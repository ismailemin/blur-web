# Free-roam drivable area around the E1 spawn — USA LA River

**Date:** 6 November 2026
**Owner:** P65 (sub-agent)
**Scope:** `probes/free-roam/**`, `_work/free-roam/**`,
`_work/logs/free-roam/**` and this document. No change to `probes/e1-drive`,
`probes/drivable-path`, `probes/track-coverage`, `probes/collision-oracle`, the
engine, `tools/`, `upstream/` or `game-data/`. The P48 course and the P41 draw
map are consumed read-only, pinned by hash. No renderer, GPU, browser, engine
frame, vehicle-physics or playable-game claim is made.

## Result

The committed spawn `(-88, 1050)` sits in a **9,689.5 m²** car-clearance basin
(P48 2-cell mask), not on a 2.3 m strip. The basin is **366.0 m** in geodesic
diameter, up to **95.5 m** wide in the perpendicular scan near the spawn (max
inscribed width 76.3 m), **100 % drawn** by section `g56-n289`, and the existing
310.395 m course is **100 % covered** at 1,245 samples × 7 stations.

The largest region in the 1 km study window is **17,618.5 m²** (`R01`), but it is
**not reachable** from the spawn: the nearest boundary pair is **3.50 m** apart
and the gap is a **100.0 m steep face** above the local ground, not a step or a
void. `R02` (15,399.0 m²) is 176.44 m away; `R03` (14,607.25 m²) is 14.98 m away
across a **6.75 m drop**. None is connected to the spawn at the P48 limits.

The spawn basin is **2.3×** the area of a 12 m-wide corridor around the 310 m
course: 4,207.75 m² (43.4 %) lies within 12 m of the course, **5,481.75 m²
(56.6 %) lies outside it**, and 3,375.25 m² (34.8 %) is more than 25 m from the
course. The 310 m course is one long geodesic through the basin, not the basin.

Recommended PoC change: add a free-roam mode on `R04` with the committed spawn,
**no corridor respawn**, using the collision mask for containment, and keep the
310 m course as a separate timed mode. `R03` is a possible **separate** spawn
arena (100 % drawn, 14,607.25 m²); it is not a drive connection. Do not open
`R01`/`R02`/`R05`/`R06`/`R08`/`R10`/`R11`/`R12` without a labelled draw fallback.

## 1. Question

The E1 slice has a 29 m sprint, a 310.395 m collision-clean course, and a
539.81 m draw corridor that is not drivable. The open question was how much
**free-roam drivable area** exists around the spawn on `Level.levelphysics`
itself, independent of the corridor: which connected regions the collision mesh
forms at car clearance, how wide they are, what walls or drops separate them, and
which of that area is actually covered by the committed draw geometry.

The answer must come from the collision mesh, the P41 draw map and the committed
spawn — not from a hand-drawn route or a "a draw triangle is nearby" test.

## 2. Inputs and provenance

| input | bytes | SHA-256 / record |
| --- | ---: | --- |
| `game-data/Blur/levels/usa_la_river/Level.levelphysics` | 1,945,409 | `1e678b2dff61b6d3a3d5d95a5160c3f713290251667cb27c55e262175efe4e28` |
| `_work/track-coverage/visual.json` (46 sections) | 32,161,171 | `877b4dc7e1f5ece197f0776239b33d23b0350f8cf77ef462c0c7a266a6abcb67` |
| `_work/drivable-path/path.json` (P48 course) | 56,136 | file `81eac0ce…230e7f`, canonical `sha256:4b725b10e6619e7cc2f3ef0b0ea03f3a252660a8ffaad0ffe04cb96e0318605b` |
| `_work/e1-drive/spawn.json` | 289 | `(-88, 1050)`, heading π/2 |
| `probes/collision-oracle/tests/reference_oracle.py` | 48,842 | `2d7e5aec…75f438a` |

The collision mesh is decoded by the committed oracle parser (v2 format contract,
`docs/work/analysis/t005-collision-oracle.md`). Two meshes, 44,244 triangles;
27,102 are up-facing surface triangles and 14,602 are steep. The draw map is the
committed P41 46-section map; `instancesApplied:false` is preserved. No vertex,
triangle, transform, material or route point is invented.

## 3. Model and method

### 3.1 Study window

A 1,000 × 1,000 m window centred on the spawn: **x −300…700, z 650…1650**, 0.5 m
cells (2,001 × 2,001). The collision mesh near the spawn is entirely inside the
window (global x −117.0…1,692.3, z 835.0…3,485.2); regions that touch the window
edge would be flagged `windowClipped:true`. All 16 detailed regions are fully
inside.

### 3.2 Collision traversability (P48 model)

1. Rasterise the highest up-facing collision triangle at 0.5 m cells. Only
   triangles with `normal.y > 0.94` (≤ 20°) are drivable surface.
2. A cell is passable when it has a surface, all 8 neighbours have a surface, and
   the maximum neighbour height difference is ≤ `min(0.05 m, 5 % × 0.5 m)` =
   **0.025 m** (5 cm absolute cap, 5 % grade cap).
3. Steep triangles (`|normal.y| < 0.5`) whose height band reaches local ground
   +0.05…+2.0 m are projected to XZ and dilated by 0.5 m. This is the wall mask.
   A 50 m face whose top is below the road is ignored by the height gate.
4. Regions are 8-connected components of the passable mask eroded by **2 cells =
   1.0 m** (the P48 search mask). A **3-cell = 1.5 m** erosion is reported as a
   strict-clearance sensitivity. The car envelope is the widest/longest XT
   roster box proxy, **2.981 m × 1.676 m**, plus a labelled **0.30 m** margin;
   half-width **1.138 m**.

The 2-cell mask reproduces the P48 component exactly: **38,758 cells =
9,689.5 m²**, a useful cross-check. The strict component containing the spawn is
**8,957.5 m²**; 9,143.75 m² of `R04` survives the 1.5 m erosion in total (some
in small fragments).

### 3.3 Region metrics

* **Area** is the mask cell count × 0.25 m². Bounds are cell-centre bounds.
* **Bounding polygon** is the convex hull of the region cells (a bounding
  polygon, not a drivable boundary).
* **Diameter** is the maximum over six boundary-seeded double sweeps on the
  8-connected region graph (0.5/0.7071 m weights); it is a grid geodesic, not a
  taut path.
* **Width** is the perpendicular drivable run on the region mask at 5 m stations
  along the diameter, cap 60 m per side. **Max inscribed width** is exactly
  `2 ×` the Euclidean distance from the widest region cell to the nearest
  non-region cell (the region is padded so a window edge cannot invent width).
* **Enclosed holes** are non-region components fully enclosed by the region
  (topological holes).
* **Boundary** classifies each boundary cell by its nearest blocked cell within
  2.5 m: wall mask, no surface (void/ledge), or step/grade. The 2-cell erosion
  places the region boundary 1.5–2.1 m from the physical blocker.
* **Separation** between the spawn region and another region is the nearest
  boundary pair (coarse search then exact refine). The straight segment is
  classified on the raster; the 35–65 % middle of the segment is the local gap.
  A barrier is reported only when the gap is ≤ 30 m; larger gaps are `distant`.

### 3.4 Draw coverage

* collision height = highest up-facing collision triangle (`normal.y > 0.5`)
  containing the test point;
* visual height = the draw triangle (`normal.y > 0.1`) containing the point
  whose height is nearest the collision height;
* `covered` = a draw triangle exists and `|visual − collision| ≤ 0.5 m` (the
  symmetric track-coverage rule);
* **area coverage** is sampled on a 1.0 m lattice (every second 0.5 m cell) over
  the region. A 1 m sample represents 1 m²; the reported area is scaled by the
  region area / sample count so it cannot exceed the region;
* **car-width band** is measured separately along each region's geodesic spine
  at seven stations: 0, ±0.419, ±0.838 (envelope) and ±1.138 m (envelope +
  margin), with the local spine tangent as the car heading;
* per-section attribution uses the exact draw range that contains the covering
  triangle.

The P48 course is also re-tested at its 1,245 committed 0.25 m samples × 7
stations as a control.

## 4. Regions in the 1 km window

Sixteen regions are ≥ 500 m²; together they are **72,122.25 m²** (7.2 % of the
window, 73.5 % of the 98,151 m² of up-facing passable collision surface). The
remaining passable cells are in small components below 500 m².

| region | area m² | strict 1.5 m m² | base m² | bounds x / z | diameter m | median width m | drawn | sections | reachable from spawn |
| ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | --- | --- |
| R01 | 17,618.5 | 16,100.0 | 21,630.25 | −104.5…262.0 / 839.0…1267.5 | 918.1 | 17.0 | 73.6 % | g58, g50, g71, g64, g56 | no — 3.50 m wall |
| R02 | 15,399.0 | 14,531.0 | 17,166.0 | 262.5…525.5 / 1121.0…1649.0 | 633.8 | 18.0 | 59.7 % | g59, g136 | no — 176.44 m |
| R03 | 14,607.25 | 14,136.0 | 15,601.0 | −71.0…96.0 / 1181.0…1375.0 | 228.9 | 45.0 | 100 % | g56 | no — 14.98 m void |
| **R04 (spawn)** | **9,689.5** | **9,143.75** | **10,912.75** | **−108.5…104.0 / 1012.5…1293.0** | **366.0** | **11.5** | **100 %** | **g56** | **yes** |
| R05 | 2,942.25 | 2,750.75 | 3,334.25 | 233.0…276.0 / 1124.5…1272.5 | 155.6 | 18.5 | 0 % | — | no |
| R06 | 2,076.0 | 1,944.5 | 2,406.5 | 161.5…227.0 / 1589.5…1649.0 | 78.8 | 29.5 | 0 % | — | no |
| R07 | 1,736.75 | 1,554.5 | 2,129.75 | 173.0…252.5 / 1252.5…1310.0 | 94.7 | 22.5 | 100 % | g64, g59 | no |
| R08 | 1,589.25 | 1,480.75 | 1,817.5 | 13.5…60.0 / 1315.5…1373.0 | 63.1 | 28.5 | 0 % | — | no |
| R09 | 1,041.5 | 898.25 | 1,362.25 | 80.0…131.5 / 1358.5…1442.5 | 98.5 | 11.0 | 97.7 % | g56 | no |
| R10 | 963.0 | 782.75 | 1,662.25 | 141.0…187.5 / 1420.5…1564.0 | 158.6 | 6.5 | 0 % | — | no |
| R11 | 873.5 | 499.75 | 3,080.0 | 371.5…480.0 / 1451.5…1582.5 | 256.2 | 1.0 | 0 % | — | no |
| R12 | 867.0 | 716.25 | 1,887.0 | 299.5…338.0 / 1114.0…1231.0 | 130.5 | 6.0 | 0 % | — | no |
| R13 | 799.25 | 728.75 | 948.0 | −69.0…−17.5 / 988.5…1007.5 | 56.7 | 17.0 | 100 % | g58, g50 | no |
| R14 | 712.0 | 597.5 | 977.5 | 239.0…295.5 / 1323.0…1382.0 | 78.0 | 10.0 | 100 % | g64 | no |
| R15 | 693.5 | 517.5 | 1,073.0 | −88.0…−43.0 / 1211.0…1343.0 | 150.6 | 5.5 | 100 % | g56 | no |
| R16 | 514.0 | 365.25 | 1,544.0 | 459.5…504.0 / 1539.5…1649.0 | 128.0 | 4.0 | 31.7 % | g136 | no |

`base` is the un-eroded passable component area containing the region; it shows
how much surface the 1.0 m clearance ring removes. `R01` has two enclosed holes
(largest 1,112.25 m²), so it is topologically a ring; a lap was **not** tested.
`R11` has a median width of 1.0 m: a long, thin tendril, not a drivable course.

The strict column is the area of the region that survives 1.5 m erosion. For
`R04` the **connected** strict component containing the spawn is 8,957.5 m²; the
remaining 186.25 m² is in small strict fragments inside the same 2-cell region,
which is why the table lists 9,143.75 m².

## 5. The spawn region R04

| field | value |
| --- | --- |
| area, 2-cell mask | **9,689.5 m²** (38,758 cells) |
| strict 1.5 m component | **8,957.5 m²** |
| bounds | x −108.5…104.0, z 1012.5…1293.0 |
| bounding hull | 14-point convex hull (in `regions.json`) |
| diameter | **366.035 m**, (103.5, 1292.5) → (−103.5, 1012.5) |
| grid geodesic from spawn | 322.115 m to (103.5, 1292.5) |
| max inscribed width | **76.322 m** at (−66.0, 1108.5) |
| width along spawn spine | median 11.5 m, mean 26.5 m, max **95.5 m** near the spawn |
| width along diameter | median 11.5 m, p05 1.0 m, max 84.5 m |
| boundary | 2,183 cells: 74.2 % step/grade, 25.8 % wall, 0 % void within 2.1 m |
| draw coverage | **100.000 %** (9,687/9,687 1 m samples), section `g56-n289` |
| spine band coverage | **100 %** at 562 diameter samples × 7 stations (0.5 m spacing) |
| spawn-spine band | **100 %** at 487 samples × 7 stations |
| P48 course band | **100 %** at 1,245 × 7; 0 gaps |
| enclosed holes | 0 |

The basin has two parts. Near the spawn it is a wide bowl: the perpendicular
width along the spawn-to-end spine is 30–95.5 m for the first ~65 m, then narrows
to 10–14 m for the eastern channel. The P48 310 m course runs along the northern
edge of the eastern channel, not down its centre; 1,235 of its 1,245 points are
inside the 2-cell region (the other 10 are start/end grid rounding). The whole
basin is inside the same `g56-n289` section already used by the E1 slice; no new
section or draw range is needed to draw it.

## 6. Is the largest region just the 310 m strip?

**No.** The spawn basin is 9,689.5 m² and the 310.395 m course is one geodesic
through it. Measured distance from the P48 course:

| band around the course | area m² | share of R04 |
| --- | ---: | ---: |
| ≤ 6 m | 2,440.0 | 25.2 % |
| ≤ 12 m | 4,207.75 | 43.4 % |
| ≤ 25 m | 6,314.25 | 65.2 % |
| > 25 m | **3,375.25** | **34.8 %** |

A 12 m-wide corridor along the 310 m course contains 4,207.75 m²; the basin is
**2.3×** that, with **5,481.75 m² (56.6 %)** outside the 12 m corridor. The
region diameter is 366.0 m vs the 310.4 m course (+55.6 m, +17.9 %), and the
spawn bowl is up to 95.5 m wide. The extra area is mostly the spawn bowl and the
lateral southern half of the eastern channel, not a second long channel.

So the answer is: a wider basin exists, and it is large enough to matter for
free-roam (roughly 2.3× a 12 m corridor), but it is not a second 900 m basin.
The P48 taut course remains the longest **point-to-point course from the spawn**
in this component; free-roam adds ~42 m behind the spawn plus lateral width, and
the region diameter is 366.0 m.

## 7. Larger basins and why they are not reachable

`R01` is the largest region (17,618.5 m², 918.1 m diameter, 73.6 % drawn) and is
the closest larger basin. Its nearest boundary pair to `R04` is 3.50 m, at
`(−103.5, 1012.5)` → `(−100.0, 1012.5)`, midpoint `(−101.75, 1012.5)`. The ground
is nearly level there (5.868–5.900 m; drop 0.032 m), but 32 steep triangles lie
within 3 m of the midpoint and their top is **100.0 m above the local ground**.
This is a real 100 m face, not a thin fin. A ground-only mask (no steep-face mask)
would connect the two regions, which is exactly why the P48 wall mask exists; the
steep face, not a step or void, is the barrier.

`R03` is 14,607.25 m², 100 % drawn, 45 m median width, 228.9 m diameter. It is
14.98 m from `R04` at `(36.5, 1193.5)` → `(23.0, 1200.0)`, midpoint
`(29.75, 1196.75)`. The ground falls **6.75 m** across the gap (5.366 → −1.382 m)
with a void/ledge; even without the wall mask it stays disconnected. This is a
separate collision island, not a drive connection. It is the best **second
arena** candidate because it is 100 % drawn and wide.

`R02` is 15,399.0 m² and 633.8 m long, but 176.44 m from `R04` with no local
connection; it is also only 59.7 % drawn. `R05`, `R06`, `R08`, `R10`, `R11` and
`R12` are small, 0 % drawn, and not recommended.

## 8. Visual coverage

| region | drawn m² | drawn % | sections used | uncovered m² | largest uncovered clusters |
| ---: | ---: | ---: | --- | ---: | --- |
| R01 | 12,971.99 | 73.6 % | g58 28.5 %, g50 18.5 %, g71 17.2 %, g64 6.0 %, g56 3.3 % | 4,646.51 | 2,146 at (−20.5, 1040.0); 1,235 at (237.5, 935.5); 1,219 at (−89.5, 911.5) |
| R02 | 9,194.01 | 59.7 % | g59 38.5 %, g136 21.2 % | 6,204.99 | 3,578 at (283.5, 1179.5); 2,629 at (377.5, 1421.0) |
| R03 | 14,607.25 | 100 % | g56 100 % | 0 | — |
| **R04** | **9,689.5** | **100 %** | **g56 100 %** | **0** | — |
| R07 | 1,736.75 | 100 % | g64 96.9 %, g59 3.1 % | 0 | — |
| R09 | 1,041.5 | 97.7 % | g56 97.7 % | 23.94 | 24.0 at (126.5, 1440.0) |
| R13 | 799.25 | 100 % | g58, g50 | 0 | — |
| R14 | 712.0 | 100 % | g64 | 0 | — |
| R15 | 693.5 | 100 % | g56 | 0 | — |
| R16 | 514.0 | 31.7 % | g136 | 350.9 | 354.0 at (494.0, 1602.0) |
| R05, R06, R08, R10, R11, R12 | 0 | 0 % | — | all | — |

Two points matter for the PoC:

1. **The spawn basin is fully drawn.** `g56-n289` covers all 9,687 1 m area
   samples, and the car-width band along both the diameter and the spawn spine
   is covered at all seven stations. The existing E1 upload already contains the
   section, so free-roam widening does not need new geometry.
2. **Draw coverage is not drivability.** `g56-n289` also covers `R03` (100 %)
   and `R09` (97.7 %), yet `R03` is behind a 6.75 m drop and `R09` is a separate
   island. `R01`/`R02` are drawn over most of their area but have 4,646.51 m² and
   6,204.99 m² undrawn respectively. The six 0 % regions are collision-only
   terraces; opening them would show the car driving on nothing.

Area coverage is a centre-point 1 m metric; the car-width band is measured along
the region spines, not at every cell and not at every heading. That distinction
is recorded in `regions.json` under `coverage` and `spineBandCoverage`.

## 9. Verification

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py probes/free-roam/tools/build_regions.py
& $py probes/free-roam/tools/verify_regions.py
```

`verify_regions.py` shares no raster, labelling, coverage or path code with the
builder. It re-parses `Level.levelphysics`, rebuilds the height/wall/passable
rasters with a dot-product barycentric formulation, labels components with its
own BFS, and re-measures:

* **raster equality:** height, passable, wall mask, 2-cell / 3-cell / base
  component sizes all match;
* **region areas and bounds:** all 16 regions match exactly;
* **region spine safety:** R01–R04 pass with max footprint height range
  **0.149 m**, min wall distance **1.716 m**, max step **0.0235 m**, max 2 m
  grade **3.57 %**, 0 hard wall violations, 0 margin violations. The 2 m spine
  samples are used for footprint/wall; the 0.5 m path is used for step/grade.
* **P48 exact control:** 623 samples at 0.5 m, min wall distance **7.7836 m**,
  footprint range **0.14691 m**, max step **0.00771 m**, max 2 m grade
  **3.0884 %** — the P48 recorded values, reproduced independently.
* **coverage subset:** every 25th row of `regions-samples.json` (2,886 rows)
  re-computed; **0 mismatches** in collision height, visual delta, covered flag,
  section and draw index;
* **P48 course band subset:** every 10th course sample × 7 stations; 0 uncovered;
* **R01 separation:** 32 steep triangles within 3 m of the midpoint, wall
  **100.005 m** above the local ground, ground drop **0.032 m**;
* **outputs:** SVG parses, PNG/HTML exist, file hashes and the deterministic grid
  content hash match.

Recorded: **32 checks, 0 failures** (`_work/free-roam/verify.json`, canonical
`sha256:fbce841ed4659c623ccd01636eaed2059b162224fcba2391a867bb5f5cbf5fef`).

Four small regions fail the exact spine footprint test: `R05` (2,942.25 m²,
footprint range 0.384 m), `R10` (963.0 m², one missing ground sample), `R12`
(867.0 m², footprint range 4.148 m) and `R13` (799.25 m², two missing ground
samples). They are all below 3,000 m², none is the spawn region, and none is
recommended for free-roam; the failures are recorded in `verify.json` under
`minorSpineIssues`, not hidden.

## 10. Determinism

Two consecutive builds produced byte-identical `hashes.json` and the same
canonical `regions.json` hash:

| artifact | canonical / SHA-256 |
| --- | --- |
| `regions.json` canonical | `sha256:e04ace8931f7bcddb1c19139ab41745afcb31fc1cfa33dd7a78c0d48a6bb263e` |
| `regions.json` file | `e875c541c19c4d635ac4f236198648be1223e2c62e1dab9f8fba30f817294746` |
| `regions-samples.json` | `6ef0ba09666e7c4a9a00b78ef0869ce61434e006df266a88e2edfe42a1fb022a` |
| `free-roam.svg` | `361c0fafacea9fb977a819535a5602a94dc1af1170fee67ab6db882a3dbb48a2` |
| `free-roam.png` | `c31037d4f438174de9c714f80c8cef1384d691b130e09b33b91194e246c7d37e` |
| `free-roam.html` | `40ffca8c23aa64098d4548b2c2e8f52da1bdf575e3e1ffba936fc89a3972792b` |
| `hashes.json` file | `27c4ddca4b15aea662b76fe84016da904f9392b5c3fb0ff9bd5b64ad11351087` |
| `grid.npz` content | `ef25b7ec69f6f65a442131e97fefd7c037183022a63eea6a6299e80a89c0e9cf` |

The npz ZIP container carries timestamps, so the deterministic record is the
**content** hash of the arrays, not the `.npz` file hash. `determinism.json`
records both runs.

## 11. Recommendation for a PoC free-roam mode

### 11.1 Mode split

* Keep `?course=310` (P48 310.395 m) exactly as it is: start gate, checkpoints,
  finish, corridor respawn, finish speed.
* Add a free-roam mode on the committed spawn `(-88, 1050)`. It must not inherit
  the corridor's lateral respawn band, finish gate or checkpoint rules.
* The free-roam containment test should be the collision mask (or an exact
  ground probe against `Level.levelphysics`), not the bbox or the convex hull.
  The hull is only a coarse outer bound and includes non-drivable pockets.

### 11.2 Bounds and spawn

| field | recommendation |
| --- | --- |
| spawn | `(-88, 1050)`, committed heading π/2 (or the measured course tangent for a rolling start) |
| region | `R04`, 2-cell P48 mask, 9,689.5 m² |
| safe sub-region | strict 1.5 m mask, 8,957.5 m², if a hard 1.5 m clearance guarantee is wanted |
| bounds | x −108.5…104.0, z 1012.5…1293.0 |
| respawn | no corridor respawn; reset only on explicit user action, out-of-region, or a fall below the local collision ground |
| draw fallback | none needed on `R04`; the whole basin is drawn by `g56-n289` |

The 2-cell area matches the P48 course and is the recommended primary area. The
1.5 m strict component is the conservative bound for arbitrary driving; the
exact verifier shows R04's diameter spine is clear by at least 1.716 m, but the
2-cell mask is a 1.0 m erosion, so a free-roam PoC that drives to the mask edge
should use an exact wall/ground query or the strict mask.

### 11.3 Optional second arena

`R03` is the only larger region that is both 100 % drawn and wide (14,607.25 m²,
45 m median width, max inscribed width 97.5 m). Its suggested spawn is
`(6.5, 1274.5)` (the max-inscribed cell). It is separated from `R04` by a 6.75 m
drop, so it cannot be reached by driving; it is a **separate spawn/arena**, not
a free-roam extension. If the PoC adds it, label the transition explicitly and
do not present it as a connected course.

Do not open `R01` or `R02` without a draw fallback: they are larger but 26.4 %
and 40.3 % undrawn respectively, and both are disconnected (100 m wall / 176 m).
Do not open `R05`, `R06`, `R08`, `R10`, `R11` or `R12`: they are 0 % drawn
collision-only terraces.

### 11.4 What not to claim

* **No lap.** `R01` is topologically a ring (two holes, largest 1,112.25 m²), but
  it is not reachable from the spawn; a lap was not tested.
* **No engine behaviour.** The wall separation is a collision-mesh measurement;
  the engine was not run for this probe. The 100 m face is a hard wall in the
  data; do not turn it into a "jump" or a "hidden route".
* **No "free-roam is fully drawn" beyond R04.** The area metric is a 1 m centre
  lattice; the car-width band is measured along the two spines. R03 is also
  100 % drawn, but R01/R02 and the small terraces are not.

## 12. Limits

* Collision-only + committed first-RenderList direct draws. No materials,
  textures, culling, LOD, GPU or renderer state. `instancesApplied:false`;
  instance-only geometry could add or change surfaces.
* The 0.5 m raster and the 2-cell/3-cell erosion are a conservative model, not a
  driven lap. The 5 cm / 5 % caps are the P48 calibration.
* Area coverage is sampled at 1.0 m; a different lattice can change counts by a
  few m². The 0.5 m coverage tolerance is symmetric; the P51 result showed the
  deltas are millimetres on this surface.
* Width is a height-matched drivable run, not a legal racing width; the scan
  caps at 60 m per side. `maxInscribed` is exact at the widest cell, not a
  guarantee along the boundary.
* The 0.30 m safety margin is a labelled assumption; XT has no body overhang.
* The 1 km window is a scope choice. Regions outside it were not measured; the
  global collision mesh extends to x 1,692, z 3,485, so the window is not the
  whole level.
* The convex hull is a bounding polygon, not a drivable boundary.
* No engine, vehicle physics, camera, telemetry, lap or game-loop claim.

## 13. Evidence

| path | content |
| --- | --- |
| `_work/free-roam/regions.json` | regions, areas, bounds, hulls, spines, widths, holes, boundaries, coverage, separations, P48 control, recommendation, canonical hash |
| `_work/free-roam/regions-samples.json` | 1 m draw-coverage samples for the 16 detailed regions |
| `_work/free-roam/grid.npz` | height / passable / wall / 2-cell / 3-cell / base label rasters |
| `_work/free-roam/free-roam.svg` | top-down map: regions, walls, drawn/undrawn cells, P48 course |
| `_work/free-roam/free-roam.png` | raster copy (region labels, legend, 100 m scale) |
| `_work/free-roam/free-roam.html` | the map with the region table and warnings |
| `_work/free-roam/verify.json` | independent re-measure, 32 checks PASS |
| `_work/free-roam/hashes.json` | output file hashes and deterministic grid content hash |
| `_work/free-roam/determinism.json` | two-run hash comparison |
| `_work/logs/free-roam/` | build, verify and exploration logs |
| `probes/free-roam/tools/build_regions.py` | traversability, regions, widths, separations, coverage, map |
| `probes/free-roam/tools/verify_regions.py` | independent raster, exact spine, coverage subset, separation check |
