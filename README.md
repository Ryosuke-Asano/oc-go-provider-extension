# OpenCode Go Chat Provider for VS Code

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.104.0%2B-blue)](https://code.visualstudio.com/)

Integrates [OpenCode Go](https://opencode.ai/docs/ja/go) models into VS Code Copilot Chat with advanced features including vision support and tool calling.

## Features

- **Multiple Model Support** (OpenAI- and Anthropic-compatible endpoints)
  - **GLM-5** / **GLM-5.1** / **GLM-5.2**: 202K context window, up to 131K output tokens
  - **Kimi K2.5**: 262K context window, up to 65K output tokens, vision support
  - **Kimi K2.6**: 262K context window, up to 262K output tokens, vision support
  - **Kimi K2.7 Code**: 262K context window, up to 262K output tokens, vision support
  - **MiMo-V2-Pro** / **MiMo-V2.5-Pro**: 1,048K context window, up to 131K output tokens
  - **MiMo-V2-Omni** / **MiMo-V2.5**: 262K context window, up to 65K output tokens, vision support
  - **Qwen3.5 Plus** / **Qwen3.6 Plus** / **Qwen3.7 Plus** / **Qwen3.7 Max**: up to 1M context window
  - **DeepSeek V4 Flash** / **DeepSeek V4 Pro**: 1M context window, up to 393K output tokens
  - **MiniMax M2.5** / **MiniMax M2.7**: 196K context window, up to 131K output tokens
  - **MiniMax M3**: 262K context window, up to 131K output tokens
  - **Hy3 Preview**: 262K context window, up to 65K output tokens, vision support

- **Advanced Capabilities**
  - Tool calling support for VS Code chat participants
  - Streaming responses via Server-Sent Events (SSE)
  - Vision support via Kimi K2.5/K2.6/K2.7 Code, MiMo-V2-Omni, MiMo-V2.5, Qwen3.5 Plus, Qwen3.6 Plus, Qwen3.7 Plus, Qwen3.7 Max, and Hy3 Preview
  - Thinking/reasoning mode for Kimi (always-on) and switchable for MiMo, Qwen, DeepSeek, MiniMax M3, and Hy3 Preview
  - Automatic image-to-text conversion for non-vision models

- **Secure API Key Management**
  - Stored securely in VS Code SecretStorage
  - Managed via Command Palette (`OpenCode Go: Manage OpenCode Go Provider`)

- **Outbound Secret Scanning (pluggable: trufflehog or gitleaks)**
  - Pre-flight scan of every chat request using either [trufflehog](https://github.com/trufflesecurity/trufflehog) (default) or [gitleaks](https://github.com/gitleaks/gitleaks)
  - Detected secrets (API keys, tokens, private keys, …) are replaced with `[REDACTED:<rule-id>]`
    before the request is sent, so they never reach the LLM provider
  - When a secret is redacted, a short system-level hint is added to the request (idempotent across
    multi-turn conversations, only injected on the first redacted turn) telling the LLM that the
    placeholders are intentional and can be safely ignored
  - Backend selected by `opencodego.secretScanner` (`trufflehog` | `gitleaks`, default `trufflehog`)
  - Action gated by `opencodego.secretScan` (`off` | `redact`, default `redact`)
  - Configurable binary paths via `opencodego.trufflehogPath` and `opencodego.gitleaksPath`
  - TruffleHog uses the bundled `config/trufflehog.yml` by default; `opencodego.trufflehogConfigPath` can override it with an absolute path
  - TruffleHog runs with `--no-verification` and `--no-update` so it never makes network calls during a scan
  - Status surfaced via the command `OpenCode Go: Show Secret Scan Status`

> **Note:** TruffleHog must be installed manually. You can build it from source:
>
> ```bash
> git clone https://github.com/trufflesecurity/trufflehog.git
> cd trufflehog; go install
> ```

## Installation

### From Source

1. Clone the repository:

```bash
git clone https://github.com/mheers/oc-go-provider-extension.git
cd oc-go-provider-extension
```

2. Install dependencies:

```bash
npm install
```

3. Compile the project:

```bash
npm run compile
```

4. Install `vsce` (VS Code Extension Manager):

   **Option A** — Install globally (requires `sudo` on Linux/macOS):

   ```bash
   npm install -g @vscode/vsce
   ```

   **Option B** — Use via `npx` (no install needed):

   > You can replace `npm run package` in the next step with `npx -y @vscode/vsce package`.

5. Package the extension:

   ```bash
   npm run package
   ```

6. Install the `.vsix` file:

```bash
code --install-extension opencode-go-vscode-chat-*.vsix
```

## Setup

1. Open VS Code
2. Open Command Palette (`Cmd/Ctrl + Shift + P`)
3. Run `OpenCode Go: Manage OpenCode Go Provider`
4. Enter your OpenCode Go API key

Get your API key from [OpenCode](https://opencode.ai/).

## Usage

Once configured, select OpenCode Go as your chat provider in VS Code Copilot Chat:

- Open the Chat view (`Cmd/Ctrl + Alt + I`)
- Click the provider selector
- Choose an OpenCode Go model from the [Supported Models](#supported-models) list

## Supported Models

The following model IDs are fetched from the OpenCode Go models endpoint. The list may change as OpenCode tests and adds models. Run `make sync-models-readme` to refresh it.

<!-- BEGIN GENERATED GO MODELS -->

| Model ID |
| -------- |
| `deepseek-v4-flash` |
| `deepseek-v4-flash-vision-exp` |
| `deepseek-v4-pro` |
| `glm-5` |
| `glm-5.1` |
| `glm-5.2` |
| `glm-5.3` |
| `glm-5.3-flash` |
| `gpt-5.6-luna` |
| `grok-4.5` |
| `grok-4.6` |
| `hy3` |
| `hy3-preview` |
| `hy4-preview` |
| `kimi-k2.5` |
| `kimi-k2.6` |
| `kimi-k2.7-code` |
| `kimi-k3` |
| `longcat-2.0` |
| `mimo-v2-omni` |
| `mimo-v2-pro` |
| `mimo-v2.5` |
| `mimo-v2.5-pro` |
| `minimax-m2.5` |
| `minimax-m2.7` |
| `minimax-m3` |
| `muse-spark-1.2-contributor` |
| `muse-spark-1.3-contributor` |
| `omen-alpha` |
| `qwen3.5-plus` |
| `qwen3.6-plus` |
| `qwen3.7-max` |
| `qwen3.7-plus` |
| `qwen3.8-flash` |
| `qwen3.8-max` |

<!-- END GENERATED GO MODELS -->

## MCP Integration

This extension integrates with OpenCode Go's MCP (Model Context Protocol) server:

- **Vision MCP**: Image analysis using MiMo-V2.5 (default vision proxy for non-vision models)

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed development guidelines.

### Quick Start

```bash
# Install dependencies
npm install

# Install vsce for packaging (or use npx -y @vscode/vsce)
npm install -g @vscode/vsce

# Watch for changes
npm run watch

# Run tests
npm test

# Lint code
npm run lint

# Format code
npm run format
```

### Project Structure

```
src/
├── extension.ts    # Extension entry point, activation
├── provider.ts     # Main chat provider implementation
├── types.ts        # Type definitions and model configuration
├── tools.ts        # Language model tool definitions
├── mcp.ts          # MCP client for tool integration
└── utils.ts        # Utility functions for message/tool conversion
```

## Requirements

- VS Code 1.104.0 or later
- Node.js 20 or later (for development)
- OpenCode Go API key

## Troubleshooting

### API Key Issues

If you see authentication errors:

1. Run `OpenCode Go: Manage OpenCode Go Provider`
2. Verify your API key is correct
3. Ensure your OpenCode Go subscription is active

### Vision Not Working

For non-vision models (GLM-5/5.1/5.2, MiMo-V2-Pro, MiMo-V2.5-Pro, DeepSeek V4 Flash/Pro, MiniMax M2.5/M2.7/M3):

- Images are automatically converted to text descriptions using Vision MCP
- If the MCP tool fails, the extension internally uses MiMo-V2-Omni for image analysis
- For direct vision, choose a vision-capable model such as Kimi K2.5/K2.6/K2.7 Code, MiMo-V2-Omni, MiMo-V2.5, Qwen3.5/3.6/3.7 Plus, Qwen3.7 Max, or Hy3 Preview

### Large Context Errors

If you encounter token limit errors:

- Reduce the amount of code/context in your message
- The extension enforces model-specific context limits

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for version history.

## License

MIT © 2025 Ryosuke Asano

[License](LICENSE)

## Links

- [Repository](https://github.com/Ryosuke-Asano/oc-go-provider-extension)
- [Issue Tracker](https://github.com/Ryosuke-Asano/oc-go-provider-extension/issues)
- [OpenCode](https://opencode.ai/)
