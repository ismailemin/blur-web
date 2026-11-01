# T-005a — Engine/WASM feasibility (initial audit)

> **Superseded:** the measured wasm32 probe is in
> [`engine-wasm-probe.md`](engine-wasm-probe.md). This file is the initial
> read-only source audit and is retained for history.

**Date:** 2 November 2026
**Status:** started (read-only source audit; no engine build attempted yet)

## Goal

Identify the smallest Amax/engine subset that can be compiled to wasm32 without
Windows/DX11, measure its dependency closure, and define the first port boundary.
This is not a full engine port.

## Confirmed blockers in the pinned source

- `upstream/BlurRebuilt/cmake/blur_common.cmake:12` hard-fails for non-MSVC:
  `MSVC only (the source is Win32/D3D9 MSVC code)`.
- `cmake/targets.cmake` declares `add_executable(Amax WIN32 ...)`.
- `cmake/dx11.cmake` links `d3d11 dxgi d3dcompiler blur_fx11`, compiles 1,254
  FX11 effects and 693 DX11 shaders, and includes D3D11 display/context/device/
  texture/window sources.
- `cmake/demonware.cmake` defines `WIN32`, libcurl/OpenSSL, and WinSock-era
  networking for eight DemonWare libraries.
- Engine platform layer depends on Windows file system, window/message loop,
  threads/job queue, input, audio (DirectSound) and save paths.
- `upstream/BlurRebuilt/code/mercury/library/graphics/display/...` and
  `display2/...` expose `Display`/`Display2` interfaces but the PC backend is
  D3D11; there is no WebGPU backend.

## Candidate first boundary

1. **Already portable:** the independent readers in `probes/asset-reader`
   (PAK, model, Scene/level, texture, XT) are native/wasm32 and do not link the
   engine.
2. **Next probe:** a small engine-side static library from `misc_shared`/`btl`
   archive/serialization primitives, compiled with Emscripten, to measure
   header and intrinsic closure. This is not gameplay.
3. **Do not start with:** Amax executable, DX11/FX11, DemonWare, audio, window
   or scheduler. Those need replacement layers, not a compiler flag.

## First experiment

Create `_work/wasm-engine-probe/` (ignored) with a minimal CMake/em++ target that
includes one representative engine header and one `.cpp` (e.g. archive/
serialization or a math-only Gravity unit). Record:

- exact em++ command and Emscripten version;
- compiled objects and unresolved/undefined symbols;
- Windows headers/intrinsics that must be replaced;
- memory and code-size baseline.

Do not modify `upstream/`; use the isolated copy or a read-only include path.
Stop at the first real dependency closure measurement; do not fake a build.

## Acceptance for T-005a

- A written list of compilable vs blocked engine modules.
- At least one real wasm32 compile/link attempt with exact errors.
- A proposed platform interface boundary (file, time, input, render, audio)
  suitable for the next slices.
- No claim that the engine runs in the browser.

## Next

Run the first `_work/wasm-engine-probe` compile, then update this document with
the actual errors and the smallest viable port order.
