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
