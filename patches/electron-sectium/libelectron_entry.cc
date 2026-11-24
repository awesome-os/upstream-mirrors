/**
 * @file patches/electron-sectium/libelectron_entry.cc
 * @description Shared-library entrypoint wrapper turning Electron's `content::ContentMain`
 * into a single exported C-ABI symbol `libelectron_main(...)`.
 */

#include "shell/app/libelectron.h"
#include "content/public/app/content_main.h"
#include "shell/app/electron_main_delegate.h"

#if defined(_WIN32)
#include <windows.h>
#include "sandbox/win/src/sandbox_types.h"
#include "content/public/app/sandbox_helper_win.h"
#endif

extern "C" {

LIBELECTRON_API uint32_t libelectron_abi_version(void) {
  return LIBELECTRON_ABI_VERSION;
}

LIBELECTRON_API int libelectron_main(
    void *hinstance,
    int argc,
    char **argv,
    const libelectron_host_config_t *config) {
  if (config && config->abi_magic != LIBELECTRON_ABI_MAGIC) {
    return -1;
  }

  electron::ElectronMainDelegate delegate;
  content::ContentMainParams params(&delegate);

#if defined(_WIN32)
  sandbox::SandboxInterfaceInfo sandbox_info = {nullptr};
  content::InitializeSandboxInfo(&sandbox_info);
  params.instance = hinstance ? static_cast<HINSTANCE>(hinstance) : GetModuleHandleW(nullptr);
  params.sandbox_info = &sandbox_info;
  (void)argc;
  (void)argv;
#else
  (void)hinstance;
  params.argc = argc;
  params.argv = const_cast<const char **>(argv);
#endif

  return content::ContentMain(std::move(params));
}

} /* extern "C" */
