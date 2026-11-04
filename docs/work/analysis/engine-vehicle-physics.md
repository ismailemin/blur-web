# T-005d — Real vehicle physics on wasm32: RacingPhysics + Gravity on the River mesh

**Date:** 5 November 2026
**Owner:** P19 (sub-agent)
**Scope:** a bounded spike. One overlay patch, one verifier, one harness directory, this
document. No modification of `upstream/`, `game-data/`, `_work/native-source/`, project
sources, `tools/`, `engine/README.md` or any existing engine file. No renderer, no game
loop, no playable-game claim.

**Result: the shipped vehicle integrator runs on wasm32 on the real `usa_la_river`
collision mesh, driven by a car decoded from the real XT record, and it drives.**
186 translation units (23 RacingPhysics, 118 Gravity, 44 logging/platform/maths closure,
1 harness) compile to a 1.0 MB `.wasm` that steps `C_Scene::Simulate(1/60)` 480 times:
180 ticks at rest (suspension settling, four wheel contacts) and 300 ticks at full
throttle, reaching **31.1 m/s** (peak 35.1 m/s at the road edge) and **96.1 m** of travel
with **zero NaN ticks** and **480/480 ticks with wheel contact**. Two builds produce the
same `.wasm`; two runs produce byte-identical documents.

The native-vs-wasm comparison is **blocked**, and the blocker is measured, not assumed:
the PC configuration of the same source needs the DX11 `Display` layer (`dxerr.h` from
the legacy DirectX SDK) before it even reaches the physics. Section 7 records the exact
command and message. Instead, PC parity is proven two ways: every web-only edit is
statically removed by MSVC's own preprocessor in the PC configuration and the resulting
translation units are **identical** to upstream, and the two unconditional grammar
fixes are compiled in the PC configuration as well.

---

## 0. Summary

| | |
| --- | --- |
| TUs compiled | 186 objects (23 RacingPhysics + 118 Gravity + 44 closure + 1 harness) |
| wasm | see §6 (`vehicle_a.wasm`, SHA-256 in §6) |
| car | `Corvette_ZR1_Stock`, `RP_CarDynamics` record 37 (id `1554942492`) from `gamedata\xt\racingphysics.bin` |
| car fields | 184 lines: 144 scalars, 1 XtHandle, 6 array descriptors (19 floats + 6 graph points), all decoded from the record |
| scenario | 180 ticks at rest + 300 ticks full throttle, `dt = 1/60`, fixed start point on the River mesh |
| result | 31.1 m/s at the end of the throttle phase (peak 35.1 m/s), 96.1 m travelled, 0 NaN ticks, 480/480 ticks with wheel contact |
| determinism | two builds byte-identical; two runs byte-identical |
| native parity | **blocked** (§7); PC source parity **passes** (§7.2) |
| patch | `engine/patches/t005d-vehicle-overlay.patch`, 9 files, +109/−14, SHA-256 in §6 |

---

## 1. The smallest vehicle TU set, and why it is the smallest

The live per-tick chain in the shipped build, with source anchors (all read from
`upstream/BlurRebuilt@5270304b`; `…/` is `code/mercury/library/`):

| step | source |
| --- | --- |
| frame step `1/(60·playback·timeScale)`, one `Simulate` per step | `…/amax/game/Game/GameWorld/GameWorld.cpp:2601-2627` |
| `SetMinTimeStep(-1)` so a call is exactly one `_Simulate` | `GameWorld.cpp:2569`, `…/physics/gravity/source/sdk/Scene.cpp:1930-1949` |
| per-body integration dispatch, group flush, post-integration | `Scene.cpp:1714-1718`, `:1756-1768`, `:1784-1786` |
| `BeginFrame` + queue the integration job | `…/physics/racingphysics/source/vehicles/integrate.cpp:24-55` |
| job body: `CreateGravityCache()` then `Integrate(time)` | `integrate.cpp:88-105` |
| `Car::CreateGravityCache` → `C_Scene::FillCache` | `…/vehicles/Car/car.cpp:597-627` |
| fill: static mesh bodies only, `#if 0` broadphase | `…/gravity/include/gravity/sdk/Scene_FillCache.inl:11-56` |
| per-leaf quantised triangles, 4-entry cap | `…/gravity/include/gravity/narrowphase/OptimisedAABBTree_FillCache.inl:87-212` |
| wheel ground ray through the cache | `…/vehicles/Car/carwheel.cpp:247-300`, `:418-480` |
| cache trace (thin and fat branches) | `…/gravity/include/gravity/narrowphase/LineCollisionCache_Trace.inl:17-228` |
| integrator: `nIntegrationSteps`, RK4 vs Euler | `…/physics/articulatedbody.cpp:176-300` |
| per-speed scheme switch (2 m/s debug thresholds) | `…/vehicles/Car/car.cpp:253-279`, `:29-30` |
| spring / tyre / transmission / control / friction forces | `car.cpp:1051`, `:1023`, `:1158`, `:1244`, `:1564` |
| derivative assembly | `car.cpp:713-770` |
| Gravity body coupling (`CopyFromGravity`/`CopyToGravity`) | `car.cpp:388-459`, `:361-386` |
| body attach | `car.cpp:308-327` |

So a *single car* necessarily drags in:

1. **RacingPhysics**: the articulated integrator, the rigid body/rotor maths, the car,
   its four wheels, engine, transmission and settings — 23 TUs (§6 lists them).
   `Scheduler.cpp` (19.5 kB) is compiled out by `MULTI_THREAD_VEHICLE_PHYSICS`
   (`racingphysics/stdafx.h:34-35`), and the motorbike, network-state, replay and
   debug-draw TUs are not needed (`cardebug.cpp`, `motorbikes*`, `spudebug.cpp`).
2. **Gravity**: `C_Scene` (allocation, body lists, command queue, `_Simulate`), the
   solver the scene runs even when nothing touches, the shape/body/descriptor code, the
   importer, the narrowphase/tree code that the fill and trace need, and the subsystem
   headers `Scene.cpp` includes unconditionally (cloth, fluid, rope, triggers,
   controllers). This is the "Gravity is not modular" fact from
   `t005-physics-feasibility.md` §2.2: the vehicle path is ~70 kLOC, and the smallest
   faithful configuration is 118 Gravity TUs, not a hand-picked dozen.

Two things were deliberately **not** re-implemented: the integrator (there is no
harness-side physics) and the ground query (the harness uses `C_Scene::FillCache` and
`C_LineCollisionCache::Trace` exactly as `Car` does, to find the placement height).

### 1.1 What the harness chooses, and what the engine chooses

| the engine computes | the harness chooses |
| --- | --- |
| every force, every integration step, every wheel ray, every contact | the start point (a committed oracle fixture, §3) |
| the gravity body's transform, the fill-cache box | a box collision proxy for the car body (retail uses the model import) |
| the scheduler's group/policy behaviour | the policy value (`{7,7,7,7,7,7,7,7}`, the game's own, §3) |

---

## 2. Translation units, and the six that cannot compile

TUs are listed by `engine/verify_vehicle.py` (`RP_TUS`, `GV_DIRS`/`GV_EXCLUDE`,
`COMMON_TUS`).

| group | count | notes |
| --- | ---: | --- |
| RacingPhysics | 23 | simulation + car + network-state TUs (the vtable needs them) |
| Gravity `sdk` | 15 | `Scene.cpp`, `SPUScene.cpp` (holds `FillCache`), `Body`, `ShapeDescriptors`, `BodyHelper`, `CollisionPhantom`, `PhysicsSDK`, controllers, `InertiaTensorGenerator` |
| Gravity `narrowphase` | 34 | trees, caches, primitives, GJK/EPA (including `GJKCollisionSpu.cpp`, which supplies the `GJK*` entry points the collision manager calls), collision manager |
| Gravity `solver2` | 37 | the LCP solver the scene runs |
| Gravity `sharedphysics` | 10 | rigid body, integrator, contact stream/database, constraint graph |
| Gravity `broadphase` | 4 | distribution tree (its `FillCache` is `#if 0`, but `Body.cpp` calls the tree) |
| Gravity `treebuilder` | 3 | `AABBTree`, `KDTree`, `BuildClothTree` |
| Gravity `cloths` | 11 | reached through `Scene.cpp` + solver |
| Gravity `Triggers` | 2 | reached through `Scene.cpp` |
| Gravity `importer` | 2 | level import + instance mesh manager |
| closure (common) | 44 | maths (`SIMD`, `Constants`, trig tables, `New/*`), scheduler (`jobqueue*`, `jobqueue_web`), logging, time, `C_MemoryStream`, `BizAssert`, endian, threads |
| harness | 1 | `engine/harness/t005d-vehicle/vehicle_harness.cpp` |

Seven Gravity TUs are excluded, each for a measured reason (they are named in
`GV_EXCLUDE`):

| TU | why |
| --- | --- |
| `sdk/Scene_DebugRender.cpp` | `Display` / DX11 |
| `narrowphase/GJKSPU.cpp` | SPU-only code; `GJKCollisionSpu.cpp` supplies the `GJK*` entry points that the collision manager actually calls, and that one *is* compiled |
| `narrowphase/CollisionManager_Rope.cpp`, `cloths/ClothCollision.cpp`, `cloths/RopePrimitiveCollision.cpp` | their headers do not parse for this target (`CollisionManager_Rope.cpp` reaches rope types through a header cycle; the cloth/rope headers redeclare `C_ClothCollision`) |
| `solver2/Link.cpp`, `solver2/Multibody.cpp` | Featherstone multibody; `Featherstone.h` needs the New-maths `Vector6` templates, and `C_MultiBody` is commented out in `Scene.cpp` |

Nothing links against them: the link is closed with `-sERROR_ON_UNDEFINED_SYMBOLS=1`.

---

## 3. Car data: decoded from the real XT record, not invented

`racingphysics.cpp:20` opens `gamedata\Xt\racingphysics.bin`; the file lives in
`game-data/Blur/cache/gamedata.pak` (codec 2, 73,420 decoded bytes, 15,762 stored).
`engine/harness/t005d-vehicle/car_xt.py` extracts it with the project's PAK index,
validates the FLSK tables exactly as `probes/asset-reader/FORMAT-xt.md` documents, and
decodes one `RP_CarDynamics` record:

| | |
| --- | --- |
| record | index 37, id `1554942492`, name `Corvette_ZR1_Stock` |
| type | `RP_CarDynamics`, serialized size 632 |
| components | `RP_CarDynamics`×1 (632 B), `f32`×19 (the four float arrays), `RP_GraphPoint`×6 (the tyre grip curves) |
| name | `XtSz8`, a U32 offset into the record's (XtFlask-decoded) string block |
| emitted | 184 `name<TAB>value` lines: 144 scalars, the `mass.physicsParameters` handle, 6 array descriptors with 19 float elements and 6 graph points (12 components), plus the record name and handle header |

Values that matter (hex is the raw binary32 bit pattern in the field file):

| field | value |
| --- | --- |
| `mass.mass` | 1600 kg |
| `geometry.wheelBase` | 2.652 m |
| `geometry.trackWidthFront` / `Rear` | 1.656 / 1.637 m |
| `tyres.frontTyres.radius` | 0.356 m |
| `suspension.front.movementUp` | 0.17 m |
| `engine.limiterRPM` | 7250 |
| `gears.topGear` | 6 (ratios 2.29 / 1.61 / 1.21 / 1.00 / 0.81 / 0.67) |
| `transmission.driveType` | 0 = `DRIVE_TYPE_REARWHEEL` |
| `gears.gearRatios[]`, `engine.engineTorque_Rpm.dataPoints[]` | from the record's array components (6 ratios, 10 normalised torque points) |

**How the mapping is proven, not assumed.** The harness assigns each value to the
`CarDynamicsXt` member named by the field, and it *checks the name* on the way in: a
renamed or reordered field is a hard failure. Two structural checks run before the tick:

- `sizeof(CarDynamicsXt)` is **636** at runtime against a 632-byte serialized image. The
  difference is an `XtHandle`: 4 bytes on the wire (a `U32` record id), 8 bytes at
  runtime (`XtRecord*` + two `U16`s), and it sits inside `RP_CarMass`, so every later
  member of the C++ struct moves by 4.
- The harness prints `offsetof` for seven members; the verifier compares the four that
  are layout-comparable with the schema the file itself carries: `name` 0, `mass` 4,
  `geometry` 64 (serialized 60 + 4) and `engine.engineTorque_Rpm` 224 (serialized 220 +
  4).

**A layout finding worth recording:** the image is *not* a memory image of the C++
struct. The schema order for the last groups is `engine, transmission, gears, tyres,
friction`, while `carsettings.h` declares `engine, gears, tyres, transmission,
friction`. The runtime offsets (gears 312, tyres 344, transmission 560, friction 612)
therefore cannot be compared with the schema's, and a decoder that assumed "image bytes
= struct bytes" would silently swap the gearbox and the wheels. This decoder reads each
field at its **schema offset** and assigns it by **name**; the plausibility of the
decoded values (§3) is the independent check that the mapping is right.

**Two honest gaps, labelled:**

1. `mass.physicsParameters` is an `XtHandle` whose id in this record is `0x4c`. No record
   in `racingphysics.bin` has that id; in the shipped game the XT database can resolve it
   across packs (`global.xt`). The XT runtime is not ported, so the harness installs the
   **null** handle and reports the raw id. Consequence: `Car::CopyMassVariablesToGravity`
   (`car.cpp:906-939`) takes its fallback branch. That function only runs when
   `m_copyMassVariablesToGravity` is set, which the game does not do for a normal car.
2. `Surfaces::GetGripScale/GetRollingFriction/GetMIScale` return their documented
   neutral values (1, 0, 1) when no `RP_SurfaceMappingList` is installed
   (`surfaces.cpp:230-300`). The mapping list *is* in the same XT file, but it is a
   second record graph and is **not** installed here: `surfaceMappingsApplied:false`.

Everything else the car uses (mass, inertia scales, geometry, suspension, steering,
brakes, engine, gears, tyres, transmission, friction) comes from the record.

### 3.1 The Gravity side of the car

`VehicleActor.cpp:6905-6970` builds a Gravity body from the car's imported collision
model and installs it with `Car::SetGravityBody`. That model import is out of scope, so
the harness builds the body from the car's **own XT geometry** instead:

- `C_BoxDesc` half extents `(trackWidthFront/2, tyreRadius, wheelBase/2)`
- mass 1600 kg (XT), inertia from `C_BoxDesc::InertiaTensor` via `C_BodyHelper`
- gravity `(0, −9.8, 0)`, Baumgarte 1.25, slop 0.00005, max angular 10 rad/s,
  max linear 250 mph → all five are the game's own debug defaults
  (`VehicleActor.cpp:228-229`, `:680-682`, `:1041`)
- the box is labelled `carBodyShape:"box-from-XT-geometry"` in the document; the retail
  composite shape would only matter for body-vs-world contacts, which do not occur here.

---

## 4. Scenario and what is recorded

The harness (`vehicle_harness.cpp`) does what `GameWorld` and `C_LevelInstance` do:

1. `C_PhysicsSDK::CreateScene(materialMatrix, 1)` — a 1×1 `C_MaterialPair` with the
   game's own default friction 0.65 / restitution 0.05 (`Materials.cpp:35-42`), because
   every shape in this level declares physics material 0.
2. `C_ImportScene::Import` over the `Main` block through `Sys::C_MemoryStream`, then
   `C_ImportSceneStaticInstance(scene, importScene, (5,20,5), (50,50,50), &filter, &filter)`
   — the game's parameters (`LevelSceneManager.cpp:28-31`).
3. `scene->ProcessCommands()` once: `AddMeshBody` queues a deferred command, so the mesh
   bodies only enter `m_MeshCollisionBodies` when the scene drains its queue.
4. A ground probe with the same fill+trace the wheel uses, at the scenario's fixed
   `(x,z)`, to get the placement height (reported as `groundY`).
5. `scene->SetInternalTaskPolicy(CreatePolicy({7,7,7,7,7,7,7,7}))` — the game's own
   policy (`SchedulerConfig.cpp:8`, installed at `GameWorld.cpp:561`).
6. One car, `Car::Initialise` with the host-installed XT record, `SetGravityBody`,
   `scene->AddBody`, `scene->SetMinTimeStep(-1)`, `PhysicsTimer` at 1/60.
7. Per tick: set `Car::Controls()`, `scene->Simulate(1/60)`,
   `PhysicsTimer::UpdatePhysicsTimer()`.

The start point `(281.2833, 1823.6890)` is the contact `x/z` of the committed
collision-oracle fixture **`ray-random-21`**, whose surface normal is `(0.000, 0.999,
0.000)` — a flat piece of road. It is not a hand-picked coordinate: it is a point the
oracle already proved lies on the mesh. The car is placed with its wheel rest positions
`radius + movementUp` above the probed ground (`startY = groundY + 0.526 m`).

Per tick the document records position, the three axis vectors (orientation), linear and
angular velocity, ground-relative speed, all four wheels' `onGround`, suspension
distance, wheel position, wheel angular velocity, surface flags, user data and the ground
normal, plus an FNV-1a-64 **hash of that tick's canonical bytes** (fixed field order,
floats as binary32 bit patterns) and a `finite` flag. The summary carries SHA-256 state
hashes over the settle phase, the drive phase and the whole run.

---

## 5. What actually happened

| phase | observation |
| --- | --- |
| release, ticks 0-5 | the car is dropped from `radius + movementUp` above the probed ground (y 3.252); the rear wheels touch first (ticks 1-5 have `g=0001`/`1001`/`1101`), then all four |
| settle, ticks 5-180 | the body drops 0.17 m to y≈3.08 and the wheels come to their nominal rest position (`suspensionDistance` ≈ −0.0002…−0.0005 m); the car creeps at ≈0.8-1.0 m/s down the fixture's 0.06 % slope |
| drive, ticks 180-460 | speed 0.7737 → **31.0948 m/s**, **96.142 m** travelled, all four wheels in contact the whole way, yaw within 0.5° of 91° |
| drive, ticks 460-479 | the car reaches the edge of the flat area: the front wheels lift (ticks 460-479 have `1011`, `0111`, `0011`), the peak speed **35.1341 m/s** is reached at tick 457 as the car leaves the surface, final y 4.304 |
| wheel spin | at tick 479 the rear wheels spin at 117.3 / 103.6 rad/s against fronts at 87.7 / 88.1 — a driven rear axle with visible wheelspin |
| NaN/Inf | none, in any tick |

That is real vehicle behaviour, not a kinematic cheat: the wheels spin, the suspension takes
the load, the car accelerates smoothly in a straight line, and the only loss of contact is
the initial drop and the road edge at the end. It also shows the limits of the scenario —
a 300-tick straight-line run leaves the flat fixture area, so a longer or steered run would
need a start point with more clear road ahead.

A note on the 0.06 % slope: the fixture's normal is `(0.000, 0.999, 0.000)` to three
decimals, but the quantised triangle underneath is not exactly level, so the car rolls
~0.8 m/s at rest. That is the tyre/friction model doing its job, not drift.

---

## 6. Build and run evidence

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

# fresh copy of upstream -> scheduler overlay -> file overlay -> t005d vehicle patch,
# build twice, run twice, check physics, check PC parity, record the native blocker
& $py engine/verify_vehicle.py --fresh

# reuse the tree and the modules
& $py engine/verify_vehicle.py

# regenerate the committed patch from an edited tree
& $py engine/verify_vehicle.py --make-patch
```

| gate | result |
| --- | --- |
| patch | `t005d-vehicle-overlay.patch`, 12,583 B, 9 files, +109/−14, SHA-256 `6fd6f2d1e2ed752251467dd779b0e27d30dfd2d5f23e483b78f28323051a86bd` |
| tree | fresh `robocopy` of upstream `5270304b`, then the scheduler + file overlays, then this patch |
| objects | **186** (23 RacingPhysics, 118 Gravity, 44 closure, 1 harness) |
| wasm | **1,024,869 B**, SHA-256 `8015f063c5b998b87e8f630f226c96be42aaff7f189584483ffb16c98eae81ce` |
| build determinism | a second full build produced the same SHA-256 |
| run determinism | two runs byte-identical; document SHA-256 `5dfe24995b42db1e39ea8da2c7c0447682886c7af297e4e8f1709dcca427bd40` (364,836 B) |
| engine source edits | 9 files, all in the patch; `upstream/` untouched |
| PC parity | 7/7 web-only files preprocess identically in the PC configuration; 2 unconditional grammar fixes |
| native probe | blocked, §7.3 |
| elapsed | 544.3 s end to end (481.2 s of that is the two 186-object builds) |

Flags (identical for every TU, one `-I` set per library so `stdafx.h` resolves per
library):

```text
-DBUILD_CONFIG_SPEED -DPLATFORM_WEB -std=c++14 -O2 -fno-fast-math -ffp-contract=off
-fdelayed-template-parsing -D__restrict= -fdeclspec -DUSE_SOLVER_2
-Wno-nonportable-include-path -Wno-ignored-attributes -Wno-deprecated-register
-Wno-return-type -Wno-c++20-extensions
-include engine/harness/t005b/msvc_crt_web.h
-include engine/harness/t005c/web_platform.h
```

No numeric or narrowing workaround flag is needed: the only construct that needed
`-Wno-c++11-narrowing` was the XT registration metadata, which the overlay removes from
the web build (§7.1).

| gate | result |
| --- | --- |
| ticks | 480 = 180 settle + 300 full throttle |
| wheel contact | 480/480 ticks have at least one wheel on the ground; the last settle tick has all four |
| NaN / Inf | 0 ticks, every tick's `finite` flag is 1 |
| settle | max speed 1.2841 m/s (the car creeps on the fixture's 0.06 % slope); body y 3.252 → 3.080 |
| throttle phase | 0.7737 → **31.0948 m/s**, peak **35.1341 m/s**, **96.142 m** travelled |
| final state | position (284.185, 4.304, 1922.320) — at the end the car has reached the road edge and only the rear wheels still touch (`g=[0,0,1,1]`) |
| canonical record | 45 bytes per tick |
| settle state hash | `27f9c4eb059e735f3f49f89f9fea3eda30c8c6a7b18bf724e516338d50c6e086` |
| drive state hash | `1eba531c023526448400a8f0e82ad13bf7f543a3b68e17479509282ec50dce66` |
| whole-run state hash | `2bbc0a1838a46789925bafc0bd2a893bd3026a4169a53bcb916b1fd754e974f5` |
| distinct tick hashes | 480 of 480 |
| struct checks | `sizeof(CarDynamicsXt)` 636; `offsetof` name 0, mass 4, geometry 64, torque curve 224 (all matching the schema plus the 4-byte handle) |

---

## 7. PC parity and the native comparison

### 7.1 The overlay patch: 9 files, +109/−14

`engine/patches/t005d-vehicle-overlay.patch` is applied *after* the scheduler and file
overlays. Seven files are web-only; two are unconditional grammar fixes that the
feasibility analysis already required (`t005-physics-feasibility.md` §3.4).

| file | change | kind |
| --- | --- | --- |
| `racingphysics/include/.../car.h` | `SetWebCarDynamics`, `WebPhysicsFatal` declaration, `DisplayDebug()` empty body on web | web-only |
| `racingphysics/source/vehicles/Car/car.cpp` | ctor nulls the XT pointers on web; `XtReload` installs the host dynamics and fails loudly when absent | web-only |
| `racingphysics/source/vehicles/Car/carsettings.cpp` | `XT_TYPE`/`XT_LIBRARY` block not compiled on web | web-only |
| `racingphysics/source/physics/surfaces.cpp` | idem | web-only |
| `racingphysics/source/physics/parameters.cpp` | idem | web-only |
| `racingphysics/source/vehicles/debugsliprecorder.cpp` | `Display()` body and its `display/...` include not compiled on web | web-only |
| `gravity/source/sdk/SPUScene.cpp` | include `AxisBox.inl` on web (the fill-cache path calls `C_AxisBoxMinMax::Intersects`, whose body clang needs in the TU) | web-only |
| `gravity/source/sdk/Body.cpp` | `AddToEnd(&C_Scene::BodyPtr(this))` → named local, 9 sites | **unconditional** |
| `gravity/source/importer/InstanceMeshResourceManager.cpp` | remove default arguments from the constructor *definition* that the header already declares without them | **unconditional** |

The two unconditional fixes are the ones the earlier analysis demanded by name:
`&temporary` is an MSVC extension (`Body.cpp:1028…1194`, harmless because
`List::AddToEnd` copies), and the duplicate default arguments make the constructor a
second default constructor.

Why `XtReload` had to change at all: `Car::Initialise` → `Car::XtReload` → 
`CarDynamicsXt::LoadDynamicsXt`, which scans the `gXtCarDynamics` vector the xt2 callback
fills. With no xt2 runtime that vector is empty, `LoadDynamicsXt` returns `NULL`, and
`RP_ASSERT` is compiled out under `CFG_SPEED` — so the car would have run on an
uninitialised `m_pCarDynamics`. The web branch replaces that with "install the record the
host decoded, or abort", which is why the harness is allowed to be the only source of car
parameters.

### 7.2 PC parity, measured

Two checks, both in `engine/verify_vehicle.py`:

1. **Web-only files.** For each of the seven, MSVC preprocesses the file in the **PC**
   configuration (`/TP /DPLATFORM_PC /DWIN32 /D_WINDOWS /DBUILD_CONFIG_SPEED`) twice: once
   from the baseline tree (the same tree with this patch reverted, so the scheduler and
   file overlays stay applied) and once from the patched tree. The two preprocessed
   translation units are compared after dropping `#line` markers and normalising the
   `__LINE__`/`__FILE__` payload that the added lines necessarily shift. They are
   **identical** for all seven, with line counts in the report
   (SPUScene.cpp 103,413 / car.cpp 102,670 / carsettings.cpp 94,745 / car.h 93,969 /
   surfaces.cpp 85,304 / debugsliprecorder.cpp 85,031 / parameters.cpp 84,664). Since
   `PLATFORM_WEB` is undefined, every added block preprocesses away: the PC translation
   unit does not change at all.
2. **Unconditional fixes.** The same preprocessing for `Body.cpp` and
   `InstanceMeshResourceManager.cpp` differs exactly where the fix is. Both compile in the
   PC configuration with MSVC `/W4` (`0 errors`; every warning comes from upstream headers,
   none from the changed lines). Behaviour is unchanged: `AddToEnd` copies the wrapper
   (`List.h:361-367`), and the removed default arguments only existed in the definition.

The `Display` headers are replaced by an empty shim for *both* sides of the comparison,
because the checkout has no DX SDK (see 7.3). That is the only deviation, and it is
symmetric.

### 7.3 Native-vs-wasm comparison: blocked, with the exact reason

The task's native probe would have to compile the same tree with MSVC. Two
configurations are possible and both are blocked:

| configuration | first blocker |
| --- | --- |
| **PC** (`PLATFORM_PC`) | `racingphysics/stdafx.h:24` includes `Display/Core/Includes.h`; with the display include path added, `Display/Core/Includes.h:59` includes `dxerr.h` — the legacy DirectX SDK, not installed. Measured: `engine/verify_vehicle.py` records the command and the first error (see `_work/logs/engine-vehicle-spike/native-attempt.log`). |
| **web** (`PLATFORM_WEB`) with MSVC | the web overlay relies on clang/GCC builtins that MSVC does not provide (`__atomic_*` in `core/threads/Atomic.h`, `__builtin_trap` in `Core.h`, `__fsel`), so `PLATFORM_WEB` cannot be built with MSVC at all. |

Those two facts are the blocker: the *same* source cannot be built natively in the *same*
configuration on this machine. The honest substitute, recorded in the report, is:

- the wasm build is deterministic (two builds, same `.wasm` SHA-256) and the run is
  deterministic (two runs, byte-identical documents, same state hashes);
- the PC translation units are unchanged (§7.2), so a future native probe, once the DX
  SDK path is resolved or a clang-cl toolchain is pinned, measures the same code.

---

## 8. Scope labels — what did and did not run

The verification report (`_work/logs/engine-vehicle-spike/verify-vehicle.json`) carries a
`scope` block with these labels; the run document carries the per-tick state and the state
hashes.

| label | value | meaning |
| --- | --- | --- |
| `carBodyShape` | `box-from-XT-geometry` | retail uses the model's composite collision shape |
| `surfaceMappingsApplied` | `false` | `RP_SurfaceMappingList` not installed; grip/rolling/MI scales are the engine's documented neutral values |
| `physicsParametersResolved` | `false` | handle id `0x4c` not resolvable without the XT database |
| `xtRuntime` | `false` | no `XtPackOpen`/`XtFlaskImport`; the record is decoded by the verifier and installed |
| `gravitySolver` | `true` | the real `_Simulate`/solver runs; no body-vs-world contact occurred in this run |
| `renderer` | `false` | `Display` absent; `DisplayDebug`, slip-recorder drawing and `DefaultDebugRenderSys` do not render |
| `network` | `false` | `Car::Network*` exists (the vtable needs it) but `CONTROL_TYPE_PLAYER` never enters it |
| `motorbike/cloth/rope/replay` | `false` | not driven |

Not claimed: visual output, a playable game, a game loop, multiple vehicles, wall
contacts, surface-dependent grip, or equality with the retail binary.

---

## 9. Blockers and the next smallest steps

1. **Native numeric reference** — blocked by the DX SDK (7.3). The cheapest unblock is a
   clang-cl toolchain (same builtins as the wasm build) which would let the identical
   source run natively; that is a toolchain decision, not a porting task.
2. **Surface mapping** — decode `RP_SurfaceMappingList` with the same schema-driven
   decoder and install it through `Surfaces::BindSurfaceMappings`. That removes the
   `surfaceMappingsApplied:false` label and makes grip/rolling friction real.
3. **Car body shape** — import the model's composite collision descriptor
   (`LevelResource.cpp:150`) instead of the box, for body-vs-wall behaviour.
4. **Multi-vehicle determinism** — `Scene.cpp:1756-1768` flushes integration groups by
   iterating a hash set. With one car there is one group; with several, flush order is a
   real determinism hazard (`t005-physics-feasibility.md` risk 4) and must be measured.
5. **`Normalise()` policy** — this run uses the web build's exact `1/sqrt`; the retail PC
   path uses `_mm_rsqrt_ps` + one Newton–Raphson step (`t005-collision-oracle.md` §6.1).
   Any future comparison with the retail binary must decide this explicitly.
6. **Suite wiring** — `engine/verify_vehicle.py` is not yet a step in
   `tools/verify_asset_probe.py` (that file is owned by the main agent). Its cost is two
   full 186-TU builds, so a `--skip-build` step is the sensible default, like the
   gravity step.

---

## 10. Evidence index

| topic | path |
| --- | --- |
| verifier | `engine/verify_vehicle.py` |
| overlay patch (9 files) | `engine/patches/t005d-vehicle-overlay.patch` |
| harness (engine + wrapper) | `engine/harness/t005d-vehicle/{vehicle_harness.cpp,car_xt.py,run_vehicle_wasm.mjs}` |
| fail-loud `Display` absence | `engine/harness/t005d-vehicle/display_shim/` |
| verification report | `_work/logs/engine-vehicle-spike/verify-vehicle.json` |
| run document (run a / repeat) | `_work/engine-vehicle-spike/{vehicle_a.json,vehicle_b.json}` |
| decoded car field list / evidence | `_work/engine-vehicle-spike/{car.fields,car.evidence.json}` |
| extracted XT pack | `_work/engine-vehicle-spike/racingphysics.xt` |
| build/run logs | `_work/logs/engine-vehicle-spike/` |
| wasm module | `_work/engine-vehicle-spike/out/vehicle_a.{mjs,wasm}` |
| physics feasibility (prior) | `docs/work/analysis/t005-physics-feasibility.md` |
| collision oracle (prior) | `docs/work/analysis/t005-collision-oracle.md` |
| Gravity spike (prior) | `docs/work/analysis/engine-gravity-layer.md` |
