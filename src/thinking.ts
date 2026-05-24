/**
 * Minimal thinking/reasoning configuration per model family.
 * Maps model families to their supported thinking levels and API parameters.
 *
 * Per-model API params (verified via official docs + E2E probe):
 * - DeepSeek:               reasoning_effort: level + thinking: { type: "enabled|disabled" }
 * - MiMo (Xiaomi):          chat_template_kwargs: { enable_thinking: true|false }
 * - Qwen (Alibaba):         chat_template_kwargs: { enable_thinking: true|false }
 * - Kimi/GLM:               Thinking toggle removed — APIs ignore disabled (always think)
 * - MiniMax:                No thinking params (Anthropic endpoint)
 */

export type ThinkingLevel =
  | "none"
  | "off"
  | "on"
  | "low"
  | "medium"
  | "high"
  | "max";

interface FamilyConfig {
  label: string;
  levels: { value: string; label: string }[];
  getParams: (level: string) => Record<string, unknown> | undefined;
}

/** DeepSeek: requires BOTH reasoning_effort AND thinking toggle. Default = high. */
const DEEPSEEK_CONFIG: FamilyConfig = {
  label: "Thinking",
  levels: [
    { value: "high", label: "High" },
    { value: "max", label: "Max" },
    { value: "none", label: "None" },
  ],
  getParams: (level) => {
    if (level === "none") return { thinking: { type: "disabled" as const } };
    return {
      reasoning_effort: level,
      thinking: { type: "enabled" as const },
    };
  },
};

/** GLM (Zhipu) and Kimi (Moonshot) — REMOVED from family configs.
 *  Their APIs ignore thinking: {type:"disabled"} and always produce reasoning.
 *  A non-functional Off toggle would mislead users, so we omit these families.
 *  Models: glm-5, glm-5.1, kimi-k2.5, kimi-k2.6 (supportsReasoning: false) */

/** MiMo (Xiaomi): uses chat_template_kwargs. Default = on. */
const MIMO_CONFIG: FamilyConfig = {
  label: "Thinking",
  levels: [
    { value: "on", label: "On" },
    { value: "off", label: "Off" },
  ],
  getParams: (level) => {
    if (level === "off") return { chat_template_kwargs: { enable_thinking: false } };
    return { chat_template_kwargs: { enable_thinking: true } };
  },
};

/** Qwen (Alibaba): uses chat_template_kwargs. Default = on. */
const QWEN_CONFIG: FamilyConfig = {
  label: "Thinking",
  levels: [
    { value: "on", label: "On" },
    { value: "off", label: "Off" },
  ],
  getParams: (level) => {
    if (level === "off") return { chat_template_kwargs: { enable_thinking: false } };
    return { chat_template_kwargs: { enable_thinking: true } };
  },
};

const FAMILY_CONFIGS: Record<string, FamilyConfig> = {
  "deepseek-v4": DEEPSEEK_CONFIG,
  "mimo-v2": MIMO_CONFIG,
  "mimo-v2.5": MIMO_CONFIG,
  "qwen3": QWEN_CONFIG,
  "qwen3.5": QWEN_CONFIG,
  "qwen3.6": QWEN_CONFIG,
};

/** Note: Kimi (kimi-k2.*) and GLM (glm-5*) are intentionally absent.
 *  Their proxies ignore thinking: {type:"disabled"} — see probe results. */

function getFamilyConfig(modelId: string): FamilyConfig | undefined {
  // Sort by key length descending so "mimo-v2.5" matches before "mimo-v2"
  const families = Object.keys(FAMILY_CONFIGS).sort((a, b) => b.length - a.length);
  const family = families.find((f) => modelId.startsWith(f));
  return family ? FAMILY_CONFIGS[family] : undefined;
}

/**
 * Build the JSON schema for the thinking subsection of the model configuration.
 * When a property has group: "navigation", VS Code renders it as a ">" submenu
 * in the model picker. enumItemLabels provide human-readable labels.
 * The first enum value is the default when no selection is made yet.
 */
export function getThinkingSchemaForModel(
  modelId: string
): { readonly properties?: Record<string, unknown> } | undefined {
  const config = getFamilyConfig(modelId);
  if (!config) return undefined;
  return {
    properties: {
      thinking_effort: {
        type: "string",
        enum: config.levels.map((l) => l.value),
        enumItemLabels: config.levels.map((l) => l.label),
        description: config.label,
        group: "navigation",
      },
    },
  };
}

/**
 * Get API parameters for the selected thinking level.
 * For "off"/"none", returns the disable param (e.g. thinking:{type:"disabled"}).
 */
export function getThinkingParams(
  modelId: string,
  level: string | undefined
): Record<string, unknown> | undefined {
  if (!level) return undefined;
  const config = getFamilyConfig(modelId);
  if (!config) return undefined;
  const validLevels = config.levels.map((l) => l.value);
  if (!validLevels.includes(level)) return undefined;
  return config.getParams(level);
}

/**
 * Parse a variant model ID to extract the base model ID and thinking level.
 * Example: "deepseek-v4-flash-high" -> { baseId: "deepseek-v4-flash", level: "high" }
 * Note: used for stable-API fallback only; the primary path reads from modelConfiguration.
 */
export function parseVariantModelId(modelId: string): {
  baseId: string;
  level: string | undefined;
} {
  for (const suffix of [
    "none",
    "off",
    "on",
    "low",
    "medium",
    "high",
    "max",
  ]) {
    if (modelId.endsWith(`-${suffix}`)) {
      const baseId = modelId.slice(0, -(suffix.length + 1));
      if (getFamilyConfig(baseId)) {
        return { baseId, level: suffix };
      }
    }
  }
  return { baseId: modelId, level: undefined };
}

/**
 * Create model variants for stable-API fallback when configurationSchema
 * (proposed API) is not supported by the user's VS Code build.
 * Ordered to match the schema enum order.
 */
export function createModelVariants(baseModel: {
  id: string;
  name: string;
  displayName: string;
  contextWindow: number;
  maxOutput: number;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsReasoning?: boolean;
  apiFormat: string;
  fixedTemperature?: number;
}): typeof baseModel[] {
  const config = getFamilyConfig(baseModel.id);
  if (!config) return [];

  return config.levels.map((level) => ({
    ...baseModel,
    id: `${baseModel.id}-${level.value}`,
    name: `${baseModel.name} (${level.label})`,
    displayName: `${baseModel.displayName} (${level.label})`,
  }));
}
