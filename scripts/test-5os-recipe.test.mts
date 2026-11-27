import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  EXPECTED_TIER2_LIBS,
  dryCompileC11FiveTargets,
  resolveZigBinary,
  validateShardReceipt,
  validateTier2Workflow,
} from "./test-5os-recipe.mts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const WORKFLOW_PATH = path.join(REPO_ROOT, ".github", "workflows", "holo-5os-tier2-shards.yml");

test("holo-5os-tier2-shards.yml passes matrix, cache, skip-fastpath, deterministic flags, and all 6 shard repairs", () => {
  const result = validateTier2Workflow(WORKFLOW_PATH);
  assert.deepEqual(result.matrixLibs, [...EXPECTED_TIER2_LIBS]);
  assert.equal(result.hasForceRebuildInput, true);
  assert.equal(result.hasZigCache, true);
  assert.equal(result.hasSkipFastPath, true);
  assert.equal(result.hasDeterministicFlags, true);
  assert.equal(result.hasReceiptEmission, true);
  assert.equal(result.hasPerShardSlsa, true);
  assert.equal(result.repairedShards.length, 6);
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
