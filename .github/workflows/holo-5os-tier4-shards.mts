import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  appendGithubOutput,
  checkSkipMaterialized,
  cloneTag,
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

export const TIER4_DEFAULTS: Record<string, LibraryPin> = {
  liburing: { pkg: "liburing", libOut: "liburing", repo: "axboe/liburing", tag: "liburing-2.15", version: "2.15" },
  ninja: { pkg: "ninja", libOut: "ninja", repo: "ninja-build/ninja", tag: "v1.13.2", version: "1.13.2" },
  libavif: { pkg: "libavif", libOut: "libavif", repo: "AOMediaCodec/libavif", tag: "v1.4.2", version: "1.4.2" },
  cairo: { pkg: "cairo", libOut: "libcairo", repo: "gitlab.freedesktop.org/cairo/cairo", tag: "1.18.4", version: "1.18.4" },
  "mariadb-connector-c": { pkg: "mariadb-connector-c", libOut: "libmariadb", repo: "mariadb-corporation/mariadb-connector-c", tag: "v3.4.11", version: "3.4.11" },
  libgit2: { pkg: "libgit2", libOut: "libgit2", repo: "libgit2/libgit2", tag: "v1.9.7", version: "1.9.7" },
  curl: { pkg: "curl", libOut: "libcurl", repo: "curl/curl", tag: "curl-8_23_0", version: "8.23.0" },
  openssl: { pkg: "openssl", libOut: "libssl", repo: "openssl/openssl", tag: "openssl-4.1.0", version: "4.1.0" },
  limine: { pkg: "limine", libOut: "limine", repo: "limine-bootloader/limine", tag: "v12.11.1", version: "12.11.1" },
  "vulkan-loader": { pkg: "vulkan-loader", libOut: "libvulkan", repo: "KhronosGroup/Vulkan-Loader", tag: "v1.4.369", version: "1.4.369" },
};

export const TIER4_LIBS = Object.keys(TIER4_DEFAULTS);

export function buildTier4Library(libKey: string, pin: LibraryPin): void {
  const { libOut, repo, tag, version } = pin;
  console.log(`=== Building ${libKey} (${libOut}) @ ${repo} ${tag} (${version}) ===`);
  fs.mkdirSync("src", { recursive: true });
  fs.mkdirSync("dist", { recursive: true });
  let dlLdLibraryPath = "";

  switch (libKey) {
    case "liburing": {
      cloneTag(repo, tag);
      fs.mkdirSync("src/src/include/liburing", { recursive: true });
      fs.mkdirSync("/tmp/uring_inc", { recursive: true });
      const ver = version.replace(/^liburing-/, "").split("-")[0];
      const [maj = "2", min = "15"] = ver.split(".");
      fs.writeFileSync(
        "src/src/include/liburing/io_uring_version.h",
        `#ifndef LIBURING_VERSION_H\n#define LIBURING_VERSION_H\n#define IO_URING_VERSION_MAJOR ${maj}\n#define IO_URING_VERSION_MINOR ${min}\n#endif\n`,
        "utf8"
      );
      fs.writeFileSync(
        "src/src/include/liburing/compat.h",
        `#ifndef LIBURING_COMPAT_H
#define LIBURING_COMPAT_H
#include <stdint.h>
#include <linux/time_types.h>
#include <linux/openat2.h>
#include <sys/stat.h>
#ifndef BLOCK_URING_CMD_DISCARD
#include <linux/ioctl.h>
#define BLOCK_URING_CMD_DISCARD _IO(0x12, 0)
#endif
#endif
`,
        "utf8"
      );
      fs.writeFileSync("/tmp/uring_inc/config-host.h", "", "utf8");
      const srcs = ["src/src/setup.c", "src/src/queue.c", "src/src/register.c", "src/src/syscall.c", "src/src/version.c"];
      const flags = ["-D_GNU_SOURCE", "-DLIBURING_INTERNAL", "-D_LARGEFILE_SOURCE", "-D_FILE_OFFSET_BITS=64", "-Isrc/src/include", "-include", "/tmp/uring_inc/config-host.h", ...srcs];
      zigCc("x86_64-linux-gnu", ["-O2", "-shared", "-fPIC", "-s", ...flags, "-o", `dist/${libOut}-linux-x64.so`]);
      zigCc("aarch64-linux-gnu", ["-O2", "-shared", "-fPIC", "-s", ...flags, "-o", `dist/${libOut}-linux-arm64.so`]);
      break;
    }
    case "ninja": {
      cloneTag(repo, tag);
      const isExcluded = (n: string): boolean =>
        !n.endsWith(".cc") || n.endsWith(".in.cc") || /_(test|perftest|bench)\.cc$/.test(n) || n === "browse.cc" || n === "test.cc";
      const posixSrcs = findFiles("src/src", (_p, n) => !isExcluded(n) && !n.endsWith("-win32.cc"), 1);
      const winSrcs = findFiles("src/src", (_p, n) => !isExcluded(n) && !n.endsWith("-posix.cc"), 1);
      fs.mkdirSync("/tmp/ninja_obj", { recursive: true });
      zigCc("x86_64-windows-gnu", ["-O2", "-c", "-Isrc/src", "src/src/getopt.c", "-o", "/tmp/ninja_obj/getopt.o"]);
      zigCxx("x86_64-windows-gnu", ["-O2", "-s", "-std=c++17", "-DNOMINMAX", "-Isrc/src", ...winSrcs, "/tmp/ninja_obj/getopt.o", "-o", `dist/${libOut}-win64.exe`]);
      zigCxx("x86_64-linux-gnu", ["-O2", "-s", "-std=c++17", "-idirafter", "src/src", ...posixSrcs, "-o", `dist/${libOut}-linux-x64`]);
      zigCxx("aarch64-linux-gnu", ["-O2", "-s", "-std=c++17", "-idirafter", "src/src", ...posixSrcs, "-o", `dist/${libOut}-linux-arm64`]);
      zigCxx("aarch64-macos", ["-O2", "-std=c++17", "-idirafter", "src/src", ...posixSrcs, "-o", `dist/${libOut}-macos-arm64`]);
      break;
    }
    case "libavif": {
      cloneTag(repo, tag);
      const core = findFiles("src/src", (_p, n) => n.endsWith(".c") && !n.startsWith("codec_"), 1);
      const yuv = [
        "src/third_party/libyuv/source/scale.c", "src/third_party/libyuv/source/scale_common.c",
        "src/third_party/libyuv/source/scale_any.c", "src/third_party/libyuv/source/row_common.c",
        "src/third_party/libyuv/source/planar_functions.c",
      ];
      const base = ["-Isrc/include", "-Isrc/third_party/libyuv/include", ...core, ...yuv];
      zigCc("x86_64-windows-gnu", ["-O2", "-shared", "-s", "-DAVIF_DLL", "-DAVIF_BUILDING_SHARED_LIBS", ...base, "-o", `dist/${libOut}-win64.dll`, `-Wl,--out-implib,dist/${libOut}-win64.dll.a`]);
      zigCc("x86_64-linux-gnu", ["-O2", "-shared", "-fPIC", "-s", ...base, "-lm", "-o", `dist/${libOut}-linux-x64.so`]);
      zigCc("aarch64-linux-gnu", ["-O2", "-shared", "-fPIC", "-s", ...base, "-lm", "-o", `dist/${libOut}-linux-arm64.so`]);
      zigCc("aarch64-macos", ["-O2", "-shared", "-fPIC", ...base, "-lm", "-o", `dist/${libOut}-macos-arm64.dylib`]);
      zigCc("wasm32-wasi", ["-O2", "-mexec-model=reactor", ...base, "-lm", "-o", `dist/${libOut}-wasm32-wasi.wasm`]);
      break;
    }
    case "cairo": {
      try {
        cloneTag(repo, tag);
      } catch {
        fs.rmSync("src", { recursive: true, force: true });
        cloneTag("gitlab.freedesktop.org/cairo/cairo", "1.18.4");
      }
      cloneTag("gitlab.freedesktop.org/pixman/pixman", "pixman-0.46.4", "/tmp/pixman_src");
      fs.mkdirSync("/tmp/cairo_inc", { recursive: true });
      const pixTpl = fs
        .readFileSync("/tmp/pixman_src/pixman/pixman-version.h.in", "utf8")
        .replaceAll("@PIXMAN_VERSION_MAJOR@", "0")
        .replaceAll("@PIXMAN_VERSION_MINOR@", "46")
        .replaceAll("@PIXMAN_VERSION_MICRO@", "4");
      fs.writeFileSync("/tmp/cairo_inc/pixman-version.h", pixTpl, "utf8");
      fs.writeFileSync("/tmp/cairo_inc/pixman-config.h", '#define PACKAGE "pixman"\n#define HAVE_PTHREADS 0\n', "utf8");
      fs.writeFileSync(
        "/tmp/cairo_inc/cairo-features.h",
        `#ifndef CAIRO_FEATURES_H
#define CAIRO_FEATURES_H
#define CAIRO_HAS_IMAGE_SURFACE 1
#define CAIRO_HAS_RECORDING_SURFACE 1
#define CAIRO_HAS_USER_FONT 1
#define CAIRO_HAS_OBSERVER_SURFACE 1
#endif
`,
        "utf8"
      );
      fs.writeFileSync(
        "/tmp/cairo_inc/config.h",
        `#define PACKAGE "cairo"
#define CAIRO_NO_MUTEX 1
#define HAVE_STDINT_H 1
#define HAVE_INTTYPES_H 1
#define HAVE_UINT64_T 1
#ifndef _WIN32
#define HAVE_UNISTD_H 1
#endif
`,
        "utf8"
      );
      const cairoRel = [
        "cairo-analysis-surface.c", "cairo-arc.c", "cairo-array.c", "cairo-atomic.c", "cairo-base64-stream.c",
        "cairo-base85-stream.c", "cairo-bentley-ottmann-rectangular.c", "cairo-bentley-ottmann-rectilinear.c",
        "cairo-bentley-ottmann.c", "cairo-botor-scan-converter.c", "cairo-boxes-intersect.c", "cairo-boxes.c",
        "cairo-cache.c", "cairo-clip-boxes.c", "cairo-clip-polygon.c", "cairo-clip-region.c", "cairo-clip-surface.c",
        "cairo-clip-tor-scan-converter.c", "cairo-clip.c", "cairo-color.c", "cairo-composite-rectangles.c",
        "cairo-compositor.c", "cairo-contour.c", "cairo-damage.c", "cairo-debug.c", "cairo-default-context.c",
        "cairo-device.c", "cairo-error.c", "cairo-fallback-compositor.c", "cairo-fixed.c", "cairo-font-face-twin-data.c",
        "cairo-font-face-twin.c", "cairo-font-face.c", "cairo-font-options.c", "cairo-freed-pool.c", "cairo-freelist.c",
        "cairo-gstate.c", "cairo-hash.c", "cairo-hull.c", "cairo-image-compositor.c", "cairo-image-info.c",
        "cairo-image-source.c", "cairo-image-surface.c", "cairo-line.c", "cairo-lzw.c", "cairo-mask-compositor.c",
        "cairo-matrix.c", "cairo-mempool.c", "cairo-mesh-pattern-rasterizer.c", "cairo-misc.c",
        "cairo-mono-scan-converter.c", "cairo-mutex.c", "cairo-no-compositor.c", "cairo-observer.c",
        "cairo-output-stream.c", "cairo-paginated-surface.c", "cairo-path-bounds.c", "cairo-path-fill.c",
        "cairo-path-fixed.c", "cairo-path-in-fill.c", "cairo-path-stroke-boxes.c", "cairo-path-stroke-polygon.c",
        "cairo-path-stroke-traps.c", "cairo-path-stroke-tristrip.c", "cairo-path-stroke.c", "cairo-path.c",
        "cairo-pattern.c", "cairo-pen.c", "cairo-polygon-intersect.c", "cairo-polygon-reduce.c", "cairo-polygon.c",
        "cairo-raster-source-pattern.c", "cairo-recording-surface.c", "cairo-rectangle.c",
        "cairo-rectangular-scan-converter.c", "cairo-region.c", "cairo-rtree.c", "cairo-scaled-font.c",
        "cairo-shape-mask-compositor.c", "cairo-slope.c", "cairo-spans-compositor.c", "cairo-spans.c",
        "cairo-spline.c", "cairo-stroke-dash.c", "cairo-stroke-style.c", "cairo-surface-clipper.c",
        "cairo-surface-fallback.c", "cairo-surface-observer.c", "cairo-surface-offset.c", "cairo-surface-snapshot.c",
        "cairo-surface-subsurface.c", "cairo-surface-wrapper.c", "cairo-surface.c", "cairo-time.c",
        "cairo-tor-scan-converter.c", "cairo-tor22-scan-converter.c", "cairo-toy-font-face.c",
        "cairo-traps-compositor.c", "cairo-traps.c", "cairo-tristrip.c", "cairo-unicode.c", "cairo-user-font.c",
        "cairo-version.c", "cairo-wideint.c", "cairo.c",
      ].map((f) => `src/src/${f}`);
      const pixRel = [
        "pixman.c", "pixman-access.c", "pixman-access-accessors.c", "pixman-arm.c", "pixman-bits-image.c",
        "pixman-combine32.c", "pixman-combine-float.c", "pixman-conical-gradient.c", "pixman-edge.c",
        "pixman-edge-accessors.c", "pixman-fast-path.c", "pixman-filter.c", "pixman-glyph.c",
        "pixman-general.c", "pixman-gradient-walker.c", "pixman-image.c", "pixman-implementation.c",
        "pixman-linear-gradient.c", "pixman-matrix.c", "pixman-mips.c", "pixman-noop.c", "pixman-ppc.c",
        "pixman-radial-gradient.c", "pixman-region16.c", "pixman-region32.c", "pixman-region64f.c",
        "pixman-riscv.c", "pixman-solid-fill.c", "pixman-timer.c", "pixman-trap.c", "pixman-utils.c", "pixman-x86.c",
      ].map((f) => `/tmp/pixman_src/pixman/${f}`);
      const flags = ["-DHAVE_CONFIG_H", "-DPIXMAN_NO_TLS", "-Wno-int-conversion", "-I/tmp/cairo_inc", "-Isrc/src", "-I/tmp/pixman_src/pixman", ...cairoRel, ...pixRel];
      zigCc("x86_64-windows-gnu", ["-O2", "-shared", "-s", "-DCAIRO_WIN32_STATIC_BUILD", "-Wl,--export-all-symbols", ...flags, "-lm", "-o", `dist/${libOut}-win64.dll`, `-Wl,--out-implib,dist/${libOut}-win64.dll.a`]);
      zigCc("x86_64-linux-gnu", ["-O2", "-shared", "-fPIC", "-s", ...flags, "-lm", "-o", `dist/${libOut}-linux-x64.so`]);
      zigCc("aarch64-linux-gnu", ["-O2", "-shared", "-fPIC", "-s", ...flags, "-lm", "-o", `dist/${libOut}-linux-arm64.so`]);
      zigCc("aarch64-macos", ["-O2", "-shared", "-fPIC", ...flags, "-lm", "-o", `dist/${libOut}-macos-arm64.dylib`]);
      break;
    }
    case "mariadb-connector-c": {
      cloneTag(repo, tag);
      cloneTag("madler/zlib", "", "/tmp/zlib_src");
      fs.mkdirSync("/tmp/mdb_posix", { recursive: true });
      fs.mkdirSync("/tmp/mdb_win", { recursive: true });
      fs.mkdirSync("/tmp/mdb_gen", { recursive: true });
      const ver = version.replace(/^v/, "").split("-")[0];
      const [maj = "3", min = "4", pat = "11"] = ver.split(".");
      const pkgId = String(Number(maj) * 10000 + Number(min) * 100 + Number(pat));
      let mdbVer = fs.readFileSync("src/include/mariadb_version.h.in", "utf8");
      const reps: Record<string, string> = {
        "@PROTOCOL_VERSION@": "10",
        "@MARIADB_CLIENT_VERSION@": ver,
        "@MARIADB_BASE_VERSION@": "mariadb-11.4",
        "@MARIADB_VERSION_ID@": "110400",
        "@MARIADB_PORT@": "3306",
        "@MARIADB_UNIX_ADDR@": "/tmp/mysql.sock",
        "@CPACK_PACKAGE_VERSION@": ver,
        "@MARIADB_PACKAGE_VERSION_ID@": pkgId,
        "@CMAKE_SYSTEM_NAME@": "Portable",
        "@CMAKE_SYSTEM_PROCESSOR@": "generic",
        "@CMAKE_INSTALL_PREFIX@/@INSTALL_PLUGINDIR@": "/usr/lib/mariadb/plugin",
        "@default_charset@": "utf8mb4",
        "@CC_SOURCE_REVISION@": tag,
      };
      for (const [k, v] of Object.entries(reps)) mdbVer = mdbVer.replaceAll(k, v);
      fs.writeFileSync("/tmp/mdb_posix/mariadb_version.h", mdbVer, "utf8");
      fs.writeFileSync("/tmp/mdb_win/mariadb_version.h", mdbVer, "utf8");

      const plug = fs
        .readFileSync("src/libmariadb/ma_client_plugin.c.in", "utf8")
        .replaceAll("@PLUGINS_DISABLED@", "")
        .replaceAll(
          "@EXTERNAL_PLUGINS@",
          "extern struct st_mysql_client_plugin_pvio pvio_socket_client_plugin;\nextern struct st_mysql_client_plugin_authentication mysql_native_password_client_plugin;"
        )
        .replaceAll(
          "@BUILTIN_PLUGINS@",
          "(struct st_mysql_client_plugin *)&pvio_socket_client_plugin,\n(struct st_mysql_client_plugin *)&mysql_native_password_client_plugin,"
        );
      fs.writeFileSync("/tmp/mdb_gen/ma_client_plugin.c", plug, "utf8");
      fs.writeFileSync(
        "/tmp/mdb_posix/ma_config.h",
        `#ifndef _ma_config_h_
#define _ma_config_h_
#define HAVE_ALLOCA_H 1
#define HAVE_DLFCN_H 1
#define HAVE_FCNTL_H 1
#define HAVE_FLOAT_H 1
#define HAVE_LIMITS_H 1
#define HAVE_PWD_H 1
#define HAVE_STDDEF_H 1
#define HAVE_STDINT_H 1
#define HAVE_STDLIB_H 1
#define HAVE_STRING_H 1
#define HAVE_SYS_IOCTL_H 1
#define HAVE_SYS_SELECT_H 1
#define HAVE_SYS_SOCKET_H 1
#define HAVE_SYS_STAT_H 1
#define HAVE_SYS_TYPES_H 1
#define HAVE_SYS_UN_H 1
#define HAVE_UNISTD_H 1
#define HAVE_DLERROR 1
#define HAVE_DLOPEN 1
#define HAVE_GETPWUID 1
#define HAVE_MEMCPY 1
#define HAVE_POLL 1
#define HAVE_STRTOK_R 1
#define HAVE_STRTOL 1
#define HAVE_STRTOLL 1
#define HAVE_STRTOUL 1
#define HAVE_STRTOULL 1
#define HAVE_VSNPRINTF 1
#define SIZEOF_CHARP 8
#define HAVE_CHARP 1
#define SIZEOF_INT 4
#define HAVE_INT 1
#define SIZEOF_LONG 8
#define HAVE_LONG 1
#define SIZEOF_LONG_LONG 8
#define HAVE_LONG_LONG 1
#define SIZEOF_SIZE_T 8
#define HAVE_SIZE_T 1
#define SIZEOF_UINT 4
#define HAVE_UINT 1
#define SIZEOF_USHORT 2
#define HAVE_USHORT 1
#define SIZEOF_ULONG 8
#define SIZEOF_SOCKLEN_T 4
#define HAVE_SOCKLEN_T 1
#define SOCKET_SIZE_TYPE socklen_t
#define LOCAL_INFILE_MODE_OFF 0
#define LOCAL_INFILE_MODE_ON 1
#define LOCAL_INFILE_MODE_AUTO 2
#define ENABLED_LOCAL_INFILE LOCAL_INFILE_MODE_AUTO
#define MARIADB_DEFAULT_CHARSET "utf8mb4"
#endif
`,
        "utf8"
      );
      fs.writeFileSync(
        "/tmp/mdb_win/ma_config.h",
        `#ifndef _ma_config_h_
#define _ma_config_h_
#define HAVE_FCNTL_H 1
#define HAVE_FLOAT_H 1
#define HAVE_LIMITS_H 1
#define HAVE_STDDEF_H 1
#define HAVE_STDINT_H 1
#define HAVE_STDLIB_H 1
#define HAVE_STRING_H 1
#define HAVE_SYS_STAT_H 1
#define HAVE_SYS_TYPES_H 1
#define HAVE_MEMCPY 1
#define HAVE_STRTOL 1
#define HAVE_STRTOLL 1
#define HAVE_STRTOUL 1
#define HAVE_STRTOULL 1
#define HAVE_VSNPRINTF 1
#define SIZEOF_CHARP 8
#define HAVE_CHARP 1
#define SIZEOF_INT 4
#define HAVE_INT 1
#define SIZEOF_LONG 4
#define HAVE_LONG 1
#define SIZEOF_LONG_LONG 8
#define HAVE_LONG_LONG 1
#define SIZEOF_SIZE_T 8
#define HAVE_SIZE_T 1
#define SIZEOF_UINT 4
#define HAVE_UINT 1
#define SIZEOF_USHORT 2
#define HAVE_USHORT 1
#define SIZEOF_ULONG 4
#define SOCKET_SIZE_TYPE int
#define LOCAL_INFILE_MODE_OFF 0
#define LOCAL_INFILE_MODE_ON 1
#define LOCAL_INFILE_MODE_AUTO 2
#define ENABLED_LOCAL_INFILE LOCAL_INFILE_MODE_AUTO
#define MARIADB_DEFAULT_CHARSET "utf8mb4"
#endif
`,
        "utf8"
      );
      fs.writeFileSync(
        "/tmp/mdb_posix/ma_crypt_pre.h",
        `#ifndef _MA_CRYPT_STUB_PRE
#define _MA_CRYPT_STUB_PRE
#include <stddef.h>
typedef struct st_ma_hash_ctx_stub { unsigned int alg; } MA_HASH_CTX;
struct st_ma_pvio_tls;
unsigned int ma_tls_get_finger_print(struct st_ma_pvio_tls *ctls, unsigned int hash_type, char *fp, unsigned int fp_len);
int ma_pvio_tls_verify_server_cert(void *ctls, unsigned int flags);
#endif
`,
        "utf8"
      );
      fs.writeFileSync(
        "/tmp/mdb_gen/ma_crypt_stub.c",
        `#include <stdlib.h>
MA_HASH_CTX *ma_hash_new(unsigned int algorithm) {
  MA_HASH_CTX *c = (MA_HASH_CTX *)calloc(1, sizeof(MA_HASH_CTX));
  if (c) c->alg = algorithm;
  return c;
}
void ma_hash_free(MA_HASH_CTX *ctx) { free(ctx); }
void ma_hash_input(MA_HASH_CTX *ctx, const unsigned char *buffer, size_t len) { (void)ctx; (void)buffer; (void)len; }
void ma_hash_result(MA_HASH_CTX *ctx, unsigned char *digest) { (void)ctx; if (digest) digest[0] = 0; }
unsigned int ma_tls_get_finger_print(struct st_ma_pvio_tls *ctls, unsigned int hash_type, char *fp, unsigned int fp_len) {
  (void)ctls; (void)hash_type; (void)fp; (void)fp_len; return 0;
}
int ma_pvio_tls_verify_server_cert(void *ctls, unsigned int flags) {
  (void)ctls; (void)flags; return 1;
}
`,
        "utf8"
      );
      fs.writeFileSync(
        "/tmp/mdb_win/ma_tls_win_pre.h",
        `#ifndef _MA_WIN_PRE
#define _MA_WIN_PRE
#include <winsock2.h>
#include <windows.h>
#define RTLD_NOW 0
static inline void *dlopen(const char *p, int m) { (void)m; return (void *)LoadLibraryA(p); }
static inline void *dlsym(void *h, const char *s) { return (void *)GetProcAddress((HMODULE)h, s); }
static inline int dlclose(void *h) { return FreeLibrary((HMODULE)h) ? 0 : -1; }
struct st_ma_pvio_tls;
unsigned int ma_tls_get_finger_print(struct st_ma_pvio_tls *ctls, unsigned int hash_type, char *fp, unsigned int fp_len);
int ma_pvio_tls_verify_server_cert(void *ctls, unsigned int flags);
#endif
`,
        "utf8"
      );
      fs.writeFileSync(
        "/tmp/mdb_gen/ma_tls_win_stub.c",
        `unsigned int ma_tls_get_finger_print(struct st_ma_pvio_tls *ctls, unsigned int hash_type, char *fp, unsigned int fp_len) {
  (void)ctls; (void)hash_type; (void)fp; (void)fp_len; return 0;
}
int ma_pvio_tls_verify_server_cert(void *ctls, unsigned int flags) {
  (void)ctls; (void)flags; return 1;
}
`,
        "utf8"
      );
      const mdbCore = [
        "src/plugins/auth/my_auth.c", "src/plugins/auth/old_password.c", "src/plugins/pvio/pvio_socket.c",
        "src/libmariadb/ma_array.c", "src/libmariadb/ma_charset.c", "src/libmariadb/ma_decimal.c",
        "src/libmariadb/ma_hashtbl.c", "src/libmariadb/ma_net.c", "src/libmariadb/mariadb_charset.c",
        "src/libmariadb/ma_time.c", "src/libmariadb/ma_default.c", "src/libmariadb/ma_errmsg.c",
        "src/libmariadb/mariadb_lib.c", "src/libmariadb/ma_list.c", "src/libmariadb/ma_pvio.c",
        "src/libmariadb/ma_tls.c", "src/libmariadb/ma_alloc.c", "src/libmariadb/ma_compress.c",
        "src/libmariadb/ma_init.c", "src/libmariadb/ma_password.c", "src/libmariadb/ma_ll2str.c",
        "src/libmariadb/mariadb_stmt.c", "src/libmariadb/ma_loaddata.c", "src/libmariadb/ma_stmt_codec.c",
        "src/libmariadb/ma_string.c", "src/libmariadb/ma_dtoa.c", "src/libmariadb/mariadb_rpl.c",
        "/tmp/mdb_gen/ma_client_plugin.c", "src/libmariadb/ma_io.c", "src/libmariadb/get_password.c",
        "src/libmariadb/mariadb_dyncol.c", "src/libmariadb/mariadb_async.c", "src/libmariadb/ma_context.c",
      ];
      const zlibSrcs = findFiles("/tmp/zlib_src", (_p, n) => n.endsWith(".c") && !n.startsWith("gz") && n !== "example.c" && n !== "minigzip.c", 1);
      const flags = ["-Wno-incompatible-function-pointer-types", "-DLIBMARIADB", "-DTHREAD", "-DHAVE_CONFIG_H", "-DHAVE_COMPRESS", "-Isrc/include", "-Isrc/libmariadb", "-I/tmp/zlib_src", "-Dreset_tls_error(m)=((void)(m))"];
      zigCc("x86_64-windows-gnu", ["-O2", "-shared", "-s", "-Wl,--export-all-symbols", ...flags, "-DWIN32", "-DHAVE_WINCRYPT", "-D_WIN32_WINNT=0x0601", "-include", "/tmp/mdb_win/ma_tls_win_pre.h", "-I/tmp/mdb_win", "-Isrc/win-iconv", ...mdbCore, "src/libmariadb/win32_errmsg.c", "src/win-iconv/win_iconv.c", "src/libmariadb/secure/win_crypt.c", "/tmp/mdb_gen/ma_tls_win_stub.c", ...zlibSrcs, "-lws2_32", "-ladvapi32", "-lshlwapi", "-lcrypt32", "-lbcrypt", "-o", `dist/${libOut}-win64.dll`, `-Wl,--out-implib,dist/${libOut}-win64.dll.a`]);
      const posixCommon = [...flags, "-include", "/tmp/mdb_posix/ma_crypt_pre.h", "-I/tmp/mdb_posix", ...mdbCore, "/tmp/mdb_gen/ma_crypt_stub.c", ...zlibSrcs, "-lpthread", "-ldl", "-lm"];
      zigCc("x86_64-linux-gnu", ["-O2", "-shared", "-fPIC", "-s", ...posixCommon, "-o", `dist/${libOut}-linux-x64.so`]);
      zigCc("aarch64-linux-gnu", ["-O2", "-shared", "-fPIC", "-s", ...posixCommon, "-o", `dist/${libOut}-linux-arm64.so`]);
      zigCc("aarch64-macos", ["-O2", "-shared", "-fPIC", "-D_XOPEN_SOURCE", ...posixCommon, "-o", `dist/${libOut}-macos-arm64.dylib`]);
      break;
    }
    case "libgit2": {
      cloneTag(repo, tag);
      fs.mkdirSync("/tmp/git2_inc", { recursive: true });
      fs.mkdirSync("/tmp/pcre2_inc", { recursive: true });
      fs.writeFileSync(
        "/tmp/git2_inc/git2_features.h",
        `#ifndef INCLUDE_features_h__
#define INCLUDE_features_h__
#define GIT_THREADS 1
#define GIT_ARCH_64 1
#define GIT_REGEX_BUILTIN 1
#define GIT_HTTPPARSER_LLHTTP 1
#define GIT_COMPRESSION_ZLIB 1
#ifdef _WIN32
#define GIT_WINHTTP 1
#define GIT_SHA1_WIN32 1
#define GIT_SHA256_WIN32 1
#define GIT_IO_WSAPOLL 1
#else
#define GIT_USE_NSEC 1
#ifdef __APPLE__
#define GIT_USE_STAT_MTIMESPEC 1
#define GIT_QSORT_BSD 1
#else
#define GIT_USE_STAT_MTIM 1
#define GIT_QSORT_GNU 1
#endif
#define GIT_USE_STAT_MTIME_NSEC 1
#define GIT_USE_FUTIMENS 1
#define GIT_SHA1_COLLISIONDETECT 1
#define GIT_SHA256_BUILTIN 1
#define GIT_IO_POLL 1
#endif
#endif
`,
        "utf8"
      );
      fs.writeFileSync(
        "/tmp/git2_inc/git2_extra.h",
        `#define GIT_DEFAULT_CERT_LOCATION "/etc/ssl"
#define SHA1DC_NO_STANDARD_INCLUDES 1
#define SHA1DC_CUSTOM_INCLUDE_SHA1_C "git2_util.h"
#define SHA1DC_CUSTOM_INCLUDE_UBC_CHECK_C "git2_util.h"
`,
        "utf8"
      );
      fs.writeFileSync(
        "/tmp/pcre2_inc/config.h",
        `#define SUPPORT_PCRE2_8 1
#define SUPPORT_UNICODE 1
#define PCRE2_CODE_UNIT_WIDTH 8
#define PCRE2_STATIC 1
#define PCRE2_EXPORT
#define NEWLINE_DEFAULT 2
#define LINK_SIZE 2
#define PARENS_NEST_LIMIT 250
#define HEAP_LIMIT 20000000
#define MATCH_LIMIT 10000000
#define MATCH_LIMIT_DEPTH MATCH_LIMIT
#define MAX_VARLOOKBEHIND 255
#define MAX_NAME_SIZE 128
#define MAX_NAME_COUNT 10000
#define HAVE_STDINT_H 1
#define HAVE_INTTYPES_H 1
#define HAVE_MEMMOVE 1
#define HAVE_STRERROR 1
#define HAVE_ASSERT_H 1
#define HAVE_SYS_STAT_H 1
#define HAVE_SYS_TYPES_H 1
#ifndef _WIN32
#define HAVE_UNISTD_H 1
#define HAVE_DIRENT_H 1
#else
#define HAVE_WINDOWS_H 1
#endif
`,
        "utf8"
      );
      const core = [
        ...findFiles("src/src/libgit2", (_p, n) => n.endsWith(".c"), 1),
        ...findFiles("src/src/libgit2/streams", (_p, n) => n.endsWith(".c"), 1),
        ...findFiles("src/src/libgit2/transports", (_p, n) => n.endsWith(".c"), 1),
      ];
      const utilCommon = [
        ...findFiles("src/src/util", (_p, n) => n.endsWith(".c"), 1),
        ...findFiles("src/src/util/allocators", (_p, n) => n.endsWith(".c"), 1),
      ];
      const unixSrcs = [
        ...findFiles("src/src/util/unix", (_p, n) => n.endsWith(".c"), 1),
        ...findFiles("src/src/util/hash/sha1dc", (_p, n) => n.endsWith(".c"), 1),
        ...findFiles("src/src/util/hash/rfc6234", (_p, n) => n.endsWith(".c"), 1),
      ];
      const winSrcs = findFiles("src/src/util/win32", (_p, n) => n.endsWith(".c"), 1);
      const deps = [
        ...findFiles("src/deps/llhttp", (_p, n) => n.endsWith(".c"), 1),
        ...findFiles("src/deps/xdiff", (_p, n) => n.endsWith(".c"), 1),
        ...findFiles("src/deps/zlib", (_p, n) => n.endsWith(".c"), 1),
      ];
      const pcre2 = findFiles("src/deps/pcre2", (_p, n) => n.endsWith(".c") && !/(fuzzsupport|dftables|test)/.test(n), 1);
      const flags = ["-DHAVE_CONFIG_H", "-DPCRE2_STATIC", "-DPCRE2_EXPORT=", "-I/tmp/git2_inc", "-I/tmp/pcre2_inc", "-Isrc/include", "-Isrc/src/libgit2", "-Isrc/src/util", "-Isrc/deps/llhttp", "-Isrc/deps/xdiff", "-Isrc/deps/zlib", "-Isrc/deps/pcre2"];
      zigCc("x86_64-windows-gnu", ["-O2", "-shared", "-s", "-DWIN32", ...flags, ...core, ...utilCommon, ...winSrcs, "src/src/util/hash/win32.c", ...deps, ...pcre2, "-lws2_32", "-lwinhttp", "-lrpcrt4", "-lcrypt32", "-lole32", "-lsecur32", "-o", `dist/${libOut}-win64.dll`, `-Wl,--out-implib,dist/${libOut}-win64.dll.a`]);
      const unixCommon = ["-include", "/tmp/git2_inc/git2_extra.h", ...flags, ...core, ...utilCommon, ...unixSrcs, "src/src/util/hash/collisiondetect.c", "src/src/util/hash/builtin.c", ...deps, ...pcre2, "-lpthread", "-lm"];
      zigCc("x86_64-linux-gnu", ["-O2", "-shared", "-fPIC", "-s", "-D_GNU_SOURCE", ...unixCommon, "-o", `dist/${libOut}-linux-x64.so`]);
      zigCc("aarch64-linux-gnu", ["-O2", "-shared", "-fPIC", "-s", "-D_GNU_SOURCE", ...unixCommon, "-o", `dist/${libOut}-linux-arm64.so`]);
      zigCc("aarch64-macos", ["-O2", "-shared", "-fPIC", ...unixCommon, "-o", `dist/${libOut}-macos-arm64.dylib`]);
      break;
    }
    case "curl": {
      cloneTag(repo, tag);
      fs.mkdirSync("/tmp/curl_win", { recursive: true });
      fs.mkdirSync("/tmp/curl_lin", { recursive: true });
      fs.mkdirSync("/tmp/curl_mac", { recursive: true });
      const linCfg = `#ifndef HEADER_CURL_CONFIG_H
#define HEADER_CURL_CONFIG_H
#define CURL_OS "x86_64-linux-gnu"
#define CURL_DISABLE_LDAP 1
#define CURL_DISABLE_LDAPS 1
#define CURL_DISABLE_NTLM 1
#define CURL_DISABLE_NEGOTIATE_AUTH 1
#define CURL_DISABLE_KERBEROS_AUTH 1
#define CURL_DISABLE_LIBCURL_OPTION 1
#define USE_IPV6 1
#define BUILDING_LIBCURL 1
#define HAVE_ALARM 1
#define HAVE_ARPA_INET_H 1
#define HAVE_ASSERT_H 1
#define HAVE_BASENAME 1
#define HAVE_CLOCK_GETTIME_MONOTONIC 1
#define HAVE_ERRNO_H 1
#define HAVE_FCNTL 1
#define HAVE_FCNTL_H 1
#define HAVE_FCNTL_O_NONBLOCK 1
#define HAVE_FNMATCH 1
#define HAVE_FREEADDRINFO 1
#define HAVE_FTRUNCATE 1
#define HAVE_GETADDRINFO 1
#define HAVE_GETEUID 1
#define HAVE_GETHOSTNAME 1
#define HAVE_GETPEERNAME 1
#define HAVE_GETPPID 1
#define HAVE_GETPWUID 1
#define HAVE_GETPWUID_R 1
#define HAVE_GETRLIMIT 1
#define HAVE_GETSOCKNAME 1
#define HAVE_GETTIMEOFDAY 1
#define HAVE_GMTIME_R 1
#define HAVE_IFADDRS_H 1
#define HAVE_INET_NTOP 1
#define HAVE_INET_PTON 1
#define HAVE_IOCTL 1
#define HAVE_LIBGEN_H 1
#define HAVE_LOCALE_H 1
#define HAVE_LONGLONG 1
#define HAVE_MEMRCHR 1
#define HAVE_NETDB_H 1
#define HAVE_NETINET_IN_H 1
#define HAVE_NETINET_TCP_H 1
#define HAVE_NET_IF_H 1
#define HAVE_PIPE 1
#define HAVE_POLL 1
#define HAVE_POLL_H 1
#define HAVE_POSIX_STRERROR_R 1
#define HAVE_PTHREAD_H 1
#define HAVE_PWD_H 1
#define HAVE_RECV 1
#define HAVE_SELECT 1
#define HAVE_SEND 1
#define HAVE_SENDMSG 1
#define HAVE_SETLOCALE 1
#define HAVE_SIGNAL 1
#define HAVE_SIGSETJMP 1
#define HAVE_SNPRINTF 1
#define HAVE_SOCKET 1
#define HAVE_SOCKETPAIR 1
#define HAVE_STDBOOL_H 1
#define HAVE_STDINT_H 1
#define HAVE_STDIO_H 1
#define HAVE_STDLIB_H 1
#define HAVE_STRCASECMP 1
#define HAVE_STRDUP 1
#define HAVE_STRERROR_R 1
#define HAVE_STRING_H 1
#define HAVE_STRINGS_H 1
#define HAVE_STRTOK_R 1
#define HAVE_STRTOLL 1
#define HAVE_STRUCT_TIMEVAL 1
#define HAVE_SYS_IOCTL_H 1
#define HAVE_SYS_PARAM_H 1
#define HAVE_SYS_POLL_H 1
#define HAVE_SYS_RESOURCE_H 1
#define HAVE_SYS_SELECT_H 1
#define HAVE_SYS_SOCKET_H 1
#define HAVE_SYS_STAT_H 1
#define HAVE_SYS_TIME_H 1
#define HAVE_SYS_TYPES_H 1
#define HAVE_SYS_UIO_H 1
#define HAVE_SYS_UN_H 1
#define HAVE_SYS_WAIT_H 1
#define HAVE_TIME_H 1
#define HAVE_UNISTD_H 1
#define HAVE_UTIME 1
#define HAVE_UTIME_H 1
#define HAVE_UTIMES 1
#define SIZEOF_INT 4
#define SIZEOF_LONG 8
#define SIZEOF_LONG_LONG 8
#define SIZEOF_OFF_T 8
#define SIZEOF_SIZE_T 8
#define SIZEOF_TIME_T 8
#define SIZEOF_CURL_OFF_T 8
#define SIZEOF_CURL_SOCKET_T 4
#define STDC_HEADERS 1
#define TIME_WITH_SYS_TIME 1
#define USE_THREADS_POSIX 1
#define USE_UNIX_SOCKETS 1
#define HAVE_GETADDRINFO_THREADSAFE 1
#define RECV_TYPE_ARG1 int
#define RECV_TYPE_ARG2 void *
#define RECV_TYPE_ARG3 size_t
#define RECV_TYPE_ARG4 int
#define RECV_TYPE_RETV ssize_t
#define SEND_TYPE_ARG1 int
#define SEND_TYPE_ARG2 const void *
#define SEND_TYPE_ARG3 size_t
#define SEND_TYPE_ARG4 int
#define SEND_TYPE_RETV ssize_t
#define SEND_QUAL_ARG2 const
#endif
`;
      fs.writeFileSync("/tmp/curl_lin/curl_config.h", linCfg, "utf8");
      fs.writeFileSync(
        "/tmp/curl_mac/curl_config.h",
        linCfg.replace('#define CURL_OS "x86_64-linux-gnu"', '#define CURL_OS "aarch64-apple-darwin"').replace("#define HAVE_MEMRCHR 1\n", ""),
        "utf8"
      );
      fs.writeFileSync(
        "/tmp/curl_win/curl_config.h",
        `#ifndef HEADER_CURL_CONFIG_H
#define HEADER_CURL_CONFIG_H
#define CURL_OS "x86_64-pc-win32"
#define CURL_DISABLE_LDAP 1
#define CURL_DISABLE_LDAPS 1
#define CURL_DISABLE_NTLM 1
#define CURL_DISABLE_NEGOTIATE_AUTH 1
#define CURL_DISABLE_KERBEROS_AUTH 1
#define CURL_DISABLE_LIBCURL_OPTION 1
#define USE_IPV6 1
#define BUILDING_LIBCURL 1
#define USE_THREADS_WIN32 1
#define USE_WIN32_LARGE_FILES 1
#define HAVE_CLOSESOCKET 1
#define HAVE_ERRNO_H 1
#define HAVE_FCNTL_H 1
#define HAVE_FREEADDRINFO 1
#define HAVE_GETADDRINFO 1
#define HAVE_GETADDRINFO_THREADSAFE 1
#define HAVE_GETHOSTNAME 1
#define HAVE_GETPEERNAME 1
#define HAVE_GETSOCKNAME 1
#define HAVE_IO_H 1
#define HAVE_IOCTLSOCKET 1
#define HAVE_IOCTLSOCKET_FIONBIO 1
#define HAVE_LOCALE_H 1
#define HAVE_LONGLONG 1
#define HAVE_RECV 1
#define HAVE_SELECT 1
#define HAVE_SEND 1
#define HAVE_SETLOCALE 1
#define HAVE_SOCKET 1
#define HAVE_STDBOOL_H 1
#define HAVE_STDINT_H 1
#define HAVE_STDIO_H 1
#define HAVE_STDLIB_H 1
#define HAVE_STRDUP 1
#define HAVE_STRING_H 1
#define HAVE_STRTOLL 1
#define HAVE_STRUCT_TIMEVAL 1
#define HAVE_SYS_STAT_H 1
#define HAVE_SYS_TYPES_H 1
#define HAVE_SYS_UTIME_H 1
#define HAVE_TIME_H 1
#define HAVE_UTIME 1
#define HAVE_WINSOCK2_H 1
#define HAVE_WS2TCPIP_H 1
#define SIZEOF_INT 4
#define SIZEOF_LONG 4
#define SIZEOF_LONG_LONG 8
#define SIZEOF_OFF_T 8
#define SIZEOF_SIZE_T 8
#define SIZEOF_TIME_T 8
#define SIZEOF_CURL_OFF_T 8
#define SIZEOF_CURL_SOCKET_T 8
#define STDC_HEADERS 1
#define RECV_TYPE_ARG1 SOCKET
#define RECV_TYPE_ARG2 char *
#define RECV_TYPE_ARG3 int
#define RECV_TYPE_ARG4 int
#define RECV_TYPE_RETV int
#define SEND_TYPE_ARG1 SOCKET
#define SEND_TYPE_ARG2 const char *
#define SEND_TYPE_ARG3 int
#define SEND_TYPE_ARG4 int
#define SEND_TYPE_RETV int
#define SEND_QUAL_ARG2 const
#endif
`,
        "utf8"
      );
      fs.writeFileSync("/tmp/curl_mac/curl_macos_stub.c", "int Curl_macos_init(void) { return 0; }\n", "utf8");
      const core = findFiles("src/lib", (_p, n) => n.endsWith(".c") && n !== "amigaos.c" && n !== "macos.c", 1);
      const sub = ["curlx", "vauth", "vdns", "vtls", "vquic", "vssh"].flatMap((d) =>
        findFiles(`src/lib/${d}`, (_p, n) => n.endsWith(".c"), 1)
      );
      const flags = ["-DHAVE_CONFIG_H", "-DBUILDING_LIBCURL", "-Isrc/include", "-Isrc/lib", ...core, ...sub];
      zigCc("x86_64-windows-gnu", ["-O2", "-shared", "-s", "-I/tmp/curl_win", "-D_WIN32_WINNT=0x0601", ...flags, "-lws2_32", "-lbcrypt", "-lcrypt32", "-liphlpapi", "-o", `dist/${libOut}-win64.dll`, `-Wl,--out-implib,dist/${libOut}-win64.dll.a`]);
      zigCc("x86_64-linux-gnu", ["-O2", "-shared", "-fPIC", "-s", "-I/tmp/curl_lin", "-D_GNU_SOURCE", ...flags, "-lpthread", "-o", `dist/${libOut}-linux-x64.so`]);
      zigCc("aarch64-linux-gnu", ["-O2", "-shared", "-fPIC", "-s", "-I/tmp/curl_lin", "-D_GNU_SOURCE", ...flags, "-lpthread", "-o", `dist/${libOut}-linux-arm64.so`]);
      zigCc("aarch64-macos", ["-O2", "-shared", "-fPIC", "-I/tmp/curl_mac", ...flags, "/tmp/curl_mac/curl_macos_stub.c", "-lpthread", "-o", `dist/${libOut}-macos-arm64.dylib`]);
      break;
    }
    case "openssl": {
      cloneTag(repo, tag);
      const sslSrc = path.resolve("src");
      const nproc = fs.readFileSync("/proc/cpuinfo", "utf8").match(/^processor\b/gm)?.length || 4;
      const buildSslArch = (cfgTarget: string, zigTarget: string): string => {
        const bdir = `/tmp/ssl_${cfgTarget}`;
        fs.rmSync(bdir, { recursive: true, force: true });
        run("cp", ["-a", sslSrc, bdir]);
        run(
          "./Configure",
          [cfgTarget, "no-asm", "no-tests", "no-apps", "no-docs", "no-shared", "-DOPENSSL_NO_SECURE_MEMORY"],
          {
            cwd: bdir,
            quiet: true,
            env: { ...process.env, AR: "zig ar", RANLIB: "zig ranlib", CC: `zig cc -target ${zigTarget} -fPIC` },
          }
        );
        run("make", [`-j${nproc}`, "build_libs"], { cwd: bdir, quiet: true });
        return bdir;
      };
      const winDir = buildSslArch("mingw64", "x86_64-windows-gnu");
      zigCc("x86_64-windows-gnu", ["-O2", "-shared", "-s", "-Wl,--export-all-symbols", "-Wl,--whole-archive", `${winDir}/libcrypto.a`, "-Wl,--no-whole-archive", "-lws2_32", "-lcrypt32", "-lbcrypt", "-o", "dist/libcrypto-win64.dll", "-Wl,--out-implib,dist/libcrypto-win64.dll.a"]);
      zigCc("x86_64-windows-gnu", ["-O2", "-shared", "-s", "-Wl,--export-all-symbols", "-Wl,--whole-archive", `${winDir}/libssl.a`, "-Wl,--no-whole-archive", "dist/libcrypto-win64.dll.a", "-lws2_32", "-lcrypt32", "-lbcrypt", "-o", `dist/${libOut}-win64.dll`, `-Wl,--out-implib,dist/${libOut}-win64.dll.a`]);

      const x64Dir = buildSslArch("linux-x86_64", "x86_64-linux-gnu");
      zigCc("x86_64-linux-gnu", ["-O2", "-shared", "-fPIC", "-s", "-Wl,-soname,libcrypto-linux-x64.so", "-Wl,--whole-archive", `${x64Dir}/libcrypto.a`, "-Wl,--no-whole-archive", "-ldl", "-lpthread", "-o", "dist/libcrypto-linux-x64.so"]);
      zigCc("x86_64-linux-gnu", ["-O2", "-shared", "-fPIC", "-s", "-Wl,-soname,libssl-linux-x64.so", "-Wl,-rpath,$ORIGIN", "-Wl,--whole-archive", `${x64Dir}/libssl.a`, "-Wl,--no-whole-archive", "dist/libcrypto-linux-x64.so", "-ldl", "-lpthread", "-o", `dist/${libOut}-linux-x64.so`]);

      const armDir = buildSslArch("linux-aarch64", "aarch64-linux-gnu");
      zigCc("aarch64-linux-gnu", ["-O2", "-shared", "-fPIC", "-s", "-Wl,-soname,libcrypto-linux-arm64.so", "-Wl,--whole-archive", `${armDir}/libcrypto.a`, "-Wl,--no-whole-archive", "-ldl", "-lpthread", "-o", "dist/libcrypto-linux-arm64.so"]);
      zigCc("aarch64-linux-gnu", ["-O2", "-shared", "-fPIC", "-s", "-Wl,-soname,libssl-linux-arm64.so", "-Wl,-rpath,$ORIGIN", "-Wl,--whole-archive", `${armDir}/libssl.a`, "-Wl,--no-whole-archive", "dist/libcrypto-linux-arm64.so", "-ldl", "-lpthread", "-o", `dist/${libOut}-linux-arm64.so`]);
      dlLdLibraryPath = path.resolve("dist");
      break;
    }
    case "limine": {
      cloneTag(repo, tag);
      fs.mkdirSync("/tmp/limine_src", { recursive: true });
      const c = fs
        .readFileSync("src/host/limine.c", "utf8")
        .replaceAll("%VERSION%", version)
        .replaceAll("%COPYRIGHT%", "Copyright (C) 2019-2026 Mintsuki and contributors.");
      fs.writeFileSync("/tmp/limine_src/limine.c", c, "utf8");
      const flags = ["-std=c99", "-D_FILE_OFFSET_BITS=64", "-DLIMINE_NO_BIOS", "/tmp/limine_src/limine.c"];
      zigCc("x86_64-windows-gnu", ["-O2", "-s", ...flags, "-o", `dist/${libOut}-win64.exe`]);
      zigCc("x86_64-linux-gnu", ["-O2", "-s", ...flags, "-o", `dist/${libOut}-linux-x64`]);
      zigCc("aarch64-linux-gnu", ["-O2", "-s", ...flags, "-o", `dist/${libOut}-linux-arm64`]);
      zigCc("aarch64-macos", ["-O2", ...flags, "-o", `dist/${libOut}-macos-arm64`]);
      break;
    }
    case "vulkan-loader": {
      cloneTag(repo, tag);
      try {
        cloneTag("KhronosGroup/Vulkan-Headers", tag, "/tmp/vk_headers");
      } catch {
        fs.rmSync("/tmp/vk_headers", { recursive: true, force: true });
        cloneTag("KhronosGroup/Vulkan-Headers", "", "/tmp/vk_headers");
      }
      fs.mkdirSync("/tmp/vk_inc", { recursive: true });
      fs.mkdirSync("/tmp/vk_cf/CoreFoundation", { recursive: true });
      fs.writeFileSync(
        "/tmp/vk_inc/vk_cfg.h",
        `#define VK_ENABLE_BETA_EXTENSIONS 1
#define FALLBACK_CONFIG_DIRS "/etc/xdg"
#define FALLBACK_DATA_DIRS "/usr/local/share:/usr/share"
#define SYSCONFDIR "/etc"
#define LOADER_ENABLE_LINUX_SORT 1
`,
        "utf8"
      );
      fs.writeFileSync(
        "/tmp/vk_cf/CoreFoundation/CoreFoundation.h",
        `#ifndef _CF_STUB_H
#define _CF_STUB_H
#include <stdint.h>
typedef const void *CFTypeRef;
typedef const struct __CFBundle *CFBundleRef;
typedef const struct __CFURL *CFURLRef;
typedef unsigned char Boolean;
typedef uint8_t UInt8;
typedef long CFIndex;
#ifndef TRUE
#define TRUE 1
#endif
CFBundleRef CFBundleGetMainBundle(void);
CFURLRef CFBundleCopyResourcesDirectoryURL(CFBundleRef bundle);
Boolean CFURLGetFileSystemRepresentation(CFURLRef url, Boolean resolveAgainstBase, UInt8 *buffer, CFIndex maxBufLen);
void CFRelease(CFTypeRef cf);
#endif
`,
        "utf8"
      );
      const vkGen = ["src/loader/generated/vk_loader_core_trampolines.c", "src/loader/generated/vk_loader_wsi.c"];
      const skip = new Set(["asm_offset.c", "dlopen_fuchsia.c", "dirent_on_windows.c", "loader_windows.c", "loader_linux.c", "dev_ext_trampoline.c", "phys_dev_ext.c"]);
      const vkCommon = findFiles("src/loader", (_p, n) => n.endsWith(".c") && !skip.has(n), 1);
      const vkInc = ["-I/tmp/vk_headers/include", "-Isrc/loader", "-Isrc/loader/generated"];
      zigCc("x86_64-windows-gnu", ["-O2", "-shared", "-s", "-DVK_ENABLE_BETA_EXTENSIONS", "-DVK_USE_PLATFORM_WIN32_KHR", "-DWIN32_LEAN_AND_MEAN", ...vkInc, ...vkCommon, "src/loader/loader_windows.c", "src/loader/dirent_on_windows.c", ...vkGen, "src/loader/vulkan-1.def", "-lcfgmgr32", "-ladvapi32", "-lshlwapi", "-o", `dist/${libOut}-win64.dll`, `-Wl,--out-implib,dist/${libOut}-win64.dll.a`]);
      zigCc("x86_64-linux-gnu", ["-O2", "-shared", "-fPIC", "-s", "-D_GNU_SOURCE", "-include", "/tmp/vk_inc/vk_cfg.h", ...vkInc, ...vkCommon, "src/loader/loader_linux.c", ...vkGen, "-ldl", "-lpthread", "-lm", "-o", `dist/${libOut}-linux-x64.so`]);
      zigCc("aarch64-linux-gnu", ["-O2", "-shared", "-fPIC", "-s", "-D_GNU_SOURCE", "-include", "/tmp/vk_inc/vk_cfg.h", ...vkInc, ...vkCommon, "src/loader/loader_linux.c", ...vkGen, "-ldl", "-lpthread", "-lm", "-o", `dist/${libOut}-linux-arm64.so`]);
      zigCc("aarch64-macos", ["-O2", "-shared", "-fPIC", "-DVK_USE_PLATFORM_METAL_EXT", "-DVK_USE_PLATFORM_MACOS_MVK", "-include", "/tmp/vk_inc/vk_cfg.h", "-I/tmp/vk_cf", ...vkInc, ...vkCommon, ...vkGen, "-lm", "-Wl,-undefined,dynamic_lookup", "-o", `dist/${libOut}-macos-arm64.dylib`]);
      break;
    }
    default:
      throw new Error(`Unknown Tier-4 libKey: ${libKey}`);
  }

  const verifiedHeaders = verifyAndSmokeTest({ libKey, libOut, dlLdLibraryPath, cliBinaries: ["ninja", "limine"] });
  const kind = libKey === "ninja" || libKey === "limine" ? "cli-tool" : "runtime-library";
  emitSha512AndReceipt({ libKey, libOut, repo, tag, version, kind, verifiedHeaders });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const cmd = process.argv[2];
  if (cmd === "resolve") {
    await resolveVersionsPhase({
      tier: "tier4",
      releaseNotes:
        "Production max-version 5-OS shared libraries (Win64 .dll, Linux x64/ARM64 .so, macOS ARM64 .dylib, wasm32-wasi .wasm) compiled directly from upstream sources via pure holo-compiler (zig 0.14.0) — zero CMake, zero Ninja, zero Make.",
      resolvedFileName: "resolved-tier4-versions.json",
      defaults: TIER4_DEFAULTS,
    });
  } else if (cmd === "build") {
    const libKey = process.env.LIB_KEY || "";
    const versions = JSON.parse(process.env.VERSIONS_JSON || "{}") as Record<string, LibraryPin>;
    const pin = versions[libKey] ?? TIER4_DEFAULTS[libKey];
    if (!pin) throw new Error(`Missing version pin for ${libKey}`);
    appendGithubOutput({ lib_out: pin.libOut });
    if (checkSkipMaterialized(libKey, pin.libOut, pin.version, process.env.RELEASE_TAG || "v11-max-5os-latest")) {
      process.exit(0);
    }
    appendGithubOutput({ skipped: "false" });
    buildTier4Library(libKey, pin);
  } else if (cmd === "finalize") {
    finalizeTierSumsPhase({
      tierTitle: "Holo 5-OS Tier-4 Shards",
      resolvedArtifactName: "resolved-tier4-versions",
      resolvedFileName: "resolved-tier4-versions.json",
      sumArtifactPrefix: "tier4-sums",
      outSumFileName: "SHA512SUMS-tier4.txt",
    });
  } else {
    throw new Error(`Unknown command: ${cmd ?? "(none)"}`);
  }
}
