# Per-car vehicle physics envelope — 62 XT records, 15 integrated cars

**Date:** 8 November 2026
**Owner:** PHYS1 (sub-agent)
**Scope:** new `probes/physics/`, output under `_work/physics/` and
`_work/logs/physics/`, and this document. No change to `probes/e1-drive/**`,
`probes/asset-reader/**`, `probes/prop-collision/**`, `tools/`, `upstream/`,
`game-data/` or any consumer. No browser capture, no engine tick, no commit.
**Result:** every geometry-relevant `RP_CarDynamics` leaf is decoded for all
**62** records with field id, byte offset, raw bits and unit; **61 / 62** cars
have a real body AABB; the 15 integrated cars are **+0.83 … +2.04 m longer** and
**+0.08 … +0.49 m wider** than the fixed 2.98 × 1.68 m collision box; a
deterministic **3,289-check** gate passes; and switching the 310 m `roadside`
profile to the per-car body envelope blocks **0 → 17–149 of 1,245** poses.

---

## 0. Summary

| | |
| --- | --- |
| XT source | `gamedata.pak` → `\gamedata\xt\racingphysics.bin`, FLSK v2, 73,420 B, SHA-256 `048ef93a…47b2e9` |
| records | **62** `RP_CarDynamics` (record image 632 B, string block 20 B) |
| schema leaves | **152** = 144 scalar/handle/reserved + 6 arrays + name + handle |
| field coverage | **152 / 152 leaves present in 62 / 62 records** |
| values copied per car | **144 scalars + 6 arrays** (every value, not a subset) |
| labelled extraction set | **112** (106 scalars + 6 arrays); **34 geometry-relevant** |
| typed missing fields | **9** (collision extents, body L/W/H, wheel width, ride height, overhangs, XT handle) |
| body AABB | **61 / 62** (all but `DefaultCar`); 25 roster + 14 staged C aliases + 22 Scene reports |
| fixed box today | **2.98 × 1.68 × 1.35 m** for every car, from `CAR_ENVELOPE` |
| fixed box re-derived | 2.981 m max wheelbase × 1.676 m max track of the **5-car** roster, rounded down |
| all-62 max axle box | **3.584 × 2.082 m** (`Ford_F150_OffRoadheh`) |
| axle boxes outside the fixed box | **15 / 62** |
| integrated body deltas | length **+0.833 … +2.040 m** (+27.9 … +68.4 %); width **+0.078 … +0.490 m** (+4.6 … +29.2 %); height **−0.173 … +0.966 m** |
| 310 m course, `roadside` | fixed **0 / 1,245**; per-car axle **0 / 1,245**; per-car body **0–149 / 1,245** |
| 310 m course, `all-visible` | fixed **181**; per-car axle **170–185**; per-car body **196–214** |
| verification | `_work/physics/verify.json` — **PASS 3,289 / 3,289**, 0 failures |
| determinism | two fresh processes (`PYTHONHASHSEED` 0/1) byte-identical; final file equal |
| manifest | `_work/physics/envelope.json`, 2,719,379 B, `1b034fa7…1fed80dd`, content `fbcfc86a…991e415d` |

No retail collision hull, no retail handling and no full-game claim is made.

---

## 1. Method and authority

### 1.1 Inputs

Every input is SHA-256 pinned in the manifest; a changed hash is a hard error,
not a silent rebuild.

| input | role | SHA-256 |
| --- | --- | --- |
| `game-data/Blur/cache/gamedata.pak` → `\gamedata\xt\racingphysics.bin` | physics authority | `048ef93a4dc9435164e89a65147423245ced1334f132f01042a442a8c047b2e9` |
| `_work/car-parts/cars/index.json` + `<slug>/manifest.json` | body AABB + wheel rest geometry, 25 roster cars | `94b31721a34cfa4a2af1c90c1893af2fd2a28c567d80cf14f42a47569fd15315` |
| `_work/vehicle-pipeline/c-staging-results.json` + `c-staging/<slug>/manifest.json` | body AABB for the staged C aliases (14) | `a25c995d064e3cdbd1182da344612c25e0e30db71d541b280b12bca10ca908ab` |
| `_work/vehicle-pipeline/cars.json` | V1 audit physics (independent) + Scene AABB (22) | `0fb3f56753ab12c56062ba559843f527081cbed354ac2cc61b71fe3c507e3e4d` |
| `_work/vehicle-pipeline/c-aliases.json` | C record → model identity | `f40027ca785fec168b994b8a5f69e337869ba372b5da668a7c77424330822ae9` |
| `_work/e1-drive/cars.json` | committed `.fields` consumer input; roster order | `0d59aa0a409c67cff5271a1944c551f8ee4a1c2c47da9300485856d37a15a768` |
| `_work/prop-collision/colliders-v2.json` | course-impact resolver input | `3348875297fdb79699410069548c724840761c61b3386e3d5bbb5974448751d7` |
| `_work/e1-drive/geometry.json` | ground sampler | `a64530094750503e53e7ddfc74d0a173377bb5bb9b9a77cca3f4da3681021aab` |
| `_work/drivable-path/path.json` | 1,245-sample 310.3952 m course | `81eac0ce413075de33e2b3c0e1c077412b35002420b199d9f05d2fdeef230e7f` |

### 1.2 Decode, not re-derivation

`probes/physics/lib/envelope.py` imports `engine/harness/t005d-vehicle/car_xt.py`
read-only and uses its `extract()`, `parse()`, `leaves()` and `_string_blob()`.
The probe adds a parallel leaf walk that also records the **schema field index**;
that walk is asserted equal to the committed `leaves()` output
(`name, offset, kind, array`) before any value is read. A divergence aborts the
build.

Each record is decoded from its own image slice; the image SHA-256 is stored per
car (`cars[].record.imageSha256`), so any value can be traced to 632 bytes.

### 1.3 Independent checks

The gate does **not** trust the builder's own objects:

* the whole XT is decoded a second time and every value re-compared;
* every extracted scalar and array is compared with the committed `.fields`
  consumer input for the 25 drive-roster cars;
* 9 physics values per car are compared with the independent V1 audit
  (`_work/vehicle-pipeline/cars.json`) for **62 / 62** records;
* body AABBs are compared between the car-part manifest and the Scene report
  wherever both exist (15 / 15 agree exactly);
* body axis meaning is **measured**: the wheel rest translations match
  ±track/2 on X and ±wheelbase/2 on Z, so the manifest object-local frame is
  X = width, Y = up, Z = length. This is recorded, not assumed.

---

## 2. XT field coverage

### 2.1 Schema census

`RP_CarDynamics` is a fixed 149-leaf struct (serialized size 632 B) plus three
reserved/expanded entries in the manifest view. The count is identical in all 62
records: **no record lacks or adds a field name** (V1 already established this;
this probe confirms it at the leaf level).

| role | leaves | notes |
| --- | ---: | --- |
| tyres | 50 | radius, grip curves, slip, grip-in-gear |
| engine | 21 | torque curve, limiter, braking, clutch, traction |
| suspension | 20 | front/rear angles, travel, springs, damping, roll |
| inertia / centre of mass | 13 | MI scales, CoM offsets, wheel MI, tensor scales |
| transmission | 13 | drive type, three differentials |
| steering | 12 | steer limit, Ackermann, smoothing, springs |
| gears | 7 | ratios array, top gear, final drive |
| friction | 6 | air, rolling, downforce |
| brakes | 5 | front/rear/handbrake forces, smoothing |
| geometry | 3 | wheelbase, front/rear track |
| mass | 1 | `mass.mass` |
| other | 1 | `name` |
| **total** | **152** | 144 scalars + 6 arrays + name + handle |

Units are claimed only where the committed consumer establishes them
(`m`, `kg`, `rad`, `rpm`, `Nm`, `ratio`, `count`, `enum`, `bool`). 70 leaves are
labelled `unknown` and 40 `engine-scalar`; that is a typed statement, not a
default. The four duplicated front/rear entries share a field id because the
serialized struct declares `CarWheelSuspensionXt` once (the `front`/`rear`
members are separate fields of `CarSuspensionXt`).

### 2.2 Geometry-relevant leaves (34)

`id` is the index in the XT `fields` table; `offset` is the byte offset inside
the 632-byte `RP_CarDynamics` image.

| field | id | image offset | bytes | unit |
| --- | ---: | ---: | ---: | --- |
| `mass.mass` | 36 | 4 | 4 | kg |
| `mass.MIScaleX` | 37 | 8 | 4 | unknown |
| `mass.MIScaleY` | 38 | 12 | 4 | unknown |
| `mass.MIScaleZ` | 39 | 16 | 4 | unknown |
| `mass.cofGOffsetY` | 40 | 20 | 4 | m (offset, not absolute height) |
| `mass.cofGOffsetZ` | 41 | 24 | 4 | m |
| `mass.frontWheelMI` | 42 | 28 | 4 | unknown (moment of inertia) |
| `mass.rearWheelMI` | 43 | 32 | 4 | unknown (moment of inertia) |
| `mass.physicsCofMassOffsetY` | 44 | 36 | 4 | m |
| `mass.physicsCofMassOffsetZ` | 45 | 40 | 4 | m |
| `mass.interiaTensorScaleX` | 46 | 44 | 4 | unknown |
| `mass.interiaTensorScaleY` | 47 | 48 | 4 | unknown |
| `mass.interiaTensorScaleZ` | 48 | 52 | 4 | unknown |
| `geometry.wheelBase` | 50 | 60 | 4 | m |
| `geometry.trackWidthFront` | 51 | 64 | 4 | m |
| `geometry.trackWidthRear` | 52 | 68 | 4 | m |
| `suspension.front.casterAngle` | 106 | 72 | 4 | rad (small-angle sine) |
| `suspension.front.camberAngle` | 107 | 76 | 4 | unknown |
| `suspension.front.toeAngle` | 108 | 80 | 4 | unknown |
| `suspension.front.movementDown` | 109 | 84 | 4 | m |
| `suspension.front.movementUp` | 110 | 88 | 4 | m |
| `suspension.front.springStiffness` | 111 | 92 | 4 | engine-scalar |
| `suspension.front.rollStiffness` | 115 | 108 | 4 | engine-scalar |
| `suspension.rear.casterAngle` | 106 | 112 | 4 | rad (small-angle sine) |
| `suspension.rear.camberAngle` | 107 | 116 | 4 | unknown |
| `suspension.rear.toeAngle` | 108 | 120 | 4 | unknown |
| `suspension.rear.movementDown` | 109 | 124 | 4 | m |
| `suspension.rear.movementUp` | 110 | 128 | 4 | m |
| `suspension.rear.springStiffness` | 111 | 132 | 4 | engine-scalar |
| `suspension.rear.rollStiffness` | 115 | 148 | 4 | engine-scalar |
| `steering.steerLimit` | 55 | 152 | 4 | rad |
| `steering.ackerman` | 56 | 156 | 4 | scalar |
| `tyres.frontTyres.radius` | 131 | 392 | 4 | m |
| `tyres.rearTyres.radius` | 131 | 500 | 4 | m |

The five arrays are stored after the struct in the record's component area
(`f32 × 19` at image offset 632, `RP_GraphPoint × 6` at 708 for the Corvette):

| array | descriptor offset | elements | per-car cardinality |
| --- | ---: | --- | --- |
| `engine.engineTorque_Rpm.dataPoints` | 232 | f32 | 10 on all 62 |
| `gears.gearRatios` | 360 | f32 | 6 on 59, 7 on 3 |
| `tyres.frontTyres.forwardsGripScaleInGear` | 492 | f32 | 0–3 |
| `tyres.rearTyres.forwardsGripScaleInGear` | 600 | f32 | 0–3 |
| `tyres.frontTyres.grip.data` | 400 | RP_GraphPoint | 3 on all 62 |
| `tyres.rearTyres.grip.data` | 508 | RP_GraphPoint | 3 on all 62 |

Each array element carries its own image offset and raw bits in the manifest
(`cars[].physics.arrays[].values[]`), and the descriptor records the component
index and element stride.

### 2.3 Distribution across the 62 records

| property | range |
| --- | --- |
| mass | 660 – 2,500 kg (median 1,462) |
| wheelbase | 2.000 – 3.584 m |
| front / rear track | 1.192 – 2.053 / 1.279 – 2.082 m |
| tyre radius front / rear | 0.320 – 0.480 / 0.320 – 0.480 m |
| suspension travel up / down | 0.03 – 0.28 / 0.05 – 0.28 m |
| `steering.steerLimit` | **1.0 rad on all 62** |
| `steering.ackerman` | **1.0 on all 62** |
| brake front / rear | **1.0 on all 62** / 0.725 – 1.500 |
| `friction.downforce` | 0.80 – 1.50 |
| final drive | 2.115 – 5.000 |
| caster front / rear | 0.09 / 0.00 rad on all 62 |
| camber / toe | 0.0 on all 62 |
| gear ratios | 6 gears (59), 7 gears (3) |
| torque points / grip points | 10 / 3+3 on all 62 |

Three gear stacks are **not** monotonically decreasing — `Audi_S3_Stock` and
`Audi_TT_Stock` (1.09 → 1.10) and `Nissan_350Z_Drift` (1.0 → 0.794 duplicated
last). That is the record's data, not a decode error: the values agree with both
independent sources. It matters for any consumer that assumes a monotonic stack.

### 2.4 Fields the brief asks for that XT does not carry (typed)

| requested | status | reason | would have to come from |
| --- | --- | --- | --- |
| collision extents / box | **absent** | no collision/body-extents leaf in 149; geometry is wheelbase, track, radii, travel only | retail imports the model's composite collision shape (`VehicleActor.cpp:6905-6970`); this project has no import |
| body length | **absent** | wheelbase excludes overhangs | mesh AABB minus wheelbase |
| body width | **absent** | track is a wheel-centre distance, not body width | mesh AABB; `track + 2 × wheel width` is a lower bound |
| body height | **absent** | only tyre radius and travel exist | mesh AABB |
| wheel width | **absent** | no serialised wheel/tyre width | mesh wheel-member X extent |
| ride height | **derived** | harness computes `tyre radius + suspension.front.movementUp` (`vehicle_harness.cpp:964`) | two serialised fields |
| front / rear overhang | **absent** | no serialised overhang | mesh AABB edges minus axle positions |
| `mass.physicsParameters` | **unresolved handle** | `XtHandle` resolves through the XT database across packs; the harness installs the null handle and reports the raw id. Consequence: `surfaceMappingsApplied:false` in the T-007 physics spike | full XT runtime (not ported) |

---

## 3. The fixed envelope and where it came from

`CAR_ENVELOPE` is `{length: 2.98, width: 1.68, height: 1.35}` in
`probes/prop-collision/lib/collider-build.mjs:27`. Re-measuring the five-car E1
roster reproduces its source exactly:

| quantity | five-car roster | 62-record maximum |
| --- | --- | --- |
| wheelbase | **2.981 m** (`Dodge_Challenger_Stock`) | **3.584 m** (`Ford_F150_OffRoadheh`) |
| track (front or rear) | **1.676 m** (`Audi_R8V10_Stock`, rear) | **2.082 m** (`Ford_F150_OffRoadheh`, rear) |

So the box is the **union of the five reference cars' wheel-centre rectangles**,
rounded down (2.981 → 2.98, 1.676 → 1.68). It is not a body box and it is not a
maximum over the 62-car set.

**15 of 62 axle rectangles already exceed it:**

| car | wheelbase | widest track | overflow L / W (m) |
| --- | ---: | ---: | --- |
| Ford_F150_OffRoadheh | 3.584 | 2.082 | +0.604 / +0.402 |
| Nissan_Navara_OffRoad | 3.324 | 1.869 | +0.344 / +0.189 |
| Ford_F100_Rat | 3.259 | 1.656 | +0.279 / 0 |
| Ford_FR100_Stock | 3.233 | 1.560 | +0.253 / 0 |
| Hummer_H2_Rat | 3.220 | 2.053 | +0.240 / +0.373 |
| Hummer_H2_OffRoad | 3.220 | 2.053 | +0.240 / +0.373 |
| Nissan_Navara_Rat | 3.129 | 1.511 | +0.149 / 0 |
| Ford_F100_OffRoad | 3.051 | 1.676 | +0.071 / 0 |
| Dodge_Challanger_Tuner1stplay | 3.000 | 1.618 | +0.020 / 0 |
| Dodge_Challenger_Race | 3.000 | 1.608 | +0.020 / 0 |
| Dodge_Challenger_Stock | 2.981 | 1.589 | +0.001 / 0 |
| Ford_FocusRS_Race | 2.749 | 1.869 | 0 / +0.189 |
| Bowler_Nemesis_Stock | 2.729 | 1.821 | 0 / +0.141 |
| Corvette_C3_Drag | 2.453 | 1.734 | 0 / +0.054 |
| Koenigsegg_CCXR_Stock | 2.710 | 1.685 | 0 / +0.005 |

The Dodge line is the 1 mm rounding of its own 2.981 m wheelbase. The important
entries are the real ones: an F-150 record is **0.604 m longer and 0.402 m
wider** than the "maximum" box, and both Hummers are 0.240 / 0.373 m over.

---

## 4. Per-car physical envelope

### 4.1 Definitions

| name | definition | meaning |
| --- | --- | --- |
| `collisionUpperBound` | visible mesh AABB, X × Y × Z = width × height × length | **upper bound**; includes mirrors, spoilers and any detail inside the mesh bounds |
| `chassisFootprint` | `wheelBase × max(trackFront, trackRear)` | **lower bound**; wheel-centre rectangle |
| `engineBodyBox` | `(trackFront/2, tyreRadius, wheelBase/2)` half extents | the T-005d harness Gravity box; a chassis proxy |

The retail body collider is the imported composite collision shape. It is not
imported here, so the honest per-car collision envelope is the mesh AABB upper
bound, and the honest lower bound is the axle rectangle. A consumer must state
which one it uses; it must not silently keep the fixed box.

### 4.2 The 15 integrated cars (Corvette ZR1 first in the roster, index 37)

`L/W/H` are the mesh AABB; `dL/dW/dH` are against 2.98 / 1.68 / 1.35 m.

| car | body L (m) | body W (m) | body H (m) | wheelbase (m) | track F/R (m) | tyre r (m) | dL (m) | dW (m) | dH (m) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Corvette_ZR1_Stock | 4.434 | 2.064 | 1.246 | 2.652 | 1.656 / 1.637 | 0.356 | **+1.454** | **+0.384** | **−0.104** |
| Lotus_ExigeCup260_Stock | 3.812 | 1.850 | 1.177 | 2.323 | 1.424 / 1.540 | 0.326 | +0.833 | +0.170 | −0.173 |
| Dodge_Challenger_Stock | 5.020 | 2.170 | 1.466 | 2.981 | 1.482 / 1.589 | 0.370 | +2.040 | +0.490 | +0.116 |
| Ford_FocusRS_Stock | 4.326 | 1.902 | 1.729 | 2.787 | 1.608 / 1.618 | 0.326 | +1.346 | +0.222 | +0.379 |
| Audi_R8V10_Stock | 4.430 | 2.043 | 1.236 | 2.635 | 1.627 / 1.676 | 0.326 | +1.450 | +0.363 | −0.114 |
| Audi_TT_Stock | 4.193 | 1.946 | 1.371 | 2.479 | 1.608 / 1.598 | 0.326 | +1.213 | +0.266 | +0.021 |
| Ford_F100_OffRoad | 4.791 | 2.061 | 2.273 | 3.051 | 1.540 / 1.676 | 0.440 | +1.811 | +0.381 | +0.923 |
| Ford_FR100_Stock | 5.020 | 2.141 | 1.937 | 3.233 | 1.540 / 1.560 | 0.370 | +2.040 | +0.461 | +0.587 |
| Volkswagen_GolfW12650_Stock | 4.303 | 2.070 | 1.463 | 2.633 | 1.637 / 1.637 | 0.326 | +1.323 | +0.390 | +0.113 |
| Ford_MustangGTR_Stock | 4.787 | 1.939 | 1.367 | 2.718 | 1.540 / 1.569 | 0.350 | +1.807 | +0.259 | +0.017 |
| Dodge_ViperACR_Stock | 4.445 | 1.994 | 1.205 | 2.507 | 1.470 / 1.502 | 0.320 | +1.465 | +0.314 | −0.145 |
| Audi_S3_Stock | 4.227 | 1.992 | 1.381 | 2.583 | 1.656 / 1.598 | 0.326 | +1.247 | +0.312 | +0.031 |
| Ford_Bronco_OffRoad | 4.303 | 1.929 | 2.316 | 2.297 | 1.511 / 1.386 | 0.403 | +1.323 | +0.249 | +0.966 |
| Nissan_SkylineR34ZTune_Stock | 4.602 | 1.903 | 1.342 | 2.687 | 1.463 / 1.453 | 0.326 | +1.622 | +0.223 | −0.008 |
| Chevrolet_SoCalHHR_Stock | 4.510 | 1.758 | 1.583 | 2.622 | 1.453 / 1.511 | 0.346 | +1.530 | +0.078 | +0.233 |

Ranges over the 15: length **+0.833 … +2.040 m** (+27.9 … +68.4 %), width
**+0.078 … +0.490 m** (+4.6 … +29.2 %), height **−0.173 … +0.966 m**
(−12.8 … +71.6 %). All 15 are longer than 2.98 m; 14 are also wider; height is
not a usable single-car proxy (a Bronco is +0.97 m, a Koenigsegg is −0.19 m).

**Corvette ZR1, the 1:1 parity reference**

| envelope | length | width | height | half L / W |
| --- | ---: | ---: | ---: | --- |
| fixed box today | 2.980 | 1.680 | 1.350 | 1.490 / 0.840 |
| axle rectangle (XT) | 2.652 | 1.656 | — | 1.326 / 0.828 |
| harness Gravity box (XT) | 2.652 | 1.656 | 0.712 | 1.326 / 0.828 / 0.356 |
| body AABB (mesh) | **4.434** | **2.064** | **1.246** | **2.217 / 1.032** |

Centred on the axle, the real body reaches **0.727 m further front and rear**
and **0.192 m further to each side** than the box the car collides with. The
fixed box is 0.328 m longer than the Corvette axle and 0.024 m wider, so it is
already too big for the chassis and far too small for the body: it fits no car
exactly.

### 4.3 Staged batch 2 (10 more roster cars, same table)

| car | body L | body W | body H | wheelbase | track F/R | tyre r | dL | dW | dH |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| BMW_M3E92_Tuner | 4.586 | 1.940 | 1.376 | 2.739 | 1.589 / 1.627 | 0.326 | +1.606 | +0.260 | +0.026 |
| Dodge_Challanger_Tuner1stplay | 5.021 | 2.166 | 1.531 | 3.000 | 1.598 / 1.618 | 0.380 | +2.041 | +0.486 | +0.181 |
| Koenigsegg_CCXR_Stock | 4.400 | 2.039 | 1.158 | 2.710 | 1.685 / 1.685 | 0.326 | +1.420 | +0.359 | −0.192 |
| Nissan_350ZNismo_Stock grpc | 4.330 | 1.981 | 1.320 | 2.613 | 1.637 / 1.589 | 0.326 | +1.350 | +0.301 | −0.030 |
| Chevrolet_Camaro_StockE3 | 4.705 | 1.886 | 1.623 | 2.895 | 1.502 / 1.415 | 0.326 | +1.725 | +0.206 | +0.273 |
| Toyota_SupraTRD_Stock | 4.514 | 1.997 | 1.312 | 2.570 | 1.482 / 1.520 | 0.326 | +1.534 | +0.317 | −0.038 |
| VW_Beetle_Offroad | 3.913 | 1.778 | 1.673 | 2.453 | 1.598 / 1.463 | 0.356 | +0.933 | +0.098 | +0.323 |
| Foose_Stallion_Stockgrpc | 4.762 | 1.975 | 1.365 | 2.720 | 1.579 / 1.618 | 0.350 | +1.782 | +0.295 | +0.015 |
| Chevrolet_Camaro_Ratdrift | 4.705 | 1.983 | 1.661 | 2.778 | 1.470 / 1.502 | 0.350 | +1.725 | +0.303 | +0.311 |
| Covette_C3_Rat | 4.590 | 1.869 | 1.198 | 2.479 | 1.531 / 1.521 | 0.326 | +1.610 | +0.189 | −0.152 |

### 4.4 All 61 cars with body geometry

| quantity | min | max |
| --- | ---: | ---: |
| body length | 3.812 m (Lotus) | 5.748 m (Ford_F150_OffRoadheh) |
| body width | 1.568 m (VW_Beetle_Rat) | 2.996 m (RatRod_NA_Stock) |
| body height | 1.158 m (Koenigsegg) | 2.316 m (Bronco) |
| total overhang (body length − wheelbase) | 1.100 m | 2.406 m |
| body length vs 2.98 m | **61 / 61 longer** | median 4.520 m |
| body width vs 1.68 m | **60 / 61 wider** | one narrower (Beetle Rat, 1.568) |
| body height vs 1.35 m | 37 / 61 taller | 24 shorter |

`RatRod_NA_Stock` at 2.996 m width is an AABB outlier (wide rear wheel/axle
detail inside the first RenderList mesh); it is reported as the mesh says, not
clipped. This is exactly why the AABB is labelled an upper bound.

---

## 5. Wheel geometry

### 5.1 What XT actually gives

| quantity | source | range / value |
| --- | --- | --- |
| tyre radius | `tyres.*.radius` | 0.320 – 0.480 m |
| suspension travel up/down | `suspension.*.movementUp/Down` | 0.03 – 0.28 / 0.05 – 0.28 m |
| ride height | **derived** `radius + movementUp` | 0.396 – 0.760 m |
| steering lock | `steering.steerLimit` | **1.0 rad on all 62** |
| Ackermann | `steering.ackerman` | 1.0 on all 62 |
| caster | `suspension.front.casterAngle` | 0.09 rad on all 62 (rear 0) |
| camber / toe | `suspension.*.camberAngle/toeAngle` | 0.0 on all 62 |
| wheel width | **absent in XT** | mesh only (below) |

Five reference cars:

| car | tyre r F/R (m) | travel up/down F | travel up/down R | ride height (m) | steer (rad) | mesh tyre r (m) | tyre width F/R (m) | mesh wheelbase vs XT |
| --- | --- | --- | --- | ---: | ---: | ---: | --- | ---: |
| Corvette ZR1 | 0.356 / 0.356 | 0.17 / 0.15 | 0.17 / 0.15 | 0.526 | 1.0 | 0.351 | 0.225 / 0.288 | +0.022 m |
| Lotus Exige | 0.326 / 0.326 | 0.07 / 0.07 | 0.07 / 0.07 | 0.396 | 1.0 | 0.317 | 0.272 / 0.272 | −0.021 m |
| Dodge Challenger | 0.370 / 0.370 | 0.11 / 0.15 | 0.11 / 0.15 | 0.480 | 1.0 | 0.377 | 0.265 / 0.265 | −0.017 m |
| Ford Focus RS | 0.326 / 0.326 | 0.145 / 0.13 | 0.13 / 0.12 | 0.471 | 1.0 | 0.339 | 0.263 / 0.263 | −0.022 m |
| Audi R8 V10 | 0.326 / 0.326 | 0.0775 / 0.0775 | 0.0775 / 0.0775 | 0.404 | 1.0 | 0.337 | 0.236 / 0.238 | +0.013 m |

### 5.2 Wheels are per car; the renderer is not

The wheel **position** is already per car: `packet-adapter.js` maps each physics
wheel to the manifest corner by nearest rest translation and the manifest
carries the per-car rest matrix. The wheel **size** comes from the mesh and the
XT radius is unused by the renderer. What is fixed today is the *pose*: the
rendered wheel uses the rest matrix and an integrated spin angle only — no
suspension travel, no steer angle, no camber/caster. `state.wheels[].suspension`
is emitted by the harness (`vehicle_harness.cpp:498`) and is not consumed.

Cross-checks that hold: mesh wheelbase agrees with XT within **0.064 m** on all
60 cars with wheel evidence; mesh tyre radius within **0.023 m**. The mesh *track*
does **not** agree (up to 0.290 m on `Ford_F100_OffRoad`) because the wheel
group origin is not the track definition; track must come from XT, and the mesh
delta is recorded as diagnostic only.

### 5.3 The harness box is per car but not the body

`vehicle_harness.cpp:964-1000` already uses the car's own values:

```c
const float rideHeight = dyn.tyres.frontTyres.radius + dyn.suspension.front.movementUp;
boxDesc.m_HalfExtents = HVec3(trackWidthFront * 0.5f, tyreRadius, wheelBase * 0.5f);
```

For the Corvette that is **2.652 × 1.656 × 0.712 m**: the "height" is the tyre
radius, so a 1.246 m tall body is represented by a 0.712 m band, and the length
is the wheelbase, so the overhangs (1.782 m total) are absent. This is why the
engine-side box and the collision-side box must both be replaced by a body
envelope for body-vs-world contacts.

---

## 6. Gameplay and parity impact

### 6.1 Measured on the committed 310 m course

Method: `probes/physics/tools/measure_course.mjs` imports the committed
`probes/prop-collision/lib/resolver.mjs` and `geometry.mjs` read-only, uses
`_work/prop-collision/colliders-v2.json`, and sweeps the 1,245 measured poses at
the same yaw and ground height. Three boxes per car: fixed, axle, body. No
browser, no e1-drive change.

| car | roadside fixed | roadside axle | roadside body | all-visible fixed | all-visible axle | all-visible body |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Audi S3 Stock | 0 | 0 | 67 | 181 | 173 | 203 |
| Dodge Challenger Stock | 0 | 0 | 149 | 181 | 180 | 214 |
| Audi TT Stock | 0 | 0 | 45 | 181 | 172 | 202 |
| Ford F100 OffRoad | 0 | 0 | 125 | 181 | 181 | 212 |
| Lotus Exige Cup260 | 0 | 0 | 17 | 181 | 170 | 196 |
| VW Golf W12 | 0 | 0 | 123 | 181 | 176 | 204 |
| Ford Bronco OffRoad | 0 | 0 | 37 | 181 | 170 | 204 |
| Dodge Viper ACR | 0 | 0 | 69 | 181 | 172 | 205 |
| **Corvette ZR1** | **0** | **0** | **120** | **181** | **176** | **205** |
| Nissan Skyline R34 | 0 | 0 | 19 | 181 | 175 | 207 |
| Ford Focus RS | 0 | 0 | 19 | 181 | 178 | 204 |
| Audi R8 V10 | 0 | 0 | 110 | 181 | 176 | 205 |
| Chevrolet SoCal HHR | 0 | 0 | 0 | 181 | 175 | 205 |
| Ford FR100 | 0 | 0 | 149 | 181 | 185 | 214 |
| Ford Mustang GTR | 0 | 0 | 47 | 181 | 177 | 212 |

Counts are blocked poses out of 1,245 samples.

**Corvette body envelope, `roadside`:** 120 / 1,245 poses in three arcs —
**53.895–58.137 m**, **124.008–128.500 m**, **186.137–206.597 m**. First contact
at 53.895 m with **0.0147 m** penetration into
`river.block56.node289.draw.115.component.015`. The fixed box clears all three;
P74 already recorded the pinch at 127.5 m as **0.0657 m** clearance, which is
smaller than the +0.192 m half-width error alone.

Interpretation:

* The fixed box is **load-bearing** for the current course. Replacing it with
  the per-car body envelope makes the committed `roadside` line non-drivable for
  14 of 15 cars. This is the P66/P74 conflict again, now car-dependent: it must
  be solved by re-measuring the course or moving the props, not by shrinking the
  car back to the fixed box.
* The axle rectangle is a safe but useless envelope: it changes `all-visible`
  from 181 to 170–185 (some cars smaller, some larger than the fixed union) and
  keeps `roadside` at 0.
* `all-visible` moves 181 → 196–214 with the body: the on-course clusters are
  hit earlier, which is the expected consequence of a longer/wider car.

### 6.2 1:1 parity slice

The Corvette parity reference currently collides as a **2.98 × 1.68 m** box.
The real body is **4.434 × 2.064 m**. Head-on, the car can approach a wall
**0.727 m closer than its bumper** at each end and **0.192 m closer than its
door** at each side; a 5.02 m Challenger is 2.04 m short. This is a direct
parity error, not only a gameplay one: the visible car and the colliding car are
different shapes.

### 6.3 Power-ups use the same fixed target

`probes/e1-drive/web/powerups.js:54-63` derives
`POWERUP_TARGET_RADIUS_M = hypot(2.98/2, 1.68/2) = 1.7104677722775135 m` and uses
it for every target (Blindfire, Shunt, Barge, and the projectile envelope). The
per-car body circumradius is **2.119–2.734 m** for the 15 integrated cars
(axle circumradius 1.394–1.689 m). A Lotus and a Challenger are today the same
target volume; with per-car envelopes they differ by ~29 %.

---

## 7. Verification and determinism

`python probes/physics/tools/verify_envelope.py` → **PASS 3,289 / 3,289**,
0 failures (`_work/physics/verify.json`).

| group | checks | evidence |
| --- | ---: | --- |
| determinism | 4 | two fresh build processes (`PYTHONHASHSEED` 0/1) produce byte-identical manifests; final file equals both; in-process rebuild equals too |
| schema / coverage | 16 | 62 records; 152 unique leaf offsets; field ids inside the 154-entry table; all 152 present in 62/62; 9 typed missing fields; unit label on every leaf |
| fixed envelope | 7 | five-car derivation reproduces 2.981 / 1.676; all-62 maxima exceed it; containment counts sum to 62 |
| independent sources | 62 × 3 + 25 × 2 | 9 values + gear stack + torque curve per car equal the V1 audit; every scalar and array equals the committed `.fields` for 25 roster cars |
| per-car self-consistency | 62 × 29 | mass 600–2600 kg; wheelbase 1.9–3.7 m; tracks 1.15–2.10 m; radii 0.30–0.50 m; travel 0.02–0.40 m; steer 0.3–1.6 rad; brakes/downforce/final-drive ranges; 6+ positive gear ratios; top gear inside the stack; 10 torque / 3+3 grip points; ride height; four wheel contact points inside the axle rectangle; fixed-box containment flag equals the dimension test; harness box = track/radius/wheelbase; finite values with 8-hex raw words; offsets equal the schema |
| body envelope | 62 × 4–9 | positive extents, body > wheelbase / max track / tyre diameter, axis mapping, finite bounds, deltas recompute, mesh wheelbase within 0.10 m, mesh radius within 0.05 m, overhang recomputes |
| Scene cross-check | 17 | 15 roster cars have both a car-part and a Scene report; AABBs equal to 1e-6 |
| content hash | 2 | canonical car array hash recomputes; no `NaN`/`Infinity` in the file |

Determinism of the course measurement: two consecutive runs produce the same
`measure-course.json` SHA-256 (`13dad45a…8e082e`). No timestamp, no random seed,
no directory-iteration order is used anywhere.

`_work/physics/verify.json` — PASS, `failed: 0`, `byteIdentical: true`,
`manifest.sha256 1b034fa7…1fed80dd`.

---

## 8. Integration contract

**PHYS1 changes no consumer.** The data and the exact change list are:

| consumer | line | current | must become per car |
| --- | ---: | --- | --- |
| `probes/prop-collision/lib/collider-build.mjs` | 27 | `CAR_ENVELOPE` 2.98 × 1.68 × 1.35 | `collisionUpperBound` (or `chassisFootprint` for the axle case) passed at query time; do **not** rewrite the committed `carEnvelope` field of the existing manifests |
| `probes/e1-drive/web/prop-layer.js` | 280 | `carEnvelope ?? manifest.carEnvelope ?? {2.98,1.68,1.35}` | selected car's `collisionUpperBound`; the value is already a parameter (call site `app.js:2534`) |
| `probes/e1-drive/web/powerups.js` | 54 | one `POWERUP_CAR_ENVELOPE` and one `POWERUP_TARGET_RADIUS_M` (1.7105 m) | the **target** car's envelope and circumradius |
| `probes/e1-drive/web/sprint-layout.js` | 1500 | `options.carEnvelope` from the page | selected car's `collisionUpperBound` |
| `probes/free-roam-prop/tools/build_props.py` | 41 | `CAR = {2.98, 1.68, 1.35}` | per-car, or keep the fixed box only as a labelled worst case; duplicated in `verify_props.py:35`, `resolve_r04.mjs:41` |
| `probes/map-laps/tools/verify_map_loops.py` | 38 | `CAR_LENGTH = 2.981` | `collisionUpperBound.length`; a 2.981 m-clear lap does not clear a 5.02 m car |
| `probes/free-roam/tools/build_regions.py` | 89 | `CAR_LENGTH = 2.981`, 2.981 × 1.676 proxy | `collisionUpperBound` per car |
| `engine/harness/t005d-vehicle/vehicle_harness.cpp` | 964 | already per car (radius + movementUp; track/radius/wheelbase box) | values are correct for a chassis proxy; body contacts still need the imported composite shape |
| `probes/e1-drive/web/packet-adapter.js` | 1039 | rest-pose wheel, spin only | consume `state.wheels[].suspension` and the steer angle; use the XT radius for the spin rate |

Recommended order (main-agent owned, after this data lands):

1. **Pin the manifest.** Add `_work/physics/envelope.json` hash `1b034fa7…` to the
   E1 pins; a selected car without a `collisionUpperBound` must fail explicitly,
   never fall back to the fixed box.
2. **Replace the collision envelope, not the collider data.** Pass the per-car
   box to `createWorld(...)`/`createPropLayer(...)`; keep the committed collider
   manifest and record both the manifest hash and the per-car envelope in the
   packet/HUD diagnostics.
3. **Measure the course before enabling it.** The current `roadside` profile is
   only clear for the fixed box. Either re-measure the line with the largest
   selected car or move the four on-course clusters; do not silently widen the
   old box or drop colliders.
4. **Target volume per target.** `POWERUP_TARGET_RADIUS_M` becomes a per-car
   lookup so Blindfire/Shunt/Barge hit a Honda-sized and a Hummer-sized target
   differently.
5. **Wheel visuals.** Use the state's suspension and steer per corner, and the
   XT radius for the spin rate; the mesh gives size, XT gives radius/travel.
6. **Keep the profile switch explicit.** Record `envelopeSource:
   "collisionUpperBound"`, the manifest hash and the resulting blocked count.

Gameplay consequence if the data is adopted with (3) solved: a Hummer and a
Lotus finally collide differently (2.5 t vs 0.89 t is already per car; the
5.07 m × 2.05 m body vs 3.81 m × 1.85 m becomes per car). If (3) is not solved,
the honest outcome is a blocked 310 m line, not a silent fixed box.

---

## 9. Limits

1. **No retail collision hull.** The body AABB is the visible mesh's first
   RenderList LOD0 bounds — an upper bound that includes mirrors, spoilers and
   non-body detail, and excludes the retail composite import entirely. It is not
   `Level.levelphysics` and not a recovered hull.
2. **No physics step.** The values are the serialised XT record; no engine tick,
   tyre model, suspension solve or native/wasm parity is claimed.
3. **One pak.** All numbers come from the installed `gamedata.pak`; a different
   build is a different input hash. The XT physics handle remains unresolved, so
   surface mappings / grip scales are not applied (`surfaceMappingsApplied:false`
   in the T-007 spike).
4. **Body bounds come from three staged sources.** 25 roster cars use the
   car-part manifest, 14 C aliases use the staged manifest, 22 use the V1 Scene
   report. All three are the same first-RenderList LOD0 reader, and every
   overlapping pair agrees to 1e-6, but a car not in one of those sets is
   `absent`, not guessed (`DefaultCar`).
5. **AABB ≠ collision shape.** The `RatRod_NA_Stock` 2.996 m AABB is a mesh
   outlier; a real hull would be narrower. Consumers must label the choice.
6. **Mesh wheel track is not the XT track.** Up to 0.290 m difference because the
   wheel-group origin is not the track definition; only the wheelbase (±0.064 m)
   and radius (±0.023 m) are used as cross-checks.
7. **Units are partly unknown.** 70 leaves have no unit statement in
   `FORMAT-xt.md` or the committed consumer; they are labelled `unknown`, not
   assigned a plausible unit.
8. **Course measurement is the P74 static layer**, not retail collision and not
   a handling result. It uses the existing `roadside` / `all-visible` profiles
   and the existing 310 m line; no browser capture was made.
9. **15 vs 25.** The brief's 15 integrated cars are roster orders 0–14 (the V2
   batch-1 roster). The roster has since grown to 25; the extra 10 are reported
   as `staged-batch2` and are not part of the 15-car delta table.
10. **No consumer change and no commit** was made by PHYS1.

---

## 10. Evidence and reproduction

```powershell
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"

& $py   probes/physics/tools/build_envelope.py      # manifest + tables.md
& $py   probes/physics/tools/verify_envelope.py     # 3,289 checks, determinism
& $node probes/physics/tools/measure_course.mjs     # 310 m course impact
```

| artifact | bytes | SHA-256 |
| --- | ---: | --- |
| `_work/physics/envelope.json` | 2,719,379 | `1b034fa7ceb3217b7f7d0b57c6c3ce9205abdc8c02699d7aaac3ee6c1fed80dd` |
| `_work/physics/verify.json` | 342,962 | `cf816b9438b8fc244dda5d0a166ead79866255e06c0bbe901a7d397bdceffab0` |
| `_work/physics/measure-course.json` | 157,514 | `13dad45ac4dfb1f6b674d7c104d98bb9c45ba65a305df87f3bed6a655c8e082e` |
| `_work/physics/tables.md` | 3,080 | `9308f3540a3c76c78bfbf819fadbe0216135e421f37ca2e49c0109605bd784fe` |
| `_work/logs/physics/build.log` | 1,728 | `d4f0405479d320cb8653b89da1be2afd71a3e2208edfa10b756dfcea9a6d0901` |
| `_work/logs/physics/verify.log` | 342,962 | `cf816b9438b8fc244dda5d0a166ead79866255e06c0bbe901a7d397bdceffab0` |
| `_work/logs/physics/measure-course.log` | 157,514 | `13dad45ac4dfb1f6b674d7c104d98bb9c45ba65a305df87f3bed6a655c8e082e` |

Manifest content hash (canonical `cars[]` array):
`fbcfc86a71dc6e0f4a69cd54024c980ad13fd7350d8db6f2dab102db991e415d`.

Per-record provenance: `cars[].record.imageOffset / imageBytes / imageSha256`,
`physics.values[].imageOffset / fieldIndex / raw`, and
`physics.arrays[].descriptorOffset / component / elementOffset`. Body provenance:
`bodyEnvelope.manifest` + `manifestSha256` + `sourceChain`.

**Definition of done:** data matches the brief and its non-goals; no other
probe was modified; the gate is 3,289/3,289 with measured determinism; the
manifest and logs are hashed above; no browser or game claim is made. The shared
C++/`e1-drive` integration is a separate main-agent change.
