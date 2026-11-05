# Track coverage — USA LA River

Measured, data-only probe: how much of the real `usa_la_river` draw geometry sits
above the physics collision surface, and how long a continuous drivable corridor
that produces. This is not a renderer or game claim and adds no geometry.

**Status:** the committed River direct draws cover a **539.81 m** smooth corridor
from the current spawn; a 748.05 m covered route exists but contains a **1.406 m**
vertical step at the `g64-n209 → g59-n265` seam. A full lap is not present in the
data.

## Inputs (read-only)

| input | role |
| --- | --- |
| `game-data/Blur/levels/usa_la_river/level.levelrender` | RenderList / source tables |
| `game-data/Blur/levels/usa_la_river/level.levelstream` | geometry and node chunks |
| `game-data/Blur/levels/usa_la_river/Level.levelphysics` | collision surface (`Level.levelphysics`) |
| `tools/inspect_level_candidates.py`, `tools/inspect_level_chunk.py` | committed Python readers (imported, not modified) |
| `probes/collision-oracle/tests/reference_oracle.py` | committed collision parser (imported, not modified) |
| `_work/e1-drive/spawn.json` | committed spawn `(-88, 1050)` |

`build_reference.py` enumerates all 46 source-correlated River RenderList /
geometry pairs. `build_corridor.py` rasterizes a 1 m grid over the level and
runs the exact pass; it takes several minutes. `instancesApplied:false` is
preserved: only first RenderList direct draws are used, at their source world
positions. No vertex, triangle, matrix or path point is typed in.

## Commands

Use the bundled Python (it includes numpy, which the 1 m grid needs):

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py probes/track-coverage/tools/build_reference.py
& $py probes/track-coverage/tools/build_corridor.py
& $py probes/track-coverage/tools/verify_corridor.py
```

Outputs (all under `_work/track-coverage/`, never game data):

| file | content |
| --- | --- |
| `visual.json` | 46 sections: source identity, bounds, counts, draw ranges, positions/indices, hashes |
| `visual-manifest.json` | compact section manifest and input hashes |
| `corridor.json` | measured course, segments, gaps, widths, section counts, canonical hash |
| `course_samples.json` | exact 0.25 m samples for the recommended course |
| `max_samples.json` | exact 0.25 m samples for the longer covered route |
| `corridor.svg` | top-down covered / collision-only / draw-only / gap map |
| `corridor.html` | the map with the result table |
| `summary.json` | compact evidence record |
| `verify.json` | independent recomputation result |

## Method

1. **Enumerate** every source-correlated RenderList pair with the committed
   readers. Each section keeps its geometry block, node block, chunk indices,
   draw ranges, per-draw counts and SHA-256 of its float32 positions and uint32
   indices.
2. **Rasterize** a 1 m XZ grid: collision height is the highest up-facing
   `Level.levelphysics` triangle (`normal.y > 0.5`); visual height is the nearest
   committed draw triangle (`normal.y > 0.1`) in the same cell.
3. **Covered** = `|visual − collision| ≤ 0.5 m`. The exact course is then
   sampled at 0.25 m with point-in-triangle code, so the JSON metrics do not
   depend on the grid centres.
4. **Path**: unweighted Dijkstra from the committed spawn to the farthest
   reachable covered cell, then a clearance-weighted Dijkstra
   (`step × (1 + 2/(clearance + 0.5))`). The smooth course is the prefix before
   the first height step `> 0.5 m`.
5. **Width**: perpendicular covered run at 0.25 m offsets up to ±10 m, every
   2 m along the path.

## Result (recorded)

| course | length | start | finish | coverage | gaps | width |
| --- | ---: | --- | --- | ---: | --- | --- |
| **recommended smooth sprint** | **539.81 m** | `(-88, 1050)` | `(268, 1301)` | **99.73 %** | **1.41 m in 3 runs** | median 20.0 m (cap), 249/283 stations ≥6 m |
| max covered from spawn | 748.05 m | `(-88, 1050)` | `(299, 1123)` | 99.55 % | 3.36 m | median 20.0 m (cap) |
| component grid diameter | 1283.47 m | `(27, 1545)` | `(298, 1122)` | 99.74 % | 2.86 m | not measured |
| largest level component (exploratory mask) | 2282 m grid diameter | `(532, 2432)` | `(1237, 2092)` | 85.9 % exact | up to 36.5 m | median 11.5 m |

The recommended course is **18.6×** the 29 m sprint length. It starts at the
same spawn but leaves the bank into the river channel; it is a new route from
the same start, not a prefix of the 29 m straight.

Its 3 gaps are sub-metre seams at the source-section joins:

| gap | length | location |
| ---: | ---: | --- |
| 1 | 0.71 m | `(-53.17, 1013.17)` |
| 2 | 0.47 m | `(-46.33, 1009.33)` |
| 3 | 0.24 m | `(-22.17, 1007.83)` |

The 748 m route's first step `> 0.5 m` is **1.406 m** at
`(268.0, 1301.0) → (268.167, 1300.833)` on the `g64-n209 → g59-n265` seam. That
is why the recommended course stops at `(268, 1301)`.

## Source sections used by the recommended course

| section | geometry block | node block | draws | triangles | vertices |
| --- | ---: | ---: | ---: | ---: | ---: |
| `g56-n289` | 56 | 289 | 49 | 9,824 | 14,508 |
| `g58-n265` | 58 | 265 | 41 | 7,393 | 12,227 |
| `g50-n265` | 50 | 265 | 44 | 7,740 | 13,874 |
| `g71-n209` | 71 | 209 | 56 | 6,736 | 11,524 |
| `g64-n209` | 64 | 209 | 40 | 6,688 | 11,145 |
| `g59-n265` | 59 | 265 | 69 | 9,409 | 15,434 |
| **total** | | | **299** | **47,790** | **78,712** |

The route is distributed as `g71 303.2 m`, `g64 130.9 m`, `g58 45.0 m`,
`g50 31.6 m`, `g56 19.7 m`, `g59 8.0 m`.

## Lap

No lap is available from the committed data. The measured course is
point-to-point. The spawn component is a single wide braided band (median
width 20 m at the offset cap), not a closed circuit: its largest enclosed hole
is only about 61 × 62 m, and a 5 m block test leaves a path because the band is
wide, not because a separate return lane exists. There is no separate return
corridor at the scale of the 539 m course. The nearest other covered component
is **109.0 m** away boundary-to-boundary (1 m grid; see
`_work/track-coverage/gaps_between.log`). A lap would need new geometry, not a
different gate layout.

## Limits

- **Data only.** No renderer, browser, GPU, vehicle-physics or playable-game
  claim is made. The engine was not run for this probe.
- **First RenderList direct draws only.** Instances are not applied
  (`instancesApplied:false`); the 46 sections are the committed correlated pairs,
  not a full level import. Instance-only geometry could add or change surfaces.
- **The 0.5 m tolerance** is the same surface-proximity rule used by the earlier
  E1 coverage test. It is symmetric: `|visual − collision| ≤ 0.5 m`. On the
  recommended course the recorded `delta = visual − collision` ranges
  **−0.0859…+0.0009 m**, so the visual is within 9 cm of the collision surface
  (mostly a few millimetres). A strict one-sided `delta ≥ 0` test would reject
  the same committed surface because of that offset; `course_samples.json`
  records every delta so a reader can apply a different rule. A different
  tolerance changes the counts.
- **Vertical seams are real in the data.** The `g64-n209 → g59-n265` join has a
  1.406 m step at the 748 m route's 540 m mark and a smaller 0.536 m step on the
  slope-aware crossing. Neither is smoothed or invented.
- **Width is a perpendicular covered run**, not a legal racing width. The
  ±10 m offset cap makes 20 m the maximum reported value.
- **No materials, textures, effects or culling** are involved; this measures
  geometry overlap only.

## Hashes (recorded)

| file | SHA-256 |
| --- | --- |
| `corridor.json` (file) | `096c0751aa89570312647683c64f5c4b210701a2652528bc945cf712e7814aff` |
| `corridor.json` (canonical content, excluding `hash`) | `sha256:10e197c119a5edc79d7c54d1f5f728c4f1e2a8006a3e76d08caf0e0c8a349d0c` |
| `course_samples.json` | `fe44e27bcdd8b4f9b2b7745ab6a964e512fe9b59472d29d2e50dda937dbb1f76` |
| `max_samples.json` | `daf17108239bd6c2a6fb6a834ee2801298745692a6bd106acf774d9bfba0f795` |
| `corridor.svg` | `8a2839c645a98fa7f7410f4326acc856a2dec4c0891c15b7c2302f24cd567e2c` |
| `corridor.html` | `531560cbd46802b461750956daae6b9c4a4d8ef7d39c3c97ad2bf3a056e42d85` |
| `visual.json` | `877b4dc7e1f5ece197f0776239b33d23b0350f8cf77ef462c0c7a266a6abcb67` |
| `verify.json` | `9b9edb7b076356ddf6538f6d290e347d9ee2925493e4a688fa35eb6fd41ac3d9` |

## Evidence

- `_work/track-coverage/corridor.json` — measured result and canonical hash
- `_work/track-coverage/corridor.svg`, `corridor.html` — diagnostic map
- `_work/track-coverage/verify.json` — independent recomputation
- `_work/logs/track-coverage/` — raw command logs
- `docs/work/analysis/track-coverage.md` — analysis record and section table
