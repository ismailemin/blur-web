# M2a/M2b — deterministic host-authoritative boost feasibility (Nitro, Shock/Shunt)

**Date:** 7 November 2026
**Owner:** BOOST1 (sub-agent)
**Scope:** read-only feasibility. New `probes/boost-feasibility/`, `_work/boost-feasibility/`,
`_work/logs/boost-feasibility/` and this document. **No change** to `probes/e1-drive/`,
`engine/`, `probes/powerups/`, `probes/race-rules/`, `probes/net-mvp/`, `tools/`,
`upstream/` or `game-data/`.

**Result:** Nitro can be implemented **without a RacingPhysics/Gravity engine change**
as a host-sequenced force applied through the engine's own `C_Body::AddForce` before
`C_Scene::Simulate`. On the real wasm car it produces a **+22.9 m/s** speed gain over
the 1.3 s Nitro duration (baseline +7.9 m/s), **+29.1 m** extra distance, 0 NaN,
four-wheel contact until the road edge and a deterministic state hash. The probe's
mode-0 baseline is **bit-identical** to the shipped e1 module. Input-only, a torque
multiplier, a post-tick velocity write and a post-tick pose write are each rejected
with measured reasons. Shock can use the same force path as a speed scrub; a Shunt
linear impulse works but is a **provisional design**, because retail Shunt is a
fake-physics flip/tip plus damage, not a linear impulse. **No retail-parity or
full-game claim.**

---

## 0. TL;DR

| question | measured answer |
| --- | --- |
| Is there an existing boost hook? | No. `CarControls` has only steer/throttle/brake/handbrake; `CarEngine::Boost()` is a dead accessor returning `0.f` (`car.h:297`). The wasm export list has no boost function. |
| Can throttle alone reproduce Nitro? | No. Full throttle adds **+7.93 m/s** in 1.3 s and the engine's own maximum on the fixture is **35.13 m/s**; the recovered Nitro target at the 310 m sprint speed is **44.85–52.76 m/s** across classes D–A (52.76 m/s at class A). |
| Can `peakTorqueScale` reproduce Nitro? | No. 2.0 gives +9.69 m/s, 5.0 gives +9.77 m/s: it saturates at **~34.9 m/s** because `CarEngine::GetTorque` clamps torque by `MaxAcceleration_Step` (`carengine.cpp:106-109`). |
| Can a post-tick velocity write work? | It is deterministic, but it is **not engine-consistent**: the published state lags the injected velocity by one tick, and a one-shot +27 m/s leaves the wheel spin **30.5 % below** body speed at the first visible tick. Reject: it silently writes physics after the solver. |
| Can a post-tick pose write work? | No. 30 requested 0.5 m steps (15 m) produced **+1.90 m** net displacement and no speed gain at 1.3 s; the engine constraints absorb the rest. Reject. |
| What works? | An engine force applied **before** `Simulate`: retail `FakeVehicleSpeedState` shape, `force = 300 m/s² × mass × adjust`, target-speed clamp, 0.5 s force window inside a 1.3 s effect. Measured +28.05 m/s at 0.5 s, +22.87 m/s at 1.3 s, peak 54.24 m/s, +29.08 m over baseline, 0 NaN, deterministic. |
| Shock? | Same force path with the sign reversed (`E_FAKE_SPEED_BRAKE`): target 20.1 m/s, −9.68 m/s in 0.5 s, 0 NaN, deterministic. |
| Shunt? | A linear impulse before `Simulate` works (20 kN·s → +12.11 m/s; 10 kN·s along body X → 6.25 m/s, 0 NaN, deterministic), but retail Shunt is `E_FAKE_PHYSICS_FLIP_FORWARD`/`TIP_FORWARD` + damage (`VLC_Pickups.cpp:1698/1702`). An impulse is therefore **provisional**, not retail parity. |
| Does it break determinism? | No. Every candidate produced the same state hash in two fresh module instances. Determinism is necessary but not sufficient: the post-tick candidates are deterministic and still rejected on engine-state consistency. |
| Does it break multiplayer authority? | The host can originate and sequence the event. In the current M1 architecture the host does **not** simulate the guest body, so the guest must apply the host-sequenced force to its **own** car at the anchored tick; a literal "host writes every car" needs server-side physics for all cars (an architecture change, not a power-up change). |

---

## 1. Method and control

The shipped e1 module is a 186-object wasm build whose only own TU is
`probes/e1-drive/native/e1_drive_lib.cpp` (`_work/e1-drive/module/build.json`,
wasm SHA-256 `eb9efc00…b53409`). It exports:

```text
_e1_create _e1_reset _e1_set_input _e1_step _e1_get_state _e1_info
_e1_engine_rpm _e1_ground_probe _e1_last_error _e1_diag _e1_ray_probe
_malloc _free
```

There is no boost, impulse, speed or modifier export.

The probe compiles the **exact shipped translation unit by inclusion** and adds
only a step seam:

```text
probes/boost-feasibility/native/boost_probe_lib.cpp
    #include "../../e1-drive/native/e1_drive_lib.cpp"
    b_step()  = the same controls + C_Scene::Simulate(1/60)
                + a pre-Simulate or post-Simulate hook
    b_set_mode(kind, a, b, c, ticks)
    b_extra() = live RPM/gear/throttle/forward speed/wheel spin/applied value
```

The engine objects are the same 185 reused T-005d objects. The probe wasm is
1,009,166 B, SHA-256 `3f03ed86…5da9d9e0`, and two links are byte-identical
(`_work/boost-feasibility/module/build.json`).

**Control:** the shipped module and the probe mode-0 baseline were run with the
same 318-tick full-throttle sequence from the T-005d fixture point
`(281.2833, 1823.6890)`, heading 0, Corvette ZR1. Both produced

```text
sha256:f3d6ffa4729d1a62ef56607c15f348df96318db6e3bf4f1a14db4d17601f4e1d
```

(`_work/boost-feasibility/control.json`, `match:true`). The probe therefore did
not change the physics; every difference below is the hook.

Fixture: the T-005d collision-oracle point `ray-random-21`, a flat piece of road
with 118 m of drivable straight before a road edge. The car is the Corvette ZR1
(`RP_CarDynamics` record 37, id `1554942492`, 1600 kg, RWD, wheelbase 2.652 m).
`e1_create` runs the shipped 180-tick settle (`kWarmupTicks`, `e1_drive_lib.cpp:525`);
the experiments then run 180 full-throttle ticks, apply the candidate for its
window, and run 60–120 post ticks. `dt = 1/60` (`e1_drive_lib.cpp:526`).

---

## 2. Available engine inputs and state (inventory)

All paths below are in the T-005d tree
`_work/engine-vehicle-spike/tree/code/mercury/library/`.

### 2.1 Driver inputs

| item | exact definition | note |
| --- | --- | --- |
| `CarControls` | `racingphysics/include/.../car/car.h:423-475` | fields `steer`, `throttle`, `brake`, `handbrake`, `pitch`, `roll`, `reverse`, `gearUp`, `gearDown`, `isWheel`, `horn` |
| throttle/brake range | `CarControls::Validate` `car.h:467-474` | `RP_ASSERT(throttle >= 0 && <= 1)`, `brake >= 0 && <= 1`; **there is no "raised target" above 1.0** |
| controls access | `Car::Controls()` `car.h:666-667`; `Car::Throttle/Brake/Steer/Handbrake()` `car.h:676-679` | what `e1_step` writes (`e1_drive_lib.cpp:1123-1128`) |
| handbrake | `CarControls::Hold()` `car.h:456-465` | sets `handbrake=1`; no boost |

### 2.2 Engine and drivetrain state

| item | exact definition | note |
| --- | --- | --- |
| RPM | `CarEngine::RPM()` `car.h:291`, implementation `carengine.cpp:68-76` | `Abs(driveAxis · rotorAngular) / RPM`; this is the value `e1_engine_rpm()` returns (`e1_drive_lib.cpp:1160-1165`) |
| limiter | `CarEngine::LimiterRPM()` `car.h:292`; `Dynamics().engine.limiterRPM` 7250 | rev limiter |
| throttle actually used | `CarEngine::AdjustedThrottle()` `car.h:295`; accumulated at `carengine.cpp:156`; `powerCut` `car.h:296` | measured below |
| gear | `CarTransmission::Gear()` `car.h:363`; `Car::GetGear()` `car.h:600` | measured below |
| engine torque | `CarEngine::GetTorque()` `carengine.cpp:95-112` | `this × peakTorqueScale`, then a `tmax` clamp (see §5.3) |
| control force | `CarEngine::EvaluateControlForces()` `carengine.cpp:114-167` | `engineTorque += t × throttle` (`:161`), applied as engine torque (`:166`) |
| dead boost accessor | `CarEngine::Boost()` `car.h:297` | `return 0.f;`; used only by audio (`BaseMessageHandler.cpp:1990`), **not a physics hook** |
| intake air | `Car::AirSpeed_LocalZ()` `car.h:649`; `GroundSpeed_LocalZ()` `car.h:648` | used by the harness `speed` computation |

### 2.3 Engine-provided performance modifiers (multipliers)

`CarPerformanceModifiers` (`car.h:489-535`) is returned as a mutable reference
(`car.h:660-661`). Every field is a **multiplier inside existing engine force
equations**, not a speed target:

| field | applied at |
| --- | --- |
| `peakTorqueScale` | `carengine.cpp:104` |
| `finalRatioScale` | `cartransmission.cpp:267` |
| `maxWheelSpin` | `car.cpp:1480` |
| `airFrictionScale` | `car.cpp:1601` |
| `downforceScale` | `car.cpp:101`, `:979`, `:984` |
| tyre grip / radius / rolling friction | `carwheel.cpp:76-77`, `:165`; `car.h:932-939` |

This is the "tiny engine export/multiplier" family. It is engine-integrated but
cannot create a target speed above the engine's own top speed (measured in §5.3).

### 2.4 Force / impulse / state hooks on the physics body

| item | exact definition | semantics |
| --- | --- | --- |
| `Gravity::C_Body::AddForce(force)` | `gravity/source/sdk/Body.cpp:775-785` | adds to `m_ExternalState.m_Force`, consumed by the solver; requires an active/sleeping graph node |
| `Gravity::C_Body::ApplyImpulse(impulse, pos)` | `Body.cpp:680-699` | deferred scene command; one-shot impulse at a world point |
| `Gravity::C_Body::AddImpulse(impulse)` | `Body.cpp:722-739` | deferred scene command; one-shot linear impulse |
| `C_Body::GetBody()` | `gravity/include/gravity/sdk/Body.h:486-496` | returns `SharedPhysics::C_RigidBody&` |
| `C_RigidBody::AddForce` | `gravity/include/gravity/sharedphysics/RigidBody.h:258-261` | immediate accumulation |
| `C_RigidBody::AddImpulse` | `RigidBody.h:307-313` | updates linear momentum and velocity immediately |
| `C_RigidBody::StoreLinearVelocity` | `RigidBody.cpp:79-85` | writes velocity **and** momentum; used by candidate B |
| `C_Body::Position(pos)` | `Body.cpp:856-875` | writes external state and queues `E_OverridePosition` for the next `Simulate`; used by candidate B |
| `Car::SetPosition` | `car.cpp:356-362` | sets the articulated-body axis only; not a gravity-body teleport |

`C_Scene::Simulate(1/60)` is the one engine call per `e1_step`
(`e1_drive_lib.cpp:1132`). Anything called before it is inside the engine's
integration; anything called after it is outside the solver.

### 2.5 State exposed by e1

`e1_get_state()` serialises position, the three body axes, velocity, angular
velocity, ground-relative `speed`, four wheel records (`onGround`, suspension,
position, spin, surface, userData, ground normal), `finite`, `anyContact` and the
input actually applied (`e1_drive_lib.cpp:956-1015`). `e1_engine_rpm()` adds the
live engine RPM. The probe's `b_extra()` adds `rpm`, `gear`, `throttle`, `brake`,
`adjustedThrottle`, `powerCut`, `mass`, `forwardSpeed`, the applied
force/velocity/step and four wheel spin rates.

---

## 3. What the shipped game actually does (source evidence)

This is the mechanism authority; it is not a claim that e1 contains the retail
actor layer.

### 3.1 Nitro = `E_FAKE_SPEED_ACCELERATE` on the vehicle actor

`C_PickupEffectsNitrous` (`GameLogic/Pickups/Normal/PickupNitrous.cpp`):

- `mDuration = mpNitrousData->mDuration` (`:50`), the recovered **1.3 s**.
- `graphVal = 200.f` ("1.0 on the graph == 200 mph", `:73`); `speed = mPrevSpeed / 200`; `speedMult = CalcSpeedFromGraph(speed)` (`:74-76`);
- `newSpeed = mClassMult * speedMult * graphVal` (`:100`);
- `pActor->GetGraphicalActor(...)->GetFakeSpeed()->Start(E_FAKE_SPEED_ACCELERATE, newSpeed)` (`:101`).
- At expiry it calls `Start(E_FAKE_SPEED_BRAKE, max(mPrevSpeed * 1.1, graph(speed/200 - SlowDownGraphValue * classMult) * 200), 300)` (`:136-163`). `mPrevSpeed` is the speed at fire time.

`FakeVehicleSpeedState::Update` (`Game/GameActors/Vehicles/FakePhysics.cpp:700-778`):

- `E_FAKE_SPEED_ACCELERATE` (`:720-753`): while forward speed `< desiredSpeed`,
  `force = AZ * (300.0f * mass * adjust)`, `force.Y(0)`, `rb.AddForce(force)`
  (`:730-734`); `adjust = 2` below half the target (`:728`). The force runs for
  `_value = 0.5f` seconds (`:711`, `:748-751`), **not** the whole Nitro duration.
- `E_FAKE_SPEED_BRAKE` (`:755-775`): while speed `> desiredSpeed`,
  `force = m_LinearVelocity * -(rate * mass * adjust / speed)`, `rb.AddForce(force)`
  (`:764-766`); default `rate = 300.0f` (`:195`), max time 2.0 s (`:196`, `:712`).

So the retail Nitro is **not** an engine torque/gear change and **not** a direct
velocity write. It is a body force applied in the actor update, before the physics
step, with a target-speed clamp.

### 3.2 Shock = speed scrub, not a physical impulse

`C_VehicleComponent_Pickups::RegisterHitByPickup` (`VLC_Pickups.cpp:1711-1745`):

- `newSpeed = ShockGraph.Evaluate(speed/200) * 200` (`:1726`);
- per consecutive hit, `newSpeed += recoveryTimeSpeedMod * speed` (`:1740`);
- `Clamp(newSpeed, newSpeed, speed - g_debugShockManagerMinSpeedScrub)` (`:1743`);
- `pGraphicalActor->GetFakeSpeed()->Start(E_FAKE_SPEED_BRAKE, newSpeed)` (`:1744`).

`g_debugShockManagerMinSpeedScrub` defaults to **10 mph** (`ShockManager.cpp:52`).
The physical effect is a brake force, not a lateral/forward kick. The hit itself
uses `OuterRadius` for a minor hit and the shield/health path
(`PickupShock.cpp:250-275`); `DamageInflicted = 100`.

### 3.3 Shunt = projectile + fake-physics flip/tip + damage

`VLC_Pickups.cpp:1685-1708`:

- `E_PICKUP_HIT_TYPE_MAJOR`: `GetFakePhysics()->Start(E_FAKE_PHYSICS_FLIP_FORWARD)` (`:1698`);
- weak: `E_FAKE_PHYSICS_TIP_FORWARD` (`:1702`);
- `DisableActiveNitrous(false)` (`:1687`).

`FakePhysics.cpp:530/583` implements FLIP/TIP through `FakePhys_SetupEffect` and
`FakePhys_UpdateEffect`, which apply impulses/torques to the `C_RigidBody`. The
retail constants are debug defaults (`FlipForce 1.4`, `TipForce 0.3`, `FlipKickForce`
etc., `FakePhysics.cpp:97-103`, `:183-189`); the exact e1-unit impulse is **not**
recovered. A single linear impulse is therefore a design choice, not retail parity.

### 3.4 The retail anti-tunnelling guard is not in e1

`VehicleActor.cpp:4880-4953` ray-traces from the previous to the new body centre
and clamps the position on a hit. The e1 harness has only the Gravity box body and
the wheel rays; it does not compile the actor layer. Any high-speed boost must
therefore be checked against the body length and the engine's own 250 mph cap.

---

## 4. Recovered Nitro values and the exact target speed

From `_work/powerups/powerups.json` (`Nitrous`, `Normal`):

| field | value | source |
| --- | --- | --- |
| `Delay` | 0.0 | `NitrousBalancingData` |
| `Duration` | **1.3 s** | `NitrousBalancingData` |
| `DurationCheckpoint` | 2.5 | recovered, semantics not used |
| `SlowDownGraphValue` | 0.5275 | recovered |
| `ClassAModifier` … `D` | 1.0, 0.95, 0.90, 0.85 | recovered |
| `BalancingGraph` | 14 Hermite keyframes, 0.0…1.3 s | recovered |
| `maxBoost` | 500.0 | recovered; not used as a target |

The graph is evaluated at `speed_mph / 200`; the value is a **speed multiplier on
200 mph**. Keyframes (Time, Value): `(0.0,0.5)`, `(0.1,0.5)`, `(0.2,0.5)`,
`(0.3,0.61)`, `(0.4,0.7259)`, `(0.5,0.842)`, `(0.6,0.9515)`, `(0.7,1.0466)`,
`(0.8,1.1199)`, `(0.9,1.1647)`, `(1.0,1.1869)`, `(1.1,1.2094)`, `(1.2,1.2324)`,
`(1.3,1.2558)`.

The evaluator **is recoverable and was recovered**, so this is no longer a bracket:

- `RLDatabase.cpp:428-433` adds each serialized frame with
  `AddKeyFrame(mTime, mValue, mInTangent, mOutTangent)`.
- `misc_shared/Curve/HermiteCurve.h:77-82` converts the serialized tangents from
  degrees to the internal gradient with `tan(deg × π/180) / 3`.
- `HermiteCurve.h:150-200` evaluates the cubic Hermite; `GetValue` uses
  `y2 = y1 + tangentOut × period`, `y3 = y4 − tangentIn × period` and the standard
  `h1…h4` basis.

`probes/boost-feasibility/tools/run_probe.mjs` implements that exact function and
writes the result to `report.json.nitroTarget`. Only the **car class
modifier** remains unknown: the e1 roster records the car record but not
`AmaxVehicle::carClass`. The tables below therefore give every class explicitly;
the implementation must use the car's recorded class, not a default guess.

### 4.1 Exact target at the measured 310 m sprint speed (24.73 m/s = 55.32 mph)

`t = 0.2766`; the exact graph value is **0.590092**, i.e. 118.018 mph before the
class modifier.

| class | multiplier | target speed |
| --- | ---: | --- |
| A | 1.00 | **118.018 mph = 52.759 m/s** |
| B | 0.95 | 112.118 mph = 50.121 m/s |
| C | 0.90 | 106.217 mph = 47.483 m/s |
| D | 0.85 | 100.316 mph = 44.845 m/s |

### 4.2 Exact target at the measured straight-line maximum (35.134 m/s = 78.59 mph)

`t = 0.3930`; the exact graph value is **0.721241**, i.e. 144.248 mph before the
class modifier.

| class | target speed |
| --- | --- |
| A | **144.248 mph = 64.485 m/s** |
| B | 137.036 mph = 61.261 m/s |
| C | 129.823 mph = 58.036 m/s |
| D | 122.611 mph = 54.812 m/s |

### 4.3 Is the effect meaningful?

Yes. The engine's own maximum on the fixture is **35.134 m/s** (126.5 km/h) and
the 310 m sprint's measured maximum is **24.73 m/s** (89.0 km/h). The exact Nitro
target at the sprint speed is **1.81–2.13×** the sprint maximum across classes D–A,
and **1.28–1.50×** the engine's straight-line maximum. At the straight-line speed
the target is **1.56–1.84×** the current speed. In every class the target is above
the engine's current top speed, so this is not a cosmetic effect.

Measured with a representative target of 50 m/s (close to the class-B 50.121 and
class-A 52.759 targets, 0.5 s of accelerating ticks): **53.20 m/s at 0.5 s (+28.05)**,
**48.02 m/s at 1.3 s (+22.87 over the pre-boost speed, +14.95 over the
full-throttle baseline)**, peak **54.24 m/s**. Over the 1.3 s window the boosted
car covers 66.45 m versus 37.37 m baseline, i.e. **+29.08 m** (9.4 % of the 310 m
course).

### 4.4 Shock target (exact)

`ShockBalancingData` (`Normal`): `InnerRadius 7`, `OuterRadius 14`,
`Lifetime 1.5 s`, `DamageInflicted 100`, `Delay 1.0`, `HeightDiff −1.5`.
The Shock graph keyframes are `(0.0,0.0)`, `(0.2,0.2)`, `(0.4,0.25)`, `(0.6,0.4)`,
`(0.8,0.5)`, `(1.0,0.65)`, `(1.2,0.8)`, `(1.5,0.8523)`. At 55.32 mph
(`t=0.2766`) the exact graph value is **0.223641**, i.e. **44.728 mph = 19.995
m/s**. The `speed − 10 mph` clamp is 45.32 mph at this speed, so it is **not
binding**; the effective target is 44.73 mph = 20.0 m/s. The measured 20.1 m/s
target is effectively the exact curve target.

---

## 5. Candidate experiments and results

All runs: Corvette ZR1, fixture `(281.2833, 1823.6890)`, heading 0, 180 ticks
full throttle (pre speed **25.148 m/s**), then the candidate, then 60–120 post
ticks. "At 1.3 s" is the state 78 ticks after the pre state. "Boost end" is the
last tick of that candidate's own window (78 ticks for the baseline/input/torque
and the 78-tick Shock run, 30 ticks for the force/post-velocity/pose and 30-tick
Shock runs, 1 tick for the impulses). Distances are horizontal (`hypot(dx,dz)`).
`wheelEq = mean(wheelAngular) × 0.356 m` is the ground speed the wheels imply; the
delta is `(wheelEq − speed)/speed` at the second candidate tick.

### 5.1 Measured table

| id | mechanism | pre m/s | boost end | 1.3 s | gain @1.3 s | dist @1.3 s | peak | wheel delta @tick 2 | edge tick | NaN | det |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `baseline` | full throttle only | 25.148 | 33.076 | 33.076 | +7.929 | 37.37 m | 35.134 | +0.49 % | 318 | 0 | yes |
| `input-partial-0.8` | 0.8 throttle | 17.370 | 26.053 | 26.053 | +8.683¹ | 28.42 m | 30.574 | +2.8 % | 318 | 0 | yes |
| `torque-2.0` | `peakTorqueScale=2` | 25.148 | 34.836 | 34.836 | +9.688 | 39.05 m | 36.334 | +0.49 % | 296 | 0 | yes |
| `torque-5.0` | `peakTorqueScale=5` | 25.148 | 34.915 | 34.915 | +9.767 | 39.02 m | 36.459 | +0.49 % | — | 0 | yes |
| `force-target-45` | `AddForce`, target 45 | 25.148 | 48.922 | 42.649 | +17.502 | 61.92 m | 50.942 | −2.9 % | 256 | 0 | yes |
| `force-target-50` | `AddForce`, target 50 | 25.148 | 53.196 | 48.022 | **+22.875** | **66.45 m** | **54.236** | **−2.9 %** | — | 0 | yes |
| `force-target-55` | `AddForce`, target 55 | 25.148 | 57.667 | 50.912 | +25.764 | 71.29 m | 58.590 | −3.4 % | 246 | 0 | yes |
| `postvel-0.9x30` | +0.9 m/s after each step | 25.148 | 50.503 | 46.443 | +21.296 | 59.27 m | 52.735 | −0.6 %² | — | 0 | yes |
| `postvel-27-once` | +27 m/s after one step | 25.148 | 25.273³ | 45.805 | +20.658 | 64.12 m | 51.888 | **−30.5 %** | — | 0 | yes |
| `postpose-0.5x30` | +0.5 m pose after each step | 25.148 | 27.671 | 33.042 | +7.895⁴ | 39.28 m | 34.290 | +0.49 % | — | 0 | yes |
| `shock-brake-45mph` | `AddForce` opposite, target 20.1, 0.5 s | 25.148 | 15.470 | 23.137 | −2.010 | 24.41 m | 29.032 | +30.9 %⁵ | — | 0 | yes |
| `shock-brake-45mph-78` | same, 1.3 s | 25.148 | 18.283 | 18.283 | −6.864 | 22.85 m | 25.848 | +30.9 %⁵ | — | 0 | yes |
| `shunt-impulse-forward-20k` | `AddImpulse` 20 kN·s | 25.148 | 37.257 | 38.462 | +13.315 | 50.24 m | 41.428 | −2.7 %⁶ | — | 0 | yes |
| `shunt-impulse-lateral-10k` | `AddImpulse` 10 kN·s lateral | 25.148 | 25.881 | 33.072 | +7.924 | 37.43 m | 36.314 | −0.4 % | — | 0 | yes |

¹ The 0.8-throttle run starts from a lower pre-speed, so its 1.3 s gain is not a
fair "boost"; it only shows that input has no headroom above 1.0.
² The per-tick +0.9 m/s is small enough that the wheel catches up; the one-shot
case is the controlled test.
³ The one-shot injects 27 m/s after the tick; the published state at that tick is
still 25.273 m/s and the injected speed becomes visible on the next tick (51.888
m/s). At 1.3 s it has decayed to 45.805 m/s (+20.658).
⁴ At 1.3 s the pose run is 33.042 vs 33.076 baseline: **no speed gain**. The
requested 15 m of pose produced **+1.90 m** net displacement (the constraints
absorb the rest).
⁵ Heavy braking produces wheel slip; this is expected, not the post-tick defect.
The 30.9 % figure is at tick 2; ABS is enabled. The 30-tick run recovers after the
0.5 s brake window and reaches 23.137 m/s at 1.3 s; the 78-tick run is still
oscillating around the 20.1 m/s target and ends at 18.283 m/s.
⁶ The impulse changes body velocity before `Simulate`; the first-tick delta is
−12.7 %, then −2.7 %, −1.3 %, −0.7 % by tick 4. This is the expected transient of a
body impulse and is much shorter than the post-tick write.

### 5.2 Determinism and control

Every row above was run twice in a **fresh module instance**; the state-sequence
hashes matched in all 14 cases (`report.json.determinism`). Representative hashes:

```text
baseline              sha256:f3d6ffa4729d1a62ef56607c15f348df96318db6e3bf4f1a14db4d17601f4e1d
torque-2.0            sha256:a07bba1c43b69411c7cebc38da76f2ae7cff13f93f594c0aef4ed1060aa0d6e4
force-target-50       sha256:18adfba8ac2321c6e29922b3e7fbf580f52f546ebc9874769911d7f8cbaea9c7
postvel-27-once       sha256:9d52b04d3b28a3dc063e063fb1fa013f483c1d6f2b949445fd17594a6c53dbb0
postpose-0.5x30       sha256:02ed92f22eaf2b3f525cd36e56e5585db2321a8a3567b150b00505d5ee15bc6c
shock-brake-45mph-78  sha256:4992e5201a81902a5c9477143a48146e38fadf0134446345e58bb0e3228432d4
shunt-impulse-20k     sha256:0220b4b73e2f9bfdf2b5049e162d9984a3da06f0a225dd0cc0f47fd257779f5b
```

The shipped-module control hash matches the probe baseline exactly (§1). All 14
full hashes are in `_work/boost-feasibility/report.json`.

### 5.3 Candidate C: the torque multiplier saturates

`peakTorqueScale=2` raises the 1.3 s gain from +7.93 to +9.69 m/s; `5.0` adds only
another 0.08 m/s (34.836 → 34.915). The reason is visible in the source: after
`t *= peakTorqueScale` (`carengine.cpp:104`), `GetTorque` clamps

```text
tmax = Mass * MaxAcceleration_Step * 4 * (|v - groundVelocity| + 4) / (|av| + 1)
t = Min(t, tmax + (t - tmax) * AddSmooth(brake, handbrake))
```

(`carengine.cpp:106-109`). The multiplier cannot raise the vehicle's top speed,
only the rate at which it approaches the existing limit. It is also inside the
engine, so it is deterministic and collision-safe, but it adds only +9.7 m/s
versus the +22.9–+28.0 m/s measured force path: it is about 2.5–3× too weak for
Nitro and cannot reach the 44.85–52.76 m/s sprint-speed targets.

### 5.4 Candidate B: post-tick velocity and pose

**Velocity.** `C_RigidBody::StoreLinearVelocity` after `Simulate` changes the
gravity body immediately. The articulated `Car` state (`e1_get_state`) is copied
from Gravity at the next step, so the published state is **one tick behind the
physics**:

| tick | `e1_get_state().speed` | `b_extra().forwardSpeed` (gravity) | wheelEq | wheel delta |
| ---: | ---: | ---: | ---: | ---: |
| 180 pre | 25.148 | 25.146 | 25.86 | +2.8 % |
| 181 write | 25.273 | **52.269** | 25.64 | +1.5 % |
| 182 | **51.888** | 51.885 | **36.04** | **−30.5 %** |
| 183 | 51.356 | 51.352 | 44.12 | −14.1 % |
| 185 | 50.944 | 50.940 | 50.36 | −1.1 % |

At tick 181 the host would publish 25.273 m/s while its gravity body is already at
52.269 m/s (measured, not derived). A client that receives that snapshot sees a
one-tick delayed jump. The wheels then need 3–4 ticks to catch up. This is
deterministic on one build, but it is **not** the engine's own state, and it is
exactly the "silent write outside the physics" the rules forbid. Rejected.

**Pose.** `C_Body::Position` queues `E_OverridePosition` for the next `Simulate`.
A 0.5 m/tick request for 30 ticks (15 m requested) produced **+1.90 m** net
displacement; at 1.3 s the speed was 33.042 vs 33.076 baseline, i.e. no boost.
The engine's wheel/spring constraints absorb most of the write, and the write can
still place the body inside geometry for a tick without an impulse. Rejected.

### 5.5 Candidate D: the engine force path (recommended)

`Gravity::C_Body::AddForce` before `Simulate`, with the retail shape:

```text
forward = body axis Z with Y zeroed
if forwardSpeed < target:
    adjust = 2 if forwardSpeed < target/2 else 1
    body.AddForce(forward * (300.0f * mass * adjust))
```

The 300.0 m/s² constant is the shipped `g_Perks_FakePhysics_SpeedAccelerateForce`
(`FakePhysics.cpp:191`); the target is the exact curve target from §4.1/4.2 or a
documented representative value inside it; the 0.5 s budget is the retail
`_value` that is decremented **only while the car is below target**
(`FakePhysics.cpp:748-751`), not 0.5 s of wall time; the 1.3 s effect is the
recovered `Duration`.

Measured (target 50 m/s, 30-tick force window):

| tick | speed | RPM | gear | contacts | force |
| ---: | ---: | ---: | ---: | --- | ---: |
| 180 pre | 25.148 | 7268 | 1 | 1111 | 0 |
| 181 | 29.976 | 7072 | 1 | 1111 | 480,000 N |
| 182 | 34.653 | 6894 | 2 | 1111 | 480,000 N |
| 209 | 53.216 | 6610 | 4 | 1111 | 0 |
| 210 | 53.196 | 6469 | 4 | 1111 | 0 |
| 258 (1.3 s) | 48.022 | 6759 | 4 | **0010** (road edge) | 0 |

Wheel consistency at full contact: tick 182 −2.9 %, tick 209 −1.0 %, tick 210
−0.9 %. The force is integrated by the solver, the tyres react, and the gearbox
shifts naturally. 0 NaN; 4-wheel contact until the road edge. This is the only
candidate that is both meaningful and engine-consistent.

### 5.6 Shock brake and Shunt impulse

**Shock** (`E_FAKE_SPEED_BRAKE` shape): the force is opposite the velocity and
scaled by `rate * mass * adjust / speed` (`FakePhysics.cpp:764`), with
`rate = 300` (`:195`). At target 20.1 m/s (45 mph) it removed 9.68 m/s in 0.5 s,
0 NaN, four contacts, deterministic. The discrete force over-brakes by ~5 m/s in
one tick when the target is crossed; a target-rate cap or a smaller force is the
obvious refinement. It is a **speed scrub**, not a linear impulse.

**Shunt** (`AddImpulse` before `Simulate`): 20 kN·s forward on 1600 kg = 12.5 m/s,
measured +12.11 m/s; 10 kN·s along body X = 6.25 m/s, measured total speed
25.88 m/s with 25.20 m/s still forward and 0 NaN. The wheels catch up within 4
ticks. This is a usable engine primitive, but
retail Shunt is a projectile hit that starts `E_FAKE_PHYSICS_FLIP_FORWARD`/
`TIP_FORWARD` and damage (`VLC_Pickups.cpp:1698/1702`), not a linear impulse.
Using an impulse is therefore a **provisional design**, not a recovered value.

---

## 6. Determinism, authority and collision

### 6.1 Determinism

- Same build, same inputs, same boost parameters → identical state hash in two
  fresh module instances (14/14). The build itself is deterministic (two links,
  same wasm SHA-256).
- The probe baseline is bit-identical to the shipped module (control hash), so
  the measurement path is not a different physics build.
- This is **within one build on one machine**. Cross-machine bitwise equality is
  not claimed; the existing project determinism gate is the same-build repeat-hash
  gate.
- Determinism alone does **not** validate a candidate: post-tick velocity and pose
  are also deterministic. The rejection reason is engine-state consistency, not
  the hash.

### 6.2 Multiplayer authority

- The host owns the pickup inventory, cooldown, target selection and event
  sequence. It emits a sequenced `nitro-activated` / `shock-activated` /
  `shunt-hit` with `{seq, targetPlayer, startTick, ticks, targetMps, magnitude}`.
- **Host car:** the host applies the force in `e1_step` before `Simulate`; its
  published state is the engine's state. Clients render from snapshots/events.
- **Guest car:** the current M1 host does not simulate the guest body (`probes/e1-drive/README.md`,
  "the host's own car is the only host-simulated physics body"); the guest
  simulates its own car and the host validates the race result. The guest must
  therefore apply the host-sequenced force to its **own** car at the same
  `startTick`. The host remains authoritative because it originates and sequences
  the event and can reject/flag a missing application; this is the existing
  M1 "host-validated, peer-state" model, not full server-side physics.
- **Tick anchoring.** The two pages need not share an absolute tick index. The
  reliable event should carry a relative `delayTicks` (2–4 ticks, host-chosen) and
  each receiver applies at `currentTick + delayTicks`; the host sequence number is
  the authority, not an absolute host tick. The host car can use the same relative
  rule. This keeps the event deterministic without assuming clock alignment.
- **Literal "host applies to every car"** requires the host to simulate every car
  (a larger M2/M3 architecture change), because the wasm module has exactly one
  car (`gWorld.car`). Do not claim that as available today.
- Post-tick writes are worse for authority: the host's snapshot at the write tick
  is one tick behind its physics (§5.4), so host and client disagree for that
  tick. This is a concrete reason to reject them independently of physics.

### 6.3 Collision

- `AddForce`/`AddImpulse` before `Simulate`: the solver sees the new force/velocity
  in the same step; contacts, wheel rays and friction respond normally. The
  measured force run had four-wheel contact and 0 NaN until the road edge.
- `StoreLinearVelocity` after `Simulate`: the next step starts from a velocity the
  solver did not produce; the body force/tyre model did not see it. The one-shot
  test shows a 30.5 % wheel-speed mismatch; no contact loss was measured on this
  straight, but the state is not physically coherent.
- `C_Body::Position` after `Simulate`: the deferred override is applied at the
  next `Simulate`; the constraints absorb most of it. It can place the body inside
  geometry for a tick without an impulse.
- **Tunnel bound.** The box proxy is `wheelBase 2.652 m` long and 1.656 m wide
  (`e1_drive_lib.cpp:870-872`). At 60 Hz a full body length per tick is
  `2.652 × 60 = 159.1 m/s` (356 mph); a half length is 79.6 m/s (178 mph). The
  engine's own cap is 250 mph = 111.8 m/s (`e1_drive_lib.cpp:888`). A Nitro target
  of 44.85–52.76 m/s moves 0.75–0.88 m/tick, well below the body length; the
  measured force run reached 54.2 m/s (0.90 m/tick). A target at the high end of
  the recovered graph (145 mph) is 64.9 m/s (1.08 m/tick), still below the body
  length but closer. Recommend a **55 m/s cap for M2a** until a wall test exists.
- The fixture straight ends at a road edge, not a wall, so this run does **not**
  measure wall penetration. A dedicated wall test is an acceptance item, not a
  claimed result.

---

## 7. Recommended path

### 7.1 M2a — Nitro

Implement the force in `probes/e1-drive/native/e1_drive_lib.cpp` (the one own TU
of the e1 module), not in `RacingPhysics`. No engine source change is needed
because `C_Body::AddForce`, `C_Body::AddImpulse` and `C_RigidBody::AddForce` are
already public and linked.

Minimal API (host-only, sequenced; names can change):

```c
/* queue one engine-integrated effect for a future tick */
int e1_boost_queue(int kind,            /* 1=NITRO_FORCE, 2=BRAKE, 3=IMPULSE */
                   int startTick,       /* receiver tick: currentTick + delay    */
                   int ticks,           /* duration in 60 Hz ticks              */
                   float targetMps,     /* NITRO/BRAKE target speed             */
                   float magnitude,     /* m/s^2 for 1/2; N*s for 3             */
                   float dx, float dy, float dz); /* world direction for 3    */

/* read-back for HUD/verifier */
const char* e1_boost_state(void);       /* {seq, kind, startTick, remaining, applied} */
```

Rules:

- `startTick >= gWorld.tick`; `ticks > 0`; all values finite; otherwise return 0
  and set `e1_last_error`. `e1_reset()` clears the queue. The event carries a
  relative `delayTicks`; the receiver converts it to its own
  `currentTick + delayTicks` (see §6.2).
- In `e1_step`, **before** `gWorld.scene->Simulate(...)`:
  - `NITRO_FORCE`: `body->GetBody().AddForce(forward * (300.0f * mass * adjust))`
    while `forwardSpeed < targetMps`; `forward = GetAxis().Matrix3().AZ()` with
    `Y` zeroed; `adjust = 2` below half target, else 1.
  - `BRAKE`: `body->GetBody().AddForce(velocity * -(rate * mass * adjust / speed))`
    while `speed > targetMps`.
  - `IMPULSE`: on exactly `startTick`, `body->GetBody().AddImpulse(dir * magnitude)`.
- Source constants: `300.0f` accelerate/brake (`FakePhysics.cpp:191`, `:195`);
  the 0.5 s accelerating-tick budget (`_value`, `FakePhysics.cpp:711`, decremented
  only while below target at `:748-751`); 1.3 s Nitro duration (PWR1 `Duration`).
- The target used by M2a is the **exact** curve value from §4.1/4.2 for the car's
  recorded class, not a guessed curve sample. The e1 roster does not record the
  class modifier, so the event payload must carry the class it used and fail
  explicitly if the class is unknown. Label the target source
  `targetSource:'pwr1-hermite'`.
- Cap the target at **55 m/s** for M2a (a project safety cap measured against the
  body-length bound; §6.3, not a retail value). Revisit after a wall test.
- Optional slowdown at expiry: same `BRAKE` path using
  `graph(speed_mph/200 − SlowDownGraphValue × classModifier)` from
  `PickupNitrous.cpp:158`; the curve and `SlowDownGraphValue = 0.5275` are
  recovered, so no guessed decay is needed. If the project chooses not to model
  the retail slowdown in M2a, label the omission in the event payload.

Do **not** use: throttle-only (too weak), `peakTorqueScale` (saturates), a
post-tick `StoreLinearVelocity` (state lag), or a post-tick `Position` (absorbed,
no boost).

### 7.2 M2b — Shock

Use the same `BRAKE` command with the exact Shock target and the
`g_debugShockManagerMinSpeedScrub = 10 mph` floor (`ShockManager.cpp:52`). Apply
the existing `DamageInflicted = 100` through the power-up health model, and the
`InnerRadius 7 / OuterRadius 14 / Lifetime 1.5` hit test from PWR1. This is a
speed scrub and a health event, not an impulse.

### 7.3 M2b — Shunt

Retail Shunt is a projectile + `E_FAKE_PHYSICS_FLIP_FORWARD`/`TIP_FORWARD` +
damage (`VLC_Pickups.cpp:1698/1702`). Two honest options:

1. **Impulse design (recommended for the first M2b slice):** use
   `e1_boost_queue(IMPULSE, hitTick+1, 1, 0, J, dirX, dirY, dirZ)` with a
   **provisional** `J` (the measured 20 kN·s forward gives +12.1 m/s; a lateral
   10 kN·s gives 6.25 m/s). Label the event `source:'provisional-impulse'`; do not
   claim the retail magnitude.
2. **Retail-faithful slice:** port the `FakePhys_SetupEffect`/`UpdateEffect`
   impulse/torque shape and the recovered constants. That is an engine/actor port,
   not a one-file e1 change; it needs the constants and the exact hit timing.

Shock already does the "host-authoritative effect" pattern; a Shunt impulse should
use the same `startTick` anchoring and target-owner application.

### 7.4 Candidate verdicts and the minimal code touch

| candidate | verdict | authority | minimal code |
| --- | --- | --- | --- |
| input-only (throttle 1.0) | reject for Nitro: +7.93 m/s, below the target | host/owner input; no new event | none |
| `peakTorqueScale` 2–5 | reject: saturates at +9.7 m/s | host-only; engine-integrated | would be `car->PerformanceModifiers().peakTorqueScale` before `Simulate`; no engine change |
| post-tick velocity | reject: state lags one tick, wheel spin −30.5 % | host-only but host snapshot disagrees with its physics | would be `body->GetBody().StoreLinearVelocity` **after** `Simulate`; not recommended |
| post-tick pose | reject: +1.90 m net after 15 m requested, no speed gain | host-only teleport; no solver | would be `body->Position` after `Simulate`; not recommended |
| engine force (`AddForce`) | **accept for Nitro** | host for host car; target owner applies the host event for a guest car | `e1_boost_queue(NITRO_FORCE, …)` + `body->GetBody().AddForce` **before** `Simulate` in `e1_step` |
| engine brake (`AddForce` opposite) | **accept for Shock** | same | `e1_boost_queue(BRAKE, …)`; same hook |
| engine impulse (`AddImpulse`) | **accept provisionally for Shunt** | same | `e1_boost_queue(IMPULSE, …)` + `body->GetBody().AddImpulse` before `Simulate` |

No engine source change is required for the three accepted rows; only the e1
harness TU and its export list change. The full file list is §7.5 (below).

### 7.5 Code change list (for the main agent; none written here)

| file | change | owner |
| --- | --- | --- |
| `probes/e1-drive/native/e1_drive_lib.cpp` | add `e1_boost_queue`/`e1_boost_state`; apply in `e1_step` before `Simulate` via `C_Body::AddForce`/`AddImpulse`; clear in `e1_reset`; add the new exports to the build script's `EXPORTS` | main agent (shared file) |
| `probes/e1-drive/tools/build_module.mjs` | add `_e1_boost_queue`, `_e1_boost_state` to `EXPORTS` | main agent |
| `probes/e1-drive/web/powerups.js` or `mp-client.js` | host event `{seq,target,startTick,ticks,targetMps,magnitude,kind}`; client applies to its own car; HUD timer | M2 owner |
| `probes/race-rules` / `probes/net-mvp` | carry the event on the reliable channel; no physics | M2 owner |
| `docs/work/analysis/boost-feasibility.md` | this feasibility record | BOOST1 |

No change to `RacingPhysics`, `Gravity`, `probes/powerups`, `probes/race-rules`,
`probes/net-mvp`, `tools/`, `upstream/` or `game-data/`.

---

## 8. Acceptance tests

### 8.1 Determinism (all effects)

1. Run the same 600-tick input + event sequence in two fresh modules; require the
   same state-sequence SHA-256 and the same `e1_boost_state()` sequence.
2. Run the baseline with no event and with the event cancelled; require the
   baseline hash `f3d6ffa4…f4e1d` (fixture run) or the sprint's committed hash.
3. Replay a recorded event log; require the same hash at every tick.

### 8.2 Nitro (M2a)

1. From the measured 310 m sprint pre-speed (24.73 m/s), a Nitro at the exact
   class target must reach **≥ 44.85 m/s** (class D) / **≥ 52.76 m/s** (class A)
   by the end of the 1.3 s duration and be **≥ +10 m/s** over the no-Nitro
   baseline. The measured force target 50 reached 48.02 m/s / +22.9 m/s.
2. Distance over the 1.3 s window must be **≥ baseline + 20 m**. Measured +29.08 m.
3. The effect must expire at **1.3 s ± 1 tick**; `e1_boost_state().remaining = 0`;
   no NaN; `finite=1` on every tick.
4. Engine consistency: while all four wheels are on the ground, require
   `|wheelEq − speed| / speed ≤ 5 %` after the first 3 ticks. The force path
   measured −2.9 % to −1.0 %; the post-tick one-shot measured −30.5 %.
5. Collision: 4-wheel contact on the measured straight until the road edge;
   no new airborne tick before the baseline edge; a dedicated wall test at the
   capped target must show no penetration (add the wall fixture; the current
   straight has no wall).
6. Host authority: two clients, same `seq`/`startTick`; guest never applies twice;
   host's published state matches the single-client reference; HUD timer matches.

### 8.3 Shock (M2b)

1. Radius: inside `InnerRadius` major, inside `OuterRadius` minor, outside no hit
   (`PickupShock.cpp:250-275`; PWR1 values 7/14/1.5 s).
2. Speed scrub: target from the exact Shock graph and the 10 mph floor; at 55 mph
   the target is ≤ 45.3 mph. Measured 20.1 m/s target removed 9.68 m/s in 0.5 s.
3. Damage 100 through the health model; 0 NaN; deterministic.
4. Wheel slip during braking is allowed; the test is contact/finite, not the
   acceleration wheel-consistency rule.

### 8.4 Shunt (M2b, provisional impulse)

1. One-shot impulse before `Simulate`; `Δv = |J| / mass` within 1 % (20 kN·s /
   1600 kg = 12.5 m/s; measured 12.11 m/s).
2. Lateral impulse applies the expected Δv (10 kN·s → 6.25 m/s along body X;
   measured total speed 25.88 m/s with 25.20 m/s forward) and no NaN; 4-wheel
   contact.
3. Wheel speed converges within 4 ticks (measured −12.7 % → −0.7 %).
4. Label `source:'provisional-impulse'`; do not claim retail Shunt magnitude or
   the retail flip/tip animation.

### 8.5 Regression

- `python tools/verify_asset_probe.py --skip-build` (27-step suite) with no new
  failure.
- `ctest --test-dir _work/build/asset-reader-native -C Release --output-on-failure`.
- The e1 shipped module's baseline hash remains `f3d6ffa4…f4e1d` on the fixture and
  the committed sprint state hashes remain unchanged. The probe is not in the
  shipped build, so this is a control, not a new gate.
- Native `/W4` is not affected (no native source changed).

---

## 9. Commands, evidence and limits

### 9.1 Commands run

```powershell
node probes/boost-feasibility/tools/build_probe.mjs
node probes/boost-feasibility/tools/recon.mjs
node probes/boost-feasibility/tools/ray_search.mjs
node probes/boost-feasibility/tools/run_probe.mjs
node probes/boost-feasibility/tools/control_baseline.mjs
```

All commands use the repo's Node (`_work/toolchains/emsdk/node/24.19.0_64bit/node.exe`
via `node` on PATH). The probe build uses the bundled Python emscripten
`em++.py` and the 185 reused T-005d objects, exactly like
`probes/e1-drive/tools/build_module.mjs`.

### 9.2 Evidence

| path | content |
| --- | --- |
| `probes/boost-feasibility/native/boost_probe_lib.cpp` | the probe TU; includes the shipped e1 source and adds only the step seam |
| `probes/boost-feasibility/tools/build_probe.mjs` | build (186 objects, two links) |
| `probes/boost-feasibility/tools/run_probe.mjs` | 14 candidate runs, two modules each, report writer |
| `probes/boost-feasibility/tools/control_baseline.mjs` | shipped-vs-probe baseline control |
| `probes/boost-feasibility/tools/recon.mjs`, `ray_search.mjs` | fixture speed/edge and wall reconnaissance |
| `_work/boost-feasibility/module/build.json` | wasm 1,009,166 B, SHA-256 `3f03ed86…5da9d9e0`, deterministic |
| `_work/boost-feasibility/report.json` | compact table, hashes, exact nitro/Shock targets, limits |
| `_work/boost-feasibility/experiments.json` | every per-tick state and extra record |
| `_work/boost-feasibility/control.json` | shipped/probe baseline match |
| `_work/logs/boost-feasibility/run.log` | text log of the 14 runs |

Key hashes:

```text
probe wasm           3f03ed862503b66009d677e473b0d2a151602ceee3f8272c91912a7e5da9d9e0
control baseline     sha256:f3d6ffa4729d1a62ef56607c15f348df96318db6e3bf4f1a14db4d17601f4e1d
force target 50      sha256:18adfba8ac2321c6e29922b3e7fbf580f52f546ebc9874769911d7f8cbaea9c7
post-tick one-shot   sha256:9d52b04d3b28a3dc063e063fb1fa013f483c1d6f2b949445fd17594a6c53dbb0
```

### 9.3 Limits

- **One car, one fixture, one build.** Corvette ZR1 on the T-005d `ray-random-21`
  straight; no second car, no course run, no multi-car physics.
- **No wall test.** The fixture ends at a road edge; wall penetration is not
  measured. The tunnel bound in §6.3 is arithmetic, not a collision result.
- **No car class.** The exact `RLBalancingGraph` Hermite evaluator is recovered
  (§4), but the e1 roster does not record the car's `AmaxVehicle::carClass`;
  §4 reports the exact target for every class instead of guessing one.
- **No retail Shunt impulse.** Retail Shunt is a fake-physics flip/tip + damage;
  the 20 kN·s impulse is a provisional design value, not recovered.
- **No two-browser run.** Authority is a design analysis against the existing M1
  model; the two-client acceptance test is specified, not executed here.
- **No source change.** This document is data and feasibility only. It does not
  claim a playable power-up, a HUD, an audio event, a full-game behaviour or
  retail parity.
- **Working tree.** Other agents already had modified `probes/car-materials/`,
  `probes/e1-drive/` tools and ghost files before this task; BOOST1 did not touch
  them. Only `probes/boost-feasibility/`, `_work/boost-feasibility/`,
  `_work/logs/boost-feasibility/` and this document were created.
