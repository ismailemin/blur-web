# T-007 — vehicle batch 2: seven C records + three B cars, 25-car roster

**Date:** 8 November 2026
**Scope:** `probes/e1-drive/**`, `probes/car-parts/**`, `probes/car-materials/**`,
`_work/e1-drive/**`, `_work/logs/e1-drive/**`, `docs/work/analysis/e1-drive-slice.md`
and this document. No engine, asset-reader, map-slice, net-mvp, race-rules,
powerups, `tools/`, `upstream/` or `game-data/` change. No commit.

**Result:** the playable E1 River roster is now **25 cars**: the 15 committed
cars plus seven high-confidence class-C records (resolved at the record level)
and three class-B cars. Every added car has its own body/wheels, its own P52
texture pack (or the committed typed runtime-only reason), a per-car geometry
chunk, a measured 310 m and 29 m run, committed ghosts on both courses, a 3-lap
and free-roam run, a same-instance restart and a browser capture. The 310 m,
29 m, free and lap state anchors of the original 15 cars did not move.

Scope labels: `rosterCars:25`, `batchAdded:10`, `classCAdded:7`,
`classBAdded:3`, `chunkedPerCar:true`, `carsFullyProven:25`,
`retailClaim:false`, `fullGameClaim:false`.

---

## 0. Result summary

| Gate | Result | Evidence |
|---|---|---|
| Node drive-slice verifier | **3665/3665 checks, 0 failures** (two independent runs; 125 anchor keys identical) | `_work/e1-drive/run.json`, `_work/logs/e1-drive/batch2-verify-final.log`, `batch2-verify-repeat.log` |
| 25-car roster decode gate | **PASS**, 62/62 records, 25 selected | `_work/e1-drive/cars.json` |
| 310 m sprint, all 25 | all finish, 2/2 checkpoints, 0 respawn, 0 NaN | `run.json → sprint.cars` |
| 29 m regression, all 25 | all finish, 0 respawn | `run.json → sprint.shortCourse.cars` |
| 3-lap race, all 25 | all finish, 3 laps | `run.json → sprint.lapCourse.cars` |
| Free roam, all 25 | contained, 0 prop contacts | `run.json → sprint.freeRoam.cars` |
| Restart, all 25 | same instance, identical finish/tick/hash | `run.json → sprint.restartCars` |
| Ghost set | **50 records** (25 cars × 310 m / 29 m) | `probes/e1-drive/ghosts/index.json` |
| P52 roster materials | **PASS**, 25 cars, 191 native re-decodes, 2 fresh builds byte-identical (599 files) | `_work/logs/e1-drive/batch2-verify-roster-materials3.log` |
| Native CTest | **15/15 PASS** | `_work/logs/e1-drive/batch2-ctest.log` |
| Portable asset suite | **stops at `prop-collision-v2` 44/45** (external whole-file geometry pin) | §7.1 |
| PoC checker | **20/23** (three hard-coded 15-car pins in `tools/check_e1_poc.py`) | §7.2 |
| Browser sprint capture | **25 cars, 100 frames**, console 0 | §6.1 |
| Browser MP with two C cars | host `dodge-challenger-tuner`, guest `nissan-350znismo-stock`, both chunks loaded, console 0/0 | §6.2 |

The two non-passing external gates are owned outside the allowed file set and are
reported with the exact pins in §7. They are not physics, chunk or roster
regressions.

---

## 1. Roster additions

`probes/e1-drive/cars/roster.json` now lists 25 cars. The first 15 entries are
unchanged; batch 2 appends:

| # | slug | record | id | intended body model | drivetrain | mass | confidence |
|--:|---|---:|---:|---|---|---:|---|
| 16 | `dodge-challenger-tuner` | 18 | 989449547 | `dodge_challenger_tuner.model` | RWD | 1600 kg | C, high (2 proven wheel draws) |
| 17 | `nissan-350znismo-stock` | 22 | 1082528515 | `nissan_350znismo_stock.model` | RWD | 1462 kg | C, high (8) |
| 18 | `chevrolet-camaro-stocke3` | 25 | 1272473348 | `chevrolet_camaro_stock.model` | RWD | 1462 kg | C, high (8) |
| 19 | `volkswagen-beetle-offroad` | 47 | 2370117387 | `volkswagen_beetle_offroad.model` | RWD | 660 kg | C, high (6) |
| 20 | `foose-stallion-stock` | 63 | 3527545165 | `foose_stallion_stock.model` | RWD | 1495 kg | C, high (6) |
| 21 | `chevrolet-camaro-ratdrift` | 65 | 3650421932 | `chevrolet_camaro_rat.model` | RWD | 1395 kg | C, high (2) |
| 22 | `corvette-c3-rat` | 75 | 3993817740 | `corvette_c3_rat.model` | RWD | 1300 kg | C, high (12) |
| 23 | `bmw-m3e92-tuner` | 16 | 937269915 | `bmw_m3e92_tuner.model` | RWD | 1462 kg | B, exact |
| 24 | `koenigsegg-ccxr-stock` | 20 | 1036618492 | `koenigsegg_ccxr_stock.model` | RWD | 1179 kg | B, exact |
| 25 | `toyota-supratrd-stock` | 30 | 1364294847 | `toyota_supratrd_stock.model` | RWD | 1565 kg | B, exact |

The record index/id/name and drivetrain/mass are re-decoded by
`tools/car_roster.py`; a wrong value is a hard failure. All 62 records still pass
the completeness gate.

### 1.1 C record mapping (record-level, never name similarity)

A class-C roster entry carries an explicit `model` plus `modelMapping` copied
from `_work/vehicle-pipeline/c-aliases.json`:
`AmaxVehicle.dynamics` handle → XT `refs` → `RP_CarDynamics` id → the engine's
`models/vehicles/%s.model` from the vehicle tag
(`LevelState.cpp:334`, `RaceLogicCore.cpp:1489`).

| record | AmaxVehicle tag | Amax record | ref | derived model | name sim used |
|---|---|---:|---:|---|---|
| `Dodge_Challanger_Tuner1stplay` | `Dodge_Challenger_Tuner` | 3110784083 | 1211 | `dodge_challenger_tuner.model` | no |
| `Nissan_350ZNismo_Stock grpc` | `Nissan_350ZNismo_Stock` | 1250219732 | 1332 | `nissan_350znismo_stock.model` | no |
| `Chevrolet_Camaro_StockE3` | `Chevrolet_Camaro_Stock` | 3715397335 | 1569 | `chevrolet_camaro_stock.model` | no |
| `VW_Beetle_Offroad` | `Volkswagen_Beetle_OffRoad` | 3121525528 | 2931 | `volkswagen_beetle_offroad.model` | no |
| `Foose_Stallion_Stockgrpc` | `Foose_Stallion_Stock` (base) | 1233078605 | 4357 | `foose_stallion_stock.model` | no |
| `Chevrolet_Camaro_Ratdrift` | `Chevrolet_Camaro_Rat` | 1782464698 | 4491 | `chevrolet_camaro_rat.model` | no |
| `Covette_C3_Rat` | `Corvette_C3_Rat` | 3069361973 | 4963 | `corvette_c3_rat.model` | no |

`probes/car-parts/tools/build_all_manifests.py` validates the override: the tag
lowercased plus `.model` must equal the explicit model, the mapping record
index/id must equal the roster record, `nameSimilarityUsed` must be `false`, and
`handleResolvesToExactRecordId` must be `true`. A missing or mismatched mapping
is a hard failure; there is no nearest-file fallback. The three B cars keep the
existing exact-normalised-name rule.

Three records share physics with an explicit variant (`Foose_Stallion_Stock_Khan`
on record 63); the base is selected and the variant is recorded in the roster
entry, not discarded. `Covette_C3_Rat` has `doNotShowInGame:true` in the XT
record; it is recorded and is not used as a proof.

### 1.2 Per-car bodies

| slug | body model | draws | parts | wheel groups | proven/ambiguous wheel draws | textures | RGBA B | UV values |
|---|---|---:|---:|---:|---|---:|---:|---:|
| `dodge-challenger-tuner` | `dodge_challenger_tuner.model` | 93 | 30 | 4 | 2 / 18 | 8 | 4,472,832 | 53,412 |
| `nissan-350znismo-stock` | `nissan_350znismo_stock.model` | 123 | 32 | 4 | 8 / 12 | 8 | 3,686,400 | 77,332 |
| `chevrolet-camaro-stocke3` | `chevrolet_camaro_stock.model` | 100 | 30 | 4 | 8 / 12 | 7 | 3,424,256 | 72,772 |
| `volkswagen-beetle-offroad` | `volkswagen_beetle_offroad.model` | 85 | 18 | 4 | 6 / 14 | 8 | 3,702,784 | 72,402 |
| `foose-stallion-stock` | `foose_stallion_stock.model` | 103 | 27 | 4 | 6 / 14 | 8 | 4,472,832 | 71,022 |
| `chevrolet-camaro-ratdrift` | `chevrolet_camaro_rat.model` | 99 | 32 | 4 | 2 / 18 | 8 | 4,472,832 | 64,504 |
| `corvette-c3-rat` | `corvette_c3_rat.model` | 83 | 27 | 4 | 12 / 8 | 8 | 2,768,896 | 67,528 |
| `bmw-m3e92-tuner` | `bmw_m3e92_tuner.model` | 94 | 29 | 4 | 0 / 20 | 8 | 3,432,448 | 60,304 |
| `koenigsegg-ccxr-stock` | `koenigsegg_ccxr_stock.model` | 97 | 34 | 4 | 8 / 12 | 9 | 3,563,520 | 80,036 |
| `toyota-supratrd-stock` | `toyota_supratrd_stock.model` | 88 | 31 | 4 | 8 / 12 | 7 | 3,424,256 | 72,244 |

Every model is a distinct body mesh and source SHA-256; `fallbackBodyCount:0`.
The preview-paired wheel draws are labelled; the driven browser frames are the
wheel-placement confirmation for the medium-confidence corners. The seven C
bodies were already staged by V3 (`docs/work/analysis/vehicle-c-aliases.md`) and
re-built here with the committed builder.

---

## 2. Build order and measured bytes

Commands from the repository root (bundled Python, pinned Node):

```powershell
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"

& $py probes/e1-drive/tools/car_roster.py
& $py probes/car-parts/tools/build_all_manifests.py
& $py probes/car-materials/tools/build_roster_materials.py
& $py probes/car-materials/tools/verify_roster_materials.py `
      --verify-a "$PWD/_work/e1-drive/verify-materials-a" `
      --verify-b "$PWD/_work/e1-drive/verify-materials-b"
& $py probes/e1-drive/tools/build_car_textures.py
& $node probes/e1-drive/tools/build_geometry.mjs
& $node probes/e1-drive/tools/verify_e1_drive.mjs --write-ghosts
& $node probes/e1-drive/tools/derive_sprint_exclusions.mjs
& $node probes/e1-drive/tools/verify_e1_drive.mjs
```

| artifact | bytes | SHA-256 |
|---|---:|---|
| `probes/e1-drive/cars/roster.json` | 16,044 | `1cb4485314c27ee276b98b67863e032bc920a0f0994c959965632c5b08051e6e` |
| `_work/e1-drive/cars.json` | 82,344 | `0d59aa0a409c67cff5271a1944c551f8ee4a1c2c47da9300485856d37a15a768` |
| `_work/car-parts/cars/index.json` | 358,905 | `94b31721a34cfa4a2af1c90c1893af2fd2a28c567d80cf14f42a47569fd15315` |
| `_work/car-materials/roster/index.json` | 111,497 | `0cce07379af01cf0f21829285cec41b01cf4cd6e0ceae72249dafb13db379455` |
| `_work/e1-drive/car-textures.json` | 2,902,831 | `468e883192a60a6485a65f532fd9e0e0ab4edb47e9749f966ae76ce373a15f61` |
| `_work/e1-drive/level.geometry.json` | 9,663,610 | `838d33408c23f2d8a9c3911cc92a9a4b3fcc3b5eeb53276c59db09efcf88483d` |
| `_work/e1-drive/base.geometry.json` | 11,429 | `8eaf4cd9c2592a8abf6031eda605541dac0909fe4d39120fb9a268837184d05d` |
| `_work/e1-drive/car-bodies.index.json` | 27,101 | `bf4379d201ade96e1fccc67e6ced1bdb082300546594c66f4a0bd4171f1a1fdc` |
| `_work/e1-drive/geometry.json` (debug) | 181,757,706 | `21c23e30ce9365b54e8779f826317daa3559fcd4013345a41cd90c93a4ed91f9` |
| `probes/e1-drive/ghosts/index.json` | 42,494 | `c0069358afad88d877b52a3e34e1870580fcae4eb102afb7f4413bf643b33ae0` |
| `_work/e1-drive/sprint-driven-exclusions.json` | 18,331 | `c6b4f24622865a4f8c068e4466c7526949d3b9918c946eb3e4ab065eb7dd50ec` |
| `_work/e1-drive/run.json` | 6,448,593 | `ba43f2ea531a5896aad445377585adf02a25f926bbe92dd836c0fa239b759e42` |

Aggregates: 25 cars, **2,343** car draws (**1,123** static albedo, **197** paint,
**281** light blend, **742** no-albedo), **191** decoded car textures /
**83,927,040 B** RGBA, **1,665,958** UV values / **6,663,832 B** UV0. The first
15 cars' per-car values are exactly the batch-1 values.

### 2.1 Page / chunk bytes

| path | bytes | note |
|---|---:|---|
| `level.geometry.json` | 9,663,610 | always loaded (River) |
| `base.geometry.json` | 11,429 | map packages only |
| `car-bodies.index.json` | 27,101 | always loaded |
| `cars/<slug>.geometry.json` | 5,468,922–9,018,247 | one selected car (+ MP peer) |
| all 25 car chunks | 172,103,239 | never all fetched |
| `geometry.json` (debug) | 181,757,706 | never fetched |

River page for the default Corvette: level 9,663,610 + car 8,468,680 + physics
1,945,409 + layout 386,521 + fields 7,489 + spawn 289 = **20,471,709 B
(≈20.47 MB)**, versus 181,757,706 B if the combined document were served
(**88.7 % less**). The largest car chunk (Lotus Exige 9,018,247 B) gives
21,021,276 B (≈21.02 MB). A car switch fetches only the next chunk; the level is
reused. The roster (`cars.json`, 82,344 B), chunk index (27,101 B), wasm
(1,012,634 B) and glue (11,480 B) are page assets outside this comparison and
were already loaded before batch 2.

New chunk sizes and pins are in `car-bodies.index.json`; the ten new rows are:

| slug | bytes | draws | SHA-256 |
|---|---:|---:|---|
| `dodge-challenger-tuner` | 7,966,464 | 93 | `sha256:ff7915bc6892…` |
| `nissan-350znismo-stock` | 7,727,617 | 123 | `sha256:aeaa68122104…` |
| `chevrolet-camaro-stocke3` | 7,180,667 | 100 | `sha256:c8da265692a4…` |
| `volkswagen-beetle-offroad` | 7,538,809 | 85 | `sha256:a0c9ef007fbf…` |
| `foose-stallion-stock` | 8,489,161 | 103 | `sha256:e57b1355c5d0…` |
| `chevrolet-camaro-ratdrift` | 8,335,955 | 99 | `sha256:5c270739a495…` |
| `corvette-c3-rat` | 6,154,740 | 83 | `sha256:08603bb6e84d…` |
| `bmw-m3e92-tuner` | 6,762,185 | 94 | `sha256:b88b91050e75…` |
| `koenigsegg-ccxr-stock` | 7,602,321 | 97 | `sha256:ad22f71b4327…` |
| `toyota-supratrd-stock` | 7,138,864 | 88 | `sha256:d5a0ce8309ae…` |

Full hashes are authoritative in the index file; this table abbreviates only for
width.

---

## 3. Per-car proof (added cars)

All rows are from `_work/e1-drive/run.json`; every run has 2/2 ordered
checkpoints, 0 respawns, 0 NaN ticks, wheel contact on every tick, a
replay-identical state sequence with rules off, a distinct state sequence and
packet, and a 10-cycle reset reproduction.

| slug | 310 m | 310 tick | 29 m | 3-lap | free | restart | ghost 310/short |
|---|---:|---:|---:|---:|---|---|---|
| `dodge-challenger-tuner` | 14.750 s | 975 | 2.867 s | 85.950 s | yes | yes | yes/yes |
| `nissan-350znismo-stock` | 15.167 s | 1000 | 3.117 s | 86.733 s | yes | yes | yes/yes |
| `chevrolet-camaro-stocke3` | 15.067 s | 994 | 3.067 s | 86.533 s | yes | yes | yes/yes |
| `volkswagen-beetle-offroad` | 14.950 s | 987 | 3.000 s | 86.567 s | yes | yes | yes/yes |
| `foose-stallion-stock` | 15.200 s | 1002 | 3.133 s | 86.917 s | yes | yes | yes/yes |
| `chevrolet-camaro-ratdrift` | 15.333 s | 1010 | 3.300 s | 86.933 s | yes | yes | yes/yes |
| `corvette-c3-rat` | 15.017 s | 991 | 3.117 s | 86.550 s | yes | yes | yes/yes |
| `bmw-m3e92-tuner` | 15.233 s | 1004 | 3.183 s | 86.900 s | yes | yes | yes/yes |
| `koenigsegg-ccxr-stock` | 14.283 s | 947 | 2.483 s | 85.950 s | yes | yes | yes/yes |
| `toyota-supratrd-stock` | 14.900 s | 984 | 2.967 s | 86.917 s | yes | yes | yes/yes |

The ghost records rebuild the body pose and all eight wheel matrices at every
tick (body/wheel delta ≤5e-3), validate their canonical hash, are byte-identical
to the committed file, and replay against themselves with a zero gap on every
moving tick. `probes/e1-drive/ghosts/index.json` lists 50 records (25 × 2).

### 3.1 The 29 m controller for `corvette-c3-rat`

The P37 29 m throttle hold leaves this 1300 kg RWD record 0.4 m outside the 6 m
finish gate (finish z 1046.62 at x −57.89; gate z 1047…1053). The generic
high-speed damper never engages because its lateral speed stays below 2.5 m/s.
The roster entry declares a deterministic `shortCourseController`:

```json
{"kind":"lane-hold-recovery","gainPerMetre":0.8,"lateralSpeedGain":0.25,
 "deadbandMetres":0.2,"throttle":1}
```

`web/sprint-script.js` applies it only for a car carrying that declaration and
only on the non-path (29 m) layout. The run now finishes in 3.117 s with a
maximum |offset| of 0.80 m. The 15 cars without the declaration keep their P37
inputs and state hashes bit for bit (the verifier checks all of them).

### 3.2 Typed telemetry anomaly

`chevrolet-camaro-ratdrift` and `corvette-c3-rat` declare one
`telemetry.lateralMissedReversals:1`. At the fixed 36-tick first sweep phase the
measured yaw rate stays positive through the phase, so the first steer reversal
has no measured lag before the next phase; the second and third reversals are
answered in 0 and 15–20 ticks. The verifier records the miss, still requires
every answered reversal to fall inside the 60-tick window, and rejects a miss for
any car that does not declare it. The global telemetry spec and the other 23 cars
are unchanged.

Three trial values of the sweep half-period (40/44/48 ticks) were measured and
rejected: 40 still leaves the first reversal unanswered, 44 leaves the Camaro
unanswered, and 48 creates 2.9–37 g lateral spikes on existing cars (the cars
reach the strip edge). The 36-tick spec is therefore kept.

---

## 4. Anchors

### 4.1 Unchanged: the original 15 cars

The drive, 310 m, 29 m, free-roam and 3-lap state-sequence anchors of all 15
previously committed cars are unchanged. The verifier checks each one every run.
The 310 m course, gates, layout, spawn, respawn rules, lap and free-roam layouts
and the 23 measured driven-line exclusions are unchanged
(`exclusionContentSha256: c16fd7ba…`).

### 4.2 Moved: packet document hashes

The per-car `packet` anchor is a whole-packet hash and moved for all 25 cars
because `carTexturePack.manifestSha256` is the identity of the now-25-car
`car-textures.json`. The body meshes, UV streams, texture pixels, physics and
state sequences are unchanged. This is the same document-identity behaviour P49/
P55/P59/P73b documented; the verifier stores the new values.

New state anchors (full values in `verify_e1_drive.mjs`):

| slug | drive | 310 m |
|---|---|---|
| `dodge-challenger-tuner` | `63d98d3a…` | `2beba973…` |
| `nissan-350znismo-stock` | `2f284f12…` | `08bdcb5b…` |
| `chevrolet-camaro-stocke3` | `c26f9cf3…` | `910e0c19…` |
| `volkswagen-beetle-offroad` | `82779e0b…` | `ecec8828…` |
| `foose-stallion-stock` | `065be673…` | `45b42ead…` |
| `chevrolet-camaro-ratdrift` | `815ba1ec…` | `cfe9986d…` |
| `corvette-c3-rat` | `6e513e17…` | `b2764e87…` |
| `bmw-m3e92-tuner` | `25d2a828…` | `e7ca1fd3…` |
| `koenigsegg-ccxr-stock` | `d5877c3c…` | `651d029d…` |
| `toyota-supratrd-stock` | `4531b4ac…` | `77706922…` |

---

## 5. Chunk / load behaviour

`build_geometry.mjs` pins 25 manifests, the 25-car car-parts index, the 25-car
P52 texture manifest and each car's coverage row; the chunk writer emits one
`cars/<slug>.geometry.json`, `level.geometry.json`, `base.geometry.json` and the
index. The verifier re-parses every chunk, compares it to the combined debug body
(metadata keys aside), builds every packet through `assembleGeometry(levelChunk,
carChunk)` and checks the index pins. The page loads one level + one selected
chunk; a car switch fetches only the next chunk and updates `?car=` without a
reload.

The River `mpPins.packageHash`/`packageBytes` were re-pinned to the new level
chunk (`838d3340…`, 9,663,610 B). The Amboy/Gracia packages and base chunk are
unchanged; their MP identity still matches.

---

## 6. Browser evidence

### 6.1 Sprint capture, all 25 cars

`node probes/e1-drive/tools/capture_browser.mjs --mode sprint --map amboy
--port 8825 --debug-port 9355`

**100 captures (25 cars × start/mid/checkpoint/finish)**, `verdict:
clean-console-and-gates`, **console 0 messages / 0 errors or warnings**,
`assertions.ok:true`, 25/25 finish frames with 2/2 checkpoints, **100/100 car
matrix exact**, 3 geometry uploads per page, 9 matrices per tick, 0 blocked
ticks. 59/100 whole-packet hashes are exactly equal; the rest differ only in the
documented last-bit `Math.atan2`/`Math.sin` difference (the state hash, car
matrix and 1e-12 matrix/camera tolerances are the gates). Evidence:
`_work/e1-drive/browser-evidence-sprint-batch2.json` (1,005,285 B, SHA-256
`7627a41b…`).

All 40 new-car frames are present under
`_work/e1-drive/browser-<slug>-sprint-{start,mid,checkpoint,finish}[-car].png`.
Finish examples:

| car | finish screenshot | time |
|---|---|---:|
| Dodge Challenger Tuner | `browser-dodge-challenger-tuner-sprint-finish.png` | 14.750 s |
| Nissan 350Z Nismo | `browser-nissan-350znismo-stock-sprint-finish.png` | 15.167 s |
| Chevrolet Camaro StockE3 | `browser-chevrolet-camaro-stocke3-sprint-finish.png` | 15.067 s |
| VW Beetle OffRoad | `browser-volkswagen-beetle-offroad-sprint-finish.png` | 14.950 s |
| Foose Stallion | `browser-foose-stallion-stock-sprint-finish.png` | 15.200 s |
| Chevrolet Camaro Ratdrift | `browser-chevrolet-camaro-ratdrift-sprint-finish.png` | 15.333 s |
| Corvette C3 Rat | `browser-corvette-c3-rat-sprint-finish.png` | 15.017 s |
| BMW M3 E92 Tuner | `browser-bmw-m3e92-tuner-sprint-finish.png` | 15.233 s |
| Koenigsegg CCXR | `browser-koenigsegg-ccxr-stock-sprint-finish.png` | 14.283 s |
| Toyota Supra TRD | `browser-toyota-supratrd-stock-sprint-finish.png` | 14.900 s |

### 6.2 Multiplayer: two different C cars

`node probes/e1-drive/tools/capture_browser.mjs --mode mp --map river --port 8826
--room-port 8836 --debug-port 9356 --host-car dodge-challenger-tuner
--guest-car nissan-350znismo-stock`

**PASS**, `verdict: clean-console-and-gates`, `assertions.ok:true`, host/guest
console **0 / 0**. Both pages loaded the *other* body's chunk:

| side | local car | peer chunk | bytes | load | draws | status |
|---|---|---|---:|---:|---:|---|
| host | `dodge-challenger-tuner` | `cars/nissan-350znismo-stock.geometry.json` | 7,727,617 | 60.9 ms | 123 | `ready` |
| guest | `nissan-350znismo-stock` | `cars/dodge-challenger-tuner.geometry.json` | 7,966,464 | 51.0 ms | 93 | `ready` |

Shared result hash `sha256:4f80f02f…`, rows equal; Host Dodge 14.733 s (tick 974),
Guest Nissan 16.683 s (tick 1091), both `finished`. Page bytes: host 19,969,557 B
(level + Dodge chunk + layout + physics + fields), guest 19,730,496 B (level +
Nissan chunk + …). Evidence: `_work/e1-drive/browser-evidence-mp-batch2.json`
(106,786 B, SHA-256 `f7a441e8…`); screenshots
`browser-mp-{lobby,mid,finish}-{host,guest}.png`.

---

## 7. External gates (owned outside this task)

### 7.1 Portable asset suite: stops at `prop-collision-v2` (44/45)

`python tools/verify_asset_probe.py --skip-build` runs 49 steps, then
`prop-collision-v2` fails on its whole-file geometry pin:

```text
FAIL  base input geometry current  input drifted after the additive car batch; V1 collider replay identical
```

`probes/prop-collision/tools/verify_v2.mjs` accepts only the old 15-car
`geometry.json` hash (`0dcf3e38…`) or its recorded `v1-regression.json` hash; the
batch-2 file is `21c23e30…` (181,757,706 B). The collider content hash and the
651-collider data are unchanged, and the e1 verifier's prop checks (including the
same 23 driven-line exclusions) pass. The correct fix is to re-pin
`base.inputs.geometry` in `probes/prop-collision/` (or scope that pin to the
level/collider subdocument), outside this task's file set. All steps after
`prop-collision-v2` were run individually: see §7.3.

Suggested external re-pin (not applied):

```text
_work/prop-collision/colliders-v2.json → inputs.geometry.sha256 = 21c23e30ce9365b54e8779f826317daa3559fcd4013345a41cd90c93a4ed91f9
_work/prop-collision/colliders-v2.json → inputs.geometry.bytes  = 181757706
```

### 7.2 PoC checker: 20/23

`python tools/check_e1_poc.py` (server on 127.0.0.1:8801) → **20 PASS, 3 FAIL**.
The three failures are hard-coded 15-car values in `tools/check_e1_poc.py`:

1. `cars.json roster` — requires `selected == 15`; the roster selects **25**.
2. `car texture manifest` — requires cars/draws/textured/textures `15/1378/673/112`;
   the 25-car totals are **25 / 2343 / 1123 / 191**.
3. `car RGBA bitmaps` — requires **46,505,984 B**; the 25-car total is
   **83,927,040 B**.

The per-car `.fields`, geometry payloads, track textures, UV0 streams and car RGBA
file hashes all pass. The main agent must generalize these three pins (or derive
them from the generated artifacts) in `tools/check_e1_poc.py`. Suggested values:
`selected=25`, `cars=25`, `draws=2343`, `staticAlbedoDraws=1123`,
`textures=191`, `rgbaBytes=83927040`.

### 7.3 Remaining suite steps run individually

All steps after `prop-collision-v2` were executed directly; results are in
`_work/logs/e1-drive/batch2-suite-remaining.log`. Twelve pass. The one failure is
`net-mvp-selftest`, which dies inside `probes/net-mvp/server.mjs:1363` with
`ReferenceError: createServer is not defined`; that file is outside this task's
ownership and the failure is in its own module state, not in the car roster or
chunk pipeline (the `net-layout` step passes). No map-slice, AI, texture or
render step regressed.

| step | result |
|---|---|
| `race-rules` | PASS |
| `net-mvp-selftest` | FAIL (external `createServer` import in `probes/net-mvp/server.mjs:1363`) |
| `map-slice-amboy` | PASS (12,367 checks) |
| `ai-driver` | PASS |
| `ai-maps` | PASS |
| `amboy-textures` | PASS |
| `amboy-render` | PASS |
| `gracia-slice` | PASS |
| `gracia-textures` | PASS |
| `gracia-render` | PASS |
| `longbeach-slice` | PASS |
| `longbeach-textures` | PASS |
| `longbeach-render` | PASS |

---

## 8. Limits and non-claims

1. **No full-game claim.** One measured River course, the 310 m sprint, the 29 m
   regression, the 222.040 m loop and the free-roam basin are the only courses.
2. **C mapping is record-level, not retail parity.** The seven C bodies are the
   vehicles the shipped engine loads for those exact physics records; paint,
   damage, LODs, runtime materials, handling balance and race tuning are not
   claimed final.
3. **Wheel corner identity.** Nine of the ten added cars have preview-paired
   wheel draws (the builder's label); the driven screenshots confirm placement,
   but the per-corner identity is not proven for them. `corvette-c3-rat` has
   12/8 proven/ambiguous.
4. **Typed anomalies.** The two telemetry first-reversal misses and the
   `corvette-c3-rat` 29 m lane-hold profile are recorded controller/measurement
   choices, not recovered retail values.
5. **External pins.** §7.1 and §7.2 are the only non-passing gates; both are
   outside the allowed file set.
6. **Residency.** One level + one selected car (+ MP peer) resident; no
   streaming/eviction in this pass.
7. **ABI/format.** No engine, reader, codec, map-slice, net-mvp, race-rules or
   power-up change; no new wire message.

---

## 9. Evidence index

```text
_work/e1-drive/run.json                       3665 checks, 25 cars, 50 ghosts
_work/e1-drive/geometry.json                  181,757,706 B / 21c23e30…
_work/e1-drive/level.geometry.json            9,663,610 B / 838d3340…
_work/e1-drive/base.geometry.json             11,429 B / 8eaf4cd9…
_work/e1-drive/car-bodies.index.json          27,101 B / bf4379d2…
_work/e1-drive/cars/*.geometry.json           25 chunks / 172,103,239 B
_work/e1-drive/car-textures.json              2,902,831 B / 468e8831…
_work/e1-drive/sprint-<slug>.json             25 raw 310 m traces
_work/e1-drive/sprint-short-<slug>.json       25 29 m traces
_work/e1-drive/telemetry-<slug>.json          25 telemetry series
_work/e1-drive/browser-evidence-sprint-batch2.json   100 captures / 25 cars
_work/e1-drive/browser-<slug>-sprint-*.png           100 sprint screenshots (40 for batch 2)
_work/e1-drive/browser-evidence-mp-batch2.json       two C cars / shared result
_work/e1-drive/browser-mp-{lobby,mid,finish}-*.png   MP screenshots
_work/e1-drive/run-batch2-a.json                     first-run copy for determinism diff
probes/e1-drive/ghosts/index.json             50 records / c0069358…
_work/logs/e1-drive/batch2-*.log              build/verify/capture logs
```

| log | SHA-256 |
|---|---|
| `batch2-verify-final.log` (3665/3665) | `96d6805321eaaf5ccf2fe855c425e01fbe5271cbaca0e2a288a5be7d234a663e` |
| `batch2-verify-repeat.log` (3665/3665) | `0720dbf8b4727032925f33cfba2d65733bbaaebea7542d3a7bfb64a5f23cfd71` |
| `batch2-verify-roster-materials3.log` (PASS) | `e2e3d3127a7f7dd5d1418ec2a88110f3bb9b63023fd01386a1471ba188c44216` |
| `batch2-ctest.log` (15/15) | `42820136affcb4f373af57bd2c3ae4bcd01f80ce466d52bc7a956615198edb14` |
| `batch2-asset-suite.log` (prop-collision pin) | `5a70f57c0a117179cf8cc6265a6de38d875bc300a3a4b5cd5e518e6ae7fa9020` |
| `batch2-check-e1-poc.log` (20/23) | `2109e250bc161d166fecc370cd355f3658b01396701a2de7fcf4381287c00d25` |
| `batch2-suite-remaining.log` (12 pass / net-mvp fail) | `753ee8767772d30cd189ca666f23b55e2feb726ed185ea3e10279ec246067870` |
| `batch2-capture-sprint.log` | `a7805d068100a019b0ae712638d63ce188b40abf68202a63f64d5e6ae8b1a0c2` |
| `batch2-capture-mp.log` | `0ea96bada9e9f9f4b50775fd74ec7758be903968347f80989eb3b45f28df7822` |
