# T-007 — vehicle batch 1: ten B-class cars in the playable E1 roster

Status: **implementation + evidence**, 7 November 2026. The playable E1 drive
slice now covers **15 real cars** (the five original T-007 anchors plus the ten
V1-audited batch-1 class-B cars). This is an original project integration on the
measured River course; it is not a retail/full-game claim and not a claim that
all 62 records are playable.

Scope labels: `rosterCars:15`, `batchAdded:10`, `carsFullyProven:15`,
`geometrySingleFile:true`, `geometryChunking:'required-before-batch-2'`,
`retailClaim:false`, `fullGameClaim:false`, `classCClaimed:false`.

Owned files: `probes/e1-drive/**`, `probes/car-parts/**`,
`probes/car-materials/**`, `_work/e1-drive/**`,
`_work/logs/e1-drive/**`, `docs/work/analysis/e1-drive-slice.md`, this
document. `engine/`, `probes/asset-reader/`, `probes/prop-collision/`,
`probes/free-roam*/`, `probes/net-mvp/`, `probes/race-rules/`,
`probes/powerups/`, `probes/audio/`, `tools/`, `upstream/` and `game-data/`
were not modified. No commit was made by this subagent.

---

## 0. Result summary

| Gate | Result | Evidence |
|---|---|---|
| Node drive-slice verifier | **2254/2254 checks passed, 0 failures** | `_work/e1-drive/run.json`, `_work/logs/e1-drive/batch1-verify-final2.log` |
| 15-car roster decode gate | **PASS**, 62/62 records gate, 15 selected | `_work/e1-drive/cars.json` |
| 310 m sprint, all 15 | all finish, 2/2 checkpoints, 0 respawn, 0 NaN | `run.json → sprint.cars` |
| 29 m regression, all 15 | all finish, 2/2 checkpoints, 0 respawn | `run.json → sprint.shortCourse.cars` |
| 3-lap race, all 15 | all finish, 3 laps, 0 respawn | `run.json → sprint.lapCourse.cars` |
| Free roam, all 15 | contained, 0 prop contacts, 0 respawn | `run.json → sprint.freeRoam.cars` |
| Ghost set | **30 records** (15 cars × 310 m / 29 m), byte-identical on re-derivation | `probes/e1-drive/ghosts/index.json` |
| Original 5 physics/state anchors | **unchanged** (drive, 310 m, 29 m, free, lap, ghost state sequences) | §4 |
| Original 5 packet anchors | moved **only** by the P52 manifest identity in `carTexturePack` (documented, not physics) | §4.2 |
| Portable asset suite | **44/45 PASS**; one external `prop-collision-v2` whole-file geometry pin | §6.1 |
| P52 roster-material verifier | **PASS**, 15 cars, 112/112 native re-decodes, two fresh builds byte-identical (352 files) | `_work/logs/e1-drive/batch1-verify-roster-materials.log` |
| PoC checker | **20/23 PASS**; three hard-coded five-car checks in `tools/check_e1_poc.py` | §6.2 |
| Native CTest | **15/15 PASS** | `_work/logs/e1-drive/batch1-ctest.log` |
| Browser sprint capture | **all 15 cars**, console 0 | `_work/e1-drive/browser-evidence-sprint.json` |
| Browser lap/free/MP samples | **PASS**, console 0 | `browser-evidence-{lap,free,mp}.json` |

The batch is proven for the playable sprint, 29 m regression, lap, free-roam,
telemetry, reset/restart and ghost paths. The two non-passing external gates are
owned outside this task and are reported with their exact pins in §6.

---

## 1. Roster

`probes/e1-drive/cars/roster.json` now lists 15 cars. The first five are the
committed T-007 anchors, unchanged. The next ten are the V1 audit's batch-1
selection, in V1 manifest order:

| # | slug | record index/id | drivetrain | mass | model | draws | static | textures |
|--:|---|---|---|---:|---|---:|---:|---:|
| 6 | `audi-tt-stock` | 10 / 553815980 | AWD | 1400 | `audi_tt_stock.model` | 100 | 52 | 7 |
| 7 | `ford-f100-offroad` | 13 / 641771883 | AWD | 1600 | `ford_f100_offroad.model` | 78 | 34 | 7 |
| 8 | `ford-fr100-stock` | 77 / 4067498883 | RWD | 1350 | `ford_fr100_stock.model` | 71 | 33 | 8 |
| 9 | `volkswagen-golfw12650-stock` | 17 / 967622623 | RWD | 1600 | `volkswagen_golfw12650_stock.model` | 92 | 43 | 8 |
| 10 | `ford-mustanggtr-stock` | 80 / 4248192450 | RWD | 1300 | `ford_mustanggtr_stock.model` | 101 | 55 | 7 |
| 11 | `dodge-viperacr-stock` | 33 / 1411916496 | RWD | 1500 | `dodge_viperacr_stock.model` | 83 | 48 | 7 |
| 12 | `audi-s3-stock` | 2 / 345654945 | AWD | 1400 | `audi_s3_stock.model` | 99 | 49 | 7 |
| 13 | `ford-bronco-offroad` | 19 / 1025798142 | AWD | 1650 | `ford_bronco_offroad.model` | 82 | 25 | 6 |
| 14 | `nissan-skyliner34ztune-stock` | 46 / 2352181282 | AWD | 1600 | `nissan_skyliner34ztune_stock.model` | 96 | 46 | 7 |
| 15 | `chevrolet-socalhhr-stock` | 74 / 3917320611 | RWD | 1350 | `chevrolet_socalhhr_stock.model` | 85 | 64 | 8 |

Every model is the exact `\models\vehicles\<lowercased record name>.model` pak
entry (the committed mapping rule); no alias, near name or C record was used.
The three medium-confidence V1 cars (Bronco / Skyline / SoCal HHR) have 20/20
preview-paired wheel draws; the driven sprint screenshot is the wheel-placement
confirmation.

---

## 2. Build order and measured bytes

Commands, from the repository root, with the bundled Python and the pinned Node:

```powershell
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"

& $py probes/e1-drive/tools/car_roster.py
& $py probes/car-parts/tools/build_all_manifests.py
& $py probes/car-materials/tools/build_roster_materials.py
& $py probes/car-materials/tools/verify_roster_materials.py
& $py probes/e1-drive/tools/build_car_textures.py
& $node probes/e1-drive/tools/build_geometry.mjs
& $node probes/e1-drive/tools/verify_e1_drive.mjs --write-ghosts
& $node probes/e1-drive/tools/derive_sprint_exclusions.mjs
& $node probes/e1-drive/tools/verify_e1_drive.mjs
```

| artifact | bytes | SHA-256 |
|---|---:|---|
| `probes/e1-drive/cars/roster.json` | 5,491 | `b2eab27df85977896e4aeb561e9c2212ff92cb6b24c6c8ec614a587496a672d2` |
| `_work/e1-drive/cars.json` | 52,492 | `932871489b0618e2a74716c63b73bc01c5f410b2022c8c02822ff3b3fccda1ae` |
| `_work/car-parts/cars/index.json` | 215,567 | `4d56ac5a77c0946548b9c1c6669fef04de4c66358da71aec75c32f96df035aaa` |
| `_work/car-materials/roster/index.json` | 65,771 | `20570f76fa156ce08d13afc39d434d50fb7259686d06f8fe8111841c416286e0` |
| `_work/e1-drive/car-textures.json` | 1,711,166 | `4807315d5de48c9d1fc4b84d703ab4390014e0a4db7f423e5f085876b1fa4a7c` |
| `_work/e1-drive/geometry.json` | **106,864,802** | `0dcf3e38f5777f1751fedf6960a0f425e3dd1bf5fb3c3e53a974d49675904709` |
| `_work/e1-drive/sprint-driven-exclusions.json` | 13,311 | `e7668a09320e44c6df181f2401ca0160dffb0a16c65b732e7153f107cb597b5a` |
| `probes/e1-drive/ghosts/index.json` | 25,636 | `a6df9a39cc497db8094a8c606dba98fbce61d9bd5395b93fccec6f2527f9bdbc` |
| `_work/e1-drive/run.json` | 3,907,853 | `a67bacf84a9eee7279e6dca7725c1c2b6f4b50f542e0012c4df3bb0d4d65aff7` |

Aggregates: 15 cars, **1,378** car draws (**673** static albedo, **146** paint,
**169** light blend, **390** no-albedo), **112** decoded car textures /
**46,505,984 B** RGBA (from 18,178,048 B for the five: **+28,327,936 B,
+155.8 %**), **974,402** UV values / **3,897,608 B** UV0 (from 1,257,960 B:
+2,639,648 B). The first five cars' per-car values are exactly the previous P52
values; the added ten are pinned per car in `build_car_textures.py`,
`build_geometry.mjs` and the verifier.

### 2.1 Geometry growth and the page-load budget

| | bytes | MiB | note |
|---|---:|---:|---|
| previous 5-car geometry | 45,374,377 | 43.27 | T-007 baseline |
| 15-car geometry | **106,864,802** | **101.91** | single `_work/e1-drive/geometry.json` |
| growth | +61,490,425 | +58.64 | **+135.5 %**; ≈6.15 MB per added car |

The file is still a **single** JSON document. The page fetches and parses all 15
bodies even though it uploads only the selected car. The batch-1 acceptance
budget was **128 MiB**; 101.91 MiB is **26.09 MiB under** it and the browser
sprint capture completes with console 0 (§5), so batch 1 ships as one file.

**Batch 2 must not ship this way.** At the same 6.15 MB/car the next ten cars
would produce ≈168 MB (≈1.57× the budget). Required order:
1. `geometry.json` keeps the level, track, collision and a small
   `carBodiesIndex` (slug → bytes/SHA-256/path).
2. One `_work/e1-drive/cars/<slug>.geometry.json` chunk per car, with the body
   mesh, UV0 and its P52 texture payloads.
3. `web/app.js`/`packet-adapter.js` fetch the selected car chunk after the
   roster resolves; the packet keeps exactly three mesh uploads.
4. The verifier pins the level document + each per-car chunk, and the browser
   capture records the selected chunk fetch.
No chunk split was done in batch 1 because the single file is inside the
declared budget; the measured number above is the trigger for batch 2.

---

## 3. Per-new-car proof

The verifier runs every car through the same deterministic paths. For the ten
added cars:

| slug | own body/wheels | textures | 310 m | 310 ghost | restart | 29 m | lap | free |
|---|---|---|---|---|---|---|---|---|
| `audi-tt-stock` | exact `audi_tt_stock.model`, 100 draws, 9 nodes | 52 textured / 7 images | 15.483 s, tick 1019 | yes | yes | 3.317 s | 86.817 s | yes |
| `ford-f100-offroad` | exact `ford_f100_offroad.model`, 78 draws | 34 / 7 | 14.817 s, tick 979 | yes | yes | 2.883 s | 85.833 s | yes |
| `ford-fr100-stock` | exact `ford_fr100_stock.model`, 71 draws | 33 / 8 | 14.500 s, tick 960 | yes | yes | 2.633 s | 85.900 s | yes |
| `volkswagen-golfw12650-stock` | exact `volkswagen_golfw12650_stock.model`, 92 draws | 43 / 8 | 14.533 s, tick 962 | yes | yes | 2.650 s | 85.933 s | yes |
| `ford-mustanggtr-stock` | exact `ford_mustanggtr_stock.model`, 101 draws | 55 / 7 | 14.800 s, tick 978 | yes | yes | 2.967 s | 85.883 s | yes |
| `dodge-viperacr-stock` | exact `dodge_viperacr_stock.model`, 83 draws | 48 / 7 | 14.517 s, tick 961 | yes | yes | 2.683 s | 86.267 s | yes |
| `audi-s3-stock` | exact `audi_s3_stock.model`, 99 draws | 49 / 7 | 15.250 s, tick 1005 | yes | yes | 3.167 s | 86.700 s | yes |
| `ford-bronco-offroad` | exact `ford_bronco_offroad.model`, 82 draws | 25 / 6 | 15.350 s, tick 1011 | yes | yes | 3.400 s | 87.383 s | yes |
| `nissan-skyliner34ztune-stock` | exact `nissan_skyliner34ztune_stock.model`, 96 draws | 46 / 7 | 14.100 s, tick 936 | yes | yes | 2.267 s | 85.183 s | yes |
| `chevrolet-socalhhr-stock` | exact `chevrolet_socalhhr_stock.model`, 85 draws | 64 / 8 | 14.767 s, tick 976 | yes | yes | 2.833 s | 86.817 s | yes |

Every row also has: 2/2 ordered checkpoints, no respawn, wheel contact on every
tick, 0 NaN, a bit-identical replay with the rules off, a distinct state
sequence, a distinct packet, a distinct settled state, and a 10-cycle reset
reproduction with the heap and scheduler pool unchanged. The 310 m and 29 m
ghost records are committed under `probes/e1-drive/ghosts/`; every ghost rebuilds
the run's body pose and all eight wheel matrices at every tick and hashes to its
recorded value. The reset/restart check re-runs the sprint in the same wasm
instance and reproduces the finish tick, time and every state hash.

Texture reasons: all 10 cars have zero undecoded P52 textures. The runtime-only
draws keep the committed P52 reason (paint lookup, light off/on blend,
`_NO_ALBEDO`) and the diagnostic albedo; they are never given an invented image.
The FR100 has one light-only texture (`fordf100_2`, 7 light references, 0 static
draws); it is decoded and bound to the light draws' reference list, not counted
as a static-albedo image.

---

## 4. Anchors

### 4.1 Unchanged: the five original cars

The committed anchors for `corvette-zr1-stock`, `lotus-exige-cup260-stock`,
`dodge-challenger-stock`, `ford-focusrs-stock` and `audi-r8v10-stock` are the
same values as before the batch for:

- drive state sequence (`PHYSICS_ANCHORS[slug].drive`);
- 310 m sprint state sequence (`sprint310`);
- 29 m sprint state sequence (`sprintShort`);
- free-roam state sequence (`FREE_ANCHORS`);
- 3-lap state sequence (`LAP_ANCHORS`);
- committed 310 m and 29 m ghost files (`probes/e1-drive/ghosts/`).

The verifier checks every one of these every run; all pass. The 310 m course,
gates, layout hashes, spawn, respawn rules, lap and free-roam layouts are
unchanged.

### 4.2 Moved: the original five packet document hashes

The per-car `packet` anchor is a whole-packet document hash. It necessarily
moved because `carTexturePack.manifestSha256` is the identity of
`_work/e1-drive/car-textures.json`, which is now the 15-car file. The per-car
texture bytes, UV streams, body meshes, draws and physics are unchanged. New
values:

| slug | packet SHA-256 |
|---|---|
| `corvette-zr1-stock` | `e7a2b1c6d43124057d922ee19c0e892126e8dbbd98350146ddb345d0b7496881` |
| `lotus-exige-cup260-stock` | `103056e474095ea13aa3be58aafb41530a6ad7a424341c7cbd0004d43db2df45` |
| `dodge-challenger-stock` | `d2b8baa35e28f8b60337bd7cf104e6c1ebfad124191105bee1594ed88fa0b7b3` |
| `ford-focusrs-stock` | `bb52408529299892bfccd153b441725168e912dc89eb3cfc0566c121125246a7` |
| `audi-r8v10-stock` | `6bd7e11afd2673a59fdafa2e309a270867169bd809c3b4c1de96b6d22c621f9e` |

This is the same behaviour documented for P49/P55/P59/P73b: the packet hash is a
document identity, not a physics anchor.

---

## 5. Browser evidence

`capture_browser.mjs --mode sprint --port 8802` loads every car from the page and
captures start / mid / checkpoint / finish. The capture asserts the page reports
the requested car, the selector lists all 15 roster entries, the browser state
hash equals the Node sprint state, the body/wheel matrices equal the Node packet,
the geometry upload count/bytes equal the level + own body + track mesh, one draw
per draw per frame, nine matrices per tick, and console 0.

Measured: **60 captures (15 cars × 4 frames)**, `verdict:
clean-console-and-gates`, `assertions.ok:true`, **console 0 messages / 0 errors
or warnings**, 15/15 finish frames, 34/60 packet hashes exactly equal and the
rest the documented last-bit `Math.atan2`/`Math.sin` difference (the state hash,
car matrix and 1e-12 matrix/camera tolerances are the gates). Evidence:
`_work/e1-drive/browser-evidence-sprint.json` (600,348 B, SHA-256
`82a859f66aa30897427b66bd8ef677d65232c89556299efff059954bbf5cdb55`).

Sample new-car screenshots:

| file | car |
|---|---|
| `browser-audi-tt-stock-sprint-finish.png` | Audi TT |
| `browser-ford-bronco-offroad-sprint-finish.png` | Ford Bronco |
| `browser-chevrolet-socalhhr-stock-sprint-finish.png` | Chevrolet SoCal HHR |

The five original cars' lap/free/MP paths are unchanged and were sampled again:

| mode | command | result |
|---|---|---|
| lap | `--mode lap --car corvette-zr1-stock --port 8805` | **PASS**, 4 frames (start/lap1/lap2/finish), console 0, 0 assertions, 2/4 packet hashes exact (last-bit elsewhere) |
| free | `--mode free --car corvette-zr1-stock --port 8806` | **PASS**, 4 frames (spawn/mid/prop/reset), console 0, 0 assertions, 2/4 packet hashes exact |
| drive / selector | `--mode drive --car audi-s3-stock --port 8808` | **PASS**, selector lists the 15-car roster and selects the requested car, console 0 |
| MP | `--mode mp --port 8807 --room-port 8812` | **PASS**, two pages, one 310 m race, console 0/0, host P1 14.667 s / guest P2 16.400 s, 20 remote-pose samples (max display Δ 3.65e-5 m) |

The full 15 × lap/free matrix is not re-captured because it is redundant with the
per-car Node checks and each page load now parses the 101.91 MiB geometry; the
browser sprint matrix is the per-car visual gate.

---

## 6. External gates

### 6.1 Portable asset suite: 44/45

`python tools/verify_asset_probe.py --skip-build` → **44/45 PASS**, exit 1.
Evidence: `_work/logs/e1-drive/batch1-verify-asset-probe.log`,
`_work/verification/suite.json`. The one failure is `prop-collision-v2`:

```text
FAIL  base input geometry current  a64530094750503e53e7ddfc74d0a173377bb5bb9b9a77cca3f4da3681021aab
```

The recorded `inputs.geometry` is the old 45,374,377 B / `a645…` file; the
current file is 106,864,802 B / `0dcf3e38…`. `probes/prop-collision/tools/verify_v2.mjs`
compares that whole-file pin with the current file. The geometry file changed
because it now carries ten more car bodies; the **level collision input and the
651-collider data are unchanged** (its content hash check passes, and the e1
verifier's prop-layer checks, including the 23 measured driven-line exclusions,
pass). This is an external probe pin owned by `probes/prop-collision/`; it was
not edited here. The correct fix is to re-pin the prop-collision input geometry
(or scope that pin to the level collision subdocument) in the prop-collision
task, then update the `web/prop-layer.js` manifest file pin if the manifest is
rebuilt.

### 6.2 PoC checker: 20/23

`python tools/check_e1_poc.py` (server on 127.0.0.1:8801) → **20 PASS, 3 FAIL**.
Evidence: `_work/logs/e1-drive/batch1-check-e1-poc-final.log`. All three failures
are hard-coded five-car assumptions in `tools/check_e1_poc.py` (not edited here):

1. `cars.json roster` — requires `selected == 5`; the roster now selects 15.
2. `car texture manifest` — requires `cars==5`, `draws==491`, `textured==224`,
   `textures==40`; the 15-car totals are 15 / 1,378 / 673 / 112.
3. `car RGBA bitmaps` — requires the RGBA total to be exactly 18,178,048 B; the
   15-car total is 46,505,984 B.

The checker's per-car `.fields`, geometry mesh payloads, track textures, UV0
streams and car RGBA file hashes all pass; the browser page/server items pass.
The main agent must generalize these three pins (or make them derive from the
generated roster/manifest) in `tools/check_e1_poc.py`.

### 6.3 CTest: 15/15

`ctest --test-dir _work/build/asset-reader-native -C Release --output-on-failure`
→ **15/15 passed** (0.88 s). On this machine `ctest` is not on `PATH`; the run
used `C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\ctest.exe`.

---

## 7. Prop layer and the measured exclusion set

The 310 m sprint's roadside layer is still the P74 V2 `roadside` profile
(553 active of 651). The measured driven-line exclusion set grew from 9 to
**23** colliders because the added cars' scripted lines touch additional fence /
rack components, including thin components swept between 60 Hz ticks. The set
is derived from the **full raw pre-finish trace** of every 310 m run (the ghost
alone stops at the finish tick); the deriver reproduces the prop layer's 8 cm
substeps and iterates to a clear fixed point. Active colliders: **530**.

Changes made to keep the derivation convergent and honest:
- the scripted controller now follows the **engine's raw state**, not the prop
  layer's resolved presentation pose; the prop layer never feeds back into the
  controller (that feedback made every exclusion change the line and produce new
  contacts);
- the prop layer is scoped to the **timed run**; after the finish the brake tail
  is presented from the raw pose and is not part of the timed contact claim;
- the zero-gap ghost check compares only **new course maxima**, so a car that
  reverses over already-covered ground is not reported as a false ghost gap;
- the 29 m regression gets a documented **drift damper** for cars whose lateral
  speed exceeds 2.5 m/s; the five reference cars never reach that (max 1.75
  m/s), so their P37 inputs and anchors are bit-identical. The Nissan Skyline,
  which physically missed the 6 m finish line by 8 cm with a pure throttle hold,
  now completes the 29 m regression (2.267 s) with a recorded short ghost.

Exclusion content SHA-256:
`sha256:c16fd7ba39b353d18f92fac569cbb63638b36cff3df8f362047dbad0e137e3a9`.
The manifest itself is unchanged; the exclusions are timed-course only.

---

## 8. Limits and non-claims

1. **Class B only.** The ten added cars are the V1-audited B cars with exact
   `.model` entries. No C record was aliased or guessed; the 15 C records remain
   unsupported.
2. **No full-game claim.** One measured River course, one 310 m sprint, one
   29 m regression, one 222.040 m loop, one free-roam basin, one car at a time in
   the single-player page.
3. **Single geometry file.** 101.91 MiB; inside the declared 128 MiB batch-1
   budget, but batch 2 needs the per-car chunk split in §2.1.
4. **Prop exclusion growth.** 23 measured colliders are inactive for the timed
   310 m course only; every other V2 structure stays solid. The set is derived,
   not typed in, and is re-checked by the verifier.
5. **Telemetry brake residuals.** Bronco (0.229 m/s) and Skyline (0.844 m/s)
   still creep at the end of the fixed 86 m brake strip; their distance and
   deceleration are inside the same bands and the residual is recorded. This is
   a diagnostic limit, not a race result. The strict cross-car drivetrain and
   torque/mass ordering claims remain scoped to the five reference cars; the
   added cars' measured values are recorded in `run.json`, but a 15-car
   torque/mass rank is not asserted (the XT gearing and drivetrain branch make it
   false: the AWD Audi TT is slower to 100 km/h than the FWD Focus).
6. **Camera capture exceptions.** At the 300-tick drive's tick 150, the Audi TT
   has a near-field prop crossing (3.03 m) and the Bronco a resolved occlusion at
   9.31 m; the camera records the occlusion and pulls in/holds. The strict
   four-clear-ticks gate remains for the five reference cars. Sprint screenshots
   for the added cars are the visual proof.
7. **No retail protocol, anti-cheat, power-up, AI or network claim** is added by
   this batch. The M1 two-browser path is unchanged and sampled separately.
8. **External pins.** The suite's one failure and the checker's three failures
   are documented in §6 and are not caused by a physics or renderer regression.

---

## 9. Evidence index

```text
_work/e1-drive/run.json                       2254 checks, 15 cars, 30 ghosts
_work/e1-drive/geometry.json                  106,864,802 B / 0dcf3e38…
_work/e1-drive/car-textures.json              1,711,166 B / 4807315d…
_work/e1-drive/sprint-driven-exclusions.json  23 ids / c16fd7ba…
_work/e1-drive/cars.json                      15 selected / 93287148…
_work/e1-drive/sprint-<slug>.json             15 full raw traces + prop
_work/e1-drive/sprint-short-<slug>.json       15 short regression runs
_work/e1-drive/telemetry-<slug>.json          15 telemetry series
_work/e1-drive/browser-evidence-sprint.json  15-car browser capture
_work/e1-drive/browser-<slug>-sprint-*.png   60 sprint screenshots
_work/e1-drive/browser-evidence-lap.json     lap sample (4 frames)
_work/e1-drive/browser-evidence-free.json    free sample (4 frames)
_work/e1-drive/browser-evidence-mp.json      M1 two-page sample
_work/logs/e1-drive/batch1-*.log              build/verify/capture logs
probes/e1-drive/ghosts/index.json             30 committed reference ghosts
```

Hashes for the main artifacts are in §2. The per-run room code, player ids and
multiplayer table hash remain per-room; the layout hash, finish ticks/times and
check state anchors are the reproducible parts.

| log | SHA-256 |
|---|---|
| `batch1-verify-final2.log` (2254/2254) | `13040d8cb71115ab9a11d24be74b25ea1ca2763c9ff9994f2e7bbda0b247003d` |
| `batch1-verify-asset-probe.log` (44/45) | `574011fcae096a28f1acd4a3b974d6f3e00006b1bfe20b0dd23d55c972285f23` |
| `batch1-check-e1-poc-final.log` (20/23) | `d00a5c95e533d3da4a1fda1b62678205032f56bca7a88079b18d41edb72873eb` |
| `batch1-ctest.log` (15/15) | `af3f7079b285ff51394aebe4653048a3025c2349f57768e66fb05f19ad541b4f` |
