# T-007 reset fix — one wasm instance can be rebuilt (10+ cycles)

**Date:** 5 November 2026
**Owner:** P40 (sub-agent)
**Scope:** `probes/e1-drive/**`, `_work/e1-drive/**`, `_work/logs/e1-drive/**`,
`docs/work/analysis/e1-drive-slice.md` §17 and this record. No change to the
engine tree, `engine/patches/`, `probes/car-parts/`, `probes/render-packet/`,
`tools/`, `upstream/` or `game-data/`. The engine overlay was **not** touched:
the defect is in how this library builds its `C_Scene`, not in the engine.

## Result

The measured limit "a 3rd `e1_reset()` / 4th `e1_create()` in one instance
aborts" is **fixed**. The root cause was **two uninitialised `C_Scene` members**:
the scene's scheduler group handles. This library created a `C_Scene` and set its
task policy but never its groups, so `C_Scene::WaitForDeferredContacts()` called
`Scheduler::Flush()` with whatever four bytes the heap block happened to hold.
On the first heap reuse those bytes were a valid-looking index whose
`TaskGroup::NDependencies` was also stale heap data, so `Flush` walked a garbage
dependency list and indexed outside `jqPool.BatchGroupPool`.

The fix creates the two groups with `Scheduler::CreateGroup()` per built world,
installs them with `SetInternalGroupHandle`/`SetBroadPhaseGroupHandle` (the same
two calls the retail game makes from `GameWorld.cpp:562-563`), and destroys them
after the scene is released, so the group pool does not grow.

Measured after the fix, one wasm instance each:

| evidence | result |
| --- | --- |
| create/reset cycles, 5 cars | **10/10** per car (alternating `e1_reset`/`e1_create`), 0 abort |
| state hashes per cycle | identical 30-tick hash sequence in all 10 cycles per car |
| telemetry in one instance | **6 manoeuvre runs** (series twice), 1 `e1_create` + 5 `e1_reset`, hashes and metrics bit-identical to the fresh-instance reference |
| sprint restart (`R`/API) | second attempt reproduces the finish tick, finish time, input sequence and every state hash |
| module heap | constant **268,435,456 B** (no growth) |
| scheduler pool | size 16, free-list head **5** before and after every rebuild, queued **2** steady state, group dependencies **0** |
| NaN | 0 |

`verify_e1_drive.mjs` is **488/488 PASS** (423 previous + 65 new). Headless
Edge/WebGPU: sprint restart 5/5 cars and telemetry `R` are
`clean-console-and-gates` with **0 console messages**; the legacy 15-capture
sprint pass (12/15 exact packet hashes, the same three documented last-bit
transcendental differences) and the 4-capture Corvette drive regression (4/4
exact) are unchanged. No physics anchor moved (all five drive/sprint/packet
hashes are the P36/P37 values).

## The defect, measured

### Reproduction (before the fix)

`probes/e1-drive/tools/repro_reset.mjs` drives the sequence in **one** instance
and records every call. With the unfixed module:

```text
status: ABORT, cyclesCompleted: 2, requested: 6
0:build  e1_create  resets=1  heap=268435456
1:build  e1_reset   resets=2
1:drive
2:build  e1_create  resets=1
2:drive
                 <- 3rd rebuild (e1_reset) traps
failure: RuntimeError: memory access out of bounds
```

The trap stack, resolved with a `-g` + symbol-map build
(`build_module.mjs --debug`, artifacts under `_work/e1-drive/module/`):

```text
Scheduler::Flush(int, bool, unsigned int)
Scheduler::Flush(int)
Gravity::C_Scene::WaitForDeferredContacts(Maths::HF32)
Gravity::C_Scene::_Simulate(...)
Gravity::C_Scene::Simulate(...)
e1::BuildWorld()
e1::e1_reset
```

So the abort happened inside the 180-tick settle phase of the *rebuild*, in a
flush the scene issues before it reads deferred contacts (Scene.cpp:3006-3015).

### Root cause

`Scheduler::Flush(GroupID)` with `GroupID != JQ_GROUP_NONE` indexes
`jqPool.BatchGroupPool[GroupID]` and walks `TaskGroup::Dependencies[0 ..
NDependencies)` (`jobqueue_web.cpp:129-201`). `SetGroupPoolSize(16)` only links
the free list (`Next`) and resets the pool head; it does **not** initialise any
`TaskGroup` (`jobqueue.cpp:389-412`). A group is only initialised by
`CreateGroup()` (`jobqueue.cpp:452-483`: `NDependencies = 0`, counters = 0).

`C_Scene` never creates a group. Its constructor has that call commented out and
does not initialise the members:

```cpp
// Scene.cpp:133-136
//m_Group = Scheduler::CreateGroup();
//m_BroadPhaseGroup = Scheduler::CreateGroup();
```

`m_Policy`, `m_Group` and `m_BroadPhaseGroup` (Scene.h:380-382) are plain members
with no default value. The retail game assigns two real groups right after it
creates the scene:

```cpp
// GameWorld.cpp:562-563
m_pPhysicsScene->SetInternalGroupHandle(C_SchedulerConfig::GetInstance()->GetGroup(E_SchedulerGroup_PhysicsInternal));
m_pPhysicsScene->SetBroadPhaseGroupHandle(C_SchedulerConfig::GetInstance()->GetGroup(E_SchedulerGroup_PhysicsInternal2));
```

This library's `BuildWorld()` did only the policy half (`GameWorld.cpp:561`).

The diagnostic export added for this investigation (`e1_diag`) shows the value
directly. On a fresh Emscripten heap the `C_Scene` block is zero, so
`m_Group == 0` happens to be in range and the scene flushes group 0 — which also
was never `CreateGroup()`'d, but whose uninitialised counters were zero, so the
flush returned immediately and the queued work was drained by the next flush.
That is why the path worked the first times. When `new C_Scene` reuses a freed
block, the same offset contains a different number:

| build | `diag.group` (m_Group) | `poolHead` | outcome |
| --- | ---: | ---: | --- |
| 1 (`e1_create`) | 0 | 3 | settle works |
| 2 (`e1_reset`) | 0 | 3 | settle works |
| 3 (`e1_create`) | **10** | 3 | settle works |
| 4 (`e1_reset`) | (stale) | 3 | `Flush` walks a garbage dependency list → out of bounds |

The value is not a group anyone created (`CreateGroup` was never called), so
`NDependencies` and `Dependencies[]` are heap leftovers; `Flush` read one as a
dependency index and recursed out of the 16-slot pool. This also explains why the
"limit" looked like "about three rebuilds": it was heap reuse, not a counter in
the engine.

Nothing was papered over: no reload, no second module, no engine patch. The scene
now owns what it flushes.

### The fix (`probes/e1-drive/native/e1_drive_lib.cpp`)

```cpp
// BuildWorld(), immediately after CreateScene + SetInternalTaskPolicy
gWorld.group = Scheduler::CreateGroup();
gWorld.broadPhaseGroup = Scheduler::CreateGroup();
scene->SetInternalGroupHandle(gWorld.group);
scene->SetBroadPhaseGroupHandle(gWorld.broadPhaseGroup);
```

```cpp
// ReleaseWorld(), after ReleaseScene (the destructor flushes both handles)
if (gWorld.broadPhaseGroup != Scheduler::JQ_GROUP_NONE)
    Scheduler::DestroyGroup(gWorld.broadPhaseGroup);
if (gWorld.group != Scheduler::JQ_GROUP_NONE)
    Scheduler::DestroyGroup(gWorld.group);
```

`World` initialises both handles to `JQ_GROUP_NONE`, so a failed build cannot
destroy a group it did not create. `DestroyGroup` flushes the group and returns
it to the pool, so a rebuild reuses handle 0/1 rather than consuming slots. The
pool holds 16 slots; 3 are taken once by physics statics
(`integrate.cpp:30-31`, `carnetworkphysics.cpp:43`), 2 by the live scene, so the
free-list head is 5 after every build and the pool never grows.

A diagnostic export, `e1_diag()`, was added to the module so this can be
measured rather than guessed. It returns the live scene/body/car pointers, the
scene's group handle and policy, and the scheduler pool (size, head, global
counters, per-group queued/executing/dependencies/next/event). It is not used by
the physics path.

## Evidence

### 1. Reset cycles — 10 per car, one instance each

`_work/e1-drive/reset-cycles.json`, written by the verifier. Per car the
instance is built with `e1_create`, then rebuilt 9 more times alternating
`e1_reset`/`e1_create`, and the same 30 scripted ticks are replayed after every
rebuild.

| car | cycles | reset rows | identical trace hash | heap | pool head | group handles | deps |
| --- | ---: | ---: | --- | --- | --- | --- | --- |
| Corvette ZR1 | 10 | 5 | yes | 268,435,456 B | 5 | 0 (all) | 0 |
| Lotus Exige | 10 | 5 | yes | 268,435,456 B | 5 | 0 (all) | 0 |
| Dodge Challenger | 10 | 5 | yes | 268,435,456 B | 5 | 0 (all) | 0 |
| Ford Focus RS | 10 | 5 | yes | 268,435,456 B | 5 | 0 (all) | 0 |
| Audi R8 V10 | 10 | 5 | yes | 268,435,456 B | 5 | 0 (all) | 0 |

Each cycle starts at tick 0 with all four wheels on the ground (`contacts
"1111"`), 0 non-finite states, and the per-tick state hash sequence is identical
across the ten rebuilds. The verifier also checks that each rebuild's group
handle is inside the pool, was created (`dependencies == 0`, `executing == 0`)
and that its queued count is the same steady-state value (2) in every cycle —
that steady state is the physics timer's two deferred batches at the end of a
tick, not a leak (it is 2 after the very first build and does not grow).

`repro_reset.mjs --cycles 20 --mode reset` and `--mode create` were also run
beyond the acceptance minimum: 20 `e1_reset()`s and 20 `e1_create()`s complete
in one instance with the same heap and pool.

### 2. Telemetry in one instance

`runTelemetrySeries()` calls `reset()` before each of its three manoeuvres, so
the same instance now runs **six** manoeuvre runs (the whole series twice) with
one `e1_create` and five `e1_reset`s. Per car (`run.json` →
`resetCycles.telemetrySeries`):

- every per-tick state hash of every manoeuvre equals the fresh-instance
  reference run, in both passes;
- the measured metrics are unchanged (Corvette 0–100 3.650 s, brake 14.83 m,
  lateral 0.86 g; Audi 2.650 s / 13.34 m / 1.52 g; and the other three as in
  `T-007-telemetry.md`);
- heap size identical before/after, 0 NaN.

The page now uses `createWasmResetEngineSet` (one module, `e1_reset` between
manoeuvres) instead of three instances, and `R` re-runs the series in the same
instance instead of `location.reload()`.

### 3. Sprint restart (`R` / API) without a reload

`runSprintRestart()` in the verifier and `--mode restart` in the browser:
the first scripted sprint finishes, `e1_reset()` (+ `sprintRules.reset()`) runs,
and the same script is executed again in the same instance.

| car | finish | restart finish | finish tick | input hash | state trace hash |
| --- | ---: | ---: | ---: | --- | --- |
| Corvette ZR1 | 2.800 s | 2.800 s | 258 | identical | identical |
| Lotus Exige | 2.850 s | 2.850 s | 261 | identical | identical |
| Dodge Challenger | 3.000 s | 3.000 s | 270 | identical | identical |
| Ford Focus RS | 3.267 s | 3.267 s | 286 | identical | identical |
| Audi R8 V10 | 2.283 s | 2.283 s | 227 | identical | identical |

The browser pass additionally proves the restart is in place: the probe's
`restarts` counter goes 0 → 1 (it cannot survive a page reload), the phase is
`countdown` with `elapsedTicks = 0`, `sprintResult` is cleared, the stored best
time in `localStorage` is kept, the packet re-renders (9 matrices, one draw per
draw per frame), and the console is clean. Screenshots:
`_work/e1-drive/browser-<slug>-sprint-restart-{before,countdown,finish}.png`.

Telemetry `R`: `_work/e1-drive/browser-corvette-zr1-stock-telemetry-restart-{before,after}.png`,
`browser-evidence-telemetry-restart.json` — `instances = 1`, 4 world builds
before R and 7 after, `restarts = 1`, every trace hash and every metric identical,
heap unchanged.

### 4. Determinism, memory and handles

- **Determinism:** the verifier's existing two-independent-instance and
  input-replay checks still pass for all cars; the 10-cycle hashes add an
  in-instance determinism proof. `PHYSICS_ANCHORS` (5 drive, 5 packet, 5 sprint)
  are unchanged.
- **Memory:** `module.HEAPU8.length` is 268,435,456 B at every one of the 50
  rebuilds and after the 6-manoeuvre telemetry series. No growth, no growth
  events (`ALLOW_MEMORY_GROWTH` never triggered).
- **Handles:** the scheduler pool free-list head returns to 5 and the per-group
  counters return to their steady state after every rebuild; no `TaskGroup` slot
  is consumed per cycle. The physics `C_Body` and `Car` objects are allocated and
  freed per world as before (`ReleaseWorld`).

## Limits (remaining, recorded)

- **This fixes the rebuild path, not the world's lifetime design.** Each
  `e1_reset()`/`e1_create()` still rebuilds the whole scene, re-imports the level
  and re-runs the 180-tick settle (15–37 ms measured), so a restart is a
  one-frame hitch, not a resumable hot reload.
- **Two groups per world is the lifetime this library chose.** The retail game
  creates its groups once at scheduler init and lives with one scene; a world
  that rebuilt 16 times *without* destroying its groups would exhaust the
  16-slot pool and `CreateGroup` would fail loudly (`jobqueue.cpp:457-462`). We
  destroy them instead, and the verifier checks the head does not move.
- **The steady-state queue count (2) is not zero.** It is the physics timer's
  two deferred batches at the end of a tick, identical in the first build and the
  tenth. It is reported, not hidden; a value that grew would fail the check.
- **One measured strip, not a lap.** Unchanged from `T-007-telemetry.md` and
  `T-007-sprint-rules.md`: 29 m of drawn road, no lap, no second sector.
- **No retail-fidelity claim, no full-game claim.** One car at a time, one
  diagnostic validation strip, unchanged physics, diagnostic materials/visuals.
- **Native parity** is still blocked by the DirectX SDK (`T-007-vehicle-physics.md`).

The rebuild-limit paragraph in `T-007-telemetry.md` (Limits) is **Superseded**
by this record: telemetry no longer needs one fresh instance per manoeuvre and
`R` no longer reloads the page. The historical text is left in place; this
record is the replacement.

## Commands

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

# reproduce the old limit / prove 10+ cycles (one instance, alternating entry points)
& $node probes/e1-drive/tools/repro_reset.mjs --cycles 10
& $node probes/e1-drive/tools/repro_reset.mjs --cycles 20 --mode reset
& $node probes/e1-drive/tools/repro_reset.mjs --cycles 20 --mode create
# the same sequence with the resolved wasm stack (diagnostic build)
& $node probes/e1-drive/tools/build_module.mjs --debug
& $node probes/e1-drive/tools/repro_reset.mjs --debug

# 488 checks: reset cycles, one-instance telemetry, sprint restart, plus the
# existing drive/sprint/telemetry/packet gates
& $node probes/e1-drive/tools/verify_e1_drive.mjs

# browser: R on a finished sprint (5 cars) and R in telemetry (no reload)
& $node probes/e1-drive/tools/capture_browser.mjs --mode restart --port 8831
& $node probes/e1-drive/tools/capture_browser.mjs --mode telemetry-restart --port 8833
# legacy regression
& $node probes/e1-drive/tools/capture_browser.mjs --mode telemetry --port 8835
& $node probes/e1-drive/tools/capture_browser.mjs --mode sprint --port 8837
& $node probes/e1-drive/tools/capture_browser.mjs --car corvette-zr1-stock `
      --label-prefix resetfix-drive --evidence-name browser-evidence-drive-resetfix.json --port 8839
& $py tools/verify_asset_probe.py --skip-build
```

## What changed

| file | change |
| --- | --- |
| `probes/e1-drive/native/e1_drive_lib.cpp` | create/set/destroy the scene's two scheduler groups; `e1_diag()` diagnostic export |
| `probes/e1-drive/tools/repro_reset.mjs` | **new**: minimal one-instance create/reset reproduction, cycle log, heap/pool record |
| `probes/e1-drive/tools/build_module.mjs` | `--debug` build (`-g`, assertions, symbol map) for resolving wasm traps; `_e1_diag` export |
| `probes/e1-drive/web/telemetry.js` | `createWasmResetEngineSet`: one instance, `e1_reset` between manoeuvres; reference set kept |
| `probes/e1-drive/web/app.js` | telemetry uses one instance; `R` re-runs in place (no reload); `restarts` counter; panel shows world builds |
| `probes/e1-drive/tools/verify_e1_drive.mjs` | 65 new checks (10-cycle rebuilds, one-instance telemetry, sprint restart); `reset-cycles.json` |
| `probes/e1-drive/tools/capture_browser.mjs` | `--mode restart`, `--mode telemetry-restart`; evidence files and screenshots; telemetry recording of builds/resets |
| `probes/e1-drive/README.md` | API (`e1_diag`), telemetry one-instance section, restart evidence, limits updated |
| `docs/work/analysis/e1-drive-slice.md` §17 | analysis record; §16.7 bullet marked superseded |
| `docs/work/verification/T-007-reset-fix.md` | this record |

## Evidence paths

| path | content |
| --- | --- |
| `_work/e1-drive/reset-cycles.json` | 10 cycles × 5 cars (per-cycle hashes, heap, pool, group handles), one-instance telemetry comparison, sprint restart |
| `_work/e1-drive/run.json` → `resetCycles` | the same results inside the main report (488 checks) |
| `_work/logs/e1-drive/repro_reset.log` | last reproduction run (status, steps, failure stack if any) |
| `_work/e1-drive/browser-evidence-restart.json` | 5 sprint restarts: first/second finish, hashes, best kept, console |
| `_work/e1-drive/browser-evidence-telemetry-restart.json` | telemetry `R`: builds 4 → 7 in one instance, identical hashes/metrics |
| `_work/e1-drive/browser-<slug>-sprint-restart-{before,countdown,finish}.png` | sprint restart screenshots (5 cars) |
| `_work/e1-drive/browser-corvette-zr1-stock-telemetry-restart-{before,after}.png` | telemetry `R` screenshots |
| `_work/e1-drive/browser-evidence-sprint.json`, `browser-evidence-telemetry.json`, `browser-evidence-drive-resetfix.json` | legacy regression passes |
| `_work/e1-drive/module/{e1_drive_debug.wasm,.symbols}` | diagnostic build used for the trap stack (not shipped) |
| `_work/logs/e1-drive/verify.log` | every check label and result |
| `_work/logs/e1-drive/edge-restart.log`, `edge-telemetry-restart.log`, `edge-sprint.log`, `edge-telemetry.log` | Edge runs |
| `_work/logs/e1-drive/verify-asset-probe-p40.log` | portable suite run |
