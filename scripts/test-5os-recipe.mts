import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TIER1_LIBS } from "../.github/workflows/holo-5os-max-shards.mts";
import { TIER2_LIBS } from "../.github/workflows/holo-5os-tier2-shards.mts";
import { TIER3_LIBS } from "../.github/workflows/holo-5os-tier3-shards.mts";
import { TIER4_LIBS } from "../.github/workflows/holo-5os-tier4-shards.mts";
import { TIER5_LIBS } from "../.github/workflows/holo-5os-tier5-shards.mts";
import { LEGACY_5OS_ENGINES } from "../.github/workflows/holo-4os-shards.mts";
import { SPARSE_MIRRORS } from "../.github/workflows/sync-sparse-mirrors.mts";
import { detFlagsForTarget } from "../.github/workflows/holo-workflow-runtime.mts";

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

export const EXPECTED_TIER5_LIBS = [
  "vulkan-headers",
  "spirv-headers",
  "cccl",
  "cutlass",
  "dav1d",
  "librdkafka",
  "libsdl3",
  "re2",
  "spirv-tools",
  "glslang",
  "ffmpeg",
  "meson",
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
  hasCompanionMts: boolean;
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

function validateTierShardWorkflow(
  workflowPath: string,
  expectedLibs: readonly string[],
  exportedLibs: readonly string[],
  workflowRelPath: string,
  tierLabel: string
): WorkflowValidationResult {
  const yml = fs.readFileSync(workflowPath, "utf8");
  const mtsRelPath = workflowRelPath.replace(/\.yml$/, ".mts");
  const mtsPath = workflowPath.replace(/\.yml$/, ".mts");
  if (!fs.existsSync(mtsPath)) {
    throw new Error(`${tierLabel} missing companion .mts file: ${mtsPath}`);
  }
  const mts = fs.readFileSync(mtsPath, "utf8");
  const runtimePath = path.join(path.dirname(workflowPath), "holo-workflow-runtime.mts");
  const runtime = fs.readFileSync(runtimePath, "utf8");

  const matrixLibs = extractMatrixLibs(yml);
  if (matrixLibs.length !== expectedLibs.length) {
    throw new Error(`Expected ${expectedLibs.length} ${tierLabel} matrix libs, found ${matrixLibs.length}`);
  }
  for (const lib of expectedLibs) {
    if (!matrixLibs.includes(lib)) {
      throw new Error(`Missing ${tierLabel} matrix lib: ${lib}`);
    }
    if (!exportedLibs.includes(lib)) {
      throw new Error(`Missing ${tierLabel} exported .mts lib: ${lib}`);
    }
    if (!mts.includes(`case "${lib}"`)) {
      throw new Error(`${tierLabel} .mts missing case block for ${lib}`);
    }
  }

  const hasForceRebuildInput =
    /force_rebuild:\s*\r?\n[\s\S]*?type:\s*boolean\s*\r?\n\s*default:\s*false/.test(yml);
  if (!hasForceRebuildInput) {
    throw new Error(`${tierLabel} missing workflow_dispatch.inputs.force_rebuild (type: boolean, default: false)`);
  }

  const hasZigCache =
    yml.includes("uses: actions/cache@v6") &&
    yml.includes("path: ~/.cache/zig") &&
    yml.includes(`key: \${{ runner.os }}-zig-0.14.0-\${{ matrix.lib }}-\${{ hashFiles('${workflowRelPath}', '${mtsRelPath}') }}`) &&
    yml.includes("${{ runner.os }}-zig-0.14.0-${{ matrix.lib }}-");
  if (!hasZigCache) {
    throw new Error(`${tierLabel} missing actions/cache@v6 configuration for ~/.cache/zig`);
  }

  const hasCompanionMts =
    yml.includes("node-version: '26'") &&
    yml.includes(`node ${mtsRelPath} resolve`) &&
    yml.includes(`node ${mtsRelPath} build`) &&
    yml.includes(`node ${mtsRelPath} finalize`) &&
    !yml.includes("node -e");
  if (!hasCompanionMts) {
    throw new Error(`${tierLabel} .yml must delegate to ${mtsRelPath} using Node 26 without inline node -e`);
  }

  const hasSkipFastPath =
    runtime.includes("SKIP: ${libKey} ${upVer} already materialized") &&
    runtime.includes('skipped: "true"') &&
    yml.includes("steps.build.outputs.skipped != 'true'");
  if (!hasSkipFastPath) {
    throw new Error(`${tierLabel} missing skip-unchanged-shard check or skipped != 'true' guards`);
  }

  const linuxDet = detFlagsForTarget("x86_64-linux-gnu", "/w");
  const winDet = detFlagsForTarget("x86_64-windows-gnu", "/w");
  const hasDeterministicFlags =
    linuxDet.includes("-ffile-prefix-map=/w=.") &&
    linuxDet.includes("-Wl,--build-id=none") &&
    winDet.includes("-ffile-prefix-map=/w=.") &&
    !winDet.includes("-Wl,--build-id=none");
  if (!hasDeterministicFlags) {
    throw new Error(`${tierLabel} detFlagsForTarget failed deterministic flag invariant`);
  }

  const hasReceiptEmission =
    runtime.includes("holo-v11.shard-receipt.v1") &&
    runtime.includes("`${opts.libOut}-receipt.json`") &&
    yml.includes('gh release upload "$TAG" dist/* --repo awesome-os/upstream-mirrors --clobber') &&
    runtime.includes("WebAssembly.validate(buf)");
  if (!hasReceiptEmission) {
    throw new Error(`${tierLabel} missing canonical per-shard receipt generation, release upload, or WebAssembly.validate`);
  }

  const hasPerShardSlsa =
    /if:\s*\$\{\{\s*steps\.build\.outputs\.skipped\s*!=\s*'true'\s*\}\}[\s\S]*?uses:\s*actions\/attest-build-provenance@v4/.test(
      yml
    );
  if (!hasPerShardSlsa) {
    throw new Error(`${tierLabel} missing guarded per-shard actions/attest-build-provenance@v4 step`);
  }

  return {
    matrixLibs,
    hasForceRebuildInput,
    hasZigCache,
    hasSkipFastPath,
    hasDeterministicFlags,
    hasReceiptEmission,
    hasPerShardSlsa,
    hasCompanionMts,
    repairedShards: [...expectedLibs],
  };
}

export function validateTier2Workflow(workflowPath: string): WorkflowValidationResult {
  const res = validateTierShardWorkflow(
    workflowPath,
    EXPECTED_TIER2_LIBS,
    TIER2_LIBS,
    ".github/workflows/holo-5os-tier2-shards.yml",
    "Tier-2"
  );
  const mts = fs.readFileSync(workflowPath.replace(/\.yml$/, ".mts"), "utf8");
  for (const snippet of [
    "src/tf-psa-crypto",
    "/tmp/mbed_wasi_config.h",
    "#undef MBEDTLS_NET_C",
    "recurseSubmodules: true",
    "-DHAVE_WINSOCK2_H=1",
    "-DHAVE_ARPA_INET_H=1",
    "cares_apple_stub.c",
    "PNG_SETJMP_SUPPORTED",
    "src/src/base/ftbitmap.c",
    "/tmp/ft_wasi_inc/setjmp.h",
  ]) {
    if (!mts.includes(snippet)) {
      throw new Error(`Tier-2 .mts missing repaired shard invariant: ${snippet}`);
    }
  }
  if (mts.includes("-DZLIB_INTERNAL")) {
    throw new Error("Tier-2 zlib-ng shard must not pass -DZLIB_INTERNAL");
  }
  return { ...res, repairedShards: ["mbedtls", "nghttp3", "c-ares", "libpng", "freetype", "zlib-ng"] };
}

export function validateTier3Workflow(workflowPath: string): WorkflowValidationResult {
  return validateTierShardWorkflow(
    workflowPath,
    EXPECTED_TIER3_LIBS,
    TIER3_LIBS,
    ".github/workflows/holo-5os-tier3-shards.yml",
    "Tier-3"
  );
}

export function validateTier4Workflow(workflowPath: string): WorkflowValidationResult {
  return validateTierShardWorkflow(
    workflowPath,
    EXPECTED_TIER4_LIBS,
    TIER4_LIBS,
    ".github/workflows/holo-5os-tier4-shards.yml",
    "Tier-4"
  );
}

export function validateTier5Workflow(workflowPath: string): WorkflowValidationResult {
  return validateTierShardWorkflow(
    workflowPath,
    EXPECTED_TIER5_LIBS,
    TIER5_LIBS,
    ".github/workflows/holo-5os-tier5-shards.yml",
    "Tier-5"
  );
}

export function validateAllWorkflowPairs(workflowsDir: string): string[] {
  const ymls = fs
    .readdirSync(workflowsDir)
    .filter((f) => f.endsWith(".yml") && f !== "holo-ci.yml")
    .sort();
  const checked: string[] = [];
  for (const ymlName of ymls) {
    const base = ymlName.replace(/\.yml$/, "");
    const mtsPath = path.join(workflowsDir, `${base}.mts`);
    if (!fs.existsSync(mtsPath)) {
      throw new Error(`Workflow ${ymlName} missing companion ${base}.mts`);
    }
    const yml = fs.readFileSync(path.join(workflowsDir, ymlName), "utf8");
    if (!yml.includes("node-version: '26'")) {
      throw new Error(`Workflow ${ymlName} must specify node-version: '26'`);
    }
    if (!yml.includes(`.github/workflows/${base}.mts`)) {
      throw new Error(`Workflow ${ymlName} must invoke .github/workflows/${base}.mts`);
    }
    checked.push(base);
  }
  if (TIER1_LIBS.length !== 14) throw new Error("Expected 14 Tier-1 libs");
  if (LEGACY_5OS_ENGINES.length !== 7) throw new Error("Expected 7 legacy 5-OS engines");
  if (SPARSE_MIRRORS.length !== 26) throw new Error("Expected 26 sparse mirrors");
  return checked;
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
      execFileSync("cmd.exe", ["/d", "/c", zigBin, ...args], { cwd: workDir, stdio: "pipe" });
    } else {
      execFileSync(zigBin, args, { cwd: workDir, stdio: "pipe" });
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
