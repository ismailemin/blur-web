# Free-roam regions — USA LA River

Measured, data-only probe: how much car-clearance drivable surface exists around
the committed E1 spawn on the collision mesh, which connected regions it forms,
and which of those regions the committed draw geometry actually covers.

This is not a renderer, engine, GPU, browser or playable-game claim. No geometry,
material, transform or path point is invented.

**Status:** the spawn-reachable free-roam basin is **9,689.5 m²** (P48 2-cell
mask) / **8,957.5 m²** (strict 1.5 m clearance), 366.0 m long, **100 % drawn**
by `g56-n289`, and the existing 310 m course is 100 % covered at seven stations.
The largest region in the 1 km study window is **17,618.5 m²**, but it is behind
a 100 m steep face 3.50 m from the spawn basin and is not reachable.

## Inputs (read-only)

| input | role |
| --- | --- |
| `game-data/Blur/levels/usa_la_river/Level.levelphysics` | collision surface |
| `_work/track-coverage/visual.json` | pinned 46-section draw map (`instancesApplied:false`) |
| `_work/drivable-path/path.json` | pinned P48 310.395 m course |
| `_work/e1-drive/spawn.json` | committed spawn `(-88, 1050)` |
| `probes/collision-oracle/tests/reference_oracle.py` | committed collision parser |

Pinned hashes: physics `1e678b2d…fe4e28`, draw map `877b4dc7…6abcb67`,
P48 canonical `sha256:4b725b10…318605b`.

## Commands

Use the bundled Python (numpy and PIL):

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py probes/free-roam/tools/build_regions.py    # regions.json, samples, map, grid
& $py probes/free-roam/tools/verify_regions.py   # independent re-measure
```

## Outputs (all under `_work/free-roam/`, never game data)

| file | content |
| --- | --- |
| `regions.json` | regions, areas, bounds, hulls, spines, widths, boundaries, coverage, separations, P48 control, recommendation |
| `regions-samples.json` | per-cell 1 m draw-coverage samples for the detailed regions |
| `free-roam.svg` | top-down map: regions, walls, drawn/undrawn cells, P48 course |
| `free-roam.png` | raster copy of the same map |
| `free-roam.html` | the map with the result table and warnings |
| `grid.npz` | height / passable / wall / label rasters |
| `hashes.json` | output file hashes and the deterministic grid content hash |
| `verify.json` | independent verifier result |
| `determinism.json` | two-run hash comparison |

## Model

* 1,000 × 1,000 m study window at 0.5 m: x −300…700, z 650…1650.
* Drivable surface = highest collision triangle with `normal.y > 0.94`.
* Adjacent step/grade ≤ `min(0.05 m, 5 % × 0.5 m)` = 0.025 m.
* Wall mask = steep triangles (`|normal.y| < 0.5`) in the local ground
  +0.05…+2.0 m band, projected to XZ and dilated by 0.5 m.
* Regions = 8-connected components of the passable mask eroded by 2 cells
  (1.0 m, the P48 search mask). A 3-cell (1.5 m) strict mask is reported as a
  sensitivity; the car envelope + 0.30 m margin half-width is 1.138 m.
* Draw coverage: highest up-facing collision triangle, nearest draw triangle
  (`normal.y > 0.1`), `covered` when `|visual − collision| ≤ 0.5 m`; area
  coverage sampled on a 1.0 m lattice; car-width band tested at seven stations
  (0, ±0.419, ±0.838, ±1.138 m) along each region's geodesic spine.
* Width is a perpendicular drivable run on the region mask, 5 m stations, cap
  60 m per side. The `maxInscribed` value is an exact Euclidean distance from
  the widest cell to the nearest non-region cell.

## Result

| region | area m² | strict m² | bounds x / z | diameter m | median width m | drawn | sections |
| ---: | ---: | ---: | --- | ---: | ---: | ---: | --- |
| R01 | 17,618.5 | 16,100.0 | −104.5…262.0 / 839.0…1267.5 | 918.1 | 17.0 | 73.6 % | g58, g50, g71, g64, g56 |
| R02 | 15,399.0 | 14,531.0 | 262.5…525.5 / 1121.0…1649.0 | 633.8 | 18.0 | 59.7 % | g59, g136 |
| R03 | 14,607.25 | 14,136.0 | −71.0…96.0 / 1181.0…1375.0 | 228.9 | 45.0 | 100 % | g56 |
| **R04 (spawn)** | **9,689.5** | **8,957.5** | **−108.5…104.0 / 1012.5…1293.0** | **366.0** | **11.5** | **100 %** | **g56** |

R04 is the only region reachable from the committed spawn under the P48 model.
It is 2.3× the area of a 12 m-wide corridor around the 310 m course; 5,481.75 m²
(56.6 %) lies more than 12 m from the course and 3,375.25 m² (34.8 %) more than
25 m. The spawn bowl is up to 95.5 m wide in the perpendicular scan (max
inscribed width 76.3 m); the eastern half of the basin is 10–14 m wide.

Separations from R04 (nearest boundary pair):

| to | gap m | barrier | evidence | reachable |
| ---: | ---: | --- | --- | --- |
| R01 | 3.50 | wall | 100.0 m steep face above ground at (−101.75, 1012.5); ground drop 0.032 m | no |
| R03 | 14.98 | void | 6.75 m ground drop at (29.75, 1196.75) | no |
| R02 | 176.44 | distant | straight-line gap; no local connection | no |

R01 has two enclosed holes (largest 1,112.25 m²), so it is topologically a ring;
a lap was not tested. R03 is 100 % drawn and is a possible **separate** spawn
arena, not a drive connection.

## Verification

`verify_regions.py` shares no raster, labelling, coverage or path code with the
builder. It re-parses the level, rebuilds the rasters with a dot-product
barycentric formulation, labels components with its own BFS, and re-measures:

* every region spine with exact triangles: ground, nine footprint points,
  step, 2 m grade, wall distance. R01–R04 pass with max footprint range
  0.149 m, min wall distance 1.716 m, max step 0.0235 m, max grade 3.57 %;
* every 25th draw-coverage row (2,886 rows): 0 mismatches;
* the P48 course control: min wall 7.7836 m, footprint 0.14691 m, max step
  0.00771 m, max grade 3.0884 % (the P48 recorded values);
* the R01 separation: 32 steep triangles within 3 m, wall 100.0 m above ground.

Recorded: **32 checks, 0 failures**. Minor regions R05, R10, R12 and R13 (all
below 3,000 m², four of them not recommended) fail the exact spine footprint
test; this is recorded, not hidden.

## Determinism

Two consecutive runs produce byte-identical `hashes.json` and the same canonical
`regions.json` hash `sha256:e04ace89…bb263e`. The `grid.npz` ZIP container carries
timestamps, so `hashes.json` records a deterministic **content** hash
(`ef25b7ec…c0e9cf`) instead of a file hash.

## Limits

* Collision + committed first-RenderList direct draws only; instances are not
  applied (`instancesApplied:false`). Instance-only geometry could add or change
  surfaces.
* The 0.5 m raster and the 2-cell/3-cell erosion are a model, not a driven lap.
* Area coverage is sampled on a 1.0 m lattice; a different lattice can change
  counts by a few m².
* The 0.5 m coverage tolerance is symmetric. Width is a height-matched covered
  run, not a legal racing width; the scan caps at 60 m per side.
* The 0.30 m margin is an assumption; the XT data has no body overhang.
* The R04 convex hull is a bounding polygon, not a drivable boundary; the PoC
  must test the collision mask or exact ground, not the bbox.
* No renderer, GPU, engine frame, vehicle physics or playable-game claim.

## Evidence

`_work/free-roam/regions.json`, `regions-samples.json`, `free-roam.svg`,
`free-roam.png`, `free-roam.html`, `verify.json`, `hashes.json`,
`determinism.json`, `grid.npz`; logs in `_work/logs/free-roam/`; full analysis in
`docs/work/analysis/free-roam.md`.
