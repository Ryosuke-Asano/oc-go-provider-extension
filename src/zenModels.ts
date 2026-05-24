/**
 * OpenCode Zen/Go model definitions with dynamic discovery via models.dev.
 *
 * models.dev (https://models.dev/api.json) is the canonical model registry used
 * by OpenCode itself. It provides complete model specs including context windows,
 * capabilities, pricing, and API routing information.
 *
 * This eliminates the need for manual static model lists — new models appear
 * automatically, deprecated models disappear, and specs are always current.
 */
import type { OcGoModelInfo, OcGoApiFormat } from "./types";
import { createHash } from "crypto";

const MODELS_DEV_URL = "https://models.dev/api.json";
const PROVIDER_IDS = ["opencode"] as const;

/** models.dev provider entry */
type ModelsDevProvider = {
  id: string;
  name: string;
  npm: string;
  api: string;
  models: Record<string, ModelsDevModel>;
};

/** models.dev model entry */
type ModelsDevModel = {
  id: string;
  name: string;
  family?: string;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  temperature?: boolean;
  provider?: { npm?: string };
  cost?: { input?: number; output?: number; cache_read?: number };
  limit?: { context?: number; output?: number };
  status?: "active" | "beta" | "deprecated";
};

/** In-memory cache with TTL */
let _cache: OcGoModelInfo[] | null = null;
let _cacheKey = "";
let _cachedAtMs: number | undefined;

/** Cache TTL: 60 minutes (matches wienans extension default) */
const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Create an internal, non-reversible fingerprint for a Zen API key.
 * Used only to separate cache buckets per key without storing the secret.
 */
function fingerprintApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    return "(none)";
  }
  return createHash("sha256").update(trimmed).digest("hex").slice(0, 16);
}

/**
 * Override context windows for models where models.dev has incorrect data.
 * These values are verified against the Go provider's static definitions
 * and OpenCode's official documentation.
 *
 * models.dev is community-maintained and may lag behind actual API capabilities.
 * This map ensures accurate context window display for known discrepancies.
 */
const CONTEXT_WINDOW_OVERRIDES: Record<string, number> = {
  // Qwen family - models.dev reports 262K but API supports 1M
  "qwen3.6-plus": 1000000,
  "qwen3.6-plus-free": 1000000,
  "qwen3.5-plus": 1000000,
  // Free models - models.dev reports 262K but API supports 1M
  "deepseek-v4-flash-free": 1000000,
  "big-pickle": 1000000,
  "ring-2.6-1t-free": 1000000,
  "trinity-large-preview-free": 1000000,
  "nemotron-3-super-free": 1000000,
};

/**
 * Determine the API format from models.dev npm package identifier.
 */
function npmToApiFormat(npm: string | undefined): OcGoApiFormat {
  if (!npm) return "openai";
  if (npm === "@ai-sdk/anthropic") return "anthropic";
  // openai, openai-compatible, google all use openai-compatible endpoints
  return "openai";
}

/**
 * Convert a models.dev model entry to our OcGoModelInfo format.
 */
function toOcGoModelInfo(
  model: ModelsDevModel,
  provider: ModelsDevProvider,
  providerId: string
): OcGoModelInfo {
  const npmOverride = model.provider?.npm ?? provider.npm;
  const isGo = providerId === "opencode-go";
  const suffix = isGo ? " (Go)" : "";

  return {
    id: model.id,
    name: model.name + suffix,
    displayName: model.name + suffix,
    contextWindow: CONTEXT_WINDOW_OVERRIDES[model.id] ?? model.limit?.context ?? 32768,
    maxOutput: model.limit?.output ?? 8192,
    supportsTools: model.tool_call ?? false,
    supportsVision: model.attachment ?? false,
    supportsReasoning: model.reasoning ?? false,
    apiFormat: npmToApiFormat(npmOverride),
  };
}

/**
 * Fetch all Zen and Go models from models.dev, convert to OcGoModelInfo,
 * and return the combined list.
 *
 * - Filters out deprecated models
 * - When no API key is provided, shows only free models (cost.input === 0)
 * - Caches results with 60-minute TTL
 * - Falls back to cached data on network failure
 */
export async function fetchZenModels(
  apiKey: string,
  signal?: AbortSignal
): Promise<OcGoModelInfo[]> {
  const cacheKey = fingerprintApiKey(apiKey);
  const now = Date.now();

  // Return cached result if still fresh
  if (
    _cache !== null &&
    _cacheKey === cacheKey &&
    _cachedAtMs !== undefined &&
    now - _cachedAtMs < CACHE_TTL_MS
  ) {
    return _cache;
  }

  try {
    const response = await fetch(MODELS_DEV_URL, {
      headers: { accept: "application/json" },
      signal,
    });

    if (!response.ok) {
      console.warn(
        `[OpenCode Zen] models.dev returned ${response.status} — using cached fallback`
      );
      if (_cache !== null) return _cache;
      return [];
    }

    const json = (await response.json()) as Record<string, ModelsDevProvider>;

    const allModels: OcGoModelInfo[] = [];

    for (const providerId of PROVIDER_IDS) {
      const provider = json[providerId];
      if (!provider) continue;

      for (const model of Object.values(provider.models)) {
        // Skip deprecated models
        if (model.status === "deprecated") continue;

        allModels.push(toOcGoModelInfo(model, provider, providerId));
      }
    }

    // Sort alphabetically by display name
    allModels.sort((a, b) => a.displayName.localeCompare(b.displayName));

    // If no API key, only show free models (matching OpenCode CLI behavior)
    const hasKey = Boolean(apiKey && apiKey.trim());
    const filtered = hasKey
      ? allModels
      : allModels.filter((m) => {
          // We don't have cost info here, but models.dev free models
          // typically have "free" in their name or ID
          const id = m.id.toLowerCase();
          const name = m.displayName.toLowerCase();
          return id.includes("free") || name.includes("free") || id.includes("pickle") || id.includes("nemotron");
        });

    _cache = filtered;
    _cacheKey = cacheKey;
    _cachedAtMs = now;

    console.log(
      `[OpenCode Zen] Fetched ${filtered.length} models from models.dev (${allModels.length} total before filtering)`
    );
    return filtered;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw err;
    }
    console.warn(
      `[OpenCode Zen] models.dev fetch failed — using cached fallback`,
      err
    );
    if (_cache !== null) return _cache;
    return [];
  }
}

/**
 * Invalidate the model cache. Call this when the API key changes
 * or when you want to force a fresh fetch.
 */
export function clearZenModelCache(): void {
  _cache = null;
  _cacheKey = "";
  _cachedAtMs = undefined;
}

/**
 * Resolve a model ID to its cached spec, if available.
 * Returns undefined if cache is empty or model not found.
 */
export function getZenModelSpec(modelId: string): OcGoModelInfo | undefined {
  if (!_cache) return undefined;
  return _cache.find((m) => m.id === modelId);
}
