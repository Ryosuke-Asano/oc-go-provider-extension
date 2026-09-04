/// <reference types="jest" />

import * as vscode from "vscode";
import {
  initStatusBar,
  statusBarRecordSecretScan,
  statusBarRecordUsage,
  statusBarSetActiveModel,
  statusBarSetPromptTokens,
} from "../src/statusBar";

interface ContextFixture {
  context: vscode.ExtensionContext;
  update: jest.Mock;
}

function createContext(snapshot?: unknown): ContextFixture {
  let stored = snapshot;
  const get = <T>(): T | undefined => stored as T | undefined;
  const update = jest.fn(async (_key: string, value: unknown) => {
    stored = value;
  });
  return {
    context: {
      secrets: {} as vscode.SecretStorage,
      subscriptions: [],
      globalState: {
        get,
        update,
      },
    },
    update,
  };
}

describe("OpenCode Go status bar", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("persists actual context usage and restores the last session snapshot", () => {
    const item = {
      show: jest.fn(),
      hide: jest.fn(),
      dispose: jest.fn(),
      text: "",
      tooltip: "",
      command: undefined,
    };
    (vscode.window.createStatusBarItem as jest.Mock).mockReturnValue(item);
    const { context, update } = createContext();
    initStatusBar(context);

    statusBarSetActiveModel(1_000_000, "qwen3.6-plus");
    statusBarSetPromptTokens(100);
    statusBarRecordUsage({ prompt_tokens: 120, completion_tokens: 30 });
    statusBarRecordSecretScan({
      apiFormat: "openai",
      redacted: true,
      findings: [
        {
          ruleId: "test-secret",
          secret: "must-not-be-persisted",
          redacted: "[REDACTED:test-secret]",
        },
      ],
    });

    expect(update).toHaveBeenLastCalledWith(
      "opencode-go.lastContextSnapshot",
      expect.objectContaining({
        model: "qwen3.6-plus",
        contextTokens: 120,
        contextLimit: 1_000_000,
        estimated: false,
        cumulativeInput: 120,
        cumulativeOutput: 30,
        redactionCount: 1,
      })
    );

    statusBarSetActiveModel(262_144, "kimi-k2.5");
    expect(item.text).not.toContain("120/1.0M");

    const restoredItem = { ...item, text: "", tooltip: "" };
    (vscode.window.createStatusBarItem as jest.Mock).mockReturnValue(
      restoredItem
    );
    const { context: restoredContext } = createContext({
      model: "qwen3.6-plus",
      contextTokens: 120,
      contextLimit: 1_000_000,
      estimated: false,
      cumulativeInput: 120,
      cumulativeOutput: 30,
      redactionCount: 1,
    });
    initStatusBar(restoredContext);

    expect(restoredItem.text).toContain("last 120/1.0M");
    expect(restoredItem.text).toContain("120in/30out");
    expect(restoredItem.text).toContain("$(shield) 1");
  });
});
