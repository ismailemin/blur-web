# Long Beach — resolved: the collision path replaces the draw path

**Date:** 8 November 2026
**Status:** **integrated** as the fourth playable map. The earlier blocker is
kept below as history.

## Result

`?map=longbeach&script=sprint` finishes the measured course:

| | value |
| --- | --- |
| course length | **785.823230 m** (3,159 samples at 0.25 m) |
| gates | start 0 / checkpoint-1 262.055868 / checkpoint-2 523.768050 / finish 785.823230 |
| finish | **57.07 s**, 2 checkpoints, **0 respawns**, 0 console errors |
| real-physics drive | `node probes/map-laps/tools/drive_longbeach_path.mjs` finishes at tick 3422 (57.0 s), max 24.75 m/s |
| min clearance to a blocked cell | **6.836 m** (stated margin 6.0 m) |

The path is an A* line on the P48 passability raster, eroded by 8 cells
(>= 4.0 m clearance) inside a 14-cell (7.0 m) corridor around the committed draw
path, simplified with a 0.25 m line-of-sight check and resampled at 0.25 m.
Every sample, gate and ground value comes from the collision raster, not the
draw path.

## Why the draw path failed (history)

The scripted sprint stopped at **arc 226.8 m**, position `(-714.73, 0.30, 49.19)`,
speed decaying to 0.008 m/s with full throttle. The obstruction is a **10 cm
curb**, not a missing triangle:

- `z = 47.664`, `x = -718.404 .. -688.458` — triangles `7617, 7618, 10292, 10293`
- `x = -718.404`, `z = 28.864 .. 47.664` — triangles `10297, 10300`

The draw path at `z = 50` passes **2.336 m** from it; the car's 2.652 x 1.656 m
box proxy cuts the corner and its 2.12 m diagonal reaches the curb. The thin
engine ray at +0.20 m passes over the 10 cm face, so the engine trace alone
does not see it; the P48 wall mask does. The collision path shifts north to
`z = 54.5` along the curb and clears it by **6.836 m**.

## Files

| file | role |
| --- | --- |
| `probes/map-laps/data/longbeach-path.json` | committed collision path (`e1-drive.sprint`, `courseId: "longbeach"`) |
| `probes/map-laps/data/longbeach-draw-layout.json` | the original draw-path layout, kept as the corridor input |
| `probes/map-laps/tools/build_longbeach_path.py` | builder (`--check` passes) |
| `probes/map-laps/tools/verify_longbeach_path.mjs` | **57/57** |
| `probes/map-laps/tools/drive_longbeach_path.mjs` | real-physics drive proof |
| `probes/e1-drive/tools/map_package_builder.mjs` | `layoutSource` support + the `longbeach` entry |
| `probes/e1-drive/tools/build_map_longbeach.mjs` | writes `_work/e1-drive/longbeach/{map,layout}.json` |
| `probes/e1-drive/web/map-registry.js` | the `longbeach` entry and pins |

## Reproduce

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
& $py probes/map-laps/tools/build_longbeach_path.py --check
node probes/map-laps/tools/verify_longbeach_path.mjs      # 57/57
node probes/map-laps/tools/drive_longbeach_path.mjs       # finishes at tick 3422
node probes/e1-drive/tools/build_map_longbeach.mjs --check
node probes/e1-drive/tools/verify_e1_map.mjs --map longbeach   # 23/23
```

Then open `http://127.0.0.1:8801/?map=longbeach&script=sprint`.

## Scope labels

- The path is collision-only; it is not a retail start line, racing line or
  checkpoint placement. Gates are rules geometry.
- The map has no prop colliders yet (`propLayer: false`); the engine's
  `Level.levelphysics` is the collision authority.
- 101 diagnostic draws and 102 blocked draws are labelled and skipped; no
  fallback texture or colour.
