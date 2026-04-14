import * as vscode from "vscode";
import packageJson from "../package.json";
import { OcGoChatModelProvider } from "./provider";
import { registerOcGoTools } from "./tools";

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

  console.log("[OpenCode Go Provider] Extension activated");
}

export function deactivate() {
  console.log("[OpenCode Go Provider] Extension deactivated");
  _provider = null;
}
