import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const EXPECTED_TIER2_LIBS = [
  "mbedtls",
  "llhttp",
  "nghttp2",
  "nghttp3",
  "c-ares",
  "fast_float",
  "libpng",
  "giflib",
  "freetype",
  "harfbuzz",
  "onig",
  "zlib-ng",
] as const;

export const EXPECTED_TIER3_LIBS = [
  "pixman",
  "libjpeg-turbo",
  "libffi",
  "ngtcp2",
  "libxml2",
  "libxslt",
  "woff2",
  "libarchive",
] as const;

export const EXPECTED_TIER4_LIBS = [
  "liburing",
  "ninja",
  "libavif",
  "cairo",
  "mariadb-connector-c",
  "libgit2",
  "curl",
  "openssl",
  "limine",
  "vulkan-loader",
] as const;

export const FIVE_OS_TARGETS = [
  { target: "x86_64-windows-gnu", ext: "win64.dll", kind: "shared" },
  { target: "x86_64-linux-gnu", ext: "linux-x64.so", kind: "linux-shared" },
  { target: "aarch64-linux-gnu", ext: "linux-arm64.so", kind: "linux-shared" },
  { target: "aarch64-macos", ext: "macos-arm64.dylib", kind: "shared" },
  { target: "wasm32-wasi", ext: "wasm32-wasi.wasm", kind: "wasi" },
] as const;

export interface ShardReceiptArtifact {
  name: string;
  size: number;
  sha512: string;
}

export interface ShardReceipt {
  schema: "holo-v11.shard-receipt.v1";
  pkg: string;
  libOut: string;
  repo: string;
  tag: string;
  version: string;
  deterministic: boolean;
  artifacts: ShardReceiptArtifact[];
}

export interface WorkflowValidationResult {
  matrixLibs: string[];
  hasForceRebuildInput: boolean;
  hasZigCache: boolean;
  hasSkipFastPath: boolean;
  hasDeterministicFlags: boolean;
  hasReceiptEmission: boolean;
  hasPerShardSlsa: boolean;
  repairedShards: string[];
}

export function validateShardReceipt(receipt: unknown): receipt is ShardReceipt {
  if (!receipt || typeof receipt !== "object") return false;
  const r = receipt as Record<string, unknown>;
  if (r.schema !== "holo-v11.shard-receipt.v1") return false;
  for (const key of ["pkg", "libOut", "repo", "tag", "version"] as const) {
    if (typeof r[key] !== "string" || (r[key] as string).length === 0) return false;
  }
  if (r.deterministic !== true) return false;
  if (!Array.isArray(r.artifacts) || r.artifacts.length === 0) return false;
  for (const art of r.artifacts) {
    if (!art || typeof art !== "object") return false;
    const a = art as Record<string, unknown>;
    if (typeof a.name !== "string" || a.name.length === 0) return false;
    if (typeof a.size !== "number" || !Number.isFinite(a.size) || a.size <= 0) return false;
    if (typeof a.sha512 !== "string" || !/^[0-9a-f]{128}$/.test(a.sha512)) return false;
  }
  return true;
}

function extractMatrixLibs(yml: string): string[] {
  const match = yml.match(/matrix:\s*\r?\n\s*lib:\s*\r?\n((?:\s*-\s*[a-zA-Z0-9_-]+\s*\r?\n)+)/);
  if (!match) return [];
  return match[1]
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim());
}

function extractCaseBlock(yml: string, libKey: string): string {
  const escaped = libKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*${escaped}\\)\\s*$[\\s\\S]*?^\\s*;;\\s*$`, "m");
  const m = yml.match(re);
  return m ? m[0] : "";
}

export function validateTier2Workflow(workflowPath: string): WorkflowValidationResult {
  const yml = fs.readFileSync(workflowPath, "utf8");
  const matrixLibs = extractMatrixLibs(yml);

  if (matrixLibs.length !== EXPECTED_TIER2_LIBS.length) {
    throw new Error(`Expected ${EXPECTED_TIER2_LIBS.length} matrix libs, found ${matrixLibs.length}`);
  }
  for (const lib of EXPECTED_TIER2_LIBS) {
    if (!matrixLibs.includes(lib)) {
      throw new Error(`Missing matrix lib: ${lib}`);
    }
  }

  const hasForceRebuildInput =
    /force_rebuild:\s*\r?\n[\s\S]*?type:\s*boolean\s*\r?\n\s*default:\s*false/.test(yml);
  if (!hasForceRebuildInput) {
    throw new Error("Missing workflow_dispatch.inputs.force_rebuild (type: boolean, default: false)");
  }

  const hasZigCache =
    yml.includes("uses: actions/cache@v4") &&
    yml.includes("path: ~/.cache/zig") &&
    yml.includes("key: ${{ runner.os }}-zig-0.14.0-${{ matrix.lib }}-${{ hashFiles('.github/workflows/holo-5os-tier2-shards.yml') }}") &&
    yml.includes("${{ runner.os }}-zig-0.14.0-${{ matrix.lib }}-");
  if (!hasZigCache) {
    throw new Error("Missing actions/cache@v4 configuration for ~/.cache/zig");
  }

  const hasSkipFastPath =
    yml.includes("SKIP: ${LIB_KEY} ${UP_VER} already materialized") &&
    yml.includes("skipped=true") &&
    yml.includes("steps.build.outputs.skipped != 'true'");
  if (!hasSkipFastPath) {
    throw new Error("Missing skip-unchanged-shard check or skipped != 'true' guards");
  }

  const hasDeterministicFlags =
    yml.includes("-ffile-prefix-map=$PWD=.") &&
    yml.includes("-Wl,--build-id=none");
  if (!hasDeterministicFlags) {
    throw new Error("Missing deterministic compiler flags (-ffile-prefix-map=$PWD=. / -Wl,--build-id=none)");
  }

  // Ensure every non-helper zig cc / zig c++ invocation uses $DET_FLAGS or $DET_LINUX_FLAGS
  const zigLines = yml
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^zig c(\+\+|c)\s+-target\s+/.test(line) && !line.includes("/tmp/dlprobe.c"));
  for (const line of zigLines) {
    const isLinux = line.includes("linux-gnu");
    if (isLinux && !line.includes("$DET_LINUX_FLAGS")) {
      throw new Error(`Linux zig invocation missing $DET_LINUX_FLAGS: ${line}`);
    }
    if (!isLinux && !line.includes("$DET_FLAGS")) {
      throw new Error(`Non-Linux zig invocation missing $DET_FLAGS: ${line}`);
    }
  }

  const hasReceiptEmission =
    yml.includes("holo-v11.shard-receipt.v1") &&
    yml.includes("${process.env.LIB_OUT}-receipt.json") &&
    yml.includes("gh release upload \"$TAG\" dist/* --repo awesome-os/upstream-mirrors --clobber");
  if (!hasReceiptEmission) {
    throw new Error("Missing canonical per-shard receipt generation or release upload");
  }

  const hasPerShardSlsa =
    /if:\s*\$\{\{\s*steps\.build\.outputs\.skipped\s*!=\s*'true'\s*\}\}[\s\S]*?uses:\s*actions\/attest-build-provenance@v2/.test(
      yml
    );
  if (!hasPerShardSlsa) {
    throw new Error("Missing guarded per-shard actions/attest-build-provenance@v2 step");
  }

  // Validate all 6 repaired Tier-2 shards
  const mbedBlock = extractCaseBlock(yml, "mbedtls");
  if (
    !mbedBlock.includes("[ -d src/tf-psa-crypto ] || [ ! -f src/library/aes.c ]") ||
    !mbedBlock.includes("/tmp/mbed_wasi_config.h") ||
    !mbedBlock.includes("#undef MBEDTLS_NET_C") ||
    !mbedBlock.includes('-DMBEDTLS_CONFIG_FILE=\'"/tmp/mbed_wasi_config.h"\'')
  ) {
    throw new Error("mbedtls shard missing v3.6.8 fallback or WASI config header");
  }

  const ng3Block = extractCaseBlock(yml, "nghttp3");
  if (
    !ng3Block.includes("--recurse-submodules --shallow-submodules") ||
    !ng3Block.includes("-DHAVE_WINSOCK2_H=1") ||
    !ng3Block.includes("-DHAVE_ARPA_INET_H=1 -DHAVE_NETINET_IN_H=1")
  ) {
    throw new Error("nghttp3 shard missing --recurse-submodules or platform endian/net headers");
  }

  const caresBlock = extractCaseBlock(yml, "c-ares");
  const caresConfigSection = caresBlock.split("cat > /tmp/cares_inc/ares_config.h")[1] || "";
  const caresWin32 = (caresConfigSection.split("#if defined(_WIN32)")[1] || "").split("#else")[0] || "";
  if (
    caresWin32.includes("HAVE_STRCMPI") ||
    caresWin32.includes("HAVE_STRNCMPI") ||
    !caresWin32.includes("HAVE_STRCASECMP 1") ||
    !caresWin32.includes("HAVE_STRNCASECMP 1") ||
    !caresWin32.includes("HAVE_STRINGS_H 1") ||
    !caresBlock.includes("cares_apple_stub.c") ||
    !caresBlock.includes("! -name 'ares_sysconfig_mac.c'")
  ) {
    throw new Error("c-ares shard _WIN32 config or macOS sysconfig stub is invalid");
  }

  const pngBlock = extractCaseBlock(yml, "libpng");
  if (
    !pngBlock.includes("sed -i -E '/PNG_SETJMP_SUPPORTED|PNG_SIMPLIFIED_READ_SUPPORTED|PNG_SIMPLIFIED_WRITE_SUPPORTED/d' src/pnglibconf.h")
  ) {
    throw new Error("libpng shard missing in-place WASI pnglibconf.h setjmp/simplified removal");
  }

  const ftBlock = extractCaseBlock(yml, "freetype");
  for (const extraSrc of [
    "src/src/base/ftbitmap.c",
    "src/src/base/ftmm.c",
    "src/src/gzip/ftgzip.c",
    "src/src/base/ftglyph.c",
    "src/src/base/ftstroke.c",
    "src/src/base/ftbbox.c",
    "/tmp/ft_wasi_inc/setjmp.h",
    "-I/tmp/ft_wasi_inc $FT_FLAGS",
  ]) {
    if (!ftBlock.includes(extraSrc)) {
      throw new Error(`freetype shard missing ${extraSrc}`);
    }
  }

  const zngBlock = extractCaseBlock(yml, "zlib-ng");
  if (zngBlock.includes("-DZLIB_INTERNAL")) {
    throw new Error("zlib-ng shard must not pass -DZLIB_INTERNAL");
  }

  return {
    matrixLibs,
    hasForceRebuildInput,
    hasZigCache,
    hasSkipFastPath,
    hasDeterministicFlags,
    hasReceiptEmission,
    hasPerShardSlsa,
    repairedShards: ["mbedtls", "nghttp3", "c-ares", "libpng", "freetype", "zlib-ng"],
  };
}

function validateTierShardWorkflow(
  workflowPath: string,
  expectedLibs: readonly string[],
  workflowRelPath: string,
  tierLabel: string
): WorkflowValidationResult {
  const yml = fs.readFileSync(workflowPath, "utf8");
  const matrixLibs = extractMatrixLibs(yml);

  if (matrixLibs.length !== expectedLibs.length) {
    throw new Error(`Expected ${expectedLibs.length} ${tierLabel} matrix libs, found ${matrixLibs.length}`);
  }
  for (const lib of expectedLibs) {
    if (!matrixLibs.includes(lib)) {
      throw new Error(`Missing ${tierLabel} matrix lib: ${lib}`);
    }
  }

  const hasForceRebuildInput =
    /force_rebuild:\s*\r?\n[\s\S]*?type:\s*boolean\s*\r?\n\s*default:\s*false/.test(yml);
  if (!hasForceRebuildInput) {
    throw new Error(`${tierLabel} missing workflow_dispatch.inputs.force_rebuild (type: boolean, default: false)`);
  }

  const hasZigCache =
    yml.includes("uses: actions/cache@v4") &&
    yml.includes("path: ~/.cache/zig") &&
    yml.includes(`key: \${{ runner.os }}-zig-0.14.0-\${{ matrix.lib }}-\${{ hashFiles('${workflowRelPath}') }}`) &&
    yml.includes("${{ runner.os }}-zig-0.14.0-${{ matrix.lib }}-");
  if (!hasZigCache) {
    throw new Error(`${tierLabel} missing actions/cache@v4 configuration for ~/.cache/zig`);
  }

  const hasSkipFastPath =
    yml.includes("SKIP: ${LIB_KEY} ${UP_VER} already materialized") &&
    yml.includes("skipped=true") &&
    yml.includes("steps.build.outputs.skipped != 'true'");
  if (!hasSkipFastPath) {
    throw new Error(`${tierLabel} missing skip-unchanged-shard check or skipped != 'true' guards`);
  }

  const hasDeterministicFlags =
    yml.includes("-ffile-prefix-map=$PWD=.") &&
    yml.includes("-Wl,--build-id=none");
  if (!hasDeterministicFlags) {
    throw new Error(`${tierLabel} missing deterministic compiler flags (-ffile-prefix-map=$PWD=. / -Wl,--build-id=none)`);
  }

  const zigLines = yml
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^zig c(\+\+|c)\s+-target\s+/.test(line) && !line.includes("/tmp/dlprobe.c"));
  for (const line of zigLines) {
    const isLinux = line.includes("linux-gnu");
    if (isLinux && !line.includes("$DET_LINUX_FLAGS")) {
      throw new Error(`${tierLabel} Linux zig invocation missing $DET_LINUX_FLAGS: ${line}`);
    }
    if (!isLinux && !line.includes("$DET_FLAGS")) {
      throw new Error(`${tierLabel} Non-Linux zig invocation missing $DET_FLAGS: ${line}`);
    }
  }

  const hasReceiptEmission =
    yml.includes("holo-v11.shard-receipt.v1") &&
    yml.includes("${process.env.LIB_OUT}-receipt.json") &&
    yml.includes("gh release upload \"$TAG\" dist/* --repo awesome-os/upstream-mirrors --clobber") &&
    yml.includes("WebAssembly.validate(buf)");
  if (!hasReceiptEmission) {
    throw new Error(`${tierLabel} missing canonical per-shard receipt generation, release upload, or WebAssembly.validate`);
  }

  const hasPerShardSlsa =
    /if:\s*\$\{\{\s*steps\.build\.outputs\.skipped\s*!=\s*'true'\s*\}\}[\s\S]*?uses:\s*actions\/attest-build-provenance@v2/.test(
      yml
    );
  if (!hasPerShardSlsa) {
    throw new Error(`${tierLabel} missing guarded per-shard actions/attest-build-provenance@v2 step`);
  }

  for (const lib of expectedLibs) {
    const block = extractCaseBlock(yml, lib);
    if (!block) {
      throw new Error(`${tierLabel} missing case block for ${lib}`);
    }
  }

  return {
    matrixLibs,
    hasForceRebuildInput,
    hasZigCache,
    hasSkipFastPath,
    hasDeterministicFlags,
    hasReceiptEmission,
    hasPerShardSlsa,
    repairedShards: [...expectedLibs],
  };
}

export function validateTier3Workflow(workflowPath: string): WorkflowValidationResult {
  return validateTierShardWorkflow(
    workflowPath,
    EXPECTED_TIER3_LIBS,
    ".github/workflows/holo-5os-tier3-shards.yml",
    "Tier-3"
  );
}

export function validateTier4Workflow(workflowPath: string): WorkflowValidationResult {
  return validateTierShardWorkflow(
    workflowPath,
    EXPECTED_TIER4_LIBS,
    ".github/workflows/holo-5os-tier4-shards.yml",
    "Tier-4"
  );
}

export function resolveZigBinary(): string | null {
  const candidates: string[] = [];
  if (process.env.ZIG_BIN) candidates.push(process.env.ZIG_BIN);
  if (process.platform === "win32") {
    candidates.push("E:\\awesome-os\\bin\\zig.cmd");
  }
  for (const cand of candidates) {
    if (fs.existsSync(cand)) return cand;
  }
  try {
    execFileSync("zig", ["version"], { stdio: "ignore" });
    return "zig";
  } catch {
    return null;
  }
}

export interface DryCompileResult {
  workDir: string;
  artifacts: ShardReceiptArtifact[];
  receipt: ShardReceipt;
}

export function dryCompileC11FiveTargets(zigBin: string, libName = "holo_smoke"): DryCompileResult {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "holo-5os-dry-"));
  const srcPath = path.join(workDir, "smoke.c");
  const distDir = path.join(workDir, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(
    srcPath,
    [
      "#include <stdint.h>",
      "int32_t holo_smoke_add(int32_t a, int32_t b) { return a + b; }",
      "",
    ].join("\n"),
    "utf8"
  );

  const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(zigBin);
  const detPrefixFlag = `-ffile-prefix-map=${workDir}=.`;
  const artifacts: ShardReceiptArtifact[] = [];

  for (const entry of FIVE_OS_TARGETS) {
    const outFileName = `${libName}-${entry.ext}`;
    const outPath = path.join(distDir, outFileName);
    const args: string[] = ["cc", "-target", entry.target, "-O2", "-std=c11", detPrefixFlag];

    if (entry.kind === "wasi") {
      args.push("-mexec-model=reactor");
    } else if (entry.kind === "linux-shared") {
      args.push("-shared", "-fPIC", "-s", "-Wl,--build-id=none");
    } else if (entry.target === "x86_64-windows-gnu") {
      args.push("-shared", "-s", `-Wl,--out-implib,${path.join(distDir, `${libName}-win64.dll.a`)}`);
    } else {
      args.push("-shared", "-fPIC");
    }

    args.push(srcPath, "-o", outPath);
    if (useShell) {
      execFileSync("cmd.exe", ["/d", "/c", zigBin, ...args], {
        cwd: workDir,
        stdio: "pipe",
      });
    } else {
      execFileSync(zigBin, args, {
        cwd: workDir,
        stdio: "pipe",
      });
    }

    const buf = fs.readFileSync(outPath);
    artifacts.push({
      name: outFileName,
      size: buf.length,
      sha512: createHash("sha512").update(buf).digest("hex"),
    });
  }

  const implibPath = path.join(distDir, `${libName}-win64.dll.a`);
  if (fs.existsSync(implibPath)) {
    const implibBuf = fs.readFileSync(implibPath);
    artifacts.push({
      name: `${libName}-win64.dll.a`,
      size: implibBuf.length,
      sha512: createHash("sha512").update(implibBuf).digest("hex"),
    });
  }

  artifacts.sort((a, b) => a.name.localeCompare(b.name));

  const receipt: ShardReceipt = {
    schema: "holo-v11.shard-receipt.v1",
    pkg: libName,
    libOut: libName,
    repo: "awesome-os/upstream-mirrors",
    tag: "local-smoke",
    version: "1.0.0",
    deterministic: true,
    artifacts,
  };

  return { workDir, artifacts, receipt };
}

const isMain =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

if (isMain) {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
  const workflowPath = path.join(repoRoot, ".github", "workflows", "holo-5os-tier2-shards.yml");
  const summary = validateTier2Workflow(workflowPath);
  console.log("Workflow validation OK:", JSON.stringify(summary));
  const zigBin = resolveZigBinary();
  if (zigBin) {
    const res = dryCompileC11FiveTargets(zigBin);
    try {
      console.log(`5-OS C11 dry-compile OK via ${zigBin}: ${res.artifacts.length} artifacts`);
    } finally {
      fs.rmSync(res.workDir, { recursive: true, force: true });
    }
  } else {
    console.log("Zig binary not found on host; skipped C11 dry-compile.");
  }
}
