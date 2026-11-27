import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  appendGithubOutput,
  checkSkipMaterialized,
  cloneTag,
  compileMultiOs,
  emitSha512AndReceipt,
  finalizeTierSumsPhase,
  findFiles,
  type LibraryPin,
  resolveVersionsPhase,
  verifyAndSmokeTest,
  zigCc,
  zigCxx,
} from "./holo-workflow-runtime.mts";

export const TIER3_DEFAULTS: Record<string, LibraryPin> = {
  pixman: { pkg: "pixman", libOut: "libpixman", repo: "gitlab.freedesktop.org/pixman/pixman", tag: "pixman-0.46.4", version: "0.46.4" },
  "libjpeg-turbo": { pkg: "libjpeg-turbo", libOut: "libjpeg-turbo", repo: "libjpeg-turbo/libjpeg-turbo", tag: "3.2.1", version: "3.2.1" },
  libffi: { pkg: "libffi", libOut: "libffi", repo: "libffi/libffi", tag: "v3.8.2", version: "3.8.2" },
  ngtcp2: { pkg: "ngtcp2", libOut: "libngtcp2", repo: "ngtcp2/ngtcp2", tag: "v1.26.0", version: "1.26.0" },
  libxml2: { pkg: "libxml2", libOut: "libxml2", repo: "GNOME/libxml2", tag: "v2.15.4", version: "2.15.4" },
  libxslt: { pkg: "libxslt", libOut: "libxslt", repo: "GNOME/libxslt", tag: "v1.1.45", version: "1.1.45" },
  woff2: { pkg: "woff2", libOut: "libwoff2", repo: "google/woff2", tag: "v1.0.2", version: "1.0.2" },
  libarchive: { pkg: "libarchive", libOut: "libarchive", repo: "libarchive/libarchive", tag: "v3.8.11", version: "3.8.11" },
};

export const TIER3_LIBS = Object.keys(TIER3_DEFAULTS);

const XML2_REL_SRCS = [
  "buf.c", "chvalid.c", "dict.c", "encoding.c", "entities.c", "error.c", "globals.c", "hash.c", "list.c",
  "parser.c", "parserInternals.c", "SAX2.c", "threads.c", "tree.c", "uri.c", "valid.c", "xmlIO.c",
  "xmlmemory.c", "xmlstring.c", "c14n.c", "catalog.c", "debugXML.c", "HTMLparser.c", "HTMLtree.c",
  "nanohttp.c", "xmlsave.c", "pattern.c", "xmlreader.c", "xmlregexp.c", "relaxng.c", "xmlschemas.c",
  "xmlschemastypes.c", "xmlwriter.c", "xinclude.c", "xpath.c", "xlink.c", "xpointer.c",
];

function genLibxml2Headers(xmlSrc: string, xmlInc: string): void {
  fs.mkdirSync(path.join(xmlInc, "libxml"), { recursive: true });
  const ver = fs.readFileSync(path.join(xmlSrc, "VERSION"), "utf8").trim();
  const [maj = "2", min = "15", mic = "0"] = ver.split(".");
  const num = String(Number(maj) * 10000 + Number(min) * 100 + Number(mic));
  let tpl = fs.readFileSync(path.join(xmlSrc, "include/libxml/xmlversion.h.in"), "utf8");
  const reps: Record<string, string> = {
    "@VERSION@": ver,
    "@LIBXML_VERSION_NUMBER@": num,
    "@LIBXML_VERSION_EXTRA@": "",
    "@WITH_THREADS@": "0",
    "@WITH_THREAD_ALLOC@": "0",
    "@WITH_OUTPUT@": "1",
    "@WITH_PUSH@": "1",
    "@WITH_READER@": "1",
    "@WITH_PATTERN@": "1",
    "@WITH_WRITER@": "1",
    "@WITH_SAX1@": "1",
    "@WITH_HTTP@": "1",
    "@WITH_VALID@": "1",
    "@WITH_HTML@": "1",
    "@WITH_C14N@": "1",
    "@WITH_CATALOG@": "1",
    "@WITH_XPATH@": "1",
    "@WITH_XPTR@": "1",
    "@WITH_XINCLUDE@": "1",
    "@WITH_ICONV@": "0",
    "@WITH_ICU@": "0",
    "@WITH_ISO8859X@": "1",
    "@WITH_DEBUG@": "1",
    "@WITH_REGEXPS@": "1",
    "@WITH_RELAXNG@": "1",
    "@WITH_SCHEMAS@": "1",
    "@WITH_SCHEMATRON@": "0",
    "@WITH_MODULES@": "0",
    "@MODULE_EXTENSION@": ".so",
    "@WITH_ZLIB@": "0",
  };
  for (const [k, v] of Object.entries(reps)) tpl = tpl.replaceAll(k, v);
  fs.writeFileSync(path.join(xmlInc, "libxml/xmlversion.h"), tpl, "utf8");
  fs.writeFileSync(
    path.join(xmlInc, "config.h"),
    `#define HAVE_STDINT_H 1
#define HAVE_DECL_GETENTROPY 0
#define HAVE_DECL_GLOB 0
#define HAVE_DECL_MMAP 0
#define XML_SYSCONFDIR "/etc"
`,
    "utf8"
  );
}

export function buildTier3Library(libKey: string, pin: LibraryPin): void {
  const { libOut, repo, tag, version } = pin;
  console.log(`=== Building ${libKey} (${libOut}) @ ${repo} ${tag} (${version}) ===`);
  fs.mkdirSync("src", { recursive: true });
  fs.mkdirSync("dist", { recursive: true });
  let dlLdLibraryPath = "";

  switch (libKey) {
    case "pixman": {
      try {
        cloneTag(repo, tag);
      } catch {
        fs.rmSync("src", { recursive: true, force: true });
        cloneTag("gitlab.freedesktop.org/pixman/pixman", "pixman-0.44.2");
      }
      fs.mkdirSync("/tmp/pix_inc", { recursive: true });
      const ver = version.replace(/^pixman-/, "").split("-")[0];
      const [maj = "0", min = "46", mic = "0"] = ver.split(".");
      const tpl = fs
        .readFileSync("src/pixman/pixman-version.h.in", "utf8")
        .replaceAll("@PIXMAN_VERSION_MAJOR@", maj)
        .replaceAll("@PIXMAN_VERSION_MINOR@", min)
        .replaceAll("@PIXMAN_VERSION_MICRO@", mic);
      fs.writeFileSync("/tmp/pix_inc/pixman-version.h", tpl, "utf8");
      fs.writeFileSync("/tmp/pix_inc/pixman-config.h", '#define PACKAGE "pixman"\n#define HAVE_PTHREADS 0\n', "utf8");
      const srcs = [
        "pixman.c", "pixman-access.c", "pixman-access-accessors.c", "pixman-arm.c", "pixman-bits-image.c",
        "pixman-combine32.c", "pixman-combine-float.c", "pixman-conical-gradient.c", "pixman-edge.c",
        "pixman-edge-accessors.c", "pixman-fast-path.c", "pixman-filter.c", "pixman-glyph.c",
        "pixman-general.c", "pixman-gradient-walker.c", "pixman-image.c", "pixman-implementation.c",
        "pixman-linear-gradient.c", "pixman-matrix.c", "pixman-mips.c", "pixman-noop.c", "pixman-ppc.c",
        "pixman-radial-gradient.c", "pixman-region16.c", "pixman-region32.c", "pixman-region64f.c",
        "pixman-riscv.c", "pixman-solid-fill.c", "pixman-timer.c", "pixman-trap.c", "pixman-utils.c", "pixman-x86.c",
      ].map((f) => `src/pixman/${f}`);
      compileMultiOs(libOut, {
        includeWasi: true,
        commonArgs: ["-I/tmp/pix_inc", "-Isrc/pixman", "-DPACKAGE=pixman", "-DPIXMAN_NO_TLS", ...srcs],
        winArgs: ["-DPIXMAN_API=__declspec(dllexport)"],
        linuxArgs: ["-lm"],
        macArgs: ["-lm"],
        wasiArgs: ["-lm"],
      });
      break;
    }
    case "libjpeg-turbo": {
      cloneTag(repo, tag);
      fs.mkdirSync("/tmp/jpg_inc", { recursive: true });
      const ver = version.replace(/^v/, "").split("-")[0];
      const [maj = "3", min = "2", rev = "0"] = ver.split(".");
      const verNum = `${maj}${min.padStart(3, "0")}${rev.padStart(3, "0")}`;
      fs.writeFileSync(
        "/tmp/jpg_inc/jconfig.h",
        `#define JPEG_LIB_VERSION 80
#define LIBJPEG_TURBO_VERSION ${ver}
#define LIBJPEG_TURBO_VERSION_NUMBER ${verNum}
#define C_ARITH_CODING_SUPPORTED 1
#define D_ARITH_CODING_SUPPORTED 1
#define MEM_SRCDST_SUPPORTED 1
#ifndef BITS_IN_JSAMPLE
#define BITS_IN_JSAMPLE 8
#endif
#ifdef _WIN32
#undef RIGHT_SHIFT_IS_UNSIGNED
#ifndef __RPCNDR_H__
typedef unsigned char boolean;
#endif
#define HAVE_BOOLEAN
#if !(defined(_BASETSD_H_) || defined(_BASETSD_H))
typedef short INT16;
typedef signed int INT32;
#endif
#define XMD_H
#endif
`,
        "utf8"
      );
      fs.writeFileSync(
        "/tmp/jpg_inc/jconfigint.h",
        `#define BUILD "20261127"
#define HIDDEN __attribute__((visibility("hidden")))
#define INLINE inline __attribute__((always_inline))
#ifdef _WIN32
#define THREAD_LOCAL __declspec(thread)
#else
#define THREAD_LOCAL __thread
#endif
#define PACKAGE_NAME "libjpeg-turbo"
#define VERSION "${ver}"
#define SIZEOF_SIZE_T __SIZEOF_SIZE_T__
#define HAVE_BUILTIN_CTZL 1
#define FALLTHROUGH __attribute__((fallthrough));
#ifndef BITS_IN_JSAMPLE
#define BITS_IN_JSAMPLE 8
#endif
#if BITS_IN_JSAMPLE == 8
#define C_ARITH_CODING_SUPPORTED 1
#define D_ARITH_CODING_SUPPORTED 1
#define SIMD_ARCHITECTURE NONE
#endif
`,
        "utf8"
      );
      fs.writeFileSync(
        "/tmp/jpg_inc/jversion.h",
        fs.readFileSync("src/src/jversion.h.in", "utf8").replaceAll("@COPYRIGHT_YEAR@", "1991-2026"),
        "utf8"
      );
      const core = [
        "jcapimin.c", "jchuff.c", "jcicc.c", "jcinit.c", "jclhuff.c", "jcmarker.c", "jcmaster.c", "jcomapi.c",
        "jcparam.c", "jcphuff.c", "jctrans.c", "jdapimin.c", "jdatadst.c", "jdatasrc.c", "jdhuff.c", "jdicc.c",
        "jdinput.c", "jdlhuff.c", "jdmarker.c", "jdmaster.c", "jdphuff.c", "jdtrans.c", "jerror.c", "jfdctflt.c",
        "jmemmgr.c", "jmemnobs.c", "jpeg_nbits.c", "jaricom.c", "jcarith.c", "jdarith.c",
      ].map((f) => `src/src/${f}`);
      const wrap = findFiles(
        "src/src/wrapper",
        (_p, n) => n.endsWith(".c") && n !== "template.c" && !/^(rdpng|wrpng|rdppm|wrppm)/.test(n),
        1
      );
      compileMultiOs(libOut, { includeWasi: true, winExportAll: true, commonArgs: ["-I/tmp/jpg_inc", "-Isrc/src", ...core, ...wrap] });
      break;
    }
    case "libffi": {
      cloneTag(repo, tag);
      fs.mkdirSync("/tmp/ffi_inc", { recursive: true });
      const ver = version.replace(/^v/, "").split("-")[0];
      const [maj = "3", min = "8", pat = "0"] = ver.split(".");
      const verNum = String(Number(maj) * 10000 + Number(min) * 100 + Number(pat));
      const tpl = fs
        .readFileSync("src/include/ffi.h.in", "utf8")
        .replaceAll("@VERSION@", ver)
        .replaceAll("@TARGET@", "TARGET_PLACEHOLDER")
        .replaceAll("@HAVE_LONG_DOUBLE@", "0")
        .replaceAll("@HAVE_LONG_DOUBLE_VARIANT@", "0")
        .replaceAll("@FFI_EXEC_TRAMPOLINE_TABLE@", "0")
        .replaceAll("@FFI_VERSION_NUMBER@", verNum)
        .replace("#ifndef TARGET_PLACEHOLDER", "#ifndef LIBFFI_TARGET_DEFINED")
        .replace("#define TARGET_PLACEHOLDER", "#define LIBFFI_TARGET_DEFINED");
      fs.writeFileSync("/tmp/ffi_inc/ffi.h", tpl, "utf8");
      fs.writeFileSync(
        "/tmp/ffi_inc/fficonfig.h",
        `#define PACKAGE "libffi"
#define PACKAGE_VERSION "3.8.2"
#define VERSION "3.8.2"
#define STDC_HEADERS 1
#define HAVE_STDINT_H 1
#define HAVE_INTTYPES_H 1
#define HAVE_MEMCPY 1
#define FFI_EXEC_TRAMPOLINE_TABLE 0
#if !defined(_WIN32) && !defined(__wasi__)
#define HAVE_ALLOCA_H 1
#define HAVE_MMAP_FILE 1
#define HAVE_MMAP_DEV_ZERO 1
#define HAVE_MMAP_ANON 1
#define HAVE_SYS_MMAN_H 1
#define HAVE_MKOSTEMP 1
#endif
#ifdef __APPLE__
#define HAVE_RO_EH_FRAME 1
#endif
#define EH_FRAME_FLAGS "a"
#if defined(__GNUC__) && !defined(_WIN32)
#  ifdef LIBFFI_ASM
#    ifdef __APPLE__
#      define FFI_HIDDEN(name) .private_extern name
#    else
#      define FFI_HIDDEN(name) .hidden name
#    endif
#  else
#    define FFI_HIDDEN __attribute__ ((visibility ("hidden")))
#  endif
#else
#  ifdef LIBFFI_ASM
#    define FFI_HIDDEN(name)
#  else
#    define FFI_HIDDEN
#  endif
#endif
`,
        "utf8"
      );
      const common = [
        "-I/tmp/ffi_inc", "-Isrc/include", "-Isrc/src",
        "src/src/prep_cif.c", "src/src/types.c", "src/src/raw_api.c", "src/src/java_raw_api.c", "src/src/closures.c", "src/src/tramp.c",
      ];
      zigCc("x86_64-windows-gnu", ["-O2", "-shared", "-s", ...common, "-Isrc/src/x86", "-DX86_WIN64", "-DFFI_BUILDING_DLL", "src/src/x86/ffiw64.c", "src/src/x86/win64.S", "-o", `dist/${libOut}-win64.dll`, `-Wl,--out-implib,dist/${libOut}-win64.dll.a`]);
      zigCc("x86_64-linux-gnu", ["-O2", "-shared", "-fPIC", "-s", ...common, "-Isrc/src/x86", "-DX86_64", "src/src/x86/ffi64.c", "src/src/x86/unix64.S", "src/src/x86/ffiw64.c", "src/src/x86/win64.S", "-o", `dist/${libOut}-linux-x64.so`]);
      zigCc("aarch64-linux-gnu", ["-O2", "-shared", "-fPIC", "-s", ...common, "-Isrc/src/aarch64", "-DAARCH64", "src/src/aarch64/ffi.c", "src/src/aarch64/sysv.S", "-o", `dist/${libOut}-linux-arm64.so`]);
      zigCc("aarch64-macos", ["-O2", "-shared", "-fPIC", ...common, "-Isrc/src/aarch64", "-DAARCH64", "src/src/aarch64/ffi.c", "src/src/aarch64/sysv.S", "-o", `dist/${libOut}-macos-arm64.dylib`]);
      break;
    }
    case "ngtcp2": {
      cloneTag(repo, tag, "src", { recurseSubmodules: true });
      fs.mkdirSync("/tmp/ngtcp2_inc/ngtcp2", { recursive: true });
      const ver = version.replace(/^v/, "").split("-")[0];
      const [maj = "1", min = "0", pat = "0"] = ver.split(".");
      const hex = `0x${[maj, min, pat].map((x) => Number(x).toString(16).padStart(2, "0")).join("")}`;
      const tpl = fs
        .readFileSync("src/lib/includes/ngtcp2/version.h.in", "utf8")
        .replaceAll("@PACKAGE_VERSION@", ver)
        .replaceAll("@PACKAGE_VERSION_NUM@", hex);
      fs.writeFileSync("/tmp/ngtcp2_inc/ngtcp2/version.h", tpl, "utf8");
      const srcs = findFiles("src/lib", (_p, n) => n.startsWith("ngtcp2_") && n.endsWith(".c"), 1);
      compileMultiOs(libOut, {
        includeWasi: true,
        commonArgs: ["-I/tmp/ngtcp2_inc", "-Isrc/lib/includes", "-Isrc/lib", "-DBUILDING_NGTCP2", ...srcs],
        winArgs: ["-DHAVE_WINSOCK2_H=1", "-lws2_32"],
        linuxArgs: ["-DHAVE_ARPA_INET_H=1", "-DHAVE_NETINET_IN_H=1"],
        macArgs: ["-DHAVE_ARPA_INET_H=1", "-DHAVE_NETINET_IN_H=1"],
        wasiArgs: ["-DHAVE_ARPA_INET_H=1", "-DHAVE_NETINET_IN_H=1"],
      });
      break;
    }
    case "libxml2": {
      cloneTag(repo, tag);
      genLibxml2Headers("src", "/tmp/xml_inc");
      const srcs = XML2_REL_SRCS.map((f) => `src/${f}`);
      compileMultiOs(libOut, {
        includeWasi: true,
        commonArgs: ["-I/tmp/xml_inc", "-Isrc/include", "-Isrc", "-DHAVE_CONFIG_H", ...srcs],
        winArgs: ["-DIN_LIBXML", "-lbcrypt", "-lws2_32"],
        linuxArgs: ["-lm"],
        macArgs: ["-lm"],
        wasiArgs: ["-Ddup(x)=(x)", "-lm"],
      });
      break;
    }
    case "libxslt": {
      cloneTag(repo, tag);
      cloneTag("GNOME/libxml2", "v2.15.4", "/tmp/libxml2_src");
      genLibxml2Headers("/tmp/libxml2_src", "/tmp/xml_inc");
      fs.mkdirSync("/tmp/xml2_dist", { recursive: true });
      fs.mkdirSync("/tmp/xslt_inc/libxslt", { recursive: true });
      fs.mkdirSync("/tmp/xslt_inc/libexslt", { recursive: true });

      const xmlTmpSrcs = XML2_REL_SRCS.map((f) => `/tmp/libxml2_src/${f}`);
      const xmlTmpFlags = ["-I/tmp/xml_inc", "-I/tmp/libxml2_src/include", "-I/tmp/libxml2_src", "-DHAVE_CONFIG_H", ...xmlTmpSrcs];
      zigCc("x86_64-windows-gnu", ["-O2", "-shared", "-s", "-DIN_LIBXML", ...xmlTmpFlags, "-lbcrypt", "-lws2_32", "-o", "/tmp/xml2_dist/libxml2-win64.dll", "-Wl,--out-implib,/tmp/xml2_dist/libxml2-win64.dll.a"]);
      zigCc("x86_64-linux-gnu", ["-O2", "-shared", "-fPIC", "-s", "-Wl,-soname,libxml2-linux-x64.so", ...xmlTmpFlags, "-lm", "-o", "/tmp/xml2_dist/libxml2-linux-x64.so"]);
      zigCc("aarch64-linux-gnu", ["-O2", "-shared", "-fPIC", "-s", "-Wl,-soname,libxml2-linux-arm64.so", ...xmlTmpFlags, "-lm", "-o", "/tmp/xml2_dist/libxml2-linux-arm64.so"]);

      const ver = version.replace(/^v/, "").split("-")[0];
      const [maj = "1", min = "1", mic = "0"] = ver.split(".");
      const num = String(Number(maj) * 10000 + Number(min) * 100 + Number(mic));
      let tpl = fs.readFileSync("src/libxslt/xsltconfig.h.in", "utf8");
      const reps: Record<string, string> = {
        "@VERSION@": ver,
        "@LIBXSLT_VERSION_NUMBER@": num,
        "@LIBXSLT_VERSION_EXTRA@": "",
        "@WITH_XSLT_DEBUG@": "0",
        "@WITH_TRIO@": "0",
        "@WITH_DEBUGGER@": "0",
        "@WITH_PROFILER@": "1",
        "@WITH_MODULES@": "0",
        "@LIBXSLT_DEFAULT_PLUGINS_PATH@": "/usr/lib/libxslt-plugins",
      };
      for (const [k, v] of Object.entries(reps)) tpl = tpl.replaceAll(k, v);
      fs.writeFileSync("/tmp/xslt_inc/libxslt/xsltconfig.h", tpl, "utf8");
      fs.writeFileSync(
        "/tmp/xslt_inc/config.h",
        `#define HAVE_INTTYPES_H 1
#define HAVE_STDINT_H 1
#define HAVE_SNPRINTF 1
#define HAVE_VSNPRINTF 1
#define HAVE_STAT 1
#define XML_SYSCONFDIR "/etc"
#ifndef _WIN32
#define HAVE_UNISTD_H 1
#define HAVE_GETTIMEOFDAY 1
#define HAVE_GMTIME_R 1
#define HAVE_LOCALTIME_R 1
#define HAVE_SYS_SELECT_H 1
#define HAVE_SYS_STAT_H 1
#define HAVE_SYS_TIME_H 1
#define HAVE_SYS_TYPES_H 1
#define HAVE_LOCALE_H 1
#else
#define HAVE__STAT 1
#define HAVE_SYS_TIMEB_H 1
#define HAVE_SYS_STAT_H 1
#define HAVE_SYS_TYPES_H 1
#define HAVE_LOCALE_H 1
#endif
`,
        "utf8"
      );
      const xsltSrcs = [
        "attributes.c", "attrvt.c", "documents.c", "extensions.c", "extra.c", "functions.c", "imports.c",
        "keys.c", "namespaces.c", "numbers.c", "pattern.c", "preproc.c", "security.c", "templates.c",
        "transform.c", "variables.c", "xslt.c", "xsltlocale.c", "xsltutils.c",
      ].map((f) => `src/libxslt/${f}`);
      const xsltFlags = ["-I/tmp/xslt_inc", "-Isrc", "-I/tmp/xml_inc", "-I/tmp/libxml2_src/include", "-DHAVE_CONFIG_H", ...xsltSrcs];
      zigCc("x86_64-windows-gnu", ["-O2", "-shared", "-s", "-DIN_LIBXSLT", ...xsltFlags, "/tmp/xml2_dist/libxml2-win64.dll.a", "-o", `dist/${libOut}-win64.dll`, `-Wl,--out-implib,dist/${libOut}-win64.dll.a`]);
      zigCc("x86_64-linux-gnu", ["-O2", "-shared", "-fPIC", "-s", ...xsltFlags, "/tmp/xml2_dist/libxml2-linux-x64.so", "-Wl,-rpath,$ORIGIN", "-lm", "-o", `dist/${libOut}-linux-x64.so`]);
      zigCc("aarch64-linux-gnu", ["-O2", "-shared", "-fPIC", "-s", ...xsltFlags, "/tmp/xml2_dist/libxml2-linux-arm64.so", "-Wl,-rpath,$ORIGIN", "-lm", "-o", `dist/${libOut}-linux-arm64.so`]);
      zigCc("aarch64-macos", ["-O2", "-shared", "-fPIC", ...xsltFlags, "-lm", "-Wl,-undefined,dynamic_lookup", "-o", `dist/${libOut}-macos-arm64.dylib`]);
      zigCc("wasm32-wasi", ["-O2", "-mexec-model=reactor", ...xsltFlags, "-I/tmp/libxml2_src", "-Ddup(x)=(x)", ...xmlTmpSrcs, "-lm", "-o", `dist/${libOut}-wasm32-wasi.wasm`]);
      dlLdLibraryPath = "/tmp/xml2_dist";
      break;
    }
    case "woff2": {
      cloneTag(repo, tag);
      cloneTag("google/brotli", "", "/tmp/brotli_src");
      const woffSrcs = [
        "table_tags.cc", "variable_length.cc", "woff2_common.cc", "woff2_dec.cc", "woff2_out.cc",
        "font.cc", "glyph.cc", "normalize.cc", "transform.cc", "woff2_enc.cc",
      ].map((f) => `src/src/${f}`);
      const brotliSrcs = [
        ...findFiles("/tmp/brotli_src/c/common", (_p, n) => n.endsWith(".c"), 1),
        ...findFiles("/tmp/brotli_src/c/dec", (_p, n) => n.endsWith(".c"), 1),
        ...findFiles("/tmp/brotli_src/c/enc", (_p, n) => n.endsWith(".c"), 1),
      ];
      compileMultiOs(libOut, {
        cxx: true,
        includeWasi: true,
        winExportAll: true,
        commonArgs: ["-D__STDC_FORMAT_MACROS", "-Isrc/include", "-Isrc/src", "-I/tmp/brotli_src/c/include", "-I/tmp/brotli_src/c", ...woffSrcs, ...brotliSrcs],
        macArgs: ["-DOS_MACOSX"],
        wasiArgs: ["-fno-exceptions"],
      });
      break;
    }
    case "libarchive": {
      cloneTag(repo, tag);
      fs.mkdirSync("/tmp/arc_inc", { recursive: true });
      const stripLine = (p: string, re: RegExp): void => {
        const s = fs.readFileSync(p, "utf8").split(/\r?\n/).filter((l) => !re.test(l)).join("\n");
        fs.writeFileSync(p, `${s}\n`, "utf8");
      };
      stripLine("src/libarchive/archive_cryptor_private.h", /#  define ARCHIVE_CRYPTOR_USE_Apple_CommonCrypto 1/);
      stripLine("src/libarchive/archive_hmac_private.h", /#  define ARCHIVE_HMAC_USE_Apple_CommonCrypto/);
      fs.writeFileSync(
        "/tmp/arc_inc/config.h",
        `#ifndef LIBARCHIVE_CONFIG_H
#define LIBARCHIVE_CONFIG_H
#define __LIBARCHIVE_CONFIG_H_INCLUDED 1
#define HAVE_CTYPE_H 1
#define HAVE_ERRNO_H 1
#define HAVE_FCNTL_H 1
#define HAVE_INTTYPES_H 1
#define HAVE_LIMITS_H 1
#define HAVE_STDARG_H 1
#define HAVE_STDINT_H 1
#define HAVE_STDLIB_H 1
#define HAVE_STRING_H 1
#define HAVE_SYS_STAT_H 1
#define HAVE_SYS_TYPES_H 1
#define HAVE_TIME_H 1
#define HAVE_WCHAR_H 1
#define HAVE_WCTYPE_H 1
#define HAVE_WCSCPY 1
#define HAVE_WCSLEN 1
#define HAVE_DECL_INT32_MAX 1
#define HAVE_DECL_INT32_MIN 1
#define HAVE_DECL_INT64_MAX 1
#define HAVE_DECL_INT64_MIN 1
#define HAVE_DECL_INTMAX_MAX 1
#define HAVE_DECL_INTMAX_MIN 1
#define HAVE_DECL_SIZE_MAX 1
#define HAVE_DECL_SSIZE_MAX 1
#define HAVE_DECL_UINT32_MAX 1
#define HAVE_DECL_UINT64_MAX 1
#define HAVE_DECL_UINTMAX_MAX 1
#define HAVE_DECL_STRERROR_R 1
#define HAVE_INTMAX_T 1
#define HAVE_UINTMAX_T 1
#define HAVE_INT16_T 1
#define HAVE_INT32_T 1
#define HAVE_INT64_T 1
#define HAVE_UINT8_T 1
#define HAVE_UINT16_T 1
#define HAVE_UINT32_T 1
#define HAVE_UINT64_T 1
#define HAVE_MEMMOVE 1
#define HAVE_MEMSET 1
#define HAVE_STRCHR 1
#define HAVE_STRDUP 1
#define HAVE_STRERROR 1
#define HAVE_STRRCHR 1
#define HAVE_UNLINK 1
#define HAVE_STRUCT_STAT_ST_MTIME 1
#if defined(_WIN32)
#  define HAVE_WINDOWS_H 1
#  define HAVE_WINCRYPT_H 1
#  define HAVE_BCRYPT_H 1
#  define HAVE_SYS_UTIME_H 1
#  define HAVE__FSEEKI64 1
#  define HAVE__GET_TIMEZONE 1
#  define SIZEOF_WCHAR_T 2
#  define uid_t short
#  define gid_t short
#  define id_t short
#else
#  define HAVE_DIRENT_H 1
#  define HAVE_STRUCT_TM_TM_GMTOFF 1
#  define HAVE_FCNTL 1
#  define HAVE_FSTAT 1
#  define HAVE_FTRUNCATE 1
#  define HAVE_GMTIME_R 1
#  define HAVE_LOCALTIME_R 1
#  define HAVE_LSTAT 1
#  define HAVE_MKDIR 1
#  define HAVE_OPENAT 1
#  define HAVE_POLL 1
#  define HAVE_POLL_H 1
#  define HAVE_READDIR_R 1
#  define HAVE_READLINK 1
#  define HAVE_READLINKAT 1
#  define HAVE_STRERROR_R 1
#  define HAVE_STRINGS_H 1
#  define HAVE_SYMLINK 1
#  define HAVE_SYS_TIME_H 1
#  define HAVE_UNISTD_H 1
#  define HAVE_UTIME 1
#  define HAVE_UTIME_H 1
#  define HAVE_UTIMENSAT 1
#  define HAVE_FUTIMENS 1
#  define SIZEOF_WCHAR_T 4
#  if defined(__APPLE__)
#    define HAVE_STRUCT_STAT_ST_MTIMESPEC_TV_NSEC 1
#  else
#    define HAVE_STRUCT_STAT_ST_MTIM_TV_NSEC 1
#  endif
#  if !defined(__wasi__)
#    define HAVE_GETEUID 1
#    define HAVE_GETUID 1
#    define HAVE_TIMEGM 1
#    define HAVE_TZSET 1
#    define HAVE_CHOWN 1
#    define HAVE_FCHDIR 1
#    define HAVE_FCHMOD 1
#    define HAVE_FCHOWN 1
#    define HAVE_FORK 1
#    define HAVE_FSTATAT 1
#    define HAVE_FSTATFS 1
#    define HAVE_FSTATVFS 1
#    define HAVE_GETGRGID_R 1
#    define HAVE_GETGRNAM_R 1
#    define HAVE_GETPWNAM_R 1
#    define HAVE_GETPWUID_R 1
#    define HAVE_GRP_H 1
#    define HAVE_LINK 1
#    define HAVE_LCHOWN 1
#    define HAVE_MKNOD 1
#    define HAVE_MKFIFO 1
#    define HAVE_PIPE 1
#    define HAVE_PWD_H 1
#    define HAVE_SELECT 1
#    define HAVE_SETENV 1
#    define HAVE_SIGNAL_H 1
#    define HAVE_STATFS 1
#    define HAVE_STATVFS 1
#    define HAVE_SYS_IOCTL_H 1
#    define HAVE_SYS_PARAM_H 1
#    define HAVE_SYS_SELECT_H 1
#    ifdef __linux__
#      define HAVE_SYS_STATFS_H 1
#    endif
#    ifdef __APPLE__
#      define HAVE_SYS_MOUNT_H 1
#    endif
#    define HAVE_SYS_STATVFS_H 1
#    define HAVE_SYS_UTSNAME_H 1
#    define HAVE_SYS_WAIT_H 1
#    define HAVE_UNAME 1
#    define HAVE_VFORK 1
#    define HAVE_WAITPID 1
#  endif
#endif
#define SIZEOF_INT 4
#define SIZEOF_LONG_LONG 8
#endif
`,
        "utf8"
      );
      const isSkipPlatform = (n: string): boolean =>
        n.startsWith("test_") || n.startsWith("archive_disk_acl_") || /_(darwin|freebsd|linux|sunos)\.c$/.test(n);
      const arcWin = findFiles("src/libarchive", (_p, n) => n.endsWith(".c") && !isSkipPlatform(n), 1);
      const arcCommon = arcWin.filter((f) => !/_(windows|bhfi)\.c$/.test(f) && !f.endsWith("/filter_fork_windows.c"));
      const baseFlags = ["-I/tmp/arc_inc", "-Isrc/libarchive", "-DHAVE_CONFIG_H"];
      zigCc("x86_64-windows-gnu", ["-O2", "-shared", "-s", ...baseFlags, ...arcWin, "-lbcrypt", "-o", `dist/${libOut}-win64.dll`, `-Wl,--out-implib,dist/${libOut}-win64.dll.a`]);
      zigCc("x86_64-linux-gnu", ["-O2", "-shared", "-fPIC", "-s", ...baseFlags, ...arcCommon, "-o", `dist/${libOut}-linux-x64.so`]);
      zigCc("aarch64-linux-gnu", ["-O2", "-shared", "-fPIC", "-s", ...baseFlags, ...arcCommon, "-o", `dist/${libOut}-linux-arm64.so`]);
      zigCc("aarch64-macos", ["-O2", "-shared", "-fPIC", ...baseFlags, ...arcCommon, "-o", `dist/${libOut}-macos-arm64.dylib`]);
      zigCc("wasm32-wasi", ["-O2", "-mexec-model=reactor", ...baseFlags, "-Dumask(m)=(0)", "-Ddup(fd)=(fd)", "-D_WASI_EMULATED_GETPID", ...arcCommon, "-lwasi-emulated-getpid", "-o", `dist/${libOut}-wasm32-wasi.wasm`]);
      break;
    }
    default:
      throw new Error(`Unknown Tier-3 libKey: ${libKey}`);
  }

  verifyAndSmokeTest({ libKey, libOut, dlLdLibraryPath });
  emitSha512AndReceipt({ libKey, libOut, repo, tag, version });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const cmd = process.argv[2];
  if (cmd === "resolve") {
    await resolveVersionsPhase({
      tier: "tier3",
      releaseNotes:
        "Production max-version 5-OS shared libraries (Win64 .dll, Linux x64/ARM64 .so, macOS ARM64 .dylib, wasm32-wasi .wasm) compiled directly from upstream sources via pure holo-compiler (zig 0.14.0) — zero CMake, zero Ninja, zero Make.",
      resolvedFileName: "resolved-tier3-versions.json",
      defaults: TIER3_DEFAULTS,
    });
  } else if (cmd === "build") {
    const libKey = process.env.LIB_KEY || "";
    const versions = JSON.parse(process.env.VERSIONS_JSON || "{}") as Record<string, LibraryPin>;
    const pin = versions[libKey] ?? TIER3_DEFAULTS[libKey];
    if (!pin) throw new Error(`Missing version pin for ${libKey}`);
    appendGithubOutput({ lib_out: pin.libOut });
    if (checkSkipMaterialized(libKey, pin.libOut, pin.version, process.env.RELEASE_TAG || "v11-max-5os-latest")) {
      process.exit(0);
    }
    appendGithubOutput({ skipped: "false" });
    buildTier3Library(libKey, pin);
  } else if (cmd === "finalize") {
    finalizeTierSumsPhase({
      tierTitle: "Holo 5-OS Tier-3 Shards",
      resolvedArtifactName: "resolved-tier3-versions",
      resolvedFileName: "resolved-tier3-versions.json",
      sumArtifactPrefix: "tier3-sums",
      outSumFileName: "SHA512SUMS-tier3.txt",
    });
  } else {
    throw new Error(`Unknown command: ${cmd ?? "(none)"}`);
  }
}
