# T-005 — Engine web shim layer and wasm32 compile spike (P14)

**Date:** 2 November 2026
**Status:** bounded spike, two steps. Step 1 measured the `core/Maths.h` gate; step
2 landed the web platform identity and closed the scheduler compile gate.
No `upstream/`, project source, build file, tool, task card or other analysis
document was modified; the game and the native build were not run. Everything
was produced under `_work/engine-web-spike/` and `_work/logs/engine-web-spike/`.
**Inputs:** `docs/work/analysis/engine-wasm-probe.md` (T-005a measurements),
`docs/work/analysis/t005-scheduler-design.md` (T-005c adapter design).
**Toolchain:** the pinned emsdk in `_work/toolchains/emsdk` — Emscripten 6.0.13,
clang 24.0.0git, `wasm32-unknown-emscripten`, driven through `em++.py` with the
bundled Python.

**No engine claim.** Nothing below says the engine or the game runs. It records
which real translation units the wasm32 front end accepts, which edits and shims
are needed, what a linked module measures, and what still blocks the rest.

---

## 1. Scope and method

Two questions, in order:

1. **Step 1 — how much of the 7-error `core/Maths.h` gate is a shim problem and
   how much is a source problem?**
2. **Step 2 — is the `tl_*` platform identity a shim problem, or five source
   edits plus a type layer?** And once it exists, does the job queue compile?

Method:

1. A `platform/web`-style prelude (`shims/web_platform.h`, `shims/crt_compat.h`)
   is force-included with `-include`. It may contain only standard typedefs, name
   aliases and definitions copied verbatim from the engine with a citation.
2. Every error class is classified as *shim*, *compiler mode* or *source edit*.
   A source edit that the prelude could hide is **not** hidden, so the required
   upstream diff stays visible.
3. To prove a source edit is sufficient without touching `upstream/`, the
   affected headers and two `.cpp` files are copied into
   `_work/engine-web-spike/patched/` by `make_patched_copy.py`, which applies
   exactly the listed tokens and writes the manifest `patched/CHANGES.txt`. The
   overlay is a measurement artifact, never a source of truth.
4. Linked modules are checked against values computed by hand, not just "it
   printed something".
5. A link that cannot be completed is recorded with its exact missing-symbol
   set; a shim that would change runtime behaviour is refused, not added.

## 2. Exact commands

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

# everything: overlay + 9 TU sets + two node smokes + scheduler link attempt
& $py _work/engine-web-spike/run_spike.py

# the overlay alone (writes patched/CHANGES.txt and its sha256)
& $py _work/engine-web-spike/make_patched_copy.py --web-branch alias

# one set, e.g. the control that still reproduces T-005a's 7-error baseline
& $py _work/engine-web-spike/build_probe.py ctl_noshim_maths maths `
    -DPLATFORM_WEB -fdelayed-template-parsing -D__restrict= -fdeclspec
```

Final configuration used everywhere below:

```text
-DBUILD_CONFIG_SPEED -DPLATFORM_WEB -std=c++14
-fdelayed-template-parsing -D__restrict= -fdeclspec
-Wno-nonportable-include-path -Wno-ignored-attributes
-include _work/engine-web-spike/shims/web_platform.h
-I _work/engine-web-spike/patched/core/include        (overlay)
-I _work/engine-web-spike/patched/system/include      (overlay)
-I <library include dirs from matrix.py>
```

`-D_vsnprintf=vsnprintf`, which T-005a needed for the `PLATFORM_PC` probe, is
not needed: `newclib.h:120` gates that branch on `defined(PLATFORM_PC)`, and
`PLATFORM_PC` is absent.

## 3. Results — 39 real engine TUs

`0` means the front end accepted the TU. Failing counts are clang diagnostics,
not defect counts (clang stops inside a cascading header).

### 3.1 The original 24 TUs: 15 → 19 compile, 87 → 22 errors

| TU | step 1 | step 2 | remaining errors |
| --- | --- | --- | --- |
| `core/maths/hvec/{Vector,Matrix,Quaternion,SIMD,Constants}` (5) | 0 | 0 | — |
| `core/source/{utility/endian,containers/String}` (2) | 0 | 0 | — |
| `core/source/allocators/{CoreMemoryNonTracked,stackallocator}` (2) | 0 | 0 | — |
| `core/source/maths/hvec/new/Mat44` | 77 → 0 | 0 | — |
| `misc_shared/{Types/Float16,Geometry/Bounds,archive/handler}` (3) | 0 | 0 | — |
| `misc_shared/Compression/Inflate` | 11 | **0** | — |
| `misc_shared/archive/serialiser` | 10 | **0** | — |
| `system/source/scheduler/jobqueue` | 11 | **0** | — |
| `system/source/scheduler/jobqueue_kernel` | 11 | **0** | — |
| `core/source/threads/{Thread}`, `system/source/time/Time` (2) | 0 | 0 | — |
| `core/source/utility/BizAssert` | 1 | 1 | `_vsnprintf_s` (MSVC secure CRT) |
| `system/source/threads/Mutex` | 7 | 7 | PS3 branch in `Lock`; **0 in the patched copy** |
| `core/source/threads/ThreadLocalStorage` | 1 | 1 | `pthread_key_t` |
| `jobqueue_xenon` | 21 | 10 | Win32 + `JQ_CORE_0` — **not ported** |
| `jobqueue_kernel_xenon` | 14 | 3 | `HANDLE` + `Scheduler::Task` shadowing — **not ported** |

The two Xenon kernel TUs are measured but deliberately not ported: they are
replaced by `jobqueue_web.h` + the spike backend, per T-005c §3.4. Excluding
them, the original set is 19 of 22 TUs at 9 errors.

### 3.2 The 15 TUs added in step 2: 11 compile

| TU | errors | note |
| --- | --- | --- |
| `system/source/scheduler/{jobqueue_task_queue_lf,jobqueue_mem}` (2) | **0** | the lock-free queue and `Spu::Fetch` |
| `core/source/threads/{RwLock}`, `allocators/CoreMemoryAligned` (2) | **0** | |
| `core/source/threads/Event` | 6 | **0 in the patched copy** (2 edits) |
| `system/source/debug/log/{LogManager,Logger,DebugLevel}` (3) | **0** | logging core |
| `core/source/threads/CpuInfo`, `system/source/misc/StringUtil` (2) | **0** | PLATFORM_LINUX branches |
| `system/source/serialise/FilePath`, `debug/log/Format` (2) | **0** | |
| `system/source/io/IoFile` | 1 | `ArteryThreadHandle` undefined in the pthreads branch |
| `core/source/threads/Semaphore` | 1 | `-Wc++11-narrowing`, a real C++11 ill-formedness |
| `system/source/network/Address` | 14 | `struct in_addr` incomplete — network stack |

**Aggregate: 39 distinct engine TUs, 30 compile, 9 fail, 44 errors.** Two of the
nine failures are the Xenon kernel TUs (13 of the 44), so the portable subset is
**30 / 37 at 31 errors**.

## 4. Step 1 — the `core/Maths.h` gate (resolved)

### 4.1 Measurement ladder (`Vector.cpp`, identical for all 5 maths TUs)

| Configuration | shim | overlay | errors |
| --- | --- | --- | --- |
| no compat flags | yes | no | 41 |
| `-D__restrict=` | yes | yes | 14 |
| `-fdelayed-template-parsing` | yes | yes | 21 |
| `-fms-extensions` | yes | yes | 36 |
| `-fdelayed-template-parsing -D__restrict= -fdeclspec` | **no** | no | 7 |
| that, + shim | yes | no | 5 |
| that, + shim, `-std=c++17 -Wno-register` | yes | no | 2 |
| that, + shim | yes | yes | **0** |

Rows 2-4 include the overlay so that cause B (which every one of them hides)
does not mask the effect of the flag being measured. The `7` row reproduces
`engine-wasm-probe.md` §3.2 exactly on the same TU.

`-std=c++17` fixes only 3 of the 5 remaining errors and introduces a `register`
error class (`Geometry.inl:1455-1456`), so it was rejected; C++14 is used.

### 4.2 Root causes

**Cause A — `__fsel` has no platform branch (`MathsUtil.h:1499-1500`).** Those
two lines have no guard at all while the only software definition the engine
ships is compiled for `PLATFORM_PC || PLATFORM_SPU` (`MathsUtil.h:412-414`).
Shimmed with a macro whose body is that same expression.

**Cause B — a cv-qualified conversion-operator return type (5 sites).**
`Vector.inl:6917/7484/8090` and `Geometry.inl:1217/1218` route through
`operator const MathsStorage::Float3() const`. clang will not use a conversion
function whose result type is cv-qualified when the result must be
copy-initialised; MSVC accepts it. Proven without any engine header:

```text
probes/repro_lang.cpp              operator const F()  c++14: 3 errors, c++17: 0
probes/repro_lang_nocv.cpp         operator       F()  c++14: 0
probes/repro_lang_assign.cpp       `out = s;`          c++14: 2, c++17: 1
probes/repro_lang_assign_nocv.cpp                     both: 0
```

Dropping `const` fixes the return form *and* the assignment form at every
language level; `-std=c++17` fixes only the return form. 7 declarations + 7
definitions changed. Semantic impact: **none** (cv-qualification of a returned
prvalue is not observable, and C++17 already discards it).

**Cause C — the `#ifndef PLATFORM_LINUX` guard (48 of `Mat44.cpp`'s 77 errors).**
A non-Windows build falls through `Core.h:181-191` to `PLATFORM_LINUX`, and
`MathsUtil.h:410` gates `Clamp`/`ClampSigned`/`Wrap`/... behind
`#ifndef PLATFORM_LINUX`. It cannot be shimmed without duplicating engine
definitions, so it is a one-line guard change. With it plus `_isnan`,
`Mat44.cpp` goes **77 → 0**.

## 5. Step 2 — the platform identity (landed)

### 5.1 Five edits and two new headers

| Site | Change | Why |
| --- | --- | --- |
| `system/scheduler/core/mercury_to_tl.h:8-10` | `+ #elif defined(PLATFORM_WEB) → #define TL_PLAT_WEB 1` | the mapping only knew SPU/PS3/PC |
| `system/scheduler/core/tl_defs.h:9` | sentinel sum `+ defined(PLATFORM_WEB)` | `#error TL_PLAT_XXX platform specification is missing` |
| `system/scheduler/core/tl_thread.h` | body wrapped `#if TL_PLAT_WEB → tl_thread_web.h → #else → (upstream unchanged)` | every `tl_*` type and function was missing |
| `system/scheduler/jobqueue.h:61-67` | `+ #elif TL_PLAT_WEB → #include "jobqueue_web.h"` | the `#else` reaches the stale `jobqueue_generic.h` |
| `core/maths/MathsUtil.h:410` | `#if !defined(PLATFORM_LINUX) \|\| defined(PLATFORM_WEB)` | cause C above (still needed in this configuration) |

The first version of this document listed `core/Core.h:181` in that table
instead of `jobqueue.h:61-67`. That edit was built and measured; §5.2 shows why
it was dropped.

New, types-only headers (in `_work/engine-web-spike/shims/`, copied into the
overlay):

- **`tl_thread_web.h`** — `tlThreadHandle`/`tlThreadId` as `U64`,
  `tlThreadPriority` as a *total order only* (no OS mapping is invented),
  `tlThreadFlags`, `tlThreadFunction`, `TL_THREAD_FUNCTION`/`TL_THREAD_RETURN`,
  `tl_threadlocal` → `thread_local`. Behaviour, per T-005c §3.2:
  - `tlCreateThread` returns `0` (the invalid handle) and increments a refusal
    counter; it never runs the entry inline (every entry point is a forever-loop).
  - `tlWaitForThread` and `tlExitThread` abort through `tlWebUnsupported()`
    (stderr + `abort()`), never an infinite wait, never a silent `return 0`.
  - `tlSleep` is a logged no-op with a counter (design §3.6.2: never
    `Atomics.wait`, which throws on the browser main thread).
- **`jobqueue_web.h`** — the sibling of `jobqueue_xenon.h` with no `windows.h`
  and `_jqWorker::Thread` as `tlThreadHandle` instead of `HANDLE`.
  `jqProcessor` values are copied verbatim from `jobqueue_xenon.h:18-26`.

`shims/web_runtime.cpp` defines the two fail-loud hooks (`tlWebUnsupported`,
the counters). That is the whole web platform layer: **no engine behaviour is
implemented, and nothing pretends to be parallel.**

### 5.2 `PLATFORM_LINUX` must stay — measured, and it reverses the T-005a proposal

T-005a §5.1 (and the first version of this document) proposed replacing
`PLATFORM_LINUX` with a `PLATFORM_WEB` branch in `core/Core.h:181`. That was
built and measured (`make_patched_copy.py --web-branch full`) and it is **worse**:

| TU | `alias` (PLATFORM_WEB + PLATFORM_LINUX) | `full` (PLATFORM_LINUX removed) |
| --- | --- | --- |
| `system/source/io/IoFile.cpp` | 1 error | **41 errors** |
| `system/source/serialise/FilePath.cpp` | 0 | **2** |
| `jobqueue.cpp` / `jobqueue_kernel.cpp` | 0 / 0 | 0 / 0 |
| all maths TUs | 0 | 0 |

`PLATFORM_LINUX` is the engine's *POSIX* label, not an OS choice: `StringUtil`,
`CpuInfo`, `FilePath.inl`, `ArterySync.h` and the `artery/*` sources all take
their portable branch from it. Removing it turns a working POSIX path into "no
branch". The honest identity for wasm32 is therefore "POSIX fallback + explicit
web backend", and renaming `PLATFORM_LINUX` → `PLATFORM_POSIX` is a separate
refactor, not a prerequisite.

### 5.3 What the identity fixed

`#error TL_PLAT_XXX` and `#error This module is only implemented for PC, Xenon
and Playstation3` are gone, and so is the entire `tl_*` symbol family
(`tlThreadHandle` ×24, `tlThreadFunction` ×12, `TL_THREAD_*` ×12,
`tl_threadlocal` ×2, `Scheduler::jqModule` ×1 — 63 of the 87 step-1 errors).
`jobqueue.cpp`, `jobqueue_kernel.cpp`, `Inflate.cpp` and `serialiser.cpp` —
T-005c's A1 gate — now compile with zero errors. They need the same
compatibility mode as every other TU (`-fdelayed-template-parsing
-D__restrict= -fdeclspec`) but no *per-TU* workaround: no fake `tl_*` define, no
`windows.h` stand-in, no scheduler type stub. The only new input is the two type
headers above plus `shims/web_platform.h`.

## 6. Source edits the shim layer cannot replace

`patched/CHANGES.txt` is the authoritative manifest (39 token substitutions in
12 headers plus 4 in 2 patched `.cpp` files). Grouped by kind:

| Kind | Files | Occurrences | Nature |
| --- | --- | --- | --- |
| cv-qualified conversion operator | `Vector.h`, `Vector.inl` | 14 | grammar |
| `typename` on a dependent using-declaration | `sortedbinarytree.h`, `btl/containers/map.h` | 5 | grammar |
| unqualified name from a dependent base | `sortedbinarytree.h`, `.inl` | 9 | grammar |
| `friend class X::Y` where `Y` is a typedef | `sortedbinarytree.h` | 1 | grammar |
| platform identity (step 2) | 4 scheduler files | 4 | platform |
| `Clamp` guard (step 2) | `MathsUtil.h` | 1 | platform |
| PPC trap → `__builtin_trap()` | `Core.h` (`snPause`) | 1 | codegen-level translation |
| dead POSIX branches made real | `Event.cpp`, `Mutex.cpp` | 4 | platform |
| `Mutex` forward declaration | `Event.h` | 1 | grammar |

Two of these deserve their own note:

- **`Core.h:795` `snPause()` emits `tw 31,1,1`.** `DebugBreak()` expands to it
  and wasm has no encoding for that instruction: `invalid instruction` at
  `jobqueue.cpp:461`. It only appears when compiling to an **object** — every
  `-fsyntax-only` probe in T-005a and in §3 above is blind to it. The web
  translation is `__builtin_trap()`, i.e. wasm `unreachable`: identical contract
  (halt here, unconditionally), no debugger break. Not a stub.
- **The engine's non-Windows branches were never compiled.** `Event.cpp`'s
  `#elif !defined(COMPILER_VC)` body calls `Mutex::Handle()` without including
  `Mutex.h`, and `Mutex.cpp`'s `Lock` class has no POSIX branch at all (it keys
  the PS3 body on the *compiler*). `ArterySync.h` defines `ArteryThreadHandle`
  for Win32 and PS3 only, yet selects `ARTERY_SYNC_PTHREADS` for
  `PLATFORM_LINUX`. These are dead code paths, not port damage, and each is a
  small explicit fix (`patched/src/{Event,Mutex}.cpp` in the overlay).

## 7. What links and runs

### 7.1 Two modules from step 1 (unchanged by step 2)

| Module | Objects | wasm `-O2` | SHA-256 (16) | Output |
| --- | --- | --- | --- | --- |
| `spike_maths.js/.wasm` | `Vector, Constants, SIMD, Matrix, Quaternion` + driver | **11,413 B** | `4DFB1FD8A56D22E9` | `maths_checksum=732`, `inverse_diag_x100=50 25 20 100` |
| `spike_time.js/.wasm` | `Time.cpp`, `endian.cpp` + driver | **10,397 B** | `34288F7DBF51E7ED` | `perf_counter_positive=1`, `perf_counter_freq=1000000` |

Both were executed twice under node 24.19.0 with identical output. The values
match hand calculation (`a+b=(5,7,9)`, `a×b=(-3,6,-3)`, `diag(2,4,5,1)⁻¹ =
diag(0.5,0.25,0.2,1)`), and the inverse comes from `Matrix44InverseCramersRuleFP`,
which is out-of-line in `Matrix.cpp`, so engine object code really executed.
Size caveat: `Vector.cpp` is a 6.6 KB commented-out TU (347 B object); most of
the executed maths is inline header code, so 11,413 B is *not* an engine size.

### 7.2 The scheduler: 16 objects compile, the link is blocked by logging only

All 16 objects below compile at `-O2` (62,013 B of wasm object code total):

```text
jobqueue.o                   10,803 B   jobqueue_kernel.o             2,293 B
jobqueue_task_queue_lf.o      1,980 B   jobqueue_mem.o                  686 B
Thread.o                      2,519 B   RwLock.o                      1,061 B
CoreMemoryAligned.o             608 B   Time.o                        5,594 B
LogManager.o                 11,350 B   Logger.o                      7,356 B
Format.o                      7,545 B   DebugLevel.o                  1,405 B
Event.o (patched copy)        1,499 B   Mutex.o (patched copy)        2,008 B
sched_web.o (spike backend)   3,086 B   smoke_sched.o (driver)        2,220 B
```

The link reports **exactly 11 undefined symbols in 6 classes, all in the logging
subsystem**:

```text
Debug::ConsoleSubscriber::{ctor,dtor}       Debug::LogFileSubscriber::{ctor,dtor}
Debug::SocketSubscriber::{ctor,dtor}        Debug::SocketServerSubscriber::{ctor,dtor}
Debug::EMailSubscriber::{ctor,dtor}         Network::GetHostName()
```

No scheduler-side symbol is missing. `LogManager` constructs all five
subscribers unconditionally, so the logger reaches the socket stack and SMTP
before any job can run; `Address.cpp` itself does not compile (14 errors,
`struct in_addr` incomplete). `run_spike.py` compares this set against the
recorded expectation, so a change on the scheduler side fails the run.

`shims/sched_web.cpp` is the backend the design asks for (without it `_Init`,
`_Start`, `Flush`, `_AddTask`, `jqExecuteBatch` … were undefined). It implements
`_Init` (`jqMaxWorkers=0`), `_Start` (no contexts), `_jqStop`, `_AddTask`,
`jqAlertWorker`, `jqWorkerSleep`→`false`, a plain batch-pool counter, and `Flush`
as an inline drain that **ignores `bRunJobs`** (the documented deviation) and
aborts on a `JQ_GROUP_LABEL`/`JQ_GROUP_SPURWLOCK` dependency.
`probes/smoke_sched.cpp` drives `CreatePolicy → Init → Start → AddTask → Flush →
Poll → Shutdown` but **cannot be run yet** — it links only once the logging
blocker is gone.

No new `.wasm` exists, so no new size is claimed for the scheduler.

## 8. Remaining blockers, ordered by cost

1. **`platform/log` — the last thing between the scheduler and a running job.**
   `LogManager` registers five subscribers (console, file, socket, socket-server,
   SMTP) by default; wasm needs a documented default set (console only) selected
   by platform, plus a decision on whether `LogFileSubscriber` is wanted at all.
   This is an engine decision, not a shim: faking `Debug::GetLogger` would change
   which logging exists. Cost: 1 platform branch in `LogManager.cpp` (+1 file per
   subscriber that is kept). **Blocks: every TU that calls `Debug::GetLogger` or
   a `LOG*` macro** — job queue, physics, streaming, audio — i.e. any real engine
   module, but not `Time.cpp` or the maths core.
2. **The dead POSIX branches (6 sites).** `Event.cpp` (2 edits) and `Mutex.cpp`
   `Lock` (2 edits) are already fixed in the overlay; `ArterySync.h`
   `ArteryThreadHandle` for `ARTERY_SYNC_PTHREADS` (`IoFile.cpp`),
   `Semaphore.cpp:128` `-Wc++11-narrowing`, and
   `ThreadLocalStorage.h:111` `pthread_key_t` are not. Each is a small explicit
   fix; none is a design decision.
3. **The network stack** (`system/source/network/Address.cpp`, 14 errors:
   `struct in_addr` incomplete; `Network::GetHostName` in the logger's static
   init). Either fix the include or make the host name platform-provided.
   Cost: unknown, first real look at the network layer.
4. **`_vsnprintf_s`** (`BizAssert.cpp:66`, 1 error). MSVC's secure variant has a
   different truncation contract than `vsnprintf`, so a name alias would be a
   silent semantic change. Cost: 1 wrapper or 1 call-site branch.
5. **`jobqueue_web.cpp` proper** — the spike backend exists but policy
   **flattening is not implemented** (T-005c §3.5). With one context and the game
   table, `piStreamer = {0,0,7,7,7,7,7,7}` is never popped and `Flush` on that
   group cannot terminate. The fix belongs in `CreatePolicy`
   (`jobqueue.cpp:485`), which is shared code. The smoke uses a column-uniform
   policy and therefore does **not** exercise the defect.
6. **DX11 / FX11** — untouched by both steps. T-005a's inventory still stands
   (442 D3D11/FX11 matches in `display`, 43 in `display2`, 33 in `render`). This
   is the only blocker whose cost is not bounded.

## 9. The single next smallest step

**Give `platform/log` a web default so the scheduler module links.** Concretely:
a `PLATFORM_WEB` branch in `system/source/debug/log/LogManager.cpp` that
registers only the console subscriber, and `Network::GetHostName()` answered from
the platform layer instead of the socket stack. No subscriber is deleted; the
socket/SMTP ones are simply not constructed on a target that has no sockets.

Acceptance, with the harness that already exists:

```powershell
& $py _work/engine-web-spike/run_spike.py
# expect: scheduler link  compiled=16 link=ok  missing=0
# and   : ran=1 / job_result=42 / queued=0 executing=0 poll=1 / workers=0 max_workers=0
```

Why this one: it is the only remaining symbol group, it turns the 16 compiled
objects into the first executable scheduler in the project, and it is the same
`platform/log` item that T-005a §3.4 already found in zlib's link closure — so
it pays twice. The alternative order (finish the dead-branch TUs and the network
stack first) would unblock at most four TUs and still leave the module
unlinkable.

## 10. What this does not prove

- No browser, GPU, WebGPU, audio or input behaviour was exercised; nothing was
  rendered, so there is no screenshot.
- **The scheduler was never executed.** Its module does not link yet. Every
  claim about `Flush`/`jqWorkerLoop` behaviour in `shims/sched_web.cpp` is
  design-derived and unverified at runtime.
- No engine module beyond maths, `Time`, `endian` was linked, and `Vector.cpp` is
  empty, so 11,413 B is not an engine size.
- `MT::Thread`/`MT::Mutex`/`MT::Event` runtime behaviour was not measured.
  `Thread.cpp` compiles against its POSIX branch; whether emscripten's thread
  stubs without `-pthread` make `MT::Thread::Start/Join` silently no-op was not
  tested — a live risk for the "must assert, never silently pass" rule.
- `-fsyntax-only` hides codegen-level problems (that is how `snPause` survived
  every syntax-only run in §3). Only the 16 scheduler objects and the two smoke
  modules were compiled to objects; the rest were syntax-checked only.
- The overlay proves the edits are *sufficient* for clang; it does not prove the
  MSVC native build accepts them (`/W4`, `/permissive`). That must be checked in
  the phase that owns the source.
- Error counts are front-end diagnostics, not defect counts.
- SSE/`_SSE2_` paths were not exercised; the scalar path is what compiled.

## 11. Evidence index

All hashes are SHA-256 prefixes of files produced by this session.

| Path | Size | SHA-256 (16) | Content |
| --- | --- | --- | --- |
| `_work/engine-web-spike/run_spike.py` | 11,482 | `02943D3C580A52BC` | one-command reproduction |
| `_work/engine-web-spike/build_probe.py` | 10,199 | `3C0C52B9D2FDB13C` | TU driver (sets, logs, JSON) |
| `_work/engine-web-spike/make_patched_copy.py` | 16,589 | `1FAF9D883E0C5674` | overlay generator + manifest |
| `_work/engine-web-spike/patched/CHANGES.txt` | 8,336 | `E6D910CA052FCCD4` | the authoritative edit list (39 tokens) |
| `_work/engine-web-spike/shims/web_platform.h` | 2,096 | `A7198FD1C5E31250` | identity + `__fsel` |
| `_work/engine-web-spike/shims/crt_compat.h` | 1,366 | `5534EA7E53074EB7` | `_TRUNCATE`, `_isnan` |
| `_work/engine-web-spike/shims/tl_thread_web.h` | 4,318 | `5CA770AD7E63775D` | `TL_PLAT_WEB` type layer + fail-loud stubs |
| `_work/engine-web-spike/shims/jobqueue_web.h` | 2,309 | `C9EEE1F93E1FBA51` | scheduler type layer |
| `_work/engine-web-spike/shims/sched_web.cpp` | 5,686 | `7A8048E15B6822B0` | single-context scheduler backend (spike) |
| `_work/engine-web-spike/shims/web_runtime.cpp` | 824 | `F4C64D01EF125D51` | `tlWebUnsupported` = stderr + `abort()` |
| `_work/engine-web-spike/probes/smoke_sched.cpp` | 2,057 | `575819279E672CD4` | driver for the cooperative path (links later) |
| `_work/engine-web-spike/out/spike_maths.wasm` | 11,413 | `4DFB1FD8A56D22E9` | maths + `Matrix.cpp` smoke |
| `_work/engine-web-spike/out/spike_time.wasm` | 10,397 | `34288F7DBF51E7ED` | `Time.cpp` + `endian.cpp` smoke |
| `_work/logs/engine-web-spike/summary.json` | 13,138 | `FD58BA30D7E2B97E` | all 9 sets, both smokes, link expectation |
| `_work/logs/engine-web-spike/final_*.json` | 9 | — | per-set results with the exact `cmd` |
| `_work/engine-web-spike/logs/final_*.log` | 45 TU logs | — | one compiler log per TU |
| `_work/engine-web-spike/logs/spike_sched.link.log` | 4,700 | `9104EBEB8DEA1D9B` | the 11 missing logging symbols |
| `_work/engine-web-spike/logs/schedlink__*.obj.log` | 16 | — | scheduler object compiles |
