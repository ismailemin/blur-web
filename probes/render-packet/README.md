# E1 render packet v1 — spike

A versioned, self-contained **render packet** and a standalone WebGPU consumer
that draws one. The producer converts two outputs this repository already
verifies (River block27 level instances and the Corvette C3 race body) into
packet v1. The consumer is a copy-adapted pipeline, **not** the asset viewer.

This is a proof that the packet contract is drawable. It is not an engine
integration, not a game, and not a claim of visual fidelity.

## What exists

| Path | Role |
| --- | --- |
| `schema/render-packet.v1.schema.json` | JSON Schema (2020-12) for packet v1 |
| `tools/packet-format.mjs` | canonical JSON, packet hash, structural conformance |
| `tools/build_packet.mjs` | producer: reader output → packet |
| `tools/validate_packet.mjs` | conformance + camera-containment gate |
| `tools/verify_render_packet.mjs` | build twice, prove determinism, validate, record evidence |
| `tools/serve_packet.mjs` | loopback static server for `web/` and `_work/render-packet/` |
| `tools/capture_browser.mjs` | headless Edge + CDP: screenshots and console capture |
| `web/index.html`, `web/app.js`, `web/packet-consumer.js`, `web/style.css` | the WebGPU consumer |

Generated output and evidence go to `_work/render-packet/` (ignored by Git);
process logs go to `_work/logs/render-packet/`.

## Producer inputs

Both are existing, non-guessed outputs:

- `level_inspect.exe --instances-all game-data/Blur/levels/usa_la_river/level.levelrender _work/level-instances/instance-geometry.chunk _work/level-instances/instance-node.chunk 27 253`
  → 22 instances, 13,162 vertices, 10,308 triangles, world space, instance
  affine `g_mWorld` already baked into positions.
- `scene_inspect.exe _work/car-level-assets/corvette_c3_race.model.decoded`
  → 30,591 vertices, 36,193 triangles, 80 draws, object-local space.

Missing prerequisites fail loudly with the command that regenerates them. No
fallback data is substituted.

## Commands

```powershell
# Full packet gate: two builds, determinism, conformance, content assertions
node probes/render-packet/tools/verify_render_packet.mjs

# Just rebuild the packet
node probes/render-packet/tools/build_packet.mjs

# Conformance only
node probes/render-packet/tools/validate_packet.mjs _work/render-packet/packet.json

# Browser check (starts its own server and headless Edge)
node probes/render-packet/tools/capture_browser.mjs

# Manual inspection
node probes/render-packet/tools/serve_packet.mjs      # http://127.0.0.1:8791/
```

## Recorded result

| Item | Value |
| --- | --- |
| Packet | `_work/render-packet/packet.json` |
| Packet hash | `sha256:7ede3abd6264d8275a508260772345300e718961700b46ad68374f8ec4a0e0d1` |
| Packet size | 2,906,496 bytes (canonical hashed body 2,432,052 bytes) |
| Draws | 102 (22 level + 80 car) |
| Meshes | 2 |
| Vertices | 43,753 |
| Triangles | 46,501 |
| Materials applied | `false` (4 identities declared, no pixels) |
| Determinism | two runs, identical file SHA-256 `14774a49…c536d5` |
| Conformance | pass (ranges, indices, bounds, hash, camera containment) |
| Browser | headless Edge, WebGPU, 1600×900, **console empty** |
| Screenshots | `browser-packet-camera.png`, `browser-level-focus.png`, `browser-car-focus.png` |
| Occlusion | the placed car is occluded in the wide frame by a level prop; the car focus shot shows the body |

Evidence: `_work/render-packet/verify.json`, `_work/render-packet/packet.report.json`,
`_work/render-packet/browser-evidence.json`.

## Consumer behaviour

- Reads only packet members: `camera`, `lights`, `meshes`, `draws`.
- Uploads each `inline-json` mesh to one vertex and one index buffer; issues one
  `drawIndexed` per draw with the packet's `indexOffset`/`indexCount`.
- Uses the packet's `view`/`projection` verbatim on the first frame, so the
  screenshot is a test of the packet camera. Dragging or scrolling switches to a
  locally recomputed orbit camera (identical maths, not part of the hash).
- `?focus=<meshId>` selects a debug camera framed on one mesh. It changes only
  the camera; the whole packet is still drawn. `browser-level-focus.png` and
  `browser-car-focus.png` use it.
- Materials are not applied, so every draw uses a neutral albedo (`0.8`) under
  the packet's single directional light. This is a **declared diagnostic
  fallback**, shown in the HUD, never presented as a recovered material.

## Limits

- Packet v1 is JSON with inline geometry. It is a spike fixture, not the output
  of the wasm engine tick loop; `tick` is 0 and `alpha` is 0.
- Materials: identity only. No texture pixels, no shader binding, no paint or
  light blends. `materialsApplied` stays `false` in the packet.
- Lighting: one diagnostic directional light. No original light rig.
- Normals come from screen-space derivatives of world position.
- No shadow, post-process, particle or effect pass.
- The vehicle placement is a declared presentation anchor (level draw-bounds
  centre) because no spawn transform is recovered; it intersects level props, and
  the car is occluded in the wide frame (see the car focus screenshot).
- Level blocks 26/32 (cross-chunk grouping) and 31 (ChunkInfo prerequisite) are
  absent, as are higher LODs, damage states and wheel placement.
- Headless Edge is a proxy for the user's physical browser.
