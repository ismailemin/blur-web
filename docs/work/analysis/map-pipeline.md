# Map pipeline audit — all 19 level directories

**Date:** 7 November 2026
**Owner:** M1 (sub-agent)
**Scope:** `probes/map-pipeline/**`, `_work/map-pipeline/**`,
`_work/logs/map-pipeline/**` and this document. No change to `probes/e1-drive`,
`probes/asset-reader`, any other probe, the engine, `tools/`, `upstream/` or
`game-data/`. The committed collision oracle and native level reader are used
read-only. No renderer, GPU, browser, engine-physics or playable-game claim is
made.

## Result

All **19** level directories have a parseable `Level.levelphysics` **once the
documented Gravity import-shape stream is read beyond type 0**. The committed
collision oracle alone stops on **15/19** levels because they begin with a box,
cylinder, composite, triangle-mesh-base or fluid-mesh import shape.

The ranked split is **A = 1, B = 16, C = 2**:

- **A:** `usa_la_river` — already integrated in `e1-drive`, with the committed
  spawn and P51’s 100 % draw-coverage proof for the 310.395 m course.
- **B:** 16 levels with a parsed collision mesh, a measured collision-only path
  and a measured draw-covered path, but still needing a committed spawn/course
  layout and/or level material/texture binding.
- **C:** 2 levels where the extracted first-RenderList direct draws cover **less
  than 25 m** of the collision surface: `spa_barcelona_bowl_multiplayer`
  (0.0 m) and `usa_la_multiplayer_highrise` (6.2 m). This is a draw-coverage
  blocker at the current extraction, not a claim that the level has no draws.

**Top 3 for the next integration wave:** `usa_amboy`, `spa_barcelona_gracia`,
`usa_la_longbeachdocks`. They are the best combination of a long measured
draw-covered path, high coverage completeness, high native section support and
manageable collision size. `spa_barcelona_oval` is a close fourth (786.1 m,
simple oval, 31/56 sections supported).

## 1. Question

The E1 slice drives one map on one measured 310.395 m collision course. The next
content wave needs to know, for every shipped level directory:

1. does the collision file parse, and how many static triangles does it contain?
2. is there a spawn on collision, and a measured drivable component?
3. is that component covered by real draws, and at what length?
4. which data files are still missing for a playable slice?
5. which maps can be added next without guessing?

## 2. Why the committed reader blocked 15 levels

`probes/collision-oracle/tests/reference_oracle.py` accepts only
`Collision::E_ImportTriangleMesh_Shape` (type 0). The upstream serializer
(`BodyHelper.h`, `ShapeDescriptors.h`, `CompositeDescriptor.h`,
`Importer.cpp`) defines 23 import types. The levels use:

| first unsupported type | name | example levels |
|---:|---|---|
| 2 | Box | `jpn_tokyo_shutoko`, `uk_london_hackney`, `usa_amboy`, `usa_ny_dumbo` |
| 6 | Cylinder | `uk_brighton`, `usa_la_observatory`, `usa_sanfran_russianhill` |
| 7 | Composite | `spa_barcelona_oval`, `usa_amboy_multiplayer` |
| 11 | TriangleMeshBase | later in `spa_barcelona_gracia`, `uk_london_hackney` |
| 17 | FluidMesh | `jpn_mharuna`, `usa_la_downtown`, `usa_la_longbeachdocks`, `usa_la_multiplayer_highrise`, `usa_ny_dumbo` |

`probes/map-pipeline/tools/physics_scan.py` follows the upstream serialization
for types 0/2/3/4/5/6/7/8/10/11/15/17/21, decodes the shared optimised-AABB tree
for triangle types 0/11, and records fluid meshes separately. It does not guess
a skipped shape size: an unknown type stops with its byte offset. The full
19-level scan log is `_work/map-pipeline/scan-all.log`.

Result: **19/19 parse**, including 15 that the oracle alone rejects. The old
oracle parses only `usa_la_river`, `showroom`,
`spa_barcelona_bowl_multiplayer` and `usa_la_downtown_multiplayer`.

## 3. Method

### 3.1 Collision and drivable surface

- 1 m audit grid over the static triangle bounds.
- Surface triangles: `normal.y > 0.94` (≤ 20°).
- Passable: finite surface, every 8-neighbour present, edge height difference
  ≤ `min(0.05 m, 5 % × cell)`.
- Wall mask: every steep triangle (`|normal.y| < 0.5`) whose height band reaches
  local ground +0.05…2.0 m is projected to its XZ bounding box and dilated by
  one cell. This over-blocks, so it can shorten a measured path but not lengthen
  a false one.
- 8-connected components; the measured path is the geodesic diameter of the
  largest component by two BFS passes, or of the committed-spawn component on
  River.
- Spawn: River uses the committed `_work/e1-drive/spawn.json` `(-88, 1050)`; the
  other 18 have **no spawn record in any level file**, so their candidate spawn
  is the derived diameter endpoint, explicitly labelled as such.

### 3.2 Draw coverage

1. `level_inspect --index` gives the native resource-block/stream-chunk index.
2. The committed `inspect_level_candidates.inspect_level` enumerates source-
   correlated first RenderList direct geometry/node pairs (`instancesApplied:false`).
3. `probe_draws.py` extracts every correlated pair with the committed native
   reader and records positions/indices/draw ranges, hashes and bounds.
4. `coverage.py` tests a path at 0.25 m against the extracted triangles: a
   station is covered when a declared draw triangle contains the point and its
   height is within **0.5 m** of the collision surface. A triangle outside every
   declared draw range is a hard error.
5. `covered_path.py` keeps only collision-passable cells that are covered, finds
   the largest draw-covered component and measures its diameter.

All 19 levels were extracted with every correlated pair across
`draw-probes-all.json` plus the `draw-probes-top.json` / `draw-probes-extra.json`
supersets (`usa_ny_dumbo` 105, `usa_la_downtown` 113); the native support counts
are in the matrix. Materials, textures, shaders, samplers, culling and GPU state
are **not** applied.

### 3.3 Classification

| class | rule |
|---|---|
| A | integrated in `e1-drive` with a committed spawn and a proven committed course (only River) |
| B | collision parsed, collision path ≥ 25 m, and a draw-covered path ≥ 25 m measured; layout/reader step still required |
| C | blocked with an exact reason: no static triangle mesh, no measured collision path, or no draw-covered collision path ≥ 25 m |

## 4. 19-level matrix

`col path` is the collision-only geodesic diameter (River: committed spawn
component); `draw path` is the largest draw-covered collision component;
`complete` is `draw path / col path`; `covered` is the number of 1 m cells in
the draw-covered component; `sections` is native-supported / probed first-
RenderList sections; `pairs` is the number of correlated first-RenderList pairs.

| # | level | kind | class | collision tris | col path m | draw path m | complete | covered cells | sections | pairs |
|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | `usa_la_river` | race | **A** | 44,244 | 365.3 | 246.8¹ | 0.675 | 146,658 | 32/46 | 46 |
| 2 | `usa_amboy` | race | **B** | 63,708 | 2,110.8 | 2,060.6 | 0.976 | 514,783 | 48/75 | 75 |
| 3 | `usa_ny_dumbo` | race | **B** | 46,243 | 2,373.5 | 1,292.5 | 0.545 | 122,718 | 94/105 | 105 |
| 4 | `showroom` | showroom | **B** | 3,358 | 116.5 | 116.5 | 1.000 | 4,810 | 1/1 | 1 |
| 5 | `spa_barcelona_gracia` | race | **B** | 113,270 | 627.4 | 624.9 | 0.996 | 56,439 | 88/92 | 92 |
| 6 | `usa_la_longbeachdocks` | race | **B** | 25,183 | 1,730.5 | 818.4 | 0.473 | 209,375 | 74/76 | 76 |
| 7 | `usa_la_observatory` | race | **B** | 111,496 | 562.3 | 562.4 | 1.000 | 32,370 | 23/53 | 53 |
| 8 | `spa_barcelona_oval` | race | **B** | 39,532 | 1,352.1 | 786.1 | 0.581 | 67,878 | 31/56 | 56 |
| 9 | `uk_london_hackney` | race | **B** | 76,820 | 1,185.7 | 776.4 | 0.655 | 68,134 | 71/82 | 82 |
| 10 | `uk_brighton` | race | **B** | 86,528 | 2,007.9 | 975.0 | 0.486 | 213,083 | 82/84 | 84 |
| 11 | `jpn_mharuna` | race | **B** | 42,038 | 417.2 | 345.8 | 0.829 | 54,442 | 39/73 | 73 |
| 12 | `usa_sanfran_russianhill` | race | **B** | 32,709 | 275.2 | 186.8 | 0.679 | 19,701 | 41/42 | 42 |
| 13 | `usa_sanfran_sausalito` | race | **B** | 93,591 | 3,985.6 | 1,046.8 | 0.263 | 323,515 | 65/96 | 96 |
| 14 | `usa_la_downtown` | race | **B** | 118,351 | 161.7 | 160.0 | 0.990 | 42,934 | 109/113 | 113 |
| 15 | `usa_la_downtown_multiplayer` | multiplayer | **B** | 12,706 | 982.1 | 154.9 | 0.158 | 3,289 | 4/4 | 4 |
| 16 | `usa_amboy_multiplayer` | multiplayer | **B** | 22,208 | 770.8 | 136.1 | 0.177 | 10,257 | 10/16 | 16 |
| 17 | `jpn_tokyo_shutoko` | race | **B** | 58,330 | 1,617.9 | 290.9 | 0.180 | 120,548 | 66/70 | 70 |
| 18 | `usa_la_multiplayer_highrise` | multiplayer | **C** | 2,522 | 208.9 | 6.2 | 0.030 | 35 | 7/7 | 7 |
| 19 | `spa_barcelona_bowl_multiplayer` | multiplayer | **C** | 4,352 | 406.9 | 0.0 | 0.000 | 0 | 3/6 | 6 |

¹ River’s 246.8 m is this audit’s 1 m lower bound; the committed P51 proof covers
the 310.395 m course 100 % at centre, envelope and +0.30 m margin. That proof is
the A evidence, not this coarse re-measure.

### 4.1 Collision details

All 19 have a top-level static triangle mesh. Fluid meshes are parsed but
excluded from drivable surface (`usa_la_downtown`, `usa_la_longbeachdocks`,
`usa_la_multiplayer_highrise`, `usa_ny_dumbo`, `jpn_mharuna`). Composite
sub-meshes are counted but not transformed/applied; `usa_amboy_multiplayer` has
1,671 composite props and `spa_barcelona_oval` one empty composite sub-mesh.
Exact per-level triangle/vertex/bounds/hash data is in
`_work/map-pipeline/inventory.json`.

## 5. A/B/C split

### A — playable slice already integrated (1)

`usa_la_river`: committed spawn `(-88, 1050)`, measured 328.1 m point-to-point
from the spawn at the 1 m audit cell, P48’s 310.395 m engine-clean collision
course, and P51’s 100 % draw coverage over that course. This is the only map
with the complete collision + draw + layout + texture pipeline.

### B — needs a layout/reader step (16)

All 16 have a parsed collision mesh and a measured draw-covered path. The
shared missing data are:

- **original spawn/start-line**: no level file contains one. The candidate spawn
  is a derived component endpoint, not a retail grid position.
- **level material/shader/texture binding**: native level draws are diagnostic
  (`albedoTexture:null`, no sampler/shader upload). Only River’s g56/P73a–P75
  subset has proven UV0/albedo bindings.
- **layout**: a committed course/checkpoint/finish/respawn layout for `e1-drive`.
- **instances**: `instancesApplied:false`; instance-only geometry can add or
  change surfaces.

Per-level additional gaps are in `maps.json` `missingData`.

### C — blocked at the extracted draw coverage (2)

| level | exact blocker | exact missing data |
|---|---|---|
| `spa_barcelona_bowl_multiplayer` | 0.0 m draw-covered collision path | 3/6 first-RenderList sections stop on unsupported position vertex formats (native offsets 573548, 492480, 498748); the 3 supported sections cover no collision surface. Needs instance traversal or another draw block. |
| `usa_la_multiplayer_highrise` | 6.2 m draw-covered collision path (35 cells) | All 7 first-RenderList sections are readable, but only two are real geometry (10,474 and 6,442 vertices); the other five are 2–12-vertex planes. The drivable surface needs instance/other-block traversal or a different draw pass. One fluid mesh is parsed and excluded. |

These are draw-coverage blockers, not collision blockers: both levels have a
parsed collision mesh and a collision-only diameter of 406.9 m / 208.9 m.

## 6. Top 3 candidates for the next integration

Selection rule: measure a draw-covered path first; then prefer (a) the longest
measured draw-covered route, (b) near-complete draw coverage of the collision
diameter, (c) high native section support with a low collision triangle count.
All three below have a measured path; none is claimed playable until a layout
and a rendered frame exist.

### 6.1 `usa_amboy`

| field | value |
|---|---|
| collision triangles | 63,708 (surface 55,812; steep 2,482) |
| collision path | 2,110.8 m |
| draw-covered path | **2,060.6 m (97.6 % of the collision diameter)** |
| draw-covered cells | 514,783 (81.3 % of passable) |
| native sections | 48/75 supported; 75 correlated pairs |
| why | longest measured draw-covered route; mostly flat; complete top-level collision |
| missing | 27 unsupported sections, derived spawn, materials/textures, layout |

### 6.2 `spa_barcelona_gracia`

| field | value |
|---|---|
| collision triangles | 113,270 (surface 67,552; steep 42,369) |
| collision path | 627.4 m |
| draw-covered path | **624.9 m (99.6 % of the collision diameter)** |
| draw-covered cells | 56,439 (58.9 % of passable) |
| native sections | 88/92 supported; 92 correlated pairs |
| why | highest coverage completeness; almost every draw section is readable |
| missing | 4 unsupported sections, derived spawn, materials/textures, layout; largest triangle count of the top 3 |

### 6.3 `usa_la_longbeachdocks`

| field | value |
|---|---|
| collision triangles | 25,183 (surface 18,051; steep 4,982) |
| collision path | 1,730.5 m |
| draw-covered path | **818.4 m (47.3 % of the collision diameter)** |
| draw-covered cells | 209,375 (33.9 % of passable) |
| native sections | 74/76 supported (97.4 %); 76 correlated pairs |
| why | best native support with the lowest collision triangle count among the long-path candidates; simple docks geometry |
| missing | 2 unsupported sections, one fluid mesh excluded, derived spawn, materials/textures, layout |

### 6.4 Next concrete command chain (per candidate)

These commands are the extraction/measurement half already implemented in this
probe. The integration half (map id, geometry upload, layout consumption) is
main-agent owned and must run `verify_e1_drive` afterwards.

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

# 1. collision + 1 m component/path
& $py probes/map-pipeline/tools/inventory_levels.py --levels usa_amboy
# 2. every first-RenderList direct section, native extraction
& $py probes/map-pipeline/tools/probe_draws.py --levels usa_amboy --max-pairs 200 `
    --out _work/map-pipeline/draw-probes-amboy.json
# 3. draw-aware collision component and path
& $py probes/map-pipeline/tools/covered_path.py --level usa_amboy
# 4. candidate spawn / course / checkpoints / finish
& $py probes/map-pipeline/tools/export_candidate.py --level usa_amboy
# 5. integration (e1-drive owner): consume
#    _work/map-pipeline/candidates/usa_amboy.layout.json
#    _work/map-pipeline/probes/usa_amboy-*/native.json
#    then run the E1 verifier
node probes/e1-drive/tools/verify_e1_drive.mjs
```

The same chain is already run for `spa_barcelona_gracia` and
`usa_la_longbeachdocks`; the three layout hand-offs are:

- `_work/map-pipeline/candidates/usa_amboy.layout.json`
- `_work/map-pipeline/candidates/spa_barcelona_gracia.layout.json`
- `_work/map-pipeline/candidates/usa_la_longbeachdocks.layout.json`

The existing `build_sprint.mjs` / `sprint-layout.js` are River-specific; they
must not be pointed at these layouts without the integration change and the
verifier gate.

## 7. Data files a playable slice needs

Present for every level:

- `game-data/Blur/levels/<level>/Level.levelphysics` — collision.
- `Level.levelrender` + `Level.levelstream` — draw source.

Produced by this probe for the candidates:

- `_work/map-pipeline/grids/<level>.npz` — 1 m height/passable/component/wall.
- `_work/map-pipeline/paths/<level>.json` — collision-only measured path.
- `_work/map-pipeline/covered/<level>.json` and `-path.json` — draw coverage and
  draw-covered path.
- `_work/map-pipeline/probes/<level>-*/native.json` — extracted section geometry,
  draw ranges, positions/indices hashes.

Still missing for every non-River map:

- a committed spawn/start-line and course/checkpoint/finish/respawn layout;
- level material/shader/sampler/texture binding (the native probe is diagnostic);
- instance traversal if the road surface is instance-only;
- prop colliders and map-specific rules (not audited here).

## 8. Verification and determinism

`python probes/map-pipeline/tools/verify_maps.py` → **PASS, 193 checks, 0
errors**. It re-parses every physics file, checks shape types and static
triangle counts, rebuilds the passable mask from `grid.npz`, re-counts
components, re-measures both path artifacts, checks every draw-covered sample
is on a passable collision cell, validates that each top-3 candidate layout
spawn is on collision with matching course length/checkpoints/finish, and
re-derives the A/B/C classification.

Repeated runs are byte-identical:

| artifact | SHA-256 |
|---|---|
| `maps.json` | `40878a997c7411c27bb8edbdaf091d3fe1bbf33b8d7b25224dd54d881f16e0ea` |
| `inventory.json` | `6ed6b1c2fa0590d6abce567c27b030eb93704e7f0c29eb22022644ed93bf96bd` |
| `draws.json` | `b0521d05445026f97596dcd909471fca4012a33421baafa722637c330458467e` |
| `draw-probes-all.json` | `00c86204c0485ca269da5e120bce8ed10232cb7f8fac172e11a339a0f4b61c55` |
| `verify.json` | `8fd93d3a8ef5478686d01c537b80183c1e148fb1aa347b26fd3b7b29e7236503` |
| `maps-summary.svg` | `0c662b6328e2f1e0b71ceed8c7b0accd30ce9b09a3f44aa6f00e980c426327e8` |
| `maps-summary.html` | `c2d99aae9ae5967d1ab310c0c64ff57fc5e3211c9cae718e8aa15448526709bf` |
| `maps-summary.png` | `bccd58c9840417cb6de4bcb4b1a84becc7b9ba1c9b8abed706ed978a161e815b` |

`maps.json`, `maps-summary.svg` and `maps-summary.html` were rerun and produced
the same hashes. The 1 m grid `.npz` container hash can vary with zip metadata;
the deterministic value is `grid.arraySha256` (height/passable/labels/wall/xs/zs
concatenated). The per-level level-file hashes are in `maps.json` `files`.

Native reader used for draw extraction:
`_work/build/asset-reader-native/Release/level_inspect.exe`, SHA-256
`63ee2801ac10b7dbafb515b8379bd720c5710593b8576b6f10b00070686a11cd`.

Top-down/table summary: `_work/map-pipeline/maps-summary.png` (headless Edge
screenshot of the static HTML/SVG; no JavaScript).

## 9. Limits

- **Collision-only path is not a road claim.** It is the geodesic diameter of a
  passable component. A large flat terrain area can produce a long path that is
  not the race line; the draw-covered path is the stronger constraint.
- **Draw coverage is first RenderList direct LOD0 only.** `instancesApplied:false`.
  A missing covered path means “not under these extracted draws”, not “no draw
  exists in the level”. Instance-only geometry can add surfaces.
- **1 m audit grid.** P48/River used 0.5 m and the engine trace; this audit is a
  coarser screen. The River committed-spawn component area (9,496 m²) agrees with
  P48’s 9,689.5 m² at 0.5 m, and the committed-spawn path (328.1 m) is close to
  P48’s 310.4 m, but the audit is not a substitute for the 0.25 m verified
  course.
- **Conservative wall mask.** Steep-triangle XZ bounding boxes over-block; this
  can shorten a path, never lengthen a false one.
- **Composite/fluid.** Composite sub-meshes are counted but not transformed;
  fluid meshes are parsed and excluded from drivable surface.
- **No spawn record.** Only River has a committed spawn; the other candidate
  spawns are derived diameter endpoints.
- **Point-to-point, not a lap.** No lap or closed circuit is claimed. The paths
  are geodesic diameters; a loop needs a separate P61-style cycle measurement.
- **No materials, textures, shaders, culling, LOD or GPU state.** The native
  draw probe reports geometry only; its `albedoTexture` is null.
- **No renderer, engine, vehicle-physics or playable-game claim.** No frame was
  rendered for any map. The summary PNG is a screenshot of a static data page,
  not a game frame.

## 10. Evidence

| path | content |
|---|---|
| `_work/map-pipeline/maps.json` | ranked 19-level matrix, A/B/C, top 3, missing data |
| `_work/map-pipeline/inventory.json` | collision/drivable inventory, file hashes, grids, paths |
| `_work/map-pipeline/draws.json` | native levelrender index + first-RenderList pair counts |
| `_work/map-pipeline/draw-probes-all.json` | native extraction of all correlated sections |
| `_work/map-pipeline/covered/<level>.json` | draw coverage + covered component per level |
| `_work/map-pipeline/covered/<level>-path.json` | draw-covered path samples |
| `_work/map-pipeline/grids/<level>.npz` | 1 m height/passable/labels/wall rasters |
| `_work/map-pipeline/paths/<level>.json` | collision-only path samples |
| `_work/map-pipeline/candidates/*.layout.json` | top-3 spawn/course/checkpoints/finish hand-off |
| `_work/map-pipeline/maps-summary.{svg,html,png}` | top-down + table summary |
| `_work/map-pipeline/verify.json` | deterministic verifier, PASS |
| `_work/logs/map-pipeline/` | every scan, probe, coverage, rank, summary and verify log |
| `probes/map-pipeline/tools/physics_scan.py` | documented shape-stream scanner |
| `probes/map-pipeline/tools/inventory_levels.py` | collision/drivable inventory |
| `probes/map-pipeline/tools/probe_draws.py` | native draw extraction |
| `probes/map-pipeline/tools/coverage.py` | 0.5 m draw-vs-collision coverage |
| `probes/map-pipeline/tools/covered_path.py` | draw-aware component/path |
| `probes/map-pipeline/tools/rank_maps.py` | matrix merge/classification |
| `probes/map-pipeline/tools/build_summary.py` | SVG/HTML summary |
| `probes/map-pipeline/tools/verify_maps.py` | independent re-measure |

## 11. Recommended next step

Integrate the three candidates in this order, one at a time:

1. `spa_barcelona_gracia` — highest completeness (99.6 %); this is the least
   likely to need extra draw work.
2. `usa_la_amboy` — longest measured route (2,060.6 m); use it for a long
   sprint/point-to-point, not a lap.
3. `usa_la_longbeachdocks` — best native section support (74/76) and the lowest
   collision triangle count of the long-path set.

Keep `spa_barcelona_oval` as the alternate if a simple oval is preferred; its
786.1 m covered path is strong, but 25/56 sections still use unsupported
position formats. Do not promote any C level until the instance/other-block
draw pass is measured.
