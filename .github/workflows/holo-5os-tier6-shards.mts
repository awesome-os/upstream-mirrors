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
  type ShardKind,
  verifyAndSmokeTest,
} from "./holo-workflow-runtime.mts";

export const TIER6_DEFAULTS: Record<string, LibraryPin> = {
  protobuf: { pkg: "protobuf", libOut: "libprotobuf", repo: "protocolbuffers/protobuf", tag: "v36.2", version: "36.2" },
  icu4c: { pkg: "icu4c", libOut: "libicuuc", repo: "unicode-org/icu", tag: "release-79.1", version: "79.1" },
  vips: { pkg: "vips", libOut: "libvips", repo: "libvips/libvips", tag: "v8.18.7", version: "8.18.7" },
  openblas: { pkg: "openblas", libOut: "libopenblas", repo: "OpenMathLib/OpenBLAS", tag: "v0.3.34", version: "0.3.34" },
  onednn: { pkg: "onednn", libOut: "libonednn", repo: "oneapi-src/oneDNN", tag: "v3.15-pc", version: "3.15" },
  cmake: { pkg: "cmake", libOut: "cmake", repo: "Kitware/CMake", tag: "v4.5.1", version: "4.5.1" },
  nccl: { pkg: "nccl", libOut: "libnccl", repo: "NVIDIA/nccl", tag: "v2.32.7-1", version: "2.32.7.1" },
  rocm: { pkg: "rocm", libOut: "librocm", repo: "ROCm/ROCm", tag: "rocm-7.14.0", version: "7.14.0" },
  triton: { pkg: "triton", libOut: "libtriton", repo: "triton-lang/triton", tag: "v3.9.0", version: "3.9.0" },
  "flash-attention": { pkg: "flash-attention", libOut: "libflash_attention", repo: "Dao-AILab/flash-attention", tag: "v2.8.3.post2", version: "2.8.3" },
  "xdna-driver": { pkg: "xdna-driver", libOut: "libxdna_driver", repo: "amd/xdna-driver", tag: "2.21.75", version: "2.21.75" },
};

export const TIER6_LIBS = Object.keys(TIER6_DEFAULTS);

export const TIER6_KIND_MAP: Record<string, ShardKind> = {
  protobuf: "runtime-library",
  icu4c: "runtime-library",
  vips: "runtime-library",
  openblas: "runtime-library",
  onednn: "runtime-library",
  cmake: "cli-tool",
  nccl: "header-abi-probe",
  rocm: "header-abi-probe",
  triton: "header-abi-probe",
  "flash-attention": "header-abi-probe",
  "xdna-driver": "header-abi-probe",
};

function cpuCount(): string {
  try {
    return String(fs.readFileSync("/proc/cpuinfo", "utf8").match(/^processor\b/gm)?.length || 4);
  } catch {
    return "4";
  }
}

function findFirstMatch(root: string, predicate: (name: string) => boolean, maxDepth = 4): string | undefined {
  return findFiles(root, (_p, n) => predicate(n), maxDepth)[0];
}

function copyIfFound(srcPath: string | undefined, destPath: string): void {
  if (!srcPath) throw new Error(`Expected built artifact for ${destPath}`);
  fs.copyFileSync(srcPath, destPath);
}

function fetchTagTarball(repo: string, tag: string, dest = "src"): void {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const tgz = `/tmp/${repo.replaceAll("/", "_")}.tar.gz`;
  const url = `https://github.com/${repo}/archive/refs/tags/${encodeURIComponent(tag)}.tar.gz`;
  try {
    run("curl", ["-fsSL", url, "-o", tgz]);
    run("tar", ["-xzf", tgz, "-C", dest, "--strip-components=1"]);
  } catch {
    fs.rmSync(dest, { recursive: true, force: true });
    cloneTag(repo, tag, dest);
  }
}

function runCProbe(cCode: string, linkTargetPath: string, extraArgs: string[] = []): void {
  fs.writeFileSync("/tmp/tier6_smoke.c", cCode, "utf8");
  run("zig", ["cc", "-target", "x86_64-linux-gnu", "-O2", "/tmp/tier6_smoke.c", ...extraArgs, "-ldl", "-lpthread", "-o", "/tmp/tier6_smoke"]);
  run("/tmp/tier6_smoke", [linkTargetPath]);
}

function parseSemverTuple(ver: string): [number, number, number] {
  const m = ver.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

export function buildTier6Library(libKey: string, pin: LibraryPin): void {
  const { libOut, repo, tag, version } = pin;
  const kind = TIER6_KIND_MAP[libKey] ?? "runtime-library";
  console.log(`=== Building Tier-6 ${libKey} (${libOut}, kind=${kind}) @ ${repo} ${tag} (${version}) ===`);
  fs.mkdirSync("src", { recursive: true });
  fs.mkdirSync("dist", { recursive: true });
  const nproc = cpuCount();
  let smokeProbe: (() => void) | undefined;

  switch (libKey) {
    case "protobuf": {
      cloneTag(repo, tag, "/tmp/pb_src");
      const depsTxt = fs.readFileSync("/tmp/pb_src/cmake/dependencies.cmake", "utf8");
      const abslVer = depsTxt.match(/set\(abseil-cpp-version\s+"([^"]+)"\)/)?.[1] ?? "20250512.1";
      cloneTag("abseil/abseil-cpp", abslVer, "/tmp/absl_src");
      fs.mkdirSync("/tmp/pb_bundle", { recursive: true });
      fs.writeFileSync(
        "/tmp/pb_bundle/CMakeLists.txt",
        `cmake_minimum_required(VERSION 3.22)
project(pb_bundle C CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(ABSL_PROPAGATE_CXX_STD ON)
set(ABSL_BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
add_subdirectory(/tmp/absl_src abseil_build)
set(protobuf_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(protobuf_BUILD_CONFORMANCE OFF CACHE BOOL "" FORCE)
set(protobuf_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(protobuf_BUILD_PROTOC_BINARIES OFF CACHE BOOL "" FORCE)
set(protobuf_BUILD_LIBPROTOC OFF CACHE BOOL "" FORCE)
set(protobuf_BUILD_LIBUPB OFF CACHE BOOL "" FORCE)
set(protobuf_WITH_ZLIB OFF CACHE BOOL "" FORCE)
set(protobuf_INSTALL OFF CACHE BOOL "" FORCE)
set(protobuf_ABSL_PROVIDER package CACHE STRING "" FORCE)
set(protobuf_BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(CMAKE_CXX_VISIBILITY_PRESET default CACHE STRING "" FORCE)
set(CMAKE_VISIBILITY_INLINES_HIDDEN OFF CACHE BOOL "" FORCE)
add_compile_definitions(PROTOBUF_USE_DLLS LIBPROTOBUF_EXPORTS)
add_subdirectory(/tmp/pb_src pb_build)
if(TARGET libprotobuf)
  set_target_properties(libprotobuf PROPERTIES CXX_VISIBILITY_PRESET default VISIBILITY_INLINES_HIDDEN OFF)
endif()
`,
        "utf8"
      );
      const buildPb = (arch: string, sys: string, proc: string, zigT: string): string => {
        const w = `/tmp/pb_w_${arch}`;
        const b = `/tmp/pb_b_${arch}`;
        makeCmakeWrappers(w, zigT);
        const args = [
          "-S", "/tmp/pb_bundle", "-B", b, "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release",
          `-DCMAKE_SYSTEM_NAME=${sys}`, `-DCMAKE_SYSTEM_PROCESSOR=${proc}`,
          `-DCMAKE_C_COMPILER=${w}/cc`, `-DCMAKE_CXX_COMPILER=${w}/cxx`,
          `-DCMAKE_AR=${w}/ar`, `-DCMAKE_RANLIB=${w}/ranlib`,
        ];
        if (sys === "Windows") args.push(`-DCMAKE_RC_COMPILER=${w}/windres`);
        run("cmake", args);
        run("cmake", ["--build", b, "--target", "libprotobuf", `-j${nproc}`]);
        return b;
      };
      const linkPbShared = (buildRoot: string, zigT: string, outPath: string, extraLink: string[]): void => {
        const pbLib = findFirstMatch(`${buildRoot}/pb_build`, (n) => n === "libprotobuf.a", 2);
        if (!pbLib) throw new Error(`Missing libprotobuf.a in ${buildRoot}`);
        const utf8Libs = findFiles(`${buildRoot}/pb_build/third_party`, (_p, n) => n.endsWith(".a"), 3);
        const abslLibs = findFiles(`${buildRoot}/abseil_build`, (_p, n) => n.endsWith(".a"), 4);
        const det = detFlagsForTarget(zigT);
        run("zig", [
          "c++", "-target", zigT, ...det, "-O2", "-shared", "-s",
          "-Wl,--whole-archive", pbLib, "-Wl,--no-whole-archive",
          "-Wl,--start-group", ...utf8Libs, ...abslLibs, "-Wl,--end-group",
          ...extraLink, "-o", outPath,
        ]);
      };
      linkPbShared(buildPb("lin_x64", "Linux", "x86_64", "x86_64-linux-gnu"), "x86_64-linux-gnu", `dist/${libOut}-linux-x64.so`, ["-lpthread", "-lm"]);
      linkPbShared(buildPb("lin_arm64", "Linux", "aarch64", "aarch64-linux-gnu"), "aarch64-linux-gnu", `dist/${libOut}-linux-arm64.so`, ["-lpthread", "-lm"]);
      linkPbShared(
        buildPb("win64", "Windows", "AMD64", "x86_64-windows-gnu"),
        "x86_64-windows-gnu",
        `dist/${libOut}-win64.dll`,
        ["-Wl,--export-all-symbols", `-Wl,--out-implib,dist/${libOut}-win64.dll.a`, "-ldbghelp", "-ladvapi32"]
      );
      smokeProbe = () => {
        fs.writeFileSync(
          "/tmp/pb_smoke.cc",
          `#include <cassert>
#include <iostream>
#include <string>
#include "google/protobuf/arena.h"
int main() {
  google::protobuf::Arena arena;
  auto* s = google::protobuf::Arena::Create<std::string>(&arena, "holo-protobuf-ok");
  assert(s != nullptr && *s == "holo-protobuf-ok");
  assert(arena.SpaceAllocated() > 0);
  std::cout << "protobuf Arena smoke OK: " << *s << " (bytes=" << arena.SpaceAllocated() << ")\\n";
  return 0;
}
`,
          "utf8"
        );
        run("zig", [
          "c++", "-target", "x86_64-linux-gnu", "-O2", "-std=c++17",
          "-I/tmp/pb_src/src", "-I/tmp/absl_src",
          "/tmp/pb_smoke.cc", `dist/${libOut}-linux-x64.so`, "-Wl,-rpath,$ORIGIN", "-lpthread",
          "-o", "/tmp/pb_smoke",
        ]);
        run("/tmp/pb_smoke", [], { env: { ...process.env, LD_LIBRARY_PATH: path.resolve("dist") } });
      };
      break;
    }

    case "icu4c": {
      fetchTagTarball(repo, tag);
      const srcListRaw = fs.readFileSync("src/icu4c/source/common/sources.txt", "utf8");
      const commonNames = srcListRaw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.endsWith(".cpp"));
      const srcs = [...commonNames.map((f) => `src/icu4c/source/common/${f}`), "src/icu4c/source/stubdata/stubdata.cpp"];
      const uverText = fs.readFileSync("src/icu4c/source/common/unicode/uvernum.h", "utf8");
      const majMatch = uverText.match(/#define\s+U_ICU_VERSION_MAJOR_NUM\s+(\d+)/);
      const icuMaj = majMatch?.[1] ?? version.split(".")[0] ?? "79";
      fs.mkdirSync("/tmp/icu_mac_inc", { recursive: true });
      fs.writeFileSync("/tmp/icu_mac_inc/tzfile.h", '#define TZDIR "/var/db/timezone/zoneinfo"\n#define TZDEFAULT "/etc/localtime"\n', "utf8");
      compileMultiOs(libOut, {
        cxx: true,
        winExportAll: true,
        commonArgs: [
          "-std=c++17",
          "-DU_COMMON_IMPLEMENTATION",
          "-DU_ENABLE_DYLOAD=0",
          "-DU_HAVE_ELF_H=0",
          "-DU_ATTRIBUTE_DEPRECATED=",
          "-Isrc/icu4c/source/common",
          "-Isrc/icu4c/source/i18n",
          ...srcs,
        ],
        winArgs: ["-ladvapi32"],
        linuxArgs: ["-lpthread", "-lm"],
        macArgs: ["-I/tmp/icu_mac_inc", "-lpthread", "-lm"],
      });
      smokeProbe = () => {
        runCProbe(
          `#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
int main(int argc, char **argv) {
  void *h = dlopen(argv[1], RTLD_NOW);
  if (!h) { fprintf(stderr, "%s\\n", dlerror()); return 1; }
  typedef void (*fn_c2u)(const char *, uint16_t *, int32_t);
  typedef void (*fn_u2c)(const uint16_t *, char *, int32_t);
  fn_c2u c2u = (fn_c2u)dlsym(h, "u_charsToUChars_${icuMaj}");
  fn_u2c u2c = (fn_u2c)dlsym(h, "u_UCharsToChars_${icuMaj}");
  if (!c2u || !u2c) { fprintf(stderr, "missing u_charsToUChars_${icuMaj}\\n"); return 2; }
  uint16_t ubuf[32] = {0};
  char out[32] = {0};
  const char *in = "Holo-ICU-${icuMaj}";
  c2u(in, ubuf, (int32_t)strlen(in) + 1);
  u2c(ubuf, out, (int32_t)strlen(in) + 1);
  if (strcmp(in, out) != 0) { fprintf(stderr, "mismatch: %s\\n", out); return 3; }
  printf("icu4c roundtrip OK: %s\\n", out);
  dlclose(h);
  return 0;
}
`,
          `dist/${libOut}-linux-x64.so`
        );
      };
      break;
    }

    case "vips": {
      fetchTagTarball(repo, tag);
      run("sudo", ["apt-get", "update", "-qq"]);
      run("sudo", ["apt-get", "install", "-y", "-qq", "meson", "ninja-build", "pkg-config", "libglib2.0-dev", "libexpat1-dev"]);
      const w = "/tmp/vips_wrap";
      makeCmakeWrappers(w, "x86_64-linux-gnu");
      fs.mkdirSync("/tmp/vips_expat_inc", { recursive: true });
      for (const h of ["expat.h", "expat_external.h"]) {
        if (fs.existsSync(`/usr/include/${h}`)) fs.copyFileSync(`/usr/include/${h}`, `/tmp/vips_expat_inc/${h}`);
      }
      const detVips = detFlagsForTarget("x86_64-linux-gnu").join(" ");
      for (const [fn, tool] of [["cc", "cc"], ["cxx", "c++"]] as const) {
        fs.writeFileSync(
          `${w}/${fn}`,
          `#!/usr/bin/env bash\nexec zig ${tool} -target x86_64-linux-gnu ${detVips} -I/tmp/vips_expat_inc -L/usr/lib/x86_64-linux-gnu "$@"\n`,
          "utf8"
        );
        fs.chmodSync(`${w}/${fn}`, 0o755);
      }
      const bdir = "/tmp/vips_build";
      fs.rmSync(bdir, { recursive: true, force: true });
      run(
        "meson",
        [
          "setup", bdir, "src",
          "-Dbuildtype=release",
          "-Ddefault_library=shared",
          "-Ddeprecated=false",
          "-Dexamples=false",
          "-Dmodules=disabled",
          "-Dintrospection=disabled",
          "-Dcplusplus=false",
          "-Dauto_features=disabled",
        ],
        { env: { ...process.env, CC: `${w}/cc`, CXX: `${w}/cxx` } }
      );
      run("meson", ["compile", "-C", bdir, `-j${nproc}`, "libvips/vips:shared_library"]);
      copyIfFound(findFirstMatch(`${bdir}/libvips`, (n) => n.startsWith("libvips.so") && !n.endsWith(".p"), 2), `dist/${libOut}-linux-x64.so`);
      smokeProbe = () => {
        runCProbe(
          `#include <dlfcn.h>
#include <stdio.h>
int main(int argc, char **argv) {
  void *h = dlopen(argv[1], RTLD_NOW);
  if (!h) { fprintf(stderr, "%s\\n", dlerror()); return 1; }
  int (*vips_init_fn)(const char *) = (int (*)(const char *))dlsym(h, "vips_init");
  int (*vips_ver_fn)(int) = (int (*)(int))dlsym(h, "vips_version");
  void (*vips_shut_fn)(void) = (void (*)(void))dlsym(h, "vips_shutdown");
  if (!vips_init_fn || !vips_ver_fn) { fprintf(stderr, "missing vips symbols\\n"); return 2; }
  if (vips_init_fn("holo-probe") != 0) { fprintf(stderr, "vips_init failed\\n"); return 3; }
  int maj = vips_ver_fn(0), min = vips_ver_fn(1), mic = vips_ver_fn(2);
  printf("vips_version OK: %d.%d.%d\\n", maj, min, mic);
  if (vips_shut_fn) vips_shut_fn();
  dlclose(h);
  return maj >= 8 ? 0 : 4;
}
`,
          `dist/${libOut}-linux-x64.so`
        );
      };
      break;
    }

    case "openblas": {
      fetchTagTarball(repo, tag);
      const buildBlas = (arch: string, sys: string, proc: string, zigT: string, blasTarget: string, shLd: string, extra: string[] = []): string => {
        const w = `/tmp/blas_w_${arch}`;
        const b = `/tmp/blas_b_${arch}`;
        makeCmakeWrappers(w, zigT);
        const args = [
          "-S", "src", "-B", b, "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release",
          `-DCMAKE_SYSTEM_NAME=${sys}`, `-DCMAKE_SYSTEM_PROCESSOR=${proc}`,
          `-DCMAKE_C_COMPILER=${w}/cc`, `-DCMAKE_AR=${w}/ar`, `-DCMAKE_RANLIB=${w}/ranlib`,
          `-DCMAKE_SHARED_LINKER_FLAGS=${shLd}`,
          "-DBUILD_SHARED_LIBS=ON", "-DBUILD_STATIC_LIBS=OFF",
          "-DBUILD_WITHOUT_LAPACK=ON", "-DBUILD_TESTING=OFF",
          "-DNOFORTRAN=1", "-DUSE_THREAD=0", `-DTARGET=${blasTarget}`,
          "-DHOSTCC=gcc", "-DC_LAPACK=ON",
          ...extra,
        ];
        if (sys === "Windows") args.push("-DCMAKE_WINDOWS_EXPORT_ALL_SYMBOLS=ON", `-DCMAKE_RC_COMPILER=${w}/windres`);
        run("cmake", args);
        run("cmake", ["--build", b, `-j${nproc}`]);
        return b;
      };
      copyIfFound(findFirstMatch(buildBlas("lin_x64", "Linux", "x86_64", "x86_64-linux-gnu", "CORE2", "-lm -s"), (n) => n.startsWith("libopenblas.so"), 3), `dist/${libOut}-linux-x64.so`);
      copyIfFound(findFirstMatch(buildBlas("lin_arm64", "Linux", "aarch64", "aarch64-linux-gnu", "ARMV8", "-lm -s"), (n) => n.startsWith("libopenblas.so"), 3), `dist/${libOut}-linux-arm64.so`);
      const bWin = buildBlas("win64", "Windows", "AMD64", "x86_64-windows-gnu", "CORE2", "-Wl,--export-all-symbols -s");
      copyIfFound(findFirstMatch(bWin, (n) => n.includes("openblas") && n.endsWith(".dll"), 3), `dist/${libOut}-win64.dll`);
      const imp = findFirstMatch(bWin, (n) => n.includes("openblas") && n.endsWith(".dll.a"), 3);
      if (imp) fs.copyFileSync(imp, `dist/${libOut}-win64.dll.a`);
      smokeProbe = () => {
        runCProbe(
          `#include <dlfcn.h>
#include <math.h>
#include <stdio.h>
int main(int argc, char **argv) {
  void *h = dlopen(argv[1], RTLD_NOW);
  if (!h) { fprintf(stderr, "%s\\n", dlerror()); return 1; }
  typedef void (*fn_dgemm)(int, int, int, int, int, int, double, const double*, int, const double*, int, double, double*, int);
  fn_dgemm dgemm = (fn_dgemm)dlsym(h, "cblas_dgemm");
  if (!dgemm) { fprintf(stderr, "missing cblas_dgemm\\n"); return 2; }
  double A[4] = {1, 2, 3, 4}, B[4] = {5, 6, 7, 8}, C[4] = {0, 0, 0, 0};
  dgemm(101, 111, 111, 2, 2, 2, 1.0, A, 2, B, 2, 0.0, C, 2);
  if (fabs(C[0]-19.0)>1e-9 || fabs(C[1]-22.0)>1e-9 || fabs(C[2]-43.0)>1e-9 || fabs(C[3]-50.0)>1e-9) {
    fprintf(stderr, "bad dgemm: %f %f %f %f\\n", C[0], C[1], C[2], C[3]);
    return 3;
  }
  printf("cblas_dgemm OK: [[%.0f, %.0f], [%.0f, %.0f]]\\n", C[0], C[1], C[2], C[3]);
  dlclose(h);
  return 0;
}
`,
          `dist/${libOut}-linux-x64.so`,
          ["-lm"]
        );
      };
      break;
    }

    case "onednn": {
      fetchTagTarball(repo, tag);
      const buildDnn = (arch: string, sys: string, proc: string, zigT: string, shLd: string): string => {
        const w = `/tmp/dnn_w_${arch}`;
        const b = `/tmp/dnn_b_${arch}`;
        makeCmakeWrappers(w, zigT);
        if (sys === "Windows") {
          const det = detFlagsForTarget(zigT).join(" ");
          fs.writeFileSync(
            `${w}/cxx`,
            `#!/usr/bin/env bash
args=()
skip_next=0
for a in "$@"; do
  if [ "$skip_next" -eq 1 ]; then
    skip_next=0
    case "$a" in /NXCOMPAT|/LTCG|/INCREMENTAL:*|/OPT:*|/DYNAMICBASE) continue ;; esac
    args+=("-Xlinker" "$a")
    continue
  fi
  if [ "$a" = "-Xlinker" ]; then skip_next=1; continue; fi
  case "$a" in /NXCOMPAT|/LTCG|/INCREMENTAL:*) continue ;; esac
  args+=("$a")
done
exec zig c++ -target ${zigT} ${det} "\${args[@]}"
`,
            "utf8"
          );
          fs.chmodSync(`${w}/cxx`, 0o755);
        }
        const args = [
          "-S", "src", "-B", b, "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release",
          `-DCMAKE_SYSTEM_NAME=${sys}`, `-DCMAKE_SYSTEM_PROCESSOR=${proc}`,
          `-DCMAKE_C_COMPILER=${w}/cc`, `-DCMAKE_CXX_COMPILER=${w}/cxx`,
          `-DCMAKE_AR=${w}/ar`, `-DCMAKE_RANLIB=${w}/ranlib`,
          `-DCMAKE_SHARED_LINKER_FLAGS=${shLd}`,
          "-DDNNL_LIBRARY_TYPE=SHARED",
          "-DDNNL_CPU_RUNTIME=SEQ",
          "-DDNNL_GPU_RUNTIME=NONE",
          "-DDNNL_BUILD_GRAPH=OFF",
          "-DDNNL_ENABLE_WORKLOAD=INFERENCE",
          "-DDNNL_AARCH64_USE_KAI=OFF",
          ...(proc === "x86_64" || proc === "AMD64" ? ["-DDNNL_ENABLE_PRIMITIVE_CPU_ISA=AVX2"] : []),
          "-DDNNL_BUILD_TESTS=OFF",
          "-DDNNL_BUILD_EXAMPLES=OFF",
          "-DDNNL_ENABLE_JIT_PROFILING=OFF",
          "-DDNNL_ENABLE_ITT_TASKS=OFF",
        ];
        if (sys === "Windows") args.push(`-DCMAKE_RC_COMPILER=${w}/windres`);
        run("cmake", args);
        run("cmake", ["--build", b, "--target", "dnnl", `-j${nproc}`]);
        return b;
      };
      copyIfFound(findFirstMatch(buildDnn("lin_x64", "Linux", "x86_64", "x86_64-linux-gnu", "-lpthread -lm -Wl,-z,nodelete -s"), (n) => n.startsWith("libdnnl.so"), 3), `dist/${libOut}-linux-x64.so`);
      copyIfFound(findFirstMatch(buildDnn("lin_arm64", "Linux", "aarch64", "aarch64-linux-gnu", "-lpthread -lm -Wl,-z,nodelete -s"), (n) => n.startsWith("libdnnl.so"), 3), `dist/${libOut}-linux-arm64.so`);
      const bWin = buildDnn("win64", "Windows", "AMD64", "x86_64-windows-gnu", "-s");
      copyIfFound(findFirstMatch(bWin, (n) => n.includes("dnnl") && n.endsWith(".dll"), 3), `dist/${libOut}-win64.dll`);
      const imp = findFirstMatch(bWin, (n) => n.includes("dnnl") && n.endsWith(".dll.a"), 3);
      if (imp) fs.copyFileSync(imp, `dist/${libOut}-win64.dll.a`);
      smokeProbe = () => {
        runCProbe(
          `#include <dlfcn.h>
#include <stdio.h>
typedef struct { int major, minor, patch; const char *hash, *cpu_runtime, *gpu_runtime; } dnnl_ver_t;
int main(int argc, char **argv) {
  void *h = dlopen(argv[1], RTLD_NOW);
  if (!h) { fprintf(stderr, "%s\\n", dlerror()); return 1; }
  const dnnl_ver_t* (*ver_fn)(void) = (const dnnl_ver_t* (*)(void))dlsym(h, "dnnl_version");
  int (*eng_create)(void **, int, unsigned long) = (int (*)(void **, int, unsigned long))dlsym(h, "dnnl_engine_create");
  int (*eng_destroy)(void *) = (int (*)(void *))dlsym(h, "dnnl_engine_destroy");
  if (!ver_fn || !eng_create || !eng_destroy) { fprintf(stderr, "missing dnnl symbols\\n"); return 2; }
  const dnnl_ver_t *v = ver_fn();
  void *eng = NULL;
  if (eng_create(&eng, 1, 0) != 0 || !eng) { fprintf(stderr, "dnnl_engine_create failed\\n"); return 3; }
  printf("oneDNN engine OK: v%d.%d.%d (%s)\\n", v->major, v->minor, v->patch, v->cpu_runtime);
  eng_destroy(eng);
  dlclose(h);
  return 0;
}
`,
          `dist/${libOut}-linux-x64.so`
        );
      };
      break;
    }

    case "cmake": {
      fetchTagTarball(repo, tag);
      const buildCmake = (arch: string, sys: string, proc: string, zigT: string, ldFlags: string, extra: string[] = []): string => {
        const w = `/tmp/cm_w_${arch}`;
        const b = `/tmp/cm_b_${arch}`;
        makeCmakeWrappers(w, zigT);
        const det = detFlagsForTarget(zigT).join(" ");
        for (const [fn, tool] of [["cc", "cc"], ["cxx", "c++"]] as const) {
          fs.writeFileSync(
            `${w}/${fn}`,
            `#!/usr/bin/env bash
args=()
for a in "$@"; do
  case "$a" in -I/usr/include|-isystem/usr/include) continue ;; esac
  args+=("$a")
done
exec zig ${tool} -target ${zigT} ${det} "\${args[@]}"
`,
            "utf8"
          );
          fs.chmodSync(`${w}/${fn}`, 0o755);
        }
        const args = [
          "-S", "src", "-B", b, "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release",
          `-DCMAKE_SYSTEM_NAME=${sys}`, `-DCMAKE_SYSTEM_PROCESSOR=${proc}`,
          `-DCMAKE_C_COMPILER=${w}/cc`, `-DCMAKE_CXX_COMPILER=${w}/cxx`,
          `-DCMAKE_AR=${w}/ar`, `-DCMAKE_RANLIB=${w}/ranlib`,
          `-DCMAKE_EXE_LINKER_FLAGS=${ldFlags}`,
          "-DCMAKE_DISABLE_FIND_PACKAGE_Iconv=TRUE",
          "-DBUILD_CursesDialog=OFF", "-DBUILD_QtDialog=OFF", "-DBUILD_TESTING=OFF",
          "-DCMake_BUILD_LTO=OFF", "-DCMAKE_USE_OPENSSL=OFF", "-DCMake_ENABLE_DEBUGGER=OFF",
          ...extra,
        ];
        if (sys === "Windows") args.push(`-DCMAKE_RC_COMPILER=${w}/windres`);
        run("cmake", args);
        run("cmake", ["--build", b, "--target", "cmake", `-j${nproc}`]);
        return `${b}/bin`;
      };
      copyIfFound(findFirstMatch(buildCmake("lin_x64", "Linux", "x86_64", "x86_64-linux-gnu", "-s"), (n) => n === "cmake", 1), `dist/${libOut}-linux-x64`);
      copyIfFound(
        findFirstMatch(
          buildCmake("lin_arm64", "Linux", "aarch64", "aarch64-linux-gnu", "-s", [
            "-DHAVE_POLL_FINE_EXITCODE=0",
            "-DHAVE_POLL_FINE_EXITCODE__TRYRUN_OUTPUT=",
            "-DKWSYS_LFS_WORKS=1",
            "-DKWSYS_LFS_WORKS__TRYRUN_OUTPUT=",
          ]),
          (n) => n === "cmake",
          1
        ),
        `dist/${libOut}-linux-arm64`
      );
      copyIfFound(findFirstMatch(buildCmake("win64", "Windows", "AMD64", "x86_64-windows-gnu", "-s"), (n) => n === "cmake.exe", 1), `dist/${libOut}-win64.exe`);
      break;
    }

    case "nccl": {
      fetchTagTarball(repo, tag);
      const mk = fs.readFileSync("src/makefiles/version.mk", "utf8");
      const maj = mk.match(/NCCL_MAJOR\s*:=\s*(\d+)/)?.[1] ?? "2";
      const min = mk.match(/NCCL_MINOR\s*:=\s*(\d+)/)?.[1] ?? "32";
      const pat = mk.match(/NCCL_PATCH\s*:=\s*(\d+)/)?.[1] ?? "7";
      const suffix = mk.match(/NCCL_SUFFIX\s*:=\s*(\S*)/)?.[1] ?? "";
      const verCode = Number(maj) <= 2 && Number(min) <= 8
        ? Number(maj) * 1000 + Number(min) * 100 + Number(pat)
        : Number(maj) * 10000 + Number(min) * 100 + Number(pat);
      fs.mkdirSync("/tmp/nccl_inc", { recursive: true });
      const tpl = fs.readFileSync("src/src/nccl.h.in", "utf8")
        .replaceAll("${nccl:Major}", maj)
        .replaceAll("${nccl:Minor}", min)
        .replaceAll("${nccl:Patch}", pat)
        .replaceAll("${nccl:Suffix}", suffix)
        .replaceAll("${nccl:Version}", String(verCode));
      fs.writeFileSync("/tmp/nccl_inc/nccl.h", tpl, "utf8");
      fs.writeFileSync("/tmp/nccl_inc/cuda_runtime.h", "#ifndef _CUDA_RUNTIME_STUB\n#define _CUDA_RUNTIME_STUB\n#define CUDART_VERSION 12000\ntypedef void* cudaStream_t;\ntypedef void* cudaEvent_t;\n#endif\n", "utf8");
      fs.writeFileSync("/tmp/nccl_inc/cuda_fp16.h", "", "utf8");
      fs.writeFileSync("/tmp/nccl_inc/cuda_bf16.h", "", "utf8");
      fs.writeFileSync(
        "/tmp/nccl_probe.c",
        `#include <stddef.h>
#include <stdint.h>
#include "nccl.h"
#ifdef _WIN32
#define B8G_EXP __declspec(dllexport)
#else
#define B8G_EXP __attribute__((visibility("default")))
#endif
B8G_EXP uint32_t b8g_nccl_abi_magic(void) { return 0x33564742u; }
B8G_EXP uint32_t b8g_nccl_version(void) { return NCCL_VERSION_CODE; }
B8G_EXP uint32_t b8g_nccl_unique_id_bytes(void) { return (uint32_t)sizeof(ncclUniqueId); }
ncclResult_t ncclGetVersion(int *version) { if (!version) return ncclInvalidArgument; *version = NCCL_VERSION_CODE; return ncclSuccess; }
`,
        "utf8"
      );
      compileMultiOs(libOut, { includeWasi: true, commonArgs: ["-std=c11", "-I/tmp/nccl_inc", "/tmp/nccl_probe.c"] });
      break;
    }

    case "rocm": {
      fetchTagTarball(repo, tag);
      const xml = fs.existsSync("src/default.xml") ? fs.readFileSync("src/default.xml", "utf8") : "";
      const projectCount = (xml.match(/<project\b/g) ?? []).length;
      const [maj, min, pat] = parseSemverTuple(version);
      fs.writeFileSync(
        "/tmp/rocm_probe.c",
        `#include <stdint.h>
#ifdef _WIN32
#define B8G_EXP __declspec(dllexport)
#else
#define B8G_EXP __attribute__((visibility("default")))
#endif
B8G_EXP uint32_t b8g_rocm_abi_magic(void) { return 0x33564742u; }
B8G_EXP uint32_t b8g_rocm_version(void) { return (${maj}u << 16) | (${min}u << 8) | ${pat}u; }
B8G_EXP uint32_t b8g_rocm_project_count(void) { return ${projectCount}u; }
B8G_EXP const char* b8g_rocm_tag(void) { return "${tag}"; }
`,
        "utf8"
      );
      compileMultiOs(libOut, { includeWasi: true, commonArgs: ["-std=c11", "/tmp/rocm_probe.c"] });
      break;
    }

    case "triton": {
      fetchTagTarball(repo, tag);
      const hasStrUtil = fs.existsSync("src/include/triton/Tools/StrUtil.h") ? 1 : 0;
      const [maj, min, pat] = parseSemverTuple(version);
      fs.writeFileSync(
        "/tmp/triton_probe.c",
        `#include <stdint.h>
#ifdef _WIN32
#define B8G_EXP __declspec(dllexport)
#else
#define B8G_EXP __attribute__((visibility("default")))
#endif
B8G_EXP uint32_t b8g_triton_abi_magic(void) { return 0x33564742u; }
B8G_EXP uint32_t b8g_triton_version(void) { return (${maj}u << 16) | (${min}u << 8) | ${pat}u; }
B8G_EXP uint32_t b8g_triton_headers_present(void) { return ${hasStrUtil}u; }
B8G_EXP const char* b8g_triton_tag(void) { return "${tag}"; }
`,
        "utf8"
      );
      compileMultiOs(libOut, { includeWasi: true, commonArgs: ["-std=c11", "/tmp/triton_probe.c"] });
      break;
    }

    case "flash-attention": {
      fetchTagTarball(repo, tag);
      const initPy = fs.existsSync("src/flash_attn/__init__.py") ? fs.readFileSync("src/flash_attn/__init__.py", "utf8") : "";
      const parsedVer = initPy.match(/__version__\s*=\s*["']([^"']+)["']/)?.[1] ?? version;
      const hasFlashH = fs.existsSync("src/csrc/flash_attn/src/flash.h") ? 1 : 0;
      const [maj, min, pat] = parseSemverTuple(parsedVer);
      fs.writeFileSync(
        "/tmp/flash_probe.c",
        `#include <stdint.h>
#ifdef _WIN32
#define B8G_EXP __declspec(dllexport)
#else
#define B8G_EXP __attribute__((visibility("default")))
#endif
B8G_EXP uint32_t b8g_flash_attention_abi_magic(void) { return 0x33564742u; }
B8G_EXP uint32_t b8g_flash_attention_version(void) { return (${maj}u << 16) | (${min}u << 8) | ${pat}u; }
B8G_EXP uint32_t b8g_flash_attention_headers_present(void) { return ${hasFlashH}u; }
B8G_EXP const char* b8g_flash_attention_version_str(void) { return "${parsedVer}"; }
`,
        "utf8"
      );
      compileMultiOs(libOut, { includeWasi: true, commonArgs: ["-std=c11", "/tmp/flash_probe.c"] });
      break;
    }

    case "xdna-driver": {
      fetchTagTarball(repo, tag);
      const uapi = fs.readFileSync("src/src/include/uapi/drm_local/amdxdna_accel.h", "utf8");
      const drvMaj = uapi.match(/#define\s+AMDXDNA_DRIVER_MAJOR\s+(\d+)/)?.[1] ?? "1";
      const drvMin = uapi.match(/#define\s+AMDXDNA_DRIVER_MINOR\s+(\d+)/)?.[1] ?? "0";
      const [maj, min, pat] = parseSemverTuple(version);
      fs.mkdirSync("/tmp/xdna_inc/libdrm", { recursive: true });
      fs.mkdirSync("/tmp/xdna_inc/linux", { recursive: true });
      fs.writeFileSync(
        "/tmp/xdna_inc/libdrm/drm.h",
        `#ifndef _DRM_STUB_H
#define _DRM_STUB_H
#include <stdint.h>
typedef int8_t __s8;
typedef uint8_t __u8;
typedef uint16_t __u16;
typedef uint32_t __u32;
typedef uint64_t __u64;
typedef int32_t __s32;
typedef int64_t __s64;
#define DRM_COMMAND_BASE 0x40
#define DRM_IOWR(nr, type) ((uint32_t)(nr))
#define DRM_IOW(nr, type) ((uint32_t)(nr))
#define DRM_IOR(nr, type) ((uint32_t)(nr))
#define DRM_IO(nr) ((uint32_t)(nr))
#endif
`,
        "utf8"
      );
      fs.writeFileSync("/tmp/xdna_inc/linux/const.h", "", "utf8");
      fs.writeFileSync("/tmp/xdna_inc/linux/stddef.h", "#include <stddef.h>\n", "utf8");
      fs.writeFileSync(
        "/tmp/xdna_probe.c",
        `#include <stdint.h>
#include "drm_local/amdxdna_accel.h"
#ifdef _WIN32
#define B8G_EXP __declspec(dllexport)
#else
#define B8G_EXP __attribute__((visibility("default")))
#endif
B8G_EXP uint32_t b8g_xdna_abi_magic(void) { return 0x33564742u; }
B8G_EXP uint32_t b8g_xdna_version(void) { return (${maj}u << 16) | (${min}u << 8) | ${pat}u; }
B8G_EXP uint32_t b8g_xdna_driver_major(void) { return ${drvMaj}u; }
B8G_EXP uint32_t b8g_xdna_driver_minor(void) { return ${drvMin}u; }
B8G_EXP uint32_t b8g_xdna_ioctl_exec_cmd(void) { return DRM_AMDXDNA_EXEC_CMD; }
`,
        "utf8"
      );
      compileMultiOs(libOut, { includeWasi: true, commonArgs: ["-std=c11", "-I/tmp/xdna_inc", "-Isrc/src/include/uapi", "/tmp/xdna_probe.c"] });
      break;
    }

    default:
      throw new Error(`Unknown Tier-6 libKey: ${libKey}`);
  }

  void detFlagsForTarget;
  const verifiedHeaders = verifyAndSmokeTest({ libKey, libOut, cliBinaries: ["cmake"], smokeProbe });
  emitSha512AndReceipt({ libKey, libOut, repo, tag, version, kind, verifiedHeaders });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const cmd = process.argv[2];
  if (cmd === "resolve") {
    await resolveVersionsPhase({
      tier: "tier6",
      releaseNotes:
        "Production max-version 5-OS shared libraries, CLI tools, and GPU/NPU ABI probes compiled via holo-compiler (zig 0.14.0).",
      resolvedFileName: "resolved-tier6-versions.json",
      defaults: TIER6_DEFAULTS,
    });
  } else if (cmd === "build") {
    const libKey = process.env.LIB_KEY || "";
    const versions = JSON.parse(process.env.VERSIONS_JSON || "{}") as Record<string, LibraryPin>;
    const pin = versions[libKey] ?? TIER6_DEFAULTS[libKey];
    if (!pin) throw new Error(`Missing version pin for ${libKey}`);
    appendGithubOutput({ lib_out: pin.libOut });
    if (checkSkipMaterialized(libKey, pin.libOut, pin.version, process.env.RELEASE_TAG || "v11-max-5os-latest")) {
      process.exit(0);
    }
    appendGithubOutput({ skipped: "false" });
    buildTier6Library(libKey, pin);
  } else if (cmd === "finalize") {
    finalizeTierSumsPhase({
      tierTitle: "Holo 5-OS Tier-6 Shards",
      resolvedArtifactName: "resolved-tier6-versions",
      resolvedFileName: "resolved-tier6-versions.json",
      sumArtifactPrefix: "tier6-sums",
      outSumFileName: "SHA512SUMS-tier6.txt",
    });
  } else {
    throw new Error(`Unknown command: ${cmd ?? "(none)"}`);
  }
}
