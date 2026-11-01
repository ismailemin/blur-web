# T-005c — Browser scheduler and fixed-step time design

**Date:** 2 November 2026
**Status:** design only. No source, build file, task card or `upstream/` file was
modified; the game was not run and no code was compiled for this document.
**Scope:** T-005c of `docs/work/tasks/T-005-single-player-vertical-slice.md`
("Scheduler ve zaman adımı — Windows thread/job queue yerine Web Worker/Atomics
veya tek iş parçacığı politikası; sabit simülasyon adımı, render'dan bağımsız").
**Inputs:** `docs/work/analysis/engine-wasm-probe.md` (T-005a measurements),
`upstream/BlurRebuilt/AGENTS.md`, and the engine sources cited inline.

Everything marked **proposal** is a design decision to be taken by T-005c. Every
statement about engine behaviour is a source citation, not a runtime
observation. Nothing below is an implementation claim.

---

## 1. What the engine actually has

### 1.1 The scheduler is one API over five platform implementations

`system/scheduler.h` is a one-line include of
`system/scheduler/jobqueue.h`. The public surface is ~40 functions
(`jobqueue.h:210-447`) and the implementation is selected by platform:

| Platform | Header | Kernel | Queue |
| --- | --- | --- | --- |
| PC / Xenon | `jobqueue_xenon.h` | `jobqueue_kernel_xenon.cpp` → `jobqueue_kernel.cpp` | `jobqueue_task_queue_lf.h` |
| PS3 | `jobqueue_ps3.h` | `jobqueue_kernel_ps3.cpp` | same |
| "generico" (legacy) | `jobqueue_generic.h` | `jobqueue_generic.cpp` | intrusive list |

`jobqueue.h:61-67` chooses by `TL_PLAT_*`; `jobqueue_generic.h:40-80` already
contains a single-threaded intrusive-list scheduler, but it is a **stale API**:
it uses `Task::Next` and `tlMemAlloc`, which the current `Scheduler::Task`
(`jobqueue.h:79-109`) does not have. It cannot be reused as-is; it is only
evidence that a serial scheduler shape was once intended.

Call-site weight (textual matches over `code/mercury` + `code/amax`, `.h`/`.cpp`;
same counting discipline as `surface.py` in the T-005a probe, so approximate):

| Symbol | Matches |
| --- | --- |
| `Scheduler::AddTask` | 150 |
| `Scheduler::Flush` | 94 |
| `MT::Thread` | 103 |
| `MT::Mutex` | 60 |
| `MT::Event` | 22 |
| `MT::Lock ` | 21 |
| `MT::AutoLock` | 13 |
| `tl_threadlocal` | 10 |
| `tlCreateThread(` | 4 |
| `tlSleep(` | 1 |

Two consequences fix most of the design space:

1. **The scheduler API is a contract, not an implementation detail.** 244 direct
   call sites mean T-005c must keep `AddTask`/`Flush`/`Poll`/groups/policies
   semantics and supply a new backend, not rewrite consumers.
2. **Concurrency is pervasive but shallow.** 103 `MT::Thread` and 60 `MT::Mutex`
   touches exist, yet `tl_*` (the actual OS thread primitive) is used in only 4
   places. Most code uses `MT::` wrappers, so a *serial* implementation of those
   wrappers is a small, auditable change.

### 1.2 The scheduler contract that matters for a browser

The PC kernel is a worker-thread pool over a lock-free queue:

- `_Init` (`jobqueue_xenon.cpp:27-41`): `GetSystemInfo` → `jqMaxWorkers =
  dwNumberOfProcessors - 1`; creates 8 named auto-reset events `jqAlert0..7`.
- `_Start` (`:60-83`): for each worker, `tlCreateThread(..., 65536,
  CREATE_SUSPENDED, name)` then `ResumeThread`.
- `jqWorkerSleep` (`jobqueue_kernel_xenon.cpp:48-53`):
  `WaitForSingleObject(g_WorkerAlert[iWorkerID], INFINITE)`.
- `_jqStop` (`jobqueue_xenon.cpp:85-110`): sets `jqStopSignal`, alerts, then
  polls `WaitForSingleObject(thread, 10)` and `CloseHandle`.
- `Flush` (`jobqueue_xenon.cpp:141-204`): spins on
  `QueuedBatchCount + ExecutingBatchCount == 0`, and **while spinning it runs
  jobs itself** via `jqWorkerLoop(&jqMainThreadWorker, GroupID, -1)`. If the
  group has an event and it is not the caller's own work, it blocks on
  `pEvent->Wait()`.
- Work selection (`jobqueue_kernel.cpp:216-241`) walks priorities in the order
  given by `Worker->PolicyOrder.iPolicy[]`, and stops at the first `-1`.
- Group dependencies (`jobqueue_kernel.cpp:31-81`): other groups,
  `JQ_GROUP_SPURWLOCK`, or `JQ_GROUP_LABEL` (a GPU fence value).

The important property: **the queue is already "enqueue now, execute later,
read results after `Flush`".** Tasks are copied by value into the queue,
including `ParamData` (`jobqueue.cpp:315-333`), so deferred execution adds no new
lifetime risk. Physics already uses exactly this pattern
(`physics/gravity/source/sdk/Scene.cpp:150-151`, `:251`), as does streaming
(`graphics/renderingdata/.../streammanager.cpp:440`, `:500`) and audio
(`audio/source/ObjectManager.cpp:810-815`).

### 1.3 Time primitives

- `Time::GetPerformanceCounter()` — `QueryPerformanceCounter` scaled to
  microseconds (`system/source/time/Time.cpp:54-63`).
- `Time::GetPerformanceFrequency()` — always `1 000 000`
  (`system/time/Time.h:48`).
- `Time::GetCurrentTime()` — `GetSystemTimeAsFileTime` (`Time.cpp:42-51`).
- `C_Timer::Update()` (`framework/source/timer/Timer.cpp:68-112`) clamps frame
  time to `[1/1000, 1/15]` s, then lets `ForceFrameTime` override it.
- `tlSleep` → `Sleep` (`tl_thread.h:166-177`); `MT::YieldThread` is already a
  **no-op on PC** (`core/threads/Misc.h:38-46`, the `SwitchToThread()` call is
  commented out).

### 1.4 What breaks on wasm32

From the T-005a probe (`engine-wasm-probe.md` §3.3), plus direct source reading:

| Primitive | Location | wasm32 failure |
| --- | --- | --- |
| `tl_defs.h` platform gate | `tl_defs.h:9-10` | `#error TL_PLAT_XXX platform specification is missing`; `mercury_to_tl.h:4-10` maps only SPU/PS3/PC |
| `tl_thread.h` gate | `tl_thread.h:15-17` | `#error This module is only implemented for PC, Xenon and Playstation3` |
| `tlThreadHandle`, `tlThreadPriority`, `tlThreadFlags`, `tlThreadFunction` | `tl_thread.h:53-125`, `:216-224` | all defined in terms of `HANDLE`/`THREAD_PRIORITY_*`/`CREATE_SUSPENDED`/`__stdcall` |
| `tlCreateThread` | `tl_thread.h:277-327` | `CreateThread`, `assert(thr != 0)` |
| `tlWaitForThread` | `tl_thread.h:355-376` | `WaitForSingleObject` + `CloseHandle` |
| `tl_threadlocal` | `tl_thread.h:405-407` | `__declspec(thread)` — MSVC only |
| JobQueue workers | `jobqueue_xenon.cpp:27-119` | `GetSystemInfo`, `CreateEvent`, `SetEvent`, `WaitForSingleObject`, `CloseHandle`, `ResumeThread` |
| `Task::iCPUBits`/`AlertBits` | `jobqueue.cpp:248-303`, `alertbits.h` | assumes 8 alert words and `MT::AtomicAdd` on `U32` halves |
| `MT::MemoryFence`/`Atomic*` | `Atomic.h:60-73`, `:91-370` | `InterlockedExchange`, `InterlockedExchangeAdd(64)`, `_InterlockedAnd`, `__int64` |
| Queue CAS | `jobqueue_task_queue_lf.h:98-101` | needs an 8-byte CAS on `U64`; the `_WIN64` path (`:28-70`) uses `_InterlockedCompareExchange128`, which must not be selected |
| `MT::Lock`/`Mutex` non-MSVC path | `core/source/threads/Mutex.cpp:52-100` | the `!COMPILER_VC` branch calls `sys_lwmutex_*` unconditionally — the 14-error "PS3 path taken" result in the probe |
| `ThreadLocalStorage` | `core/threads/ThreadLocalStorage.h:37-57`, `:90-112` | `TlsAlloc`/`TlsGetValue`; the fallback uses `pthread_key_*` |
| `Time` | `Time.cpp:3-16` | PC branch needs `windows.h`; the `#else` branch is fine for emscripten |
| `ArterySync.h` | `system/artery/ArterySync.h:25-28` | `typedef HANDLE ArteryThreadHandle` / `sys_ppu_thread_t`; no third branch — the `system/io/IoFile` 8-error result |
| `system/xt2` atomics | `xt2` TUs | `<cell/atomic.h>` (`engine-wasm-probe.md` §3.3) |
| `jobqueue.cpp` include chain | `jobqueue.cpp:1-6` | pulls `core/Maths.h` (7-error gate) and `system/DebugLog.h` |

Two of the four `tlCreateThread` sites are the JobQueue itself
(`jobqueue_xenon.cpp:76`, `tl_thread.h:277/:330`); the rest are test/tool code.
Everything else in the engine reaches threading through `MT::Thread`.

### 1.5 The engine already has a zero-worker degenerate case

`jqEnableWorkers` is called **only under `PLATFORM_PS3`**
(`code/mercurygame/game/SchedulerConfig.cpp:52-54`), so on PC the mask stays at
its default `0xfffffffe` (`jobqueue.cpp:28`). `jqNWorkers = min(tlCountOnes(mask),
jqMaxWorkers)` (`jobqueue.cpp:197`) and `jqMaxWorkers = cores - 1`
(`jobqueue_xenon.cpp:33`). On a one-core machine `jqNWorkers == 0`, and `Flush`
still completes because it runs jobs on the caller. **The serial scheduler is
therefore not a new mode invented for the browser; it is the existing
`jqNWorkers == 0` layout.** This project has not executed that layout — it is a
source-level observation, and proving it is part of the first slice (§5, A4).

**But it is not yet a *correct* serial layout**, for a concrete reason:

- `GenerateWorkerPolicyOrder` (`jobqueue.cpp:500-533`) sorts policies by the
  caller's column, then sets any policy whose column value is `0` to `-1`.
- `jqPopNextBatch` breaks out of the priority loop at the first `-1`
  (`jobqueue_kernel.cpp:216-221`).
- The main-thread worker is generated with column **0** (`jobqueue_xenon.cpp:62`).
- `SchedulerConfig` defines the streamer policy as `{0, 0, 7, 7, 7, 7, 7, 7}`
  (`SchedulerConfig.cpp:49-50`).

So with column 0 as the only execution context, **decompression/streamer tasks
are never popped**, and a `Flush` on that group cannot terminate. §3.4 fixes
this by flattening policies; it is the single most important correctness detail
in this design.

### 1.6 Thread consumers beyond the job queue

`MT::Thread` subclasses found in `code/mercury`:

| Consumer | File | What T-005c must decide |
| --- | --- | --- |
| Layer manager | `framework/include/framework/layer/LayerManager.h:21`, `source/layer/LayerManager.cpp:22-48`, `:90` | thread waits on `m_StatusDirtyEvent`; must be pumped per frame in a serial build |
| Framework loading | `framework/include/framework/application/LoadingThread.h:24` | loading-screen progress |
| Resource manager | `util/resource/include/resource/Manager.h:66` | async resource load |
| Render streamer | `graphics/renderingdata/.../streammanager.cpp:81` | decompression + GPU copy groups |
| Pak FS | `util/logicalFs/source/pakfs/PakFsManager.cpp:104`, `:127` | spin/verify threads |
| Save system | `ui/include/ui/Game/SaveSystem/SaveSystem.h:45`, `:67`, `:89` | load/save/delete |
| Networking / debug | `system/network/Service.h:46`, `system/debug/log/NetworkRepeater.h:40`, `debugsystems/Source/FileMonitor.cpp:22` | out of single-player scope |

The layer-manager thread is the one that changes semantics: layer update ordering
versus the main update is currently "as soon as the dirty event fires".

---

## 2. Options

Three models were compared against five criteria. "Determinism" here means:
the same input trace produces the same state, independent of wall-clock frame
timing.

### A. Single-threaded wasm (one execution context)

| Criterion | Assessment |
| --- | --- |
| Latency | Best possible. No cross-context wake-up. `Flush` costs exactly the work, not a scheduling round trip. |
| Complexity | Lowest. ~1 new `tl_*` implementation (~150 lines), one new `jobqueue_web.cpp`, and a decision per `MT::Thread` consumer. No COOP/COEP. |
| Determinism | **Total.** One context, one order. Task order is deterministic by construction, so state hashes are reproducible. |
| Audio | WebAudio `AudioWorklet` is mandatory regardless; the worklet is a separate real-time context and cannot be replaced by this model. The engine's audio *update* (`ObjectManager::UpdateAudioObjects`) is CPU-side and can stay serial. |
| Input | Trivial: DOM events queue into a ring, drained at step start. |
| Cost | The main thread does simulation *and* jobs *and* rendering. Decompression and physics become frame-time, not background. |

Hard problem: `Scheduler::Flush(group, false)` exists precisely to mean "wait,
but do not run jobs here". There are **exactly two** such call sites, both audio:
`audio/source/ObjectManager.cpp:815` and `audio/source/BatchFrameAdd.cpp:281`.
With one context, `bRunJobs == false` cannot be honoured — nothing else will ever
run those tasks.

### B. Web Workers + SharedArrayBuffer (Emscripten `-pthread`)

| Criterion | Assessment |
| --- | --- |
| Latency | Good for parallel batches; wake-up cost is `Atomics.notify` → ~50-200 µs. For a 16 ms frame with small batches, often negative net win. |
| Complexity | Highest. Requires COOP `same-origin` + COEP `require-corp` on every response, a cross-origin-isolated origin, fixed memory (no post-start growth), and `-pthread` in the build. Also every `MT::Mutex`/`Event` must become a real futex-backed primitive, and the 8-byte queue CAS must lower to a real atomic. |
| Determinism | **Lost by default.** Today's `Flush`-then-read pattern is safe, but task *order* is nondeterministic, and any batch that writes shared state without a group boundary becomes a race. The engine's 150 `AddTask` sites were written for 7 workers, so most are probably safe — "probably" is not a verification argument. |
| Audio | Unchanged: worklet still required. Blocking `Atomics.wait` is illegal on the main thread and must never be used for audio timing. |
| Input | Needs a message channel; latency one frame. |
| Cost | Blocks the first slice entirely behind header work (COOP/COEP) and a determinism audit. |

### C. Hybrid: serial main thread + opt-in worker pool behind the same API (**proposal: target model**)

Main thread owns the fixed-step simulation, the scheduler drain, input and
render submission. A small pool (`navigator.hardwareConcurrency - 1`, capped) is
created only when a batch is *declared* parallel-safe by a policy, and only for
batches that already have a group boundary and no shared writes. Default
configuration: pool size 0.

| Criterion | Assessment |
| --- | --- |
| Latency | Same as A when the pool is empty; pays only where there is real work. |
| Complexity | Medium. Model A plus a policy-level opt-in and a COOP/COEP deployment. |
| Determinism | Preserved **only** for opt-in batches; the determinism gate must run with the pool at 0 and at N, and both must hash identically for the opt-in set. |
| Audio | Worklet, plus the pool must never touch the audio command buffers. |
| Input | Main thread only. |

### Decision (proposal)

1. **Adopt A for T-005c** and for the whole T-005d…T-005g vertical slice. It is
   the only model that can be verified quickly, and it is the model the engine
   already supports structurally (`jqNWorkers == 0`, `Flush` self-drains).
2. **Keep the API shaped for C.** The `platform/thread` adapter is the seam; the
   worker pool is a build-time variant of that seam, not a rewrite. Land it only
   when a measured frame budget demands it, with a determinism comparison.
3. **Reject B as the first step.** It front-loads deployment constraints
   (COOP/COEP) and a determinism audit across 150 call sites before any of the
   slice is playable.
4. Audio never uses any of these as a clock: `AudioWorklet` is a hard
   requirement from T-005f, independent of the scheduler choice.

### The two audio call sites must be named as a deviation

`Flush(group, false)` cannot be honoured with one context. Proposal: under
`PLATFORM_WEB`, `Flush` ignores `bRunJobs` and always drains, and the deviation
is recorded at the two call sites with a comment and a removal task. The
alternative — asserting — turns a working audio update into a boot failure,
which is worse for a slice whose purpose is to get a race running. This must be
an explicit, documented deviation, not a silent fallback (project rule).

---

## 3. Required adapter interfaces

### 3.1 Layer shape

New build identity `PLATFORM_WEB` → `TL_PLAT_WEB` in `mercury_to_tl.h`, compiled
with `-DPLATFORM_WEB` and **without** `PLATFORM_PC`/`_WIN32`/`WIN32`
(T-005a §5.1). Then:

| Adapter | Replaces | Owns |
| --- | --- | --- |
| `platform/thread` (`thread_web.cpp`) | `tl_thread.h` PC branches | spawn/join/exit, id, TLS, priorities (mapped), flags |
| `platform/atomic` (`Atomic.h` web branch) | `Interlocked*` | fence, CAS32/64, add, inc/dec, and/or, get/set |
| `platform/sync` (`Mutex.cpp`, `Event.cpp`) | `CRITICAL_SECTION`, `CreateMutex`, `CreateEvent` | one `PlatformMutex`/`PlatformEvent`/`PlatformLock` type per mode |
| `platform/time` (`Time.cpp` web branch) | `QueryPerformanceCounter` | monotonic µs clock, wall clock |
| `platform/sched` (`jobqueue_web.cpp`) | `jobqueue_xenon.cpp` | worker lifecycle (none), pump, flush, policy flattening |

`system/scheduler.h` and every `Scheduler::` caller stay untouched.

### 3.2 Spawn

```cpp
// platform/thread, single mode
// Returns a handle that is only valid as an identity, never as a runnable context.
tlThreadHandle PlatformSpawn(const PlatformThreadDesc&); // kUnsupported
```

Required semantics, per function:

- `tlCreateThread` (single mode): **returns an invalid handle and records the
  request**. It must not run the entry inline: every real entry point is a
  forever-loop (`jqWorkerThread` → `jqWorkerLoop`), so inline execution would
  hang the frame. Callers that require a context must be compiled for web or
  pumped instead (see `Spawn` consumers table, §3.6).
- `tlWaitForThread` / `MT::Thread::Join` (single mode): fatal `BizAssert` with a
  message naming the subsystem. Never an infinite wait (browser hang, no
  console output), never a silent `return 0` (project rule: no silent fallback).
- `tlExitThread`: `std::terminate` in single mode — reaching it means the code
  path should not exist.
- `tlSetCurrentThreadName`: no-op that stores the name for logs.
- `tl_threadlocal` → `thread_local`. With one context this is plain storage; the
  macro must stay so the 10 existing declarations compile unchanged.
- `ThreadLocalStorage` → a `thread_local`-backed slot, so
  `MT::Thread::GetCurrentThreadID()` keeps working.

### 3.3 Atomic and TLS

- `MT::MemoryFence` → `__atomic_thread_fence(__ATOMIC_SEQ_CST)` (compiles to
  nothing meaningful with one context, and is correct later).
- `MT::AtomicAdd/Increment/Decrement/CompareAndSwap/AtomicGet/AtomicSet` →
  `__atomic_*` builtins on the same types. No `InterlockedExchange` of `long`.
- The 8-byte queue CAS (`jobqueue_task_queue_lf.h:98-101`) uses
  `MT::AtomicCompareAndSwap(volatile U64*, U64, U64)`. On wasm32
  `jqAtomicQueuePtr` is exactly `T*` (4 B) + `unsigned int` (4 B), so it fits the
  64-bit path — **provided** the `_WIN64` 16-byte branch (`:28-70`) is not
  selected. Whether emscripten lowers the i64 CAS to `i64.atomic.rmw.cmpxchg` or
  to an emulated lock must be read out of the produced `.wasm` before any
  multi-context claim; in single-context mode the distinction does not matter.
- In single mode every `MT::Mutex`/`Lock`/`Event`/`Semaphore`/`RwLock` is a
  no-op with a debug counter. That is honest for one context; it must not be
  described as a thread-safe implementation.

### 3.4 Scheduler backend (`jobqueue_web.cpp`)

Mirror `jobqueue_xenon.cpp` minus all OS types:

| Function | Single-mode behaviour |
| --- | --- |
| `_Init` | `jqMaxWorkers = 0`; no events. Report the value in startup metadata. |
| `_Start` | create zero contexts; `jqNWorkers = 0`; build the **flattened** policy order (§3.5). |
| `_jqStop` | assert all counts are zero; free. |
| `_AddTask` | no-op (already empty on PC, `jobqueue_xenon.cpp:112-114`). |
| `jqAlertWorker` | no-op. |
| `jqWorkerSleep` | `return false` — never called because `jqWorkerLoop` is only entered with `iWorkerID == -1`. |
| `jqLockBatchPoolInternal` | plain assign; keep the function so call sites are unchanged. |
| `Flush` | drain loop, then assert counts are zero; **ignore `bRunJobs`** (documented deviation). No `pEvent->Wait()`. |
| `Poll` | drain up to a budget, then report counts (see `jqRunPending`). |
| `jqAssistWithJobs` | drain inline until the callback returns true, then return. |
| **`jqRunPending(budgetMs, maxTasks)`** (new, web-only) | the cooperative pump: run pending tasks within budget, return the number run. Called once per frame. **Without this, `Poll`-based streaming never completes** (`streammanager.cpp:500`). |
| `GetNumWorkers` | 0. `jqGetMaxWorkers` 0. `jqGetCurrentThreadID`/`MainThreadID` both 1. |

Also required: `JQ_GROUP_LABEL` dependencies must **fail loudly** in single mode
if a `Flush` would need a fence that only the renderer can advance. There is
exactly one such call site, `graphics/deferred/source/prepass/spu/Lighting.cpp:224`
(write-fence address). It is renderer-only and outside the slice; the group must
assert rather than spin.

### 3.5 Policy flattening (the fix for §1.5)

Web policy table rule: for each game policy, take the **maximum across its 8
columns** and replicate it into all 8 columns. Then:

- `GenerateWorkerPolicyOrder(..., column)` is column-invariant, so the single
  context may use any column.
- No policy is disabled, so no task is unrunnable and `Batch.iCPUBits != 0`
  holds (`jobqueue.cpp:265`).
- Relative priority order between policies is preserved (max is monotone).

`SchedulerConfig.cpp` is game code; the flattening belongs in the web scheduler
backend (`CreatePolicy`), not in the game file, so a future worker pool uses the
original table unchanged.

### 3.6 Preventing main-thread blocking

Hard rules for the web build, all mechanically checkable:

1. **No wait whose completion depends on another context.** The only waits the
   engine performs are `Flush` (self-draining), `MT::Event::Wait`, `Mutex::Wait`
   and `MT::Thread::Join`. In single mode the latter three must assert, because
   they can only succeed with a concurrent producer.
2. **Never map a wait to `Atomics.wait`.** It throws on the main thread. Map
   `tlSleep` to a logged no-op (it has one call site) and `YieldThread` to a
   no-op (already a no-op on PC).
3. **Budgeted pump.** `jqRunPending` runs at most `maxTasks` or `budgetMs` per
   frame and logs when it is capped. That log is the honest signal "the serial
   model is out of budget", and the trigger for reconsidering model C.
4. **No synchronous large decode.** T-005b's file layer must resolve promises
   between frames; the scheduler must not be used to hide a blocking read.
5. **Frame loop never busy-waits.** The only loop is
   `requestAnimationFrame`; `Blur2PCFrameLimitWait` (`Timer.cpp:15-44`) must not
   be ported (it busy-spins with `Sleep`).

---

## 4. Fixed-step simulation and interpolation

### 4.1 The rule this design is bound by

`upstream/BlurRebuilt/AGENTS.md:24`:

> Every implementation must run correctly with an unlocked frame rate… The
> simulation keeps its fixed-step cadence while rendering runs at any rate, so
> code that assumes one rendered frame per game tick is a fault… New or ported
> code must advance by elapsed time or fixed simulation ticks with interpolation,
> never by rendered-frame count. This is a design rule: nothing may be
> implemented in a way that only works at 60 Hz.

T-005c must therefore not introduce a second, competing time base, and must not
make any new decision "per rendered frame".

### 4.2 What already exists and must be reused

The PC build already has the decoupled loop; the browser driver is a
re-implementation of it, not a new mechanism:

- `C_Application::IdleLoop` (`framework/source/application/ApplicationPC.cpp:480-590`):
  accumulator in seconds, `tick = 1/60`, `ticks = floor(accum / tick)`, capped at
  **4** (`:518-519`), leftover kept, and the game is told exactly the consumed
  time via `g_Blur2PCForcedFrameTime = ticks * tick` (`:523`).
- Render interpolation alpha `= accum / (1/60)`, clamped to `[0,1]`
  (`:543-544`), fed to `Cam2::I_Feed::SetRenderOffset(alpha - 1)` and
  `WorldRender::Blur2PCInterpBeginRender(alpha)` (`:545-546`).
- The game converts that into integer steps itself:
  `C_GameWorld::CalcNumberOfSteps` (`amax/game/Game/GameWorld/GameWorld.cpp:2488-2520`)
  accumulates `GetTimeStepRaw()` and rounds to `baseRate = 60` (or 50 if
  `g_TimeStep50Hz` and a 50 Hz display), producing `m_GameStep`.
- `m_GameStep` drives nested physics sub-updates, capped by
  `g_maxPhysicsUpdates` (2 in the shipped config, `GameWorld.cpp:199`
  vs `:201`), at `:2601-2603`.
- `Timer.cpp:85-99` documents the exact bug this rule exists to prevent: the old
  1/60 floor made the game run `fps/60` times too fast above 60 fps.

### 4.3 Proposed web loop (pseudo-code, not implementation)

```text
onAnimationFrame(now):
    dt = (now - last) / 1000; last = now
    if dt > kPauseThreshold (0.25 s):     # tab throttled / devtools paused
        accum = 0                       # do not fast-forward the simulation
    else:
        accum += dt
    ticks = min(floor(accum / (1/60)), 4)
    accum -= ticks * (1/60)
    if ticks > 0:
        forcedFrameTime = ticks / 60     # the existing seam
        OnUpdate()                       # runs exactly `ticks` game steps
    alpha = accum / (1/60)               # clamp [0,1]
    jqRunPending(budget)                 # cooperative scheduler pump
    OnRender(alpha)
```

Rules:

- `ticks` comes **only** from monotonic elapsed time. No `frameCount++` may
  influence simulation state.
- The 4-tick cap is the existing PC value (`ApplicationPC.cpp:518`); the
  catch-up clamp must be justified against it, not invented.
- A long gap is a **pause**, not a fast-forward. The 0.25 s threshold is a
  proposal; the 4-tick cap alone already bounds the step, but without the pause
  rule the simulation would silently lose time in a way the user cannot see.
- `jqRunPending` sits **between** the fixed step and render submission, so a
  frame's jobs are visible to that frame's render, matching the current
  `Flush`-before-read pattern in streaming.
- Interpolation reads only state from the last two steps; it must never advance
  simulation state. Camera, model matrices and effects already have the hook
  (`WorldRender::Blur2PCInterp*`, `Cam2::I_Feed::SetRenderOffset`).
- The clock source is `platform/time`, monotonic. `performance.now()` resolution
  may be coarsened by the browser (Spectre mitigations); measure it and record
  it, and never assume millisecond granularity is the simulation quantum. Tick
  count is the contract, not elapsed identity.

### 4.4 Display refresh rate must be stable and not 50 Hz

`CalcNumberOfSteps` (and two other sites, `GameWorld.cpp:2326`, `:2594`) branch
on `Display::Device()->GetRefreshRate()` when `g_TimeStep50Hz` is set. That debug
flag defaults to `false` (`GameWorld.cpp:300`), so the web build must (a) keep it
false and (b) have the display adapter report a **stable 60 Hz** value rather
than a measured panel rate. Otherwise the simulation cadence becomes
device-dependent, which is the exact fault class the upstream rule forbids.

---

## 5. Minimal first slice and acceptance

### 5.1 Scope

Goal: `Scheduler::` works under `PLATFORM_WEB` in node and in a browser with one
execution context, and the fixed-step driver is proven frame-rate independent
without the engine.

In scope:

1. `PLATFORM_WEB` + `TL_PLAT_WEB` (`mercury_to_tl.h`, `tl_defs.h`,
   `tl_thread.h`).
2. `platform/thread` + `platform/atomic` + `platform/time` web branches
   (`Atomic.h`, `Misc.h`, `ThreadLocalStorage.h`, `Thread.h`,
   `Mutex.cpp`, `Event.cpp`, `Time.cpp`).
3. `jobqueue_web.h` / `jobqueue_web.cpp` selected by `TL_PLAT_WEB`, including
   `jqRunPending` and policy flattening.
4. A standalone probe `probes/scheduler-probe/` (new directory, disjoint from
   `probes/asset-reader/`) with a native and a wasm target and a node verifier,
   wired into `tools/verify_asset_probe.py` as two new steps (27 → 29).
5. The fixed-step driver as a pure function in the probe (no engine types), so it
   is testable in node.

Out of scope: workers, SharedArrayBuffer, `-pthread`, physics, audio, renderer,
`Input`, any change to `SchedulerConfig.cpp`, any change to a `Scheduler::`
call site other than the two documented audio deviations.

### 5.2 Acceptance tests

Each item must be recorded with a command, an exit status and a log path under
`_work/`, per `AGENTS.md` ("No claim without evidence").

| # | Gate | Evidence |
| --- | --- | --- |
| **A1** | `system/scheduler/jobqueue`, `misc_shared/Compression/Inflate`, `misc_shared/archive/serialiser` compile with `-DPLATFORM_WEB` and **no** workaround flags | per-TU logs; this is T-005a port-order step 3, re-run with the web identity |
| **A2** | Node smoke: N tasks across 2 groups with a dependency; `Flush`; every task ran exactly once, dependency order respected, counts back to 0, `Poll` true afterwards | `verify_sched_wasm.mjs` JSON |
| **A3** | **Policy coverage**: build the four game policies from `SchedulerConfig.cpp:34-50` and prove a task added with each (especially `piStreamer`) actually executes | this is the regression test for §1.5 |
| **A4** | **Serial-layout assertions**: `GetNumWorkers()==0`, `jqGetMaxWorkers()==0`, `Flush(g,false)` completes and runs the task | documents the deliberate `bRunJobs` deviation |
| **A5** | **Fixed-step driver, pure**: for frame-delta traces {144 Hz × 600, 30 Hz × 300, one 250 ms hitch, one 5 s tab gap, one 8 ms jitter stream} the tick counts, accumulator remainder and alpha match an independent Python reference exactly | native + wasm + Python three-way, mirroring the existing "native/WASM JSON and independent Python references must agree" gate |
| **A6** | **Frame-rate independence**: same simulated duration delivered as 600 small frames vs 150 large frames produces an identical final state hash (the driver's deterministic title state) | hash equality; repeated runs identical |
| **A7** | Browser smoke: page loads the same wasm, runs the synthetic-delta driver and a `requestAnimationFrame`-driven run over the same simulated duration, both print the same hash; screenshot + clean console | screenshot path + console log |
| **A8** | No regression: `python tools/verify_asset_probe.py --skip-build` 27/27 → **29/29**; CTest 14/14 | `_work/verification/suite.json` |

A5/A6 are the real T-005c deliverable. A1–A4 are the compile/link unblock from
T-005a. A7 is the project's browser gate. A8 is the standing gate.

### 5.3 What may legitimately remain stubbed in the first slice

- `MT::Thread::Start/Join` → refuse with a named assert; no consumer is exercised
  until T-005d/f.
- `MT::Mutex`/`Lock`/`Event`/`Semaphore`/`RwLock` → counters/no-ops, with an
  assert on any blocking wait.
- `jqAssistWithJobs` → inline drain (small, but keep the exact signature).
- `JQ_GROUP_SPURWLOCK` / `JQ_GROUP_LABEL` → implemented as "unsupported in
  single mode", asserting with the group id.
- All `MT::Thread` consumers except the job queue → not started; each gets an
  explicit entry in the T-005c log naming the subsystem and the frame-loop pump
  that will replace it (layer manager, loader, streamer, save, pakfs).
- Anything GPU-fence related.

Being explicit about these is a project requirement, not a convenience: a stub
must be a documented failure, never a pretend-parallel pass.

---

## 6. Risks

1. **Single-threaded success hides real races.** The PC build runs 6–7 workers;
   any shared write not protected by a group boundary is latent today. Passing
   A2/A6 does **not** prove thread safety, and must not be reported as such. The
   determinism hash is a *frame-rate* gate, not a race detector.
2. **`Flush(group, false)` (2 audio sites) is unrepresentable** with one context.
   The proposed deviation (always drain) must be written at both sites with a
   removal task, or audio init hangs.
3. **Policy column 0 silently drops `piStreamer`** (§1.5) → infinite `Flush` in
   streaming. A3 exists solely to catch this; without flattening, the slice can
   appear to work until the first decompression.
4. **`Task::iCPUBits` assertion.** `jobqueue.cpp:265` asserts a non-zero mask; a
   web policy table with an all-zero column produces an assert at `AddTask`
   rather than at the real fault. Flattening fixes it, but the assert message
   should name the policy.
5. **8-byte atomics.** `jqAtomicQueuePtr` needs a 64-bit CAS on wasm32. It fits
   (4+4) and the `_WIN64` 16-byte path must not be compiled in; whether the i64
   CAS is a real wasm atomic or an emulated lock must be checked in the artifact
   before any multi-context claim.
6. **Emscripten pthreads, if ever enabled.** Requires COOP `same-origin` + COEP
   `require-corp` on every response, a cross-origin-isolated origin (third-party
   asset hosts and some CDNs will fail), fixed memory (no post-start growth),
   and it changes `pthread_create` failure handling. This is the main reason B is
   not the first step.
7. **Browser throttling.** `requestAnimationFrame` stops in background tabs;
   devtools pauses, and cross-origin iframes can be throttled. Without the
   pause rule in §4.3, the first frame after resume injects a huge delta. The
   4-tick cap bounds the *step*, but the accumulator must also be dropped, or
   the simulation silently fast-forwards when the user returns.
8. **Clock quantisation.** `performance.now()` may be coarsened; a driver that
   compares absolute times for identity will jitter. Use tick counts as the
   contract.
9. **Frame-rate faults in ported consumers.** Upstream AGENTS.md:24 names audio,
   physics, shaders/effects, particles, animation and cameras as systems that
   already needed frame-rate fixes. Any T-005d…T-005g consumer that advances per
   rendered frame will behave differently at 144 Hz and will not be caught by A5
   (which tests the driver, not the consumer). Each ported system needs its own
   "advanced by elapsed time or fixed tick" review.
10. **Audio cannot use this scheduler as a clock.** The worklet has its own
    real-time thread and a 128-frame quantum. If the serial main thread stalls,
    audio must keep playing from its own buffers — the scheduler must never be
    on the audio path.
11. **Determinism of float.** wasm32 is IEEE-conformant with no x87 excess
    precision, which helps, but contraction/reassociation flags still change
    results. Record the exact compile flags next to every hash; if hashes
    diverge, record the divergence rather than loosening the test.
12. **Deadlock classes to keep banned by construction:** waiting on
    `MT::Event`/`Mutex` with one context; `Flush` on a group whose only producer
    is a `JQ_GROUP_LABEL` fence; `jqWorkerLoop` with `iWorkerID >= 0`; and any
    `while` loop whose exit condition is owned by another context.

---

## 7. What this document does not prove

- No code was written, compiled or run for T-005c. The only compile evidence in
  this project remains the T-005a probe.
- `jqNWorkers == 0` is a source-level reading of `jobqueue.cpp:197` +
  `jobqueue_xenon.cpp:33`; it was not executed.
- The policy-flattening defect (§1.5) is derived by reading
  `GenerateWorkerPolicyOrder`, `jqPopNextBatch` and `SchedulerConfig.cpp`. It is
  not an observed hang.
- wasm32 lowering of the 64-bit queue CAS, `performance.now()` granularity in
  the target browser, and rAF throttling behaviour under COOP/COEP were not
  measured.
- No browser, GPU or audio behaviour is claimed anywhere in this document.

## 8. Source index

| Path (under `upstream/BlurRebuilt/code/`) | Used for |
| --- | --- |
| `mercury/library/common/system/include/system/scheduler/jobqueue.h` | scheduler API, task/group structs |
| `.../scheduler/jobqueue_xenon.h`, `jobqueue_generic.h` | per-platform headers, stale serial scheduler |
| `.../scheduler/core/tl_defs.h`, `mercury_to_tl.h`, `tl_thread.h` | platform identity, `tl_*` contract |
| `.../source/scheduler/jobqueue.cpp` | AddTask, groups, policies, counters |
| `.../source/scheduler/jobqueue_xenon.cpp` | worker lifecycle, Flush, batch-pool lock |
| `.../source/scheduler/jobqueue_kernel.cpp` | pop/execute loop, dependency checks |
| `.../source/scheduler/jobqueue_kernel_xenon.cpp` | worker sleep, batch execute |
| `.../source/scheduler/jobqueue_generic.cpp` | legacy serial reference (stale API) |
| `.../scheduler/jobqueue_task_queue_lf.h` | 8-byte pointer/count CAS |
| `.../core/include/core/threads/{Atomic,Misc,Mutex,Event,Thread,ThreadLocalStorage,SpuEvent}.h` | primitives |
| `.../core/source/threads/{Mutex,Thread}.cpp` | platform branches that break |
| `.../system/include/system/time/Time.h`, `.../source/time/Time.cpp` | clock |
| `mercury/library/gamesys/framework/source/timer/Timer.cpp` | frame-time clamp, frame limiter |
| `.../framework/source/application/ApplicationPC.cpp` | existing decoupled loop |
| `.../framework/source/application/ApplicationBase.cpp` | timer/`ForceFrameTime` wiring |
| `amax/game/Game/GameWorld/GameWorld.cpp` | `CalcNumberOfSteps`, physics sub-steps, 50 Hz branch |
| `mercurygame/game/SchedulerConfig.cpp` | real policy and group table |
| `mercury/library/physics/gravity/source/sdk/Scene.cpp` | physics uses queue+Flush |
| `mercury/library/graphics/renderingdata/.../streammanager.cpp` | `Poll`-based streaming, label dependency |
| `mercury/library/audio/source/{ObjectManager,BatchFrameAdd}.cpp` | `Flush(..., false)` sites |
| `mercury/library/gamesys/framework/source/layer/LayerManager.cpp` | non-job-queue thread that must be pumped |
