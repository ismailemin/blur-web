# Long Beach — E1 package built, playable path blocked at arc 226.8 m

**Date:** 8 November 2026
**Status:** package built and pinned; **not integrated** (the measured path is
blocked by engine collision). This is a path fix, not a byte or extractor gap.

## What is ready

`probes/e1-drive/tools/build_map_longbeach.mjs` (new) and the `longbeach` entry
in `probes/e1-drive/tools/map_package_builder.mjs` build:

| file | bytes | sha256 |
| --- | ---: | --- |
| `_work/e1-drive/longbeach/map.json` | 72,494,393 | `3c1a47f5a368c1992a49196b72b69c4790cbbd4a9ad3222f26f93ea292dc0062` |
| `_work/e1-drive/longbeach/layout.json` | 469,223 | `ac9b68630a8c82c4f99a1f376466240ed89b9100df630bbf192a687be772eb30` |

Content hashes: map `a3bd36858ba6a58ac5d607a0a51ced4053294eaf6d94b871f8272dda373312e5`,
layout `7ef9c05477e3ee76ea2017574f5acbcd21c42cfef7f50a1d35d86956ab7214b8`.
`--check` passes and two builds are byte-identical.

Counts: 1,039 draws / 511,782 triangles / 164 textures / 1,239,168 texture
bytes / 864,473 vertices / 1,611,882 indices / 101 diagnostic draws / 102
blocked draws / 25,183 collision triangles / 7,476 instance descriptions.
Course: 818.371718 m, gates at 0 / 272.892723 / 545.610543 / 818.371718.

The page loads it: `?map=longbeach&script=sprint` reaches `consumer: running`,
correct layout hash, 0 console errors.

## Why it is not integrated

The scripted sprint stops at **arc 226.8 m**, position `(-714.73, 0.30, 49.19)`,
speed decaying to 0.008 m/s with full throttle input `[1,0,1,0]`. That is the
engine's own `Level.levelphysics` collision, not the prop layer (Longbeach has
none) and not a decode gap.

Reproduce:

```powershell
node _work/debug_longbeach.mjs    # progress freezes at 0.277243 from ~tick 1634
node _work/debug_longbeach2.mjs   # speed ~0.008 m/s at the same pose
```

The measured draw-covered path therefore crosses a wall at ~227 m. The path is
draw-covered (818.4 m, 100 % of the draw path), but draw coverage does not prove
drivability.

## What the next task must do

1. Find a drivable polyline for `usa_la_longbeachdocks` (the collision raster in
   `_work/map-laps/` or the `map-pipeline` path tools), or narrow the measured
   path around the obstruction.
2. Re-run `node probes/e1-drive/tools/build_map_longbeach.mjs` and the
   `map-laps`/`map-pipeline` verifiers.
3. Only then add the registry entry (the pin set is in the builder output) and
   `INTEGRATED["usa_la_longbeachdocks"] = "longbeach"` in
   `probes/map-batch/map_batch_lib.py`.

Until then the registry keeps three maps and the batch verifier keeps the
three-map registry pin.
