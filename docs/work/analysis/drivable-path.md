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
