#!/usr/bin/env node

/**
 * sync-models.mjs — Fetches the latest OpenCode Go model list from the API
 * and compares it against the OC_GO_MODELS defined in src/types.ts.
 *
 * Usage:
 *   node scripts/sync-models.mjs           # dry-run — only report differences
 *   node scripts/sync-models.mjs --apply    # modify types.ts in-place
 *   node scripts/sync-models.mjs --readme   # update the generated README table
 *   node scripts/sync-models.mjs --help     # show this message
 *
 * The script handles three kinds of changes:
 *   1. NEW models — present in the API but missing from OC_GO_MODELS.
 *   2. REMOVED models — present in OC_GO_MODELS but absent from the API.
 *   3. CHANGED models — metadata differences (only apiFormat detected automatically).
 */

const GO_MODELS_API = "https://opencode.ai/zen/go/v1/models";
const ZEN_MODELS_API = "https://opencode.ai/zen/v1/models";
const TYPES_FILE = new URL("../src/types.ts", import.meta.url);
const README_FILE = new URL("../README.md", import.meta.url);
// Monorepo-style, but should work from project root

/* ------------------------------------------------------------------ */
/*  Known model specs (edit this when new families land)              */
/*  Keyed by base model-id prefix — longest match wins.               */
/* ------------------------------------------------------------------ */
const SPECS = [
  // —— GLM family (OpenAI) ——
  {
    prefix: "glm-5.1",
    spec: {
      name: "GLM-5.1",
      displayName: "GLM-5.1",
      contextWindow: 202752,
      maxOutput: 131072,
      supportsVision: false,
      apiFormat: "openai",
      thinkingMode: "none",
    },
  },
  {
    prefix: "glm-5",
    spec: {
      name: "GLM-5",
      displayName: "GLM-5",
      contextWindow: 202752,
      maxOutput: 131072,
      supportsVision: false,
      apiFormat: "openai",
      thinkingMode: "none",
    },
  },

  // —— Kimi K2 family (OpenAI, always thinking, fixed temp) ——
  {
    prefix: "kimi-k2.7",
    spec: {
      name: "Kimi K2.7 Code",
      displayName: "Kimi K2.7 Code",
      contextWindow: 262144,
      maxOutput: 262144,
      supportsVision: true,
      apiFormat: "openai",
      thinkingMode: "always",
      fixedTemperature: 1,
    },
  },
  {
    prefix: "kimi-k2.6",
    spec: {
      name: "Kimi K2.6",
      displayName: "Kimi K2.6",
      contextWindow: 262144,
      maxOutput: 262144,
      supportsVision: true,
      apiFormat: "openai",
      thinkingMode: "always",
      fixedTemperature: 1,
    },
  },
  {
    prefix: "kimi-k2.5",
    spec: {
      name: "Kimi K2.5",
      displayName: "Kimi K2.5",
      contextWindow: 262144,
      maxOutput: 65536,
      supportsVision: true,
      apiFormat: "openai",
      thinkingMode: "always",
      fixedTemperature: 1,
    },
  },

  // —— MiMo V2 family (OpenAI, switchable thinking) ——
  {
    prefix: "mimo-v2.5-pro",
    spec: {
      name: "MiMo-V2.5-Pro",
      displayName: "MiMo-V2.5-Pro",
      contextWindow: 1048576,
      maxOutput: 131072,
      supportsVision: false,
      apiFormat: "openai",
      thinkingMode: "switchable",
    },
  },
  {
    prefix: "mimo-v2.5",
    spec: {
      name: "MiMo-V2.5",
      displayName: "MiMo-V2.5",
      contextWindow: 262144,
      maxOutput: 65536,
      supportsVision: true,
      apiFormat: "openai",
      thinkingMode: "switchable",
    },
  },
  {
    prefix: "mimo-v2-pro",
    spec: {
      name: "MiMo-V2-Pro",
      displayName: "MiMo-V2-Pro",
      contextWindow: 1048576,
      maxOutput: 131072,
      supportsVision: false,
      apiFormat: "openai",
      thinkingMode: "switchable",
    },
  },
  {
    prefix: "mimo-v2-omni",
    spec: {
      name: "MiMo-V2-Omni",
      displayName: "MiMo-V2-Omni",
      contextWindow: 262144,
      maxOutput: 65536,
      supportsVision: true,
      apiFormat: "openai",
      thinkingMode: "switchable",
    },
  },

  // —— MiniMax family (Anthropic) ——
  {
    prefix: "minimax-m3",
    spec: {
      name: "MiniMax M3",
      displayName: "MiniMax M3",
      contextWindow: 262144,
      maxOutput: 131072,
      supportsVision: false,
      apiFormat: "anthropic",
      thinkingMode: "switchable",
    },
  },
  {
    prefix: "minimax-m2.7",
    spec: {
      name: "MiniMax M2.7",
      displayName: "MiniMax M2.7",
      contextWindow: 196608,
      maxOutput: 131072,
      supportsVision: false,
      apiFormat: "anthropic",
      thinkingMode: "none",
    },
  },
  {
    prefix: "minimax-m2.5",
    spec: {
      name: "MiniMax M2.5",
      displayName: "MiniMax M2.5",
      contextWindow: 196608,
      maxOutput: 131072,
      supportsVision: false,
      apiFormat: "anthropic",
      thinkingMode: "none",
    },
  },

  // —— Qwen 3.7 family (Anthropic, vision) ——
  {
    prefix: "qwen3.7-max",
    spec: {
      name: "Qwen3.7 Max",
      displayName: "Qwen3.7 Max",
      contextWindow: 262144,
      maxOutput: 65536,
      supportsVision: true,
      apiFormat: "anthropic",
      thinkingMode: "switchable",
    },
  },
  {
    prefix: "qwen3.7-plus",
    spec: {
      name: "Qwen3.7 Plus",
      displayName: "Qwen3.7 Plus",
      contextWindow: 1000000,
      maxOutput: 65536,
      supportsVision: true,
      apiFormat: "anthropic",
      thinkingMode: "switchable",
    },
  },

  // —— Qwen 3.6 family (Anthropic, vision) ——
  {
    prefix: "qwen3.6-plus",
    spec: {
      name: "Qwen3.6 Plus",
      displayName: "Qwen3.6 Plus",
      contextWindow: 1000000,
      maxOutput: 65536,
      supportsVision: true,
      apiFormat: "anthropic",
      thinkingMode: "switchable",
    },
  },

  // —— Qwen 3.5 family (OpenAI, vision) ——
  {
    prefix: "qwen3.5-plus",
    spec: {
      name: "Qwen3.5 Plus",
      displayName: "Qwen3.5 Plus",
      contextWindow: 1000000,
      maxOutput: 65536,
      supportsVision: true,
      apiFormat: "openai",
      thinkingMode: "switchable",
    },
  },

  // —— DeepSeek V4 family (OpenAI, reasoning) ——
  {
    prefix: "deepseek-v4-pro",
    spec: {
      name: "DeepSeek V4 Pro",
      displayName: "DeepSeek V4 Pro",
      contextWindow: 1000000,
      maxOutput: 393216,
      supportsVision: false,
      apiFormat: "openai",
      thinkingMode: "switchable",
    },
  },
  {
    prefix: "deepseek-v4-flash",
    spec: {
      name: "DeepSeek V4 Flash",
      displayName: "DeepSeek V4 Flash",
      contextWindow: 1000000,
      maxOutput: 393216,
      supportsVision: false,
      apiFormat: "openai",
      thinkingMode: "switchable",
    },
  },

  // —— Free Zen models (use /zen/v1 endpoint) ——
  {
    prefix: "deepseek-v4-flash-free",
    spec: {
      name: "DeepSeek V4 Flash Free",
      displayName: "DeepSeek V4 Flash Free",
      contextWindow: 1000000,
      maxOutput: 393216,
      supportsVision: false,
      apiFormat: "openai",
      thinkingMode: "none",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },
  {
    prefix: "mimo-v2.5-free",
    spec: {
      name: "MiMo-V2.5 Free",
      displayName: "MiMo-V2.5 Free",
      contextWindow: 262144,
      maxOutput: 65536,
      supportsVision: true,
      apiFormat: "openai",
      thinkingMode: "none",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },
  {
    prefix: "laguna-s-2.1-free",
    spec: {
      name: "Laguna S 2.1 Free",
      displayName: "Laguna S 2.1 Free",
      contextWindow: 131072,
      maxOutput: 65536,
      supportsVision: false,
      apiFormat: "openai",
      thinkingMode: "none",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },
  {
    prefix: "north-mini-code-free",
    spec: {
      name: "North Mini Code Free",
      displayName: "North Mini Code Free",
      contextWindow: 131072,
      maxOutput: 65536,
      supportsVision: false,
      apiFormat: "openai",
      thinkingMode: "none",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },
  {
    prefix: "nemotron-3-ultra-free",
    spec: {
      name: "Nemotron 3 Ultra Free",
      displayName: "Nemotron 3 Ultra Free",
      contextWindow: 131072,
      maxOutput: 65536,
      supportsVision: false,
      apiFormat: "openai",
      thinkingMode: "none",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },

  // —— Anthropic Claude models (Anthropic API format) ——
  {
    prefix: "claude-fable-5",
    spec: {
      name: "Claude Fable 5",
      displayName: "Claude Fable 5",
      contextWindow: 200000,
      maxOutput: 8192,
      supportsVision: true,
      apiFormat: "anthropic",
      thinkingMode: "switchable",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },
  {
    prefix: "claude-opus-4-8",
    spec: {
      name: "Claude Opus 4.8",
      displayName: "Claude Opus 4.8",
      contextWindow: 200000,
      maxOutput: 8192,
      supportsVision: true,
      apiFormat: "anthropic",
      thinkingMode: "switchable",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },
  {
    prefix: "claude-opus-4-7",
    spec: {
      name: "Claude Opus 4.7",
      displayName: "Claude Opus 4.7",
      contextWindow: 200000,
      maxOutput: 8192,
      supportsVision: true,
      apiFormat: "anthropic",
      thinkingMode: "switchable",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },
  {
    prefix: "claude-opus-4-6",
    spec: {
      name: "Claude Opus 4.6",
      displayName: "Claude Opus 4.6",
      contextWindow: 200000,
      maxOutput: 8192,
      supportsVision: true,
      apiFormat: "anthropic",
      thinkingMode: "switchable",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },
  {
    prefix: "claude-opus-4-5",
    spec: {
      name: "Claude Opus 4.5",
      displayName: "Claude Opus 4.5",
      contextWindow: 200000,
      maxOutput: 8192,
      supportsVision: true,
      apiFormat: "anthropic",
      thinkingMode: "switchable",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },
  {
    prefix: "claude-opus-4-1",
    spec: {
      name: "Claude Opus 4.1",
      displayName: "Claude Opus 4.1",
      contextWindow: 200000,
      maxOutput: 8192,
      supportsVision: true,
      apiFormat: "anthropic",
      thinkingMode: "switchable",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },
  {
    prefix: "claude-sonnet-5",
    spec: {
      name: "Claude Sonnet 5",
      displayName: "Claude Sonnet 5",
      contextWindow: 200000,
      maxOutput: 8192,
      supportsVision: true,
      apiFormat: "anthropic",
      thinkingMode: "switchable",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },
  {
    prefix: "claude-sonnet-4-6",
    spec: {
      name: "Claude Sonnet 4.6",
      displayName: "Claude Sonnet 4.6",
      contextWindow: 200000,
      maxOutput: 8192,
      supportsVision: true,
      apiFormat: "anthropic",
      thinkingMode: "switchable",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },
  {
    prefix: "claude-sonnet-4-5",
    spec: {
      name: "Claude Sonnet 4.5",
      displayName: "Claude Sonnet 4.5",
      contextWindow: 200000,
      maxOutput: 8192,
      supportsVision: true,
      apiFormat: "anthropic",
      thinkingMode: "switchable",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },
  {
    prefix: "claude-sonnet-4",
    spec: {
      name: "Claude Sonnet 4",
      displayName: "Claude Sonnet 4",
      contextWindow: 200000,
      maxOutput: 8192,
      supportsVision: true,
      apiFormat: "anthropic",
      thinkingMode: "switchable",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },
  {
    prefix: "claude-haiku-4-5",
    spec: {
      name: "Claude Haiku 4.5",
      displayName: "Claude Haiku 4.5",
      contextWindow: 200000,
      maxOutput: 8192,
      supportsVision: true,
      apiFormat: "anthropic",
      thinkingMode: "switchable",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },

  // —— Google Gemini models (OpenAI-compatible) ——
  {
    prefix: "gemini-3.6-flash",
    spec: {
      name: "Gemini 3.6 Flash",
      displayName: "Gemini 3.6 Flash",
      contextWindow: 1000000,
      maxOutput: 65536,
      supportsVision: true,
      apiFormat: "openai",
      thinkingMode: "switchable",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },
  {
    prefix: "gemini-3.5-flash-lite",
    spec: {
      name: "Gemini 3.5 Flash Lite",
      displayName: "Gemini 3.5 Flash Lite",
      contextWindow: 1000000,
      maxOutput: 65536,
      supportsVision: true,
      apiFormat: "openai",
      thinkingMode: "none",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },
  {
    prefix: "gemini-3.5-flash",
    spec: {
      name: "Gemini 3.5 Flash",
      displayName: "Gemini 3.5 Flash",
      contextWindow: 1000000,
      maxOutput: 65536,
      supportsVision: true,
      apiFormat: "openai",
      thinkingMode: "switchable",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },
  {
    prefix: "gemini-3.1-pro",
    spec: {
      name: "Gemini 3.1 Pro",
      displayName: "Gemini 3.1 Pro",
      contextWindow: 2000000,
      maxOutput: 65536,
      supportsVision: true,
      apiFormat: "openai",
      thinkingMode: "switchable",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },
  {
    prefix: "gemini-3-flash",
    spec: {
      name: "Gemini 3 Flash",
      displayName: "Gemini 3 Flash",
      contextWindow: 1000000,
      maxOutput: 65536,
      supportsVision: true,
      apiFormat: "openai",
      thinkingMode: "switchable",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },

  // —— OpenAI GPT models (OpenAI-compatible) ——
  {
    prefix: "gpt-5.6-sol",
    spec: {
      name: "GPT 5.6 Sol",
      displayName: "GPT 5.6 Sol",
      contextWindow: 272000,
      maxOutput: 65536,
      supportsVision: true,
      apiFormat: "openai",
      thinkingMode: "switchable",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },
  {
    prefix: "gpt-5.6-terra",
    spec: {
      name: "GPT 5.6 Terra",
      displayName: "GPT 5.6 Terra",
      contextWindow: 272000,
      maxOutput: 65536,
      supportsVision: true,
      apiFormat: "openai",
      thinkingMode: "switchable",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },
  {
    prefix: "gpt-5.6-luna",
    spec: {
      name: "GPT 5.6 Luna",
      displayName: "GPT 5.6 Luna",
      contextWindow: 272000,
      maxOutput: 65536,
      supportsVision: true,
      apiFormat: "openai",
      thinkingMode: "switchable",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },
  {
    prefix: "gpt-5.5-pro",
    spec: {
      name: "GPT 5.5 Pro",
      displayName: "GPT 5.5 Pro",
      contextWindow: 272000,
      maxOutput: 65536,
      supportsVision: true,
      apiFormat: "openai",
      thinkingMode: "switchable",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },
  {
    prefix: "gpt-5.5",
    spec: {
      name: "GPT 5.5",
      displayName: "GPT 5.5",
      contextWindow: 272000,
      maxOutput: 65536,
      supportsVision: true,
      apiFormat: "openai",
      thinkingMode: "switchable",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },
  {
    prefix: "gpt-5.4-pro",
    spec: {
      name: "GPT 5.4 Pro",
      displayName: "GPT 5.4 Pro",
      contextWindow: 272000,
      maxOutput: 65536,
      supportsVision: true,
      apiFormat: "openai",
      thinkingMode: "switchable",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },
  {
    prefix: "gpt-5.4-mini",
    spec: {
      name: "GPT 5.4 Mini",
      displayName: "GPT 5.4 Mini",
      contextWindow: 272000,
      maxOutput: 65536,
      supportsVision: false,
      apiFormat: "openai",
      thinkingMode: "none",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },
  {
    prefix: "gpt-5.4-nano",
    spec: {
      name: "GPT 5.4 Nano",
      displayName: "GPT 5.4 Nano",
      contextWindow: 272000,
      maxOutput: 65536,
      supportsVision: false,
      apiFormat: "openai",
      thinkingMode: "none",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },
  {
    prefix: "gpt-5.4",
    spec: {
      name: "GPT 5.4",
      displayName: "GPT 5.4",
      contextWindow: 272000,
      maxOutput: 65536,
      supportsVision: true,
      apiFormat: "openai",
      thinkingMode: "switchable",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },
  {
    prefix: "gpt-5.3-codex-spark",
    spec: {
      name: "GPT 5.3 Codex Spark",
      displayName: "GPT 5.3 Codex Spark",
      contextWindow: 128000,
      maxOutput: 65536,
      supportsVision: false,
      apiFormat: "openai",
      thinkingMode: "switchable",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },
  {
    prefix: "gpt-5.3-codex",
    spec: {
      name: "GPT 5.3 Codex",
      displayName: "GPT 5.3 Codex",
      contextWindow: 128000,
      maxOutput: 65536,
      supportsVision: false,
      apiFormat: "openai",
      thinkingMode: "switchable",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },
  {
    prefix: "gpt-5.2-codex",
    spec: {
      name: "GPT 5.2 Codex",
      displayName: "GPT 5.2 Codex",
      contextWindow: 128000,
      maxOutput: 65536,
      supportsVision: false,
      apiFormat: "openai",
      thinkingMode: "switchable",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },
  {
    prefix: "gpt-5.2",
    spec: {
      name: "GPT 5.2",
      displayName: "GPT 5.2",
      contextWindow: 128000,
      maxOutput: 65536,
      supportsVision: true,
      apiFormat: "openai",
      thinkingMode: "switchable",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },
  {
    prefix: "gpt-5.1-codex-max",
    spec: {
      name: "GPT 5.1 Codex Max",
      displayName: "GPT 5.1 Codex Max",
      contextWindow: 200000,
      maxOutput: 65536,
      supportsVision: false,
      apiFormat: "openai",
      thinkingMode: "switchable",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },
  {
    prefix: "gpt-5.1-codex-mini",
    spec: {
      name: "GPT 5.1 Codex Mini",
      displayName: "GPT 5.1 Codex Mini",
      contextWindow: 128000,
      maxOutput: 65536,
      supportsVision: false,
      apiFormat: "openai",
      thinkingMode: "none",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },
  {
    prefix: "gpt-5.1-codex",
    spec: {
      name: "GPT 5.1 Codex",
      displayName: "GPT 5.1 Codex",
      contextWindow: 128000,
      maxOutput: 65536,
      supportsVision: false,
      apiFormat: "openai",
      thinkingMode: "none",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },
  {
    prefix: "gpt-5.1",
    spec: {
      name: "GPT 5.1",
      displayName: "GPT 5.1",
      contextWindow: 128000,
      maxOutput: 65536,
      supportsVision: true,
      apiFormat: "openai",
      thinkingMode: "switchable",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },
  {
    prefix: "gpt-5-codex",
    spec: {
      name: "GPT 5 Codex",
      displayName: "GPT 5 Codex",
      contextWindow: 128000,
      maxOutput: 65536,
      supportsVision: false,
      apiFormat: "openai",
      thinkingMode: "none",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },
  {
    prefix: "gpt-5-nano",
    spec: {
      name: "GPT 5 Nano",
      displayName: "GPT 5 Nano",
      contextWindow: 128000,
      maxOutput: 65536,
      supportsVision: false,
      apiFormat: "openai",
      thinkingMode: "none",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },
  {
    prefix: "gpt-5",
    spec: {
      name: "GPT 5",
      displayName: "GPT 5",
      contextWindow: 128000,
      maxOutput: 65536,
      supportsVision: true,
      apiFormat: "openai",
      thinkingMode: "switchable",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },

  // —— xAI Grok models ——
  {
    prefix: "grok-build-0.1",
    spec: {
      name: "Grok Build 0.1",
      displayName: "Grok Build 0.1",
      contextWindow: 131072,
      maxOutput: 65536,
      supportsVision: true,
      apiFormat: "openai",
      thinkingMode: "switchable",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },

  // —— Free / other ——
  {
    prefix: "big-pickle",
    spec: {
      name: "Big Pickle",
      displayName: "Big Pickle",
      contextWindow: 131072,
      maxOutput: 65536,
      supportsVision: false,
      apiFormat: "openai",
      thinkingMode: "none",
      baseUrl: "https://opencode.ai/zen/v1",
    },
  },
];

/* Fallback for completely unknown models */
const FALLBACK_SPEC = {
  name: null,
  displayName: null,
  contextWindow: 131072,
  maxOutput: 65536,
  supportsVision: true,
  apiFormat: "openai",
  thinkingMode: "switchable",
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function sortByPrefixLength(a, b) {
  return b.prefix.length - a.prefix.length;
}

function findSpec(modelId) {
  const sorted = [...SPECS].sort(sortByPrefixLength);
  const match = sorted.find((s) => modelId.startsWith(s.prefix));
  return match ? { ...match.spec } : null;
}

function toModelEntry(id, spec) {
  const name = spec.name ?? guessName(id);
  const displayName = spec.displayName ?? guessName(id);
  const kv = [
    `    id: "${id}",`,
    `    name: "${name}",`,
    `    displayName: "${displayName}",`,
    `    contextWindow: ${spec.contextWindow},`,
    `    maxOutput: ${spec.maxOutput},`,
    `    supportsTools: true,`,
    `    supportsVision: ${String(spec.supportsVision)},`,
    `    apiFormat: "${spec.apiFormat}",`,
  ];
  if (spec.fixedTemperature !== undefined) {
    kv.push(`    fixedTemperature: ${spec.fixedTemperature},`);
  }
  if (spec.baseUrl !== undefined) {
    kv.push(`    baseUrl: "${spec.baseUrl}",`);
  }
  kv.push(`    thinkingMode: "${spec.thinkingMode}",`);
  return kv.join("\n");
}

function guessName(id) {
  return id
    .split(/[-]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function updateReadme(apiIds, fs) {
  const source = fs.readFileSync(README_FILE, "utf-8");
  const startMarker = "<!-- BEGIN GENERATED GO MODELS -->";
  const endMarker = "<!-- END GENERATED GO MODELS -->";
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);

  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      "Could not find generated model markers in README.md. Add the markers before running with --readme."
    );
  }

  const table = [
    "| Model ID |",
    "| -------- |",
    ...apiIds.map((id) => `| \`${id}\` |`),
  ].join("\n");
  const updated = `${source.slice(0, start + startMarker.length)}\n\n${table}\n\n${source.slice(end)}`;

  if (updated !== source) {
    fs.writeFileSync(README_FILE, updated, "utf-8");
    console.log(
      `✅ Updated ${apiIds.length} model IDs in ${README_FILE.pathname}\n`
    );
  } else {
    console.log("✅ README model list is already up to date.\n");
  }
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  const args = process.argv.slice(2);
  const isApply = args.includes("--apply");
  const isHelp = args.includes("--help");
  const isZen = args.includes("--zen");
  const isReadme = args.includes("--readme");

  if (isHelp) {
    console.log(`
Usage: node scripts/sync-models.mjs [--apply] [--readme] [--zen]

Fetches the OpenCode model list and compares it against OC_GO_MODELS
in src/types.ts.

  --apply    Write new model entries directly into types.ts
  --readme   Update the generated model ID table in README.md
  --zen      Use the full Zen API (https://opencode.ai/zen/v1/models)
             instead of the Go API (https://opencode.ai/zen/go/v1/models)
  --help     Show this help

Without --apply the script runs in dry-run mode (read-only).
`);
    process.exit(0);
  }

  // 1. Fetch the API
  const apiUrl = isZen ? ZEN_MODELS_API : GO_MODELS_API;
  console.log("🔍 Fetching models from", apiUrl, "...");
  const fs = await import("node:fs");
  const { EnvHttpProxyAgent, fetch: proxyFetch } = await import("undici");
  const proxyConfigured = Boolean(
    process.env.https_proxy || process.env.HTTPS_PROXY
  );
  if (proxyConfigured) {
    console.log("   Using proxy from HTTPS proxy environment variable");
  }
  const res = await proxyFetch(apiUrl, {
    dispatcher: new EnvHttpProxyAgent(),
  });
  if (!res.ok) {
    console.error(`❌ API returned ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const body = await res.json();
  const apiIds = (body.data || []).map((m) => m.id).sort();
  console.log(`   Found ${apiIds.length} models in API\n`);

  if (isReadme) {
    updateReadme(apiIds, fs);
    if (!isApply) {
      return;
    }
  }

  // 2. Read current types.ts
  const source = fs.readFileSync(TYPES_FILE, "utf-8");

  // Extract existing model IDs from the OC_GO_MODELS array
  const existingIds = new Set(
    [...source.matchAll(/^\s{4}id:\s*"([^"]+)",$/gm)].map((m) => m[1])
  );
  console.log(`   Found ${existingIds.size} models in OC_GO_MODELS\n`);

  // 3. Compare
  const newIds = apiIds.filter((id) => !existingIds.has(id));
  const removedIds = [...existingIds].filter((id) => !apiIds.includes(id));

  if (newIds.length === 0 && removedIds.length === 0) {
    console.log("✅ Models are in sync — no changes needed.\n");
    return;
  }

  // Removed models
  if (removedIds.length > 0) {
    console.log(
      "🗑️  Models in OC_GO_MODELS but NOT in API (possibly deprecated):"
    );
    for (const id of removedIds) {
      console.log(`   - ${id}`);
    }
    console.log("");
  }

  // New models
  if (newIds.length === 0) {
    console.log("✨ No new models to add.\n");
    return;
  }

  console.log("✨ New models to add:");
  for (const id of newIds) {
    const spec = findSpec(id);
    if (spec) {
      console.log(
        `   + ${id}  (known — ${spec.name ?? spec.displayName ?? id})`
      );
    } else {
      console.log(`   + ${id}  ⚠️  UNKNOWN — using fallback defaults`);
    }
  }
  console.log("");

  if (!isApply) {
    console.log("ℹ️  Run with --apply to insert them into types.ts\n");
    return;
  }

  // 4. Generate and insert entries
  const entries = newIds.map((id) => {
    const spec = findSpec(id);
    return toModelEntry(id, spec ?? FALLBACK_SPEC);
  });

  const block = entries.map((entry) => `  {\n${entry}\n  },`).join("\n");

  // Insert before the closing "];" of OC_GO_MODELS
  const marker = "\n];\n\n/** Default model used for OCR";
  if (!source.includes(marker)) {
    console.error(
      '❌ Could not find array terminator "];" in types.ts — aborting.'
    );
    process.exit(1);
  }
  const updated = source.replace(marker, `\n${block}\n${marker}`);

  fs.writeFileSync(TYPES_FILE, updated, "utf-8");
  console.log(
    `✅ Inserted ${entries.length} new model(s) into ${TYPES_FILE.pathname}\n`
  );
}

main().catch((err) => {
  console.error("❌ Script failed:", err);
  process.exit(1);
});
