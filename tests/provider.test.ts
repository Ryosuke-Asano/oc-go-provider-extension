/// <reference types="jest" />

import * as vscode from "vscode";
import * as path from "path";

import { OcGoChatModelProvider, getSecretScanConfig } from "../src/provider";
import { secrets } from "../__mocks__/vscode";
import { secretScanLog } from "../src/secretScanLog";
import * as secretScan from "../src/secretScan";

interface SseEventFixture {
  [key: string]: unknown;
}

function createDoneStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n"));
      controller.close();
    },
  });
}

function createSseStream(
  events: readonly SseEventFixture[]
): ReadableStream<Uint8Array> {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n`).join("\n")}\ndata: [DONE]\n`;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
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

  it("should expose GPT 5.6 Luna as a user-selectable model", async () => {
    const provider = new OcGoChatModelProvider(
      secrets as unknown as vscode.SecretStorage,
      "jest-agent"
    );

    const models = await provider.provideLanguageModelChatInformation(
      { silent: true } as vscode.PrepareLanguageModelChatModelOptions,
      createToken()
    );

    const luna = models.find((m) => m.id === "gpt-5.6-luna");
    expect(luna).toBeDefined();
    expect(luna?.name).toBe("GPT 5.6 Luna");
    expect(luna?.isUserSelectable).toBe(true);
    expect(luna?.maxInputTokens).toBe(272000 - 65536);
    expect(luna?.maxOutputTokens).toBe(65536);
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

  it("should send a stable OpenCode session header for a conversation", async () => {
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

    const messages = [vscode.LanguageModelChatMessage.User("hello")];
    const progress = {
      report: jest.fn(),
    } as unknown as vscode.Progress<vscode.LanguageModelResponsePart>;

    await provider.provideLanguageModelChatResponse(
      glm5,
      messages,
      {},
      progress,
      createToken()
    );
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      body: createDoneStream(),
    });
    await provider.provideLanguageModelChatResponse(
      glm5,
      messages,
      {},
      progress,
      createToken()
    );

    const calls = (global.fetch as jest.Mock).mock.calls.filter(
      (call: unknown[]) =>
        typeof call[1] === "object" &&
        call[1] !== null &&
        "body" in (call[1] as object)
    );
    const firstHeaders = calls[0]?.[1]?.headers as Record<string, string>;
    const secondHeaders = calls[1]?.[1]?.headers as Record<string, string>;
    expect(firstHeaders["x-opencode-session"]).toMatch(/^vscode-[a-f0-9]{64}$/);
    expect(secondHeaders["x-opencode-session"]).toBe(
      firstHeaders["x-opencode-session"]
    );
  }, 15000);

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

  it("reports OpenCode usage with Copilot's native usage MIME type", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      body: createSseStream([
        {
          choices: [],
          usage: {
            prompt_tokens: 1234,
            completion_tokens: 56,
          },
        },
      ]),
    });
    const provider = new OcGoChatModelProvider(
      secrets as unknown as vscode.SecretStorage,
      "jest-agent"
    );
    const models = await provider.provideLanguageModelChatInformation(
      { silent: true } as vscode.PrepareLanguageModelChatModelOptions,
      createToken()
    );
    const glm5 = models.find((model) => model.id === "glm-5");
    if (!glm5) throw new Error("glm-5 not found");
    const progress = {
      report: jest.fn(),
    } as unknown as vscode.Progress<vscode.LanguageModelResponsePart>;

    await provider.provideLanguageModelChatResponse(
      glm5,
      [vscode.LanguageModelChatMessage.User("hello")],
      {},
      progress,
      createToken()
    );

    const usagePart = (progress.report as jest.Mock).mock.calls
      .map(([part]) => part)
      .find((part) => part instanceof vscode.LanguageModelDataPart);
    if (!usagePart) throw new Error("usage part not reported");
    expect(usagePart.mimeType).toBe("usage");
    expect(JSON.parse(new TextDecoder().decode(usagePart.data))).toEqual({
      type: "usage",
      prompt_tokens: 1234,
      completion_tokens: 56,
      total_tokens: 1290,
    });
  });

  it("reports usage from Anthropic message events", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      body: createSseStream([
        {
          type: "message_start",
          message: {
            id: "message-id",
            type: "message",
            role: "assistant",
            content: [],
            model: "minimax-m2.5",
            stop_reason: null,
            usage: { input_tokens: 800, output_tokens: 0 },
          },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 75 },
        },
        { type: "message_stop" },
      ]),
    });
    const provider = new OcGoChatModelProvider(
      secrets as unknown as vscode.SecretStorage,
      "jest-agent"
    );
    const models = await provider.provideLanguageModelChatInformation(
      { silent: true } as vscode.PrepareLanguageModelChatModelOptions,
      createToken()
    );
    const minimax = models.find((model) => model.id === "minimax-m2.5");
    if (!minimax) throw new Error("minimax-m2.5 not found");
    const progress = {
      report: jest.fn(),
    } as unknown as vscode.Progress<vscode.LanguageModelResponsePart>;

    await provider.provideLanguageModelChatResponse(
      minimax,
      [vscode.LanguageModelChatMessage.User("hello")],
      {},
      progress,
      createToken()
    );

    const usagePart = (progress.report as jest.Mock).mock.calls
      .map(([part]) => part)
      .find((part) => part instanceof vscode.LanguageModelDataPart);
    if (!usagePart) throw new Error("usage part not reported");
    expect(JSON.parse(new TextDecoder().decode(usagePart.data))).toMatchObject({
      prompt_tokens: 800,
      completion_tokens: 75,
      total_tokens: 875,
    });
  });
});

describe("secretScan live toggle (off stops redaction without restart)", () => {
  let currentSecretScan: string;

  beforeEach(() => {
    jest.clearAllMocks();
    currentSecretScan = "redact";
    (secrets.get as jest.Mock).mockResolvedValue("test-api-key");
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((key: string, defaultValue: unknown) => {
        if (key === "secretScan") return currentSecretScan;
        return defaultValue;
      }),
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      body: createDoneStream(),
    });
  });

  async function sendOne(provider: OcGoChatModelProvider, text: string) {
    const models = await provider.provideLanguageModelChatInformation(
      { silent: true } as vscode.PrepareLanguageModelChatModelOptions,
      createToken()
    );
    const glm5 = models.find((m) => m.id === "glm-5");
    if (!glm5) throw new Error("glm-5 not found");
    const messages = [vscode.LanguageModelChatMessage.User(text)];
    const progress = {
      report: jest.fn(),
    } as unknown as vscode.Progress<vscode.LanguageModelResponsePart>;
    await provider.provideLanguageModelChatResponse(
      glm5,
      messages,
      {},
      progress,
      createToken()
    );
  }

  function lastChatBody(): string | undefined {
    const fetchMock = global.fetch as jest.Mock;
    const chatCall = fetchMock.mock.calls.find(
      (c: unknown[]) =>
        typeof c[1] === "object" && c[1] !== null && "body" in (c[1] as object)
    );
    return (chatCall?.[1] as { body?: string } | undefined)?.body;
  }

  it("skips scanAndRedact and leaves secrets in the body when secretScan=off", async () => {
    currentSecretScan = "off";
    const scanSpy = jest.spyOn(secretScan, "scanAndRedact").mockResolvedValue({
      redacted: true,
      findings: [],
      text: "should-not-be-used",
    });

    const provider = new OcGoChatModelProvider(
      secrets as unknown as vscode.SecretStorage,
      "jest-agent"
    );
    const secret = "AKIAIOSFODNN7EXAMPLE";
    await sendOne(provider, `my token is ${secret}`);

    expect(scanSpy).not.toHaveBeenCalled();
    expect(lastChatBody()).toContain(secret);
    scanSpy.mockRestore();
  });

  it("runs scanAndRedact when secretScan=redact", async () => {
    currentSecretScan = "redact";
    const scanSpy = jest.spyOn(secretScan, "scanAndRedact").mockResolvedValue({
      redacted: false,
      findings: [],
      text: "passthrough",
    });

    const provider = new OcGoChatModelProvider(
      secrets as unknown as vscode.SecretStorage,
      "jest-agent"
    );
    await sendOne(provider, "hello");

    expect(scanSpy).toHaveBeenCalled();
    scanSpy.mockRestore();
  });
});

describe("getSecretScanConfig", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env["OPENCODEGO_SCANNER"];
    delete process.env["OPENCODEGO_GITLEAKS_PATH"];
    delete process.env["OPENCODEGO_TRUFFLEHOG_PATH"];
  });

  it("uses the bundled trufflehog config when no override is set", () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((key: string, defaultValue: unknown) => {
        if (key === "secretScanner") return "trufflehog";
        if (key === "secretScan") return "redact";
        if (key === "trufflehogConfigPath") return "";
        return defaultValue;
      }),
    });

    const config = getSecretScanConfig();

    expect(config.scanner).toBe("trufflehog");
    expect(config.trufflehogConfigPath).toBe(
      path.resolve(process.cwd(), "config", "trufflehog.yml")
    );
    expect(config.trufflehogConfigLabel).toBe(
      `bundled default (${path.resolve(process.cwd(), "config", "trufflehog.yml")})`
    );
  });

  it("uses an absolute trufflehog config override as-is", () => {
    const customPath = path.resolve(process.cwd(), "config", "trufflehog.yml");
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((key: string, defaultValue: unknown) => {
        if (key === "secretScanner") return "trufflehog";
        if (key === "secretScan") return "redact";
        if (key === "trufflehogConfigPath") return customPath;
        return defaultValue;
      }),
    });

    const config = getSecretScanConfig();

    expect(config.trufflehogConfigPath).toBe(customPath);
    expect(config.trufflehogConfigLabel).toBe(customPath);
  });

  it("falls back to the bundled config for a relative trufflehog override", () => {
    const fallbackSpy = jest.spyOn(secretScanLog, "configFallback");
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((key: string, defaultValue: unknown) => {
        if (key === "secretScanner") return "trufflehog";
        if (key === "secretScan") return "redact";
        if (key === "trufflehogConfigPath") return "./relative.yml";
        return defaultValue;
      }),
    });

    const config = getSecretScanConfig();

    expect(config.trufflehogConfigPath).toBe(
      path.resolve(process.cwd(), "config", "trufflehog.yml")
    );
    expect(fallbackSpy).toHaveBeenCalledWith(
      "./relative.yml",
      path.resolve(process.cwd(), "config", "trufflehog.yml")
    );
  });
});
