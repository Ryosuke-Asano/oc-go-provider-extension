import * as vscode from "vscode";
import {
  CancellationToken,
  LanguageModelChatInformation,
  LanguageModelChatMessage,
  LanguageModelChatProvider,
  ProvideLanguageModelChatResponseOptions,
  LanguageModelResponsePart,
  Progress,
  PrepareLanguageModelChatModelOptions,
  EventEmitter,
  Event,
} from "vscode";

import type {
  OcGoModelInfo,
  OcGoStreamResponse,
  Json,
  OcGoRequestBody,
  AnthropicRequestBody,
  AnthropicSSEEvent,
} from "./types";
import { OC_GO_MODELS } from "./types";
import {
  convertMessages,
  convertTools,
  convertMessagesToAnthropic,
  convertToolsToAnthropic,
  tryParseJSONObject,
  estimateTokens,
  validateRequest,
  estimateMessagesTokens,
  getTextPartValue,
  extractImageData,
} from "./utils";
import type { LegacyPart } from "./utils";
import { OcGoMcpClient } from "./mcp";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const DEBUG_LOG_PATH = path.join(os.homedir(), "oc-go-debug.log");

function debugLog(msg: string, data?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const line = data
    ? `[${timestamp}] ${msg} ${JSON.stringify(data)}\n`
    : `[${timestamp}] ${msg}\n`;
  try {
    fs.appendFileSync(DEBUG_LOG_PATH, line);
  } catch {
    // Ignore write errors
  }
}

const BASE_URL = "https://opencode.ai/zen/go/v1";
const MAX_TOOL_RESULT_CHARS = 20000;
const MAX_TOOLS_PER_REQUEST = 128;
const DEFAULT_MAX_TOKENS = 65536;

/**
 * VS Code Chat provider backed by OpenCode Go API.
 */
export class OcGoChatModelProvider implements LanguageModelChatProvider {
  /** Buffer for assembling streamed tool calls by index. */
  private _toolCallBuffers: Map<
    number,
    { id?: string; name?: string; args: string }
  > = new Map();

  /** Indices for which a tool call has been fully emitted. */
  private _completedToolCallIndices = new Set<number>();

  /** Track if we emitted any assistant text before seeing tool calls */
  private _hasEmittedAssistantText = false;

  /** Track if we emitted the begin-tool-calls whitespace hint */
  private _emittedBeginToolCallsHint = false;

  /** Buffer for text-embedded tool call token parsing */
  private _textToolParserBuffer = "";

  /** Active text-embedded tool call being assembled */
  private _textToolActive:
    | {
        name?: string;
        index?: number;
        argBuffer: string;
        emitted?: boolean;
      }
    | undefined;

  /** Deduplicate tool calls parsed from text and structured deltas */
  private _emittedTextToolCallKeys = new Set<string>();
  private _emittedTextToolCallIds = new Set<string>();

  /** Track token usage from API responses */
  private _usageMetrics: { prompt_tokens: number; completion_tokens: number } =
    {
      prompt_tokens: 0,
      completion_tokens: 0,
    };

  /** Track whether usage metrics have been reported for the current request */
  private _usageReported = false;

  /** Debug counter */
  private _debugCallCount = 0;

  /** Event emitter for model information changes */
  private readonly _onDidChangeLanguageModelChatInformation =
    new EventEmitter<void>();

  /** Event that fires when available language models change */
  readonly onDidChangeLanguageModelChatInformation: Event<void> =
    this._onDidChangeLanguageModelChatInformation.event;

  /**
   * Fire the onDidChangeLanguageModelChatInformation event
   * Call this when the list of available models changes
   */
  fireModelInfoChanged(): void {
    this._onDidChangeLanguageModelChatInformation.fire();
  }

  /**
   * Convert HTTP status codes from upstream to LanguageModelError when possible.
   */
  private toLanguageModelError(
    status: number,
    statusText: string,
    details: string
  ): Error {
    const message = `OpenCode Go API error: ${status} ${statusText}${details ? `\n${details}` : ""}`;
    if (status === 401 || status === 403) {
      return vscode.LanguageModelError.NoPermissions(message);
    }
    if (status === 404) {
      return vscode.LanguageModelError.NotFound(message);
    }
    if (status === 429) {
      return vscode.LanguageModelError.Blocked(message);
    }
    return new Error(message);
  }

  /** MCP client for image processing and other tools */
  private _mcpClient: OcGoMcpClient;

  /**
   * Create a provider using the given secret storage for the API key.
   * @param secrets VS Code secret storage.
   * @param userAgent User agent string for API requests.
   */
  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly userAgent: string
  ) {
    this._mcpClient = new OcGoMcpClient(secrets);
  }

  /**
   * Get the list of available language models contributed by this provider
   * @param options Options which specify the calling context of this function
   * @param token A cancellation token which signals if the user cancelled the request or not
   * @returns A promise that resolves to the list of available language models
   */
  async provideLanguageModelChatInformation(
    options: PrepareLanguageModelChatModelOptions,
    _token: CancellationToken
  ): Promise<LanguageModelChatInformation[]> {
    this._debugCallCount++;
    console.log(
      "[OpenCode Go Provider] provideLanguageModelChatInformation called",
      {
        silent: options.silent,
        callCount: this._debugCallCount,
        timestamp: new Date().toISOString(),
      }
    );
    const apiKey = await this.ensureApiKey(options.silent);
    if (!apiKey) {
      console.log("[OpenCode Go Provider] No API key, returning empty list");
      return [];
    }

    // Import models from types
    const { OC_GO_MODELS: models } = await import("./types");
    console.log(`[OpenCode Go Provider] Found ${models.length} models`);

    const infos: LanguageModelChatInformation[] = models.map(
      (model: OcGoModelInfo) => {
        console.log(`[OpenCode Go Provider] Model info: ${model.id}`, {
          supportsVision: model.supportsVision,
          supportsTools: model.supportsTools,
          contextWindow: model.contextWindow,
          maxOutput: model.maxOutput,
        });
        return {
          id: model.id,
          name: model.displayName,
          detail: "OpenCode Go",
          tooltip: `OpenCode Go ${model.name}`,
          family: "opencode-go",
          version: "1.0.0",
          maxInputTokens: Math.max(
            1,
            model.contextWindow - Math.min(model.maxOutput, DEFAULT_MAX_TOKENS)
          ),
          maxOutputTokens: model.maxOutput,
          capabilities: {
            toolCalling: model.supportsTools ? MAX_TOOLS_PER_REQUEST : false,
            imageInput: true, // Image input allowed; non-vision models auto-route
          },
        };
      }
    );

    console.log(`[OpenCode Go Provider] Returning ${infos.length} models`);
    return infos;
  }

  /**
   * Check if model supports vision natively
   */
  private modelSupportsVision(modelId: string): boolean {
    const modelInfo = OC_GO_MODELS.find((m) => m.id === modelId);
    return modelInfo?.supportsVision ?? false;
  }

  /**
   * Pick a fallback vision model for image input
   */
  private getVisionFallbackModelId(): string | undefined {
    const preferred = OC_GO_MODELS.find(
      (m) => m.id === "mimo-v2-omni" && m.supportsVision
    );
    if (preferred) {
      return preferred.id;
    }
    return OC_GO_MODELS.find((m) => m.supportsVision)?.id;
  }

  /**
   * Check if any message contains image input parts
   */
  private hasImageInput(
    messages: readonly LanguageModelChatMessage[]
  ): boolean {
    for (const msg of messages) {
      for (const part of msg.content) {
        if (extractImageData(part)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Get model info by id
   */
  private getModelInfo(modelId: string): OcGoModelInfo | undefined {
    return OC_GO_MODELS.find((m) => m.id === modelId);
  }

  /**
   * Rough token estimate for tool definitions by JSON size.
   */
  private estimateToolTokens(tools: OcGoRequestBody["tools"]): number {
    if (!tools || tools.length === 0) {
      return 0;
    }
    try {
      return Math.ceil(JSON.stringify(tools).length / 4);
    } catch {
      return 0;
    }
  }

  /**
   * Pre-process messages to handle images
   * Converts images to text descriptions using GLM-OCR MCP
   */
  private async processImagesForNonVisionModel(
    messages: readonly LanguageModelChatMessage[],
    _modelId: string,
    token: CancellationToken
  ): Promise<{
    processedMessages: LanguageModelChatMessage[];
    imageDescriptions: string[];
  }> {
    const imageDescriptions: string[] = [];
    const processedMessages: LanguageModelChatMessage[] = [];

    for (const msg of messages) {
      // Extract text from message
      const textParts: string[] = [];
      for (const part of msg.content) {
        const v = getTextPartValue(part);
        if (v !== undefined) {
          textParts.push(v);
        }
      }
      const userPrompt = textParts.join(" ");

      // Extract image data parts (supports DataPart and legacy shapes)
      const images: Array<{ mimeType: string; data: Uint8Array }> = [];
      for (const part of msg.content) {
        const img = extractImageData(part);
        if (img) {
          images.push(img);
        }
      }

      if (images.length === 0) {
        // No images, keep message as-is
        processedMessages.push(msg);
        continue;
      }

      // Analyze images for this message
      const thisMessageDescriptions: string[] = [];
      for (const img of images) {
        if (token.isCancellationRequested) {
          throw new vscode.CancellationError();
        }

        const base64Data = Buffer.from(img.data).toString("base64");
        const imageDataUrl = `data:${img.mimeType};base64,${base64Data}`;

        const analysisPrompt = userPrompt || "Describe this image in detail.";
        const description = await this._mcpClient.analyzeImage(
          imageDataUrl,
          analysisPrompt
        );
        thisMessageDescriptions.push(description);
      }

      // Replace image with text description for non-Vision model
      const newContent: vscode.LanguageModelTextPart[] = [];
      for (const textPart of textParts) {
        newContent.push(new vscode.LanguageModelTextPart(textPart));
      }

      // Add image descriptions as text (only those for this message)
      if (thisMessageDescriptions.length > 0) {
        newContent.push(
          new vscode.LanguageModelTextPart(
            `\n\n[Image Analysis]:\n${thisMessageDescriptions.join("\n\n---\n\n")}`
          )
        );
      }

      processedMessages.push(vscode.LanguageModelChatMessage.User(newContent));
    }

    return { processedMessages, imageDescriptions };
  }

  /**
   * Returns the response for a chat request, passing the results to the progress callback.
   * @param model The language model to use
   * @param messages The messages to include in the request
   * @param options Options for the request
   * @param progress The progress to emit the streamed response chunks to
   * @param token A cancellation token for the request
   * @returns A promise that resolves when the response is complete.
   */
  async provideLanguageModelChatResponse(
    model: LanguageModelChatInformation,
    messages: readonly LanguageModelChatMessage[],
    options: ProvideLanguageModelChatResponseOptions,
    progress: Progress<LanguageModelResponsePart>,
    token: CancellationToken
  ): Promise<void> {
    // Reset state
    this._toolCallBuffers.clear();
    this._completedToolCallIndices.clear();
    this._hasEmittedAssistantText = false;
    this._emittedBeginToolCallsHint = false;
    this._textToolParserBuffer = "";
    this._textToolActive = undefined;
    this._emittedTextToolCallKeys.clear();
    this._emittedTextToolCallIds.clear();
    this._usageMetrics = { prompt_tokens: 0, completion_tokens: 0 };
    this._usageReported = false;
    const abortController = new AbortController();
    const cancellationSubscription = token.onCancellationRequested(() => {
      abortController.abort();
    });

    const trackingProgress: Progress<LanguageModelResponsePart> = {
      report: (part) => {
        try {
          progress.report(part);
        } catch (e) {
          console.error("[OpenCode Go Model Provider] Progress.report failed", {
            modelId: model.id,
            error:
              e instanceof Error
                ? { name: e.name, message: e.message }
                : String(e),
          });
        }
      },
    };

    try {
      const apiKey = await this.ensureApiKey(true);
      if (!apiKey) {
        throw vscode.LanguageModelError.NoPermissions(
          "OpenCode Go API key not found"
        );
      }

      const hasImages = this.hasImageInput(messages);
      let processedMessages = messages;
      let effectiveModelId = model.id;
      /** Whether we switched to a vision fallback model (may need OCR recovery) */
      let usedVisionFallback = false;

      if (hasImages) {
        if (!this.modelSupportsVision(model.id)) {
          const visionFallback = this.getVisionFallbackModelId();
          if (visionFallback && visionFallback !== model.id) {
            console.warn(
              "[OpenCode Go Model Provider] Switching to vision model for image input",
              {
                originalModel: model.id,
                visionModel: visionFallback,
              }
            );
            effectiveModelId = visionFallback;
            usedVisionFallback = true;
          } else {
            console.warn(
              "[OpenCode Go Model Provider] No vision model available, using OCR fallback"
            );
            const result = await this.processImagesForNonVisionModel(
              messages,
              model.id,
              token
            );
            processedMessages = result.processedMessages;
          }
        }
      }

      if (options.tools && options.tools.length > MAX_TOOLS_PER_REQUEST) {
        throw new Error(
          `Cannot have more than ${MAX_TOOLS_PER_REQUEST} tools per request.`
        );
      }

      validateRequest(processedMessages);

      // Determine API format based on model
      const effectiveModelInfo = this.getModelInfo(effectiveModelId);
      const apiFormat = effectiveModelInfo?.apiFormat ?? "openai";
      const isAnthropic = apiFormat === "anthropic";

      // Estimate tokens (rough approximation)
      const inputTokenCount = estimateMessagesTokens(processedMessages, {
        maxToolResultChars: MAX_TOOL_RESULT_CHARS,
      });
      const mo = options.modelOptions as Record<string, Json> | undefined;
      const maxTokensVal =
        typeof mo?.max_tokens === "number" ? mo.max_tokens : DEFAULT_MAX_TOKENS;
      const temperatureVal =
        typeof mo?.temperature === "number" ? mo.temperature : 0.7;
      const effectiveMaxOutputTokens =
        effectiveModelInfo?.maxOutput ?? model.maxOutputTokens;
      const requestedMaxTokens = Math.min(
        maxTokensVal,
        effectiveMaxOutputTokens
      );
      const tokenLimit = Math.max(
        1,
        effectiveModelInfo
          ? effectiveModelInfo.contextWindow
          : model.maxInputTokens
      );

      let toolTokenCount = 0;
      if (isAnthropic) {
        // Estimate Anthropic tool tokens
        const anthropicToolConfig = convertToolsToAnthropic(options);
        try {
          toolTokenCount = anthropicToolConfig.tools
            ? Math.ceil(JSON.stringify(anthropicToolConfig.tools).length / 4)
            : 0;
        } catch {
          toolTokenCount = 0;
        }
      } else {
        const toolConfig = convertTools(options);
        toolTokenCount = this.estimateToolTokens(toolConfig.tools);
      }

      const totalEstimatedTokens = inputTokenCount + toolTokenCount;
      debugLog("PRE-REQUEST", {
        model: effectiveModelId,
        apiFormat,
        messageCount: processedMessages.length,
        inputTokenEstimate: inputTokenCount,
        toolTokenEstimate: toolTokenCount,
        totalEstimate: totalEstimatedTokens,
        contextWindow: tokenLimit,
        maxInputTokensReported: Math.floor(tokenLimit * 0.75),
        maxOutputTokens: effectiveMaxOutputTokens,
        requestedMaxTokens,
        utilizationPct: Math.round((totalEstimatedTokens / tokenLimit) * 100),
      });
      if (totalEstimatedTokens > tokenLimit) {
        console.error(
          "[OpenCode Go Model Provider] Message exceeds token limit",
          {
            total: totalEstimatedTokens,
            messageTokens: inputTokenCount,
            toolTokens: toolTokenCount,
            tokenLimit,
            requestedMaxTokens,
          }
        );
        throw new Error("Message exceeds token limit.");
      }

      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      console.log("[OpenCode Go Model Provider] 🚀 Starting chat request", {
        model: effectiveModelId,
        apiFormat,
        messageCount: messages.length,
        timestamp: new Date().toISOString(),
      });

      // Dispatch based on API format
      if (isAnthropic) {
        await this.handleAnthropicRequest(
          effectiveModelId,
          processedMessages,
          options,
          apiKey,
          requestedMaxTokens,
          temperatureVal,
          trackingProgress,
          token,
          abortController
        );
      } else {
        await this.handleOpenAIRequest(
          effectiveModelId,
          processedMessages,
          options,
          apiKey,
          requestedMaxTokens,
          temperatureVal,
          mo,
          trackingProgress,
          token,
          abortController,
          usedVisionFallback,
          model.id
        );
      }
    } catch (err) {
      if (
        token.isCancellationRequested ||
        (err instanceof Error && err.name === "AbortError")
      ) {
        throw new vscode.CancellationError();
      }
      console.error("[OpenCode Go Model Provider] Chat request failed", {
        modelId: model.id,
        messageCount: messages.length,
        error:
          err instanceof Error
            ? { name: err.name, message: err.message }
            : String(err),
      });
      throw err;
    } finally {
      cancellationSubscription.dispose();
    }
  }

  /**
   * Handle OpenAI-format API request (chat/completions endpoint)
   */
  private async handleOpenAIRequest(
    effectiveModelId: string,
    processedMessages: readonly LanguageModelChatMessage[],
    options: ProvideLanguageModelChatResponseOptions,
    apiKey: string,
    requestedMaxTokens: number,
    temperatureVal: number,
    mo: Record<string, Json> | undefined,
    trackingProgress: Progress<LanguageModelResponsePart>,
    token: CancellationToken,
    abortController: AbortController,
    usedVisionFallback: boolean,
    originalModelId: string
  ): Promise<void> {
    const toolConfig = convertTools(options);
    const apiMessages = convertMessages(processedMessages, {
      maxToolResultChars: MAX_TOOL_RESULT_CHARS,
    });

    const requestBody: OcGoRequestBody = {
      model: effectiveModelId,
      messages: apiMessages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: requestedMaxTokens,
      temperature: temperatureVal,
    };

    // Allow-list model options
    if (mo) {
      if (typeof mo.stop === "string") {
        requestBody.stop = mo.stop;
      } else if (
        Array.isArray(mo.stop) &&
        mo.stop.every((s) => typeof s === "string")
      ) {
        requestBody.stop = mo.stop;
      }
      if (typeof mo.frequency_penalty === "number") {
        requestBody.frequency_penalty = mo.frequency_penalty;
      }
      if (typeof mo.presence_penalty === "number") {
        requestBody.presence_penalty = mo.presence_penalty;
      }
    }

    if (toolConfig.tools) {
      requestBody.tools = toolConfig.tools;
    }
    if (toolConfig.tool_choice) {
      requestBody.tool_choice = toolConfig.tool_choice;
    }

    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": this.userAgent,
      },
      signal: abortController.signal,
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        "[OpenCode Go Model Provider] API error response",
        errorText
      );

      // If vision fallback failed due to subscription limits (429 + code 1311),
      // fall back to OCR processing on the original model instead.
      if (
        usedVisionFallback &&
        response.status === 429 &&
        errorText.includes("1311")
      ) {
        console.warn(
          "[OpenCode Go Model Provider] Vision model unavailable on subscription, falling back to OCR",
          {
            originalModel: originalModelId,
            failedVisionModel: effectiveModelId,
          }
        );

        // Reset to original model and process images via OCR
        effectiveModelId = originalModelId;
        const ocrResult = await this.processImagesForNonVisionModel(
          processedMessages,
          originalModelId,
          token
        );
        processedMessages = ocrResult.processedMessages;

        // Rebuild request with original model + OCR'd messages
        const ocrApiMessages = convertMessages(processedMessages, {
          maxToolResultChars: MAX_TOOL_RESULT_CHARS,
        });
        const ocrRequestBody: OcGoRequestBody = {
          model: effectiveModelId,
          messages: ocrApiMessages,
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: requestedMaxTokens,
          temperature: temperatureVal,
        };
        if (toolConfig.tools) {
          ocrRequestBody.tools = toolConfig.tools;
        }
        if (toolConfig.tool_choice) {
          ocrRequestBody.tool_choice = toolConfig.tool_choice;
        }

        console.log(
          "[OpenCode Go Model Provider] 🔄 Retrying with OCR fallback",
          {
            model: effectiveModelId,
          }
        );

        const retryResponse = await fetch(`${BASE_URL}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "User-Agent": this.userAgent,
          },
          signal: abortController.signal,
          body: JSON.stringify(ocrRequestBody),
        });

        if (!retryResponse.ok) {
          const retryErrorText = await retryResponse.text();
          console.error(
            "[OpenCode Go Model Provider] OCR fallback also failed",
            retryErrorText
          );
          throw this.toLanguageModelError(
            retryResponse.status,
            retryResponse.statusText,
            retryErrorText
          );
        }

        if (!retryResponse.body) {
          throw new Error("No response body from OpenCode Go API");
        }

        await this.processStreamingResponse(
          retryResponse.body,
          trackingProgress,
          token
        );
      } else {
        throw this.toLanguageModelError(
          response.status,
          response.statusText,
          errorText
        );
      }
    } else {
      if (!response.body) {
        throw new Error("No response body from OpenCode Go API");
      }

      await this.processStreamingResponse(
        response.body,
        trackingProgress,
        token
      );
    }
  }

  /**
   * Handle Anthropic-format API request (/messages endpoint)
   */
  private async handleAnthropicRequest(
    effectiveModelId: string,
    processedMessages: readonly LanguageModelChatMessage[],
    options: ProvideLanguageModelChatResponseOptions,
    apiKey: string,
    requestedMaxTokens: number,
    temperatureVal: number,
    trackingProgress: Progress<LanguageModelResponsePart>,
    token: CancellationToken,
    abortController: AbortController
  ): Promise<void> {
    const toolConfig = convertToolsToAnthropic(options);
    const { messages: apiMessages, system } = convertMessagesToAnthropic(
      processedMessages,
      { maxToolResultChars: MAX_TOOL_RESULT_CHARS }
    );

    if (apiMessages.length === 0) {
      throw new Error("No messages to send to Anthropic API");
    }

    const safeMaxTokens = Math.max(1, requestedMaxTokens);

    const requestBody: AnthropicRequestBody = {
      model: effectiveModelId,
      messages: apiMessages,
      max_tokens: safeMaxTokens,
      stream: true,
    };

    if (system) {
      requestBody.system = system;
    }

    if (typeof temperatureVal === "number" && temperatureVal > 0) {
      requestBody.temperature = temperatureVal;
    }

    if (toolConfig.tools && toolConfig.tools.length > 0) {
      requestBody.tools = toolConfig.tools;
      // Only set tool_choice when it's not the default "auto"
      if (toolConfig.tool_choice && toolConfig.tool_choice !== "auto") {
        requestBody.tool_choice = toolConfig.tool_choice;
      }
    }

    console.log("[OpenCode Go Model Provider] Anthropic request body", {
      model: requestBody.model,
      system: requestBody.system,
      messagesCount: requestBody.messages.length,
      messages: requestBody.messages,
      toolsCount: requestBody.tools?.length,
      max_tokens: requestBody.max_tokens,
      temperature: requestBody.temperature,
      tool_choice: requestBody.tool_choice,
    });

    const response = await fetch(`${BASE_URL}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
        "User-Agent": this.userAgent,
      },
      signal: abortController.signal,
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        "[OpenCode Go Model Provider] Anthropic API error response",
        errorText
      );
      throw this.toLanguageModelError(
        response.status,
        response.statusText,
        errorText
      );
    }

    if (!response.body) {
      throw new Error("No response body from Anthropic API");
    }

    await this.processAnthropicStreamingResponse(
      response.body,
      trackingProgress,
      token
    );
  }

  /**
   * Process an Anthropic-format streaming response (SSE events)
   */
  private async processAnthropicStreamingResponse(
    body: ReadableStream<Uint8Array>,
    progress: Progress<LanguageModelResponsePart>,
    token: CancellationToken
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // Track active tool_use blocks: index -> { id, name, inputJsonDelta }
    const activeToolCalls = new Map<
      number,
      { id: string; name: string; inputJson: string }
    >();

    try {
      while (!token.isCancellationRequested) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        // Keep the last incomplete line in the buffer
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) {
            continue;
          }

          const jsonStr = trimmed.slice(5).trim();
          if (!jsonStr || jsonStr === "[DONE]") {
            continue;
          }

          let event: AnthropicSSEEvent;
          try {
            event = JSON.parse(jsonStr) as AnthropicSSEEvent;
          } catch {
            continue;
          }

          switch (event.type) {
            case "message_start":
              // Initial message metadata — nothing to emit
              break;

            case "content_block_start": {
              if (event.content_block?.type === "tool_use") {
                const idx = event.index;
                const toolId =
                  event.content_block.id ??
                  `tu_${Math.random().toString(36).slice(2, 10)}`;
                const toolName = event.content_block.name ?? "unknown_tool";
                activeToolCalls.set(idx, {
                  id: toolId,
                  name: toolName,
                  inputJson: "",
                });
              }
              break;
            }

            case "content_block_delta": {
              const deltaEvent = event;
              if (deltaEvent.delta?.type === "text_delta") {
                const text = deltaEvent.delta.text ?? "";
                if (text) {
                  progress.report(new vscode.LanguageModelTextPart(text));
                }
              } else if (deltaEvent.delta?.type === "input_json_delta") {
                const partialJson = deltaEvent.delta.partial_json ?? "";
                const idx = event.index;
                const tc = activeToolCalls.get(idx);
                if (tc) {
                  tc.inputJson += partialJson;
                }
              }
              break;
            }

            case "content_block_stop": {
              const idx = event.index;
              const tc = activeToolCalls.get(idx);
              if (tc) {
                // Parse the accumulated JSON and emit the tool call
                let input: Record<string, Json> = {};
                if (tc.inputJson.trim()) {
                  const parsed = tryParseJSONObject<Record<string, Json>>(
                    tc.inputJson
                  );
                  if (parsed.ok) {
                    input = parsed.value;
                  }
                }
                progress.report(
                  new vscode.LanguageModelToolCallPart(tc.id, tc.name, input)
                );
                activeToolCalls.delete(idx);
              }
              break;
            }

            case "message_delta":
              // Contains stop_reason, usage — nothing to emit
              break;

            case "message_stop":
              // Stream is done
              break;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Returns the number of tokens for a given text using the model specific tokenizer logic
   * @param model The language model to use
   * @param text The text to count tokens for
   * @param token A cancellation token for the request
   * @returns A promise that resolves to the number of tokens
   */
  provideTokenCount(
    _model: LanguageModelChatInformation,
    text:
      | string
      | {
          content: readonly unknown[];
        },
    _token: CancellationToken
  ): Promise<number> {
    if (typeof text === "string") {
      return Promise.resolve(estimateTokens(text));
    }

    const partCount = text.content.length;
    const totalTokens = estimateMessagesTokens([
      {
        content: text.content as (vscode.LanguageModelInputPart | LegacyPart)[],
      },
    ]);
    debugLog("TOKEN-COUNT", {
      type: "message",
      partCount,
      result: totalTokens,
    });
    return Promise.resolve(totalTokens);
  }

  /**
   * Ensure an API key exists in SecretStorage, optionally prompting the user when not silent.
   * @param silent If true, do not prompt the user.
   */
  private async ensureApiKey(silent: boolean): Promise<string | undefined> {
    let apiKey = await this.secrets.get("opencode-go.apiKey");
    if (!apiKey && !silent) {
      const entered = await vscode.window.showInputBox({
        title: "OpenCode Go API Key",
        prompt: "Enter your OpenCode Go API key",
        ignoreFocusOut: true,
        password: true,
      });
      if (entered && entered.trim()) {
        apiKey = entered.trim();
        await this.secrets.store("opencode-go.apiKey", apiKey);
      }
    }
    return apiKey;
  }

  /**
   * Read and parse the OpenCode Go streaming (SSE) response and report parts.
   * @param responseBody The readable stream body.
   * @param progress Progress reporter for streamed parts.
   * @param token Cancellation token.
   */
  private async processStreamingResponse(
    responseBody: ReadableStream<Uint8Array>,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const reader = responseBody.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (!token.isCancellationRequested) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) {
            continue;
          }
          const data = line.slice(6);
          if (data === "[DONE]") {
            // Do not throw on DONE for incomplete tool call JSON.
            await this.flushToolCallBuffers(progress, false);
            await this.flushActiveTextToolCall(progress);
            // Report usage metrics
            debugLog("STREAM-DONE", {
              apiPromptTokens: this._usageMetrics.prompt_tokens,
              apiCompletionTokens: this._usageMetrics.completion_tokens,
            });
            console.log(
              "[OpenCode Go Model Provider] Stream [DONE], final usage metrics:",
              {
                prompt_tokens: this._usageMetrics.prompt_tokens,
                completion_tokens: this._usageMetrics.completion_tokens,
                alreadyReported: this._usageReported,
              }
            );
            this.reportUsageMetrics(progress);
            continue;
          }

          try {
            const parsed = JSON.parse(data) as OcGoStreamResponse;
            // Track usage metrics from the response
            if (parsed.usage) {
              console.log(
                "[OpenCode Go Model Provider] Received usage in chunk:",
                parsed.usage
              );
              if (parsed.usage.prompt_tokens !== undefined) {
                this._usageMetrics.prompt_tokens = parsed.usage.prompt_tokens;
              }
              if (parsed.usage.completion_tokens !== undefined) {
                this._usageMetrics.completion_tokens =
                  parsed.usage.completion_tokens;
              }
            }
            // Skip processDelta for usage-only final chunk (empty choices)
            if (parsed.choices && parsed.choices.length > 0) {
              await this.processDelta(parsed, progress);
            } else if (parsed.usage) {
              console.log(
                "[OpenCode Go Model Provider] Received usage-only final chunk:",
                parsed.usage
              );
            }
          } catch {
            // Silently ignore malformed SSE lines temporarily
          }
        }
      }
    } finally {
      // Report any unreported usage metrics before cleanup
      if (!this._usageReported) {
        try {
          this.reportUsageMetrics(progress);
        } catch {
          // Best effort — progress may already be closed
        }
      }
      reader.releaseLock();
      // Clean up any leftover tool call state
      this._toolCallBuffers.clear();
      this._completedToolCallIndices.clear();
      this._hasEmittedAssistantText = false;
      this._emittedBeginToolCallsHint = false;
      this._textToolParserBuffer = "";
      this._textToolActive = undefined;
      this._emittedTextToolCallKeys.clear();
      this._emittedTextToolCallIds.clear();
      this._usageMetrics = { prompt_tokens: 0, completion_tokens: 0 };
      this._usageReported = false;
    }
  }

  /**
   * Report usage metrics to VS Code Chat UI via LanguageModelDataPart
   */
  private reportUsageMetrics(
    progress: vscode.Progress<vscode.LanguageModelResponsePart>
  ): void {
    if (this._usageReported) {
      return;
    }
    if (
      this._usageMetrics.prompt_tokens > 0 ||
      this._usageMetrics.completion_tokens > 0
    ) {
      const totalTokens =
        this._usageMetrics.prompt_tokens + this._usageMetrics.completion_tokens;
      console.log("[OpenCode Go Model Provider] Token usage metrics", {
        prompt_tokens: this._usageMetrics.prompt_tokens,
        completion_tokens: this._usageMetrics.completion_tokens,
        total_tokens: totalTokens,
      });
      try {
        progress.report(
          vscode.LanguageModelDataPart.json(
            {
              type: "usage",
              prompt_tokens: this._usageMetrics.prompt_tokens,
              completion_tokens: this._usageMetrics.completion_tokens,
              total_tokens: totalTokens,
            },
            "application/vnd.opencode-go.usage+json"
          )
        );
      } catch (e) {
        console.warn(
          "[OpenCode Go Model Provider] Failed to report usage via progress",
          e
        );
      }
      this._usageReported = true;
    }
  }

  /**
   * Handle a single streamed delta chunk, emitting text and tool call parts.
   * @param delta Parsed SSE chunk from OpenCode Go.
   * @param progress Progress reporter for parts.
   */
  private async processDelta(
    delta: OcGoStreamResponse,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>
  ): Promise<boolean> {
    let emitted = false;
    const choice = delta.choices?.[0];
    if (!choice) {
      return false;
    }

    const deltaObj = choice.delta;

    // Handle text content
    if (deltaObj?.content) {
      const content = String(deltaObj.content);

      const textResult = this.processTextContent(content, progress);
      if (textResult.emittedText) {
        this._hasEmittedAssistantText = true;
      }
      if (textResult.emittedAny) {
        emitted = true;
      }
    }

    // Handle tool calls
    if (deltaObj?.tool_calls) {
      const toolCalls = deltaObj.tool_calls;

      // Emit a whitespace hint to flush UI rendering once tool calls begin
      if (
        !this._emittedBeginToolCallsHint &&
        this._hasEmittedAssistantText &&
        toolCalls.length > 0
      ) {
        progress.report(new vscode.LanguageModelTextPart(" "));
        this._emittedBeginToolCallsHint = true;
      }

      for (const tc of toolCalls) {
        const idx = (tc as { index?: number }).index ?? 0;
        // Ignore any further deltas for an index we've already completed
        if (this._completedToolCallIndices.has(idx)) {
          continue;
        }
        const buf = this._toolCallBuffers.get(idx) ?? { args: "" };
        if (tc.id && typeof tc.id === "string") {
          buf.id = tc.id;
        }
        const func = tc.function;
        if (func?.name && typeof func.name === "string") {
          buf.name = func.name;
        }
        if (typeof func?.arguments === "string") {
          buf.args += func.arguments;
        }
        this._toolCallBuffers.set(idx, buf);

        // Emit immediately once arguments become valid JSON
        await this.tryEmitBufferedToolCall(idx, progress);
      }
    }

    const finish = choice.finish_reason;
    if (finish === "tool_calls" || finish === "stop") {
      // Emit any buffered calls
      await this.flushToolCallBuffers(progress, true);
    }

    return emitted;
  }

  /**
   * Parse provider control tokens embedded in streamed text and emit text/tool calls.
   */
  private processTextContent(
    input: string,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>
  ): { emittedText: boolean; emittedAny: boolean } {
    const BEGIN = "<|tool_call_begin|>";
    const ARG_BEGIN = "<|tool_call_argument_begin|>";
    const END = "<|tool_call_end|>";

    let data = this._textToolParserBuffer + input;
    let emittedText = false;
    let emittedAny = false;
    let visibleOut = "";

    while (data.length > 0) {
      if (!this._textToolActive) {
        const b = data.indexOf(BEGIN);
        if (b === -1) {
          let longestPartialPrefix = 0;
          for (
            let k = Math.min(BEGIN.length - 1, data.length - 1);
            k > 0;
            k--
          ) {
            if (data.endsWith(BEGIN.slice(0, k))) {
              longestPartialPrefix = k;
              break;
            }
          }

          if (longestPartialPrefix > 0) {
            const visible = data.slice(0, data.length - longestPartialPrefix);
            if (visible) {
              visibleOut += this.stripControlTokens(visible);
            }
            this._textToolParserBuffer = data.slice(
              data.length - longestPartialPrefix
            );
            data = "";
            break;
          }

          const lines = data.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const emittedJsonTool = this.tryEmitJsonToolCallLine(
              line,
              progress
            );
            if (emittedJsonTool) {
              emittedAny = true;
              continue;
            }
            visibleOut += this.stripControlTokens(line);
            if (i < lines.length - 1) {
              visibleOut += "\n";
            }
          }
          data = "";
          break;
        }

        const pre = data.slice(0, b);
        if (pre) {
          visibleOut += this.stripControlTokens(pre);
        }
        data = data.slice(b + BEGIN.length);

        const a = data.indexOf(ARG_BEGIN);
        const e = data.indexOf(END);
        let delimIdx = -1;
        let delimKind: "arg" | "end" | undefined;
        if (a !== -1 && (e === -1 || a < e)) {
          delimIdx = a;
          delimKind = "arg";
        } else if (e !== -1) {
          delimIdx = e;
          delimKind = "end";
        } else {
          this._textToolParserBuffer = BEGIN + data;
          data = "";
          break;
        }

        const header = data.slice(0, delimIdx).trim();
        const m = header.match(/^([A-Za-z0-9_\-.]+)(?::(\d+))?/);
        const name = m?.[1];
        const index = m?.[2] ? Number(m[2]) : undefined;
        this._textToolActive = { name, index, argBuffer: "", emitted: false };

        if (delimKind === "arg") {
          data = data.slice(delimIdx + ARG_BEGIN.length);
        } else {
          data = data.slice(delimIdx + END.length);
          const did = this.emitTextToolCallIfValid(
            progress,
            this._textToolActive,
            "{}"
          );
          if (did) {
            this._textToolActive.emitted = true;
            emittedAny = true;
          }
          this._textToolActive = undefined;
        }
        continue;
      }

      const e2 = data.indexOf(END);
      if (e2 === -1) {
        this._textToolActive.argBuffer += data;
        if (!this._textToolActive.emitted) {
          const did = this.emitTextToolCallIfValid(
            progress,
            this._textToolActive,
            this._textToolActive.argBuffer
          );
          if (did) {
            this._textToolActive.emitted = true;
            emittedAny = true;
          }
        }
        data = "";
        break;
      }

      this._textToolActive.argBuffer += data.slice(0, e2);
      data = data.slice(e2 + END.length);
      if (!this._textToolActive.emitted) {
        const did = this.emitTextToolCallIfValid(
          progress,
          this._textToolActive,
          this._textToolActive.argBuffer
        );
        if (did) {
          emittedAny = true;
        }
      }
      this._textToolActive = undefined;
    }

    if (visibleOut.length > 0) {
      progress.report(new vscode.LanguageModelTextPart(visibleOut));
      emittedText = true;
      emittedAny = true;
    }

    this._textToolParserBuffer = data;
    return { emittedText, emittedAny };
  }

  /**
   * Detect and emit tool calls serialized as plain JSON text lines.
   */
  private tryEmitJsonToolCallLine(
    line: string,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>
  ): boolean {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
      return false;
    }

    const parsed = tryParseJSONObject<Record<string, Json>>(trimmed);
    if (!parsed.ok) {
      return false;
    }

    const obj = parsed.value;
    const fn = (obj.function ?? null) as Record<string, Json> | null;
    const name =
      typeof obj.name === "string"
        ? obj.name
        : fn && typeof fn.name === "string"
          ? fn.name
          : undefined;
    if (!name) {
      return false;
    }

    const callId =
      typeof obj.callId === "string"
        ? obj.callId
        : typeof obj.id === "string"
          ? obj.id
          : undefined;

    let input: Record<string, Json> | undefined;
    const inputVal = obj.input;
    if (inputVal && typeof inputVal === "object" && !Array.isArray(inputVal)) {
      input = inputVal as Record<string, Json>;
    }

    if (!input) {
      const argsVal = obj.arguments ?? fn?.arguments;
      if (typeof argsVal === "string") {
        const parsedArgs = tryParseJSONObject<Record<string, Json>>(argsVal);
        if (!parsedArgs.ok) {
          return false;
        }
        input = parsedArgs.value;
      } else if (
        argsVal &&
        typeof argsVal === "object" &&
        !Array.isArray(argsVal)
      ) {
        input = argsVal as Record<string, Json>;
      }
    }

    if (!input) {
      return false;
    }

    try {
      const canonical = JSON.stringify(input);
      const key = `${name}:${canonical}`;
      if (this._emittedTextToolCallKeys.has(key)) {
        return true;
      }
      this._emittedTextToolCallKeys.add(key);
      if (callId) {
        this._emittedTextToolCallIds.add(`${name}:${callId}`);
      }
    } catch {
      // Fall through and emit even if canonicalization fails.
    }

    progress.report(
      new vscode.LanguageModelToolCallPart(
        callId ?? `jtc_${Math.random().toString(36).slice(2, 10)}`,
        name,
        input
      )
    );
    return true;
  }

  private emitTextToolCallIfValid(
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    call: {
      name?: string;
      index?: number;
      argBuffer: string;
      emitted?: boolean;
    },
    argText: string
  ): boolean {
    const name = call.name ?? "unknown_tool";
    const parsed = tryParseJSONObject<Record<string, Json>>(argText);
    if (!parsed.ok) {
      return false;
    }

    const canonical = JSON.stringify(parsed.value);
    const key = `${name}:${canonical}`;
    if (typeof call.index === "number") {
      const idKey = `${name}:${call.index}`;
      if (this._emittedTextToolCallIds.has(idKey)) {
        return false;
      }
      this._emittedTextToolCallIds.add(idKey);
    } else if (this._emittedTextToolCallKeys.has(key)) {
      return false;
    }

    this._emittedTextToolCallKeys.add(key);
    const id = `tct_${Math.random().toString(36).slice(2, 10)}`;
    progress.report(
      new vscode.LanguageModelToolCallPart(id, name, parsed.value)
    );
    return true;
  }

  private flushActiveTextToolCall(
    progress: vscode.Progress<vscode.LanguageModelResponsePart>
  ): Promise<void> {
    if (!this._textToolActive) {
      return Promise.resolve();
    }
    const argText = this._textToolActive.argBuffer;
    const parsed = tryParseJSONObject<Record<string, Json>>(argText);
    if (!parsed.ok) {
      return Promise.resolve();
    }
    this.emitTextToolCallIfValid(progress, this._textToolActive, argText);
    this._textToolActive = undefined;
    return Promise.resolve();
  }

  /** Strip provider control tokens from visible streamed text. */
  private stripControlTokens(text: string): string {
    try {
      return text
        .replace(/<\|[a-zA-Z0-9_-]+_section_(?:begin|end)\|>/g, "")
        .replace(/<\|tool_call_(?:argument_)?(?:begin|end)\|>/g, "");
    } catch {
      return text;
    }
  }

  /**
   * Try to emit a buffered tool call when a valid name and JSON arguments are available.
   * @param index The tool call index from the stream.
   * @param progress Progress reporter for parts.
   */
  private tryEmitBufferedToolCall(
    index: number,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>
  ): Promise<void> {
    const buf = this._toolCallBuffers.get(index);
    if (!buf) {
      return Promise.resolve();
    }
    if (!buf.name) {
      return Promise.resolve();
    }
    const canParse = tryParseJSONObject<Record<string, Json>>(buf.args);
    if (!canParse.ok) {
      return Promise.resolve();
    }
    const id = buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
    const parameters = canParse.value;
    try {
      const canonical = JSON.stringify(parameters);
      this._emittedTextToolCallKeys.add(`${buf.name}:${canonical}`);
    } catch {
      // Ignore JSON serialization errors; tool call can still be emitted.
    }
    progress.report(
      new vscode.LanguageModelToolCallPart(id, buf.name, parameters)
    );
    this._toolCallBuffers.delete(index);
    this._completedToolCallIndices.add(index);
    return Promise.resolve();
  }

  /**
   * Flush all buffered tool calls, optionally throwing if arguments are not valid JSON.
   * @param progress Progress reporter for parts.
   * @param throwOnInvalid If true, throw when a tool call has invalid JSON args.
   */
  private flushToolCallBuffers(
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    throwOnInvalid: boolean
  ): Promise<void> {
    if (this._toolCallBuffers.size === 0) {
      return Promise.resolve();
    }
    for (const [idx, buf] of Array.from(this._toolCallBuffers.entries())) {
      const parsed = tryParseJSONObject<Record<string, Json>>(buf.args);
      if (!parsed.ok) {
        if (throwOnInvalid) {
          console.error(
            "[OpenCode Go Model Provider] Invalid JSON for tool call",
            {
              idx,
              snippet: (buf.args || "").slice(0, 200),
            }
          );
          throw new Error("Invalid JSON for tool call");
        }
        // When not throwing (e.g. on [DONE]), drop silently
        continue;
      }
      const id = buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
      const name = buf.name ?? "unknown_tool";
      const parameters = parsed.value;
      try {
        const canonical = JSON.stringify(parameters);
        this._emittedTextToolCallKeys.add(`${name}:${canonical}`);
      } catch {
        // Ignore JSON serialization errors; tool call can still be emitted.
      }
      progress.report(
        new vscode.LanguageModelToolCallPart(id, name, parameters)
      );
      this._toolCallBuffers.delete(idx);
      this._completedToolCallIndices.add(idx);
    }
    return Promise.resolve();
  }
}
