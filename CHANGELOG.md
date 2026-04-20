# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
