import * as vscode from "vscode";
import type {
  OcGoChatMessage,
  OcGoTool,
  OcGoContentPart,
  Json,
  JsonObject,
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicTool,
} from "./types";

/**
 * Legacy part shape used by mocks or older API shapes
 */
export interface LegacyPart {
  type?: string;
  mimeType?: string;
  bytes?: Uint8Array | number[];
  data?: Uint8Array | number[];
  buffer?: ArrayBuffer;
  value?: string;
  callId?: string;
  input?: Json | JsonObject | Json[];
  arguments?: string | JsonObject;
  name?: string;
  [key: string]: Json | Uint8Array | number[] | ArrayBuffer | undefined;
}

/**
 * Helper: extract text value from a LanguageModelTextPart or plain object
 */
export function getTextPartValue(
  part: vscode.LanguageModelInputPart | LegacyPart
): string | undefined {
  if (part instanceof vscode.LanguageModelTextPart) {
    return part.value;
  }
  if (typeof part === "object" && part !== null) {
    const p = part as { value?: string };
    if (typeof p.value === "string") {
      return p.value;
    }
  }
  return undefined;
}

function toUint8Array(
  data: Uint8Array | number[] | ArrayBuffer | undefined
): Uint8Array | undefined {
  if (data instanceof Uint8Array && data.length > 0) {
    return data;
  }
  if (Array.isArray(data) && data.length > 0) {
    return new Uint8Array(data);
  }
  if (data instanceof ArrayBuffer && data.byteLength > 0) {
    return new Uint8Array(data);
  }
  return undefined;
}

/**
 * Helper: extract UTF-8 text from LanguageModelDataPart-like content
 */
export function getDataPartTextValue(
  part: vscode.LanguageModelInputPart | LegacyPart
): string | undefined {
  if (typeof part !== "object" || part === null) {
    return undefined;
  }

  const p = part as {
    mimeType?: unknown;
    data?: Uint8Array | number[];
    bytes?: Uint8Array | number[];
    buffer?: ArrayBuffer;
  };
  if (typeof p.mimeType !== "string") {
    return undefined;
  }

  const isTextMime =
    p.mimeType.startsWith("text/") ||
    p.mimeType === "application/json" ||
    p.mimeType.endsWith("+json");
  if (!isTextMime) {
    return undefined;
  }

  const bytes =
    toUint8Array(p.data) ?? toUint8Array(p.bytes) ?? toUint8Array(p.buffer);
  if (!bytes) {
    return undefined;
  }

  try {
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Helper: extract image bytes and mime type from a variety of part shapes
 */
export function extractImageData(
  part: vscode.LanguageModelInputPart | LegacyPart
): { mimeType: string; data: Uint8Array } | undefined {
  const dataPart = part as { mimeType?: unknown; data?: unknown } | null;
  if (
    dataPart &&
    typeof dataPart.mimeType === "string" &&
    dataPart.mimeType.startsWith("image/") &&
    dataPart.data instanceof Uint8Array &&
    dataPart.data.length > 0
  ) {
    return { mimeType: dataPart.mimeType, data: dataPart.data };
  }

  if (typeof part !== "object" || part === null) {
    return undefined;
  }

  const p = part as LegacyPart;

  if (p.type === "image") {
    const mimeType = typeof p.mimeType === "string" ? p.mimeType : "image/png";
    if (p.bytes instanceof Uint8Array && p.bytes.length > 0) {
      return { mimeType, data: p.bytes };
    }
    if (p.data instanceof Uint8Array && p.data.length > 0) {
      return { mimeType, data: p.data };
    }
    if (p.buffer instanceof ArrayBuffer && p.buffer.byteLength > 0) {
      return { mimeType, data: new Uint8Array(p.buffer) };
    }
    if (Array.isArray(p.bytes) && p.bytes.length > 0) {
      return { mimeType, data: new Uint8Array(p.bytes) };
    }
    if (Array.isArray(p.data) && p.data.length > 0) {
      return { mimeType, data: new Uint8Array(p.data) };
    }
    return undefined;
  }

  if (typeof p.mimeType === "string" && p.mimeType.startsWith("image/")) {
    const mimeType = p.mimeType;
    if (p.bytes instanceof Uint8Array && p.bytes.length > 0) {
      return { mimeType, data: p.bytes };
    }
    if (p.data instanceof Uint8Array && p.data.length > 0) {
      return { mimeType, data: p.data };
    }
    if (p.buffer instanceof ArrayBuffer && p.buffer.byteLength > 0) {
      return { mimeType, data: new Uint8Array(p.buffer) };
    }
    if (Array.isArray(p.bytes) && p.bytes.length > 0) {
      return { mimeType, data: new Uint8Array(p.bytes) };
    }
    if (Array.isArray(p.data) && p.data.length > 0) {
      return { mimeType, data: new Uint8Array(p.data) };
    }
  }

  return undefined;
}

/**
 * Helper: extract tool call info from a part
 */
export function getToolCallInfo(
  part: vscode.LanguageModelInputPart | LegacyPart
): { id?: string; name?: string; args?: Json | string } | undefined {
  if (part instanceof vscode.LanguageModelToolCallPart) {
    return { id: part.callId, name: part.name, args: part.input as Json };
  }
  if (typeof part === "object" && part !== null) {
    const p = part as LegacyPart;
    const isLegacyToolCall =
      p.type === "tool_call" ||
      ((typeof p.name === "string" || typeof p.callId === "string") &&
        (p.input !== undefined || p.arguments !== undefined));
    if (isLegacyToolCall) {
      return {
        id: p.callId,
        name: p.name,
        args: (p.input ?? p.arguments) as Json | string,
      };
    }
  }
  return undefined;
}

/**
 * Helper: extract tool result textual representation from a part
 */
function truncateText(text: string, maxChars?: number): string {
  if (typeof maxChars !== "number" || maxChars <= 0) {
    return text;
  }
  if (text.length <= maxChars) {
    return text;
  }
  const removed = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n...[truncated ${removed} chars]`;
}

function isLegacyToolResultPart(part: LegacyPart): boolean {
  if (typeof part.type === "string") {
    const t = part.type.toLowerCase();
    return t === "tool_result" || t === "tool_result_part";
  }
  if (typeof part.callId === "string") {
    const p = part as LegacyPart & { content?: unknown };
    const hasResultShape =
      p.value !== undefined ||
      p.content !== undefined ||
      p.type === "tool_result" ||
      p.type === "tool_result_part";
    const looksLikeToolCall =
      p.name !== undefined ||
      p.input !== undefined ||
      p.arguments !== undefined ||
      p.type === "tool_call";
    return hasResultShape && !looksLikeToolCall;
  }
  return false;
}

export function getToolResultTexts(
  part: vscode.LanguageModelInputPart | LegacyPart,
  maxChars?: number
): string[] {
  const results: string[] = [];

  if (part instanceof vscode.LanguageModelToolResultPart) {
    for (const inner of part.content) {
      const tv = getTextPartValue(
        inner as vscode.LanguageModelInputPart | LegacyPart
      );
      if (tv !== undefined) {
        results.push(truncateText(tv, maxChars));
        continue;
      }
      const dv = getDataPartTextValue(
        inner as vscode.LanguageModelInputPart | LegacyPart
      );
      if (dv !== undefined) {
        results.push(truncateText(dv, maxChars));
        continue;
      }
      try {
        if (
          typeof (inner as { valueOf?: () => string | object }).valueOf ===
          "function"
        ) {
          const v = (inner as { valueOf: () => string | object }).valueOf();
          results.push(
            truncateText(
              typeof v === "string" ? v : JSON.stringify(v),
              maxChars
            )
          );
        } else {
          results.push(truncateText(JSON.stringify(inner), maxChars));
        }
      } catch {
        results.push(truncateText(String(inner), maxChars));
      }
    }
    return results;
  }

  if (typeof part === "object" && part !== null) {
    const p = part as LegacyPart;
    if (!isLegacyToolResultPart(p)) {
      return results;
    }
    if (typeof p.value === "string") {
      results.push(truncateText(p.value, maxChars));
    } else if (
      typeof (p as { valueOf?: () => string | object }).valueOf === "function"
    ) {
      try {
        const v = (p as { valueOf: () => string | object }).valueOf();
        results.push(
          truncateText(typeof v === "string" ? v : JSON.stringify(v), maxChars)
        );
      } catch {
        results.push(truncateText(JSON.stringify(p), maxChars));
      }
    } else {
      results.push(truncateText(JSON.stringify(p), maxChars));
    }
  }

  return results;
}

/**
 * Convert VSCode LanguageModelChatMessage to OpenCode Go/OpenAI format
 */
export function convertMessages(
  messages: readonly vscode.LanguageModelChatMessage[],
  options?: { maxToolResultChars?: number }
): OcGoChatMessage[] {
  const result: OcGoChatMessage[] = [];

  for (const msg of messages) {
    const role =
      msg.role === vscode.LanguageModelChatMessageRole.User
        ? "user"
        : msg.role === vscode.LanguageModelChatMessageRole.Assistant
          ? "assistant"
          : "system";

    // Collect text parts
    const textParts: string[] = [];
    for (const part of msg.content) {
      const tv = getTextPartValue(part);
      if (tv !== undefined) {
        textParts.push(tv);
      }
    }

    // Collect images
    const imageParts: OcGoContentPart[] = [];
    for (const part of msg.content) {
      const img = extractImageData(part);
      if (!img) continue;
      if (img.data && img.data.length > 0) {
        const base64Data = Buffer.from(img.data).toString("base64");
        imageParts.push({
          type: "image_url",
          image_url: { url: `data:${img.mimeType};base64,${base64Data}` },
        });
      } else {
        console.warn(
          "[OpenCode Go] Image part has no accessible byte data:",
          part
        );
      }
    }

    // Handle tool calls
    const toolCalls = msg.content
      .map((p) => getToolCallInfo(p))
      .filter(
        (t): t is { id?: string; name?: string; args?: Json | string } => !!t
      );

    let emittedAnyMessage = false;
    if (toolCalls.length > 0) {
      const assistantContent = textParts.join("");
      result.push({
        role: "assistant",
        content: assistantContent || "",
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
          type: "function",
          function: {
            name: tc.name ?? "unknown",
            arguments: JSON.stringify(tc.args ?? {}),
          },
        })),
        // Kimi (Moonshot AI) requires reasoning_content in assistant messages with tool_calls
        // when thinking mode is enabled; harmless for other providers
        reasoning_content: "",
      });
      emittedAnyMessage = true;
    }

    // Handle tool results
    const toolResults = getToolResultEntries(
      msg.content as Array<vscode.LanguageModelInputPart | LegacyPart>,
      options?.maxToolResultChars
    );
    for (const tr of toolResults) {
      result.push({
        role: "tool",
        tool_call_id: tr.callId,
        content: tr.content || "",
      });
      emittedAnyMessage = true;
    }

    if (
      (textParts.length > 0 || imageParts.length > 0) &&
      !(role === "assistant" && toolCalls.length > 0)
    ) {
      if (imageParts.length > 0) {
        const contentParts: OcGoContentPart[] = [];
        const textContent = textParts.join("");
        if (textContent) {
          contentParts.push({ type: "text", text: textContent });
        }
        contentParts.push(...imageParts);
        const msg: OcGoChatMessage = { role, content: contentParts };
        if (role === "assistant") {
          msg.reasoning_content = "";
        }
        result.push(msg);
      } else {
        const msg: OcGoChatMessage = { role, content: textParts.join("") };
        if (role === "assistant") {
          msg.reasoning_content = "";
        }
        result.push(msg);
      }
      emittedAnyMessage = true;
    }

    if (!emittedAnyMessage) {
      result.push({ role, content: "(empty message)" });
    }
  }

  return result;
}

function getToolResultEntries(
  parts: Array<vscode.LanguageModelInputPart | LegacyPart>,
  maxChars?: number
): Array<{ callId: string; content: string }> {
  const entries: Array<{ callId: string; content: string }> = [];

  for (const part of parts) {
    if (part instanceof vscode.LanguageModelToolResultPart) {
      const content = getToolResultTexts(part, maxChars).join("\n").trim();
      entries.push({ callId: part.callId, content });
      continue;
    }

    if (typeof part !== "object" || part === null) {
      continue;
    }
    const legacy = part as LegacyPart;
    if (!isLegacyToolResultPart(legacy)) {
      continue;
    }
    if (typeof legacy.callId !== "string" || !legacy.callId) {
      continue;
    }
    const content = getToolResultTexts(legacy, maxChars).join("\n").trim();
    entries.push({ callId: legacy.callId, content });
  }

  return entries;
}

export function getFirstToolResultCallId(
  parts: Array<vscode.LanguageModelInputPart | LegacyPart>
): string | undefined {
  for (const p of parts) {
    if (p instanceof vscode.LanguageModelToolResultPart) {
      return p.callId;
    }
    if (typeof p === "object" && p !== null) {
      const lp = p as LegacyPart;
      if (typeof lp.callId === "string") {
        return lp.callId;
      }
    }
  }
  return undefined;
}

/**
 * Convert VSCode tools to OpenCode Go/OpenAI format
 */
export function convertTools(
  options: vscode.ProvideLanguageModelChatResponseOptions
): {
  tools?: OcGoTool[];
  tool_choice?: "auto" | { type: "function"; function: { name: string } };
} {
  const toolsInput = options.tools ?? [];
  if (toolsInput.length === 0) {
    if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
      throw new Error(
        "LanguageModelChatToolMode.Required requires at least one tool."
      );
    }
    return {};
  }

  const tools: OcGoTool[] = toolsInput.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as JsonObject,
    },
  }));

  let tool_choice: "auto" | { type: "function"; function: { name: string } } =
    "auto";

  if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
    if (tools.length !== 1) {
      throw new Error(
        "LanguageModelChatToolMode.Required is not supported with more than one tool."
      );
    }
    tool_choice = {
      type: "function",
      function: { name: tools[0].function.name },
    };
  }

  return { tools, tool_choice };
}

/**
 * Convert VSCode LanguageModelChatMessage to Anthropic Messages API format
 *
 * Anthropic format differences from OpenAI:
 * - System messages are extracted as a top-level `system` parameter
 * - Only `user` and `assistant` roles are allowed in messages
 * - Tool results use `role: "user"` with `content: [{type: "tool_result", ...}]`
 * - Images use `{type: "image", source: {type: "base64", ...}}` format
 */
export function convertMessagesToAnthropic(
  messages: readonly vscode.LanguageModelChatMessage[],
  options?: { maxToolResultChars?: number }
): { system?: string; messages: AnthropicMessage[] } {
  const systemParts: string[] = [];
  const result: AnthropicMessage[] = [];

  for (const msg of messages) {
    const isUser = msg.role === vscode.LanguageModelChatMessageRole.User;
    const isAssistant =
      msg.role === vscode.LanguageModelChatMessageRole.Assistant;

    // Collect text parts
    const textParts: string[] = [];
    for (const part of msg.content) {
      const tv = getTextPartValue(part);
      if (tv !== undefined) {
        textParts.push(tv);
      }
    }

    // Collect images in Anthropic format
    const imageBlocks: AnthropicContentBlock[] = [];
    for (const part of msg.content) {
      const img = extractImageData(part);
      if (img && img.data && img.data.length > 0) {
        const base64Data = Buffer.from(img.data).toString("base64");
        imageBlocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: img.mimeType,
            data: base64Data,
          },
        });
      }
    }

    // Handle tool calls (assistant messages)
    const toolCalls = msg.content
      .map((p) => getToolCallInfo(p))
      .filter(
        (t): t is { id?: string; name?: string; args?: Json | string } => !!t
      );

    // Handle tool results
    const toolResults = getToolResultEntries(
      msg.content as Array<vscode.LanguageModelInputPart | LegacyPart>,
      options?.maxToolResultChars
    );

    // System messages → top-level system parameter
    if (!isUser && !isAssistant) {
      const text = textParts.join("");
      if (text) {
        systemParts.push(text);
      }
      continue;
    }

    const role: "user" | "assistant" = isUser ? "user" : "assistant";

    // Build content blocks for this message
    const contentBlocks: AnthropicContentBlock[] = [];

    // Text content
    const textContent = textParts.join("");
    if (textContent) {
      contentBlocks.push({ type: "text", text: textContent });
    }

    // Images
    contentBlocks.push(...imageBlocks);

    // Tool calls (assistant messages)
    if (isAssistant && toolCalls.length > 0) {
      for (const tc of toolCalls) {
        const inputObj =
          typeof tc.args === "string"
            ? (() => {
                try {
                  return JSON.parse(tc.args) as JsonObject;
                } catch {
                  return {} as JsonObject;
                }
              })()
            : ((tc.args as JsonObject) ?? ({} as JsonObject));
        contentBlocks.push({
          type: "tool_use",
          id: tc.id ?? `toolu_${Math.random().toString(36).slice(2, 14)}`,
          name: tc.name ?? "unknown",
          input: inputObj,
        });
      }
    }

    // Tool results (mapped to user messages with tool_result blocks)
    if (isUser && toolResults.length > 0) {
      for (const tr of toolResults) {
        result.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: tr.callId,
              content: tr.content || "",
            },
          ],
        });
      }
      // If there's also text/image content, add as separate user message
      if (contentBlocks.length > 0) {
        result.push({ role: "user", content: contentBlocks });
      }
      continue;
    }

    // Regular user/assistant message
    if (contentBlocks.length > 0) {
      // If single text block, simplify to string
      if (
        contentBlocks.length === 1 &&
        contentBlocks[0].type === "text" &&
        imageBlocks.length === 0
      ) {
        result.push({ role, content: textContent });
      } else {
        result.push({ role, content: contentBlocks });
      }
    } else {
      result.push({ role, content: "(empty message)" });
    }
  }

  // Ensure alternating user/assistant pattern (Anthropic requirement)
  // Merge consecutive same-role messages
  const mergedMessages = mergeConsecutiveMessages(result);

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: mergedMessages,
  };
}

/**
 * Merge consecutive messages with the same role (Anthropic requires alternating roles)
 */
function mergeConsecutiveMessages(
  messages: AnthropicMessage[]
): AnthropicMessage[] {
  if (messages.length === 0) return messages;

  const result: AnthropicMessage[] = [messages[0]];

  for (let i = 1; i < messages.length; i++) {
    const prev = result[result.length - 1];
    const curr = messages[i];

    if (prev.role === curr.role) {
      // Merge content
      const prevContent =
        typeof prev.content === "string"
          ? [{ type: "text" as const, text: prev.content }]
          : prev.content;
      const currContent =
        typeof curr.content === "string"
          ? [{ type: "text" as const, text: curr.content }]
          : curr.content;
      prev.content = [...prevContent, ...currContent];
    } else {
      result.push(curr);
    }
  }

  // Ensure first message is from user (Anthropic requirement)
  if (result.length > 0 && result[0].role !== "user") {
    result.unshift({ role: "user", content: "(start of conversation)" });
  }

  return result;
}

/**
 * Convert VSCode tools to Anthropic Messages API format
 *
 * Anthropic tool format:
 * { name, description, input_schema } instead of { type: "function", function: { name, description, parameters } }
 */
export function convertToolsToAnthropic(
  options: vscode.ProvideLanguageModelChatResponseOptions
): {
  tools?: AnthropicTool[];
  tool_choice?: "auto" | "any" | { type: "tool"; name: string };
} {
  const toolsInput = options.tools ?? [];
  if (toolsInput.length === 0) {
    if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
      throw new Error(
        "LanguageModelChatToolMode.Required requires at least one tool."
      );
    }
    return {};
  }

  const tools: AnthropicTool[] = toolsInput.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema:
      (tool.inputSchema as JsonObject) ??
      ({ type: "object", properties: {} } as JsonObject),
  }));

  let tool_choice: "auto" | "any" | { type: "tool"; name: string } = "auto";

  if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
    if (tools.length !== 1) {
      throw new Error(
        "LanguageModelChatToolMode.Required is not supported with more than one tool."
      );
    }
    tool_choice = { type: "tool", name: tools[0].name };
  }

  return { tools, tool_choice };
}

/**
 * Parse JSON with error handling (generic)
 */
export function tryParseJSONObject<T extends Json = Json>(
  text: string
): { ok: true; value: T } | { ok: false; error: string } {
  if (!text || !text.trim()) {
    return { ok: false, error: "Empty string" };
  }
  try {
    const value = JSON.parse(text) as T;
    return { ok: true, value };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Validate chat request
 */
export function validateRequest(
  messages:
    | readonly vscode.LanguageModelChatMessage[]
    | readonly {
        role: string;
        content: (vscode.LanguageModelInputPart | LegacyPart)[];
      }[]
): void {
  if (!messages || messages.length === 0) {
    throw new Error("Messages array is empty");
  }

  for (const msg of messages) {
    if (!msg.content || msg.content.length === 0) {
      throw new Error("Message has no content");
    }
  }
}

/**
 * Estimate token count.
 *
 * Tokenizer averages ~2 chars/token for mixed CJK/Latin text.
 * Using a conservative divisor of 2 avoids undercounting which causes
 * context-window-exceeded errors at the API level.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2);
}

/**
 * Estimate message array tokens
 */
export function estimateMessagesTokens(
  messages:
    | readonly vscode.LanguageModelChatMessage[]
    | readonly {
        content: (vscode.LanguageModelInputPart | LegacyPart)[];
      }[],
  options?: { maxToolResultChars?: number }
): number {
  let total = 0;
  for (const m of messages) {
    for (const part of m.content) {
      const tv = getTextPartValue(part);
      if (tv !== undefined) {
        total += estimateTokens(tv);
        continue;
      }
      const dv = getDataPartTextValue(part);
      if (dv !== undefined) {
        total += estimateTokens(dv);
        continue;
      }
      const img = extractImageData(part);
      if (img) {
        // Rough estimate based on base64 size to avoid undercount
        const approxBase64Tokens = Math.ceil(img.data.length / 3);
        total += Math.max(1500, approxBase64Tokens);
        continue;
      }
      const toolCall = getToolCallInfo(part);
      if (toolCall) {
        if (toolCall.name) total += estimateTokens(toolCall.name);
        if (toolCall.args) {
          const argsStr =
            typeof toolCall.args === "string"
              ? toolCall.args
              : JSON.stringify(toolCall.args);
          total += estimateTokens(argsStr);
        }
        continue;
      }
      const toolResultTexts = getToolResultTexts(
        part,
        options?.maxToolResultChars
      );
      if (toolResultTexts.length > 0) {
        for (const tr of toolResultTexts) {
          total += estimateTokens(tr);
        }
      }
    }
  }
  return total;
}
