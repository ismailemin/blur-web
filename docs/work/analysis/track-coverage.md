# Track coverage — longest covered River corridor from committed draws + collision

**Date:** 5 November 2026
**Owner:** P41 (sub-agent)
**Scope:** `probes/track-coverage/**`, `_work/track-coverage/**`,
`_work/logs/track-coverage/**` and this document. No change to `probes/e1-drive`,
`probes/asset-reader`, `probes/collision-oracle`, the engine, `tools/`,
`upstream/` or `game-data/`. No renderer, browser, GPU, vehicle-physics or
playable-game claim is made.

## Result

The committed River draw geometry covers a **539.81 m** smooth point-to-point
corridor from the current E1 spawn `(-88, 1050)` to `(268, 1301)`. It is
**99.73 %** covered at a 0.25 m sample step, with **1.41 m** of total gaps in
three sub-metre seams. A longer **748.05 m** covered route reaches
`(299, 1123)` but contains a **1.406 m** vertical step at the
`g64-n209 → g59-n265` seam; that is why the recommended course stops before it.
The longest covered route in the same component is **1,283.47 m** from
`(27, 1545)` to `(298, 1122)` (99.74 %, 2.86 m of gaps, same class of seam).

No full lap exists in the committed data. The measured corridor is
point-to-point; the spawn component is a braided band with only local holes
(largest about 61 × 62 m), and the nearest other covered component is **109.0 m**
away boundary-to-boundary.

## 1. Question

The E1 drive slice draws the real `river.block56.node289` geometry over a 29 m
sprint. The open question was whether another RenderList/node on `usa_la_river`
covers a longer continuous stretch of the collision surface, and whether that
stretch can become the next sprint or a lap. The answer must come from the
committed draw geometry and `Level.levelphysics`, not from a hand-drawn route.

## 2. Inputs and provenance

| input | SHA-256 / record |
| --- | --- |
| `game-data/Blur/levels/usa_la_river/Level.levelphysics` | `1e678b2dff61b6d3a3d5d95a5160c3f713290251667cb27c55e262175efe4e28` |
| `_work/track-coverage/visual.json` (46 sections) | `877b4dc7e1f5ece197f0776239b33d23b0350f8cf77ef462c0c7a266a6abcb67` |
| `_work/track-coverage/corridor.json` | `sha256:10e197c119a5edc79d7c54d1f5f728c4f1e2a8006a3e76d08caf0e0c8a349d0c` |
| committed spawn | `_work/e1-drive/spawn.json`, `(-88, 1050)`, heading +X |

The geometry was extracted by the committed Python readers
(`tools/inspect_level_candidates.py`, `tools/inspect_level_chunk.py`) and the
collision mesh by `probes/collision-oracle/tests/reference_oracle.py`, both
read-only. `instancesApplied:false` is preserved: only first RenderList direct
draws are used, at their source world positions. No vertex, triangle, matrix,
material or course point was invented.

### 2.1 RenderList / node enumeration

The committed reader found **46** source-correlated first-RenderList/geometry
pairs on River. Their bounds and counts are the enumeration requested by the
task; the six sections used by the corridor are marked `*` in the first column.

| section | geometry block | node block | draws | triangles | vertices | bounds x / z |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `g102-n279` | 102 | 279 | 37 | 5,746 | 11,617 | x -26.4…436.0, z 862.5…1515.2 |
| `g103-n245` | 103 | 245 | 53 | 6,624 | 12,433 | x 1174.9…2131.4, z 2148.5…3032.4 |
| `g104-n227` | 104 | 227 | 52 | 7,903 | 16,694 | x 479.6…1297.8, z 395.1…1767.7 |
| `g108-n307` | 108 | 307 | 73 | 5,984 | 11,250 | x -1226.6…3108.6, z -825.4…3593.4 |
| `g112-n283` | 112 | 283 | 37 | 8,597 | 14,794 | x 774.3…1947.5, z 2383.8…3472.3 |
| `g113-n227` | 113 | 227 | 10 | 7,346 | 9,601 | x 446.9…838.7, z 1733.5…2180.1 |
| `g114-n277` | 114 | 277 | 40 | 5,381 | 9,158 | x 1000.0…2640.3, z 569.9…2790.6 |
| `g132-n133` | 132 | 133 | 1 | 28 | 58 | x -510.7…-125.7, z 1323.5…2227.5 |
| `g136-n137` | 136 | 137 | 1 | 49 | 89 | x 417.8…615.7, z 1468.6…1965.8 |
| `g172-n173` | 172 | 173 | 8 | 1,074 | 2,032 | x 767.4…882.9, z 2498.0…2565.4 |
| `g252-n253` | 252 | 253 | 5 | 208 | 344 | x -106.6…-16.6, z 1024.0…1076.9 |
| `g258-n259` | 258 | 259 | 45 | 7,475 | 14,961 | x -154.8…505.4, z 1469.8…2383.4 |
| `g272-n273` | 272 | 273 | 3 | 475 | 490 | x 531.9…571.4, z 2267.8…2273.1 |
| `g296-n297` | 296 | 297 | 2 | 136 | 181 | x 1380.1…2206.1, z 1081.1…2181.8 |
| `g39-n199` | 39 | 199 | 16 | 7,918 | 15,824 | x 560.5…752.8, z 1660.3…1763.8 |
| `g41-n227` | 41 | 227 | 1 | 7,525 | 9,673 | x 649.6…676.6, z 2129.1…2160.0 |
| `g43-n195` | 43 | 195 | 2 | 544 | 1,088 | x 505.6…564.7, z 1958.7…2013.3 |
| `g44-n285` | 44 | 285 | 16 | 9,718 | 19,444 | x 1042.0…1217.6, z 1601.0…1722.4 |
| `g45-n283` | 45 | 283 | 25 | 5,948 | 11,041 | x 931.2…1237.5, z 2514.4…2824.8 |
| `g46-n303` | 46 | 303 | 30 | 9,756 | 19,156 | x 1125.4…1366.1, z 1618.2…2006.2 |
| `g48-n277` | 48 | 277 | 44 | 9,758 | 12,697 | x 1286.3…2427.8, z 1701.4…2821.6 |
| `g50-n265` * | 50 | 265 | 44 | 7,740 | 13,874 | x -373.9…332.4, z 519.2…1155.2 |
| `g51-n237` | 51 | 237 | 30 | 9,966 | 20,147 | x 1370.1…1678.6, z 2491.3…2853.2 |
| `g52-n263` | 52 | 263 | 44 | 6,900 | 11,991 | x 983.4…1286.3, z 1452.9…1754.5 |
| `g54-n301` | 54 | 301 | 17 | 3,810 | 7,650 | x -162.1…242.3, z 833.6…1365.7 |
| `g56-n289` * | 56 | 289 | 49 | 9,824 | 14,508 | x -375.0…189.1, z 671.5…1606.3 |
| `g58-n265` * | 58 | 265 | 41 | 7,393 | 12,227 | x -330.1…241.1, z 711.2…1202.5 |
| `g59-n265` * | 59 | 265 | 69 | 9,409 | 15,434 | x -102.1…486.9, z 708.3…1455.2 |
| `g60-n263` | 60 | 263 | 55 | 6,920 | 11,278 | x 1042.2…1728.6, z 1733.5…2285.5 |
| `g61-n207` | 61 | 207 | 28 | 6,650 | 12,274 | x -242.7…150.8, z 778.0…1491.5 |
| `g62-n177` | 62 | 177 | 3 | 1,292 | 2,528 | x 521.1…575.8, z 2258.0…2363.4 |
| `g63-n277` | 63 | 277 | 48 | 7,216 | 9,825 | x 1076.6…1837.7, z 1452.0…2158.4 |
| `g64-n209` * | 64 | 209 | 40 | 6,688 | 11,145 | x 28.2…382.3, z 1125.4…1496.9 |
| `g67-n259` | 67 | 259 | 49 | 7,997 | 16,042 | x 72.7…458.1, z 1555.2…2066.4 |
| `g71-n209` * | 71 | 209 | 56 | 6,736 | 11,524 | x -27.2…573.7, z 868.4…1582.6 |
| `g73-n293` | 73 | 293 | 56 | 7,474 | 11,715 | x 517.9…815.5, z 1939.6…2575.7 |
| `g74-n293` | 74 | 293 | 53 | 5,406 | 9,411 | x 609.4…1085.8, z 2237.1…2618.1 |
| `g76-n187` | 76 | 187 | 14 | 2,446 | 5,052 | x 277.5…750.5, z 1904.3…2260.7 |
| `g77-n217` | 77 | 217 | 25 | 9,762 | 14,366 | x 410.8…586.8, z 1432.1…1721.1 |
| `g79-n205` | 79 | 205 | 44 | 6,294 | 12,367 | x 125.2…677.5, z 2009.6…2637.0 |
| `g80-n227` | 80 | 227 | 28 | 9,561 | 16,483 | x 623.6…1158.1, z 1482.2…2170.2 |
| `g88-n283` | 88 | 283 | 95 | 9,343 | 17,782 | x 944.0…2477.9, z 2205.9…3237.2 |
| `g92-n283` | 92 | 283 | 70 | 8,504 | 14,380 | x 705.6…1428.7, z 1767.1…2823.7 |
| `g95-n297` | 95 | 297 | 44 | 5,662 | 11,417 | x 828.4…1950.2, z 1549.4…2827.0 |
| `g98-n199` | 98 | 199 | 28 | 9,876 | 19,695 | x 512.8…860.7, z 1590.4…1930.9 |
| `g99-n217` | 99 | 217 | 37 | 9,262 | 13,595 | x 341.1…723.7, z 1492.0…1932.9 |

The spawn component contains the road/terraces around `g56`, `g58`, `g50`,
`g71`, `g64` and `g59`. Other sections are outside the reachable band (or are
props/structures); the component search never crosses them.

## 3. Method

1. **Coverage grid (1 m).** For every XZ cell:
   - collision height = highest up-facing `Level.levelphysics` triangle
     (`normal.y > 0.5`) containing the cell centre;
   - visual height = nearest committed draw triangle (`normal.y > 0.1`)
     containing the cell centre;
   - a cell is covered when the nearest visual triangle is within **0.5 m** of
     the collision surface.
2. **Component.** 8-connected covered cells. The spawn `(-88, 1050)` lies in
   the largest component of the probe's 1 m mask (100,614 cells).
3. **Path.** Unweighted Dijkstra from the spawn to the farthest reachable cell
   `(299, 1123)` at 711.8 m. A clearance-weighted Dijkstra
   (`step × (1 + 2/(clearance + 0.5))`) follows the middle of the band and
   measures 748.05 m.
4. **Exact samples (0.25 m).** Every path sample is re-tested with
   point-in-triangle code. `covered` means a visual triangle exists within
   0.5 m of the highest collision triangle at that point. Segment lengths, gap
   lengths, section metres and heights are computed from these samples, not
   from grid counts.
5. **Smooth course.** The recommended course is the prefix of the 748.05 m
   route before the first height step `> 0.5 m`. That step is **1.406 m** at
   `(268.0, 1301.0) → (268.167, 1300.833)` on the `g64-n209 → g59-n265` seam.
6. **Width.** Perpendicular covered run at 0.25 m offsets up to ±10 m, every
   2 m along the path.

## 4. Recommended course

| field | value |
| --- | --- |
| name | recommended smooth sprint extension |
| length | **539.808 m** |
| start | `(-88.0, 1050.0)`, ground `5.8074` (matches the engine `e1_ground_probe` `5.8074`) |
| finish | `(268.0, 1301.0)`, ground `2.9883` |
| samples | 2,257 at 0.25 m |
| covered | 2,251 (**99.734 %**) |
| gaps | 3 runs, **1.413 m** total |
| max height step | **0.0781 m** (4.47°) |
| max slope | **17.349°** at `(263.25, 1303.0) → (263.5, 1303.0)` |
| width | min 2.75 m, median 20.0 m (offset cap), mean 16.77 m; 280/283 stations ≥3 m, 249/283 ≥6 m |
| draws / triangles / vertices (six source sections) | **299 / 47,790 / 78,712** |
| collision / visual triangles under the samples | 227 / 204 |

### 4.1 Continuous segments

| # | length | start | finish |
| ---: | ---: | --- | --- |
| 1 | 53.370 m | `(-88.0, 1050.0)` | `(-53.333, 1013.333)` |
| 2 | 7.714 m | `(-52.667, 1012.667)` | `(-46.5, 1009.5)` |
| 3 | 27.493 m | `(-46.0, 1009.0)` | `(-22.333, 1007.667)` |
| 4 | **449.819 m** | `(-22.0, 1008.0)` | `(268.0, 1301.0)` |

### 4.2 Gaps

| # | length | start | end |
| ---: | ---: | --- | --- |
| 1 | 0.707 m | `(-53.167, 1013.167)` | `(-52.833, 1012.833)` |
| 2 | 0.471 m | `(-46.333, 1009.333)` | `(-46.167, 1009.167)` |
| 3 | 0.235 m | `(-22.167, 1007.833)` | `(-22.167, 1007.833)` |

All three are at source-section joins, not at a missing mesh region. They are
reported as gaps because a strict 0.25 m point test finds no triangle exactly at
the sample.

### 4.3 Section distribution

| section | metres | draws | triangles | vertices | positions SHA-256 (prefix) | indices SHA-256 (prefix) |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| `g71-n209` | 303.23 | 56 | 6,736 | 11,524 | `2ed051dd16c25868` | `bffa2f5d40ec5b68` |
| `g64-n209` | 130.90 | 40 | 6,688 | 11,145 | `9fa0646e5b0c100c` | `e42076fbaaf425e6` |
| `g58-n265` | 45.01 | 41 | 7,393 | 12,227 | `2565265ddb1732d5` | `9578f1fb3688e4ba` |
| `g50-n265` | 31.55 | 44 | 7,740 | 13,874 | `d3b29f46fab533f0` | `1ea461c94d139324` |
| `g56-n289` | 19.67 | 49 | 9,824 | 14,508 | `372ef9751097586c` | `4d57f4ed5b2fc6b5` |
| `g59-n265` | 8.04 | 69 | 9,409 | 15,434 | `5baaefc87d08cdd2` | `346df7d2f0c0f1ba` |

## 5. Longer routes and the step

| route | length | start | finish | coverage | gaps | max step |
| --- | ---: | --- | --- | ---: | ---: | ---: |
| recommended smooth | 539.808 m | `(-88, 1050)` | `(268, 1301)` | 99.734 % | 1.413 m | 0.0781 m |
| max covered from spawn | 748.046 m | `(-88, 1050)` | `(299, 1123)` | 99.551 % | 3.356 m | **1.406 m** |
| component diameter | 1283.467 m | `(27, 1545)` | `(298, 1122)` | 99.735 % | 2.857 m | **1.4351 m** |

The 748 m route's step is at `(268.0, 1301.0) → (268.167, 1300.833)` between
`g64-n209` and `g59-n265`. The 1,283 m route crosses the same class of seam at
`(268.0, 1301.0) → (268.333, 1300.667)`. Both are real height discontinuities in
the committed data; the recommended course stops at the first one.

A slope-aware crossing exists at `(272.0, 1312.0) → (272.167, 1311.833)` with a
**0.536 m** step, but it costs two more gaps (6.0 m and 5.25 m) in the connector,
so it is not proposed as the course.

### 5.1 Largest covered component on the level

An earlier exploratory mask with a symmetric tolerance (`comp0_samples.json`)
found a larger eastern-basin component (122,122 cells; bounds
`x 532…1237, z 2092…2432`) with a grid diameter of **2,282 m** from
`(532, 2432)` to `(1237, 2092)`. Exact 0.5 m sampling finds only **85.9 %**
coverage with gaps up to **36.5 m** (e.g. `(762, 2485) → (778.67, 2468.33)`),
so it is **not** a continuous corridor and is not a course candidate. The final
builder's mask ranks the spawn component first (100,614 cells); the two masks
differ only in the lower visual-height tolerance and both agree that the
eastern basin is not continuous.

## 6. Lap analysis

**No full lap is available from the committed data.**

- The measured corridor is point-to-point. The spawn component is a single wide
  braided band (median measured width 20 m, offset cap), not a closed circuit.
  Its enclosed cycles are local holes: the largest is **1,888 cells** at
  `x 11…72, z 1313…1375` (about 61 × 62 m). A 5 m block test on the 1 m grid
  leaves a path because the band is wide, not because a separate long return
  lane exists. There is no separate return corridor at the scale of the 539 m
  course.
- The nearest other covered component is **109.0 m** away
  boundary-to-boundary (`(371, 1394) → (431, 1485)`, 1 m grid;
  `_work/track-coverage/gaps_between.log`). The rest are farther. Bridging that
  gap would require new geometry, not a different gate layout.
- The 2,282 m eastern component is disconnected from the spawn and is not
  continuous (85.9 % exact coverage, 36.5 m gaps).

## 7. Verification

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py probes/track-coverage/tools/build_reference.py
& $py probes/track-coverage/tools/build_corridor.py
& $py probes/track-coverage/tools/verify_corridor.py
```

Recorded result:

- `build_reference.py`: 46 sections; `visual.json` SHA-256
  `877b4dc7e1f5ece197f0776239b33d23b0350f8cf77ef462c0c7a266a6abcb67`.
- `build_corridor.py`: recommended `539.808 m`, coverage `99.734 %`, gaps
  `1.413 m`, width median `20.0 m`; max route `748.046 m`; component route
  `1,283.467 m`.
- `verify_corridor.py`: **PASS**, `sampleMismatches:0`,
  `sectionLabelMismatches:0`, `2251/2257` covered, `length 539.808 m`,
  `max step 0.0781 m`, canonical hash
  `sha256:10e197c119a5edc79d7c54d1f5f728c4f1e2a8006a3e76d08caf0e0c8a349d0c`.
- The verifier re-extracts the six used sections with the committed readers,
  hashes their positions/indices, re-reads `Level.levelphysics` through the
  collision oracle, and recomputes every 0.25 m sample with its own
  point-in-triangle code. The builder and verifier agree exactly.
- `corridor.svg` parses as XML (4,058 elements); `corridor.html` embeds the SVG
  and the result table.

### Determinism

- `visual.json` and `corridor.json` are written from sorted inputs and contain
  no timestamps. Repeated `build_corridor.py` runs produce the same canonical
  hash `sha256:10e197…49d0c`; the path search uses deterministic heap
  tie-breaking.
- `corridor.svg` / `corridor.html` are deterministic text; no clock, random or
  locale-dependent field is written.

### Recorded file hashes

| file | SHA-256 |
| --- | --- |
| `corridor.json` (file) | `096c0751aa89570312647683c64f5c4b210701a2652528bc945cf712e7814aff` |
| `corridor.json` (canonical body) | `sha256:10e197c119a5edc79d7c54d1f5f728c4f1e2a8006a3e76d08caf0e0c8a349d0c` |
| `course_samples.json` | `fe44e27bcdd8b4f9b2b7745ab6a964e512fe9b59472d29d2e50dda937dbb1f76` |
| `max_samples.json` | `daf17108239bd6c2a6fb6a834ee2801298745692a6bd106acf774d9bfba0f795` |
| `corridor.svg` | `8a2839c645a98fa7f7410f4326acc856a2dec4c0891c15b7c2302f24cd567e2c` |
| `corridor.html` | `531560cbd46802b461750956daae6b9c4a4d8ef7d39c3c97ad2bf3a056e42d85` |
| `visual.json` | `877b4dc7e1f5ece197f0776239b33d23b0350f8cf77ef462c0c7a266a6abcb67` |
| `verify.json` | `9b9edb7b076356ddf6538f6d290e347d9ee2925493e4a688fa35eb6fd41ac3d9` |

## 8. Recommended next course

**Sprint extension, not a lap.** Put the start line at the committed spawn
`(-88, 1050)` and the finish at `(268, 1301)`; the car runs 539.81 m along the
river channel with 99.73 % exact coverage and no height step above 0.078 m. The
existing 29 m sprint is a straight on the bank; the measured corridor leaves
the spawn into the channel, so this is a new route from the same start, not a
prefix of the old straight. The new course is 18.6× the current sprint length.

If the main agent wants the absolute longest covered route from the same spawn,
use 748.05 m to `(299, 1123)` and document the 1.406 m step as a jump/limit. If
it moves the start to `(27, 1545)`, the component diameter is 1,283.47 m, again
with the same seam step. A lap is not available.

## 9. Limits

- Data-only analysis. No renderer, browser, GPU, engine, vehicle-physics or
  playable-game claim.
- First RenderList direct draws only; instances are not applied. The 46
  sections are the committed correlated pairs, not a full level import.
  Instance-only geometry could add or change surfaces.
- The 0.5 m proximity rule is the same surface-matching rule used by the earlier
  E1 coverage test. It is symmetric (`|visual − collision| ≤ 0.5 m`). On the
  recommended course `delta = visual − collision` ranges **−0.0859…+0.0009 m**,
  so the visual is within 9 cm of the collision surface, mostly a few
  millimetres. A strict one-sided `delta ≥ 0` test would reject the same
  committed surface because of that offset; `course_samples.json` records every
  delta so a reader can apply a different rule. A different tolerance changes
  the counts.
- The `g64-n209 → g59-n265` seam is a real vertical step (1.406 m at the 748 m
  route's 540 m mark; 0.536 m on the slope-aware crossing). It is not smoothed
  or hidden.
- Width is a perpendicular covered run, not a legal racing width; the ±10 m
  offset cap makes 20 m the maximum reported value.
- No materials, textures, effects or culling are involved. The collision mesh
  is the physics surface; the visual triangles are the real direct draws.

## 10. Evidence paths

| path | content |
| --- | --- |
| `_work/track-coverage/visual.json` | 46 sections, source identity, positions/indices, hashes |
| `_work/track-coverage/visual-manifest.json` | compact section manifest and input hashes |
| `_work/track-coverage/corridor.json` | measured course, segments, gaps, widths, counts, canonical hash |
| `_work/track-coverage/course_samples.json` | exact 0.25 m samples for the recommended course |
| `_work/track-coverage/max_samples.json` | exact 0.25 m samples for the 748 m route |
| `_work/track-coverage/corridor.svg` | top-down covered / collision-only / draw-only / gap map |
| `_work/track-coverage/corridor.html` | the map with the result table |
| `_work/track-coverage/summary.json` | compact result record |
| `_work/track-coverage/verify.json` | independent recomputation, PASS |
| `_work/track-coverage/gaps_between.log` | nearest other component, 109.0 m |
| `_work/track-coverage/lap_test.log`, `detour.log` | 5 m block test and alternative path lengths (band width, not a second lane) |
| `_work/track-coverage/diameter_samples.json`, `comp0_samples.json` | secondary diameter / largest-component measurements |
| `_work/logs/track-coverage/` | raw build and verify logs |
