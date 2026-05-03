# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
