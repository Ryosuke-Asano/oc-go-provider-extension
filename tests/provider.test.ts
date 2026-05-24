/// <reference types="jest" />

import * as vscode from "vscode";

import { OcGoChatModelProvider } from "../src/provider";
import { secrets } from "../__mocks__/vscode";

function createDoneStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n"));
      controller.close();
    },
  });
}

function createToken(): vscode.CancellationToken {
  return {
    isCancellationRequested: false,
    onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
  } as unknown as vscode.CancellationToken;
}

describe("OcGoChatModelProvider", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (secrets.get as jest.Mock).mockResolvedValue("test-api-key");
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((_key: string, defaultValue: unknown) => defaultValue),
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      body: createDoneStream(),
    });
  });

  it("should expose the full context window as maxInputTokens", async () => {
    const provider = new OcGoChatModelProvider(
      secrets as unknown as vscode.SecretStorage,
      "jest-agent"
    );

    const models = await provider.provideLanguageModelChatInformation(
      { silent: true } as vscode.PrepareLanguageModelChatModelOptions,
      createToken()
    );

    const glm5 = models.find((m) => m.id === "opencode-go-glm-5");
    expect(glm5).toBeDefined();
    expect(glm5?.maxInputTokens).toBe(202752 - Math.min(131072, 65536));
    expect(glm5?.maxOutputTokens).toBe(131072);
  });

  it("should allow prompts larger than the old reserved-output cap", async () => {
    const provider = new OcGoChatModelProvider(
      secrets as unknown as vscode.SecretStorage,
      "jest-agent"
    );
    const models = await provider.provideLanguageModelChatInformation(
      { silent: true } as vscode.PrepareLanguageModelChatModelOptions,
      createToken()
    );
    const glm5 = models.find((m) => m.id === "opencode-go-glm-5");
    if (!glm5) {
      throw new Error("opencode-go-glm-5 not found");
    }

    const largePrompt = "a".repeat(72000 * 4);
    const messages = [vscode.LanguageModelChatMessage.User(largePrompt)];
    const progress = {
      report: jest.fn(),
    } as unknown as vscode.Progress<vscode.LanguageModelResponsePart>;

    await expect(
      provider.provideLanguageModelChatResponse(
        glm5,
        messages,
        {},
        progress,
        createToken()
      )
    ).resolves.toBeUndefined();

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("should use the official default max_tokens when not specified", async () => {
    const provider = new OcGoChatModelProvider(
      secrets as unknown as vscode.SecretStorage,
      "jest-agent"
    );
    const models = await provider.provideLanguageModelChatInformation(
      { silent: true } as vscode.PrepareLanguageModelChatModelOptions,
      createToken()
    );
    const kimiK25 = models.find((m) => m.id === "opencode-go-kimi-k2.5");
    if (!kimiK25) {
      throw new Error("kimi-k2.5 not found");
    }

    const messages = [vscode.LanguageModelChatMessage.User("hello")];
    const progress = {
      report: jest.fn(),
    } as unknown as vscode.Progress<vscode.LanguageModelResponsePart>;

    await provider.provideLanguageModelChatResponse(
      kimiK25,
      messages,
      {},
      progress,
      createToken()
    );

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const requestInit = (global.fetch as jest.Mock).mock.calls[0]?.[1] as {
      body?: string;
    };
    expect(requestInit.body).toBeDefined();
    const requestBody = JSON.parse(requestInit.body ?? "{}");
    expect(requestBody.max_tokens).toBe(65536);
  });

  it("should reject prompts that exceed the documented context window", async () => {
    const provider = new OcGoChatModelProvider(
      secrets as unknown as vscode.SecretStorage,
      "jest-agent"
    );
    const models = await provider.provideLanguageModelChatInformation(
      { silent: true } as vscode.PrepareLanguageModelChatModelOptions,
      createToken()
    );
    const kimiK25 = models.find((m) => m.id === "opencode-go-kimi-k2.5");
    if (!kimiK25) {
      throw new Error("kimi-k2.5 not found");
    }

    const tooLargePrompt = "a".repeat(263000 * 4);
    const messages = [vscode.LanguageModelChatMessage.User(tooLargePrompt)];
    const progress = {
      report: jest.fn(),
    } as unknown as vscode.Progress<vscode.LanguageModelResponsePart>;

    await expect(
      provider.provideLanguageModelChatResponse(
        kimiK25,
        messages,
        {},
        progress,
        createToken()
      )
    ).rejects.toThrow("Message exceeds token limit");

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("should count tokens for text data parts in provideTokenCount", async () => {
    const provider = new OcGoChatModelProvider(
      secrets as unknown as vscode.SecretStorage,
      "jest-agent"
    );
    const models = await provider.provideLanguageModelChatInformation(
      { silent: true } as vscode.PrepareLanguageModelChatModelOptions,
      createToken()
    );
    const glm5 = models.find((m) => m.id === "opencode-go-glm-5");
    if (!glm5) {
      throw new Error("glm-5 not found");
    }

    const text = "text from LanguageModelDataPart";
    const message = vscode.LanguageModelChatMessage.User([
      vscode.LanguageModelDataPart.text(text),
    ]);

    const count = await provider.provideTokenCount(
      glm5,
      message,
      createToken()
    );
    expect(count).toBe(Math.ceil(text.length / 2));
  });

  it("should attach configurationSchema to reasoning base models", async () => {
    const provider = new OcGoChatModelProvider(
      secrets as unknown as vscode.SecretStorage,
      "jest-agent"
    );
    const models = await provider.provideLanguageModelChatInformation(
      { silent: true } as vscode.PrepareLanguageModelChatModelOptions,
      createToken()
    );

    const deepseek = models.find((m) => m.id === "opencode-go-deepseek-v4-pro");
    expect(deepseek).toBeDefined();
    expect((deepseek as any).configurationSchema).toBeDefined();
    expect((deepseek as any).isUserSelectable).toBe(true);
    expect((deepseek as any).configurationSchema.properties.thinking_effort.enum).toEqual(
      ["high", "max", "none"]
    );

    // Kimi/GLM: no configurationSchema — APIs ignore disabled toggle
    const kimi = models.find((m) => m.id === "opencode-go-kimi-k2.5");
    expect(kimi).toBeDefined();
    expect((kimi as any).configurationSchema).toBeUndefined();

    // Non-reasoning models should NOT have configurationSchema
    const minimax = models.find((m) => m.id === "opencode-go-minimax-m2.5");
    expect(minimax).toBeDefined();
    expect((minimax as any).configurationSchema).toBeUndefined();
    expect((minimax as any).isUserSelectable).toBe(true);
  });

  it("should inject reasoning_effort via modelConfiguration for DeepSeek", async () => {
    const provider = new OcGoChatModelProvider(
      secrets as unknown as vscode.SecretStorage,
      "jest-agent"
    );
    const models = await provider.provideLanguageModelChatInformation(
      { silent: true } as vscode.PrepareLanguageModelChatModelOptions,
      createToken()
    );
    const deepseek = models.find((m) => m.id === "opencode-go-deepseek-v4-pro");
    if (!deepseek) {
      throw new Error("deepseek-v4-pro not found");
    }

    const messages = [vscode.LanguageModelChatMessage.User("hello")];
    const progress = {
      report: jest.fn(),
    } as unknown as vscode.Progress<vscode.LanguageModelResponsePart>;

    await provider.provideLanguageModelChatResponse(
      deepseek,
      messages,
      {
        modelConfiguration: { thinking_effort: "high" },
      } as any,
      progress,
      createToken()
    );

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const requestInit = (global.fetch as jest.Mock).mock.calls[0]?.[1] as {
      body?: string;
    };
    expect(requestInit.body).toBeDefined();
    const requestBody = JSON.parse(requestInit.body ?? "{}");
    expect(requestBody.model).toBe("deepseek-v4-pro");
    expect(requestBody.reasoning_effort).toBe("high");
  });

  it("should inject chat_template_kwargs via modelConfiguration for MiMo (was Kimi)", async () => {
    const provider = new OcGoChatModelProvider(
      secrets as unknown as vscode.SecretStorage,
      "jest-agent"
    );
    const models = await provider.provideLanguageModelChatInformation(
      { silent: true } as vscode.PrepareLanguageModelChatModelOptions,
      createToken()
    );
    const mimo = models.find((m) => m.id === "opencode-go-mimo-v2-pro");
    if (!mimo) {
      throw new Error("mimo-v2-pro not found");
    }

    const messages = [vscode.LanguageModelChatMessage.User("hello")];
    const progress = {
      report: jest.fn(),
    } as unknown as vscode.Progress<vscode.LanguageModelResponsePart>;

    await provider.provideLanguageModelChatResponse(
      mimo,
      messages,
      {
        modelConfiguration: { thinking_effort: "on" },
      } as any,
      progress,
      createToken()
    );

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const requestInit = (global.fetch as jest.Mock).mock.calls[0]?.[1] as {
      body?: string;
    };
    expect(requestInit.body).toBeDefined();
    const requestBody = JSON.parse(requestInit.body ?? "{}");
    expect(requestBody.model).toBe("mimo-v2-pro");
    expect(requestBody.chat_template_kwargs).toEqual({ enable_thinking: true });
  });

  it("should inject chat_template_kwargs for MiMo when thinking enabled", async () => {
    const provider = new OcGoChatModelProvider(
      secrets as unknown as vscode.SecretStorage,
      "jest-agent"
    );
    const models = await provider.provideLanguageModelChatInformation(
      { silent: true } as vscode.PrepareLanguageModelChatModelOptions,
      createToken()
    );
    const mimo = models.find((m) => m.id === "opencode-go-mimo-v2-pro");
    if (!mimo) {
      throw new Error("mimo-v2-pro not found");
    }

    const messages = [vscode.LanguageModelChatMessage.User("hello")];
    const progress = {
      report: jest.fn(),
    } as unknown as vscode.Progress<vscode.LanguageModelResponsePart>;

    await provider.provideLanguageModelChatResponse(
      mimo,
      messages,
      {
        modelConfiguration: { thinking_effort: "on" },
      } as any,
      progress,
      createToken()
    );

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const requestInit = (global.fetch as jest.Mock).mock.calls[0]?.[1] as {
      body?: string;
    };
    expect(requestInit.body).toBeDefined();
    const requestBody = JSON.parse(requestInit.body ?? "{}");
    expect(requestBody.model).toBe("mimo-v2-pro");
    expect(requestBody.chat_template_kwargs).toEqual({
      enable_thinking: true,
    });
    expect(requestBody.thinking).toBeUndefined();
  });

  it("should inject both reasoning_effort AND thinking for DeepSeek high", async () => {
    const provider = new OcGoChatModelProvider(
      secrets as unknown as vscode.SecretStorage,
      "jest-agent"
    );
    const models = await provider.provideLanguageModelChatInformation(
      { silent: true } as vscode.PrepareLanguageModelChatModelOptions,
      createToken()
    );
    const deepseek = models.find((m) => m.id === "opencode-go-deepseek-v4-pro");
    if (!deepseek) {
      throw new Error("deepseek-v4-pro not found");
    }

    const messages = [vscode.LanguageModelChatMessage.User("hello")];
    const progress = {
      report: jest.fn(),
    } as unknown as vscode.Progress<vscode.LanguageModelResponsePart>;

    await provider.provideLanguageModelChatResponse(
      deepseek,
      messages,
      {
        modelConfiguration: { thinking_effort: "high" },
      } as any,
      progress,
      createToken()
    );

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const requestInit = (global.fetch as jest.Mock).mock.calls[0]?.[1] as {
      body?: string;
    };
    expect(requestInit.body).toBeDefined();
    const requestBody = JSON.parse(requestInit.body ?? "{}");
    expect(requestBody.model).toBe("deepseek-v4-pro");
    expect(requestBody.reasoning_effort).toBe("high");
    expect(requestBody.thinking).toEqual({ type: "enabled" });
  });

  it("should emit reasoning via LanguageModelThinkingPart when supported", () => {
    const provider = new OcGoChatModelProvider(
      secrets as unknown as vscode.SecretStorage,
      "jest-agent"
    );
    const progress = {
      report: jest.fn(),
    } as unknown as vscode.Progress<vscode.LanguageModelResponsePart>;

    (provider as unknown as { _reasoningContentBuffer: string })._reasoningContentBuffer =
      "Reasoning to preserve";

    (provider as any).reportReasoningContent(progress);

    expect(progress.report).toHaveBeenCalledTimes(1);
    const reported = (progress.report as jest.Mock).mock.calls[0][0];
    expect(reported).toBeInstanceOf(vscode.LanguageModelThinkingPart);
    expect((reported as vscode.LanguageModelThinkingPart).value).toBe(
      "Reasoning to preserve"
    );
  });

  it("should route non-vision image analysis through the configured vision proxy model", async () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((key: string, defaultValue: unknown) =>
        key === "visionProxyModel" ? "qwen3.6-plus" : defaultValue
      ),
    });

    const provider = new OcGoChatModelProvider(
      secrets as unknown as vscode.SecretStorage,
      "jest-agent"
    );
    provider.updateModelList([
      {
        id: "text-only-test",
        name: "Text Only Test",
        displayName: "Text Only Test",
        contextWindow: 8192,
        maxOutput: 2048,
        supportsTools: true,
        supportsVision: false,
        supportsReasoning: false,
        apiFormat: "openai",
      },
    ]);

    const analyzeImage = jest.fn().mockResolvedValue(
      "Proxy-generated image description"
    );
    (provider as any)._mcpClient = {
      analyzeImage,
    };

    const model = {
      id: "opencode-go-text-only-test",
      name: "Text Only Test",
      detail: "OpenCode Go",
      tooltip: "OpenCode Go Text Only Test",
      family: "opencode-go",
      version: "1.0.0",
      isUserSelectable: true,
      maxInputTokens: 6144,
      maxOutputTokens: 2048,
      capabilities: {
        toolCalling: true,
        imageInput: false,
      },
    } as vscode.LanguageModelChatInformation;

    const imagePart = new vscode.LanguageModelDataPart(
      new Uint8Array([1, 2, 3, 4]),
      "image/png"
    );
    const messages = [
      vscode.LanguageModelChatMessage.User([
        new vscode.LanguageModelTextPart("Describe the image"),
        imagePart,
      ]),
    ];
    const progress = {
      report: jest.fn(),
    } as unknown as vscode.Progress<vscode.LanguageModelResponsePart>;

    await provider.provideLanguageModelChatResponse(
      model,
      messages,
      {},
      progress,
      createToken()
    );

    expect(analyzeImage).toHaveBeenCalledTimes(1);
    expect(analyzeImage).toHaveBeenCalledWith(
      expect.stringMatching(/^data:image\/png;base64,/),
      "Describe the image",
      "qwen3.6-plus"
    );
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const requestInit = (global.fetch as jest.Mock).mock.calls[0]?.[1] as {
      body?: string;
    };
    const requestBody = JSON.parse(requestInit.body ?? "{}");
    expect(requestBody.messages[0].content).toContain(
      "Proxy-generated image description"
    );
  });

  it("should reject when the configured vision proxy model is not vision-capable", async () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((key: string, defaultValue: unknown) =>
        key === "visionProxyModel" ? "text-only-test" : defaultValue
      ),
    });

    const provider = new OcGoChatModelProvider(
      secrets as unknown as vscode.SecretStorage,
      "jest-agent"
    );
    provider.updateModelList([
      {
        id: "text-only-test",
        name: "Text Only Test",
        displayName: "Text Only Test",
        contextWindow: 8192,
        maxOutput: 2048,
        supportsTools: true,
        supportsVision: false,
        supportsReasoning: false,
        apiFormat: "openai",
      },
    ]);

    const model = {
      id: "opencode-go-text-only-test",
      name: "Text Only Test",
      detail: "OpenCode Go",
      tooltip: "OpenCode Go Text Only Test",
      family: "opencode-go",
      version: "1.0.0",
      isUserSelectable: true,
      maxInputTokens: 6144,
      maxOutputTokens: 2048,
      capabilities: {
        toolCalling: true,
        imageInput: false,
      },
    } as vscode.LanguageModelChatInformation;

    const imagePart = new vscode.LanguageModelDataPart(
      new Uint8Array([1, 2, 3, 4]),
      "image/png"
    );
    const messages = [
      vscode.LanguageModelChatMessage.User([
        new vscode.LanguageModelTextPart("Describe the image"),
        imagePart,
      ]),
    ];
    const progress = {
      report: jest.fn(),
    } as unknown as vscode.Progress<vscode.LanguageModelResponsePart>;

    await expect(
      provider.provideLanguageModelChatResponse(
        model,
        messages,
        {},
        progress,
        createToken()
      )
    ).rejects.toThrow(
      'Configured vision proxy model "text-only-test" does not support vision'
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

});

describe("restoreConversation (compaction handling)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (secrets.get as jest.Mock).mockResolvedValue("test-api-key");
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      body: createDoneStream(),
    });
  });

  function makeUserMsg(text: string): vscode.LanguageModelChatMessage {
    return vscode.LanguageModelChatMessage.User(text);
  }

  it("should NOT modify messages when there is no compaction marker", async () => {
    const provider = new OcGoChatModelProvider(
      secrets as unknown as vscode.SecretStorage,
      "jest-agent"
    );
    const models = await provider.provideLanguageModelChatInformation(
      { silent: true } as vscode.PrepareLanguageModelChatModelOptions,
      createToken()
    );
    const glm5 = models.find((m) => m.id === "opencode-go-glm-5")!;
    const progress = {
      report: jest.fn(),
    } as unknown as vscode.Progress<vscode.LanguageModelResponsePart>;

    const messages = [
      makeUserMsg("Hello, how are you?"),
      vscode.LanguageModelChatMessage.Assistant([
        new vscode.LanguageModelTextPart("I'm doing great, thanks!"),
      ]),
      makeUserMsg("What can you help with?"),
    ];

    await provider.provideLanguageModelChatResponse(
      glm5,
      messages,
      {},
      progress,
      createToken()
    );

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const reqBody = JSON.parse(
      (global.fetch as jest.Mock).mock.calls[0][1]?.body as string ?? "{}"
    );
    expect(reqBody.messages).toHaveLength(3);
    expect(reqBody.messages[0].role).toBe("user");
    expect(reqBody.messages[0].content).toContain("Hello, how are you?");
  });

  it("should use summary text when transcript file is unreadable", async () => {
    const provider = new OcGoChatModelProvider(
      secrets as unknown as vscode.SecretStorage,
      "jest-agent"
    );
    const models = await provider.provideLanguageModelChatInformation(
      { silent: true } as vscode.PrepareLanguageModelChatModelOptions,
      createToken()
    );
    const glm5 = models.find((m) => m.id === "opencode-go-glm-5")!;
    const progress = {
      report: jest.fn(),
    } as unknown as vscode.Progress<vscode.LanguageModelResponsePart>;

    const compactionMsg =
      "[Compacted 42 earlier messages — summary: " +
      "This session involved implementing a VS Code extension for OpenCode Go. " +
      "We fixed the Zen vendor registration, added compaction handling, and built the VSIX. " +
      "Current state: Extension is working with both Go and Zen providers." +
      "] If you need specific details from before compaction (such as exact code snippets), " +
      'use the ReadFile tool to look up the full uncompacted conversation transcript at: "/fake/path/transcript.jsonl"';

    const messages = [
      makeUserMsg(compactionMsg),
      makeUserMsg("Continue from where we left off"),
    ];

    // Make transcript read fail
    (vscode.workspace.fs.readFile as jest.Mock).mockRejectedValueOnce(
      new Error("file not found")
    );

    await provider.provideLanguageModelChatResponse(
      glm5,
      messages,
      {},
      progress,
      createToken()
    );

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const reqBody = JSON.parse(
      (global.fetch as jest.Mock).mock.calls[0][1]?.body as string ?? "{}"
    );
    // Should have 2 messages: summary + current input
    expect(reqBody.messages).toHaveLength(2);
    expect(reqBody.messages[0].role).toBe("user");
    // Summary text should be in the first message
    expect(reqBody.messages[0].content).toContain("This session involved implementing a VS Code extension");
    expect(reqBody.messages[0].content).not.toContain("[Compacted");
    expect(reqBody.messages[0].content).not.toContain("If you need specific details");
    expect(reqBody.messages[1].content).toBe("Continue from where we left off");
  });

  it("should prefer transcript over summary when transcript is readable", async () => {
    const provider = new OcGoChatModelProvider(
      secrets as unknown as vscode.SecretStorage,
      "jest-agent"
    );
    const models = await provider.provideLanguageModelChatInformation(
      { silent: true } as vscode.PrepareLanguageModelChatModelOptions,
      createToken()
    );
    const glm5 = models.find((m) => m.id === "opencode-go-glm-5")!;
    const progress = {
      report: jest.fn(),
    } as unknown as vscode.Progress<vscode.LanguageModelResponsePart>;

    const compactionMsg =
      "[Compacted 50 earlier messages — summary: We were working on token budget handling.] " +
      'Use ReadFile tool to look up the full transcript at: "/some/path/abc.jsonl"';

    const messages = [
      makeUserMsg(compactionMsg),
      makeUserMsg("What was the last thing we discussed?"),
    ];

    // Mock transcript content with 2 rounds
    const line1 = JSON.stringify({ userMessage: "First question about the codebase" });
    const line2 = JSON.stringify({
      userMessage: "Second question about compaction",
      rounds: [{ response: "Here is how compaction works" }],
    });
    const transcriptBytes = new TextEncoder().encode(`${line1}\n${line2}\n`);
    (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValueOnce(transcriptBytes);

    await provider.provideLanguageModelChatResponse(
      glm5,
      messages,
      {},
      progress,
      createToken()
    );

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const reqBody = JSON.parse(
      (global.fetch as jest.Mock).mock.calls[0][1]?.body as string ?? "{}"
    );
    // Transcript has 2 user messages (first line) + 1 assistant (second line rounds[0].response)
    expect(reqBody.messages.length).toBeGreaterThanOrEqual(2);
    // Current input should NOT be duplicated if already in transcript
    // The second user message "What was the last thing..." should be appended
    // since it doesn't appear in the transcript content
    const lastMsg = reqBody.messages[reqBody.messages.length - 1];
    expect(lastMsg.content).toBe("What was the last thing we discussed?");
  });

  it("should deduplicate current input when it is already in summary", async () => {
    const provider = new OcGoChatModelProvider(
      secrets as unknown as vscode.SecretStorage,
      "jest-agent"
    );
    const models = await provider.provideLanguageModelChatInformation(
      { silent: true } as vscode.PrepareLanguageModelChatModelOptions,
      createToken()
    );
    const glm5 = models.find((m) => m.id === "opencode-go-glm-5")!;
    const progress = {
      report: jest.fn(),
    } as unknown as vscode.Progress<vscode.LanguageModelResponsePart>;

    // Summary already contains the current input text
    const currentInput = "What were we doing with the extension?";
    const compactionMsg =
      "[Compacted 10 messages — summary: We were fixing the OpenCode Go extension. " +
      "The last thing we discussed was: What were we doing with the extension? " +
      "Answer: Adding compaction handling for third-party providers.] " +
      'Use ReadFile at: "/path/to/transcript.jsonl"';

    const messages = [makeUserMsg(compactionMsg), makeUserMsg(currentInput)];

    // Transcript unavailable — fallback to summary
    (vscode.workspace.fs.readFile as jest.Mock).mockRejectedValueOnce(
      new Error("not found")
    );

    await provider.provideLanguageModelChatResponse(
      glm5,
      messages,
      {},
      progress,
      createToken()
    );

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const reqBody = JSON.parse(
      (global.fetch as jest.Mock).mock.calls[0][1]?.body as string ?? "{}"
    );
    // Should have only 1 message — summary already has current input
    expect(reqBody.messages).toHaveLength(1);
    expect(reqBody.messages[0].content).toContain("We were fixing the OpenCode Go extension");
  });

  it("should NOT modify non-user first message (no compaction)", async () => {
    const provider = new OcGoChatModelProvider(
      secrets as unknown as vscode.SecretStorage,
      "jest-agent"
    );
    const models = await provider.provideLanguageModelChatInformation(
      { silent: true } as vscode.PrepareLanguageModelChatModelOptions,
      createToken()
    );
    const glm5 = models.find((m) => m.id === "opencode-go-glm-5")!;
    const progress = {
      report: jest.fn(),
    } as unknown as vscode.Progress<vscode.LanguageModelResponsePart>;

    // First message is assistant — not a compaction marker
    const messages = [
      vscode.LanguageModelChatMessage.Assistant([
        new vscode.LanguageModelTextPart("System initialized"),
      ]),
      makeUserMsg("Hello"),
    ];

    await provider.provideLanguageModelChatResponse(
      glm5,
      messages,
      {},
      progress,
      createToken()
    );

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const reqBody = JSON.parse(
      (global.fetch as jest.Mock).mock.calls[0][1]?.body as string ?? "{}"
    );
    expect(reqBody.messages).toHaveLength(2);
  });

  it("should pass through normal conversation when there is no compaction at all", async () => {
    const provider = new OcGoChatModelProvider(
      secrets as unknown as vscode.SecretStorage,
      "jest-agent"
    );
    const models = await provider.provideLanguageModelChatInformation(
      { silent: true } as vscode.PrepareLanguageModelChatModelOptions,
      createToken()
    );
    const glm5 = models.find((m) => m.id === "opencode-go-glm-5")!;
    const progress = {
      report: jest.fn(),
    } as unknown as vscode.Progress<vscode.LanguageModelResponsePart>;

    const messages = [
      makeUserMsg("Read the codebase"),
      vscode.LanguageModelChatMessage.Assistant([
        new vscode.LanguageModelTextPart("I read the codebase and found 3 main components."),
      ]),
      makeUserMsg("What is component A?"),
      vscode.LanguageModelChatMessage.Assistant([
        new vscode.LanguageModelTextPart("Component A is the main entry point."),
      ]),
      makeUserMsg("Explain component B"),
    ];

    await provider.provideLanguageModelChatResponse(
      glm5,
      messages,
      {},
      progress,
      createToken()
    );

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const reqBody = JSON.parse(
      (global.fetch as jest.Mock).mock.calls[0][1]?.body as string ?? "{}"
    );
    expect(reqBody.messages).toHaveLength(5);
    expect(reqBody.messages[0].role).toBe("user");
    expect(reqBody.messages[0].content).toBe("Read the codebase");
  });
});
