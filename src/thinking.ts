import type { OcGoModelInfo } from "./types";

export type ThinkingMode = "always" | "switchable" | "none";

export interface ThinkingSchema {
  type: "object";
  properties: Record<string, unknown>;
}

interface FamilyConfig {
  /** Schema enum values (display order) */
  levels: string[];
  /** Map level → API request parameters */
  getParams: (
    level: string
  ) => Record<string, unknown> | null;
  /** Suffix used for stable-API variant model IDs */
  suffix: string;
}

// Sorted longest-key-first so "mimo-v2.5" matches before "mimo-v2"
const FAMILIES: Record<string, FamilyConfig> = {
  "glm-5.2": {
    levels: ["max", "high", "none"],
    getParams: (level) => {
      switch (level) {
        case "max":
          return {
            reasoning_effort: "max",
            thinking: { type: "enabled" },
          };
        case "high":
          return {
            reasoning_effort: "high",
            thinking: { type: "enabled" },
          };
        case "none":
          return {
            reasoning_effort: "none",
            thinking: { type: "disabled" },
          };
        default:
          return null;
      }
    },
    suffix: "reasoning",
  },
  "deepseek-v4": {
    levels: ["max", "high", "none"],
    getParams: (level) => {
      switch (level) {
        case "max":
          return {
            reasoning_effort: "max",
            thinking: { type: "enabled" },
          };
        case "high":
          return {
            reasoning_effort: "high",
            thinking: { type: "enabled" },
          };
        case "none":
          return {
            reasoning_effort: "none",
            thinking: { type: "disabled" },
          };
        default:
          return null;
      }
    },
    suffix: "reasoning",
  },
  "mimo-v2.5": {
    levels: ["on", "off"],
    getParams: (level) => ({
      chat_template_kwargs: { enable_thinking: level === "on" },
    }),
    suffix: "thinking",
  },
  "mimo-v2": {
    levels: ["on", "off"],
    getParams: (level) => ({
      chat_template_kwargs: { enable_thinking: level === "on" },
    }),
    suffix: "thinking",
  },
};

function getFamilyKey(modelId: string): string | undefined {
  const keys = Object.keys(FAMILIES).sort(
    (a, b) => b.length - a.length
  );
  return keys.find((k) => modelId.startsWith(k));
}

export function getThinkingSchemaForModel(
  modelId: string
): ThinkingSchema | null {
  const key = getFamilyKey(modelId);
  if (!key) return null;
  const family = FAMILIES[key];
  return {
    type: "object",
    properties: {
      thinking_effort: {
        type: "string",
        enum: family.levels,
        enumItemLabels: family.levels.map((l) => {
          if (l === "none") return "Disabled";
          if (l === "on") return "Thinking";
          if (l === "off") return "No Thinking";
          return l.charAt(0).toUpperCase() + l.slice(1);
        }),
        description: `Reasoning effort for this model`,
        group: "navigation",
      },
    },
  };
}

export function getThinkingParams(
  modelId: string,
  effort?: string
): Record<string, unknown> | null {
  if (!effort) return null;
  const key = getFamilyKey(modelId);
  if (!key) return null;
  return FAMILIES[key].getParams(effort);
}

export function parseVariantModelId(
  modelId: string
): { baseId: string; level?: string } {
  for (const [key, family] of Object.entries(FAMILIES)) {
    const suffix = `-${family.suffix}`;
    if (modelId.endsWith(suffix)) {
      const baseId = modelId.slice(0, -suffix.length);
      // Only accept if the base is a known family prefix
      if (baseId.startsWith(key)) {
        // Derive the level from the suffix mapping
        // The suffix itself indicates thinking is enabled
        const level = family.levels[0]; // First level = enabled
        return { baseId, level };
      }
    }
  }
  return { baseId: modelId };
}

export function createModelVariants(
  model: OcGoModelInfo
): OcGoModelInfo[] {
  if (model.thinkingMode !== "switchable") return [];
  const key = getFamilyKey(model.id);
  if (!key) return [];
  const family = FAMILIES[key];
  // Create one variant per level (skip first = default)
  return family.levels.slice(1).map((level) => ({
    ...model,
    id: `${model.id}-${family.suffix}`,
    displayName: `${model.displayName} (${level === "on" || level === "max" || level === "high" ? "Thinking" : level})`,
  }));
}
