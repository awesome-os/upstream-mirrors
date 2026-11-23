# Upstream Tracking, Sparse Mirroring & Semantic Rebuild Method (`UPSTREAM_TRACKING.md`)

> **Purpose:** Plain-English guide and live status board showing how **Awesome-OS** and **Sectium Browser** track upstream C/C++ engines (`V8`, `Chromium`, `BoringSSL`, `Brotli`, `libwebp`, `zlib-ng`, `libpng`, `SQLite3`, `FreeType`, `HarfBuzz`, `libjpeg-turbo`, `Expat`) without maintaining bloated monolithic forks.

---

## 1. The 4-Stage Sovereign Upstream Method

1. **Stage 1 — Sparse Debloated Mirrors (`awesome-os/upstream-mirrors`):**
   - Each upstream C/C++ library is backed up onto its own dedicated **orphan branch** (`mirror/<name>`) via `git clone --depth=1 --filter=blob:none --no-checkout` + `git sparse-checkout` excluding tests, fuzzers, docs, benchmarks, and unused language bindings.
   - `main` in `sectium-browser` stays `< 50 KB` (zero vendored gigabytes), while `awesome-os/upstream-mirrors` preserves an immutable, debloated source corpus for sovereign rebuilds and $O(1)$ blast-radius analysis.
2. **Stage 2 — Dual-Layer Semantic Canonical AST Diff Gate (`upstream/semantic-diff.mts`):**
   - Strips comments/whitespace and applies De Bruijn $\alpha$-canonicalization (`$0, $1, ...`) to compute two orthogonal SHA-256 hashes per header/module:
     - **`abi_hash`** (exported signatures & struct layouts)
     - **`impl_hash`** (canonicalized function bodies)
   - Classifies every upstream update into one of four deterministic decisions:
     - `IDENTICAL` / `SKIP_NOISE` (comments/formatting/local renames → **`0` rebuilds**)
     - `SAFE_GHOST_HOTSWAP` (`abi_hash` unchanged → rebuild **only that 1 shard**, zero downstream relinks)
     - `ABI_BREAK_REBUILD` (`abi_hash` changed → caught mathematically before linking)
3. **Stage 3 — Parallel Independent Shards & Damped Gravity Builds (Free Cloud Runners):**
   - Independent C/C++ engines fan out **in parallel** on free `ubuntu-latest` (`~2 min` wall-clock for all 10 shards).
   - Heavy engines (`V8`, `Chromium`) use **component builds (`is_component_build = true`)** + **Damped Gravity** bounded drops (`compile -> checkpoint -> bounce`) so only finished shared libraries (`.so`/`.dll`/`.dylib`) are carried forward — keeping per-drop disk well inside free cloud runners.
4. **Stage 4 — Central `GhostModuleRegistry` & `RollingReleaseManifest.json`:**
   - Every compiled shared library is addressed by its **human-readable name + exact SHA-256** (`<cas>/<sha256>/<filename>`).
   - **`b8g-ghost`** (`~10 KB` `.so` / `~23 KB` `.dll` / `~52 KB` Darwin `.dylib`) hydrates missing libraries automatically from the central registry on first load and shares them once in OS RAM across all apps.
   - `sectium-browser`'s `baseline-release.yml` assembles the unified baseline (`RollingReleaseManifest.json` + `SHA256SUMS.txt` + `previous_tag` for $O(1)$ rollback) in ~21 seconds.

---

## 2. Live Sparse Mirror Status (`awesome-os/upstream-mirrors`)

- **Repository:** https://github.com/awesome-os/upstream-mirrors
- **Latest Verified Sync (`1m 14s` GREEN):** https://github.com/awesome-os/upstream-mirrors/actions/runs/45271338927

| Orphan Branch | Upstream SHA | Stripped Files | Stripped Size |
| :--- | :---: | :---: | :---: |
| `mirror/boringssl` | `1bbdb4a` | `4,504` | `236M` |
| `mirror/brotli` | `fed075f` | `197` | `33M` |
| `mirror/libwebp` | `5eddebf` | `294` | `7.7M` |
| `mirror/zlib-ng` | `9374b1b` | `273` | `3.0M` |
| `mirror/libpng` | `6d53b5e` | `507` | `5.9M` |
| `mirror/freetype` | `504159f` | `717` | `11M` |
| `mirror/harfbuzz` | `2d67dc9` | `760` | `17M` |
| `mirror/libjpeg-turbo` | `1631763` | `499` | `9.0M` |
| `mirror/expat` | `bbdb35e` | `204` | `131M` |

---

## 3. Live Cloud-Built Engine Shards & Baselines (`awesome-os/sectium-browser`)

| Release Tag | Contents | Live Verification |
| :--- | :--- | :--- |
| **[`v0.6.0-baseline`](https://github.com/awesome-os/sectium-browser/releases/tag/v0.6.0-baseline)** | **36 verified assets**: `RollingReleaseManifest.json` (`b8g-ghost` aligned), Lumi White Dragon brand pack, 4-OS `b8g-ghost`, 4-OS `b8g-shim`, 5-OS `libsectium_display`, 8 Win32 `gui-shells`, cloud V8 `eaf3708a`, `ghost-shards-manifest.json` | `21s` GREEN (`45267995649`) |
| **[`v0.6.0-v8-cloud`](https://github.com/awesome-os/sectium-browser/releases/tag/v0.6.0-v8-cloud)** | Fresh cloud-compiled upstream V8 (`eaf3708a`): `v8-shared-linux-x64.tar.gz` (`libv8.so`, `libv8_libbase.so`, `libv8_libplatform.so`) + `v8-include-eaf3708a.tar.gz` | `48m 05s` GREEN (`45250990278`) |
| **[`v0.6.0-chromium-shards`](https://github.com/awesome-os/sectium-browser/releases/tag/v0.6.0-chromium-shards)** | **10/10 parallel shards (`31` assets)**: `BoringSSL`, `Brotli`, `libwebp`, `zlib-ng`, `libpng18`, `SQLite3`, `FreeType`, `HarfBuzz`, `libjpeg-turbo`, `Expat` + unified `ghost-shards-manifest.json` | `~2m` GREEN (`45168854440`) |

### Latest Live Semantic AST Diff Gate Run (`45268965479` — GREEN)

```text
[semantic-diff] shard=v8        headers=112 blobChanged=0 abiChanged=0 implChanged=0 -> IDENTICAL
[semantic-diff] shard=boringssl headers=106 blobChanged=1 abiChanged=1 implChanged=1 -> ABI_BREAK_REBUILD
[semantic-diff] shard=brotli    headers=5   blobChanged=0 abiChanged=0 implChanged=0 -> IDENTICAL
```

---

## 4. Ghost Build Stacks & Zero-CMake `holo-compiler` 4-OS Cross-Compilation

Hosted CI runners (`windows-2022`, `ubuntu-latest`) routinely lag behind bleeding-edge SDKs (e.g., Windows SDK `10.0.26100.0` vs upstream V8's `10.0.28000.0`). To eliminate ambient runner drift and replace legacy CMake/Ninja/Make/MSVC pipelines system-wide, **build stacks themselves are packaged as content-addressed Ghost Toolchain Packs** inside `awesome-os/upstream-mirrors` and lazily hydrated by `holo-compiler` via SHA-256 CAS:

| Ghost Toolchain Pack (`v0.1.0-ghost-toolchains`) | Contents | Replaces |
| :--- | :--- | :--- |
| **`ghost-zig-0.14.0`** (`linux-x64`, `win64`, `macos-arm64`) | Self-contained Clang/LLVM + LLD + glibc/musl/Win32/macOS/WASI sysroots | Host GCC/Clang, MinGW, CMake, Make, `apt-get` |
| **`ghost-winsdk-msvc-x64`** (`xwin 0.10.0`, `.tar.zst`) | Hermetic Windows SDK + UCRT + MSVC CRT headers & import libs | Runner-installed Windows SDK / Visual Studio drift |
| **`ghost-ninja-1.12.1`** (`linux-x64`, `win64`, `macos`) | Minimal static legacy bridge (tree-shaken out as `holo-compiler` native recipes expand) | Ambient host Ninja / Make |
| **`ghost-toolchains-manifest.json`** | Unified SHA-256 + CAS key index for `holo-compiler` | Ad-hoc runner setup actions |

### Zero-CMake / Zero-Ninja 4-OS Shards (`v0.1.0-holo-4os`)

Pure `holo-compiler` (`zig cc`) compiles directly from sparse `mirror/*` branches into **4 OS native shared libraries** (`Win64 .dll`, `Linux x64 .so`, `Linux ARM64 .so`, `Darwin ARM64 .dylib`) from a single `ubuntu-latest` runner with zero CMake, zero Ninja, zero Make, and zero `apt-get`:

- **Live 4-OS Engines:** `libbrotli`, `libexpat`, `libsqlite3`, `libwebp` -> `16` cross-compiled shared libraries + unified `ghost-4os-manifest.json`.

