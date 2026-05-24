import * as vscode from "vscode";
import packageJson from "../package.json";
import { OcGoChatModelProvider } from "./provider";
import { registerOcGoTools } from "./tools";
import { fetchZenModels } from "./zenModels";
import { OC_GO_MODELS, DEFAULT_VISION_PROXY_MODEL } from "./types";
import { initStatusBar } from "./statusBar";
import { flushLog } from "./logging";

export function activate(context: vscode.ExtensionContext) {
  const extVersion = (packageJson as { version?: string }).version ?? "unknown";
  const vscodeVersion = vscode.version;
  const ua = `opencode-go-vscode-chat/${extVersion} VSCode/${vscodeVersion}`;

  // ── OpenCode Go Provider ──────────────────────────────────────────
  const goProvider = new OcGoChatModelProvider(
    context.secrets,
    ua,
    "https://opencode.ai/zen/go/v1",
    "opencode-go.apiKey",
    OC_GO_MODELS,
    "OpenCode Go"
  );
  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider("opencode-go", goProvider)
  );
  console.log("[OpenCode] Go provider registered");

  // ── OpenCode Zen Provider ──────────────────────────────────────────
  const zenProvider = new OcGoChatModelProvider(
    context.secrets,
    ua,
    "https://opencode.ai/zen/v1",
    "opencode-zen.apiKey",
    [], // Populated dynamically via updateModelList after activation
    "OpenCode Zen"
  );
  void fetchZenModelsAndUpdate(zenProvider);
  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider("opencode-zen", zenProvider)
  );
  console.log("[OpenCode] Zen provider registered (fetching models...)");

  // ── Shared Tools ──────────────────────────────────────────────────
  context.subscriptions.push(registerOcGoTools(context.secrets));
  console.log("[OpenCode] Tools registered");

  // ── Status Bar ────────────────────────────────────────────────────
  initStatusBar(context);

  // ── API Key Management Commands ───────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("opencode-go.manage", () =>
      manageKey(
        context,
        "opencode-go.apiKey",
        "OpenCode Go",
        goProvider,
        zenProvider
      )),
    vscode.commands.registerCommand("opencode-zen.manage", () =>
      manageKey(
        context,
        "opencode-zen.apiKey",
        "OpenCode Zen",
        goProvider,
        zenProvider
      ))
  );

  // ── Vision Proxy Selection Command ───────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("opencode-go.selectVisionProxy", async () => {
      const visionModels = OC_GO_MODELS.filter((m) => m.supportsVision);
      const current = vscode.workspace
        .getConfiguration("opencode")
        .get<string>("visionProxyModel", DEFAULT_VISION_PROXY_MODEL);
      const items = visionModels.map((m) => ({
        label: m.displayName,
        description: m.id === current ? "$(check) Current" : m.id,
        modelId: m.id,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "Select vision proxy model for OCR",
      });
      if (picked) {
        const config = vscode.workspace.getConfiguration("opencode");
        await config.update(
          "visionProxyModel",
          picked.modelId,
          vscode.ConfigurationTarget.Global
        );
        vscode.window.showInformationMessage(
          `Vision proxy set to ${picked.label}`
        );
      }
    })
  );

  // ── Secrets change listener ──────────────────────────────────────
  context.subscriptions.push(
    context.secrets.onDidChange((e) => {
      if (e.key === "opencode-go.apiKey" || e.key === "opencode-zen.apiKey") {
        goProvider.fireModelInfoChanged();
        zenProvider.fireModelInfoChanged();
      }
    })
  );

  console.log("[OpenCode] Extension activated");
}

async function fetchZenModelsAndUpdate(
  provider: OcGoChatModelProvider
): Promise<void> {
  const apiKey = await provider.getApiKeyForFetch();
  const models = await fetchZenModels(apiKey);
  provider.updateModelList(models);
  provider.fireModelInfoChanged();
  console.log(
    `[OpenCode] ${provider.getVendorLabel()}: ${models.length} models loaded`
  );
}

async function manageKey(
  context: vscode.ExtensionContext,
  secretKey: string,
  label: string,
  goProvider: OcGoChatModelProvider,
  zenProvider: OcGoChatModelProvider
): Promise<void> {
  const existing = await context.secrets.get(secretKey);
  const apiKey = await vscode.window.showInputBox({
    title: `${label} API Key`,
    prompt: existing ? `Update your ${label} API key` : `Enter your ${label} API key`,
    ignoreFocusOut: true,
    password: true,
    value: existing ?? "",
    placeHolder: `Enter your ${label} API key...`,
  });
  if (apiKey === undefined) return;
  if (!apiKey.trim()) {
    await context.secrets.delete(secretKey);
    vscode.window.showInformationMessage(`${label} API key cleared.`);
  } else {
    await context.secrets.store(secretKey, apiKey.trim());
    vscode.window.showInformationMessage(`${label} API key saved.`);
  }
  void refreshModelsForKeyChange(secretKey, goProvider, zenProvider);
}

export async function refreshModelsForKeyChange(
  secretKey: string,
  goProvider: OcGoChatModelProvider,
  zenProvider: OcGoChatModelProvider
): Promise<void> {
  if (secretKey === "opencode-zen.apiKey") {
    await fetchZenModelsAndUpdate(zenProvider);
    return;
  }

  if (secretKey === "opencode-go.apiKey") {
    goProvider.updateModelList(OC_GO_MODELS);
    goProvider.fireModelInfoChanged();
    console.log("[OpenCode] OpenCode Go model list reset to static catalog");
  }
}

export function deactivate() {
  flushLog();
  console.log("[OpenCode] Extension deactivated");
}
