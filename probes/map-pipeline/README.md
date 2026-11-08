# Map pipeline probe

Read-only audit of every level directory under `game-data/Blur/levels/` for a
WebGPU/WebAssembly playable slice. This probe does **not** change `e1-drive`,
`asset-reader`, the engine, `tools/`, `upstream/` or game data. It writes only
under `_work/map-pipeline/`, `_work/logs/map-pipeline/` and one analysis document.

## What it measures

1. **Collision format** — `Level.levelphysics` block framing and the documented
   Gravity import-shape stream. The committed oracle decoder (`reference_oracle.py`)
   supports only `E_ImportTriangleMesh_Shape` (type 0); many levels start with a
   box/cylinder/composite/fluid shape. `physics_scan.py` follows the upstream
   serializer (`BodyHelper.h`, `ShapeDescriptors.h`, `CompositeDescriptor.h`,
   `Importer.cpp`) for types 0/2/3/4/5/6/7/8/10/11/15/17/21, decodes the shared
   optimised-AABB tree for triangle types 0/11, and records fluid meshes
   separately. It never guesses a skipped shape size: an unknown type stops with
   its byte offset.
2. **Drivable surface** — 1 m audit grid, up-facing triangles (`normal.y > 0.94`),
   edge step <= min(0.05 m, 5 % of cell), conservative steep-triangle wall mask.
   8-connected components; geodesic diameter by two BFS passes.
3. **Draw coverage** — native `level_inspect --index` plus committed
   `inspect_level_candidates.inspect_level` first-RenderList direct pairs; then
   native `level_inspect` extraction of geometry/node chunks and a 0.5 m
   draw-vs-collision coverage test (`coverage.py`, `covered_path.py`).
4. **Ranking** — A/B/C matrix and top-3 candidates (`rank_maps.py`), with exact
   missing data and a candidate layout hand-off (`export_candidate.py`).

## Map decisions (19 levels)

`data/map-decisions.json` is the byte-backed decision document for every level
directory. It is derived from the committed probe/batch documents; it is not a
renderer, GPU, browser or playable-game claim.

**Verdicts:** `playable` = integrated in `probes/e1-drive/web/map-registry.js`
`MAP_IDS` and the map-batch package verifies; `blocked` = a named committed
record prevents playable today; `unsupported` = no buildable package or no
measured path exists, so the level cannot be decided from committed data.

The committed registry has **3 playable maps** (`river`, `amboy`, `gracia`).
`usa_la_longbeachdocks` has a verified map-batch package and an 818.372 m
committed draw-covered path, but no E1 registry entry, so it is **blocked** by
two integration items (`e1-map-package`, `e1-verify-browser`). The "4 playable
maps" premise is not supported by the committed registry in this tree.

`draw m` is the committed draw-covered path; `collision m` is the collision-only
geodesic diameter. For the three extended-probe levels the recovered path is in
`paths.recoveredM`: Longbeach 1,730.511 m, highrise 208.948 m, bowl 406.889 m.

| # | level | city | verdict | draw m | collision m | col tris | draws | textures | blocker |
|---:|---|---|---|---:|---:|---:|---:|---:|---|
| 1 | `spa_barcelona_gracia` | Barcelona Gracia | **playable** | 624.9 | 627.4 | 113,270 | 3,580 | 734 | - |
| 2 | `usa_amboy` | Amboy | **playable** | 2,060.6 | 2,110.8 | 63,708 | 1,606 | 179 | - |
| 3 | `usa_la_river` | LA River | **playable** | 246.8 | 365.3 | 44,244 | 1,117 | 300 | - |
| 4 | `usa_la_longbeachdocks` | LA Docks | **blocked** | 818.4 | 1,730.5 | 25,183 | 1,141 | 164 | integration: no E1 map package |
| 5 | `usa_la_observatory` | Hollywood Hills | **blocked** | 562.4 | 562.3 | 111,496 | 1,201 | 97 | integration: no E1 map package |
| 6 | `usa_la_downtown` | LA Downtown | **blocked** | 160.0 | 161.7 | 118,351 | 2,312 | 736 | integration: no E1 map package |
| 7 | `jpn_mharuna` | Mount Haruna | **blocked** | 345.8 | 417.2 | 42,038 | 1,783 | 234 | integration: no E1 map package |
| 8 | `usa_sanfran_russianhill` | SanFran Russian Hill | **blocked** | 186.8 | 275.2 | 32,709 | 1,488 | 824 | integration: no E1 map package |
| 9 | `uk_london_hackney` | Hackney | **blocked** | 776.4 | 1,185.7 | 76,820 | 2,659 | 877 | integration: no E1 map package |
| 10 | `spa_barcelona_oval` | Barcelona Oval | **blocked** | 786.1 | 1,352.1 | 39,532 | 1,242 | 218 | integration: no E1 map package |
| 11 | `usa_ny_dumbo` | NY Dumbo | **blocked** | 1,292.4 | 2,373.5 | 46,243 | 2,443 | 1,023 | integration: no E1 map package |
| 12 | `uk_brighton` | Brighton | **blocked** | 975.0 | 2,007.9 | 86,528 | 2,045 | 667 | integration: no E1 map package |
| 13 | `usa_sanfran_sausalito` | SanFran Sausalito | **blocked** | 1,046.8 | 3,985.6 | 93,591 | 1,683 | 209 | integration: no E1 map package |
| 14 | `jpn_tokyo_shutoko` | Tokyo Shutoko | **blocked** | 290.9 | 1,617.9 | 58,330 | 2,709 | 1,086 | integration: no E1 map package |
| 15 | `usa_amboy_multiplayer` | Amboy | **blocked** | 136.1 | 770.8 | 22,208 | 148 | 37 | integration: no E1 map package |
| 16 | `usa_la_downtown_multiplayer` | LA Downtown | **blocked** | 154.9 | 982.1 | 12,706 | 230 | 121 | integration: no E1 map package |
| 17 | `usa_la_multiplayer_highrise` | LA Downtown | **blocked** | 6.2 | 208.9 | 2,522 | 113 | 53 | draw coverage < 25 m; extractor chunk policy |
| 18 | `showroom` | Show Room | **blocked** | 116.5 | 116.5 | 3,358 | 95 | 67 | showroom: needs showroom mode |
| 19 | `spa_barcelona_bowl_multiplayer` | Barcelona | **blocked** | 0.0 | 406.9 | 4,352 | 128 | 49 | draw coverage < 25 m; extractor chunk policy |

Every blocked row names a source record in `blocker.sourceRecord`. Integration
blockers name `probes/e1-drive/web/map-registry.js#MAP_IDS` and carry every
committed unsupported draw section with its byte offset in `blocker.byteGaps`.
The two draw-coverage blockers name the exact probe chunk item and its
levelstream chunk offset (re-derived from the levelrender Scene ChunkInfo):
`spa_barcelona_bowl_multiplayer` block 18 / chunk 12 / item 1 at byte 8,818,688;
`usa_la_multiplayer_highrise` block 14 / chunk 47 / item 1 at byte 18,569,216.
Showroom names `blocked/inventory-19.json#levels[showroom].singleBlocker`.

`unsupported` is **0**: all 19 levels build, all have a measured collision path,
and all have a committed draw-covered path or a 100 % recovered path. The two
draw-coverage blockers are `blocked` (extractor-limited), not `unsupported`,
because the extended probe recovers 100 % of the measured collision path.

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py probes/map-pipeline/tools/build_map_decisions.py
& $py probes/map-pipeline/tools/verify_map_decisions.py
```

The verifier re-derives every verdict and every measured field, re-reads the
levelrender chunk offsets, rebuilds the document twice and compares it
byte-for-byte. It prints `N/M checks passed` and exits 1 on failure; the current
run is **2463/2463 checks passed**.

## Tools

| tool | purpose |
|---|---|
| `tools/physics_scan.py` | documented shape-stream scanner; triangle/fluid/composite accounting |
| `tools/inventory_levels.py` | per-level collision, passable components, geodesic path, file hashes |
| `tools/draw_inventory.py` | native levelrender index + first-RenderList pair counts |
| `tools/probe_draws.py` | native extraction of selected correlated sections |
| `tools/coverage.py` | 0.5 m draw-vs-collision coverage on one path |
| `tools/covered_path.py` | draw-aware collision component and path |
| `tools/rank_maps.py` | merge evidence into `maps.json`, A/B/C + top 3 |
| `tools/export_candidate.py` | candidate spawn/course/checkpoints/finish layout |
| `tools/build_summary.py` | SVG/HTML top-down + table summary |
| `tools/verify_maps.py` | deterministic re-measure and classification check |
| `tools/blocked_inventory.py` | merge the 19-map evidence into `_work/map-pipeline/blocked/inventory-19.json` |
| `tools/verify_blocked.py` | deterministic re-measure of the blocked inventory and the three extended probes |
| `tools/map_decisions_lib.py` | shared read-only derivation of the 19-level decision document |
| `tools/build_map_decisions.py` | write `data/map-decisions.json` |
| `tools/verify_map_decisions.py` | re-derive every verdict, re-read chunk offsets, rebuild and compare |

### Blocked-inventory coverage schema

`blocked_inventory.py` mirrors the three coverage views of every extended probe
(`coverage.allTriangles`, `coverage.upFacingTriangles`,
`coverage.newSectionsOnly`) into `extendedProbe.coverageFraction`,
`upFacingCoverageFraction` and `newOnlyCoverageFraction`. `verify_blocked.py`
does not trust those mirrors: it re-derives all three fractions from the probe
document itself and only cross-checks a mirror when the field is present, so a
stale `inventory-19.json` cannot mask a wrong measurement.

The documented invariant (`docs/work/analysis/map-pipeline-blocked.md` §4.2,
§5.2) is 100 % coverage of the committed collision path by the extended
extraction as a whole, on all triangles and on up-facing triangles only.
`newSectionsOnly` is a **subset** view: the same stations tested against only
the newly extracted (non-committed) sections. It is therefore not 100 %
(Longbeach 0.598021; the committed sections carry the remaining stations), and
the verifier asserts the subset invariants instead — same sample/station count,
covered stations <= the full set, fraction recomputed from its own counts.

## Reproduce

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py probes/map-pipeline/tools/draw_inventory.py
& $py probes/map-pipeline/tools/inventory_levels.py
& $py probes/map-pipeline/tools/probe_draws.py --levels <level> [<level> ...] --max-pairs 100
& $py probes/map-pipeline/tools/coverage.py --level <level>
& $py probes/map-pipeline/tools/covered_path.py --level <level>
& $py probes/map-pipeline/tools/rank_maps.py
& $py probes/map-pipeline/tools/build_summary.py
& $py probes/map-pipeline/tools/verify_maps.py
& $py probes/map-pipeline/tools/blocked_inventory.py
& $py probes/map-pipeline/tools/verify_blocked.py
& $py probes/map-pipeline/tools/build_map_decisions.py
& $py probes/map-pipeline/tools/verify_map_decisions.py
```

The full 19-level extraction is recorded in
`_work/logs/map-pipeline/probe-draws-full.log`; the ranked result is
`_work/map-pipeline/maps.json`, the check is `_work/map-pipeline/verify.json`.

## Limits

- Collision-only path is not a road-semantic claim; it is the geodesic diameter
  of the largest passable component (or the committed-spawn component on River).
- Draw coverage is first RenderList direct LOD0 only. `instancesApplied:false`;
  instance-only geometry, materials, textures, shaders, culling and GPU state are
  not applied. A missing covered path means "not under these extracted draws",
  not "no draw exists in the level".
- Composite sub-meshes are counted but not transformed/applied; fluid meshes are
  parsed and excluded from drivable surface.
- No level is claimed playable by this probe. A is the already integrated
  `usa_la_river` slice; B needs a layout/reader step; C is blocked at the
  measured draw coverage with the exact reason recorded.
