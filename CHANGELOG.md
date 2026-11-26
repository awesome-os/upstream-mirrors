# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Normalized SPDX `LICENSE` to full canonical OSI BSD-3-Clause text with LF line endings.

### Added
- Governance standardization: `.gitattributes`, `.github/CODEOWNERS`, and `CHANGELOG.md`.

## [11.0.0] - 2026-11-26

### Added
- Sparse debloated upstream C/C++ mirrors (`mirror/*` orphan branches) synced via `.github/workflows/sync-sparse-mirrors.yml`.
- `v11-max-5os-latest` release matrix compiling 14 Tier-1 libraries across Win64, Linux x64/ARM64, macOS ARM64, and `wasm32-wasi` via `holo-compiler` (`zig cc`/`c++ 0.14.0`).
- Reusable `holo-ci@v1` verification (`holo-ci.json`, `mirror-index.json`, `holo-compiler-lockfile.json`).
