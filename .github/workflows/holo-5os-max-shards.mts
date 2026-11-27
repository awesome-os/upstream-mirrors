import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  cloneTag,
  compileMultiOs,
  findFiles,
  GH_REPO,
  type LibraryPin,
  resolveVersionsPhase,
  run,
  runCapture,
  zigCc,
  zigCxx,
} from "./holo-workflow-runtime.mts";

export const TIER1_DEFAULTS: Record<string, LibraryPin> = {
  zlib: { pkg: "zlib", libOut: "libz", repo: "madler/zlib", tag: "v1.4", version: "1.4" },
  zstd: { pkg: "zstd", libOut: "libzstd", repo: "facebook/zstd", tag: "v1.6.0", version: "1.6.0" },
  libdeflate: { pkg: "libdeflate", libOut: "libdeflate", repo: "ebiggers/libdeflate", tag: "v1.26", version: "1.26" },
  lz4: { pkg: "lz4", libOut: "liblz4", repo: "lz4/lz4", tag: "v1.11.1", version: "1.11.1" },
  brotli: { pkg: "brotli", libOut: "libbrotli", repo: "google/brotli", tag: "v1.2.1", version: "1.2.1" },
  md4c: { pkg: "md4c", libOut: "libmd4c", repo: "mity/md4c", tag: "v0.6.0", version: "0.6.0" },
  sqlite3: {
    pkg: "sqlite",
    libOut: "libsqlite3",
    repo: "sqlite/sqlite",
    tag: "version-3.54.1",
    version: "3.54.1",
    url: "https://www.sqlite.org/2025/sqlite-amalgamation-3490100.zip",
  },
  simdjson: { pkg: "simdjson", libOut: "libsimdjson", repo: "simdjson/simdjson", tag: "v5.3.0", version: "5.3.0" },
  simdutf: { pkg: "simdutf", libOut: "libsimdutf", repo: "simdutf/simdutf", tag: "v9.5.0", version: "9.5.0" },
  ada: { pkg: "ada", libOut: "libada", repo: "ada-url/ada", tag: "v4.1.1", version: "4.1.1" },
  libyaml: { pkg: "libyaml", libOut: "libyaml", repo: "yaml/libyaml", tag: "0.2.5", version: "0.2.5" },
  libwebp: { pkg: "libwebp", libOut: "libwebp", repo: "webmproject/libwebp", tag: "v1.6.0", version: "1.6.0" },
  expat: { pkg: "expat", libOut: "libexpat", repo: "libexpat/libexpat", tag: "R_2_11_0", version: "2.11.0" },
  mimalloc: { pkg: "mimalloc", libOut: "libmimalloc", repo: "microsoft/mimalloc", tag: "v3.7.1", version: "3.7.1" },
};

export const TIER1_LIBS = Object.keys(TIER1_DEFAULTS);

async function resolvePhase(): Promise<void> {
  await resolveVersionsPhase({
    tier: "tier1-max",
    releaseNotes:
      "Production max-version 5-OS shared libraries (Win64 .dll, Linux x64/ARM64 .so, macOS ARM64 .dylib, wasm32-wasi .wasm) compiled directly from upstream sources via pure holo-compiler (zig 0.14.0) — zero CMake, zero Ninja, zero Make.",
    resolvedFileName: "resolved-versions.json",
    defaults: TIER1_DEFAULTS,
    postResolve: async (resolved) => {
      try {
        const yres = await fetch("https://api.github.com/repos/yaml/libyaml/releases/latest", {
          headers: {
            "User-Agent": "holo-5os-max-shards",
            ...(process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {}),
          },
        });
        if (yres.ok) {
          const yjson = (await yres.json()) as { tag_name?: string };
          if (yjson.tag_name) {
            resolved.libyaml.tag = yjson.tag_name;
            resolved.libyaml.version = yjson.tag_name.replace(/^v/, "");
          }
        }
      } catch (err) {
        console.warn("[warn] libyaml release lookup failed:", (err as Error).message);
      }

      try {
        const sres = await fetch("https://www.sqlite.org/download.html");
        if (sres.ok) {
          const html = await sres.text();
          const m = html.match(/(\d{4}\/sqlite-amalgamation-(\d+)\.zip)/);
          if (m) {
            resolved.sqlite3.url = `https://www.sqlite.org/${m[1]}`;
            const n = m[2];
            if (n.length === 7) {
              const maj = Number(n.slice(0, 1));
              const min = Number(n.slice(1, 3));
              const pat = Number(n.slice(3, 5));
              resolved.sqlite3.version = `${maj}.${min}.${pat}`;
              resolved.sqlite3.tag = `version-${resolved.sqlite3.version}`;
            }
          }
        }
      } catch (err) {
        console.warn("[warn] sqlite.org lookup failed, using fallback:", (err as Error).message);
      }
    },
  });
}

function fetchSingleHeader(repo: string, tag: string, workDir: string): string {
  fs.mkdirSync(workDir, { recursive: true });
  const zipPath = path.join(workDir, "singleheader.zip");
  try {
    run("curl", ["-fsSL", `https://github.com/${repo}/releases/download/${tag}/singleheader.zip`, "-o", zipPath]);
    run("unzip", ["-q", zipPath, "-d", workDir]);
    return workDir;
  } catch {
    cloneTag(repo, tag);
    return "src/singleheader";
  }
}

export function buildTier1Library(libKey: string, pin: LibraryPin): void {
  const { libOut, repo, tag, version } = pin;
  console.log(`=== Building ${libKey} (${libOut}) @ ${repo} ${tag} (${version}) ===`);
  fs.mkdirSync("src", { recursive: true });
  fs.mkdirSync("dist", { recursive: true });

  switch (libKey) {
    case "zlib": {
      cloneTag(repo, tag);
      const srcs = findFiles("src", (_p, n) => n.endsWith(".c"), 1);
      compileMultiOs(libOut, {
        includeWasi: true,
        commonArgs: ["-Isrc", ...srcs],
        winArgs: ["-DZLIB_DLL", "-DZLIB_INTERNAL"],
        linuxArgs: ["-DHAVE_STDARG_H", "-DHAVE_UNISTD_H"],
        macArgs: ["-DHAVE_STDARG_H", "-DHAVE_UNISTD_H"],
        wasiArgs: ["-DHAVE_STDARG_H", "-DHAVE_UNISTD_H"],
      });
      break;
    }
    case "zstd": {
      cloneTag(repo, tag);
      const srcs = [
        ...findFiles("src/lib/common", (_p, n) => n.endsWith(".c")),
        ...findFiles("src/lib/compress", (_p, n) => n.endsWith(".c")),
        ...findFiles("src/lib/decompress", (_p, n) => n.endsWith(".c")),
      ];
      compileMultiOs(libOut, {
        includeWasi: true,
        commonArgs: ["-Isrc/lib", "-Isrc/lib/common", "-DZSTD_MULTITHREAD=0", "-DZSTD_DISABLE_ASM", "-DXXH_NAMESPACE=ZSTD_", ...srcs],
        winArgs: ["-DZSTD_DLL_EXPORT=1"],
      });
      break;
    }
    case "libdeflate": {
      cloneTag(repo, tag);
      const srcs = [
        ...findFiles("src/lib", (_p, n) => n.endsWith(".c"), 1),
        ...findFiles("src/lib/arm", (_p, n) => n.endsWith(".c")),
        ...findFiles("src/lib/x86", (_p, n) => n.endsWith(".c")),
      ];
      compileMultiOs(libOut, { includeWasi: true, evex512: true, commonArgs: ["-Isrc", "-Isrc/lib", ...srcs] });
      break;
    }
    case "lz4":
      cloneTag(repo, tag);
      compileMultiOs(libOut, {
        includeWasi: true,
        evex512: true,
        commonArgs: ["-Isrc/lib", "src/lib/lz4.c", "src/lib/lz4hc.c", "src/lib/lz4frame.c", "src/lib/xxhash.c"],
      });
      break;
    case "brotli": {
      cloneTag(repo, tag);
      const srcs = [
        ...findFiles("src/c/common", (_p, n) => n.endsWith(".c")),
        ...findFiles("src/c/dec", (_p, n) => n.endsWith(".c")),
        ...findFiles("src/c/enc", (_p, n) => n.endsWith(".c")),
      ];
      compileMultiOs(libOut, {
        includeWasi: true,
        evex512: true,
        commonArgs: [
          "-Isrc/c/include",
          "-Isrc/c",
          "-DBROTLI_SHARED_COMPILATION",
          "-DBROTLI_BUILD_COMMON_LIBRARY",
          "-DBROTLI_BUILD_DECODER_LIBRARY",
          "-DBROTLI_BUILD_ENCODER_LIBRARY",
          ...srcs,
          "-lm",
        ],
      });
      break;
    }
    case "md4c":
      cloneTag(repo, tag);
      compileMultiOs(libOut, {
        includeWasi: true,
        evex512: true,
        commonArgs: ["-Isrc/src", "src/src/md4c.c", "src/src/md4c-html.c", "src/src/entity.c"],
      });
      break;
    case "sqlite3": {
      fs.mkdirSync("/tmp/sq", { recursive: true });
      const sqUrl = pin.url || "https://www.sqlite.org/2025/sqlite-amalgamation-3490100.zip";
      try {
        run("curl", ["-fsSL", sqUrl, "-o", "/tmp/sq/sq.zip"]);
      } catch {
        run("curl", ["-fsSL", "https://www.sqlite.org/2025/sqlite-amalgamation-3490100.zip", "-o", "/tmp/sq/sq.zip"]);
      }
      run("unzip", ["-q", "/tmp/sq/sq.zip", "-d", "/tmp/sq"]);
      const sqC = findFiles("/tmp/sq", (_p, n) => n === "sqlite3.c", 2)[0];
      if (!sqC) throw new Error("sqlite3.c not found");
      compileMultiOs(libOut, {
        includeWasi: true,
        commonArgs: ["-DSQLITE_ENABLE_FTS5", "-DSQLITE_ENABLE_JSON1", sqC],
        winArgs: ["-DSQLITE_THREADSAFE=1"],
        linuxArgs: ["-DSQLITE_THREADSAFE=1"],
        macArgs: ["-DSQLITE_THREADSAFE=1"],
        wasiArgs: ["-DSQLITE_THREADSAFE=0", "-DSQLITE_OMIT_LOAD_EXTENSION=1", "-D_WASI_EMULATED_MMAN", "-lwasi-emulated-mman"],
      });
      break;
    }
    case "simdjson": {
      const inc = fetchSingleHeader(repo, tag, "/tmp/sj");
      compileMultiOs(libOut, {
        cxx: true,
        evex512: true,
        winExportAll: true,
        commonArgs: ["-std=c++17", `-I${inc}`, `${inc}/simdjson.cpp`],
      });
      break;
    }
    case "simdutf": {
      const inc = fetchSingleHeader(repo, tag, "/tmp/su");
      compileMultiOs(libOut, {
        cxx: true,
        evex512: true,
        winExportAll: true,
        commonArgs: ["-std=c++17", `-I${inc}`, `${inc}/simdutf.cpp`],
      });
      break;
    }
    case "ada": {
      const inc = fetchSingleHeader(repo, tag, "/tmp/ada_sh");
      const base = ["-std=c++20", `-I${inc}`, `${inc}/ada.cpp`];
      zigCxx("x86_64-windows-gnu", ["-O2", "-mssse3", "-shared", "-s", "-Wl,--export-all-symbols", ...base, "-o", `dist/${libOut}-win64.dll`, `-Wl,--out-implib,dist/${libOut}-win64.dll.a`]);
      zigCxx("x86_64-linux-gnu", ["-O2", "-mssse3", "-shared", "-fPIC", "-s", ...base, "-o", `dist/${libOut}-linux-x64.so`]);
      zigCxx("aarch64-linux-gnu", ["-O2", "-shared", "-fPIC", "-s", ...base, "-o", `dist/${libOut}-linux-arm64.so`]);
      zigCxx("aarch64-macos", ["-O2", "-shared", "-fPIC", ...base, "-o", `dist/${libOut}-macos-arm64.dylib`]);
      break;
    }
    case "libyaml": {
      cloneTag(repo, tag);
      fs.mkdirSync("/tmp/yaml_inc", { recursive: true });
      const [maj = "0", min = "2", pat = "5"] = version.split("-")[0].split(".");
      fs.writeFileSync(
        "/tmp/yaml_inc/config.h",
        `#ifndef CONFIG_H
#define CONFIG_H
#define YAML_VERSION_MAJOR ${maj}
#define YAML_VERSION_MINOR ${min}
#define YAML_VERSION_PATCH ${pat}
#define YAML_VERSION_STRING "${version}"
#endif
`,
        "utf8"
      );
      const srcs = findFiles("src/src", (_p, n) => n.endsWith(".c"), 1);
      compileMultiOs(libOut, {
        includeWasi: true,
        evex512: true,
        commonArgs: [
          "-I/tmp/yaml_inc",
          "-Isrc/include",
          "-Isrc/src",
          "-DHAVE_CONFIG_H",
          "-DYAML_DECLARE_EXPORT",
          `-DYAML_VERSION_MAJOR=${maj}`,
          `-DYAML_VERSION_MINOR=${min}`,
          `-DYAML_VERSION_PATCH=${pat}`,
          `-DYAML_VERSION_STRING="${version}"`,
          ...srcs,
        ],
      });
      break;
    }
    case "libwebp": {
      cloneTag(repo, tag);
      const srcs = [
        ...findFiles("src/src/dec", (_p, n) => n.endsWith(".c")),
        ...findFiles("src/src/dsp", (_p, n) => n.endsWith(".c")),
        ...findFiles("src/src/enc", (_p, n) => n.endsWith(".c")),
        ...findFiles("src/src/utils", (_p, n) => n.endsWith(".c")),
        ...findFiles("src/src/demux", (_p, n) => n.endsWith(".c")),
        ...findFiles("src/sharpyuv", (_p, n) => n.endsWith(".c")),
      ];
      compileMultiOs(libOut, { includeWasi: true, evex512: true, commonArgs: ["-Isrc", "-Isrc/src", "-DWEBP_DLL", ...srcs, "-lm"] });
      break;
    }
    case "expat": {
      cloneTag(repo, tag);
      fs.mkdirSync("/tmp/expat_inc", { recursive: true });
      fs.writeFileSync(
        "/tmp/expat_inc/expat_config.h",
        `#ifndef EXPAT_CONFIG_H
#define EXPAT_CONFIG_H
#define BYTEORDER 1234
#define HAVE_MEMMOVE 1
#define HAVE_STDINT_H 1
#define HAVE_STDLIB_H 1
#define HAVE_STRING_H 1
#define XML_NS 1
#define XML_DTD 1
#define XML_GE 1
#define XML_CONTEXT_BYTES 1024
#if defined(_WIN32)
#define HAVE_RAND_S 1
#elif defined(__APPLE__)
#define HAVE_ARC4RANDOM_BUF 1
#elif defined(__wasi__)
#define HAVE_GETENTROPY 1
#else
#define HAVE_GETRANDOM 1
#endif
#endif
`,
        "utf8"
      );
      compileMultiOs(libOut, {
        includeWasi: true,
        commonArgs: [
          "-I/tmp/expat_inc",
          "-Isrc/expat/lib",
          "-DHAVE_EXPAT_CONFIG_H",
          "-DXML_ENABLE_VISIBILITY=1",
          "src/expat/lib/xmlparse.c",
          "src/expat/lib/xmlrole.c",
          "src/expat/lib/xmltok.c",
          "src/expat/lib/xcs.c",
        ],
        winArgs: ["src/expat/lib/random_rand_s.c"],
        linuxArgs: ["src/expat/lib/random_getrandom.c"],
        macArgs: ["src/expat/lib/random_arc4random_buf.c"],
        wasiArgs: ["src/expat/lib/random_getentropy.c"],
      });
      break;
    }
    case "mimalloc": {
      cloneTag(repo, tag);
      const flags = ["-Isrc/include", "-DMI_SHARED_LIB=1", "-DMI_SHARED_LIB_EXPORT=1"];
      zigCc("x86_64-windows-gnu", ["-O2", "-shared", "-s", ...flags, "-DMI_WIN_NOREDIRECT=1", "src/src/static.c", "-lpsapi", "-lshell32", "-luser32", "-ladvapi32", "-lbcrypt", "-o", `dist/${libOut}-win64.dll`, `-Wl,--out-implib,dist/${libOut}-win64.dll.a`]);
      zigCc("x86_64-linux-gnu", ["-O2", "-shared", "-fPIC", "-s", ...flags, "src/src/static.c", "-lpthread", "-o", `dist/${libOut}-linux-x64.so`]);
      zigCc("aarch64-linux-gnu", ["-O2", "-shared", "-fPIC", "-s", ...flags, "src/src/static.c", "-lpthread", "-o", `dist/${libOut}-linux-arm64.so`]);
      zigCc("aarch64-macos", ["-O2", "-shared", "-fPIC", ...flags, "-DMAC_OS_X_VERSION_MIN_REQUIRED=101400", "src/src/static.c", "-lpthread", "-o", `dist/${libOut}-macos-arm64.dylib`]);
      break;
    }
    default:
      throw new Error(`Unknown Tier-1 libKey: ${libKey}`);
  }

  const distFiles = fs.readdirSync("dist").filter((f) => /\.(dll|so|dylib|wasm|dll\.a)$/.test(f)).sort();
  const sumLines: string[] = [];
  for (const name of distFiles) {
    const full = path.join("dist", name);
    if (fs.statSync(full).size <= 0) throw new Error(`ERROR: empty artifact ${full}`);
    run("file", [full]);
    const sha512 = createHash("sha512").update(fs.readFileSync(full)).digest("hex");
    sumLines.push(`${sha512}  ${name}`);
  }
  fs.writeFileSync(path.join("dist", `SHA512SUMS-${libKey}.txt`), `${sumLines.join("\n")}\n`, "utf8");
  run("ls", ["-lh", "dist/"]);
}

function finalizeMaxPhase(): void {
  const tag = process.env.TAG || "v11-max-5os-latest";
  fs.mkdirSync("/tmp/sums", { recursive: true });
  fs.mkdirSync("/tmp/out", { recursive: true });
  run("gh", ["release", "download", tag, "--repo", GH_REPO, "--pattern", "SHA512SUMS-*.txt", "--dir", "/tmp/sums", "--clobber"]);
  const assetsRaw = runCapture("gh", ["release", "view", tag, "--repo", GH_REPO, "--json", "assets"]);
  const assetsJson = JSON.parse(assetsRaw) as { assets?: Array<{ name: string; size: number }> };
  const resolved = (JSON.parse(fs.readFileSync("/tmp/meta/resolved-versions.json", "utf8")) as { libraries: Record<string, LibraryPin> }).libraries;
  const assetSizeMap = new Map((assetsJson.assets ?? []).map((a) => [a.name, a.size]));

  const targetOf = (filename: string): string => {
    if (filename.endsWith("-win64.dll")) return "win64";
    if (filename.endsWith("-win64.dll.a")) return "win64-implib";
    if (filename.endsWith("-linux-x64.so")) return "linux-x64";
    if (filename.endsWith("-linux-arm64.so")) return "linux-arm64";
    if (filename.endsWith("-macos-arm64.dylib")) return "macos-arm64";
    if (filename.endsWith("-wasm32-wasi.wasm")) return "wasm32-wasi";
    return "unknown";
  };

  const allLines: string[] = [];
  const libraries: unknown[] = [];
  let totalBinaries = 0;

  for (const f of fs.readdirSync("/tmp/sums").sort()) {
    const m = f.match(/^SHA512SUMS-(.+)\.txt$/);
    if (!m) continue;
    const libKey = m[1];
    const meta = resolved[libKey] || { pkg: libKey, libOut: `lib${libKey}`, repo: "unknown", tag: "unknown", version: "unknown" };
    const lines = fs.readFileSync(path.join("/tmp/sums", f), "utf8").trim().split(/\r?\n/).filter(Boolean);
    const binaries: Array<{ target: string; filename: string; size: number | null; sha512: string; v11CasPath: string; downloadUrl: string }> = [];
    const importLibs: typeof binaries = [];
    for (const line of lines) {
      const [sha512, filename] = line.trim().split(/\s+/);
      if (!sha512 || !filename || filename.endsWith(".txt")) continue;
      allLines.push(`${sha512}  ${filename}`);
      const target = targetOf(filename);
      const entry = {
        filename,
        target,
        size: assetSizeMap.get(filename) ?? null,
        sha512,
        v11CasPath: `v11/files/${sha512.slice(0, 2)}/${sha512}`,
        downloadUrl: `https://github.com/${GH_REPO}/releases/download/${tag}/${filename}`,
      };
      if (target === "win64-implib") importLibs.push(entry);
      else {
        binaries.push(entry);
        totalBinaries++;
      }
    }
    libraries.push({
      lib: libKey,
      pkg: meta.pkg,
      libOut: meta.libOut,
      repo: meta.repo,
      tag: meta.tag,
      version: meta.version,
      targets: binaries.map((b) => b.target),
      binaries,
      importLibs,
    });
  }

  fs.writeFileSync("/tmp/out/SHA512SUMS.txt", `${allLines.join("\n")}\n`, "utf8");
  const manifest = {
    schema: "holo-v11.max-5os-manifest.v1",
    abiMagic: "0x33564742",
    compiler: "holo-compiler (zig 0.14.0)",
    tag,
    generatedAt: new Date().toISOString(),
    totalLibraries: libraries.length,
    totalBinaries,
    libraries,
  };
  fs.writeFileSync("/tmp/out/holo-v11-max-5os-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`[holo-5os-max] Emitted manifest: ${libraries.length} libraries, ${totalBinaries} binaries`);
  run("gh", ["release", "upload", tag, "/tmp/out/SHA512SUMS.txt", "/tmp/out/holo-v11-max-5os-manifest.json", "--repo", GH_REPO, "--clobber"]);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const cmd = process.argv[2];
  if (cmd === "resolve") {
    await resolvePhase();
  } else if (cmd === "build") {
    const libKey = process.env.LIB_KEY || "";
    const versions = JSON.parse(process.env.VERSIONS_JSON || "{}") as Record<string, LibraryPin>;
    const pin = versions[libKey] ?? TIER1_DEFAULTS[libKey];
    if (!pin) throw new Error(`Missing version pin for ${libKey}`);
    buildTier1Library(libKey, pin);
  } else if (cmd === "finalize") {
    finalizeMaxPhase();
  } else {
    throw new Error(`Unknown command: ${cmd ?? "(none)"}`);
  }
}
