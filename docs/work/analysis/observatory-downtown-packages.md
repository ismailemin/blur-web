# Observatory and Downtown E1 packages

**Date:** 8 November 2026

## Result

| map | verdict | course | evidence |
| --- | --- | --- | --- |
| `usa_la_observatory` → `observatory` | **playable (5th map)** | 536.621709 m collision path, 2,161 samples, gates 0 / 178.809347 / 357.8057 / 536.621709 | `verify_e1_map --map observatory` **22/22**; `solo-observatory` e2e **12/12**, finish **81.5 s, 0 respawns, 0 console errors** |
| `usa_la_downtown` → `downtown` | **package built, not playable** | 153.860674 m collision path, 620 samples | page loads the package; the scripted car leaves the 4 m corridor at ~arc 102 m and respawns at checkpoint-1 |

## How the packages were built

`probes/map-batch/tools/build_e1_package.py` converts a map-batch package plus a
committed collision path into `_work/e1-drive/<map>/{map,layout}.json`.
`probes/e1-drive/tools/build_map_batch.mjs` is the Node entry point; `--check`
re-builds and compares byte-for-byte.

The paths come from `probes/map-laps/tools/build_batch_paths.py`: the P48 0.5 m
raster from the map-batch collision buffers, eroded by `CLEARANCE_CELLS` (10
cells = 5.0 m) inside a 14-cell (7 m) corridor around the committed draw path,
simplified with a 0.25 m line-of-sight check, resampled at 0.25 m. The first
attempt used 3 cells (1.5 m) and both maps stalled: the car's 2.12 m
circumradius cuts corners the isotropic 1.5 m erosion does not model.

`probes/map-laps/tools/verify_batch_paths.mjs` → **114/114** (57 per map).

## Why downtown is not playable yet

The car reaches ~66.8 % (arc ≈ 102 m, exactly checkpoint-2) and then respawns
with `outside-corridor` at `(663.10, 111.99, 59.94)`, ~27 m from the checkpoint-1
respawn target. The measured downtown course is only 153.86 m and its draw path
is 160.01 m, so the collision path is a short, tight loop; the scripted
controller leaves the corridor there even with a 5 m erosion.

Next step: either widen the corridor for that section (a declared respawn rule,
not a measured lane) or find a path that keeps the driven line inside it. The
package and pins are ready; only the path needs work.

## Also fixed

- `build_module.mjs`: `MAXIMUM_MEMORY` 512 MB → **1 GB**. Downtown's 6.6 MB
  level failed `e1_create` with "out of memory copying the level"; the bigger
  cap lets the level load. `check_e1_poc` still **23/23**.
- `serve.mjs`: `/_work/map-batch/` route, because the E1 package re-fetches and
  hashes the map-batch source documents at load.
- `verify_e1_map.mjs`: a map-batch package has no `_work/map-slice/<id>/`
  settle document, so the settle is measured (finite, contacts) and the
  committed-hash comparison is recorded as not applicable; the builder check
  falls back to `build_map_batch.mjs --check --map <id>`.
- `map-pipeline` (blocked inventory, batch, decisions) and `map-batch` pins
  moved to five playable maps: **930/930**, **1450/1450**, **2274/2274**.
