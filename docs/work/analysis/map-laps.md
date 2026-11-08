# Map laps - closed collision-only loops on `usa_amboy` and `spa_barcelona_gracia`

**Date:** 8 November 2026
**Owner:** LM1 (sub-agent)
**Scope:** `probes/map-laps/**`, `_work/map-laps/**`,
`_work/logs/map-laps/**` and this document. No change to
`probes/e1-drive`, `probes/map-slice`, `probes/map-pipeline`,
`probes/lap-search`, `tools/`, `upstream/` or `game-data/`.
The map-pipeline physics scanner and the P61 raster primitives are imported
read-only; the committed e1-drive wasm is called read-only for collision traces.
No renderer, GPU, browser, vehicle-physics or playable-game claim is made.

## Result

**`usa_amboy` contains a validated closed lap; `spa_barcelona_gracia` does not.**

| map | largest component | enclosed islands | loops | best loop | verdict |
| --- | --- | --- | ---: | --- | --- |
| `usa_amboy` | **510**: 860,891 cells / 215,222.75 m2 (the spawn; the measured 2,060.595 m path uses 510 for 934 of 1,628 samples and component 650 for 668) | 988 total, 27 >= 100 m2, **all 27 are pure step/grade patches** (no void, no steep face) | **6** | **loop-01, 284.4524 m**, ring survives 5 erosions | **lap exists and is drawn** |
| `spa_barcelona_gracia` | **171**: 64,566 cells / 16,141.5 m2 (the spawn and the measured 624.914 m course) | 176 total, 3 >= 100 m2; the course component has **one 2.25 m2 pinhole** | 3 | loop-01, 67.8883 m, but in component **180**, **1.581 m away** from the course component | **no lap on the course** |

Amboy loop-01 passes all three instruments:

| field | loop-01 (`usa_amboy`) |
| --- | --- |
| length | **284.4524 m** (1,152 samples at 0.25 m, closed, seam 0.5 m) |
| component | 510 - the same component as the spawn `(230, 1128)` and 934 of the 1,628 measured path samples |
| start / finish | `(179.5, 889.5)`, heading **1.712699381 rad** |
| island | 1,339.25 m2, 100 % step/grade cells (a sloped ridge, not a void) |
| ring | survives **5** clearance erosions (>= 3 m half-width) |
| exact verifier | **PASS 9/9** (step 1.060 cm, 2 m grade 4.27 %, footprint range 16.81 cm, min band 11.75 m, no steep face in the car band) |
| engine trace | **569 samples, 0 hard, 0 safety-margin violations** |
| draw coverage | **100 %** of 3 stations x 1,151 samples, 0 gap runs, max draw-vs-collision delta 4.42 cm |
| 3 laps | **853.3572 m** |
| reach from the committed spawn | 1,661.993 m geodesic (243.788 m straight) - same component, so a connector exists, but it is 1.66 km |

Gracia's only fully drawn ring is a 67.8883 m oval around a 175.5 m2 void in
component 180. It is exact-clean and engine-clean, but component 180 is
**1.581 m** from the course component 171, across a **smooth 6.2 % ramp** with no
steep face. The measured 624.914 m course itself is a corridor: its component has
exactly one enclosed background region of **2.25 m2** (9 cells, a raster pinhole),
so there is no non-contractible cycle of any usable size on it.

The point-to-point courses stand: **2,060.595 m (Amboy)** and **624.914 m
(Gracia)**. Amboy additionally offers a 3-lap course of 3 x 284.4524 m if the
start is moved to `(179.5, 889.5)`; that is a new layout, not a gate change.

## 1. Question

P61 proved that `usa_la_river` has three closed collision loops but none in the
spawn component, and this project's lap asset is River loop-01. Amboy and Gracia
are shipped as point-to-point courses (2,060.595 m and 624.914 m). The question
here is whether their **collision** networks contain a closed drivable loop that
could support a 2-3 lap race, and if not, what topological fact prevents it.

A loop is not "a circle in open ground": it must enclose an island of
non-passable collision surface, the ring must fit the car (envelope + margin),
and the line must survive an exact-triangle and an engine-trace measurement.

## 2. Inputs and provenance

| input | bytes | SHA-256 |
| --- | ---: | --- |
| `game-data/Blur/levels/usa_amboy/Level.levelphysics` | 4,442,528 | `18c73e1cca6f13c5bbd4937454f25ec3163a67553fea6842a7797400af2175f2` |
| `game-data/Blur/levels/spa_barcelona_gracia/Level.levelphysics` | 5,569,121 | `acfb58a20ff7adced0b2424dc39474509e6b4c4c805729fd9463bdd310a173c0` |
| `probes/map-pipeline/tools/physics_scan.py` (parser import) | 18,100 | `a98e699ad43d4cf6b44064870973c3921847cfa2f7e091cefd36a00586776b72` |
| `probes/lap-search/tools/raster.py` (raster primitives) | 10,806 | `a99e88838afe32742a093122c565ccf08204505c4373730626e0f3ad56e215dd` |
| `_work/e1-drive/cars.json` (roster) | 82,344 | `0d59aa0a409c67cff5271a1944c551f8ee4a1c2c47da9300485856d37a15a768` |
| `_work/e1-drive/module/e1_drive.wasm` (engine trace) | 1,012,634 | `bcdc2d994a499cc399333b44cfc418d6594f8b5182a668c3a9df761d891de265` |
| `_work/map-pipeline/paths/usa_amboy.json` | 55,347 | `6d99438af2074826a453aae6ccd27205471da6d00cd388ede131b23ee8c8fddf` |
| `_work/map-pipeline/paths/spa_barcelona_gracia.json` | 18,252 | `1d194750d6ad567986fd87f9355d00f4a501f2fadf408ff1416f636433239f77` |

Collision triangles are decoded by the committed map-pipeline scanner, which
follows the upstream serializer. The committed collision oracle alone rejects
these levels (their first import shape is a Box). Decoded static triangle counts
match the committed map-slice packages exactly: **63,708** (Amboy) and
**113,270** (Gracia).

Only static triangle meshes (types 0 and 11) are in the model. The
`InstancedTriangleMesh` and simple Box/Cylinder shapes are **not** decoded by the
committed scanner and are therefore not in the raster. They are obstacles, not
road, but that is a stated limit, not a guess.

## 3. Model

The P48/P61 model is reused without change at 0.5 m XZ:

1. The highest up-facing collision triangle per cell is the surface; only
   `normal.y > 0.94` (<= 20 deg) is drivable.
2. A cell is passable when it has a surface, every 8-neighbour has a surface, and
   the maximum neighbour height difference is <= `min(0.05, 0.05 x 0.5)` =
   **2.5 cm** (5 % grade with a 5 cm cap).
3. Every steep triangle (`|normal.y| < 0.5`) whose height band reaches local
   ground + 0.05..2.0 m is projected to XZ and dilated by 0.5 m: the wall mask.

A lap is a simple closed curve in the passable cell graph that winds around at
least one enclosed island (a 4-connected background region that a border flood
cannot reach), the island is >= 100 m2, and the island is still enclosed after
`k` 8-connected erosions of the passable mask. A retained cell of the eroded mask
is at least `(k+1) x 0.5 m` from every blocked cell, so `k = 3` is a >= 2.0 m
clearance ring and `k = 2` is a labelled tight ring (>= 1.5 m). The loop line is
extracted at `k = min(3, survival)` with a Moore boundary trace, corner cutting
and 0.25 m resampling; the closure seam must be <= 1.0 m and stay in the mask.

Car envelope: 2.981 m x 1.676 m - the project's documented maximum XT envelope
(largest roster wheelbase 2.981 m; the prop resolver uses a 2.98 x 1.68 m box
proxy, not a recovered retail hull) - plus a labelled 0.30 m margin on every
side: half-width 1.138 m, half-length 1.7905 m, needed width 2.276 m. The 0.30 m
margin is an assumption.

### 3.1 Labelled sensitivity model

The 5 %/2.5 cm rule is a River road rule. On these two maps the P48 model splits
large, visibly continuous road rings into hundreds of components, because a
**6 % road ramp** is over the 5 % limit. A second run is therefore recorded with
`stepLimit = 0.30 m` and `gradeLimit = 0.30` (`edgeDhLimit = min(0.30, 0.15) =
0.15 m`). It is **not** the claim: it is a labelled sensitivity screen whose only
purpose is to show what the ring topology looks like when a kerb/ramp step is
allowed. Every sensitivity artifact carries `modelLabel:
"sensitivity-relaxed"`.

## 4. Method

1. Decode `Level.levelphysics`, flatten the static triangle meshes.
2. Rasterise height, 8-neighbour difference and the wall mask; build `base_pass`.
3. Label every 8-connected passable component; find the spawn component and every
   component the measured path visits.
4. Label the 4-connected background; keep regions a border flood cannot reach
   (enclosed islands), with size, bbox and blocked-cell composition.
5. For every island >= 100 m2, measure erosion survival `k = 1..8`.
6. For every island with survival >= 2, extract the ring at `k = min(3, survival)`
   and resample at 0.25 m.
7. Rank by the documented rule; the artifact records which rule fired
   (`bestReason`), including fallbacks.
8. Validate with three independent instruments: exact triangles, engine trace,
   draw coverage.

## 5. `usa_amboy`

### 5.1 Components and islands

| measure | value |
| --- | ---: |
| raster | 11,437,389 cells at 0.5 m |
| passable | 2,649,589 cells / 662,397.25 m2 |
| components | **693** |
| spawn component | **510**, 860,891 cells / 215,222.75 m2 |
| measured path | 934/1,628 samples in component 510, 668 in 650, 26 with no passable cell |
| enclosed islands | 988 (74,195 cells), **27 >= 100 m2** |
| islands in component 510 | 145 (8 >= 100 m2) |

The spawn component is huge and contains 145 holes, but **every one of the 27
large islands is 100 % step/grade cells**: zero void cells and zero steep cells
across all 27. There is no cliff, no hole and no wall-bounded infield anywhere at
>= 100 m2 in Amboy. A lap in Amboy is a ring around a **too-steep slope patch**,
which is a legitimate natural infield but not a "real obstacle" in the P61 sense;
`bestReason` therefore records the fallback rule.

### 5.2 Candidate loops (P48 model)

| loop | component | length m | survival | max step | max 2 m grade | footprint | min band | draw cover | engine |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| **loop-01** | **510** | **284.4524** | **5** | 1.06 cm | 4.27 % | 16.81 cm | 11.75 m | **1.000** | 569/0/0 |
| loop-02 | 3 | 197.0924 | 4 | 0.86 cm | 3.21 % | 15.63 cm | 11.25 m | 0.201 | 395/0/0 |
| loop-03 | 148 | 191.5230 | 4 | 0.87 cm | 3.49 % | 15.03 cm | 11.25 m | 0.570 | 384/0/0 |
| loop-04 | 3 | 118.0306 | 7 | 0.87 cm | 3.48 % | 15.93 cm | 13.00 m | 0.524 | 237/0/0 |
| loop-05 | 2 | 68.9295 | 2 (tight) | 0.95 cm | 3.81 % | 15.28 cm | 12.25 m | 1.000 | 138/0/0 |
| loop-06 | 288 | 66.3482 | 8 | 0.96 cm | 3.83 % | 14.66 cm | 12.50 m | 1.000 | 133/0/0 |

All six are exact-clean and engine-clean; only loop-01 is both **in the course
component** and **fully drawn**. loop-05/06 are fully drawn but are 66-69 m
paddocks in other components.

### 5.3 The recommended lap

| field | value |
| --- | --- |
| loop | `loop-01`, component 510 |
| length | **284.4524 m** (1,152 samples, seam 0.5 m) |
| start / finish | `(179.5, 889.5)`, ground **1.8430 m**, heading **1.712699381 rad** (5 m tangent window) |
| checkpoint 1 | arc 93.215 m, `(183.016, 971.474)`, ground 0.2688 m |
| checkpoint 2 | arc 186.763 m, `(155.204, 982.704)`, ground 0.8506 m |
| 3 laps | **853.3572 m** |
| ground range | 2.222 m (the lap descends ~1.6 m from the start to checkpoint 1 and climbs back) |
| min exact band | **11.75 m** (median 14.75 m) - a 2.276 m car has 4.74 m spare half-width |
| island | 43 m x 115.5 m sloped ridge in `x 146..189, z 891.5..1007` |
| respawn band | 1.25 m (declared rule; the River P67 value, no lap has been driven here) |

The ring is an elongated oval around the ridge; the full 1,152-point polyline is
in `_work/map-laps/usa_amboy/loops.json` (`loops[id=loop-01].points`, with a
parallel `ground` array). `_work/map-laps/usa_amboy/map.png` shows it in red on
the level overview.

**Reach from the committed spawn.** The loop start is in the same component as
the spawn, so a drivable path exists, but it is **1,661.993 m** long (8-connected
raster BFS) for a 243.788 m straight line: the dune network snakes. A race that
keeps the committed spawn and adds this lap would need a 1.66 km connector, so
the lap is effectively a separate venue with its own start.

### 5.4 Sensitivity model

With `stepLimit 0.30 / gradeLimit 0.30` the whole drivable surface merges into
one 4,109,202-cell component and 24 loops are extracted, up to 2,653 m. **None of
them is usable**: every one fails the exact flat-footprint check with a range of
0.48-1.15 m across the 3.58 m footprint (they cross dune ridges and ledges), and
the 752 m ring reaches a 20.6 % maximum 2 m grade. The strict P48 loops are the
only validated ones.

## 6. `spa_barcelona_gracia`

### 6.1 Components and islands

| measure | value |
| --- | ---: |
| raster | 7,260,817 cells at 0.5 m |
| passable | 572,553 cells / 143,138.25 m2 |
| components | **486** |
| spawn component | **171**, 64,566 cells / 16,141.5 m2 |
| measured path | **541/541 samples in component 171** (the whole 624.914 m course) |
| enclosed islands | 176 (3,020 cells), **3 >= 100 m2** |
| islands in component 171 | **1**, largest **2.25 m2** (9 cells) |

So the 624.914 m course component is a corridor with a single 9-cell pinhole. A
component with no enclosed island of usable size has no non-contractible cycle.

### 6.2 Candidate loops (P48 model)

| loop | component | length m | survival | max step | max band | min wall | draw cover | engine |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| loop-01 | 180 | 67.8883 | 2 (tight) | 0.22 cm | 9.25 m | none in band | **1.000** | 136/0/0 |
| loop-03 | 293 | 61.0356 | 6 | 0.00 cm | 10.75 m | 2.034 m | 0.209 | 123/0/0 |
| loop-02 | 79 | 60.5854 | 2 (tight) | 0.05 cm | 3.75 m | none in band | **0.000** | 122/0/0 |

loop-01 circles a 175.5 m2 **void** (560 no-surface cells + 142 step/grade cells)
- a real obstacle - and is 100 % drawn, but it is a 68 m plaza ring, not a course.
loop-02 is not drawn at all; loop-03 is only 21 % drawn.

### 6.3 Why there is no lap on the course

| fact | measurement |
| --- | --- |
| course component islands | 1, area 2.25 m2 (9 cells) |
| reach from the spawn | **unreachable** for all three loops (different components) |
| nearest ring component | 180 (18,294 cells / 4,573.5 m2), **1.581 m** from 171 at `(800.0, -115.5)` -> `(800.5, -114.0)` |
| the barrier | **no steep face**: exact ground rises 129.832 -> 129.930 m over 1.581 m |
| why it separates | 6.2 % grade = **3.1 cm per 0.5 m cell**, just over the 2.5 cm P48 limit |
| car envelope + margin | 2.276 m |

This is the honest nuance: the gap is **not a wall**, it is a smooth ramp that the
5 % rule rejects. Under the sensitivity model the ramp connects and the ring
becomes part of the 624 m course component.

But the resulting large ring is **not the street circuit**:

| sensitivity loop | length m | ground | draw cover | exact verdict |
| --- | ---: | --- | ---: | --- |
| loop-03 | 1,187.0023 | 100.0 .. 113.7 m | **0.337** (786.5 m of gaps) | fails footprint on 1,042 samples |
| loop-01 | 993.6787 | 190.2 .. 208.0 m | 0.532 | fails footprint + wall (0.525 m) |
| loop-02 | 418.7130 | 158.5 .. 180.1 m | 0.432 | fails footprint |

The road sits at y ~ 130 m; these rings run 20-80 m below it, on terrain, and
two thirds of the 1,187 m ring has no draw within 0.5 m of the collision. The
footprint failures are **longitudinal**: at arc 473.5-570.75 the front-back
height difference is 0.29-0.57 m while left-right is ~0.00 m, i.e. a sustained
8-13 % grade, not a lateral ledge. So the ring is a terrain loop, not a raceable
drawn circuit, and the flat-car footprint proxy is the wrong instrument for a
graded road - both facts are recorded rather than resolved into a claim.

## 7. Validation

### 7.1 Independent exact-triangle verifier (`verify_map_loops.py`)

Shares no raster, erosion, search or metric code with the builder. It re-parses
the physics file, builds its own 4 m bucket index and, for every 0.25 m sample,
re-measures ground at the centre and eight footprint points, missing ground,
footprint height range (<= 0.20 m), cyclic step and 2 m grade at the declared
model limits, exact XZ distance to every steep face whose height band intersects
the car (>= 1.138 m), the perpendicular flat band (>= 2.276 m), the closure seam
(<= 1.0 m), the recomputed length and the canonical hash.

| map | loops | result |
| --- | ---: | --- |
| `usa_amboy` | 6 | **PASS, 0 failures** (60 checks: 6 x 9 loop + 6 global) |
| `spa_barcelona_gracia` | 3 | **PASS, 0 failures** (33 checks: 3 x 9 loop + 6 global) |
| `usa_amboy` sensitivity | 24 | FAIL - 34 failed checks (footprint range 0.48-1.15 m) |
| `spa_barcelona_gracia` sensitivity | 6 | FAIL - 4 failed checks (footprint/wall on the big rings) |

### 7.2 Engine collision trace (`verify_engine_map_loops.mjs`)

One world is created at the measured spawn. Every 0.5 m loop sample is queried
with the engine's own `FillCache`/`Trace` ground probe and eight horizontal rays
at +0.20 m and +1.00 m in the car frame; a hit inside the footprint support +
0.05 m is a hard violation, inside support + 0.30 m a safety-margin violation.

| map | samples | hard | safety margin | max engine step | max engine 2 m grade |
| --- | ---: | ---: | ---: | ---: | ---: |
| `usa_amboy` (6 loops) | 1,856 | **0** | **0** | 2.14 cm | 4.27 % |
| `spa_barcelona_gracia` (3 loops) | 381 | **0** | **0** | 0.44 cm | 0.89 % |

Control: the first 29 m of each measured path, 23 samples (Amboy) / 26 samples
(Gracia), 0 wall hits, 0 missing ground, max step 4.91 cm / 0.15 cm.

**Engine ground-probe window.** `e1_ground_probe` starts its ray at y = 130.0.
Gracia's road is at y ~ 130, so the probe misses most of the course (47/400 path
samples hit). The trace therefore falls back to a vertical `e1_ray_probe` from
2 m above the raster ground, which is still the engine's own
`FillCache`/`Trace`, not a synthetic surface. The fallback count is recorded per
loop (`downRaySamples`). Amboy needs no fallback.

### 7.3 Draw coverage (`coverage_map_loops.py`)

The committed map-pipeline rule, unchanged: covered = a declared first-RenderList
draw triangle lies within 0.5 m of the collision height. Three stations per
sample (centre, +/-1.0 m).

| map | draw triangles / sections | result |
| --- | --- | --- |
| `usa_amboy` | 348,948 / 48 | loop-01 **100 %**, loop-05/06 100 %, others 20-57 % |
| `spa_barcelona_gracia` | 550,632 / 88 | loop-01 **100 %**, loop-02 0 %, loop-03 21 % |

Airborne geometry is irrelevant here: the rule compares the *nearest* draw
triangle height with the collision height, and the recorded maximum delta on
Amboy loop-01 is 4.42 cm.

### 7.4 Determinism

Two full runs of the pipeline (build, verify, coverage, layout, map, engine
trace, reach) produced byte-identical artifacts - all 18 files compared
`SAME`. Final file hashes:

| artifact | file SHA-256 |
| --- | --- |
| `_work/map-laps/usa_amboy/loops.json` | `05afd517eccce44c9bb041d76f07027336ef0ee89a2d90d211f2a5560333b79b` |
| `_work/map-laps/usa_amboy/verify.json` | `c42a2b9217b812e56e6a271da12abf08c26764678db357d8888d85ea69463542` |
| `_work/map-laps/usa_amboy/coverage.json` | `b05b831f8eeb2662f16437e411bfa81060365c1d6ab4f78827a66607d9997847` |
| `_work/map-laps/usa_amboy/layout.json` | `8fb1c837d176f1b57f683524513608f40c2e7a650b333e1452a70d391b07b986` |
| `_work/map-laps/usa_amboy/engine-trace.json` | `4ae589b902b73a340714117e0a57caee37f72123ec4ea90a2b441e4facaf5825` |
| `_work/map-laps/usa_amboy/reach.json` | `93c3cc68a70a2972aa3c543bef26144299708fcff430c475c8510740b9288cb8` |
| `_work/map-laps/usa_amboy/map.png` | `2c97e503386d5d1e93780c7a7086fed41f421f1d6e4f54ee8cd6d49fefab0af1` |
| `_work/map-laps/usa_amboy/map.svg` | `ecfb645c1cd79ac23569f130273b4852f0f97ec73ccabfdb49cacd2863b52db6` |
| `_work/map-laps/usa_amboy/grid.npz` | `251db275c4e4a2516b353e398429e249f9c794eb7e38c4a9639c07d316d84c9b` |
| `_work/map-laps/spa_barcelona_gracia/loops.json` | `fab958d95c3665597754c09cd6774d1d5a4d03bac40d15d6b249d6a5115ecaf1` |
| `_work/map-laps/spa_barcelona_gracia/verify.json` | `8677f7abf21da1722ca068324df78a6f16102bc34bb9f66e936908cd9932c1c4` |
| `_work/map-laps/spa_barcelona_gracia/coverage.json` | `315b11d2db07d481ef56a21afd2bf17f0ad6b4a76aacab09d343907fa8a3717b` |
| `_work/map-laps/spa_barcelona_gracia/layout.json` | `d3147733176118d85b18aab60a3c28ddb3bcd51f5b44fc0b853a22a697db0699` |
| `_work/map-laps/spa_barcelona_gracia/engine-trace.json` | `0992d2a77c8422b33e2b4ff36069e4649ab932f4b827db0d3c9ac96c3c5f5b0d` |
| `_work/map-laps/spa_barcelona_gracia/reach.json` | `f38fe067c4ea098cf2e4a9f6ace18e9ecf04e911f11749e603d6741937a35872` |
| `_work/map-laps/spa_barcelona_gracia/map.png` | `db6cb0f06018d25a2d80129b477ddd9fc0716588d946812809783a871dfc9a3f` |
| `_work/map-laps/spa_barcelona_gracia/map.svg` | `5e7e16eb55fdab63ef74afdf9376d1197cba42b83c9f61a07ddc762a659d4a74` |
| `_work/map-laps/spa_barcelona_gracia/grid.npz` | `042183edc26ea7c5abfbcce2a93ed0b7d538dc014e51aa7bcf882bb62dbf4017` |

Canonical body hashes (`doc["hash"]`):

| artifact | `usa_amboy` | `spa_barcelona_gracia` |
| --- | --- | --- |
| `loops.json` | `sha256:9c9997068a65e10eb5d9e056b738286596f1dd08ebfc4fc5e63a79f5e7bbc476` | `sha256:ba4ecf522cef4848a6dd5a04327b001768d59f6e1eaac732878a1cf8a67d3016` |
| `verify.json` | `sha256:c113a0782002228f9a60ad4a7c17e72bb7404403f6b56a9e440736f7015d0869` | `sha256:79f9952a0f20ea757697ca82adf28cb65e54bf98bfca36fcac2e58016da2398b` |
| `coverage.json` | `sha256:6f4f45210b65cb684469aa901138f8cdd9436eef69012e54166799b3590f3537` | `sha256:320d1e5e468db4af1c96657bd04ff91e8ee47c2ab2b5330288c8d1063950ef14` |
| `layout.json` | `sha256:de16213f8136bc8cdf6e09007f4ddc51718149db30431888cb0fb8fb59aa1044` | `sha256:3bd5f704a5a229dcafef5c5d7e3e3d544b654f5def27f0636b9384e5d457f365` |
| `engine-trace.json` | `sha256:e514d054c9d548174a70cdc246712192ecdd50eb3d3d0ddc68a17e6defa1114c` | `sha256:007f45434b11ab4ab35f8b0737a15a0a993aa87f488df608c63bcb4512113098` |
| `reach.json` | `sha256:eafc9ae2ac6c9a229c7f9b72d33ad36c19836b96321dd1fd67a238db185fa1f4` | `sha256:51db9cb348a9ab63827ab7960768d169e4d152358d2bd885b073844ac44fa8e0` |

The two runs were consecutive executions of the final code; the layout emits its
own hash and the map PNG/SVG are deterministic Pillow/SVG output.

### 7.5 P61 regression

`probes/lap-search/tools/verify_loops.py` is imported unmodified and run with its
`OUT` redirected to `_work/map-laps/p61-regression/`, so no `probes/lap-search`
or `_work/lap-search` file is written. It re-reads the committed
`_work/lap-search/loops.json` (file `2aabf0cd…`, canonical `acc47b6b…`), passes
**34/34 checks** and reproduces the recorded verify hash
`sha256:ced92399c7c0394aad605aa582af43669157a4a8b2cc07bef164a4ecfe2a7236`.
Every `_work/lap-search` artifact was hashed before and after: identical.

## 8. Hand-off

### 8.1 Amboy 3-lap course

`_work/map-laps/usa_amboy/layout.json` (content hash
`sha256:de16213f8136bc8cdf6e09007f4ddc51718149db30431888cb0fb8fb59aa1044`):

| field | value |
| --- | --- |
| loop | `loop-01`, component 510, 284.4524 m, 1,152 samples |
| laps | 3 (total **853.3572 m**) |
| spawn / start line | `x 179.5, z 889.5`, ground 1.8430, heading **1.712699381 rad** |
| start/finish line | perpendicular to the 5 m tangent, half-width 2.0 m (4 m line), endpoints `(179.2171, 887.5201)` - `(179.7829, 891.4799)` |
| checkpoint 1 | `(183.016, 971.474)`, arc 93.215 m, heading -0.189197 |
| checkpoint 2 | `(155.204, 982.704)`, arc 186.763 m, heading 2.912201 |
| finish | same point as start, arc 284.4524 m |
| respawn band | 1.25 m half-width (declared) |
| evidence | exact PASS, engine 0/0, draw coverage 1.000 |

### 8.2 Gracia

The recommendation is **not** to move the start. The 624.914 m point-to-point
course stays. If a lap is mandatory for a mode, the only exact-clean, fully drawn
ring is `loop-01` in component 180:

| field | value |
| --- | --- |
| loop | `loop-01`, component 180, 67.8883 m, 283 samples, tight (k=2) |
| spawn / start | `(583.5, -68.0)`, ground 130.1000, heading **1.505665847 rad** |
| 3 laps | 203.6649 m |
| band | 9.25 m; island = 175.5 m2 void |
| caveat | component 180 is a 4,573.5 m2 strip parallel to the course, **1.581 m** from it across a 6.2 % ramp; this is a plaza oval, not the retail circuit |

`_work/map-laps/spa_barcelona_gracia/layout.json`
(`sha256:3bd5f704a5a229dcafef5c5d7e3e3d544b654f5def27f0636b9384e5d457f365`).

### 8.3 What integration still needs

`layout.json.integration` lists the gaps; the blocking ones:

1. `probes/e1-drive/web/sprint-layout.js` pins exactly one River artifact
   (`LAP_LOOPS_PATH`: `_work/lap-search/loops.json`, loop-01, component 5,
   `lapCourseSamples()` refuses any other hash). A per-map pin and a per-map
   `deriveLapCourseLayout` call are required. My loops.json schema matches the
   fields it reads (`kind/version/hash`, `loops[].id/length/points/component/
   closed`), but the artifact is a different file with a different hash.
2. e1-drive builds its packet and gate layout from River; the map slice package
   needs a per-map geometry packet (map id, draw ranges, index buffer) before a
   browser lap can be rendered.
3. Gate lines are rules geometry only. No gate mesh, start banner, race director,
   lap timing or respawn rule exists for either map.
4. Props/power-up colliders are not measured by this probe (a separate prop
   collision profile would be needed for a race).
5. Retail route records: `Level.levelphysics` carries a route count, but routes
   are not parsed by the committed scanner, so the retail start line is unknown.
6. The gate lines were measured only at 0 / +/-1 m stations; a full 4 m gate-line
   draw-coverage check is not in `coverage.json`.

## 9. Limits

- **Collision only.** No draw geometry, materials, textures, culling or GPU state
  is read for the loop search. Draw coverage is a separate 0.5 m height test and
  is not a rendered frame.
- **Geometric/trace drivability, not a driven lap.** No car, steering, speed,
  suspension or lap timing is simulated.
- **The wall mask is conservative.** It includes one-sided faces the engine thin
  trace ignores, so it can disconnect or shorten the model; it cannot create a
  false pass. Every loop is validated by exact triangles and the engine trace.
- **The 0.30 m margin is an assumption.** The XT roster gives wheelbase and track
  width, not body overhangs.
- **The 100 m2 island threshold is a choice.** Smaller islands are counted (988 in
  Amboy, 176 in Gracia) but not promoted.
- **The 5 %/2.5 cm rule is a River rule.** It rejects a 6.2 % Gracia ramp and
  splits many visible road rings; the sensitivity model is recorded next to the
  claim, not instead of it.
- **The flat-footprint check is a flat-car proxy.** It fails a sustained grade
  (front-back height difference) as well as a ledge; on Gracia's terrain ring the
  failures are longitudinal, and that is stated rather than resolved.
- **Only static triangle meshes.** `InstancedTriangleMesh` (1 shape in Amboy, 38
  in Gracia) and the simple Box/Cylinder shapes are not in the raster.
- **One line per loop.** The lap length is the inner clearance contour at the
  stated erosion, not a racing line.
- **No renderer/GPU/game claim.**

## 10. Evidence

| path | content |
| --- | --- |
| `_work/map-laps/usa_amboy/loops.json` | components, islands, 6 loops with per-sample ground, barriers |
| `_work/map-laps/usa_amboy/verify.json` | exact-triangle verifier, PASS |
| `_work/map-laps/usa_amboy/engine-trace.json` | engine ground + 8 x 2 rays, 0 violations |
| `_work/map-laps/usa_amboy/coverage.json` | draw coverage per loop |
| `_work/map-laps/usa_amboy/layout.json` | 3-lap hand-off: spawn, heading, gates, finish |
| `_work/map-laps/usa_amboy/map.png`, `map.svg` | top-down diagnostic + loop zoom |
| `_work/map-laps/usa_amboy/grid.npz` | height / base / wall / dh rasters |
| `_work/map-laps/spa_barcelona_gracia/*` | the same seven artifacts |
| `_work/map-laps/usa_amboy/relaxed/*`, `spa_barcelona_gracia/relaxed/*` | labelled sensitivity runs (not the claim) |
| `_work/map-laps/spa_barcelona_gracia/ground-coverage.json` | engine ground-probe coverage of the course (47/400) |
| `_work/map-laps/{usa_amboy,spa_barcelona_gracia}/reach.json` | geodesic reach from the committed spawn to each loop start |
| `_work/map-laps/p61-regression/regression.json` | P61 verifier replay, 34/34, artifacts untouched |
| `_work/logs/map-laps/*.log` | every build, verify, engine, coverage, map, reach and repeat run |
| `probes/map-laps/tools/*` | builder, verifier, engine trace, coverage, layout, map, reach, regression |
| `probes/map-laps/README.md` | commands, results, hashes, limits |
