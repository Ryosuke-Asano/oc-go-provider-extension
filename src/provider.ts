import * as vscode from "vscode";
import {
  CancellationToken,
  LanguageModelChatInformation,
  LanguageModelChatMessage,
  LanguageModelChatMessageRole,
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
  estimateTokensWithOverhead,
  validateRequest,
  estimateMessagesTokens,
  getTextPartValue,
  extractImageData,
  getVisionProxyModelId,
} from "./utils";
import type { LegacyPart } from "./utils";
import { OcGoMcpClient } from "./mcp";
import {
  getThinkingSchemaForModel,
  getThinkingParams,
  createModelVariants,
  parseVariantModelId,
} from "./thinking";
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

interface ErrorResponseLike {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
  headers: { get(name: string): string | null };
}

const MAX_TOOL_RESULT_CHARS = 20000;
const MAX_TOOLS_PER_REQUEST = 128;
const DEFAULT_MAX_TOKENS = 65536;
const MAX_OCR_TOKENS = 16000;
const OCR_TRUNCATION_SUFFIX = "\n\n...[truncated image analysis]";
const MAX_TRANSCRIPT_LINES = 200;
const TRANSCRIPT_OVERRUN_TOLERANCE = 0.005;

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

  /** Buffer for accumulating reasoning content from the stream */
  private _reasoningContentBuffer = "";

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

  /** Per-image hashes OCR'd this session + the message index where they appeared.
   *  Only skip OCR when the same image reappears at the SAME message index
   *  (VS Code re-attach). A new message index means the user deliberately
   *  re-sent the image and wants fresh analysis. */
  private _ocrImageState = new Map<string, number>();
  private _lastNewestImageMsgIdx = -1;

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

  updateModelList(models: OcGoModelInfo[]): void {
    (this as unknown as { _modelList: OcGoModelInfo[] })._modelList = models;
  }

  getVendorLabel(): string {
    return this._vendorLabel;
  }

  async getApiKeyForFetch(): Promise<string> {
    return await this.secrets.get(this._secretKeyName) ?? "";
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

  private async rejectForErrorResponse(
    response: ErrorResponseLike
  ): Promise<never> {
    const errorText = await response.text();
    console.error(
      "[OpenCode] API error response",
      errorText.slice(0, 2000)
    );
    debugLog("API-ERROR", { upstreamError: errorText.slice(0, 2000) });
    throw this.toLanguageModelError(
      response.status,
      response.statusText,
      errorText
    );
  }

  /** Generate unique model ID with vendor prefix to avoid collision with Copilot's built-in models */
  private getVendorPrefix(): string {
    const label = this._vendorLabel.toLowerCase();
    if (label.includes("zen")) return "zen";
    if (label.includes("go")) return "go";
    return label.replace(/[^a-z0-9]/g, "");
  }

  private getModelIdWithPrefix(modelId: string): string {
    const vendorPrefix = this.getVendorPrefix();
    return `opencode-${vendorPrefix}-${modelId}`;
  }

  private getModelFamily(): string {
    return this._vendorLabel.toLowerCase().replace(/[^a-z0-9]/g, "-");
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
    private readonly userAgent: string,
    private readonly _baseUrl: string = "https://opencode.ai/zen/go/v1",
    private readonly _secretKeyName: string = "opencode-go.apiKey",
    private readonly _modelList?: OcGoModelInfo[],
    private readonly _vendorLabel: string = "OpenCode Go"
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
      `[OpenCode] provideLanguageModelChatInformation called (${this._vendorLabel})`,
      {
        silent: options.silent,
        callCount: this._debugCallCount,
        timestamp: new Date().toISOString(),
      }
    );

    // Always return static model list - don't require API key for model discovery.
    // API key is only needed for actual chat requests (handled in provideLanguageModelChatResponse).
    // This ensures models appear in the chat model picker even without authentication.
    const apiKey = await this.ensureApiKey(options.silent);
    console.log(
      `[OpenCode] API key status: ${apiKey ? "available" : "not available"} (silent: ${options.silent})`
    );

    const models = this._modelList ?? OC_GO_MODELS;
    console.log(`[OpenCode] Found ${models.length} models (${this._vendorLabel})`);

    const infos: LanguageModelChatInformation[] = [];

    for (const model of models) {
      const schema = model.supportsReasoning ? getThinkingSchemaForModel(model.id) : undefined;
      console.log(`[OpenCode] Model info: ${model.id}`, {
        supportsVision: model.supportsVision,
        supportsTools: model.supportsTools,
        supportsReasoning: model.supportsReasoning,
        hasThinkingSchema: !!schema,
        contextWindow: model.contextWindow,
        maxOutput: model.maxOutput,
      });

      const baseInfo = {
        // Add vendor prefix to ensure global uniqueness - prevents collision with Copilot's built-in models
        // This fixes VS Code 1.120 issue where BYOK models disappear from chat picker due to ID collision
        id: this.getModelIdWithPrefix(model.id),
        name: model.displayName,
        detail: this._vendorLabel,
        tooltip: `${this._vendorLabel} ${model.name}`,
        family: this.getModelFamily(),
        version: "1.0.0",
        isUserSelectable: true,
        maxInputTokens: Math.max(
          1,
          model.contextWindow - Math.min(model.maxOutput, DEFAULT_MAX_TOKENS)
        ),
        maxOutputTokens: model.maxOutput,
        capabilities: {
          // Use boolean instead of number to work around VS Code 1.120 bug
          // where third-party provider models with numeric toolCalling are filtered out
          // from the Chat model picker (see Stack Overflow and GitHub issues)
          toolCalling: model.supportsTools ? true : false,
          imageInput: model.supportsVision ?? false,
        },
      } as LanguageModelChatInformation & {
        configurationSchema?: Record<string, unknown>;
      };

      // Attach configurationSchema for Insiders builds that support the proposed API
      // If configurationSchema is supported, emit a single model entry; otherwise
      // create suffixed model variants (e.g. "deepseek-v4-pro-high") for stable VS Code
      if (model.supportsReasoning) {
        const schema = getThinkingSchemaForModel(model.id);
        if (schema) {
          baseInfo.configurationSchema = schema;
          console.log(`[OpenCode] Thinking schema attached for: ${model.id}`);
          infos.push(baseInfo);
        } else {
          // Stable-API fallback: emit one model per thinking level
          const variants = createModelVariants(model);
          if (variants.length > 0) {
            console.log(`[OpenCode] Creating ${variants.length} variant models for: ${model.id}`);
            for (const variant of variants) {
              infos.push({
                // Add vendor prefix to variant models too
                id: this.getModelIdWithPrefix(variant.id),
                name: variant.displayName,
                detail: this._vendorLabel,
                tooltip: `${this._vendorLabel} ${variant.name}`,
                family: this.getModelFamily(),
                version: "1.0.0",
                isUserSelectable: true,
                maxInputTokens: Math.max(
                  1,
                  variant.contextWindow - Math.min(variant.maxOutput, DEFAULT_MAX_TOKENS)
                ),
                maxOutputTokens: variant.maxOutput,
                capabilities: {
                  // Use boolean instead of number to work around VS Code 1.120 bug
                  toolCalling: variant.supportsTools ? true : false,
                  imageInput: variant.supportsVision ?? false,
                },
              });
            }
          } else {
            infos.push(baseInfo);
          }
        }
      } else {
        infos.push(baseInfo);
      }
    }

    console.log(`[OpenCode] Returning ${infos.length} models (${this._vendorLabel})`);
    return infos;
  }

  /**
   * Check if model supports vision natively
   */
  private modelSupportsVision(modelId: string): boolean {
    const modelInfo = this.getModelInfo(modelId);
    return modelInfo?.supportsVision ?? false;
  }

  /**
   * Check if any message contains image input parts.
   * Must scan ALL messages because OCR replacements from previous turns
   * do NOT persist in VS Code conversation history — raw images remain
   * and will crash non-vision models like DeepSeek if not stripped.
   * (messages[42]: unknown variant image_url, expected text)
   */
  private hasImageInput(
    messages: readonly LanguageModelChatMessage[]
  ): boolean {
    for (const msg of messages) {
      if (msg.content.some((part) => extractImageData(part))) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get model info by id
   */
  private getModelInfo(modelId: string): OcGoModelInfo | undefined {
    // Extract original model ID from prefixed ID (e.g., "opencode-go-glm-5" -> "glm-5")
    const originalId = this.extractOriginalModelId(modelId);
    
    // Provider model list takes priority (includes Zen models)
    if (this._modelList) {
      const found = this._modelList.find((m) => m.id === originalId || m.id === modelId);
      if (found) return found;
    }
    // Fall back to OC_GO_MODELS for Go-specific models
    return OC_GO_MODELS.find((m) => m.id === originalId || m.id === modelId);
  }

  private extractOriginalModelId(prefixedId: string): string {
    // Extract original model ID from prefixed format: "opencode-{vendorPrefix}-{originalId}"
    // vendorPrefix is "go" for OpenCode Go, "zen" for OpenCode Zen (via getVendorPrefix)
    const parts = prefixedId.split("-");
    if (parts.length >= 3 && parts[0] === "opencode") {
      const vendorPrefix = this.getVendorPrefix();
      if (parts[1] === vendorPrefix) {
        return parts.slice(2).join("-");
      }
    }
    return prefixedId;
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

  private truncateTextToTokens(
    text: string,
    maxTokens: number,
    suffix: string
  ): string {
    if (maxTokens <= 0) {
      return text;
    }
    const tokenCount = estimateTokens(text);
    if (tokenCount <= maxTokens) {
      return text;
    }
    const maxChars = Math.max(1, maxTokens * 2 - suffix.length);
    return `${text.slice(0, maxChars)}${suffix}`;
  }

  /**
   * Pre-process messages to handle images for non-vision models.
   *
   * Strategy: analyze images from the LAST message (the newest user turn)
   * through the configured vision proxy model.
   * For older messages, images are simply stripped — their analysis text was
   * already sent to the model on a previous turn and lives in context.
   * This avoids redundant image-analysis calls while keeping the original
   * non-vision model stable.
   */
  private async processImagesForNonVisionModel(
    messages: readonly LanguageModelChatMessage[],
    _modelId: string,
    visionProxyModel: string,
    token: CancellationToken
  ): Promise<{
    processedMessages: LanguageModelChatMessage[];
    imageDescriptions: string[];
  }> {
    const imageDescriptions: string[] = [];
    const processedMessages: LanguageModelChatMessage[] = [];

    // Find the newest message with images and build per-image hashes.
    // Only skip OCR when the SAME image reappears at the SAME message index
    // (VS Code re-attach). Different index = user deliberately re-sent → re-OCR.
    let newestImageIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const imgs = messages[i].content
        .map((p) => extractImageData(p))
        .filter((x): x is NonNullable<typeof x> => !!x);
      if (imgs.length > 0) {
        newestImageIdx = i;
        break;
      }
    }

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const isNewest = i === newestImageIdx;

      // Extract text parts
      const textParts: string[] = [];
      for (const part of msg.content) {
        const v = getTextPartValue(part);
        if (v !== undefined) {
          textParts.push(v);
        }
      }
      const userPrompt = textParts.join(" ");

      // Extract image data
      const images: Array<{ mimeType: string; data: Uint8Array }> = [];
      for (const part of msg.content) {
        const img = extractImageData(part);
        if (img) {
          images.push(img);
        }
      }

      if (images.length === 0) {
        processedMessages.push(msg);
        continue;
      }

      if (isNewest) {
        // Per-image dedup: only OCR images that are new OR appear at a new index
        const thisMessageDescriptions: string[] = [];
        let anyOcred = false;
        let anySkipped = false;
        for (const img of images) {
          const imgHash =
            img.mimeType +
            "|" +
            Buffer.from(
              img.data.length <= 2048
                ? img.data
                : img.data.subarray(0, 1024),
            ).toString("base64") +
            "|" +
            img.data.length;

          const prevIdx = this._ocrImageState.get(imgHash);
          if (prevIdx === newestImageIdx) {
            // Same image, same index → VS Code re-attach → skip
            anySkipped = true;
            continue;
          }

          // New image, or same image at new index (user re-sent) → OCR
          anyOcred = true;
          if (token.isCancellationRequested) {
            throw new vscode.CancellationError();
          }

          this._ocrImageState.set(imgHash, newestImageIdx);

          const base64Data = Buffer.from(img.data).toString("base64");
          const imageDataUrl = `data:${img.mimeType};base64,${base64Data}`;
          const analysisPrompt =
            userPrompt || "Describe this image in detail.";

          const reason =
            prevIdx === undefined
              ? "new image"
              : `user re-sent (was idx ${prevIdx}, now ${newestImageIdx})`;
          debugLog("VISION-PROXY-NEWEST-IMAGE", {
            imageSizeKB: Math.round(img.data.length / 1024),
            mimeType: img.mimeType,
            reason,
          });

          const description = await this._mcpClient.analyzeImage(
            imageDataUrl,
            analysisPrompt,
            visionProxyModel
          );
          thisMessageDescriptions.push(
            this.truncateTextToTokens(
              description,
              MAX_OCR_TOKENS,
              OCR_TRUNCATION_SUFFIX,
            ),
          );
        }

        if (anySkipped) {
          debugLog("VISION-PROXY-SKIPPED", {
            reason: "same image, same index (VS Code re-attach)",
            imageCount: images.length,
          });
        }

        // Always include the message: with OCR text (anyOcred) or just
        // user text (all skipped — OCR already lives in model context).
        if (!anyOcred) {
          const textContent = textParts.join(" ");
          processedMessages.push(
            vscode.LanguageModelChatMessage.User([
              textContent
                ? new vscode.LanguageModelTextPart(textContent)
                : new vscode.LanguageModelTextPart(
                    "[Image context already described above]",
                  ),
            ]),
          );
        }

        if (anyOcred) {
          this._lastNewestImageMsgIdx = newestImageIdx;

          const newContent: vscode.LanguageModelTextPart[] = [];
          for (const textPart of textParts) {
            newContent.push(new vscode.LanguageModelTextPart(textPart));
          }
          if (thisMessageDescriptions.length > 0) {
            newContent.push(
              new vscode.LanguageModelTextPart(
                `\n\n[Image Analysis]:\n${thisMessageDescriptions.join("\n\n---\n\n")}`,
              ),
            );
          }
          processedMessages.push(
            vscode.LanguageModelChatMessage.User(newContent),
          );
          imageDescriptions.push(...thisMessageDescriptions);
        }
      } else {
        // Older image: strip it — OCR text already lives in model context
        const textContent = textParts.join(" ");
        processedMessages.push(
          vscode.LanguageModelChatMessage.User([
            textContent
              ? new vscode.LanguageModelTextPart(textContent)
              : new vscode.LanguageModelTextPart(
                  "[Image context already described above]",
                ),
          ]),
        );
      }
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
    this._reasoningContentBuffer = "";
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
          console.error("[OpenCode] Progress.report failed", {
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
      // Extract original model ID from prefixed ID for API calls
      const originalModelId = this.extractOriginalModelId(model.id);
      let effectiveModelId = originalModelId;

      if (hasImages) {
        if (!this.modelSupportsVision(originalModelId)) {
          // Route images through the configured vision proxy for non-vision
          // models so users can explicitly control which image-capable model
          // performs the analysis.
          const visionProxyModel = getVisionProxyModelId();
          const visionProxyInfo = this.getModelInfo(visionProxyModel);
          if (visionProxyInfo && !visionProxyInfo.supportsVision) {
            throw new Error(
              `Configured vision proxy model "${visionProxyModel}" does not support vision`
            );
          }
          console.warn(
            "[OpenCode] Non-vision model, using configured vision proxy for image analysis",
            { visionProxyModel }
          );
          const result = await this.processImagesForNonVisionModel(
            messages,
            originalModelId,
            visionProxyModel,
            token
          );
          processedMessages = result.processedMessages;
        }
      }

      if (options.tools && options.tools.length > MAX_TOOLS_PER_REQUEST) {
        throw new Error(
          `Cannot have more than ${MAX_TOOLS_PER_REQUEST} tools per request.`
        );
      }

      validateRequest(processedMessages);

      // Get model info early for context restoration (budget-based strategy)
      const effectiveModelInfo = this.getModelInfo(effectiveModelId);
      const modelMaxInputTokens =
        effectiveModelInfo?.contextWindow ?? model.maxInputTokens;

      // ── Seamless Memory: Handle VS Code compaction ─────────────────
      // VS Code compacts long conversations by injecting a summary message
      // with a transcript path. Native models follow the ReadFile instruction,
      // but third-party models (MiniMax Free, etc.) cannot.
      // SMART STRATEGY (v0.7.2+): Summary FIRST, transcript ONLY if fits budget.
      // This fixes the root cause: VS Code sends OPTIMIZED summaries to native
      // Copilot models but RAW JSONL to third-party BYOK providers.
      processedMessages = await this.restoreConversation(
        processedMessages,
        modelMaxInputTokens
      );

      // Determine API format based on model
      const apiFormat = effectiveModelInfo?.apiFormat ?? "openai";
      const isAnthropic = apiFormat === "anthropic";

      // Estimate tokens (rough approximation)
      const inputTokenCount = estimateMessagesTokens(processedMessages, {
        maxToolResultChars: MAX_TOOL_RESULT_CHARS,
      });
      const mo = options.modelOptions as Record<string, Json> | undefined;

      // Extract thinking level from proposed API modelConfiguration (Insiders)
      // or from the variant model ID suffix (stable fallback)
      const modelConfiguration = (
        options as unknown as {
          readonly modelConfiguration?: { readonly [key: string]: unknown };
        }
      ).modelConfiguration;
      let thinkingLevel = modelConfiguration?.thinking_effort as
        | string
        | undefined;

      // Stable-API fallback: if no modelConfiguration, parse thinking level from
      // suffixed variant model IDs like "deepseek-v4-pro-high"
      // Use originalModelId to handle prefixed IDs like "opencode-go-deepseek-v4-pro-high"
      if (!thinkingLevel) {
        const parsed = parseVariantModelId(originalModelId);
        if (parsed.level) {
          thinkingLevel = parsed.level;
          effectiveModelId = parsed.baseId;
        }
      }

      const maxTokensVal =
        typeof mo?.max_tokens === "number" ? mo.max_tokens : DEFAULT_MAX_TOKENS;
      const temperatureVal =
        typeof effectiveModelInfo?.fixedTemperature === "number"
          ? effectiveModelInfo.fixedTemperature
          : typeof mo?.temperature === "number"
            ? mo.temperature
            : 0.7;
      const effectiveMaxOutputTokens =
        effectiveModelInfo?.maxOutput ?? model.maxOutputTokens;
      const requestedMaxTokens = Math.min(
        maxTokensVal,
        effectiveMaxOutputTokens
      );
      const tokenLimit = Math.max(
        1,
        effectiveModelInfo?.contextWindow ?? model.maxInputTokens
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
        thinkingLevel: thinkingLevel ?? "none",
      });
      if (totalEstimatedTokens > tokenLimit) {
        console.warn(
          `[OpenCode] Token budget exceeded — compacting (${totalEstimatedTokens} > ${tokenLimit})`,
          {
            total: totalEstimatedTokens,
            messageTokens: inputTokenCount,
            toolTokens: toolTokenCount,
            tokenLimit,
            contextWindow: effectiveModelInfo?.contextWindow,
            messageCount: processedMessages.length,
          }
        );

        const compactBudget = Math.floor(tokenLimit * 0.85);
        const compactionResult = this.compactMessagesWithinBudget(
          processedMessages,
          compactBudget,
          MAX_TOOL_RESULT_CHARS
        );

        processedMessages = compactionResult.messages;
        const newInputCount = estimateMessagesTokens(processedMessages, {
          maxToolResultChars: MAX_TOOL_RESULT_CHARS,
        });
        const newTotal = newInputCount + toolTokenCount;
        console.log(
          `[OpenCode] Compaction: ${compactionResult.droppedCount} dropped, ${processedMessages.length} msgs, ~${newTotal} tokens`
        );

        if (compactionResult.droppedCount === 0 && newTotal > tokenLimit) {
          const overrunPct = (newTotal - tokenLimit) / tokenLimit;
          if (overrunPct > TRANSCRIPT_OVERRUN_TOLERANCE) {
            throw new Error(
              `Message exceeds token limit (${newTotal} > ${tokenLimit}) — single message too large.`
            );
          }
        }
      }

      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      console.log("[OpenCode] 🚀 Starting chat request", {
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
          abortController,
          thinkingLevel
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
           effectiveModelId,
           thinkingLevel,
           effectiveModelInfo
         );
       }
    } catch (err) {
      if (
        token.isCancellationRequested ||
        (err instanceof Error && err.name === "AbortError")
      ) {
        throw new vscode.CancellationError();
      }
      console.error("[OpenCode] Chat request failed", {
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
     originalModelId: string,
     thinkingLevel?: string,
     modelInfo?: OcGoModelInfo
   ): Promise<void> {
    const toolConfig = convertTools(options);
    const apiMessages = convertMessages(processedMessages, {
      maxToolResultChars: MAX_TOOL_RESULT_CHARS,
    });

    const requestBody: OcGoRequestBody = {
      // Use original model ID for API calls (prefixed IDs are only for VS Code's model picker)
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

     // Apply model-specific sampling overrides
     if (modelInfo?.samplingOverrides) {
       const so = modelInfo.samplingOverrides;
       if (typeof so.temperature === "number") requestBody.temperature = so.temperature;
       if (typeof so.frequency_penalty === "number") requestBody.frequency_penalty = so.frequency_penalty;
       if (typeof so.presence_penalty === "number") requestBody.presence_penalty = so.presence_penalty;
       if (typeof so.repetition_penalty === "number") requestBody.repetition_penalty = so.repetition_penalty;
     }

     if (toolConfig.tools) {
      requestBody.tools = toolConfig.tools;
    }
    if (toolConfig.tool_choice) {
      requestBody.tool_choice = toolConfig.tool_choice;
    }

    // Inject thinking/reasoning parameters if a level was selected
    const thinkingParams = getThinkingParams(effectiveModelId, thinkingLevel);
    if (thinkingParams) {
      Object.assign(requestBody, thinkingParams);
      console.log("[OpenCode] Thinking params injected", {
        thinkingLevel,
        params: thinkingParams,
      });
    }

    const response = await fetch(`${this._baseUrl}/chat/completions`, {
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
      await this.rejectForErrorResponse(response as ErrorResponseLike);
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
    abortController: AbortController,
    thinkingLevel?: string
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

    // Inject thinking/reasoning parameters if a level was selected
    const thinkingParams = getThinkingParams(effectiveModelId, thinkingLevel);
    if (thinkingParams) {
      Object.assign(requestBody, thinkingParams);
      console.log("[OpenCode] Anthropic thinking params injected", {
        thinkingLevel,
        params: thinkingParams,
      });
    }

    console.log("[OpenCode] Anthropic request body", {
      model: requestBody.model,
      system: requestBody.system,
      messagesCount: requestBody.messages.length,
      messages: requestBody.messages,
      toolsCount: requestBody.tools?.length,
      max_tokens: requestBody.max_tokens,
      temperature: requestBody.temperature,
      tool_choice: requestBody.tool_choice,
    });

    const response = await fetch(`${this._baseUrl}/messages`, {
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
      await this.rejectForErrorResponse(response as ErrorResponseLike);
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
    let apiKey = await this.secrets.get(this._secretKeyName);
    if (!apiKey && !silent) {
      const label = this._vendorLabel;
      const entered = await vscode.window.showInputBox({
        title: `${label} API Key`,
        prompt: `Enter your ${label} API key`,
        ignoreFocusOut: true,
        password: true,
      });
      if (entered && entered.trim()) {
        apiKey = entered.trim();
        await this.secrets.store(this._secretKeyName, apiKey);
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
              reasoningChars: this._reasoningContentBuffer.length,
              hasReasoning: this._reasoningContentBuffer.length > 0,
            });
            console.log(
              "[OpenCode] Stream [DONE], final usage metrics:",
              {
                prompt_tokens: this._usageMetrics.prompt_tokens,
                completion_tokens: this._usageMetrics.completion_tokens,
                alreadyReported: this._usageReported,
              }
            );
            this.reportReasoningContent(progress);
            this.reportUsageMetrics(progress);
            continue;
          }

          try {
            const parsed = JSON.parse(data) as OcGoStreamResponse;
            // Track usage metrics from the response
            if (parsed.usage) {
              console.log(
                "[OpenCode] Received usage in chunk:",
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
                "[OpenCode] Received usage-only final chunk:",
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
      this._reasoningContentBuffer = "";
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
      console.log("[OpenCode] Token usage metrics", {
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
          "[OpenCode] Failed to report usage via progress",
          e
        );
      }
      this._usageReported = true;
    }
  }

  /**
   * Report accumulated reasoning content to VS Code Chat UI via LanguageModelDataPart.
   * This preserves reasoning content in the conversation history so it can be
   * included in subsequent requests (required by Moonshot AI/Kimi when thinking is enabled).
   */
  private reportReasoningContent(
    progress: vscode.Progress<vscode.LanguageModelResponsePart>
  ): void {
    if (!this._reasoningContentBuffer) {
      return;
    }
    try {
      progress.report(this.createReasoningPart(this._reasoningContentBuffer));
    } catch (e) {
      console.warn(
        "[OpenCode] Failed to report reasoning content via progress",
        e
      );
    }
  }

  private createReasoningPart(
    content: string
  ): vscode.LanguageModelResponsePart {
    const ThinkingPartCtor = (
      vscode as unknown as {
        LanguageModelThinkingPart?: new (value: string) => vscode.LanguageModelResponsePart;
      }
    ).LanguageModelThinkingPart;

    if (typeof ThinkingPartCtor === "function") {
      return new ThinkingPartCtor(content);
    }

    return vscode.LanguageModelDataPart.json(
      {
        type: "reasoning",
        content,
      },
      "application/vnd.opencode-go.reasoning+json"
    );
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

    // Handle reasoning content
    // DeepSeek, GLM, Qwen, MiMo stream reasoning in the `reasoning_content` field.
    // Moonshot AI/Kimi streams reasoning in the `reasoning` field (not `reasoning_content`).
    // We accumulate both here and later emit as a data part so it is preserved in history.
    if (deltaObj?.reasoning_content) {
      this._reasoningContentBuffer += String(deltaObj.reasoning_content);
    }
    if (deltaObj?.reasoning) {
      this._reasoningContentBuffer += String(deltaObj.reasoning);
    }

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
            "[OpenCode] Invalid JSON for tool call",
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

  /**
   * Check if VS Code has compacted the conversation by examining the first
   * user message for the compaction marker text.
   * Returns the transcript path if found, undefined otherwise.
   */
  /**
   * Detect if VS Code has injected a compaction summary at the START of the
   * message array. VS Code's copilot-chat produces a marker like:
   *   "[Compacted X earlier messages — summary: ...]"
   * in the first user message, followed by a transcript path.
   *
   * Returns the compacted summary text (everything after the marker prefix
   * and before "If you need specific details...") so we can use it directly.
   */
  private detectCompactionSummary(
    messages: readonly LanguageModelChatMessage[]
  ): string | undefined {
    if (messages.length === 0) return undefined;
    const first = messages[0];
    if (first.role !== LanguageModelChatMessageRole.User) return undefined;

    const textParts: string[] = [];
    for (const part of first.content) {
      const v = getTextPartValue(part);
      if (v !== undefined) textParts.push(v);
    }
    const fullText = textParts.join(" ");

    // VS Code compact marker: "[Compacted X earlier messages — summary:"
    if (!fullText.includes("[Compacted") || !fullText.includes("— summary:")) {
      return undefined;
    }

    // Extract everything after "— summary:" and before "If you need specific details"
    const markerIdx = fullText.indexOf("— summary:");
    let summary = fullText.slice(markerIdx + "— summary:".length).trim();

    // Strip the ReadFile instruction block if present
    const readFileIdx = summary.indexOf("If you need specific details");
    if (readFileIdx !== -1) {
      summary = summary.slice(0, readFileIdx).trim();
    }

    // Strip trailing markers/notes like "Example usage: ReadFile(...)"
    const exampleIdx = summary.lastIndexOf("Example usage:");
    if (exampleIdx !== -1) {
      summary = summary.slice(0, exampleIdx).trim();
    }

    if (!summary) return undefined;
    debugLog("COMPACTION-SUMMARY-EXTRACTED", { length: summary.length });
    return summary;
  }

  /**
   * Detect the transcript path from the compaction marker in the first message.
   * Returns the .jsonl file path if the path is found and readable.
   */
  private detectTranscriptPath(
    messages: readonly LanguageModelChatMessage[]
  ): string | undefined {
    if (messages.length === 0) return undefined;
    const first = messages[0];
    if (first.role !== LanguageModelChatMessageRole.User) return undefined;

    const textParts: string[] = [];
    for (const part of first.content) {
      const v = getTextPartValue(part);
      if (v !== undefined) textParts.push(v);
    }
    const fullText = textParts.join(" ");

    const match = fullText.match(/transcript at:\s*"([^"]+)"/);
    return match?.[1];
  }

  /**
   * Parse VS Code's JSONL transcript file into a flat list of user/assistant
   * messages. Each line is a JSON object following VS Code's IHistoricalTurn
   * format: { userMessage: string, rounds: [{ response: string, toolCalls, reasoningText }] }
   */
  private async parseTranscript(
    path: string
  ): Promise<LanguageModelChatMessage[] | null> {
    try {
      const uri = vscode.Uri.file(path);
      const bytes = await vscode.workspace.fs.readFile(uri);
      const content = new TextDecoder().decode(bytes);
      const lines = content.split("\n");
      const result: LanguageModelChatMessage[] = [];
      let parsedLines = 0;

      for (const rawLine of lines) {
        if (parsedLines >= MAX_TRANSCRIPT_LINES) break;
        const line = rawLine.trim();
        if (!line) continue;

        let turn: {
          userMessage?: string;
          rounds?: Array<{
            response?: string;
            toolCalls?: Array<{
              name?: string;
              arguments?: string;
              result?: string;
            }>;
          }>;
        };

        try {
          turn = JSON.parse(line) as typeof turn;
        } catch {
          continue;
        }

        if (turn.userMessage) {
          result.push(
            vscode.LanguageModelChatMessage.User([
              new vscode.LanguageModelTextPart(turn.userMessage),
            ])
          );
          parsedLines++;
        }

        if (turn.rounds) {
          for (const round of turn.rounds) {
            if (round.response) {
              result.push(
                vscode.LanguageModelChatMessage.Assistant([
                  new vscode.LanguageModelTextPart(round.response),
                ])
              );
              parsedLines++;
            }
            if (round.toolCalls) {
              for (const tc of round.toolCalls) {
                const _args =
                  typeof tc.arguments === "string"
                    ? tc.arguments
                    : JSON.stringify(tc.arguments ?? {});
                result.push(
                  vscode.LanguageModelChatMessage.Assistant([
                    new vscode.LanguageModelToolCallPart(
                      `tc_${parsedLines}`,
                      tc.name ?? "unknown",
                      {}
                    ),
                  ])
                );
                if (tc.result) {
                  result.push(
                    vscode.LanguageModelChatMessage.User([
                      new vscode.LanguageModelToolResultPart(
                        `tc_${parsedLines}`,
                        [new vscode.LanguageModelTextPart(tc.result)]
                      ),
                    ])
                  );
                }
                parsedLines++;
              }
            }
          }
        }
      }

      debugLog("TRANSCRIPT-PARSED", {
        path,
        messageCount: result.length,
      });
      return result.length > 0 ? result : null;
    } catch (err) {
      console.warn("[OpenCode] Transcript parse failed", {
        path,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Restore conversation when VS Code has compacted.
   *
   * SMART BUDGET-BASED STRATEGY (v0.7.2+):
   * - REVERSE priority: summary FIRST, transcript ONLY if it fits in budget
   * - This fixes the root cause: VS Code sends OPTIMIZED summaries to native
   *   Copilot models but RAW JSONL to third-party BYOK providers
   * - For small-context models (MiniMax 2.5 Free: 204K), summary is the correct choice
   * - For large-context models (DeepSeek V4 Flash Free: 1M), transcript can be used
   *
   * Strategy selection:
   * 1. If summary fits in 85% budget → use summary (preferred for all models)
   * 2. If transcript fits in 85% budget → use transcript (for large-context models)
   * 3. If neither fits alone → progressive fallback (last 5 turns + summary)
   * 4. If no compaction marker → return as-is (normal flow)
   *
   * This ensures seamless memory across model switches and compaction events,
   * for ALL models regardless of their tool-calling capability.
   */
  private async restoreConversation(
    messages: readonly LanguageModelChatMessage[],
    maxInputTokens?: number
  ): Promise<readonly LanguageModelChatMessage[]> {
    const summaryText = this.detectCompactionSummary(messages);
    const transcriptPath = this.detectTranscriptPath(messages);

    debugLog("RESTORE-CONVERSATION-START", {
      hasSummary: !!summaryText,
      hasTranscript: !!transcriptPath,
      maxInputTokens,
      messageCount: messages.length,
    });

    if (!summaryText && !transcriptPath) {
      debugLog("RESTORE-CONVERSATION-SKIP", {
        reason: "no compaction marker detected",
      });
      return messages;
    }

    let currentInput = "";
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === LanguageModelChatMessageRole.User) {
      const parts: string[] = [];
      for (const part of lastMsg.content) {
        const v = getTextPartValue(part);
        if (v !== undefined) parts.push(v);
      }
      currentInput = parts.join(" ");
    }

    const BUDGET_SAFETY_FACTOR = 0.85;
    const safeBudget = maxInputTokens
      ? Math.floor(maxInputTokens * BUDGET_SAFETY_FACTOR)
      : 0;

    debugLog("RESTORE-BUDGET", {
      maxInputTokens,
      safeBudget,
      summaryLength: summaryText?.length ?? 0,
    });

    const summaryTokens = summaryText
      ? estimateTokensWithOverhead(summaryText)
      : 0;

    if (summaryText && safeBudget > 0 && summaryTokens <= safeBudget) {
      debugLog("RESTORE-STRATEGY", {
        strategy: "summary",
        summaryTokens,
        safeBudget,
        fits: summaryTokens <= safeBudget,
      });

      console.log(
        `[OpenCode] Context Restoration: Using SUMMARY (${summaryTokens} tokens, budget: ${safeBudget})`
      );

      const restored = this.buildSummaryContext(summaryText, currentInput);
      debugLog("RESTORE-COMPLETE", {
        strategy: "summary",
        messageCount: restored.length,
      });
      return restored;
    }

    let transcript: LanguageModelChatMessage[] | null = null;
    if (transcriptPath) {
      const parseResult = await this.parseTranscript(transcriptPath);
      if (parseResult && parseResult.length > 0) {
        transcript = parseResult;
      }
    }

    const transcriptTokens = transcript
      ? estimateMessagesTokens(transcript, { maxToolResultChars: MAX_TOOL_RESULT_CHARS })
      : 0;

    if (transcript && safeBudget > 0 && transcriptTokens <= safeBudget) {
      debugLog("RESTORE-STRATEGY", {
        strategy: "transcript",
        transcriptTokens,
        safeBudget,
        fits: transcriptTokens <= safeBudget,
      });

      console.log(
        `[OpenCode] Context Restoration: Using TRANSCRIPT (${transcriptTokens} tokens, budget: ${safeBudget})`
      );

      const inputAlreadyInTranscript = transcript.some((msg) => {
        if (msg.role !== LanguageModelChatMessageRole.User) return false;
        for (const part of msg.content) {
          const v = getTextPartValue(part);
          if (v !== undefined && currentInput.trim().length > 10) {
            const preview = currentInput.trim().slice(0, 50);
            if (v.includes(preview)) return true;
          }
        }
        return false;
      });

      if (!inputAlreadyInTranscript && currentInput) {
        transcript.push(
          vscode.LanguageModelChatMessage.User([
            new vscode.LanguageModelTextPart(currentInput),
          ])
        );
      }

      debugLog("RESTORE-COMPLETE", {
        strategy: "transcript",
        messageCount: transcript.length,
      });
      console.log(
        `[OpenCode] Transcript restored: ${transcript.length} messages`
      );
      return transcript;
    }

    if (summaryText && safeBudget > 0) {
      debugLog("RESTORE-STRATEGY", {
        strategy: "progressive",
        reason:
          summaryTokens > safeBudget && transcriptTokens > safeBudget
            ? "neither fits alone"
            : summaryTokens > safeBudget
              ? "summary too large"
              : "transcript too large",
        summaryTokens,
        transcriptTokens,
        safeBudget,
      });

      console.log(
        `[OpenCode] Context Restoration: Using PROGRESSIVE (summary: ${summaryTokens}, transcript: ${transcriptTokens}, budget: ${safeBudget})`
      );

      const restored = this.buildProgressiveContext(
        transcript,
        summaryText,
        currentInput,
        safeBudget
      );

      debugLog("RESTORE-COMPLETE", {
        strategy: "progressive",
        messageCount: restored.length,
      });
      return restored;
    }

    if (summaryText) {
      debugLog("RESTORE-FALLBACK", {
        strategy: "summary-only",
        reason: "no budget info or budget check disabled",
      });

      console.log(
        `[OpenCode] Context Restoration: Using SUMMARY (fallback, no budget info)`
      );

      const restored = this.buildSummaryContext(summaryText, currentInput);
      return restored;
    }

    debugLog("RESTORE-COMPLETE", {
      strategy: "none",
      reason: "no summary available",
    });
    return messages;
  }

  /**
   * Build context using summary text only (preferred for small-context models).
   */
  private buildSummaryContext(
    summaryText: string,
    currentInput: string
  ): LanguageModelChatMessage[] {
    const restored: LanguageModelChatMessage[] = [];

    if (summaryText && currentInput.trim().length > 10) {
      const inputPreview = currentInput.trim().slice(0, 80);
      if (summaryText.includes(inputPreview)) {
        restored.push(
          vscode.LanguageModelChatMessage.User([
            new vscode.LanguageModelTextPart(summaryText),
          ])
        );
        console.log(
          `[OpenCode] Compaction summary used directly (current input embedded in summary)`
        );
        return restored;
      }
    }

    if (summaryText) {
      restored.push(
        vscode.LanguageModelChatMessage.User([
          new vscode.LanguageModelTextPart(summaryText),
        ])
      );
    }

    if (currentInput && (!summaryText || !summaryText.includes(currentInput.trim().slice(0, 80)))) {
      restored.push(
        vscode.LanguageModelChatMessage.User([
          new vscode.LanguageModelTextPart(currentInput),
        ])
      );
    }

    console.log(
      `[OpenCode] Compaction summary used directly (${restored.length} messages)`
    );
    return restored;
  }

  /**
   * Build progressive context when neither full transcript nor summary fits.
   * Strategy: last N turns from transcript + summary text
   */
  private buildProgressiveContext(
    transcript: LanguageModelChatMessage[] | null,
    summaryText: string,
    currentInput: string,
    safeBudget: number
  ): LanguageModelChatMessage[] {
    const result: LanguageModelChatMessage[] = [];

    const RECENT_TURNS = 5;
    const summaryTokens = estimateTokensWithOverhead(summaryText);
    const availableForRecent = Math.max(0, safeBudget - summaryTokens);

    debugLog("PROGRESSIVE-BUILD", {
      summaryTokens,
      availableForRecent,
      recentTurns: RECENT_TURNS,
    });

    if (summaryText) {
      result.push(
        vscode.LanguageModelChatMessage.User([
          new vscode.LanguageModelTextPart(summaryText),
        ])
      );
    }

    if (transcript && transcript.length > 0) {
      const recentMessages = transcript.slice(-RECENT_TURNS * 2);
      const recentTokens = estimateMessagesTokens(recentMessages, {
        maxToolResultChars: MAX_TOOL_RESULT_CHARS,
      });

      if (recentTokens <= availableForRecent) {
        result.push(...recentMessages);
        console.log(
          `[OpenCode] Progressive context: ${recentMessages.length} recent turns + summary`
        );
      } else {
        let includedCount = 0;
        for (let i = recentMessages.length - 1; i >= 0; i--) {
          const msg = recentMessages[i];
          const msgTokens = estimateMessagesTokens([msg], {
            maxToolResultChars: MAX_TOOL_RESULT_CHARS,
          });
          if (result.reduce((acc, m) => acc + estimateMessagesTokens([m], { maxToolResultChars: MAX_TOOL_RESULT_CHARS }), 0) + msgTokens <= availableForRecent) {
            result.unshift(msg);
            includedCount++;
          } else {
            break;
          }
        }
        console.log(
          `[OpenCode] Progressive context: ${includedCount} recent turns + summary (budget limited)`
        );
      }
    }

    if (currentInput) {
      const lastMsg = result[result.length - 1];
      if (lastMsg?.role === LanguageModelChatMessageRole.User) {
        const existingText = lastMsg.content
          .map((p) => getTextPartValue(p))
          .filter((v): v is string => v !== undefined)
          .join(" ");

        if (!existingText.includes(currentInput.trim().slice(0, 50))) {
          result.push(
            vscode.LanguageModelChatMessage.User([
              new vscode.LanguageModelTextPart(currentInput),
            ])
          );
        }
      } else {
        result.push(
          vscode.LanguageModelChatMessage.User([
            new vscode.LanguageModelTextPart(currentInput),
          ])
        );
      }
    }

    return result;
  }

  private compactMessagesWithinBudget(
    messages: readonly LanguageModelChatMessage[],
    budget: number,
    maxToolResultChars: number
  ): { messages: LanguageModelChatMessage[]; droppedCount: number } {
    if (messages.length <= 1) {
      return { messages: Array.from(messages), droppedCount: 0 };
    }

    const result: LanguageModelChatMessage[] = [];
    let totalTokens = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const tokens = estimateMessagesTokens([msg], { maxToolResultChars });

      if (result.length === 0) {
        result.unshift(msg);
        totalTokens = tokens;
      } else if (totalTokens + tokens <= budget) {
        result.unshift(msg);
        totalTokens += tokens;
      } else {
        break;
      }
    }

    return {
      messages: result,
      droppedCount: messages.length - result.length,
    };
  }
}
