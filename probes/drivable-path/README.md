# P48 drivable-path probe — collision-only course on USA LA River

Finds the longest **collision-only** drivable course from the committed E1 spawn
`(-88, 1050)` on `usa_la_river`, using the static `Level.levelphysics` triangles
and the car envelope decoded from the XT roster. No draw geometry, renderer,
GPU or game claim is made.

```json
"scope": {
  "collisionOnly": true,
  "drawGeometryRead": false,
  "engineTraceOnly": true,
  "vehiclePhysics": false,
  "gameRun": false,
  "rendererClaim": false
}
```

## 1. Result

| field | value |
| --- | --- |
| course length | **310.395 m** |
| start | `(-88.0, 1050.0)`, ground 5.8074 m |
| end | `(103.5, 1292.5)`, ground 5.8813 m |
| samples | 1,245 at 0.25 m |
| max step | 1.55 cm (engine trace) / 0.77 cm (exact oracle triangles) |
| max 2 m grade | **3.09 %** (both instruments) |
| footprint height range | 0.147 m (limit 0.20 m) |
| min distance to a steep collision face | 7.78 m |
| engine wall trace | **0 violations** in 621 samples at 0.5 m |
| stop | the collision surface narrows to **2.0 m at +4 m** (105.83, 1295.75) and to 0.5 m at +5 m; the car envelope + margin needs 2.276 m |

The courses in `T-007` (539.81 m draw corridor) and the 555 m collision-height
route are **not** drivable: the first crosses the documented 6.36 cm section-join
rise and two 50 m faces; the second hugs and crosses a solid cliff face at
`(-85.15, 1039.9)` (engine-confirmed, 18 hit points across 4 samples). Both are
recorded as rejected candidates, not as courses.

## 2. Inputs (read-only)

| input | bytes | SHA-256 |
| --- | ---: | --- |
| `game-data/Blur/levels/usa_la_river/Level.levelphysics` | 1,945,409 | `1e678b2dff61b6d3a3d5d95a5160c3f713290251667cb27c55e262175efe4e28` |
| `_work/e1-drive/cars.json` (XT roster decode) | 31,672 | `be8843030ce86983f42d6addf05ef5653481037d0f9ec16c30f2b802706aa97f` |
| `_work/e1-drive/spawn.json` | 289 | `09f9bd38264fe0363280d94ca34ec5b7356e7d28b94d5451015b87688de8604e` |
| `_work/e1-drive/module/e1_drive.wasm` (engine trace only) | 1,006,186 | `836e7764985ba29dec026f5fe6376a6d75b3b3054b696f0484249e7e6626fdb8` |
| `probes/collision-oracle/tests/reference_oracle.py` (parser import) | 48,842 | `2d7e5aecbff57f2d119e4ca0aa9d6904194ce6c7080ef5c546edb944e75f438a` |

The parser is imported, never modified. The engine module is called only through
`_e1_ray_probe` and `_e1_ground_probe`; no e1-drive file is changed.

## 3. Model

| parameter | value | reason |
| --- | --- | --- |
| grid | 0.5 m XZ (1 m first pass for the component bbox) | task range 0.25–0.5 m |
| drivable surface | triangle `normal.y > 0.94` (≤ 20° slope) | steeper banks are not road |
| step limit | 5 cm between adjacent 0.5 m cells | engine stops at the measured 6.36 cm rise |
| grade limit | 5 % over any 2 m window; 2.5 cm per 0.5 m edge | engine climbs 2.5 %, fails 6.7 % |
| wall mask | every triangle `|normal.y| < 0.5` whose height band reaches the local ground + 0.05…2.0 m; XZ projection dilated 0.5 m | a height raster cannot see a thin fin |
| clearance | search erosion 1.0 m (2 cells); exact final check uses the car envelope + 0.30 m margin | 1.0 m is a search heuristic, not the claim |
| car envelope | 2.981 m × 1.676 m | the longest/widest harness box proxy across the five-car XT roster (Dodge wheelbase, Audi rear track) |
| safety margin | 0.30 m on every side | labelled assumption, not an XT value; final half-width 1.138 m, half-length 1.7905 m |
| search | 8-connected Dijkstra on the eroded component, no corner cutting | deterministic, complete over the component |
| smoothing | visibility string-pulling on the same component | removes the 45° staircase; every crossed cell stays in the component |

The course is the geodesic farthest point from the spawn, so it is the longest
point-to-point course the component allows under the model. No lap is claimed;
the component is a one-way band in this model.

## 4. Barrier, measured

At the end `(103.5, 1292.5)`, along the final heading (54.36°):

| ahead | physical surface width | note |
| ---: | ---: | --- |
| 0 m | 3.5 m | end of the eroded component |
| 2 m | 3.0 m | |
| 3 m | 2.5 m | |
| **4 m** | **2.0 m** | below the 2.276 m car envelope + margin |
| 5 m | 0.5 m | surface ends |

The nearest steep collision face is **7.78 m** away (oracle exact query), so the
stop is a **ledge/void narrowing**, not a wall. `path.json` records both
`freeWidths[].width` (the eroded search mask, 0.5 m at the endpoint) and
`freeWidths[].widthBase` (the physical collision-surface width, the column
above); the claim uses `widthBase` plus the exact verifier. The 555 m candidate is the one
that is stopped by a wall: a 50 m face at `(-85.15, 1039.9)` whose top is at the
road surface; the engine trace hits it from the west, and the path is rejected.

The known 29 m P37 sprint (z = 1050, x = -88 → -59) is engine-clean (0 wall hits,
max step 1.64 cm). The oracle wall mask is stricter than the engine at
`x ≈ -71.3`: a 50 m face starts at the road surface there, but the engine's thin
trace from the sprint direction misses it. That is why the conservative model
marks the 29 m straight as wall-blocked while the engine accepts it; the
candidate 310 m course does not use that face.

## 5. Commands

```powershell
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"

# 1. build the course (deterministic; canonical hash below)
& $py probes/drivable-path/tools/build_path.py --wall-mask oracle --erode 2

# 2. engine collision trace: ground + 8 wall rays per 0.5 m sample
& $node probes/drivable-path/tools/verify_engine_trace.mjs

# 3. independent oracle re-measure at 0.25 m (no builder code shared)
& $py probes/drivable-path/tools/verify_path.py

# 4. map
& $py probes/drivable-path/tools/build_map.py
```

`build_path.py` writes `_work/drivable-path/{path.json,grid.npz}`.
`verify_engine_trace.mjs` writes `engine-trace.json`.
`verify_path.py` writes `verify.json`.
`build_map.py` writes `path.svg` and `path.html`.

If the engine module is unavailable, steps 2 is skipped; steps 1, 3 and 4 still
run from the level file alone.

## 6. Recorded verification

| instrument | result |
| --- | --- |
| `build_path.py` | 310.395 m, 1,245 samples, component 38,758 cells (9,689.5 m²), canonical `sha256:4b725b10…318605b` |
| `verify_engine_trace.mjs` | **621 samples, 0 hard violations, 0 safety-margin violations**, max step 0.0155 m, max 2 m grade 3.09 %, 29 m control 0 hits; hash `sha256:3035bf36…afe655217` |
| `verify_path.py` | **8/8 checks**, length 310.3952 m, max step 0.00771 m, max grade 3.0884 %, footprint range 0.14691 m, min wall distance 7.7836 m; hash `sha256:f5e5ffb6…5abef53` |
| repeat runs | builder and all verifiers produce identical canonical hashes |

### File hashes (this run)

| file | bytes | SHA-256 |
| --- | ---: | --- |
| `path.json` | 56,136 | `81eac0ce413075de33e2b3c0e1c077412b35002420b199d9f05d2fdeef230e7f` |
| `path.svg` | 189,811 | `c0b55efe862dca9867a5d3e846953b8d42f72bfef89ca6e00b3829ca50ff30df` |
| `path.html` | 191,930 | `03dc7be64550e05fc0b41ac9e5cdf559a1d2f2bd19db20f78d68f2bfe33061ca` |
| `verify.json` | 1,754 | `bfb047e97a8c62afe82c98fc4c5006a2a55fe863e47a21d9f031351b14f98337` |
| `engine-trace.json` | 85,560 | `75dc7c2fc597016b4b7dfcf2acda4eb36673dfb5daa0611ce9950534e08f354f` |
| `grid.npz` | 997,665 | `49f64d56ae510a549fbde522136fd699650ebba5468cc96dbb06d35e99547821` |

`path.svg` is 189,811 bytes on disk (187,129 characters; UTF-8 `·` and `≤` are
multi-byte).

## 7. Limits

- **Collision-only.** No committed draw geometry is read, so no statement is made
  about whether the course is drawn, textured or visible.
- **Geometric/engine-trace drivability, not a driven lap.** The engine trace uses
  the same `C_Scene::FillCache` + `C_LineCollisionCache::Trace` path the wheels
  use, but this probe does not simulate a car, lap, opponents or materials.
- **The wall mask is conservative.** It includes every steep collision triangle,
  including one-sided faces the engine's thin trace ignores. The candidate course
  is verified with the engine trace, so this conservatism cannot create a false
  positive; it can only shorten the reported course.
- **The 0.30 m margin is an assumption.** The XT data gives the wheelbase and
  track width; it does not give body overhangs or a racing margin. The exact
  envelope used is recorded in `path.json`.
- **No full lap.** The spawn component is a one-way band; the search returns the
  farthest geodesic point, not a cycle.
- **One grid.** 0.5 m is within the requested 0.25–0.5 m range; the verifier
  re-measures the 0.25 m samples against exact triangles, so the grid is not the
  final authority.
- **No renderer/GPU/game claim.** The map is a data diagnostic, not a render.

## 8. Evidence

```text
_work/drivable-path/path.json           course, model, barriers, hashes
_work/drivable-path/path.svg            top-down map
_work/drivable-path/path.html           map + result table
_work/drivable-path/path-map.png        headless-Edge screenshot of the HTML map
_work/drivable-path/verify.json         independent oracle re-measure, PASS
_work/drivable-path/engine-trace.json   engine ground/wall trace, 0 violations
_work/drivable-path/grid.npz            height / passable / component / wall rasters
_work/logs/drivable-path/*.log          every build, verify and probe run
```

Analysis: `docs/work/analysis/drivable-path.md`.
