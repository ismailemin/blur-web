# Camera parity — retail camera recovery and PoC comparison

**Date:** 8 November 2026
**Owner:** CAM1 (sub-agent)
**Scope:** new `probes/camera/`, `_work/camera/`, `_work/logs/camera/` and this
document only. Read-only inputs: `game-data/`, `upstream/BlurRebuilt/`,
`probes/e1-drive/`, `probes/render-packet/`, `_work/vehicle-pipeline/`,
`_work/e1-drive/`. No game data, upstream file, `probes/e1-drive` file, tool or
engine source was modified. No browser capture was run.

**Result:** the shipped camera data was recovered from
`\gamedata\xt\amax.bin` (decoded **1,078,940 B**, SHA-256
`a833487bd66552ecf61b1f13790ee228b18ca8f4d76c524dcd94e44c63d1e3c7`, PAK entry
offset **21,028,864**, stored **308,744 B**, FAT index **81**). The **normal
retail chase is the Hollywood camera**, not `AmaxChaseParam`; the latter is the
legacy/future feed. The five E1 roster cars have per-car Hollywood profiles
(FOV 65°, distance 4.45–5.80 m, eye 1.33–1.71 m, look-down 2.66–5.00°,
look-ahead 1.0 m). The legacy profile is 4.65 m / 1.4 m / 65° / tilt −8° /
behindSpring 3.0 s⁻¹ for all five. The PoC is 9.0 m / 3.4 m absolute / 45° /
0.18 per-tick / no look-ahead, so it is not the retail camera. The machine
manifest is `_work/camera/camera.json`; the verifier is
**8,760 checks, 0 failures**.

---

## 0. Summary

| item | value |
| --- | --- |
| source entry | `\gamedata\xt\amax.bin` in `game-data/Blur/cache/gamedata.pak` |
| source physical | offset 21,028,864; stored 308,744 B; logical 1,078,940 B; FAT 81; path CRC32 `8b97d338` |
| decoded SHA-256 | `a833487bd66552ecf61b1f13790ee228b18ca8f4d76c524dcd94e44c63d1e3c7` |
| decoded tables | 209 types, 4,518 records |
| normal chase | `C_HollywoodVehicleCamera` + per-car `HollywoodVehicleParams` |
| legacy chase | `C_AmaxChaseCamera` + per-car `AmaxChaseParam` (future feed only) |
| manifest | `_work/camera/camera.json`, 446,755 B, SHA-256 `d201dbc0eefb52cc6335a39a1196495ee3c1e8d366ca8a7128a0d2fc1c3d360d` |
| manifest canonical hash | `sha256:c5b41745b9897a4387eb0987942ff958de3019b67fb25cee724a05b3518f4ade` |
| verifier | **8,760 checks, 0 failures** (`_work/camera/verify.json`) |
| parameters | 511 = **309 data + 82 code + 120 provisional** |
| per-car normal profiles | 4 distinct distances among the five cars |
| legacy single profile | **true** (five identical values, five distinct records) |

The two camera systems are easy to confuse because the legacy record is named
`AmaxChaseParam` and directly carries `Distance`, `Height`, `Fov` and `Tilt`.
The source is unambiguous: `C_VehicleFeed::Init` creates
`C_HollywoodVehicleCamera` when `m_Future` is false and `C_AmaxChaseCamera` only
when `m_Future` is true (`VehicleFeed.cpp:75-94`). The normal game camera is the
Hollywood one. The legacy record is still useful because it is the only complete
**orbit** parameter set and the PoC is an orbit camera, so it is the closest
like-for-like comparison.

---

## 1. Source chain and provenance

### 1.1 Data path

```
game-data/Blur/cache/gamedata.pak
  \gamedata\xt\amax.bin                             (decoded 1,078,940 B)
    AmaxVehicle (81 records)
      .CameraParam -> inline AmaxVehicleFeedParam
        .Chase   -> AmaxChaseParam                  (legacy/future chase)
        .Dash    -> AmaxDashParam                   (data only)
        .Bonnet  -> AmaxBoltedParam                 (data only; fed to Bumper)
        .Bumper  -> AmaxBoltedParam                 (data only)
      .hollywoodVehicleParams  -> HollywoodVehicleParams (normal chase, debugIndex 0)
      .hollywoodVehicleParams2 -> HollywoodVehicleParams (debugIndex 1)
    AmaxVehicleDefaults.defaultCamera                  (fallback, not used by the roster)
    AmaxAccelEffect                                   (legacy acceleration offset)
    AmaxViewportFovScale                              (split-screen FOV scale)
    RightStickCameraParams                            (look-around)
    DyCamShakeDef (4 records)                         (dynamic-camera shake)
```

The roster match is not name similarity. Each of the five E1 roster cars was
matched by its exact `AmaxVehicle` tag **and** by the `dynamics` FlaskHandle id,
which equals the committed `RP_CarDynamics` record id in
`_work/e1-drive/cars.json`:

| car | `AmaxVehicle` record | id | dynamics ref id | RP record id |
| --- | ---: | ---: | ---: | ---: |
| Corvette ZR1 | 317 | 307030087 | 1554942492 | 1554942492 |
| Lotus Exige Cup260 | 3762 | 3585127731 | 805568925 | 805568925 |
| Dodge Challenger | 216 | 198712773 | 528964602 | 528964602 |
| Ford Focus RS | 344 | 331339493 | 2563977008 | 2563977008 |
| Audi R8 V10 | 2426 | 2303754943 | 2936683857 | 2936683857 |

The field values are decoded with the committed
`probes/powerups/tools/xt_decode.py` (SHA-256 recorded in the manifest). The
decoder is read-only; it validates every table/field/record extent and rejects a
mismatch rather than returning a partial object.

### 1.2 Normal vs legacy selection

| source line | what it proves |
| --- | --- |
| `VehicleFeed.cpp:75-94` | `m_Future=false` → `C_HollywoodVehicleCamera`; `m_Future=true` → `C_AmaxChaseCamera` |
| `VehicleFeed.cpp:96-115` | the Bumper feed is always the second slot |
| `VehicleFeed.cpp:359-371` | `m_Chase->SetAmaxParam(...CameraParam.Chase)`; it never feeds the Hollywood camera from `AmaxChaseParam` |
| `VehicleActor.cpp:8953-8963` | `GetCameraParam()` returns per-car `CameraParam`, else `AmaxVehicleDefaults.defaultCamera` |
| `VehicleActor.cpp:9727-9741` | `GetHollywoodCameraParams(0)` returns `hollywoodVehicleParams`, else the default; index 1 returns `hollywoodVehicleParams2` |
| `VFCamera.h:7-12` | the only game feeds are `E_VFCamera_Hollywood` and `E_VFCamera_Bumper` |

All five roster cars have their own non-null `CameraParam` and
`hollywoodVehicleParams`; the defaults and the `hollywoodVehicleParams2` debug
variant were **not used**. The manifest records `usedFallback:false` for all ten
checks (five normal, five legacy).

---

## 2. Retail camera modes

| mode | source | active in this build | what it is |
| --- | --- | --- | --- |
| **normal chase** | `C_HollywoodVehicleCamera` + `HollywoodVehicleParams` | **yes** | spring/velocity chase with per-car FOV, distance, pitch, look-ahead, roll and speed-dependent look side |
| **legacy/future chase** | `C_AmaxChaseCamera` + `AmaxChaseParam` | only `m_Future=true` | orbit behind the car with `BehindSpring`, `AngularLimit/Fade`, `PivotZ`, `SafeHeight`, ray-traced pull-in |
| **bumper** | `C_BoltedCamera`; `C_VehicleFeed::UpdateParam` feeds it `CameraParam.Bonnet` | **yes** | rigid bolt-on view; source comment says the bumper/bonnet settings are switched (`VehicleFeed.cpp:373-376`) |
| **hood/bonnet** | `CameraParam.Bonnet` | data only | `C_VehicleFeed::Init` does not create a separate hood feed |
| **dash** | `CameraParam.Dash` | data only | serialized per car; no consumer in `C_VehicleFeed` |
| **orbit** | `C_OrbitCamera` code defaults | debug only | `E_DebugCam_OrbitCamera`; radius 4.0 m, FOV 60°, 40 s period |
| **replay/cinematic** | `root.pak\animations\cameras\*.cycle` and `AnimatedCameraSequence` | not a chase | 171 `.cycle` camera packs and 156 `AnimatedCameraSequence` records in `amax.bin`; not decoded here |
| **far** | — | **does not exist** | `E_VFCamera` has only Hollywood and Bumper; no far profile is serialized or instantiated |

The manifest names the two unsupported cases explicitly (`farChase`,
`replayCinematic`) instead of silently reusing a chase parameter.

---

## 3. Recovered parameters

All values below are **data** unless marked **code** or **provisional**. The
manifest carries the exact float, unit, record index/id, field path and decoded
file offset for every parameter.

### 3.1 Normal chase — per-car `HollywoodVehicleParams`

`record` is the `HollywoodVehicleParams` record index; all five have a distinct
record. `eye` and `look-down` are provisional orbit mappings; the raw data
fields are `IdealBase.vy`, `IdealPitch`, `IdealDistanceNormal` and `LookAtPos`.

| car | record | FOV ° | distance m | base y m | pitch ° | eye above car m | horizontal m | height above aim m | look-down ° | look-ahead m | dist smooth s | yaw smooth s | pitch smooth s | look-at smooth s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Corvette ZR1 | 2267 | 65 | 5.00 | 1.35 | 2.0 | 1.524 | 4.997 | 0.524 | 4.998 | 1.0 | 0.375 | 0.90 | 0.25 | 0.45 |
| Lotus Exige Cup260 | 2337 | 65 | 4.45 | 1.10 | 3.0 | 1.333 | 4.444 | 0.333 | 3.499 | 1.0 | 0.375 | 0.90 | 0.25 | 0.45 |
| Dodge Challenger | 2279 | 65 | 5.80 | 1.55 | 1.0 | 1.651 | 5.799 | 0.401 | 3.377 | 1.0 | 0.600 | 0.90 | 0.25 | 0.45 |
| Ford Focus RS | 3796 | 65 | 5.30 | 1.55 | 1.7 | 1.707 | 5.298 | 0.407 | 3.700 | 1.0 | 0.700 | 0.90 | 0.25 | 0.45 |
| Audi R8 V10 | 3592 | 65 | 5.30 | 1.30 | 1.0 | 1.392 | 5.299 | 0.292 | 2.659 | 1.0 | 0.375 | 0.90 | 0.25 | 0.45 |

Additional normal-chase data:

| parameter | Corvette value | unit | note |
| --- | ---: | --- | --- |
| `IdealDistanceAtFullAcceleration` | 5.1 | m | acceleration > +0.1 m/s² (`HollywoodVehicleCamera.cpp:94,1488-1492`) |
| `IdealDistanceAtFullDeceleration` | 4.8 | m | acceleration < −0.1 m/s² (`:95,1494-1498`) |
| `IdealDistanceAirbourne` | 4.8 | m | after 0.3 s airborne (`:96,1482-1484`) |
| `IdealDistanceSmoothingAccelerating` | 0.60 | s | `:1557` |
| `IdealDistanceSmoothingDecelerating` | 0.55 | s | `:1559` |
| `IdealDistanceSmoothingAirbourne` | 1.0 | s | `:1551` |
| `IdealPitchAirbourneUp/Down` | 0 / 0 | ° | `CalculateDesiredPitch`, `:1238-1271` |
| `MaxAcceleration` / `MaxDeceleration` | +7 / −5 | m/s² | `:90-91` |
| `LookSideMax` | 1.8 | m | lateral look-at offset, depends on yaw/slip/contact |
| `LookSideUpDownMultiplier` | −0.7 | ratio | coupling with speed (see §3.5) |
| `ForwardsVelocityUpDownMultiplier` | 0.5 | ratio | speed factor; at 30 m/s straight `lookSide=0`, so the product is 0 |
| `LookAtSmoothingValue` | 0.45 | s | `:913-920` |
| `HighSpeedFovMultiplier` | 1.3 | ratio | **data only**; `m_highSpeed` is never set true (`:153,1477,1545,1577`) |

The normal camera's collision trace uses `RayTrace(safePositionWS,
desiredPositionWS, 0.35f)` (`HollywoodVehicleCamera.cpp:1157`) from a safe point
at the top of the car's collision body (`:1129-1133`), clamps the desired offset
by `trace`, and has no fixed near-field hold (`:1161-1168`). The maximum distance
is initialised to `IdealDistanceNormal * 2` (`:226`).

### 3.2 Legacy/future chase — per-car `AmaxChaseParam`

All five roster cars have **byte-identical values**; only the record id differs:

| car | record | distance m | height m | FOV ° | tilt ° | behindSpring s⁻¹ | angularLimit ° | angularFade ° | pivotZ m | safeHeight m |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Corvette ZR1 | 2476 | 4.65 | 1.40 | 65 | −8.0 | 3.0 | 120 | 40 | 0.0 | 0.70 |
| Lotus Exige Cup260 | 1383 | 4.65 | 1.40 | 65 | −8.0 | 3.0 | 120 | 40 | 0.0 | 0.70 |
| Dodge Challenger | 2032 | 4.65 | 1.40 | 65 | −8.0 | 3.0 | 120 | 40 | 0.0 | 0.70 |
| Ford Focus RS | 3332 | 4.65 | 1.40 | 65 | −8.0 | 3.0 | 120 | 40 | 0.0 | 0.70 |
| Audi R8 V10 | 1745 | 4.65 | 1.40 | 65 | −8.0 | 3.0 | 120 | 40 | 0.0 | 0.70 |

The legacy code default (`C_AmaxChaseParam`) is **different** and must not be
used instead of the data: 4.65 / 1.4 / **55°** / −8 / **5.5 s⁻¹** / **180°** /
40 / 0 / 0.7 (`AmaxChaseCamera.cpp:185-196`). The data overrides FOV and spring
values. The base `C_ChaseParam` constructor (5.0 / 1.5 / 60° / −8 / lag 0.1 /
behindSpring 3 / 120 / 40 / 0.7) is only the generic stock default
(`ChaseCamera2.cpp:206-219`).

Legacy geometry and motion:

| parameter | value | unit | note |
| --- | ---: | --- | --- |
| orbit distance | 4.856 | m | provisional `hypot(4.65, 1.4)` |
| orbit elevation | 16.756 | ° | provisional `atan2(1.4, 4.65)` |
| view tilt | −8.0 | ° | data; `ChaseCamera2.cpp:132-133` applies `DegToRad(tilt)*0.5` |
| per-tick spring | 0.05 | ratio | provisional `3.0/60`; only when `driveFade>0` |
| t63 when active | 0.323 | s | provisional first-order equivalent |
| trace margin | 0.2 | m | code `ChaseCamera2.cpp:119,123` |
| safe height | 0.70 | m | data; ray starts at car + safeHeight |
| near-field hold | none | — | code: `trace` clamps directly; no hold |
| FOV cap | 120 | ° | code `AmaxChaseCamera.cpp:165-166` |

`C_ChaseParam.lag` is declared (0.1 s) but **not read** by
`C_ChaseCamera2::OnUpdate`; it is a dead field, not a smoothing constant. The
legacy `BehindSpring` blend is also not a general per-tick alpha: `driveFade` is
0 until the angular speed reaches `AngularLimit` (120°/s), then rises over
`AngularFade` (40°); at standstill or a straight 30 m/s the camera follows the
trail position, not the spring. This is recorded in the manifest as a limit.

The legacy acceleration effect (`AmaxAccelEffect`, record 1008/id 960034656):

| field | value | unit | note |
| --- | ---: | --- | --- |
| `Roughness` | 0.025 | ratio | smoothed acceleration factor |
| `ZMin` / `ZMax` | −1.5 / 0.5 | m | clamp of `softAccel * -ZEffect` |
| `FovEffect` | 0.0 | °/(m/s²) | **zero**, so the legacy acceleration FOV term is identically zero |
| `FovMin` / `FovMax` | 0 / 0 | ° | zero bounds |

### 3.3 Bumper

`C_VehicleFeed::UpdateParam` feeds `CameraParam.Bonnet` to `C_BoltedCamera`
(`VehicleFeed.cpp:373-376`), adds a code height offset of 0.10 m
(`VehicleFeed.cpp:42`), and uses the per-car FOV. `C_BoltedParam`'s default FOV
is 58° (`BoltedCamera.cpp:150`); the camera falls back to 60° only when the
parameter FOV is ≤ 0 (`BoltedCamera.cpp:92`). The data FOV is 70° for all five.

| car | Bonnet x,y,z m | Bonnet FOV ° | Bumper x,y,z m | Bumper FOV ° |
| --- | --- | ---: | --- | ---: |
| Corvette ZR1 | 0, 0.810, 1.450 | 70 | 0, 0.500, 1.450 | 70 |
| Lotus Exige Cup260 | 0, 0.670, 1.000 | 70 | 0, 0.300, 1.000 | 70 |
| Dodge Challenger | 0, 0.850, 1.600 | 70 | 0, 0.500, 1.600 | 70 |
| Ford Focus RS | 0, 0.950, 1.700 | 70 | 0, 0.500, 1.700 | 70 |
| Audi R8 V10 | 0, 0.800, 1.550 | 70 | 0, 0.500, 1.550 | 70 |

### 3.4 Hood and dash (data only)

The hood uses the same Bonnet position/FOV as §3.3. The dash values are:

| car | RangeX m | RangeY m | HeadY m | OffsetZ m | HeadOrient ° | DashFov ° |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Corvette ZR1 | 90 | 0 | 0.050 | 0.25 | 0 | 56 |
| Lotus Exige Cup260 | 90 | 0 | 0.040 | 0.00 | 0 | 56 |
| Dodge Challenger | 90 | 0 | 0.050 | 0.25 | 0 | 56 |
| Ford Focus RS | 90 | 0 | 0.050 | 0.25 | 0 | 56 |
| Audi R8 V10 | 90 | 0 | 0.040 | 0.00 | 0 | 56 |

`C_VehicleFeed::Init` creates only the Hollywood (or legacy Chase) and Bumper
feeds; no separate hood/dash feed is instantiated in this source revision. The
values are still shipped per car and are recorded for future work.

### 3.5 Speed-dependent look-at

The normal Hollywood camera's look-at point is `LookAtPos` plus smoothed
`lookSide` and `lookUpDown` offsets (`:909-925`). `lookUpDown` is the product of
the look-side factor and a forward-speed factor:

```
normalisedVelocity = clamp((v_z - 0.2)/(50 - 0.2), 0, 1)     # m/s
desiredBasedOnVelocity = normalisedVelocity * 0.5
desiredLookUpDown = lookSideFactor * (-0.7) * desiredBasedOnVelocity
```

At 30 m/s straight, `lookSideFactor` is 0, so the up/down term is 0. At speed
with steering/slip, the term is nonzero; it is not modelled in this manifest.
This is the closest thing to a speed-based look-ahead curve; there is **no
speed-based FOV curve active at 30 m/s**.

### 3.6 FOV, near/far, aspect and split-screen

The camera FOV is **vertical**. Horizontal values below are computed at 16:9.

| source | vertical FOV ° | horizontal FOV ° (16:9) | near clip m | far clip m |
| --- | ---: | ---: | ---: | ---: |
| PoC (current) | 45 | 72.734 | 0.156196 (fit, not the near formula) | 230.037 |
| normal chase | 65 | 97.114 | 0.115382 | 4000 |
| legacy chase | 65 | 97.114 | 0.115382 | 4000 |
| bumper / hood | 70 | 102.448 | 0.114283 | 4000 |
| dash | 56 | 86.776 | 0.117854 | 4000 |
| debug orbit | 60 | 91.493 | 0.116664 | 4000 |

The near clip is code-derived: `C_Camera` starts with `m_NearClip = 0` and
`m_FarClip = 4000` (`Camera.cpp:34-36`); when the camera's near clip is 0,
`C_Feed::ToViewSetup` uses `near = 0.1 + 0.01745 / fovRad`
(`Feed.cpp:71-78,157-162`). The PoC's 0.156196 is a fit value from the
committed render-packet, not this formula.

Split-screen FOV scale (`AmaxViewportFovScale`, record 3722/id 3543092841):
two-player 0.7, three-player 1.0, four-player 1.0. `C_CameraSystem::FovScale`
clamps it to [0.1, 1.0] and the Hollywood camera multiplies its final FOV by it
(`CameraSystem.cpp:1054-1074`; `HollywoodVehicleCamera.cpp:894-901`). For 1:1
single-player the effective scale is 1.0.

### 3.7 Code vs data defaults

| default | source | value | why it matters |
| --- | --- | --- | --- |
| `C_AmaxChaseParam` constructor | code `AmaxChaseCamera.cpp:185-196` | 4.65/1.4/55/−8/5.5/180/40/0/0.7 | if the data is ignored, FOV and spring are wrong |
| `C_ChaseParam` constructor | code `ChaseCamera2.cpp:206-219` | 5.0/1.5/60/−8/lag 0.1/3/120/40/0.7 | generic base only |
| `C_Camera` constructor | code `Camera.cpp:34-36` | FOV 60, near 0, far 4000 | near is recalculated |
| `C_BoltedParam` constructor | code `BoltedCamera.cpp:150` | FOV 58 | per-car data is 70 |
| Bumper height offset | code `VehicleFeed.cpp:42` | 0.10 m | added to the Bonnet position |
| Hollywood trace margin | code `HollywoodVehicleCamera.cpp:1157` | 0.35 m | retail normal pull-in |
| Legacy trace margin | code `ChaseCamera2.cpp:119,123` | 0.20 m | retail legacy pull-in |
| max distance | code `HollywoodVehicleCamera.cpp:226` | 2 × `IdealDistanceNormal` | normal chase cap |

### 3.8 File/record/offset examples

All offsets are in the decoded `amax.bin`; the PAK entry starts at **21,028,864**
and decodes to **1,078,940** bytes. The manifest stores `recordDataOffset`,
`fieldOffsetInRecord` and `fileOffset` for every data parameter.

| car | type | record | id | field | offset in record | decoded file offset |
| --- | --- | ---: | ---: | --- | ---: | ---: |
| Corvette | `HollywoodVehicleParams` | 2267 | 2150029673 | `NormalFOV` | 0 | 613,968 |
| Corvette | `HollywoodVehicleParams` | 2267 | 2150029673 | `IdealDistanceNormal` | 4 | 613,972 |
| Corvette | `HollywoodVehicleParams` | 2267 | 2150029673 | `IdealPitch` | 56 | 614,024 |
| Corvette | `HollywoodVehicleParams` | 2267 | 2150029673 | `IdealBase` (`vy` at +4) | 60 | 614,028 |
| Corvette | `HollywoodVehicleParams` | 2267 | 2150029673 | `YawDampingNormal` | 92 | 614,060 |
| Corvette | `HollywoodVehicleParams` | 2267 | 2150029673 | `LookAtPos` (`vz` at +8) | 172 | 614,140 |
| Corvette | `AmaxChaseParam` | 2476 | 2354127912 | `Distance` | 0 | 661,084 |
| Corvette | `AmaxChaseParam` | 2476 | 2354127912 | `Height` | 4 | 661,088 |
| Corvette | `AmaxChaseParam` | 2476 | 2354127912 | `Fov` | 8 | 661,092 |
| Corvette | `AmaxChaseParam` | 2476 | 2354127912 | `Tilt` | 12 | 661,096 |
| Corvette | `AmaxChaseParam` | 2476 | 2354127912 | `BehindSpring` | 16 | 661,100 |
| Corvette | `AmaxChaseParam` | 2476 | 2354127912 | `SafeHeight` | 32 | 661,116 |

The per-car `CameraParam` pointer is at `AmaxVehicle` field offset **536**
(Corvette record 317). The inline Bonnet/Dash/Bumper values are reached through
that pointer; the decoder exposes the values but not the component byte offset,
so those manifest sources say `inlineComponent:true` and do not invent an
offset.

### 3.9 Shake

No `AmaxChaseParam` or `HollywoodVehicleParams` field carries shake. Chase shake
is runtime/event-driven (`C_CameraNoiseSpecialFX`, `C_ShakeWorld`), and the
`C_ShakeCamera` defaults are amount 0 / frequency 0 (`ShakeCamera.cpp:10-12`).
The data does carry four `DyCamShakeDef` records (dynamic-camera shake):

| record | id | X ° | Y ° | Z ° | Freq Hz |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 2208 | 2096603625 | 0.47 | 0.32 | 0.30 | 9.42 |
| 2527 | 2409893593 | 0.47 | 0.32 | 0.30 | 9.42 |
| 2970 | 2836857898 | 0.10 | 0.10 | 0.10 | 30.0 |
| 3282 | 3128391040 | 1.30 | 1.00 | 0.20 | 20.0 |

They are **not** mapped to a chase camera or a specific route here; that
ownership is unresolved. The manifest records them with `data` provenance and
states `perCarChaseShakeSerialized:false`.

---

## 4. PoC camera extraction

Extracted from the code, not assumed:

| PoC parameter | value | unit | source |
| --- | ---: | --- | --- |
| `distance` | 9.0 | m | `packet-adapter.js:150` |
| `height` | 2.4 | m | `packet-adapter.js:151` |
| `lookHeight` | 1.0 | m | `packet-adapter.js:152` |
| `smoothing` | 0.18 | per-tick alpha | `packet-adapter.js:153` |
| `occlusionMargin` | 0.4 | m | `packet-adapter.js:162` |
| `occlusionMinimum` | 0.05 | m | `packet-adapter.js:165` |
| `occlusionRecovery` | 0.08 | per-tick | `packet-adapter.js:166` |
| `occlusionNearField` | 3.4 | m | `packet-adapter.js:172` |
| vertical FOV | 45 | ° | `build_packet.mjs:36` (`FOV_Y = Math.PI / 4`) |
| near | 0.156196 | m | `_work/e1-drive/geometry.json` (`cameraIntrinsics.near`) |
| far | 230.037 | m | `_work/e1-drive/geometry.json` (`cameraIntrinsics.far`) |
| aspect | 16:9 | ratio | `_work/e1-drive/geometry.json` |

Derived (provisional):

| derived value | value | formula |
| --- | ---: | --- |
| orbit distance | 9.314505 | `hypot(9.0, 2.4)` |
| orbit pitch | 14.931 | `asin(2.4/9.314505)` in degrees |
| eye above car | 3.400 | `lookHeight + height` |
| look-ahead | 0.000 | `ChaseCamera.update` target is `position + lookHeight` |
| yaw/pitch t63 | 0.0835 s | first-order `ln(0.37)/ln(1−0.18)/60` |
| horizontal FOV | 72.734° | `2·atan(tan(45/2)·16/9)` |
| car angular size ratio | 0.854 normal / 0.795 legacy | retail distance·tan(retailFOV/2) ÷ PoC distance·tan(PoC FOV/2) |

The PoC has **one** smoothing field for both yaw and pitch, **no** look-ahead,
and a near-field hold that is a PoC presentation choice, not retail behaviour.

---

## 5. Numeric comparison

The normal Hollywood profile is the primary basis; the legacy profile is shown
because it is a complete orbit and the PoC is orbit-shaped. Positive deltas are
retail − PoC.

### 5.1 At standstill and at 30 m/s (108 km/h)

| parameter | PoC | normal retail | Δ normal | legacy retail | Δ legacy |
| --- | ---: | ---: | ---: | ---: | ---: |
| vertical FOV ° | 45.000 | 65.000 | **+20.000** | 65.000 | **+20.000** |
| distance m | 9.000 | 4.997 | **−4.003** | 4.650 | **−4.350** |
| eye above car m | 3.400 | 1.524 | **−1.876** | 1.400 | **−2.000** |
| look-down ° | 14.931 | 4.998 | **−9.933** | 16.756 (orbit elevation; view tilt −8° separate) | +1.824 |
| yaw t63 s | 0.0835 | 0.9667 | **+0.8832** | 0.3231 | +0.2396 |
| horizontal FOV ° | 72.734 | 97.114 | +24.380 | 97.114 | +24.380 |
| near m | 0.156196 | 0.115382 | −0.040814 | 0.115382 | −0.040814 |
| far m | 230.037 | 4000 | +3769.963 | 4000 | +3769.963 |

At **30 m/s constant** the normal retail values are the same as standstill:
`IdealDistanceNormal` 5.0 m, FOV 65°, eye 1.524 m, look-down 4.998°,
yaw t63 0.967 s. The distance only moves under longitudinal acceleration:
**5.1 m at full acceleration**, **4.8 m at full deceleration** for the Corvette
(`HollywoodVehicleCamera.cpp:1453-1502`). The FOV stays 65° because
`m_highSpeed` is never true in the committed source; the serialized high-speed
multiplier 1.3 is data-only. The legacy distance/FOV are also constant at
30 m/s; the legacy acceleration offset is active only under acceleration and its
`FovEffect` is 0.

### 5.2 Interpretation

- The PoC is **~1.8× farther** and **~2.2× higher** than the normal retail chase.
- Its FOV is **20° narrower** (vertical), which only partly compensates: the car
  is still ~**14.6% smaller** in the PoC frame than normal retail and ~**20.5%**
  smaller than legacy at the same world size.
- Its look-down is **~10° steeper** than normal retail; the frame shows more
  roof and less of the car's side/background.
- Its yaw response is **~11.6× faster** than normal retail (t63 0.0835 s vs
  0.9667 s), and pitch is **~3.4× faster** (0.0835 vs 0.283 s). The PoC will feel
  twitchy.
- The near/far difference is mostly a depth-precision/projection difference, not
  a framing difference.

---

## 6. Exact patch values

### 6.1 Primary: normal Hollywood chase onto the PoC orbit (Corvette ZR1)

This is the recommended 1:1 profile. It keeps the PoC aim point at
`car + 1.0 m` (the Corvette `LookAtPos.vy`) and maps the Hollywood camera to the
PoC's orbit fields. `lookAhead` and separate yaw/pitch smoothing require small
code changes; the current `ChaseCamera` has one smoothing field and no
look-ahead.

| PoC field | current | patch | unit | provenance |
| --- | ---: | ---: | --- | --- |
| `distance` | 9.0 | **4.997** | m | provisional (`IdealDistanceNormal·cos(IdealPitch)`) |
| `height` | 2.4 | **0.5245** | m | provisional (`eye − LookAtPos.vy`) |
| `lookHeight` | 1.0 | **1.0** | m | provisional (keep; equals Corvette `LookAtPos.vy`) |
| `lookAhead` (new) | 0.0 | **1.0** | m | provisional (`LookAtPos.vz`) |
| `verticalFov` | 45 | **65** | ° | data (`NormalFOV`) |
| `near` | 0.156196 | **0.115382** | m | code (near formula) |
| `far` | 230.037 | **4000** | m | code (`C_Camera` far clip) |
| `yawSmoothing` | 0.18 | **0.016996** | per-tick alpha | provisional (matches yaw t63 0.967 s) |
| `pitchSmoothing` (new) | 0.18 | **0.056808** | per-tick alpha | provisional (matches pitch t63 0.283 s) |
| `distanceSmoothing` (new) | — | **0.038990** | per-tick alpha | provisional (matches 0.417 s) |
| `fovSmoothing` (new) | — | **0.018939** | per-tick alpha | provisional (matches 0.867 s) |
| `lookAtSmoothing` (new) | — | **0.033704** | per-tick alpha | provisional (matches 0.483 s) |
| `occlusionMargin` | 0.4 | **0.35** | m | code (Hollywood trace) |
| `occlusionNearField` | 3.4 | **0.0 / remove hold** | m | provisional (retail has no fixed hold) |
| eye above car | 3.4 | **1.5245** | m | provisional |
| look-down | 14.931 | **4.998** | ° | provisional |

After the patch, the car angular size ratio is 1.0 by construction and the
look-down matches the retail Corvette straight-line value. The `lookAhead`
change is `target = position + lookHeight + forwardNormal * lookAhead`.

### 6.2 Per-car orbit mapping

All normal profiles use FOV 65°, look-ahead 1.0 m, and the same smoothing
family; the per-car values are:

| car | `lookHeight` m | `distance` m | `height` above aim m | eye above car m | `lookAhead` m | look-down ° |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Corvette ZR1 | 1.00 | 4.997 | 0.524 | 1.524 | 1.0 | 4.998 |
| Lotus Exige Cup260 | 1.00 | 4.444 | 0.333 | 1.333 | 1.0 | 3.499 |
| Dodge Challenger | 1.25 | 5.799 | 0.401 | 1.651 | 1.0 | 3.377 |
| Ford Focus RS | 1.30 | 5.298 | 0.407 | 1.707 | 1.0 | 3.700 |
| Audi R8 V10 | 1.10 | 5.299 | 0.292 | 1.392 | 1.0 | 2.659 |

`height` is relative to the `lookHeight` target; the eye-above-car column is the
absolute value. The per-car smoothing values are in the manifest
(`yawDampingNormal` 0.9 s for all, `pitchDampingNormal` 0.25 s,
`lookAtSmoothing` 0.45 s; distance smoothing 0.375/0.375/0.600/0.700/0.375 s).

### 6.3 Secondary: legacy orbit

Use only if the PoC keeps the legacy orbit model and does not adopt the normal
Hollywood camera:

| field | patch | unit | provenance |
| --- | ---: | --- | --- |
| `distance` | 4.65 | m | data |
| `height` | 1.40 | m | data |
| `lookHeight` | 0.0 | m | provisional (legacy pivot is car origin) |
| `lookAhead` | 0.0 | m | provisional (legacy looks at pivot) |
| `verticalFov` | 65 | ° | data |
| `tilt` | −8.0 | ° | data (view tilt; `ChaseCamera2.cpp:132-133`) |
| `behindSpring` | 3.0 | s⁻¹ | data |
| `perTickAlpha` | 0.05 | ratio | provisional (3.0/60; active only above 120°/s) |
| `near` | 0.115382 | m | code |
| `far` | 4000 | m | code |
| `occlusionMargin` | 0.20 | m | code |
| `safeHeight` | 0.70 | m | data |

The legacy orbit elevation is 16.756°; the −8° view tilt is separate and should
not be folded into the orbit pitch.

---

## 7. 1:1 implications (Corvette ZR1 + River 0–100 m)

1. **Do not compare pixels with the current PoC camera.** It is a different
   camera family: 1.8× the distance, 2.2× the eye height, 20° narrower, 10°
   steeper look-down, ~11.6× faster yaw response. The immediate mismatch is
   larger than any material/shader difference on the car.
2. **Use the normal Hollywood profile**, not the legacy `AmaxChaseParam`, for the
   retail comparison. The legacy record is a useful cross-check and the closest
   orbit analogue, but `C_VehicleFeed` selects Hollywood in normal gameplay.
3. **Patch FOV first.** 45° → 65° vertical changes horizontal FOV from 72.734° to
   97.114°; the car's projected size changes by ~1.54× at constant distance.
4. **Patch distance/height/look-ahead together.** 9.0/2.4/no-look-ahead →
   4.997/0.5245/1.0 m with `lookHeight` 1.0 gives the Corvette eye at 1.5245 m
   and a 4.998° look-down, matching the data-derived straight-line framing.
5. **Patch smoothing with separate axes.** A single 0.18 per-tick alpha cannot
   represent retail yaw (t63 0.967 s) and pitch (t63 0.283 s) at the same time;
   use 0.0170 yaw and 0.0568 pitch (and 0.0390 distance, 0.0189 FOV, 0.0337
   look-at if those paths exist).
6. **Revisit occlusion.** Retail normal traces from the car roof with a 0.35 m
   margin; the PoC's 3.4 m near-field hold is a presentation invention. Dense
   props will frame differently even after the framing patch.
7. **Keep single-player FOV scale 1.0.** Only two-player split-screen scales FOV
   by 0.7; do not apply that to the 1:1 capture.
8. **Record the camera pose per tick.** The retail camera is a velocity/spring
   camera; a single `?camdist/camheight` override cannot reproduce its transient
   response. For a still comparison, use the settled/tick-0 pose.

---

## 8. Verification

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py probes/camera/tools/build_camera_manifest.py
& $py probes/camera/tools/verify_camera_manifest.py
```

`_work/camera/verify.json` — **PASS, 8,760 checks, 0 failures**, parameter count
**511**, provenance **309 data / 82 code / 120 provisional**, 4 distinct normal
distance profiles, legacy single profile **true**. The verifier checks, among
other things:

- every parameter has a provenance tag, a unit in the manifest's unit table, a
  semantic/unit match and a non-empty source;
- every numeric value is finite and within a plausible range;
- every data source record index/id/type, record data offset, field offset and
  file offset resolves against a fresh `amax.bin` decode, and every decoded
  value equals the manifest value (including nested `IdealBase.vy`,
  `LookAtPos.vz` and `CameraParam.Bonnet/Dash` paths);
- every code source file exists and its SHA-256 matches;
- every provisional source has a derivation and inputs;
- no duplicate parameter path;
- the five roster cars are present in every active mode, the normal profiles use
  their own records (no fallback), the legacy profile is byte-identical across
  cars;
- the comparison deltas and angular-size ratios recompute exactly;
- the patch values equal the derived retail values;
- the manifest rebuilds byte-identically from source (deterministic), and the
  canonical manifest hash matches.

The manifest file is `_work/camera/camera.json`, 446,755 B, SHA-256
`d201dbc0eefb52cc6335a39a1196495ee3c1e8d366ca8a7128a0d2fc1c3d360d`,
canonical hash
`sha256:c5b41745b9897a4387eb0987942ff958de3019b67fb25cee724a05b3518f4ade`.

---

## 9. Limits

- **Normal vs legacy.** `AmaxChaseParam` is not the normal chase. The normal
  chase is `C_HollywoodVehicleCamera`; the legacy record is only created for the
  future feed. Any claim that 4.65/1.4/65 is "the retail camera" is wrong for
  normal gameplay, even though it is a real shipped record.
- **Pitch-unit ambiguity.** The data `IdealPitch` is in degrees by context, but
  this source revision passes it raw to `SetIdealPitch`, whose range is radians
  (`HollywoodVehicleCamera.cpp:863`; `ThirdPersonCamera.cpp:385-389`). The
  derived eye height/look-down is **provisional**; a retail binary check is
  needed before treating it as exact.
- **Dormant high-speed FOV.** `HighSpeedLowerVelThreshold` 199,
  `HighSpeedUpperVelThreshold` 200 and `HighSpeedFovMultiplier` 1.3 are
  serialized, but `m_highSpeed` is only ever set false in this source revision.
  The multiplier is not applied at 30 m/s, and the threshold unit is unresolved.
- **Five cars, not 62.** Per-car normal offsets are recovered for the five E1
  roster cars; the other `RP_CarDynamics` records are not enumerated. The legacy
  chase is a single profile for all five.
- **Straight-line look-at only.** The Hollywood look-side/up-down depends on
  yaw rate, wheel slip, throttle and wheel contact; only the `LookAtPos` rest
  value is mapped. Airborne, wrecked, lost-control and burnout branches are not
  modelled.
- **No per-car chase shake.** Shake is runtime/event-driven; the four
  `DyCamShakeDef` records are dynamic-camera data and are not mapped to a chase
  camera or route.
- **No retail binary execution and no browser capture.** The task forbids
  browser captures; this record is data/code evidence, not pixel parity. No
  screenshot claim is made.
- **`lag` is dead.** `C_ChaseParam.lag` is declared (0.1 s) but unread by
  `C_ChaseCamera2::OnUpdate`; it is not a smoothing constant.
- **First-order vs velocity smoothing.** The PoC uses a first-order per-tick
  alpha; retail uses `Kanzen::SmoothingFunction` (velocity-based). The comparison
  uses t63 as a common metric, not a like-for-like formula.
- **Mode gaps.** Far chase does not exist; hood/dash are data-only; orbit is a
  debug camera; replay is keyframed `.cycle` packs, not a chase camera.
- **Native parity.** The project's native-vs-wasm parity remains blocked by the
  DirectX SDK; this record adds no new engine claim.

---

## 10. Evidence paths

| path | content |
| --- | --- |
| `_work/camera/camera.json` | 511-parameter manifest with provenance/units/offsets |
| `_work/camera/verify.json` | PASS, 8,760 checks, parameter/provenance counts |
| `_work/logs/camera/build.log` | builder stdout (final run) |
| `_work/logs/camera/verify.log` | verifier stdout (final run) |
| `probes/camera/tools/build_camera_manifest.py` | deterministic builder |
| `probes/camera/tools/verify_camera_manifest.py` | manifest gate |
| `probes/camera/README.md` | reproduction and scope |

---

## 11. Reproduction

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py probes/camera/tools/build_camera_manifest.py
& $py probes/camera/tools/verify_camera_manifest.py
```

The builder is deterministic: no timestamps, sorted keys, no absolute paths in
the manifest, and a canonical hash over the manifest with `manifestHash` set to
the empty string. Re-running the builder and verifier reproduces the same
`manifestHash` and the same 8,760-check PASS.
