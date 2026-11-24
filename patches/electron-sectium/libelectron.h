/**
 * @file patches/electron-sectium/libelectron.h
 * @description Canonical C11 ABI for `libelectron` (`libelectron.dll` / `libelectron.so` / `libelectron.dylib`).
 *
 * Allows tiny (~118 KB) per-appliance native launchers (`code-oss.exe`, `sectium-browser.exe`, `theia.exe`)
 * to dynamically load ONE shared Electron/Chromium/V8 library from `~/.b8g/cas/`, giving:
 *   - 0 B duplicated Electron across apps on disk
 *   - Shared read-only `.text` memory pages across running appliances in the OS kernel
 *   - True per-app identity (exact name + icon) in Windows Task Manager, macOS Dock, and Linux `ps`
 */

#ifndef AWESOME_OS_LIBELECTRON_H
#define AWESOME_OS_LIBELECTRON_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define LIBELECTRON_ABI_MAGIC   0x33564742u /* B8G_ABI_MAGIC_V3 ("B8GV3") */
#define LIBELECTRON_ABI_VERSION 1u

#if defined(_WIN32)
  #if defined(LIBELECTRON_BUILD_DLL)
    #define LIBELECTRON_API __declspec(dllexport)
  #else
    #define LIBELECTRON_API __declspec(dllimport)
  #endif
#else
  #define LIBELECTRON_API __attribute__((visibility("default")))
#endif

typedef struct libelectron_host_config {
  uint32_t abi_magic;         /* Must be LIBELECTRON_ABI_MAGIC */
  uint32_t abi_version;       /* Must be LIBELECTRON_ABI_VERSION */
  const char *app_name;       /* e.g. "Awesome-OS Code - OSS" or "Sectium Browser" */
  const char *resources_dir;  /* Path to appliance resources/ directory */
  const char *ghost_abi_path; /* Optional path to b8g-ghost-abi.<ext> for B8G_ARENA_V1 */
} libelectron_host_config_t;

/**
 * Returns LIBELECTRON_ABI_VERSION.
 */
LIBELECTRON_API uint32_t libelectron_abi_version(void);

/**
 * Main entrypoint replacing Electron's monolithic executable `wWinMain` / `main`.
 * On Win32, `hinstance` is the host `.exe`'s HINSTANCE; on POSIX pass NULL.
 */
LIBELECTRON_API int libelectron_main(
    void *hinstance,
    int argc,
    char **argv,
    const libelectron_host_config_t *config);

typedef int (*libelectron_main_fn)(
    void *hinstance,
    int argc,
    char **argv,
    const libelectron_host_config_t *config);

#ifdef __cplusplus
}
#endif

#endif /* AWESOME_OS_LIBELECTRON_H */
