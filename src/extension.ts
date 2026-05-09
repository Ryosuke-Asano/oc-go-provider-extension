import * as vscode from "vscode";
import packageJson from "../package.json";
import { OcGoChatModelProvider } from "./provider";
import { registerOcGoTools } from "./tools";
import { OC_GO_MODELS } from "./types";
import { initStatusBar } from "./statusBar";

const VISION_PROXY_SETTING = "visionProxyModel";
const DEFAULT_VISION_PROXY_MODEL = "kimi-k2.6";

/**
 * Per-model latency / quality profile shown in the proxy QuickPick.
 * Helps the user pick between fast (MiMo) and detailed (Kimi).
 */
const VISION_PROXY_PROFILE: Record<string, string> = {
  "mimo-v2-omni":
    "Fastest · no reasoning · lower detail (best for quick OCR / simple descriptions)",
  "mimo-v2.5":
    "Fast · no reasoning · slightly richer than V2-Omni",
  "qwen3.5-plus":
    "Balanced · optional reasoning · 1M context · good detail/speed tradeoff",
  "qwen3.6-plus":
    "Balanced (newer) · optional reasoning · 1M context · good detail/speed tradeoff",
  "kimi-k2.5":
    "High detail · always reasons before answering (slower) · best for nuanced visual analysis",
  "kimi-k2.6":
    "Highest detail · always reasons before answering (slowest) · best for nuanced visual analysis",
};

/** Display order: fastest → most detailed. */
const VISION_PROXY_ORDER: string[] = [
  "mimo-v2-omni",
  "mimo-v2.5",
  "qwen3.5-plus",
  "qwen3.6-plus",
  "kimi-k2.5",
  "kimi-k2.6",
];

// Global provider reference for API key management
let _provider: OcGoChatModelProvider | null = null;

export function activate(context: vscode.ExtensionContext) {
  // Build a descriptive User-Agent to help quantify API usage
  const extVersion = (packageJson as { version?: string }).version ?? "unknown";
  const vscodeVersion = vscode.version;
  // Keep UA minimal: only extension version and VS Code version
  const ua = `opencode-go-vscode-chat/${extVersion} VSCode/${vscodeVersion}`;

  initStatusBar(context);

  const provider = new OcGoChatModelProvider(context.secrets, ua);
  _provider = provider;

  // Refresh model list when API key is changed outside the management command.
  context.subscriptions.push(
    context.secrets.onDidChange((e) => {
      if (e.key === "opencode-go.apiKey") {
        _provider?.fireModelInfoChanged();
      }
    })
  );

  // Register the OpenCode Go provider under the vendor id used in package.json
  const registration = vscode.lm.registerLanguageModelChatProvider(
    "opencode-go",
    provider
  );
  context.subscriptions.push(registration);

  console.log(
    "[OpenCode Go Provider] OpenCode Go provider registered successfully"
  );

  // Register OpenCode Go tools (vision analysis, etc.) for Copilot to use
  const toolsRegistration = registerOcGoTools(context.secrets);
  context.subscriptions.push(toolsRegistration);

  console.log(
    "[OpenCode Go Provider] OpenCode Go tools registered successfully"
  );

  // Management command to configure API key
  context.subscriptions.push(
    vscode.commands.registerCommand("opencode-go.manage", async () => {
      const existing = await context.secrets.get("opencode-go.apiKey");
      const apiKey = await vscode.window.showInputBox({
        title: "OpenCode Go API Key",
        prompt: existing
          ? "Update your OpenCode Go API key"
          : "Enter your OpenCode Go API key",
        ignoreFocusOut: true,
        password: true,
        value: existing ?? "",
        placeHolder: "Enter your OpenCode Go API key...",
      });
      if (apiKey === undefined) {
        return; // user canceled
      }
      if (!apiKey.trim()) {
        await context.secrets.delete("opencode-go.apiKey");
        vscode.window.showInformationMessage("OpenCode Go API key cleared.");
        _provider?.fireModelInfoChanged();
        return;
      }
      await context.secrets.store("opencode-go.apiKey", apiKey.trim());
      vscode.window.showInformationMessage("OpenCode Go API key saved.");
      // Notify VS Code that the list of available models has changed
      _provider?.fireModelInfoChanged();
    })
  );

  // Command to pick the vision proxy model used to transcribe images for
  // non-vision chat models. Shows a QuickPick listing every vision-capable
  // OpenCode Go model with its current selection marked.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "opencode-go.selectVisionProxyModel",
      async () => {
        const config = vscode.workspace.getConfiguration("opencodego");
        const current = config.get<string>(
          VISION_PROXY_SETTING,
          DEFAULT_VISION_PROXY_MODEL
        );

        const visionModels = OC_GO_MODELS.filter((m) => m.supportsVision);
        if (visionModels.length === 0) {
          vscode.window.showWarningMessage(
            "No vision-capable OpenCode Go models are available."
          );
          return;
        }

        // Sort fastest → most detailed so the QuickPick reads top-down by
        // latency cost. Unknown models fall to the end in their original order.
        const orderIndex = (id: string): number => {
          const i = VISION_PROXY_ORDER.indexOf(id);
          return i === -1 ? Number.MAX_SAFE_INTEGER : i;
        };
        visionModels.sort((a, b) => orderIndex(a.id) - orderIndex(b.id));

        const items: Array<vscode.QuickPickItem & { id: string }> =
          visionModels.map((m) => {
            const profile =
              VISION_PROXY_PROFILE[m.id] ??
              `Vision proxy · ${m.contextWindow.toLocaleString()} ctx`;
            const tags: string[] = [];
            if (m.id === current) tags.push("current");
            if (m.id === DEFAULT_VISION_PROXY_MODEL) tags.push("default");
            const labelTag = tags.length ? ` (${tags.join(", ")})` : "";
            return {
              id: m.id,
              label:
                m.id === current
                  ? `$(check) ${m.displayName}${labelTag}`
                  : `${m.displayName}${labelTag}`,
              description: m.id,
              detail: profile,
            };
          });

        const picked = await vscode.window.showQuickPick(items, {
          title: "Select OpenCode Go vision proxy model",
          placeHolder:
            "Used to transcribe attached images when the active model has no vision support",
          matchOnDescription: true,
          matchOnDetail: true,
          ignoreFocusOut: true,
        });
        if (!picked) {
          return; // user canceled
        }
        if (picked.id === current) {
          vscode.window.showInformationMessage(
            `OpenCode Go vision proxy already set to ${picked.id}.`
          );
          return;
        }
        await config.update(
          VISION_PROXY_SETTING,
          picked.id,
          vscode.ConfigurationTarget.Global
        );
        vscode.window.showInformationMessage(
          `OpenCode Go vision proxy model set to ${picked.id}.`
        );
      }
    )
  );

  console.log("[OpenCode Go Provider] Extension activated");
}

export function deactivate() {
  console.log("[OpenCode Go Provider] Extension deactivated");
  _provider = null;
}
