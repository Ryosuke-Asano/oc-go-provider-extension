/**
 * Type definitions for OpenCode Go API compatibility
 * Supports both OpenAI-compatible and Anthropic-compatible API formats
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

/**
 * Content part for chat messages
 */
export interface OcGoContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: {
    url: string;
  };
}

export interface OcGoChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OcGoContentPart[];
  name?: string;
  tool_calls?: OcGoToolCall[];
  tool_call_id?: string;
  /** Kimi (Moonshot AI) requires this field in assistant messages when thinking mode is enabled */
  reasoning_content?: string | null;
}

export interface OcGoToolCall {
  id: string;
  /** Optional index used in streaming tool call deltas */
  index?: number;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface OcGoTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: JsonObject;
  };
}

export interface OcGoChatRequest {
  model: string;
  messages: OcGoChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  top_p?: number;
  stop?: string | string[];
  tools?: OcGoTool[];
  tool_choice?: "auto" | "none" | { type: string; function: { name: string } };
}

export interface OcGoChatChoice {
  index: number;
  message: {
    role: string;
    content: string | null;
    tool_calls?: OcGoToolCall[];
  };
  finish_reason: string;
}

export interface OcGoChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: OcGoChatChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OcGoStreamChoice {
  index: number;
  delta: {
    role?: string;
    content?: string;
    reasoning_content?: string;
    tool_calls?: OcGoToolCall[];
  };
  finish_reason: string | null;
}

export interface OcGoStreamResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: OcGoStreamChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * API format used by a model
 */
export type OcGoApiFormat = "openai" | "anthropic";

/**
 * Model information for OpenCode Go models
 */
export interface OcGoModelInfo {
  id: string;
  name: string;
  displayName: string;
  contextWindow: number;
  maxOutput: number;
  supportsTools: boolean;
  supportsVision: boolean;
  apiFormat: OcGoApiFormat;
  /** If set, this exact temperature value is sent for every request (some models only accept a single value). */
  fixedTemperature?: number;
}

/**
 * A strongly-typed request body used for OpenCode Go Chat API requests
 */
export interface OcGoRequestBody {
  model: string;
  messages: OcGoChatMessage[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  max_tokens?: number;
  temperature?: number;
  stop?: string | string[];
  frequency_penalty?: number;
  presence_penalty?: number;
  tools?: OcGoTool[];
  tool_choice?: "auto" | "none" | { type: string; function: { name: string } };
}

// ============================================================================
// Anthropic Messages API types
// Used by MiniMax M2.5 and M2.7 via OpenCode Go proxy
// ============================================================================

/** Anthropic message content block */
export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    }
  | { type: "tool_use"; id: string; name: string; input: JsonObject }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | AnthropicContentBlock[];
    };

/** Anthropic message format */
export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

/** Anthropic tool definition */
export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: JsonObject;
}

/** Anthropic request body */
export interface AnthropicRequestBody {
  model: string;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: "text"; text: string }>;
  max_tokens: number;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?: "auto" | "any" | { type: "tool"; name: string };
}

/** Anthropic response */
export interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

/** Anthropic SSE event types */
export interface AnthropicMessageStartEvent {
  type: "message_start";
  message: {
    id: string;
    type: "message";
    role: "assistant";
    content: AnthropicContentBlock[];
    model: string;
    stop_reason: string | null;
    usage: { input_tokens: number; output_tokens: number };
  };
}

export interface AnthropicContentBlockStartEvent {
  type: "content_block_start";
  index: number;
  content_block: AnthropicContentBlock;
}

export interface AnthropicContentBlockDeltaEvent {
  type: "content_block_delta";
  index: number;
  delta:
    | { type: "text_delta"; text: string }
    | { type: "input_json_delta"; partial_json: string }
    | { type: "thinking_delta"; thinking: string };
}

export interface AnthropicContentBlockStopEvent {
  type: "content_block_stop";
  index: number;
}

export interface AnthropicMessageDeltaEvent {
  type: "message_delta";
  delta: {
    stop_reason: string | null;
    stop_sequence: string | null;
  };
  usage: {
    output_tokens: number;
  };
}

export interface AnthropicMessageStopEvent {
  type: "message_stop";
}

export type AnthropicSSEEvent =
  | AnthropicMessageStartEvent
  | AnthropicContentBlockStartEvent
  | AnthropicContentBlockDeltaEvent
  | AnthropicContentBlockStopEvent
  | AnthropicMessageDeltaEvent
  | AnthropicMessageStopEvent;

/**
 * Available OpenCode Go models configuration
 *
 * Models using the OpenAI-compatible endpoint (chat/completions):
 *   GLM-5, GLM-5.1, Kimi K2.5, Kimi K2.6, MiMo-V2-Pro, MiMo-V2-Omni
 *
 * Models using the Anthropic-compatible endpoint (messages):
 *   MiniMax M2.5, MiniMax M2.7
 */
export const OC_GO_MODELS: OcGoModelInfo[] = [
  {
    id: "glm-5",
    name: "GLM-5",
    displayName: "GLM-5",
    contextWindow: 202752,
    maxOutput: 131072,
    supportsTools: true,
    supportsVision: false,
    apiFormat: "openai",
  },
  {
    id: "glm-5.1",
    name: "GLM-5.1",
    displayName: "GLM-5.1",
    contextWindow: 202752,
    maxOutput: 131072,
    supportsTools: true,
    supportsVision: false,
    apiFormat: "openai",
  },
  {
    id: "kimi-k2.5",
    name: "Kimi K2.5",
    displayName: "Kimi K2.5",
    contextWindow: 262144,
    maxOutput: 65536,
    supportsTools: true,
    supportsVision: true,
    apiFormat: "openai",
    fixedTemperature: 1,
  },
  {
    id: "kimi-k2.6",
    name: "Kimi K2.6",
    displayName: "Kimi K2.6",
    contextWindow: 262144,
    maxOutput: 262144,
    supportsTools: true,
    supportsVision: true,
    apiFormat: "openai",
    fixedTemperature: 1,
  },
  {
    id: "mimo-v2-pro",
    name: "MiMo-V2-Pro",
    displayName: "MiMo-V2-Pro",
    contextWindow: 1048576,
    maxOutput: 131072,
    supportsTools: true,
    supportsVision: false,
    apiFormat: "openai",
  },
  {
    id: "mimo-v2-omni",
    name: "MiMo-V2-Omni",
    displayName: "MiMo-V2-Omni",
    contextWindow: 262144,
    maxOutput: 65536,
    supportsTools: true,
    supportsVision: true,
    apiFormat: "openai",
  },
  {
    id: "minimax-m2.5",
    name: "MiniMax M2.5",
    displayName: "MiniMax M2.5",
    contextWindow: 196608,
    maxOutput: 131072,
    supportsTools: true,
    supportsVision: false,
    apiFormat: "anthropic",
  },
  {
    id: "minimax-m2.7",
    name: "MiniMax M2.7",
    displayName: "MiniMax M2.7",
    contextWindow: 196608,
    maxOutput: 131072,
    supportsTools: true,
    supportsVision: false,
    apiFormat: "anthropic",
  },
  {
    id: "qwen3.5-plus",
    name: "Qwen3.5 Plus",
    displayName: "Qwen3.5 Plus",
    contextWindow: 1000000,
    maxOutput: 65536,
    supportsTools: true,
    supportsVision: true,
    apiFormat: "openai",
  },
  {
    id: "qwen3.6-plus",
    name: "Qwen3.6 Plus",
    displayName: "Qwen3.6 Plus",
    contextWindow: 1000000,
    maxOutput: 65536,
    supportsTools: true,
    supportsVision: true,
    apiFormat: "openai",
  },
];
