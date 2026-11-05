# probes/e1-drive — drivable E1 slice (wasm vehicle physics → render packet → WebGPU)

The first **connector** between the two proven halves of E1:

- the wasm vehicle physics of `engine/harness/t005d-vehicle/` (the real
  RacingPhysics/Gravity integrator on `usa_la_river/Level.levelphysics`, T-007), and
- the dynamic render-packet consumer of `probes/render-packet/web/` (v1.1
  `nodes[]`/`updates[]`, fixed-step, interpolated, T-007/E1b).

The page now runs a **point-to-point sprint** on the measured covered segment of
the real River draw: a 3-2-1 countdown, a running timer, two checkpoints that must
be crossed in order, a finish gate before the drawn road ends, a results overlay
with a per-car best time in `localStorage`, `R` restart and a respawn at the last
checkpoint when the car leaves the surface. It is still one car and one measured
segment, **not a lap**; the rules are presentation/bookkeeping only and do not
change the physics (the verifier replays every scripted sprint's input sequence
into a fresh module and gets identical state hashes).

`?telemetry=1&car=<slug>` runs a deterministic **telemetry mode** instead: three
scripted manoeuvres (standing start, 80 km/h brake, steering sweep), a metric
table and three 60 Hz traces in a panel, and a JSON report
(`_work/e1-drive/telemetry-<slug>.json`). It is a diagnostic validation, not a
retail-fidelity claim.

The car is drawn from each car's own committed part manifest
(`probes/car-parts/`): the Corvette ZR1 has **34 parts / 100 draws**, the Lotus
Exige Cup260 **23 / 88**, the Dodge Challenger **31 / 104**, the Ford Focus RS
**31 / 115** and the Audi R8 V10 **29 / 84**, each with **four wheel groups**
whose tyre/rim/brake-disc members spin about the proven element-local `+X` axis
using that car's physics wheel angular velocity. Brake calipers stay static
(`VehicleActor.cpp:5198`). Materials remain diagnostic; per-part colours and the
wheel spin marker are debug aids, labelled in the packet diagnostics.

The car drives on the whole River collision mesh, but the **drawn** track is the
real River render geometry: the committed `level_inspect` direct draws
(block88/node283, 95 draws / 17,782 vertices / 9,343 triangles, plus the
drive-covering block56/node289 section) **plus the six measured sections of the
539.81 m River corridor**, merged into one labelled `river.track.visual` mesh
(394 draws / 96,494 vertices / 57,133 triangles). The diagnostic collision surface
is no longer drawn; it stays in the packet as hidden physics provenance
(`visible:false`). See `docs/work/verification/T-007-track-visual.md` for the two
original sections and `docs/work/verification/T-007-ledge-fix.md` for the corridor.

### The extended corridor is a survey, not a course

The 539.81 m corridor measured by `probes/track-coverage` is **drawn** and
**measured**, but it is **not a race course**: its measured centre line crosses a
50 m vertical collision face at **arc 57.82 m** (and again at 530.71 m), and the
faithful box chassis stops on the 6.4 cm section-join rise at **52.7-53.4 m**. The
playable sprint therefore stays the **29 m straight** on the same spawn, and the
corridor is reported as a survey:

- `?survey=1` labels the drawn corridor in the page (no gate, timer or result
  changes) and states the measured limit;
- `_work/e1-drive/corridor-survey.json` is the measured record (six-section
  totals, the four survey gates and their 61/61 coverage, the four path/face
  crossings with the engine's own solidity test, the section-join rise, the 31 %
  drop near the end and the three coverage gaps);
- `_work/e1-drive/corridor-survey.html` is the labelled survey page;
- `_work/e1-drive/corridor-probe*.json` is the per-car physical limit, measured by
  placing the car on the measured line and driving at it.

The survey, its limits and the rejected proxy fix are recorded in
`docs/work/verification/T-007-ledge-fix.md`.

Nothing in this directory is engine code and nothing here edits the probes it
reuses. The engine still runs the car; the packet still describes the frame; the
WebGPU backend still renders the packet.

```
keyboard / scripted input / sprint / telemetry / ?car=<slug>
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

Each car also has **its own visual body**: `probes/car-parts/tools/build_all_manifests.py`
maps the record name to `\models\vehicles\<lowercased name>.model`, decodes the
pak entry, and builds a part manifest from it. `_work/car-parts/cars/index.json`
is the mapping evidence; `build_geometry.mjs` pins every manifest SHA-256, so a
regenerated or hand-edited manifest is a hard failure. The five models are
distinct, and so are the five body mesh hashes.

| slug | body model | parts | draws |
| --- | --- | ---: | ---: |
| `corvette-zr1-stock` | `corvette_zr1_stock.model` | 34 | 100 |
| `lotus-exige-cup260-stock` | `lotus_exigecup260_stock.model` | 23 | 88 |
| `dodge-challenger-stock` | `dodge_challenger_stock.model` | 31 | 104 |
| `ford-focusrs-stock` | `ford_focusrs_stock.model` | 31 | 115 |
| `audi-r8v10-stock` | `audi_r8v10_stock.model` | 29 | 84 |

## Commands

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

# 0. one-time prerequisites (already produced by the T-007 gates)
& $node probes/render-packet/tools/build_packet.mjs
& $py   engine/verify_vehicle.py --skip-build        # objects + car.fields, no rebuild
& $py   probes/car-parts/tools/build_all_manifests.py # one real body per roster car (read-only input)

# 1. build the library module (185 reused T-005d objects + this slice's harness TU)
& $node probes/e1-drive/tools/build_module.mjs --force-objects

# 2. collision surface under the drive (physics provenance; kept hidden, not drawn)
& $py   probes/e1-drive/tools/extract_track.py

# 3. static geometry (level packet + real level_inspect track visual + 5 car bodies + hidden collision)
& $node probes/e1-drive/tools/build_geometry.mjs

# 4. decode the car roster (every RP_CarDynamics record + one field list per car)
& $py   probes/e1-drive/tools/car_roster.py            # --list prints all 62

# 4b. measured course line + extended corridor survey (survey only, not a course)
& $node probes/e1-drive/tools/build_course.mjs                    # writes course.json
& $node probes/e1-drive/tools/build_corridor_survey.mjs           # survey.json + survey.html
& $node probes/e1-drive/tools/corridor_probe.mjs                   # per-car physical limit

# 5. derive the sprint gates from the measured covered road (writes sprint.json)
& $node probes/e1-drive/tools/build_sprint.mjs

# 6. scripted drive of every roster car twice, sprint runs + respawn + layout
#    checks, telemetry series twice + input replay, 10 create/reset rebuilds per
#    car in one instance, one-instance telemetry and sprint restart, packet
#    validation and the extended-corridor survey/limit checks (514 checks)
& $node probes/e1-drive/tools/verify_e1_drive.mjs      # --car <slug> for one car

# 7. headless Edge/WebGPU screenshots + console gate
& $node probes/e1-drive/tools/capture_browser.mjs                  # drive captures
& $node probes/e1-drive/tools/capture_browser.mjs --mode sprint    # start/cp/finish per car
& $node probes/e1-drive/tools/capture_browser.mjs --mode survey    # ?survey=1 corridor label
& $node probes/e1-drive/tools/capture_browser.mjs --mode respawn   # respawn diagnostic
& $node probes/e1-drive/tools/capture_browser.mjs --mode telemetry # metric panel per car
& $node probes/e1-drive/tools/capture_browser.mjs --mode restart   # R on a finished sprint, 5 cars
& $node probes/e1-drive/tools/capture_browser.mjs --mode telemetry-restart # R in telemetry, no reload

# 8. one-instance rebuild reproduction (10+ create/reset cycles, exact trap + heap/pool log)
& $node probes/e1-drive/tools/repro_reset.mjs --cycles 10
& $node probes/e1-drive/tools/repro_reset.mjs --cycles 20 --mode reset
& $node probes/e1-drive/tools/build_module.mjs --debug            # symbol-map build for wasm stacks
& $node probes/e1-drive/tools/repro_reset.mjs --debug

# 9. deterministic soak session (headless Edge/WebGPU): 5 simulated minutes,
#    drive -> sprint -> telemetry, e1_reset rebuild at every segment; two runs
& $node probes/e1-drive/tools/soak_browser.mjs --minutes 5 --runs 2
& $node probes/e1-drive/tools/soak_browser.mjs --minutes 5 --runs 2 --ticks-per-frame 1  # one tick per rAF

# interactive
& $node probes/e1-drive/tools/serve.mjs            # http://127.0.0.1:8801/ (keyboard sprint)
& $node probes/e1-drive/tools/serve.mjs --port 8801  # /?script=sprint&car=audi-r8v10-stock
                                                     # /?telemetry=1&car=audi-r8v10-stock
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
| `e1_reset()` | rebuild scene + car and re-run the settle; `tick` goes back to 0. Rebuilds the same instance in place; the scene creates and destroys its own scheduler groups, so it can be called repeatedly (measured 10–20 times per instance, `T-007-reset-fix.md`). |
| `e1_set_input(throttle, brake, steer, handbrake)` | the next `e1_step` uses these `CarControls`. |
| `e1_step()` | exactly one `C_Scene::Simulate(1/60)` + `PhysicsTimer::UpdatePhysicsTimer()`. |
| `e1_get_state()` | JSON snapshot of this tick: position, the three body axes, velocity, angular velocity, ground-relative speed, four wheel records (contact, suspension, position, spin, surface, userData, ground normal), `finite`, `anyContact`, and the input actually applied. |
| `e1_info()` | car name, XT handle id, ground/start Y, dt, settle-tick count, current tick, reset count, `sizeof(CarDynamicsXt)`. |
| `e1_ground_probe(x, z)` | the same fill+trace the wheel uses, as JSON: hit, height, normal, cached triangle count. Used to prove the spawn instead of guessing it. |
| `e1_diag()` | diagnostic snapshot of the live world: scene/body/car pointers, the scene's scheduler group handle and policy, and the scheduler pool (size, free-list head, global counters, per-group queued/executing/dependencies/next/event). Used by `tools/repro_reset.mjs` and the verifier to prove rebuilds do not leak groups; not on the physics path. |
| `e1_last_error()` | the message behind a 0 return. |

Floats are printed with `%.9g` (round-trip exact for binary32). A non-finite
value is emitted as the string `"NaN"`/`"Inf"` and the tick's `finite` flag goes
0, so the JSON never becomes unparseable and a NaN can never hide.

Measured: build 1,004,335 B, deterministic across two links; `e1_create` including
the 180-tick settle takes 15–37 ms in node for the roster cars, 300 scripted ticks
take 24–34 ms. The library takes no per-car code path: the XT record alone decides
mass, inertia scales, geometry, suspension, steering, brakes, engine, gearbox,
tyres and drivetrain, and `e1_info().car` reports which record it decoded.

## Packet adapter

`web/packet-adapter.js` is shared by the browser and the node verifier, so the
packet the browser renders is produced by the same code the verifier validates.

- `draws[]`: 22 committed level instances (world-space, identity transform) + the **real
  River track visual** (144 `level_inspect` direct draws: 95 from block88/node283 and
  49 from block56/node289) + that car's own draw ranges (100 / 88 / 104 / 115 / 84).
  Every car draw carries its manifest `partId`/`partKind`, `wheelPart`, `spins`,
  `nodeId` and a labelled `diagnosticColour`. Every track draw keeps its source
  index range and is labelled `trackVisual:"asset-reader-direct-draws"`.
- `meshes[]`: exactly three — the level mesh, the real track visual (one merged
  mesh, 32,290 vertices / 19,167 triangles) and the selected car's own body mesh.
  One body per packet keeps the upload bounded (3 uploads, ~1.62–1.72 MB) instead
  of growing with the roster. The collision surface is **not** in `meshes`.
- `physicsSurfaces[]`: one hidden collision surface (`visible:false`,
  `physicsOnly:true`, 230 vertices / 381 triangles) carried for provenance only;
  it is not uploaded and not drawn.
- `nodes[]`: **nine** nodes — `e1.car.body` (all non-wheel parts) plus, per wheel
  corner, a `.spin` node (tyre/rim/brake disc) and a `.static` node (brake
  caliper). Each car draw is owned by exactly one node; static level/track draws
  need no node.
- `updates[]`: one entry per engine tick: the occlusion-resolved chase-orbit
  camera (with its per-tick request/hit record), the body matrix
  (three body axes as columns + position) and eight wheel matrices. The wheel
  matrix is `body × MdlDat rest translation × Rx(angle)`; the angle integrates
  `e1_get_state().wheels[].angular` at the fixed 1/60 s step. The caliper node is
  `body × rest` only. Every tick is hashed with the committed canonical form.
- `draws[].bounds` for the car are recomputed from the mesh's local AABB at the
  tick-0 pose, so the reference frame's bounds are real.
- `diagnostics.extras.track`: the real track visual label
  (`asset-reader-direct-draws`), 144 draws / 32,290 vertices / 19,167 triangles,
  both source sections (block88/node283 95/17,782/9,343 and block56/node289
  49/14,508/9,824) with their pinned reference SHA-256 values, and the measured
  collision coverage (67 covered / 314 no-draw triangles in the drive box).
- `diagnostics.extras.collisionSurface`: the hidden collision surface
  (`visible:false`, `physicsOnly:true`, 381 triangles) and where it came from.
- `diagnostics.extras.drive.car`: the car this timeline describes (name, record
  index/id, drivetrain, mass, field-file SHA-256) **and the real body it draws**
  (`bodyMesh`, `bodyManifest`, `bodyManifestSha256`, `bodyVertexCount`,
  `bodyDrawCount`, `bodyPartCount`, plus the model pak path and SHA-256).
- `diagnostics.extras.parts` / `.wheels`: part/draw/node counts, that car's
  manifest (path, SHA-256, model pak path, tyre proof tier, ambiguous wheel
  draws), the rest-pose/spin source and the diagnostic-colour label.
- `diagnostics.extras.wheels`: the four wheel corners spin about element-local
  `+X`; physics wheel records are assigned to the nearest manifest wheel
  translation in body-local space.

The camera is an orbit camera behind the car; yaw follows the car with a fixed
per-tick lag, so it is a pure function of the tick sequence (no wall clock). Its
distance is collision-limited: every tick casts the segment from the car's aim
point to the desired eye against the **visible static geometry** (level props +
real track visual, 29,475 triangles) and places the eye 0.4 m in front of the
first hit. Pull-in is immediate, push-out is eased by 0.08 of the gap per tick.
Each update carries `camera.occlusion { requestedDistance, distance, blocked,
nearField, hitDistance, hitMesh }`, and `diagnostics.extras.camera.occlusion`
states the rule, the occluder and the parameters. `?camdist`/`?camheight`/
`?camyaw` still change the requested orbit and are resolved the same way. The
hidden `physicsSurfaces` and the car body are not occluders, and a hit closer
than 3.4 m is a `nearField` prop crossing (the car is inside the prop) that the
camera holds instead of collapsing into the car.

## Sprint rules

The page is a **point-to-point sprint**, not a lap: the committed real track visual
covers a 29 m segment of the drive and no lap exists in this data. The gates are
derived from the geometry (`tools/build_sprint.mjs` → `_work/e1-drive/sprint.json`)
and re-derived by the verifier, so no coordinate is typed in:

| gate | x | width | coverage |
| --- | ---: | ---: | --- |
| start (spawn line) | −88.00 | 6 m (z 1047…1053) | 61/61 drawn + 61/61 collision samples |
| checkpoint 1 | −78.25 | 6 m | 61/61 + 61/61 |
| checkpoint 2 | −68.75 | 6 m | 61/61 + 61/61 |
| finish | −59.00 | 6 m | 61/61 + 61/61 |

Rule: a column is covered when every 0.1 m sample across the spawn corridor
(z = spawn z ± 3 m) has **both** a real `block56/node289` triangle over it and a
collision triangle under it. The fully covered segment runs from the spawn to
**x = −57.00**; the finish sits 2 m before that (`finishClearanceMetres`), so no
gate line has to leave the drawn road. The checkpoints are the 1/3 and 2/3 points
of that span, snapped to a 0.25 m grid. The layout hash is
`sha256:9e5b7befe60227ddf826ffa3fe5983e56ae091ac49e3cf1ad17005221da4f703`; the
verifier re-hashes the file, re-derives it from `geometry.json` and re-measures
every gate sample with independent barycentric code.

| rule | value |
| --- | --- |
| countdown | 90 ticks (1.5 s, labels 3 / 2 / 1), input held at zero; timer starts at GO |
| timer | engine ticks from GO at 60 Hz; keeps running across a respawn, freezes on the finish |
| gate order | checkpoints count only in index order; a finish before the last checkpoint is recorded as `finish-blocked` |
| respawn | chassis > 1 m below the measured spawn ground, 30 airborne ticks, or outside the gate corridor (±3 m + 1 m) |
| respawn target | last passed checkpoint (start line before the first) |
| best time | per car in `localStorage` key `e1-drive.sprint.best.v1`; only a faster finish overwrites |
| restart | `R` resets the engine, timeline, timer and gate progress; the best time is kept |

Modes: `/` = keyboard sprint, `?script=sprint` = deterministic scripted sprint
(throttle while running, brake after the finish), `?script=sprint&sprintfall=1` =
diagnostic driver that steers off the corridor to exercise respawn,
`?script=drive` = the original 300-tick drive with no rules (kept for the
P23/P31/P36 evidence), and `?survey=1` = the label for the drawn extended
corridor (below; it changes no gate, timer or result). Rules never touch physics:
the verifier records each scripted sprint's input sequence, replays it into a
fresh module with the rules switched off, and requires every state hash to match.

Measured scripted sprints (`_work/e1-drive/run.json` → `sprint.cars`):

| car | finish | tick | checkpoint 1 | checkpoint 2 | speed at finish | state sequence hash |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Corvette ZR1 | **2.800 s** | 258 | 1.683 s | 2.317 s | 22.35 m/s | `fdd893bd…e62622` |
| Lotus Exige Cup260 | **2.850 s** | 261 | 1.733 s | 2.350 s | 20.83 m/s | `c9b17397…b52dfc` |
| Dodge Challenger | **3.000 s** | 270 | 1.783 s | 2.450 s | 19.05 m/s | `438e2e12…e12684` |
| Ford Focus RS (FWD) | **3.267 s** | 286 | 1.967 s | 2.683 s | 18.70 m/s | `cc911ea3…2af937` |
| Audi R8 V10 (AWD) | **2.283 s** | 227 | 1.317 s | 1.850 s | 24.26 m/s | `d52d4b8f…44dea` |

Every car: 2/2 checkpoints in order, no respawn, wheel contact on every tick, 0
NaN, and a bit-identical replay with the rules off. The AWD Audi is fastest and
the FWD Focus slowest, as the drivetrain and the unchanged physics predict. A
real off-course run (steer off the corridor) respawns once at checkpoint 1 with
the timer still running (2.45 s → 4.45 s) and the checkpoint kept.

## Extended corridor survey (`?survey=1`)

The six measured corridor sections are drawn (394 real draws / 57,133 triangles in
one mesh) and the measured 539.81 m line, its four gates and their 61/61 coverage
are recorded in `_work/e1-drive/corridor-survey.json` — but the corridor is **not a
course**:

| measurement | value |
| --- | --- |
| measured corridor | 539.808 m, 2,257 samples at 0.25 m, 2,251 covered, 3 gaps (1.413 m) |
| six-section totals | 299 draws / 47,790 triangles / 78,712 vertices |
| survey gates | start 0.00 m, checkpoints 179.88 / 359.80 m, finish 537.69 m, all 61/61 covered |
| path/face crossings | 4 measured, 2 engine-confirmed solid (57.82 m and 530.71 m, both 50 m tall) |
| measured course limit | **57.82 m** — the measured line crosses a vertical collision face |
| section-join rise | 6.36 cm in 0.94 m (6.7 %) at 52.19 m |
| steepest local grade | −31.24 % at 534.23 m |
| per-car physical limit | the car stops at **52.7–53.4 m** (rise) and never reaches 56.5 m (pinch) |

Coverage (a draw within 0.5 m of the collision surface) does not test walls, width,
steps or slope: a 50 m cliff face is both drawn and collided, so its cells count as
covered and the measured Dijkstra line can run straight through it. `?survey=1`
labels exactly that; the playable sprint stays the 29 m straight.

## Telemetry (`?telemetry=1`)

Three deterministic manoeuvres per car, measured from the engine state and shown
as a metric table plus three 60 Hz traces. Inputs are functions of the tick only
(the brake step tick is measured in the accel run of the same series). All three
manoeuvres run in **one wasm instance**, rebuilt with `e1_reset()` between them
(one `e1_create` + two resets per series), and `R` re-runs the series in the same
instance without a page reload. See `T-007-reset-fix.md`.

| manoeuvre | input | measured |
| --- | --- | --- |
| `accel` | throttle on every tick, fixed 86 m window | 0–50 / 0–80 / 0–100 km/h, top speed, speed at 86 m |
| `brake` | throttle, then brake from the measured 80 km/h tick | entry speed, distance, peak/mean deceleration |
| `lateral` | 120 throttle ticks, then 4 square half-periods of 36 ticks at ±0.6 | peak lateral g, peak yaw rate, yaw lag per reversal |

Measured (`_work/e1-drive/telemetry.json`; one strip, diagnostic only):

| car | 0–50 | 0–100 | speed at 86 m | brake 80–0 | peak / mean decel | lateral peak | yaw peak | yaw response |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Audi R8 V10 (AWD) | 1.133 s | **2.650 s** | **135.2 km/h** | **13.34 m** | 24.77 / 15.46 m/s² | **1.52 g** | 22.7 °/s | 12.7 ticks |
| Corvette ZR1 | 1.817 s | 3.650 s | 126.5 km/h | 14.83 m | 20.80 / 15.13 m/s² | 0.86 g | 22.2 °/s | 15.3 ticks |
| Lotus Exige | 1.900 s | 3.833 s | 119.1 km/h | 17.00 m | 18.40 / 12.65 m/s² | 0.99 g | 22.7 °/s | 12.3 ticks |
| Dodge Challenger | 2.100 s | 4.633 s | 108.2 km/h | 17.07 m | 18.47 / 13.34 m/s² | 0.84 g | 19.0 °/s | 14.7 ticks |
| Ford Focus RS (FWD) | 2.400 s | 5.133 s | 107.1 km/h | 18.73 m | 16.59 / 11.76 m/s² | 1.32 g | 26.3 °/s | 13.3 ticks |

The 0–100 order (Audi < Corvette < Lotus < Dodge < Focus) is exactly the XT
`torqueScaleNm / mass` order; the AWD car is quickest and the FWD car slowest.
Stopping distances follow the same order, but the Lotus is an anomaly: highest XT
brake-to-mass ratio, third-shortest stop. Full comparison in
`docs/work/verification/T-007-telemetry.md`. Physics is unchanged: the verifier
pins all five drive and sprint state sequence hashes and all five drive packet
hashes, and the page recomputes the series itself and matches the node metrics
and per-tick state hashes exactly.

## Soak (`?soak=1`)

`?soak=1&soakSeconds=<n>&soakTicksPerFrame=<k>&car=<slug>` runs a deterministic
session endurance plan with no wall-clock input:

1. **drive** — the 300-tick scripted drive, then `e1_reset()` and a new packet timeline;
2. **sprint** — countdown, both checkpoints, finish, 120-tick brake tail, then `e1_reset()`;
3. **telemetry** — the three diagnostic manoeuvres, each after an `e1_reset()`;
4. repeat until `soakSeconds` of 1/60 s ticks have run.

Every segment after the first drive builds a new world (full level import +
180-tick settle) and reloads the packet's three meshes. The browser page (not the
engine) records one wall-clock frame interval and CPU work time per rendered frame,
one wasm-heap/scheduler/buffer sample per simulated second, the state sequence and
packet hash after every segment, and the telemetry metrics/trace hashes. `tools/soak_browser.mjs` runs the
plan twice in two fresh page instances, takes start/mid/end screenshots, and gates:

- 0 console messages of any kind;
- requested simulated tick budget reached (fixed 1/60 s ticks, deterministic
  sequence independent of frame pacing);
- no NaN/Inf state and no abort;
- wasm heap constant, scheduler pool head/group handles constant, GPU packet
  buffers bounded (created − destroyed = live = one packet's 8 buffers);
- exactly three mesh uploads per timeline load and one uniform write/draw set
  per frame;
- every complete drive/sprint segment reproduces the node verifier's state
  sequence hash and finish, every telemetry segment reproduces the node metrics
  and per-tick trace hashes, and the two soak runs have identical checkpoint
  hashes. Browser packet hashes may differ from Node in the documented
  `Math.atan2`/`Math.sin` last bit; state sequences are the exact gate.

The page's frame-time percentiles are measurements of this headless WebGPU loop.
Headless Edge is not vsync-limited and this is not a claim about the user's GPU,
display or retail frame rate. See `docs/work/verification/T-007-soak.md`.


`web/app.js` owns the loop: character-key input (WASD/arrows/space, R to restart),
the fixed-step driver, the engine step, the sprint rules, the adapter append, and
the render. It renders `tick - 1 + alpha` so interpolation between the two most
recent ticks is real, and holds an exact integer tick when `?hold=` is used for
screenshots. `web/sprint-rules.js` is the tick-driven rules state machine
(countdown, timer, gate order, finish, respawn), `web/sprint-layout.js` derives /
validates the gates, `web/sprint-best.js` is the `localStorage` best-time store,
and `web/sprint-script.js` holds the scripted sprint driver plus the off-course
respawn diagnostic. The page adds a countdown numeral, an event banner, a sprint
HUD block and a results overlay.
`web/cars.js` resolves `?car=<slug>` against the generated roster and fills the
page's car selector; `?car` defaults to the roster's recorded default, so the
original single-car links still work.

`web/packet-consumer.js` is a copy of the committed consumer with two additions:
`syncTimeline()`, which accepts ticks appended after `load()`, and a soak-only
buffer lifecycle (`releaseGeometry()` + `stats.packetLoads/buffersCreated/
buffersDestroyed`, invoked at every `load()`) so repeated timeline rebuilds cannot
grow GPU memory. The render/pipeline code is unchanged.

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

`_work/e1-drive/run.json` (all cars, including the camera ranges and
blocked/near-field counts), `state-<slug>.json`, `packet-<slug>.json`,
`sprint.json` (the derived layout), `sprint-<slug>.json` (per-car sprint ticks,
events, inputs and the start/checkpoint/finish capture updates),
`telemetry.json` (all cars' measured metrics, hashes and rank comparison),
`telemetry-<slug>.json` (full 60 Hz traces, metrics, hash aggregates and unit
definitions),
`geometry.json` (level packet + real track visual + one real body per car + hidden
collision), `cars.json` (the 62-record roster + gate), `reset-cycles.json`
(10 create/reset cycles per car in one instance with per-cycle hashes, heap and
scheduler pool, plus the one-instance telemetry and sprint-restart comparison),
`browser-evidence.json`,
`browser-evidence-sprint.json`, `browser-evidence-respawn.json`,
`browser-evidence-survey.json`,
`browser-<slug>-survey.png`,
`corridor-survey.json` + `corridor-survey.html` (the measured corridor survey),
`course.json`, `corridor-probe.json` + `corridor-probe-<slug>.json` (per-car
measured limit),
`browser-evidence-telemetry.json`, `browser-evidence-restart.json`,
`browser-evidence-telemetry-restart.json`, `browser-evidence-soak.json`,
`soak-run-{1,2}.json`, `browser-soak-run{1,2}-{start,mid,end}.png`,
`browser-<slug>-{start,mid,coast,end}.png`,
`browser-<slug>-sprint-{start,checkpoint,finish}.png`,
`browser-<slug>-sprint-restart-{before,countdown,finish}.png`,
`browser-<slug>-sprint-respawn.png`,
`browser-<slug>-telemetry.png` (+ `-car.png`),
`browser-<slug>-telemetry-restart-{before,after}.png`,
`browser-<slug>-wheels-240.png` (side view, wheel geometry),
`browser-evidence-wheels.json`; `packet.json`/`state_a.json` are the default
car's aliases. The track visual, its source sections and the coverage limit
are recorded in `docs/work/verification/T-007-track-visual.md`; the six-section
corridor, its survey, the measured course limit and the rejected proxy fix are
recorded in `docs/work/verification/T-007-ledge-fix.md`; the per-car
body/wheel integration is recorded in
`docs/work/verification/T-007-per-car-meshes.md`; the chase-camera occlusion
rule, the before/after frames and the near-field limit are recorded in
`docs/work/verification/T-007-camera-collision.md`; the sprint rules, gate
derivation and respawn are recorded in
`docs/work/verification/T-007-sprint-rules.md`; the telemetry manoeuvres,
per-car metrics and plausibility comparison are recorded in
`docs/work/verification/T-007-telemetry.md`; the rebuild-limit root cause, the
10-cycle/one-instance measurements and the restart evidence are recorded in
`docs/work/verification/T-007-reset-fix.md`; details and numbers:
`docs/work/analysis/e1-drive-slice.md` §10–17 and
`docs/work/verification/T-007-multi-car.md`.

## Limits (also carried in the packet's own diagnostics)

- **Diagnostic materials.** Identity albedo, one directional light, screen-space
  derivative normals; no texture pixels, shadows, post, particles. Paint and
  material parameters are not decoded.
- **One car at a time, selected at runtime.** No opponents, no traffic. Each
  physics car now draws **its own real body and wheels** from its own
  `root.pak` model (body mesh, parts, wheel groups per car; see the counts in
  the Cars section). The body is labelled with `bodyMesh`, `bodyMeshReason` and
  the manifest SHA-256.
- **Wheel corner identity is bounds evidence.** Symmetric wheel sets cannot be
  resolved by AABB alone: the ZR1 has 10 ambiguous wheel draws, the Lotus 12,
  the Dodge 16, the Focus 20 and the Audi 16. Those draws are still drawn and
  spun on their wheel node, but their `partKind` is `unclassified` and the
  pairing is `previewAssignment` — no corner label is claimed. The Audi tyre tier
  is `containment` because its element boxes are larger than the geometry.
- **The track visual is real River render geometry, but it does not cover the
  whole script.** It is built from the committed `level_inspect` direct draws:
  block88/node283 (95 draws / 17,782 vertices / 9,343 triangles, as instructed)
  and block56/node289 (49 / 14,508 / 9,824), merged with the six measured
  corridor sections (299 / 78,712 / 47,790; merged mesh 394 draws / 96,494
  vertices / 57,133 triangles). Measured fact: block88/node283
  bounds are `x 944…2478, z 2206…3237` and do **not** overlap the drive box
  (`x −120…−10, z 1010…1090`); block56/node289 does (its road y at the spawn is
  5.80685 vs the engine's 5.8074 ground probe). Measured for the sprint: the full
  6 m gate band is covered to `x = −57.00`, and along the recorded car line the
  last drawn ground is around `x = −48.5`; the tail of the 300-tick drive and the
  off-road area have no committed real draw, so no ground is drawn there. The HUD
  says `394 real draws · 57133 tri · no-draw 2088 tri · slab hidden`.
- **The extended corridor is a survey, not a course.** The measured line crosses
  two engine-confirmed 50 m vertical collision faces (arc 57.82 m and 530.71 m)
  and a cliff pinch at 55.7-59.7 m; every car stops at 52.66-53.37 m on the
  section-join rise and at 55.49-56.20 m at the pinch. `?survey=1` labels the drawn
  corridor; nothing about the playable 29 m sprint changes.
- **The collision surface is physics-only and hidden.** The wheels still trace
  `Level.levelphysics`, but the collision mesh is now carried in
  `packet.physicsSurfaces` with `visible:false`; it is not uploaded and not
  drawn. The diagnostic slab is therefore gone; only real draw geometry is
  rendered. Nearly edge-on real slabs still speckle (derivative normals at
  grazing angles).
- **Wheels use rest-pose placement and physics spin only.** The four wheel groups
  sit at their `MdlDat` element translations; tyre/rim/brake disc rotate about
  element-local `+X` by the integrated physics wheel angular velocity, and the
  caliper stays static. No suspension travel, steer or camber is applied because
  the state does not carry those per-wheel rotations.
- **Wheel spin is integrated, not read as an angle.** `e1_get_state()` reports
  `wheels[].angular` (rad/s); the adapter integrates it at 1/60 s starting from
  zero on the settled tick, so the angle is a pure function of the tick sequence.
- **The spin marker is diagnostic.** A local-angle band makes rotation visible on
  rotationally symmetric tyre/rim/disc geometry; it is not a material or texture.
- **Box gravity proxy and neutral surface scalars**, no XT physics handle — the
  T-005d labels, unchanged. The box is sized from the selected car's own XT
  geometry, so it differs per car.
- **The car mesh frame to chassis frame mapping is not recovered** (that is the
  model import), so each body is drawn directly in the engine body frame. The
  five bodies visibly fit the engine chassis at the spawn, but the retail
  mesh→body alignment offset is not proven.
- **The chase camera resolves occlusion, but only with one cast per tick.**
  The eye is pulled in front of the first hit against the visible static
  geometry (level props + real track visual); the hidden collision surface and
  the car body are not occluders, and nothing is swept between ticks (no
  continuous collision). Pull-in is immediate, push-out eased by 0.08/tick, so
  dense prop areas give a close rear view (resolved 3.02–9.31 m over a script;
  at the recorded tick 150 the blocked cars sit at 3.15 / 4.61 / 5.34 / 6.32 m).
  A hit closer than 3.4 m is a `nearField` prop crossing: the car is inside the
  prop (physics has no prop collision), the camera holds its distance, and the
  frame shows the prop — 26–36 ticks per car, recorded per tick, not hidden.
  The consumer's manual drag/zoom debug camera is not occlusion-checked;
  `?camdist/camheight/camyaw` are, change only the camera and never physics, and
  the default page never sets them.
- **The sprint is one measured segment, not a lap.** The committed real draws
  cover 29 m from the spawn to x = −57 (last fully covered column); the finish is
  at x = −59. There is no start/finish loop, no second sector, and the car cannot
  drive a lap on drawn ground. Gates are **rules geometry only**: no gate mesh is
  added to the render packet, so the gates appear in the HUD/banner, not as 3D
  objects. The checkpoints are 1/3 and 2/3 of the measured span.
- **Telemetry is a diagnostic validation on that same strip.** The standing start
  is 86 m, braking is from 80 km/h, and the lateral figure is a fixed-steer
  response, not a grip limit; "top speed" is the maximum inside the 86 m window.
  No Vmax run, 100–0 km/h stop, lap time or retail handling claim. All numbers
  come from the unchanged engine and are traceable to `telemetry-<slug>.json`.
- **One wasm instance can be rebuilt (fixed in P40).** A 3rd `e1_reset()` / 4th
  `e1_create()` used to abort because the `C_Scene` never created or set its
  scheduler group handles, so `Scheduler::Flush` indexed stale heap bytes. The
  scene now creates its two groups with `Scheduler::CreateGroup()`, installs them
  like `GameWorld.cpp:562-563`, and destroys them with the scene. Measured: 10
  create/reset cycles per car in one instance with identical state hashes,
  constant 256 MiB heap and a constant scheduler pool; six telemetry manoeuvres
  and the sprint restart also run in one instance. Root cause, measurements and
  remaining limits: `docs/work/verification/T-007-reset-fix.md`.
- **The rebuild is still a full rebuild.** Each `e1_reset()`/`e1_create()`
  re-imports the level and re-runs the 180-tick settle (15–37 ms), so a restart
  or respawn is a one-frame hitch; it is not a resumable hot reload. The
  scheduler pool has 16 slots and this library returns its two per world, so the
  free-list head does not move; a build that leaked groups would fail loudly in
  `CreateGroup`.
- **Respawn rebuilds the world at the last checkpoint.** That is the module's
  `e1_create` path (180-tick settle), so a respawn costs a one-frame hitch and the
  car restarts from rest at the gate; the attempt timer keeps running and the
  passed checkpoints are kept. The page's best time is per car and local to the
  browser (`localStorage`), not a server record.
- **One car, one block, no game.** No opponents, traffic, AI, race audio,
  multiplayer, culling or engine streaming, and no per-car handling claim. The
  sprint rules are this slice's own bookkeeping; they are not the retail race
  mode and carry no BPR/score/XP claim.
- **The soak is a session endurance proxy, not a retail frame-rate claim.** It
  runs deterministic fixed 1/60 s ticks; `?soakTicksPerFrame=` (default 1 on the
  page, 4 in the tool's fast path) controls how many ticks one animation frame
  advances. Frame times and JS heap are measured in headless Edge/WebGPU; the
  headless compositor is not vsync-limited, so the wall-clock intervals are not
  the user's display cadence. GPU buffer count is bounded by destroying the
  previous packet's buffers on every reload; the soak gate requires
  created − destroyed = live = 8 (three meshes + uniform + scene) at every
  checkpoint. Five simulated minutes = 18,000 ticks; a one-tick-per-frame run
  completed in ~70 s here because headless rAF is not throttled to 60 Hz.
- **Native parity** is blocked by the DirectX SDK, as recorded in
  `T-007-vehicle-physics.md`.
