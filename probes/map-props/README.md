# `probes/map-props` — static prop colliders from the map-slice render packages

Derives static oriented-box (OBB) prop colliders for the visible man-made
structures of `usa_amboy` and `spa_barcelona_gracia`, using the committed
map-slice render packages as the only geometry source.

**Data only.** No renderer, GPU, browser, e1-drive integration, playable-map or
full-game claim is made. This probe does not modify `probes/e1-drive`,
`probes/map-slice`, `probes/prop-collision`, `tools/`, `upstream/` or
`game-data/`; it imports the committed P74 helpers and resolver read-only.

## Inputs

| input | role |
| --- | --- |
| `_work/map-slice/amboy-render/` | visible opaque draws, shared position/index buffers, layout points, diagnostics |
| `_work/map-slice/gracia-render/` | same for Gracia |
| `_work/map-slice/{amboy,gracia}/slice.json` + `collision.*.bin` | collision triangle mesh, used **only** as a ground-height reference |
| `probes/prop-collision/lib/{collider-build,geometry,geom2d,resolver}.mjs` | committed classification, component split, box fit and resolver |

Buffer sizes and SHA-256 are re-checked on load; a mismatch throws. The opaque
draw list plus the diagnostics draw list must tile the shared index buffer
exactly once.

## Rules (summary)

- Source is the **visible opaque draw list** (`render.json#draws`). The 405
  Amboy / 953 Gracia diagnostic draws (additive decal layer, decoder-size,
  alpha-rule, runtime albedo) are not visible opaque geometry and are not
  collider source; they are counted in `measure.json`.
- One OBB per vertex-connected component; minimum-area XZ rectangle over the
  component convex hull (rotating calipers); Y from the collision column.
- Material-independent: a vertical structure stays collidable even when its
  texture name matches a terrain pattern. Terrain/ground-surface components are
  excluded only when the geometry is actually ground (`upRatio >= 0.5`, or not
  vertical).
- Natural rock/barrier/sand/vegetation scenery is **out of scope** for a prop
  layer. It is excluded with reason `natural-terrain-scenery` and listed, never
  silently dropped.
- `vertical extent >= 0.25 m`, `top > ground + 0.20 m` (not flush),
  `bottom < ground + 2.50 m` (not overhead); a non-overhead obstacle occupies a
  ground-to-top collision column.
- Region: component footprint within **40 m** of the measured layout polyline.
- Ground: windowed collision-mesh sample (±8 m around the nearest layout-point
  ground). Fallback to the layout ground is recorded as `groundExact:false`.
- Car envelope: the documented P66/P74
  `2.98 × 1.68 × 1.35 m` maximum.

## Profiles

| profile | meaning |
| --- | --- |
| `roadside` (default) | every collider except the components that overlap the measured path; the committed line stays clear |
| `all-visible` | every mapped collider; the measured path is blocked at the recorded arcs |

`active:false` marks an on-path collider. It is kept in the data with
`exclusion.rule = "on-measured-path"`, first/last arc and sample count. Nothing
is dropped from the manifest.

## Commands

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $node probes/map-props/tools/build_colliders.mjs --map all   # manifests
& $node probes/map-props/tools/resolve.mjs                     # resolver suite
& $node probes/map-props/tools/measure.mjs                     # measurement report
& $py   probes/map-props/tools/map_topdown.py                  # top-down PNGs
& $node probes/map-props/tools/verify.mjs                      # verifier (>=100 checks)
& $node probes/map-props/tools/emit_hashes.mjs                 # hash index
```

## Outputs (`_work/map-props/`)

| file | content |
| --- | --- |
| `colliders-amboy.json` / `colliders-gracia.json` | full collider manifest: profiles, per-collider hash + provenance, path measurements, coverage |
| `manifest-amboy.json` / `manifest-gracia.json` | small per-map loader manifest for e1 (file/content hashes, counts, profile names, path) |
| `measure.json` | compact cross-map measurement report, blocked arcs with the exact structures |
| `resolve.json` | committed-resolver tests (spawn, head-on, glance, no-tunnelling, path drive, determinism) |
| `map-amboy.png` / `map-gracia.png` | top-down diagnostic |
| `verify.json` | independent verifier (all checks) |
| `hashes.json` | SHA-256 of every artifact and probe source |
| `build-summary.json` | build log summary |

Logs are written under `_work/logs/map-props/`.

## Integration (recommended)

Load `manifest-<map>.json`, then `colliders-<map>.json`, and construct the
committed resolver world with `profile:"roadside"`. Use `all-visible` only when
the course is re-measured or the on-path props are moved. Record the manifest
file hash, content hash, profile and collider count in the packet/HUD; never
fall back to a different profile silently.

## Limits

- Visible-mesh approximation, not retail collision and not `Level.levelphysics`.
- One box per connected component; a hollow or L-shaped structure is
  over-approximated by one rectangle.
- Upper-storey walls and roofs above `ground + 2.5 m` are true overhead and are
  not separate colliders; the ground-level component below them is.
- Natural terrain scenery (rock ridges, natural barriers, sand, vegetation) is
  not a prop collider in this layer.
- 40 m band only; components farther away are counted but not collidable.
- No rendered frame, browser screenshot, GPU upload or full-game claim.
