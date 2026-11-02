# T-005 — Engine web shim layer and wasm32 compile spike (P14)

**Date:** 2 November 2026
**Status:** bounded spike. No `upstream/`, project source, build file, tool, task
card or other analysis document was modified; the game and the native build were
not run. Everything below was produced under `_work/engine-web-spike/` and
`_work/logs/engine-web-spike/`.
**Inputs:** `docs/work/analysis/engine-wasm-probe.md` (T-005a measurements),
`docs/work/analysis/t005-scheduler-design.md` (T-005c adapter design).
**Toolchain:** the pinned emsdk already in `_work/toolchains/emsdk` —
Emscripten 6.0.13, clang 24.0.0git, target `wasm32-unknown-emscripten`, driven
through `em++.py` with the bundled Python.

**No engine claim.** This document does not say the engine runs. It says which
real translation units the wasm32 front end accepts, which one shim layer was
needed, what a linked module measures, and what still blocks the rest.

---

## 1. Scope and method

The spike answers one question: **how much of the 7-error `core/Maths.h` gate is
a shim problem and how much is a source problem?** It then pushes the same shim
against the scheduler and platform TUs named in the T-005c design, and finally
links and runs the largest subset that survives.

Method:

1. A `platform/web`-style prelude (`shims/web_platform.h`,
   `shims/crt_compat.h`) is force-included with `-include`. It may contain only
   standard typedefs, name aliases and definitions copied verbatim from the
   engine with a citation. Nothing numeric is invented.
2. Every error class is classified as *shim*, *compiler mode* or *source edit*.
   A source edit that the prelude could hide is deliberately **not** hidden, so
   the required upstream diff stays visible.
3. To prove a source edit is sufficient without touching `upstream/`, the
   `core/include` tree is copied into an overlay
   (`_work/engine-web-spike/patched/`, `make_patched_copy.py`) and exactly the
   listed tokens are substituted. The overlay is a measurement artifact.
4. Two node smokes link real objects and check values that were computed by
   hand, not just "it printed something".

24 distinct real engine TUs were compiled, plus the synthetic probes under
`_work/engine-web-spike/probes/` (five header-free language repros and two
drivers).

## 2. Exact commands

One command reproduces everything:

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
& $py _work/engine-web-spike/run_spike.py
```

It runs, in order: `make_patched_copy.py`, then `build_probe.py` for the seven
measurement sets, then compile → link → two node runs per smoke. Per-TU logs go
to `_work/engine-web-spike/logs/`, per-run JSON and the summary to
`_work/logs/engine-web-spike/`.

A single TU can be reproduced directly, e.g. the control that still has the
value of the T-005a baseline:

```powershell
& $py _work/engine-web-spike/build_probe.py ctl_noshim_maths maths `
    -DPLATFORM_WEB -fdelayed-template-parsing -D__restrict= -fdeclspec
# 7 errors per TU - identical to engine-wasm-probe.md section 3.2
```

The final configuration used everywhere below is:

```text
-DBUILD_CONFIG_SPEED -DPLATFORM_WEB -std=c++14
-fdelayed-template-parsing -D__restrict= -fdeclspec
-Wno-nonportable-include-path -Wno-ignored-attributes
-include _work/engine-web-spike/shims/web_platform.h
-I _work/engine-web-spike/patched/core/include        (final_* sets only)
-I <library include dirs from matrix.py>
```

`-D_vsnprintf=vsnprintf`, which T-005a needed for the `PLATFORM_PC` probe, is
**not** needed here: `newclib.h:120` gates that branch on
`defined(PLATFORM_PC) && (_MSC_VER < 1400)`, and `PLATFORM_PC` is absent.

## 3. Results — 24 real TUs

`0` means the front end accepted the TU. A failing count is clang diagnostics,
not a defect count (clang stops inside a cascading header).

| TU | errors | class of the remaining errors |
| --- | --- | --- |
| `core/maths/hvec/{Vector,Matrix,Quaternion,SIMD,Constants}.cpp` (5) | **0** | — |
| `core/source/utility/endian.cpp` | **0** | — |
| `core/source/containers/String.cpp` | **0** | — |
| `core/source/allocators/{CoreMemoryNonTracked,stackallocator}.cpp` (2) | **0** | — |
| `core/source/maths/hvec/new/Mat44.cpp` | **0** | was 77 before shim + guard |
| `core/source/threads/Thread.cpp` | **0** | POSIX branch (`Thread.cpp:31-37`) |
| `system/source/time/Time.cpp` | **0** | generic branch, `gettimeofday` |
| `misc_shared/{Types/Float16,Geometry/Bounds}.cpp` (2) | **0** | — |
| `misc_shared/archive/handler.cpp` | **0** | was 1 (`typename`) |
| `core/source/utility/BizAssert.cpp` | 1 | `_vsnprintf_s` (MSVC secure CRT) |
| `system/source/threads/Mutex.cpp` | 7 | PS3 branch taken (`!COMPILER_VC`) |
| `core/source/threads/ThreadLocalStorage.cpp` | 1 | `pthread_key_t` |
| `system/source/scheduler/jobqueue.cpp` | 11 | 9 `tl_*`, 2 `#error` |
| `system/source/scheduler/jobqueue_kernel.cpp` | 11 | identical to the above |
| `system/source/scheduler/jobqueue_xenon.cpp` | 21 | 9 `tl_*`, 2 `#error`, 9 Win32, 1 `JQ_CORE_0` |
| `system/source/scheduler/jobqueue_kernel_xenon.cpp` | 14 | 9 `tl_*`, 2 `#error`, 2 `HANDLE`, 1 `Task` shadowing |
| `misc_shared/Compression/Inflate.cpp` | 11 | 9 `tl_*`, 2 `#error`, 1 `Scheduler::jqModule` |
| `misc_shared/archive/serialiser.cpp` | 10 | 10 identity-gated, nothing else |

**15 / 24 TUs compile; the 9 failures carry 87 errors.** Grouped by cause (an
explicit classification of every one of the 87 diagnostics):

| Cause | Errors | Share |
| --- | --- | --- |
| `tl_*` platform identity (`tlThreadHandle`, `tlThreadFunction`, `tl_threadlocal`, `TL_THREAD_*`, `jqModule`, the two `#error`) | 63 | 72 % |
| Win32 types/APIs (`HANDLE`, `SYSTEM_INFO`, `WaitForSingleObject`, `ResumeThread`, `CloseHandle`, `WAIT_OBJECT_0`, `FALSE`) | 11 | 13 % |
| PS3/pthread branch (`sys_lwmutex_*`, `CELL_OK`, `SYS_SYNC_RECURSIVE`, `pthread_key_t`) | 8 | 9 % |
| Engine symbols outside the identity (`JQ_CORE_0`, `Task` shadowing, 2 cascading `expected ';'`) | 4 | 5 % |
| MSVC secure CRT (`_vsnprintf_s`) | 1 | 1 % |

`Mutex.cpp` is not identity-gated: it is a genuinely wrong compiler branch
(`#if !defined(COMPILER_VC)` means "PS3", `core/source/threads/Mutex.cpp:52-100`),
so it fails on *any* non-MSVC target.

## 4. The `core/Maths.h` gate, resolved

### 4.1 The measurement ladder (`Vector.cpp`, identical for all 5 maths TUs)

| Configuration | shim (`-include`) | overlay | errors |
| --- | --- | --- | --- |
| no compat flags | yes | no | 41 |
| `-D__restrict=` | yes | **yes** | 14 |
| `-fdelayed-template-parsing` | yes | **yes** | 21 |
| `-fms-extensions` | yes | **yes** | 36 |
| `-fdelayed-template-parsing -D__restrict= -fdeclspec` | **no** | no | 7 |
| that, + shim | yes | no | 5 |
| that, + shim, `-std=c++17 -Wno-register` | yes | no | 2 |
| that, + shim | yes | **yes** | **0** |

Rows 2-4 include the overlay so that cause B (which every one of them hides)
does not mask the effect of the flag being measured; their residuals are
therefore "whatever that single flag does *not* fix".

The `7` row reproduces `engine-wasm-probe.md` §3.2 exactly on the same TU (the
earlier probe reported 11 because probe-own usage added 4), so the
configurations are comparable.

`-std=c++17` fixes only 3 of the 5 remaining errors and introduces a new error
class — `register` is a hard error in C++17, observed at `Geometry.inl:1455-1456`
and textually present in `core/utility/hash.h:86,138`. It is not the right lever,
and it is not needed.

### 4.2 Root causes of the 7-error gate (2 causes, 7 sites)

**Cause A — `__fsel` has no platform branch (`MathsUtil.h:1499-1500`).**
Those two lines have *no* guard at all, while the only software definition the
engine ships is compiled for `PLATFORM_PC || PLATFORM_SPU`
(`MathsUtil.h:412-414`). Shimmed with a macro whose body is that same
expression, so the behaviour is the engine's own:

```c
#define __fsel(cmp, a, b) (((cmp) >= 0.0f) ? (a) : (b))
```

**Cause B — a cv-qualified conversion-operator return type (5 sites).**
`Vector.inl:6917/7484/8090` (`return (MathsStorage::Float3)m_V;`) and
`Geometry.inl:1217/1218` (`rtn.vmin = m_Min;`) all route through
`operator const MathsStorage::Float3() const`. clang refuses to use a conversion
function whose result type is cv-qualified **when the result has to be copy-
initialised**, and MSVC accepts it. Reproduced without any engine header:

```text
probes/repro_lang.cpp          operator const F()  -> c++14: 3 errors, c++17: 0
probes/repro_lang_nocv.cpp     operator       F()  -> c++14: 0 errors
probes/repro_lang_assign.cpp   `out = s;` with `operator const F()`
                               -> c++14: 2 errors, c++17: 1 error
probes/repro_lang_assign_nocv.cpp                 -> both: 0 errors
```

So: dropping `const` from the return type fixes the *return* form and the
*assignment* form at every language level; `-std=c++17` fixes only the return
form. The proof in the engine is the `final_maths` run: 5/5 TUs, 0 errors, with
7 declarations and 7 definitions changed (the 4 `Float3` pairs are the error
sites; the 3 `Fixed3_S16` pairs were identical declarations and were changed so
the header stays consistent), and nothing else.

Semantic impact: **none**. The cv-qualification of a returned prvalue is not
observable, and C++17 already ignores it. This is a grammar fix, not a behaviour
change.

**Cause C — the `#ifndef PLATFORM_LINUX` guard (48 of `Mat44.cpp`'s 77 errors).**
A non-Windows build falls through `Core.h:181-191` to `PLATFORM_LINUX`, and
`MathsUtil.h:410` gates `Clamp`, `ClampSigned`, `SetClamp`, `Wrap`, `AddWrap`,
`SubWrap` behind `#ifndef PLATFORM_LINUX`. This cannot be shimmed without
duplicating engine definitions (the bodies call `Clamped`, which does not exist
yet at prelude time), and duplicating them would be a silent fork. It is a
one-line guard change:

```c
#if !defined( PLATFORM_LINUX ) || defined( PLATFORM_WEB )   // MathsUtil.h:410
```

With that guard + the `_isnan` mapping, `Mat44.cpp` goes **77 → 0**.

## 5. Shim inventory and semantic impact

| Shim entry | File | Origin | Semantic impact |
| --- | --- | --- | --- |
| `PLATFORM_WEB` | `web_platform.h` | new build identity | none by itself; `Core.h` still defines `PLATFORM_LINUX` too (see §8.1) |
| `__fsel(cmp,a,b)` | `web_platform.h` | body copied from `MathsUtil.h:413` | **none** — identical expression, macro instead of `inline` only because the engine's `F32`/`INLINE` do not exist yet |
| `_TRUNCATE` | `crt_compat.h` | copied from `Core.h:724` (`PLATFORM_PC`) and `:500` (`PLATFORM_PS3`) | none — same value `((size_t)-1)` |
| `_isnan(x)` → `isnan(x)` | `crt_compat.h` | MSVC CRT name | none — same predicate; 29 sites in `Mat44.cpp`, 137 in `physics/gravity` (T-005a) |
| `_finite` | **deliberately absent** | `Core.h:355` already defines it for `COMPILER_GNU` | defining it here caused a `-Wmacro-redefined`; removed |
| `_vsnprintf` | **deliberately absent** | not reached without `PLATFORM_PC` — every TU in §3 compiled without the `-D_vsnprintf=vsnprintf` that T-005a needed | — |
| `_vsnprintf_s` | **deliberately absent** | MSVC secure CRT returns `-1` and empties the buffer on truncation; `vsnprintf` returns the would-be length | **would change semantics**; left unfixed (1 site, `BizAssert.cpp:66`) |

Two *compiler modes* are part of the shim layer in the sense that they cannot be
avoided by source edits alone, but they are not engine code:

| Mode | Effect | Semantic impact |
| --- | --- | --- |
| `-fdelayed-template-parsing` | MSVC-style two-phase lookup. With `-D__restrict=` it is the difference between 14 errors and 0. It clears 12 `no viable conversion from returned value of type 'const Vector3_Bool' to function return type 'const S32'` — a second instance of cause B, which 12 more `const` removals would also clear | none on generated code; it defers name lookup, it does not reinterpret expressions |
| `-D__restrict=` | removes the `restrict` qualifier everywhere. Alone it leaves 14 errors; together with `-fdelayed-template-parsing` it leaves 0. Without it (keeping `-fdelayed-template-parsing`) the 4 `'restrict' qualifier is not allowed on a constructor` sites plus 17 follow-on ambiguity errors remain (`Vector2_Bool`, `HF32`, `HVec4::operator*=`) | none observable — `restrict` is an aliasing hint, so this can only cost performance. It is a **workaround, not a fix**: the port should eventually delete `__restrict` from those declarations |
| `-fdeclspec` | enables `__declspec(novtable)` (`Core.h:254`) | none; needed by 1 TU (`jobqueue_kernel_xenon.cpp`) |

## 6. Source edits the shim cannot replace (21 tokens, 6 headers)

Reproduced by `make_patched_copy.py`; `patched/CHANGES.txt` is the manifest.
The overlay is byte-identical to upstream everywhere else.

| File | occurrences | change |
| --- | --- | --- |
| `core/maths/hvec/Vector.h` | 4 | `operator const MathsStorage::Float3` → `operator MathsStorage::Float3` |
| `core/maths/hvec/Vector.inl` | 4 | same, in the definitions |
| `core/maths/hvec/Vector.h` | 3 | `operator const MathsStorage::Fixed3_S16` → drop `const` |
| `core/maths/hvec/Vector.inl` | 3 | same, in the definitions |
| `core/maths/MathsUtil.h:410` | 1 | guard: `\|\| defined( PLATFORM_WEB )` |
| `core/containers/sortedbinarytree.h` | 4 | `using Base::InsertionReturnType;` → `using typename ...` |
| `btl/containers/map.h:41` | 1 | same |
| `btl/containers/sortedbinarytree.inl:388` | 1 | `BalanceInsertedItem(pp);` → `Base::BalanceInsertedItem(pp);` |

The `typename`/`Base::` group is ordinary ISO C++ that MSVC's permissive mode
accepted. None of the 21 tokens changes a value, an offset or a numeric
expression.

## 7. What linked and ran

Two modules were linked from **real engine objects** and executed twice each
under node 24.19.0. `deterministic=True` means both runs printed identical
output.

| Module | Objects | wasm `-O2` | SHA-256 (16) | Output | Check |
| --- | --- | --- | --- | --- | --- |
| `spike_maths.js/.wasm` | `Vector, Constants, SIMD, Matrix, Quaternion` + driver | **11,413 B** | `4DFB1FD8A56D22E9` | `maths_checksum=732`, `inverse_diag_x100=50 25 20 100` | both values computed by hand from the same operands |
| `spike_time.js/.wasm` | `Time.cpp`, `endian.cpp` + driver | **10,397 B** | `34288F7DBF51E7ED` | `perf_counter_positive=1`, `perf_counter_freq=1000000` | frequency matches `system/time/Time.h:48` |

Exact link command (objects from `_work/engine-web-spike/out/obj/`):

```powershell
& $py _work/toolchains/emsdk/upstream/emscripten/em++.py `
  spike_maths_Vector.o spike_maths_Constants.o spike_maths_SIMD.o `
  spike_maths_Matrix.o spike_maths_Quaternion.o spike_maths_smoke_maths.o `
  -sENVIRONMENT=node -o _work/engine-web-spike/out/spike_maths.js
& _work/toolchains/emsdk/node/24.19.0_64bit/node.exe _work/engine-web-spike/out/spike_maths.js
# maths_checksum=732
# inverse_diag_x100=50 25 20 100
```

`732 = 5 + 70 + 900 + (-3) + 60 + (-300)` for `a=(1,2,3)`, `b=(4,5,6)`:
`a+b = (5,7,9)`, `a×b = (-3,6,-3)`. `Matrix44InverseCramersRuleFP` inverts
`diag(2,4,5,1)` to `diag(0.5,0.25,0.2,1)`. That function is **out-of-line in
`Matrix.cpp`** (`Matrix.o` = 9,647 B, symbol
`_ZN5Maths28Matrix44InverseCramersRuleFPEPKfPf`), so its correct output proves
engine object code was linked and executed, not inlined away.

Caveat that must stay attached to the size number: `Vector.cpp` is 6,671 bytes
of almost entirely commented-out code, so `Vector.o` is 347 B. Most of the
executed maths is **inline engine header code** expanded into the driver TU.
`Matrix.cpp` (673 live lines) is the only TU in the link with substantial
object code. 11,413 B is therefore "maths core + libc printf + runtime", not a
measurement of the engine.

Link closure observations:

- The maths core has **no external link closure at all**: no allocator, no
  `Debug::` logger, no assert handler. zlib's wrapper needed `Debug::`
  (T-005a §3.4); the maths TUs need nothing.
- `Time.cpp` also linked with no closure, but its `GetPerformanceCounter()` is
  `GetCurrentTime()` (`Time.cpp:86-93`) — a **wall clock**, not a monotonic
  counter. That is a real semantic caveat for T-005c §3.1 `platform/time`, not
  a compile problem.

## 8. Remaining blockers, ordered by cost

Cheapest first. "Cost" = files and decisions, not lines.

### 8.1 Identity is not a shim problem — it is 5 edits plus a type layer (63 / 87 errors)

`PLATFORM_WEB` currently means `PLATFORM_LINUX` *and* `PLATFORM_WEB`, because
`Core.h:162-191` has no web branch. That double identity is what makes the
maths helpers and the PCH behave differently at the same time, and it is the one
thing this spike could not fix from outside. The minimum source work:

| Site | Change |
| --- | --- |
| `core/Core.h:181` | add `#elif defined(PLATFORM_WEB)` before the `#else` that defines `PLATFORM_LINUX` (`WORD_SIZE 32`, no `PLATFORM_LINUX`) |
| `core/maths/MathsUtil.h:410` | `#if !defined( PLATFORM_LINUX ) \|\| defined( PLATFORM_WEB )` |
| `system/scheduler/core/mercury_to_tl.h:8-10` | add `#elif defined(PLATFORM_WEB)` → `#define TL_PLAT_WEB 1` |
| `system/scheduler/core/tl_defs.h:9` | add `+ defined(PLATFORM_WEB)` to the sentinel sum |
| `system/scheduler/core/tl_thread.h:15` | add `+ TL_PLAT_WEB`; add a `TL_PLAT_WEB` branch for `tlThreadHandle`, `tlThreadId`, `tlThreadPriority`, `tlThreadFlags` |

Then `tl_thread.h` needs the ~20 `tl_*` functions. T-005c §3.2 already specifies
their single-context contract (`tlCreateThread` returns an invalid handle and
records the request, `tlWaitForThread` is a named fatal assert). That part is
**engine implementation work, not shim work**, and it is why this document stops
here.

**Correction to T-005a §3.3:** the Windows PCH (`windows.h`/`winsock2.h`) is
**not** an independent blocker. `SystemPch.h:17-24` gates both headers on
`PLATFORM_PC`; with `PLATFORM_WEB` they disappear, which is why `Time.cpp`
(a `SystemPch.h` TU) compiles and links. The PCH was only fatal while the build
claimed to be PC.

### 8.2 The Xenon kernel TUs should not be ported at all (25 errors)

`jobqueue_xenon.cpp` + `jobqueue_kernel_xenon.cpp` carry 11 Win32
types/APIs, `JQ_CORE_0` (`jobqueue_xenon.cpp:81`), a `Scheduler::Task` vs
`struct Task` shadowing (`jobqueue_kernel_xenon.cpp:27`) and `__declspec`.
Porting them would mean emulating a Windows thread pool on a single-context
target. This is direct evidence for the T-005c §3.4 decision to add
`jobqueue_web.cpp` instead. Cost: replacing two files with one, already designed.

### 8.3 `Mutex.cpp` and `ThreadLocalStorage.cpp` (8 errors)

`core/source/threads/Mutex.cpp:52-100` selects PS3 syscalls whenever the
compiler is not MSVC. The guard should test the platform, not the compiler, and
then a web mutex type is still required (T-005c §3.3: no-op with a debug
counter, assert on any blocking wait). `ThreadLocalStorage.cpp` needs
`pthread_key_t` (or the same web branch). Cost: two files, one semantic
decision already taken by the design.

### 8.4 `_vsnprintf_s` (1 error)

`BizAssert.cpp:66`. The MSVC secure variant has a different truncation contract
than `vsnprintf`, so a name alias would be a silent semantic change. Needs either
a documented wrapper implementing the MSVC contract, or a `PLATFORM_WEB` branch
at that call site. Cost: 1 site. **Not** a blocker for anything else.

### 8.5 DX11 / FX11 — untouched, and the largest unknown

Not measured by this spike at all. T-005a's inventory stands: 442 D3D11/FX11
matches in `graphics/display`, 43 in `display2`, 33 in `render`. This is a
renderer backend project, not a compile problem, and it is the only remaining
blocker on this list whose cost is not yet bounded.

### 8.6 Scheduler module types

`Scheduler::jqModule` (1 error, `Inflate.cpp`) and the `jqModule`-shaped
`jobqueue_*` selection are downstream of 8.1, not separate: `jobqueue.h:61-67`
selects a platform header by `TL_PLAT_*`, and with no identity it selects none.

## 9. The single next smallest step

**Add the `PLATFORM_WEB`/`TL_PLAT_WEB` identity, in a task branch, without
implementing any thread behaviour.** Concretely: the five edits in §8.1, plus a
`tl_thread_web.h` that contains only the *type* layer (`tlThreadHandle` as `U64`,
`tlThreadId`, `tlThreadPriority`, `tlThreadFlags`) and the design's
"refuse loudly" spawn contract — no scheduler edits, no `jobqueue_web.cpp` yet.

Acceptance, using the harness that already exists:

```powershell
& $py _work/engine-web-spike/build_probe.py after_identity sched `
    -DPLATFORM_WEB -fdelayed-template-parsing -D__restrict= -fdeclspec
# expect jobqueue.cpp 11 -> 0 and jobqueue_kernel.cpp 11 -> 0
```

Why this one: it retires 63 of the 87 remaining diagnostics (72 %) and it is the
only step that unblocks T-005c's A1 gate (`jobqueue.cpp`, `Inflate.cpp`,
`serialiser.cpp`) and every `MT::` consumer behind it. The two cheaper items
(§8.4, §8.3) unblock one TU each and nothing else.

## 10. What this does not prove

- No browser, GPU, WebGPU, audio or input behaviour was exercised. No screenshot
  exists because nothing was rendered.
- No engine module beyond the maths core, `Time` and `endian` was linked, and
  `Vector.cpp` is an empty TU, so the 11,413 B figure is **not** an engine size.
- No runtime behaviour of `MT::Thread`, `MT::Mutex` or the scheduler was
  measured. `Thread.cpp` compiles against the POSIX branch
  (`Thread.cpp:31-37`); whether emscripten's thread stubs without `-pthread`
  would make `MT::Thread::Start/Join` silently no-op was **not** tested, and it
  is a real risk for the T-005c "must assert, never silently pass" rule.
- Error counts are front-end diagnostics, not defect counts; clang stops inside
  a cascading header.
- The overlay proves the 21 tokens are *sufficient*; it does not prove they are
  *accepted* by the MSVC native build (`/W4`, `/permissive`). That has to be
  checked in the phase that owns the source.
- `-std=c++17` was measured and rejected (§4.1); C++14 is used throughout.
  Whether the remaining roughly 1.2 MLOC of engine and game source behaves under
  C++14 once the identity exists is unknown.
- SSE/`_SSE2_` paths were not exercised; the scalar path is what compiled.

## 11. Evidence index

All hashes are SHA-256 prefixes of files produced by this session.

| Path | Size | SHA-256 (16) | Content |
| --- | --- | --- | --- |
| `_work/engine-web-spike/run_spike.py` | 6,870 | `7AD9876F3020D385` | one-command reproduction |
| `_work/engine-web-spike/build_probe.py` | 8,426 | `6601F264CA22CC28` | TU driver (sets, logs, JSON) |
| `_work/engine-web-spike/shims/web_platform.h` | 2,096 | `A7198FD1C5E31250` | platform identity + `__fsel` |
| `_work/engine-web-spike/shims/crt_compat.h` | 1,366 | `5534EA7E53074EB7` | `_TRUNCATE`, `_isnan` |
| `_work/engine-web-spike/patched/CHANGES.txt` | 1,972 | `F9A67FE4B9189848` | overlay manifest (21 tokens) |
| `_work/engine-web-spike/out/spike_maths.wasm` | 11,413 | `4DFB1FD8A56D22E9` | maths + `Matrix.cpp` smoke |
| `_work/engine-web-spike/out/spike_time.wasm` | 10,397 | `34288F7DBF51E7ED` | `Time.cpp` + `endian.cpp` smoke |
| `_work/logs/engine-web-spike/summary.json` | 8,607 | `EAB715AB1C4F7EBF` | all seven sets, sizes, two runs each |
| `_work/engine-web-spike/logs/final_*.log` | 24 TU + 4 driver | — | one compiler log per TU, plus the driver stdout |
| `_work/logs/engine-web-spike/{final_*,ctl_*,shim_only_*}.json` | 7 | — | per-set JSON with the exact `cmd` |
| `_work/engine-web-spike/probes/{repro_lang,repro_lang_nocv,repro_lang_assign,repro_lang_assign_nocv,repro_cast}.cpp` | — | — | header-free proof of cause B |
| `_work/engine-web-spike/probes/{smoke_maths,smoke_time}.cpp` | — | — | the two drivers |
