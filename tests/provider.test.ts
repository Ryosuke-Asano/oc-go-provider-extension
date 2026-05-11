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

    const glm5 = models.find((m) => m.id === "glm-5");
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
    const glm5 = models.find((m) => m.id === "glm-5");
    if (!glm5) {
      throw new Error("glm-5 not found");
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
    const kimiK25 = models.find((m) => m.id === "kimi-k2.5");
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
    const kimiK25 = models.find((m) => m.id === "kimi-k2.5");
    if (!kimiK25) {
      throw new Error("kimi-k2.5 not found");
    }

    const tooLargePrompt = "a".repeat(131073 * 4);
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
    ).rejects.toThrow("Message exceeds token limit.");

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
    const glm5 = models.find((m) => m.id === "glm-5");
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

    const deepseek = models.find((m) => m.id === "deepseek-v4-pro");
    expect(deepseek).toBeDefined();
    expect((deepseek as any).configurationSchema).toBeDefined();
    expect((deepseek as any).configurationSchema.properties.thinking_effort.enum).toEqual(
      ["high", "max", "none"]
    );

    // Kimi/GLM: no configurationSchema — APIs ignore disabled toggle
    const kimi = models.find((m) => m.id === "kimi-k2.5");
    expect(kimi).toBeDefined();
    expect((kimi as any).configurationSchema).toBeUndefined();

    // Non-reasoning models should NOT have configurationSchema
    const minimax = models.find((m) => m.id === "minimax-m2.5");
    expect(minimax).toBeDefined();
    expect((minimax as any).configurationSchema).toBeUndefined();
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
    const deepseek = models.find((m) => m.id === "deepseek-v4-pro");
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
    const mimo = models.find((m) => m.id === "mimo-v2-pro");
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
    const mimo = models.find((m) => m.id === "mimo-v2-pro");
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
    const deepseek = models.find((m) => m.id === "deepseek-v4-pro");
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
});
