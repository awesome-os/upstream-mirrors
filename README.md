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

## Quick Install & Run (Windows / Linux / macOS)

```sh
# Download latest release assets (all platforms)
gh release download -R awesome-os/upstream-mirrors --dir ./upstream-mirrors-release

# Or clone source directly (all platforms)
git clone https://github.com/awesome-os/upstream-mirrors.git && cd upstream-mirrors
```
