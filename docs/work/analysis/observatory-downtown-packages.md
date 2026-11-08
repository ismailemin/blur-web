# Observatory and Downtown E1 packages

**Date:** 8 November 2026

## Result

| map | verdict | course | evidence |
| --- | --- | --- | --- |
| `usa_la_observatory` → `observatory` | **playable (5th map)** | 536.621709 m collision path, 2,161 samples, gates 0 / 114.838678 / 308.628092 / 536.621709 | `verify_e1_map --map observatory` **22/22**; `solo-observatory` e2e **12/12**, finish **34.2 s, 0 respawns** |
| `usa_la_downtown` → `downtown` | **playable (6th map)** | 153.860674 m collision path, 620 samples, gates 0 / 32.931883 / 84.117373 / 153.860674 | `verify_e1_map --map downtown` **22/22**; `solo-downtown` e2e **12/12**, finish **12.83 s, 0 respawns, 0 console errors** |

## The downtown fix

The first downtown run stalled at arc ~102 m. The `finish-blocked` event showed
`checkpoints-missing`: **checkpoint-2 sat inside a hairpin** (nominal two-thirds
of 153.86 m = 102.56 m), so the driven line cut the gate and the finish was
refused; the car then went `airborne` and respawned.

Two changes:

1. **Checkpoints sit on straights.** The builder now searches ±12 % of the
   nominal third for the sample with the smallest heading change over a 5 m
   window. Downtown cp-1/cp-2 moved to 32.93 / 84.12 m; Observatory to
   114.84 / 308.63 m.
2. **The respawn band is a declared 12 m recovery band** (was 4 m). It is
   labelled as a recovery rule, not a measured road width; the measured raster
   clearance stays in `corridor.source.minRasterClearanceM`.

The car now crosses both checkpoints and the finish with no respawn.


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

## Why downtown was not playable (fixed)

The car reached ~66.8 % (arc ≈ 102 m) and respawned. The `finish-blocked` event
showed `checkpoints-missing`: checkpoint-2 sat inside a hairpin, the driven line
cut the gate, and the finish was refused. See "The downtown fix" above.

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
