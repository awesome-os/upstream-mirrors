import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  appendGithubOutput,
  checkSkipMaterialized,
  cloneTag,
  compileMultiOs,
  detFlagsForTarget,
  emitSha512AndReceipt,
  finalizeTierSumsPhase,
  findFiles,
  type LibraryPin,
  makeCmakeWrappers,
  resolveVersionsPhase,
  run,
  verifyAndSmokeTest,
  zigCc,
  zigCxx,
} from "./holo-workflow-runtime.mts";

export const TIER5_DEFAULTS: Record<string, LibraryPin> = {
  "vulkan-headers": { pkg: "vulkan-headers", libOut: "libvulkan_headers", repo: "KhronosGroup/Vulkan-Headers", tag: "v1.4.369", version: "1.4.369" },
  "spirv-headers": { pkg: "spirv-headers", libOut: "libspirv_headers", repo: "KhronosGroup/SPIRV-Headers", tag: "vulkan-sdk-1.4.363.0", version: "1.4.363.0" },
  cccl: { pkg: "cccl", libOut: "libcccl", repo: "NVIDIA/cccl", tag: "v3.5.0", version: "3.5.0" },
  cutlass: { pkg: "cutlass", libOut: "libcutlass", repo: "NVIDIA/cutlass", tag: "v4.9.0dev", version: "4.9.0" },
  dav1d: { pkg: "dav1d", libOut: "libdav1d", repo: "videolan/dav1d", tag: "1.5.5", version: "1.5.5" },
  librdkafka: { pkg: "librdkafka", libOut: "librdkafka", repo: "confluentinc/librdkafka", tag: "v2.16.0", version: "2.16.0" },
  libsdl3: { pkg: "libsdl3", libOut: "libSDL3", repo: "libsdl-org/SDL", tag: "release-3.4.20", version: "3.4.20" },
  re2: { pkg: "re2", libOut: "libre2", repo: "google/re2", tag: "2025-11-05", version: "2025-11-05" },
  "spirv-tools": { pkg: "spirv-tools", libOut: "libSPIRV-Tools", repo: "KhronosGroup/SPIRV-Tools", tag: "v2026.4", version: "2026.4" },
  glslang: { pkg: "glslang", libOut: "libglslang", repo: "KhronosGroup/glslang", tag: "16.6.0", version: "16.6.0" },
  ffmpeg: { pkg: "ffmpeg", libOut: "libavutil", repo: "FFmpeg/FFmpeg", tag: "n9.1", version: "9.1" },
  meson: { pkg: "meson", libOut: "meson", repo: "mesonbuild/meson", tag: "1.12.1", version: "1.12.1" },
};

export const TIER5_LIBS = Object.keys(TIER5_DEFAULTS);

function cpuCount(): number {
  try {
    return fs.readFileSync("/proc/cpuinfo", "utf8").match(/^processor\b/gm)?.length || 4;
  } catch {
    return 4;
  }
}

function findFirstMatch(root: string, predicate: (name: string) => boolean, maxDepth = 4): string | undefined {
  return findFiles(root, (_p, n) => predicate(n), maxDepth)[0];
}

function copyIfFound(srcPath: string | undefined, destPath: string): void {
  if (!srcPath) throw new Error(`Expected built artifact for ${destPath}`);
  fs.copyFileSync(srcPath, destPath);
}

export function buildTier5Library(libKey: string, pin: LibraryPin): void {
  const { libOut, repo, tag, version } = pin;
  console.log(`=== Building ${libKey} (${libOut}) @ ${repo} ${tag} (${version}) ===`);
  fs.mkdirSync("src", { recursive: true });
  fs.mkdirSync("dist", { recursive: true });
  let dlLdLibraryPath = "";
  const nproc = String(cpuCount());

  switch (libKey) {
    case "vulkan-headers": {
      cloneTag(repo, tag);
      fs.writeFileSync(
        "/tmp/vk_probe.c",
        `#define VK_NO_PROTOTYPES 1
#include <stdint.h>
#include <vulkan/vulkan.h>
#ifdef _WIN32
#define B8G_EXP __declspec(dllexport)
#else
#define B8G_EXP __attribute__((visibility("default")))
#endif
B8G_EXP uint32_t b8g_vulkan_header_version(void) { return VK_HEADER_VERSION; }
B8G_EXP uint32_t b8g_vulkan_api_version(void) { return VK_HEADER_VERSION_COMPLETE; }
`,
        "utf8"
      );
      compileMultiOs(libOut, { includeWasi: true, commonArgs: ["-std=c11", "-Isrc/include", "/tmp/vk_probe.c"] });
      break;
    }
    case "spirv-headers": {
      cloneTag(repo, tag);
      fs.writeFileSync(
        "/tmp/spv_probe.c",
        `#include <stdint.h>
#include <spirv/unified1/spirv.h>
#ifdef _WIN32
#define B8G_EXP __declspec(dllexport)
#else
#define B8G_EXP __attribute__((visibility("default")))
#endif
B8G_EXP uint32_t b8g_spv_version(void) { return SPV_VERSION; }
B8G_EXP uint32_t b8g_spv_magic(void) { return SpvMagicNumber; }
`,
        "utf8"
      );
      compileMultiOs(libOut, { includeWasi: true, commonArgs: ["-std=c11", "-Isrc/include", "/tmp/spv_probe.c"] });
      break;
    }
    case "cccl": {
      cloneTag(repo, tag);
      fs.writeFileSync(
        "/tmp/cccl_probe.cpp",
        `#define THRUST_HOST_SYSTEM THRUST_HOST_SYSTEM_CPP
#define THRUST_DEVICE_SYSTEM THRUST_DEVICE_SYSTEM_CPP
#include <cuda/std/version>
#include <thrust/version.h>
#include <cstdint>
#ifdef _WIN32
#define B8G_EXP __declspec(dllexport)
#else
#define B8G_EXP __attribute__((visibility("default")))
#endif
extern "C" {
B8G_EXP uint32_t b8g_cccl_version(void) { return CCCL_VERSION; }
B8G_EXP uint32_t b8g_thrust_version(void) { return THRUST_VERSION; }
B8G_EXP uint32_t b8g_cccl_major(void) { return CCCL_MAJOR_VERSION; }
B8G_EXP uint32_t b8g_cccl_minor(void) { return CCCL_MINOR_VERSION; }
B8G_EXP uint32_t b8g_cccl_patch(void) { return CCCL_PATCH_VERSION; }
}
`,
        "utf8"
      );
      compileMultiOs(libOut, { cxx: true, commonArgs: ["-std=c++17", "-Isrc/libcudacxx/include", "-Isrc/thrust", "/tmp/cccl_probe.cpp"] });
      break;
    }
    case "cutlass": {
      cloneTag(repo, tag);
      fs.writeFileSync(
        "/tmp/cutlass_probe.cpp",
        `#include <cutlass/version.h>
#include <cstdint>
#ifdef _WIN32
#define B8G_EXP __declspec(dllexport)
#else
#define B8G_EXP __attribute__((visibility("default")))
#endif
extern "C" {
B8G_EXP uint32_t b8g_cutlass_version(void) { return cutlass::getVersion(); }
B8G_EXP uint32_t b8g_cutlass_major(void) { return cutlass::getVersionMajor(); }
B8G_EXP uint32_t b8g_cutlass_minor(void) { return cutlass::getVersionMinor(); }
B8G_EXP uint32_t b8g_cutlass_patch(void) { return cutlass::getVersionPatch(); }
}
`,
        "utf8"
      );
      compileMultiOs(libOut, { cxx: true, commonArgs: ["-std=c++17", "-Isrc/include", "/tmp/cutlass_probe.cpp"] });
      break;
    }
    case "dav1d": {
      cloneTag(repo, tag);
      fs.mkdirSync("/tmp/dav1d_inc", { recursive: true });
      fs.mkdirSync("/tmp/dav1d_wasi_inc", { recursive: true });
      fs.writeFileSync("/tmp/dav1d_inc/vcs_version.h", `#define DAV1D_VERSION "${version}"\n`, "utf8");
      fs.writeFileSync(
        "/tmp/dav1d_inc/config.h",
        `#ifndef DAV1D_CONFIG_H
#define DAV1D_CONFIG_H
#define CONFIG_8BPC 1
#define CONFIG_16BPC 1
#define HAVE_ASM 0
#define CONFIG_ASM_DEBUG 0
#define TRIM_DSP_FUNCTIONS 0
#define CONFIG_LOG 1
#define ENDIAN_LITTLE 1
#define ENDIANNESS_BIG 0
#define ARCH_X86 0
#define ARCH_X86_64 0
#define ARCH_X86_32 0
#define ARCH_AARCH64 0
#define ARCH_ARM 0
#define ARCH_PPC64LE 0
#define ARCH_RISCV 0
#define ARCH_RV32 0
#define ARCH_RV64 0
#define ARCH_LOONGARCH 0
#define ARCH_LOONGARCH32 0
#define ARCH_LOONGARCH64 0
#define HAVE_C11_GENERIC 1
#define HAVE_DLSYM 0
#define HAVE_PTHREAD_GETAFFINITY_NP 0
#define HAVE_PTHREAD_SETAFFINITY_NP 0
#define HAVE_PTHREAD_SETNAME_NP 0
#define HAVE_PTHREAD_SET_NAME_NP 0
#define HAVE_PTHREAD_NP_H 0
#define HAVE_GETAUXVAL 0
#define HAVE_ELF_AUX_INFO 0
#define HAVE_SIGACTION 0
#define HAVE_SYS_TYPES_H 1
#ifdef _WIN32
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0601
#endif
#define _FILE_OFFSET_BITS 64
#define HAVE_CLOCK_GETTIME 0
#define HAVE_POSIX_MEMALIGN 0
#define HAVE_MEMALIGN 0
#define HAVE_ALIGNED_ALLOC 0
#define HAVE_UNISTD_H 0
#define HAVE_IO_H 1
#else
#define HAVE_CLOCK_GETTIME 1
#define HAVE_POSIX_MEMALIGN 1
#define HAVE_MEMALIGN 0
#define HAVE_ALIGNED_ALLOC 1
#define HAVE_UNISTD_H 1
#define HAVE_IO_H 0
#endif
#endif
`,
        "utf8"
      );
      fs.writeFileSync(
        "/tmp/dav1d_wasi_inc/pthread.h",
        `#ifndef _WASI_PTHREAD_STUB_H
#define _WASI_PTHREAD_STUB_H
#include <errno.h>
#include <stddef.h>
typedef int pthread_t;
typedef int pthread_attr_t;
typedef int pthread_mutex_t;
typedef int pthread_mutexattr_t;
typedef int pthread_cond_t;
typedef int pthread_condattr_t;
typedef int pthread_once_t;
#define PTHREAD_MUTEX_INITIALIZER 0
#define PTHREAD_COND_INITIALIZER 0
#define PTHREAD_ONCE_INIT 0
static inline int pthread_attr_init(pthread_attr_t *a) { (void)a; return 0; }
static inline int pthread_attr_destroy(pthread_attr_t *a) { (void)a; return 0; }
static inline int pthread_attr_setstacksize(pthread_attr_t *a, size_t s) { (void)a; (void)s; return 0; }
static inline int pthread_create(pthread_t *t, const pthread_attr_t *a, void *(*fn)(void *), void *arg) { (void)t; (void)a; (void)fn; (void)arg; return ENOSYS; }
static inline int pthread_join(pthread_t t, void **ret) { (void)t; (void)ret; return 0; }
static inline int pthread_mutex_init(pthread_mutex_t *m, const pthread_mutexattr_t *a) { (void)m; (void)a; return 0; }
static inline int pthread_mutex_destroy(pthread_mutex_t *m) { (void)m; return 0; }
static inline int pthread_mutex_lock(pthread_mutex_t *m) { (void)m; return 0; }
static inline int pthread_mutex_trylock(pthread_mutex_t *m) { (void)m; return 0; }
static inline int pthread_mutex_unlock(pthread_mutex_t *m) { (void)m; return 0; }
static inline int pthread_cond_init(pthread_cond_t *c, const pthread_condattr_t *a) { (void)c; (void)a; return 0; }
static inline int pthread_cond_destroy(pthread_cond_t *c) { (void)c; return 0; }
static inline int pthread_cond_wait(pthread_cond_t *c, pthread_mutex_t *m) { (void)c; (void)m; return 0; }
static inline int pthread_cond_signal(pthread_cond_t *c) { (void)c; return 0; }
static inline int pthread_cond_broadcast(pthread_cond_t *c) { (void)c; return 0; }
static inline int pthread_once(pthread_once_t *o, void (*fn)(void)) { if (o && !*o) { *o = 1; fn(); } return 0; }
#endif
`,
        "utf8"
      );
      const core = [
        "cdf.c", "cpu.c", "ctx.c", "data.c", "decode.c", "dequant_tables.c", "getbits.c", "intra_edge.c",
        "itx_1d.c", "lf_mask.c", "lib.c", "log.c", "mem.c", "msac.c", "obu.c", "pal.c", "picture.c", "qm.c",
        "ref.c", "refmvs.c", "scan.c", "tables.c", "thread_task.c", "warpmv.c", "wedge.c",
      ].map((f) => `src/src/${f}`);
      const tmpl = [
        "cdef_apply_tmpl.c", "cdef_tmpl.c", "fg_apply_tmpl.c", "filmgrain_tmpl.c", "ipred_prepare_tmpl.c",
        "ipred_tmpl.c", "itx_tmpl.c", "lf_apply_tmpl.c", "loopfilter_tmpl.c", "looprestoration_tmpl.c",
        "lr_apply_tmpl.c", "mc_tmpl.c", "recon_tmpl.c",
      ].map((f) => `src/src/${f}`);
      const baseInc = ["-std=c11", "-I/tmp/dav1d_inc", "-Isrc", "-Isrc/include", "-Isrc/src", "-DENDIAN_LITTLE=1", "-DARCH_X86=0", "-DARCH_AARCH64=0"];

      const buildTarget = (
        target: string,
        cflags: string[],
        lflags: string[],
        extraSrcs: string[],
        out: string
      ): void => {
        const odir = `/tmp/dav1d_obj_${target}`;
        fs.mkdirSync(odir, { recursive: true });
        const objs: string[] = [];
        for (const f of tmpl) {
          const b = path.basename(f, ".c");
          const o8 = `${odir}/${b}_8.o`;
          const o16 = `${odir}/${b}_16.o`;
          zigCc(target, ["-O2", "-c", ...cflags, ...baseInc, "-DBITDEPTH=8", f, "-o", o8]);
          zigCc(target, ["-O2", "-c", ...cflags, ...baseInc, "-DBITDEPTH=16", f, "-o", o16]);
          objs.push(o8, o16);
        }
        zigCc(target, ["-O2", ...cflags, ...baseInc, ...core, ...extraSrcs, ...objs, ...lflags, "-o", out]);
      };

      buildTarget("x86_64-windows-gnu", ["-DDAV1D_BUILDING_DLL"], ["-shared", "-s", `-Wl,--out-implib,dist/${libOut}-win64.dll.a`], ["src/src/win32/thread.c"], `dist/${libOut}-win64.dll`);
      buildTarget("x86_64-linux-gnu", ["-fPIC", "-D_GNU_SOURCE", "-D_POSIX_C_SOURCE=200809L"], ["-shared", "-s", "-lpthread", "-lm"], [], `dist/${libOut}-linux-x64.so`);
      buildTarget("aarch64-linux-gnu", ["-fPIC", "-D_GNU_SOURCE", "-D_POSIX_C_SOURCE=200809L"], ["-shared", "-s", "-lpthread", "-lm"], [], `dist/${libOut}-linux-arm64.so`);
      buildTarget("aarch64-macos", ["-fPIC", "-D_DARWIN_C_SOURCE", "-D_POSIX_C_SOURCE=200809L"], ["-shared", "-lpthread", "-lm"], [], `dist/${libOut}-macos-arm64.dylib`);
      buildTarget("wasm32-wasi", ["-I/tmp/dav1d_wasi_inc", "-D_POSIX_C_SOURCE=200809L"], ["-mexec-model=reactor", "-lm"], [], `dist/${libOut}-wasm32-wasi.wasm`);
      break;
    }
    case "librdkafka": {
      cloneTag(repo, tag);
      fs.writeFileSync(
        "src/config.h",
        `#ifndef _RD_CONFIG_H_
#define _RD_CONFIG_H_
#define WITHOUT_OPTIMIZATION 0
#define ENABLE_DEVEL 0
#define ENABLE_REFCNT_DEBUG 0
#define HAVE_ATOMICS_32 1
#define HAVE_ATOMICS_32_ATOMIC 1
#define HAVE_ATOMICS_32_SYNC 0
#define ATOMIC_OP32(OP1,OP2,PTR,VAL) __atomic_ ## OP1 ## _ ## OP2(PTR, VAL, __ATOMIC_SEQ_CST)
#define HAVE_ATOMICS_64 1
#define HAVE_ATOMICS_64_ATOMIC 1
#define HAVE_ATOMICS_64_SYNC 0
#define ATOMIC_OP64(OP1,OP2,PTR,VAL) __atomic_ ## OP1 ## _ ## OP2(PTR, VAL, __ATOMIC_SEQ_CST)
#define WITH_PKGCONFIG 0
#define WITH_HDRHISTOGRAM 0
#define WITH_ZLIB 0
#define WITH_CURL 0
#define WITH_OAUTHBEARER_OIDC 0
#define WITH_ZSTD 0
#define WITH_LIBDL 0
#define WITH_PLUGINS 0
#define WITH_SNAPPY 1
#define WITH_SOCKEM 1
#define WITH_SSL 0
#define WITH_SASL 1
#define WITH_SASL_SCRAM 0
#define WITH_SASL_OAUTHBEARER 0
#define WITH_SASL_CYRUS 0
#define WITH_LZ4_EXT 0
#define HAVE_REGEX 1
#define HAVE_STRNDUP 1
#define HAVE_RAND_R 1
#define HAVE_GETENTROPY 1
#ifdef __APPLE__
#define HAVE_PTHREAD_SETNAME_GNU 0
#define HAVE_PTHREAD_SETNAME_DARWIN 1
#define SOLIB_EXT ".dylib"
#else
#define HAVE_PTHREAD_SETNAME_GNU 1
#define HAVE_PTHREAD_SETNAME_DARWIN 0
#define SOLIB_EXT ".so"
#endif
#define HAVE_PTHREAD_SETNAME_FREEBSD 0
#define WITH_C11THREADS 0
#define WITH_CRC32C_HW 0
#define BUILT_WITH "SNAPPY SOCKEM SASL"
#endif
`,
        "utf8"
      );
      const exclude = new Set([
        "rdkafka_ssl.c", "rdkafka_zstd.c", "rdhttp.c", "rdgz.c", "rdhdrhistogram.c",
        "rdkafka_plugin.c", "rddl.c", "rdkafka_sasl_cyrus.c", "rdkafka_sasl_scram.c",
        "rdkafka_sasl_win32.c", "regexp.c",
      ]);
      const core = findFiles("src/src", (_p, n) => n.endsWith(".c") && !exclude.has(n) && !n.startsWith("rdkafka_sasl_oauthbearer"), 1);
      const pb = [
        "src/src/nanopb/pb_encode.c", "src/src/nanopb/pb_decode.c", "src/src/nanopb/pb_common.c",
        "src/src/opentelemetry/metrics.pb.c", "src/src/opentelemetry/common.pb.c", "src/src/opentelemetry/resource.pb.c",
      ];
      const inc = ["-Isrc/src", "-Isrc/src/nanopb", "-Wno-incompatible-pointer-types"];
      const winFlags = [
        "-DWITHOUT_WIN32_CONFIG", "-DLIBRDKAFKA_EXPORTS", "-DWITH_SNAPPY=1", "-DWITH_SOCKEM=1",
        "-DWITH_SASL=1", "-DENABLE_DEVEL=0", "-DWITH_LIBDL=0", "-DWITH_PLUGINS=0", "-DWITH_SSL=0",
        "-DWITH_ZLIB=0", "-DWITH_ZSTD=0", "-DWITH_CURL=0", "-DWITH_HDRHISTOGRAM=0", "-DWITH_LZ4_EXT=0",
        "-DWITH_SASL_SCRAM=0", "-DWITH_SASL_OAUTHBEARER=0", "-DWITH_OAUTHBEARER_OIDC=0", "-DHAVE_REGEX=0",
        "-DWITH_C11THREADS=0", "-DWITH_CRC32C_HW=0",
      ];
      zigCc("x86_64-windows-gnu", ["-O2", "-shared", "-s", ...winFlags, ...inc, ...core, "src/src/regexp.c", "src/src/rdkafka_sasl_win32.c", ...pb, "-lws2_32", "-liphlpapi", "-lcrypt32", "-lsecur32", "-o", `dist/${libOut}-win64.dll`, `-Wl,--out-implib,dist/${libOut}-win64.dll.a`]);
      zigCc("x86_64-linux-gnu", ["-O2", "-shared", "-fPIC", "-s", ...inc, ...core, ...pb, "-lpthread", "-lm", "-o", `dist/${libOut}-linux-x64.so`]);
      zigCc("aarch64-linux-gnu", ["-O2", "-shared", "-fPIC", "-s", ...inc, ...core, ...pb, "-lpthread", "-lm", "-o", `dist/${libOut}-linux-arm64.so`]);
      zigCc("aarch64-macos", ["-O2", "-shared", "-fPIC", ...inc, ...core, ...pb, "-lpthread", "-lm", "-o", `dist/${libOut}-macos-arm64.dylib`]);
      break;
    }
    case "libsdl3": {
      cloneTag(repo, tag);
      const sdlOpts = [
        "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release",
        "-DSDL_SHARED=ON", "-DSDL_STATIC=OFF", "-DSDL_TESTS=OFF", "-DSDL_EXAMPLES=OFF",
        "-DSDL_VIDEO=ON", "-DSDL_DUMMYVIDEO=ON", "-DSDL_OFFSCREEN=ON",
        "-DSDL_AUDIO=ON", "-DSDL_DUMMYAUDIO=ON", "-DSDL_DISKAUDIO=ON", "-DSDL_RENDER=ON",
        "-DSDL_UNIX_CONSOLE_BUILD=ON", "-DSDL_X11=OFF", "-DSDL_WAYLAND=OFF", "-DSDL_KMSDRM=OFF",
        "-DSDL_OPENGL=OFF", "-DSDL_OPENGLES=OFF", "-DSDL_VULKAN=OFF",
        "-DSDL_DIRECTX=OFF", "-DSDL_WASAPI=OFF", "-DSDL_XINPUT=OFF",
        "-DSDL_RENDER_D3D=OFF", "-DSDL_RENDER_D3D11=OFF", "-DSDL_RENDER_D3D12=OFF",
        "-DSDL_RENDER_VULKAN=OFF", "-DSDL_RENDER_GPU=OFF", "-DSDL_GPU=OFF",
        "-DSDL_HIDAPI=OFF", "-DSDL_JOYSTICK=OFF", "-DSDL_HAPTIC=OFF",
        "-DSDL_CAMERA=OFF", "-DSDL_SENSOR=OFF", "-DSDL_DIALOG=OFF", "-DSDL_TRAY=OFF",
        "-DSDL_ALSA=OFF", "-DSDL_PULSEAUDIO=OFF", "-DSDL_PIPEWIRE=OFF", "-DSDL_JACK=OFF",
        "-DSDL_SNDIO=OFF", "-DSDL_OSS=OFF", "-DSDL_DBUS=OFF", "-DSDL_IBUS=OFF", "-DSDL_LIBUDEV=OFF",
      ];
      const buildSdl = (arch: string, sys: string, proc: string, zigT: string, shLd: string): string => {
        const w = `/tmp/sdl_w_${arch}`;
        const b = `/tmp/sdl_b_${arch}`;
        makeCmakeWrappers(w, zigT);
        const args = [
          "-S", "src", "-B", b, ...sdlOpts,
          `-DCMAKE_SYSTEM_NAME=${sys}`, `-DCMAKE_SYSTEM_PROCESSOR=${proc}`,
          `-DCMAKE_C_COMPILER=${w}/cc`, `-DCMAKE_CXX_COMPILER=${w}/cxx`,
          `-DCMAKE_AR=${w}/ar`, `-DCMAKE_RANLIB=${w}/ranlib`,
          `-DCMAKE_SHARED_LINKER_FLAGS=${shLd}`,
        ];
        if (sys === "Windows") args.push(`-DCMAKE_RC_COMPILER=${w}/windres`);
        run("cmake", args);
        run("cmake", ["--build", b, `-j${nproc}`]);
        return b;
      };
      const bX64 = buildSdl("lin_x64", "Linux", "x86_64", "x86_64-linux-gnu", "-lpthread -s");
      copyIfFound(findFirstMatch(bX64, (n) => n.startsWith("libSDL3.so") && !n.endsWith(".dbg"), 2), `dist/${libOut}-linux-x64.so`);
      const bArm = buildSdl("lin_arm64", "Linux", "aarch64", "aarch64-linux-gnu", "-lpthread -s");
      copyIfFound(findFirstMatch(bArm, (n) => n.startsWith("libSDL3.so") && !n.endsWith(".dbg"), 2), `dist/${libOut}-linux-arm64.so`);
      const bWin = buildSdl("win64", "Windows", "AMD64", "x86_64-windows-gnu", "-s");
      copyIfFound(findFirstMatch(bWin, (n) => n.includes("SDL3") && n.endsWith(".dll"), 2), `dist/${libOut}-win64.dll`);
      const imp = findFirstMatch(bWin, (n) => n.includes("SDL3") && n.endsWith(".dll.a"), 2);
      if (imp) fs.copyFileSync(imp, `dist/${libOut}-win64.dll.a`);
      break;
    }
    case "re2": {
      cloneTag(repo, tag, "/tmp/re2_src");
      cloneTag("abseil/abseil-cpp", "", "/tmp/absl_src");
      fs.mkdirSync("/tmp/re2_bundle", { recursive: true });
      fs.writeFileSync(
        "/tmp/re2_bundle/CMakeLists.txt",
        `cmake_minimum_required(VERSION 3.22)
project(re2_bundle C CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(ABSL_PROPAGATE_CXX_STD ON)
set(ABSL_BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS OFF)
add_subdirectory(/tmp/absl_src abseil_build)
set(BUILD_SHARED_LIBS ON)
set(RE2_BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(RE2_USE_ICU OFF CACHE BOOL "" FORCE)
set(RE2_INSTALL OFF CACHE BOOL "" FORCE)
add_subdirectory(/tmp/re2_src re2_build)
`,
        "utf8"
      );
      const buildRe2 = (arch: string, sys: string, proc: string, zigT: string, shLd: string): string => {
        const w = `/tmp/re2_w_${arch}`;
        const b = `/tmp/re2_b_${arch}`;
        makeCmakeWrappers(w, zigT);
        run("cmake", [
          "-S", "/tmp/re2_bundle", "-B", b, "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release",
          `-DCMAKE_SYSTEM_NAME=${sys}`, `-DCMAKE_SYSTEM_PROCESSOR=${proc}`,
          `-DCMAKE_C_COMPILER=${w}/cc`, `-DCMAKE_CXX_COMPILER=${w}/cxx`,
          `-DCMAKE_AR=${w}/ar`, `-DCMAKE_RANLIB=${w}/ranlib`,
          `-DCMAKE_SHARED_LINKER_FLAGS=${shLd}`,
          "-DCMAKE_WINDOWS_EXPORT_ALL_SYMBOLS=ON",
        ]);
        run("cmake", ["--build", b, "--target", "re2", `-j${nproc}`]);
        return `${b}/re2_build`;
      };
      copyIfFound(findFirstMatch(buildRe2("lin_x64", "Linux", "x86_64", "x86_64-linux-gnu", "-lpthread -s"), (n) => n.startsWith("libre2.so"), 2), `dist/${libOut}-linux-x64.so`);
      copyIfFound(findFirstMatch(buildRe2("lin_arm64", "Linux", "aarch64", "aarch64-linux-gnu", "-lpthread -s"), (n) => n.startsWith("libre2.so"), 2), `dist/${libOut}-linux-arm64.so`);
      const bWin = buildRe2("win64", "Windows", "AMD64", "x86_64-windows-gnu", "-s");
      copyIfFound(findFirstMatch(bWin, (n) => n.includes("re2") && n.endsWith(".dll"), 2), `dist/${libOut}-win64.dll`);
      const imp = findFirstMatch(bWin, (n) => n.includes("re2") && n.endsWith(".dll.a"), 2);
      if (imp) fs.copyFileSync(imp, `dist/${libOut}-win64.dll.a`);
      break;
    }
    case "spirv-tools": {
      cloneTag(repo, tag);
      try {
        cloneTag("KhronosGroup/SPIRV-Headers", "vulkan-sdk-1.4.363.0", "/tmp/spv_headers");
      } catch {
        fs.rmSync("/tmp/spv_headers", { recursive: true, force: true });
        cloneTag("KhronosGroup/SPIRV-Headers", "", "/tmp/spv_headers");
      }
      const spvOpts = [
        "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release",
        "-DSPIRV_SKIP_TESTS=ON", "-DSPIRV_SKIP_EXECUTABLES=ON",
        "-DBUILD_SHARED_LIBS=ON", "-DSPIRV_TOOLS_USE_MIMALLOC=OFF",
        "-DSPIRV_WERROR=OFF", "-DENABLE_RTTI=ON",
        "-DSPIRV-Headers_SOURCE_DIR=/tmp/spv_headers",
      ];
      const buildSpvt = (arch: string, sys: string, proc: string, zigT: string, shLd: string): string => {
        const w = `/tmp/spvt_w_${arch}`;
        const b = `/tmp/spvt_b_${arch}`;
        makeCmakeWrappers(w, zigT);
        run("cmake", [
          "-S", "src", "-B", b, ...spvOpts,
          `-DCMAKE_SYSTEM_NAME=${sys}`, `-DCMAKE_SYSTEM_PROCESSOR=${proc}`,
          `-DCMAKE_C_COMPILER=${w}/cc`, `-DCMAKE_CXX_COMPILER=${w}/cxx`,
          `-DCMAKE_AR=${w}/ar`, `-DCMAKE_RANLIB=${w}/ranlib`,
          `-DCMAKE_SHARED_LINKER_FLAGS=${shLd}`,
        ]);
        run("cmake", ["--build", b, "--target", "SPIRV-Tools-shared", `-j${nproc}`]);
        return `${b}/source`;
      };
      copyIfFound(findFirstMatch(buildSpvt("lin_x64", "Linux", "x86_64", "x86_64-linux-gnu", "-lpthread -Wl,-z,nodelete -s"), (n) => n.startsWith("libSPIRV-Tools-shared.so"), 2), `dist/${libOut}-linux-x64.so`);
      copyIfFound(findFirstMatch(buildSpvt("lin_arm64", "Linux", "aarch64", "aarch64-linux-gnu", "-lpthread -Wl,-z,nodelete -s"), (n) => n.startsWith("libSPIRV-Tools-shared.so"), 2), `dist/${libOut}-linux-arm64.so`);
      const bWin = buildSpvt("win64", "Windows", "AMD64", "x86_64-windows-gnu", "-s");
      copyIfFound(findFirstMatch(bWin, (n) => n.includes("SPIRV-Tools-shared") && n.endsWith(".dll"), 2), `dist/${libOut}-win64.dll`);
      const imp = findFirstMatch(bWin, (n) => n.includes("SPIRV-Tools-shared") && n.endsWith(".dll.a"), 2);
      if (imp) fs.copyFileSync(imp, `dist/${libOut}-win64.dll.a`);
      break;
    }
    case "glslang": {
      cloneTag(repo, tag);
      const glslOpts = [
        "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release",
        "-DGLSLANG_TESTS=OFF", "-DBUILD_TESTING=OFF",
        "-DENABLE_OPT=OFF", "-DENABLE_GLSLANG_BINARIES=OFF",
        "-DBUILD_SHARED_LIBS=ON", "-DENABLE_PCH=OFF",
        "-DENABLE_RTTI=ON", "-DENABLE_EXCEPTIONS=ON",
      ];
      const buildGlsl = (arch: string, sys: string, proc: string, zigT: string, shLd: string): string => {
        const w = `/tmp/glsl_w_${arch}`;
        const b = `/tmp/glsl_b_${arch}`;
        makeCmakeWrappers(w, zigT);
        run("cmake", [
          "-S", "src", "-B", b, ...glslOpts,
          `-DCMAKE_SYSTEM_NAME=${sys}`, `-DCMAKE_SYSTEM_PROCESSOR=${proc}`,
          `-DCMAKE_C_COMPILER=${w}/cc`, `-DCMAKE_CXX_COMPILER=${w}/cxx`,
          `-DCMAKE_AR=${w}/ar`, `-DCMAKE_RANLIB=${w}/ranlib`,
          `-DCMAKE_SHARED_LINKER_FLAGS=${shLd}`,
          "-DCMAKE_INSTALL_RPATH=$ORIGIN", "-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON",
          "-DCMAKE_WINDOWS_EXPORT_ALL_SYMBOLS=ON",
        ]);
        run("cmake", ["--build", b, "--target", "glslang", `-j${nproc}`]);
        return b;
      };
      copyIfFound(findFirstMatch(buildGlsl("lin_x64", "Linux", "x86_64", "x86_64-linux-gnu", "-lpthread -Wl,-z,nodelete -s"), (n) => n.startsWith("libglslang.so")), `dist/${libOut}-linux-x64.so`);
      copyIfFound(findFirstMatch(buildGlsl("lin_arm64", "Linux", "aarch64", "aarch64-linux-gnu", "-lpthread -Wl,-z,nodelete -s"), (n) => n.startsWith("libglslang.so")), `dist/${libOut}-linux-arm64.so`);
      const bWin = buildGlsl("win64", "Windows", "AMD64", "x86_64-windows-gnu", "-s");
      copyIfFound(findFirstMatch(bWin, (n) => n.includes("glslang") && n.endsWith(".dll")), `dist/${libOut}-win64.dll`);
      const imp = findFirstMatch(bWin, (n) => n.includes("glslang") && n.endsWith(".dll.a"));
      if (imp) fs.copyFileSync(imp, `dist/${libOut}-win64.dll.a`);
      break;
    }
    case "ffmpeg": {
      cloneTag(repo, tag);
      const ffSrc = path.resolve("src");
      const detC = `-ffile-prefix-map=${process.cwd()}=.`;
      const buildFf = (arch: string, osName: string, zigT: string, ldDet: string): string => {
        const bdir = `/tmp/ff_b_${arch}_${osName}`;
        fs.rmSync(bdir, { recursive: true, force: true });
        fs.mkdirSync(bdir, { recursive: true });
        run(
          `${ffSrc}/configure`,
          [
            "--enable-cross-compile", `--arch=${arch}`, `--target-os=${osName}`,
            `--cc=zig cc -target ${zigT} ${detC}`,
            `--cxx=zig c++ -target ${zigT} ${detC}`,
            `--ld=zig cc -target ${zigT} ${detC}`,
            "--ar=zig ar", "--ranlib=zig ranlib", "--disable-stripping",
            "--disable-all", "--disable-asm", "--disable-autodetect",
            "--disable-programs", "--disable-doc",
            "--enable-avutil", "--enable-avcodec", "--enable-avformat", "--enable-swscale",
            "--enable-shared", "--disable-static",
            `--extra-ldflags=-Wl,-rpath,$ORIGIN ${ldDet}`.trim(),
          ],
          { cwd: bdir, quiet: true }
        );
        if (osName === "linux" && fs.existsSync(path.join(bdir, "config.h"))) {
          const ch = fs.readFileSync(path.join(bdir, "config.h"), "utf8").replace(/^#define HAVE_SYSCTL 1$/m, "#define HAVE_SYSCTL 0");
          fs.writeFileSync(path.join(bdir, "config.h"), ch, "utf8");
        }
        run("make", [`-j${nproc}`], { cwd: bdir, quiet: true });
        return bdir;
      };
      const bx64 = buildFf("x86_64", "linux", "x86_64-linux-gnu", "-Wl,--build-id=none");
      for (const lib of ["libavutil", "libavcodec", "libavformat", "libswscale"]) {
        copyIfFound(findFirstMatch(bx64, (n) => n.startsWith(`${lib}.so`)), `dist/${lib}-linux-x64.so`);
      }
      const barm = buildFf("aarch64", "linux", "aarch64-linux-gnu", "-Wl,--build-id=none");
      for (const lib of ["libavutil", "libavcodec", "libavformat", "libswscale"]) {
        copyIfFound(findFirstMatch(barm, (n) => n.startsWith(`${lib}.so`)), `dist/${lib}-linux-arm64.so`);
      }
      const bwin = buildFf("x86_64", "mingw32", "x86_64-windows-gnu", "");
      for (const lib of ["avutil", "avcodec", "avformat", "swscale"]) {
        const dll = findFirstMatch(bwin, (n) => n.startsWith(`${lib}-`) && n.endsWith(".dll"));
        if (dll) fs.copyFileSync(dll, `dist/lib${lib}-win64.dll`);
        const imp = findFirstMatch(bwin, (n) => n === `lib${lib}.dll.a`);
        if (imp) fs.copyFileSync(imp, `dist/lib${lib}-win64.dll.a`);
      }
      dlLdLibraryPath = path.resolve("dist");
      break;
    }
    case "meson": {
      cloneTag(repo, tag);
      fs.mkdirSync("/tmp/meson_app", { recursive: true });
      run("cp", ["-a", "src/mesonbuild", "/tmp/meson_app/mesonbuild"]);
      fs.writeFileSync(
        "/tmp/meson_app/__main__.py",
        `import sys
from mesonbuild import mesonmain
if __name__ == '__main__':
    sys.exit(mesonmain.main())
`,
        "utf8"
      );
      run("python3", ["-m", "zipapp", "/tmp/meson_app", "-p", "/usr/bin/env python3", "-o", `dist/${libOut}.pyz`]);
      fs.chmodSync(`dist/${libOut}.pyz`, 0o755);
      fs.writeFileSync(
        "/tmp/meson_wrap.c",
        `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <process.h>
#include <windows.h>
int main(int argc, char **argv) {
  char exe[4096], pyz[4096];
  GetModuleFileNameA(NULL, exe, sizeof(exe));
  char *sep = strrchr(exe, '\\\\');
  if (sep) *(sep + 1) = '\\0'; else exe[0] = '\\0';
  snprintf(pyz, sizeof(pyz), "%smeson.pyz", exe);
  const char **av = (const char **)calloc((size_t)argc + 3, sizeof(char *));
  av[0] = "python"; av[1] = pyz;
  for (int i = 1; i < argc; i++) av[i + 1] = argv[i];
  return (int)_spawnvp(_P_WAIT, "python", av);
}
#else
#include <libgen.h>
#include <unistd.h>
int main(int argc, char **argv) {
  char buf[4096], pyz[4096];
  snprintf(buf, sizeof(buf), "%s", argv[0]);
  snprintf(pyz, sizeof(pyz), "%s/meson.pyz", dirname(buf));
  char **av = (char **)calloc((size_t)argc + 3, sizeof(char *));
  av[0] = "python3"; av[1] = pyz;
  for (int i = 1; i < argc; i++) av[i + 1] = argv[i];
  execvp("python3", av);
  return 127;
}
#endif
`,
        "utf8"
      );
      zigCc("x86_64-windows-gnu", ["-O2", "-s", "/tmp/meson_wrap.c", "-o", `dist/${libOut}-win64.exe`]);
      zigCc("x86_64-linux-gnu", ["-O2", "-s", "/tmp/meson_wrap.c", "-o", `dist/${libOut}-linux-x64`]);
      zigCc("aarch64-linux-gnu", ["-O2", "-s", "/tmp/meson_wrap.c", "-o", `dist/${libOut}-linux-arm64`]);
      zigCc("aarch64-macos", ["-O2", "/tmp/meson_wrap.c", "-o", `dist/${libOut}-macos-arm64`]);
      break;
    }
    default:
      throw new Error(`Unknown Tier-5 libKey: ${libKey}`);
  }

  // Ensure deterministic compilation helper is referenced by TypeScript typecheck
  void detFlagsForTarget;
  const verifiedHeaders = verifyAndSmokeTest({ libKey, libOut, dlLdLibraryPath, cliBinaries: ["meson"] });
  const probeSet = new Set(["vulkan-headers", "spirv-headers", "cccl", "cutlass"]);
  const kind = libKey === "meson" ? "cli-tool" : probeSet.has(libKey) ? "header-abi-probe" : "runtime-library";
  emitSha512AndReceipt({ libKey, libOut, repo, tag, version, kind, verifiedHeaders });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const cmd = process.argv[2];
  if (cmd === "resolve") {
    await resolveVersionsPhase({
      tier: "tier5",
      releaseNotes:
        "Production max-version 5-OS shared libraries (Win64 .dll, Linux x64/ARM64 .so, macOS ARM64 .dylib, wasm32-wasi .wasm) compiled directly from upstream sources via holo-compiler (zig 0.14.0).",
      resolvedFileName: "resolved-tier5-versions.json",
      defaults: TIER5_DEFAULTS,
    });
  } else if (cmd === "build") {
    const libKey = process.env.LIB_KEY || "";
    const versions = JSON.parse(process.env.VERSIONS_JSON || "{}") as Record<string, LibraryPin>;
    const pin = versions[libKey] ?? TIER5_DEFAULTS[libKey];
    if (!pin) throw new Error(`Missing version pin for ${libKey}`);
    appendGithubOutput({ lib_out: pin.libOut });
    if (checkSkipMaterialized(libKey, pin.libOut, pin.version, process.env.RELEASE_TAG || "v11-max-5os-latest")) {
      process.exit(0);
    }
    appendGithubOutput({ skipped: "false" });
    buildTier5Library(libKey, pin);
  } else if (cmd === "finalize") {
    finalizeTierSumsPhase({
      tierTitle: "Holo 5-OS Tier-5 Shards",
      resolvedArtifactName: "resolved-tier5-versions",
      resolvedFileName: "resolved-tier5-versions.json",
      sumArtifactPrefix: "tier5-sums",
      outSumFileName: "SHA512SUMS-tier5.txt",
    });
  } else {
    throw new Error(`Unknown command: ${cmd ?? "(none)"}`);
  }
}
