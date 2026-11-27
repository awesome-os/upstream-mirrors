import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { findFiles, run, runCapture } from "./holo-workflow-runtime.mts";

export interface SparseMirrorSpec {
  name: string;
  url: string;
  branch?: string;
  paths?: string[];
}

export interface MirrorRow {
  name: string;
  branch: string;
  upstream_url: string;
  upstream_sha: string;
  files: number;
  size: string;
}

export const SPARSE_MIRRORS: readonly SparseMirrorSpec[] = [
  { name: "boringssl", url: "https://boringssl.googlesource.com/boringssl" },
  { name: "brotli", url: "https://github.com/google/brotli.git" },
  { name: "libwebp", url: "https://chromium.googlesource.com/webm/libwebp" },
  { name: "zlib-ng", url: "https://github.com/zlib-ng/zlib-ng.git" },
  { name: "libpng", url: "https://github.com/pnggroup/libpng.git" },
  { name: "freetype", url: "https://gitlab.freedesktop.org/freetype/freetype.git" },
  { name: "harfbuzz", url: "https://github.com/harfbuzz/harfbuzz.git" },
  { name: "libjpeg-turbo", url: "https://github.com/libjpeg-turbo/libjpeg-turbo.git" },
  { name: "expat", url: "https://github.com/libexpat/libexpat.git" },
  { name: "lz4", url: "https://github.com/lz4/lz4.git" },
  { name: "libdeflate", url: "https://github.com/ebiggers/libdeflate.git" },
  { name: "md4c", url: "https://github.com/mity/md4c.git" },
  { name: "picohttp", url: "https://github.com/h2o/picohttpparser.git" },
  { name: "libffi", url: "https://github.com/libffi/libffi.git" },
  { name: "mbedtls", url: "https://github.com/Mbed-TLS/mbedtls.git" },
  { name: "curl", url: "https://github.com/curl/curl.git" },
  { name: "luajit", url: "https://github.com/LuaJIT/LuaJIT.git" },
  { name: "raylib", url: "https://github.com/raysan5/raylib.git" },
  { name: "tcc", url: "https://github.com/TinyCC/tinycc.git" },
  { name: "ada", url: "https://github.com/ada-url/ada.git" },
  { name: "simdutf", url: "https://github.com/simdutf/simdutf.git" },
  {
    name: "electron",
    url: "https://github.com/electron/electron.git",
    branch: "main",
    paths: ["lib/", "docs/", "typings/", "build/args/", "shell/common/api/", "package.json", "LICENSE", "DEPS"],
  },
  {
    name: "vscode",
    url: "https://github.com/microsoft/vscode.git",
    branch: "main",
    paths: ["product.json", "package.json", "LICENSE.txt", "build/lib/", "src/vs/code/", "src/vs/platform/telemetry/"],
  },
  {
    name: "theia",
    url: "https://github.com/eclipse-theia/theia.git",
    branch: "master",
    paths: ["package.json", "LICENSE", "packages/core/package.json", "packages/electron/", "examples/browser/", "examples/electron/"],
  },
  {
    name: "adblock-rust",
    url: "https://github.com/brave/adblock-rust.git",
    branch: "master",
    paths: ["Cargo.toml", "LICENSE", "src/"],
  },
  {
    name: "xnulinux",
    url: "https://github.com/AFK-surf/xnulinux.git",
    branch: "main",
    paths: ["README.md", "Makefile", "fki/", "scripts/"],
  },
];

const DEFAULT_SPARSE_PATTERNS = [
  "/*",
  "!/test/",
  "!/tests/",
  "!/testing/",
  "!/fuzz/",
  "!/fuzzer/",
  "!/doc/",
  "!/docs/",
  "!/bench/",
  "!/benchmark/",
  "!/benchmarks/",
  "!/examples/",
  "!/java/",
  "!/python/",
  "!/go/",
  "!/rust/",
  "!/research/",
  "!/.github/",
].join("\n");

export function syncSparseMirror(spec: SparseMirrorSpec): MirrorRow {
  const branch = `mirror/${spec.name}`;
  const work = `/tmp/mirror-${spec.name}`;
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`=== Syncing sparse ${spec.name} from ${spec.url} -> ${branch} ===`);

  const cloneArgs = ["clone", "--depth=1", "--filter=blob:none", "--no-checkout"];
  if (spec.branch) cloneArgs.push("--branch", spec.branch);
  cloneArgs.push(spec.url, work);
  run("git", cloneArgs);

  run("git", ["-C", work, "sparse-checkout", "init", "--no-cone"]);
  const sparseBody = spec.paths
    ? spec.paths.map((p) => `/${p.replace(/^\/+/, "")}`).join("\n")
    : DEFAULT_SPARSE_PATTERNS;
  fs.writeFileSync(path.join(work, ".git/info/sparse-checkout"), `${sparseBody}\n`, "utf8");
  run("git", ["-C", work, "checkout", "--quiet", "HEAD"]);

  const upSha = runCapture("git", ["-C", work, "rev-parse", "--short", "HEAD"]).trim();
  fs.rmSync(path.join(work, ".git"), { recursive: true, force: true });
  const files = findFiles(work, () => true).length;
  const size = runCapture("du", ["-sh", work]).trim().split(/\s+/)[0] || "0";

  const hasRemote = runCapture("git", ["ls-remote", "--exit-code", "--heads", "origin", branch], { ignoreError: true }).trim();
  if (hasRemote) {
    run("git", ["fetch", "--depth=1", "origin", branch]);
    run("git", ["checkout", "-B", branch, "FETCH_HEAD"]);
  } else {
    run("git", ["checkout", "--orphan", branch]);
  }

  run("git", ["rm", "-rf", "."], { ignoreError: true, quiet: true });
  run("cp", ["-a", `${work}/.`, "."]);
  run("git", ["add", "-A"]);

  const dirty = runCapture("git", ["status", "--porcelain"]).trim();
  if (!dirty) {
    console.log(`  -> ${branch} @ ${upSha} unchanged (0 new commits)`);
  } else {
    run("git", ["commit", "-q", "-m", `mirror(${spec.name}): sparse stripped snapshot @ ${upSha} (${files} files, ${size})`]);
    run("git", ["push", "origin", branch]);
    console.log(`  -> Appended commit on ${branch} @ ${upSha} (${files} files, ${size})`);
  }

  run("git", ["checkout", "-f", "main"]);
  run("git", ["clean", "-fdx"]);

  return { name: spec.name, branch, upstream_url: spec.url, upstream_sha: upSha, files, size };
}

export function runSyncAll(): void {
  run("git", ["config", "user.name", "github-actions[bot]"]);
  run("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);

  const rows = SPARSE_MIRRORS.map((spec) => syncSparseMirror(spec));
  const payload = {
    schema: "awesome-os-sparse-mirrors-v1",
    updated_at: new Date().toISOString(),
    mirrors: rows,
  };
  fs.writeFileSync("mirror-index.json", `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  run("git", ["add", "mirror-index.json"]);
  if (runCapture("git", ["status", "--porcelain", "mirror-index.json"]).trim()) {
    run("git", ["commit", "-m", `chore: update mirror-index.json for ${rows.length} sparse upstream mirrors`]);
    run("git", ["push", "origin", "main"]);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  runSyncAll();
}
