# OpenCode Go Chat Provider for VS Code

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.104.0%2B-blue)](https://code.visualstudio.com/)

Integrates [OpenCode Go](https://opencode.ai/docs/ja/go) models into VS Code Copilot Chat with advanced features including vision support, tool calling, and thinking process display.

## Features

- **Multiple Model Support**
  - **GLM-5**: 202K context window, up to 131K output tokens
  - **GLM-5.1**: 202K context window, up to 131K output tokens
  - **Kimi K2.5**: 131K context window, up to 8K output tokens
  - **MiMo-V2-Pro**: 131K context window, up to 16K output tokens
  - **MiMo-V2-Omni**: 131K context window, up to 16K output tokens, vision support

- **Advanced Capabilities**
  - Tool calling support for VS Code chat participants
  - Streaming responses via Server-Sent Events (SSE)
  - Vision support via MiMo-V2-Omni
  - Thinking/reasoning process display (configurable)
  - Automatic image-to-text conversion for non-vision models

- **Secure API Key Management**
  - Stored securely in VS Code SecretStorage
  - Managed via Command Palette (`OpenCode Go: Manage OpenCode Go Provider`)

## Installation

### From Source

1. Clone the repository:

```bash
git clone https://github.com/Ryosuke-Asano/oc-go-provider-extension.git
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

4. Package the extension:

```bash
npm run package
```

5. Install the `.vsix` file:

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
- Choose an OpenCode Go model (GLM-5, GLM-5.1, Kimi K2.5, MiMo-V2-Pro, or MiMo-V2-Omni)

### Configuration

| Setting                      | Type    | Default | Description                                                 |
| ---------------------------- | ------- | ------- | ----------------------------------------------------------- |
| `opencode-go.enableThinking` | boolean | `true`  | Enable thinking/reasoning process display in chat responses |

## Supported Models

| Model        | Context Window | Max Output | Vision | Tools |
| ------------ | -------------- | ---------- | ------ | ----- |
| GLM-5        | 202,752        | 131,072    | No     | Yes   |
| GLM-5.1      | 202,752        | 131,072    | No     | Yes   |
| Kimi K2.5    | 131,072        | 8,192      | No     | Yes   |
| MiMo-V2-Pro  | 131,072        | 16,384     | No     | Yes   |
| MiMo-V2-Omni | 131,072        | 16,384     | Yes    | Yes   |

## MCP Integration

This extension integrates with OpenCode Go's MCP (Model Context Protocol) server:

- **Vision MCP**: Image analysis using MiMo-V2-Omni

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed development guidelines.

### Quick Start

```bash
# Install dependencies
npm install

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

For non-vision models (GLM-5, GLM-5.1, Kimi K2.5, MiMo-V2-Pro):

- Images are automatically converted to text descriptions using Vision MCP
- If the MCP tool fails, the extension internally uses MiMo-V2-Omni for image analysis
- MiMo-V2-Omni is also available as a selectable model with direct vision support

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
