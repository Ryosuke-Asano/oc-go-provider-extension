/// <reference types="jest" />
/**
 * Unit tests for type definitions in types.ts
 */

import {
  OcGoContentPart,
  OcGoChatMessage,
  OcGoToolCall,
  OcGoTool,
  OcGoChatRequest,
  OcGoChatChoice,
  OcGoChatResponse,
  OcGoStreamChoice,
  OcGoStreamResponse,
  OcGoRequestBody,
  OC_GO_MODELS,
} from "../src/types";

describe("OcGoContentPart", () => {
  it("should create valid text part", () => {
    const part: OcGoContentPart = {
      type: "text",
      text: "Hello world",
    };
    expect(part.type).toBe("text");
    expect(part.text).toBe("Hello world");
  });

  it("should create valid image_url part", () => {
    const part: OcGoContentPart = {
      type: "image_url",
      image_url: {
        url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg==",
      },
    };
    expect(part.type).toBe("image_url");
    expect(part.image_url).toBeDefined();
    expect(part.image_url?.url).toContain("data:image/png;base64,");
  });

  it("should validate type is either text or image_url", () => {
    const textPart: OcGoContentPart = {
      type: "text",
      text: "test",
    };
    expect(["text", "image_url"]).toContain(textPart.type);
  });
});

describe("OcGoChatMessage", () => {
  it("should create user message with text content", () => {
    const message: OcGoChatMessage = {
      role: "user",
      content: "Hello",
    };
    expect(message.role).toBe("user");
    expect(message.content).toBe("Hello");
  });

  it("should create assistant message with content array", () => {
    const content: OcGoContentPart[] = [{ type: "text", text: "Response" }];
    const message: OcGoChatMessage = {
      role: "assistant",
      content,
    };
    expect(message.role).toBe("assistant");
    expect(Array.isArray(message.content)).toBe(true);
  });

  it("should include tool_calls in message", () => {
    const toolCall: OcGoToolCall = {
      id: "call_123",
      type: "function",
      function: {
        name: "get_weather",
        arguments: '{"location": "Tokyo"}',
      },
    };
    const message: OcGoChatMessage = {
      role: "assistant",
      content: "",
      tool_calls: [toolCall],
    };
    expect(message.tool_calls).toBeDefined();
    expect(message.tool_calls?.length).toBe(1);
    expect(message.tool_calls?.[0].function.name).toBe("get_weather");
  });

  it("should include tool_call_id for tool messages", () => {
    const message: OcGoChatMessage = {
      role: "tool",
      content: '{"result": "sunny"}',
      tool_call_id: "call_123",
      name: "get_weather",
    };
    expect(message.role).toBe("tool");
    expect(message.tool_call_id).toBe("call_123");
  });

  it("should support name field", () => {
    const message: OcGoChatMessage = {
      role: "user",
      content: "Hello",
      name: "John",
    };
    expect(message.name).toBe("John");
  });
});

describe("OcGoToolCall", () => {
  it("should create valid function tool call", () => {
    const toolCall: OcGoToolCall = {
      id: "call_123",
      type: "function",
      function: {
        name: "search",
        arguments: '{"query": "test"}',
      },
    };
    expect(toolCall.id).toBe("call_123");
    expect(toolCall.type).toBe("function");
    expect(toolCall.function.name).toBe("search");
  });

  it("should include valid JSON arguments", () => {
    const args = JSON.stringify({ key: "value", num: 123 });
    const toolCall: OcGoToolCall = {
      id: "call_456",
      type: "function",
      function: {
        name: "calculate",
        arguments: args,
      },
    };
    expect(JSON.parse(toolCall.function.arguments)).toEqual({
      key: "value",
      num: 123,
    });
  });
});

describe("OcGoTool", () => {
  it("should create valid function tool definition", () => {
    const tool: OcGoTool = {
      type: "function",
      function: {
        name: "get_current_time",
        description: "Get the current time",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    };
    expect(tool.type).toBe("function");
    expect(tool.function.name).toBe("get_current_time");
    expect(tool.function.description).toBeDefined();
  });

  it("should create tool without parameters", () => {
    const tool: OcGoTool = {
      type: "function",
      function: {
        name: "simple_tool",
      },
    };
    expect(tool.function.parameters).toBeUndefined();
  });
});

describe("OcGoChatRequest", () => {
  it("should create basic chat request", () => {
    const request: OcGoChatRequest = {
      model: "glm-5",
      messages: [{ role: "user", content: "Hello" }],
    };
    expect(request.model).toBe("glm-5");
    expect(request.messages.length).toBe(1);
  });

  it("should create request with temperature", () => {
    const request: OcGoChatRequest = {
      model: "glm-5",
      messages: [],
      temperature: 0.7,
    };
    expect(request.temperature).toBe(0.7);
  });

  it("should create request with max_tokens", () => {
    const request: OcGoChatRequest = {
      model: "glm-5",
      messages: [],
      max_tokens: 4096,
    };
    expect(request.max_tokens).toBe(4096);
  });

  it("should create request with streaming enabled", () => {
    const request: OcGoChatRequest = {
      model: "glm-5",
      messages: [],
      stream: true,
    };
    expect(request.stream).toBe(true);
  });

  it("should create request with tools", () => {
    const tool: OcGoTool = {
      type: "function",
      function: {
        name: "test_tool",
        description: "A test tool",
      },
    };
    const request: OcGoChatRequest = {
      model: "glm-5",
      messages: [],
      tools: [tool],
    };
    expect(request.tools).toBeDefined();
    expect(request.tools?.length).toBe(1);
  });

  it("should create request with tool_choice auto", () => {
    const request: OcGoChatRequest = {
      model: "glm-5",
      messages: [],
      tool_choice: "auto",
    };
    expect(request.tool_choice).toBe("auto");
  });

  it("should create request with tool_choice none", () => {
    const request: OcGoChatRequest = {
      model: "glm-5",
      messages: [],
      tool_choice: "none",
    };
    expect(request.tool_choice).toBe("none");
  });

  it("should create request with stop strings", () => {
    const request: OcGoChatRequest = {
      model: "glm-5",
      messages: [],
      stop: ["\n\n", "###"],
    };
    expect(Array.isArray(request.stop)).toBe(true);
    expect(request.stop?.length).toBe(2);
  });
});

describe("OcGoChatResponse", () => {
  it("should create valid chat response", () => {
    const choice: OcGoChatChoice = {
      index: 0,
      message: {
        role: "assistant",
        content: "Hello!",
      },
      finish_reason: "stop",
    };
    const response: OcGoChatResponse = {
      id: "resp_123",
      object: "chat.completion",
      created: Date.now(),
      model: "glm-5",
      choices: [choice],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    };
    expect(response.id).toBe("resp_123");
    expect(response.choices[0].message.content).toBe("Hello!");
    expect(response.usage.total_tokens).toBe(15);
  });

  it("should include tool_calls in response", () => {
    const toolCall: OcGoToolCall = {
      id: "call_123",
      type: "function",
      function: {
        name: "test",
        arguments: "{}",
      },
    };
    const choice: OcGoChatChoice = {
      index: 0,
      message: {
        role: "assistant",
        content: "",
        tool_calls: [toolCall],
      },
      finish_reason: "tool_calls",
    };
    const response: OcGoChatResponse = {
      id: "resp_456",
      object: "chat.completion",
      created: Date.now(),
      model: "glm-5",
      choices: [choice],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    };
    expect(response.choices[0].finish_reason).toBe("tool_calls");
  });
});

describe("OcGoStreamResponse", () => {
  it("should create valid stream response", () => {
    const choice: OcGoStreamChoice = {
      index: 0,
      delta: {
        role: "assistant",
        content: "Hello",
      },
      finish_reason: null,
    };
    const response: OcGoStreamResponse = {
      id: "stream_123",
      object: "chat.completion.chunk",
      created: Date.now(),
      model: "glm-5",
      choices: [choice],
    };
    expect(response.object).toBe("chat.completion.chunk");
    expect(response.choices[0].delta.content).toBe("Hello");
  });

  it("should include reasoning_content in delta", () => {
    const choice: OcGoStreamChoice = {
      index: 0,
      delta: {
        role: "assistant",
        content: "Answer",
        reasoning_content: "Thinking process here",
      },
      finish_reason: null,
    };
    const response: OcGoStreamResponse = {
      id: "stream_456",
      object: "chat.completion.chunk",
      created: Date.now(),
      model: "glm-5",
      choices: [choice],
    };
    expect(response.choices[0].delta.reasoning_content).toBeDefined();
  });
});

describe("OC_GO_MODELS", () => {
  it("should have at least one model defined", () => {
    expect(OC_GO_MODELS.length).toBeGreaterThan(0);
  });

  it("should have GLM-5 model", () => {
    const model = OC_GO_MODELS.find((m) => m.id === "glm-5");
    expect(model).toBeDefined();
    expect(model?.name).toBe("GLM-5");
    expect(model?.supportsTools).toBe(true);
    expect(model?.supportsVision).toBe(false);
    expect(model?.contextWindow).toBe(202752);
    expect(model?.maxOutput).toBe(131072);
  });

  it("should have Kimi K2.5 model", () => {
    const model = OC_GO_MODELS.find((m) => m.id === "kimi-k2.5");
    expect(model).toBeDefined();
    expect(model?.name).toBe("Kimi K2.5");
    expect(model?.contextWindow).toBe(262144);
    expect(model?.maxOutput).toBe(65536);
  });

  it("should have MiMo-V2-Omni vision model", () => {
    const model = OC_GO_MODELS.find((m) => m.id === "mimo-v2-omni");
    expect(model).toBeDefined();
    expect(model?.name).toBe("MiMo-V2-Omni");
    expect(model?.supportsVision).toBe(true);
    expect(model?.contextWindow).toBe(262144);
    expect(model?.maxOutput).toBe(65536);
  });

  it("should have MiniMax M2.5 model with Anthropic API format", () => {
    const model = OC_GO_MODELS.find((m) => m.id === "minimax-m2.5");
    expect(model).toBeDefined();
    expect(model?.name).toBe("MiniMax M2.5");
    expect(model?.supportsVision).toBe(false);
    expect(model?.apiFormat).toBe("anthropic");
    expect(model?.contextWindow).toBe(196608);
    expect(model?.maxOutput).toBe(131072);
  });

  it("should have MiniMax M2.7 model with Anthropic API format", () => {
    const model = OC_GO_MODELS.find((m) => m.id === "minimax-m2.7");
    expect(model).toBeDefined();
    expect(model?.name).toBe("MiniMax M2.7");
    expect(model?.supportsVision).toBe(false);
    expect(model?.apiFormat).toBe("anthropic");
    expect(model?.contextWindow).toBe(196608);
    expect(model?.maxOutput).toBe(131072);
  });

  it("should have Qwen3.5 Plus model with OpenAI API format", () => {
    const model = OC_GO_MODELS.find((m) => m.id === "qwen3.5-plus");
    expect(model).toBeDefined();
    expect(model?.name).toBe("Qwen3.5 Plus");
    expect(model?.supportsVision).toBe(true);
    expect(model?.apiFormat).toBe("openai");
    expect(model?.contextWindow).toBe(1000000);
    expect(model?.maxOutput).toBe(65536);
  });

  it("should have Qwen3.6 Plus model with OpenAI API format", () => {
    const model = OC_GO_MODELS.find((m) => m.id === "qwen3.6-plus");
    expect(model).toBeDefined();
    expect(model?.name).toBe("Qwen3.6 Plus");
    expect(model?.supportsVision).toBe(true);
    expect(model?.apiFormat).toBe("openai");
    expect(model?.contextWindow).toBe(1000000);
    expect(model?.maxOutput).toBe(65536);
  });

  it("should have OpenAI format for non-MiniMax models", () => {
    const openaiModels = OC_GO_MODELS.filter(
      (m) => m.id !== "minimax-m2.5" && m.id !== "minimax-m2.7"
    );
    openaiModels.forEach((model) => {
      expect(model.apiFormat).toBe("openai");
    });
  });

  it("should all models have required fields", () => {
    OC_GO_MODELS.forEach((model) => {
      expect(model.id).toBeDefined();
      expect(typeof model.id).toBe("string");
      expect(model.name).toBeDefined();
      expect(model.displayName).toBeDefined();
      expect(model.contextWindow).toBeGreaterThan(0);
      expect(model.maxOutput).toBeGreaterThan(0);
    });
  });

  it("should all models have unique IDs", () => {
    const ids = OC_GO_MODELS.map((m) => m.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});

describe("OcGoRequestBody", () => {
  it("should support stream_options with include_usage", () => {
    const body: OcGoRequestBody = {
      model: "glm-5",
      messages: [],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 4096,
    };
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("should allow stream_options to be omitted", () => {
    const body: OcGoRequestBody = {
      model: "glm-5",
      messages: [],
      stream: true,
    };
    expect(body.stream_options).toBeUndefined();
  });
});

describe("OcGoStreamResponse with usage", () => {
  it("should parse usage from final streaming chunk", () => {
    const response: OcGoStreamResponse = {
      id: "chatcmpl-123",
      object: "chat.completion.chunk",
      created: 1234567890,
      model: "glm-5",
      choices: [],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      },
    };
    expect(response.usage).toBeDefined();
    expect(response.usage!.prompt_tokens).toBe(100);
    expect(response.usage!.completion_tokens).toBe(50);
    expect(response.choices).toHaveLength(0);
  });

  it("should handle chunk without usage", () => {
    const response: OcGoStreamResponse = {
      id: "chatcmpl-123",
      object: "chat.completion.chunk",
      created: 1234567890,
      model: "glm-5",
      choices: [
        {
          index: 0,
          delta: { content: "Hello" },
          finish_reason: null,
        },
      ],
    };
    expect(response.usage).toBeUndefined();
  });
});
