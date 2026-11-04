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
| `corvette.c3.race.body` | committed packet (`scene_inspect.exe`, 80 draws) | 30,591 | 36,193 | object-local |
| `river.collision.surface` | `Level.levelphysics` (176/282 inside the run box) | 176 | 282 | world |

103 draws total (22 props + 1 surface + 80 car). No colour, texture or transform
is invented:

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
is a per-tick operation. The verifier's 30 checks include "every tick hash the
browser-side implementation computes equals the committed Node definition", so
the two implementations are proven to agree on all 301 real payloads, not on a
toy vector.

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
& $node probes/e1-drive/tools/verify_e1_drive.mjs          # 30/30 checks
& $node probes/e1-drive/tools/capture_browser.mjs          # 3 screenshots, console gate
```

Artifacts:

| path | content |
| --- | --- |
| `_work/e1-drive/module/{e1_drive.mjs,e1_drive.wasm,build.json}` | module + build evidence (hashes, flags, object counts) |
| `_work/e1-drive/geometry.json` | 3 meshes, 23 static draws, 80 car draw ranges, materials, light, provenance |
| `_work/e1-drive/track.json` | 282 collision triangles + selection record |
| `_work/e1-drive/packet.json`, `packet.validation.json` | the validated 301-tick packet |
| `_work/e1-drive/state_a.json` | all 301 per-tick states, positions, speeds, contacts, hashes |
| `_work/e1-drive/run.json` | the evidence document (module, drive, determinism, packet, 30 checks) |
| `_work/e1-drive/browser-evidence.json`, `browser-*.png` | browser runs, console log, screenshots |
| `_work/logs/e1-drive/` | build, verify and Edge logs |

---

## 8. Limits (carried in the packet's own `diagnostics`)

- **Diagnostic materials.** Identity albedo, one directional light,
  screen-space-derivative face normals. No texture pixels, shadow, post,
  particles or effects. No claim of visual fidelity.
- **The road is collision geometry, not retail render geometry.** It is drawn
  with the same diagnostic albedo and is labelled (`materialId: null`,
  `diagnostics.extras.track`). Nearly edge-on slabs speckle because derivative
  normals are unstable at grazing angles — visible as the noisy band in the mid
  screenshot.
- **Wheels are not drawn.** The committed car draw set has body draws only; wheel
  contact, suspension, spin and position are in the state and the HUD.
- **Box gravity proxy, neutral surface scalars, unresolved XT physics handle** —
  the T-005d labels, unchanged (`carBodyShape: box-from-XT-geometry`,
  `surfaceMappingsApplied: false`, `physicsParametersResolved: false`).
- **Car mesh frame alignment is not recovered.** The body is drawn in the engine
  body frame; the retail mesh import that defines the offset is out of scope, so
  the body can be rotated/offset relative to the chassis.
- **The drawn surface is a box, not the track.** 282 triangles around the run;
  driving far enough leaves the drawn surface even though the physics still has
  collision geometry.
- **One car, one camera, no game.** No audio, opponents, race rules, HUD beyond
  diagnostics, culling or engine streaming. One manual reset re-uploads geometry
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
   the wheels can be drawn instead of only sampled.
4. Then the acceptance gates of `e1-renderer-strategy.md` §"Decision gate": a
   finishable lap, unambiguous boundaries, 60 Hz with a clean console.
