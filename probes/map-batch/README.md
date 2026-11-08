# `map-batch` — one-command map package compiler

Give the compiler a level id, get a self-describing physics + draw + texture +
path + spawn + layout + blocker package and a verifier.

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

# one map
& $py probes/map-batch/build_map.py --level usa_amboy

# every level directory (19)
& $py probes/map-batch/build_map.py --all

# two independent builds per level; every pinned file compared byte-for-byte
& $py probes/map-batch/build_map.py --all --determinism

# independent verifier (>=300 checks; ~350k with per-texture pins)
& $py probes/map-batch/verify_batch.py
```

## Output

`_work/map-batch/<level>/` (generated game data, never committed):

| file | content |
|---|---|
| `manifest.json` | schema, source pins, counts, artifact pins, integration contract |
| `draws.json` | sections, every draw with status/range/texture join, buffers, totals |
| `draws.positions.f32.bin` | merged first-RenderList direct LOD0 positions (`float32x3`) |
| `draws.uv0.f32.bin` | merged UV0 (`float32x2`, vertex-aligned) |
| `draws.indices.u32.bin` | one global index buffer (`uint32`), every draw range |
| `textures/index.json` | static albedo items, source ids, statuses, per-blob pins |
| `textures/tex-NNN.rgba` | deduplicated RGBA8 mip0 blobs (bindable draws only) |
| `collision.json` | static triangle mesh provenance, counts, shapes, bounds |
| `collision.positions.f32.bin` | collision vertex table |
| `collision.indices.u32.bin` | collision triangle list |
| `path.json` | measured path samples, continuity, coverage, checkpoints |
| `path.points.f32.bin` | `x,z,h` `float32le`, 12 B per point |
| `spawn.json` | spawn pose, 25-ray band proof, checkpoint/finish layout |
| `blockers.json` | typed blockers with severity and fatal flag |
| `report.json` | per-level counts, grade, stage timings, hashes |

Batch evidence lives at `_work/map-batch/batch-summary.json` (per-level counts and
timings + total) and `_work/map-batch/determinism.json` (two-build hashes).
Logs are written to `_work/logs/map-batch/`.

## What is reused (no second decoder)

| stage | committed reader |
|---|---|
| collision | `probes/map-pipeline/tools/physics_scan.py` + `extract_slice.collision_geometry` |
| draw decode | `_work/build/asset-reader-native/Release/level_inspect.exe`, staged by `probe_draws.py` |
| textures | `probes/map-slice/tools/amboy_texture_bindings.py` (Resolver, TextureArchive, decoder, classifier) |
| spawn rays | `probes/map-slice/tools/extract_slice.py` ray helpers |
| measurement | committed `_work/map-pipeline` grid, collision path and draw-covered path |

The compiler merges already-decoded native JSON; it does not parse the physics,
levelrender or levelstream binary formats itself.

## Grades

| grade | rule |
|---|---|
| `blocked` | measured draw-covered path < 25 m |
| `playable` | level integrated in `probes/e1-drive/web/map-registry.js` and package valid |
| `partial` | measured draw-covered path >= 25 m but not integrated |

`playable` is an integration fact with a repository pin, not a data-only claim.

## Limits

- first-RenderList direct LOD0 draws only; `instancesApplied:false`.
- static albedo identity + original UV0 only; colour/blend/alpha/shader/sampler/
  mips/sRGB are not applied.
- no vertex normals are exported.
- collision is the static triangle mesh; simple/instance/fluid shapes are
  excluded from the package (the engine still loads the full physics file).
- spawn/course are derived from the measured path; there is no retail start
  line, no lap circuit and no pickup placement.
- no renderer, GPU, browser, engine-physics or playable-game claim.
