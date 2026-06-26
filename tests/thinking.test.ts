import {
  getThinkingSchemaForModel,
  getThinkingParams,
  parseVariantModelId,
  createModelVariants,
} from "../src/thinking";
import type { OcGoModelInfo } from "../src/types";

describe("thinking module", () => {
  describe("getThinkingSchemaForModel", () => {
    it("returns null for non-thinking models", () => {
      expect(getThinkingSchemaForModel("qwen3.7-max")).toBeNull();
      expect(getThinkingSchemaForModel("glm-5.1")).toBeNull();
      expect(getThinkingSchemaForModel("kimi-k2.7-code")).toBeNull();
      expect(getThinkingSchemaForModel("kimi-k2.6")).toBeNull();
      expect(getThinkingSchemaForModel("minimax-m3")).toBeNull();
      expect(getThinkingSchemaForModel("minimax-m2.7")).toBeNull();
    });

    it("returns schema for DeepSeek models", () => {
      const schema = getThinkingSchemaForModel("deepseek-v4-pro");
      expect(schema).not.toBeNull();
      expect(schema!.properties.thinking_effort).toBeDefined();
      expect((schema!.properties.thinking_effort as { enum: string[] }).enum).toEqual(["max", "high", "none"]);
    });

    it("returns schema for MiMo models", () => {
      const schema = getThinkingSchemaForModel("mimo-v2.5");
      expect(schema).not.toBeNull();
      expect(schema!.properties.thinking_effort).toBeDefined();
      expect((schema!.properties.thinking_effort as { enum: string[] }).enum).toEqual(["on", "off"]);
    });

    it("returns schema for GLM-5.2 model", () => {
      const schema = getThinkingSchemaForModel("glm-5.2");
      expect(schema).not.toBeNull();
      expect(schema!.properties.thinking_effort).toBeDefined();
      expect((schema!.properties.thinking_effort as { enum: string[] }).enum).toEqual(["max", "high", "none"]);
    });
  });

  describe("getThinkingParams", () => {
    it("returns null for undefined effort", () => {
      expect(getThinkingParams("deepseek-v4-pro")).toBeNull();
    });

    it("returns null for unknown models", () => {
      expect(getThinkingParams("unknown-model", "high")).toBeNull();
    });

    it("returns correct params for DeepSeek max", () => {
      const params = getThinkingParams("deepseek-v4-pro", "max");
      expect(params).toEqual({
        reasoning_effort: "max",
        thinking: { type: "enabled" },
      });
    });

    it("returns correct params for DeepSeek high", () => {
      const params = getThinkingParams("deepseek-v4-flash", "high");
      expect(params).toEqual({
        reasoning_effort: "high",
        thinking: { type: "enabled" },
      });
    });

    it("returns correct params for DeepSeek none", () => {
      const params = getThinkingParams("deepseek-v4-pro", "none");
      expect(params).toEqual({
        reasoning_effort: "none",
        thinking: { type: "disabled" },
      });
    });
    it("returns correct params for MiMo on", () => {
      const params = getThinkingParams("mimo-v2.5", "on");
      expect(params).toEqual({
        chat_template_kwargs: { enable_thinking: true },
      });
    });

    it("returns correct params for MiMo off", () => {
      const params = getThinkingParams("mimo-v2.5", "off");
      expect(params).toEqual({
        chat_template_kwargs: { enable_thinking: false },
      });
    });

    it("returns correct params for GLM-5.2 max", () => {
      const params = getThinkingParams("glm-5.2", "max");
      expect(params).toEqual({
        reasoning_effort: "max",
        thinking: { type: "enabled" },
      });
    });
  });

  describe("parseVariantModelId", () => {
    it("returns baseId for non-variant IDs", () => {
      expect(parseVariantModelId("deepseek-v4-pro")).toEqual({
        baseId: "deepseek-v4-pro",
      });
    });

    it("parses thinking variant for DeepSeek", () => {
      const result = parseVariantModelId("deepseek-v4-pro-reasoning");
      expect(result.baseId).toBe("deepseek-v4-pro");
      expect(result.level).toBeDefined();
    });

    it("parses thinking variant for MiMo", () => {
      const result = parseVariantModelId("mimo-v2.5-thinking");
      expect(result.baseId).toBe("mimo-v2.5");
      expect(result.level).toBeDefined();
    });

    it("handles unknown variants", () => {
      expect(parseVariantModelId("unknown-model-xyz")).toEqual({
        baseId: "unknown-model-xyz",
      });
    });
  });

  describe("createModelVariants", () => {
    it("returns empty for non-switchable models", () => {
      const model: OcGoModelInfo = {
        id: "glm-5.1",
        name: "GLM-5.1",
        displayName: "GLM-5.1",
        contextWindow: 200000,
        maxOutput: 131072,
        supportsTools: true,
        supportsVision: false,
        apiFormat: "openai",
        thinkingMode: "none",
      };
      expect(createModelVariants(model)).toEqual([]);
    });

    it("returns empty for always-thinking models", () => {
      const model: OcGoModelInfo = {
        id: "kimi-k2.6",
        name: "Kimi K2.6",
        displayName: "Kimi K2.6",
        contextWindow: 262144,
        maxOutput: 262144,
        supportsTools: true,
        supportsVision: true,
        apiFormat: "openai",
        fixedTemperature: 1,
        thinkingMode: "always",
      };
      expect(createModelVariants(model)).toEqual([]);
    });

    it("creates variants for switchable DeepSeek model", () => {
      const model: OcGoModelInfo = {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        displayName: "DeepSeek V4 Pro",
        contextWindow: 1000000,
        maxOutput: 393216,
        supportsTools: true,
        supportsVision: false,
        apiFormat: "openai",
        thinkingMode: "switchable",
      };
      const variants = createModelVariants(model);
      expect(variants.length).toBeGreaterThan(0);
      expect(variants[0].id).toContain("deepseek-v4-pro");
    });
  });
});
