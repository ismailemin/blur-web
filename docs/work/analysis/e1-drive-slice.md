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
float e1_engine_rpm(void);                            /* live Engine().RPM(); -1 before a world */
int  e1_boost_queue(int kind, int startTick, int ticks, float targetMps,
                    float magnitude, float dx, float dy, float dz);
const char* e1_boost_state(void);                     /* JSON queue/effect read-back */
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

---

## 16. Per-car telemetry and a small validation report (T-007/telemetry, P39)

**Date:** 5 November 2026
**Scope:** `probes/e1-drive/**`, `_work/e1-drive/**`, `_work/logs/e1-drive/**`,
this section and `docs/work/verification/T-007-telemetry.md`. No change to the
engine, the wasm module, `probes/render-packet/`, `probes/car-parts/`, tools,
`upstream/` or `game-data/`. Physics is unchanged: all five drive state sequence
hashes and drive packet hashes and all five sprint sequence hashes are the
P36/P37 anchors, and the verifier now pins them for every car, not only the
Corvette.

### 16.1 Why

The sprint answers "who is faster over 29 m"; it does not answer "does this car
accelerate, stop and turn like its XT record says". The telemetry mode adds three
deterministic manoeuvres per car and reports the measured numbers in units, with
a 60 Hz trace. Nothing about the physics changes: the page and the verifier feed
the same `e1_set_input` calls to the same wasm build, and the manoeuvres are
separate from the drive/sprint paths.

### 16.2 The three manoeuvres (tick-only inputs)

`web/telemetry.js` holds the scripts and the analysis; both the page and the node
verifier import it.

| manoeuvre | input | what is reported |
| --- | --- | --- |
| `accel` | throttle on every tick, fixed 86 m window | 0–50 / 0–80 / 0–100 km/h ticks, top speed, speed and distance at the end of the window |
| `brake` | throttle, then brake from the tick the accel run first measured 80 km/h | entry speed, stop tick, distance, peak and mean deceleration |
| `lateral` | 120 throttle ticks, then 4 square half-periods of 36 ticks at ±0.6 steer | peak lateral acceleration, peak yaw rate, yaw lag behind each steering reversal |

Each manoeuvre runs in its own fresh wasm instance (`e1_create` at the committed
spawn). The brake step tick is measured in the same series (`plan.brakeTick`), so
the executed input is a constant step function of the tick; the steer sweep is a
square wave built with `Math.floor`, not `sin`/`cos`, so Node and Edge agree
exactly. Speed comes from `state.speed`, acceleration from the per-tick finite
difference of `state.velocity` projected on the body axes, yaw from
`state.angular` projected on the body up axis. Nothing is fitted and no engine
parameter is read back into the report.

### 16.3 Measured (`_work/e1-drive/telemetry.json`)

| car | 0–50 | 0–100 | speed at 86 m | brake 80–0 | peak / mean decel | lateral peak | yaw peak | yaw response |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Audi R8 V10 (AWD) | 1.133 s | **2.650 s** | **135.2 km/h** | **13.34 m** | 24.77 / 15.46 m/s² | **1.52 g** | 22.7 °/s | 12.7 ticks |
| Corvette ZR1 (RWD) | 1.817 s | 3.650 s | 126.5 km/h | 14.83 m | 20.80 / 15.13 m/s² | 0.86 g | 22.2 °/s | 15.3 ticks |
| Lotus Exige (RWD) | 1.900 s | 3.833 s | 119.1 km/h | 17.00 m | 18.40 / 12.65 m/s² | 0.99 g | 22.7 °/s | 12.3 ticks |
| Dodge Challenger (RWD) | 2.100 s | 4.633 s | 108.2 km/h | 17.07 m | 18.47 / 13.34 m/s² | 0.84 g | 19.0 °/s | 14.7 ticks |
| Ford Focus RS (FWD) | 2.400 s | 5.133 s | 107.1 km/h | 18.73 m | 16.59 / 11.76 m/s² | 1.32 g | 26.3 °/s | 13.3 ticks |

Every manoeuvre: wheel contact on every tick, 0 non-finite states, distinct state
hashes per tick, and the recorded inputs replayed into a fresh instance set give
identical hashes.

### 16.4 Plausibility against the XT records (not a fidelity claim)

- 0–100 order (Audi < Corvette < Lotus < Dodge < Focus) is **exactly** the order
  of `torqueScaleNm / mass` (905/1600, 780/1600, 370/890, 675/1700, 455/1400).
  `accelRankDistance = 0` in `run.json`. The AWD car is quickest, the FWD car
  slowest, the 1700 kg Dodge slower than the 1600 kg Corvette with less torque.
  The 86 m terminal-speed order is the same.
- Braking order is the same but the **Lotus is an anomaly**: it has the highest
  XT brake-to-mass ratio (1.985/890) and only the third-shortest stop (17.00 m).
  Brake scalars alone do not order the stop (tyre grip, balance and entry speed
  also contribute), so the measured anomaly is recorded and not explained.
  `brakeRankDistance = 2` is the verifier's coarse plausibility bound.
- Lateral output separates cars that share the same XT grip points, so the sweep
  orders the *response* at a fixed steer, not a grip limit: the Audi (1.52 g at
  64.6 km/h entry) and Focus (1.32 g at 29.8 km/h) are highest, the long,
  heavy Dodge lowest (0.84 g).
- Peak deceleration is a one-tick finite difference including the brake
  application transient (1.69–2.53 g); the mean over the stop (1.20–1.58 g) is
  the robust figure. Both are reported and labelled.

### 16.5 Verification

`_work/e1-drive/run.json` — **PASS, 423/423 checks** (348 P37 + 75 telemetry).
The 75 new checks cover the three-manoeuvre structure, monotonic timers,
independent re-derivation of every timer from the recorded states, the fixed 86 m
window on the ground, top speed = max measured speed, brake entry/stop/distance/
deceleration sanity, lateral peak and yaw-response consistency, 60 Hz contiguous
traces, tick-only input shape, tick-0 identity with the drive, **two independent
instance sets**, **input replay**, distinct per-tick hashes, the unchanged physics
anchors, and five cross-car ordering/plausibility gates.

`tools/verify_asset_probe.py --skip-build` — **Passed 29 checks** (no regression).

### 16.6 Browser evidence

Five headless Edge/WebGPU captures at the 0–100 km/h tick (219 / 230 / 278 / 308 /
159), **0 console messages**, panel visible with one table and three charts,
`maxNumericDelta = 0` against the node metrics, the brake plan tick equal, and
the three per-tick state hash traces **SHA-256 equal** to node. The legacy paths
were re-run: the 15-capture sprint pass is clean (12/15 exact packet hashes, the
same three documented last-bit differences) and the Corvette drive regression is
clean (4/4 exact, P36 positions/speeds). Screenshots:
`browser-<slug>-telemetry.png` and `-car.png`.

### 16.7 Limits

- **One strip, not a lap.** 0–100 km/h fits for all five cars; a Vmax run, a
  100–0 km/h stop and a full lap do not fit on the measured data. Braking is from
  80 km/h (entry measured per car) and "top speed" is the maximum inside the
  86 m window.
- **Lateral is a response at a fixed steer**, not a grip limit; entry speed
  differs per car (29.8–64.6 km/h) and is reported.
- **Peak deceleration includes a one-tick transient**; the mean is reported too.
- **Module rebuild limit — Superseded by §17.** This section recorded, correctly
  for the build it measured, that the wasm module aborts on a third `e1_reset()`
  or fourth `e1_create()` in one instance, and that telemetry therefore used one
  fresh instance per manoeuvre with `R` reloading the page. The limit was a
  library defect (an uninitialised `C_Scene` scheduler group handle flushing
  stale heap bytes), not an engine limit; it is fixed in §17, so telemetry now
  runs in one instance and `R` rebuilds in place. The historical measurement and
  its workaround are kept here as the record of what was true at P39.
- **No retail-fidelity claim.** Diagnostic visuals, unchanged physics, one
  measured strip, five XT cars, no opponents/audio/multiplayer/streaming.
- Native-vs-wasm parity remains blocked by the DirectX SDK.

## 17. Rebuild limit fixed: one wasm instance, 10+ restarts (T-007/reset, P40)

**Date:** 5 November 2026
**Scope:** `probes/e1-drive/**`, `_work/e1-drive/**`, `_work/logs/e1-drive/**`,
this section and `docs/work/verification/T-007-reset-fix.md`. No engine patch,
no change to `probes/car-parts/`, `probes/render-packet/`, `tools/`, `upstream/`
or `game-data/`. Physics is unchanged: the verifier's five drive state sequence
hashes, five drive packet hashes and five sprint sequence hashes are still the
P36/P37 anchors.

### 17.1 The defect was a scene, not the engine

P39 recorded that this wasm build aborts on a third `e1_reset()` after
`e1_create()` or a fourth `e1_create()` in one instance, and worked around it
with one fresh instance per telemetry manoeuvre and a page reload on `R`. P40
reproduced it and resolved the trap to a function:

```text
Scheduler::Flush(int, bool, unsigned int)
Gravity::C_Scene::WaitForDeferredContacts(...)
Gravity::C_Scene::_Simulate(...)
e1::BuildWorld()
```

`C_Scene` flushes its scheduler group every tick. The group handles are members
the scene constructor does not initialise (`Scene.cpp:133-136` has the
`CreateGroup` calls commented out) and the retail game assigns them explicitly
(`GameWorld.cpp:562-563`). This library's `BuildWorld` set the task policy but
not the handles, so `Flush` indexed `jqPool.BatchGroupPool[m_Group]` with heap
leftovers. On a fresh zeroed heap that value was 0 and the flush silently
returned; after the first freed-block reuse it was another number whose
`NDependencies` was also stale, so the dependency walk left the pool. That is
the whole "about three rebuilds" behaviour: heap reuse, not an engine counter.

Measured with the new `e1_diag()` export on the unfixed build: builds 1 and 2
reported `group = 0`, build 3 reported `group = 10`, and build 4 trapped. The
value 10 was never returned by `CreateGroup()` in that instance.

### 17.2 The fix

The scene owns its two scheduler groups for the lifetime the library gives a
world:

- `BuildWorld`: `Scheduler::CreateGroup()` twice, then
  `SetInternalGroupHandle` / `SetBroadPhaseGroupHandle` — exactly the two retail
  calls, made once per built world;
- `ReleaseWorld`: after the scene is released (its destructor flushes both
  handles), `Scheduler::DestroyGroup` both, returning the slots to the pool;
- `World` starts both handles at `JQ_GROUP_NONE`, so a partial build cannot
  destroy a group it did not create.

No engine file changed. No reload, no second module, no physics parameter.

### 17.3 Measured (`_work/e1-drive/reset-cycles.json`)

One wasm instance per car, built with `e1_create` and rebuilt nine more times
with alternating `e1_reset`/`e1_create`, replaying the same 30 scripted ticks
after every rebuild:

| car | cycles | resets | identical 30-tick hashes | heap | pool head | group handle | deps |
| --- | ---: | ---: | --- | --- | ---: | ---: | ---: |
| Corvette ZR1 | 10 | 5 | yes | 268,435,456 B | 5 | 0 | 0 |
| Lotus Exige | 10 | 5 | yes | 268,435,456 B | 5 | 0 | 0 |
| Dodge Challenger | 10 | 5 | yes | 268,435,456 B | 5 | 0 | 0 |
| Ford Focus RS | 10 | 5 | yes | 268,435,456 B | 5 | 0 | 0 |
| Audi R8 V10 | 10 | 5 | yes | 268,435,456 B | 5 | 0 | 0 |

Every rebuild starts at tick 0 with `contacts = "1111"`, 0 non-finite states,
and the same per-tick hash sequence. The scheduler pool keeps 16 slots with the
free-list head at 5 in every cycle (three physics static groups + this world's
two), dependencies 0, and the same steady-state queued count (the physics
timer's two deferred batches at the end of a tick — present in the first build,
never growing). `repro_reset.mjs --cycles 20 --mode reset` and
`--mode create` extend this to twenty rebuilds through each entry point.

The telemetry series now runs twice in one instance (six manoeuvre runs, one
`e1_create` + five `e1_reset`) with per-tick hashes and all metrics bit-identical
to the fresh-instance reference. The sprint restart path reconstructs the same
inputs, the same per-tick hashes and the same finish on all five cars:
2.800 / 2.850 / 3.000 / 3.267 / 2.283 s at ticks 258 / 261 / 270 / 286 / 227.

### 17.4 Verification

`_work/e1-drive/run.json` — **PASS, 488/488 checks** (423 P39 + 65 new). The new
checks are 13 per car: seven on the 10 rebuild cycles (completion, hash identity,
tick-0 contact, constant heap, non-growing pool and valid created group handles,
reset-counter semantics, 0 NaN), three on the one-instance telemetry series
(6 manoeuvres / 5 resets / 1 create, hash identity with the reference, constant
heap and finite metrics), and three on the sprint restart (finish and both
checkpoints, identical inputs/hashes/finish, constant heap and pool).

Browser, headless Edge/WebGPU: `--mode restart` is
`clean-console-and-gates` for **5/5 cars** with **0 console messages** — the
probe's `restarts` counter goes 0 → 1 (a reload cannot preserve it), the phase
returns to `countdown` with `elapsedTicks = 0`, `sprintResult` is cleared, the
`localStorage` best is kept, and the second finish has the same time and the same
finish-tick state hash. `--mode telemetry-restart` proves `R` re-runs telemetry
in place: 4 world builds before, 7 after, one instance, every trace hash and
every metric identical. Legacy passes are unchanged: telemetry 5/5 exact, sprint
15 captures at 12/15 exact packet hashes (the three documented last-bit
`atan2`/`sin` differences), Corvette drive 4/4 exact.
`tools/verify_asset_probe.py --skip-build` — **Passed 29 checks**.

### 17.5 Limits

- Each rebuild still re-imports the level and re-runs the 180-tick settle
  (15–37 ms), so a restart is a one-frame hitch, not a resumable hot reload.
- The group lifetime is per world. The pool has 16 slots; a world that rebuilt
  more than 16 times without destroying its groups would fail loudly in
  `CreateGroup` (jobqueue.cpp:457-462). This library destroys them, and the
  verifier checks the head does not move.
- The steady-state queue count is 2, not 0 (the physics timer's deferred
  batches); it is measured and required to stay constant, not hidden.
- Unchanged: one measured 29 m strip, no lap, one car at a time, diagnostic
  materials, no retail- or full-game claim, native parity blocked by the DirectX
  SDK.

## 18. Deterministic 5-minute soak: long session, restarts and mode switches (T-007/soak, P42)

**Date:** 5 November 2026
**Scope:** `probes/e1-drive/**`, `_work/e1-drive/**`, `_work/logs/e1-drive/**`,
this section and `docs/work/verification/T-007-soak.md`. No engine, wasm module,
`probes/render-packet/`, `probes/car-parts/`, `tools/`, `upstream/` or `game-data/`
change. Physics is unchanged: every complete drive segment is the node verifier's
`sha256:83f76590…008e1f`, every complete sprint segment is
`sha256:fdd893bd…e62622` at finish tick 258 / 2.800 s, and every telemetry
segment reproduces the P39 metrics and trace hashes exactly.

### 18.1 The session plan

`?soak=1&soakSeconds=<n>&soakTicksPerFrame=<k>&car=<slug>` is a new page mode.
It repeats a three-segment cycle with no wall-clock input:

| segment | ticks | boundary |
| --- | ---: | --- |
| drive | 300 | 2 s throttle / 2 s coast / 1 s brake, then `e1_reset()` + new timeline |
| sprint | ~379 | countdown, both checkpoints, finish, 120-tick brake tail, then `e1_reset()` + new timeline |
| telemetry | ~779 | the P39 three-manoeuvre series, each after `e1_reset()` |

A 5-minute session is 18,000 fixed 1/60 s ticks. `soakTicksPerFrame` controls how
many ticks one animation frame advances (default 1); tick inputs, state hashes,
packet hashes, telemetry metrics and the final tick count are independent of frame
pacing. The page records per-frame rAF interval and CPU work, one wasm-heap /
scheduler / buffer sample per simulated second, a checkpoint after every segment
(state sequence hash, packet hash, last-update hash, scheduler group, heap,
buffers) and the full telemetry metrics/trace hashes.

`probes/e1-drive/tools/soak_browser.mjs` runs the plan twice in fresh page/module
instances, takes start/mid/end screenshots and gates the two runs against each
other and against `run.json`. `web/packet-consumer.js` gained a bounded buffer
lifecycle (`releaseGeometry()`, `packetLoads`, `buffersCreated/Destroyed`) because
this is the first path that reloads a timeline dozens of times in one page; the
render/pipeline code did not change.

### 18.2 Measured, 5 simulated minutes × 2 runs (one tick per frame)

| evidence | run 1 | run 2 |
| --- | ---: | ---: |
| simulated ticks | 18,000 (300.000 s) | 18,000 (300.000 s) |
| wall time | 70.20 s | 70.68 s |
| cycles / drive / sprint / telemetry segments | 13 / 13 / 13 / 12 | 13 / 13 / 13 / 12 |
| packet timeline loads | 26 | 26 |
| frame time p50 / p95 / p99 / max | 7.63 / 8.06 / 8.535 / 11.013 ms | 7.97 / 8.06 / 8.52 / 8.995 ms |
| CPU work per frame p50 / p95 / p99 / max | 0.325 / 0.59 / 0.68 / 0.98 ms | 0.315 / 0.59 / 0.695 / 1.405 ms |
| frames over 16.7 ms | 0 | 0 |
| wasm heap | 268,435,456 B constant | 268,435,456 B constant |
| scheduler pool | head 5, size 16, queued 2, group 0, deps 0 | same |
| GPU buffers | 208 created / 200 destroyed / 8 live | same |
| geometry uploads | 78 (3 per load) | 78 |
| uniform writes / draws issued | 8,688 / 2,311,008 | 8,688 / 2,311,008 |
| JS heap, post-GC early → late mean | 39.87 → 38.05 MB (−1.82 MB) | 39.86 → 38.10 MB (−1.76 MB) |
| console messages | 0 | 0 |
| NaN / abort | 0 / 0 | 0 / 0 |

The two runs have **38 identical checkpoint records** (label, cycle, tick, state
hash, last-update hash, packet hash, telemetry aggregates/metrics). The 13th
sprint is truncated by the 18,000-tick budget and labelled `truncated`; it is not
compared with the node finish, but it is identical in both runs. Browser packet
hashes differ from Node in the documented `Math.atan2`/`Math.sin` last bit, while
browser-to-browser packet hashes are identical; state sequences, finishes and
telemetry hashes are exact.

Headless rAF runs at ~123 Hz here, so 18,000 one-tick frames take ~70 s rather
than 300 s. The frame intervals are a measurement of this headless loop, not a
user-display or retail frame-rate claim. `verify_e1_drive.mjs` remains **488/488
PASS** and the portable suite is unchanged.

Full method, evidence paths, screenshots and limits:
`docs/work/verification/T-007-soak.md`.

## 19. The measured 539.81 m corridor: full track visual, path gates, and the chassis grade limit (T-007/extended, P43)

**Status:** kept for the corridor measurement (geometry, course artifact, gates,
coverage); §19.3's "the chassis is the blocker" reading is **superseded by §20**
(P46): the measured line also crosses two engine-confirmed 50 m vertical collision
faces, so the corridor is not drivable and the playable sprint is the 29 m straight.

**Date:** 5 November 2026
**Scope:** `probes/e1-drive/**`, `_work/e1-drive/**`, `_work/logs/e1-drive/**`,
this section and `docs/work/verification/T-007-extended-sprint.md`. No engine,
wasm module, `probes/track-coverage/`, `probes/render-packet/`,
`probes/car-parts/`, `tools/`, `upstream/` or `game-data/` change. The drive
physics anchors are the P36 values; the sprint timeline is a new measured record.

### 19.1 What was built

The real track visual now merges the instructed `block88/node283` section with the
six measured corridor sections of P41's 539.81 m course
(`block56/58/50/71/64/59`). The corridor subtotal is exactly the measured
**299 draws / 47,790 triangles / 78,712 vertices**; the merged visual is **394 /
57,133 / 96,494** and still one mesh (2 meshes, 3 uploads). Five sections come from
the pinned 46-section track-coverage draw map and are re-hashed against its
recorded positions/indices; `block56/node289` keeps its pinned `level_inspect`
reference, and the two independent readers are asserted equal.

`tools/build_course.mjs` copies the measured 0.25 m samples into
`_work/e1-drive/course.json` (539.808 m, 2,257 samples, 2,251 covered, three seams
totalling 1.413 m). `web/sprint-layout.js` v2 places the start, the 1/3 and 2/3
checkpoints and the finish on that line as measured samples, with every gate line
perpendicular to the local 5 m tangent, 6 m wide, and re-measured independently
(61/61 drawn and collision samples per gate, surface delta <= 0.7 mm). The finish
is 2.121 m before the measured end. Progress, the next-gate distance, the off-course
band and the respawn heading are all path-based; the fall rule is relative to the
measured ground at the car's arc (the corridor descends 2.8 m, so the old
spawn-height rule was wrong).

### 19.2 What was measured

`verify_e1_drive.mjs` re-measures all 2,248 course samples with its own barycentric
code: 2,245 collision hits, 2,242 draws within 0.5 m (the six misses are the three
recorded seams), coverage 99.733 %, gaps 1.414 m in three runs. It is **490/496**;
the six failures are one recorded drivability check and one DNF check per car.
15 headless Edge captures (5 cars x start / mid / stop) have **0 console messages**;
the merged track is visible under the car (`394 real draws, 57133 tri`).

### 19.3 The blocker (P43, superseded in 19.5)

The scripted sprint is a real path follower (Stanley control on an 8 m moving
average of the measured path, bounded inside the measured band). Every car drives
53.2-53.8 m of the corridor and stops at the `g58 -> g50` section join, where the
collision surface rises **7.16 cm across the seam (6.36 cm in the first 0.94 m
window, 6.7 %)** while the drawn road stays flat. The E1 chassis is the documented box proxy whose skid plate sits at ground
level, so the lip strikes the plate: the car stalls at 0.07-0.53 m/s with all four
wheels in contact, and a direct probe shows it cannot move south across the rise
from rest, while it climbs 2.5 % grades elsewhere. This is a vehicle-proxy limit,
not a survey error; the full-chassis game car has suspension travel the proxy does
not model. A second, larger blocker follows at arc 528-535 (up to 31 % local grade,
61 cm).

Consequence: the two checkpoints and the finish are unreachable in this PoC. The
layout, coverage, gates and rules are verified; the sprint is a measured DNF. The
possible fixes (raised proxy body, a course ending before arc 52, or keeping the
corridor visual-only with the 29 m P37 sprint playable) are outside this slice's
ownership and are recorded in `docs/work/verification/T-007-extended-sprint.md` section 7.

## 20. The extended-sprint root cause and the survey fallback (T-007/ledge-fix, P46)

**Date:** 5 November 2026
**Scope:** `probes/e1-drive/**`, `_work/e1-drive/**`, `_work/logs/e1-drive/**`,
this section and `docs/work/verification/T-007-ledge-fix.md`. No change to
`probes/track-coverage/`, `probes/car-parts/`, `probes/render-packet/`, the engine,
`tools/`, `upstream/` or `game-data/`.

### 20.1 The saved P43 patch had to be repaired

`_work/p43-drive.diff` was written through a lossy console pipeline: UTF-8 bytes
were decoded as CP857, so every em dash, arrow and minus in the *context* lines
became three characters (`—` → `ÔÇö`), and `git apply` failed on four files.
Reversing the transform per line (`line.encode('cp857').decode('utf-8')`) produces a
patch that applies cleanly; the repaired patch and the script are kept in
`_work/e1-drive/`. The P43 blocker reproduces exactly (all five cars stop at the
section join; the Corvette at 53.81 m), so the artifact was correct in substance.

### 20.2 The chassis proxy was the second blocker

The harness box is `trackWidth × 2·tyreRadius × wheelBase` centred on the car
origin; measured at the settled spawn the box's lower face is **1.2 mm above the
ground**, so the car skates on its skid plate. P46 implements the proxy fix as a
*labelled option*: the box's collision element is offset upward with
`C_ShapeDesc::m_RenderOffset` (the retail element offset), which moves only the
collision surface — the car's tick-0 state, mass, inertia tensor and centre of mass
are unchanged (measured: `e1_diag().collisionBox` centre +0.0999 m at lift 0.10,
car state bit-identical). Measured with the same from-rest probe:

| lift | instrument | section-join rise (arc 47.5 →) | cliff pinch (arc 54.8 →) |
| ---: | --- | --- | --- |
| 0.00 | limit probe | stops at 52.66 m | stops at 56.20 m |
| 0.10 | limit probe | crosses the rise, stops at 55.96 m | stops at 55.96 m |
| 0.25 | scripted sprint (path follower) | crosses the rise, reaches 57.88 m | not measured with the probe |

The lift is faithful to the harness' own documentation and it fixes P43's blocker,
but it does **not** make the corridor drivable. The shipped module stays at lift 0
(the XT data's own skid-plate height), so the verified physics is untouched.

### 20.3 The real blocker: the corridor crosses cliffs

The corridor is a *coverage* measurement: a cell is covered when a committed draw
is within 0.5 m of the collision surface. The 50 m vertical faces that bound the
playable valley are drawn **and** collided, so their cells are covered and the
measured Dijkstra line runs through the wall. Measured from the committed artifacts
and confirmed with the engine's own ray query (`e1_ray_probe`, the same
`FillCache`/`Trace` path the wheels use):

| crossing | point | face height | engine-solid |
| --- | --- | ---: | --- |
| 10.66 m | (−84.70, 1040.70) | 50.0 m | no |
| 57.82 m | (−49.85, 1011.00) | 50.0 m | **yes** |
| 177.15 m | (30.00, 1063.77) | 50.0 m | no |
| 530.71 m | (259.73, 1303.00) | 50.3 m | **yes** |

The line also threads a pinch 0.05-1.8 m from two cliffs between arc 55.7 and
59.7 m. Per-car from-rest probes: every car stops at **52.66-53.37 m** (the 6.36 cm
rise) and, driven from 54.8 m, at **55.49-56.20 m** (the pinch), never past 56.5 m.
So the measured course limit is the first engine-confirmed wall crossing at
**57.82 m**, and the practical limit is the pinch just before it. This is a property
of the measured route, not of the chassis: no proxy lift and no suspension travel
makes a 50 m wall passable.

### 20.4 What was shipped

The extended sprint is therefore **reported, not offered as a course**:

- the playable sprint is the **29 m straight** again (P37/P42 layout, rules, script,
  page wiring, captures and soak restored from HEAD);
- the **540 m visual stays drawn** (394 real draws / 57,133 triangles, 3 uploads)
  and `?survey=1` labels it with the measured limit — no gate, timer, result or
  packet field changes;
- `web/corridor-survey.js` + `tools/build_corridor_survey.mjs` produce
  `_work/e1-drive/corridor-survey.json` (sections, four gates with 61/61 coverage,
  the four path/face crossings with the engine's confirmation, the 6.36 cm rise,
  the −31.24 % drop, the three gaps) and a labelled `corridor-survey.html`;
- `tools/corridor_probe.mjs` measures the per-car physical limit at both stations;
- `verify_e1_drive.mjs` re-derives the survey with the engine's ray query
  (canonical comparison), re-measures the gates, checks the limits and re-runs the
  per-car probes: **514/514 checks, 0 failures**. The five drive state anchors are
  still the P36 values (physics unchanged); the packet anchors moved explicitly
  because the packet now carries 394 track draws instead of 144.

Verification, per-car numbers, hashes, screenshots and limits:
`docs/work/verification/T-007-ledge-fix.md`. The P43 record
(`T-007-extended-sprint.md`) keeps the corridor measurement and is marked
superseded where it read the chassis as the only blocker.

## 21. Real static albedo textures on the real UV0 stream (T-007/textured-track, P49)

**Date:** 5 November 2026
**Scope:** `probes/e1-drive/**`, `_work/e1-drive/**`, `_work/logs/e1-drive/**`,
this section and `docs/work/verification/T-007-textured-track.md`. No change to
track-coverage, drivable-path, car-parts, render-packet, engine, tools,
`upstream/` or `game-data/`. Physics, cars, sprint, camera, telemetry, restart and
soak behaviour are untouched.

### 21.1 What was missing

P31/P46 drew the real River direct draws with a diagnostic albedo: the geometry,
draw ranges and world positions were real, but every draw was a neutral colour
because `materialsApplied:false`. P45 measured the UV0 stream of the 299 corridor
draws and P47 decoded the static `g_tAlbedo` texture of each of them, but neither
pass uploaded, bound or sampled anything. §20's blocker 1 (no sampling) is closed
here for the six measured sections.

### 21.2 What P49 exports and uploads

`tools/build_track_textures.py` (new) turns the committed P45/P47 rows and the
committed `level_inspect` mesh references into PoC data:

- **UV0**: the `uv0` array of all seven merged sections, in the merged vertex
  order (`track-uv.bin`, 192,988 float32 values / 771,952 B). Each draw's
  referenced UV pairs are hashed exactly as `verify_stream.py` does and must
  equal the P47 `uvhash`; all 299 match. The UV aggregate is the P45 value
  `2ed1f4b0b3c9148e`.
- **Pixels**: one RGBA file per distinct static source
  (`textures/track.albedo.<block>.<index>.rgba`, 136 files / 439,360 B). Each is
  decoded by the committed `texture_inspect --raw` from the P47/P34 blob and
  re-hashed against the recorded RGBA FNV-1a 64; a mismatch aborts.
- **Bindings**: per-draw `textureId` and `bindingStatus`. 297 draws are
  `bound-static-albedo`; 2 are `runtimeOnlyAlbedoParameter` (g50-n265 primitives
  241/242); 95 block88/node283 draws are `noBindingRowForSection` (P44/P45/P47
  never covered that section). Nothing is invented for the 97.

`build_geometry.mjs` verifies the manifest/UV/file hashes, embeds the UV stream
and the RGBA payloads (base64) plus the sampler metadata as **geometry v5**
(18,791,525 B, +1.82 MB), and gives every track draw its `textureId` and
`textureBinding` record. `packet-adapter.js` copies `uv`, `textures` and
`texturePack` into the packet; `packet-consumer.js` creates one `rgba8unorm`
mip0 texture + bind group per source, a second vertex buffer with the real UV0,
and a 1×1 white placeholder for untextured draws.

### 21.3 Sampling is one declared choice, not recovered engine state

P45/P47 list wrap mode, filter, anisotropy, mip selection and texture matrices as
unresolved. P49 publishes the choice instead of hiding it: `repeat` address mode
(UV0 leaves `[0,1]`), linear min/mag, mip0 only, `rgba8unorm`, no sRGB
conversion, no material colour and a white tint for textured draws. A textured
draw samples its own UV; an untextured draw samples the white placeholder and
mixes back to its diagnostic albedo (`texParams.x = 0`), so `textureSample` has no
non-uniform control flow. Mip/sRGB/retail sampler fidelity is explicitly **not**
claimed.

### 21.4 Result

- `verify_e1_drive.mjs` **522/522** (was 514/514). The eight new checks cover UV
  presence/hash, the 297/2/95 split, texture uniqueness/provenance, RGBA re-hash,
  the sampler contract, finite sampled UV0 and the exact runtime-only pair.
- 20 headless Edge/WebGPU captures: **0 console messages**, 136 textures /
  439,360 B and 297 textured track draws on every page, state hashes equal to
  Node.
- 1-minute two-run soak: **PASS**, 136 live textures at the end (no texture leak),
  buffers live 11 (9 mesh + uniform + scene), 0 console messages.
- The five drive state sequence hashes are the P36 values; the whole-packet hash
  moved because the packet now carries the UV stream and the textures, and the
  five `PHYSICS_ANCHORS.packet` constants are re-pinned with that note.
- The road patch changes from the neutral diagnostic `206,206,206` to the
  sampled `129,130,111` (fixed screen patch; see the verification record for the
  caveat).

### 21.5 Limits

97/394 draws stay diagnostic (2 runtime-only, 95 unbound); only mip0 is
uploaded; wrap/filter/sRGB are a declared PoC choice; no material colour, blend,
shader stages or retail sampler; no culling/sorting/LOD/instancing; the last
~12 m of the sprint still has no committed draw. No full-game claim.

Verification, commands, per-section table, per-car browser bytes, screenshots,
before/after pixel patch and every file hash:
`docs/work/verification/T-007-textured-track.md`.

## 22. The measured 310 m P48 course is the default sprint (T-007/310m, P50)

**Date:** 5 November 2026
**Scope:** `probes/e1-drive/**`, `_work/e1-drive/**`, `_work/logs/e1-drive/**`,
this section and `docs/work/verification/T-007-310m-course.md`. No change to
drivable-path, track-coverage, car-parts, collision-oracle, render-packet, the
engine, `tools/`, `upstream/` or `game-data/`. The P48 path is consumed read-only
and pinned by file + canonical hash. Physics, packet body, camera, telemetry and
reset behaviour are unchanged.

### 22.1 Why the course moved

P37's playable sprint was 29 m because that was the length of the committed real
draw under the spawn corridor. P48 then measured a **310.395 m collision-only
drivable path** from the same spawn (1,245 samples at 0.25 m, max step 1.55 cm,
max 2 m grade 3.09 %, 0 wall hits in 621 engine traces), and P51 measured **100 %
draw coverage** of that path from the already-drawn section `river.block56.node289`.
The two blockers that stopped the 539.81 m corridor (a 6.36 cm section join and two
engine-confirmed 50 m faces at arc 57.82 / 530.71) are not on this route.

### 22.2 How the course is derived

`web/sprint-layout.js` gained `deriveLongCourseLayout`: it validates and pins
`_work/drivable-path/path.json`, builds the 0.25 m arc table, measures collision
ground on every sample, places the start at arc 0, the two checkpoints at the 1/3
and 2/3 points of the finish span, and the finish at the last sample before
`measuredEnd − 10 m`. Each gate line is the left normal of the local 5 m tangent
and is re-measured at 0.1 m against the real draw (nearest within 0.5 m of the
collision surface, the P51 rule). The 29 m course stays `deriveSprintLayout`, now
carrying `courseId: 'short'`.

`tools/build_sprint.mjs` writes both layouts. The page loads the 310 m one by
default and the 29 m one with `?course=short`; best times are stored per course
(`e1-drive.sprint.best.v2.310m` / `…v2.short`).

### 22.3 How the car drives it

The scripted sprint is a Stanley follower (P43's controller form) with a measured
speed-dependent steering gain and a per-tick steering rate limit. The engine's
steering authority falls sharply with speed (0.1 request ≈ 0.01 rad/s yaw at
24 m/s; 1.0 ≈ 1.3 rad/s), so the gain scales with speed. The car is created on the
start gate facing the measured tangent (0.767411 rad) — the drive-slice spawn
heading π/2 is unchanged. The follower stays within 0.85 m of the measured line,
slows to 13 m/s over the last 18 m, and the post-finish brake stops it at arc
306–308, before the measured narrowing.

### 22.4 Result

- `verify_e1_drive.mjs` **550/550** (was 522/522). New checks cover the pinned P48
  path, both layout derivations, the 10 m finish clearance, gate perpendicularity,
  independent 61/61 gate coverage for both courses, the 7-station × 1,202-sample
  car-width band (8,414/8,414), engine-ground agreement (125 probes), the path
  rules (out-of-order, local-ground below-ground, outside-corridor, gate heading),
  the per-course best keys and both per-car sprint suites.
- All five cars finish: Corvette 14.650 s, Lotus 14.767 s, Dodge 14.917 s, Focus
  15.217 s, Audi 14.150 s; 0 respawns, 0 NaN, wheel contact on every tick, max
  lateral 0.59–0.85 m, and a replay with the rules off that reproduces every state
  hash. A one-instance `e1_reset()` restart reproduces the finish.
- The 29 m regression still finishes at the exact P37 times (2.800 / 2.850 /
  3.000 / 3.267 / 2.283 s) with the P37 state hashes.
- Drive and packet anchors are unchanged (P49 values); the new 310 m sprint state
  sequences are new anchors, recorded in the verifier with that reason.
- Headless Edge/WebGPU: **20 captures** (5 cars × start / mid / checkpoint /
  finish) on the 310 m course, **0 console messages**, 0 assertion failures,
  13/20 packet hashes byte-exact (the seven differences are the documented Node /
  Edge last-bit transcendental cases; camera |Δ| ≤ 4.55e-13, car matrices
  bit-identical). The 29 m course is captured the same way with `--course short`.
  In the mid frame the HUD reads `310 m P48 (default) · 310.4 m measured · finish
  300.2 m`, `1/2 cp`, 22.9 m/s, 50 %; the finish overlay shows 14.650 s and the
  new best time.

### 22.5 Limits

Point-to-point, no lap; five small draw seams inside one section; the start
heading is a convention; the follower is a deterministic PoC driver; the ±6 m
respawn band is a declared rule below P48's measured 7.78 m wall clearance; the
course beyond the finish is unmeasured and not driven. Full record:
`docs/work/verification/T-007-310m-course.md`.

## 23. Per-car albedo textures on each car's own UV0 stream (T-007/textured-cars, P55)

**Date:** 6 November 2026
**Scope:** `probes/e1-drive/**`, `_work/e1-drive/**`, `_work/logs/e1-drive/**`,
this section and `docs/work/verification/T-007-textured-cars.md`. No change to
`probes/car-materials/`, `probes/car-parts/`, `probes/drivable-path/`, the
engine, `probes/render-packet/`, `tools/`, `upstream/` or `game-data/`. The P52
material manifest and the committed car-parts files are read-only inputs, pinned
by SHA-256. Physics, sprint, camera, telemetry, restart and soak behaviour are
unchanged.

### 23.1 What was missing

P52 resolved every draw of the five roster cars to its committed material row and
decoded the static `g_MeshTexture` image behind **224 of the 491 car draws**
(40 images, 18,178,048 RGBA bytes). The E1 drive slice still drew all five bodies
with per-part diagnostic colours (`materialsApplied:false`), and the car mesh had
no UV0 stream at all: `packet-consumer.js` bound an explicit zero UV buffer for
it because the part manifest exports only positions and indices.

### 23.2 What the export adds

`tools/build_car_textures.py` (new) turns the committed P52 record into PoC data
without re-decoding or re-resolving anything:

- **Draw → material → texture**: per car, all draws keep their P52 status,
  material row (id, stage, type name, archive/field offsets), resolved
  `block:index` / `shared:index` identity, name and `u32` texture hash. 224 are
  `staticAlbedo`, 45 are the `_NO_ALBEDO` paint lookup, 66 the light off/on blend
  and 156 the other `_NO_ALBEDO` shaders, each with the committed P52 reason.
- **UV0**: the `uv0` array of the committed `scene_inspect.exe` scene report,
  exported byte-exactly (signed zeros preserved) as `car-uv-<slug>.bin`. Its
  positions are numerically the part-manifest mesh (the report keeps `-0`, the
  mesh serialised `0`, so a byte hash of the two position arrays differs in the
  sign of zero only). Every draw range, part identity and UV availability flag is
  required to agree between the P52 manifest, the car-parts manifest and the scene
  report before a byte is written, and each draw's UV0 value hash (FNV-1a 64 over
  the referenced float32 UV pairs) is recomputed by `build_geometry.mjs`.
- **Pixels**: the committed P52 `.rgba` files are re-hashed and embedded as
  base64. No decode is repeated here and no pixel is modified.

`build_geometry.mjs` therefore emits **geometry v6**: each body mesh carries its
real UV stream, each car draw carries `textureId`, `textureBinding` and
`uvFlipV`, and each body carries its own textures. `packet-adapter.js` puts the
static level/track pack **plus only the driven car's own images** in the packet,
so a page uploads 143–145 textures (136 track + 7–9 car) and never the roster.
`packet-consumer.js` already had the `rgba8unorm` mip0 texture, the UV vertex
buffer and the `texParams` select; it gained the per-draw V direction below.

### 23.3 The one declared sampling choice: `v' = 1 − v` for car draws

The exported UV0 and the decoded pixels are unmodified, but sampling them as-is
renders the artwork vertically mirrored. The evidence is pixel-level and
specific: the ZR1 rear plate (`nyc_10`, shared 6) reads `NEW YORK` at the bottom
with the number mirrored under the raw stream, and reads upright with
`v' = 1 − v`; the Audi plate (`spain10`, shared 7) and the ZR1 rear emblem
(`corvette_zr1_decals`, resource block 8) behave the same, so both texture
storage kinds share one convention. Glyph order is preserved and only the
vertical axis changes, which is a V inversion — not a per-draw UV transform and
not a 180° rotation. `geometry.carTextures.uvConvention` records the rule, the
three observations and the fact that no per-material texture matrix, wrap state
or mip state is recovered. `texParams.y` carries the flag per draw; the track and
level packs keep the raw stream, so the accepted P49 track evidence is not
silently changed. **The same inversion is likely present in the track pack**
(its road textures carry no readable text, so P49 could not see it); re-opening
that pack is outside this task and is recorded as an open item.

### 23.4 Result

- `verify_e1_drive.mjs` **570/570**, 0 failures (was 550/550). The 20 new checks
  cover the pinned export, the per-car UV stream and its byte/sha identity, the
  224/45/66/156 split with per-draw labels, per-car texture identity and RGBA
  re-hash, the recomputed per-draw UV0 hash (224/224), the UV bounds, the
  `(u, 1−v)` convention and the bounded per-packet texture set.
- All five drive state sequence hashes are **unchanged** (P36/P37 values); the
  sprint, telemetry, restart and reset checks are unchanged. The whole-packet
  hash moved because the packet now carries the car UV stream and textures, so
  the five `PHYSICS_ANCHORS.packet` constants are re-pinned with that note.
- 20 headless Edge/WebGPU captures: **0 console messages**, 0 assertion failures,
  143–145 textures / 3.02–5.44 MB per page, 37–50 textured car draws per car,
  17/20 packet hashes byte-exact (the documented Node/Edge `Math.atan2` ulp case).
- The car bodies now show their own artwork: plates, decals, badges, wheel
  textures, brake discs and interior weave, per car. The Focus's four glass draws
  bind the `focusrs-alpha` image and render its RGB opaque (no blend state).
- A 1-minute two-run soak keeps **145 live textures** (exactly one packet) across
  four packet loads per run: created 580 = 4 × 145, destroyed 435, live 145 in
  both runs and at every sample — no texture leak. The page's own soak report is
  PASS; the tool's drive/telemetry node-anchor comparisons fail for a
  pre-existing reason unrelated to textures (the soak world starts on the 310 m
  tangent since P50), see the verification record.

### 23.5 Limits

224/491 car draws are textured; the 267 runtime-only draws stay diagnostic with
their P52 reason. Only mip0 is uploaded and no sRGB, anisotropy, material colour,
blend state or shader stage is applied. The paint lookup and light blend are
runtime inputs and are not recovered. The car mesh is still drawn in the engine
body frame; per-material texture matrices and mirrored plate quads are not
recovered (the Audi plate's `E` strip stays on the mirrored side). No full-game
claim.

Full commands, counts, per-car tables, screenshots, soak evidence and hashes:
`docs/work/verification/T-007-textured-cars.md`.

## 24. The car UV correction is U, not V (T-007/car-uv, P59)

**Date:** 6 November 2026
**Scope:** `probes/e1-drive/**`, `_work/e1-drive/**`, `_work/logs/e1-drive/**`,
this section and `docs/work/verification/T-007-car-uv-orientation.md`. No change
to `probes/car-materials/`, `probes/car-parts/`, the engine, `probes/render-packet/`,
`tools/`, `upstream/` or `game-data/`. Physics, sprint, camera, telemetry, restart
and soak behaviour are untouched; only the per-draw car UV sampling direction
changes. This section **supersedes §23.3 and §23.5** on the V claim.

### 24.1 What was visibly wrong

§23 chose `v' = 1 − v` for all 224 textured car draws. The plates were still
wrong: the Audi rear plate read as a 180°-rotated `E 350L EMO`, the ZR1 rear
plate read upside-down `DQF 9760`, and the country strip stayed on the wrong
side. P55 saw the plate was still mirrored and recorded it as an unrecovered
per-material U transform. The error was in the diagnosis, not in the model: the
V flip was unnecessary and the remaining mirror was a U inversion. The two
mistakes together produced the 180° rotation.

### 24.2 Root cause from the committed data

The committed `scene_inspect.exe` UV0 stream and the committed P52 RGBA decode
are both unmodified. For a readable island they say:

| island | data | result |
| --- | --- | --- |
| ZR1 rear plate (`nyc_10`, draw 14) | `x=+0.124 → u=0.935`, `x=-0.124 → u=0.072`; `y=+0.328 → v=0.077`, `y=+0.194 → v=0.917` | U increases toward world `+x` (screen-left when viewed from behind); V decreases as the plate rises, so the upper plate edge samples the image's top rows and V is already correct |
| Audi rear plate (`spain10`, draws 51/52) | `x=+0.258 → u=0.981`, `x=-0.258 → u=0.018`; `y=0.338 → v=0.079`, `y=0.231 → v=0.939` | same U direction and same already-correct V |
| ZR1 side badges (`corvette_zr1_decals`, draws 39/44) and front/rear emblems | U runs toward the screen-left on the outside of the body | same one U convention, both sides and both ends |

The decoded images are stored row 0 = top, so raw V displays upright. Raw U
displays the text in reverse glyph order with upright glyphs (a horizontal
mirror), which is exactly what the P55 `p55-plate-asis.png` frame shows. Flipping
V instead gives upright-order, upside-down glyphs (`p55-plate-vflip.png`); doing
both axes gives a 180° rotation (`p55-plate-rot180.png`). Only `u' = 1 − u`
gives the authored `DQF 9760` / `NEW YORK` / `E 350L EMO` (`p55-plate-uflip.png`).
The front Dodge plate validates the same rule on a front-facing island: it reads
`California 2SBI653` only with the U flip.

The track pack remains on the raw stream: P49 had no readable text, and this task
does not silently change accepted track evidence. Whether the track needs the
same U inversion is still an open item.

### 24.3 The fix

- `tools/build_car_textures.py` exports the rule as
  `sampleU:"1 - uv0.u"`, `sampleV:"uv0.v (unchanged)"`,
  `sampleUV:"(1 - uv0.u, uv0.v)"`, and sets `uvFlipU:true` /
  `uvFlipV:false` on the 224 textured car draws only.
- `tools/build_geometry.mjs` carries both per-draw flags; the texture binding
  records `sampled as (1 - u, v)`.
- `web/packet-adapter.js` requires every textured car draw to have
  `uvFlipU:true, uvFlipV:false` and every track draw to have neither.
- `web/packet-consumer.js` applies each flag independently in the vertex stage:
  `uv' = (select(u, 1-u, texParams.y), select(v, 1-v, texParams.z))`. The UV
  values in the vertex buffer are never modified.
- `tools/verify_e1_drive.mjs` asserts the new convention, the per-draw flags and
  the separation from the track pack; the five `PHYSICS_ANCHORS.packet` values
  are re-pinned because the packet's per-draw flags changed.

### 24.4 Result

- `verify_e1_drive.mjs` **570/570, 0 failures**.
- All five drive **state sequence hashes are unchanged** (`83f76590…`,
  `8d6cd4d4…`, `b1c63d20…`, `fb3909b6…`, `5b4ae49d…`); sprint, telemetry,
  restart and reset checks are unchanged.
- 20 headless Edge/WebGPU captures: **0 console messages**, 0 assertion
  failures, the same 224 textured car draws (37–50 per car) and 143–145
  uploaded textures per page.
- Close-ups: the Audi plate reads `E 350L EMO` with the `E` strip on the left;
  the ZR1 plate reads `NEW YORK` / `DQF 9760`; the Dodge plate reads
  `California 2SBI653`. Rings, crossed-flags and other badge artwork is upright.
- No textured draw count, texture count, RGBA byte count or UV stream changed;
  only the sampling direction of the same 224 draws changed.

### 24.5 Limits

The fix is one declared global car U inversion, not a recovered per-material
texture matrix. 267/491 car draws stay diagnostic. Mips, sRGB, anisotropy,
material colour, blend state and shader stages remain unapplied. The track pack
keeps its raw stream. The Focus glass still binds an alpha image and renders it
opaque. No full-game claim.

Full commands, before/after images, hashes and the exact rule:
`docs/work/verification/T-007-car-uv-orientation.md`.

## 25. Ghost / rival replay of a completed sprint (T-007/ghost, P63)

**Date:** 6 November 2026
**Scope:** `probes/e1-drive/**`, `_work/e1-drive/**`, `_work/logs/e1-drive/**`,
this section and `docs/work/verification/T-007-ghost.md`. No change to
`probes/car-materials/`, `probes/car-parts/`, `probes/drivable-path/`, the engine,
`probes/render-packet/`, `tools/`, `upstream/` or `game-data/`. **No physics
change:** every drive/sprint state sequence anchor is the P59 value and the ghost
is a recording of those runs, not a new simulation.

### 25.1 Why a recording, not a rival AI

The sprint is one car on one measured segment; there is no opponent simulation and
adding one would be a new physics/AI claim. The slice instead lets the user race
**their own best run**: at the finish the page copies the run's own per-tick body
pose and integrated wheel angles into a compact record, and the next attempt plays
that record back through the same car mesh. Before the first finish, the committed
deterministic reference trace (the scripted Stanley follower's run) stands in,
clearly labelled. The ghost never steps the engine, never collides and never enters
the packet.

### 25.2 Record and hash

One sample per engine tick from the settled tick 0 to the finish tick:
`position3 + rotationQuaternion4 + wheelAngle4`, float32 little-endian, base64
(44 B/tick; 14.2–59.7 KB per reference file). The body matrix is rebuilt from the
quaternion and translation; each wheel is `body × manifest rest × Rx(angle)` with
the same `multiplyMat4`/`rotationXMatrix` the adapter uses. The canonical-JSON
SHA-256 of the whole record (including the payload) is the ghost hash. The verifier
re-derives every committed reference from its own sprint run on each normal run,
compares the bytes, and reconstructs all nine node matrices at every tick: max
|body Δ| **5.0e-6** and max |wheel Δ| **3.1e-5** (float32 sample quantization),
and two derivations of the same run produce the same hash and payload.

Storage is one `localStorage` key per course
(`e1-drive.sprint.ghost.v1.310m` / `…v1.short`), a map from car slug to the
fastest clean ghost; a slower run does not overwrite it, a respawned run is not
recorded (the engine tick axis restarts) and a tampered record is dropped with a
reason instead of replayed. Without a stored ghost the page fetches the committed
reference and verifies both the file SHA-256 and the record hash; a failure leaves
the ghost off and says why.

### 25.3 Rendering and HUD

The consumer reserves ghost uniform slots in the existing uniform buffer and adds
one pipeline with the same bind groups, vertex layout and car mesh, a translucent
cyan diagnostic tint and a depth test without depth write. Each ghost frame is
**one extra draw set of already uploaded geometry** (84–115 draws): no buffer, no
texture and no geometry upload (`geometryUploads` stays 3), and no new GPU buffer
(the soak buffer gate remains 11). `G` toggles the ghost in place; the HUD shows the
source, `Δt` (player time minus ghost time at the player's arc, positive = behind)
and `Δd` (ghost arc at the player's time minus the player's arc, positive =
behind), and the on-screen tag reads `GHOST · … · REPLAY, NO COLLISION`.
`?ghostoffset=<ticks>` is a capture-only presentation offset (the headless 5-car
capture uses +60 so the ghost is visibly ahead of the identical scripted run); it
moves only the drawn ghost.

### 25.4 Playback clock and delta

Playback follows the **race clock** (`countdownTicks − remaining`, else
`countdownTicks + elapsedTicks`, minus one tick plus the fixed-step alpha), so a
respawn — which restarts the engine tick axis but keeps `elapsedTicks` — does not
rewind the ghost. The delta uses the running maximum of the measured arc as the
progress axis (straight `x` on the 29 m course), so projection wobble cannot rewind
it; a finished ghost clamps at the finish. Replaying a run against its own ghost is
a zero gap on every moving tick (≤ 2.3e-7 s / 3.9e-5 m measured), and the cross-car
signs follow the unchanged physics (the Audi ghost is ahead of the Corvette's pace,
the Focus ghost behind the Audi's).

### 25.5 Verification

`verify_e1_drive.mjs` — **PASS, 678/678 checks, 0 failures** (570 before; the new
block covers the 10 reference records, the index, reconstruction, determinism,
purity, the store and the delta). The ten sprint state sequence anchors are
unchanged. `capture_browser.mjs --mode ghost` produced 5 ghost-visible frames plus
the G-toggle pair in headless Edge/WebGPU with **0 console messages**, 3 geometry
uploads and the exact
`drawsIssued = frames × draws + ghostFrames × ghostDrawSlots` relation; the browser
pose is bit-identical to the record. `--mode sprint` and `--mode restart` remain
green (ghost off by default), so best-time and restart behaviour are unchanged.

### 25.6 Limits

A replay, not an AI: one ghost, no collision, no input, no packet entry, no retail
rival behaviour. The committed reference is the deterministic scripted follower,
not a human best. The tint is a diagnostic colour, not a recovered material. One
extra draw set per ghost frame is not culled or LOD'd. No full-game claim.

Full commands, hashes, screenshots and evidence paths:
`docs/work/verification/T-007-ghost.md`.

## 26. A real three-lap race on P61 loop-01 (T-007/lap, P67)

### 26.1 What was added

`?course=lap` is a separate, playable layout on P61 `loop-01`: the closed
**222.040211 m** collision loop in component 5, 902 samples at 0.25 m, first
point == last point at `(115.5, 1164.0)`. The loop is disconnected from the
committed spawn component by the measured 1.118 m / 50 m wall, so the layout
spawns on the loop itself with its 5 m seam tangent (`1.638873 rad`). The line is
both the start and the finish; three forward crossings end the race. The layout is
`_work/e1-drive/sprint-lap.json`, canonical hash
`sha256:167643a9a108bc927d093da2b3d1408d639c1cc4110920511455b68c68ad1f91`.
The P61 source is consumed read-only against its pinned file and canonical hashes.

The `LapRules` state machine counts a crossing only after `lapDistance` has
accumulated the next full lap, so the start pose and a respawn on the line cannot
count as a lap. It records each lap's race-clock time, keeps the timer running
across a respawn, and rebuilds an off-course car on the last lap line. `R` resets
laps, lap times, timer and finish.

An earlier revision also required the previous sample's projected arc to be past
half the loop. At the seam the closed polyline repeats its first point, so a
position a few centimetres before the line can project onto the start segment
(arc ~0) instead of the end segment (arc ~length). All five cars completed lap 1
and then dropped every later crossing (Audi crossed at ticks 1667, 3222, 4780 and
6334; only the first counted). The guard was redundant because `lapDistance`
already guarantees a full lap, so it was removed; the same defect and fix are
recorded in `probes/e1-drive/web/sprint-rules.js`.

### 26.2 The follower

The same deterministic controller is used with a lap profile: pure pursuit on a
`3 + 0.40·v` m lookahead (max 9 m), cruise 12 m/s, lateral acceleration
2.0 m/s², steer gain 3.0. Only controller constants changed; no physics value
changes. Pure pursuit replaced the Stanley lateral term because the latter
saturates at the loop's ~10 m hairpins when the car is slow. The 310 m and 29 m
courses keep their exact previous controller and hashes.

Every roster car drives three laps with **0 respawns**, wheel contact on every
tick, 0 NaN, an input replay that reproduces every state hash and an `e1_reset()`
restart with identical lap times:

| car | lap 1 | lap 2 | lap 3 | total | best lap | max running lateral | min centre-to-face |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Corvette ZR1 | 29.000 | 28.550 | 28.550 | **86.100 s** | 28.550 s | 0.784 m | 2.056 m |
| Lotus Exige Cup260 | 29.117 | 28.583 | 28.583 | **86.283 s** | 28.583 s | 0.810 m | 2.063 m |
| Dodge Challenger | 29.050 | 28.550 | 28.517 | **86.117 s** | 28.517 s | 0.854 m | 2.040 m |
| Ford Focus RS (FWD) | 29.167 | 28.533 | 28.550 | **86.250 s** | 28.533 s | 0.984 m | 1.949 m |
| Audi R8 V10 (AWD) | 28.650 | 28.400 | 28.417 | **85.467 s** | 28.400 s | 0.812 m | 2.041 m |

The measured minimum centre-to-steep-face distance during the race is 1.949 m;
the 2.981 x 1.676 m car circumradius is 1.710 m, so the whole footprint clears
every steep face by at least 0.239 m. The declared respawn band is ±1.25 m.

### 26.3 Visible-prop layer (P66, read-only)

The lap enables the P66 `all-visible` manifest (468 OBB colliders) through the
committed resolver. The layer runs after the engine tick and adjusts only the pose
used by the packet, rules observer and camera; it never writes an engine value.
The 310 m sprint keeps its existing `roadside` policy.

Measured: **loop-01 has no mapped visible prop**. 0 of 901 loop poses are blocked
under `all-visible`, and the nearest collider is **69.530 m** away, outside the
manifest's 30 m region (built around the 310 m course). `all-visible` is therefore
safe on the lap, but inert: there is no truck on the loop to hit. The layer is
tested against real manifest colliders instead: a 31 m/s head-on into the 5.39 m
`level.instance.00` truck stops on the near face with no residual overlap; a
31 m/s hit on a 0.02 m fence component does not tunnel; a 5° glancing hit along the
44.7 m `river.block56.node289.draw.102.component.005` building keeps 99.7 % of its
travel without overlap. These prove the layer, not lap props.

### 26.4 Draw coverage

The loop has real committed draws: 902/902 centre samples are covered by the union
of the 394 committed track draws (block71/node209 and block64/node209 cover the
loop), with a maximum surface delta of 0.9 mm. The car-width band (7 stations,
1.676 m envelope + 0.30 m margin) is **6,286/6,307 = 99.667 %** drawn; the 21
missing stations are the lateral-edge stations (-1.138 / -0.838 m) at arc
82.65-99.31 m, while the collision surface exists at all 6,307. No diagnostic
surface or invented texture is used; the real committed draws are rendered.

### 26.5 Verification

`verify_e1_drive.mjs` — PASS after this pass (**766 checks**; the exact count is in
`_work/e1-drive/run.json`). New checks: P61 artifact/hash, lap layout derivation
and structure, 222.040 m / 902 samples / 3 laps, line coverage, independent
centre-line and band draw coverage, engine ground agreement, per-car three-lap
times/order/finish/band/steep clearance/prop layer/anchor/replay, lap rules
(crossing order, finish, respawn target, reset), lap restart, and the prop-layer
head-on/glancing/no-tunnelling tests. The 310 m, 29 m and ghost blocks are
unchanged, including every previously pinned state hash.

The full browser pass is 5 cars x start / lap 1 / lap 2 / finish with console 0;
details and screenshot paths are in `docs/work/verification/T-007-lap-mode.md`.

### 26.6 Limits

The lap starts in component 5; it is not the committed spawn and it does not
bridge the wall. The P66 manifest has no collider on loop-01, so the enabled
`all-visible` layer is inert there and the truck/fence tests are resolver-layer
tests elsewhere in the manifest. There is no AI, no traffic, no lap ghost (the
sprint/regression ghosts are unchanged) and no full-game claim. The ±1.25 m band
is a declared respawn rule, not a measured lane.

## 27. Free roam on the P65/P68 spawn basin (T-007/free, P69)

### 27.1 What was added

`?course=free` is a fourth playable layout next to the unchanged 310 m sprint,
the 29 m regression and the P61 three-lap race: the committed spawn
`(-88, 1050)` at heading `pi/2` on the P65 `R04` basin (9,689.5 m², 100 %
drawn), with **no countdown, no gates, no finish, no lap counter and no
corridor respawn**. The page shows a free-roam HUD (course, session clock,
contained/distance, box, speed, position, prop layer); `R` returns to the
spawn. The layout is `_work/e1-drive/sprint-free.json`
(file `sha256:3accd653…236d3e`, canonical
`sha256:c512ad733959903878ed805367c4b3112a0976a12f484da3c1d5813c7f865f87`),
derived from the pinned P65 `regions.json`, the committed spawn and the P68b
spawn-component box. The three existing layouts are not touched.

### 27.2 Containment

The box is the measured P68b spawn component `x -108.5…5.0, z 1027.5…1164.0`
(P68a area 7,702.25 m²; the C03 wall cuts the 1,321.25 m² eastern channel out)
expanded by a declared 2.0 m. `FreeRoamRules` resets only when the car leaves
that box, falls more than 1 m below the local measured ground, or stays
airborne for 30 ticks; the target is always the committed spawn. There is no
invisible wall and no corridor band.

The local ground is a 2 m lattice re-sampled from the collision mesh over the
box (57 × 69 cells: 3,418 measured, 515 void/pocket corners filled from the
nearest measured cell by a deterministic BFS, recorded). The 2 m lattice is an
estimate between cells; the fall rule is a defensive reset, not a terrain
solver.

The containment test lane is measured, not typed in: the easternmost lattice
cell whose 1 m samples east reach the reset boundary over a collision surface
with no step above 5 cm/m and no P68b all-visible contact. It is
`(-24.5, 1037.5)`, 31.5 m to the boundary. On the real engine at full throttle
the rules fire `outside-bounds` at tick 199, at `x = 7.076`; the world rebuilds
`0.0053 m` from the spawn, and 30 further ticks produce no event. That also
records the honest reason for the rule: the extended visible-prop boxes leave a
sub-cell slot at the C03 clearance ring (wider than the 1.68 m car while the
0.5 m raster + 1.0 m erosion closes it), so the box reset is what keeps the car
in the measured component.

### 27.3 Visible-prop layer with parameters

`web/prop-layer.js` now takes a manifest/profile/hash pin set. The lap keeps
the committed P66 `colliders.json` (468, `sha256:a98fb8eb…`) and free roam uses
the P68b extended manifest `_work/free-roam-prop/colliders-r04.json` (variant
`free-roam-r04`, 431 colliders, file `sha256:5c7bba74…`, content
`sha256:932e0f87…`). A world whose profile or collider count disagrees with its
pins throws; the page hashes the manifest bytes before parsing. No manifest was
regenerated or modified, and the 310 m/29 m manifests/policies are unchanged.

Measured on the real R04 colliders: the spawn pose has 0 contacts; a 31 m/s
head-on into the 5.386 × 2.219 m wreck `level.instance.00` stops on the near
face (165 ticks, max penetration 0.0728 m — one 8 cm substep, residual 0); a
31 m/s hit on the 0.02 m panel `…draw.143.component.072` blocks after 160 ticks
with residual 0 and no pass-through.

### 27.4 Scripted free run

`freeScriptInput(tick, speed)` is a tick-only, speed-capped diagnostic
manoeuvre (throttle, tight left turn in the bowl, run west, brake), not a path
follower and not a route file. Five roster cars, 401 ticks each:

| car | travel | max speed | contacts | respawns | state sequence hash |
| --- | ---: | ---: | ---: | ---: | --- |
| Corvette ZR1 | 24.635 m | 7.067 m/s | 0 | 0 | `bede912e…05a3b920` |
| Lotus Exige Cup260 | 22.710 m | 6.273 m/s | 0 | 0 | `f198bd7b…8f383f8e` |
| Dodge Challenger | 25.594 m | 7.044 m/s | 0 | 0 | `ee6018bf…6a0f2369` |
| Ford Focus RS (FWD) | 23.344 m | 6.795 m/s | 0 | 0 | `f590e4ad…bc27390b` |
| Audi R8 V10 (AWD) | 29.198 m | 7.076 m/s | 0 | 0 | `4d4a4323…79ade5ca` |

Every car: contained, wheel contact on every tick, 0 NaN, 0 prop contacts,
0 resets, an input replay that reproduces every raw state hash, a pinned anchor
and a valid packet v1.1 timeline. `R` after 200 ticks returns to `0.0053 m`
from the spawn with the session clock at 0.

### 27.5 Verification

`verify_e1_drive.mjs` — PASS (**818 checks**, 766 existing + 52 free-roam). New
checks cover the P65 artifact/R04, the P68b pins and 431-collider world, the
derived layout and its validation, no gates/finish/lap/countdown, spawn and
heading, box/margin, ground lattice, measured lane, spawn clearance, truck
head-on, 0.02 m no-tunnelling, per-car spawn/contained/no-respawn/contacts/NaN/
replay/anchor/packet, synthetic out-of-box/below-ground/airborne cases, the
real-engine boundary reset and the `R` restart. Two runs produce identical
anchors. `verify_asset_probe.py --skip-build` is 30/30, `check_e1_poc.py` 21/21
with the server up, and `capture_browser.mjs --mode free` is 20 captures
(5 × spawn/mid/prop/reset) with console 0, 0 assertions, 20/20 state hashes,
max camera delta 4.55e-13 and 14/20 byte-exact packet hashes (the six are the
documented Node/Edge last-bit transcendental cases).

### 27.6 Limits

One basin, one spawn: free roam is not a route, a lap or the eastern channel.
The box is a bounding rectangle, not the exact free mask; the ground fills 515
void/pocket cells. Draw coverage is P65's 100 % measurement consumed read-only.
The prop layer is a visible-mesh kinematic approximation. The scripted run is a
23–29 m diagnostic manoeuvre, not a racing line. There is no free-roam ghost,
best time, AI, traffic or full-game claim (details and evidence:
`docs/work/verification/T-007-free-roam.md`).

## 28. Engine audio follows the wasm RPM (T-007/audio, P71)

### 28.1 What was added

The slice now plays the committed retail engine-audio module
(`probes/audio/web/engine-audio.js`) against the simulation's own RPM:

- `native/e1_drive_lib.cpp` exports `float e1_engine_rpm()`; the value is
  `RacingPhysics::Car::Engine().RPM()` (the documented `RPMInput` source,
  `BaseMessageHandler.cpp:1940/1970`) and is `-1` before a world exists.
  It is not derived from speed or a guessed gear.
- `tools/build_module.mjs` exports `_e1_engine_rpm`; the 186-object wasm was
  rebuilt deterministically (A/B hash identical, 1,006,289 B,
  `sha256:eb9efc0064f0d871…`).
- `tools/serve.mjs` adds two read-only trees through the existing `safeJoin`:
  `/audio/` → `probes/audio/web/` and `/_work/audio/` → `_work/audio/`.
  The six decoded WAVs are game data and are not committed.
- `web/app.js` constructs the module at load (no context, no fetch), starts it
  only from a real gesture (`pointerdown` or a driving key), calls `setRpm`
  once per rendered frame and after reset/respawn, adds `M` mute, the `audio`
  HUD row and `pagehide` dispose. `?audio=0` forces it off with no instance.
- `web/index.html` documents `M`; the user-visible HUD row reports state, RPM,
  active layer count and mute.

The gesture filter is deliberate: `R` (restart) and `G` (ghost) are used by
headless captures, so they must not create an `AudioContext`; only pointerdown,
`W/A/S/D`, arrows, Space and `M` start audio.

### 28.2 Verification

`verify_e1_drive.mjs` — PASS (**826 checks**, 818 existing + 8 audio). The new
checks compare the module table with `_work/audio/engine-model.json`, verify the
six WAV sizes/SHA-256, prove construction/`setRpm` create no context, check the
typed RPM errors and `dispose()`, and read the live accessor (`-1` before a
world, **799.75 RPM** at the settled spawn; limiter 7250). Independently
evaluating the decoded PLF at 1500/3015/6000 gives a max delta of **0**.

`capture_browser.mjs --mode audio` — PASS, **16/16**, console **0**. Before the
gesture there is no context; a trusted CDP mouse gesture reaches `running` with
6/6 decoded mono 48 kHz layers. Holding 1500/3015/6000 RPM, the live
`AudioParam` gains/rates match the retail curves with max deltas of
**1.30e-8 / 8.57e-10 / 1.23e-14** and **5.76e-8 / 5.93e-8 / 4.98e-8** (limit
1e-3); analyser RMS is **0.0643 / 0.0394 / 0.1391**. Mute reaches RMS **0** with
the context still running; unmute restores **0.1330**. `?audio=0` leaves no
instance and an explicit off HUD.

Regression: `capture_browser.mjs --mode lap` (20 captures, console 0,
0 assertions, 15/20 byte-exact) and `--mode free` (20 captures, console 0,
0 assertions, 14/20) both pass; `verify_asset_probe.py --skip-build` is
**30/30** and `check_e1_poc.py` **23/23**. The free capture presses `R`; the
gesture filter keeps that synthetic key silent, which is why its console is
clean again.

Evidence: `_work/e1-drive/browser-evidence-audio.json`,
`browser-audio-{running,muted}.png`, the `engineAudio` block in `run.json`, and
the `p71-*` logs. Server processes started before this change must be
restarted to serve `/audio/`.

### 28.3 Limits

One retail graph (`Race_V8_engine`) and one parameter (RPM); the decel layer is
excluded (flat-zero volume chain), and the bus is not the retail mixer. No
throttle/damage/induction/EQ layers and no car-to-bank mapping. The WAVs remain
uncommitted game data under `_work/audio/`. The page disposes on `pagehide`, so
a bfcache restore stays silent until reload. Full detail and evidence:
`docs/work/verification/T-007-audio.md`.

## 29. Level-instance props sample their real static albedo + UV0 (T-007/props, P73b)

**Date:** 7 November 2026
**Scope:** `probes/e1-drive/**`, `_work/e1-drive/**`, `_work/logs/e1-drive/**`,
this section and `docs/work/verification/T-007-prop-textures.md`. Read-only
inputs: the P73a asset-reader export (`level-instance-textures.json`,
`level-instance-uv.bin`, `level-instances-all.json`), the committed P34 texture
registry and BC reader. No asset-reader, engine, tool, other probe, `upstream/`
or `game-data/` change. Physics, cars, sprint, camera, restart and audio are
untouched.

### 29.1 What was missing, and what is bound now

P73a exported the real source UV0 and the static `g_tAlbedo` identity for the 22
`River block27/node253` level instances, but nothing sampled or uploaded them.
P73b joins that export to the committed P34 registry:

- **18 draws / 10,212 triangles** resolve to DXT1/BC1 and now sample their own
  decoded image on the real instance UV0 stream (14 of them are visible in the
  driven view; 4 are behind the spawn).
- **4 draws / 96 triangles** resolve to `cab01alphas_diff` (DXT5/BC3) and stay
  explicitly **diagnostic** as `bc3-alpha-rule-missing`; no alpha rule, texture,
  pixel or UV is invented.

The four images are `car01_lic_diff`, `car02_lic_diff`, `car03_lic_diff` and
`bigtruck02_diff`, all 32×16 mip0, **8,192 decoded RGBA B**. Instance UV0 is
26,324 float32 / 105,296 B (aggregate `0xb07310e198de4c19`), exactly the P73a
stream.

### 29.2 How it is wired

`tools/build_level_instance_textures.py` re-derives all 22 per-draw UV hashes,
decodes the four BC1 blobs with the committed reader, re-hashes the RGBA
against the registry and writes `_work/e1-drive/level-instance-textures.json`
(file SHA-256 `80857371…b788`, content hash `d30dcae6…6499`). `build_geometry.mjs`
pins that manifest, embeds the UV stream on the level mesh and the four images in
`geometry.levelTextures`, and gives the 18 draws a `textureId` plus a
`textureBinding` record; the 4 blocked draws keep `textureId:null` and their
neutral labelled diagnostic colour. `packet-adapter.js` concatenates the level
images into the packet and exposes `diagnostics.extras.levelProps`; the consumer
needs **no new shader semantics** — it already supports per-draw `textureId`, a
mesh UV buffer and `texParams`.

The geometry document stays **v6** because the pack is additive and that keeps
every committed layout/ghost pin valid. The packet texture count moves from 145
to **149** for the default car (+4 images / +8,192 B); the level UV buffer
replaces a same-size zero-filled buffer.

### 29.3 Verification and limits

`verify_e1_drive.mjs` — **838/838, 0 failures** (826 + 12 level-prop/packet
checks). Full `verify_asset_probe.py` **31/31**; `check_e1_poc.py` **23/23**;
1-minute two-run soak PASS with **149** live textures and 0 console messages.

`capture_browser.mjs --mode props` — 5 cars × 5 frames (tick 120, each car's
measured near-field truck tick, free-prop, sprint start, lap start), **0 console
messages, 0 assertions**. The drive/free/sprint/lap passes remain clean. The
before/after pixel delta is **37.13 %** at the tick-120 near-field truck,
**5.63 %** on the free-prop frame and **5.35 %** at the sprint start.

Limits: static `g_tAlbedo` pixels only — `g_tMaterial`, material colour, blend
state, alpha, shader stages and per-material texture matrices remain unapplied
(sampling only: mips and sRGB are superseded by §30). The committed packet/consumer
path carries world-space positions + UV0 and lights with screen-space derivative
normals, so no vertex normal array is invented. The 4 BC3 cab draws stay blocked.
No full-game claim.
Full detail, per-draw hashes, before/after paths and the diff report:
`docs/work/verification/T-007-prop-textures.md`.

## 30. Texture quality: proven sRGB decode, derived mips, trilinear sampling (T-007/quality, P75)

**Date:** 7 November 2026
**Scope:** `probes/e1-drive/web/packet-consumer.js`,
`probes/e1-drive/tools/capture_browser.mjs` (`--mode quality`),
`_work/e1-drive/**`, `_work/logs/e1-drive/**`, `probes/e1-drive/README.md`, this
section and `docs/work/verification/T-007-texture-quality.md`. No producer
manifest, geometry, packet, verifier, asset-reader, engine, tool, prop-collision,
`upstream/` or `game-data/` change.

### 30.1 What was wrong

The consumer uploaded the committed BC1 decode as `rgba8unorm` (raw stored
texels), sampled it with one mip level and `mipmapFilter: 'nearest'`, and then
applied `pow(1/2.2)` on output. The stored texels are sRGB-encoded, so the
result was gamma-encoded twice — the pale, flat-looking track/trucks/decals —
and minified pixels sampled mip0 with no mip chain.

### 30.2 What changed

- Upload every static albedo as `rgba8unorm-srgb`.
- Derive the full mip chain from mip0 in the consumer: 2×2 box **in linear
  light** (sRGB decode → average → sRGB encode; alpha averaged linearly; odd
  edges clamp). No source detail is invented or upscaled.
- Sample trilinearly (`mipmapFilter: 'linear'`) and request anisotropy 8 where
  the adapter exposes it (this adapter reports `maxSamplerAnisotropy 1`, so 1 is
  applied).
- Use the exact sRGB OETF instead of `pow(1/2.2)` on output.
- Expose the policy, per-packet mip bytes/levels and the aggregate mip hash via
  `window.__e1TextureSampling`.
- Add `capture_browser.mjs --mode quality --label before|after` and scene-only
  sharpness/noise metrics on four identical-camera frames.

### 30.3 sRGB proof

The committed `SamplerState version1` for **16/16** car resource-block albedos is
`[0,0,0,1,1,1,0,0,0,1]` — WRAP, LINEAR mag/min/mip, maxAnisotropy 0; **sRGB=1**
(`_work/car-materials/roster/cars/<slug>/materials.json`). The same record for
the level fixture `trafficcylinder_diff` is `sRGB=1`
(`docs/plan/material-binding.md`), and the committed asset-reader viewer already
uploads decoded textures as `rgba8unorm-srgb`
(`probes/asset-reader/web/mesh-viewer.js`). The BC1 decode is the untransformed
stored texel, so `sRGB=1` says those bytes are sRGB. The 136 track and 4
level-prop sources have no per-source sampler row in the committed P47/P73a
manifests; their application is labelled as the same sampler class, not as
per-source recovered state.

### 30.4 Results and limits

`verify_e1_drive.mjs` **838/838**; full `verify_asset_probe.py` **31/31**;
`check_e1_poc.py` **23/23**; drive/sprint/props/free/lap captures all console 0,
0 assertions. The default packet grows from 4,985,920 B to **6,648,180 B**
(+1,662,260 B, +33.33 %; 149 textures, 907 levels, hash `0x8942c723`), and mip
generation costs **30.3–33.6 ms** once per load (no per-frame work). Before/after
frames differ on **91.1–99.6 %** of the scene (the colour transfer); the
scale-free noise/edge alias proxy improves on 3/4 frames (−0.17 % to −1.42 %)
and is +0.70 % on the sprint-start frame. The main remaining limitation is the
**source resolution**: the ground is a 16×16 baked mud texture magnified across
metres, so it stays smooth; no upscale or invented detail is applied. Material
colour/paint, UV transforms, normals, the 4 BC3 cab draws and the 267 non-static
car draws remain unapplied and labelled. Full tables, paths and hashes:
`docs/work/verification/T-007-texture-quality.md`.

---

## 31. P74b — binding the V2 collision manifests in the playable page

**Date:** 7 November 2026. **Owner:** P74b. **Scope:** `probes/e1-drive/**`,
`_work/e1-drive/**`, `_work/logs/e1-drive/**`, this section,
`docs/work/verification/T-007-free-roam.md` and
`docs/work/verification/T-007-lap-mode.md`. No change to
`probes/prop-collision/**`, `probes/free-roam-prop/**`, `asset-reader`, the
engine, `tools/`, `upstream/` or `game-data/`. No manifest was regenerated.

### 31.1 Result

The playable page now binds the P74 V2 manifests per course through the same
additive post-tick resolver. The lap wall/garage/balcony/sign/grey-wall
components and the free-roam pipes/fences/rails are solid; the timed 310 m
sprint and the three lap/free runs keep their exact state-sequence anchors and
finish times.

| mode | manifest | profile | manifest / profile / active | run result |
| --- | --- | --- | ---: | --- |
| `?course=310` | `_work/prop-collision/colliders-v2.json` | `roadside` | 651 / 553 / **544** | 0 contacts, all five anchors and finish ticks unchanged |
| `?course=lap` | same | `all-visible` | 651 / 651 / **651** | 0 contacts, all five anchors unchanged (86.100…85.467 s) |
| `?course=free` | `_work/free-roam-prop/colliders-r04-v2.json` | `all-visible` | 447 / 447 / **447** | 0 contacts, all five anchors unchanged |

File and content pins are `33488752…751d7` / `73620739…db9ee` (base V2) and
`b1b8f2c9…18211` / `663e2570…20b38` (R04-V2). The page hashes the bytes before
parsing and `checkPropManifest` re-checks the variant, profile count, total
count and content hash. A mismatch throws a typed `PropManifestError`; there is
no fallback to V1.

### 31.2 The measured 310 m driven-line conflict

P74's `roadside` profile is clear on the measured centreline (0 of 1,245 car
poses). The committed scripted sprint does not drive the centreline exactly:
its Stanley follower has up to ~0.6–0.9 m lateral error, and when the V2 layer
was first bound the five cars contacted 0 / 354 / 3,094 / 544 / 5 ticks
(Corvette / Lotus / Dodge / Focus / Audi), changing four state anchors and
finishing two cars late. The touching components are edge pieces of the four
known clusters, not the main walls/pipes.

The response is explicit. `tools/derive_sprint_exclusions.mjs` sweeps the
committed 310 m reference ghost traces through the same 553-collider roadside
world and records **exactly 9 colliders** the committed line grazes:

```text
river.block56.node289.draw.115.component.015
river.block56.node289.draw.116.component.043
river.block56.node289.draw.116.component.044
river.block56.node289.draw.116.component.047
river.block56.node289.draw.97.component.063
river.block56.node289.draw.99.component.029
river.block56.node289.draw.99.component.042
river.block56.node289.draw.99.component.043
river.block56.node289.draw.99.component.047
```

Those nine are marked `active:false` for the timed course only
(`applyDrivenLineExclusions`), leaving **544** active. The set has
`exclusionContentSha256:9603f858…86b4f2`, is re-derived from the committed
ghosts, and is checked by the verifier against the manifest (each id is
`active:true` in the profile). The manifest and its `roadside` profile are not
modified; the four on-course arcs remain the P74 exclusions. The timed course
therefore keeps its 0-contact, anchored run, and 544 structures are solid.
This is a measured data limit, not a silent fallback: the nine ids and arcs are
in `run.json`, the artifact and the HUD row.

### 31.3 Resolver targets (P74 V2)

| target | test | result |
| --- | --- | --- |
| lap building wall `draw.355.component.000` (44.37 × 0.02 m) | 31 m/s head-on | blocks 100/120 ticks; side **1.501 m** = car half-length 1.49 + wall half 0.01 + slop; residual 0; max penetration 0.0728 m; target is the only contact |
| free pipe `draw.95.component.004` | 31 m/s head-on | blocks 101/120 ticks; first contact is the neighbouring pipe `draw.95.component.002`; side 2.032 m; residual 0; max penetration 0.0728 m |
| lap no-parking sign `draw.257.component.000` | 31 m/s head-on (single-collider world) | stops on the target, side 1.501 m, residual 0 |
| free steel pole `draw.283.component.327` | 31 m/s head-on (single-collider world) | stops on the target, side 1.501 m, residual 0 |
| lap wall | four-direction rays | **4/4 blocked**; first hits: wall (2), balcony `draw.233` (2) |
| free pipe | four-direction rays | **4/4 blocked**; first hits: other `draw.95` pipes (4) |
| both | no tunnelling at 31 m/s | 7 substeps per tick (840/120), resolved travel 10.50 m (wall) / 9.97 m (pipe) of 62.0 m free travel, residual 0, approach side kept |

The resolver tests use the target's own measured ground. `draw.355` sits on the
upper terrace at ground 6.514 m; the loop is at ~3.2 m there, so the browser
capture cannot reach it. The captures use the reachable loop-side no-parking
sign `draw.257.component.000` (2.44 × 2.76 m, ground 3.38 m) and a broad free
pipe `draw.95.component.010`; the building-wall head-on remains the resolver
proof.

### 31.4 Browser collision probe

`?collisionprobe=lap-sign|free-pipe` is a capture-only page mode: the start pose
is derived from the target manifest record (`distanceMetres` outside the near
face along `axis`), the engine gets full throttle until the layer reports its
first contact and then brake + handbrake; there are no race rules, gates or
timer. The layer does not write a physics value. `--mode collision-v2` captures
five cars × two targets × approach (tick 30) / stopped (tick 360) / settled
(tick 420).

**Result: PASS** — 30 captures, **0 console messages**, **0 assertions**. All
five cars stopped at both targets: lap sign side 1.962–2.673 m, speed
0.001–0.064 m/s, 45–76 contacts; free pipe side 2.712–2.875 m, speed
0.001–0.023 m/s, 51–61 contacts. The settled (tick 420) pose differs from the
stopped (tick 360) pose by < 0.05 m for every car. Screenshots:
`_work/e1-drive/browser-<slug>-collision-{lap-sign,free-pipe}-{approach,stopped,settled}.png`;
evidence `_work/e1-drive/browser-evidence-collision-v2.json`
(`sha256:81af5fb2…ca5840`).

The free capture is 20/20 state hashes, console 0, 447 colliders; the props
capture is 25/25, console 0; the 310 m browser sprint capture is 20/20 state
hashes and finish times with the 544-active layer (console 0); the lap
regression is the Corvette's four-frame three-lap race (4/4 state hashes,
console 0, 651 colliders). The previous
five-car lap evidence is preserved as `browser-evidence-lap-p74b-previous.json`;
the full five-car headless lap rerun is left to the main agent because a lap
frame exceeded the original poll window (raised to 600 s). The Node verifier
covers all five lap cars.

The capture uses the reachable lap no-parking sign (`draw.257`) rather than the
44 m building wall: `draw.355` is on the upper terrace (ground 6.514 m) and the
car cannot reach it from the loop at ~3.2 m. The wall's head-on proof is the
resolver test at its own measured ground (§31.3).

### 31.5 Verification

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $node probes/e1-drive/tools/build_sprint.mjs
& $node probes/e1-drive/tools/derive_sprint_exclusions.mjs
& $node probes/e1-drive/tools/verify_e1_drive.mjs              # 856/856
& $py   tools/verify_asset_probe.py --skip-build                # 36/36
& $py   tools/check_e1_poc.py                                   # 21/23 (documented V1 pins)
& $node probes/e1-drive/tools/capture_browser.mjs --mode collision-v2 --port 8802
```

`verify_e1_drive` adds the per-mode pins, the exclusion artifact/hash, the
lap/free route measurements, the five target stops, the rays and the no-tunnel
case, and keeps every previous sprint/lap/free/ghost anchor. The free layout
hash becomes `sha256:c1829cb2…ab80a6` because its recorded prop block is the
V2 447 pins; the free runs and their anchors are unchanged.

`check_e1_poc.py` still pins the V1 free manifest (431 colliders and the V1
file/content hashes) in `tools/`, which is outside this task's ownership; its
two free-roam items therefore fail while every other item passes. The checker
needs a main-agent update to the 447/V2 pins; this task does not modify it.

### 31.6 Limits

1. **Nine measured 310 m driven-line exclusions.** They are the exact active
   roadside components the committed scripted line grazes; making them solid
   changes four of the five anchored runs. They are excluded by measurement,
   recorded with ids/arcs, and the manifest/profile is unchanged. A re-measured
   sprint line could remove the need for them.
2. **The lap building wall is on the upper terrace.** The resolver proves the
   wall solid at its own ground; the car cannot reach it from the loop. The
   browser capture uses a reachable loop-side wall.
3. **Visible-mesh approximation.** Boxes fitted to visible components; the
   layer is a kinematic 2.5D post-tick pose resolver with no rotation sweep,
   suspension or vertical dynamics. Penetration is bounded by one 8 cm substep.
4. **No full-game, retail-collision or retail-handling claim.** One level, three
   courses, five cars; no opponents, traffic, race audio or multiplayer.

---

## 32. M1 — two browsers, one measured 310 m race

**Date:** 7 November 2026
**Scope:** `probes/e1-drive/**`, `_work/e1-drive/**`,
`_work/logs/e1-drive/**`, `probes/e1-drive/README.md`, this document and
`docs/work/verification/T-007-multiplayer.md`. `probes/net-mvp/**`,
`probes/race-rules/**`, `probes/prop-collision/**`, `probes/audio/**`,
`tools/`, `upstream/` and `game-data/` are read-only inputs and were not
modified.

The M1 gate connects the two standalone probes — the room/transport layer and
the rules layer — to the real drive slice. Two browser pages join one room by
code, both drive the measured 310 m P48 course with the real wasm car, see the
other car through the existing ghost draw path, and finish with one shared
result. It is an original project protocol and authority model, not a retail
network claim.

### 32.1 Session architecture

```text
host page                                   guest page
  wasm engine (own car)                       wasm engine (own car)
  60 Hz input  ─┐                             60 Hz input  ─┐
  20 Hz state  ─┤                             20 Hz state  ─┤
                ▼                                            ▼
        probes/net-mvp/server.mjs  (unchanged RFC 6455 relay, room, resume)
                ▲                                            ▲
                └────────────── 20 Hz state ─────────────────┘
  RaceSession (host rules)                     display only: sampleRemote
   ordered gates / finish / result              + RemoteDisplay corrector
                │                                            │
                └──────── room.finished ──► shared pure result table ◄──┘
```

- The **host** creates the room (slot 1) and runs `RaceSession` over both cars:
  ordered checkpoints, finish validation, result order and a deterministic
  session hash.
- The **guest** joins slot 2, simulates its own car and sends input/state. It does
  not run a second judge.
- Both pages render the other car through the **existing ghost pipeline**
  (`consumer.setGhostFrame`), one remote slot, with a translucent diagnostic
  tint and the `REMOTE · … · no collision` tag.
- **Correction:** the remote display target comes from `sampleRemote` (position
  lerp, quaternion slerp, no extrapolation). A delta above **0.5 m / 0.25 rad**
  is a counted hard set; smaller deltas blend over **3 frames**. The local engine
  is never teleported.
- **Finish:** each page reports `client.finished {tick, hash}`. The room's
  `room.finished` broadcast is converted by the **same pure function**
  (`buildMpResult`) on both pages, so positions/times/hash are identical. The
  host keeps its session ticking after its own finish until the guest's finish is
  observed (bounded) and records the validation delta.

### 32.2 What had to be added

| File | Change |
|---|---|
| `web/mp-client.js` (new) | `MpSession` wrapper over the injected `NetClient` (DOM-free, runs in Node and the browser), room/lobby/ready/start, typed event normalisation, `buildMpResult`, URL/name/code/roster helpers, M1 constants |
| `web/mp-remote.js` (new) | `RemoteDisplay` threshold/blend corrector and the nine remote node matrices (body × wheel rest × Rx), reusing `packet-adapter` matrix helpers |
| `web/app.js` | `?mp=1` mode, lobby overlay, host start, per-tick sends, remote display, RaceSession host loop, finish/result, reconnect labels, HUD counters; single-player best times and ghost replay are explicitly off in MP |
| `web/index.html`, `web/style.css` | lobby (room/name/car/roster/ready/start/status), `REMOTE` tag, shared result table, MP HUD styling |
| `web/sprint-script.js` | optional controller-constants argument for the capture-only scripted pace; default behaviour unchanged |
| `tools/serve.mjs` | read-only `/net-mvp/` and `/race-rules/` routes; `--with-room --room-port` launcher; actual-port return |
| `tools/verify_e1_drive.mjs` | 18 Node-level MP protocol/authority/result/reconnect/RaceSession checks |
| `tools/capture_browser.mjs` | `--mode mp`: room service, two page targets, lobby/ready/start, both finishes, remote-pose samples, shared result, console gate, six screenshots |

### 32.3 Scope decisions

- **One car for both bodies.** The host's car at creation is the session car;
  both pages load it. The guest page must be opened with the same `?car=`. A
  guest with a different car fails with an explicit message instead of silently
  racing two different bodies. The lobby car selector records each player's
  metadata only.
- **Provisional grid.** The start grid (2.2 m spacing, two per row) comes from
  `probes/race-rules/course-model.mjs`; it is project-specific and labelled
  `provisional`, not a recovered retail table.
- **Peer-state remote authority.** The host runs the rules/result and its own
  physics. It does **not** run a second physics body for the guest; the guest's
  20 Hz state is the pose the host validates and relays. This keeps M1 to one
  engine per page and one uploaded body per page. It is labelled
  `remotePhysicsAuthority:'peer-state'`; a second host-side body is M2 work.
- **Engine load before room join.** The 45 MB geometry parse and wasm world
  build happen before the room socket opens, so the room's 5 s heartbeat is not
  starved by the synchronous load.
- **20 Hz relay granularity.** The host's session may observe the guest finish
  one or two 60 Hz ticks before/after the guest's own report. The displayed
  table uses the room's finish ticks; the validation delta is recorded and
  checked (≤ 6 ticks in the browser capture).

### 32.4 Measured result

Representative two-page capture (`--mode mp --port 8802 --room-port 8811`):

| measurement | result |
|---|---|
| room | allocated 5-character code (per run; not committed) |
| host / guest | slot 1 / slot 2; both connected, both finished |
| shared result | identical rows and hash on both pages; host P1, guest P2 |
| host time / guest time | 14.667 s / 16.400 s (the guest's scripted pace is 0.85 in the capture) |
| host RaceSession | phase `finished`, guest `finished`, validation delta **-1…-2 ticks** (20 Hz relay) |
| remote pose samples | 20 samples, max display Δ **3.72e-5 m**, max received-vs-authoritative Δ **7.0e-7 m** |
| state/input sequences | host 324 state / 968 input, guest 358 / 1072; every state applied exactly (the capture still allows one final in-flight message) |
| console | **0** messages on both pages |
| room stats | 1 room created, 1 finished, 2 connections; no resume in the clean run |

Screenshots: lobby, mid-race and finish for both pages under
`_work/e1-drive/browser-mp-*.png`. The guest mid-race frame shows the host car
ahead through the remote slot; the finish frames show the same `RACE RESULT`
table on both pages. The full check-by-check record (including the Node
protocol gate, reconnect and the rules session) is
`docs/work/verification/T-007-multiplayer.md`.

### 32.5 Limits and non-claims

1. **WebSocket loopback, not UDP/WebRTC.** No STUN/TURN, no NAT traversal, no
   TLS/auth/accounts/database. The room code is a lookup key, not a secret.
2. **No second authoritative physics body.** Remote state is peer-reported and
   host-validated; there is no anti-cheat claim and no host-side re-simulation of
   the guest. This is the documented M1 `peer-state` authority, not the stronger
   M2 model.
3. **One map, one car for both bodies, one remote slot, no power-ups/AI.**
4. **Late join/restart/host migration are out of scope.** The room rejects late
   joins; `R` is disabled in an M1 room; the URL role is fixed for the session.
5. **Same-machine clock.** Cross-machine clock skew and WAN behavior are not
   tested. The 20 Hz state interpolation hides a 3-tick (50 ms) display delay.
6. **`check_e1_poc.py` and the `--skip-build` asset probe** remain read-only
   external gates; the M1 capture does not modify the game data, the room probe
   or the rules probe.

## 33. M2/PWR2 — power-up slice (Mine, Shield, Repair)

Status: implemented and verified, 7 November 2026, on top of the committed M1
race (`f9ff085`). This is an original project rules/relay layer driven by the
recovered PWR1 values; it is not a retail protocol or a full-game claim. The
full evidence record is `docs/work/verification/T-007-powerups.md`.

`?powerups=1` (multiplayer only, default off) adds the first power-up slice:

- **Host-authoritative world.** The host builds `PowerupModel` from
  `_work/powerups/powerups.json` and the committed
  `probes/powerups/rules/engine.js` (`createWorld`). Clients send use intents
  only; the host validates inventory/cooldown/type, resolves mine hits/shield
  absorption/damage and broadcasts sequenced events. The guest applies the
  host snapshot and event feed and never judges a hit locally.
- **Integrated types.** **Bomb (Mine), Shield, Repair.** Nitro, Shock, Shunt,
  Blindfire/Bolt, Barge and SuperShield are deferred with typed reasons: no
  proven wasm boost/impulse hook and no serialized projectile lifetime, hit test
  or human targeting (`POWERUP_DEFERRED`).
- **Placement.** Six provisional pickups on the measured 310 m P48 arcs
  40/90/140/190/240/280 m, cycling Bomb/Shield/Repair. Every event says
  `placement:'provisional-measured-arc'`; PWR3 owns the real level/actor
  placement.
- **Collection and inventory.** Host planar proximity against the recovered
  `PickupRadius=2.0 m`; one active slot; a second pickup is rejected with
  `inventory-full`. Normal pickup respawn seconds are not serialized, so the
  page emits a typed `respawn-unresolved` instead of guessing.
- **Recovered values in use.** Bomb `Radius=1.0`, `OuterRadius=3.5`,
  `DamageInflicted=100`, `Lifespan=60`, `MasterMinePrimeTimer=0.3`,
  `PlaceBehindDistance=5`; Shield `Health=50`, `Lifetime=6`; Repair
  `AmountToRepair=400`; pickup deactivate `0.6 s`.
- **Damage/wreck/respawn.** The model applies the full Bomb damage inside
  `Radius`, emits a typed near miss between `Radius` and `OuterRadius`, and
  emits `wrecked` at 0 HP. After a labelled 1.0 s diagnostic delay it emits
  `respawn` with the R1 `respawnTargetForGate(lastPassedGate)` target; the page
  rebuilds the car through the existing `respawnAt()` path and rejoins progress.
  Health is a labelled 100 HP diagnostic pool (`healthScale` is runtime-only).
- **HUD and effects.** `#powerup-hud` shows the one-slot inventory
  (icon/letter + type name), health, shield capacity/remaining time, status and
  the last six sequenced events. A bounded diagnostic marker pass in
  `packet-consumer.js` draws an octahedron for pickups, mines and shield
  bubbles (16 slots, ghost pipeline, no new buffer/texture, no packet/physics
  change). The icon is a labelled glyph because the retail `perk_icons`
  binding is not recovered.
- **Control channel.** `/_powerups/relay` is an ordered in-memory HTTP relay
  beside the unchanged `probes/net-mvp` room service: host events, guest use
  intents. It is project-specific, loopback and not a retail protocol.
- **Logical tick across rebuilds.** A wreck rebuild resets the local engine
  tick; the page carries `mpEngineTickOffset` into the 20 Hz snapshot and the M1
  finish report so the race clock stays monotonic. The offset is recorded in the
  finish hash payload; the normal M1 finish path is unchanged and re-verified.

Verification:

| Gate | Result |
|---|---|
| Node event-model tests | 68/68 PASS (`_work/e1-drive/powerups-node-report.json`) |
| Two-browser `--mode mp-powerups` | PASS, console 0/0, identical host/guest event counts, mine/wreck/respawn + shield absorb/break + repair screenshots |
| M1 Node regression | 874/874 PASS |
| Portable asset suite | 41/41 PASS (concurrent `amboy-render` added; every step passes) |
| PoC readiness | 23/23 PASS |
| M1 two-browser capture | PASS, console 0/0, host P1 / guest P2 |
| Solo sprint capture | PASS, console 0, 14.650 s |

Limits: one remote slot and peer-state authority are unchanged; the mine
falloff law, `Normal` pickup respawn seconds, max-health scale, inventory
capacity, HUD icon binding and projectile/boost rules remain un-recovered and
are labelled; no AI use and no retail/full-game claim. The task card, handoff
and `docs/STATUS.md` entry are owned by the main agent (this subagent's file
ownership did not include them).

## 34. Vehicle batch 1 — ten B-class cars join the playable roster

Status: implementation + evidence, 7 November 2026. The playable E1 roster grew
from 5 to **15** cars without moving the five original state anchors. The full
record is `docs/work/verification/T-007-vehicle-batch1.md`.

- **Roster.** `probes/e1-drive/cars/roster.json` now lists the five T-007 anchors
  plus Audi TT, Ford F100 OffRoad, Ford FR100, VW Golf W12, Ford Mustang GTR,
  Dodge Viper ACR, Audi S3, Ford Bronco, Nissan Skyline R34 and Chevrolet SoCal
  HHR, in V1 manifest order. `car_roster.py` decodes all 62 records, gates
  62/62, writes 15 field lists and `_work/e1-drive/cars.json`.
- **Bodies/materials.** All fifteen map to their exact
  `\models\vehicles\<name>.model` entry and build a complete part manifest. The
  P52 material pass covers 1,378 draws: 673 static albedo, 146 paint, 169 light
  blend, 390 no-albedo; 112 decoded textures / 46,505,984 B RGBA. Every added car
  has zero undecoded textures; FR100's `fordf100_2` is a light-only texture (7
  light references, 0 static draws). The four five-car guards were generalized to
  the roster length with per-car pins, not weakened.
- **Geometry.** `_work/e1-drive/geometry.json` is **106,864,802 B** (101.91 MiB)
  versus 45,374,377 B before batch 1 (+135.5 %, ≈6.15 MB/car). It is inside the
  declared 128 MiB batch-1 budget and the 15-car browser capture passes; batch 2
  must split per-car chunks (`carBodiesIndex` + `cars/<slug>.geometry.json`)
  before it ships.
- **Drive proof.** All 15 finish the 310 m sprint (14.100–15.483 s), the 29 m
  regression (2.267–3.400 s), the 3-lap loop (85.183–87.383 s) and the free-roam
  basin (contained, 0 prop contacts). Every car has 2/2 ordered checkpoints, 0
  respawn, wheel contact every tick, 0 NaN, a rules-off replay, a restart in the
  same wasm instance and a committed 310 m + 29 m ghost (30 records). The
  verifier is **2254/2254**.
- **Prop layer.** The measured timed-course exclusion set grew from 9 to **23**
  colliders (530 active of the 553 roadside profile) because the added lines
  touch additional fence/rack components, including thin components swept
  between ticks. The set is derived from the full raw pre-finish trace; the
  scripted controller follows the raw engine state (the prop layer no longer
  feeds back into it), and the layer is scoped to the timed run. The original
  five state anchors, courses and gates did not move.
- **Short-course damper.** The 29 m P37 throttle hold is unchanged for the five
  reference cars. A documented drift damper (engages only above 2.5 m/s lateral
  speed) lets the Nissan Skyline — which missed the 6 m finish line by 8 cm —
  complete the regression at 2.267 s; its short ghost is committed.
- **Limits.** Class B only; no C alias, no full-game claim, one map/car at a
  time. Telemetry brake residuals for Bronco (0.229 m/s) and Skyline
  (0.844 m/s) are recorded. The portable suite is **44/45**: the one failure is
  `prop-collision-v2` pinning the whole `geometry.json` file (its collider data
  and content hash are unchanged; the pin is owned by `probes/prop-collision/`).
  The PoC checker is **20/23**: three hard-coded five-car checks in
  `tools/check_e1_poc.py` (selected count, P52 totals, RGBA total) need the main
  agent to generalize them.

## 35. M2a — Nitro and Shock in the online race

Status: implemented and verified, 7 November 2026, on top of the PWR2
Mine/Shield/Repair slice. The full evidence record is
`docs/work/verification/T-007-powerups.md` section 10. Nitro and Shock use the
engine's own `C_Body::AddForce` **before** `C_Scene::Simulate`; there is no
post-tick velocity or pose write, no engine source change and no new physics
object.

Scope labels: `nitro:true`, `shock:true`, `powerupTypes:[Bomb,Shield,Repair,Nitrous,Shock]`,
`engineIntegration:true`, `hostRulesAuthority:true`, `clientJudgement:false`,
`retailProtocol:false`, `projectileSlice:false`, `shunt:false`, `barge:false`,
`classSource:'project-class-A-assumption'`, `browserClients:2`, `fullGame:false`.

### 35.1 Module API

`native/e1_drive_lib.cpp` adds two exports, both in the 186-object module:

```c
/* Queue one engine-integrated effect for a future receiver tick.
 * kind 1 = NITRO (forward force while below target, 0.5 s/30-tick window),
 * kind 2 = BRAKE (velocity-opposed force while above target),
 * kind 3 = IMPULSE (one-shot AddImpulse). */
int e1_boost_queue(int kind, int startTick, int ticks, float targetMps,
                   float magnitude, float dx, float dy, float dz);

/* JSON: {status, active, seq, kind, kindName, startTick, ticks, remaining,
 *        applied, forceTicks, targetMps, magnitude, forceN, lastSpeed,
 *        queued, tick, effects[]} */
const char* e1_boost_state(void);
```

- `startTick >= gWorld.tick`, `ticks > 0`, finite values; otherwise the call
  returns 0 and sets `e1_last_error`.
- Up to four effects can be queued. `e1_create`/`e1_reset` clear the queue
  through `BuildWorld`.
- `e1_step` calls `ApplyBoostPreStep()` after the controls are set and **before**
  `gWorld.scene->Simulate(1/60)`. The solver, tyre model and contact response
  therefore see the force in the same step.
- NITRO applies `magnitude * mass * adjust` along the horizontal body +Z axis
  while forward speed is below `targetMps`; `adjust = 2` below half the target.
  The force window is the first 30 ticks (0.5 s) of the effect, and the effect
  remains active for its full `ticks` duration. BRAKE applies
  `-(magnitude * mass * adjust / speed) * velocity` while speed is above the
  target. IMPULSE normalises the direction and applies `magnitude` once.
- `e1_boost_state().remaining` is in 60 Hz ticks; `applied`/`forceTicks` are the
  measured window/force counts. The state is diagnostic only and does not feed
  physics.

### 35.2 Recovered values and exact targets

`web/boost-model.js` evaluates the recovered `C_HermiteCurve::Evaluate` exactly:
the serialized tangents are degrees and are converted with
`tan(deg*pi/180)/3` before the cubic Hermite basis. It reads the Nitrous and
Shock `balancingGraph` keyframes and `ClassA..D` modifiers from the PWR1
manifest; no keyframe or target is re-typed.

| item | value | source |
|---|---|---|
| Nitro force | `300 m/s^2 * mass * adjust` | `FakePhysics.cpp:191`, `:730-734` |
| Nitro force window | 30 ticks (0.5 s) inside a 78-tick (1.3 s) effect | `_value`, `FakePhysics.cpp:711/748-751`; PWR1 `Duration` |
| Nitro class-A target at 24.73 m/s | `52.758963 m/s` (118.018 mph) | exact curve, `graphValue 0.590092` |
| class B/C/D at 24.73 m/s | `50.121015 / 47.483066 / 44.845120 m/s` | exact curve * 0.95/0.90/0.85 |
| class-A target at 35.134 m/s | `64.484674 m/s` raw, capped to **55 m/s** | exact curve; project safety cap |
| Shock target at 24.73 m/s | `19.995236 m/s` (44.728 mph) | exact Shock curve, `graphValue 0.223640` |
| Shock floor | `speed - 10 mph` | `g_debugShockManagerMinSpeedScrub`, `ShockManager.cpp:52` |
| Shock radii/lifetime/damage | `InnerRadius 7`, `OuterRadius 14`, `Lifetime 1.5 s`, `DamageInflicted 100` | PWR1 `ShockBalancingData` |

The e1 roster does not record `AmaxVehicle::carClass`. M2a uses the exact
class-A target and labels it in every event
(`classSource:'project-assumption: AmaxVehicle::carClass is not recorded by the
e1 roster; M2a uses the exact class-A target'`); all four class targets are
carried in `targetTable` so the choice is auditable. The 55 m/s cap is a project
safety value (BOOST1 section 6.3), not retail data; `capApplied` records when it
binds.

### 35.3 Host authority and event flow

- The host validates the use, evaluates the target at the host-observed fire
  speed, and emits `nitro-activated` or `shock-activated` with
  `{targetPlayer, startTick, delayTicks, ticks, targetMps, magnitude, source,
  targetSource, classLetter, targetTable}` (Nitro) or
  `{targets:[{targetPlayer, targetMps, speedMps, hit, damage}], innerRadius,
  outerRadius, lifetime, damage}` (Shock).
- The host applies the event to **its own** car only. The guest applies the same
  host-sequenced event to **its own** car at `localTick + delayTicks - 1`; the
  host never simulates the guest body. The relative delay makes the event
  robust to the two pages' different tick histories.
- `effect-expired` is emitted by the host power-up model at 1.3 s (Nitro) or
  1.5 s (Shock). The guest removes the effect from the snapshot and the wasm
  effect expires independently on its own tick boundary.
- Shock damage goes through the existing host health model (100 diagnostic HP);
  a hit at 100 damage wrecks the target and the existing R1 respawn path applies.
  The Shock hit test is a documented project planar distance inside the recovered
  `OuterRadius`; PWR1 does not serialize the retail hit/falloff rule.

### 35.4 Verification

| Gate | Result | Evidence |
|---|---|---|
| wasm build | 1,012,634 B, SHA-256 `bcdc2d99…de265`, two links byte-identical | `_work/e1-drive/module/build.json` |
| Boost Node tests | **31/31 PASS** | `_work/e1-drive/boost-node-report.json` |
| Power-up Node tests | **79/79 PASS** (was 68) | `_work/e1-drive/powerups-node-report.json` |
| E1 drive verifier | **2254/2254 PASS**, original anchors unchanged | `_work/e1-drive/run.json` |
| Portable asset suite | **46/46 PASS** (concurrent map-slice additions; every step passes) | `_work/verification/suite.json` |
| PoC readiness | **23/23 PASS** | `_work/logs/e1-drive/boost-check-e1-poc.log` |
| Native CTest | **15/15 PASS** | `_work/logs/e1-drive/boost-ctest.log` |
| Two-browser `mp-powerups` | **PASS**, `clean-console-and-gates`, console **0/0** | `_work/e1-drive/browser-evidence-mp-powerups.json` |
| M1 two-browser regression | **PASS**, console 0/0 | `_work/e1-drive/browser-evidence-mp.json` |
| Solo sprint regression | **PASS**, console 0 | `_work/e1-drive/browser-evidence-sprint.json` |

The wasm boost run reproduces the BOOST1 fixture (Corvette ZR1 at
`281.2833, 1823.6890`, heading 0, 180 full-throttle ticks, pre speed
`25.1475315 m/s`). At the exact class-A target `53.21259 m/s` for that fire
speed it measured `57.822 m/s` at 0.5 s, `51.370 m/s` at 1.3 s (baseline
`33.076 m/s`, gain **+18.294 m/s**) and peak `58.608 m/s` (peak gain
**+25.532 m/s**); the effect expired at tick 259, `remaining 0`, 0 NaN, and two
fresh instances produced the same state hash. Shock at the exact
`20.116619 m/s` target measured `18.283 m/s` at 1.3 s (baseline `33.076`,
**-14.793 m/s**).

The two-browser capture (room per run, ports 8803/8813) observed both Nitro
events (host fire speed `10.15 m/s` target `44.704 m/s`, peak `48.49 m/s`;
guest `12.51 m/s` target `44.704 m/s`, peak `48.82 m/s`) and both Shock events
(guest target `8.02 m/s` at `12.50 m/s` fire speed, host target `9.30 m/s` at
`13.77 m/s`; the 10 mph floor binds at those capture speeds; the exact
sprint-speed value is `19.995 m/s` and is asserted in the Node test). Host and
guest counts were identical for the required set, including
`nitro-activated 2`, `shock-activated 2`, `wrecked 3`, `respawn 2`; console was
0/0 and the relay reported 0 dropped. Screenshots are under
`_work/e1-drive/browser-mp-powerups-nitro-*.png`, `…-shock-*.png`.

### 35.5 Limits

1. **Car class is a project assumption.** The exact curve evaluator and all
   four class targets are recovered; the e1 roster does not record
   `AmaxVehicle::carClass`, so M2a uses class A and labels it. No retail class
   assignment is claimed.
2. **No wall test.** The 55 m/s cap is arithmetic against the measured body
   length (BOOST1 section 6.3); wall penetration is not measured.
3. **Shock hit test is project-planar.** PWR1 serializes radii/lifetime/damage
   but not the retail hit/falloff rule. M2a applies 100 damage to every target
   inside `OuterRadius` by planar distance; no falloff curve is invented.
4. **One car per page.** The host applies to its own car; the guest applies to
   its own car. The M1 peer-state remote authority is unchanged.
5. **Shunt, Barge, Blindfire and projectiles remain deferred** with typed
   reasons (`POWERUP_DEFERRED`): retail Shunt is a fake-physics flip/tip plus a
   projectile hit, and the impulse/hit timing is not recovered.
6. **Same-machine capture.** Both pages run on one machine over the loopback
   relay; WAN latency, cross-machine clocks and anti-cheat are not tested.
7. **External pins refreshed.** Rebuilding the e1 module changes the module
   identity pins in the generated `_work/map-slice/amboy` and `_work/ai-driver`
   evidence. The map-slice physics hashes (`tick0`, `tick60`, state sequence)
   are unchanged; the AI driver was re-run on its existing five-reference-car
   selection and is 26/26. Only generated `_work` artifacts were regenerated;
   no probe source, tool or game data was edited.

## 36. M3 first map: `usa_amboy` (`?map=amboy`)

### 36.1 Scope and map registry

The page now has a committed map registry (`probes/e1-drive/web/map-registry.js`).
`?map=river` (the default) resolves to the exact M1 paths, layout, spawn,
best-time key and pins used before this change. `?map=amboy` resolves to the
generated map package under `_work/e1-drive/amboy/` and the read-only
`game-data/Blur/levels/usa_amboy/Level.levelphysics` bytes served at
`/map-data/usa_amboy/Level.levelphysics`.

The registry carries hard pins for the generated map/layout content hashes and
file SHA-256 values, the source `render.json`/`slice.json` file and content
hashes, and the physics SHA-256. The page verifies the map/layout content hashes,
the layout file SHA-256, the physics bytes and the fetched source package bytes
(`crypto.subtle`) before `e1_create`. A mismatch is a hard failure; there is no
silent fallback to River or to an older package.

Amboy rejects `?mp=1`, `?telemetry=1`, `?soak=1`, `?survey=1`,
`?collisionprobe=...` and River-only courses; those modes remain River-only.

### 36.2 Package build

`probes/e1-drive/tools/build_map_amboy.mjs` reads the committed MAP2/READ1 slice
and AMB1 render package read-only and writes:

| output | content |
|---|---|
| `_work/e1-drive/amboy/map.json` | one merged mesh (529,624 vertices, 1,046,844 indices), 1,201 opaque draws, 179 RGBA textures, hidden collision surface, blocked/decal labels, source pins |
| `_work/e1-drive/amboy/layout.json` | 8,673 measured samples, spawn, two checkpoints, finish, R1-style rules, declared 6 m band and coverage label |

The builder verifies every payload file against the package pins and refuses a
different content hash. Current files:

| file | bytes | SHA-256 | content hash |
|---|---:|---|---|
| `map.json` | 49,524,812 | `52acd103...e01a` | `9290bd3f...ffd4` |
| `layout.json` | 1,198,445 | `b89ae430...4f8d` | `bccb6bed...f644` |

The layout length measured from the float32 layout buffer is **2,060.595408 m**,
2.8e-5 m above the declared 2,060.595 m. Checkpoint arcs are 686.862337 m and
1,373.667341 m; the finish is the last sample. The spawn is `(230, 1128)` with
the slice heading `-2.35619449 rad`. The 6 m band is a declared
controller/respawn band, not a measured road width.

### 36.3 Render upload

The map branch in `web/packet-adapter.js` uploads **two meshes** (the single
Amboy map mesh and the selected car body) and **one draw list**: 1,201 opaque
draws x the 179 deduplicated textures. The 334 effect/decal draws and 71
decoder/alpha/runtime draws are skipped with their committed labels; no fallback
texture or colour is invented. `instancesApplied:false`; 27 sections and 366
instance descriptions are not applied. No vertex normals exist, so the existing
consumer screen-space derivative normal path is used.

The 179 textures are uploaded as `rgba8unorm-srgb` with the consumer's derived
mip chain (the same policy as the River track/car packs); the producer's
`srgbHint`/`mipHint` remain hints, not applied values.

### 36.4 Physics and scripted finish

The engine loads the complete `Level.levelphysics` through `_e1_create`; the
package collision buffers are hidden physics provenance only. Measured:

| gate | result |
|---|---|
| spawn settle | 61/61 state hashes identical to `_work/map-slice/amboy/physics-settle.json`; 4/4 contacts, finite |
| settle sequence | `sha256:d25c4592...53491b38` |
| scripted sprint | finish **222.050 s / tick 13,413**; checkpoints 68.617 s / 131.617 s in order |
| run quality | 0 respawns, max lateral 1.472 m, max speed 13.077 m/s, wheel contact on every tick, no NaN |
| replay | the recorded input sequence reproduces every state hash in a fresh module |
| run anchor | `sha256:696e5f14...9a36d4` |

The script uses `AMBOY_CONTROL` (12 m/s cruise, short pure pursuit) because the
measured path turns back on itself several times. This is a controller choice,
not recovered map or vehicle data; physics is unchanged.

### 36.5 Verification and capture

`probes/e1-drive/tools/verify_e1_map.mjs` runs 23 checks: builder determinism,
file/content pins, page validator, 61/61 settle hashes, scripted finish,
checkpoints, 0 respawn, finite/contact, replay. Browser evidence is produced by
`capture_browser.mjs --mode map` at start/checkpoint/mid/finish with console 0
and screenshots under `_work/e1-drive/browser-corvette-zr1-stock-map-amboy-*.png`.
The capture verdict is `clean-console-and-gates` (0 messages / 0 errors or
warnings); the finish frame reports 222.050 s with both checkpoints.

### 36.6 Limits

1. First-map integration only: one map, one car at a time, no opponents, props,
   power-ups, AI, lap or retail race director.
2. The path is measured draw coverage, not a retail start line. The 6 m band is a
   declared rule, not a measured width.
3. 27 unsupported sections (billboards) and 366 instance descriptions can add
   surfaces; collision excludes the Box, four Cylinders and the
   InstancedTriangleMesh.
4. 334 additive/decal draws and 71 diagnostic draws are skipped; no additive pass
   exists.
5. No vertex normals; derivative normals are the documented fallback.
6. No full-game claim.

### 36.7 Second map: `spa_barcelona_gracia` (MAP5)

The map integration was generalized rather than copied: `tools/map_package_builder.mjs` holds the package reader and emits the same map/layout schema for `usa_amboy` and `spa_barcelona_gracia`; the two `build_map_*.mjs` files are thin instantiations. `web/map-package.js` is the shared pin/shape validator and merger, and the packet adapter derives its map provenance from the merged document instead of Amboy literals. The Amboy builder still reproduces both committed files byte-for-byte.

Gracia inputs: `_work/map-slice/gracia` + `gracia-render`. The generated map document is 72,616,715 B (2,627 opaque draws / 365,451 triangles / 734 textures / 3,247,360 B), the layout is 312,569 B (2,571 samples, 624.913781 m). 953 blocked draws are labelled (518 Racification, 426 BC3-alpha, 5 decoder-size, 4 runtime); 4 unsupported sections and 2,714 instance descriptions are not applied; there are no vertex normals.

Physics settles 61/61 on the package hashes (`sha256:4fd8ae0c...6e8e30`) at spawn `(336, -23)` heading `2.15879893`. The scripted sprint finishes at **66.266667 s / tick 4,066** with both checkpoints, 0 respawns and a bit-identical replay. Browser capture is `clean-console-and-gates` (console 0) at start/checkpoint/mid/finish. Gracia map verifier 23/23; River verifier 2254/2254; suite 50/50; checker 23/23. Evidence: `docs/work/verification/T-007-map-gracia.md`.

## 37. M3 - the online room selects a map (River / Amboy / Gracia)

The room protocol already carries a `map` selector in `room.create`,
`player.select` and the `room.started` room view. M3 uses that field instead of
adding a wire message.

### 37.1 Contract

- **Host-only selection.** The lobby select is enabled only for the host;
  `player.select {map}` remains host-only in the unchanged room service. Guests
  see the broadcast value and cannot override it through `?map=`.
- **Typed record.** Each client derives
  `{id, packageHash, layoutHash, physicsHash}` from `web/map-registry.js`
  `mpPins`. River has no package document, so its record pins the committed
  `geometry.json`, the 310 m layout and `Level.levelphysics`.
- **map-ready.** The page loads the room map, measures the actual hashes and only
  then enables READY. The existing room ready flag is the map-ready report; the
  host start gate requires every player ready and its own verified record.
- **Refusal.** A record mismatch throws `MpMapError` with
  `MAP_PACKAGE_MISMATCH`; the lobby shows the field/value diff. There is no
  River fallback.
- **Switch.** A host map change clears ready on both pages and serializes one
  reload per page, with a loading status and measured bytes/time. Changing the
  map after `room.started` is not supported.
- **Finish report.** The reported tick is derived from the local race time
  (`round(seconds·60)+countdown`), so a respawn rebuild cannot introduce a
  one-tick table difference. The guest's own report is the result row and is
  accepted while the room is open; a report after `room.finished` is rejected
  with `MP_ROOM_CLOSED`. Host-side projected detection is a diagnostic, not a
  start/finish gate.

### 37.2 Rules mapping

The released `probes/race-rules` allow-list predates M3 and only accepts
`310m`/`lap`. The page projects an Amboy/Gracia point-to-point layout through the
equivalent sprint mode (`courseId` copy `310m`, `sourceCourseId` kept,
`verifyLayoutHash:false`, samples/gates/hash untouched). This is a rules-mode
mapping, not a geometry, physics or map value. `buildMpResult` still uses the
original layout and therefore reports the real `courseId` and finish gate.

### 37.3 Node gates

| gate | result |
|---|---|
| `verify_e1_drive.mjs` | **2265/2265** checks, 0 failures (22 MP protocol, 7 map-record checks) |
| map records | River/Amboy/Gracia pin records match the committed file hashes |
| refusal | identical records agree; a mutated physics/layout record throws `MpMapError` / `MAP_PACKAGE_MISMATCH` |
| room selection | host selects Amboy, guest sees it, guest selection rejected `NET_NOT_HOST`, `room.started` carries the id |
| shared result | `buildMpResult` on Amboy/Gracia layouts keeps the measured finish gate and race times |
| finish contract | time-derived reported tick; late guest report accepted while open; closed-room report rejected `MP_ROOM_CLOSED` |

### 37.4 Browser races

Two real wasm pages, the unchanged room service and a host-selected map. Both
pages report the same map record before READY; the host runs `RaceSession` and
both overlays render the same shared table.

| map | host row | guest row | console |
|---|---|---|---|
| River | tick 970 / 14.666667 s | tick 1074 / 16.400000 s | 0/0 |
| Amboy | tick 13,410 / 222.000000 s | tick 14,344 / 237.566667 s | 0/0 |
| Gracia | tick 4,065 / 66.250000 s | tick 4,253 / 69.383333 s | 0/0 |

Both rows equal the local finish time within one tick (exactly in these runs);
shared rows/hashes are identical on both pages. The MP start grid probes both
slots with the real engine before the race world is created. Gracia's released
lateral slot 1 is airborne at tick 91, so it uses the measured spawn + path
tangent longitudinal grid (slot 1 2.2 m ahead at `(338.001826, -23.912520)`,
slot 2 the measured spawn `(336, -23)`), giving 0 host/guest respawns; River and
Amboy keep the lateral grid because both slots probe clean. Evidence:
`docs/work/verification/T-007-mp-maps.md`.


### 37.5 Limits

1. Two players, one room map, one car for both bodies; no mid-race switch.
2. Amboy/Gracia power-ups are not placed; `?powerups=1` is rejected on those
   maps. No AI.
3. The host still runs only its own physics body (peer-state guest), so this is
   not host-simulated two-body authority or anti-cheat.
4. Start-grid ground validity is established by a 140-tick real-engine probe per
   candidate slot at load time; there is no continuous grid validation or
   arbitrary terrain search beyond the measured spawn/tangent candidates.
5. Package loading is a blocking fetch/parse per page with a visible loading
   status; there is no streaming, progressive upload or map download.
6. No full-game claim.

---

## 38. M4 - host-simulated AI opponents (0-3) in the online room

Status: implementation + evidence, 7 November 2026. `?ai=0..3` (host URL or lobby
controls) adds host-controlled AI to the existing two-human room on River,
Amboy and Gracia. The AI is the committed original centre-line driver, not
retail AI.

### 38.1 Contract

- Host-only lobby: AI count 0-3, one roster car and one skill profile per AI.
  Guests see the list read-only; guest `?ai=` parameters are rejected.
- `window.__mp.setAi({count, cars, profiles})` is the same host-only mutation;
  the start gate requires all humans ready and the AI records built.
- Participant ids are `ai-1`...`ai-3` in slots after the humans (3-5). The room
  roster is unchanged: AI is not a room player.
- The AI relay (project-specific HTTP beside the unchanged room service) carries
  `roster`, 20 Hz `pose` and final `result` messages. The room's `input`/`state`
  relay is untouched.
- Typed refusals: invalid count/car/profile, and Gracia + Dodge Challenger
  (`ai-spawn-unsupported`; the driver owner measured the front axle unloaded at
  the committed spawn).

### 38.2 Host simulation

- One wasm module instance per AI (the module has one global world), created at
  a grounded slot with that car's committed `.fields`; the host steps it once per
  60 Hz host tick, zero input during the countdown, then the committed
  `ai-driver-browser.js` input.
- `web/ai-driver-browser.js` is a verbatim copy of `probes/ai-driver/ai-driver.mjs`
  with only the crypto import/hash helper swapped. The Node gate compares the
  controller source and drives both copies on the real wasm: identical inputs
  and the AI1 reference finish ticks (Audi 849, Dodge cautious 1014).
- Map control follows the driver owner: `MAP_CONTROL` on Amboy/Gracia, Amboy
  `{minSpeed:3.5}`; River keeps `SPRINT_CONTROL`. Gracia's AI start uses the
  measured spawn-row lateral grid (2.2/-2.8 m and 0/-2.8 m) because the released
  lateral rows and behind-spawn candidates have no ground; every AI slot is
  probed with the real engine for 140 ticks before the final world is created.
- `RaceSession` owns AI checkpoint/finish/respawn. On `respawn` the host rebuilds
  the AI world, `reprime`s the driver and `rejoin`s the progress row. A stuck AI
  is a tick-capped DNF with a typed reason, never a guessed time.
- AI is not added to the power-up model, so it cannot pick up, use or be hit by
  power-ups in this gate.
- The host delays its own `client.finished` report until all AI are terminal, so
  `room.finished` and the AI result reach both pages together.

### 38.3 Client rendering and result

- `PacketConsumer.setGhostFrames()` reserves one ghost-pipeline car slot per
  remote (human peer + AI). The host renders its own AI through the same
  interpolation buffer; the guest renders only relayed poses. Cyan = human,
  amber = AI; 3-tick delay, position/quaternion interpolation, bounded
  correction, static wheel spin (the E1 snapshot has no wheel angle), no
  collision.
- `#mp-remotes` labels every remote as `AI · <profile> · AI n · <car> · 20 Hz
  host relay · no collision`; the M1 single tag is hidden only when AI is
  present.
- `buildMpResult` merges human and AI rows with the same tick/time convention
  and orders by finish tick then slot. With zero AI the object/hash are
  byte-identical to M1.

### 38.4 Measured result

River (host + guest + 2 AI, console 0/0, shared hash `sha256:110d4f21…`):

| P | Participant | Car / profile | Tick | Time |
|---:|---|---|---:|---:|
| 1 | `ai-1` | Audi R8 V10 / reference | 953 | 14.383333 s |
| 2 | Host | Corvette ZR1 | 970 | 14.666667 s |
| 3 | Guest | Corvette ZR1 | 1120 | 17.166667 s |
| 4 | `ai-2` | Dodge Challenger / cautious | 1128 | 17.300000 s |

Amboy (`sha256:6b304d0b…`): ai-1 13,354 / 221.066667 s, host 13,410 / 222.000000 s,
guest 14,684 / 243.233333 s, ai-2 15,617 / 258.783333 s. Gracia
(`sha256:4a60b2c5…`): ai-1 3,910 / 63.666667 s, host 4,065 / 66.250000 s, guest
4,347 / 70.950000 s, ai-2 4,689 / 76.650000 s. All AI had 0 respawns and a
per-AI state-sequence hash. The River AI times differ from the AI1 start-pose
anchors by the grid row offset (~0.23 / 0.40 s), not a controller change.

Guest reconnect (River): the guest's socket was dropped and resumed; the host AI
kept ticking (403 → 489 ticks) and the guest's AI pose samples continued
(264 → 324), with the same player id/slot.

### 38.5 Verification

- `verify_e1_drive.mjs`: **2281/2281** (16 MP AI checks;
  `mp-ai-node-report.json`).
- Browser `--mode mp-ai`: River/Amboy/Gracia **clean-console-and-gates**, console
  **0/0**; River includes the reconnect check.
- Regressions: River M1 rows unchanged (970 / 1074), Gracia M3 MP unchanged
  (4065 / 4253), M2 power-up capture clean, suite **57/57**, checker exit 0.
- Full record: `docs/work/verification/T-007-mp-ai.md`.

### 38.6 Limits

Host-only simulation; no client AI simulation, no car-to-car physics, no
rubber-banding/traffic, no AI power-ups, no mid-race AI change; Gracia + Dodge
refused; only River/Amboy/Gracia; loopback HTTP relay; no retail AI or full-game
claim.

---

## 39. WPN1 - Blindfire/Bolt, Shunt and Barge in the online race

**Date:** 8 November 2026. **Scope:** `probes/e1-drive/**`, `_work/e1-drive/**`,
`_work/logs/e1-drive/**`, this document, `docs/work/verification/T-007-powerups.md`.
The PWR4 artifacts (`_work/powerups/projectiles.json`,
`probes/powerups/rules/projectiles.js`) are read-only inputs.

### 39.1 What changed

`PowerupModel` now composes the PWR4 projectile model with the PWR1 health/shield
world instead of re-typing its values:

- `POWERUP_SLICE_TYPES` is `Bomb/Shield/Repair/Nitrous/Shock/Blindfire/Shunt/Barge`;
  only `SuperShield` remains deferred.
- The host owns fire ids, `seq`, charges, travel, hit judgement and expiry.
  Clients still send only `{type:'use',slot}` intents.
- PWR4 judges travel/hit/expiry; every hit is applied exactly once through
  `world.damage`, so shield absorb, 100 HP wreck and respawn stay in one model.
- The host syncs player position/forward/speed/health/alive/mass into the PWR4
  car records each tick. The PWR4 internal damage call is replaced by a no-op.
- Charges are runtime-only: a Blindfire pickup grants 3 shots, Shunt/Barge 1.
  A Blindfire slot stays in the inventory with 2/1 charges after a shot; the
  item is removed at 0.
- Shunt target selection uses the recovered rule: distance <= 500 m,
  forward dot > cos 45 deg, score `(1-dot)*sqrt(distance/500)`, lowest wins.
  The host has no camera LOS, so the engine forward is used and labelled.
- The target sphere radius is the documented project envelope circumradius
  `sqrt(1.49^2 + 0.84^2) = 1.7104677722775135 m` from the 2.98 x 1.68 x 1.35 m
  `CAR_ENVELOPE`. Barge reuses the full envelope for its extents fudge.
- A Shunt hit emits `shunt-hit` with a `provisional-impulse` object
  (`20000 N*s`, `deltaV = 20000 / massKg`, direction = projectile direction).
  Each page applies it to its own car through `e1_boost_queue` kind 3; host and
  guest never simulate the other body.
- Barge is the recovered 7.0 m radius + 0.5 m runtime padding, 2.0 m inner band,
  0.4 s duration. With the documented envelope the outer/inner bands are
  **8.08 m / 6.08 m**. Major/minor both apply 100; the jink kind is emitted with
  `magnitude:{status:'not-serialized'}` and no linear vehicle impulse.
- Dynamic objects do not exist in this slice, so the serialized
  `PerkForceEffects` table is recorded but no `dynamic-object-impulse` is
  emitted.
- Presentation: the existing octahedron marker pass draws pickups, mines,
  shield/nitro/shock and live projectiles; a second bounded flat annulus pass
  (4 slots) draws the Barge radius. HUD shows charge counts and the live
  projectile/barge countdown; the event feed is unchanged.

### 39.2 Recovered vs provisional

| field | value | status |
|---|---:|---|
| Blindfire Speed / Radius / Damage | 300 m/s / 0.2 m / 50 | XT (`pickups.bin`) |
| Blindfire lifetime / charges | 10 s / 3 | runtime-only (shipped source defaults) |
| Shunt Radius / Damage | 0.75 m / 100 major, 50 minor | XT + minor rule |
| Shunt speed | `clamp(max(forward+15,10),60,110)` | runtime-only |
| Shunt homing | `clamp(d^2/50^2,0.3,1.0)*50 + targetSpeed`, 65 deg/s | runtime-only |
| Shunt lifetime / charges | 40 s / 1 | runtime-only |
| Shunt target | 500 m / cos 45 deg / lowest score | recovered source rule |
| Barge Radius / Damage / Duration | 7.0 m / 100 / 0.4 s | XT |
| Barge padding / inner band / extents fudge | +0.5 m / 2.0 m / 1.75 m | runtime-only |
| Barge outer / inner with project envelope | 8.08 m / 6.08 m | derived, documented envelope |
| Shunt linear impulse | 20 kN*s, `source:'provisional-impulse'` | project design choice, not retail |
| Barge jink magnitude | `not-serialized` | typed unknown |
| target collision shape | 1.7105 m sphere from the documented envelope | project envelope, not a recovered retail hull |
| ground alignment | straight-line travel, no level ray | not modelled |
| Shock (already M2a) | speed scrub + 100 base damage | unchanged |

### 39.3 Host event table

| event | payload (minimum) | source |
|---|---|---|
| `projectile-fired` | `seq, authority, projectileId, pickupType, level, ownerId, origin, direction, speedMps, lifetimeSeconds, lifetimeSource, chargesRemaining, targetId?, homing?` | PWR4 |
| `projectile-hit` | `seq, projectileId, pickupType, targetId, hitType, damage, position, fakePhysics, hitTest` + `appliedDamage/absorbed/health` | PWR4 + PWR1 damage |
| `projectile-expired` | `seq, projectileId, pickupType, reason:'old-age', at, lifetimeSeconds` | PWR4 |
| `shunt-hit` | `seq, projectileId, targetId, hitType, damage, fakePhysics, impulse{status,source:'provisional-impulse',impulseNs,massKg,deltaV,direction}` | PWR4 + project impulse |
| `barge-activated` | `seq, bargeId, ownerId, position, radius, durationSeconds, hitTest, chargesRemaining` | PWR4 |
| `barge-hit` | `seq, bargeId, ownerId, targetId, hitType, damage, distance, outerRadius, innerRadius, fakePhysics` | PWR4 |
| `effect-expired` | `effectId, kind:'barge', ownerId, at` | PWR4 |
| `projectile-rejected` | `reason:'no-eligible-target'`, targeting rule | host |
| `use-rejected` | `reason:'no-ammo'/'empty-inventory'/'projectile-model-unavailable'` | host |

Every translated event is re-emitted by `world.emit`, so it carries the host's
monotonic `seq`/`authority`; PWR4's own seq is never put on the wire.

### 39.4 Verification

| gate | result |
|---|---|
| `powerups_model_tests.mjs` | **107/107 PASS** (39 new projectile/weapon checks) |
| PWR4 `projectiles.test.mjs` | **19/19 PASS** (unchanged) |
| PWR1 `tests.mjs` | **9/9 PASS** (unchanged) |
| `verify_e1_drive.mjs` | **2281/2281 PASS**, 0 failures |
| `verify_asset_probe.py --skip-build` | **57/57 PASS** |
| `check_e1_poc.py --json` | **23/23 PASS**, exit 0 |
| two-browser `--mode mp-powerups` | verdict `clean-console-and-gates`, console **0/0** |
| host/guest event counts | identical for all required types, including `projectile-fired 5`, `projectile-hit 4`, `projectile-expired 1`, `shunt-hit 2`, `barge-activated 2`, `barge-hit 2` |
| weapon evidence | Blindfire 50 damage both directions; Shunt `flip-forward` + `deltaV 12.5 m/s` + engine impulse kind 3; Barge radius 7 / 0.4 s / 100 damage and host marker ring 8.08 m |
| marker pass | 16 octahedron slots + 4 ring slots, 0 dropped; guest ring draws 57 |

Screenshots: `_work/e1-drive/browser-mp-powerups-blindfire-host.png`,
`browser-mp-powerups-shunt-guest.png`, `browser-mp-powerups-barge-host.png`,
`browser-mp-powerups-barge-guest.png`. Evidence:
`_work/e1-drive/browser-evidence-mp-powerups.json`,
`_work/logs/e1-drive/mp-capture-powerups-wpn1.log`,
`_work/logs/e1-drive/powerups-node-wpn1.log`.

### 39.5 Limits

- No retail fake-physics magnitude, no retail camera-LOS target selection, no
  ground ray, no dynamic objects, no damage-mode/mod multipliers.
- The Shunt linear impulse is a labelled project choice; retail is a
  FakePhysics flip/tip.
- Target radius/extents come from the documented project envelope, not a
  recovered vehicle hull; missing inputs are typed.
- Capture weapon fire is host-staged (`staged:true`) so both directions hit
  deterministically; normal play still uses the host forward-cone target rule.
- The Barge ring is a presentation proxy, not a retail FX asset.
- No full-game or retail-parity claim.

## 40. Chunked geometry: level + selected car (T-007/chunking)

### 40.1 What changed

The 106,864,802 B combined `geometry.json` is now a debug artifact. The builder
writes a 9,662,959 B `level.geometry.json` (collision provenance, 22 level-prop
draws, 394 track draws, 140 albedo images, hidden collision), a 10,778 B
`base.geometry.json` for map-package mode, one 5.47–9.02 MB
`cars/<slug>.geometry.json` per roster car and a 16,858 B
`car-bodies.index.json` pinning every file by SHA-256, byte size, draw count and
texture/UV references.

`web/geometry-chunks.js` is the shared browser/Node contract. The page loads the
index and level once, then only the selected car; `assembleGeometry` puts exactly
one body into `carBodies`, so `packet-adapter.js` and the packet schema did not
change. A car switch preflights and caches the next chunk, rebuilds the
engine/session in place and updates `?car=` with `history.replaceState` (no page
reload). Missing, short or hash-mismatched chunks raise a typed `ChunkLoadError`
(`CHUNK_CAR_MISSING`, `CHUNK_CAR_SHA256`, …); there is no fallback body.

The MP room roster now drives per-player cars. Each page loads its own car chunk;
the peer's chunk is uploaded once as a second ghost-pipeline mesh and drawn with
the peer's wheel rest matrices. A failed peer chunk appears as
`state.mp.remote.carChunk {status:"error", code, error}` and is not drawn.

### 40.2 Measured bytes

| page assets | before | after |
| --- | ---: | ---: |
| geometry | 106,864,802 B | 9,662,959 + 8,468,680 = 18,131,639 B |
| physics + layout + fields + spawn | 2,339,419 B | 2,339,419 B |
| total | ≈109.20 MB | ≈20.47 MB (-81.3 %) |

The largest car chunk (Lotus, 9.02 MB) gives ≈20.9 MB; the debug combined file is
never fetched. A second car adds only its own chunk and no level bytes.

### 40.3 Verification

`verify_e1_drive.mjs` parses and pins the index/level/base and all 15 car chunks,
proves each body and the level half are structurally identical to the combined
artifact and produces every per-car packet from `assembleGeometry(levelChunk,
carChunk)`. The result is **2285/2285 checks**, including the unchanged per-car
packet hashes and the 301-tick state anchors.

Full chunk sizes, hashes, load flow and limits:
`docs/work/verification/T-007-chunking.md`.

## 41. Vehicle batch 2: 25 cars (T-007/batch2)

### 41.1 What changed

`probes/e1-drive/cars/roster.json` grew from 15 to **25 cars**. The ten new
entries are the seven high-confidence class-C records
(`Dodge_Challanger_Tuner1stplay`, `Nissan_350ZNismo_Stock grpc`,
`Chevrolet_Camaro_StockE3`, `VW_Beetle_Offroad`, `Foose_Stallion_Stockgrpc`,
`Chevrolet_Camaro_Ratdrift`, `Covette_C3_Rat`) and three class-B cars
(`BMW_M3E92_Tuner`, `Koenigsegg_CCXR_Stock`, `Toyota_SupraTRD_Stock`).

A class-C entry carries an explicit `model` plus the record-level evidence
(AmaxVehicle tag/record/dynamics ref) copied from
`_work/vehicle-pipeline/c-aliases.json`. `build_all_manifests.py` checks that the
tag lowercased + `.model` is exactly that file and that the supplied record id
matches; there is no nearest-name or similarity mapping. The seven bodies were
staged by V3; the integration reuses the committed builders.

The chunked pipeline is unchanged in shape: one level, one `cars/<slug>` chunk
per car, the index and the debug combined file. The chunk index now pins 25
chunks; the ten new chunks are 6.15–8.49 MB. The 25 car chunks total
172,103,239 B, but the page still loads only the level and one selected car
(≈20.6 MiB with the default Corvette, largest chunk 20.7 MiB).

### 41.2 New per-car behaviour

- 310 m: all ten finish with 2/2 checkpoints, 0 respawn, 0 NaN (14.283–15.333 s).
- 29 m: all ten finish (2.483–3.300 s). `corvette-c3-rat` needs a declared
  deterministic `lane-hold-recovery` controller because the P37 throttle hold
  leaves it 0.4 m outside the 6 m gate and its lateral speed stays below the
  generic 2.5 m/s damper threshold. The controller is on the roster entry, is
  applied only to the 29 m layout, and leaves the other 24 cars' inputs and
  hashes bit-identical.
- Lap/free/restart/ghost: all ten complete the 3-lap loop, the free-roam
  containment run, a same-instance restart and both committed ghosts (50 records
  total).
- Telemetry: `chevrolet-camaro-ratdrift` and `corvette-c3-rat` declare one
  typed lateral first-reversal miss at the fixed 36-tick phase; the miss is
  recorded as an anomaly, all answered reversals keep their measured lag, and
  no other car is allowed a miss.

### 41.3 Verification and page bytes

`verify_e1_drive.mjs` is **3665/3665 checks, 0 failures**. The original 15 cars'
drive/310 m/29 m/free/lap state anchors did not move; the per-car `packet` hash
moved for all cars because it is the whole-packet document identity of the
25-car `car-textures.json` (same documented behaviour as P49/P55/P59/P73b).

| page assets | batch 1 | batch 2 |
|---|---:|---:|
| level + one car chunk | 9,662,959 + 8,468,680 = 18,131,639 B | 9,663,610 + 8,468,680 = 18,132,290 B |
| physics + layout + fields + spawn | 2,339,419 B | 2,339,419 B |
| total | ≈20.47 MB | **20,471,709 B (≈20.47 MB)** |

The largest car chunk (Lotus, 9,018,247 B) gives ≈21.02 MB. The page never
fetches the 181,757,706 B combined document and never fetches 25 bodies. Full record, chunk pins and browser evidence:
`docs/work/verification/T-007-vehicle-batch2.md`.

### 41.4 External pins

The portable suite stops at `prop-collision-v2` (44/45) because its V1
regression pins the whole 15-car `geometry.json` hash; the collider data and the
23 driven-line exclusions are unchanged. `tools/check_e1_poc.py` still asserts
three hard-coded 15-car totals. Both files are outside this task's ownership and
need a re-pin by their owners; details are in the batch-2 verification document.
