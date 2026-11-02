# T-005d — Physics feasibility: the smallest Gravity/RacingPhysics subset for wasm32

**Date:** 2 November 2026
**Status:** read-only feasibility analysis. No `upstream/`, source, build file, task
card or game data was modified; the game was not run; nothing was implemented.
**Owner:** P6 (sub-agent, read-only)
**Scope:** identify the smallest physics subset that can plausibly run as
`wasm32`, what blocks it today, and how it can be compared against the native
reference. This document claims no port, no build, and no measured runtime.

**Method.** Source reading of `upstream/BlurRebuilt` at
`5270304b81983b9e3edbd569ba25235c17bbabd7`, plus fresh `-fsyntax-only`
measurements of real physics translation units with the Emscripten 6.0.13
toolchain already used by T-005a. Counts below are **clang error lines**, which
are diagnostics, not defect counts; a cascading header can turn one mistake into
dozens of lines. No artifact was written (this task allowed one document).

---

## 0. Summary

1. The **live** vehicle-physics loop is: `C_Scene::Simulate` → vehicle
   `IntegrationCallback` → `Car::Integrate` → `ArticulatedBody::Integrate`
   (fixed sub-steps, RK4 or Euler) → per-wheel ground query through
   **Gravity's static triangle-mesh line cache**. The wheel/tyre/suspension
   forces come from the car's own integrator; Gravity's **broadphase
   distribution tree is dead code** (`#if 0`) and the **ATG thread-pool
   scheduler is compiled out entirely**. Gravity's contact solver does still run
   and re-enters the car only through `Car::CopyFromGravity`, so it cannot be
   ignored for body-vs-world collisions.
2. The small subset that reaches the ground query is **Gravity: 9 source
   directories / 58,759 lines** plus **RacingPhysics: 11,436 lines**. That is not
   a small amount of code: ~70 kLOC of C++. "Smallest" must therefore mean
   *smallest faithful configuration*, and every reduction has to be labelled.
3. After the T-005a maths and CRT gates, **the whole RacingPhysics simulation
   set is 18 errors per TU away from compiling** — 7 maths and 11 thread-identity
   errors, nothing else (measured). The extra 74 errors per TU are one
   `stdafx.h` block that includes the renderer.
4. Gravity's residual blockers are **scheduler module types** (`Scheduler::jqModule`
   and the four `JQ_DECLARE_*` macros) and three MSVC-isms. This makes T-005c's
   `jobqueue_web.h` a hard prerequisite for physics, not an optional one.
5. There is **no numeric native physics reference today**: the stationary
   Brighton race proves the race loads and rests at 0 mph, and the throttle run
   dies in the particle cache before any driving interval completes. A native
   numeric oracle has to be built, and the cheapest honest one is a small native
   probe build of the same collision-query code — not the game.

---

## 1. What the shipped build actually runs

### 1.1 Per-tick driver

```text
C_GameWorld::UpdatePhysics                  amax/game/Game/GameWorld/GameWorld.cpp:2601-2627
  step = (1/60) * g_DebugPlaybackRate * timeScale        (or 1/50 only if
                                                          g_TimeStep50Hz && 50 Hz panel)
  RacingPhysics::PhysicsTimer::SetPhysicsUpdateTime(step)
  for i in [0, m_GameStep):                             m_GameStep from CalcNumberOfSteps
      if i < g_maxPhysicsUpdates:                        code default 4 (2 only under CFG_PROFILE)
          PhysicsTimer::UpdatePhysicsTimer()
          pPhysicsScene->Simulate(step)
```

`C_Scene::Simulate` (`gravity/source/sdk/Scene.cpp:1930`) does **one**
`_Simulate(remainingTime)` per call, because the game sets
`SetMinTimeStep(-1)` immediately before (`GameWorld.cpp:2569`); a fractional
remainder is carried in `m_RemainingTime`. Inside `_Simulate`
(`Scene.cpp:1690-1790`):

```text
for each active body with an IntegrationCallback (Scene.cpp:1714-1718):
    pBody->ApplyForcesAndTorques(time)
    group = callback->BeginIntegrationTask(m_Group, m_Policy, time)
    groupSet.Insert(group)
... Scheduler::Flush(m_Group) ... then Flush each group in groupSet ... (1756-1768)
for each such body: callback->PostIntegration(time)                       (1784-1786)
```

So the vehicle is integrated by **its own integrator**, invoked from inside
Gravity's scene update, and the scene then solves bodies that were *not* given
an integration callback.

### 1.2 The vehicle integrator

`racingphysics/source/vehicles/integrate.cpp:24-61` — `BeginIntegrationTask`
calls `m_pVehicle->BeginFrame(0)` and `Scheduler::AddTask(IntegrationModule,
...)`; `IntegrationTask` (`:88-105`) then calls `CreateGravityCache()` and
`Integrate(time)`.

`racingphysics/source/physics/articulatedbody.cpp:176-207`:

```text
nIntegrationSteps = max(int((integrateStepsPer60 * time + 0.001f) * 60), 1)   // :187
while (nIntegrationSteps > 4) { IntegrateSteps(4, timePerStep); ... }
```

With `time = 1/60` this is exactly 4, and `IntegrateSteps(4, 1/240)` (`:209`)
turns 4 into one RK4 pass over 1/60 (`:219-232`). `Car::GetIntegrationType`
(`car.cpp:253-279`) then *downgrades* it by speed, using two debug floats that
both default to **2.0 m/s** (`car.cpp:29-30`):

| speed | integration actually used at `dt = 1/60` |
| --- | --- |
| `v < 2` | 4 × Euler, `timeStep = 1/240` |
| `2 ≤ v < 2` (unreachable as written) | midpoint |
| `v ≥ 2` | 1 × RK4 over 1/60 |

Two consequences for comparison: the *set of integrator evaluations changes with
speed*, and the per-step value is
`m_dd.timeStep = time * g_timeStepScale / nIntegrationSteps`
(`articulatedbody.cpp:241`), with `g_timeStepScale` a debug float clamped to
`[0.01, 1]` (`vehicle.cpp:32`).

### 1.3 The ground query — the only reason Gravity is on the vehicle path

`Car::CreateGravityCache` (`car.cpp:597-627`) builds a `Collision::C_CRAxisBox`
from `m_dd.gravityTransformedBox`, extrudes it by
`(velocity * 1/60 + normal * 2.0) * 0.5`, grows the extents by the absolute
extrusion, resets `m_LineCache`, and calls

```cpp
pScene->FillCache(box, m_LineCache, stack, &filter, normal, maxCosAngle);   // car.cpp:620
```

`normal` is `-Y` (or the negated car up-axis when wall-riding), `maxCosAngle` is
`-π/4`. `C_Scene::FillCache` (`gravity/include/gravity/sdk/Scene_FillCache.inl:11-56`)
iterates **`m_MeshCollisionBodies` only** — the static level collision meshes —
plus an optional ground plane. The broadphase tree branch is `#if 0`
(`Scene_FillCache.inl:37-44`, comment: "removed this for Blur release - they
don't have platforms to drive on"). Each mesh body's
`C_TriangleMeshShape::m_AABBTree.FillLineCollisionCache(...)`
(`OptimisedAABBTree_FillCache.inl:87`) appends into the cache, which **stops at
`DEFAULT_CACHE_SIZE = 4` triangles** (`LineCollisionCache.h:9`, `:81-84`).

Each wheel then ray-casts down through that cache:
`CarWheel::PutWheelOnGround` (`carwheel.cpp:247-258`) →
`CarWheel::GetGroundIntersection` (`:418-480`) →
`m_pCar->GetLineCollisionCache().Trace(ray, pCache)` (`:450`), with a
persistent per-wheel `C_SingleTriangleCache` tried first
(`LineCollisionCache_Trace.inl:30-96`). The hit supplies normal, contact point,
distance, `m_EffectMaterialIndex` (surface flags) and user data, which drive the
spring, tyre and friction forces in `Car::EvaluateSpringForces`
(`car.cpp:1051`) and `EvaluateTyreForces` (`:1023`).

**This is the porting-critical loop.** Everything about the vehicle's behaviour
on the ground is a function of *which four triangles* the fill produced and in
which order.

### 1.4 The Gravity body coupling

The car also owns a Gravity body. `VehicleActor.cpp:6960` calls
`SetGravityBody(m_pCollisionBody, ...)`, which registers the integration
callback on that body (`car.cpp:308-330`) and creates a `C_CollisionPhantom`
(unconditionally; only `networkupdate.cpp:175-261` consumes it, so for a
single-player slice it is constructed and never used). Per frame, `Car::BeginFrame` (`car.cpp:463`) calls
`CopyFromGravity` (`:388-461`), and the flags
`RacingPhysics.Cars.Integration.{CopyFromGravity, CopyVelocityFromGravity,
CopyPositionFromGravity}` all default **true** (`car.cpp:33-35`). `CopyFromGravity`
overwrites velocity/position from the Gravity rigid body and converts the
residual into `externalForce`/`externalTorque`, and it is also the **only**
writer of `m_dd.gravityTransformedBox` (`:390`) — the box the ground query
needs. Conversely `Car::CopyToGravity` (`:361-386`) writes the car state back
and clears `E_Type_Apply_Gravity` so gravity is not applied twice.

Consequence: a car without a Gravity body cannot even form its fill-cache box.
The Gravity body is not optional; whether Gravity's *solver* must run is a
separate question (section 5).

### 1.5 What is **not** in the vehicle loop (measured, not assumed)

| Component | Status | Evidence |
| --- | --- | --- |
| ATG `TaskScheduler`/`ThreadPool` (`racingphysics/source/system/Scheduler.cpp`, 19.5 KB, includes `<xmcore.h>`) | **not compiled**: whole file behind `#ifdef MULTI_THREAD_VEHICLE_PHYSICS`, which is commented out in `racingphysics/stdafx.h:35` | file head, `stdafx.h:34-35` |
| `MULTI_THREAD_VEHICLE_PHYSICS` vehicle paths | off | same |
| Gravity broadphase `C_DistributionTree::FillCache` | **dead** on PC (`#if 0` in `Scene_FillCache.inl:37-44`) | source |
| RacingPhysics' own `CollisionCache` (triangles/vertical surfaces, `collisioncache.h`, `raycast.h`, `collisionspheres`, `sweptsphere`) | still compiled, but the car uses Gravity's line cache; `Vehicle::s_buildCacheSolid`/`s_buildCacheOverlay` (`vehicle.cpp:46-47`, `vehicle.h:228-229`) are declared and defined but **never assigned anywhere in the tree** | repo-wide search: 6 hits, all declaration/definition sites |
| Debug drawing | `cardebug.cpp`, `debugsliprecorder.cpp`, `debug/draw.cpp`, `debug/colour.cpp`, `Motorbike/motorbikes.cpp` | all `Display::` users |
| Motorbike physics | `motorbike*` (9 files) — same interfaces, not needed for one car | jamfile |
| Network physics/replay | `carnetworkphysics.cpp`, `networkupdate.cpp` | jamfile |

This is good news for the port: the thread-heavy and Xbox-specific pieces of
RacingPhysics are already excluded by the shipped `Speed` configuration.

---

## 2. Module and dependency inventory

### 2.1 RacingPhysics (the vehicle)

`racingphysics/jamfile.jam:27-70` lists 42 TUs. Excluding motorbike and network,
**33 TUs / 11,436 lines**; excluding the debug-draw TUs, **~9.7 kLOC**.

| Group | Files | Role |
| --- | --- | --- |
| integration | `physics/articulatedbody.cpp`, `physics/rigidbody.cpp` | fixed sub-step RK4/Euler over N rigid bodies + rotors |
| frames | `physics/axis.cpp`, `physics/quaternion.cpp`, `physics/rotationmatrix.cpp` | pose math (HVec-based) |
| vehicle core | `vehicles/vehicle.cpp`, `vehicles/integrate.cpp` | vehicle base, scheduler glue |
| car | `vehicles/Car/car.cpp` (70.9 KB), `carwheel.cpp` (21 KB), `carengine.cpp`, `cartransmission.cpp`, `carsettings.cpp` | the model |
| forces | `physics/constraints.cpp`, `physics/surfaces.cpp` | constraint projection, XT-driven surface grip |
| queries | `collisions/boundingbox.cpp`, `collisions/roots3and4.cpp` (+ dead legacy cache files) | ray/box helpers |
| timing | `physics/physicstimer.cpp`, `physics/physics.cpp`, `physics/parameters.cpp` | 1/60 clock, XT registrations |
| debug/network (excluded) | `Car/cardebug.cpp`, `debugsliprecorder.cpp`, `carnetworkphysics.cpp`, `networkupdate.cpp`, `spudebug.cpp` | |

Header-level coupling that decides the boundary:
`vehicle.h:14-16` includes `gravity/sdk/body.h`, `gravity/narrowphase/shape.h`,
`gravity/sdk/Scene.h`; `car.h:8-13` includes
`gravity/narrowphase/LineCollisionCache.h` and `gravity/importer/importer.h`;
`car.cpp:5-12` includes `gravity/sdk/shapedescriptors`, `bodyhelper`,
`gravity/sharedphysics/rigidbody`, `gravity/narrowphase/optimisedaabbtree.inl`,
`gravity/sdk/CollisionPhantom.h`. **RacingPhysics has no standalone existence
without Gravity's headers, and its car cannot be built without Gravity's body
and scene types.**

### 2.2 Gravity (the world collision and rigid-body SDK)

`gravity/jamfile.jam` builds essentially the whole library (exporter only under
`CFG_CONVERTER`). Non-exporter `.cpp`: **127 files / 58,759 lines**. Directories
relevant to the vehicle path:

| Directory | Why it is on the path |
| --- | --- |
| `narrowphase/` (~34 cpp) | `C_LineCollisionCache`, `Ray`, `Shapes` (triangle mesh shape), `OptimisedAABBTree`, `Primitive*`, `GJK*`, `CollisionManager*` |
| `treebuilder/` | `AABBTree.cpp` (89 KB) builds the tree the fill traverses |
| `sharedphysics/` | `SPU_Memory` (`C_SafeStack`, `C_SmallSPUCache`), `rigidbody`, `ContactDatabase`, `ConstraintGraph`, `Integrator`, `GravityConstants` |
| `broadphase/` | `DistributionTree` (+`_FillCache`, `_Raytrace`), `SweepAndPrune` |
| `sdk/` | `Scene.cpp` (144 KB), `SPUScene.cpp` (118 KB, holds the PPU `FillCache`), `Body.cpp` (65 KB), `BodyHelper`, `ShapeDescriptors`, `ConstraintDescriptors`, `CollisionPhantom`, controllers |
| `solver2/` | LCP + constraint set, used by `_Simulate` |
| `cloths/`, `Triggers/`, `importer/` | bodies that appear in the same scene / the level import |

`C_Scene::FillCache` itself is small and clean, but it lives in
`source/sdk/SPUScene.cpp` (`:28` includes `Scene_FillCache.inl`), a 2,787-line TU
that also declares every job module of the library. There is no way to compile
"just FillCache" without parsing that TU.

### 2.3 Underlying core/system glue

| Need | Site | T-005a status |
| --- | --- | --- |
| HVec math, `MathsStorage::{Float3,HenDN3,Fixed3_S16<14>}` | `common/core/include/core/maths/**` | 7-error maths gate (planned fix) |
| assert, logging, debug variables (`DECLARE_DEBUG_BOOL` etc., used heavily by both libraries) | `common/system/debug/**` | maths gate + CRT compat |
| job queue types and `Scheduler::` API | `common/system/include/system/scheduler/**` | `tl_*` identity (`#error`) |
| `Sys::I_BinaryStream` / `C_FileBlock` for the level and XT reads | `common/system/serialise/**` | maths gate; `C_File.cpp:151` has a malformed string literal |
| XT records (car and surface parameters) | `common/xt2/**` | blocked by `<cell/atomic.h>` |
| `Spu::Fetch*` / `MemBaseMarker` | `system/include/system/scheduler/jobqueue_mem.h:339-370`, `jobqueue_mem.cpp:33+` | **portable**: on non-SPU these are `return (void*)ptr` and no-ops |

The `Spu::` abstraction is worth stating explicitly because it looks like a
platform blocker and is not: on every non-PS3 target the SPU fetch layer
degrades to pointer identity (`FetchAlloc`) or `memcpy` (`Fetch`).

### 2.4 Data inputs

| Input | Size / location | Read by |
| --- | --- | --- |
| Track collision mesh | `game-data/Blur/levels/uk_brighton/Level.levelphysics`, **5,595,906 B** | `GameResource::C_PhysicsLevel::Load` (`gamesys/game_resource/source/PhysicsLevel.cpp:41-108`) → `Gravity::C_ImportScene::Import` |
| Car/surface parameters | `gamedata\Xt\racingphysics.bin` inside a PAK (`racingphysics.cpp:20`), records `RacingPhysics_DynamicsParameters`, `RacingPhysics_CarDynamics`, `RacingPhysics_Surfaces`, … | `XtPackOpen` → `CarDynamicsXt::LoadDynamicsXt`, `Surfaces::*` |
| Car collision shape | model physics import (`LevelResource.cpp:150`, `m_pModelData->m_pPhysicsImport`) | `VehicleActor.cpp` builds a `C_CompositeDesc` |
| Placement / route / lap data | level resource + `Amax.SetupRace` | game logic, out of physics scope |

The level file is **not** an opaque or undocumented format: `C_PhysicsLevel::Load`
reads it with `Sys::C_FileBlock`, looks for a root block with
`HeaderId() == "Physic"` and its `Header` / `Main` / `Routes` / `Route`
children, and hands each `Main` block to `C_ImportScene::Import`. It even has an
explicit fallback for a file without the `Physic` root: rewind to 0 and import
the raw stream (`PhysicsLevel.cpp:41-57`). The on-disk head is
`20 20 43 50 50 68 79 73 69 63 00` = `"  CPPhysic"`, i.e. a `CP` block-header
signature followed by the `Physic` id; the exact framing lives in
`Sys::C_FileBlock::OpenBlock` and must be confirmed there, not guessed, before a
wasm reader asserts a layout. So the input gate is *engine code we must compile
anyway*, not a format we must invent. This is the most useful fact in this
document for T-005b: `Level.levelphysics` needs `C_FileBlock` + `Import`, both of
which are inside the physics closure already.

The scene is then built exactly as the game does it
(`gamesys/game_resource/source/LevelSceneManager.cpp:28`):

```cpp
C_ImportSceneStaticInstance(scene, mainImportScene,
                            Maths::HVec3(5, 20, 5),      // desiredSize
                            Maths::HVec3(50, 50, 50),    // maxCellSize
                            &collisionFilter, &collisionFilter)
```

and `Importer.cpp:744` registers the mesh bodies via `m_pScene->AddMeshBody(pBody)`,
which is precisely what puts them into `m_MeshCollisionBodies` for `FillCache`.

---

## 3. Portability after the P1 maths/platform gates

All numbers below were measured this session with the T-005a toolchain and the
**faithful per-library include sets from the jamfiles** (this matters: adding the
Gravity source root to a RacingPhysics compile silently changes header
resolution and invalidates the count).

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
$em = "_work/toolchains/emsdk/upstream/emscripten/em++.py"
# portable hypothesis, same workaround flags as T-005a §3.2
#   -DBUILD_CONFIG_SPEED -DPLATFORM_PC -DWIN32 -D_vsnprintf=vsnprintf
#   -UPLATFORM_PC -UWIN32 -D__restrict= -fms-extensions -fdelayed-template-parsing
#   -ferror-limit=0 -fsyntax-only -std=c++14 [-DUSE_SOLVER_2]
```

### 3.1 Measured today

| TU | error lines | of which Display cascade |
| --- | ---: | ---: |
| RacingPhysics `physics/{articulatedbody,rigidbody,axis,quaternion,constraints,surfaces,physicstimer,compressfloat}` | 92 each | 74 |
| RacingPhysics `collisions/{boundingbox,roots3and4}` | 92 each | 74 |
| RacingPhysics `vehicles/Car/{car,carwheel,carengine,cartransmission,carsettings}` | 94–95 | 74 |
| RacingPhysics `vehicles/{vehicle,integrate}` | 97–98 | 74 |
| Gravity `narrowphase/{OptimisedAABBTree,Shapes,Ray}` | 205–208 | 0 |
| Gravity `treebuilder/AABBTree` | 206 | 0 |
| Gravity `sharedphysics/SPU_Memory` | 203 | 0 |
| Gravity `importer/Importer` | 206 | 0 |
| Gravity `sdk/Body` | 215 | 0 |
| Gravity `sdk/Scene` | 227 | 0 |
| Gravity `sdk/SPUScene` | 269 | 0 |
| RacingPhysics debug draw `Car/cardebug`, `debug/draw`, `vehicles/debugsliprecorder` | 188 / 141 / 174 | 145 / 120 / 145 |

Cross-check: `_work/wasm-engine-probe/final_posix.json` reports 92/95 for the
RacingPhysics TUs and 203–215 for the Gravity TUs, i.e. the same counts.
`docs/work/analysis/engine-wasm-probe.md` §3.3 quotes 19 and 62 for these two
libraries; those figures are **stale relative to the probe's own JSON** and
appear to count distinct classes rather than lines. The *classes* in that section
are correct and unchanged; only the magnitudes need the correction above.

### 3.2 The RacingPhysics residual is only the known gates

Removing the Display lines from one representative TU leaves **18 errors** —
`articulatedbody.cpp`, identical composition in every simulation TU:

| Count | Message | Gate |
| ---: | --- | --- |
| 5 | `no viable conversion from 'const HVec3' to 'Float3'` (`Vector.inl:6917,7484,8090`, `Geometry.inl:1217-1218`) | P1 maths |
| 2 | `use of undeclared identifier '__fsel'` (`MathsUtil.h:1499-1500`) | P1 maths (`PLATFORM_LINUX` guard at `MathsUtil.h:410`) |
| 4 / 2 / 1 | `tlThreadHandle`, `tlThreadFunction`, `TL_THREAD_JOINABLE` | P1 platform identity |
| 1 | `TL_THREAD_PRIORITY_NORMAL` | P1 platform identity |
| 1 | `TL_PLAT_XXX platform specification is missing` | P1 platform identity |
| 1 | `This module is only implemented for PC, Xenon and Playstation3` | P1 platform identity |
| 1 | `unknown type name 'Mutex'` (`core/threads/Event.h:49`) | P1 platform identity |

**No other blocker class exists in the RacingPhysics simulation set.** Note that
the earlier assumption "RacingPhysics reaches the renderer through its stdafx"
is true but is a *header* problem, not a code problem: the 74 Display errors all
disappear if `racingphysics/stdafx.h:21-32` gets a `PLATFORM_WEB` sibling that
omits the seven `Display/*` includes. The debug-draw TUs are the only files that
genuinely need `Display::` symbols and are excluded.

### 3.3 Gravity residual: the scheduler module types

| TU | residual after maths/CRT/`tl_*` are removed | Composition |
| --- | ---: | --- |
| `sdk/Scene.cpp` | 24 | 21 × `no type named 'jqModule' in namespace 'Scheduler'`, 3 × `HVec3` → `Fixed3_S16<14>` |
| `sdk/SPUScene.cpp` | 66 | 21 module-variable declarations, 16 × `a type specifier is required`, 4 × `jqModule` construction, ~14 undeclared module names (`RayTraceModule`, `DynamicCollisionModule`, `SolverModule`, `IntegrateModule`, …, each with a `gravity_*` ELF name), 3 × `HVec3` → `Fixed3_S16<14>`, 5 × private-member access in the water query |
| all other measured Gravity TUs | 0–4 | maths/CRT/`tl_*` plus the same `Fixed3_S16<14>` cast |

`SPUScene.cpp` declares its job modules with `JQ_DECLARE_DUAL_MODULE`,
`JQ_DECLARE_PPU_MODULE` and `JQ_DECLARE_SPU_MODULE(name, fn, elfname, logger)`.
Those macros and the `Scheduler::jqModule` type exist only in
`jobqueue_xenon.h` and `jobqueue_ps3.h`; `jobqueue_generic.h` defines neither
(it defines an unqualified `jqModule` and only `JQ_DECLARE_MODULE` /
`JQ_DECLARE_PPU_MODULE`, `:121-127`). Mapping `TL_PLAT_WEB` to the generic
header therefore **cannot** work for Gravity.

This is a concrete, testable requirement for T-005c's `jobqueue_web.h`, in
addition to what `docs/work/analysis/t005-scheduler-design.md` already specifies:

- `Scheduler::jqModule` with the Xenon/PS3 constructor shape,
- `JQ_DECLARE_MODULE`, `JQ_DECLARE_PPU_MODULE`, `JQ_DECLARE_SPU_MODULE`,
  `JQ_DECLARE_DUAL_MODULE` with the same arity, where the `elfname`/`logger`
  arguments are accepted and treated as labels only (exactly what PS3 does for
  `JQ_DECLARE_PPU_MODULE`),
- `AddTask`, `CreateGroup`, `AddGroupDependency`, `Flush`, `GroupHandle`,
  `PolicyHandle`, `JQ_GROUP_NONE`.

### 3.4 Three fixes that must not be papered over

1. **`HVec3` → `MathsStorage::Fixed3_S16<14>`** (`AxisBox.h:246`,
   `LineCollisionCache.h:119-121`, and 3 more sites). The conversion is a
   *member function template* whose parameter cannot be deduced from the
   argument (`Vector.h:523-525`), only from the target type. MSVC allows it,
   clang does not. A `-D__restrict=` style flag does not help; the port needs an
   explicit named conversion (e.g. a `ToFixed3<S16,14>()` helper) at the call
   sites.
2. **`&C_Scene::BodyPtr(this)`** — `Body.cpp:1028,1037,1047,1058` take the
   address of a temporary (MSVC extension). Harmless in effect because
   `SharedPhysics::List::AddToEnd(Elem*)` copies (`List.h:361-367`), so the fix
   is a named local, not a semantic change. It must still be *fixed*, not
   silenced, because the construct is ill-formed.
3. **Private-member access in `C_Scene::DoWaterQuery`** (`SPUScene.cpp:2532-2545`
   reading `C_WaterQuery::m_Depth`, `m_UnderWater`, `m_SurfacePoint`,
   `m_SurfaceNormal`, `m_TestPoint`). `WaterQuery.h:11` already declares
   `friend class C_Scene;`, so this is **not** the obvious missing-friend case;
   the actual reason clang rejects it has to be established from the source
   before a fix is chosen. Reordering includes to make it disappear is not
   acceptable.

---

## 4. Native reference status today

### 4.1 What exists and is usable

- **Native x64 Amax Release builds and runs.** `Amax.exe`
  SHA-256 `e9727929…a5a254` with its matching PDB is the canonical reference
  binary (`docs/setup/native-source-build.md:197-208`).
- **The stationary Brighton race works:** `RaceState()=="Racing"` at 10.08 s,
  live HUD at 10.28 s, one 1280×720 capture, scripted quit, exit 0, 12 s, no
  timeout (`native-race-audit.json`, scenario `stationary-race`). The capture
  shows the car on the Brighton waterfront at 0 mph with lap 0/1 — i.e. the
  suspension/contact path is *stable at rest* on the real level.
- **A full-memory dump and a bounded `Free`/`AtomicFree` trace** of the failing
  throttle run exist, with the double-free mechanism proven
  (`docs/work/analysis/native-particle-crash.md`).

### 4.2 What cannot be used

- **No numeric native vehicle state.** Neither the stationary nor the throttle
  run emits per-frame position, velocity, wheel contact, suspension or slip.
  The stationary evidence is qualitative (state name, HUD, screenshot).
- **No usable driving interval.** The throttle run stops inside the particle
  cache `~1 s` (triage) to `~13 s` (full dump) after `W`; three separate fix
  attempts were built and all rejected (1/3 + 2/3 `0xC0000005`; 3/3
  `0xC0000005`; 1/3 breakpoint + 2/3 `0xC0000005`), and the patches were reverted
  (`docs/STATUS.md:237-245`). The canonical EXE still crashes.
- **The in-tree physics test applications are not a reference.**
  `code/mercury/applications/Physics/RacingPhysicsTest` calls
  `RacingPhysics::Create()`, `RacingPhysics::Update()` and
  `VehicleManager::Instance().UpdatePhysics()` — none of which exist in the
  current library (`racingphysics.h` exposes only `CreateXt/DestroyXt/UpdateXt`;
  `VehicleManager` in `vehicle.cpp:64-155` has no `UpdatePhysics`). It is stale
  and `xtl.h`-based. `RacingPhysicsTest2` and `amax/applications/Gravity/GravityTest`
  are Win32/x86 D3D9-era apps; `cmake/targets.cmake` contains exactly one target,
  `Amax` (`targets.cmake:4`), so none of them is part of the PC build.

### 4.3 Consequence

Any claim of the form "wasm physics matches the native reference" is
**unsupportable today**. The comparison has to be built, and the honest order is:
compare the *port* against a *native build of the same physics code on the same
inputs* first (section 5.4), and only then look at the game.

---

## 5. A minimal deterministic scenario and the comparison metrics

Two scenarios, deliberately separated so that the highest-risk porting work can
be verified before vehicle parameters exist.

### 5.1 D1 — static collision-query oracle (no vehicle, no XT)

Purpose: prove that the ported Gravity tree + line-cache path returns the same
triangles and the same ray hits as the original code, on the real Brighton mesh.

- **Input:** `Level.levelphysics` (5,595,906 B) read with `Sys::C_FileBlock` →
  `C_PhysicsLevel::Load` → `C_ImportScene::Import`; static instance built with
  the game's own parameters `desiredSize (5,20,5)`, `maxCellSize (50,50,50)`.
- **Fixture:** a fixed table of probe boxes and rays, written down as data, at
  N known positions on the track (e.g. the four wheel rest positions for a
  recorded car pose from `Amax.SetupRace`'s placement, plus a grid that crosses
  cell boundaries). No randomness, no wall clock.
- **Per probe, emit:** cached triangle count (0–4), each cached triangle's
  `m_TriangleIndex`, `m_CollisionFlags`, `m_PhysicsMaterialFlags`,
  `m_EffectMaterialFlags`, `m_UserData`, the three quantised vertices, the
  normal; and for each ray: hit/miss, `m_TriangleIndex`, `m_distance`,
  `m_normal`, point, and the same material fields.
- **Why this is the right first thing:** it isolates exactly the parts the port
  changes (HVec/Fixed3 quantisation, tree traversal order, the four-entry cache
  policy, the fat-ray vs thin-ray branch) and needs **no** XT records, no car, no
  solver and no scheduler policy.

### 5.2 D2 — vehicle on the ground (one car, no input, then constant throttle)

Purpose: the vehicle integrator and the spring/tyre/friction chain.

- One `RacingPhysics::Car`, `DefaultCar` dynamics, placed on the real mesh at a
  recorded pose, `g_timeStepScale = 1`, `PhysicsUpdateTime = 1/60`,
  `ControlType = PLAYER`, all controls zero.
- 600 fixed steps of `dt = 1/60` (10 s), `Scene::Simulate(dt)` once per step, so
  `g_maxPhysicsUpdates` is not exercised (the probe drives one step per call, not
  the game's loop of up to 4).
- Then a second run: `throttle = 1` from step 120, 480 further steps.
- **Per step, emit** (fixed order, little-endian float32 bit patterns):
  body position (x,y,z), body velocity, body angular velocity, per wheel:
  `onGround`, ground normal, `suspensionDistance`, wheel position, angular
  velocity 1D, `surfaceFlags`, `userData`, and the four cached triangle indices.
- This scenario is deliberately **single-car**, on a straight stretch away from
  walls, so the solver's contact responses are not expected to contribute. If a
  contact does occur, it is reported as an unexpected event (`contactStepCount`)
  rather than silently folded into the comparison.

### 5.3 Metrics

| Metric | Definition | Gate |
| --- | --- | --- |
| `stateHash` | SHA-256 over the concatenated per-step float32 bit patterns of one run (fixed field order, fixed step count) | repeat runs on the *same* target must be **identical** |
| `queryHash` (D1) | SHA-256 over the JSON of cached triangles + ray hits, canonical key order | native vs wasm must be **identical** if the port is faithful (integers, indices, material flags, and quantised `Fixed3_S16<14>` are exact) |
| `maxAbsPos` / `maxAbsVel` (D2) | max over steps of `|Δposition|` (m) and `|Δvelocity|` (m/s) against the native run | reported, with a threshold agreed *before* the run (proposal: 1e-4 m and 1e-4 m/s at 600 steps, escalated only with a written justification) |
| `firstDivergenceStep` | first step where any component differs by more than 1 ULP | must be reported, not just the final delta |
| `time` | wall time of the wasm run for 600 steps | recorded, not gated in this slice |
| `contactCount` (D1/D2) | number of steps/wheels with `onGround` | must match exactly |

`queryHash` exactness is the point: D1 is a discrete computation, so any
difference is a port bug, not floating-point noise.

### 5.4 Independent reference strategy

Because no native numeric oracle exists (section 4.2), the reference has to be
built in this order:

1. **Native build of the same probe (authoritative).** The project already has
   the pattern: a bounded, isolated patch plus a separate build output in the
   isolated worktree (`native-free-trace.patch`, `_work/build/engine-reference/`).
   The same approach gives a native `physics-probe.exe` that links `core`,
   `system`, `gravity` and (for D2) `RacingPhysics`, reads the same level file
   and emits the same JSON. It does not run the game and does not need DX11.
   This is the only way to distinguish "the port changed behaviour" from "the
   original code behaves this way".
2. **Independent Python reference (narrow).** For D1, a Python Möller–Trumbore
   plus the same negative-normal and fat-ray rules can independently check a
   *subset* of the ray results — but only once the triangle emitted by the engine
   is known, so it validates the intersection math, not the traversal. For the
   integrator, a Python implementation of `ArticulatedBody::Integrate` +
   `RigidBody::UpdateState` for the contact-free interval (`onGround == false`,
   pure ballistics) is a genuinely independent check of the sub-step schedule.
   Anything wider would be re-implementing the format, not verifying it.
3. **Native game trace (last, and only if a driving interval becomes possible).**
   Would need the particle double-free resolved or bypassed; `W`-driven runs
   currently produce no stable window. Until then, "native driving reference" is
   an open blocker, not a plan.

---

## 6. First code slice and acceptance tests

### 6.1 Slice T-005d-1 (proposed; nothing created)

Scope: **D1 only** — compile Gravity's static-mesh import and query path for
`wasm32`, run it on `Level.levelphysics`, and compare against a native build of
the same probe.

Contents:

1. Prerequisites from T-005a: maths gate, CRT compat header
   (`_isnan`, `_TRUNCATE`, `_vsnprintf`), `PLATFORM_WEB` + `TL_PLAT_WEB`.
2. T-005c's `jobqueue_web.h` with the module types and macros from §3.3.
3. Gravity TUs: `narrowphase/{OptimisedAABBTree,AABB,Shapes,Ray,ConvexHull,
   PrimitiveClosestPointsTest,PrimitiveIntersectTest,LineCollisionCache}`,
   `treebuilder/AABBTree`, `sharedphysics/{SPU_Memory,rigidbody,ConstraintGraph,
   ContactDatabase,Integrator,GravityConstants}`, `sdk/{Body,BodyHelper,
   ShapeDescriptors,SPUScene,Scene}`, `importer/Importer`, `broadphase/*` and
   the `solver2/*` files the linker demands.
4. `system/serialise/{C_FileBlock,C_MemoryStream}` + a byte-buffer source so the
   probe can read the level file without T-005b's async file layer (explicitly a
   probe-only input path, labelled as such).
5. `probes/physics-probe/` with a native and a wasm target, a JSON contract and a
   node verifier, added to `tools/verify_asset_probe.py` as new steps.

Explicitly **not** in this slice: the car, XT records, the solver, the job queue
runtime, `Display`, motorbikes, cloth/fluids/triggers, controllers.

### 6.2 Acceptance tests

| # | Gate | Evidence |
| --- | --- | --- |
| P1 | The TU set in §6.1 compiles with `-DPLATFORM_WEB` and **no** workaround flags | per-TU logs, `/W4`-equivalent warnings clean (native) |
| P2 | Native and wasm builds of the probe produce the **same** `queryHash` for the fixture, and both are deterministic across two runs | two JSON files + hashes |
| P3 | Parsed `Level.levelphysics`: mesh body count, triangle count, and the number of cells are reported and identical native/wasm; every triangle index referenced by a hit exists | JSON fields; no "assumed" triangles |
| P4 | A deliberately perturbed fixture (a ray moved by 1 mm, a box moved across a cell boundary) changes the expected fields and nothing else | diff between fixture A and B, reviewed |
| P5 | Explicit failure for the cases the engine cannot answer: a ray with no hit, an empty cache, a filter that rejects everything — each is a named result, never a silent zero | JSON `status` per probe |
| P6 | No regression: `python tools/verify_asset_probe.py --skip-build` 27/27 → 29/29, CTest 14/14 | `_work/verification/suite.json` |

### 6.3 Slice T-005d-2 (next, not this task)

Adds D2: the 33 RacingPhysics simulation TUs, a `PLATFORM_WEB` branch in
`racingphysics/stdafx.h`, the XT record decode for `CarDynamicsXt` and
`RP_TrackSurface` (the current `xt_reader` stops at metadata — `docs/STATUS.md:114`
— so this is a real gate), the car's gravity body, and `Scene::Simulate`. Its
acceptance is the `stateHash` determinism gate plus `maxAbsPos`/`maxAbsVel`
against the native probe.

---

## 7. What must remain unsupported

Everything below must fail loudly or be absent, with the label recorded — not
silently degraded:

- **Solver-dependent behaviour** if D2 is run without the contact solver:
  car-vs-wall contacts, body-vs-body contacts, props, dynamic obstacles. Label
  `gravitySolverContacts:false` if that configuration is ever used for a
  measurement.
- **Motorbike physics** (`motorbike*`, 9 files) — unused by the vertical slice.
- **Cloth, rope, fluid, deformable bodies** (`cloths/*`), triggers
  (`Triggers/TriggerSystem`), character/kinematic/ragdoll/animated controllers.
- **Network physics and replay** (`carnetworkphysics.cpp`, `networkupdate.cpp`,
  `CompressedNetworkState`, `NetworkForces`) — the vertical slice is
  single-player.
- **The ATG thread-pool scheduler** (`MULTI_THREAD_VEHICLE_PHYSICS`) — not
  compiled on PC today and must stay uncompiled.
- **SPU job modules** — must be single-context labels, never a pretend-parallel
  implementation (T-005c §5.3 applies unchanged).
- **50 Hz time step** — `g_TimeStep50Hz` stays `false`; a 50 Hz display must not
  change the cadence.
- **`CFG_GOLD`/Master** behaviour differences — the port targets `CFG_SPEED`.
- **Debug rendering** of physics (`cardebug`, `debugsliprecorder`, `debug/*`,
  `Motorbike/motorbikes.cpp`) — needs `Display`, out of scope until the renderer
  layer exists.
- **Exporter/converter paths** (`CFG_CONVERTER`, `gravity/source/exporter/*`).

---

## 8. Risks

1. **The four-triangle cache makes ground contact order-sensitive.** `FillCache`
   stops
   at `DEFAULT_CACHE_SIZE = 4` (`LineCollisionCache.h:9`), and
   `C_LineCollisionCache::Trace` keeps the **nearest** hit among the cached
   triangles, walking them in insertion order (ties resolved by that order,
   `LineCollisionCache_Trace.inl:100-175`). Which four triangles make it into the
   cache depends on tree layout and traversal order. Any difference in
   `OptimisedAABBTree` construction (a reordered build, a different sort, a
   64-bit→32-bit index assumption) changes *which* triangles are available and
   therefore the ground normal, not just the last decimal. This is the most
   likely cause of a large D2 divergence and the reason D1 must compare the
   cached set exactly.
2. **Fixed-step fidelity is a chain of defaults, not a constant.** `dt = 1/60`
   only if `g_DebugPlaybackRate == 1` (debug float, default 1.0,
   `GameWorld.cpp:297`), `timeScale == 1`, `g_TimeStep50Hz` false and the panel is
   not 50 Hz; `g_timeStepScale` is a debug float in `[0.01, 1]`; the integration
   *scheme* switches at 2.0 m/s; `Scene::Simulate` carries `m_RemainingTime`; the
   game caps physics updates at `g_maxPhysicsUpdates`, whose code default is **4**
   for Speed/Release and 2 only under `CFG_PROFILE` (`GameWorld.cpp:198-202`).
   Note that a settings XML can override any of these at runtime. A scenario must
   pin every one of these and record the values, otherwise two runs are not
   comparable.
3. **Floating-point differences are real but bounded.** Native x64 uses SSE2
   and MSVC's default `/fp:precise` (no FMA contraction); wasm is scalar IEEE-754
   single. Same operations in the same order should be bit-identical; any
   divergence is more likely a *different code path* (see risk 1) than rounding.
   `-ffp-contract=off` should be pinned to match MSVC's default, and the wasm
   build must not silently take a different `_SIMD_` branch — T-005a §7 already
   records that SSE paths were never exercised.
4. **Scheduler coupling beyond compilation.** `Scene.cpp:1710-1768` collects
   integration groups in a `Btl::OpenHashSet<Scheduler::GroupHandle>` and flushes
   them by iterating that set. With one car there is one group and no effect;
   with several vehicles the *flush order* comes from a hash set, which is a
   determinism hazard the port inherits. It must be measured, not assumed
   harmless, before any multi-vehicle comparison.
5. **No native driving reference.** Section 4.2. Until the particle double-free
   is resolved, any "matches native" claim can only mean "matches a native build
   of the same physics code", which is a weak but honest statement, and must be
   worded that way.
6. **XT parameter provenance.** Without a record decode, a "DefaultCar" fixture
   would have to be invented, which violates the no-guessing rule. Either the
   existing bounded XT reader is extended to decode `CarDynamicsXt`/
   `RP_TrackSurface` records from the real `racingphysics.bin`, or the ported
   `XtPackOpen` path is used. This is a hard gate for D2 and should be treated as
   a prerequisite, not a detail.
7. **The Gravity library is not modular.** `Scene.cpp` includes the solver,
   cloths, triggers, controllers and importer; `SPUScene.cpp` declares every job
   module. "Only the collision query" still parses the whole library's header
   set. Budget accordingly: this is a 70 kLOC port, not a 5 kLOC one.
8. **Latent MSVC-isms will keep appearing.** `_isnan`, `Clamp`/`__fsel` behind
   `#ifndef PLATFORM_LINUX` (`MathsUtil.h:410`), `__restrict` after parameter
   lists, address-of-temporary, `operator const Fixed3_S16<T>` deduction, and the
   `#if defined(PLATFORM_PC) && (_MSC_VER < 1400)` idiom (`newclib.h:120`).
   Each is individually small; the risk is that a workaround flag hides a real
   semantic difference. The rule "fail explicitly, never silently fall back"
   applies to each of them individually.

---

## 9. Evidence index

Source anchors cited above (all read-only):

| Topic | Path |
| --- | --- |
| per-tick driver | `upstream/BlurRebuilt/code/amax/game/Game/GameWorld/GameWorld.cpp:199-201, 2601-2627` |
| scene simulate | `.../physics/gravity/source/sdk/Scene.cpp:1567-1630, 1690-1790, 1930-1990` |
| fill cache | `.../physics/gravity/include/gravity/sdk/Scene_FillCache.inl:11-56` |
| tree fill | `.../gravity/include/gravity/narrowphase/OptimisedAABBTree_FillCache.inl:87-200` |
| cache trace | `.../gravity/include/gravity/narrowphase/LineCollisionCache_Trace.inl:30+`, `LineCollisionCache.h:9-157` |
| importer | `.../gravity/source/importer/Importer.cpp:744`, `include/gravity/importer/Importer.h:141-210` |
| level load | `.../gamesys/game_resource/source/PhysicsLevel.cpp:41-108`, `LevelSceneManager.cpp:22-35` |
| vehicle glue | `.../amax/game/Game/GameActors/Vehicles/VehicleActor.cpp:6905-6970` |
| integrator | `.../racingphysics/source/physics/articulatedbody.cpp:176-300` |
| car | `.../racingphysics/source/vehicles/Car/car.cpp:29-35, 253-279, 361-461, 597-640, 713-760, 1051-1160` |
| wheel query | `.../racingphysics/source/vehicles/Car/carwheel.cpp:247-300, 418-480` |
| stdafx split point | `.../racingphysics/stdafx.h:8-35` |
| dead scheduler | `.../racingphysics/source/system/Scheduler.cpp:1-15`, `stdafx.h:34-35` |
| dead legacy cache | `.../racingphysics/source/vehicles/vehicle.cpp:46-47`, `include/.../vehicle.h:228-229` |
| job module macros | `.../common/system/include/system/scheduler/jobqueue_{xenon,ps3,generic}.h` |
| SPU no-ops | `.../common/system/include/system/scheduler/jobqueue_mem.h:339-370` |
| maths gate | `.../common/core/include/core/maths/{MathsUtil.h:410-414, hvec/Vector.h:523-525, hvec/Vector.inl:6917}` |
| platform identity | `.../common/core/include/core/Core.h:165-190` |

Prior evidence reused: `_work/wasm-engine-probe/{final_posix.json,logs/}`,
`_work/build/engine-reference/native-race-audit.json`,
`_work/build/engine-reference/{native-saltfix,native-drainfix,native-trailfix}-attempt.patch`,
`docs/STATUS.md:237-245`, `docs/setup/native-source-build.md:252-320`,
`docs/work/analysis/{engine-wasm-probe.md, native-particle-crash.md, t005-scheduler-design.md}`.

This session produced no artifacts other than this document; the measurements in
section 3 are reproducible with the command block at the head of that section.
