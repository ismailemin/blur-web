# E1 render packet v1.1 — spike

A versioned **render packet** and a standalone WebGPU consumer that draws it from
real Blur geometry with a fixed-step, interpolated tick loop.

The producer converts two outputs this repository already verifies (River block27
level instances and the Corvette C3 race body) into a packet, then adds a
deterministic 120-tick timeline for the vehicle. The consumer is a copy-adapted
pipeline, **not** the asset viewer.

This proves the packet is a drawable, per-tick seam. It is not an engine
integration, not a game, and not a claim of visual fidelity. **The vehicle motion
is a synthetic path, not physics.**

## What exists

| Path | Role |
| --- | --- |
| `schema/render-packet.v1.schema.json` | JSON Schema (2020-12) for packet 1.0 **and** 1.1 |
| `tools/packet-format.mjs` | canonical JSON, packet/tick hashes, structural conformance |
| `tools/packet-camera.mjs` | orbit/perspective/fit maths shared by producer and validator |
| `tools/build_packet.mjs` | producer: reader output + synthetic timeline → packet |
| `tools/validate_packet.mjs` | conformance, per-tick camera containment, bounds re-derivation |
| `tools/verify_render_packet.mjs` | build twice, determinism, timeline shape, schema drift |
| `tools/verify_tick_loop.mjs` | replays the scheduler probe's deltas through the browser driver |
| `tools/serve_packet.mjs` | loopback static server for `web/` and `_work/render-packet/` |
| `tools/capture_browser.mjs` | headless Edge + CDP: two held ticks, screenshots, console |
| `web/fixed-step.js` | fixed-step driver (1/60, 4-tick cap, pause rule) |
| `web/interpolate.js` | rigid-transform interpolation (quaternion slerp) |
| `web/packet-consumer.js` | WebGPU consumer, static geometry uploaded once |
| `web/app.js`, `web/index.html`, `web/style.css` | host page, HUD, URL options |

Generated output and evidence go to `_work/render-packet/` (ignored by Git);
process logs go to `_work/logs/render-packet/`.

## Version story

- **1.0** — one static frame: camera, lights, meshes, draws. The consumer still
  accepts a 1.0 packet and renders `draws[].world` as a single frame; the
  producer (`build_packet.mjs --ticks N`, default 120) emits 1.1.
- **1.1** — additive. Adds `nodes`, `updates`, `tickDurationSeconds`. Nothing in
  1.0 changes meaning; a 1.0 reader that ignores the three new members renders
  the reference frame, because `draws[].world`, `camera`, `tick` and `alpha`
  describe tick 0 and the validator enforces that they equal `updates[0]`.

A 1.1 packet without a timeline is rejected, and a 1.0 packet carrying timeline
members is rejected: the version bump has to mean something.

## Producer inputs

Both are existing, non-guessed outputs:

- `level_inspect.exe --instances-all game-data/Blur/levels/usa_la_river/level.levelrender _work/level-instances/instance-geometry.chunk _work/level-instances/instance-node.chunk 27 253`
  → 22 instances, 13,162 vertices, 10,308 triangles, world space, instance
  affine `g_mWorld` already baked into positions.
- `scene_inspect.exe _work/car-level-assets/corvette_c3_race.model.decoded`
  → 30,591 vertices, 36,193 triangles, 80 draws, object-local space.

Missing prerequisites fail loudly with the command that regenerates them.

## Commands

```powershell
# Packet gate: two builds, determinism, conformance, timeline assertions
node probes/render-packet/tools/verify_render_packet.mjs

# Fixed-step gate: browser driver vs the native scheduler probe, 10 scenarios
node probes/render-packet/tools/verify_tick_loop.mjs

# Browser gate: two held ticks, screenshots, instrumentation, console
node probes/render-packet/tools/capture_browser.mjs

# Just rebuild the packet
node probes/render-packet/tools/build_packet.mjs

# Conformance only
node probes/render-packet/tools/validate_packet.mjs _work/render-packet/packet.json

# Manual inspection
node probes/render-packet/tools/serve_packet.mjs   # http://127.0.0.1:8791/
#   /                    tick loop running, holds the last tick at the end
#   ?hold=90             advance to tick 90 and hold it
#   ?pinCamera=1         hold the tick-0 camera (evidence option)
#   ?focus=<meshId>      debug camera framed on one mesh
```

## Recorded result

| Item | Value |
| --- | --- |
| Packet | `_work/render-packet/packet.json` |
| Version | 1.1 |
| Packet hash | `sha256:c31ddb3fd57dd9a6a0413a377a53f286cb450d9d195c562ba8321d2bf613f84c` |
| Packet size | 3,099,828 bytes (canonical hashed body 2,577,062) |
| Draws | 102 (22 level static + 80 car moved) |
| Meshes | 2 |
| Vertices / triangles | 43,753 / 46,501 |
| Timeline | 120 ticks @ 60 Hz, `motion: "synthetic"` |
| Per-tick hashes | 120 unique, `b95ca216…930249` → `2658bf35…d89de2` |
| Determinism | two runs, identical file SHA-256 `0f1dad09…53d384f7` |
| Conformance | pass, including full camera containment at all 120 ticks |
| Tick-loop gate | 10/10 scheduler-probe scenarios match with zero tolerance |
| Browser | headless Edge, WebGPU, 1600×900, **console empty** |
| Geometry uploads | **2** at tick 0 and **2** at tick 90 (262 frames) |

Screenshots: `browser-tick-0.png`, `browser-tick-90.png`, plus
`browser-tick-0-car.png` / `browser-tick-90-car.png` crops centred on the body.

Evidence: `_work/render-packet/verify.json`, `packet.validation.json`,
`tick-loop.json`, `browser-evidence.json`, `packet.report.json`.

## Consumer behaviour

- Reads only packet members: `camera`, `lights`, `meshes`, `draws`, and for 1.1
  `nodes` + `updates`.
- Uploads each `inline-json` mesh **once** (2 uploads, 1,083,048 bytes) and never
  again. A frame writes per-draw uniforms (view-projection, world, albedo) and
  resubmits draw calls.
- Runs the fixed-step loop from `docs/work/analysis/t005-scheduler-design.md`
  §4.3: integer-microsecond accumulator, 1/60 tick, 4-tick cap, backlog drop,
  0.25 s pause rule. Interpolates between ticks with the leftover alpha.
- Interpolates rigid transforms by quaternion slerp and translation lerp. At
  alpha 0 the matrices are the packet's, byte for byte.
- Materials are not applied, so every draw uses a neutral albedo (`0.8`) under
  the packet's single directional light. This is a **declared diagnostic
  fallback**, never presented as a recovered material.

## Limits

- Packet 1.1 is JSON with inline geometry. It is a spike fixture: no wasm engine
  tick loop produced it.
- **Motion is synthetic.** The producer generates a 43.9 m straight run offset
  12 m into the open side of the prop row (9.7 m clearance from the real instance
  AABBs). There is no velocity integration, no collision, no physics and no
  gameplay state.
- Materials: identity only, no texture pixels. Lighting: one diagnostic
  directional light. No shadow, post-process, particle or effect pass.
- Interpolation requires rigid matrices; scale and shear are rejected by the
  validator and by the consumer.
- The sequence is finite and the consumer holds the last tick; it does not loop.
- Level blocks 26/32/31, higher LODs, damage states and wheels remain absent.
- Headless Edge is a proxy for the user's physical browser.
