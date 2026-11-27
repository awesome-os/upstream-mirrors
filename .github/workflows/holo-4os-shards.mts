import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { compileMultiOs, ensureGithubRelease, findFiles, GH_REPO, run } from "./holo-workflow-runtime.mts";

export const LEGACY_5OS_ENGINES = ["brotli", "expat", "sqlite3", "libwebp", "lz4", "md4c", "picohttp"] as const;
export type Legacy5OsEngine = (typeof LEGACY_5OS_ENGINES)[number];

export function buildLegacyEngine(engine: Legacy5OsEngine): void {
  fs.mkdirSync("dist", { recursive: true });
  switch (engine) {
    case "brotli": {
      const srcs = [
        ...findFiles("src/c/common", (_p, n) => n.endsWith(".c")),
        ...findFiles("src/c/dec", (_p, n) => n.endsWith(".c")),
        ...findFiles("src/c/enc", (_p, n) => n.endsWith(".c")),
      ];
      compileMultiOs("libbrotli", {
        includeWasi: true,
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
    case "expat": {
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
      compileMultiOs("libexpat", {
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
    case "sqlite3": {
      fs.mkdirSync("/tmp/sq", { recursive: true });
      run("curl", ["-fsSL", "https://www.sqlite.org/2025/sqlite-amalgamation-3490100.zip", "-o", "/tmp/sq/sq.zip"]);
      run("unzip", ["-q", "/tmp/sq/sq.zip", "-d", "/tmp/sq"]);
      const sqC = findFiles("/tmp/sq", (_p, n) => n === "sqlite3.c", 2)[0];
      if (!sqC) throw new Error("sqlite3.c not found");
      compileMultiOs("libsqlite3", {
        includeWasi: true,
        commonArgs: ["-DSQLITE_ENABLE_FTS5", "-DSQLITE_ENABLE_JSON1", sqC],
        winArgs: ["-DSQLITE_THREADSAFE=1"],
        linuxArgs: ["-DSQLITE_THREADSAFE=1"],
        macArgs: ["-DSQLITE_THREADSAFE=1"],
        wasiArgs: ["-DSQLITE_THREADSAFE=0", "-DSQLITE_OMIT_LOAD_EXTENSION=1", "-D_WASI_EMULATED_MMAN", "-lwasi-emulated-mman"],
      });
      break;
    }
    case "libwebp": {
      const srcs = [
        ...findFiles("src/src/dec", (_p, n) => n.endsWith(".c")),
        ...findFiles("src/src/dsp", (_p, n) => n.endsWith(".c")),
        ...findFiles("src/src/enc", (_p, n) => n.endsWith(".c")),
        ...findFiles("src/src/utils", (_p, n) => n.endsWith(".c")),
        ...findFiles("src/src/demux", (_p, n) => n.endsWith(".c")),
        ...findFiles("src/sharpyuv", (_p, n) => n.endsWith(".c")),
      ];
      compileMultiOs("libwebp", {
        includeWasi: true,
        commonArgs: ["-Isrc", "-Isrc/src", "-DWEBP_DLL", ...srcs, "-lm"],
      });
      break;
    }
    case "lz4":
      compileMultiOs("liblz4", {
        includeWasi: true,
        commonArgs: ["-Isrc/lib", "src/lib/lz4.c", "src/lib/lz4hc.c", "src/lib/lz4frame.c", "src/lib/xxhash.c"],
      });
      break;
    case "md4c":
      compileMultiOs("libmd4c", {
        includeWasi: true,
        commonArgs: ["-Isrc/src", "src/src/md4c.c", "src/src/md4c-html.c", "src/src/entity.c"],
      });
      break;
    case "picohttp":
      compileMultiOs("libpicohttp", {
        includeWasi: true,
        commonArgs: ["-Isrc", "src/picohttpparser.c"],
      });
      break;
  }

  const files = fs.readdirSync("dist").sort();
  const lines = files.map((name) => {
    const out = execFileSync("sha256sum", [name], { cwd: "dist", encoding: "utf8" }).trim();
    return out;
  });
  fs.writeFileSync(path.join("dist", `SHA256SUMS-${engine}-5os.txt`), `${lines.join("\n")}\n`, "utf8");
  run("ls", ["-lh", "dist/"]);
}

export function emitLegacyManifest(): void {
  const tag = process.env.TAG || "v0.2.0-holo-5os";
  fs.mkdirSync("/tmp/sums", { recursive: true });
  run("gh", ["release", "download", tag, "--repo", GH_REPO, "--pattern", "SHA256SUMS-*-5os.txt", "--dir", "/tmp/sums", "--clobber"]);

  const entries: Array<{ filename: string; sha256: string; download_url: string }> = [];
  for (const f of fs.readdirSync("/tmp/sums").sort()) {
    for (const line of fs.readFileSync(path.join("/tmp/sums", f), "utf8").trim().split(/\r?\n/)) {
      const [sha256, filename] = line.trim().split(/\s+/);
      if (!sha256 || !filename || filename.endsWith(".dll.a")) continue;
      entries.push({
        filename,
        sha256,
        download_url: `https://github.com/${GH_REPO}/releases/download/${tag}/${filename}`,
      });
    }
  }
  const manifest = {
    schema: "holo-v11-registry-5os",
    compiler: "holo-compiler (zig cc 0.14.0, zero cmake/ninja)",
    targets: ["win64", "linux-x64", "linux-arm64", "macos-arm64", "wasm32-wasi"],
    tag,
    total_libs: entries.length,
    libs: entries,
  };
  fs.writeFileSync("/tmp/holo-v11-5os-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log("[holo-5os] Published holo-v11-5os-manifest.json with", entries.length, "cross-compiled 5-OS shared/WASI libraries");
  run("gh", ["release", "upload", tag, "/tmp/holo-v11-5os-manifest.json", "--repo", GH_REPO, "--clobber"]);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const cmd = process.argv[2];
  if (cmd === "ensure-release") {
    ensureGithubRelease(
      process.env.TAG || "v0.2.0-holo-5os",
      "100% pure zig cc cross-compiled shared + WASI libraries directly from sparse mirror/* branches."
    );
  } else if (cmd === "build") {
    const engine = process.env.ENGINE as Legacy5OsEngine;
    buildLegacyEngine(engine);
  } else if (cmd === "manifest") {
    emitLegacyManifest();
  } else {
    throw new Error(`Unknown command: ${cmd ?? "(none)"}`);
  }
}
