# T-005a — Engine/WASM probe (wasm32 compile and link measurements)

**Date:** 2 November 2026
**Scope:** read-only feasibility probe. No `upstream/` file, project source,
build file or game data was modified; the game was not run.
**Supersedes:** `docs/work/analysis/engine-wasm-feasibility.md` (initial source
audit, no build attempted).
**Toolchain measured:** Emscripten 6.0.13 (commit `e13ee988ce3d87a738dd8f3661d02223308c412a`),
clang 24.0.0git, target `wasm32-unknown-emscripten`, pinned at
`_work/toolchains/emsdk`, driven through
`_work/toolchains/emsdk/upstream/emscripten/em++.py` with the bundled Python.

## 1. What was measured, and how

Five independent probes, all reproducible from `_work/wasm-engine-probe/`:

| Probe | Question |
| --- | --- |
| `probe_core.cpp` | Does the mandatory engine header (`<core/Core.h>`) parse? |
| `probe_math.cpp`, `matrix.py` | Which real engine translation units compile, and what blocks them? |
| `matrix.py` (two configurations) | How much of the block is Windows headers vs. MSVC language semantics? |
| zlib link probe | Smallest real subset that **links and runs**; its size and its link closure. |
| `surface.py` | Size of the Windows/DX/audio surface per library (inventory, not a compile). |

Compile probes use `-fsyntax-only` so nothing but the compiler outcome is
claimed. All paths below are relative to the repo root.

Reproduce the two matrix runs:

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

# (a) the configuration the native build uses: PLATFORM_PC + WIN32
& $py _work/wasm-engine-probe/matrix.py final_pc

# (b) a hypothetical portable configuration: no PLATFORM_PC, plus the two
#     flag-level workarounds that the source needs for any non-MSVC compiler
& $py _work/wasm-engine-probe/matrix.py final_posix -UPLATFORM_PC -UWIN32 `
    -D__restrict= -fms-extensions -fdelayed-template-parsing

& $py _work/wasm-engine-probe/blockers.py
```

## 2. What the build description actually requires

- `cmake/blur_common.cmake:12` is a hard gate: `if(NOT MSVC) FATAL_ERROR
  "MSVC only (the source is Win32/D3D9 MSVC code)"`.
- Everything is compiled with `/permissive` (`blur_common.cmake:54`) and with
  `PLATFORM_PC WIN32 _WINDOWS ...` on the command line
  (`blur_common.cmake:67-74`). `PLATFORM_PC` is therefore not derived in the
  source; it is injected by the build.
- Targets are per-library static libraries plus one unity-batched `Amax`
  executable (`cmake/targets.cmake`), each with a PCH
  (`CorePch.h`, `SystemPch.h`, `MiscSharedPch.h`, ...).
- `cmake/dx11.cmake` is the only PC renderer: `blur_dx11` is D3D11, and
  `display`/`display2` take their D3D11 devices, contexts and windows as extra
  sources.

Two facts from the source that decide most of the outcome:

1. `code/mercury/library/common/system/include/system/scheduler/core/tl_defs.h:9-10`
   refuses to compile without a platform identity —
   `#error TL_PLAT_XXX platform specification is missing. It should be set via
   the compiler command line.` — and `tl_thread.h:15` —
   `#if TL_PLAT_PC + TL_PLAT_PS3 + TL_PLAT_PS3_SPU + TL_PLAT_REV != 1
   #error This module is only implemented for PC, Xenon and Playstation3
   platforms.` A wasm32 target has **no** platform identity
   (`mercury_to_tl.h` maps only `PLATFORM_SPU`/`PLATFORM_PS3`/`PLATFORM_PC`).
2. The engine has no non-Windows *configuration*, only non-Windows *compiler*
   branches. `core/include/core/Maths.h` wraps portable helpers (`__fsel`,
   `Clamp`, `ClampSigned`) in `#ifndef PLATFORM_LINUX`, while `PLATFORM_LINUX` is
   what `core.h` auto-defines when neither `_WIN32` nor `WIN32` is set. Dropping
   `PLATFORM_PC` therefore removes `windows.h` **and** removes portable maths
   helpers — the two cannot currently be separated.

## 3. Results

### 3.1 `<core/Core.h>` — one define away from parsing

`PLATFORM_PC + WIN32` on wasm32 fails with exactly one error:

```
core/utility/newclib.h:125:9: error: use of undeclared identifier '_vsnprintf'
```

Cause: `newclib.h:120` tests `#if defined(PLATFORM_PC) && (_MSC_VER < 1400)`.
`_MSC_VER` is undefined for clang, evaluates to `0`, and the MSVC-only branch is
taken. Adding a single command-line compat define compiles clean:

```powershell
& $py _work/toolchains/emsdk/upstream/emscripten/em++.py -std=c++14 `
  -DBUILD_CONFIG_SPEED -DPLATFORM_PC -DWIN32 -D_vsnprintf=vsnprintf `
  -Wno-nonportable-include-path `
  -I upstream/BlurRebuilt/code/mercury/library/common/core/include `
  -I upstream/BlurRebuilt/code/mercury/library/common/core `
  -c _work/wasm-engine-probe/probe_core.cpp -o _work/wasm-engine-probe/probe_core_pc2.o
# exit 0
```

The `_MSC_VER < N` idiom is a repeating hazard: `surface.py` finds 2 more
occurrences in `common/core`, and it is the same pattern that hides the maths
helpers.

### 3.2 `core/Maths.h` — the single gate for the whole engine

Every library measured here includes `core/Maths.h` (directly, or via its PCH).
On wasm32 it fails with **7 errors in 3 headers**, of two kinds:

| Site | Error | Count |
| --- | --- | --- |
| `core/maths/hvec/Vector.inl:6917, 7484, 8090`, `Geometry.inl:1217, 1218` | `no viable conversion from 'const HVec3' to 'Float3'` in `(MathsStorage::Float3)m_V` | 5 |
| `core/maths/MathsUtil.h:1499, 1500` | `use of undeclared identifier '__fsel'` (software shim excluded by `#ifndef PLATFORM_LINUX`) | 2 |

Measured error counts for `probe_math.cpp` (includes `<core/Maths.h>`), by flag
set, all with `-DPLATFORM_PC -DWIN32 -D_vsnprintf=vsnprintf`:

| Flags | Errors |
| --- | --- |
| none | 67 |
| `-fms-extensions -fdelayed-template-parsing` | 51 |
| `-fpermissive` (clang has no such mode; same as none) | 67 |
| `-fms-compatibility` | 14707 (breaks the system headers; do not use) |
| `-D__restrict=` | 24 |
| `-D__restrict= -fms-extensions -fdelayed-template-parsing` | **11** (7 header + 4 from the probe's own `Vector3` usage) |
| `-D_MSC_VER=1920 -D__restrict= -fms-extensions` | 84 (pretending to be MSVC is harmful) |

With `-D__restrict= -fms-extensions -fdelayed-template-parsing` the real TU
`core/source/maths/hvec/Vector.cpp` (the largest maths TU) is down to **5
errors**, i.e. 5 header lines (`Vector.inl` ×3, `Geometry.inl` ×2) separate the
largest maths TU from compiling. `__restrict` after a
constructor's parameter list is MSVC-only syntax (`Vector2_Bool`, `HF32`,
`HVec4::operator*=`); `-D__restrict=` is a workaround, not a fix — the port must
remove `__restrict` from those declarations.

### 3.3 Windows headers vs MSVC semantics — separated

`matrix.py` compiles 48 real TUs. Two configurations:

**Configuration A — the native one (`PLATFORM_PC + WIN32`)**

| Library | Result |
| --- | --- |
| `common/core` (13 TUs) | 61–100 errors each; maths cascade + `windows.h` in `threads/Thread.cpp`, `threads/Mutex.cpp` |
| `common/system` (14 TUs) | **1 fatal each**: `SystemPch.h:22 fatal error: 'winsock2.h' file not found` — PCH gate, nothing else measured |
| `common/misc_shared` (10 TUs) | **1 fatal each**: `MiscSharedPch.h:13 fatal error: 'windows.h' file not found` |
| `common/xt2` (2 TUs) | 175 / 212 errors (maths cascade + PS3 `cell/atomic.h`) |
| `physics/gravity` (3 TUs) | 210 errors: 137 `_isnan`, plus maths |
| `physics/racingphysics` (3 TUs) | 62 errors: maths + `tl_*` + Display headers |
| `vendor/zlib` (3 TUs) | **0 errors — compiles** |

**Configuration B — portable (`-UPLATFORM_PC -UWIN32`, plus
`-D__restrict= -fms-extensions -fdelayed-template-parsing`)**

Same 48 TUs, but the `windows.h`/`winsock2.h` PCH gate disappears and the maths
gate is the only shared failure. Remaining errors beyond the 7-error maths
baseline (error counts are per TU and **not additive** — clang stops inside a
cascading header):

| TU | errors | extra blockers beyond the maths baseline |
| --- | --- | --- |
| `core/maths/{Vector,Matrix,Quaternion,SIMD,Constants}` | 7 | — (only the maths gate) |
| `core/maths/new/Mat44` | 84 | 29× `_isnan` (MSVC CRT), 48× `Clamp` unavailable because `PLATFORM_LINUX` disables it |
| `core/util/endian`, `core/containers/String`, `core/alloc/*`, `core/threads/Thread` | 7 | — |
| `core/util/BizAssert` | 11 | 3× missing `typename` on a dependent using-declaration, `_TRUNCATE` undefined |
| `core/threads/Mutex` | 14 | PS3 path taken: `sys_lwmutex_attribute_t`, `CELL_OK`, `SYS_SYNC_RECURSIVE` |
| `system/misc/{Base64,StringUtil,Platform,Random}`, `system/time/Time`, `system/serialise/{FilePath,C_MemoryStream}`, `system/memory/{BlockAllocator,VirtualMemory}`, `system/XML/XmlDom` | 7 | — |
| `system/serialise/C_File` | 11 | `C_File.cpp:151` is malformed C++ (`failed to open %s", ...` — missing opening quote); MSVC tolerates it because the macro discards the tokens |
| `system/scheduler/jobqueue` | 18 | `tlThreadHandle`, `tlThreadFunction`, `#error TL_PLAT_XXX` |
| `system/debug/log/Format` | 10 | 3× missing `typename` |
| `system/io/IoFile` | 8 | `ArteryThreadHandle` |
| `misc_shared/{Types/Float16,DataStructure/StringTable,Sort/*,Geometry/Bounds,Variant}` | 7 | — |
| `misc_shared/Compression/Inflate`, `archive/serialiser` | 18 | `tl_*` + job-queue types |
| `misc_shared/archive/handler`, `Messaging/MessageBase` | 8 / 10 | missing `typename` |
| `xt2/{XtCrc,XtFlask}` | 8 | `<cell/atomic.h>` (PS3 atomics) even with `-DXT_GAME` |
| `physics/gravity/*` | 203–215 | `tl_*` `#error`, 137 `_isnan`, `Clamp` gated out, `HVec3`→`Fixed3_S16<14>` conversions |
| `physics/racingphysics/*` | 19 | `tl_*` `#error`, `Mutex`, cascade into `Display/*` headers |
| `vendor/zlib/*` | 0 | — |

### 3.4 The one subset that links and runs

Vendored zlib, unchanged, links and executes:

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
$z  = "upstream/BlurRebuilt/code/vendor/zlib/current_mercury"
$src = @("adler32","compress","crc32","deflate","infback","inffast","inflate",
         "inftrees","trees","uncompr","zutil") | ForEach-Object { "$z/$_.c" }
$src += "_work/wasm-engine-probe/zlib_link_probe.c"

& $py _work/toolchains/emsdk/upstream/emscripten/emcc.py -O2 `
  -DBUILD_CONFIG_SPEED -DPLATFORM_PC -DWIN32 -Wno-nonportable-include-path `
  "-I$z" "-Iupstream/BlurRebuilt/code/mercury/library/common/core/include" `
  "-Iupstream/BlurRebuilt/code/mercury/library/common/system/include" `
  @src -sENVIRONMENT=node -o _work/wasm-engine-probe/out/zlib_probe.js
# exit 0

& _work/toolchains/emsdk/node/24.19.0_64bit/node.exe _work/wasm-engine-probe/out/zlib_probe.js
# crc32=fd7bb204 adler32=6c4ff86a compress=0 inflate=0 roundtrip=1 packed=315
# exit 0
```

| Artifact | `-O2` | `-Os` |
| --- | --- | --- |
| empty `main` | 305 B | — |
| zlib core (11 C files + driver) | 58,598 B | 50,222 B |

Two closure facts from the same link:

- `code/vendor/zlib/current_mercury/compression.cpp` (the Mercury wrapper) does
  **not** link standalone: `wasm-ld: error: ...compression.o: undefined symbol:
  Debug::`. It includes `System/DebugLog.h` and holds
  `static Debug::Logger &g_ZlibLog = Debug::GetLogger("vendor.zlib")`
  (`compression.cpp:20-27`). Even zlib's wrapper pulls in the logging system.
- Sizes for `core`/`system`/`misc_shared` cannot be reported yet: they do not
  compile, so no link was attempted and no number is claimed.

### 3.5 Platform surface inventory (inventory only, not a compile result)

`surface.py` scans 4,782 text files / ~1,236 kLOC of engine and Amax code.
Counts are textual matches, useful for ordering, not for guarantees:

| library | files | kloc | `windows.h` | `winsock2` | `d3d11`/`fx11` | DirectInput/XInput | DirectSound | OpenAL | file API | timing | threads | message loop |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| common/core | 498 | 186.0 | 12 | 0 | 0 | 0 | 0 | 0 | 66 | 2 | 9 | 1 |
| common/system | 269 | 48.3 | 8 | 3 | 0 | 0 | 0 | 0 | 11 | 9 | 34 | 4 |
| common/misc_shared | 207 | 30.0 | 1 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 |
| common/xt2 | 88 | 32.7 | 1 | 2 | 0 | 0 | 0 | 0 | 8 | 4 | 1 | 0 |
| physics/gravity | 347 | 116.7 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| physics/racingphysics | 83 | 24.0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 3 | 0 |
| graphics/display | 538 | 69.6 | 1 | 1 | 442 | 0 | 0 | 0 | 1 | 1 | 6 | 15 |
| graphics/display2 | 72 | 27.9 | 1 | 1 | 43 | 0 | 0 | 0 | 0 | 0 | 1 | 2 |
| graphics/render | 226 | 29.6 | 1 | 1 | 33 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| util/input | 30 | 4.4 | 1 | 1 | 0 | 2 | 0 | 0 | 0 | 1 | 0 | 0 |
| audio | 493 | 123.4 | 5 | 1 | 0 | 0 | 10 | 7 | 6 | 5 | 10 | 57 |
| ui | 215 | 57.8 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 1 | 1 | 5 |
| Amax/game | 941 | 301.0 | 3 | 3 | 3 | 0 | 0 | 0 | 0 | 2 | 0 | 235 |

Concrete anchors used for the boundary design: `system/source/time/Time.cpp:57`
(`QueryPerformanceCounter`), `system/source/serialise/C_File.cpp:86`
(`CreateFile`), `util/input/source/input/DeviceManagerPC.cpp:19`
(`DirectInput8Create`), `util/input/source/input/Device.cpp:60`
(window-message mouse).

## 4. Compilable vs blocked

**Compilable today, unmodified**

- `code/vendor/zlib/current_mercury/*.c` (11 files) — compiles, links, runs;
  58,598 B at `-O2`.
- `<core/Core.h>` alone (the mandatory header, no maths) — parses with
  `-D_vsnprintf=vsnprintf`.
- `probes/asset-reader` (PAK, model, mesh, scene, level, texture, XT readers) —
  already native/wasm32; not part of this probe.

**Blocked by the maths gate only** (7 errors, 3 headers; all of `core` except
`new/Mat44`, and most of `system`/`misc_shared`)

- `core/maths/*`, `core/util/*`, `core/containers/String`, `core/alloc/*`,
  `system/time/Time`, `system/serialise/{FilePath,C_MemoryStream}`,
  `system/memory/*`, `system/XML/XmlDom`, `system/misc/*`,
  `misc_shared/{Float16,StringTable,Sort/*,Bounds,Variant}`.

**Blocked by maths + MSVC/CRT compat** (`_isnan` 137×, `_TRUNCATE`, missing
`typename`)

- `core/maths/new/Mat44`, `core/util/BizAssert`, `system/debug/log/Format`,
  `misc_shared/{archive/handler,Messaging/MessageBase}`,
  `physics/gravity/*` (also `Clamp` gating and `Fixed3_S16` casts).

**Blocked by the threading identity** (`tl_defs.h`/`tl_thread.h` `#error`)

- `system/scheduler/jobqueue`, `misc_shared/Compression/Inflate`,
  `misc_shared/archive/serialiser`, `core/threads/Mutex`,
  `system/io/IoFile`, `physics/racingphysics/*`.

**Blocked by a platform primitive with no non-Windows branch**

- `common/xt2/*`: `<cell/atomic.h>`; atomics must come from the new platform layer.
- `system/serialise/C_File.cpp:151`: latent malformed string literal, must be
  fixed (it is not a Windows issue, MSVC just accepts it).

**Blocked by the renderer (not a compiler problem)**

- `graphics/display` (442 D3D11/FX11 matches), `graphics/display2` (43),
  `graphics/render` (33), `blur_dx11`, `blur_fx11`, all `Display/*` consumers
  (`racingphysics` reaches them through its stdafx).

**Not measured at all:** audio, ui, network, animation, gamesys, Amax game
logic. They include the same gated headers, so their first error is already
known, but no TU was compiled and no number is claimed.

## 5. Proposed platform interface boundary

One new platform identity plus a narrow boundary, so the engine keeps a single
code path and no silent fallback:

1. **Add `PLATFORM_WEB`** (and `PLATFORM_WEB` → `TL_PLAT_WEB` in
   `mercury_to_tl.h`), compiled with `-DPLATFORM_WEB` and **no** `PLATFORM_PC`,
   `_WIN32`, `WIN32`. Every `#ifndef PLATFORM_LINUX` that currently guards
   portable maths must become `#if defined(PLATFORM_PC) || defined(PLATFORM_SPU)
   || defined(PLATFORM_WEB)` (or the helpers move out of the guard). This is the
   change that makes the maths gate fixable once instead of per-platform.
2. **`platform/file`** — open/read-range/size/close, directory enumeration,
   write for save. Replaces `CreateFile`/`ReadFile`/`FindFirstFile` in
   `C_File.cpp` and `logicalfs`. Must expose range reads so T-005b does not copy
   whole PAK/level blocks into a single buffer. Async completion stays with the
   engine's IO service; the browser side resolves promises.
3. **`platform/time`** — monotonic tick source with sub-millisecond resolution
   (`QueryPerformanceCounter` equivalent) plus a sleep/yield. Simulation stays
   fixed-step (project rule); no frame-count timing.
4. **`platform/thread`** — the `tl_*` contract of `tl_thread.h`
   (`tlCreateThread`, `tlWaitForThread`, handle, priorities, TLS, atomics).
   T-005c decides between single-threaded scheduler and
   `SharedArrayBuffer`/Atomics workers; until then `TL_PLAT_WEB` must provide a
   single-threaded implementation, not a stub that pretends to be parallel.
5. **`platform/input`** — device enumeration, buttons/axes with the retail
   semantics of `Device.cpp` (XInput trigger threshold, deadzone, edge tests),
   keyboard and pointer from DOM events. Replaces `DirectInput8Create` and the
   window-message mouse.
6. **`platform/render`** — the `Display`/`Display2` interface already exists as
   an abstraction; the work is a WebGPU backend behind it, not changes in
   consumers. Shader path is separate (FX11 is compiled offline today).
7. **`platform/audio`** — output device + voice/mixer surface behind
   `library/audio`; the PC backend is DirectSound, so a new backend is required
   (WebAudio). OpenAL is linked on PC as well and is not automatically portable.
8. **`platform/log`** — `Debug::Logger` is in the closure of the zlib wrapper
   (`compression.cpp`), so logging must exist in the earliest linkable slice;
   a console/`console.log` sink is enough.

Explicitly **out of scope for the first boundary**: DX11/FX11, DemonWare
networking, Bink/movie, window management as an engine concept.

## 6. First port order

1. **Maths gate (blocking everything).** Fix the 7 errors: move `__fsel`/
   `Clamp`/`ClampSigned` out of `#ifndef PLATFORM_LINUX`, and make the five
   `(MathsStorage::Float3)m_V` casts explicit. Remove `__restrict` from
   constructor/operator declarations instead of relying on `-D__restrict=`.
   Acceptance: `matrix.py final_posix` reports 0 errors for the five `core/maths`
   TUs and for `Vector.cpp` with no workaround flags.
2. **CRT compat header** (`_vsnprintf`, `_isnan`, `_TRUNCATE`, `sprintf_s`,
   missing `typename` sites). Acceptance: `core/util/BizAssert`,
   `core/maths/new/Mat44`, `system/debug/log/Format`,
   `misc_shared/Messaging/MessageBase` compile.
3. **`PLATFORM_WEB` identity + `platform/thread` single-threaded `tl_*`.**
   Acceptance: `system/scheduler/jobqueue`, `misc_shared/Compression/Inflate`,
   `misc_shared/archive/serialiser` compile; a job-queue smoke test links.
4. **`platform/file` + `platform/time`.** Acceptance: `C_File`, `FilePath`,
   `Time`, `logicalfs` compile; a PAK range read runs in node.
5. **Link slice 1 and measure.** `core` + `system` + `misc_shared` + `xt2` +
   zlib into one wasm; record size, memory floor and startup time. This is the
   first number that says whether the vertical slice is viable.
6. **Physics** (`gravity`, `racingphysics`) against the native reference, then
   input, then audio/HUD/save, then the race acceptance test (T-005g).

Rationale for the order: steps 1–2 are the only ones that unblock *every*
module, step 3 removes the last `#error`, steps 4–5 produce the first real size
measurement, and only then is physics worth touching.

## 7. Unverified, and what this probe does not prove

- No engine module beyond zlib was linked; therefore **no engine code size or
  memory figure exists yet**. The 58,598 B figure is zlib only.
- No runtime behaviour was measured; zlib's roundtrip in node is the only
  executed code.
- Nothing was run in a browser; there is no GPU, WebGPU or screenshot evidence.
- Error counts are compiler diagnostics, not independent defect counts: clang
  stops inside a cascading header, so a TU showing 7 errors may hide more.
- The `-UPLATFORM_PC` configuration is a *hypothesis* used to separate Windows
  headers from MSVC semantics. It is not a supported engine configuration and it
  currently disables portable maths helpers, so it must not be adopted as-is.
- SSE/`_SIMD_` code paths were not exercised: with `PLATFORM_PC` the engine does
  not define `_SSE2_` on wasm32 (`_WIN64` branch), so the scalar path is what
  was compiled. Whether Emscripten's SSE-emulation headers can host
  `SIMD_SSE.inl` is untested.
- Audio, input, UI, network, animation, gamesys and Amax game logic were not
  compiled at all.
- The Windows surface table is textual; it does not prove that a given API is on
  a live path.
- `upstream/` was never written to. Probe scripts, logs and artifacts live in
  `_work/wasm-engine-probe/` (ignored by Git).

## 8. Evidence index

All hashes are SHA-256 prefixes of the files as produced by this session.

| Path | Size | SHA-256 (16) | Content |
| --- | --- | --- | --- |
| `_work/wasm-engine-probe/final_pc.json` | 37,723 | `EE2FD358B5CF0E6C` | 48-TU matrix, `PLATFORM_PC + WIN32` |
| `_work/wasm-engine-probe/final_posix.json` | 51,600 | `6AB097B2F657DDF5` | 48-TU matrix, portable config + workaround flags |
| `_work/wasm-engine-probe/surface.json` | 4,015 | `0437EFB1AD929258` | per-library Windows/DX/audio inventory |
| `_work/wasm-engine-probe/logs/final_posix__core_maths_Vector.log` | 26,297 | `8DC4DF25A247CA40` | the 7-error maths gate |
| `_work/wasm-engine-probe/logs/vector_tu.log` | 25,913 | `4428AFC1A27527CD` | `Vector.cpp` at 5 errors with workaround flags |
| `_work/wasm-engine-probe/logs/final_pc__system_time_Time.log` | 380 | `B661F3EA718BA529` | `winsock2.h` PCH gate |
| `_work/wasm-engine-probe/logs/final_posix__system_scheduler_jobqueue.log` | 38,849 | `C53F533B046BF547` | `tl_*` threading `#error` |
| `_work/wasm-engine-probe/logs/final_posix__gravity_*.log`, `..._racing_*.log` | 595–619 KB | `5351ACCAE7A9D04D` … | `_isnan`, `Clamp`, `tl_*` in physics |
| `_work/wasm-engine-probe/logs/zlib_link.log` | 20,550 | `561C9887DDDDE1A6` | zlib link, `Debug::` undefined symbol |
| `_work/wasm-engine-probe/out/zlib_probe.wasm` | 58,598 | `00BB31D58E1D85C7` | `-O2` zlib wasm |
| `_work/wasm-engine-probe/out/zlib_probe_os.wasm` | 50,222 | `F625EA5A74F830C3` | `-Os` zlib wasm |
| `_work/wasm-engine-probe/out/empty.wasm` | 305 | `56BEE82786620EC2` | empty-`main` baseline |
| `_work/wasm-engine-probe/{matrix,blockers,surface}.py` | — | — | probe harness (scratch, not project code) |
