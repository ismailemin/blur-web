# Lap search - closed collision-only loops on USA LA River

**Date:** 6 November 2026
**Owner:** P61 (sub-agent)
**Scope:** `probes/lap-search/**`, `_work/lap-search/**`,
`_work/logs/lap-search/**` and this document. No change to
`probes/drivable-path`, `probes/e1-drive`, `probes/track-coverage`,
`probes/collision-oracle`, the engine, `tools/`, `upstream/` or `game-data/`.
The collision-oracle parser is imported read-only; the e1-drive wasm is called
read-only for collision traces. No renderer, GPU, browser, vehicle-physics or
playable-game claim is made.

## Result

**USA LA River contains genuinely drivable closed loops, but none in the spawn
component.** The committed spawn `(-88, 1050)` lies in a component with **zero**
enclosed islands at the 0.5 m P48 model resolution, so no closed ring exists
there. Three closed loops exist in three other, disconnected components:

| loop | component | length | island | ring | verdict |
| --- | ---: | ---: | --- | --- | --- |
| **loop-01** | 5 | **222.040 m** | 812 m2: 306 m2 void + 191 m2 steep + 315 m2 step/grade | survives 6 erosions; min band 11.75 m | **best loop, PASS** |
| loop-02 | 129 | **224.225 m** | 230 m2 all step/grade (rough ridge) | survives 2 erosions; min band 7.00 m | longest, PASS |
| loop-03 | 261 | 91.130 m | 100 m2 all step/grade | survives 2 erosions; min band 11.00 m | PASS |

loop-01 is the best loop by the rule stated in §4: it is the longest loop whose
island has at least 10 % void or steep cells (a real obstacle, not only a rough
patch) and whose ring survives at least three clearance erosions. loop-02 is
2.18 m longer but circles a rough step/grade ridge with no void or steep face,
and its ring only survives two erosions; it is recorded as the longest loop.

All three loops are **engine-clean**: 0 hard and 0 safety-margin violations in
1,077 samples of the engine's own `FillCache`/`Trace` query (8 rays x 2 heights
per sample), and all three pass the independent exact-triangle verifier.

**Recommendation:** for a course that starts at the committed spawn, keep the
**310.395 m point-to-point course** from P48 as the final course. A lap requires
moving the start into component 5 (or 129/261); the nearest loop component is
separated from the spawn component by a measured **1.118 m** gap at
`(-103.5, 1004.5)` / `(-102.5, 1004.0)`, where the exact collision mesh has a
**50.0 m tall vertical face** (y 5.894..55.894, `normal.y = 0`) 2.16 cm from the
crossing line. The car envelope plus margin is 2.276 m. This is a level
structure, not a gate layout change.

## 1. Question

P48 measured the longest collision-only **point-to-point** course from the
committed spawn: 310.395 m, engine-clean, ending at a 2.0 m narrowing. P41
reported no lap in the *draw-covered* data. The open question here is whether
the **collision mesh itself** contains a **closed loop** a car can drive, in any
connected component, independent of draw coverage.

The answer must come from `Level.levelphysics`, the P48 traversability model and
the car envelope, and must be validated with the engine's own collision trace
and an independent exact-triangle measurement. A "loop" is not a small circle in
open ground: it is a closed path that encloses an island of non-passable
collision surface.

## 2. Inputs and provenance

| input | bytes | SHA-256 |
| --- | ---: | --- |
| `game-data/Blur/levels/usa_la_river/Level.levelphysics` | 1,945,409 | `1e678b2dff61b6d3a3d5d95a5160c3f713290251667cb27c55e262175efe4e28` |
| `_work/e1-drive/cars.json` (RP_CarDynamics XT decode) | 31,672 | `be8843030ce86983f42d6addf05ef5653481037d0f9ec16c30f2b802706aa97f` |
| `_work/e1-drive/module/e1_drive.wasm` (engine trace only) | 1,006,186 | `836e7764985ba29dec026f5fe6376a6d75b3b3054b696f0484249e7e6626fdb8` |
| `probes/collision-oracle/tests/reference_oracle.py` (parser import) | 48,842 | `2d7e5aecbff57f2d119e4ca0aa9d6904194ce6c7080ef5c546edb944e75f438a` |

The collision mesh is decoded by the committed oracle parser (v2 format
contract, `docs/work/analysis/t005-collision-oracle.md`): two meshes, 44,244
triangles, identity instances. The car envelope is the widest/longest harness
box proxy across the five-car XT roster, 2.981 m x 1.676 m, plus a labelled
0.30 m margin on every side (half-width 1.138 m, half-length 1.7905 m). The
0.30 m margin is an assumption, not an XT value; the exact envelope is recorded
in `loops.json`.

## 3. Model

### 3.1 Surface and passability

The P48 model is reused unchanged at 0.5 m XZ:

1. The highest up-facing collision triangle per cell is the surface; only
   `normal.y > 0.94` (<= 20 deg) is drivable.
2. A cell is passable when it has a surface, every 8-neighbour has a surface,
   and the maximum neighbour height difference is <= `min(0.05, 0.05 x 0.5)` =
   **2.5 cm** (a 5 % edge grade with a 5 cm absolute cap).
3. Every steep triangle (`|normal.y| < 0.5`) whose height band reaches
   local ground + 0.05..2.0 m is projected to XZ and dilated by 0.5 m: the
   **wall mask**. A height raster alone cannot see a thin fin.

The result is `base_pass`. The full level is 3,631 x 5,313 cells at 0.5 m;
1,732,487 cells are passable (433,121.75 m2).

### 3.2 What counts as a lap

A lap is a **simple closed curve in the passable cell graph that winds around at
least one enclosed island**. An island is a 4-connected region of `~base_pass`
that a 4-connected flood from the raster border cannot reach. This excludes:

- a small 4-cell raster cycle in the open (no island);
- a circle in the middle of a wide band (contractible; no island);
- an island smaller than 100 m2 (a single rock or a raster speck).

The 100 m2 threshold is a stated choice: it is 400 cells at 0.5 m, about a
11 m diameter obstacle. Islands below it are counted in `loops.json` but not
promoted to loops.

### 3.3 Ring criterion

A loop must fit the car. Erode `base_pass` by `k` 8-connected layers:

- a retained cell has every cell within Chebyshev distance `k` in the mask, so
  its Euclidean distance to the nearest non-passable cell is at least
  `(k+1) x 0.5 m`; the loop line is one of those retained cells (the boundary
  of the eroded island), so `k=2` gives >= 1.5 m and `k=3` gives >= 2.0 m;
- an island that is still enclosed after erosion `k` therefore has a ring
  around it;
- `k=1` (>= 1.0 m) is below the 1.138 m half-width and is never used;
- `k=2` (>= 1.5 m) is accepted as a labelled **tight** ring;
- `k=3` (>= 2.0 m) is the normal loop line.

The reported loop line is extracted at `k = min(3, island survival)`. A base
island that does not survive `k=2` cannot have a 2.276 m-wide car ring and is
recorded with an explicit rejection reason.

### 3.4 Path extraction

The eroded island mask is traced with a Moore boundary trace (outer boundary
only), mapped to the adjacent passable cells with continuity preserved, corner
cut four times with a supercover visibility test that never leaves the eroded
mask, and resampled at 0.25 m. The raw seam between the last and first taut
points must be <= 1.0 m and the closing chord must stay in the passable mask.
All three loops close exactly (first point == last point) with a 0.5 m raw seam.

## 4. All-component screen

The final 0.5 m scan finds **427 passable components** and **166 enclosed
islands**. Eight islands are >= 100 m2. The spawn component and the six largest
islands are:

| island | area | component | island survival | loop | what the island is |
| ---: | ---: | ---: | ---: | --- | --- |
| 0 | 812 m2 | 5 | 6 erosions | loop-01 | 1,224 void + 763 steep + 1,262 step/grade cells |
| 1 | 625 m2 | 5 | 0 | rejected | 415 steep + 2,084 step/grade; not enclosed after 0.5 m erosion |
| 2 | 369 m2 | 129 | 1 | rejected | 1,475 step/grade; not enclosed after 1.0 m erosion |
| 3 | 238 m2 | 129 | 1 | rejected | 954 step/grade; not enclosed after 1.0 m erosion |
| 4 | 230 m2 | 129 | 2 | loop-02 | 918 step/grade (rough ridge) |
| 5 | 130 m2 | 355 | 0 | rejected | 520 step/grade; not enclosed after 0.5 m erosion |
| 6 | 114 m2 | 180 | 1 | rejected | 454 step/grade; not enclosed after 1.0 m erosion |
| 7 | 100 m2 | 261 | 2 | loop-03 | 402 step/grade |

The six rejected islands are a measured result, not a silent drop: each is not
enclosed after the 1.5 m clearance erosion (survival 0 or 1 in the table), so no
loop line exists at that clearance. Their rings are at most about 3 m wide, and
a 2.276 m car envelope leaves no validated loop at the model's safety standard.
The 1 m screening pass is kept only as a diagnostic: it found 69 holes in the
spawn region that vanish at 0.5 m because the finer grid resolves drivable
connections through them. The 0.5 m grid is the P48 model resolution and
reproduces the P48 38,758-cell component exactly at erosion 2.

## 5. The best loop (loop-01)

| field | value |
| --- | --- |
| component | 5 (86,521 cells, 21,630.25 m2, bbox x -105.5..263.5, z 838..1269) |
| length | **222.0402 m** |
| start / closure | `(115.5, 1164.0)`; first point == last point, raw seam 0.5 m (threshold 1.0 m) |
| samples | 902 at 0.25 m |
| island | 812 m2, bbox x 115.5..180.5, z 1166.0..1244.0 |
| ring | survives 6 erosions (>= 3.5 m half-width); loop built at 3 (>= 2.0 m) |
| min flat band | **11.75 m** (median 13.00 m) |
| min exact steep-face distance | **2.063 m** (need 1.138 m) |
| max step | **0.40 cm** exact / 0.76 cm engine |
| max 2 m grade | **1.49 %** exact / 1.49 % engine |
| footprint height range | **6.85 cm** (limit 20 cm) |
| exact verifier | **PASS**, 9/9 loop checks |
| engine trace | **445 samples, 0 hard, 0 safety-margin violations** |

Every 25 m:

| arc | point |
| ---: | --- |
| 0.0 | (115.50, 1164.00) |
| 25.1 | (135.67, 1177.67) |
| 50.2 | (151.83, 1196.86) |
| 75.2 | (167.10, 1216.57) |
| 100.0 | (182.12, 1236.38) |
| 125.0 | (168.19, 1239.88) |
| 150.2 | (152.17, 1220.42) |
| 175.2 | (136.31, 1201.16) |
| 200.1 | (120.44, 1181.89) |
| 222.040 | (115.50, 1164.00) |

The line is an oval around the island: it runs south-east along x 115 -> 182,
turns around the south end near (168, 1240), and returns north-west to the
start. The full 902-point polyline is in `loops.json` under
`loops[id=loop-01].points`.

The island is a mixed obstacle: 306 m2 of no-collision-surface (a void/ledge),
191 m2 of steep face, and 315 m2 of step/grade cells. It is not an artefact of a
single raster rule; the exact footprint check passes on every sample and the
engine trace sees continuous ground.

## 6. The other loops

| field | loop-02 | loop-03 |
| --- | ---: | ---: |
| component | 129 | 261 |
| length | 224.2246 m | 91.1298 m |
| island | 230 m2, all step/grade | 100 m2, all step/grade |
| ring | survives 2 erosions (1.5 m), tight | survives 2 erosions (1.5 m), tight |
| min flat band | 7.00 m | 11.00 m |
| min exact steep-face distance | 2.401 m | none in the car band |
| max step exact / engine | 1.57 / 1.58 cm | 0.85 / 1.67 cm |
| max grade exact / engine | 1.00 / 0.90 % | 1.42 / 1.25 % |
| footprint range | 3.34 cm | 4.59 cm |
| samples / engine | 915 / 449 | 375 / 183 |
| verifier | PASS 9/9 | PASS 9/9 |
| engine | 0 violations | 0 violations |

loop-02 is the longest loop but its island is a rough ridge, not a void or
cliff. It is not the recommended lap: the "best" rule in §4 deliberately prefers
a loop around a real obstacle. loop-03 is short and around a step/grade patch.

## 7. Why no lap is reachable from the spawn

### 7.1 The spawn component is simply connected

`spawnComponent` in `loops.json`:

| field | value |
| --- | --- |
| id | 26 |
| cells / area | 43,651 / 10,912.75 m2 |
| enclosed islands | **0** (at every size) |
| largest island | 0.0 m2 |
| islands >= 100 m2 | 0 |

A component with zero enclosed islands has no non-contractible cycle: every
closed path in it can be shrunk to a point without leaving the passable
surface. There is therefore no lap in the spawn component at the P48 model
resolution. This is stronger than "no lap around a 100 m2 island": there is no
enclosed background region at all.

The exact P48 component is reproduced: at erosion 2 the spawn component has
38,758 cells, the same count as `_work/drivable-path/path.json`. The 310.395 m
course is the farthest-point geodesic inside that component; it is not a cycle.

### 7.2 The loop components are disconnected from the spawn

| loop component | nearest spawn cell | nearest loop cell | gap | measured barrier |
| --- | --- | --- | ---: | --- |
| 5 | (-103.5, 1004.5) | (-102.5, 1004.0) | **1.118 m** | 50.0 m vertical face, y 5.894..55.894, `normal.y=0`, 2.16 cm from the line |
| 129 | (108.5, 1297.0) | (322.5, 1379.5) | 229.352 m | separate component; straight profile 2,346/4,000 samples with no ground, max step 1.427 m |
| 261 | (108.5, 1297.0) | (1241.5, 1960.5) | 1,312.982 m | separate component; 2,994/4,000 samples with no ground, max step 6.030 m |

The comp-5 barrier is the important one because it is only 1.118 m away. The
near-approach scan finds **20 clusters** along the shared boundary, all at the
same 1.118 m cell gap; it is a continuous vertical fin, not one pinch point.
The exact nearest steep triangle at the first cluster is:

```text
triangle 43578
vertices (-102.822, 5.896, 1005.866)
         (-103.072, 5.894, 1003.612)
         (-103.072, 55.894, 1003.612)
y range  5.894 .. 55.894 m   (50.0 m tall)
normal.y 0.0                 (vertical)
distance 0.02156 m from the crossing line
ground   5.8951 m on the spawn side
```

The car envelope plus 0.30 m margin is 2.276 m wide; 1.118 m is less than half
of it. Even without the fin, the two passable cells are too close for the car.
The P48 wall mask blocks the gap; the exact triangles place a 50 m face there.

### 7.3 The engine thin trace and the one-sided face

The engine barrier probe fires the two wheel-height horizontal rays from the
spawn-side nearest cell toward the loop component:

| component | gap | rays | hits |
| --- | ---: | ---: | ---: |
| 5 | 1.118 m | 2 (0.20 m, 1.00 m) | **0** |
| 129 | 229.352 m | 2 (5 m max) | 0 |
| 261 | 1,312.982 m | 2 (5 m max) | 0 |

The comp-5 miss is the documented **one-sided-face limitation** of the
wheel-style thin trace (`docs/work/verification/T-007-ledge-fix.md` §3 and
`probes/drivable-path/README.md` §4): the oracle includes one-sided faces the
engine's thin trace ignores. It is not evidence that a car body can pass. The
exact collision mesh and the P48 wall mask both place a 50 m vertical face
across the only 1.118 m approach. A box-body collision test is out of scope; the
conservative model separation stands, and the thin trace cannot be used to claim
passage.

## 8. Validation

### 8.1 Independent exact-triangle verifier (`verify_loops.py`)

Shares no search, raster or path code with the builder. It re-parses the level,
builds its own bucket index, and for every 0.25 m sample of every loop
re-measures:

- exact ground at the centre and eight footprint points (four corners, four
  edge midpoints), using the half-width/half-length envelope;
- no missing ground and footprint height range <= 0.20 m;
- adjacent step <= 0.05 m and 2 m grade <= 5 %, **cyclically** across the seam;
- exact XZ distance to every steep face whose height band intersects the car at
  that sample, >= 1.138 m;
- exact flat-band width perpendicular to the line, >= 2.276 m;
- the canonical hash of `loops.json`.

Recorded: **PASS, 0 failures** (canonical hash, 3 global checks, 3 barrier
checks and 3 loops x 9 loop checks = 34 checks). loop-01: max step 0.00397 m,
max grade 1.4938 %, footprint range 0.06847 m, min steep distance 2.06263 m,
min band 11.75 m.

### 8.2 Engine trace (`verify_engine_loops.mjs`)

Reads `loops.json`, re-samples each closed loop at 0.5 m, and for every sample:

- `_e1_ground_probe` -> the engine ground (the same `FillCache`/`Trace` path the
  wheels use);
- eight horizontal `_e1_ray_probe` rays at +0.20 m and +1.00 m above ground, in
  the car frame (forward, back, left, right, four diagonals);
- a hit is a hard violation inside the footprint support + 0.05 m, and a
  safety-margin violation inside the support + 0.30 m.

Recorded: **1,077 samples** (449 + 445 + 183 at 0.5 m), **0 hard violations,
0 safety-margin violations**, 17,232 ray queries. The 29 m P37 sprint control is
clean: 59 samples, 0 wall hits, max step 0.01642 m.

### 8.3 Determinism

Repeated runs produce identical output:

| artifact | canonical / file SHA-256 |
| --- | --- |
| `loops.json` canonical | `sha256:acc47b6bbd0719af857323060b273e83e933bf7b86330d0362b3e70409873536` |
| `loops.json` file | `2aabf0cd04fc96b2e2cf903a392fc86fc5b2cd6e85772b9d0e8b523a0826a59c` |
| `verify.json` canonical | `sha256:ced92399c7c0394aad605aa582af43669157a4a8b2cc07bef164a4ecfe2a7236` |
| `verify.json` file | `6f1b133c6fe04d4e409f99da81ce4307f9f6cfaad7c447771d080acd6464615e` |
| `engine-trace.json` canonical | `sha256:07d888f1b191cac17d887f7b0aa598ba450b33e3a20db5f426c1a5f1ca4e5b6b` |
| `engine-trace.json` file | `01dbba4c9a2f45aa1389bcb8bb375a46802dd00807d78a426ba1f40056c25349` |
| `loops.svg` | `5226b8285ac6468d5139720b5607e3d6b18fc6fa594f5a4fbf6b8993d0d407e9` |
| `loops.png` | `6a39cc7d87f316ea93c4f2a8ac7f51c0e3a0d101cb368e81e287224463aa03e7` |
| `grid.npz` | `7fd4314dd14f4d85eea0756c1a7c98c8b36c40a8c299eac1bb9c64c3f06473fb` |

The builder and exact verifier use deterministic run orders; the map contains no
timestamps; the engine trace was re-run twice after the final `loops.json` and
was byte-identical.

## 9. Recommendation

1. **For the committed spawn, the 310.395 m point-to-point course remains the
   final course.** There is no loop in the spawn component; the three loops are
   in other components, the nearest of which is behind a 50 m vertical face at
   a 1.118 m gap.
2. **If a lap is a hard requirement, use loop-01 (222.040 m, component 5).** It
   is the only loop around a real void/cliff island, its ring is the widest
   (min band 11.75 m, six erosion survivors) and all three instruments pass.
   This requires moving the start into component 5; it is a new layout, not a
   gate change.
3. **Do not use loop-02 as the lap** even though it is 2.185 m longer: its
   island is entirely step/grade (a rough ridge, no void or steep face) and its
   ring is tight (two erosion survivors).
4. **Do not bridge the comp-5 wall.** The measured face is 50 m tall and 2.16 cm
   from the crossing line; it is level structure, not a tuning artefact.
5. **Re-measure draw coverage before rendering a loop.** This probe reads no
   draw geometry. P51's 100 % coverage result is for the 310.395 m course;
   loop-01 may or may not be drawn.

## 10. Limits

- **Collision-only.** No draw geometry, materials, textures, culling or GPU
  state is read. A loop is not claimed to be drawn or visible.
- **Geometric/trace drivability, not a driven lap.** No car, steering, speed,
  suspension or lap timing is simulated. The engine trace is the wheel-style
  `FillCache`/`Trace` path; no box-body collision is tested.
- **The wall mask is conservative.** It includes one-sided faces the engine thin
  trace ignores. It can disconnect or shorten the model; it cannot create a
  false pass. The loops are validated by exact triangles and the engine trace,
  not by the mask alone.
- **The 0.30 m margin is an assumption.** XT gives wheelbase and track width,
  not body overhangs.
- **The 100 m2 island threshold is a choice.** Smaller islands are counted but
  not promoted. The loops themselves are not sensitive to it: loop-01's island
  is 812 m2.
- **Grid phase and resolution matter for topology.** The 1 m screen finds holes
  the 0.5 m model does not. The 0.5 m result is the claim; it is the P48 model
  resolution and reproduces the P48 component cell count at erosion 2.
- **One line per loop.** The lap length is the inner clearance contour at the
  stated erosion, not the shortest possible line at 1.138 m or a racing line.
  A wider line would be slightly longer.
- **No renderer/GPU/game claim.**

## 11. Evidence

| path | content |
| --- | --- |
| `_work/lap-search/loops.json` | components, islands, three loops, barriers, hashes |
| `_work/lap-search/verify.json` | independent exact-triangle result, 34 checks, PASS |
| `_work/lap-search/engine-trace.json` | engine ground + 8 x 2 rays, 0 violations, barrier probes |
| `_work/lap-search/loops.png` | top-down map: overview + loop-01 zoom |
| `_work/lap-search/loops.svg` | vector schematic of the same map |
| `_work/lap-search/grid.npz` | base pass / wall / 0.5 m height rasters |
| `_work/logs/lap-search/explore-components.log` | 1 m all-component screen |
| `_work/logs/lap-search/explore-full05.log` | full 0.5 m components + islands |
| `_work/logs/lap-search/explore-erosion.log` | island erosion survival, k=0..6 |
| `_work/logs/lap-search/explore-barrier.log` | 20 near-approach clusters + exact faces |
| `_work/logs/lap-search/build-loops.log` | builder run |
| `_work/logs/lap-search/verify-loops.log` | exact verifier run |
| `_work/logs/lap-search/verify-engine-loops.log` | engine trace run |
| `_work/logs/lap-search/build-map.log` | map run |
| `_work/logs/lap-search/repeat-*.log` | repeat-run determinism |
| `probes/lap-search/tools/build_loops.py` | raster model, components, islands, loops |
| `probes/lap-search/tools/verify_loops.py` | independent exact verifier |
| `probes/lap-search/tools/verify_engine_loops.mjs` | engine collision trace |
| `probes/lap-search/tools/build_map.py` | PNG + SVG map |
| `probes/lap-search/tools/raster.py` | shared raster primitives |
| `probes/lap-search/README.md` | commands, results, hashes, limits |
