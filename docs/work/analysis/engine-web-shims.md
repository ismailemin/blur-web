# T-005 — Engine web shim layer and wasm32 compile spike (P14)

**Date:** 2 November 2026
**Status:** bounded spike, three steps. Step 1 measured the `core/Maths.h` gate,
step 2 landed the web platform identity, step 3 closed the first *executable*
engine module: a scheduler job runs under node with `ran=1`.
No `upstream/`, project source, build file, tool, task card or other analysis
document was modified; the game and the native build were not run. Everything
was produced under `_work/engine-web-spike/` and `_work/logs/engine-web-spike/`.
**Inputs:** `docs/work/analysis/engine-wasm-probe.md` (T-005a measurements),
`docs/work/analysis/t005-scheduler-design.md` (T-005c adapter design).
**Toolchain:** the pinned emsdk in `_work/toolchains/emsdk` — Emscripten 6.0.13,
clang 24.0.0git, `wasm32-unknown-emscripten`, driven through `em++.py` with the
bundled Python.

**No engine and no game claim.** One scheduler job on a synthetic policy is not
the engine running, and no renderer, audio, input or game logic was involved.
What is claimed: 22 real engine TUs link into one wasm module, and one job goes
through `AddTask → Flush → jqWorkerLoop → jqExecuteBatch` exactly once with the
expected result.

**Policy, explicitly:** the single execution context of T-005c §3. A serial
cooperative scheduler, not a thread pool. `_Init` sets `jqMaxWorkers = 0`, no
worker context is created, `Flush` drains on the caller and ignores `bRunJobs`,
and `MT::Thread`/`Mutex`/`Event` are never asked to block. It is **not** a
thread-safe implementation and must not be described as one.

## 1. Scope and method

Three questions, in order:

1. **Step 1** — how much of the 7-error `core/Maths.h` gate is a shim problem and
   how much is a source problem?
2. **Step 2** — is the `tl_*` platform identity a shim problem, or five source
   edits plus a type layer? And does the job queue compile once it exists?
3. **Step 3** — what does it take to *link and run* one job through the
   cooperative path, and which of the remaining symbols have a real web
   behaviour?

Method:

1. A `platform/web`-style prelude (`shims/web_platform.h`, `shims/crt_compat.h`)
   is force-included with `-include`. It may contain only standard typedefs, name
   aliases and definitions copied verbatim from the engine with a citation.
2. Every error class is classified as *shim*, *compiler mode* or *source edit*.
   A source edit that the prelude could hide is **not** hidden, so the required
   upstream diff stays visible.
3. To prove a source edit is sufficient without touching `upstream/`, the
   affected headers and `.cpp` files are copied into
   `_work/engine-web-spike/patched/` by `make_patched_copy.py`, which applies
   exactly the listed tokens and writes the manifest `patched/CHANGES.txt`.
4. A symbol gets a web implementation only when the operation is genuinely
   defined for the target (a fence, a CAS, a host name). If it is not, the build
   stops and the gap is documented — nothing is stubbed to "make it link".
5. Linked modules are checked against values computed by hand, and every run is
   repeated to show determinism.

## 2. Exact commands

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

# everything: overlay + 9 TU sets + three node modules (two maths/system, one scheduler)
& $py _work/engine-web-spike/run_spike.py

# the scheduler module alone is built and run by the same script; the exact
# link line is the 22 objects in SCHED_TUS, then:
#   em++ <22 .o> -sENVIRONMENT=node -o out/spike_sched.js
#   node out/spike_sched.js            (twice; output must be identical)

# the overlay alone (writes patched/CHANGES.txt and its sha256)
& $py _work/engine-web-spike/make_patched_copy.py --web-branch alias

# one set, e.g. the control that still reproduces T-005a's 7-error baseline
& $py _work/engine-web-spike/build_probe.py ctl_noshim_maths maths `
    -DPLATFORM_WEB -fdelayed-template-parsing -D__restrict= -fdeclspec
```

Final configuration used everywhere:

```text
-DBUILD_CONFIG_SPEED -DPLATFORM_WEB -std=c++14
-fdelayed-template-parsing -D__restrict= -fdeclspec
-Wno-nonportable-include-path -Wno-ignored-attributes
-include _work/engine-web-spike/shims/web_platform.h
-I _work/engine-web-spike/patched/core/include        (overlay)
-I _work/engine-web-spike/patched/system/include      (overlay)
-I <library include dirs from matrix.py>
```

`-D_vsnprintf=vsnprintf`, which T-005a needed for the `PLATFORM_PC` probe, is not
needed: `newclib.h:120` gates that branch on `defined(PLATFORM_PC)`.

## 3. Compile results — 39 real engine TUs

`0` means the front end accepted the TU. Failing counts are clang diagnostics, not
defect counts.

### 3.1 The original 24 TUs: 15 → 19 compile, 87 → 22 errors

| TU | step 1 | step 2/3 | remaining errors |
| --- | --- | --- | --- |
| `core/maths/hvec/{Vector,Matrix,Quaternion,SIMD,Constants}` (5) | 0 | 0 | — |
| `core/source/{utility/endian,containers/String}` (2) | 0 | 0 | — |
| `core/source/allocators/{CoreMemoryNonTracked,stackallocator}` (2) | 0 | 0 | — |
| `core/source/maths/hvec/new/Mat44` | 77 → 0 | 0 | — |
| `misc_shared/{Types/Float16,Geometry/Bounds,archive/handler}` (3) | 0 | 0 | — |
| `misc_shared/Compression/Inflate`, `archive/serialiser` (2) | 11 / 10 | **0** | — |
| `system/source/scheduler/jobqueue`, `jobqueue_kernel` (2) | 11 / 11 | **0** | — |
| `core/source/threads/Thread`, `system/source/time/Time` (2) | 0 | 0 | — |
| `core/source/utility/BizAssert` | 1 | 1 | `_vsnprintf_s` (MSVC secure CRT) |
| `system/source/threads/Mutex` | 7 | 7 | PS3 branch in `Lock`; **0 in the patched copy** |
| `core/source/threads/ThreadLocalStorage` | 1 | 1 | `pthread_key_t` |
| `jobqueue_xenon` | 21 | 10 | Win32 + `JQ_CORE_0` — **not ported** |
| `jobqueue_kernel_xenon` | 14 | 3 | `HANDLE` + `Scheduler::Task` shadowing — **not ported** |

### 3.2 The 15 TUs added in step 2

| TU | errors | note |
| --- | --- | --- |
| `scheduler/{jobqueue_task_queue_lf,jobqueue_mem}`, `{RwLock,CoreMemoryAligned}` (4) | **0** | the lock-free queue, `Spu::Fetch`, the RW lock, the aligned allocator |
| `debug/log/{LogManager,Logger,DebugLevel}` (3) | **0** | logging core |
| `{CpuInfo,StringUtil,FilePath,Format}` (4) | **0** | PLATFORM_LINUX branches |
| `core/source/threads/Event` | 6 | **0 in the patched copy** (2 edits) |
| `system/source/io/IoFile` | 1 | `ArteryThreadHandle` missing in the pthreads branch |
| `core/source/threads/Semaphore` | 1 | `-Wc++11-narrowing`, real C++11 ill-formedness |
| `system/source/network/Address` | 14 | `struct in_addr` incomplete — network stack |

**Aggregate: 39 distinct engine TUs, 30 compile, 9 fail, 44 errors.** Two of the
nine are the Xenon kernel TUs (13 of the 44), so the portable subset is
**30 / 37 at 31 errors**. The remaining failures are all outside the scheduler
closure (§8).

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

Rows 2-4 include the overlay so that cause B does not mask the flag being
measured. The `7` row reproduces `engine-wasm-probe.md` §3.2 exactly.
`-std=c++17` fixes only 3 of the 5 remaining errors and adds a `register` error
class, so it was rejected; C++14 is used.

### 4.2 Root causes

**Cause A — `__fsel` has no platform branch (`MathsUtil.h:1499-1500`).** The two
call sites have no guard while the only software definition the engine ships is
compiled for `PLATFORM_PC || PLATFORM_SPU` (`MathsUtil.h:412-414`). Shimmed with a
macro whose body is that same expression.

**Cause B — a cv-qualified conversion-operator return type (5 sites).**
`Vector.inl:6917/7484/8090` and `Geometry.inl:1217/1218` route through
`operator const MathsStorage::Float3() const`. clang will not use a conversion
function whose result type is cv-qualified when the result must be
copy-initialised; MSVC accepts it. Proven without any engine header
(`probes/repro_lang*.cpp`): dropping `const` fixes the return form *and* the
assignment form at every language level; `-std=c++17` fixes only the return form.
Semantic impact: none.

**Cause C — the `#ifndef PLATFORM_LINUX` guard (48 of `Mat44.cpp`'s 77 errors).**
`MathsUtil.h:410` gates `Clamp`/`ClampSigned`/`Wrap`/... behind
`#ifndef PLATFORM_LINUX`. Cannot be shimmed without duplicating engine
definitions, so it is a one-line guard change. With it plus `_isnan`,
`Mat44.cpp` goes **77 → 0**.

## 5. Step 2 — the platform identity

### 5.1 Five edits and two new headers

| Site | Change | Why |
| --- | --- | --- |
| `scheduler/core/mercury_to_tl.h:8-10` | `+ #elif defined(PLATFORM_WEB) → #define TL_PLAT_WEB 1` | the mapping only knew SPU/PS3/PC |
| `scheduler/core/tl_defs.h:9` | sentinel sum `+ defined(PLATFORM_WEB)` | `#error TL_PLAT_XXX platform specification is missing` |
| `scheduler/core/tl_thread.h` | body wrapped `#if TL_PLAT_WEB → tl_thread_web.h → #else → (upstream unchanged)` | every `tl_*` type and function was missing |
| `scheduler/jobqueue.h:61-67` | `+ #elif TL_PLAT_WEB → #include "jobqueue_web.h"` | the `#else` reaches the stale `jobqueue_generic.h` |
| `core/maths/MathsUtil.h:410` | `#if !defined(PLATFORM_LINUX) \|\| defined(PLATFORM_WEB)` | cause C above |

New, types-only headers (in `shims/`, copied into the overlay):

- **`tl_thread_web.h`** — `tlThreadHandle`/`tlThreadId` as `U64`,
  `tlThreadPriority` as a *total order only* (no OS mapping is invented),
  `tlThreadFlags`, `tlThreadFunction`, `tl_threadlocal` → `thread_local`.
  `tlCreateThread` returns `0` (the invalid handle) and counts the refusal; it
  never runs the entry inline. `tlWaitForThread`/`tlExitThread` abort through
  `tlWebUnsupported()` (stderr + `abort()`), never an infinite wait, never a
  silent `return 0`. `tlSleep` is a logged no-op (never `Atomics.wait`).
- **`jobqueue_web.h`** — the sibling of `jobqueue_xenon.h` without `windows.h`,
  with `_jqWorker::Thread` as `tlThreadHandle`. `jqProcessor` values are copied
  verbatim from `jobqueue_xenon.h:18-26`.

`shims/web_runtime.cpp` defines the fail-loud hooks and the counters.

### 5.2 `PLATFORM_LINUX` must stay — measured, and it reverses the T-005a proposal

Replacing `PLATFORM_LINUX` with a `core/Core.h:181` branch
(`make_patched_copy.py --web-branch full`) was built and measured, and it is
**worse**:

| TU | `alias` (PLATFORM_WEB + PLATFORM_LINUX) | `full` (PLATFORM_LINUX removed) |
| --- | --- | --- |
| `system/source/io/IoFile.cpp` | 1 error | **41 errors** |
| `system/source/serialise/FilePath.cpp` | 0 | **2** |
| `jobqueue.cpp` / `jobqueue_kernel.cpp` | 0 / 0 | 0 / 0 |

`PLATFORM_LINUX` is the engine's *POSIX* label, not an OS choice: `StringUtil`,
`CpuInfo`, `FilePath.inl`, `ArterySync.h` and the `artery/*` sources take their
portable branch from it. Renaming it to `PLATFORM_POSIX` is a separate refactor.

### 5.3 What the identity fixed

Both `#error`s and the whole `tl_*` family are gone (63 of the 87 step-1 errors).
`jobqueue.cpp`, `jobqueue_kernel.cpp`, `Inflate.cpp` and `serialiser.cpp` — T-005c's
A1 gate — compile with zero errors and no per-TU workaround.

## 6. Step 3 — `platform/log` and `platform/atomic`

### 6.1 `platform/log`: a retention list and one host name

`LogManager::LogManager()` calls `BugBashingBodge()` (`LogManager.cpp:18-26`),
which exists only to force linker retention: it constructs five subscribers and
destroys them, and **registers nothing**. Restricting that list therefore does
not change which subscribers a logger has or which messages are logged.

```cpp
#if defined( PLATFORM_WEB )        // patched copy
	ConsoleSubscriber dummy2;      // file / socket / socket-server / SMTP cannot exist
#else
	LogFileSubscriber dummy1;  ConsoleSubscriber dummy2;  SocketSubscriber dummy3;
	SocketServerSubscriber dummy4;  EMailSubscriber dummy5;
#endif
```

`Network::GetHostName()` (`Logger.cpp:80`, the host field of every log record)
lives in `system/source/network/Address.cpp`, which cannot compile for wasm32
(14 errors, `struct in_addr` incomplete). The platform layer supplies it
(`shims/platform_net_web.cpp`) and returns the fixed string **`"web-local"`**.
Rationale, recorded in the file: a web build has no host identity and
`gethostname()` has no meaning under wasm; an empty string would be
indistinguishable from a failure and would leave an empty field in every record,
while `"web-local"` cannot be mistaken for a resolved machine name. It is not a
network identity and nothing resolves it.

With those two changes the five subscriber classes, `Address.cpp` and the
socket stack leave the link.

### 6.2 `platform/atomic`: the engine had no web branch at all

`core/threads/Atomic.h` is a chain of `#if PLATFORM_PC / PS3 / SPU / REVOLUTION`
blocks with **no `#else`**. On wasm32 every one of the 17 active functions had an
empty body, and the non-void ones fell off the end — undefined behaviour that
clang lowers to a wasm `unreachable` **trap**. The first run died exactly there:

```text
RuntimeError: unreachable
  at Scheduler::jqAtomicQueue::AllocateNode()      <- 8-byte queue CAS
  at MT::AtomicAdd(unsigned long long volatile*, unsigned long long)
  at Scheduler::AddTaskToQueue(...)
```

All 17 active overloads now have a web branch implemented with the `__atomic_*`
builtins — the same operations the PC path performs with `Interlocked*`, so this
is a platform implementation, not an approximation:

| Function | Web implementation |
| --- | --- |
| `MemoryFence` | `__atomic_thread_fence(__ATOMIC_SEQ_CST)` |
| `AtomicCompareAndSwap` (U32, U64) | `__atomic_compare_exchange_n(..., __ATOMIC_SEQ_CST, ...)` |
| `AtomicAdd` (U32, U64), `AtomicAnd/Or` (U32, U64) | `__atomic_fetch_*` |
| `AtomicIncrement/Decrement` (int, S64) | `__atomic_fetch_add/sub` (returns the *old* value, as the PC path does) |
| `AtomicGet/Set` (U32, U64) | `__atomic_load_n` / `__atomic_store_n` |

The 8-byte queue CAS is worth its own line because T-005c §6.5 left it open:
`jqAtomicQueuePtr` is `{ T* Ptr; unsigned Count; }` — `sizeof = 8`,
`__alignof__ = 4` on wasm32, i.e. **4-aligned**, unlike the 8-aligned x64 layout.
`probes/probe_queue_cas.cpp` shows the misaligned 8-byte CAS works and returns the
expected old value, so no atomic-alignment rework is required. Whether emscripten
lowers it to a real atomic instruction is irrelevant here: this build has one
context, and the module contains no `-matomics`.

## 7. What links and runs

### 7.1 The scheduler module

**22 objects, 86,986 B of wasm object code → `spike_sched.wasm`, 59,140 B at
`-O2` — the first engine module in this project that both links and executes a
job.** No symbol is resolved by a stub.

```text
jobqueue.o              jobqueue_kernel.o      jobqueue_task_queue_lf.o
jobqueue_mem.o          Thread.o               RwLock.o
CoreMemoryAligned.o     Time.o                 Logger.o
Format.o                DebugLevel.o           Filter.o
ThreadContext.o         ConsoleSubscriber.o    SubscriberCommon.o
SubscriberManager.o     LogManager.o*          Mutex.o*
Event.o*                platform_net_web.o†    sched_web.o†
smoke_sched.o†
  * patched copy of an engine .cpp   † spike source, not engine code
```

Run output (`node`, exit 0, twice, identical):

```text
step=policy
step=init
step=start
step=pool
step=group
step=add
step=flush
ran=1
job_result=42
queued=0 executing=0 poll=1
workers=0 max_workers=0
step=shutdown
```

That is one job through `CreatePolicy → Init → Start → SetGroupPoolSize →
CreateGroup → AddTask → Flush(Poll) → DestroyGroup → Shutdown`. The job body
writes `in + 1`, `in = 41`, so `job_result=42`; `ran=1` proves it executed
exactly once; `workers=0`, `max_workers=0` and `queued/executing = 0/0` are the
single-context contract, and `poll=1` is `Poll()` satisfied afterwards.

Three things the run exposed, all recorded because they are engine facts and not
spike bugs:

1. **Call order matters.** The game calls `Init()`, `Start()` and *then*
   `SetGroupPoolSize(...)` (`SchedulerConfig.cpp:56-60`). A driver that creates a
   group before setting the pool indexes a NULL `jqPool.BatchGroupPool` — it
   corrupted the emscripten stack cookie at `0x4` before the driver was fixed.
   `CreateGroup` has no size check of its own.
2. **`Start()` allocates `sizeof(jqWorker) * 0`.** With `jqMaxWorkers = 0` that
   malloc is zero-sized and may return a non-null pointer, so `jqWorkers != NULL`
   is not a fault by itself. `_jqStop` frees it and asserts `jqNWorkers == 0`.
3. **`CFG_SPEED` disables `BIZ_ASSERT`** (`BizAssert.h:146-147`), so the
   `iCPUBits != 0` guard in `AddTaskToQueue` is inert in this build. The smoke
   does not rely on it: policy `{5,5,5,5,5,5,5,5}` yields `iCPUBits = 0xFF`.

### 7.2 The two earlier modules (unchanged)

| Module | Objects | wasm `-O2` | SHA-256 (16) | Output |
| --- | --- | --- | --- | --- |
| `spike_maths.js/.wasm` | 5 maths TUs + driver | 11,413 B | `4DFB1FD8A56D22E9` | `maths_checksum=732`, `inverse_diag_x100=50 25 20 100` |
| `spike_time.js/.wasm` | `Time.cpp`, `endian.cpp` | 10,397 B | `34288F7DBF51E7ED` | `perf_counter_positive=1`, `perf_counter_freq=1000000` |

Both values match hand calculation. `Vector.cpp` is a 6.6 KB commented-out TU, so
most of the maths is inline header code and 11,413 B is not an engine size.

## 8. Remaining blockers, ordered by cost

1. **Policy flattening is still not implemented** (T-005c §3.5). With one context
   the game table's `piStreamer = {0,0,7,7,7,7,7,7}` is disabled by
   `GenerateWorkerPolicyOrder` (column 0), so a streamer task would never run and
   `Flush` on that group would not terminate. The fix belongs in `CreatePolicy`
   (`jobqueue.cpp:485`), which is shared code. **The smoke uses a column-uniform
   policy and therefore does not exercise this defect** — it is the first thing
   `jobqueue_web.cpp` must fix, and T-005c's A3 test exists for it.
2. **The dead POSIX branches (5 sites).** `Event.cpp`/`Mutex.cpp` are already
   fixed in the overlay; `ArterySync.h` `ArteryThreadHandle` for
   `ARTERY_SYNC_PTHREADS` (`IoFile.cpp`), `Semaphore.cpp:128`
   `-Wc++11-narrowing`, `ThreadLocalStorage.h:111` `pthread_key_t` are not.
3. **The network stack** (`Address.cpp`, 14 errors, `struct in_addr` incomplete).
   Needed only for real networking; the logger no longer depends on it.
4. **`_vsnprintf_s`** (`BizAssert.cpp:66`, 1 error). MSVC's secure variant has a
   different truncation contract than `vsnprintf`; a name alias would be a silent
   semantic change, so it is 1 wrapper or 1 call-site branch.
5. **The Xenon kernel TUs** (13 errors) — deliberately not ported, replaced by
   `jobqueue_web.h` + `shims/sched_web.cpp`.
6. **DX11 / FX11** — untouched. T-005a's inventory stands (442 D3D11/FX11 matches
   in `display`, 43 in `display2`, 33 in `render`); the only blocker whose cost is
   not bounded.

## 9. The single next smallest step

**Turn `shims/sched_web.cpp` into a real `jobqueue_web.cpp` + `jobqueue_web_kernel.cpp`
inside `upstream/`, with policy flattening, and prove it with the A2/A3/A4 tests
of T-005c §5.2.**

Concretely:

1. Move the two spike files into the engine next to `jobqueue_xenon.cpp`, under
   `TL_PLAT_WEB`, keeping the same contract (`jqMaxWorkers = 0`, `Flush` drains,
   `bRunJobs` ignored, fence dependencies abort).
2. Put the flattening in `CreatePolicy`: for each policy take the maximum of its
   8 columns and replicate it, so column 0 cannot disable a policy and
   `iCPUBits != 0` holds.
3. Extend `probes/smoke_sched.cpp` with the A3 case — one task per game policy,
   including `{0,0,7,7,7,7,7,7}` — and the A4 assertions (`GetNumWorkers() == 0`,
   `Flush(group,false)` completes and runs the task).

Acceptance, with the harness that already exists:

```powershell
& $py _work/engine-web-spike/run_spike.py
# expect: scheduler link  link=ok output_matches=True
# and   : ran=1 / job_result=42 / queued=0 executing=0 poll=1 / workers=0
#         plus one success line per policy, including the streamer policy
```

Why this one: it is the difference between *a* scheduler spike and *the* scheduler
the engine can call, and it retires the single most likely silent failure in the
slice (a streamer `Flush` that never terminates). Everything else on the blocker
list is either outside the scheduler (network, DX11) or costs one TU.

## 10. What this does not prove

- **No browser, GPU, audio, input, physics or game logic.** One job on a
  synthetic policy is the whole runtime evidence. No screenshot exists.
- **Not thread-safe, not parallel.** Nothing exercised two contexts; `MT::Mutex`,
  `MT::Event` and `MT::Thread` were linked but never contended or joined. Whether
  emscripten's thread stubs without `-pthread` make `MT::Thread::Start/Join`
  silently no-op was not tested — a live risk for the "must assert, never
  silently pass" rule.
- **The real game policy table was not used.** The smoke's policy is
  column-uniform on purpose, so the column-0 defect (§8.1) is untested.
- Only the 22 scheduler objects and the three sample modules were compiled to
  objects; the rest of §3 was syntax-checked only, and `-fsyntax-only` hides
  codegen-level problems (that is how the `snPause` PPC trap survived step 2).
- No engine size claim: 59,140 B includes the emscripten runtime, libc and libc++
  and is dominated by `LogManager`/`Logger`/`Format`.
- The overlay proves the edits are *sufficient* for clang; it does not prove the
  MSVC native build accepts them (`/W4`, `/permissive`). That must be checked in
  the phase that owns the source.
- Error counts are front-end diagnostics, not defect counts.

## 11. Evidence index

All hashes are SHA-256 prefixes of files produced by this session.

| Path | Size | SHA-256 (16) | Content |
| --- | --- | --- | --- |
| `_work/engine-web-spike/out/spike_sched.wasm` | 59,140 | `132EF3BA0FB9FD05` | **the scheduler module; 22 engine objects** |
| `_work/engine-web-spike/out/spike_sched.js` | 64,079 | `DACEBA65F4FF30C8` | node loader for the above |
| `_work/engine-web-spike/out/spike_maths.wasm` | 11,413 | `4DFB1FD8A56D22E9` | maths + `Matrix.cpp` sample |
| `_work/engine-web-spike/out/spike_time.wasm` | 10,397 | `34288F7DBF51E7ED` | `Time.cpp` + `endian.cpp` sample |
| `_work/engine-web-spike/shims/sched_web.cpp` | 5,964 | `AF923B3397D3CA26` | single-context scheduler backend (spike) |
| `_work/engine-web-spike/shims/platform_net_web.cpp` | 1,124 | `8C43A5177ECA2AAC` | `Network::GetHostName()` → `"web-local"` |
| `_work/engine-web-spike/shims/tl_thread_web.h` | 4,318 | `5CA770AD7E63775D` | `TL_PLAT_WEB` type layer + fail-loud stubs |
| `_work/engine-web-spike/shims/jobqueue_web.h` | 2,309 | `C9EEE1F93E1FBA51` | scheduler type layer |
| `_work/engine-web-spike/patched/CHANGES.txt` | 15,356 | `761580260097649B` | the authoritative edit manifest |
| `_work/logs/engine-web-spike/summary.json` | 13,770 | `72F97E019D19D766` | all 9 sets, three modules, expected output |
| `_work/engine-web-spike/logs/spike_sched.run{1,2}.log` | 172 each | `F3174592FE2146F2` | the two identical runs (exit 0) |
| `_work/engine-web-spike/logs/schedlink__*.obj.log` | 22 | — | one object compile per scheduler TU |
| `_work/engine-web-spike/probes/probe_queue_cas.cpp` | 999 | `3FC27ED1CD265A06` | 8-byte CAS on the 4-aligned queue pointer |
| `_work/engine-web-spike/probes/smoke_sched.cpp` | 3,146 | `0B696F61497D9461` | the driver, with `stop after step N` |
| `_work/engine-web-spike/run_spike.py` | 12,615 | `21B954D029B941A5` | one-command reproduction |
