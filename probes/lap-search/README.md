# P61 lap-search probe - collision-only closed loops on USA LA River

Searches every connected component of the P48 collision-passable surface for a
closed ring a car can drive around an enclosed island. It is a collision-only
measurement: no draw geometry is read and no renderer, vehicle-physics or game
claim is made.

```json
"scope": {
  "collisionOnly": true,
  "drawGeometryRead": false,
  "rendererClaim": false,
  "vehiclePhysics": false,
  "gameRun": false,
  "engineTrace": "thin FillCache/Trace probes only; no car simulated"
}
```

## 1. Result

**A lap exists on the collision mesh, but not in the spawn component.**

| component | cells | area (m2) | enclosed islands | loop |
| --- | ---: | ---: | ---: | --- |
| spawn (**26**) | 43,651 | 10,912.75 | **0** | **none** |
| 5 | 86,521 | 21,630.25 | 2 (812 m2, 625 m2) | **loop-01 222.040 m** |
| 129 | 42,159 | 10,539.75 | 3 (369, 238, 230 m2) | loop-02 224.225 m |
| 261 | 55,330 | 13,832.50 | 1 (100 m2) | loop-03 91.130 m |

The spawn component is **simply connected at the 0.5 m model resolution**: zero
enclosed 4-connected background regions, so no closed ring exists in it at all.
The three loops live in three other, disconnected components. The best loop
(by ring quality and a real obstacle) is:

| field | loop-01 |
| --- | --- |
| length | **222.040 m** |
| component | 5 |
| start / closure | `(115.5, 1164.0)`, closed, raw seam 0.5 m (limit 1.0 m) |
| island | 812 m2: 1,224 void cells (306 m2), 763 steep cells (191 m2), 1,262 step/grade cells |
| ring width | survives **6** clearance erosions (>= 3.5 m half-width); measured min flat band **11.75 m** |
| clearance | 2.0 m raster lower bound; **2.063 m** exact to the nearest steep face |
| max step | **0.40 cm** exact / 0.76 cm engine |
| max 2 m grade | **1.49 %** exact / 1.49 % engine |
| exact verifier | **PASS** (9/9 loop checks) |
| engine trace | **445 samples, 0 hard, 0 safety-margin violations** |

loop-02 is **2.18 m longer** (224.225 m) but its island is 100 % step/grade
cells (a rough ridge, no void and no steep face) and its ring only survives two
erosions. It is recorded as the longest loop, not the recommended one.

**Recommendation for a course that starts at the committed spawn:** keep the
310.395 m point-to-point course. There is no lap in the spawn component. The
nearest loop component (5) is separated from the spawn component by a measured
**1.118 m** gap at `(-103.5, 1004.5)` / `(-102.5, 1004.0)`, where the exact
collision mesh has a **50.0 m tall vertical face** (y 5.894..55.894,
`normal.y = 0`) 2.16 cm from the crossing line. The car envelope plus margin is
2.276 m, so the model does not connect them. Using loop-01 requires moving the
start into component 5; it is not a gate-layout change.

## 2. Inputs (read-only)

| input | bytes | SHA-256 |
| --- | ---: | --- |
| `game-data/Blur/levels/usa_la_river/Level.levelphysics` | 1,945,409 | `1e678b2dff61b6d3a3d5d95a5160c3f713290251667cb27c55e262175efe4e28` |
| `probes/collision-oracle/tests/reference_oracle.py` (parser import) | 48,842 | `2d7e5aecbff57f2d119e4ca0aa9d6904194ce6c7080ef5c546edb944e75f438a` |
| `_work/e1-drive/cars.json` (XT roster decode) | 31,672 | `be8843030ce86983f42d6addf05ef5653481037d0f9ec16c30f2b802706aa97f` |
| `_work/e1-drive/module/e1_drive.wasm` (read-only trace) | 1,006,186 | `836e7764985ba29dec026f5fe6376a6d75b3b3054b696f0484249e7e6626fdb8` |

No input is modified. The oracle parser is imported; the wasm is called only
through `_e1_create`, `_e1_ground_probe` and `_e1_ray_probe`.

## 3. Model (P48 reuse)

| parameter | value | source |
| --- | --- | --- |
| grid | 0.5 m XZ, full level 3,631 x 5,313 cells | P48 `drivable-path.md` §3.1 |
| drivable surface | triangle `normal.y > 0.94` (<= 20 deg) | P48 |
| passable cell | surface in all 8 neighbours, max neighbour dh <= 2.5 cm (5 %) | P48 |
| wall mask | steep `|normal.y| < 0.5`, height band ground+0.05..2.0 m, XZ dilated 0.5 m | P48 |
| car envelope | 2.981 m x 1.676 m (widest/longest XT box proxy) | `_work/e1-drive/cars.json` |
| safety margin | 0.30 m each side; half-width 1.138 m, half-length 1.7905 m | labelled assumption |
| island threshold | 100 m2 (400 cells) | this probe: a meaningful obstacle |

A lap is a closed cell-graph cycle that encloses an island of non-passable
collision surface. Trivial 4-cell raster cycles are excluded by the 100 m2
island threshold and by the ring criterion:

> A base island that is still enclosed after `k` 8-connected erosions of the
> passable mask has a ring whose retained cells are at least `(k+1)` cells from
> every non-passable cell (Chebyshev, hence a Euclidean lower bound). `k=3` is
> used for the reported loop line (>= 2.0 m clearance); `k=2` is accepted as a
> labelled tight ring (>= 1.5 m).

The loop line is the boundary foreground cells of the eroded island, ordered by
a Moore boundary trace, corner-cut with a visibility check on the eroded mask,
and resampled at 0.25 m. The seam is closed only when the closing chord stays in
the passable mask; the raw seam must be <= 1.0 m.

## 4. Method

1. Load `Level.levelphysics` through the committed oracle parser; flatten both
   meshes (44,244 triangles).
2. Rasterise the highest up-facing triangle at 0.5 m; compute the 8-neighbour
   height difference; rasterise the steep-face wall mask; build `base_pass`.
3. Label every 8-connected passable component. The spawn cell `(-88, 1050)` is
   component 26.
4. Label the 4-connected background and keep background regions that a border
   flood cannot reach: these are the enclosed islands. Count them per component.
5. For every island >= 100 m2, erode the passable mask 1..8 times and check
   whether the island is still enclosed. That number is the ring survival.
6. For every island that survives `k >= 2`, extract the ring at
   `k = min(3, survival)`, trace it, corner-cut it and resample it at 0.25 m.
7. Measure step, 2 m grade and raster clearance; record the loop.
8. Validate with two independent instruments:
   - `verify_loops.py`: exact triangles, own bucket index, footprint at nine
     points, exact steep-face distance, exact flat-band width;
   - `verify_engine_loops.mjs`: the engine's `FillCache`/`Trace` ground probe and
     eight horizontal rays at +0.20 and +1.00 m in the car frame, at 0.5 m.

## 5. Validation

`verify_loops.py` (exact triangles, no builder code) - **PASS, 0 failures**
(canonical hash, 3 global checks, 3 barrier checks and 3 x 9 loop checks = 34):

| loop | length | max step | max grade | footprint range | min steep face | min band | checks |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| loop-02 | 224.2246 | 1.566 cm | 1.00 % | 3.341 cm | 2.401 m | 7.00 m | 9/9 |
| loop-01 | 222.0402 | 0.397 cm | 1.49 % | 6.847 cm | 2.063 m | 11.75 m | 9/9 |
| loop-03 | 91.1298 | 0.853 cm | 1.42 % | 4.585 cm | none in band | 11.00 m | 9/9 |

`verify_engine_loops.mjs` - **0 violations** at 1,077 samples (449 + 445 + 183
at 0.5 m), 8 rays x 2 heights per sample. The 29 m P37 sprint control is also
clean (59 samples, 0 wall hits). No safety-margin hit anywhere.

## 6. Why the spawn component has no lap

At 0.5 m the spawn component is a simply connected band: it has **zero** enclosed
background regions, so no cycle can enclose an island. A 1 m screening pass did
find 69 holes in the same region (`_work/logs/lap-search/explore-holes.log`),
but those are coarse-raster artefacts: the finer grid resolves drivable
connections through them. The 0.5 m result is the P48 model resolution and the
same grid that reproduces the P48 38,758-cell component at erosion 2.

The loops are in different components:

| loop component | nearest spawn-comp cell | gap | barrier |
| --- | --- | ---: | --- |
| 5 | `(-103.5, 1004.5)` -> `(-102.5, 1004.0)` | **1.118 m** | 50.0 m vertical face (y 5.894..55.894), 2.16 cm from the line |
| 129 | `(108.5, 1297.0)` -> `(322.5, 1379.5)` | 229.352 m | separate component; exact profile 2,346/4,000 samples with no ground, max step 1.427 m |
| 261 | `(108.5, 1297.0)` -> `(1241.5, 1960.5)` | 1,312.982 m | separate component; 2,994/4,000 samples with no ground, max step 6.030 m |

The comp-5 barrier is a continuous vertical fin, not a single point: the
near-approach scan finds 20 clusters along it, all at the same 1.118 m cell gap
(`_work/logs/lap-search/explore-barrier.log`). The engine thin trace does **not**
register that face at the sampled point (0 hits at +0.2/+1.0 m over 2.118 m),
which is the documented one-sided-face limitation of the wheel-style thin trace,
not evidence of passage. The exact collision mesh and the P48 wall mask both
place a 50 m face there, so the model separation stands. No box-body collision
test is made; that is outside this probe.

## 7. Commands

Use the bundled Python and the emsdk node:

```powershell
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"

# 1. build all components, islands and candidate loops
& $py probes/lap-search/tools/build_loops.py

# 2. independent exact-triangle verifier
& $py probes/lap-search/tools/verify_loops.py

# 3. engine collision trace
& $node probes/lap-search/tools/verify_engine_loops.mjs

# 4. PNG + SVG map
& $py probes/lap-search/tools/build_map.py
```

The exploratory screens are also runnable, in order:

```powershell
& $py probes/lap-search/tools/explore_components.py   # 1 m all-component screen
& $py probes/lap-search/tools/explore_full05.py       # full 0.5 m raster + islands
& $py probes/lap-search/tools/explore_erosion.py      # island erosion survival
& $py probes/lap-search/tools/explore_connect.py      # component gap
& $py probes/lap-search/tools/explore_barrier.py      # exact barrier profile
```

`explore_full05.py` writes `_work/lap-search/_full05.npz`; the later explore
scripts read the saved rasters. The final pipeline does not depend on it.

## 8. Recorded hashes

| artifact | bytes | file SHA-256 | canonical |
| --- | ---: | --- | --- |
| `loops.json` | 109,292 | `2aabf0cd04fc96b2e2cf903a392fc86fc5b2cd6e85772b9d0e8b523a0826a59c` | `sha256:acc47b6bbd0719af857323060b273e83e933bf7b86330d0362b3e70409873536` |
| `verify.json` | 8,494 | `6f1b133c6fe04d4e409f99da81ce4307f9f6cfaad7c447771d080acd6464615e` | `sha256:ced92399c7c0394aad605aa582af43669157a4a8b2cc07bef164a4ecfe2a7236` |
| `engine-trace.json` | 163,553 | `01dbba4c9a2f45aa1389bcb8bb375a46802dd00807d78a426ba1f40056c25349` | `sha256:07d888f1b191cac17d887f7b0aa598ba450b33e3a20db5f426c1a5f1ca4e5b6b` |
| `loops.svg` | 489,497 | `5226b8285ac6468d5139720b5607e3d6b18fc6fa594f5a4fbf6b8993d0d407e9` | - |
| `loops.png` | 151,153 | `6a39cc7d87f316ea93c4f2a8ac7f51c0e3a0d101cb368e81e287224463aa03e7` | - |
| `grid.npz` | 9,600,378 | `7fd4314dd14f4d85eea0756c1a7c98c8b36c40a8c299eac1bb9c64c3f06473fb` | - |

Repeat runs of the builder, exact verifier and map produce byte-identical
output. Two consecutive engine-trace runs also produce byte-identical output
(checked after the final `loops.json` rebuild).

## 9. Limits

- **Collision only.** No draw geometry is read. A loop is not claimed to be
  drawn, textured or visible. P51's coverage result is for the 310 m course only.
- **Geometric/trace drivability, not a driven lap.** No car, steering, speed,
  suspension or lap timing is simulated. The engine trace is the same
  `FillCache`/`Trace` path the wheels use.
- **The wall mask is conservative.** It includes one-sided faces the engine thin
  trace ignores, so it can shorten or disconnect the model but cannot create a
  false pass. The loops are validated by the exact triangles and the engine
  trace, not by the mask alone.
- **No box-body collision test.** The engine probe is a thin wheel-style ray;
  the 50 m barrier on comp 5 is an exact-triangle result, and the thin trace's
  miss there is the documented one-sided-face limitation.
- **The 0.30 m margin is an assumption.** The XT roster gives wheelbase and
  track width, not body overhangs. The exact envelope is recorded in
  `loops.json`.
- **Best vs longest.** `bestLoop` is loop-01: the longest loop whose island has
  >= 10 % void or steep cells and whose ring survives >= 3 erosions. The longest
  loop overall is loop-02 and is recorded as such.
- **No renderer/GPU/game claim.** The map is a data diagnostic.

## 10. Evidence

```text
_work/lap-search/loops.json          islands, loops, components, barriers, hashes
_work/lap-search/verify.json         independent exact-triangle result, PASS
_work/lap-search/engine-trace.json   engine ground + 8 x 2 rays, 0 violations
_work/lap-search/loops.png           top-down map (overview + loop-01 zoom)
_work/lap-search/loops.svg           vector schematic of the same map
_work/lap-search/grid.npz            base pass / wall / height rasters
_work/logs/lap-search/*.log          every build, screen, verify, repeat run
```

Analysis document: `docs/work/analysis/lap-search.md`.
