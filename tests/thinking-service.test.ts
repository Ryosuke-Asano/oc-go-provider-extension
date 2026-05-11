import {
  getThinkingSchemaForModel,
  getThinkingParams,
  parseVariantModelId,
  createModelVariants,
} from "../src/thinking";

describe("thinking", () => {
  describe("getThinkingSchemaForModel", () => {
    it("should return schema for DeepSeek with correct enum order (high=default)", () => {
      const schema = getThinkingSchemaForModel("deepseek-v4-pro");
      expect(schema).toBeDefined();
      expect((schema?.properties as any)?.thinking_effort).toEqual({
        type: "string",
        enum: ["high", "max", "none"],
        enumItemLabels: ["High", "Max", "None"],
        description: "Thinking",
        group: "navigation",
      });
    });

    it("should return NO schema for Kimi (removed, API ignores disabled)", () => {
      const schema = getThinkingSchemaForModel("kimi-k2.5");
      expect(schema).toBeUndefined();
    });

    it("should return NO schema for GLM (removed, API ignores disabled)", () => {
      const schema = getThinkingSchemaForModel("glm-5.1");
      expect(schema).toBeUndefined();
    });

    it("should return schema for MiMo with correct enum order (on=default)", () => {
      const schema = getThinkingSchemaForModel("mimo-v2-pro");
      expect(schema).toBeDefined();
      expect((schema?.properties as any)?.thinking_effort).toEqual({
        type: "string",
        enum: ["on", "off"],
        enumItemLabels: ["On", "Off"],
        description: "Thinking",
        group: "navigation",
      });
    });

    it("should return schema for Qwen with correct enum order (on=default)", () => {
      const schema = getThinkingSchemaForModel("qwen3.5-plus");
      expect(schema).toBeDefined();
      expect((schema?.properties as any)?.thinking_effort).toEqual({
        type: "string",
        enum: ["on", "off"],
        enumItemLabels: ["On", "Off"],
        description: "Thinking",
        group: "navigation",
      });
    });

    it("should return undefined for MiniMax (no thinking support)", () => {
      expect(getThinkingSchemaForModel("minimax-m2.5")).toBeUndefined();
    });

    it("should return undefined for unknown model", () => {
      expect(getThinkingSchemaForModel("unknown-model")).toBeUndefined();
    });

    it("should return correct schema for all MiMo variants", () => {
      const omni = getThinkingSchemaForModel("mimo-v2-omni");
      expect((omni?.properties as any)?.thinking_effort?.enum).toEqual(["on", "off"]);
      const v25 = getThinkingSchemaForModel("mimo-v2.5");
      expect((v25?.properties as any)?.thinking_effort?.enum).toEqual(["on", "off"]);
      const v25p = getThinkingSchemaForModel("mimo-v2.5-pro");
      expect((v25p?.properties as any)?.thinking_effort?.enum).toEqual(["on", "off"]);
    });

    it("should return correct schema for Qwen 3.5 and 3.6 variants", () => {
      expect(getThinkingSchemaForModel("qwen3.5-plus")).toBeDefined();
      expect((getThinkingSchemaForModel("qwen3.5-plus")?.properties as any)?.thinking_effort?.enum).toEqual(["on", "off"]);
      expect(getThinkingSchemaForModel("qwen3.6-plus")).toBeDefined();
      expect((getThinkingSchemaForModel("qwen3.6-plus")?.properties as any)?.thinking_effort?.enum).toEqual(["on", "off"]);
    });
  });

  describe("getThinkingParams", () => {
    describe("DeepSeek", () => {
      it("should send both reasoning_effort AND thinking for high", () => {
        expect(getThinkingParams("deepseek-v4-pro", "high")).toEqual({
          reasoning_effort: "high",
          thinking: { type: "enabled" },
        });
      });

      it("should send both reasoning_effort AND thinking for max", () => {
        expect(getThinkingParams("deepseek-v4-flash", "max")).toEqual({
          reasoning_effort: "max",
          thinking: { type: "enabled" },
        });
      });

      it("should return thinking disabled for none", () => {
        expect(getThinkingParams("deepseek-v4-pro", "none")).toEqual({ thinking: { type: "disabled" } });
      });

      it("should return undefined for invalid level", () => {
        expect(getThinkingParams("deepseek-v4-pro", "on")).toBeUndefined();
        expect(getThinkingParams("deepseek-v4-pro", "off")).toBeUndefined();
        expect(getThinkingParams("deepseek-v4-pro", "low")).toBeUndefined();
      });
    });

    describe("Kimi and GLM — REMOVED (APIs ignore disabled)", () => {
      it("should return undefined for any level (no thinking config)", () => {
        // Kimi and GLM no longer have family configs — APIs ignore disabled
        expect(getThinkingParams("kimi-k2.5", "on")).toBeUndefined();
        expect(getThinkingParams("kimi-k2.5", "off")).toBeUndefined();
        expect(getThinkingParams("glm-5", "on")).toBeUndefined();
        expect(getThinkingParams("glm-5.1", "off")).toBeUndefined();
        expect(getThinkingParams("kimi-k2.6", "on")).toBeUndefined();
      });
    });

    describe("MiMo (chat_template_kwargs)", () => {
      it("should send chat_template_kwargs for on", () => {
        expect(getThinkingParams("mimo-v2-pro", "on")).toEqual({
          chat_template_kwargs: { enable_thinking: true },
        });
        expect(getThinkingParams("mimo-v2.5", "on")).toEqual({
          chat_template_kwargs: { enable_thinking: true },
        });
      });

      it("should return chat_template_kwargs disabled for off", () => {
        expect(getThinkingParams("mimo-v2-omni", "off")).toEqual({ chat_template_kwargs: { enable_thinking: false } });
        expect(getThinkingParams("mimo-v2.5-pro", "off")).toEqual({ chat_template_kwargs: { enable_thinking: false } });
      });

      it("should return undefined for invalid level", () => {
        expect(getThinkingParams("mimo-v2-pro", "high")).toBeUndefined();
        expect(getThinkingParams("mimo-v2-pro", "none")).toBeUndefined();
      });

    it("should work for all MiMo variants", () => {
      expect(getThinkingParams("mimo-v2-pro", "on")).toEqual({
        chat_template_kwargs: { enable_thinking: true },
      });
      expect(getThinkingParams("mimo-v2-omni", "on")).toEqual({
        chat_template_kwargs: { enable_thinking: true },
      });
      expect(getThinkingParams("mimo-v2.5-pro", "on")).toEqual({
        chat_template_kwargs: { enable_thinking: true },
      });
      expect(getThinkingParams("mimo-v2.5", "on")).toEqual({
        chat_template_kwargs: { enable_thinking: true },
      });
    });
    });

    describe("Qwen (chat_template_kwargs)", () => {
      it("should send chat_template_kwargs for on", () => {
        expect(getThinkingParams("qwen3.6-plus", "on")).toEqual({
          chat_template_kwargs: { enable_thinking: true },
        });
        expect(getThinkingParams("qwen3.5-plus", "on")).toEqual({
          chat_template_kwargs: { enable_thinking: true },
        });
      });

      it("should return chat_template_kwargs disabled for off", () => {
        expect(getThinkingParams("qwen3.5-plus", "off")).toEqual({ chat_template_kwargs: { enable_thinking: false } });
        expect(getThinkingParams("qwen3.6-plus", "off")).toEqual({ chat_template_kwargs: { enable_thinking: false } });
      });

    it("should return undefined for invalid level", () => {
      expect(getThinkingParams("qwen3.5-plus", "high")).toBeUndefined();
      expect(getThinkingParams("qwen3.5-plus", "none")).toBeUndefined();
      expect(getThinkingParams("qwen3.6-plus", "on")).toEqual({
        chat_template_kwargs: { enable_thinking: true },
      });
    });
    });

    describe("MiniMax", () => {
      it("should return undefined for any level (no thinking support)", () => {
        expect(getThinkingParams("minimax-m2.5", "on")).toBeUndefined();
        expect(getThinkingParams("minimax-m2.5", "off")).toBeUndefined();
        expect(getThinkingParams("minimax-m2.7", "on")).toBeUndefined();
        expect(getThinkingParams("minimax-m2.7", "off")).toBeUndefined();
      });
    });

    describe("undefined level", () => {
      it("should return undefined for undefined level (no selection made)", () => {
        expect(getThinkingParams("deepseek-v4-pro", undefined)).toBeUndefined();
        expect(getThinkingParams("kimi-k2.5", undefined)).toBeUndefined();
        expect(getThinkingParams("mimo-v2-pro", undefined)).toBeUndefined();
        expect(getThinkingParams("qwen3.5-plus", undefined)).toBeUndefined();
      });
    });

    describe("unknown model", () => {
      it("should return undefined for unknown model", () => {
        expect(getThinkingParams("unknown-model", "high")).toBeUndefined();
        expect(getThinkingParams("unknown-model", "on")).toBeUndefined();
      });
    });
  });

  describe("parseVariantModelId", () => {
    it("should return baseId and level for DeepSeek variant", () => {
      const result = parseVariantModelId("deepseek-v4-pro-high");
      expect(result.baseId).toBe("deepseek-v4-pro");
      expect(result.level).toBe("high");
    });

    it("should return baseId and level for MiMo variant", () => {
      const result = parseVariantModelId("mimo-v2-pro-on");
      expect(result.baseId).toBe("mimo-v2-pro");
      expect(result.level).toBe("on");
    });

    it("should return same id when no variant suffix", () => {
      const result = parseVariantModelId("deepseek-v4-pro");
      expect(result.baseId).toBe("deepseek-v4-pro");
      expect(result.level).toBeUndefined();
    });

    it("should strip suffix only when baseId is a known family", () => {
      expect(parseVariantModelId("deepseek-v4-pro-high").baseId).toBe("deepseek-v4-pro");
      expect(parseVariantModelId("deepseek-v4-pro-high").level).toBe("high");
      expect(parseVariantModelId("deepseek-v4-pro-on").baseId).toBe("deepseek-v4-pro");
      expect(parseVariantModelId("deepseek-v4-pro-on").level).toBe("on");
    });
  });

  describe("createModelVariants", () => {
    it("should create DeepSeek variants in schema order", () => {
      const variants = createModelVariants({
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        displayName: "DeepSeek V4 Pro",
        contextWindow: 1000000,
        maxOutput: 393216,
        supportsTools: true,
        supportsVision: false,
        supportsReasoning: true,
        apiFormat: "openai",
      });
      expect(variants.length).toBe(3);
      expect(variants[0].id).toBe("deepseek-v4-pro-high");
      expect(variants[1].id).toBe("deepseek-v4-pro-max");
      expect(variants[2].id).toBe("deepseek-v4-pro-none");
    });

    it("should create MiMo toggle variants in schema order", () => {
      const variants = createModelVariants({
        id: "mimo-v2-pro",
        name: "MiMo-V2-Pro",
        displayName: "MiMo-V2-Pro",
        contextWindow: 1048576,
        maxOutput: 131072,
        supportsTools: true,
        supportsVision: false,
        supportsReasoning: true,
        apiFormat: "openai",
      });
      expect(variants.length).toBe(2);
      expect(variants[0].id).toBe("mimo-v2-pro-on");
      expect(variants[1].id).toBe("mimo-v2-pro-off");
    });

    it("should return empty array for MiniMax", () => {
      const variants = createModelVariants({
        id: "minimax-m2.5",
        name: "MiniMax M2.5",
        displayName: "MiniMax M2.5",
        contextWindow: 196608,
        maxOutput: 131072,
        supportsTools: true,
        supportsVision: false,
        supportsReasoning: false,
        apiFormat: "anthropic",
      });
      expect(variants.length).toBe(0);
    });
  });
});
