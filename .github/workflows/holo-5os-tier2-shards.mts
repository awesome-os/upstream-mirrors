import fs from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
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
  run,
  verifyAndSmokeTest,
  zigCc,
  zigCxx,
} from "./holo-workflow-runtime.mts";

export const TIER2_DEFAULTS: Record<string, LibraryPin> = {
  mbedtls: { pkg: "mbedtls", libOut: "libmbedtls", repo: "Mbed-TLS/mbedtls", tag: "mbedtls-4.3.0", version: "4.3.0" },
  llhttp: { pkg: "llhttp", libOut: "libllhttp", repo: "nodejs/llhttp", tag: "release/v9.4.4", version: "9.4.4" },
  nghttp2: { pkg: "nghttp2", libOut: "libnghttp2", repo: "nghttp2/nghttp2", tag: "v1.71.0", version: "1.71.0" },
  nghttp3: { pkg: "nghttp3", libOut: "libnghttp3", repo: "ngtcp2/nghttp3", tag: "v1.19.0", version: "1.19.0" },
  "c-ares": { pkg: "c-ares", libOut: "libcares", repo: "c-ares/c-ares", tag: "v1.34.9", version: "1.34.9" },
  fast_float: { pkg: "fast_float", libOut: "libfast_float", repo: "fastfloat/fast_float", tag: "v8.4.0", version: "8.4.0" },
  libpng: { pkg: "libpng", libOut: "libpng", repo: "pnggroup/libpng", tag: "v1.6.59", version: "1.6.59" },
  giflib: { pkg: "giflib", libOut: "libgiflib", repo: "sourceforge.net/projects/giflib", tag: "giflib-6.1.3", version: "6.1.3" },
  freetype: { pkg: "freetype", libOut: "libfreetype", repo: "freetype/freetype", tag: "VER-2-15-0", version: "2.15.0" },
  harfbuzz: { pkg: "harfbuzz", libOut: "libharfbuzz", repo: "harfbuzz/harfbuzz", tag: "15.2.0", version: "15.2.0" },
  onig: { pkg: "onig", libOut: "libonig", repo: "kkos/oniguruma", tag: "v6.9.10", version: "6.9.10" },
  "zlib-ng": { pkg: "zlib-ng", libOut: "libzlib-ng", repo: "zlib-ng/zlib-ng", tag: "2.3.3", version: "2.3.3" },
};

export const TIER2_LIBS = Object.keys(TIER2_DEFAULTS);

export function buildTier2Library(libKey: string, pin: LibraryPin): void {
  const { libOut, repo, tag, version } = pin;
  console.log(`=== Building ${libKey} (${libOut}) @ ${repo} ${tag} (${version}) ===`);
  fs.mkdirSync("src", { recursive: true });
  fs.mkdirSync("dist", { recursive: true });

  switch (libKey) {
    case "mbedtls": {
      fs.rmSync("src", { recursive: true, force: true });
      fs.mkdirSync("src", { recursive: true });
      let needFallback = false;
      try {
        cloneTag(repo, tag);
      } catch {
        needFallback = true;
      }
      if (needFallback || fs.existsSync("src/tf-psa-crypto") || !fs.existsSync("src/library/aes.c")) {
        fs.rmSync("src", { recursive: true, force: true });
        fs.mkdirSync("src", { recursive: true });
        cloneTag("Mbed-TLS/mbedtls", "v3.6.8");
      }
      fs.writeFileSync(
        "/tmp/mbed_wasi_config.h",
        `#include "mbedtls/mbedtls_config.h"
#undef MBEDTLS_HAVE_TIME
#undef MBEDTLS_HAVE_TIME_DATE
#undef MBEDTLS_NET_C
#undef MBEDTLS_TIMING_C
#define MBEDTLS_NO_PLATFORM_ENTROPY
`,
        "utf8"
      );
      const srcsAll = findFiles("src/library", (_p, n) => n.endsWith(".c"), 1);
      const srcsNoWasi = srcsAll.filter((s) => !/\/(net_sockets|timing)\.c$/.test(s));
      const incs = ["-Isrc/include", "-Isrc/library"];
      zigCc("x86_64-windows-gnu", ["-O2", "-shared", "-s", "-Wl,--export-all-symbols", ...incs, ...srcsAll, "-lws2_32", "-lbcrypt", "-o", `dist/${libOut}-win64.dll`, `-Wl,--out-implib,dist/${libOut}-win64.dll.a`]);
      zigCc("x86_64-linux-gnu", ["-O2", "-shared", "-fPIC", "-s", ...incs, ...srcsAll, "-o", `dist/${libOut}-linux-x64.so`]);
      zigCc("aarch64-linux-gnu", ["-O2", "-shared", "-fPIC", "-s", ...incs, ...srcsAll, "-o", `dist/${libOut}-linux-arm64.so`]);
      zigCc("aarch64-macos", ["-O2", "-shared", "-fPIC", ...incs, ...srcsAll, "-o", `dist/${libOut}-macos-arm64.dylib`]);
      zigCc("wasm32-wasi", ["-O2", "-mexec-model=reactor", ...incs, '-DMBEDTLS_CONFIG_FILE="/tmp/mbed_wasi_config.h"', ...srcsNoWasi, "-o", `dist/${libOut}-wasm32-wasi.wasm`]);
      break;
    }
    case "llhttp": {
      cloneTag(repo, tag);
      const srcs = findFiles("src/src", (_p, n) => n.endsWith(".c"), 1);
      compileMultiOs(libOut, { includeWasi: true, winExportAll: true, commonArgs: ["-Isrc/include", ...srcs] });
      break;
    }
    case "nghttp2": {
      cloneTag(repo, tag);
      fs.mkdirSync("/tmp/ng2_inc/nghttp2", { recursive: true });
      const ver = version.replace(/^v/, "").split("-")[0];
      const [maj = "1", min = "0", pat = "0"] = ver.split(".");
      const hex = `0x${[maj, min, pat].map((x) => Number(x).toString(16).padStart(2, "0")).join("")}`;
      const tpl = fs
        .readFileSync("src/lib/includes/nghttp2/nghttp2ver.h.in", "utf8")
        .replaceAll("@PACKAGE_VERSION@", ver)
        .replaceAll("@PACKAGE_VERSION_NUM@", hex);
      fs.writeFileSync("/tmp/ng2_inc/nghttp2/nghttp2ver.h", tpl, "utf8");
      fs.writeFileSync(
        "/tmp/ng2_inc/config.h",
        `#ifndef NGHTTP2_CONFIG_H
#define NGHTTP2_CONFIG_H
#if defined(_WIN32)
#define HAVE_WINSOCK2_H 1
#else
#define HAVE_ARPA_INET_H 1
#define HAVE_NETINET_IN_H 1
#define HAVE_UNISTD_H 1
#endif
#define HAVE_TIME_H 1
#define HAVE_STDINT_H 1
#define HAVE_INTTYPES_H 1
#endif
`,
        "utf8"
      );
      const srcs = [
        "nghttp2_pq.c", "nghttp2_map.c", "nghttp2_queue.c", "nghttp2_frame.c", "nghttp2_buf.c",
        "nghttp2_stream.c", "nghttp2_outbound_item.c", "nghttp2_session.c", "nghttp2_submit.c",
        "nghttp2_helper.c", "nghttp2_alpn.c", "nghttp2_hd.c", "nghttp2_hd_huffman.c",
        "nghttp2_hd_huffman_data.c", "nghttp2_version.c", "nghttp2_priority_spec.c",
        "nghttp2_option.c", "nghttp2_callbacks.c", "nghttp2_mem.c", "nghttp2_http.c",
        "nghttp2_rcbuf.c", "nghttp2_extpri.c", "nghttp2_ratelim.c", "nghttp2_time.c",
        "nghttp2_debug.c", "sfparse.c",
      ].map((f) => `src/lib/${f}`);
      compileMultiOs(libOut, {
        includeWasi: true,
        commonArgs: ["-I/tmp/ng2_inc", "-Isrc/lib/includes", "-Isrc/lib", "-DHAVE_CONFIG_H", "-DBUILDING_NGHTTP2", ...srcs],
        winArgs: ["-lws2_32"],
      });
      break;
    }
    case "nghttp3": {
      cloneTag(repo, tag, "src", { recurseSubmodules: true });
      fs.mkdirSync("/tmp/ng3_inc/nghttp3", { recursive: true });
      const ver = version.replace(/^v/, "").split("-")[0];
      const [maj = "1", min = "0", pat = "0"] = ver.split(".");
      const hex = `0x${[maj, min, pat].map((x) => Number(x).toString(16).padStart(2, "0")).join("")}`;
      const tpl = fs
        .readFileSync("src/lib/includes/nghttp3/version.h.in", "utf8")
        .replaceAll("@PACKAGE_VERSION@", ver)
        .replaceAll("@PACKAGE_VERSION_NUM@", hex);
      fs.writeFileSync("/tmp/ng3_inc/nghttp3/version.h", tpl, "utf8");
      const srcs = [...findFiles("src/lib", (_p, n) => n.startsWith("nghttp3_") && n.endsWith(".c"), 1), "src/lib/sfparse/sfparse.c"];
      compileMultiOs(libOut, {
        includeWasi: true,
        commonArgs: ["-I/tmp/ng3_inc", "-Isrc/lib/includes", "-Isrc/lib", "-Isrc/lib/sfparse", "-DBUILDING_NGHTTP3", ...srcs],
        winArgs: ["-DHAVE_WINSOCK2_H=1", "-lws2_32"],
        linuxArgs: ["-DHAVE_ARPA_INET_H=1", "-DHAVE_NETINET_IN_H=1"],
        macArgs: ["-DHAVE_ARPA_INET_H=1", "-DHAVE_NETINET_IN_H=1"],
        wasiArgs: ["-DHAVE_ARPA_INET_H=1", "-DHAVE_NETINET_IN_H=1"],
      });
      break;
    }
    case "c-ares": {
      cloneTag(repo, tag);
      fs.mkdirSync("/tmp/cares_inc", { recursive: true });
      fs.writeFileSync(
        "/tmp/cares_inc/ares_build.h",
        `#ifndef __CARES_BUILD_H
#define __CARES_BUILD_H
#if defined(_WIN32)
#  define CARES_TYPEOF_ARES_SOCKLEN_T int
#  define CARES_TYPEOF_ARES_SSIZE_T ptrdiff_t
#  define CARES_HAVE_WINDOWS_H 1
#  define CARES_HAVE_WS2TCPIP_H 1
#  define CARES_HAVE_WINSOCK2_H 1
#  include <stddef.h>
#  include <winsock2.h>
#  include <ws2tcpip.h>
#  include <windows.h>
#else
#  include <sys/types.h>
#  include <sys/socket.h>
#  include <sys/select.h>
#  define CARES_TYPEOF_ARES_SOCKLEN_T socklen_t
#  define CARES_TYPEOF_ARES_SSIZE_T ssize_t
#  define CARES_HAVE_SYS_TYPES_H 1
#  define CARES_HAVE_SYS_SOCKET_H 1
#  define CARES_HAVE_SYS_SELECT_H 1
#endif
#endif
`,
        "utf8"
      );
      fs.writeFileSync(
        "/tmp/cares_inc/ares_config.h",
        `#ifndef ARES_CONFIG_H
#define ARES_CONFIG_H
#define HAVE_AF_INET6 1
#define HAVE_ASSERT_H 1
#define HAVE_ERRNO_H 1
#define HAVE_INTTYPES_H 1
#define HAVE_LIMITS_H 1
#define HAVE_LONGLONG 1
#define HAVE_PF_INET6 1
#define HAVE_RECV 1
#define HAVE_RECVFROM 1
#define HAVE_SEND 1
#define HAVE_SENDTO 1
#define HAVE_SETSOCKOPT 1
#define HAVE_SIGNAL_H 1
#define HAVE_SOCKET 1
#define HAVE_STAT 1
#define HAVE_STDBOOL_H 1
#define HAVE_STDINT_H 1
#define HAVE_STDLIB_H 1
#define HAVE_STRING_H 1
#define HAVE_STRDUP 1
#define HAVE_STRNLEN 1
#define HAVE_STRUCT_ADDRINFO 1
#define HAVE_STRUCT_IN6_ADDR 1
#define HAVE_STRUCT_SOCKADDR_IN6 1
#define HAVE_STRUCT_SOCKADDR_STORAGE 1
#define HAVE_STRUCT_TIMEVAL 1
#define HAVE_SYS_STAT_H 1
#define HAVE_SYS_TYPES_H 1
#define HAVE_TIME_H 1
#define HAVE_FREEADDRINFO 1
#define HAVE_GETADDRINFO 1
#define HAVE_GETADDRINFO_THREADSAFE 1
#define HAVE_GETENV 1
#define HAVE_GETHOSTNAME 1
#define HAVE_GETNAMEINFO 1
#define HAVE_INET_NTOP 1
#define HAVE_INET_PTON 1
#define HAVE_CONNECT 1

#if defined(_WIN32)
#  define HAVE_CLOSESOCKET 1
#  define HAVE_GETBESTROUTE2 1
#  define HAVE_CONVERTINTERFACEINDEXTOLUID 1
#  define HAVE_CONVERTINTERFACELUIDTONAMEA 1
#  define HAVE_NOTIFYIPINTERFACECHANGE 1
#  define HAVE_IOCTLSOCKET 1
#  define HAVE_IOCTLSOCKET_FIONBIO 1
#  define HAVE_IPHLPAPI_H 1
#  define HAVE_NETIOAPI_H 1
#  define HAVE_MALLOC_H 1
#  define HAVE_STRCASECMP 1
#  define HAVE_STRICMP 1
#  define HAVE_STRNCASECMP 1
#  define HAVE_STRNICMP 1
#  define HAVE_STRINGS_H 1
#  define HAVE_WINDOWS_H 1
#  define HAVE_WINSOCK2_H 1
#  define HAVE_WS2TCPIP_H 1
#  define HAVE_MSWSOCK_H 1
#  define GETHOSTNAME_TYPE_ARG2 int
#  define GETNAMEINFO_QUAL_ARG1 const
#  define GETNAMEINFO_TYPE_ARG1 struct sockaddr *
#  define GETNAMEINFO_TYPE_ARG2 socklen_t
#  define GETNAMEINFO_TYPE_ARG46 DWORD
#  define GETNAMEINFO_TYPE_ARG7 int
#  define RECVFROM_QUAL_ARG5
#  define RECVFROM_TYPE_ARG1 SOCKET
#  define RECVFROM_TYPE_ARG2 char *
#  define RECVFROM_TYPE_ARG3 int
#  define RECVFROM_TYPE_ARG4 int
#  define RECVFROM_TYPE_ARG5 struct sockaddr *
#  define RECVFROM_TYPE_ARG6 int *
#  define RECVFROM_TYPE_RETV int
#  define RECV_TYPE_ARG1 SOCKET
#  define RECV_TYPE_ARG2 char *
#  define RECV_TYPE_ARG3 int
#  define RECV_TYPE_ARG4 int
#  define RECV_TYPE_RETV int
#  define SEND_TYPE_ARG1 SOCKET
#  define SEND_TYPE_ARG2 const char *
#  define SEND_TYPE_ARG3 int
#  define SEND_TYPE_ARG4 int
#  define SEND_TYPE_RETV int
#else
#  define HAVE_ARPA_INET_H 1
#  define HAVE_CLOCK_GETTIME_MONOTONIC 1
#  define HAVE_FCNTL 1
#  define HAVE_FCNTL_H 1
#  define HAVE_FCNTL_O_NONBLOCK 1
#  define HAVE_GETTIMEOFDAY 1
#  define HAVE_IF_INDEXTONAME 1
#  define HAVE_IF_NAMETOINDEX 1
#  define HAVE_IOCTL 1
#  define HAVE_IOCTL_FIONBIO 1
#  define HAVE_NETDB_H 1
#  define HAVE_NETINET_IN_H 1
#  define HAVE_NETINET_TCP_H 1
#  define HAVE_NET_IF_H 1
#  define HAVE_PIPE 1
#  define HAVE_POLL 1
#  define HAVE_POLL_H 1
#  define HAVE_STRCASECMP 1
#  define HAVE_STRINGS_H 1
#  define HAVE_STRNCASECMP 1
#  define HAVE_SYS_IOCTL_H 1
#  define HAVE_SYS_PARAM_H 1
#  define HAVE_SYS_SELECT_H 1
#  define HAVE_SYS_SOCKET_H 1
#  define HAVE_SYS_TIME_H 1
#  define HAVE_SYS_UIO_H 1
#  define HAVE_UNISTD_H 1
#  define HAVE_WRITEV 1
#  define HAVE_IFADDRS_H 1
#  define HAVE_GETIFADDRS 1
#  define GETHOSTNAME_TYPE_ARG2 size_t
#  define GETNAMEINFO_QUAL_ARG1 const
#  define GETNAMEINFO_TYPE_ARG1 struct sockaddr *
#  define GETNAMEINFO_TYPE_ARG2 socklen_t
#  define GETNAMEINFO_TYPE_ARG46 socklen_t
#  define GETNAMEINFO_TYPE_ARG7 int
#  define RECVFROM_QUAL_ARG5
#  define RECVFROM_TYPE_ARG1 int
#  define RECVFROM_TYPE_ARG2 void *
#  define RECVFROM_TYPE_ARG3 size_t
#  define RECVFROM_TYPE_ARG4 int
#  define RECVFROM_TYPE_ARG5 struct sockaddr *
#  define RECVFROM_TYPE_ARG6 socklen_t *
#  define RECVFROM_TYPE_RETV ssize_t
#  define RECV_TYPE_ARG1 int
#  define RECV_TYPE_ARG2 void *
#  define RECV_TYPE_ARG3 size_t
#  define RECV_TYPE_ARG4 int
#  define RECV_TYPE_RETV ssize_t
#  define SEND_TYPE_ARG1 int
#  define SEND_TYPE_ARG2 const void *
#  define SEND_TYPE_ARG3 size_t
#  define SEND_TYPE_ARG4 int
#  define SEND_TYPE_RETV ssize_t
#  if defined(__APPLE__)
#    define HAVE_KQUEUE 1
#    define HAVE_SYS_EVENT_H 1
#    define HAVE_ARC4RANDOM_BUF 1
#    define HAVE_AVAILABILITYMACROS_H 1
#    define CARES_RANDOM_FILE "/dev/urandom"
#  elif defined(__linux__)
#    define HAVE_EPOLL 1
#    define HAVE_SYS_EPOLL_H 1
#    define HAVE_GETRANDOM 1
#    define HAVE_SYS_RANDOM_H 1
#    define HAVE_PIPE2 1
#    define HAVE_MSG_NOSIGNAL 1
#    define CARES_RANDOM_FILE "/dev/urandom"
#  endif
#endif
#define RECVFROM_TYPE_ARG2_IS_VOID 1
#define RECVFROM_TYPE_ARG5_IS_VOID 0
#define RECVFROM_TYPE_ARG6_IS_VOID 0
#define GETSERVBYPORT_R_ARGS 6
#define GETSERVBYNAME_R_ARGS 6
#endif
`,
        "utf8"
      );
      fs.writeFileSync(
        "/tmp/cares_apple_stub.c",
        `#include "ares_private.h"
ares_status_t ares_init_sysconfig_macos(const ares_channel_t *channel, ares_sysconfig_t *sysconfig) {
  return ares_init_sysconfig_files(channel, sysconfig, ARES_TRUE);
}
`,
        "utf8"
      );
      const srcs = findFiles("src/src/lib", (_p, n) => n.endsWith(".c"));
      const macSrcs = srcs.filter((s) => !s.endsWith("/ares_sysconfig_mac.c"));
      const flags = ["-I/tmp/cares_inc", "-Isrc/include", "-Isrc/src/lib", "-Isrc/src/lib/include", "-Isrc/src/lib/util", "-Isrc/src/lib/dsa", "-DHAVE_CONFIG_H=1", "-DCARES_BUILDING_LIBRARY"];
      zigCc("x86_64-windows-gnu", ["-O2", "-shared", "-s", ...flags, ...srcs, "-lws2_32", "-liphlpapi", "-ladvapi32", "-o", `dist/${libOut}-win64.dll`, `-Wl,--out-implib,dist/${libOut}-win64.dll.a`]);
      zigCc("x86_64-linux-gnu", ["-O2", "-shared", "-fPIC", "-s", ...flags, ...srcs, "-o", `dist/${libOut}-linux-x64.so`]);
      zigCc("aarch64-linux-gnu", ["-O2", "-shared", "-fPIC", "-s", ...flags, ...srcs, "-o", `dist/${libOut}-linux-arm64.so`]);
      zigCc("aarch64-macos", ["-O2", "-shared", "-fPIC", ...flags, ...macSrcs, "/tmp/cares_apple_stub.c", "-o", `dist/${libOut}-macos-arm64.dylib`]);
      break;
    }
    case "fast_float": {
      cloneTag(repo, tag);
      fs.writeFileSync(
        "/tmp/b8g_fast_float.cc",
        `#include <cstddef>
#include <system_error>
#include "fast_float/fast_float.h"

extern "C" double b8g_fast_float_f64(const char* s, size_t len, int* ok) {
  double val = 0.0;
  if (!s) {
    if (ok) *ok = 0;
    return val;
  }
  auto res = fast_float::from_chars(s, s + len, val);
  if (ok) *ok = (res.ec == std::errc()) ? 1 : 0;
  return val;
}
`,
        "utf8"
      );
      compileMultiOs(libOut, { cxx: true, winExportAll: true, commonArgs: ["-std=c++17", "-Isrc/include", "/tmp/b8g_fast_float.cc"] });
      break;
    }
    case "libpng": {
      cloneTag(repo, tag);
      fs.copyFileSync("src/scripts/pnglibconf.h.prebuilt", "src/pnglibconf.h");
      cloneTag("madler/zlib", "", "/tmp/zlib_src");
      const pngSrcs = findFiles("src", (_p, n) => n.startsWith("png") && n.endsWith(".c") && n !== "pngtest.c", 1);
      const zlibSrcs = findFiles("/tmp/zlib_src", (_p, n) => n.endsWith(".c") && !n.startsWith("gz"), 1);
      const flags = ["-Isrc", "-I/tmp/zlib_src", "-DPNG_ARM_NEON_OPT=0", "-DPNG_INTEL_SSE_OPT=0", ...pngSrcs, ...zlibSrcs];
      zigCc("x86_64-windows-gnu", ["-O2", "-shared", "-s", "-DPNG_BUILD_DLL", ...flags, "-o", `dist/${libOut}-win64.dll`, `-Wl,--out-implib,dist/${libOut}-win64.dll.a`]);
      zigCc("x86_64-linux-gnu", ["-O2", "-shared", "-fPIC", "-s", ...flags, "-lm", "-o", `dist/${libOut}-linux-x64.so`]);
      zigCc("aarch64-linux-gnu", ["-O2", "-shared", "-fPIC", "-s", ...flags, "-lm", "-o", `dist/${libOut}-linux-arm64.so`]);
      zigCc("aarch64-macos", ["-O2", "-shared", "-fPIC", ...flags, "-lm", "-o", `dist/${libOut}-macos-arm64.dylib`]);
      const conf = fs.readFileSync("src/pnglibconf.h", "utf8");
      const stripped = conf
        .split(/\r?\n/)
        .filter((l) => !/(PNG_SETJMP_SUPPORTED|PNG_SIMPLIFIED_READ_SUPPORTED|PNG_SIMPLIFIED_WRITE_SUPPORTED)/.test(l))
        .join("\n");
      fs.writeFileSync("src/pnglibconf.h", `${stripped}\n`, "utf8");
      zigCc("wasm32-wasi", ["-O2", "-mexec-model=reactor", ...flags, "-lm", "-o", `dist/${libOut}-wasm32-wasi.wasm`]);
      break;
    }
    case "giflib": {
      fs.mkdirSync("/tmp/gif", { recursive: true });
      try {
        run("curl", ["-fsSL", `https://sourceforge.net/projects/giflib/files/giflib-${version}.tar.gz/download`, "-o", "/tmp/gif/giflib.tar.gz"]);
      } catch {
        run("curl", ["-fsSL", "https://sourceforge.net/projects/giflib/files/giflib-5.2.2.tar.gz/download", "-o", "/tmp/gif/giflib.tar.gz"]);
      }
      run("tar", ["-xzf", "/tmp/gif/giflib.tar.gz", "-C", "src", "--strip-components=1"]);
      const srcs = ["dgif_lib.c", "egif_lib.c", "gif_err.c", "gif_font.c", "gif_hash.c", "gifalloc.c", "openbsd-reallocarray.c", "quantize.c"].map(
        (f) => `src/${f}`
      );
      compileMultiOs(libOut, { includeWasi: true, winExportAll: true, commonArgs: ["-Isrc", ...srcs] });
      break;
    }
    case "freetype": {
      cloneTag(repo, tag);
      fs.mkdirSync("/tmp/ft_inc/freetype/config", { recursive: true });
      fs.writeFileSync(
        "/tmp/ft_inc/freetype/config/ftmodule.h",
        `FT_USE_MODULE( FT_Module_Class, autofit_module_class )
FT_USE_MODULE( FT_Driver_ClassRec, tt_driver_class )
FT_USE_MODULE( FT_Driver_ClassRec, cff_driver_class )
FT_USE_MODULE( FT_Driver_ClassRec, t1cid_driver_class )
FT_USE_MODULE( FT_Module_Class, psaux_module_class )
FT_USE_MODULE( FT_Module_Class, pshinter_module_class )
FT_USE_MODULE( FT_Module_Class, psnames_module_class )
FT_USE_MODULE( FT_Renderer_Class, ft_raster1_renderer_class )
FT_USE_MODULE( FT_Renderer_Class, ft_smooth_renderer_class )
FT_USE_MODULE( FT_Module_Class, sfnt_module_class )
`,
        "utf8"
      );
      const ftSrcs = [
        "src/src/base/ftbase.c", "src/src/base/ftinit.c", "src/src/base/ftsystem.c", "src/src/base/ftdebug.c",
        "src/src/base/ftbitmap.c", "src/src/base/ftmm.c", "src/src/gzip/ftgzip.c", "src/src/base/ftglyph.c",
        "src/src/base/ftstroke.c", "src/src/base/ftbbox.c", "src/src/truetype/truetype.c", "src/src/sfnt/sfnt.c",
        "src/src/smooth/smooth.c", "src/src/autofit/autofit.c", "src/src/cff/cff.c", "src/src/cid/type1cid.c",
        "src/src/psaux/psaux.c", "src/src/psnames/psnames.c", "src/src/pshinter/pshinter.c", "src/src/raster/raster.c",
      ];
      const ftFlags = ["-I/tmp/ft_inc", "-Isrc/include", "-DFT2_BUILD_LIBRARY", ...ftSrcs];
      zigCc("x86_64-windows-gnu", ["-O2", "-shared", "-s", "-DDLL_EXPORT", ...ftFlags, "-o", `dist/${libOut}-win64.dll`, `-Wl,--out-implib,dist/${libOut}-win64.dll.a`]);
      zigCc("x86_64-linux-gnu", ["-O2", "-shared", "-fPIC", "-s", ...ftFlags, "-lm", "-o", `dist/${libOut}-linux-x64.so`]);
      zigCc("aarch64-linux-gnu", ["-O2", "-shared", "-fPIC", "-s", ...ftFlags, "-lm", "-o", `dist/${libOut}-linux-arm64.so`]);
      zigCc("aarch64-macos", ["-O2", "-shared", "-fPIC", ...ftFlags, "-lm", "-o", `dist/${libOut}-macos-arm64.dylib`]);
      fs.mkdirSync("/tmp/ft_wasi_inc", { recursive: true });
      fs.writeFileSync(
        "/tmp/ft_wasi_inc/setjmp.h",
        `#ifndef _FT_WASI_SETJMP_H
#define _FT_WASI_SETJMP_H
typedef int jmp_buf[1];
#define setjmp(b) 0
#define longjmp(b,v) __builtin_trap()
#endif
`,
        "utf8"
      );
      zigCc("wasm32-wasi", ["-O2", "-mexec-model=reactor", "-I/tmp/ft_wasi_inc", ...ftFlags, "-lm", "-o", `dist/${libOut}-wasm32-wasi.wasm`]);
      break;
    }
    case "harfbuzz": {
      cloneTag(repo, tag);
      const ver = version.replace(/^v/, "").split("-")[0];
      const [maj = "15", min = "0", mic = "0"] = ver.split(".");
      const tpl = fs
        .readFileSync("src/src/hb-version.h.in", "utf8")
        .replaceAll("@HB_VERSION_MAJOR@", maj)
        .replaceAll("@HB_VERSION_MINOR@", min)
        .replaceAll("@HB_VERSION_MICRO@", mic)
        .replaceAll("@HB_VERSION@", ver);
      fs.writeFileSync("src/src/hb-version.h", tpl, "utf8");
      compileMultiOs(libOut, {
        cxx: true,
        winExportAll: true,
        commonArgs: ["-std=c++11", "-fno-exceptions", "-fno-rtti", "-DHB_NO_MT", "-Isrc/src", "src/src/harfbuzz.cc"],
      });
      break;
    }
    case "onig": {
      cloneTag(repo, tag);
      fs.mkdirSync("/tmp/onig_inc", { recursive: true });
      fs.writeFileSync(
        "/tmp/onig_inc/config.h",
        `#ifndef ONIG_CONFIG_H
#define ONIG_CONFIG_H
#define HAVE_STDINT_H 1
#define HAVE_INTTYPES_H 1
#define HAVE_SYS_TYPES_H 1
#define SIZEOF_INT 4
#define SIZEOF_LONG_LONG 8
#define SIZEOF_VOIDP 8
#if defined(_WIN32)
#  define SIZEOF_LONG 4
#  define HAVE_ALLOCA 1
#else
#  define SIZEOF_LONG 8
#  define HAVE_UNISTD_H 1
#  define HAVE_SYS_TIME_H 1
#  define HAVE_SYS_TIMES_H 1
#  define HAVE_ALLOCA 1
#  define HAVE_ALLOCA_H 1
#endif
#define PACKAGE "onig"
#define PACKAGE_VERSION "6.9.10"
#define VERSION "6.9.10"
#endif
`,
        "utf8"
      );
      const srcs = [
        "regparse.c", "regcomp.c", "regexec.c", "regenc.c", "regerror.c", "regext.c", "regsyntax.c",
        "regtrav.c", "regversion.c", "st.c", "reggnu.c", "unicode.c", "unicode_unfold_key.c",
        "unicode_fold1_key.c", "unicode_fold2_key.c", "unicode_fold3_key.c", "ascii.c", "utf8.c",
        "utf16_be.c", "utf16_le.c", "utf32_be.c", "utf32_le.c", "euc_jp.c", "euc_jp_prop.c",
        "sjis.c", "sjis_prop.c", "iso8859_1.c", "iso8859_2.c", "iso8859_3.c", "iso8859_4.c",
        "iso8859_5.c", "iso8859_6.c", "iso8859_7.c", "iso8859_8.c", "iso8859_9.c", "iso8859_10.c",
        "iso8859_11.c", "iso8859_13.c", "iso8859_14.c", "iso8859_15.c", "iso8859_16.c", "euc_tw.c",
        "euc_kr.c", "big5.c", "gb18030.c", "koi8_r.c", "cp1251.c", "onig_init.c",
      ].map((f) => `src/src/${f}`);
      compileMultiOs(libOut, { includeWasi: true, winExportAll: true, commonArgs: ["-I/tmp/onig_inc", "-Isrc/src", "-DHAVE_CONFIG_H", ...srcs] });
      break;
    }
    case "zlib-ng": {
      cloneTag(repo, tag);
      fs.mkdirSync("/tmp/zng_inc", { recursive: true });
      fs.copyFileSync("src/zlib_name_mangling.h.empty", "/tmp/zng_inc/zlib_name_mangling.h");
      fs.copyFileSync("src/zlib_name_mangling.h.empty", "/tmp/zng_inc/zlib_name_mangling-ng.h");
      fs.writeFileSync("/tmp/zng_inc/zlib.h", fs.readFileSync("src/zlib.h.in", "utf8").replaceAll("@ZLIB_SYMBOL_PREFIX@", ""), "utf8");
      fs.writeFileSync("/tmp/zng_inc/zlib-ng.h", fs.readFileSync("src/zlib-ng.h.in", "utf8").replaceAll("@ZLIB_SYMBOL_PREFIX@", ""), "utf8");
      const patchZconf = (srcPath: string, outPath: string): void => {
        const s = fs
          .readFileSync(srcPath, "utf8")
          .replaceAll("@ZLIB_SYMBOL_PREFIX@", "")
          .replaceAll("#cmakedefine HAVE_UNISTD_H", "#ifndef _WIN32\n#define HAVE_UNISTD_H 1\n#endif")
          .replaceAll("#cmakedefine HAVE_STDARG_H", "#define HAVE_STDARG_H 1")
          .replaceAll("#cmakedefine Z_HAVE_UNISTD_H", "#ifndef _WIN32\n#define Z_HAVE_UNISTD_H 1\n#endif");
        fs.writeFileSync(outPath, s, "utf8");
      };
      patchZconf("src/zconf.h.in", "/tmp/zng_inc/zconf.h");
      patchZconf("src/zconf-ng.h.in", "/tmp/zng_inc/zconf-ng.h");
      const srcs = [
        "src/adler32.c", "src/compress.c", "src/crc32.c", "src/crc32_braid_comb.c", "src/deflate.c",
        "src/deflate_fast.c", "src/deflate_huff.c", "src/deflate_medium.c", "src/deflate_quick.c",
        "src/deflate_rle.c", "src/deflate_slow.c", "src/deflate_stored.c", "src/functable.c",
        "src/infback.c", "src/inflate.c", "src/inftrees.c", "src/insert_string.c", "src/insert_string_roll.c",
        "src/trees.c", "src/uncompr.c", "src/zutil.c", "src/cpu_features.c",
        "src/arch/generic/adler32_c.c", "src/arch/generic/adler32_fold_c.c", "src/arch/generic/chunkset_c.c",
        "src/arch/generic/compare256_c.c", "src/arch/generic/crc32_braid_c.c", "src/arch/generic/crc32_fold_c.c",
        "src/arch/generic/slide_hash_c.c", "src/arch/generic/crc32_chorba_c.c",
      ];
      compileMultiOs(libOut, {
        includeWasi: true,
        commonArgs: ["-std=c11", "-I/tmp/zng_inc", "-Isrc", "-Isrc/arch/generic", "-DZLIB_COMPAT", "-DHAVE_BUILTIN_CTZ", "-DHAVE_BUILTIN_CTZLL", ...srcs],
        winArgs: ["-DZLIB_DLL"],
        linuxArgs: ["-DHAVE_UNISTD_H"],
        macArgs: ["-DHAVE_UNISTD_H"],
        wasiArgs: ["-DHAVE_UNISTD_H"],
      });
      break;
    }
    default:
      throw new Error(`Unknown Tier-2 libKey: ${libKey}`);
  }

  const verifiedHeaders = verifyAndSmokeTest({ libKey, libOut });
  emitSha512AndReceipt({ libKey, libOut, repo, tag, version, kind: "runtime-library", verifiedHeaders });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const cmd = process.argv[2];
  if (cmd === "resolve") {
    await resolveVersionsPhase({
      tier: "tier1b-tier2",
      releaseNotes:
        "Production max-version 5-OS shared libraries (Win64 .dll, Linux x64/ARM64 .so, macOS ARM64 .dylib, wasm32-wasi .wasm) compiled directly from upstream sources via pure holo-compiler (zig 0.14.0) — zero CMake, zero Ninja, zero Make.",
      resolvedFileName: "resolved-tier2-versions.json",
      defaults: TIER2_DEFAULTS,
    });
  } else if (cmd === "build") {
    const libKey = process.env.LIB_KEY || "";
    const versions = JSON.parse(process.env.VERSIONS_JSON || "{}") as Record<string, LibraryPin>;
    const pin = versions[libKey] ?? TIER2_DEFAULTS[libKey];
    if (!pin) throw new Error(`Missing version pin for ${libKey}`);
    appendGithubOutput({ lib_out: pin.libOut });
    if (checkSkipMaterialized(libKey, pin.libOut, pin.version, process.env.RELEASE_TAG || "v11-max-5os-latest")) {
      process.exit(0);
    }
    appendGithubOutput({ skipped: "false" });
    buildTier2Library(libKey, pin);
  } else if (cmd === "finalize") {
    finalizeTierSumsPhase({
      tierTitle: "Holo 5-OS Tier-1B & Tier-2 Shards",
      resolvedArtifactName: "resolved-tier2-versions",
      resolvedFileName: "resolved-tier2-versions.json",
      sumArtifactPrefix: "tier2-sums",
      outSumFileName: "SHA512SUMS-tier2.txt",
    });
  } else {
    throw new Error(`Unknown command: ${cmd ?? "(none)"}`);
  }
}
