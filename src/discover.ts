import { OC_GO_MODELS, OcGoModelInfo } from "./types";

const GO_MODELS_API = "https://opencode.ai/zen/go/v1/models";
const ZEN_MODELS_API = "https://opencode.ai/zen/v1/models";
const MODELS_DEV_API = "https://models.dev/api.json";
const DISCOVER_CACHE_TTL_MS = 3_600_000; // 1 hour

const FALLBACK_SPEC = {
  contextWindow: 131072,
  maxOutput: 65536,
  supportsVision: false,
  apiFormat: "openai" as const,
  thinkingMode: "none" as const,
};

let cachedDiscovered: OcGoModelInfo[] | null = null;
let cacheTime = 0;

interface ModelLimits {
  context: number;
  input?: number;
  output: number;
}

function parseModelId(id: string): string {
  return id
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function inferBaseUrl(id: string): string | undefined {
  if (id.endsWith("-free")) return "https://opencode.ai/zen/v1";
  if (
    id.startsWith("claude-") ||
    id.startsWith("gemini-") ||
    id.startsWith("gpt-") ||
    id.startsWith("grok-build-") ||
    id === "big-pickle"
  ) {
    return "https://opencode.ai/zen/v1";
  }
  return undefined;
}

function inferApiFormat(id: string): "openai" | "anthropic" {
  if (id.startsWith("claude-")) return "anthropic";
  return "openai";
}

function inferVision(id: string): boolean {
  if (id.startsWith("claude-")) return true;
  if (id.startsWith("gemini-")) return true;
  if (
    id.startsWith("gpt-5.6-") ||
    id.startsWith("gpt-5.5") ||
    id.startsWith("gpt-5.4")
  )
    return !id.includes("nano") && !id.includes("mini");
  if (
    id.startsWith("gpt-5.3-") ||
    id.startsWith("gpt-5.2-") ||
    id.startsWith("gpt-5.1-") ||
    id.startsWith("gpt-5-")
  )
    return false;
  if (id === "gpt-5.2" || id === "gpt-5.1" || id === "gpt-5") return true;
  if (id.startsWith("grok-build-")) return true;
  return false;
}

function inferThinking(id: string): "switchable" | "none" {
  if (id.startsWith("claude-")) return "switchable";
  if (id.startsWith("gemini-")) {
    if (id.includes("lite")) return "none";
    return "switchable";
  }
  if (
    id.includes("nano") ||
    (id.includes("mini") && !id.includes("codex-mini"))
  )
    return "none";
  if (id.includes("codex")) {
    if (id.includes("mini") || id === "gpt-5-codex") return "none";
  }
  if (id.includes("-free")) return "none";
  return "switchable";
}

async function fetchModelIds(apiUrl: string): Promise<string[]> {
  try {
    const res = await fetch(apiUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: Array<{ id: string }> };
    return (body.data || []).map((m) => m.id);
  } catch {
    return [];
  }
}

async function fetchModelLimits(): Promise<Map<string, ModelLimits>> {
  try {
    const res = await fetch(MODELS_DEV_API, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return new Map();

    const body = (await res.json()) as Record<string, unknown>;
    const provider = body["opencode-go"];
    if (typeof provider !== "object" || provider === null) return new Map();
    const models = (provider as { models?: unknown }).models;
    if (typeof models !== "object" || models === null) return new Map();

    const limits = new Map<string, ModelLimits>();
    for (const [id, value] of Object.entries(models)) {
      if (typeof value !== "object" || value === null) continue;
      const limit = (value as { limit?: unknown }).limit;
      if (typeof limit !== "object" || limit === null) continue;
      const candidate = limit as {
        context?: unknown;
        input?: unknown;
        output?: unknown;
      };
      if (
        typeof candidate.context !== "number" ||
        typeof candidate.output !== "number"
      ) {
        continue;
      }
      limits.set(id, {
        context: candidate.context,
        input:
          typeof candidate.input === "number" ? candidate.input : undefined,
        output: candidate.output,
      });
    }
    return limits;
  } catch {
    return new Map();
  }
}

function buildModelEntry(
  id: string,
  limits?: ModelLimits
): OcGoModelInfo {
  return {
    id,
    name: parseModelId(id),
    displayName: parseModelId(id),
    contextWindow: limits?.context ?? FALLBACK_SPEC.contextWindow,
    inputLimit: limits?.input,
    maxOutput: limits?.output ?? FALLBACK_SPEC.maxOutput,
    supportsTools: true,
    supportsVision: inferVision(id),
    apiFormat: inferApiFormat(id),
    thinkingMode: inferThinking(id),
    baseUrl: inferBaseUrl(id),
  };
}

export async function discoverModels(): Promise<OcGoModelInfo[]> {
  const now = Date.now();
  if (cachedDiscovered && now - cacheTime < DISCOVER_CACHE_TTL_MS) {
    return cachedDiscovered;
  }

  const [goIds, zenIds, goLimits] = await Promise.all([
    fetchModelIds(GO_MODELS_API),
    fetchModelIds(ZEN_MODELS_API),
    fetchModelLimits(),
  ]);

  const goIdSet = new Set(goIds);
  const apiIds = new Set([...goIds, ...zenIds]);
  const discoveredModels: OcGoModelInfo[] = [];

  for (const id of apiIds) {
    const limits = goIdSet.has(id) ? goLimits.get(id) : undefined;
    const known = OC_GO_MODELS.find((model) => model.id === id);
    discoveredModels.push(
      limits && known
        ? {
            ...known,
            contextWindow: limits.context,
            inputLimit: limits.input,
            maxOutput: limits.output,
          }
        : known ?? buildModelEntry(id, limits)
    );
  }

  cachedDiscovered = discoveredModels;
  cacheTime = now;

  if (discoveredModels.length > 0) {
    console.log(
      `[OpenCode Go Provider] Discovered ${discoveredModels.length} model(s) from API:`,
      discoveredModels.map((m) => m.id).join(", ")
    );
  }

  return discoveredModels;
}

export function clearDiscoverCache(): void {
  cachedDiscovered = null;
  cacheTime = 0;
}

export function getAllModels(discovered: OcGoModelInfo[]): OcGoModelInfo[] {
  const discoveredById = new Map(discovered.map((model) => [model.id, model]));
  const known = new Set(OC_GO_MODELS.map((m) => m.id));
  const merged = OC_GO_MODELS.map((model) => {
    const discoveredModel = discoveredById.get(model.id);
    return discoveredModel
      ? {
          ...model,
          contextWindow: discoveredModel.contextWindow,
          inputLimit: discoveredModel.inputLimit ?? model.inputLimit,
          maxOutput: discoveredModel.maxOutput,
        }
      : model;
  });
  for (const m of discovered) {
    if (!known.has(m.id)) {
      merged.push(m);
    }
  }
  return merged;
}
