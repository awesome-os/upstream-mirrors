# Electron-on-Sectium Shared-V8 Component Build (Path 2)

This directory holds the GN build overlay and integration notes for running **Electron** on top of the **Awesome-OS / Sectium** collapsed 4-layer runtime stack (**Path 2: Shared-V8 Component Build**).

## Why Path 2?

A stock Electron release statically bundles its own private copy of Chromium, V8, Node.js, BoringSSL, ICU, and ~50 locale `.pak` files (`~150–250 MB` per application, duplicated on disk and in RAM for every installed Electron app).

**Path 2 (Electron-on-Sectium Shared-V8)** eliminates that duplication by converting Electron into a thin component-built shell that binds to Awesome-OS's content-addressed shared engines:

1. **Zero-Duplication Shared V8 (`cas-v1`):**
   - Enables `is_component_build = true`, `is_official_build = false`, and `v8_use_external_startup_data = true`.
   - Links dynamically against the cloud-built, content-addressed `cas-v1` V8 shared libraries (`v8.dll` / `libv8.so`, `v8_libbase`, `v8_libplatform`) hydrated once into OS RAM by **`b8g-ghost`** (`GhostModuleRegistry`).
   - External startup snapshots (`snapshot_blob.bin` / `v8_context_snapshot.bin`) and `v8_enable_shared_ro_heap = true` allow multiple Electron and `sectium-es` processes to share the same read-only V8 heap pages.
2. **Decoupled Presentation via `libsectium_display`:**
   - Presentation surfaces route through **`libsectium_display`** and the Sectium Host Device Boundary (`sections/sectium-device/`, dual-channel NDJSON over `\\.\pipe\sectium-dev` / `/tmp/sectium-dev.sock`) rather than embedding a standalone monolithic browser chrome.
3. **Aggressive Bloat & Locale Stripping:**
   - Strips unused locale `.pak` files (retaining `en-US` via `sectium_keep_locales = [ "en-US" ]`), disables `enable_pseudolocales`, PDF/printing stacks, Widevine, and debug symbols (`symbol_level = 0`, `blink_symbol_level = 0`, `v8_symbol_level = 0`).

## Upstream Mirror Source

Electron's API surface, TypeScript definitions, build arguments, and `DEPS` manifest are tracked as **Mirror #22** (`mirror/electron`) in [`../../.github/workflows/sync-sparse-mirrors.yml`](../../.github/workflows/sync-sparse-mirrors.yml) using a strict sparse allowlist:

- `lib/`
- `docs/`
- `typings/`
- `build/args/`
- `shell/common/api/`
- `package.json`
- `LICENSE`
- `DEPS`

## Usage

Append or import [`sectium_shared_v8.gn`](sectium_shared_v8.gn) on top of Electron's base GN args before running `gn gen`:

```gn
import("//electron/build/args/all.gn")
import("//patches/electron-sectium/sectium_shared_v8.gn")
```

At runtime, resolve the `cas-v1` V8 and `libsectium_display` shared libraries via the active `RollingReleaseManifest.json` and `b8g-ghost` shim loader.
