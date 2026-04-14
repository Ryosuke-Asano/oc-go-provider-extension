/// <reference types="jest" />
/**
 * Unit tests for utility functions in utils.ts
 */

import * as vscode from "../__mocks__/vscode";
import * as realVscode from "vscode";
import type { LegacyPart } from "../src/utils";
import type { AnthropicContentBlock } from "../src/types";
import {
  tryParseJSONObject,
  validateRequest,
  estimateTokens,
  estimateMessagesTokens,
  convertMessages,
  convertTools,
  convertMessagesToAnthropic,
  convertToolsToAnthropic,
} from "../src/utils";

/**
 * Helper to cast mock messages to be compatible with utils.ts functions
 */
function toValidatableMessages(
  messages: vscode.LanguageModelChatMessage[]
): readonly {
  role: string;
  content: (realVscode.LanguageModelInputPart | LegacyPart)[];
}[] {
  return messages as unknown as readonly {
    role: string;
    content: (realVscode.LanguageModelInputPart | LegacyPart)[];
  }[];
}

function toEstimatableMessages(
  messages: vscode.LanguageModelChatMessage[]
): readonly { content: (realVscode.LanguageModelInputPart | LegacyPart)[] }[] {
  return messages as unknown as readonly {
    content: (realVscode.LanguageModelInputPart | LegacyPart)[];
  }[];
}

describe("tryParseJSONObject", () => {
  it("should parse valid JSON object successfully", () => {
    const result = tryParseJSONObject('{"name": "test", "value": 123}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ name: "test", value: 123 });
    }
  });

  it("should parse valid JSON array successfully", () => {
    const result = tryParseJSONObject("[1, 2, 3]");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([1, 2, 3]);
    }
  });

  it("should parse valid JSON string successfully", () => {
    const result = tryParseJSONObject('"hello world"');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("hello world");
    }
  });

  it("should parse valid JSON number successfully", () => {
    const result = tryParseJSONObject("42");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(42);
    }
  });

  it("should parse valid JSON boolean successfully", () => {
    const result = tryParseJSONObject("true");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(true);
    }
  });

  it("should return error for invalid JSON", () => {
    const result = tryParseJSONObject("{invalid json}");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeDefined();
      expect(typeof result.error).toBe("string");
    }
  });

  it("should return error for empty string", () => {
    const result = tryParseJSONObject("");
    expect(result.ok).toBe(false);
  });

  it("should return error for non-JSON string", () => {
    const result = tryParseJSONObject("just a string");
    expect(result.ok).toBe(false);
  });

  it("should return error for malformed object", () => {
    const result = tryParseJSONObject('{name: "test"}'); // Missing quotes
    expect(result.ok).toBe(false);
  });
});

describe("validateRequest", () => {
  it("should pass validation for valid message array", () => {
    const message = new vscode.LanguageModelChatMessage(
      vscode.LanguageModelChatMessageRole.User,
      [new vscode.LanguageModelTextPart("Hello")]
    );
    expect(() =>
      validateRequest(toValidatableMessages([message]))
    ).not.toThrow();
  });

  it("should throw error for empty message array", () => {
    expect(() => validateRequest([])).toThrow("Messages array is empty");
  });

  it("should throw error for null messages", () => {
    // @ts-expect-error: testing invalid input
    expect(() => validateRequest(null)).toThrow("Messages array is empty");
  });

  it("should throw error for undefined messages", () => {
    // @ts-expect-error: testing invalid input
    expect(() => validateRequest(undefined)).toThrow("Messages array is empty");
  });

  it("should throw error for message with no content", () => {
    const message = new vscode.LanguageModelChatMessage(
      vscode.LanguageModelChatMessageRole.User,
      []
    );
    expect(() => validateRequest(toValidatableMessages([message]))).toThrow(
      "Message has no content"
    );
  });

  it("should pass validation for multiple messages", () => {
    const messages = [
      new vscode.LanguageModelChatMessage(
        vscode.LanguageModelChatMessageRole.User,
        [new vscode.LanguageModelTextPart("Hello")]
      ),
      new vscode.LanguageModelChatMessage(
        vscode.LanguageModelChatMessageRole.Assistant,
        [new vscode.LanguageModelTextPart("Hi there")]
      ),
    ];
    expect(() =>
      validateRequest(toValidatableMessages(messages))
    ).not.toThrow();
  });
});

describe("estimateTokens", () => {
  it("should estimate tokens for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("should estimate tokens for short text", () => {
    const text = "Hello";
    expect(estimateTokens(text)).toBe(Math.ceil(5 / 2)); // 5 chars / 2 = 2.5 -> 3
  });

  it("should estimate tokens for longer text", () => {
    const text = "Hello world, this is a test";
    expect(estimateTokens(text)).toBe(Math.ceil(27 / 2)); // 27 chars / 2 = 13.5 -> 14
  });

  it("should handle whitespace", () => {
    const text = "Hello   world";
    expect(estimateTokens(text)).toBe(Math.ceil(13 / 2)); // 13 chars / 2 = 6.5 -> 7
  });

  it("should handle newlines", () => {
    const text = "Hello\nWorld\nTest";
    expect(estimateTokens(text)).toBe(Math.ceil(16 / 2)); // 16 chars (incl \n) / 2 -> 8
  });

  it("should handle unicode characters", () => {
    const text = "こんにちは世界";
    expect(estimateTokens(text)).toBe(Math.ceil(7 / 2)); // 7 chars / 2 = 3.5 -> 4
  });

  it("should handle special characters", () => {
    const text = "!@#$%^&*()";
    expect(estimateTokens(text)).toBe(Math.ceil(10 / 2)); // 10 chars / 2 = 5
  });
});

describe("estimateMessagesTokens", () => {
  it("should estimate tokens for single text message", () => {
    const message = new vscode.LanguageModelChatMessage(
      vscode.LanguageModelChatMessageRole.User,
      [new vscode.LanguageModelTextPart("Hello world")]
    );
    const tokens = estimateMessagesTokens(toEstimatableMessages([message]));
    expect(tokens).toBe(Math.ceil(11 / 2)); // 11 chars / 2 = 5.5 -> 6
  });

  it("should estimate tokens for multiple messages", () => {
    const messages = [
      new vscode.LanguageModelChatMessage(
        vscode.LanguageModelChatMessageRole.User,
        [new vscode.LanguageModelTextPart("Hello")]
      ),
      new vscode.LanguageModelChatMessage(
        vscode.LanguageModelChatMessageRole.Assistant,
        [new vscode.LanguageModelTextPart("Hi there")]
      ),
    ];
    const tokens = estimateMessagesTokens(toEstimatableMessages(messages));
    expect(tokens).toBe(Math.ceil(14 / 2)); // 14 chars total / 2 = 7
  });

  it("should estimate tokens for messages with images", () => {
    // Create a mock image part
    const mockImagePart = new vscode.LanguageModelDataPart(
      new Uint8Array([1, 2, 3, 4]),
      "image/png"
    );

    const message = new vscode.LanguageModelChatMessage(
      vscode.LanguageModelChatMessageRole.User,
      [new vscode.LanguageModelTextPart("Describe this"), mockImagePart]
    );
    const tokens = estimateMessagesTokens(toEstimatableMessages([message]));
    // 16 chars for text + 1500 for image = 1516
    expect(tokens).toBeGreaterThanOrEqual(1500);
  });

  it("should estimate tokens for text data parts", () => {
    const text = "Token count from data part";
    const dataPart = vscode.LanguageModelDataPart.text(text);
    const message = new vscode.LanguageModelChatMessage(
      vscode.LanguageModelChatMessageRole.User,
      [dataPart]
    );

    const tokens = estimateMessagesTokens(toEstimatableMessages([message]));
    expect(tokens).toBe(Math.ceil(text.length / 2));
  });

  it("should estimate tokens for json data parts", () => {
    const payload = { action: "analyze", target: "file.ts" };
    const jsonText = JSON.stringify(payload);
    const dataPart = vscode.LanguageModelDataPart.json(payload);
    const message = new vscode.LanguageModelChatMessage(
      vscode.LanguageModelChatMessageRole.User,
      [dataPart]
    );

    const tokens = estimateMessagesTokens(toEstimatableMessages([message]));
    expect(tokens).toBe(Math.ceil(jsonText.length / 2));
  });

  it("should estimate tokens for message with only text", () => {
    const message = new vscode.LanguageModelChatMessage(
      vscode.LanguageModelChatMessageRole.User,
      [
        new vscode.LanguageModelTextPart("Part 1"),
        new vscode.LanguageModelTextPart("Part 2"),
        new vscode.LanguageModelTextPart("Part 3"),
      ]
    );
    const tokens = estimateMessagesTokens(toEstimatableMessages([message]));
    // Each part: 6 chars / 2 = 3 tokens, Total: 3+3+3 = 9 tokens
    expect(tokens).toBe(9);
  });

  it("should handle empty messages array", () => {
    const tokens = estimateMessagesTokens([]);
    expect(tokens).toBe(0);
  });

  it("should estimate tokens correctly for multiple messages with mixed content", () => {
    // Create a mock image part
    const mockImagePart = new vscode.LanguageModelDataPart(
      new Uint8Array([1, 2, 3, 4]),
      "image/png"
    );

    const messages = [
      new vscode.LanguageModelChatMessage(
        vscode.LanguageModelChatMessageRole.User,
        [new vscode.LanguageModelTextPart("First message"), mockImagePart]
      ),
      new vscode.LanguageModelChatMessage(
        vscode.LanguageModelChatMessageRole.Assistant,
        [new vscode.LanguageModelTextPart("Response")]
      ),
      new vscode.LanguageModelChatMessage(
        vscode.LanguageModelChatMessageRole.User,
        [new vscode.LanguageModelTextPart("Follow up"), mockImagePart]
      ),
    ];
    const tokens = estimateMessagesTokens(toEstimatableMessages(messages));
    // Text: 13 + 8 + 10 = 31 chars
    // Images: 2 * 1500 = 3000
    // Total: 3031 / 4 ≈ 758
    expect(tokens).toBeGreaterThan(3000);
  });
});

describe("convertTools", () => {
  const weatherTool: realVscode.LanguageModelChatTool = {
    name: "get_weather",
    description: "Get weather",
    inputSchema: {
      type: "object",
      properties: {
        location: { type: "string" },
      },
      required: ["location"],
    },
  };

  it("should return empty config when no tools are provided", () => {
    const options = {} as realVscode.ProvideLanguageModelChatResponseOptions;
    expect(convertTools(options)).toEqual({});
  });

  it("should return auto tool_choice in auto mode", () => {
    const options = {
      tools: [weatherTool],
      toolMode: vscode.LanguageModelChatToolMode.Auto,
    } as realVscode.ProvideLanguageModelChatResponseOptions;

    const result = convertTools(options);
    expect(result.tools).toBeDefined();
    expect(result.tools?.length).toBe(1);
    expect(result.tool_choice).toBe("auto");
  });

  it("should default tool_choice to auto when toolMode is not provided", () => {
    const options = {
      tools: [weatherTool],
    } as unknown as realVscode.ProvideLanguageModelChatResponseOptions;

    const result = convertTools(options);
    expect(result.tool_choice).toBe("auto");
  });

  it("should force a specific function in required mode with one tool", () => {
    const options = {
      tools: [weatherTool],
      toolMode: vscode.LanguageModelChatToolMode.Required,
    } as realVscode.ProvideLanguageModelChatResponseOptions;

    const result = convertTools(options);
    expect(result.tool_choice).toEqual({
      type: "function",
      function: { name: "get_weather" },
    });
  });

  it("should throw in required mode with no tools", () => {
    const options = {
      toolMode: vscode.LanguageModelChatToolMode.Required,
    } as realVscode.ProvideLanguageModelChatResponseOptions;

    expect(() => convertTools(options)).toThrow(
      "LanguageModelChatToolMode.Required requires at least one tool."
    );
  });

  it("should throw in required mode with multiple tools", () => {
    const options = {
      tools: [weatherTool, { ...weatherTool, name: "get_time" }],
      toolMode: vscode.LanguageModelChatToolMode.Required,
    } as realVscode.ProvideLanguageModelChatResponseOptions;

    expect(() => convertTools(options)).toThrow(
      "LanguageModelChatToolMode.Required is not supported with more than one tool."
    );
  });
});

describe("convertMessages", () => {
  it("should serialize assistant tool calls as assistant message with tool_calls", () => {
    const assistant = new vscode.LanguageModelChatMessage(
      vscode.LanguageModelChatMessageRole.Assistant,
      [
        new vscode.LanguageModelTextPart("Calling tool"),
        new vscode.LanguageModelToolCallPart("call_1", "get_weather", {
          location: "Tokyo",
        }),
      ]
    );

    const result = convertMessages([assistant]);
    expect(result.length).toBe(1);
    expect(result[0].role).toBe("assistant");
    expect(result[0].tool_calls?.length).toBe(1);
    expect(result[0].tool_calls?.[0].function.name).toBe("get_weather");
  });

  it("should serialize tool results as role=tool messages", () => {
    const userToolResult = new vscode.LanguageModelChatMessage(
      vscode.LanguageModelChatMessageRole.User,
      [
        new vscode.LanguageModelToolResultPart("call_1", [
          new vscode.LanguageModelTextPart("Sunny"),
        ]),
      ]
    );

    const result = convertMessages([userToolResult]);
    expect(result.length).toBe(1);
    expect(result[0].role).toBe("tool");
    expect(result[0].tool_call_id).toBe("call_1");
    expect(result[0].content).toBe("Sunny");
  });

  it("should not emit empty user messages for tool-result-only turns", () => {
    const userToolResult = new vscode.LanguageModelChatMessage(
      vscode.LanguageModelChatMessageRole.User,
      [
        new vscode.LanguageModelToolResultPart("call_1", [
          new vscode.LanguageModelTextPart("42"),
        ]),
      ]
    );

    const result = convertMessages([userToolResult]);
    expect(result.filter((m) => m.role === "user").length).toBe(0);
    expect(result.filter((m) => m.role === "tool").length).toBe(1);
  });
});

describe("convertMessagesToAnthropic", () => {
  it("should extract system message to top-level system field", () => {
    const systemMsg = new vscode.LanguageModelChatMessage(
      vscode.LanguageModelChatMessageRole.User,
      [new vscode.LanguageModelTextPart("You are a helpful assistant.")]
    );
    // Simulate system message by assigning role (VSCode doesn't have a system role,
    // but we handle it in convertMessagesToAnthropic)
    const userMsg = new vscode.LanguageModelChatMessage(
      vscode.LanguageModelChatMessageRole.User,
      [new vscode.LanguageModelTextPart("Hello")]
    );

    const result = convertMessagesToAnthropic([systemMsg, userMsg]);
    expect(result.messages.length).toBeGreaterThanOrEqual(1);
    // Anthropic format only has user/assistant roles; system is separate
    const roles = result.messages.map((m) => m.role);
    expect(roles).not.toContain("system");
  });

  it("should convert user and assistant messages", () => {
    const userMsg = new vscode.LanguageModelChatMessage(
      vscode.LanguageModelChatMessageRole.User,
      [new vscode.LanguageModelTextPart("Hello")]
    );
    const assistantMsg = new vscode.LanguageModelChatMessage(
      vscode.LanguageModelChatMessageRole.Assistant,
      [new vscode.LanguageModelTextPart("Hi there!")]
    );

    const result = convertMessagesToAnthropic([userMsg, assistantMsg]);
    expect(result.messages.length).toBe(2);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[1].role).toBe("assistant");
  });

  it("should convert tool calls to tool_use content blocks", () => {
    const assistant = new vscode.LanguageModelChatMessage(
      vscode.LanguageModelChatMessageRole.Assistant,
      [
        new vscode.LanguageModelTextPart("Let me check that."),
        new vscode.LanguageModelToolCallPart("call_123", "get_weather", {
          location: "Tokyo",
        }),
      ]
    );

    const result = convertMessagesToAnthropic([assistant]);
    expect(result.messages.length).toBeGreaterThanOrEqual(1);
    // Find tool_use block across all messages
    const allBlocks: AnthropicContentBlock[] = result.messages.flatMap((m) =>
      Array.isArray(m.content) ? m.content : []
    );
    const toolUseBlock = allBlocks.find((b) => b.type === "tool_use");
    expect(toolUseBlock).toBeDefined();
    if (toolUseBlock && toolUseBlock.type === "tool_use") {
      expect(toolUseBlock.id).toBe("call_123");
      expect(toolUseBlock.name).toBe("get_weather");
      expect(toolUseBlock.input).toEqual({ location: "Tokyo" });
    }
  });

  it("should convert tool results to user messages with tool_result blocks", () => {
    const userToolResult = new vscode.LanguageModelChatMessage(
      vscode.LanguageModelChatMessageRole.User,
      [
        new vscode.LanguageModelToolResultPart("call_123", [
          new vscode.LanguageModelTextPart("Sunny, 25°C"),
        ]),
      ]
    );

    const result = convertMessagesToAnthropic([userToolResult]);
    expect(result.messages.length).toBe(1);
    expect(result.messages[0].role).toBe("user");
    const content = result.messages[0].content;
    const blocks = Array.isArray(content) ? content : [];
    const toolResultBlock = blocks.find(
      (b: AnthropicContentBlock) => b.type === "tool_result"
    );
    expect(toolResultBlock).toBeDefined();
    if (toolResultBlock && toolResultBlock.type === "tool_result") {
      expect(toolResultBlock.tool_use_id).toBe("call_123");
    }
  });

  it("should merge consecutive same-role messages", () => {
    const user1 = new vscode.LanguageModelChatMessage(
      vscode.LanguageModelChatMessageRole.User,
      [new vscode.LanguageModelTextPart("Hello")]
    );
    const user2 = new vscode.LanguageModelChatMessage(
      vscode.LanguageModelChatMessageRole.User,
      [new vscode.LanguageModelTextPart("How are you?")]
    );

    const result = convertMessagesToAnthropic([user1, user2]);
    // Messages should be merged or interleaved
    expect(result.messages.length).toBeLessThanOrEqual(2);
    // At least the content should be present
    const allBlocks: AnthropicContentBlock[] = result.messages.flatMap((m) =>
      Array.isArray(m.content) ? m.content : []
    );
    const textContent = allBlocks.filter(
      (b) => b.type === "text" && typeof b.text === "string"
    );
    expect(textContent.length).toBeGreaterThanOrEqual(2);
  });
});

describe("convertToolsToAnthropic", () => {
  it("should return empty tools when no tools are provided", () => {
    const options = {} as realVscode.ProvideLanguageModelChatResponseOptions;
    const result = convertToolsToAnthropic(options);
    expect(result.tools).toBeUndefined();
    expect(result.tool_choice).toBeUndefined();
  });

  it("should convert tools to Anthropic format with input_schema", () => {
    const weatherTool: realVscode.LanguageModelChatTool = {
      name: "get_weather",
      description: "Get the weather for a location",
      inputSchema: {
        type: "object",
        properties: {
          location: { type: "string", description: "City name" },
        },
        required: ["location"],
      },
    };

    const options = {
      tools: [weatherTool],
    } as unknown as realVscode.ProvideLanguageModelChatResponseOptions;

    const result = convertToolsToAnthropic(options);
    expect(result.tools).toBeDefined();
    expect(result.tools!.length).toBe(1);
    expect(result.tools![0].name).toBe("get_weather");
    expect(result.tools![0].description).toBe("Get the weather for a location");
    expect(result.tools![0].input_schema).toEqual({
      type: "object",
      properties: {
        location: { type: "string", description: "City name" },
      },
      required: ["location"],
    });
  });

  it("should set tool_choice to auto in auto mode", () => {
    const weatherTool: realVscode.LanguageModelChatTool = {
      name: "get_weather",
      description: "Get the weather",
      inputSchema: { type: "object", properties: {} },
    };

    const options = {
      tools: [weatherTool],
    } as unknown as realVscode.ProvideLanguageModelChatResponseOptions;

    const result = convertToolsToAnthropic(options);
    expect(result.tool_choice).toBe("auto");
  });

  it("should force a specific tool in required mode with one tool", () => {
    const weatherTool: realVscode.LanguageModelChatTool = {
      name: "get_weather",
      description: "Get the weather",
      inputSchema: { type: "object", properties: {} },
    };

    const options = {
      tools: [weatherTool],
      toolMode: vscode.LanguageModelChatToolMode.Required,
    } as realVscode.ProvideLanguageModelChatResponseOptions;

    const result = convertToolsToAnthropic(options);
    expect(result.tool_choice).toEqual({
      type: "tool",
      name: "get_weather",
    });
  });

  it("should not include type:function wrapper like OpenAI format", () => {
    const tool: realVscode.LanguageModelChatTool = {
      name: "search",
      description: "Search the web",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    };

    const options = {
      tools: [tool],
    } as unknown as realVscode.ProvideLanguageModelChatResponseOptions;

    const result = convertToolsToAnthropic(options);
    const toolDef = result.tools![0];
    // Anthropic format has name/description/input_schema directly (no nested function)
    const defAny = toolDef as any;
    expect(defAny["function"]).toBeUndefined();
    expect(defAny["parameters"]).toBeUndefined();
    expect(toolDef.input_schema).toBeDefined();
  });
});
