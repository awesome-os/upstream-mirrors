import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyBinaryMagic } from "../.github/workflows/holo-workflow-runtime.mts";
import { TIER6_KIND_MAP } from "../.github/workflows/holo-5os-tier6-shards.mts";
import {
  EXPECTED_TIER2_LIBS,
  EXPECTED_TIER3_LIBS,
  EXPECTED_TIER4_LIBS,
  EXPECTED_TIER5_LIBS,
  EXPECTED_TIER6_LIBS,
  dryCompileC11FiveTargets,
  resolveZigBinary,
  validateAllWorkflowPairs,
  validateShardReceipt,
  validateTier2Workflow,
  validateTier3Workflow,
  validateTier4Workflow,
  validateTier5Workflow,
  validateTier6Workflow,
} from "./test-5os-recipe.mts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const WORKFLOWS_DIR = path.join(REPO_ROOT, ".github", "workflows");
const WORKFLOW_PATH = path.join(WORKFLOWS_DIR, "holo-5os-tier2-shards.yml");
const TIER3_WORKFLOW_PATH = path.join(WORKFLOWS_DIR, "holo-5os-tier3-shards.yml");
const TIER4_WORKFLOW_PATH = path.join(WORKFLOWS_DIR, "holo-5os-tier4-shards.yml");
const TIER5_WORKFLOW_PATH = path.join(WORKFLOWS_DIR, "holo-5os-tier5-shards.yml");
const TIER6_WORKFLOW_PATH = path.join(WORKFLOWS_DIR, "holo-5os-tier6-shards.yml");

test("all non-reusable workflows are paired *.yml + *.mts targeting Node 26+ and <= 125 lines", () => {
  const checked = validateAllWorkflowPairs(WORKFLOWS_DIR);
  assert.deepEqual(checked, [
    "holo-4os-shards",
    "holo-5os-max-shards",
    "holo-5os-tier2-shards",
    "holo-5os-tier3-shards",
    "holo-5os-tier4-shards",
    "holo-5os-tier5-shards",
    "holo-5os-tier6-shards",
    "sync-sparse-mirrors",
  ]);
});

test("holo-5os-tier2-shards passes matrix, cache, skip-fastpath, deterministic flags, companion .mts, and all 6 shard repairs", () => {
  const result = validateTier2Workflow(WORKFLOW_PATH);
  assert.deepEqual(result.matrixLibs, [...EXPECTED_TIER2_LIBS]);
  assert.equal(result.hasForceRebuildInput, true);
  assert.equal(result.hasZigCache, true);
  assert.equal(result.hasSkipFastPath, true);
  assert.equal(result.hasDeterministicFlags, true);
  assert.equal(result.hasReceiptEmission, true);
  assert.equal(result.hasPerShardSlsa, true);
  assert.equal(result.hasCompanionMts, true);
  assert.equal(result.repairedShards.length, 6);
});

test("holo-5os-tier3-shards passes 8-lib matrix, cache, skip-fastpath, deterministic flags, companion .mts, WebAssembly.validate, and SLSA", () => {
  const result = validateTier3Workflow(TIER3_WORKFLOW_PATH);
  assert.deepEqual(result.matrixLibs, [...EXPECTED_TIER3_LIBS]);
  assert.equal(result.hasForceRebuildInput, true);
  assert.equal(result.hasZigCache, true);
  assert.equal(result.hasSkipFastPath, true);
  assert.equal(result.hasDeterministicFlags, true);
  assert.equal(result.hasReceiptEmission, true);
  assert.equal(result.hasPerShardSlsa, true);
  assert.equal(result.hasCompanionMts, true);
  assert.equal(result.repairedShards.length, 8);
});

test("holo-5os-tier4-shards passes 10-lib matrix, cache, skip-fastpath, deterministic flags, companion .mts, WebAssembly.validate, and SLSA", () => {
  const result = validateTier4Workflow(TIER4_WORKFLOW_PATH);
  assert.deepEqual(result.matrixLibs, [...EXPECTED_TIER4_LIBS]);
  assert.equal(result.hasForceRebuildInput, true);
  assert.equal(result.hasZigCache, true);
  assert.equal(result.hasSkipFastPath, true);
  assert.equal(result.hasDeterministicFlags, true);
  assert.equal(result.hasReceiptEmission, true);
  assert.equal(result.hasPerShardSlsa, true);
  assert.equal(result.hasCompanionMts, true);
  assert.equal(result.repairedShards.length, 10);
});

test("holo-5os-tier5-shards passes 12-lib matrix, cache, skip-fastpath, deterministic flags, companion .mts, WebAssembly.validate, and SLSA", () => {
  const result = validateTier5Workflow(TIER5_WORKFLOW_PATH);
  assert.deepEqual(result.matrixLibs, [...EXPECTED_TIER5_LIBS]);
  assert.ok(result.lineCount <= 120, `expected <= 120 lines, got ${result.lineCount}`);
  assert.equal(result.hasForceRebuildInput, true);
  assert.equal(result.hasZigCache, true);
  assert.equal(result.hasSkipFastPath, true);
  assert.equal(result.hasDeterministicFlags, true);
  assert.equal(result.hasReceiptEmission, true);
  assert.equal(result.hasPerShardSlsa, true);
  assert.equal(result.hasCompanionMts, true);
  assert.equal(result.repairedShards.length, 12);
});

test("holo-5os-tier6-shards passes 11-lib matrix, <= 120 lines, and honest kind breakdown", () => {
  const result = validateTier6Workflow(TIER6_WORKFLOW_PATH);
  assert.deepEqual(result.matrixLibs, [...EXPECTED_TIER6_LIBS]);
  assert.ok(result.lineCount <= 120, `expected <= 120 lines, got ${result.lineCount}`);
  assert.equal(result.hasForceRebuildInput, true);
  assert.equal(result.hasZigCache, true);
  assert.equal(result.hasSkipFastPath, true);
  assert.equal(result.hasDeterministicFlags, true);
  assert.equal(result.hasReceiptEmission, true);
  assert.equal(result.hasPerShardSlsa, true);
  assert.equal(result.hasCompanionMts, true);
  assert.equal(result.repairedShards.length, 11);

  const counts = Object.values(TIER6_KIND_MAP).reduce<Record<string, number>>((acc, k) => {
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(counts, { "runtime-library": 5, "cli-tool": 1, "header-abi-probe": 5 });
});

test("verifyBinaryMagic validates ELF64, PE32+, Mach-O64, and WASM headers and rejects corrupt files", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "holo-magic-test-"));
  try {
    const elf = Buffer.alloc(64);
    elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
    elf.writeUInt16LE(0x3e, 18);
    fs.writeFileSync(path.join(tmpDir, "ok.so"), elf);
    assert.deepEqual(verifyBinaryMagic(path.join(tmpDir, "ok.so")), {
      name: "ok.so",
      ok: true,
      format: "elf64",
      arch: "x86_64",
    });

    const badElf = Buffer.from(elf);
    badElf[4] = 1; // ELF32 should fail
    fs.writeFileSync(path.join(tmpDir, "bad32.so"), badElf);
    assert.equal(verifyBinaryMagic(path.join(tmpDir, "bad32.so")).ok, false);

    const pe = Buffer.alloc(0x80);
    pe.writeUInt16LE(0x5a4d, 0);
    pe.writeUInt32LE(0x40, 0x3c);
    pe.write("PE\0\0", 0x40, "ascii");
    pe.writeUInt16LE(0x8664, 0x44);
    fs.writeFileSync(path.join(tmpDir, "ok.dll"), pe);
    assert.deepEqual(verifyBinaryMagic(path.join(tmpDir, "ok.dll")), {
      name: "ok.dll",
      ok: true,
      format: "pe32+",
      arch: "x86_64",
    });

    const badPe = Buffer.from(pe);
    badPe.writeUInt16LE(0x014c, 0x44); // x86 32-bit should fail
    fs.writeFileSync(path.join(tmpDir, "bad32.dll"), badPe);
    assert.equal(verifyBinaryMagic(path.join(tmpDir, "bad32.dll")).ok, false);

    const macho = Buffer.alloc(32);
    macho.writeUInt32BE(0xcffaedfe, 0);
    macho.writeUInt32LE(0x0100000c, 4);
    fs.writeFileSync(path.join(tmpDir, "ok.dylib"), macho);
    assert.deepEqual(verifyBinaryMagic(path.join(tmpDir, "ok.dylib")), {
      name: "ok.dylib",
      ok: true,
      format: "macho64",
      arch: "arm64",
    });

    const fatMacho = Buffer.alloc(32);
    fatMacho.writeUInt32BE(0xcafebabe, 0);
    fs.writeFileSync(path.join(tmpDir, "fat.dylib"), fatMacho);
    assert.equal(verifyBinaryMagic(path.join(tmpDir, "fat.dylib")).ok, true);

    const wasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    fs.writeFileSync(path.join(tmpDir, "ok.wasm"), wasm);
    assert.deepEqual(verifyBinaryMagic(path.join(tmpDir, "ok.wasm")), {
      name: "ok.wasm",
      ok: true,
      format: "wasm32",
      arch: "wasm32-wasi",
    });

    const badWasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0xff, 0xff, 0xff, 0xff]);
    fs.writeFileSync(path.join(tmpDir, "bad.wasm"), badWasm);
    assert.equal(verifyBinaryMagic(path.join(tmpDir, "bad.wasm")).ok, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("validateShardReceipt enforces holo-v11.shard-receipt.v1 schema", () => {
  const valid = {
    schema: "holo-v11.shard-receipt.v1",
    pkg: "zlib-ng",
    libOut: "libzlib-ng",
    repo: "zlib-ng/zlib-ng",
    tag: "2.3.3",
    version: "2.3.3",
    deterministic: true,
    artifacts: [
      {
        name: "libzlib-ng-wasm32-wasi.wasm",
        size: 1024,
        sha512: "a".repeat(128),
      },
    ],
  };
  assert.equal(validateShardReceipt(valid), true);
  assert.equal(validateShardReceipt({ ...valid, deterministic: false }), false);
  assert.equal(validateShardReceipt({ ...valid, artifacts: [] }), false);
  assert.equal(
    validateShardReceipt({
      ...valid,
      artifacts: [{ name: "x.wasm", size: 10, sha512: "bad" }],
    }),
    false
  );
});

test("local C11 5-OS dry-compile produces valid PE/ELF/Mach-O/WASM binaries when Zig is available", (t) => {
  const zigBin = resolveZigBinary();
  if (!zigBin) {
    t.skip("zig compiler not available in environment");
    return;
  }

  const res = dryCompileC11FiveTargets(zigBin, "holo_smoke");
  try {
    assert.equal(validateShardReceipt(res.receipt), true);
    assert.equal(res.artifacts.length, 6);

    const distDir = path.join(res.workDir, "dist");
    const win64 = fs.readFileSync(path.join(distDir, "holo_smoke-win64.dll"));
    assert.equal(win64.subarray(0, 2).toString("ascii"), "MZ");

    for (const elfName of ["holo_smoke-linux-x64.so", "holo_smoke-linux-arm64.so"]) {
      const elf = fs.readFileSync(path.join(distDir, elfName));
      assert.deepEqual([...elf.subarray(0, 4)], [0x7f, 0x45, 0x4c, 0x46]);
    }

    const mac = fs.readFileSync(path.join(distDir, "holo_smoke-macos-arm64.dylib"));
    assert.deepEqual([...mac.subarray(0, 4)], [0xcf, 0xfa, 0xed, 0xfe]);

    const wasm = fs.readFileSync(path.join(distDir, "holo_smoke-wasm32-wasi.wasm"));
    assert.deepEqual([...wasm.subarray(0, 4)], [0x00, 0x61, 0x73, 0x6d]);
  } finally {
    fs.rmSync(res.workDir, { recursive: true, force: true });
  }
});
