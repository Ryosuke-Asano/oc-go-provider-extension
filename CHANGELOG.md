# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.0] - 2026-06-25

### Added

- **GLM-5.2** model (`glm-5.2`) — 1M context, 131K max output, reasoning support via `reasoning_effort`/`thinking` parameters
- **Kimi K2.7 Code** model (`kimi-k2.7-code`) — 262K context, 16K max output, tool calling support
- **MiniMax M3** model (`minimax-m3`) — 1M context, 512K max output, tool calling support (Anthropic endpoint)
- **Qwen3.7 Max** model (`qwen3.7-max`) — 1M context, 65K max output, tool calling support (Anthropic endpoint)
- **Qwen3.7 Plus** model (`qwen3.7-plus`) — 1M context, 65K max output, vision & tool calling support (Anthropic endpoint)

### Changed

- Aligned model roster with the current OpenCode Go subscription:
  - Removed models no longer offered: `glm-5`, `kimi-k2.5`, `mimo-v2-pro`, `mimo-v2-omni`, `minimax-m2.5`, `qwen3.5-plus`
  - `qwen3.6-plus` now uses the Anthropic-compatible `/messages` endpoint (corrected from OpenAI format)
  - All Qwen models now route through the Anthropic endpoint; thinking mode set to none (previous `chat_template_kwargs` thinking params apply only to the OpenAI endpoint)
- Switched default vision proxy model from `mimo-v2-omni` to `mimo-v2.5`; updated the configurable vision proxy enum to current vision-capable models (MiMo-V2.5, Kimi K2.6, Qwen3.7 Plus, Qwen3.6 Plus)

## [0.7.0] - 2026-05-19

### Added

- Enhanced image analysis tool with vision model support and logging

### Changed

- Improved code formatting and readability in package.json, provider.ts, and utils.ts

## [0.6.1] - 2026-05-08

### Fixed

- Cap image token estimation to avoid base64 size overcounting
- Truncate OCR image analysis text to prevent oversized prompts

## [0.6.0] - 2026-05-04

### Added

- **MiMo-V2.5-Pro** model (`mimo-v2.5-pro`) — 1T params (42B activated), 1M context, 131K max output, tool calling support
- **MiMo-V2.5** model (`mimo-v2.5`) — 311B params, 262K context, 65K max output, multimodal vision, audio, video & tool calling support (native omnimodal)

## [0.5.0] - 2026-04-25

### Added

- **DeepSeek V4 Flash** model (`deepseek-v4-flash`) — 284B params (13B activated), 1M context, 384K max output, tool calling support
- **DeepSeek V4 Pro** model (`deepseek-v4-pro`) — 1.6T params (49B activated), 1M context, 384K max output, tool calling support

## [0.4.1] - 2026-04-22

### Fixed

- Fixed Kimi (Moonshot AI) 400 error "thinking is enabled but reasoning_content is missing in assistant tool call message" by including `reasoning_content` field in all assistant messages

## [0.4.0] - 2026-04-21

### Added

- **Kimi K2.6** model (`kimi-k2.6`) — 262K context, 262K max output, multimodal vision & tool calling support

## [0.3.0] - 2026-04-16

### Added

- **Qwen3.5 Plus** model (`qwen3.5-plus`) — 1M context, 65K max output, vision & tool calling support
- **Qwen3.6 Plus** model (`qwen3.6-plus`) — 1M context, 65K max output, vision & tool calling support

## [0.2.1] - 2026-04-14

### Fixed

- Fixed Kimi K2.5 API error "invalid temperature: only 1 is allowed for this model" by adding `fixedTemperature` support to model configuration

## [0.2.0] - 2026-04-14

### Changed

- Aligned model token limits with OpenRouter published specifications
  - **Kimi K2.5**: context 131K → 262K, max output 8K → 65K
  - **MiMo-V2-Pro**: context 131K → 1M, max output 16K → 131K
  - **MiMo-V2-Omni**: context 131K → 262K, max output 16K → 65K
  - **MiniMax M2.5**: context 1M → 196K, max output 16K → 131K
  - **MiniMax M2.7**: context 1M → 196K, max output 16K → 131K
  - GLM-5 and GLM-5.1 remain unchanged (already aligned)

### Fixed

- Updated README and package.json descriptions for accuracy
- Added token limit disclaimer to README

## [0.1.0] - 2026-04-14

- The First Release.
