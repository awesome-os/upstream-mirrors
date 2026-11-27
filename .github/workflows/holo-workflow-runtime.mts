import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type ShardKind = "runtime-library" | "cli-tool" | "header-abi-probe";

export interface LibraryPin {
  pkg: string;
  libOut: string;
  repo: string;
  tag: string;
  version: string;
  url?: string;
}

export interface VerifiedHeaderInfo {
  name: string;
  ok: boolean;
  format: string;
  arch: string;
  detail?: string;
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
  kind: ShardKind;
  deterministic: boolean;
  verifiedHeaders: {
    passed: number;
    total: number;
    targets: VerifiedHeaderInfo[];
  };
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
  if [ "$prev" = "-o" ] || [ "$prev" = "--output" ]; then
    out="$arg"
  fi
  case "$arg" in
    -o?*) out="\${arg#-o}" ;;
    --output=*) out="\${arg#--output=}" ;;
    -Fo?*) out="\${arg#-Fo}" ;;
    /fo?*) out="\${arg#/fo}" ;;
    *.obj|*.res) if [ -z "$out" ]; then out="$arg"; fi ;;
  esac
  prev="$arg"
done
if [ -z "$out" ]; then
  echo "windres wrapper: could not determine output file from args: $*" >&2
  exit 1
fi
mkdir -p "$(dirname "$out")"
exec zig cc -target x86_64-windows-gnu -ffile-prefix-map=$PWD=. -x c -c /dev/null -o "$out"
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

export function verifyBinaryMagic(filePath: string): VerifiedHeaderInfo {
  const name = path.basename(filePath);
  if (!fs.existsSync(filePath)) {
    return { name, ok: false, format: "missing", arch: "unknown", detail: `File not found: ${filePath}` };
  }
  const buf = fs.readFileSync(filePath);
  if (buf.length === 0) {
    return { name, ok: false, format: "empty", arch: "unknown", detail: "Empty artifact" };
  }

  if (name.endsWith(".dll.a")) {
    const ok = buf.length >= 8 && buf.subarray(0, 8).toString("ascii") === "!<arch>\n";
    return { name, ok, format: "ar-implib", arch: "x86_64", ...(ok ? {} : { detail: "Invalid ar archive header" }) };
  }

  if (name.endsWith(".pyz")) {
    const ok = buf.includes(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    return { name, ok, format: "pyz", arch: "noarch", ...(ok ? {} : { detail: "Missing PKZIP signature in .pyz" }) };
  }

  if (name.endsWith(".dll") || name.endsWith(".exe")) {
    if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) {
      return { name, ok: false, format: "pe32+", arch: "unknown", detail: "Invalid MZ header" };
    }
    const peOff = buf.readUInt32LE(0x3c);
    if (peOff + 6 > buf.length || buf[peOff] !== 0x50 || buf[peOff + 1] !== 0x45 || buf[peOff + 2] !== 0 || buf[peOff + 3] !== 0) {
      return { name, ok: false, format: "pe32+", arch: "unknown", detail: "Invalid PE\\0\\0 signature" };
    }
    const machine = buf.readUInt16LE(peOff + 4);
    if (machine !== 0x8664 && machine !== 0xaa64) {
      return { name, ok: false, format: "pe32+", arch: `0x${machine.toString(16)}`, detail: `Unsupported PE machine 0x${machine.toString(16)}` };
    }
    return { name, ok: true, format: "pe32+", arch: machine === 0x8664 ? "x86_64" : "aarch64" };
  }

  if (name.endsWith(".so") || /-(linux-x64|linux-arm64)$/.test(name)) {
    if (buf.length < 64 || buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) {
      return { name, ok: false, format: "elf64", arch: "unknown", detail: "Invalid ELF magic" };
    }
    if (buf[4] !== 2) {
      return { name, ok: false, format: "elf", arch: "unknown", detail: `Expected ELFCLASS64 (2), got ${buf[4]}` };
    }
    const eMachine = buf[5] === 2 ? buf.readUInt16BE(18) : buf.readUInt16LE(18);
    if (eMachine !== 0x3e && eMachine !== 0xb7) {
      return { name, ok: false, format: "elf64", arch: `0x${eMachine.toString(16)}`, detail: `Unsupported ELF e_machine 0x${eMachine.toString(16)}` };
    }
    return { name, ok: true, format: "elf64", arch: eMachine === 0x3e ? "x86_64" : "aarch64" };
  }

  if (name.endsWith(".dylib") || name.endsWith("-macos-arm64")) {
    if (buf.length < 28) {
      return { name, ok: false, format: "macho64", arch: "unknown", detail: "Truncated Mach-O header" };
    }
    const magicBe = buf.readUInt32BE(0);
    if (magicBe !== 0xfeedfacf && magicBe !== 0xcffaedfe && magicBe !== 0xcafebabe && magicBe !== 0xbebafeca) {
      return { name, ok: false, format: "macho64", arch: "unknown", detail: `Invalid Mach-O magic 0x${magicBe.toString(16)}` };
    }
    let arch = "arm64";
    if (magicBe === 0xcafebabe || magicBe === 0xbebafeca) {
      arch = "universal";
    } else {
      const cpu = magicBe === 0xcffaedfe ? buf.readUInt32LE(4) : buf.readUInt32BE(4);
      if (cpu === 0x01000007) arch = "x86_64";
    }
    return { name, ok: true, format: "macho64", arch };
  }

  if (name.endsWith(".wasm")) {
    if (buf.length < 8 || buf[0] !== 0x00 || buf[1] !== 0x61 || buf[2] !== 0x73 || buf[3] !== 0x6d) {
      return { name, ok: false, format: "wasm32", arch: "wasm32-wasi", detail: "Invalid WASM magic header" };
    }
    if (!WebAssembly.validate(buf)) {
      return { name, ok: false, format: "wasm32", arch: "wasm32-wasi", detail: "WebAssembly.validate failed" };
    }
    return { name, ok: true, format: "wasm32", arch: "wasm32-wasi" };
  }

  return { name, ok: false, format: "unknown", arch: "unknown", detail: `Unrecognized artifact extension: ${name}` };
}

export function verifyAndSmokeTest(opts: {
  libKey: string;
  libOut: string;
  dlLdLibraryPath?: string;
  cliBinaries?: readonly string[];
  smokeProbe?: () => void;
}): VerifiedHeaderInfo[] {
  console.log("=== Verifying produced binaries & runtime smoke tests ===");
  const distFiles = fs.readdirSync("dist").sort();
  const artifactPattern = /\.(dll|so|dylib|wasm|dll\.a|exe|pyz)$|-(linux-x64|linux-arm64|macos-arm64)$/;
  const verifiedHeaders: VerifiedHeaderInfo[] = [];
  const hasFileTool = Boolean(runCapture("which", ["file"], { ignoreError: true }).trim());

  for (const name of distFiles) {
    if (!artifactPattern.test(name)) continue;
    const full = path.join("dist", name);
    const stat = fs.statSync(full);
    if (stat.size <= 0) {
      throw new Error(`ERROR: empty artifact ${full}`);
    }
    const hdr = verifyBinaryMagic(full);
    verifiedHeaders.push(hdr);
    if (!hdr.ok) {
      throw new Error(`Header verification failed for ${full}: ${hdr.detail ?? hdr.format}`);
    }
    console.log(`Header OK: ${name} (${hdr.format}, ${hdr.arch}, ${stat.size} bytes)`);
    if (hasFileTool) run("file", [full]);
  }
  if (verifiedHeaders.length === 0) {
    throw new Error(`ERROR: no verifiable artifacts produced in dist/ for ${opts.libKey}`);
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
    const linuxSo = `dist/${opts.libOut}-linux-x64.so`;
    if (!fs.existsSync(linuxSo)) {
      throw new Error(`Missing expected Linux x64 shared library for dlopen smoke test: ${linuxSo}`);
    }
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
  fflush(stdout);
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
    run("/tmp/dlprobe", [linuxSo], {
      env: { ...process.env, LD_LIBRARY_PATH: opts.dlLdLibraryPath ?? "" },
    });
  }

  if (opts.smokeProbe) {
    opts.smokeProbe();
  }

  return verifiedHeaders;
}

export function emitSha512AndReceipt(opts: {
  libKey: string;
  libOut: string;
  repo: string;
  tag: string;
  version: string;
  kind?: ShardKind;
  verifiedHeaders?: VerifiedHeaderInfo[];
}): void {
  const artifactPattern = /\.(dll|so|dylib|wasm|dll\.a|exe|pyz)$|-(linux-x64|linux-arm64|macos-arm64)$/;
  const files = fs
    .readdirSync("dist")
    .filter((f) => artifactPattern.test(f))
    .sort();

  const targets = opts.verifiedHeaders ?? files.map((name) => verifyBinaryMagic(path.join("dist", name)));
  const failed = targets.filter((t) => !t.ok);
  if (targets.length === 0 || failed.length > 0) {
    throw new Error(`Cannot emit receipt for ${opts.libKey}: ${failed.map((f) => `${f.name}:${f.detail}`).join("; ") || "no artifacts"}`);
  }

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
    kind: opts.kind ?? "runtime-library",
    deterministic: true,
    verifiedHeaders: {
      passed: targets.length,
      total: targets.length,
      targets,
    },
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

export function uploadDistPhase(): void {
  const tag = process.env.TAG || process.env.RELEASE_TAG || "v11-max-5os-latest";
  if (!fs.existsSync("dist")) {
    throw new Error("uploadDistPhase: dist/ directory not found");
  }
  const files = fs
    .readdirSync("dist")
    .filter((f) => fs.statSync(path.join("dist", f)).isFile())
    .sort()
    .map((f) => path.join("dist", f));
  if (files.length === 0) {
    throw new Error("uploadDistPhase: no files in dist/");
  }
  run("gh", ["release", "upload", tag, ...files, "--repo", GH_REPO, "--clobber"]);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const cmd = process.argv[2];
  if (cmd === "upload") {
    uploadDistPhase();
  } else {
    throw new Error(`Unknown runtime command: ${cmd ?? "(none)"}`);
  }
}
