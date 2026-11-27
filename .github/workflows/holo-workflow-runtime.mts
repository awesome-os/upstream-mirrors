import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface LibraryPin {
  pkg: string;
  libOut: string;
  repo: string;
  tag: string;
  version: string;
  url?: string;
}

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

export interface CompileTargetOptions {
  commonArgs?: string[];
  winArgs?: string[];
  linuxArgs?: string[];
  macArgs?: string[];
  wasiArgs?: string[];
  includeWasi?: boolean;
  cxx?: boolean;
  evex512?: boolean;
  winExportAll?: boolean;
}

export interface ResolvePhaseOptions {
  tier: string;
  releaseNotes: string;
  resolvedFileName: string;
  defaults: Record<string, LibraryPin>;
  postResolve?: (resolved: Record<string, LibraryPin>) => Promise<void>;
}

export interface FinalizePhaseOptions {
  tierTitle: string;
  resolvedArtifactName: string;
  resolvedFileName: string;
  sumArtifactPrefix: string;
  outSumFileName: string;
}

export const GH_REPO = "awesome-os/upstream-mirrors";
export const TRACKER_URL =
  "https://raw.githubusercontent.com/awesome-os/t2linux-baseline/main/catalog/live-upstream-tracker.json";

export function detFlagsForTarget(target: string, cwd = process.cwd()): string[] {
  const prefixFlag = `-ffile-prefix-map=${cwd}=.`;
  if (target.includes("linux-gnu")) {
    return [prefixFlag, "-Wl,--build-id=none"];
  }
  return [prefixFlag];
}

export function run(
  cmd: string,
  args: readonly string[],
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv; ignoreError?: boolean; quiet?: boolean }
): string {
  try {
    const out = execFileSync(cmd, [...args], {
      cwd: opts?.cwd ?? process.cwd(),
      env: opts?.env ?? process.env,
      encoding: "utf8",
      stdio: opts?.quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
    });
    return typeof out === "string" ? out : "";
  } catch (err) {
    if (opts?.ignoreError) return "";
    throw err;
  }
}

export function runCapture(
  cmd: string,
  args: readonly string[],
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv; ignoreError?: boolean }
): string {
  try {
    return execFileSync(cmd, [...args], {
      cwd: opts?.cwd ?? process.cwd(),
      env: opts?.env ?? process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    if (opts?.ignoreError) return "";
    throw err;
  }
}

export function zigCc(target: string, args: readonly string[], cwd = process.cwd()): void {
  const det = detFlagsForTarget(target, cwd);
  run("zig", ["cc", "-target", target, ...det, ...args], { cwd });
}

export function zigCxx(target: string, args: readonly string[], cwd = process.cwd()): void {
  const det = detFlagsForTarget(target, cwd);
  run("zig", ["c++", "-target", target, ...det, ...args], { cwd });
}

export function compileMultiOs(libOut: string, opts: CompileTargetOptions): void {
  const fn = opts.cxx ? zigCxx : zigCc;
  const common = opts.commonArgs ?? [];
  const winArgs = opts.winArgs ?? [];
  const linuxArgs = opts.linuxArgs ?? [];
  const macArgs = opts.macArgs ?? [];
  const wasiArgs = opts.wasiArgs ?? [];
  const evex = opts.evex512 ? ["-mevex512"] : [];
  const winExport = opts.winExportAll ? ["-Wl,--export-all-symbols"] : [];

  fn("x86_64-windows-gnu", [
    "-O2",
    ...evex,
    "-shared",
    "-s",
    ...winExport,
    ...common,
    ...winArgs,
    "-o",
    `dist/${libOut}-win64.dll`,
    `-Wl,--out-implib,dist/${libOut}-win64.dll.a`,
  ]);

  fn("x86_64-linux-gnu", [
    "-O2",
    ...evex,
    "-shared",
    "-fPIC",
    "-s",
    ...common,
    ...linuxArgs,
    "-o",
    `dist/${libOut}-linux-x64.so`,
  ]);

  fn("aarch64-linux-gnu", [
    "-O2",
    "-shared",
    "-fPIC",
    "-s",
    ...common,
    ...linuxArgs,
    "-o",
    `dist/${libOut}-linux-arm64.so`,
  ]);

  fn("aarch64-macos", [
    "-O2",
    "-shared",
    "-fPIC",
    ...common,
    ...macArgs,
    "-o",
    `dist/${libOut}-macos-arm64.dylib`,
  ]);

  if (opts.includeWasi) {
    fn("wasm32-wasi", [
      "-O2",
      "-mexec-model=reactor",
      ...common,
      ...wasiArgs,
      "-o",
      `dist/${libOut}-wasm32-wasi.wasm`,
    ]);
  }
}

export function cloneTag(
  repo: string,
  tag: string,
  dest = "src",
  opts?: { recurseSubmodules?: boolean }
): void {
  const url = repo.startsWith("gitlab.") ? `https://${repo}.git` : `https://github.com/${repo}.git`;
  const args = ["clone", "--depth=1"];
  if (opts?.recurseSubmodules) {
    args.push("--recurse-submodules", "--shallow-submodules");
  }
  if (tag) {
    args.push("--branch", tag);
  }
  args.push(url, dest);
  run("git", args);
}

export function findFiles(
  dir: string,
  predicate: (relPath: string, name: string) => boolean,
  maxDepth = Number.POSITIVE_INFINITY
): string[] {
  const results: string[] = [];
  function walk(current: string, depth: number): void {
    if (!fs.existsSync(current)) return;
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );
    for (const entry of entries) {
      const full = path.posix.join(current, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) walk(full, depth + 1);
      } else if (entry.isFile() && predicate(full, entry.name)) {
        results.push(full);
      }
    }
  }
  walk(dir, 1);
  return results.sort();
}

export function makeCmakeWrappers(wrapDir: string, zigTarget: string): void {
  fs.mkdirSync(wrapDir, { recursive: true });
  const det = detFlagsForTarget(zigTarget).join(" ");

  const writeExec = (name: string, content: string): void => {
    const p = path.join(wrapDir, name);
    fs.writeFileSync(p, content, "utf8");
    fs.chmodSync(p, 0o755);
  };

  writeExec("cc", `#!/usr/bin/env bash\nexec zig cc -target ${zigTarget} ${det} "$@"\n`);
  writeExec("cxx", `#!/usr/bin/env bash\nexec zig c++ -target ${zigTarget} ${det} "$@"\n`);
  writeExec("ar", "#!/usr/bin/env bash\nexec zig ar \"$@\"\n");
  writeExec("ranlib", "#!/usr/bin/env bash\nexec zig ranlib \"$@\"\n");
  writeExec(
    "windres",
    `#!/usr/bin/env bash
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then out="$arg"; fi
  prev="$arg"
done
if [ -n "$out" ]; then
  exec zig cc -target x86_64-windows-gnu -ffile-prefix-map=$PWD=. -x c -c /dev/null -o "$out"
fi
`
  );
}

export function appendGithubOutput(kv: Record<string, string>): void {
  const outFile = process.env.GITHUB_OUTPUT;
  if (!outFile) return;
  const lines = Object.entries(kv).map(([k, v]) => `${k}=${v}`);
  fs.appendFileSync(outFile, `${lines.join("\n")}\n`, "utf8");
}

export function ensureGithubRelease(tag: string, notes: string): void {
  try {
    execFileSync("gh", ["release", "view", tag, "--repo", GH_REPO], { stdio: "ignore" });
  } catch {
    run("gh", [
      "release",
      "create",
      tag,
      "--repo",
      GH_REPO,
      "--title",
      `Holo v11 Max 5-OS Shared + WASI Libraries (${tag})`,
      "--notes",
      notes,
    ]);
  }
}

export async function resolveVersionsPhase(opts: ResolvePhaseOptions): Promise<void> {
  const tag = process.env.TAG || "v11-max-5os-latest";
  ensureGithubRelease(tag, opts.releaseNotes);

  const resolved: Record<string, LibraryPin> = structuredClone(opts.defaults);
  try {
    const res = await fetch(TRACKER_URL);
    if (res.ok) {
      const tracker = (await res.json()) as {
        libraries?: Array<{ pkg?: string; upstreamTag?: string; upstreamVersion?: string; repo?: string }>;
      };
      const byPkg = new Map((tracker.libraries ?? []).map((x) => [x.pkg, x]));
      for (const cfg of Object.values(resolved)) {
        const hit = byPkg.get(cfg.pkg);
        if (hit?.upstreamTag) {
          cfg.tag = hit.upstreamTag;
          cfg.version = hit.upstreamVersion || hit.upstreamTag.replace(/^v/, "");
          if (hit.repo && hit.repo.includes("/") && !hit.repo.includes("sourceforge.net")) {
            cfg.repo = hit.repo;
          }
        }
      }
    }
  } catch (err) {
    console.warn("[warn] tracker fetch failed, using safe defaults:", (err as Error).message);
  }

  if (opts.postResolve) {
    await opts.postResolve(resolved);
  }

  const payload = {
    schema: "holo-v11.resolved-versions.v1",
    tier: opts.tier,
    resolvedAt: new Date().toISOString(),
    releaseTag: tag,
    libraries: resolved,
  };
  fs.writeFileSync(opts.resolvedFileName, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  appendGithubOutput({
    release_tag: tag,
    versions_json: JSON.stringify(resolved),
  });
  console.log(`Resolved ${Object.keys(resolved).length} ${opts.tier} libraries:`, JSON.stringify(resolved, null, 2));
}

export function checkSkipMaterialized(
  libKey: string,
  libOut: string,
  upVer: string,
  releaseTag: string
): boolean {
  if (process.env.FORCE_REBUILD === "true") return false;
  const skipDir = "/tmp/skip-check";
  fs.mkdirSync(skipDir, { recursive: true });
  const rawAssets = runCapture(
    "gh",
    ["release", "view", releaseTag, "--repo", GH_REPO, "--json", "assets"],
    { ignoreError: true }
  );
  let assetsList: Array<{ name?: string }> = [];
  try {
    assetsList = (JSON.parse(rawAssets || '{"assets":[]}') as { assets?: Array<{ name?: string }> }).assets ?? [];
  } catch {
    assetsList = [];
  }
  const receiptName = `${libOut}-receipt.json`;
  const assetNames = new Set(assetsList.map((a) => a.name).filter((n): n is string => Boolean(n)));
  if (!assetNames.has(receiptName)) return false;

  try {
    run(
      "gh",
      ["release", "download", releaseTag, "--repo", GH_REPO, "-p", receiptName, "-D", skipDir, "--clobber"],
      { quiet: true }
    );
    const receipt = JSON.parse(fs.readFileSync(path.join(skipDir, receiptName), "utf8")) as Partial<ShardReceipt>;
    const ok =
      Boolean(receipt) &&
      receipt.version === upVer &&
      Array.isArray(receipt.artifacts) &&
      receipt.artifacts.length > 0 &&
      receipt.artifacts.every((a) => a && typeof a.name === "string" && assetNames.has(a.name));
    if (ok) {
      appendGithubOutput({ skipped: "true" });
      console.log(`SKIP: ${libKey} ${upVer} already materialized`);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function verifyAndSmokeTest(opts: {
  libKey: string;
  libOut: string;
  dlLdLibraryPath?: string;
  cliBinaries?: readonly string[];
}): void {
  console.log("=== Verifying produced binaries & runtime smoke tests ===");
  const distFiles = fs.readdirSync("dist").sort();
  const artifactPattern = /\.(dll|so|dylib|wasm|dll\.a|exe|pyz)$|-(linux-x64|linux-arm64|macos-arm64)$/;
  for (const name of distFiles) {
    if (!artifactPattern.test(name)) continue;
    const full = path.join("dist", name);
    const stat = fs.statSync(full);
    if (stat.size <= 0) {
      throw new Error(`ERROR: empty artifact ${full}`);
    }
    run("file", [full]);
  }

  const cliSet = new Set(opts.cliBinaries ?? []);
  if (cliSet.has(opts.libKey)) {
    for (const suffix of ["-linux-x64", "-linux-arm64", "-macos-arm64"]) {
      const p = path.join("dist", `${opts.libOut}${suffix}`);
      if (fs.existsSync(p)) fs.chmodSync(p, 0o755);
    }
    const pyz = path.join("dist", `${opts.libOut}.pyz`);
    if (fs.existsSync(pyz)) {
      fs.chmodSync(pyz, 0o755);
      run(`./${pyz}`, ["--version"]);
    }
    const linuxBin = path.join("dist", `${opts.libOut}-linux-x64`);
    if (fs.existsSync(linuxBin)) {
      run(`./${linuxBin}`, ["--version"]);
    }
  } else {
    fs.writeFileSync(
      "/tmp/dlprobe.c",
      `#include <dlfcn.h>
#include <stdio.h>
int main(int argc, char **argv) {
  if (argc < 2) return 2;
  void *h = dlopen(argv[1], RTLD_NOW);
  if (!h) {
    fprintf(stderr, "dlopen(%s) failed: %s\\n", argv[1], dlerror());
    return 1;
  }
  printf("dlopen(%s) OK\\n", argv[1]);
  dlclose(h);
  return 0;
}
`,
      "utf8"
    );
    const hasGcc = Boolean(runCapture("which", ["gcc"], { ignoreError: true }).trim());
    if (hasGcc) {
      run("gcc", ["-O2", "/tmp/dlprobe.c", "-ldl", "-lpthread", "-o", "/tmp/dlprobe"]);
    } else {
      run("zig", ["cc", "-target", "x86_64-linux-gnu", "-O2", "/tmp/dlprobe.c", "-ldl", "-lpthread", "-o", "/tmp/dlprobe"]);
    }
    run("/tmp/dlprobe", [`dist/${opts.libOut}-linux-x64.so`], {
      env: { ...process.env, LD_LIBRARY_PATH: opts.dlLdLibraryPath ?? "" },
    });
  }

  const wasmPath = `dist/${opts.libOut}-wasm32-wasi.wasm`;
  if (fs.existsSync(wasmPath)) {
    const buf = fs.readFileSync(wasmPath);
    if (buf.length < 8 || buf[0] !== 0x00 || buf[1] !== 0x61 || buf[2] !== 0x73 || buf[3] !== 0x6d) {
      throw new Error(`Invalid WASM magic header in ${wasmPath}`);
    }
    if (!WebAssembly.validate(buf)) {
      throw new Error(`WebAssembly.validate failed in ${wasmPath}`);
    }
    console.log("WebAssembly.validate OK:", wasmPath, buf.length, "bytes");
  }
}

export function emitSha512AndReceipt(opts: {
  libKey: string;
  libOut: string;
  repo: string;
  tag: string;
  version: string;
}): void {
  const artifactPattern = /\.(dll|so|dylib|wasm|dll\.a|exe|pyz)$|-(linux-x64|linux-arm64|macos-arm64)$/;
  const files = fs
    .readdirSync("dist")
    .filter((f) => artifactPattern.test(f))
    .sort();

  const sumLines: string[] = [];
  const artifacts: ShardReceiptArtifact[] = [];
  for (const name of files) {
    const buf = fs.readFileSync(path.join("dist", name));
    const sha512 = createHash("sha512").update(buf).digest("hex");
    sumLines.push(`${sha512}  ${name}`);
    artifacts.push({ name, size: buf.length, sha512 });
  }

  fs.writeFileSync(path.join("dist", `SHA512SUMS-${opts.libKey}.txt`), `${sumLines.join("\n")}\n`, "utf8");

  const receipt: ShardReceipt = {
    schema: "holo-v11.shard-receipt.v1",
    pkg: opts.libKey,
    libOut: opts.libOut,
    repo: opts.repo,
    tag: opts.tag,
    version: opts.version,
    deterministic: true,
    artifacts,
  };
  fs.writeFileSync(path.join("dist", `${opts.libOut}-receipt.json`), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  run("ls", ["-lh", "dist/"]);
}

export function finalizeTierSumsPhase(opts: FinalizePhaseOptions): void {
  const root = "/tmp/artifacts";
  const resolvedPath = path.join(root, opts.resolvedFileName.replace(/\.json$/, ""), opts.resolvedFileName);
  const resolved = fs.existsSync(resolvedPath)
    ? ((JSON.parse(fs.readFileSync(resolvedPath, "utf8")) as { libraries?: Record<string, LibraryPin> }).libraries ?? {})
    : {};
  const expected = Object.keys(resolved);

  const sumLines: string[] = [];
  const rows: string[] = [];
  let passedCount = 0;

  for (const lib of expected) {
    const sumFile = path.join(root, `${opts.sumArtifactPrefix}-${lib}`, `SHA512SUMS-${lib}.txt`);
    if (!fs.existsSync(sumFile)) {
      rows.push(`| \`${lib}\` | ${resolved[lib]?.tag ?? "unknown"} | FAILED | - |`);
      continue;
    }
    const lines = fs.readFileSync(sumFile, "utf8").trim().split(/\r?\n/).filter(Boolean);
    const targets: string[] = [];
    for (const line of lines) {
      const [sha, name] = line.trim().split(/\s+/);
      if (!sha || !name || name.endsWith(".txt") || name.endsWith(".json")) continue;
      sumLines.push(`${sha}  ${name}`);
      if (name.endsWith("-win64.dll") || name.endsWith("-win64.exe")) targets.push("win64");
      else if (name.endsWith("-linux-x64.so") || name.endsWith("-linux-x64")) targets.push("linux-x64");
      else if (name.endsWith("-linux-arm64.so") || name.endsWith("-linux-arm64")) targets.push("linux-arm64");
      else if (name.endsWith("-macos-arm64.dylib") || name.endsWith("-macos-arm64")) targets.push("macos-arm64");
      else if (name.endsWith("-wasm32-wasi.wasm")) targets.push("wasm32-wasi");
      else if (name.endsWith(".pyz")) targets.push("pyz");
    }
    passedCount++;
    rows.push(`| \`${lib}\` | ${resolved[lib]?.tag ?? "unknown"} | PASS | ${targets.join(", ")} |`);
  }

  const outPath = `/tmp/${opts.outSumFileName}`;
  if (sumLines.length > 0) {
    fs.writeFileSync(outPath, `${sumLines.join("\n")}\n`, "utf8");
  }
  const tag = process.env.TAG || "v11-max-5os-latest";
  const summary = [
    `## ${opts.tierTitle} (${tag})`,
    "",
    `- **Passed:** ${passedCount}/${expected.length}`,
    "",
    "| Library | Tag | Status | Targets |",
    "| :--- | :--- | :--- | :--- |",
    ...rows,
    "",
  ].join("\n");
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary, "utf8");
  }
  console.log(summary);

  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
    run("gh", ["release", "upload", tag, outPath, "--repo", GH_REPO, "--clobber"]);
  }
}
