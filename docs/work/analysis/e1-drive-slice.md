# E1 drive slice — wasm vehicle physics → render packet v1.1 → WebGPU

**Date:** 5 November 2026
**Owner:** P21 (sub-agent)
**Scope:** connect the proven T-007 vehicle physics to the proven T-007/E1b
dynamic packet consumer. New directory `probes/e1-drive/` plus generated output
under `_work/e1-drive/`; this document. No change to `probes/render-packet/`,
`engine/harness/t005d-vehicle/`, engine patches, project sources, tools,
`upstream/` or `game-data/`.
**Result: a scripted 5 s drive on the River collision mesh, rendered by the
committed WebGPU packet consumer in headless Edge, with a clean console and a
deterministic state sequence.**

---

## 0. Summary

| | |
| --- | --- |
| module | `_work/e1-drive/module/e1_drive.{mjs,wasm}` — **1,003,249 B**, SHA-256 `7b977ea70994493c7a09a2c24227f8779e9082f09fa60a780d2f047ecff9dabc` |
| objects | **186** = 185 reused T-005d objects + 1 new harness TU (the T-005d `vehicle_harness.o` with its 32 MiB output buffer is the one object replaced) |
| API | `e1_create / e1_reset / e1_set_input / e1_step / e1_get_state / e1_info / e1_ground_probe / e1_last_error` |
| step | one `C_Scene::Simulate(1/60)` per tick, fixed; a 180-tick settle runs inside `e1_create`/`e1_reset` |
| spawn | `(-88.0, 1050.0)`, heading +X — ground probe hit at `y = 5.8074`, normal `(0.0029, 0.9990, 0)` |
| script | 120 throttle + 120 coast + 60 brake = 300 ticks (5 s) |
| result | **44.58 m** travelled, 0.00 → **14.99** → 11.04 → **0.45 m/s**, **301/301** ticks with wheel contact, **0 NaN** |
| determinism | two independent module instances: identical **301/301** state hashes, sequence hash `sha256:83f76590…008e1f` |
| packet | 301 ticks, 103 draws, **3,396,616 B**, hash `sha256:fa7e660b…d769c1`, 0 validation errors |
| browser | headless Edge/WebGPU, 1600×900, adapter `nvidia / blackwell`, **0 console messages**, 3 geometry uploads (1,088,544 B) on every run |
| screenshots | `_work/e1-drive/browser-{start,mid,end}.png` (+ `-car` crops) |
| multi-car (P23) | **5 cars** of 62 `RP_CarDynamics` records, selectable at runtime, 164/164 checks, 20 browser captures, 0 console messages — see **§10** (this section's numbers are the original single-car run; §10 records what the roster changed) |
| car parts + wheels (P28) | **29 parts / 80 draws**, **4 wheel groups** (8 wheel nodes), 202/202 checks, 20 browser captures, 0 console messages — see **§11** |
| per-car meshes (P29) | **5 of 5 roster cars** draw their own real body/wheels (100/88/104/115/84 draws, 34/23/31/31/29 parts), 214/214 checks, distinct body mesh hashes, 3 uploads per page, 0 console messages — see **§12** |
| real track visual (P31) | **144 real direct draws** (32,290 vertices / 19,167 triangles: block88/node283 95/17,782/9,343 + block56/node289 49/14,508/9,824), collision slab hidden as physics provenance, 231/231 checks, 20 captures, 0 console messages — see **§13** |
| camera collision (P36) | chase camera pulled in front of the first visible-geometry hit; **268/268 checks**, 5 state hashes unchanged, 20 captures + 1 near-field capture, 0 console messages — see **§14** |
| sprint rules (P37) | point-to-point sprint on the measured 29 m covered segment: **348/348 checks** (268 P36 + 80 sprint), 5 sprint times 2.283–3.267 s, 15 sprint captures + 1 respawn capture, 0 console messages, legacy drive hashes unchanged — see **§15** |

---

## 1. What was connected, and what had to be written

The two halves existed and were proven separately:

- `engine/harness/t005d-vehicle/` runs the real car, but through one batch entry
  point (`vehicle_run(level, fields, x, z, settleTicks, driveTicks, throttle, steer, dt)`)
  that dumps every tick of one fixed scenario into a 32 MiB buffer.
- `probes/render-packet/` consumes a **complete** v1.1 timeline that a tool built
  offline; it uploads geometry once and plays a finite sequence.

Neither can drive a live loop. The connector is:

1. **A library instead of a batch call** (`probes/e1-drive/native/e1_drive_lib.cpp`).
   Same 186-TU closure, same level import, same car decode, same settle — but the
   world is a persistent object that can be stepped one tick at a time, read, and
   rebuilt.
2. **A packet adapter** (`probes/e1-drive/web/packet-adapter.js`) that turns one
   engine state into one `updates[]` entry (rigid matrix + chase camera + tick
   hash). It is used by both the browser and the node verifier.
3. **A live page** (`probes/e1-drive/web/app.js`) with the committed fixed-step
   driver, keyboard input, a chase camera and the committed consumer.
4. **A track surface.** The committed River draw set (block27/node253) turns out
   to be props near the road, not the road; the surface the wheels trace only
   exists as collision triangles. A small extractor emits those triangles so the
   car is visibly on the surface it drives on (`probes/e1-drive/tools/extract_track.py`).

### 1.1 Three defects found while connecting (each measured, each fixed)

These are the reason the connector is not a copy-paste of the harness:

| symptom | cause | fix |
| --- | --- | --- |
| throttle produced **no force** at all (car crept only from the slope, then decelerated) | the decoded `CarDynamicsXt` was parsed into locals and then **copied** into the persistent world; its `XtArray` members still pointed at the (dead) local `CarBuffers` — the torque curve read garbage | parse straight into the persistent struct, exactly as the batch harness's function-scope locals did |
| wheels had contact for one tick, then the car **fell through** the road | `C_ImportSceneStaticInstance` was scoped around the settle loop only; the mesh bodies the wheel rays trace are owned by the instance | keep the static instance for the world's lifetime and release it before the scene |
| `e1_reset()` produced a sequence differing at the **1e-8 level** from a fresh run | `new Car()` reused heap bytes from the previous car; a member the constructor leaves alone leaked across resets | `calloc` + placement new, i.e. the same zeroed storage a `static Car` gets |

The third one is why the verifier can now claim reset determinism as well as
cross-instance determinism.

---

## 2. Module API and state

```c
int  e1_create(const char* level, int levelLen, const char* fields, int fieldsLen,
               float x, float z, float heading);
int  e1_reset(void);                                  /* rebuild + settle, tick = 0 */
void e1_set_input(float throttle, float brake, float steer, float handbrake);
int  e1_step(void);                                   /* one C_Scene::Simulate(1/60) */
const char* e1_get_state(void);                       /* JSON, this tick */
const char* e1_info(void);                            /* car, ground, dt, tick, resets */
const char* e1_ground_probe(float x, float z);        /* fill+trace at one point */
const char* e1_last_error(void);
```

`e1_get_state` carries `tick`, `dt`, `position`, `axisX/axisY/axisZ` (the engine's
body basis), `velocity`, `angular`, `speed` (ground-relative), `contacts[4]`,
`wheels[4]{onGround, suspension, position, angular, surface, userData, groundNormal}`,
`finite`, `anyContact`, `input[4]`. Numbers are `%.9g`; a non-finite value is the
JSON string `"NaN"`/`"Inf"` and `finite` goes 0, so a NaN can never corrupt the
JSON or hide.

Build:

```powershell
node probes/e1-drive/tools/build_module.mjs --force-objects
```

The 185 reused objects come from `_work/engine-vehicle-spike/out/obj_a/`,
produced by a `--fresh` run of `engine/verify_vehicle.py` and recorded in
`_work/logs/engine-vehicle-spike/verify-vehicle.json` (batch module 1,024,869 B,
SHA-256 `8015f063…eae81ce`, 186 objects, PASS). The compile flag set is
reproduced verbatim in `tools/build_module.mjs`, and `run.json` re-reads that
report so the provenance is part of this slice's evidence. Two links of the same
object list produce the same `.wasm` (`build.json`, `buildDeterministic: true`).

`sizeof(CarDynamicsXt)` is reported by `e1_info()` as 636, the T-005d value.

---

## 3. Geometry: what is drawn and where it came from

| mesh | source | vertices | triangles | space |
| --- | --- | ---: | ---: | --- |
| `river.block27.instances-all` | committed packet (`level_inspect.exe --instances-all`, 22 draws) | 13,162 | 10,308 | world |
| `car.<slug>.body` (one per roster car) | that car's `root.pak` `.model` through `scene_inspect.exe` (P29; §12) | 28,365–33,048 | 30,736–36,193 | object-local |
| `river.collision.surface` | `Level.levelphysics` (381 triangles in the run box) | 230 | 381 | world |

One packet carries the level, the selected car's body and the collision surface
(23 static + 84–115 car draws, `23 + carDraws` total). No colour, texture or
transform is invented:

- materials are the committed identity list (`pixelsIncluded: false`);
- the collision surface has `materialId: null` and a `materialReason` that says
  it is physics geometry with no material binding;
- the car's collision-surface triangle selection is recorded
  (`tool`, level SHA-256, box, kept/skipped counts, parser SHA-256).

The surface extractor reuses the **collision oracle's independent Python
reference parser** (`probes/collision-oracle/tests/reference_oracle.py`,
`load_level`) instead of re-deriving the format; the parser's own SHA-256 is
recorded in the output so the artifact is reproducible against that revision.
Selection rule: a triangle is kept when all three of its vertices are inside
`x −120…−30, y 0…20, z 1010…1090`. Result: 282 of the level's 44,244 triangles,
bounds `(-110.38, 5.55, 1010.08) … (-31.86, 10.97, 1089.64)`.

### 3.1 Why the road had to be added

The committed packet's level geometry is a 22-instance prop cluster: a shack,
wrecked cars, barriers. It is *near* the road but it is not the road. With only
that geometry the car drives on an invisible surface and floats in front of
distant props (this was observed: the first connected build rendered exactly
that). The collision triangles are the literal surface the wheel rays hit, so
drawing them is the honest way to show the car on its track — labelled as
diagnostic collision geometry, not as retail render geometry.

---

## 4. Scripted drive

`probes/e1-drive/web/drive-script.js`: input is a function of the tick number,
never of wall time, so a browser run and a node run execute the same sequence at
any frame rate.

| ticks | phase | input | tick-0…300 |
| --- | --- | --- | --- |
| 1–120 | throttle | (1, 0, 0, 0) | 2 s |
| 121–240 | coast | (0, 0, 0, 0) | 2 s |
| 241–300 | brake | (0, 1, 0, 0) | 1 s |

Measured (`_work/e1-drive/run.json`):

| tick | phase | position (x, y, z) | speed m/s | wheels |
| ---: | --- | --- | ---: | --- |
| 0 | settled | −87.99, 6.16, 1050.00 | 0.00 | 1111 |
| 60 | throttle | −85.03, 6.15, 1050.00 | 7.00 | 1111 |
| 120 | throttle | −73.79, 6.21, 1049.64 | 14.99 | 1111 |
| 150 | coast | −66.25, 6.17, 1049.38 | 14.53 | 1111 |
| 240 | coast | −47.09, 6.14, 1048.72 | 11.04 | 1111 |
| 300 | brake | −42.64, 6.13, 1048.58 | 0.45 | 1111 |

- 44.58 m travelled (44.58 m in XZ), peak 14.99 m/s (54 km/h), 1 s of brake from
  11.04 → 0.45 m/s (the Corvette's brakes at ~1 g).
- **301/301 ticks with at least one wheel on the ground**, **0 non-finite ticks**.
- The path drifts 1.4 m in Z over 44 m: the road is not exactly level (the
  ground normal is 0.9990 in Y), and the tyres follow it.
- `e1_create` including the 180-tick settle: 5–17 ms; the 300 scripted ticks:
  24–32 ms (node, wasm).

---

## 5. Determinism and hashes

Two runs, each in a **separate wasm module instance** (fresh `factory()` — no
shared state, no reset in between):

| | |
| --- | --- |
| state sequence hash (run A) | `sha256:83f765902ce5c610889e8a27e9bfe747f86142bddea24ecb987b29be29008e1f` |
| state sequence hash (run B) | identical |
| distinct tick state hashes | **301 of 301** |
| first / last state hash | `sha256:37e71370224cc460aa4e3d2eb447a7f63d41243aa1ca298be0b2f8d189d34828` → `sha256:afa0fd1735fd70e6eab17d4d7080c57da73c1cc5b523f4a4750589065180d960` |
| packet hash | `sha256:fa7e660bcd03f7a26e3b998a55ce1343faa634c48bd9520742505f79a1d769c1` (run B identical) |
| reset + replay of ticks 0–30 inside one instance | identical (after the zeroed-car fix) |

The sequence hash is SHA-256 over the newline-joined per-tick canonical state
hashes; the per-tick state hash is the committed `hashOf` (key-sorted canonical
JSON). Selected ticks:

| tick | state hash | packet tick hash |
| ---: | --- | --- |
| 0 | `37e71370…` | `5667980a…` |
| 60 | `96cb7399…` | `72999f5a…` |
| 120 | `bb122110…` | `37b4b19d…` |
| 150 | `81639926…` | `f9ac2656…` |
| 240 | `54be67e8…` | `8fad8e68…` |
| 300 | `afa0fd17…` | `103953bd…` |

All 301 rows are in `_work/e1-drive/state_a.json` (state hash) and
`_work/e1-drive/packet.json` (`updates[].hash`).

The browser uses a **synchronous SHA-256 + canonical JSON** copy
(`web/sha256.js`, `web/packet-hash.js`) because `crypto.subtle` is async and this
is a per-tick operation. The verifier's checks include "every tick hash the
browser-side implementation computes equals the committed Node definition", so
the two implementations are proven to agree on all 301 real payloads, not on a
toy vector. (The check set was 30 for the single car; it is 164 with the roster,
§10.)

---

## 6. Browser evidence

```powershell
node probes/e1-drive/tools/capture_browser.mjs
```

Headless Edge (`--headless=new --enable-unsafe-webgpu`), CDP, 1600×900, device
scale 1, page loaded at `/?script=drive&hold={0,150,300}`. Each load runs the real
`requestAnimationFrame` loop and holds the requested tick. Frame counts vary with
wall-clock speed; the table is the recorded run in
`_work/e1-drive/browser-evidence.json` — ticks, hashes, upload counts and
checksums do not vary.

| run | tick | phase | speed | frames | ticks | uploads | draws issued | console |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| start | 0 | throttle | 0.00 | 22 | 0 | 3 | 2,266 | empty |
| mid | 150 | coast | 14.53 | 363 | 149 | 3 | 37,389 | empty |
| end | 300 | brake | 0.45 | 741 | 299 | 3 | 76,323 | empty |

- **Geometry uploaded once per mesh, 3 uploads / 1,088,544 B in every run**, from
  22 to 741 frames. Per frame: one uniform write and 103 `drawIndexed`.
- **Console: 0 messages of any kind** (no errors, no warnings, no logs).
- The page's per-tick **state hash and packet hash equal the node producer's** for
  ticks 0, 150 and 300 — the browser ran the same simulation, not a replay.
- Matrix checksums `0x47f341a5 → 0xcd02c1e5 → 0xcbfc6065`; the car's projected
  screen box stays inside the frame at all three ticks (chase camera).
- The car travels 45.38 m between the start and end captures (world space).
- Adapter reported by the page: `nvidia / blackwell`.

Screenshots, 1600×900:

| file | what it shows |
| --- | --- |
| `_work/e1-drive/browser-start.png` | tick 0: settled car on the road, prop cluster and two wrecked cars ahead, embankment to the right |
| `_work/e1-drive/browser-mid.png` | tick 150: coasting at 52 km/h, the car has moved down the road, the embankment now on the right |
| `_work/e1-drive/browser-end.png` | tick 300: braked to 1.6 km/h, near the end of the extracted surface |
| `...-start-car.png`, `...-mid-car.png`, `...-end-car.png` | 2× crops on the body |

---

## 7. Reproduce

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $node probes/render-packet/tools/build_packet.mjs        # committed v1.1 packet (input)
& $py   engine/verify_vehicle.py --skip-build              # objects + car.fields
& $node probes/e1-drive/tools/build_module.mjs --force-objects
& $py   probes/e1-drive/tools/extract_track.py
& $node probes/e1-drive/tools/build_geometry.mjs
& $py   probes/e1-drive/tools/car_roster.py                 # 62 records -> 5 car field lists
& $node probes/e1-drive/tools/verify_e1_drive.mjs          # 164/164 checks (--car <slug> for one)
& $node probes/e1-drive/tools/capture_browser.mjs          # 20 screenshots, console gate
```

Artifacts:

| path | content |
| --- | --- |
| `_work/e1-drive/module/{e1_drive.mjs,e1_drive.wasm,build.json}` | module + build evidence (hashes, flags, object counts) |
| `_work/e1-drive/geometry.json` | 3 meshes, 23 static draws, 80 car draw ranges, materials, light, provenance |
| `_work/e1-drive/track.json` | 381 collision triangles + selection record (282 before §10) |
| `_work/e1-drive/cars.json`, `cars/<slug>.fields` | the 62-record roster, gate and per-car field lists |
| `_work/e1-drive/packet-<slug>.json`, `packet-validation-<slug>.json` | the validated 301-tick packet per car |
| `_work/e1-drive/state-<slug>.json` | all 301 per-tick states, positions, speeds, contacts, hashes (per car) |
| `_work/e1-drive/run.json` | the evidence document (module, roster, per-car drive, determinism, packets, 164 checks) |
| `_work/e1-drive/browser-evidence.json`, `browser-<slug>-*.png` | browser runs, console log, per-car screenshots |
| `_work/logs/e1-drive/` | build, verify and Edge logs |

---

## 8. Limits (carried in the packet's own `diagnostics`)

> **Superseded for the visual surface by §13 (P31).** The collision slab is no
> longer drawn: the real River direct-draw track visual is drawn instead and the
> collision mesh is hidden physics provenance. The material, camera, wheel and
> one-car limits below still apply.

- **Diagnostic materials.** Identity albedo, one directional light,
  screen-space-derivative face normals. No texture pixels, shadow, post,
  particles or effects. No claim of visual fidelity.
- **The road is collision geometry, not retail render geometry.** It is drawn
  with the same diagnostic albedo and is labelled (`materialId: null`,
  `diagnostics.extras.track`). Nearly edge-on slabs speckle because derivative
  normals are unstable at grazing angles — visible as the noisy band in the mid
  screenshot.
- **Wheels are not drawn.** ~~The committed car draw set has body draws only;
  wheel contact, suspension, spin and position are in the state and the HUD.~~
  **Superseded by §11**: the manifest exposes 20 wheel draws, four wheel groups
  are drawn and tyre/rim/disc spin from the physics angular velocity.
- **Box gravity proxy, neutral surface scalars, unresolved XT physics handle** —
  the T-005d labels, unchanged (`carBodyShape: box-from-XT-geometry`,
  `surfaceMappingsApplied: false`, `physicsParametersResolved: false`).
- **Car mesh frame alignment is not recovered.** The body is drawn in the engine
  body frame; the retail mesh import that defines the offset is out of scope, so
  the body can be rotated/offset relative to the chassis.
- **The drawn surface is a box, not the track.** 381 triangles around the script
  for every car (§10 widened it from 282); driving far enough still leaves the
  drawn surface even though the physics has collision geometry.
- **One car at a time, no game.** No audio, opponents, race rules, HUD beyond
  diagnostics, culling or engine streaming, and no per-car body mesh (every car is
  drawn with the committed Corvette body). One manual reset re-uploads geometry
  (the consumer's `load()` is re-run); the evidence path never resets.
- **Headless Edge is a proxy** for the user's physical browser.
- **Native-vs-wasm numeric parity remains blocked** by the DirectX SDK
  (`T-007-vehicle-physics.md` §7); this slice adds no new parity claim.

---

## 9. Next step

The seam now carries a real engine tick. The next smallest step is to replace the
spike geometry and the hand-rolled camera with engine output, one at a time:

1. **Engine draw list** — produce `draws[]` from the engine scene rather than the
   committed packet, keeping the same JSON contract and the adapter's per-tick
   updates; this is the E1 "scene traversal → packet" step and the thing the
   decision gate actually needs.
2. **Engine camera** — feed `Cam2::I_Feed::SetRenderOffset` / the interpolated
   render camera into `updates[].camera` so the chase camera stops being a
   presentation choice.
3. **Wheel meshes** — recover the wheel draws (or the composite body import) so
   the wheels can be drawn instead of only sampled. *Corvette part integration is
   done in §11; per-car meshes are still open.*
4. Then the acceptance gates of `e1-renderer-strategy.md` §"Decision gate": a
   finishable lap, unambiguous boundaries, 60 Hz with a clean console.

---

## 10. Multi-car roster — five real cars, selectable at runtime (T-007/E1g, P23)

**Date:** 5 November 2026
**Scope:** `probes/e1-drive/**` and `_work/e1-drive/**` only. No C++ change, no
engine patch, no renderer change, no new physics, no race rules/audio/multiplayer.

### 10.1 The data: 62 records, one decoder, one gate

`gamedata\xt\racingphysics.bin` (73,420 B, SHA-256 `048ef93a4dc94351…`, decoded
from `gamedata.pak`) holds **62 `RP_CarDynamics` records** (type size 632 B). They
are decoded by the *same* extractor that produced the verified T-005d
`car.fields` (`engine/harness/t005d-vehicle/car_xt.py`, SHA-256 `9f216c72…`); no
layout is re-derived. `probes/e1-drive/tools/car_roster.py` enumerates every
record and applies one **completeness gate** to the decoded values:

| gate | rule |
| --- | --- |
| positive scalars | `mass.mass`, `geometry.wheelBase`, `trackWidthFront/Rear`, both tyre radii, `engine.limiterRPM`, torque `x1`/`yScale`, `gears.gearRatios[0]`, `gears.finalRatio`, `brakes.frontBrakeForce`, `brakes.rearBrakeForce` must be finite and `> 0` |
| array length | `gears.gearRatios ≥ 2`, `engineTorque_Rpm.dataPoints ≥ 2`, front/rear `grip.data ≥ 2` |
| consistency | `1 ≤ gears.topGear ≤ len(gearRatios)`; `transmission.driveType ∈ {0,1,2}` (RWD/FWD/AWD) |
| finite | every decoded `f32` must be finite |

**Result: 62 of 62 records pass.** No record in this file is structurally
incomplete, so nothing had to be excluded — the roster is a *scenario* selection,
not a salvage operation. Two fields are `0.0` in **all 62** records
(`gears.reverseGearRatio`, tyre `loadDependence`); they are carried unchanged from
the data (the verified Corvette has the same values) and the scripted drive never
selects reverse, so this slice makes no claim about them. Full per-record table:
`_work/e1-drive/cars.json` (`records[]`, with `problems: []` for every row).

The committed selection (`probes/e1-drive/cars/roster.json`) is checked against
the decoded data by name, record id **and** record index; a mismatch fails the
tool. Five cars, chosen for one baseline plus one car per drivetrain:

| slug | record | id | layout | mass | wheelbase | track F/R | tyre | gears | limiter |
| --- | ---: | ---: | --- | ---: | ---: | --- | ---: | ---: | ---: |
| `corvette-zr1-stock` *(default)* | 37 | 1554942492 | RWD | 1600 kg | 2.652 m | 1.656/1.637 | 0.356 | 6 | 7250 |
| `lotus-exige-cup260-stock` | 15 | 805568925 | RWD | 890 kg | 2.323 m | 1.424/1.540 | 0.326 | 6 | 8000 |
| `dodge-challenger-stock` | 9 | 528964602 | RWD | 1700 kg | 2.981 m | 1.482/1.589 | 0.370 | 6 | 6000 |
| `ford-focusrs-stock` | 50 | 2563977008 | FWD | 1400 kg | 2.787 m | 1.608/1.618 | 0.326 | 6 | 7000 |
| `audi-r8v10-stock` | 55 | 2936683857 | AWD | 1600 kg | 2.635 m | 1.627/1.676 | 0.326 | 6 | 8200 |

Each car's field file (`_work/e1-drive/cars/<slug>.fields`, 181–185 lines) is the
record's own values; their SHA-256 is in `cars.json` and in `run.json`. The
default car's file is byte-identical to `_work/engine-vehicle-spike/car.fields`
(the T-005d artifact), which the tool asserts.

### 10.2 Where the selection lives

- **Module API:** unchanged. `e1_create` already took a field list, and every
  per-car decision (ride height, box extents, body mass, drivetrain) is read from
  `CarDynamicsXt`. The wasm is the **same 1,003,249 B module**, SHA-256
  `7b977ea7…9dabc`, 186 objects — no rebuild, no new object.
- **Page:** `?car=<slug>`, plus a `<select>` fed from the roster
  (`web/cars.js`). `?car` defaults to the roster default, so the old
  `/?script=drive` links still drive the Corvette.
- **Node:** `verify_e1_drive.mjs --car <slug>` and
  `capture_browser.mjs --car <slug>`; `--list` prints the roster.
- **Packet:** `diagnostics.extras.drive.car` names the car a timeline describes.

### 10.3 Same script, five different cars

Spawn `(-88, 1050)`, heading +X, same River collision mesh, same 300-tick script
(120 throttle / 120 coast / 60 brake). `verify_e1_drive.mjs`: **164/164 checks**.

| car | travel | peak | t=120 | t=240 | t=300 | contacts | NaN | state sequence hash | packet |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| Corvette ZR1 | 45.38 m | 15.44 | 14.99 | 11.04 | 0.45 | 301/301 | 0 | `83f76590…008e1f` | `b30b7e2b…f86c0f` |
| Lotus Exige Cup260 | 40.64 m | 15.08 | 14.65 | 8.40 | 0.27 | 301/301 | 0 | `8d6cd4d4…dac66c2` | `a1e25161…463fd3` |
| Dodge Challenger | 41.04 m | 13.85 | 13.35 | 10.06 | 0.22 | 301/301 | 0 | `b1c63d20…7220a7e2` | `5ac3d5c2…ab5c3c` |
| Ford Focus RS (FWD) | 30.66 m | 12.36 | 11.66 | 5.87 | 1.34 | 301/301 | 0 | `fb3909b6…c9bdb6` | `002fc2a2…e6f845` |
| Audi R8 V10 (AWD) | 69.45 m | 21.54 | 21.22 | 16.91 | 0.93 | 301/301 | 0 | `5b4ae49d…4fd4067` | `61063b60…a14732a` |

Every car: `e1_info().car` equals the roster name, tick 0 has all four wheels on
the ground at rest, no non-finite state in any tick, wheel contact on all 301
ticks, two independent module instances produce identical per-tick hash sequences,
reset+replay reproduces the first 30 ticks, and all 301 per-tick state hashes are
distinct.

**The Corvette did not change.** Its state sequence hash is exactly the T-007
value `sha256:83f76590…008e1f`, pinned as an anchor check in the verifier. The
roster adds cars around the existing one; it does not tune it.

The differences are the car, not the scenario, and they read the way the data
says they should:

- **AWD (Audi, 69.45 m, 21.5 m/s)** puts the torque of a 1600 kg car through four
  tyres: its peak is 6 m/s above every other car and its coast phase still exceeds
  16 m/s. (Every car peaks a few ticks after the throttle ends, 124–128, so the
  peak is not a throttle-phase endpoint.)
- **FWD (Focus RS, 30.66 m, 12.4 m/s)** is the slowest: 1400 kg on the front axle
  only, so it is traction-limited from the first tick and loses speed fastest in
  coast (5.87 m/s at t=240).
- **RWD:** the light Lotus and the heavy Challenger land either side of the
  Corvette. The 890 kg Lotus reaches nearly the Corvette's speed by t=120 (14.65
  vs 14.99 m/s) with less torque and then sheds it fastest off throttle (8.40),
  while the 1700 kg Challenger is slower to accelerate (13.35) and holds speed
  better (10.06). The FWD car is also the only one still moving at 1.34 m/s after
  the brake second; the rear-drive cars stop below 0.5 m/s.

### 10.4 Browser evidence (headless Edge + WebGPU)

20 captures (`0,150,240,300` for each of the five cars), 1600×900, adapter
`nvidia / blackwell`, **0 console messages of any kind**, **3 geometry uploads /
1,090,380 B in every capture** (geometry does not grow with frames), one uniform
write and one `drawIndexed` per draw per frame.

| car | tick 150 speed / position | tick 240 | tick 300 | screenshots |
| --- | --- | --- | --- | --- |
| Corvette | 14.53 m/s (−66.25, 1049.38) | 11.04 | 0.45 | `browser-corvette-zr1-stock-{start,mid,coast,end}.png` |
| Lotus | 13.72 m/s (−67.11, 1049.94) | 8.40 | 0.27 | `browser-lotus-exige-cup260-stock-*.png` |
| Dodge | 13.18 m/s (−68.50, 1049.33) | 10.06 | 0.22 | `browser-dodge-challenger-stock-*.png` |
| Focus RS | 11.04 m/s (−71.84, 1048.93) | 5.87 | 1.34 | `browser-ford-focusrs-stock-*.png` |
| Audi | 20.56 m/s (−54.86, 1048.65) | 16.91 | 0.93 | `browser-audi-r8v10-stock-*.png` |

Every capture's **state hash** equals the node producer's for the same car and
tick, every **car matrix is bit-identical** to the node producer's, and the page
reports and selects the requested car (`car` block + selector value).

**One honest, measured discrepancy.** For 18 of 20 captures the browser's
canonical *packet* hash equals node's; for two (Dodge tick 0, Focus RS tick 240)
it differs by one ulp in the camera, with camera max |Δ| = 2.3e-13 while the car
matrix is bit-identical. Cause, measured in both engines:
`Math.atan2(-0.999985695, -6.21325853e-8)` returns `-1.5707963889283709236` in
Node 24's V8 and `-1.570796388928370…7` in Edge 156's V8. The chase camera's yaw
comes from `atan2` of the car's forward axis, so an engine-level transcendental
difference shows up in the camera and therefore in the update hash. This is why
the capture gate checks the **state hash exactly, the car matrix exactly, and the
camera within 1e-6** instead of pretending the packet hash must always match; the
exact-match count is recorded in `browser-evidence.json`
(`packetHashAgreement`). It is a JS-engine difference, not a simulation one.

**Camera occlusion (pre-existing camera, not a physics result).** The chase camera
has no occlusion avoidance. At tick 150 the Focus RS, Dodge and Lotus are still in
the start-area props/berm, so their `-mid.png` frames show terrain rather than the
car (the HUD still shows car, speed and position). Their `-coast.png` (tick 240)
and `-end.png` frames show the car on the surface with 3 uploads and matching
hashes, so the extra tick exists to make the per-car visual evidence usable.

### 10.5 What the roster changed in the artifacts (and what it did not)

| artifact | before | now | why |
| --- | --- | --- | --- |
| wasm module | 1,003,249 B `7b977ea7…` | unchanged | no C++ change; the field list was already the car input |
| physics state hashes | Corvette `83f76590…` | unchanged | same data, same spawn, same script |
| packet hash (Corvette) | `fa7e660b…` | `b30b7e2b…` | the packet now records `extras.drive.car` (name, record, drivetrain, mass, field hash) |
| collision surface | 282 triangles, box `x −120…−30` | 381 triangles, box `x −120…−10` | the AWD car travels 69.45 m (to x = −18.6); the old box stopped at x = −31.9 and the car drove off the drawn surface at the end of the script |
| geometry mesh bytes | 1,088,544 B uploaded (282 surface triangles) | 1,090,380 B uploaded (381) | +99 triangles of the same collision mesh (same parser, same selection rule, bigger box) |

Both changes are additive and labelled; neither touches the simulation. The
Corvette's *state* sequence hash is the proof that the physics did not move.

### 10.6 Evidence

| path | content |
| --- | --- |
| `_work/e1-drive/cars.json` | 62 decoded records, gate result per record, the 5-car selection, per-car values + field hashes |
| `_work/e1-drive/cars/<slug>.fields` | one decoded `name<TAB>value` list per car |
| `_work/e1-drive/run.json` | 164 checks, per-car drive, determinism, packet (all five) |
| `_work/e1-drive/{state,packet,packet-validation}-<slug>.json` | per-car per-tick states and validated packets |
| `_work/e1-drive/browser-evidence.json` | 20 captures, console log, packet-hash agreement, per-capture comparison |
| `_work/e1-drive/browser-<slug>-*.png` | per-car screenshots (+ 2× car crops) |
| `docs/work/verification/T-007-multi-car.md` | the gate record |

---

## 11. Corvette parts + spinning wheels in the drive slice (T-007/E1i, P28)

**Date:** 5 November 2026
**Scope:** `probes/e1-drive/**` and `_work/e1-drive/**` only. The committed
`_work/car-parts/manifest.json` is read (never rebuilt or edited). Physics is
unchanged: the Corvette state sequence hash is still
`sha256:83f765902ce5c610889e8a27e9bfe747f86142bddea24ecb987b29be29008e1f`.

### 11.1 What changed

`tools/build_geometry.mjs` now reads the committed Corvette part manifest
(`sha256:24aa45f37cce2738b2f6b90bcd043aee736be6db8d7e2e855eb86048f7dbf602`,
29 parts / 80 draws / 4 wheel groups) and **refuses any other file**: that SHA-256
is pinned in the tool. It validates the manifest mesh counts and
mesh-value hashes against the packet's car mesh, matches every one of the 80
car draws by its exact index range, and embeds into `_work/e1-drive/geometry.json`:

- the 29 part records, 4 wheel groups, 9 car nodes and the manifest provenance;
- on each car draw: `partId`, `renderPartId`, `partKind`, `partName`,
  `wheelPart`, `spins`, `nodeId` and a labelled `diagnosticColour`.

`web/packet-adapter.js` keeps the same car transform and replaces the single
`e1.car.body` node with **nine** nodes:

| node | draws | per-tick transform |
| --- | ---: | --- |
| `e1.car.body` | 60 | `body` (engine position + three body axes) |
| `e1.car.wheel.<corner>.spin` ×4 | 16 | `body × wheelRest × Rx(angle)` |
| `e1.car.wheel.<corner>.static` ×4 | 4 | `body × wheelRest` (caliper) |

`wheelRest` is the `MdlDat` element translation from the manifest
(`e1_wheel_frontleft` etc.). The spin axis is element-local `+X`; the source is
`VehicleActor.cpp:5158-5197` (`wheelMatrix.AX()`), and the caliper is static per
line 5198 ("Brake calipers mustn't rotate").

`e1_get_state()` reports `wheels[].angular` (rad/s), not an angle. The adapter
integrates it at the fixed 1/60 s step, starting at 0 on the settled tick, and
assigns each physics wheel to the nearest manifest wheel translation in
body-local space. The angle is therefore a pure function of the state sequence;
two runs produce identical wheel matrices. No suspension, steer or camber is
applied.

The consumer (`web/packet-consumer.js`) uses `draw.diagnosticColour` when present
and a local-angle marker band when `draw.spins` is true. Both are labelled debug
aids; `materialsApplied` stays `false`.

### 11.2 Verification gate

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py   probes/car-parts/tools/build_manifest.py     # committed manifest input
& $node probes/e1-drive/tools/build_geometry.mjs
& $node probes/e1-drive/tools/verify_e1_drive.mjs
& $node probes/e1-drive/tools/capture_browser.mjs    # --port 8811 if 8801 is busy
```

- `_work/e1-drive/geometry.json` — **2,495,306 B**,
  SHA-256 `f25c9cd36dc8bc21ef5620749ad84862d05d77e02be560336bc49900ab233fd1`;
  `carParts:29`, `wheelGroups:4`, `carNodes:9`, body draws 60, wheel spin draws
  16, wheel caliper draws 4.
- `_work/e1-drive/run.json` — **PASS, 202/202 checks, 0 failures**. The 164
  pre-existing checks are unchanged; the 38 new checks cover the manifest
  provenance, draw coverage, nine nodes, nine matrices per tick, wheel-angle
  advance (>60% of tick steps > 0.001 rad), a wheel matrix that differs from
  tick 0 to 300, caliper angle ≈ 0, and a labelled diagnostic colour per car
  draw.
- All five cars: **301/301 wheel-contact ticks, 0 NaN**, distinct state
  sequences, run A = run B packet hash, and every per-tick matrix still rigid.
  The Corvette state sequence hash is the T-007 anchor `83f76590…`.

| car | packet B | packet hash | nodes | draws |
| --- | ---: | --- | ---: | ---: |
| Corvette ZR1 | 4,288,582 | `4e8eb90f…d63d2b74` | 9 | 103 |
| Lotus Exige Cup260 | 4,297,042 | `c97b1a6a…4b7eae97` | 9 | 103 |
| Dodge Challenger | 4,289,142 | `5c732e9e…28178e51` | 9 | 103 |
| Ford Focus RS | 4,287,489 | `81600e06…88013987` | 9 | 103 |
| Audi R8 V10 | 4,287,529 | `ec0c9abf…7bcbf614` | 9 | 103 |

The packet grew from ~3.4 MB to ~4.3 MB because each tick now carries nine
matrices instead of one. The packet hash necessarily changed from the P23 value;
the state hashes did not.

### 11.3 Browser evidence

`capture_browser.mjs` ran 20 captures (5 cars × ticks 0/150/240/300) at
1600×900, adapter `nvidia / blackwell`:

- **0 console messages** in every capture;
- **3 geometry uploads / 1,090,380 B** in every run, independent of frame count;
- every capture: `parts:29`, `carDraws:80`, `packetNodes:9`, `wheelNodes:8`,
  `render.matrices:9`, `drawsIssued = frames × 103`;
- wheel angles are 0 on the settled tick and grow with the script; Corvette
  front-left: **0 → 84.637 → 138.223 → 148.603 rad** at ticks 0/150/240/300
  (unwrapped); the other cars reach 69–218 rad by tick 300;
- per-tick car matrix is bit-identical to the node producer; the camera matches
  within 1e-6. **Packet hashes are byte-exact for 17/20 captures**; the other
  three differ only in the last `Math.atan2` bit (the documented Node-24 vs
  Edge-156 camera ulp caveat from §6), not in any physics value or matrix.

Screenshots (full list in `_work/e1-drive/browser-evidence.json`):

| file | what it shows |
| --- | --- |
| `_work/e1-drive/browser-corvette-zr1-stock-start.png` | tick 0, settled Corvette: 29-part body, cyan glass, yellow lights, rear tyre corner colours |
| `...-mid.png` | tick 150, 52 km/h: parts and rear wheels visible from the chase camera, HUD `29 parts · 80 draws · 9 nodes (8 wheel)` |
| `...-coast.png`, `...-end.png` | tick 240/300: wheel angles 138.2 / 148.6 rad |
| `browser-<slug>-*.png` | the same four ticks for all five roster cars |

![Corvette parts and wheels, mid-drive](../../../_work/e1-drive/browser-corvette-zr1-stock-mid.png)

*`_work/e1-drive/browser-corvette-zr1-stock-mid.png`: the real 29-part Corvette
with the rear wheel groups drawn; the chase camera is behind the car, so the rear
tyres are the visible wheels.*

### 11.4 Limits

- **Rest-pose wheel placement.** Wheel groups use their `MdlDat` element
  translations. No suspension travel, steering angle or camber is applied because
  the state does not carry those per-wheel rotations.
- **Corvette-only parts.** *Superseded by §12 (P29).* The manifest is
  Corvette-specific; the other four physics cars are still drawn with the
  Corvette body and wheels (`bodyMeshReason`). Per-car meshes are the next step.
- **Diagnostic materials and colours.** Per-part colours and the spin marker are
  debug aids, not game materials/textures; `materialsApplied:false`.
- **Spin is integrated, not read.** `wheels[].angular` is a rate; the adapter
  integrates it. A wheel with contact loss still uses the reported rate.
- **Four side-ambiguous wheel draws.** Front disc/caliper draws have identical
  left/right element bounds; their corner is the manifest's preview-only pairing,
  not a proof. The caliper is still kept static.
- **The chase camera hides the front wheels.** The rear wheel groups are visible;
  the front wheels are occluded by the body from behind. Wheel rotation is proven
  by the per-tick matrices and the HUD angles, and the marker band makes it
  visible where a tyre is not occluded.
- **32 shell draws remain group-proven** (`body.shell` 26, `interior.shell` 6),
  not leaf-panel named.

### 11.5 Next step

**Done in §12 (P29).** The per-car meshes were decoded with the same
reader/manifest path and the manifest is selected per `?car=`.

---

## 12. Per-car body and wheel meshes (T-007/E1j, P29)

**Date:** 5 November 2026
**Scope:** `probes/car-parts/**`, `probes/e1-drive/**`, `_work/car-parts/**`,
`_work/e1-drive/**`, `_work/logs/{car-parts,e1-drive}/**`, this document,
`docs/work/analysis/e1-car-parts.md` and
`docs/work/verification/T-007-per-car-meshes.md`. Physics is unchanged: the
Corvette state sequence hash is still `83f76590…`.

### 12.1 What changed

`probes/car-parts/tools/build_manifest.py` is now model-generic: it takes any
decoded PC model and produces the same manifest schema. `build_all_manifests.py`
maps every roster record to `\models\vehicles\<lowercased name>.model` (exactly
one match required), decodes it with the committed PAK index reader + packet-zlib
decoder, and builds one manifest/mesh per car under `_work/car-parts/cars/<slug>/`.

`probes/e1-drive/tools/build_geometry.mjs` reads
`_work/car-parts/cars/index.json` + the five manifest/mesh pairs, pins every
manifest SHA-256 and the index SHA-256, re-derives every draw AABB from the mesh
and emits geometry **v3**: `meshes[]` = [level, collision surface] and
`carBodies[slug]` = {mesh, parts, wheelGroups, nodes, draws, manifest}.

`web/packet-adapter.js` resolves the body from `options.car.slug`, so a packet
contains exactly one car mesh (3 uploads: level + that body + surface) and its
own parts/wheel nodes. `diagnostics.extras.drive.car` now records `bodyMesh`,
`bodyManifest`, `bodyManifestSha256`, `bodyVertexCount`, `bodyDrawCount`,
`bodyPartCount`, the model pak path and its SHA-256.

| car | model pak path | draws | parts | body mesh SHA-256 (positions) |
| --- | --- | ---: | ---: | --- |
| Corvette ZR1 | `\models\vehicles\corvette_zr1_stock.model` | 100 | 34 | `1319e2ac…d7fd2b` |
| Lotus Exige Cup260 | `\models\vehicles\lotus_exigecup260_stock.model` | 88 | 23 | `c5cc7937…75e1085` |
| Dodge Challenger | `\models\vehicles\dodge_challenger_stock.model` | 104 | 31 | `a430202d…21df9b8` |
| Ford Focus RS | `\models\vehicles\ford_focusrs_stock.model` | 115 | 31 | `8fc09c18…ae539e6` |
| Audi R8 V10 | `\models\vehicles\audi_r8v10_stock.model` | 84 | 29 | `0fce56a6…59d44f40` |

### 12.2 Verification gate

```powershell
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"

& $py   probes/car-parts/tools/build_all_manifests.py
& $py   probes/car-parts/tools/verify_manifest.py
& $node probes/e1-drive/tools/build_geometry.mjs
& $node probes/e1-drive/tools/verify_e1_drive.mjs
& $node probes/e1-drive/tools/capture_browser.mjs    # --port 8811 if 8801 is busy
```

- `_work/e1-drive/geometry.json` — **9,962,640 B**, SHA-256
  `37341b8db106c22b53e261fccffc746c1b1942ddbf209560841992e67ad34b08`, five
  bodies with distinct mesh hashes, 9 nodes / 20 wheel draws each.
- `_work/e1-drive/run.json` — **PASS, 214/214 checks, 0 failures** (202
  pre-existing + 12 per-car body checks).
- All five cars: **301/301 wheel-contact ticks, 0 NaN**, distinct state
  sequences and packets, run A = run B, every per-tick matrix rigid.
- Headless Edge: 20 captures + 5 wheel-view captures, **0 console messages**,
  3 geometry uploads per page (1.01–1.11 MB depending on the body), and the
  browser reports each car's own `bodyMesh`/manifest hash.

Details, screenshots and limits are in
`docs/work/verification/T-007-per-car-meshes.md` and
`docs/work/analysis/e1-car-parts.md` §4.7.

---

## 13. Real River track visual from level_inspect direct draws (T-007/E1k, P31)

**Date:** 5 November 2026
**Scope:** `probes/e1-drive/**`, `_work/e1-drive/**`, `_work/logs/e1-drive/**`,
this document and `docs/work/verification/T-007-track-visual.md`. No change to
`probes/asset-reader/`, `probes/render-packet/`, `probes/car-parts/`, the engine,
tools, `upstream/` or `game-data/`. Physics is unchanged: all five state sequence
hashes are exactly the P29 values (Corvette `83f76590…008e1f`).

### 13.1 What changed

The diagnostic collision slab is no longer drawn. `build_geometry.mjs` now reads
the committed `level_inspect` direct-draw references and emits geometry **v4**:

| section | source | vertices | triangles | draws | reference SHA-256 |
| --- | --- | ---: | ---: | ---: | --- |
| `river.block88.node283` | `_work/level-candidates/probes/00-usa_la_river-g88-n283/reference.json` | 17,782 | 9,343 | 95 | `e2a830f4…887b89` |
| `river.block56.node289` | `_work/level-candidates/probes/08-usa_la_river-g56-n289/reference.json` | 14,508 | 9,824 | 49 | `ac570f64…8dccaf` |
| **track visual (merged)** | one mesh, `river.track.visual` | **32,290** | **19,167** | **144** | both pinned above |

Both references are pinned by file SHA-256; the tool re-hashes the reference
positions/indices in Node and refuses a regenerated or hand-edited file. The two
sections are concatenated without transform or clipping: every source draw keeps
its `primitiveIndex`, `firstIndex`, `indexCount`, declared primitive offset,
topology and source buffers, with the merged-mesh offsets recorded. The Mesh and
draws are labelled `trackVisual:"asset-reader-direct-draws"`; materials stay
diagnostic (`materialId:null`, `materialsApplied:false`).

Why two sections: the instructed `block88/node283` set is **not under the drive**.
Its committed bounds are `x 944.037…2477.923, z 2205.934…3237.170`; the drive box
is `x −120…−10, z 1010…1090`, so zero of its 17,782 vertices overlap. It is
included verbatim, at its true source position, but cannot be the ground in a
chase frame. `block56/node289` is the committed direct-draw section whose bounds
cross the drive box; its road height at the spawn `(-88, 1050)` is **5.80685**,
within 0.0006 m of the engine's `e1_ground_probe` result **5.8074**. That is the
section visible under the car in the screenshots.

The full collision surface (230 vertices / 381 triangles) is kept as
`packet.physicsSurfaces[0]` with `visible:false` and `physicsOnly:true`. It is
**not** in `packet.meshes`, so the consumer neither uploads nor draws it. The
wheels still trace the whole `Level.levelphysics` mesh through wasm physics.

### 13.2 Coverage limit (measured, not hidden)

A collision triangle is counted as covered when its centroid is inside a
`block56/node289` triangle in XZ and its height is within 1.0 m of that triangle:

| collision triangles in the drive box | covered by real draws | no committed real draw |
| ---: | ---: | ---: |
| 381 | 67 | 314 |

The no-draw part is where the car leaves `block56/node289` near `x = −55` and in
the off-road area. No ground is drawn there (the collision slab is physics-only),
which is why the `coast`/`end` chase frames show the car against the background.
This is a scope limit of the committed direct-draw geometry, not a physics or
camera change. The HUD reports both counts in every frame.

### 13.3 Verification gate

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py   probes/e1-drive/tools/extract_track.py      # collision mesh input (unchanged)
& $node probes/e1-drive/tools/build_geometry.mjs     # geometry v4
& $node probes/e1-drive/tools/verify_e1_drive.mjs    # 231/231 checks
& $node probes/e1-drive/tools/capture_browser.mjs --port 8811   # 20 captures
```

- `_work/e1-drive/geometry.json` — **12,215,183 B**, SHA-256
  `dfb93f39301477ce6848ab946525dddd07365c4bf7d0ffebb1c6aaee9e3dc3a3`;
  `trackVisual.drawCount:144`, `vertexCount:32,290`, `triangleCount:19,167`.
- `_work/e1-drive/run.json` — **PASS, 231/231 checks** (214 P29 + 17 track
  checks). The five state sequence hashes are unchanged from P29:
  `83f76590…008e1f`, `8d6cd4d4…dac66c2`, `b1c63d20…7220a7e2`,
  `fb3909b6…c9bdb6`, `5b4ae49d…4fd4067`.
- Per-car packet (draws = 22 level props + 144 track + car; nodes = 9):

| car | draws | bytes | packet hash |
| --- | ---: | ---: | --- |
| Corvette ZR1 | 266 | 6,984,197 | `994a0a4b…83753e6` |
| Lotus Exige Cup260 | 254 | 6,940,535 | `dc7c6ff5…abefd89a` |
| Dodge Challenger | 270 | 6,719,038 | `96834cd9…b9c89d51` |
| Ford Focus RS | 281 | 6,880,669 | `e1580e57…348b314d` |
| Audi R8 V10 | 250 | 6,790,388 | `7c94f801…5ee3b4e5` |

- Headless Edge/WebGPU, 1600×900, adapter `nvidia / blackwell`, **20 captures**
  (5 cars × ticks 0/150/240/300): **0 console messages**, **3 geometry uploads**
  per page (1,623,888–1,716,240 B depending on the body), constant across frames,
  and `drawsIssued = frames × draws`. Every capture reports
  `trackVisual:"asset-reader-direct-draws"`, `trackDraws:144`,
  `trackTriangles:19,167`, `collisionVisible:false`. The browser state hash
  equals node's for every capture; the car matrix is bit-identical; the packet
  hash is byte-exact for 17/20 (the other three are the documented Node-24 vs
  Edge-156 `Math.atan2` camera ulp from §10.4, not a physics difference).

### 13.4 Evidence

| path | content |
| --- | --- |
| `_work/e1-drive/geometry.json` | geometry v4: level mesh, merged real track visual, per-car bodies, hidden collision |
| `_work/e1-drive/run.json` | 231 checks, per-car packets, track/collision counts |
| `_work/e1-drive/browser-evidence.json` | 20 captures, console log, packet-hash agreement, track fields |
| `_work/e1-drive/browser-<slug>-{start,mid,coast,end}.png` | per-car real-track frames |
| `docs/work/verification/T-007-track-visual.md` | the P31 gate record |

### 13.5 Limits

- **Two sections, not the whole track.** block88/node283 does not overlap the
  drive and block56/node289 ends near `x = −55`; the last ~12 m and the off-road
  area have no committed real draw, so no ground is drawn there.
- **Diagnostic materials.** The track keeps its source draw ranges but is shaded
  with the diagnostic albedo; no level material or texture is bound.
- **No visibility or culling.** All 144 direct draws are submitted; the far
  block88/node283 geometry is outside the chase view and is not culled.
- **Collision is physics-only.** The collision slab is hidden and not uploaded;
  it is retained in `packet.physicsSurfaces` only so the physics provenance is
  explicit.
- **One car, one loaded block, no game.** No race rules, audio, multiplayer,
  opponents or engine streaming claim.

---

## 14. Chase-camera collision against visible geometry (T-007/E1l, P36)

**Date:** 5 November 2026
**Scope:** `probes/e1-drive/**`, `_work/e1-drive/**`, `_work/logs/e1-drive/**`,
this document §14 and `docs/work/verification/T-007-camera-collision.md`. No
change to the engine, the module, `probes/render-packet/`, `probes/car-parts/`,
tools, `upstream/` or `game-data/`. All five state sequence hashes are exactly
the P31 values (Corvette `83f76590…008e1f`); only the packet camera changes.

### 14.1 The defect, measured

The P31 record (§13, and §10.4 before it) states that the chase camera has no
occlusion avoidance: at tick 150 the Focus RS, Dodge and Lotus are still among
the start-area props, so their mid frame shows terrain instead of the car.
Re-casting the unoccluded P31 camera against the scene reproduces it exactly:
the desired eye at 9.3145 m is behind `river.block27.instances-all` at
**4.040 m** (Focus), **6.918 m** (Dodge), **7.949 m** (Lotus) and **9.219 m**
(Corvette); the Audi is clear at tick 150.

### 14.2 What was added

`web/camera-occlusion.js` (new) builds a deterministic median-split triangle BVH
over `geometry.meshes` — the level props (10,308 triangles) and the real track
visual (19,167) — **29,475 triangles / 8,191 nodes**, cached per geometry object.
Only `coordinateSpace:'world'` meshes are accepted (a non-world mesh is a hard
error, not a silent skip). `packet.physicsSurfaces` and the car body are not
occluders: the collision surface is `visible:false` and undrawn, and the body
sits on the segment. The cast is a two-sided Möller–Trumbore segment test.

`ChaseCamera` keeps its parameters (`distance` 9.0, `height` 2.4, `lookHeight`
1.0, yaw smoothing 0.18, `?camdist`/`?camheight`/`?camyaw`) and adds:

- cast `target -> desired eye`; if hit, `distance = hit - 0.4 m` (hard floor
  0.05 m), **pull-in immediate** so the eye is never behind a resolvable surface;
- **push-out eased** by 0.08 of the gap per 1/60 s tick, so leaving a prop does
  not pop;
- if the first hit is closer than **3.4 m** the prop crosses the car itself
  (physics has no prop collision); the camera holds its distance and records
  `nearField:true` instead of collapsing into the car;
- `orbit.distance` is the distance used, so the committed validator still
  rebuilds view/projection from the declared orbit;
- every update carries `camera.occlusion { requestedDistance, distance, blocked,
  nearField, hitDistance, hitMesh, marginMetres, nearFieldMetres }`, and
  `extras.camera.occlusion` states the rule, the occluder and why the hidden
  surface is excluded.

The page HUD shows `camera <used> / <requested> · pulled from <hit> m hit`.

### 14.3 Verification

```powershell
& $node probes/e1-drive/tools/verify_e1_drive.mjs          # 268/268
& $node probes/e1-drive/tools/capture_browser.mjs --port 8811
```

`_work/e1-drive/run.json` — **PASS, 268/268 checks** (231 P31 + 37 camera).
Physics is unchanged: 301/301 contact ticks, 0 NaN, and the five state sequence
hashes are the P31 values. Packets changed as they must (each update now carries
the camera distance used and the occlusion record), are 6.82–7.09 MB, and keep
250–281 draws / 9 nodes.

| car | camera range | blocked | resolvable | near-field | resolved clear | packet hash |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Corvette ZR1 | 3.10–9.31 m | 55 | 23 | 32 | 269 | `9462fda8…` |
| Lotus Exige Cup260 | 3.04–9.31 m | 58 | 24 | 34 | 267 | `f2956330…` |
| Dodge Challenger | 3.02–9.31 m | 60 | 26 | 34 | 267 | `d866be00…` |
| Ford Focus RS | 3.07–9.31 m | 70 | 34 | 36 | 265 | `fa9e334d…` |
| Audi R8 V10 | 3.11–9.31 m | 44 | 18 | 26 | 275 | `4a9b3179…` |

The verifier re-casts the stored camera and the unoccluded P31 camera itself
(it does not trust the adapter's record), asserts the camera is clear on every
resolvable blocking tick, asserts the eye is in front of the first hit there,
asserts the four capture ticks 0/150/240/300 are fully clear with no near-field
exception, and pins the recorded tick-150 occlusion of the three cars the P31
record named. Geometry is untouched (`dfb93f39…`, 12,215,183 B).

### 14.4 Browser evidence

Headless Edge/WebGPU, 1600×900, **20 captures** (5 cars × 0/150/240/300) plus
one tick-129 near-field diagnostic: **0 console messages**, 3 uploads per page,
`drawsIssued = frames × draws`, state hash and car matrix equal to node,
camera within 1e-6, packet hash byte-exact for 17/20 (the same three `atan2`
last-bit cases as P31). At tick 150 the page eye is pulled to 6.32 m (Corvette),
5.34 m (Lotus), 4.61 m (Dodge), 3.15 m (Focus) of 9.315 m, and the mid frames
show the car. Exact before/after hashes and the preserved P31 frames are in
`T-007-camera-collision.md`.

### 14.5 Limits

- One cast per packet tick; no continuous collision, nothing swept between ticks.
- Hidden physics geometry is not an occluder; only drawn props and track visual.
- Near-field prop crossings (hit < 3.4 m, 26–36 ticks per car) are labelled, not
  resolved: the car is inside the prop and the frame shows the prop.
- Pull-in is along the orbit ray, so dense props give a close rear view
  (per-car minimum 3.02–3.11 m; tick 150 is 3.15/4.61/5.34/6.32 m for
  Focus/Dodge/Lotus/Corvette); there is no "rise over the obstacle" behaviour.
- The consumer's manual drag/zoom debug camera is unchanged and not
  occlusion-checked; `?camdist`/`?camheight`/`?camyaw` are.
- Presentation camera only; still not the engine camera. No race rules, audio,
  multiplayer, opponents or streaming claim.

---

## 15. Point-to-point sprint: checkpoints, timer, finish, respawn (T-007/E1m, P37)

**Date:** 5 November 2026
**Scope:** `probes/e1-drive/**`, `_work/e1-drive/**`, `_work/logs/e1-drive/**`,
this section and `docs/work/verification/T-007-sprint-rules.md`. No change to the
engine, the wasm module, `probes/render-packet/`, `probes/car-parts/`, tools,
`upstream/` or `game-data/`. Physics is unchanged: the five 300-tick state
sequence hashes and packet hashes are exactly the P36 values.

### 15.1 The course is the measured draw, so it is a sprint

A lap is impossible in the committed data: the real River draws cover one segment
and the drawn ground under the driven line ends near `x = −48.5`. The sprint is
therefore point-to-point on the measured segment, and every gate is derived from
`geometry.json` (`tools/build_sprint.mjs` → `sprint.json`) rather than typed in:

- corridor = spawn z ± 3 m; a column is covered when every 0.1 m sample has both
  a real `river.block56.node289` triangle over it and a collision triangle under
  it;
- the fully covered band runs from the spawn to **x = −57.00** (125 columns at
  0.25 m, no gap); the finish is 2 m before it (**−59.00**) so no gate line leaves
  the drawn road;
- start at the spawn (**−88.00**), checkpoints at 1/3 and 2/3 of the 29 m span
  (**−78.25**, **−68.75**), all 6 m wide, all 61/61 drawn + 61/61 collision
  samples;
- the layout hash is `sha256:9e5b7bef…da4f703`; the verifier re-derives the
  layout, re-hashes the file and re-measures every sample with independent
  barycentric code.

### 15.2 Rules implemented (all presentation/bookkeeping)

`web/sprint-rules.js` is a pure tick state machine: 90-tick (1.5 s) 3-2-1
countdown with input held at zero and the car measured at rest; timer from GO at
60 Hz; checkpoints counted only in index order; finish only after both
checkpoints; `finish-blocked`/`gate-out-of-order` events recorded instead of
silently accepting them; respawn when the chassis is > 1 m below the measured
spawn ground, airborne for 30 ticks, or outside the gate corridor; respawn target
= last passed checkpoint; `R` restart clears timer and gates; best time per car in
`localStorage` (milliseconds, only faster finishes replace it).

The rules gate the *driver request*, not the engine: the scripted sprint records
its input sequence, and a fresh module replaying that sequence with the rules
switched off produces identical per-tick state hashes (379+ ticks per car). The
default page runs the keyboard sprint; `?script=sprint` runs the scripted
sprint; `?sprintfall=1` is the off-course respawn diagnostic; `?script=drive`
keeps the original 300-tick drive with no rules.

### 15.3 Verification

`_work/e1-drive/run.json` — **PASS, 348/348 checks** (268 P36 + 80 sprint). New
checks cover: layout derivation equality, independent gate coverage, covered-span
end, countdown rest, GO tick, timer monotonicity and freeze, ordered checkpoints,
finish gate/position/span, input gating (zero in countdown, brake after finish),
rules-off replay, sprint packet validity and script label, four rule unit tests,
the best-time store (including corrupt JSON and a throwing storage), and a real
off-course respawn (one event at tick 237, reason `outside-gate-band`, rebuilt at
checkpoint 1, timer 2.45 → 4.45 s, checkpoint kept, car drives on).

| car | finish | tick | CP1 | CP2 | speed at finish | sprint state sequence hash |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Corvette ZR1 | 2.800 s | 258 | 1.683 s | 2.317 s | 22.35 m/s | `fdd893bd…e62622` |
| Lotus Exige Cup260 | 2.850 s | 261 | 1.733 s | 2.350 s | 20.83 m/s | `c9b17397…b52dfc` |
| Dodge Challenger | 3.000 s | 270 | 1.783 s | 2.450 s | 19.05 m/s | `438e2e12…e12684` |
| Ford Focus RS (FWD) | 3.267 s | 286 | 1.967 s | 2.683 s | 18.70 m/s | `cc911ea3…2af937` |
| Audi R8 V10 (AWD) | 2.283 s | 227 | 1.317 s | 1.850 s | 24.26 m/s | `d52d4b8f…44dea` |

Every car: two ordered checkpoints, no respawn, contact on every tick, 0 NaN, and
a bit-identical rules-off replay. The AWD car is fastest and the FWD car slowest,
as the unchanged physics predicts.

Legacy mode is untouched: the 300-tick state hashes are the P36 anchors
(Corvette `sha256:83f76590…008e1f`) and the five drive packet hashes are the P36
values (`9462fda8…`, `f2956330…`, `d866be00…`, `fa9e334d…`, `4a9b3179…`). The
adapter gained only an optional diagnostics `script` label; its default string is
the old one, so no legacy packet byte moved.

### 15.4 Browser evidence

15 headless Edge/WebGPU sprint captures (5 cars × start / checkpoint / finish)
plus one respawn capture: **0 console messages**, 3 geometry uploads per page at
the expected byte count, `drawsIssued = frames × draws`, 9 matrices per tick,
browser state hash equal to node for every capture, car matrix bit-identical,
every matrix within 1e-12, camera within 1e-6. At the finish the results overlay
shows the time and car and the best time is in `localStorage`. Packet hashes are
byte-exact for **12/15**; the three exceptions are one `atan2` camera ulp (Dodge
start, camera 2.3e-13) and two `sin/cos` wheel-matrix ulps at 5.6e-17 / 1.1e-16
(Corvette finish, Dodge checkpoint), the same class of Node-24 vs Edge-156 JS
difference recorded in §10.4, not a physics change.

Screenshots: `browser-<slug>-sprint-{start,checkpoint,finish}.png` (+ 2× crops),
`browser-corvette-zr1-stock-sprint-respawn.png`. The checkpoint frame is at the
exact crossing tick inside the start-area truck prop (near-field camera limit:
the car drives through the prop, so it can fill the view); the banner, HUD and
state hashes are the crossing evidence, and the start/finish frames are clear.
Evidence: `browser-evidence-sprint.json`, `browser-evidence-respawn.json`,
per-car `sprint-<slug>.json`.

### 15.5 Limits

- **No lap / one segment.** 29 m of measured real draw; start→checkpoints→finish
  only, no second lap, sectors or loop.
- **Gates are rules geometry only**; no gate mesh is added to the render packet.
- **Respawn rebuilds the world** through `e1_create` (180-tick settle): a frame
  hitch and a restart from rest at the gate; the timer and passed checkpoints are
  kept.
- **Best time is local** (`localStorage`, per car, ms); no server, ghost or
  leaderboard.
- **No opponents, AI, traffic, race audio or multiplayer.** One car, one segment,
  one chase camera; not the retail race mode.
- **Rules are bookkeeping**: they gate the requested input only, proven by the
  rules-off replay; penalties, collisions and wrong-way logic are out of scope.
- Native-vs-wasm parity remains blocked by the DirectX SDK
  (`T-007-vehicle-physics.md` §7).
