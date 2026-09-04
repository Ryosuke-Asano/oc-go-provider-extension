import * as vscode from "vscode";
import packageJson from "../package.json";
import { OcGoChatModelProvider, getSecretScanConfig } from "./provider";
import { registerOcGoTools } from "./tools";
import { initStatusBar, statusBarGetLastScan } from "./statusBar";
import { flushLog } from "./logging";
import { OC_GO_MODELS, DEFAULT_VISION_PROXY_MODEL } from "./types";
import { clearDiscoverCache } from "./discover";
import {
  availability,
  getConfigPath,
  getConfigName,
  _resetAvailabilityCache,
} from "./secretScan";
import { secretScanLog, disposeChannel } from "./secretScanLog";

// Global provider reference for API key management
let _provider: OcGoChatModelProvider | null = null;

export function activate(context: vscode.ExtensionContext) {
  // Build a descriptive User-Agent to help quantify API usage
  const extVersion = (packageJson as { version?: string }).version ?? "unknown";
  const vscodeVersion = vscode.version;
  // Keep UA minimal: only extension version and VS Code version
  const ua = `opencode-go-vscode-chat/${extVersion} VSCode/${vscodeVersion}`;

  const provider = new OcGoChatModelProvider(context.secrets, ua);
  _provider = provider;

  // Refresh model list when API key is changed outside the management command.
  context.subscriptions.push(
    context.secrets.onDidChange((e) => {
      if (e.key === "opencode-go.apiKey") {
        clearDiscoverCache();
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

  // Initialize status bar for token usage display
  initStatusBar(context);

  console.log(
    "[OpenCode Go Provider] OpenCode Go tools registered successfully"
  );

  // Management command — now a real menu. Clicking the status bar
  // (or running "OpenCode Go: Manage OpenCode Go Provider") shows a
  // quick-pick with the most common actions: set/update/clear the API
  // key, view the secret scan status & log, pick the vision proxy
  // model, and jump straight to the extension's settings.
  context.subscriptions.push(
    vscode.commands.registerCommand("opencode-go.manage", async () => {
      const existing = await context.secrets.get("opencode-go.apiKey");
      const lastScan = statusBarGetLastScan();
      const scanAction = vscode.workspace
        .getConfiguration("opencodego")
        .get<string>("secretScan", "redact");
      const scanBackend = vscode.workspace
        .getConfiguration("opencodego")
        .get<string>("secretScanner", "trufflehog");

      type MenuItem = vscode.QuickPickItem & { action: () => Thenable<void> };

      const items: MenuItem[] = [];

      // --- API key section ---------------------------------------------
      if (existing) {
        items.push({
          label: "$(key) Update API Key…",
          description: "Replace the currently stored OpenCode Go API key",
          action: () => promptForApiKey(context, existing),
        });
        items.push({
          label: "$(eye) Show API Key…",
          description: "Reveal the currently stored OpenCode Go API key",
          action: () => revealApiKey(existing),
        });
        items.push({
          label: "$(trash) Clear API Key",
          description: "Remove the stored OpenCode Go API key",
          action: async () => {
            await context.secrets.delete("opencode-go.apiKey");
            vscode.window.showInformationMessage(
              "OpenCode Go API key cleared."
            );
            _provider?.fireModelInfoChanged();
          },
        });
      } else {
        items.push({
          label: "$(key) Set API Key…",
          description: "Store your OpenCode Go API key in the secret store",
          action: () => promptForApiKey(context, undefined),
        });
      }

      // --- Sub-menu separator -----------------------------------------
      items.push({
        kind: vscode.QuickPickItemKind.Separator,
        label: "Configuration",
        action: async () => {
          /* separator, never invoked */
        },
      } as MenuItem);

      items.push({
        label: "$(eye) Select Vision Proxy Model…",
        description:
          "Choose which vision-capable model is used for OCR / image analysis",
        action: () =>
          vscode.commands.executeCommand("opencode-go.selectVisionProxy"),
      });

      items.push({
        label: `$(shield) Secret Scan: ${scanAction}`,
        description: `View the scanner status (backend: ${scanBackend})`,
        action: () =>
          vscode.commands.executeCommand("opencode-go.showSecretScanStatus"),
      });

      if (lastScan) {
        const ts = new Date(lastScan.at).toLocaleString();
        const findingCount = lastScan.findings.length;
        items.push({
          label: `$(history) Show Secret Scan Log`,
          description:
            findingCount > 0
              ? `Last: ${ts} — ${findingCount} finding(s), redacted`
              : `Last: ${ts} — clean`,
          action: () =>
            vscode.commands.executeCommand("opencode-go.showSecretScanLog"),
        });
      } else {
        items.push({
          label: "$(history) Show Secret Scan Log",
          description: "No scans performed yet",
          action: () =>
            vscode.commands.executeCommand("opencode-go.showSecretScanLog"),
        });
      }

      // --- Settings section -------------------------------------------
      items.push({
        kind: vscode.QuickPickItemKind.Separator,
        label: "Help",
        action: async () => {
          /* separator, never invoked */
        },
      } as MenuItem);

      items.push({
        label: "$(gear) Open OpenCode Go Settings",
        description: "Adjust secret-scan mode, scanner path, vision model…",
        action: () =>
          vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "opencodego"
          ),
      });

      const picked = await vscode.window.showQuickPick(items, {
        title: "OpenCode Go",
        placeHolder: existing
          ? "Choose an action — an API key is set"
          : "Choose an action — no API key is set yet",
        matchOnDescription: true,
      });
      if (picked) {
        await picked.action();
      }
    })
  );

  // Vision proxy model selection command
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "opencode-go.selectVisionProxy",
      async () => {
        const visionModels = OC_GO_MODELS.filter(
          (m) => m.supportsVision && m.id !== "mimo-v2-omni"
        );
        const current = vscode.workspace
          .getConfiguration("opencodego")
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
          const config = vscode.workspace.getConfiguration("opencodego");
          await config.update(
            "visionProxyModel",
            picked.modelId,
            vscode.ConfigurationTarget.Global
          );
          vscode.window.showInformationMessage(
            `Vision proxy set to ${picked.label}`
          );
        }
      }
    )
  );

  // Listen for configuration changes to apply settings in real time
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("opencodego.visionProxyModel")) {
        vscode.window.showInformationMessage(
          "Vision proxy model updated. Changes apply to new requests."
        );
      }
      if (
        e.affectsConfiguration("opencodego.secretScan") ||
        e.affectsConfiguration("opencodego.secretScanner") ||
        e.affectsConfiguration("opencodego.gitleaksPath") ||
        e.affectsConfiguration("opencodego.trufflehogPath") ||
        e.affectsConfiguration("opencodego.trufflehogConfigPath")
      ) {
        _resetAvailabilityCache();
      }
    })
  );

  // Secret-scan status command — surfaces whether the configured
  // scanner is available and what was last redacted in the most
  // recent outbound request.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "opencode-go.showSecretScanStatus",
      async () => {
        const action = vscode.workspace
          .getConfiguration("opencodego")
          .get<string>("secretScan", "redact");
        const resolvedConfig = getSecretScanConfig();
        const path = getConfigPath();
        const avail = await availability(action === "off" ? "off" : "redact");
        const last = statusBarGetLastScan();
        const lines: string[] = [];
        lines.push(`Action: ${action}`);
        lines.push(`Scanner: ${getConfigName()}`);
        lines.push(`Binary: ${path}`);
        if (resolvedConfig.scanner === "trufflehog") {
          lines.push(`Config: ${resolvedConfig.trufflehogConfigLabel}`);
        }
        lines.push(`Status: ${avail}`);
        if (avail === "missing") {
          lines.push(
            `\nInstall the scanner binary and ensure it is on $PATH, or set the matching \`opencodego.<scanner>Path\` setting.`
          );
        }
        if (last) {
          lines.push("");
          lines.push(
            `Last scan: ${new Date(last.at).toLocaleString()} (${last.apiFormat})`
          );
          lines.push(`Redacted: ${last.redacted}`);
          lines.push(
            `Findings: ${last.findings.length} (${last.findings
              .map((f) => f.ruleId)
              .join(", ")})`
          );
        } else {
          lines.push("\nNo scans have been performed yet.");
        }
        const item = await vscode.window.showInformationMessage(
          lines.join("\n"),
          { modal: true },
          "Open Settings"
        );
        if (item === "Open Settings") {
          vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "opencodego.secretScan"
          );
        }
      }
    )
  );

  // Reveal the "OpenCode Go: Secret Scan" output channel. This gives
  // users a single clickable way to see per-request scan history, the
  // resolved scanner binary path, and any per-finding detail.
  context.subscriptions.push(
    vscode.commands.registerCommand("opencode-go.showSecretScanLog", () => {
      secretScanLog.reveal();
    })
  );

  // Show API Key — reveals the currently stored OpenCode Go API key
  // in a modal so the user can copy it. Useful when the key needs to
  // be pasted into another tool (curl, another editor, …). Disabled
  // (informative message) when no key is stored yet.
  context.subscriptions.push(
    vscode.commands.registerCommand("opencode-go.showApiKey", async () => {
      const stored = await context.secrets.get("opencode-go.apiKey");
      if (!stored) {
        vscode.window.showInformationMessage(
          "No OpenCode Go API key is set. Use 'Set API Key…' to store one."
        );
        return;
      }
      await revealApiKey(stored);
    })
  );

  console.log("[OpenCode Go Provider] Extension activated");
}

/**
 * Show an input box that lets the user set or update the OpenCode Go
 * API key. The prefill value is `existing` (when updating) or empty
 * (when setting for the first time). Empty input is treated as a
 * no-op (we never silently delete a key from this prompt — clearing
 * is an explicit menu choice).
 */
async function promptForApiKey(
  context: vscode.ExtensionContext,
  existing: string | undefined
): Promise<void> {
  const apiKey = await vscode.window.showInputBox({
    title: existing ? "Update OpenCode Go API Key" : "Set OpenCode Go API Key",
    prompt: existing
      ? "Replace the currently stored API key"
      : "Enter your OpenCode Go API key",
    ignoreFocusOut: true,
    password: true,
    value: existing ?? "",
    placeHolder: "Enter your OpenCode Go API key…",
    validateInput: (value) => {
      if (!value.trim()) {
        return "API key cannot be empty — use 'Clear API Key' from the menu to remove it.";
      }
      return undefined;
    },
  });
  if (apiKey === undefined) {
    return; // user canceled
  }
  await context.secrets.store("opencode-go.apiKey", apiKey.trim());
  vscode.window.showInformationMessage("OpenCode Go API key saved.");
  _provider?.fireModelInfoChanged();
}

/**
 * Reveal the currently stored OpenCode Go API key in a modal dialog
 * with a "Copy to Clipboard" action.
 *
 * The key is read from {@link vscode.SecretStorage}, which on every
 * supported platform is encrypted at rest by VS Code (libsecret on
 * Linux, Keychain on macOS, DPAPI on Windows). "Decrypting" here
 * just means surfacing the plaintext so the user can copy it —
 * no additional crypto layer is involved.
 *
 * The key is shown verbatim inside a modal `showInformationMessage`.
 * VS Code has no built-in read-only text dialog, so we offer the
 * user a single "Copy to Clipboard" action and otherwise close the
 * dialog. The full key is also written to a temporary, read-only
 * untitled document so it can be selected and copied manually as a
 * fallback (e.g. when the clipboard is being recorded).
 */
async function revealApiKey(apiKey: string): Promise<void> {
  // 1. Offer the convenient one-click copy path.
  const copy = "Copy to Clipboard";
  const choice = await vscode.window.showInformationMessage(
    `OpenCode Go API Key\n\n${apiKey}`,
    { modal: true, detail: "Click 'Copy to Clipboard' to copy this key." },
    copy
  );
  if (choice === copy) {
    await vscode.env.clipboard.writeText(apiKey);
    vscode.window.showInformationMessage(
      "OpenCode Go API key copied to clipboard."
    );
    return;
  }

  // 2. Fallback: open a read-only document containing the key so the
  //    user can select and copy it manually. Untitled documents
  //    have a fixed name we don't need to clean up.
  const doc = await vscode.workspace.openTextDocument({
    content: apiKey,
    language: "plaintext",
  });
  await vscode.window.showTextDocument(doc, { preview: false });
}

export function deactivate() {
  flushLog();
  disposeChannel();
  console.log("[OpenCode Go Provider] Extension deactivated");
  _provider = null;
}
