# Drivable path — longest collision-only course on USA LA River

**Date:** 5 November 2026
**Owner:** P48 (sub-agent)
**Scope:** `probes/drivable-path/**`, `_work/drivable-path/**`,
`_work/logs/drivable-path/**` and this document. No change to `probes/e1-drive`,
`probes/track-coverage`, `probes/collision-oracle`, the engine, `tools/`,
`upstream/` or `game-data/`. The collision oracle parser is imported read-only;
the e1-drive wasm is called read-only for collision traces. No renderer, GPU,
browser, vehicle-physics or playable-game claim is made.

## Result

The longest **collision-only drivable course** from the committed spawn
`(-88, 1050)` is **310.395 m** to `(103.5, 1292.5)`, ending where the collision
surface narrows to **2.0 m** — below the 2.276 m car envelope plus safety margin.
The course is engine-clean: **0 wall hits in 621 samples** of the engine's own
`FillCache`/`Trace` query, max step **1.55 cm**, max 2 m grade **3.09 %**. The
independent exact-triangle verifier agrees: **8/8 checks**, max step 0.77 cm,
max grade 3.09 %, footprint height range 0.147 m, minimum distance to a steep
collision face **7.78 m**.

This is **not** the 539.81 m draw corridor. That corridor is not drivable: its
centre line crosses a 6.36 cm section-join rise and two 50 m vertical faces, and
it has no notion of a wall. The collision-only river bed takes a different route
north-east from the spawn and is walled off from the corridor's eastern basin by
the measured narrowing.

## 1. Question

The E1 slice has a 29 m straight sprint and a 539.81 m *draw-covered* corridor
that no car can drive. The open question was whether the collision mesh itself
contains a longer genuinely drivable channel, independent of draw coverage. The
answer must come from `Level.levelphysics`, a car footprint from the XT data,
and the engine's own collision trace — not from a hand-drawn route and not from
"a draw triangle is nearby".

## 2. Inputs and provenance

| input | bytes | SHA-256 |
| --- | ---: | --- |
| `game-data/Blur/levels/usa_la_river/Level.levelphysics` | 1,945,409 | `1e678b2dff61b6d3a3d5d95a5160c3f713290251667cb27c55e262175efe4e28` |
| `_work/e1-drive/cars.json` (RP_CarDynamics XT decode) | 31,672 | `be8843030ce86983f42d6addf05ef5653481037d0f9ec16c30f2b802706aa97f` |
| `_work/e1-drive/spawn.json` | 289 | `09f9bd38264fe0363280d94ca34ec5b7356e7d28b94d5451015b87688de8604e` |
| `_work/e1-drive/module/e1_drive.wasm` | 1,006,186 | `836e7764985ba29dec026f5fe6376a6d75b3b3054b696f0484249e7e6626fdb8` |
| `probes/collision-oracle/tests/reference_oracle.py` | 48,842 | `2d7e5aecbff57f2d119e4ca0aa9d6904194ce6c7080ef5c546edb944e75f438a` |

The collision mesh is decoded by the committed oracle parser (v2 format
contract, `docs/work/analysis/t005-collision-oracle.md`). Two meshes, 44,244
triangles, identity instances. No vertex, normal, transform or path point is
invented. The car envelope is read from the five-car roster:

| car | wheelbase (m) | front track (m) | rear track (m) | tyre radius (m) |
| --- | ---: | ---: | ---: | ---: |
| Corvette ZR1 | 2.652 | 1.656 | 1.637 | 0.356 |
| Lotus Exige | 2.323 | 1.424 | 1.540 | 0.326 |
| Dodge Challenger | **2.981** | 1.482 | 1.589 | 0.370 |
| Ford Focus RS | 2.787 | 1.608 | 1.618 | 0.326 |
| Audi R8 V10 | 2.635 | 1.627 | **1.676** | 0.326 |

The harness box proxy is `trackWidth × 2·tyreRadius × wheelBase`. The clearance
envelope is the widest/longest proxy in that roster — **2.981 m × 1.676 m** —
plus a labelled **0.30 m** margin on every side. The XT data does not contain
body overhangs or a racing margin; the margin is an assumption, stated as such.

## 3. Method

### 3.1 Surface model

1. Rasterise the highest up-facing collision triangle at **0.5 m** XZ cells.
   Only triangles with `normal.y > 0.94` (≤ 20° slope) are drivable surface; a
   steep bank is not road.
2. A cell is passable when it has a surface, every 8-neighbour is present, and
   the maximum neighbour height difference is ≤ `min(0.05 m, 0.05 × 0.5 m)` =
   **2.5 cm**. This is a 5 % edge grade, with a 5 cm absolute step cap.
3. Rasterise every steep triangle (`|normal.y| < 0.5`) whose height band reaches
   the local ground +0.05…2.0 m, project it to XZ, and dilate by 0.5 m. This is
   the **wall mask**; a height raster alone cannot see a thin vertical fin on
   otherwise level ground. A 50 m face whose top is *below* the road is ignored
   by the height gate (a retaining wall under the road is not an obstacle).
4. Erode the passable mask by 2 cells (1.0 m, 8-connected). This is a **search
   heuristic**; the final claim uses the exact car envelope and the engine trace,
   not the erosion.
5. BFS the eroded component from the spawn cell; Dijkstra with 0.5/0.7071 m
   edge costs; no diagonal corner cutting. The geodesic farthest cell is the
   longest point-to-point course from the spawn.
6. Taut the path with visibility string-pulling on the same component and
   resample at **0.25 m**. The course starts exactly at the committed spawn.

The model constants are recorded in `path.json` under `model`; the car envelope
under `inputs.carEnvelope`.

### 3.2 Why these limits

The engine evidence from `T-007-ledge-fix.md` is the calibration:

- the box-proxy chassis rides on a skid plate at ground level;
- it climbs a **2.5 %** grade elsewhere;
- it is stopped by the **6.36 cm in 0.94 m (6.7 %)** `g58 → g50` section join;
- it is stopped laterally by 50 m faces.

A 5 % grade cap and a 5 cm step cap are therefore conservative: below the
measured failure and above the measured success. The course's actual 3.09 %
maximum grade is inside both bounds.

## 4. Course

| field | value |
| --- | --- |
| length | **310.395 m** |
| start | `(-88.0, 1050.0)`, ground 5.8074 m |
| end | `(103.5, 1292.5)`, ground 5.8813 m |
| samples | 1,245 at 0.25 m |
| final heading | 54.36° (north-east) |
| max step | 1.55 cm engine / 0.77 cm exact oracle |
| max 2 m grade | 3.09 % (both) |
| footprint height range | 0.147 m (limit 0.20 m) |
| min steep-face distance | 7.78 m |
| min blocked-cell distance | 1.41 m |
| component | 38,758 cells = 9,689.5 m², bbox x −129…282, z 819…1319 |

Every 25 m:

| arc | point |
| ---: | --- |
| 0.0 | (−88.00, 1050.00) |
| 25.2 | (−70.49, 1068.15) |
| 50.2 | (−53.16, 1086.11) |
| 75.1 | (−35.83, 1104.08) |
| 100.1 | (−18.50, 1122.05) |
| 125.1 | (−1.17, 1140.02) |
| 150.2 | (15.00, 1159.20) |
| 175.1 | (29.08, 1179.74) |
| 200.1 | (42.83, 1200.56) |
| 225.0 | (56.59, 1221.38) |
| 250.2 | (68.44, 1243.61) |
| 275.2 | (82.99, 1263.90) |
| 300.2 | (97.53, 1284.18) |
| 310.4 | (103.50, 1292.50) |

The line is a smooth north-east sweep through the river bed. It is not the
539.81 m draw corridor; it leaves the spawn on the opposite side of the measured
cliff and follows the open collision surface.

`path.json` also records the builder's raster-read audit values (max step
0.0234 m, max 2 m grade 3.47 %, min blocked-cell distance 1.414 m). The
verified values in the table are from the exact oracle and the engine trace and
are the claim; the raster values are the conservative search view.

### 4.1 The stop, measured

Beyond the endpoint, along the final heading:

| ahead | physical surface width | note |
| ---: | ---: | --- |
| 0 m | 3.5 m | last point of the eroded component |
| 2 m | 3.0 m | |
| 3 m | 2.5 m | |
| **4 m** | **2.0 m** | first width below the 2.276 m car envelope + margin |
| 5 m | 0.5 m | surface ends |

The exact 4 m point is `(105.83, 1295.75)`. The nearest steep collision face is
**7.78 m** away, so this is a **ledge/void narrowing**, not a wall. The car
envelope plus 0.30 m margin is 2.276 m wide; 2.0 m is below it, so the course
ends. This is a real clearance limit, not a tuning choice.

### 4.2 Rejected candidates (recorded, not hidden)

| candidate | length | stop | why rejected |
| --- | ---: | --- | --- |
| T-007 draw corridor | 539.81 m | 6.36 cm / 0.94 m rise at arc 52.66; 50 m faces at 57.82 / 530.71 | draw coverage includes cliffs; the centre line has no wall test |
| no-wall-mask collision route | 555 m | solid 50 m face at `(-85.15, 1039.9)` | the engine trace hits it 0.34 m behind the car on 4 samples / 18 hit points |
| 1.5 m-erosion collision route | 223.277 m | narrowing at `(56.0, 1219.5)` | stricter clearance variant; the 1.0 m search plus exact checks finds 310.395 m and still passes the envelope |

The 555 m route is the important one: it is what a pure height raster reports.
It looks drivable because the cliff face at `(-85.15, 1039.9)` is a thin fin, and
the ground on both sides is at the same height. The engine trace caught it. The
wall mask was then enabled for the search, and the route became the 310 m
north-east course.

## 5. Verification

### 5.1 Engine collision trace (`verify_engine_trace.mjs`)

Reads `path.json`, resamples at 0.5 m, and for each sample:

- `_e1_ground_probe` → the engine ground (same `FillCache`/`Trace` path as the
  wheels);
- eight horizontal `_e1_ray_probe` rays from the car centre at +0.20 m and
  +1.00 m above ground, in the car frame (forward, back, left, right, four
  diagonals);
- a hit is a **hard violation** inside the car footprint support + 0.05 m, and a
  **safety-margin violation** inside the support + 0.30 m.

Recorded: **621 samples, 0 hard violations, 0 safety-margin violations**, max
step **0.015457 m**, max 2 m grade **0.0308899**. The 29 m P37 sprint control
(z = 1050, x = −88 → −59) is also engine-clean: **0 wall hits**, max step
0.01642 m.

### 5.2 Independent exact-triangle verifier (`verify_path.py`)

Shares no search code with the builder. It re-parses the level, builds its own
bucket index, and for every 0.25 m sample:

- exact ground height (highest up-facing triangle) at the centre, four car
  corners and four edge midpoints;
- no missing ground and no ledge: footprint height range ≤ 0.20 m;
- adjacent step ≤ 5 cm and 2 m grade ≤ 5 %;
- exact XZ distance to every steep triangle whose height band intersects the car
  at that sample (solid or one-sided; no engine filter) ≥ half-width;
- the recorded canonical hash.

Recorded: **8/8 checks passed**, min wall distance **7.7836 m**, footprint
maximum range **0.14691 m**, length matches the recorded 310.3952 m.

### 5.3 Determinism

Repeated runs produce identical canonical hashes:

| artifact | canonical hash |
| --- | --- |
| `path.json` | `sha256:4b725b10e6619e7cc2f3ef0b0ea03f3a252660a8ffaad0ffe04cb96e0318605b` |
| `verify.json` | `sha256:f5e5ffb6e309e4c1b8d554a2e527ff0e7f1c7e8c4c82ccf4972fc6a8b5abef53` |
| `engine-trace.json` | `sha256:3035bf36e5428b9d623df1e661cf5f464da4d4a876f192f19bedff3afe655217` |

File hashes are in `probes/drivable-path/README.md` §6. The path search uses
deterministic heap tie-breaking; no timestamps or locale-dependent values are
written.

## 6. Limits

- **Collision-only.** No draw geometry is read, so the course is not claimed to
  be drawn, textured or visible. It is a statement about `Level.levelphysics`.
- **Engine trace, not a driven lap.** The trace is the same `FillCache`/`Trace`
  the wheels use, but no car is simulated. Steering, suspension travel and speed
  are not modelled. The 5 cm / 5 % caps are conservative proxies for the measured
  box-proxy limits.
- **The wall mask is stricter than the engine.** It includes one-sided faces
  the engine's thin trace ignores (measured at `x ≈ -71.3` on the 29 m sprint).
  This can shorten the reported course, never lengthen it falsely.
- **The 0.30 m margin is an assumption.** XT gives wheelbase/track width, not
  body overhangs. The exact envelope is recorded in `path.json`.
- **One component.** The 310 m course is the farthest point in the spawn
  component. No lap is claimed; the component is a one-way band in this model,
  and the eastern basin is separated by the measured narrowing.
- **No materials, opponents, laps or game loop.**
- **Native-vs-wasm parity** is irrelevant here: only the wasm collision trace
  and the Python oracle are used; no renderer or GPU path is involved.

## 7. Recommended next course

1. **Use the 310.395 m course as the next sprint extension**, not the 539.81 m
   draw corridor. It starts at the existing spawn, needs no layout invention,
   and is engine-clean at 621 samples.
2. **Place the finish before the narrowing**, e.g. at arc 300 m `(97.53, 1284.18)`
   or at the measured end `(103.5, 1292.5)`. The 2.0 m narrowing at +4 m is the
   natural stop; a finish 5–10 m before it avoids a car sitting on the lip.
3. **Keep the 29 m sprint as a regression control.** It is engine-clean and
   unchanged.
4. **If a longer course is wanted**, the next blocker is the 2.0 m narrowing.
   It is a surface/void limit, not a wall; the options are a narrower car (not
   available in the roster) or accepting a smaller margin (the exact 2.276 m
   envelope already needs 0.30 m). Do not "fix" it by moving the path line: the
   surface is genuinely 2.0 m there.
5. **Do not re-use the draw corridor line** for a course without a wall test.
   The 555 m collision-height route is the measured counter-example: a thin 50 m
   fin at `(-85.15, 1039.9)` is invisible to a height raster and solid to the
   engine.

## 8. Evidence

| path | content |
| --- | --- |
| `_work/drivable-path/path.json` | course, model, barrier, hashes |
| `_work/drivable-path/path.svg` | top-down collision map + course |
| `_work/drivable-path/path.html` | the map with the result table |
| `_work/drivable-path/path-map.png` | headless-Edge screenshot of the map |
| `_work/drivable-path/verify.json` | independent exact-triangle re-measure, PASS |
| `_work/drivable-path/engine-trace.json` | engine ground/wall trace, 0 violations |
| `_work/drivable-path/grid.npz` | height / passable / component / wall rasters |
| `_work/logs/drivable-path/` | every build, verify, probe and repeat log |
| `probes/drivable-path/tools/build_path.py` | traversability + Dijkstra + taut path |
| `probes/drivable-path/tools/verify_path.py` | independent oracle verifier |
| `probes/drivable-path/tools/verify_engine_trace.mjs` | engine collision trace |
| `probes/drivable-path/tools/build_map.py` | SVG/HTML map |
| `probes/drivable-path/tools/stats_edges.py` | surface step statistics |
| `probes/drivable-path/tools/explore_surface.py`, `explore_layers.py` | exploratory measurements |
| `probes/drivable-path/tools/inspect_path.py`, `inspect_junction.py` | endpoint/junction diagnostics |
| `probes/drivable-path/tools/make_engine_blocks.py` | engine-hit → blocker iteration |

## 9. Visual coverage of the course (P51)

**Date:** 5 November 2026
**Owner:** P51 (sub-agent)
**Scope:** `probes/drivable-path/**`, `_work/drivable-path/**`,
`_work/logs/drivable-path/**` and this section. No change to `probes/e1-drive`,
`probes/track-coverage`, `probes/asset-reader`, `probes/collision-oracle`, the
engine, `tools/`, `upstream/` or `game-data/`. The 46-section draw map is
consumed read-only from `_work/track-coverage/visual.json`; the native level
reader is called read-only to re-extract the same geometry. No renderer, GPU,
browser or game claim is made.

### 9.1 Result

Section **`g56-n289`** — the same section the E1 slice already draws — covers
the **entire 310.395 m course**. At 1,245 samples (0.25 m) the coverage is
**100.000 %** at the centre line, at the 1.676 m car envelope and at the envelope
plus the 0.30 m margin. There are **0 gap runs** and **0.000 m of gaps**. The
drawn surface sits on the collision surface: `visual − collision` ranges
**−0.000921 … +0.000929 m**, and all 1,245 samples are inside ±1 cm.

Only **6 of the 49 draws** of the section contain the centre line
(`d29, d40, d42, d41, d37, d36`); **8 draws** are needed for the full car-width
band (`d21` and `d43` add a handful of seam samples). Those 8 ranges hold
**2,817 indices / 939 triangles**; **70 distinct triangles** contain the centre
line and **84** touch the ±1.138 m band. The drawn surface is **16.1–24.2 m
wide** across the course (median 23.3 m; the scan caps at 24 m).

The result is falsifiable and was falsified in both directions: removing the
8 attributed draws drops centre coverage to **14/1,245 (1.12 %)**, and removing
the section drops it to **0/1,245**.

### 9.2 Method

Inputs (all read-only, pinned by hash in the manifest):

| input | record |
| --- | --- |
| `_work/drivable-path/path.json` (P48 course) | canonical `sha256:4b725b10…318605b`, file `81eac0ce…230e7f` |
| `_work/track-coverage/visual.json` (46-section draw map) | `877b4dc7e1f5ece197f0776239b33d23b0350f8cf77ef462c0c7a266a6abcb67` |
| `game-data/Blur/levels/usa_la_river/Level.levelphysics` | `1e678b2d…fe4e28` |
| `probes/collision-oracle/tests/reference_oracle.py` | `2d7e5aec…75f438a` |

1. Load the 1,245 committed path samples (0.25 m) and the 46-section draw map.
2. Flatten every `ok` section into triangles, but **only triangles inside a
   declared draw range** (`firstIndex … firstIndex + indexCount`). A triangle
   outside every draw range is a hard error, never silently dropped: a vertex
   array is not a draw.
3. Collision height = highest up-facing `Level.levelphysics` triangle
   (`normal.y > 0.5`) containing the point. Visual height = the draw triangle
   (`normal.y > 0.1`) containing the point whose height is **nearest** the
   collision height.
4. `covered` = a draw triangle exists and `|visual − collision| ≤ 0.5 m` (the
   track-coverage surface rule). The car-width test uses seven lateral stations
   in the car frame: `0, ±0.419, ±0.838` (envelope 1.676 m) and `±1.138`
   (envelope + 0.30 m margin). A continuous width profile is scanned at 0.10 m
   steps, capped at 12 m per side.
5. Every covered sample is attributed to its section, draw index, primitive
   index and index offset. Consecutive samples with the same attribution form a
   draw span; consecutive samples with the same car-width flag form a segment.

### 9.3 Sections and draws used

| section | geometry block | node block | geometry chunk | node chunk | draws | triangles | vertices |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `g56-n289` | 56 | 289 | 121 | 71 | 49 | 9,824 | 14,508 |

| draw | primitive | index range | tris in range | arc span (m) | centre samples | band samples |
| ---: | ---: | --- | ---: | --- | ---: | ---: |
| 29 | 205 | 20,988…21,288 | 100 | 0.00–50.18 | 202 | 1,415 |
| 40 | 220 | 25,257…25,551 | 98 | 50.43–76.89 | 107 | 740 |
| 42 | 222 | 25,854…26,256 | 134 | 77.14–168.64 | 368 | 2,579 |
| 41 | 221 | 25,551…25,854 | 101 | 168.89–222.78 | 217 | 1,516 |
| 37 | 217 | 24,123…24,495 | 124 | 223.03–242.00 | 77 | 539 |
| 36 | 216 | 23,823…24,123 | 100 | 242.24–310.40 | 274 | 1,920 |
| 21 | 174 | 15,003…15,399 | 132 | band only | 0 | 1 |
| 43 | 223 | 26,256…26,706 | 150 | band only | 0 | 5 |

The six centre draws are not in index order along the road: the section is a
patchwork of segments and the course crosses it in the order
`29 → 40 → 42 → 41 → 37 → 36`. `d21`/`d43` are needed only for one and five
band stations at the 49.93–50.68 m and 185.85 m seams. Sum of the six centre
spans is 309.147 m; the remaining 1.248 m is the five 0.25 m sample transitions
between adjacent draws, not a hole (§9.4).

Section totals: **1 section, 8 draws, 2,817 indices, 939 triangles in the used
ranges, 84 triangles over the car-width band, 70 over the centre line.**

### 9.4 Gaps

**None.** `coverage.gapRuns = 0`, `gapTotalMetres = 0.000`, `firstGap = null`.
Across 1,245 samples × 7 stations = **8,715 station tests**, the failure
reasons are all zero: 0 stations without a collision triangle below, 0 without
a draw triangle above, 0 outside the 0.5 m tolerance.

The only discontinuities are the five draw-to-draw transitions. Because the
nearest triangle can change between two 0.25 m samples, those transitions were
re-tested by interpolating the 0.25 m segment at **0.02 m** (14 sub-samples
each): **0 uncovered sub-samples**. Recorded seams:

| seam (m) | sub-samples | uncovered | covered left / right (m) |
| --- | ---: | ---: | --- |
| 50.1787 → 50.4283 | 14 | 0 | 12.1 / 12.1 |
| 76.8907 → 77.1404 | 14 | 0 | 12.1 / 12.1 |
| 168.6360 → 168.8855 | 14 | 0 | 12.1 / 10.5 |
| 222.7806 → 223.0301 | 14 | 0 | 4.8 / 12.1 |
| 241.9950 → 242.2446 | 14 | 0 | 8.3 / 12.1 |

The narrowest single-side drawn run outside a seam is **4.0 m left / 8.8 m
right**; the narrowest total drawn width on the course is **16.1 m**.

### 9.5 Verification

The verifier shares no coverage, index or attribution code with the builder. It
re-extracts `g56-n289` with the **native C++ reader**
(`_work/build/asset-reader-native/Release/level_inspect.exe`, `level_mesh`),
not with the Python draw map the builder consumed, and re-parses the collision
mesh independently. It recomputes every sample's collision height, nearest draw
height, delta, covering draw, triangle offset, station flags and continuous
width, plus the coverage fractions, gaps, draw spans, totals and canonical
manifest hash.

Recorded: **PASS, 24 checks, 0 errors, 0 warnings**, including
`native-geometry-equals-manifest` (positions/indices hashes and all 49 draw
ranges identical) and `draw-seam-refinement`.

Additional collision cross-check: the oracle collision height at the 621 engine
trace coordinates agrees with the engine's own `_e1_ground_probe` to
**0.388 mm maximum** (0 samples over 1 cm). That validates the reference plane
only; the draw question is answered by the native reader.

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py probes/drivable-path/tools/build_visual_coverage.py   # manifest + samples
& $py probes/drivable-path/tools/verify_visual_coverage.py  # native reader re-measure
& $py probes/drivable-path/tools/build_visual_map.py --png  # SVG + HTML + PNG
```

Determinism: two consecutive runs of all three tools produced byte-identical
`visual-coverage.json`, `visual-coverage-samples.json`,
`visual-coverage-verify.json`, `visual-coverage.svg`, `visual-coverage.html`
and `visual-coverage.png`.

| artifact | canonical / SHA-256 |
| --- | --- |
| `visual-coverage.json` canonical | `sha256:094abf3210d45841bd88784b7d35efdb13377c4f4bb08497cf559f9dbd44f2b0` |
| `visual-coverage.json` file | `39d93da4c82774b432ef3d2ed3bebf0977fd01ca9669d7866572da9ace48c273` |
| `visual-coverage-samples.json` | `3c282672c66f364c577bf19799d53f51e9ab35b772dbb0f7e04bbd7ac3bc9be7` |
| `visual-coverage-verify.json` | `919b5eb37ea1675d642748e59015e62596a51642ad7783bb91196b46b1070acf` |
| `visual-coverage.svg` | `64e0f1422e6f00908d987a4d68f315d436ead8fa5df765357f15eda1dda5a8ad` |
| `visual-coverage.html` | `35d09dbcf52a25c858d7f189ee50e6a17415c328befad3ec3d4cec695fb1a57b` |
| `visual-coverage.png` | `a55cd0bfee66ea540072c175851b7c925f2f1cf9066f6dad956aae3bf33e6b70` |

Native reader used: `_work/build/asset-reader-native/Release/level_inspect.exe`,
SHA-256 `ec5e25178c9d256d88ff8c1aad59e0379b43d04509d784610a4daba4735c2b04`;
geometry chunk `5bc6e0bb…53e2e431`, node chunk `a0523540…9acb8a07`.

### 9.6 How to render the 310 m course

1. **Load section `g56-n289` only.** It is already the section the E1 slice
   draws for the 29 m sprint (`probes/e1-drive/tools/build_geometry.mjs`), so
   the 310 m extension needs **no new section and no new upload**. The whole
   section is 49 draws / 9,824 triangles / 14,508 vertices.
2. **If the renderer wants to submit only course geometry**, the 8 draws in
   §9.3 are sufficient (2,817 indices / 939 triangles), and the 6 centre draws
   suffice if only the centre line is needed. Keep all 8 for the full
   2.276 m band; `d21`/`d43` are tiny and only matter at two seams.
3. **No visual gap needs a labelled fallback on the course.** The drawn surface
   is 16 m or wider everywhere and matches the collision plane within 1 mm, so
   the road can be drawn strictly from the committed draws.
4. **Label the parts that were not measured.** Coverage stops at arc 310.395
   (`(103.5, 1292.5)`). The final sample lies inside a draw triangle that
   extends past it, but coverage beyond the finish was **not measured**, and
   the collision surface narrows to 2.0 m at +4 m (P48 §4.1). If the renderer
   extends the road past the finish, mark that extension as unmeasured.
5. **Arc table for culling or streaming**: `0–50.18`, `50.43–76.89`,
   `77.14–168.64`, `168.89–222.78`, `223.03–242.00`, `242.24–310.40` on the
   six centre draws. A one-draw-call submission of the whole section is
   simpler and costs 9,824 triangles instead of 939.

### 9.7 Limits

- **Symmetric 0.5 m tolerance.** The recorded deltas are millimetres, so the
  result does not depend on the tolerance; a stricter ±1 cm rule would give the
  same 1,245/1,245. The rule is still the one stated, not a hidden tightening.
- **Nearest-height rule.** Where more than one `g56-n289` triangle covers the
  same XZ point, the others lie within −0.324 … +0.408 m of the collision plane
  (verge/bank geometry; `_work/logs/drivable-path/explore2.log`). The claim is
  about the triangle nearest the collision surface, not about every triangle in
  the section. A renderer that uploads the whole section draws those triangles
  too, which is expected for a river bed.
- **First RenderList direct draws only.** `instancesApplied:false`; the 46
  sections are the committed correlated pairs, not a full level import.
  Instance-only geometry could add surfaces; it cannot remove the ones
  measured here.
- **The course only.** Coverage is measured on the committed 310.395 m path at
  its 0.25 m samples and at seven lateral stations; it is not a statement about
  the whole section, the whole river bed, or visibility from a camera.
- **Width is a height-matched covered run**, not a legal racing width, and the
  scan caps at 24 m total.
- **No materials, textures, culling, LOD selection or GPU state** are involved.
- **No renderer/game claim.** No frame was rendered and no engine frame was
  produced; the engine is used only as an independent ground-probe reference.
