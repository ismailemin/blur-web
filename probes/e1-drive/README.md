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
keyboard / scripted input / ?car=<slug>
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

## Cars

**Five real cars** are selectable at runtime from the 62 `RP_CarDynamics`
records in `gamedata\xt\racingphysics.bin` (T-007/E1g):

| slug | record | id | drivetrain | mass | wheelbase |
| --- | ---: | ---: | --- | ---: | ---: |
| `corvette-zr1-stock` (default) | 37 | 1554942492 | RWD | 1600 kg | 2.652 m |
| `lotus-exige-cup260-stock` | 15 | 805568925 | RWD | 890 kg | 2.323 m |
| `dodge-challenger-stock` | 9 | 528964602 | RWD | 1700 kg | 2.981 m |
| `ford-focusrs-stock` | 50 | 2563977008 | FWD | 1400 kg | 2.787 m |
| `audi-r8v10-stock` | 55 | 2936683857 | AWD | 1600 kg | 2.635 m |

`cars/roster.json` is the committed selection (checked against the decoded
records: a wrong name/id/index is a hard failure). `tools/car_roster.py` decodes
**every** record with the T-005d extractor, gates it on the fields the physics
needs, and writes one `name<TAB>value` field list per selected car plus
`_work/e1-drive/cars.json` (all 62 records, their values and the gate result).
Nothing is invented: a record that failed the gate would be excluded with the
exact field and value, never patched.

Select at runtime with `?car=<slug>` in the page (there is also a car selector in
the page), or `--car <slug>` on the two node tools.

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

# 4. decode the car roster (every RP_CarDynamics record + one field list per car)
& $py   probes/e1-drive/tools/car_roster.py            # --list prints all 62

# 5. scripted drive of every roster car twice, in two module instances + packet + 164 checks
& $node probes/e1-drive/tools/verify_e1_drive.mjs      # --car <slug> for one car

# 6. headless Edge/WebGPU screenshots per car + console gate
& $node probes/e1-drive/tools/capture_browser.mjs      # --car <slug> for one car

# interactive
& $node probes/e1-drive/tools/serve.mjs            # http://127.0.0.1:8801/
& $node probes/e1-drive/tools/serve.mjs --port 8801  # /?script=drive&car=audi-r8v10-stock
```

Outputs go to `_work/e1-drive/` (module, geometry, track, roster, per-car packets
and states, screenshots, evidence) and `_work/logs/e1-drive/` (build/verify/Edge
logs). None of it is committed.

## The module API

`native/e1_drive_lib.cpp` compiles into the same 186-object closure as the T-005d
harness, with the batch harness replaced by a library ABI:

| export | meaning |
| --- | --- |
| `e1_create(level, levelLen, fields, fieldsLen, x, z, heading)` | decode/validate the car field list, load the level, build the scene, place the car at the ground-probed `(x,z)` with `heading`, run the 180-tick settle. Returns 1/0. **The field list is the car selector**: one `cars/<slug>.fields` per roster car, decoded from its `RP_CarDynamics` record. |
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
the 180-tick settle takes 15–37 ms in node for the roster cars, 300 scripted ticks
take 24–34 ms. The library takes no per-car code path: the XT record alone decides
mass, inertia scales, geometry, suspension, steering, brakes, engine, gearbox,
tyres and drivetrain, and `e1_info().car` reports which record it decoded.

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
- `diagnostics.extras.drive.car`: the car this timeline describes (name, record
  index/id, drivetrain, mass, field-file SHA-256) and the honest note that the
  drawn body is the committed Corvette C3 mesh for every car.

The camera is an orbit camera behind the car; yaw follows the car with a fixed
per-tick lag, so it is a pure function of the tick sequence (no wall clock).

## What the browser adds

`web/app.js` owns the loop: character-key input (WASD/arrows/space, R to reset),
the fixed-step driver, the engine step, the adapter append, and the render. It
renders `tick - 1 + alpha` so interpolation between the two most recent ticks is
real, and holds an exact integer tick when `?hold=` is used for screenshots.
`web/cars.js` resolves `?car=<slug>` against the generated roster and fills the
page's car selector; `?car` defaults to the roster's recorded default, so the
original single-car links still work.

`web/packet-consumer.js` is a copy of the committed consumer with one added
method, `syncTimeline()`, which accepts ticks appended after `load()`. No other
line changed.

`web/fixed-step.js` and `web/interpolate.js` are verbatim copies of the committed
modules; `web/packet-camera.mjs` is a verbatim copy of the producer/validator
camera maths so the per-tick orbit reconstruction agrees exactly.

## Scripted drive

`web/drive-script.js` — 300 ticks at 60 Hz: **120 throttle, 120 coast, 60 brake**,
input chosen by tick number, never by wall time. Same script, same spawn
`(-88, 1050)`, same level for every car; only the field list changes:

| car | travel | peak speed | t=120 | t=240 | t=300 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Corvette ZR1 | 45.38 m | 15.44 m/s | 14.99 | 11.04 | 0.45 |
| Lotus Exige Cup260 | 40.64 m | 15.08 m/s | 14.65 | 8.40 | 0.27 |
| Dodge Challenger | 41.04 m | 13.85 m/s | 13.35 | 10.06 | 0.22 |
| Ford Focus RS (FWD) | 30.66 m | 12.36 m/s | 11.66 | 5.87 | 1.34 |
| Audi R8 V10 (AWD) | 69.45 m | 21.54 m/s | 21.22 | 16.91 | 0.93 |

All five: **301/301 ticks with wheel contact**, **0 NaN**, distinct state
sequence hash, and the Corvette's sequence hash is exactly the T-007 value
(`83f76590…`), so the roster did not change the existing car.

## Evidence

`_work/e1-drive/run.json` (all cars), `state-<slug>.json`, `packet-<slug>.json`,
`cars.json` (the 62-record roster + gate), `browser-evidence.json`,
`browser-<slug>-{start,mid,coast,end}.png`; `packet.json`/`state_a.json` are the
default car's aliases. Details and numbers: `docs/work/analysis/e1-drive-slice.md`
§10 and `docs/work/verification/T-007-multi-car.md`.

## Limits (also carried in the packet's own diagnostics)

- **Diagnostic materials.** Identity albedo, one directional light, screen-space
  derivative normals; no texture pixels, shadows, post, particles.
- **One car at a time, selected at runtime.** No opponents, no traffic, no
  per-car body mesh: every physics car is drawn with the committed Corvette C3
  body (labelled `bodyMeshReason`), and wheels are not drawn.
- **The collision surface is not retail render geometry.** The committed River
  draw set is props near the road; the road itself only exists as collision
  triangles, which are drawn here as a labelled diagnostic surface. Nearly
  edge-on slabs therefore speckle (derivative normals at grazing angles). The
  selection box now covers the whole script for every car (`x −120…−10`,
  `381` triangles; it was `−120…−30` / `282` for the single-car slice).
- **Wheels are not drawn.** No wheel mesh is in the committed car draw set; wheel
  contact/suspension/spin are in the state and the HUD only.
- **Box gravity proxy and neutral surface scalars**, no XT physics handle — the
  T-005d labels, unchanged. The box is sized from the selected car's own XT
  geometry, so it differs per car.
- **The car mesh frame to chassis frame mapping is not recovered** (that is the
  model import), so the body is drawn directly in the engine body frame, and the
  same body mesh is used for every car.
- **The chase camera has no occlusion avoidance.** At tick 150 the slower cars
  are still among the start-area props, so their mid frame shows terrain; the
  coast/end frames show the car. The HUD and the state/packet comparison prove
  the simulation in every frame.
- **One car, one block, no game.** No audio, race rules, opponents, culling or
  engine streaming, no per-car handling/AI claims.
- **Native parity** is blocked by the DirectX SDK, as recorded in
  `T-007-vehicle-physics.md`.
