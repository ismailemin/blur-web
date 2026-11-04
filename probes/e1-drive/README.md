# probes/e1-drive — drivable E1 slice (wasm vehicle physics → render packet → WebGPU)

The first **connector** between the two proven halves of E1:

- the wasm vehicle physics of `engine/harness/t005d-vehicle/` (the real
  RacingPhysics/Gravity integrator on `usa_la_river/Level.levelphysics`, T-007), and
- the dynamic render-packet consumer of `probes/render-packet/web/` (v1.1
  `nodes[]`/`updates[]`, fixed-step, interpolated, T-007/E1b).

Nothing in this directory is engine code and nothing here edits the probes it
reuses. The engine still runs the car; the packet still describes the frame; the
WebGPU backend still renders the packet.

```
keyboard / scripted input
        │  set_input(tick)
        ▼
wasm  e1_*  ── one C_Scene::Simulate(1/60) per tick ──►  JSON state
        │                                                   │
        │                                                   ▼
        │                                   web/packet-adapter.js: updates[] (camera + matrix)
        ▼                                                   │
web/fixed-step.js (1/60, 4-tick cap, pause rule)            ▼
        └────────────────────► web/packet-consumer.js (WebGPU, geometry uploaded once)
```

## Commands

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

# 0. one-time prerequisites (already produced by the T-007 gates)
& $node probes/render-packet/tools/build_packet.mjs
& $py   engine/verify_vehicle.py --skip-build        # objects + car.fields, no rebuild

# 1. build the library module (185 reused T-005d objects + this slice's harness TU)
& $node probes/e1-drive/tools/build_module.mjs --force-objects

# 2. collision surface under the drive (level physics → mesh, via the oracle parser)
& $py   probes/e1-drive/tools/extract_track.py

# 3. static geometry (committed packet meshes + level draws + collision surface)
& $node probes/e1-drive/tools/build_geometry.mjs

# 4. scripted drive twice in two module instances + packet + 30 checks
& $node probes/e1-drive/tools/verify_e1_drive.mjs

# 5. headless Edge/WebGPU screenshots at start / mid / end + console gate
& $node probes/e1-drive/tools/capture_browser.mjs

# interactive
& $node probes/e1-drive/tools/serve.mjs            # http://127.0.0.1:8801/
& $node probes/e1-drive/tools/serve.mjs --port 8801  # /?script=drive for the scripted run
```

Outputs go to `_work/e1-drive/` (module, geometry, track, packet, states,
screenshots, evidence) and `_work/logs/e1-drive/` (build/verify/Edge logs). None
of it is committed.

## The module API

`native/e1_drive_lib.cpp` compiles into the same 186-object closure as the T-005d
harness, with the batch harness replaced by a library ABI:

| export | meaning |
| --- | --- |
| `e1_create(level, levelLen, fields, fieldsLen, x, z, heading)` | decode/validate the car field list, load the level, build the scene, place the car at the ground-probed `(x,z)` with `heading`, run the 180-tick settle. Returns 1/0. |
| `e1_reset()` | rebuild scene + car and re-run the settle; `tick` goes back to 0. |
| `e1_set_input(throttle, brake, steer, handbrake)` | the next `e1_step` uses these `CarControls`. |
| `e1_step()` | exactly one `C_Scene::Simulate(1/60)` + `PhysicsTimer::UpdatePhysicsTimer()`. |
| `e1_get_state()` | JSON snapshot of this tick: position, the three body axes, velocity, angular velocity, ground-relative speed, four wheel records (contact, suspension, position, spin, surface, userData, ground normal), `finite`, `anyContact`, and the input actually applied. |
| `e1_info()` | car name, XT handle id, ground/start Y, dt, settle-tick count, current tick, reset count, `sizeof(CarDynamicsXt)`. |
| `e1_ground_probe(x, z)` | the same fill+trace the wheel uses, as JSON: hit, height, normal, cached triangle count. Used to prove the spawn instead of guessing it. |
| `e1_last_error()` | the message behind a 0 return. |

Floats are printed with `%.9g` (round-trip exact for binary32). A non-finite
value is emitted as the string `"NaN"`/`"Inf"` and the tick's `finite` flag goes
0, so the JSON never becomes unparseable and a NaN can never hide.

Measured: build 1,003,249 B, deterministic across two links; `e1_create` including
the 180-tick settle takes 5–16 ms in node, 300 scripted ticks take 24–32 ms.

## Packet adapter

`web/packet-adapter.js` is shared by the browser and the node verifier, so the
packet the browser renders is produced by the same code the verifier validates.

- `draws[]`: 22 committed level instances (world-space, identity transform) + the
  diagnostic River collision surface + 80 car draw ranges.
- `nodes[]`: one node, `e1.car.body`, moving all 80 car draws.
- `updates[]`: one entry per engine tick: the chase-orbit camera and the car's
  rigid matrix (three body axes as columns + position), hashed with the committed
  canonical form.
- `draws[].bounds` for the car are recomputed from the mesh's local AABB at the
  tick-0 pose, so the reference frame's bounds are real.

The camera is an orbit camera behind the car; yaw follows the car with a fixed
per-tick lag, so it is a pure function of the tick sequence (no wall clock).

## What the browser adds

`web/app.js` owns the loop: character-key input (WASD/arrows/space, R to reset),
the fixed-step driver, the engine step, the adapter append, and the render. It
renders `tick - 1 + alpha` so interpolation between the two most recent ticks is
real, and holds an exact integer tick when `?hold=` is used for screenshots.

`web/packet-consumer.js` is a copy of the committed consumer with one added
method, `syncTimeline()`, which accepts ticks appended after `load()`. No other
line changed.

`web/fixed-step.js` and `web/interpolate.js` are verbatim copies of the committed
modules; `web/packet-camera.mjs` is a verbatim copy of the producer/validator
camera maths so the per-tick orbit reconstruction agrees exactly.

## Scripted drive

`web/drive-script.js` — 300 ticks at 60 Hz: **120 throttle, 120 coast, 60 brake**,
input chosen by tick number, never by wall time. With the spawn at
`(-88, 1050)` facing +X, the measured result is 44.58 m of travel, 0.00 → 14.99 →
11.04 → 0.45 m/s, all four wheels in contact on every tick, no NaN.

## Evidence

`_work/e1-drive/run.json`, `packet.json`, `state_a.json`,
`browser-evidence.json`, `browser-{start,mid,end}.png`.
Details and numbers: `docs/work/analysis/e1-drive-slice.md`.

## Limits (also carried in the packet's own diagnostics)

- **Diagnostic materials.** Identity albedo, one directional light, screen-space
  derivative normals; no texture pixels, shadows, post, particles.
- **The collision surface is not retail render geometry.** The committed River
  draw set is props near the road; the road itself only exists as collision
  triangles, which are drawn here as a labelled diagnostic surface. Nearly
  edge-on slabs therefore speckle (derivative normals at grazing angles).
- **Wheels are not drawn.** No wheel mesh is in the committed car draw set; wheel
  contact/suspension/spin are in the state and the HUD only.
- **Box gravity proxy**, neutral grip/rolling/MI scales, no XT physics handle —
  the T-005d labels, unchanged.
- **The car mesh frame to chassis frame mapping is not recovered** (that is the
  model import), so the body is drawn directly in the engine body frame.
- **One car, one block, no game.** No audio, race rules, opponents, culling or
  engine streaming. The collision surface covers the run's box; driving past it
  leaves the drawn surface.
- **Native parity** is blocked by the DirectX SDK, as recorded in
  `T-007-vehicle-physics.md`.
