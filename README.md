# `awesome-os/upstream-mirrors` — Sparse Debloated Upstream Mirrors

Clean, sparse-checked-out source snapshots of the exact C/C++ upstream libraries used by **Awesome-OS** and **Sectium Browser** — **zero test suites, zero fuzzers, zero docs/benchmark bloat**.

Each upstream lives on its own dedicated orphan branch (`mirror/<name>`) so `main` stays tiny while every dependency's stripped source tree is preserved permanently for sovereign backup, reproducible builds, and large-scale C/C++ debloat analysis:

- `mirror/boringssl`
- `mirror/brotli`
- `mirror/libwebp`
- `mirror/zlib-ng`
- `mirror/libpng`
- `mirror/freetype`
- `mirror/harfbuzz`
- `mirror/libjpeg-turbo`
- `mirror/expat`

Updated automatically by [`.github/workflows/sync-sparse-mirrors.yml`](.github/workflows/sync-sparse-mirrors.yml).

## Production Max-Version 5-OS Shared + WASI Libraries (`v11-max-5os-latest`)

[`.github/workflows/holo-5os-max-shards.yml`](.github/workflows/holo-5os-max-shards.yml) resolves live pinned upstream versions from [`awesome-os/t2linux-baseline`](https://github.com/awesome-os/t2linux-baseline/blob/main/catalog/live-upstream-tracker.json) and compiles **14 Tier-1 high-overlap libraries** directly from upstream sources using pure `holo-compiler` (`zig cc 0.14.0` / `zig c++ 0.14.0`, zero CMake/Ninja/Make) across **Win64 (`.dll`)**, **Linux x64 (`.so`)**, **Linux ARM64 (`.so`)**, **macOS ARM64 (`.dylib`)**, and **`wasm32-wasi` (`.wasm`)**:

- **C + WASI Reactor (5 targets each):** `zlib`, `zstd`, `libdeflate`, `lz4`, `brotli`, `md4c`, `sqlite3`, `libyaml`, `libwebp`, `expat`
- **C++ / Native Allocator (4 native OS targets each):** `simdjson`, `simdutf`, `ada`, `mimalloc`
- **Release & Manifest:** [`v11-max-5os-latest`](https://github.com/awesome-os/upstream-mirrors/releases/tag/v11-max-5os-latest) publishes all verified binaries, `SHA512SUMS.txt`, and `holo-v11-max-5os-manifest.json` (`schema: "holo-v11.max-5os-manifest.v1"`, `abiMagic: "0x33564742"`, `v11/files/<aa>/<sha512>` CAS layout).

## Live Shard & Workflow Telemetry Summary

<!-- AUTO-GENERATED:BEGIN source="holo-ci.json" id="upstream-mirrors:catalog-summary" -->
| Gate / Surface | Verified Status | Details & Source |
| :--- | :--- | :--- |
| **Hardened Workflows (`holo-ci@v1`)** | `9` workflows · `0` findings | [`holo-ci.yml`](.github/workflows/holo-ci.yml), [`sync-sparse-mirrors.yml`](.github/workflows/sync-sparse-mirrors.yml), [`holo-4os-shards.yml`](.github/workflows/holo-4os-shards.yml), [`holo-5os-max-shards.yml`](.github/workflows/holo-5os-max-shards.yml), [`holo-5os-tier2-shards.yml`](.github/workflows/holo-5os-tier2-shards.yml), [`holo-5os-tier3-shards.yml`](.github/workflows/holo-5os-tier3-shards.yml), [`holo-5os-tier4-shards.yml`](.github/workflows/holo-5os-tier4-shards.yml), [`holo-5os-tier5-shards.yml`](.github/workflows/holo-5os-tier5-shards.yml), [`holo-5os-tier6-shards.yml`](.github/workflows/holo-5os-tier6-shards.yml) |
| **Tier-1..6 5-OS Shards** | `win64`, `linux-x64`, `linux-arm64`, `macos-arm64`, `wasm32-wasi` | Pure `holo-compiler` (`zig cc` / `zig c++`) builds with fail-fast `linux-x64` smoke pre-flight (`B8G_ABI_MAGIC_V3 = 0x33564742`) |
| **Sparse Orphan Mirrors** | `9` `mirror/*` branches | Debloated source-only snapshots (`boringssl`, `brotli`, `libwebp`, `zlib-ng`, `libpng`, `freetype`, `harfbuzz`, `libjpeg-turbo`, `expat`) indexed in [`mirror-index.json`](mirror-index.json) |
| **`holo-ci.v1` Guards** | `7/7` active | `zeroGhost`, `zeroCasV1`, `spdxLicense`, `gitattributes`, `codeowners`, `noWorkflowBloat`, `requireWorkflowHardening` ([`holo-ci.json`](holo-ci.json)) |
<!-- AUTO-GENERATED:END -->

## Quick Install & Run (Windows / Linux / macOS)

```sh
# Install / hydrate from v11 CAS via holo-pm
holo-pm install repository://github.com/awesome-os/upstream-mirrors@main

# Or project & run directly via holo-project (0-byte hardlink)
holo-project "project://cpp/upstream-mirrors?from=repository://github.com/awesome-os/upstream-mirrors@main"
```
