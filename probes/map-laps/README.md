# Map laps probe - closed collision-only loops on `usa_amboy` and `spa_barcelona_gracia`

Generalises the P61 lap search (`probes/lap-search`) to the two point-to-point
maps: it builds the collision passability raster, labels every component, finds
enclosed islands, measures clearance-erosion survival, extracts closed loop lines
and validates them with exact triangles, the engine's own trace and draw
coverage.

```json
"scope": {
  "collisionOnly": true,
  "drawGeometryRead": false,
  "rendererClaim": false,
  "vehiclePhysics": false,
  "gameRun": false,
  "engineTrace": "thin FillCache/Trace probes only; no car simulated"
}
```

The only draw data read anywhere in this probe is the separate `coverage.json`
test, which loads committed draw triangles and compares their height with the
collision height. It is not a render.

## 1. Result

**`usa_amboy` has a validated closed lap. `spa_barcelona_gracia` has none on its
course.**

| map | course component | islands in it | loops | best loop | verdict |
| --- | --- | --- | ---: | --- | --- |
| `usa_amboy` | **510**, 860,891 cells / 215,222.75 m2 | 145 (8 >= 100 m2, **all step/grade**) | 6 | **loop-01 284.4524 m** | lap, fully drawn |
| `spa_barcelona_gracia` | **171**, 64,566 cells / 16,141.5 m2 | 1 (largest **2.25 m2**) | 3 | loop-01 67.8883 m, component **180** | no lap on the course |

Amboy loop-01 (recommended):

| field | value |
| --- | --- |
| length | **284.4524 m**, 1,152 samples at 0.25 m, closed (seam 0.5 m) |
| component | 510 - the spawn `(230, 1128)` and 934 of the 1,628 measured path samples |
| start / finish | `(179.5, 889.5)`, ground 1.8430 m, heading **1.712699381 rad** |
| island | 1,339.25 m2 sloped ridge (100 % step/grade cells; Amboy has **no** void/steep island >= 100 m2) |
| ring | survives **5** clearance erosions (>= 3.0 m half-width) |
| exact verifier | **PASS 9/9**: step 1.060 cm, 2 m grade 4.27 %, footprint 16.81 cm, band 11.75 m |
| engine trace | **569 samples, 0 hard / 0 safety-margin violations** |
| draw coverage | **100 %** (0 gaps, max delta 4.42 cm) |
| 3 laps | **853.3572 m** |
| reach from the committed spawn | **1,661.993 m** geodesic (243.788 m straight) - same component, so a connector exists |

Gracia: the 624.914 m course component is a corridor with one 9-cell (2.25 m2)
pinhole, so it has no usable non-contractible cycle. Its only 100 % drawn ring is
a 67.8883 m oval around a 175.5 m2 void in component **180**, which is **1.581 m**
away from the course component across a **smooth 6.2 % ramp** (no steep face:
ground 129.832 -> 129.930 m). The P48 5 % rule rejects that ramp; with a 30 %
sensitivity model the rings that appear are terrain 20-80 m below the road and
only 33.7-53 % drawn.

**Recommendation:** keep both point-to-point courses. Use Amboy loop-01 for a
3-lap mode by moving the start to `(179.5, 889.5)` - a new layout, not a gate
change.

## 2. Inputs (read-only)

| input | bytes | SHA-256 |
| --- | ---: | --- |
| `game-data/Blur/levels/usa_amboy/Level.levelphysics` | 4,442,528 | `18c73e1cca6f13c5bbd4937454f25ec3163a67553fea6842a7797400af2175f2` |
| `game-data/Blur/levels/spa_barcelona_gracia/Level.levelphysics` | 5,569,121 | `acfb58a20ff7adced0b2424dc39474509e6b4c4c805729fd9463bdd310a173c0` |
| `probes/map-pipeline/tools/physics_scan.py` (imported) | 18,100 | `a98e699ad43d4cf6b44064870973c3921847cfa2f7e091cefd36a00586776b72` |
| `probes/lap-search/tools/raster.py` (imported) | 10,806 | `a99e88838afe32742a093122c565ccf08204505c4373730626e0f3ad56e215dd` |
| `_work/e1-drive/cars.json` (roster) | 82,344 | `0d59aa0a409c67cff5271a1944c551f8ee4a1c2c47da9300485856d37a15a768` |
| `_work/e1-drive/module/e1_drive.wasm` (engine trace) | 1,012,634 | `bcdc2d994a499cc399333b44cfc418d6594f8b5182a668c3a9df761d891de265` |
| `_work/map-pipeline/paths/usa_amboy.json` | 55,347 | `6d99438af2074826a453aae6ccd27205471da6d00cd388ede131b23ee8c8fddf` |
| `_work/map-pipeline/paths/spa_barcelona_gracia.json` | 18,252 | `1d194750d6ad567986fd87f9355d00f4a501f2fadf408ff1416f636433239f77` |

The committed collision oracle alone rejects these levels (their first import
shape is a Box), so the shape stream is decoded by the committed map-pipeline
scanner. Static triangle counts match the committed map-slice packages:
**63,708** (Amboy) and **113,270** (Gracia); the builder refuses to run if they
differ.

## 3. Model

| parameter | value | source |
| --- | --- | --- |
| grid | 0.5 m XZ (Amboy 2,843 x 4,023 cells; Gracia 2,297 x 3,161) | P48 |
| drivable surface | triangle `normal.y > 0.94` (<= 20 deg) | P48 |
| passable cell | surface in all 8 neighbours, max neighbour dh <= 2.5 cm (5 %) | P48 |
| wall mask | steep `|normal.y| < 0.5`, height band ground+0.05..2.0 m, XZ dilated 0.5 m | P48 |
| car envelope | 2.981 m x 1.676 m (documented max XT envelope: largest roster wheelbase 2.981 m, 2.98 x 1.68 m box proxy) | project vehicle work, mirrored in `_work/e1-drive/cars.json` |
| safety margin | 0.30 m per side; half-width 1.138 m, half-length 1.7905 m | labelled assumption |
| island threshold | 100 m2 (400 cells) | this probe |
| loop line | `k = min(3, survival)` erosion boundary, 0.25 m samples, seam <= 1.0 m | P61 |

`--step-limit` / `--grade-limit` switch to the labelled **sensitivity** model
(30 % grade, 15 cm step). Artifacts from it carry
`modelLabel: "sensitivity-relaxed"` and are never the claim.

## 4. Method

1. Decode the physics file, flatten static triangle meshes (types 0 and 11).
2. Rasterise the surface, the 8-neighbour difference and the wall mask.
3. Label 8-connected passable components; find the spawn component and the
   components the measured path uses.
4. Label the 4-connected background; keep the enclosed (non-border) regions.
5. Measure erosion survival `k = 1..8` per island >= 100 m2.
6. Extract a ring at `k = min(3, survival)`, corner-cut it inside the mask and
   resample at 0.25 m; reject seams > 1.0 m.
7. Validate: exact triangles, engine trace, draw coverage.
8. Rank with a documented rule and record which one fired (`bestReason`).

## 5. Validation

| gate | `usa_amboy` | `spa_barcelona_gracia` |
| --- | --- | --- |
| exact triangles (`verify_map_loops.py`) | **PASS 60/60** (6 loops x 9 + 6 global) | **PASS 33/33** (3 loops x 9 + 6 global) |
| engine trace (`verify_engine_map_loops.mjs`) | 1,856 samples, **0 / 0** | 381 samples, **0 / 0** |
| draw coverage (`coverage_map_loops.py`) | loop-01 **1.000**; others 0.20-1.00 | loop-01 **1.000**; loop-02 0.000, loop-03 0.209 |
| determinism | two full runs byte-identical | same |
| P61 regression | **34/34**, artifacts untouched | same run |

Engine ground-probe window: `e1_ground_probe` starts its ray at y = 130.0, which
clips Gracia's y ~ 130 road (47/400 path samples hit). The trace falls back to a
vertical `e1_ray_probe` from 2 m above the raster ground - still the engine's own
`FillCache`/`Trace`. Amboy needs no fallback.

## 6. Commands

```powershell
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"

foreach ($lvl in @("usa_amboy","spa_barcelona_gracia")) {
  & $py probes/map-laps/tools/build_map_loops.py       --level $lvl   # raster, components, islands, loops
  & $py probes/map-laps/tools/verify_map_loops.py      --level $lvl   # exact triangles
  & $node probes/map-laps/tools/verify_engine_map_loops.mjs --level $lvl   # engine trace
  & $py probes/map-laps/tools/coverage_map_loops.py    --level $lvl   # draw coverage
  & $py probes/map-laps/tools/build_map_layout.py      --level $lvl   # spawn/gates/finish hand-off
  & $py probes/map-laps/tools/build_map_image.py       --level $lvl   # map.png / map.svg
  & $py probes/map-laps/tools/reach_map_loop.py        --level $lvl   # geodesic reach from the spawn
}

# labelled sensitivity runs (not the claim)
& $py probes/map-laps/tools/build_map_loops.py --level spa_barcelona_gracia --step-limit 0.30 --grade-limit 0.30 --tag relaxed
& $py probes/map-laps/tools/verify_map_loops.py --level spa_barcelona_gracia --dir _work/map-laps/spa_barcelona_gracia/relaxed

# engine ground coverage of the measured path
& $node probes/map-laps/tools/probe_map_ground.mjs --level spa_barcelona_gracia

# P61 regression (redirected output, nothing under _work/lap-search is written)
& $py probes/map-laps/tools/run_p61_regression.py

# committed Amboy 3-lap layout document (e1-drive.sprint v1, courseId "lap")
& $py probes/map-laps/tools/build_amboy_lap.py
& $node probes/map-laps/tools/verify_amboy_lap.mjs

# committed Gracia no-closed-lap decision (map-laps.no-lap v1)
& $py probes/map-laps/tools/build_gracia_no_lap.py
& $node probes/map-laps/tools/verify_gracia_no_lap.mjs
```

## 7. Artifacts and hashes

`_work/map-laps/<level>/`:

| file | `usa_amboy` bytes / SHA-256 | `spa_barcelona_gracia` bytes / SHA-256 |
| --- | --- | --- |
| `loops.json` | 243,890 / `05afd517eccce44c9bb041d76f07027336ef0ee89a2d90d211f2a5560333b79b` | 54,867 / `fab958d95c3665597754c09cd6774d1d5a4d03bac40d15d6b249d6a5115ecaf1` |
| `verify.json` | 14,028 / `c42a2b9217b812e56e6a271da12abf08c26764678db357d8888d85ea69463542` | 7,651 / `8677f7abf21da1722ca068324df78a6f16102bc34bb9f66e936908cd9932c1c4` |
| `coverage.json` | 4,203 / `b05b831f8eeb2662f16437e411bfa81060365c1d6ab4f78827a66607d9997847` | 2,001 / `315b11d2db07d481ef56a21afd2bf17f0ad6b4a76aacab09d343907fa8a3717b` |
| `layout.json` | 6,114 / `8fb1c837d176f1b57f683524513608f40c2e7a650b333e1452a70d391b07b986` | 6,159 / `d3147733176118d85b18aab60a3c28ddb3bcd51f5b44fc0b853a22a697db0699` |
| `engine-trace.json` | 281,768 / `4ae589b902b73a340714117e0a57caee37f72123ec4ea90a2b441e4facaf5825` | 59,289 / `0992d2a77c8422b33e2b4ff36069e4649ab932f4b827db0d3c9ac96c3c5f5b0d` |
| `reach.json` | 1,630 / `93c3cc68a70a2972aa3c543bef26144299708fcff430c475c8510740b9288cb8` | 1,110 / `f38fe067c4ea098cf2e4a9f6ace18e9ecf04e911f11749e603d6741937a35872` |
| `map.png` | 45,448 / `2c97e503386d5d1e93780c7a7086fed41f421f1d6e4f54ee8cd6d49fefab0af1` | 29,363 / `db6cb0f06018d25a2d80129b477ddd9fc0716588d946812809783a871dfc9a3f` |
| `map.svg` | 33,623 / `ecfb645c1cd79ac23569f130273b4852f0f97ec73ccabfdb49cacd2863b52db6` | 6,943 / `5e7e16eb55fdab63ef74afdf9376d1197cba42b83c9f61a07ddc762a659d4a74` |
| `grid.npz` | 19,733,896 / `251db275c4e4a2516b353e398429e249f9c794eb7e38c4a9639c07d316d84c9b` | 5,073,237 / `042183edc26ea7c5abfbcce2a93ed0b7d538dc014e51aa7bcf882bb62dbf4017` |

Canonical body hashes (`doc["hash"]`):

| artifact | `usa_amboy` | `spa_barcelona_gracia` |
| --- | --- | --- |
| `loops.json` | `sha256:9c9997068a65e10eb5d9e056b738286596f1dd08ebfc4fc5e63a79f5e7bbc476` | `sha256:ba4ecf522cef4848a6dd5a04327b001768d59f6e1eaac732878a1cf8a67d3016` |
| `verify.json` | `sha256:c113a0782002228f9a60ad4a7c17e72bb7404403f6b56a9e440736f7015d0869` | `sha256:79f9952a0f20ea757697ca82adf28cb65e54bf98bfca36fcac2e58016da2398b` |
| `coverage.json` | `sha256:6f4f45210b65cb684469aa901138f8cdd9436eef69012e54166799b3590f3537` | `sha256:320d1e5e468db4af1c96657bd04ff91e8ee47c2ab2b5330288c8d1063950ef14` |
| `layout.json` | `sha256:de16213f8136bc8cdf6e09007f4ddc51718149db30431888cb0fb8fb59aa1044` | `sha256:3bd5f704a5a229dcafef5c5d7e3e3d544b654f5def27f0636b9384e5d457f365` |
| `engine-trace.json` | `sha256:e514d054c9d548174a70cdc246712192ecdd50eb3d3d0ddc68a17e6defa1114c` | `sha256:007f45434b11ab4ab35f8b0737a15a0a993aa87f488df608c63bcb4512113098` |
| `reach.json` | `sha256:eafc9ae2ac6c9a229c7f9b72d33ad36c19836b96321dd1fd67a238db185fa1f4` | `sha256:51db9cb348a9ab63827ab7960768d169e4d152358d2bd885b073844ac44fa8e0` |

Other artifacts: `_work/map-laps/spa_barcelona_gracia/ground-coverage.json`
(4,499 B / `ae64bb22e3c78e3791aa9e9f6b312c98e77490a55ab28256289344ab69181c5a`),
`_work/map-laps/p61-regression/regression.json`
(999 B / `f6e23fc87317df789a3000405f33ba1544a3a9148e7877b858ae8394f0bbd425`),
sensitivity `_work/map-laps/*/relaxed/{loops,verify,coverage,grid}.json|npz`.

## 8. Limits

- **Collision only.** Draw coverage is a separate 0.5 m height test, not a frame.
  No material, texture, shader, sampler or GPU state is applied.
- **Geometric/trace drivability, not a driven lap.** No car, steering, speed,
  suspension or lap timing is simulated; the engine trace is the wheel-style
  thin `FillCache`/`Trace`, not a box-body collision.
- **The wall mask is conservative** (it includes one-sided faces the thin trace
  ignores), so it can disconnect or shorten the model but cannot create a false
  pass.
- **The 0.30 m margin is an assumption**; XT gives wheelbase and track width,
  not body overhangs.
- **Only static triangle meshes.** `InstancedTriangleMesh` (1 Amboy, 38 Gracia)
  and the simple Box/Cylinder shapes are not in the raster.
- **The 5 %/2.5 cm rule is a River rule.** It rejects a 6.2 % Gracia ramp; the
  30 % sensitivity model is recorded next to the claim, never instead of it.
- **The flat-footprint check is a flat-car proxy.** It flags a sustained grade as
  well as a ledge; on Gracia's terrain ring the failures are longitudinal
  (front-back 0.29-0.57 m, left-right ~0.00 m).
- **The 100 m2 island threshold is a choice**; smaller islands are counted but not
  promoted.
- **Reach is a raster BFS**, i.e. a geometric shortest path on 0.5 m cells, not a
  driven line; an 8-connected path is a few percent longer than a smoothed one.
- **No renderer/GPU/game claim.**

## 9. Evidence

```text
_work/map-laps/usa_amboy/         loops.json verify.json coverage.json layout.json engine-trace.json reach.json map.png map.svg grid.npz
_work/map-laps/spa_barcelona_gracia/  the same nine artifacts + ground-coverage.json
_work/map-laps/usa_amboy/relaxed/     labelled sensitivity run (24 loops, all rejected)
_work/map-laps/spa_barcelona_gracia/relaxed/  labelled sensitivity run (1,187 m terrain ring, 33.7 % drawn)
_work/map-laps/p61-regression/    P61 verifier replay, 34/34, artifacts untouched
_work/logs/map-laps/*.log         every build, verify, engine, coverage, map, repeat run
```

Analysis document: [`docs/work/analysis/map-laps.md`](../../docs/work/analysis/map-laps.md).

## 10. Amboy 3-lap layout document

`probes/map-laps/data/amboy-loop01-lap.json` is the committed, game-ready
three-lap layout for `usa_amboy` loop-01. It is an `e1-drive.sprint` v1
document with `courseId: "lap"` - the schema
`probes/e1-drive/web/sprint-layout.js` derives for River's loop-01 - plus two
checkpoint gates distributed along the loop.

| field | value |
| --- | --- |
| output | `probes/map-laps/data/amboy-loop01-lap.json` |
| bytes / file SHA-256 | 290,543 / `sha256:61cac054420f01520636ea3b48ba9d025dfce120471ee2a7d7a41d3f2f5f1c28` |
| canonical `hash` | `sha256:7b39c8c20700ae4f3b3698e9d128d7686aec1f583e52f4238b13d87fc42817e1` |
| loop | `loop-01`, component **510**, 284.4524 m, 1,152 samples at 0.25 m |
| laps | **3** |
| gates | start 0 m / 1.8430 m; checkpoint-1 94.7107 m / 0.2569 m; checkpoint-2 189.5103 m / 0.9473 m; finish 284.452387 m / 1.8430 m |
| start / finish | `(179.5, 889.5)`, heading 1.712699381 rad, 4 m line |
| total race distance | 853.3572 m (3 x 284.4524) |
| draw coverage | 1.000, 0 gaps, max delta 4.42 cm |
| verifier | **53/53 checks passed** |

Schema (the driving-slice fields the page reads):

- `kind: "e1-drive.sprint"`, `version: 1`, `courseId: "lap"`;
- `source`: the collision-only probe, `loopId: "loop-01"`, component 510, the
  loops/coverage/layout/verify/engine-trace/physics file hashes and the
  `groundSource` / `gateLineSource` / `checkpointStationSource` notes;
- `course`: `samples` (1,152 x `{arc,x,z,groundY,covered}`), `lap.line`
  (`a`, `b`, `x`, `z`, `groundY`, `headingRad`, `tangent`), `corridor`
  (1.25 m declared respawn band), `coverage`, `reference` and `span`;
- `gates`: `start`, `checkpoint-1`, `checkpoint-2`, `finish`, each with
  `sampleIndex`, `arc`, `x`, `z`, `groundY`, `height`, `headingRad`,
  `tangent`, `a`, `b`, `widthMetres` and `groundCheck`;
- `countdown` (90 ticks), `rules` (3 forward crossings of the start/finish
  line, respawn rule) and `hash`.

Derived fields (the probe's `layout.json` does not carry them):

- per-sample `groundY` is `loops.json` loop-01 `ground`, the P48 collision
  raster H at each 0.25 m sample's 0.5 m cell (4 decimals);
- gate lines are the 5 m tangent window, a 4 m line, oriented so the approach
  side is positive (the `sprint-layout.js` rule);
- `groundCheck` is the P48 passable raster (`grid.npz` `base` / `height`) at
  the gate cell and at 0.25 m stations across the line. The probe did not
  measure the 4 m gate lines for draw coverage, so `coverage.measured` is
  `false`;
- the checkpoints are the samples closest to one-third / two-thirds of the
  measured arc (indices 385 / 770). The probe's `layout.json` used nominal
  0.25 m sample thirds (379 / 759, 32.77 % / 65.66 %); the measured arc is the
  authority here.

Scope labels carried by the document:

```json
"scope": {
  "collisionOnly": true,
  "drawGeometryRead": false,
  "drawCoverageSource": "_work/map-laps/usa_amboy/coverage.json (0.5 m height test, not a render)",
  "rendererClaim": false,
  "vehiclePhysics": false,
  "gameRun": false,
  "lapDriven": false,
  "engineTrace": "recorded in _work/map-laps/usa_amboy/engine-trace.json; not re-run by this builder",
  "note": "a data layout, not an e1-drive integration: no gate mesh, no race director, no lap timing, no car simulated"
}
```

Integration caveats:

- `courseId: "lap"` is what `LapRules` (`sprint-rules.js`) accepts; the page
  must fetch this document for the Amboy lap course and pass it to
  `createSprintRules`.
- `map-package.js` `validateMapPackage` is the point-to-point 4-gate /
  2,060 m validator; it must not be applied to this lap document.
- the checkpoint gates are data only: `LapRules` counts three forward
  crossings of the start/finish line and does not require them.
- no lap has been driven on this map; the 1.25 m respawn band is a declared
  rule, not a measured driven lateral bound. No gate mesh, race director,
  lap timing, props or AI are added by this document.

Verifier coverage (`verify_amboy_lap.mjs`, 53 checks): gate count / order /
arcs, the 284.4524 m length within 1e-3 m, the closed seam and the
last-gate-to-start connection, the 5 m seam tangent, per-gate ground and P48
passable raster (centre, car-width line, 4 m line), per-sample coverage, the
3-lap counter (same forward-crossing rule as `LapRules`), the countdown /
respawn rules, the canonical hash, and determinism (the builder twice,
byte-identical, and equal to the committed file).

`build_amboy_lap.py --check` compares the generated document with the
committed file and exits 1 if it is stale; the verifier already runs the
builder twice, so a hand-edited document fails both gates.
