# E1 render packet v1.1 — per-tick contract, fixed-step consumer, evidence

**Status:** frozen for the E1 vertical slice (spike evidence, 5 November 2026)
**Scope:** the packet seam between an engine-side draw-list producer and a WebGPU
backend, with a per-tick update model and a fixed-step, interpolated consumer.
Implemented in `probes/render-packet/`. Not an engine integration.
**History:** extends the 1.0 contract recorded here on 4 November 2026; the 1.0
members are unchanged and remain the static subset of 1.1.
**Related:** `docs/work/analysis/e1-renderer-strategy.md`,
`docs/work/analysis/t005-scheduler-design.md`, `probes/render-packet/README.md`.

## What changed from 1.0

1.0 froze a single frame: camera, lights, meshes, draws, diagnostics. That proved
the packet was drawable but said nothing about how a frame becomes the *next*
frame — which is the whole reason E1 keeps the engine's draw-list front end.

1.1 answers that with the smallest additive change that works:

- geometry and draw ranges are **static** and uploaded once;
- a tick carries only the transforms that changed, addressed by `nodeId` or
  `drawId`;
- the camera and the interpolation alpha travel with each tick;
- every tick has its own hash, so a renderer regression can be bisected to a tick.

Nothing in 1.0 changed meaning. A 1.0 reader ignores `nodes`, `updates` and
`tickDurationSeconds` and renders tick 0, because `draws[].world`, `camera`,
`tick` and `alpha` are defined to be the reference frame and the validator
enforces that they equal `updates[0]`.

### Compatibility rules (enforced, not aspirational)

| Rule | Enforced by |
| --- | --- |
| `version` is `1` or `1.1`; anything else is refused | schema `enum`, `validatePacket`, consumer `load()` |
| 1.1 requires `nodes`, `updates`, `tickDurationSeconds` | schema `if/then`, validator |
| 1.0 must **not** carry those members | schema `else/not`, validator |
| `updates[0].tick/alpha/camera` equals the reference frame | validator |
| `draws[].world` equals each moved draw's tick-0 transform | validator |
| ticks are strictly increasing | validator |
| per-tick matrices are rigid | validator + consumer |
| per-tick hash matches its canonical body | validator |
| every draw AABB is inside the camera of **every** tick | validator (120 ticks × 102 draws × 8 corners) |

The last one is the reason the camera is carried per tick rather than once: with
a fixed camera and a moving object there is nothing to check. Rebuilding the clip
test for all 120 ticks costs ~98k transforms and is the strongest statement in
the file that the timeline is coherent, not just well-formed.

## Contract additions

### `nodes`

```json
"nodes": [{
  "id": "corvette.c3.race.body",
  "meshId": "corvette.c3.race.body",
  "drawIds": ["corvette.body.primitive0", "…80 ids…"],
  "reason": "single rigid vehicle body: every draw of this mesh shares one world transform in the source scene"
}]
```

A node is the unit a tick can move cheaply. Without it, one rigid body of 80
draws would repeat the same 16 floats 80 times per tick — 153,600 numbers across
the sequence. With it, the same information is 120 matrices.

A draw may be moved by at most one node; the validator rejects overlap. A draw
covered by neither a node nor a per-tick `drawId` entry is static and renders
from `draws[].world`.

### `updates`

```json
"updates": [{
  "tick": 0,
  "alpha": 0,
  "camera": { "mode": "orbit", "view": [16], "projection": [16], "position": [3],
              "target": [3], "up": [3], "near": 0.156, "far": 230.04,
              "verticalFovRadians": 0.785, "aspect": 1.7778,
              "matrixConvention": "column-major …",
              "orbit": { "yaw": 0.7, "pitch": 0.3, "distance": 78.0978 } },
  "matrices": [{ "nodeId": "corvette.c3.race.body", "world": [16] }],
  "hash": "sha256:…"
}]
```

- `alpha` is the producer's declared alpha for a tick-exact frame, which is 0.
  A live driver replaces it with its own scheduler alpha; this is stated in
  `diagnostics.sequence.alphaSource`.
- `orbit` exists so the consumer can interpolate camera motion. The validator
  rebuilds `view`/`projection` from `orbit` + the intrinsics and fails if they
  disagree by more than `1e-5`, so the matrices are not free-floating data.
- `matrices[]` entries carry exactly one of `nodeId` / `drawId`.

### Per-tick hash

`hashOf(update minus hash)` with the same canonical JSON as the packet hash.
120 ticks, 120 distinct hashes. Two producers runs produce the same 120 hashes;
the consumer reports the hash of the tick it rendered, so a screenshot is tied to
a specific packet tick rather than to "some frame".

### Rigid-transform requirement

Interpolation is only well defined if consecutive matrices differ by a rotation
and a translation. The contract therefore requires it rather than tolerating it:

- `web/interpolate.js` `isRigid()` checks orthonormal columns, determinant +1,
  `[0,0,0,1]` bottom row;
- the validator rejects a non-rigid tick matrix;
- the consumer refuses to load a packet containing one.

Interpolation is translation lerp + quaternion slerp, and returns the endpoint
matrix unchanged at `f = 0` and `f = 1`, so an integer-tick frame is the packet's
matrix bit for bit — no slow drift between packet and screen.

## Fixed-step loop

The consumer implements `docs/work/analysis/t005-scheduler-design.md` §4.3
exactly, in integer microseconds:

```
dt = now - last
if dt > 250 ms:  pause, accumulator = 0, consume nothing
else:            accumulator += dt
ticks = min(floor(accumulator / 16_666.66… µs), 4)
accumulator -= ticks × tick
alpha = clamp(accumulator / tick, 0, 1)
render(tick + alpha)
```

`web/fixed-step.js` is a line-by-line port of
`probes/scheduler-probe/src/fixed_step.cpp`, which is the project's reference
implementation (native + wasm + Python). The port is verified by replaying the
native probe's own recorded per-frame deltas through the browser module:

```
node probes/render-packet/tools/verify_tick_loop.mjs
```

All ten reference scenarios match with **zero tolerance** on every counter
(`totalTicks`, `totalRequestedTicks`, `maxTicksInFrame`, `cappedFrames`,
`pausedFrames`, `zeroTickFrames`, `rewindFrames`, `backlogDropFrames`,
`backlogDropTicks`, `finalAccUnits`, alpha numerator/denominator):

| Scenario | Frames | Ticks | Capped | Paused | Backlog drop |
| --- | ---: | ---: | ---: | ---: | ---: |
| hz144-600f | 600 | 249 | 0 | 0 | 0 |
| hz30-300f | 300 | 600 | 0 | 0 | 0 |
| hitch-250ms-400f | 400 | 169 | 1 | 0 | 1 |
| tabgap-5s-400f | 400 | 165 | 0 | 1 | 0 |
| jitter-8ms-500f | 500 | 239 | 0 | 0 | 0 |
| equal5s-600f / -150f / -100f | 600 / 150 / 100 | 300 / 300 / 300 | 0 | 0 | 0 |
| capboundary-15hz-75f | 75 | 275 | 25 | 0 | 0 |
| keepbacklog-200ms-5f (`dropBacklog:false`) | 5 | 20 | 5 | 0 | 0 |

The three `equal5s` rows are the frame-rate-independence property: the same 5 s
of wall time delivered as 600, 150 or 100 frames produces 300 ticks in all three
cases. The `capboundary` row is the 4-tick cap at 15 Hz; `tabgap` is the pause
rule; `hitch` is the post-cap backlog drop.

## Producer: the synthetic sequence

`build_packet.mjs` emits 120 ticks at 60 Hz (2 s). Everything about the motion is
labelled `motion: "synthetic"` in `diagnostics.sequence`, with
`motionReason: "parametric … no velocity integration, no collision, no physics
step and no engine tick ran"`, and repeated in `approximations` and `limits`.

| Element | Value | How it was chosen |
| --- | --- | --- |
| Anchor | `(-71.6507, 5.6734, 1050.3497)` | centre of the level draw bounds on XZ, at the level's lowest recorded Y |
| Path | straight run, 43.895 m | along the level's long axis (`bounds` diagonal in XZ) |
| Lateral offset | +12 m | first offset (4…32 m, both signs) whose sampled clearance from the real instance AABBs is ≥ 8 m |
| Measured clearance | 9.688 m | minimum point-to-AABB distance over the run |
| Heading | 0.9230 rad | aligned with the run direction |
| Camera | orbit, yaw 0.7 → 1.6, pitch 0.3, distance 78.098 m | yaw sweeps 0.9 rad over the sequence; distance is the max fit over sampled ticks so the level never leaves the frame |

The clearance search and the camera fit are arithmetic over the packet's own
geometry, not hand-tuned numbers, and they are re-derivable from the packet.
The anchor is a presentation choice — it is recorded in `placedObjects` with
`placement: "synthetic-path-start"` and in `diagnostics.sequence.path.anchor`
with `anchorName`, precisely because no engine spawn transform exists in scope.

The car sits at the level's lowest Y, so it does not float above the props; it is
still not a ground query, and there is no collision.

## Consumer: per-frame work

| Per tick | Per frame | Never |
| --- | --- | --- |
| 1 matrix (node) + 1 camera | 1 uniform buffer write (26,112 B) + 102 `drawIndexed` | any geometry upload |

Instrumentation counted in the consumer and asserted by the capture tool:

- `geometryUploads` — incremented only inside `load()`, once per mesh;
- `geometryUploadBytes` — 1,083,048 for the two meshes;
- `uniformWrites` — one per rendered frame;
- `drawsIssued` — must equal `frames × 102`;
- `movedScreen` — projected screen position/extent of the first moved draw,
  computed from the live matrices, used to aim the screenshot crop;
- `matrixChecksum` — FNV-1a over the float32 bits of the submitted world
  matrices;
- `tickHash` — the packet hash of the tick being rendered.

## Evidence

### Packet gate

```
node probes/render-packet/tools/verify_render_packet.mjs
```

| Item | Value |
| --- | --- |
| Packet | `_work/render-packet/packet.json` |
| Version | 1.1 |
| Packet hash | `sha256:c31ddb3fd57dd9a6a0413a377a53f286cb450d9d195c562ba8321d2bf613f84c` |
| File size | 3,099,828 bytes |
| Canonical hashed body | 2,577,062 bytes |
| Draws | 102 (22 static level + 80 moved car) |
| Vertices / triangles | 43,753 / 46,501 |
| Tick count / rate | 120 @ 60 Hz |
| Per-tick hashes | 120 unique, `b95ca216…930249` → `2658bf35…d89de2` |
| Determinism | run1 and run2 files both `sha256:0f1dad09…53d384f7`; identical JSON; identical 120 tick hashes |
| Conformance | pass — no errors; 120/120 ticks fully contained; stored draw bounds re-derived from geometry within `1e-4` |
| Travel | 43.895 m between tick 0 and tick 119 |
| Camera changes per tick | yes (`view` differs by > `1e-4` between tick 0 and 119) |

`_work/render-packet/verify.json`, `packet.validation.json`.

### Tick-loop gate

`_work/render-packet/tick-loop.json` — 10/10 scenarios, zero mismatches (table
above). The reference comes from
`_work/build/scheduler-probe-native/Release/scheduler_probe.exe`, regenerated on
each run.

### Browser gate

```
node probes/render-packet/tools/capture_browser.mjs
```

Headless Edge (`--headless=new --enable-unsafe-webgpu`) over CDP, 1600×900,
device scale 1. Two page loads, each running the real `requestAnimationFrame`
loop until the driver reaches the requested tick, then holding it.

| Run | URL | Tick | Frames | Geometry uploads | Draws issued | Console |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| A | `/?hold=0&pinCamera=1` | 0 | 42 | 2 | 4,284 | empty |
| B | `/?hold=90&pinCamera=1` | 90 | 262 | 2 | 26,724 | empty |

Recorded run of 5 November 2026. Frame counts vary between runs because they are
wall-clock driven; the tick numbers, upload counts, checksums, tick hashes and
screenshots do not. `_work/render-packet/browser-evidence.json` holds the run the
numbers above were taken from.

- **Geometry uploads do not grow with frames**: 2 in a 42-frame run and 2 in a
  262-frame run, 1,083,048 bytes both times. Per frame the consumer only wrote
  one uniform buffer and resubmitted 102 draw calls.
- **Transforms changed**: `matrixChecksum` `0xdf2aade5` → `0xacaf5ec5`; the
  projected position of `corvette.body.primitive0` moved **190.16 px**
  (873.1,396.7) → (1017.7,520.2) at 1600×900.
- **Tick hashes match the packet**: tick 0 = `b95ca216…930249`, tick 90 =
  `e7c2dbc4…28b82d`, both equal to `updates[tick].hash`.
- **Zero-tick frames are real**: run B executed 90 ticks over 262 frames — 127
  frames correctly ran no tick because the headless renderer is faster than
  60 Hz. The `zeroTickFrames` path is exercised in the live loop, not only in the
  driver tests.
- **Console: zero messages of any kind** — no errors, no warnings, no logs.
  `favicon.ico` is suppressed with an inline data URI.
- Adapter reported by the page: `nvidia / blackwell`.

Screenshots, all 1600×900:

| File | What it shows |
| --- | --- |
| `_work/render-packet/browser-tick-0.png` | tick 0, packet camera pinned to tick 0 |
| `_work/render-packet/browser-tick-90.png` | tick 90, same camera |
| `_work/render-packet/browser-tick-0-car.png` | 3× crop on the body at tick 0 |
| `_work/render-packet/browser-tick-90-car.png` | 3× crop on the body at tick 90 |

The camera is **pinned to the tick-0 camera** for both screenshots on purpose:
with an identical frame, the only difference between the two images is the
moving body, so "the car moved" is a claim the pictures support without also
having to argue about a camera sweep. The per-tick camera motion is evidenced
numerically instead (`the camera changes per tick` in the packet gate).

The level geometry, camera and 22 level draws are unchanged between the two
frames; the body's pixels are the difference. That is the static-geometry half of
the same statement.

## Limits

Recorded in the packet (`diagnostics.approximations`, `.notRecovered`, `.limits`)
and repeated here:

- **No physics, no engine.** The timeline is generated by a tool. `tick` counts
  are producer ticks, not engine simulation ticks. No velocity, gravity,
  collision, wheel or gameplay state exists.
- **No engine integration.** The producer calls `level_inspect.exe` and
  `scene_inspect.exe`; nothing in the wasm engine produced this packet.
- **Synthetic motion.** A straight run with a measured lateral offset. The
  clearance search keeps the body out of the level props, but this is a
  presentation path, not a racing line.
- **Diagnostic materials.** Identity only, no texture pixels, one directional
  light, screen-space derivative normals. No shadow, post, particles or effects.
- **Finite sequence.** 120 ticks; the consumer holds the last tick and does not
  loop.
- **Rigid transforms only.** Scale, shear and non-uniform transforms are refused
  rather than approximated.
- **Incomplete level.** Blocks 26/32/31, higher LODs, damage states and wheels
  remain absent, as in 1.0.
- Headless Edge is a proxy for the user's physical browser.

## What this does not claim

- Not a game, not a playable slice, not an engine tick loop.
- Not a physics or gameplay validation: the car does not drive, it is placed.
- Not visual fidelity: materials and lighting are explicit approximations.
- Not a full level: one geometry block's supported instances plus one body.

## Next steps this unblocks

1. Replace the producer's synthetic timeline with the engine's draw-list builder
   output, keeping the JSON contract, the per-tick hash and the consumer.
2. Add `storage: "engine-buffer"` so `meshes[]` can reference wasm memory instead
   of inlining geometry; `updates[]` does not change.
3. Carry camera and node transforms straight from the engine's interpolated
   render state (`WorldRender::Blur2PCInterp*`, `Cam2::I_Feed::SetRenderOffset`)
   instead of recomputing them from orbit parameters.
4. Extend the browser gate from "two held ticks" to a per-tick screenshot hash
   over the whole sequence, so the renderer regresses the same way the readers do.
