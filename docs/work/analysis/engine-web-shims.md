# T-005 — Engine web shim layer and wasm32 compile spike (P14)

**Date:** 2 November 2026
**Status:** bounded spike, five steps. Step 1 measured the `core/Maths.h` gate,
step 2 landed the web platform identity, step 3 produced the first executable
engine module (one scheduler job), step 4 moved the backend into the engine as
`jobqueue_web.cpp`, added policy flattening, and ran the T-005c A3/A4 cases;
step 5 exported the whole thing as a reviewable patch, re-applied it to a fresh
upstream tree, ran a real engine caller through the queue, and proved the PC
translation unit unchanged.
No `upstream/`, project source, build file, tool, task card or other analysis
document was modified; the game and the native build were not run. Everything
was produced under `_work/engine-web-spike/` and `_work/logs/engine-web-spike/`.
**Inputs:** `docs/work/analysis/engine-wasm-probe.md` (T-005a measurements),
`docs/work/analysis/t005-scheduler-design.md` (T-005c adapter design).
**Toolchain:** the pinned emsdk in `_work/toolchains/emsdk` — Emscripten 6.0.13,
clang 24.0.0git, `wasm32-unknown-emscripten`, driven through `em++.py` with the
bundled Python.

**No engine and no game claim.** Four policies on one synthetic job each is not
the engine running, and no renderer, audio, input or game logic was involved.
What is claimed: 23 real engine TUs link into one wasm module, and four jobs —
one per shipped game policy, including the streamer policy — go through
`AddTask → Flush → jqWorkerLoop → jqExecuteBatch` exactly once each with the
expected results.

**Policy, explicitly:** the single execution context of T-005c §3. A serial
cooperative scheduler, not a thread pool. `_Init` sets `jqMaxWorkers = 0`, no
worker context is created, `Flush` drains on the caller and ignores `bRunJobs`,
and every blocking wait either cannot be reached or aborts. It is **not** a
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
4. **Step 4** — can the backend live in the engine as `jobqueue_web.cpp`, and do
   the shipped game policies (**including the column-0 streamer policy**) run on
   a single context without changing PC behaviour?
5. **Step 5** — can the whole thing be shipped as a reviewable patch that applies
   to a fresh upstream tree, and is the PC build provably unchanged?

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
4. That overlay is then exported to `engine/patches/t005c-web-scheduler.patch`
   and re-applied to a *fresh copy of upstream* by `engine/apply_overlay.py`,
   which refuses to run against a dirty `upstream/`. The rebuilt module must
   reproduce the same behaviour from that tree.
5. A symbol gets a web implementation only when the operation is genuinely
   defined for the target (a fence, a CAS, a host name). If it is not, the build
   stops and the gap is documented — nothing is stubbed to "make it link".
6. Linked modules are checked against values computed by hand, and every run is
   repeated to show determinism.
7. The PC path is checked by preprocessor equality (the only allowed difference
   is a `__LINE__` constant) plus a native MSVC compile of the whole closure.

## 2. Exact commands

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

# everything: overlay + 9 TU sets + three node modules (maths, system, scheduler)
& $py _work/engine-web-spike/run_spike.py

# the scheduler module alone is built and run by the same script; the exact
# link line is the 23 objects in SCHED_TUS, then:
#   em++ <23 .o> -sENVIRONMENT=node -o out/spike_sched.js
#   node out/spike_sched.js            (twice; output must be identical)
#   node out/spike_sched.js abort-event | abort-thread | abort-policy

# the overlay alone (writes patched/CHANGES.txt and its sha256)
& $py _work/engine-web-spike/make_patched_copy.py --web-branch alias

# one set, e.g. the control that still reproduces T-005a's 7-error baseline
& $py _work/engine-web-spike/build_probe.py ctl_noshim_maths maths `
    -DPLATFORM_WEB -fdelayed-template-parsing -D__restrict= -fdeclspec
```

The overlay itself (`engine/`, English README with the same provenance):

```powershell
& $py engine/apply_overlay.py --tree _work/engine-overlay-check     # copy + patch
& $py engine/verify_overlay.py --fresh                              # fresh tree, rebuild, run
& $py engine/native_parity.py                                        # PC TU equality + MSVC compile
& $py engine/make_patch.py                                           # regenerate the patch (--check)
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

The 8-byte queue CAS is worth its own line because T-005c §6.5 left it open. The
real `Scheduler::jqAtomicQueuePtr<U32>` is `{ T* volatile Ptr; unsigned Count; }`
in a union with `U64 Val64` — **`sizeof = 8`, `__alignof__ = 8` on wasm32**
(the `U64` member forces 8-alignment), so the 64-bit CAS is naturally aligned and
no rework is required. `probes/probe_queue_cas.cpp` (which uses the engine's own
type, not a hand-made copy) prints `sizeof=8 alignof=8`, `cas_ok=1` and shows a
stale compare fails without touching the pair (`stale_cas_ok=0 ptr_unchanged=1`).
Whether emscripten lowers it to a real atomic instruction is irrelevant here: the
module has one context and contains no `-matomics`.

### 6.3 Policy flattening — the column-0 defect, fixed

`GenerateWorkerPolicyOrder` (`jobqueue.cpp:500-533`) sorts policies by the
caller's column and sets any policy whose value there is `0` to `-1`;
`jqPopNextBatch` (`jobqueue_kernel.cpp:216-221`) stops at the first `-1`. With
column 0 as the only execution context, `piStreamer = {0,0,7,7,7,7,7,7}`
(`SchedulerConfig.cpp:49-50`) can never be popped, so a streamer task is queued
and never executed, and `Flush` on its group cannot terminate (T-005c §1.5).

`CreatePolicy` now flattens **under `PLATFORM_WEB` only**: it takes the maximum
across the 8 columns and replicates it, so the policy is column-invariant, the
relative order between policies is preserved (max is monotone), every policy
stays enabled, and `Task::iCPUBits != 0` holds. The flattened copy also lives in
static storage, which removes the caller-lifetime dependency (the game passes a
stack array — a pre-existing hazard, unchanged for PC).

**If a policy cannot be represented faithfully it aborts, it is never dropped:**
an all-zero policy means "never run on any context" and is refused with
`CreatePolicy(N): all 8 columns are 0, …` through the same `jqWebFatal` path.
Creating more than `JQ_PRIORITY_MAX` policies aborts too instead of
overrunning the static table.

The PC path is byte-for-byte unchanged (`#else gPolicyList.Policies[iPolicy] =
pPolicy;`).

**Proof that flattening is load-bearing** — `run_spike.py` links the same closure
a second time with the *unpatched* `jobqueue.cpp` and runs it. Result: `piMed`,
`piHigh` and `piOneSPU` execute, then the run aborts with

```text
[scheduler/web] unsupported: Flush cannot make progress: a queued batch is not
runnable (a policy disabled by its column 0?)
```

With the flattening, all four policies execute (§7.1). The progress guard also
means the defect can never present as a browser hang: `Flush` aborts after eight
iterations without the queue shrinking.

### 6.4 Blocking waits fail loudly

Two waits are reachable from this closure, and both now abort with a message
instead of blocking or returning a fake success:

| Wait | Web behaviour | Why |
| --- | --- | --- |
| `MT::Event::Wait` | `tlWebUnsupported("MT::Event::Wait")` → stderr + `abort()` | nothing in one context can signal it; emscripten's pthread stubs must not be allowed to report success (T-005c §3.6.1) |
| `tlWaitForThread` | `tlWebUnsupported("tlWaitForThread")` → stderr + `abort()` | waiting for another context can never complete |

`MT::Mutex::Wait` is left on the POSIX branch: an uncontended lock in a single
context genuinely succeeds and there is no second thread to deadlock against.
`MT::Thread::Start/Join` are not exercised at all (§10).

## 7. What links and runs

### 7.1 The scheduler module

**23 objects, 95,477 B of wasm object code → `spike_sched.wasm`, 63,996 B at
`-O2` — an engine scheduler module that links and executes every shipped game
policy and the T-005c dependency cases.** No symbol is resolved by a stub; the two spike sources are a platform
backend and a driver, both marked below.

```text
jobqueue_kernel.o       jobqueue_task_queue_lf.o  jobqueue_mem.o
Thread.o                RwLock.o                  CoreMemoryAligned.o
Time.o                  Logger.o                  Format.o
DebugLevel.o            Filter.o                  ThreadContext.o
ConsoleSubscriber.o     SubscriberCommon.o        SubscriberManager.o
jobqueue.o*             jobqueue_web.cpp*         LogManager.o*
Mutex.o*                Event.o*                  platform_net_web.o†
web_runtime.o†          smoke_sched.o†
  * patched copy / new engine file in the overlay   † shim or driver
```

`jobqueue_web.cpp` is now an engine-side source (the web sibling of
`jobqueue_xenon.cpp` + `jobqueue_kernel_xenon.cpp`), not a spike shim: it lives at
`system/source/scheduler/jobqueue_web.cpp` in the overlay and is selected by
`TL_PLAT_WEB`. The overlay adds it; upstream is untouched.

Run output (`node`, exit 0, twice, identical — `output_matches=True`):

```text
policy count=4
step=init
step=start
step=pool
layout queueptr=8/8 paramdata=48 task=72
A4 workers=0 max_workers=0
A4 flush_false ran=1 poll=1
A2 phase1 seq=A a_ran=1 b_ran=0 a_queue=0 b_queue=1
A2 phase2 seq=AB b_ran=1 b_queue=0
A2 phase3 only_flush_D seq=ABCD c_ran=1 d_ran=1
A2 verdict=ok
A3 piMed ran=1 observed=1 poll=1
A3 piHigh ran=1 observed=2 poll=1
A3 piOneSPU ran=1 observed=3 poll=1
A3 piStreamer ran=1 observed=4 poll=1
A3 total=4/4
queue queued=0 executing=0
step=shutdown
```

**A2 — group dependency (the last unverified clause).** Group B depends on group
A via `AddGroupDependency(B, A)`, and **B's task is enqueued first**, so the test
fails in both directions: a drain that ignored the group filter would run B
before A, and a drain that ignored the dependency would strand A behind B.

- `phase1` calls `Flush(A)` only: the sequence recorded *inside the job bodies*
  is `A`, `b_ran=0`, A's queue empty and B's still holding one task. Order is
  asserted, not just counts.
- `phase2` calls `Flush(B)`: the sequence becomes `AB` and B's queue drains.
- `phase3` builds a second pair C<-D, enqueues D first, and calls `Flush(D)`
  only. `Flush` recurses into its dependency (`jobqueue_xenon.cpp:146-155`), so
  the sequence is `ABCD` — C ran before D without anyone flushing C directly.
- `verdict=ok` re-checks all three from the sequence strings, so a reordering
  fails the run rather than passing on counts.

**A3 — every shipped game policy runs exactly once.** `piMed {7,7,7,…}`,
`piHigh {10,…}`, `piOneSPU {7,7,7,0,0,0,0,0}` and `piStreamer {0,0,7,7,7,7,7,7}`
each get one task in their own group; `ran=1` is the run count, `observed=i+1` is
the value the job body wrote back (so the right task ran), `poll=1` is `Poll()`
satisfied afterwards. `piStreamer` is the column-0 regression case: without
flattening it aborts (§6.3).

**A4 — serial layout.** `GetNumWorkers()=0`, `jqGetMaxWorkers()=0`,
`Flush(group,false)` still runs its task (the documented `bRunJobs` deviation),
and the queue layout the backend relies on is asserted in-process:
`jqAtomicQueuePtr<U32>` = 8/8, `Task::ParamData` = 48, `sizeof(Task)` = 72. If any
of those move, the smoke fails rather than silently using a different layout.

**Fail-loud cases**, each a separate process that must die with a message
(`run_spike.py` and `verify_overlay.py` run all four and check exit code +
message):

| mode | call | stderr |
| --- | --- | --- |
| `abort-event` | `MT::SpuEvent::Wait(1)` | `MT::Event::Wait` |
| `abort-thread` | `tlWaitForThread(0)` | `tlWaitForThread` |
| `abort-policy` | `CreatePolicy({0,0,0,0,0,0,0,0})` | `all 8 columns are 0` |
| `abort-label` | `AddGroupDependency(g, JQ_GROUP_LABEL, &fence)` + `Flush(g)` | `JQ_GROUP_LABEL` |

All four exit 1 with the expected message; nothing hangs. The label message names
the exact API and the reason: *"AddGroupDependency(group, JQ_GROUP_LABEL, U32*)
cannot be satisfied - only the renderer can advance the fence value"*.

The other fence form, `AddGroupDependency(group, MT::SpuRwLock*)`, **cannot even be
expressed on wasm32**: `MT::SpuRwLock` is declared only for
`PLATFORM_PS3 | PLATFORM_SPU` (`core/threads/SpuRwLock.h:4`), so the inline
overload in `jobqueue.h:350` does not exist for this build. It is reported as
unsupported with the exact reason rather than emulated: the backend still refuses
a group whose dependency id is `JQ_GROUP_SPURWLOCK` ("only another context can
release the lock") in case such a group is ever created by code compiled for
another platform, but no probe can construct one here.

**A2 is only groups.** The two fence forms are refused rather than simulated, so
this probe never proves that a fence would be *satisfied* — nothing in a single
context can satisfy one.

Three things the earlier runs exposed, kept because they are engine facts and not
spike bugs (the driver now follows the game's order):

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
   does not rely on it: each flattened policy yields a non-zero mask.

### 7.2 The two earlier modules (unchanged)

| Module | Objects | wasm `-O2` | SHA-256 (16) | Output |
| --- | --- | --- | --- | --- |
| `spike_maths.js/.wasm` | 5 maths TUs + driver | 11,413 B | `4DFB1FD8A56D22E9` | `maths_checksum=732`, `inverse_diag_x100=50 25 20 100` |
| `spike_time.js/.wasm` | `Time.cpp`, `endian.cpp` | 10,397 B | `34288F7DBF51E7ED` | `perf_counter_positive=1`, `perf_counter_freq=1000000` |

Both values match hand calculation. `Vector.cpp` is a 6.6 KB commented-out TU, so
most of the maths is inline header code and 11,413 B is not an engine size.

### 7.3 The overlay as a patch, and PC parity

The 20-file diff is exported to `engine/patches/t005c-web-scheduler.patch`
(691 insertions, 35 deletions, SHA-256
`B939B39C7F7598B19677F29286655DE554762CB3CBD1471833D17C873C3FDEF2`) and applied
by `engine/apply_overlay.py` to a **fresh copy of upstream**
(`_work/engine-overlay-check/`, 20,198 files). Both the built-in applier and
`git apply -p1 --check` accept it.

Applying the patch reproduces the spike overlay exactly (20/20 files identical
after line-ending normalisation), and the module rebuilt **from that tree**
reproduces the A3/A4 behaviour:

| | overlay (`run_spike.py`) | fresh tree (`verify_overlay.py`) |
| --- | --- | --- |
| objects | 23 | 23 |
| wasm | 63,996 B | 64,073 B |
| A2 | `verdict=ok` | `verdict=ok` |
| A3 | `total=4/4` | `total=4/4` |
| fail-loud cases | 4/4 | 4/4 |
| deterministic | yes | yes |

The 76-byte difference is `__FILE__` strings (`upstream/BlurRebuilt/...` vs
`_work/engine-overlay-check/...`) in log locations; behaviour is identical, so
the wasm hash is not compared across trees.

**PC parity is measured at the translation-unit level**, which is stronger than a
runtime sample: `jobqueue.cpp` preprocessed with MSVC in the PC configuration
(`PLATFORM_PC`, `WIN32`, `_WINDOWS`) from upstream and from the overlay tree
gives two 151,971-line units whose **only** difference is the `__LINE__` constant
of two log locations (555→589, shifted by the inserted web block). No statement
differs, which is the direct proof that `CreatePolicy` and the rest of the
scheduler behave identically on PC. The whole closure — 29 TUs including the
probe source with its PC layout constants — compiles natively.

This check found a real defect in the first version of the patch: `Event.cpp`'s
added `pthread_mutex_t` typedefs and `Mutex.h` include were unconditional, which
broke the PC compile. They are now inside `#if defined(PLATFORM_WEB)`.

**Native runtime A3/A4 is blocked, and not by the scheduler.** The PC
`LogManager` retention list constructs the file/socket/SMTP subscribers, so
linking the probe natively needs `Sys::C_FileSystem` → `AsyncFile` →
`ArteryMutex`, and `Network::TCPSocket` / `SMTPClient`; `system/source/io/
IoStream.cpp` does not compile in this checkout at all. That is a pre-existing
gap in the `common` library's PC logging chain, unrelated to the overlay.

### 7.4 The first real engine caller

`probes/smoke_caller.cpp` drives the engine's own compression classes through the
queue — `Compression::C_Deflate` and `Compression::C_Inflate`
(`misc_shared/.../Deflate.cpp`, `Inflate.cpp`) and their job bodies
(`Compression::DeflateTask`, `InflateTask` + the vendored zlib). It is the
cheapest engine code that really calls `Scheduler::AddTask` and
`Scheduler::Flush`, it is on T-005c's A1 list, and its result is checkable byte
for byte.

```text
caller setup ok
caller deflate deferred=1 ran=1 packed=37 cmf=0x78
caller inflate deferred=1 ran=1 equal=1 text=blur-scheduler-caller-roundtrip
caller shutdown ok
```

What each field proves:

- `deferred=1` — the output buffer still holds the 0xAA fill after `Start()`, so
  the job did **not** run inline: `AddTask` queued it and the cooperative
  `Flush` drain executed it. This is the property the whole design rests on.
- `ran=1`, `cmf=0x78` — the task ran and wrote a real zlib stream (RFC 1950 CMF
  byte for `CM=deflate`, 32K window).
- `equal=1` — deflate→inflate reproduces the input exactly, so `Task::ParamData`
  was copied correctly (16-byte `C_InflateParameters` inside the 48-byte field)
  and the module received the right pointers.
- `caller shutdown ok` — `DestroyGroup` + `Shutdown` complete with the queue
  empty.

Module: 116,101 B, SHA-256 `C793045C783CE105`, stable across two runs. Building
it needs one build-layout detail: `Deflate.cpp`/`InflateTask.cpp` include
`"../../../../Vendor/Zlib/Current_Mercury/Zlib.h"`, which the engine's build
layout provides but this checkout does not; `verify_overlay.py` materialises that
directory from `code/vendor/zlib/current_mercury` (12 headers) inside the tree.
No engine source is changed by that step.

## 8. Remaining blockers, ordered by cost

1. **The overlay is still a patch, not engine source.** It applies cleanly and is
   verified, but nothing has landed in `upstream/`: the owning phase has to take
   `engine/patches/t005c-web-scheduler.patch`, run the native build (`/W4`,
   `/permissive`, 14/14 CTest) and commit it. Until then every result here comes
   from an overlay tree.
2. **The 150 real call sites are still unexercised.** A2 now covers the
   dependency *mechanism* (§7.1), but no game system has queued across dependent
   groups; group/policy interleavings under load, and the two audio
   `Flush(group, false)` sites, remain unmeasured.
3. **Native runtime A3/A4 cannot be linked** in this checkout: the PC `LogManager`
   retention list needs `Sys::C_FileSystem` → `AsyncFile` → `ArteryMutex` and
   `Network::TCPSocket`/`SMTPClient`, and `system/source/io/IoStream.cpp` does not
   compile here. PC parity is proven at the TU level instead (§7.3). Nothing to do
   with the scheduler; it is a pre-existing gap in the `common` PC logging chain.
4. **The dead POSIX branches (5 sites).** `Event.cpp`/`Mutex.cpp` are fixed in the
   overlay; `ArterySync.h` `ArteryThreadHandle` for `ARTERY_SYNC_PTHREADS`
   (`IoFile.cpp`), `Semaphore.cpp:128` `-Wc++11-narrowing`,
   `ThreadLocalStorage.h:111` `pthread_key_t` are not. Each is a small explicit
   fix, none is a design decision.
5. **The network stack** (`Address.cpp`, 14 errors, `struct in_addr` incomplete).
   Needed only for real networking; the logger no longer depends on it.
6. **`_vsnprintf_s`** (`BizAssert.cpp:66`, 1 error). MSVC's secure variant has a
   different truncation contract than `vsnprintf`; a name alias would be a silent
   semantic change, so it is 1 wrapper or 1 call-site branch.
7. **The Xenon kernel TUs** (13 errors) — deliberately not ported, replaced by
   `jobqueue_web.h` + `jobqueue_web.cpp`.
8. **DX11 / FX11** — untouched. T-005a's inventory stands (442 D3D11/FX11 matches
   in `display`, 43 in `display2`, 33 in `render`); the only blocker whose cost is
   not bounded.

## 9. The single next smallest step

**Land the overlay.** Every clause of the scheduler contract that can be checked
without a game is now checked (A1 compile, A2 dependencies, A3 policies, A4
serial layout, caller, fail-loud cases), so the remaining work is no longer
discovery — it is putting the patch into `upstream/` under the owning phase's
gates.

Concretely, in `task/T-005-...`:

1. Apply `engine/patches/t005c-web-scheduler.patch` and keep the PC branches
   byte-identical (the preprocessor equality in §7.3 is the check).
2. Run the native build: `/W4` warning-free, `/permissive`, 14/14 CTest, and
   `engine/native_parity.py` still green on the committed source.
3. Re-run `engine/verify_overlay.py --fresh` against the committed `upstream/`
   (no longer an overlay tree) to confirm the web module is unchanged.
4. Only then point the game's `SchedulerConfig` at the web backend and take the
   first real system (streaming or the layer-manager thread), which is where the
   two audio `Flush(group,false)` deviations and the 150 call sites finally meet
   the single-context rules.

Acceptance: the four gates above, plus `A2 verdict=ok` and `A3 total=4/4` from
the committed tree.

Why this one: the scheduler's behaviour is no longer the open question; whether
the patch survives the real build and lands before other work diverges is. Every
other item on the blocker list is outside this module (network, DX11, native
logging chain).

## 10. What this does not prove

- **No browser, GPU, audio, input, physics or game logic.** Four policy jobs,
  four dependency jobs and one compression round trip are the whole runtime
  evidence. No screenshot exists.
- **Not thread-safe, not parallel.** Nothing exercised two contexts; `MT::Mutex`
  was linked but never contended, and `MT::Thread::Start/Join` were not called at
  all. Whether emscripten's thread stubs without `-pthread` make
  `MT::Thread::Start/Join` silently no-op is still untested — `MT::Event::Wait`
  and `tlWaitForThread` are the two waits that now abort (§6.4), not the thread
  entry path.
- **The game's own policy values, but not its call sites.** The four policies are
  copied verbatim from `SchedulerConfig.cpp:34-50`, and one real engine caller
  (the compression classes, §7.4) runs through the queue, but the 150 game call
  sites and any group *dependency* remain unexercised (T-005c A2).
- **The native probe never ran.** PC parity is a translation-unit result (§7.3),
  not a runtime comparison; the native link is blocked by the PC logging chain.
- Only the 23 scheduler objects, the caller closure and the three sample modules
  were compiled to objects; the rest of §3 was syntax-checked only, and
  `-fsyntax-only` hides codegen-level problems (that is how the `snPause` PPC trap
  survived step 2).
- No engine size claim: 63,996 B / 116,101 B include the emscripten runtime, libc
  and libc++, and are dominated by the logging and zlib code, not by the
  scheduler.
- The overlay proves the edits are *sufficient* for clang and for the MSVC TU
  check; it does not prove a full native link or `/W4` cleanliness — that is the
  owning phase's gate.
- Error counts are front-end diagnostics, not defect counts.

## 11. Evidence index

All hashes are SHA-256 prefixes. `engine/` files are committed; everything under
`_work/` is regenerated by the scripts.

| Path | Size | SHA-256 (16) | Content |
| --- | --- | --- | --- |
| `engine/patches/t005c-web-scheduler.patch` | 39,156 | `B939B39C7F7598B1` | **the overlay: 20 files, +691/−35** |
| `engine/apply_overlay.py` | 9,966 | `3EEE1B15579B5252` | copy + patch a caller-supplied tree |
| `engine/verify_overlay.py` | 12,182 | `E21F463034A66219` | fresh-tree rebuild + A2/A3/A4 + caller |
| `engine/native_parity.py` | 9,026 | `0C7D18B7D6C68868` | MSVC TU equality + native compile |
| `engine/make_patch.py` | 5,804 | `20EE39E65D79DC87` | regenerates the patch |
| `engine/README.md` | 8,387 | `BA40E4AA30C65141` | purpose, provenance, A2/A3/A4 coverage |
| `_work/engine-overlay-check/.overlay/manifest.json` | 2,908 | `C140E5BC8D24C428` | applied tree: commit, patch hash, manifest hash |
| `_work/engine-web-spike/out/spike_sched.wasm` | 63,996 | `9547C5CA972A6F8C` | **scheduler module; 23 objects, A2/A3/A4** |
| `_work/engine-web-spike/out/treecheck/spike_sched_tree.wasm` | 64,073 | `AB918E9A1FC2C330` | same module rebuilt from the applied tree |
| `_work/engine-web-spike/out/treecheck/spike_caller_tree.wasm` | 116,101 | `C793045C783CE105` | **scheduler + compression caller + zlib** |
| `_work/engine-web-spike/out/spike_maths.wasm` | 11,413 | `4DFB1FD8A56D22E9` | maths + `Matrix.cpp` sample |
| `_work/engine-web-spike/out/spike_time.wasm` | 10,397 | `34288F7DBF51E7ED` | `Time.cpp` + `endian.cpp` sample |
| `_work/engine-web-spike/native/upstream_jobqueue.i` | 6,874,851 | `684B4C8D4507F0BF` | PC preprocessed TU, upstream |
| `_work/engine-web-spike/native/overlay_jobqueue.i` | 6,875,525 | `F2E913DB1B0526BA` | PC preprocessed TU, overlay (differs by 2 line numbers) |
| `_work/engine-web-spike/shims/jobqueue_web.cpp` | 7,184 | `D5527182715A1265` | the backend, copied to `system/source/scheduler/jobqueue_web.cpp` |
| `_work/engine-web-spike/shims/platform_net_web.cpp` | 1,124 | `8C43A5177ECA2AAC` | `Network::GetHostName()` → `"web-local"` |
| `_work/engine-web-spike/shims/tl_thread_web.h` | 4,318 | `5CA770AD7E63775D` | `TL_PLAT_WEB` type layer + fail-loud stubs |
| `_work/engine-web-spike/shims/jobqueue_web.h` | 2,309 | `C9EEE1F93E1FBA51` | scheduler type layer + `jqWebFatal` |
| `_work/engine-web-spike/patched/CHANGES.txt` | 18,919 | `DB524F9616015A49` | the spike-side edit manifest |
| `_work/logs/engine-web-spike/summary.json` | 17,223 | `A04089AC05494CF5` | 9 sets, 3 modules, A2/A3/A4, abort cases, flatten control |
| `_work/engine-web-spike/logs/spike_sched.run{1,2}.log` | — | — | the two identical runs (exit 0) |
| `_work/engine-web-spike/logs/spike_sched.abort-*.log` | 4 | — | the fail-loud cases (exit 1 + message) |
| `_work/engine-web-spike/logs/flatten_control.run.log` | — | — | unpatched `jobqueue.cpp` → "cannot make progress" |
| `_work/engine-web-spike/logs/caller.run{1,2}.log` | — | — | the compression round trip, twice |
| `_work/engine-web-spike/logs/schedlink__*.obj.log` | 23 | — | one object compile per scheduler TU |
| `_work/engine-web-spike/probes/probe_queue_cas.cpp` | 1,210 | `2F1316B987622CDE` | real `jqAtomicQueuePtr`: 8/8, CAS + stale CAS |
| `_work/engine-web-spike/probes/smoke_sched.cpp` | 10,989 | `F09DF76B33FFE3BA` | A2/A3/A4 driver + four abort modes |
| `_work/engine-web-spike/probes/smoke_caller.cpp` | 3,713 | `FBD0FE0B1E726E74` | the compression caller |
| `_work/engine-web-spike/run_spike.py` | 16,899 | `B2EA5B494B8564D5` | one-command reproduction |
