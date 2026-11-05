# T-007/E1g verification — several real cars in the E1 drive slice

**Date:** 5 November 2026
**Owner:** P23 (sub-agent)
**Scope:** `probes/e1-drive/**`, `_work/e1-drive/**`, `_work/logs/e1-drive/**` and
this document. No engine patch, no harness change, no `probes/render-packet/`
change, no project source, no `upstream/`, no `game-data/` write. No new physics,
no renderer change, no race rules/audio/multiplayer claim.

**Result: five cars decoded from the real `RP_CarDynamics` records are selectable
at runtime, each drives the same scripted 300 ticks with a distinct deterministic
state sequence, and each is captured in headless Edge/WebGPU with a clean
console and one geometry upload.**

## Gate

```powershell
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"

& $py   probes/e1-drive/tools/car_roster.py             # 62/62 records pass, 5 selected
& $node probes/e1-drive/tools/verify_e1_drive.mjs       # 164/164 checks
& $node probes/e1-drive/tools/capture_browser.mjs       # 20 captures, clean console
& $py   tools/verify_asset_probe.py --skip-build        # 29 checks, no regression
```

All **PASS**.

## Car roster

| slug | record | id | drivetrain | mass | wheelbase | field file |
| --- | ---: | ---: | --- | ---: | ---: | --- |
| `corvette-zr1-stock` (default) | 37 | 1554942492 | RWD | 1600 kg | 2.652 m | `_work/e1-drive/cars/corvette-zr1-stock.fields` |
| `lotus-exige-cup260-stock` | 15 | 805568925 | RWD | 890 kg | 2.323 m | `…/lotus-exige-cup260-stock.fields` |
| `dodge-challenger-stock` | 9 | 528964602 | RWD | 1700 kg | 2.981 m | `…/dodge-challenger-stock.fields` |
| `ford-focusrs-stock` | 50 | 2563977008 | FWD | 1400 kg | 2.787 m | `…/ford-focusrs-stock.fields` |
| `audi-r8v10-stock` | 55 | 2936683857 | AWD | 1600 kg | 2.635 m | `…/audi-r8v10-stock.fields` |

- Source: `gamedata\xt\racingphysics.bin` (73,420 B, SHA-256
  `048ef93a4dc94351…b2e9`), **62 `RP_CarDynamics` records**, decoded by the T-005d
  extractor `engine/harness/t005d-vehicle/car_xt.py` (SHA-256 `9f216c72…c924`).
- Completeness gate: positive mass/wheelbase/tracks/tyre radii/limiter/torque
  scale/first gear/final ratio/brake forces, `≥ 2` gear ratios / torque points /
  front and rear grip points, `1 ≤ topGear ≤ ratios`, `driveType ∈ {0,1,2}`, every
  `f32` finite. **62/62 pass**; no record had to be excluded, so the roster is a
  scenario choice (one baseline + one car per drivetrain), not a repair. The five
  are declared in `probes/e1-drive/cars/roster.json` and checked against the
  decoded name, record id and record index.
- Two fields are `0.0` in all 62 records (`gears.reverseGearRatio`, tyre
  `loadDependence`); they are carried as decoded, and the script never selects
  reverse, so this slice makes no claim about either.
- The default car's field file is **byte-identical** to
  `_work/engine-vehicle-spike/car.fields` (asserted by `car_roster.py`).

## Scripted drive per car

Same spawn `(-88, 1050)`, heading +X, same level, same script
(120 throttle / 120 coast / 60 brake), same wasm module
(**1,003,249 B**, SHA-256 `7b977ea7…9dabc`, 186 objects — unchanged, no rebuild).

| car | travel | peak m/s | t=120 | t=240 | t=300 | contacts | NaN | state sequence hash |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Corvette ZR1 | 45.378 m | 15.439 | 14.986 | 11.044 | 0.448 | 301/301 | 0 | `sha256:83f765902ce5c610889e8a27e9bfe747f86142bddea24ecb987b29be29008e1f` |
| Lotus Exige Cup260 | 40.641 m | 15.084 | 14.649 | 8.404 | 0.274 | 301/301 | 0 | `sha256:8d6cd4d456e5ddc47dc21d50f417134298cb366fd1c3a486b80d844e0dac66c2` |
| Dodge Challenger | 41.041 m | 13.850 | 13.350 | 10.056 | 0.225 | 301/301 | 0 | `sha256:b1c63d209a55c974662d87a83f03568db4de981730ddf08dd409074a7220a7e2` |
| Ford Focus RS (FWD) | 30.664 m | 12.359 | 11.663 | 5.871 | 1.344 | 301/301 | 0 | `sha256:fb3909b6fdcc32e6a710a57ab092c0523641ee6c76e9c82cdcbb7bee02c9bdb6` |
| Audi R8 V10 (AWD) | 69.447 m | 21.543 | 21.216 | 16.914 | 0.928 | 301/301 | 0 | `sha256:5b4ae49dc38fc8e9c2ff2f8292739f1e07b2945dbb3a9a02dae9993724fd4067` |

- **Distinctness:** five distinct state sequences, five distinct tick-0 states,
  five distinct packets, five distinct record ids and three drivetrains (asserted).
- **Determinism:** each car run twice in separate wasm module instances →
  identical per-tick hash sequences; `e1_reset()` + 30-tick replay reproduces the
  first 30 ticks inside one instance; every per-tick hash distinct (301/301).
- **No regression:** the Corvette's sequence hash equals the T-007/E1d value
  exactly (pinned as an anchor check).
- Packets: 301 ticks, 103 draws each, validator 0 errors, every per-tick hash
  recomputed with the committed definition, every matrix rigid, and
  `diagnostics.extras.drive.car` names the car.
- Per car and per tick: `e1_info().car` is the requested record, dt 1/60, 180-tick
  settle, tick 0 at rest on four wheels.

## Browser evidence

Headless Edge (`--headless=new --enable-unsafe-webgpu`), CDP, 1600×900, adapter
`nvidia / blackwell`. Captures at ticks 0/150/240/300 for each car (20 total).

| car | t=150 | t=240 | t=300 | console | uploads per capture |
| --- | --- | --- | --- | --- | --- |
| Corvette | 14.53 m/s | 11.04 | 0.45 | 0 | 3 / 1,090,380 B |
| Lotus | 13.72 | 8.40 | 0.27 | 0 | 3 / 1,090,380 B |
| Dodge | 13.18 | 10.06 | 0.22 | 0 | 3 / 1,090,380 B |
| Focus RS | 11.04 | 5.87 | 1.34 | 0 | 3 / 1,090,380 B |
| Audi | 20.56 | 16.91 | 0.93 | 0 | 3 / 1,090,380 B |

- **0 console messages of any kind** across all 20 loads; one uniform write and
  one `drawIndexed` per draw per frame; geometry uploaded **once per mesh** and
  never grows between frames or cars.
- Every capture: the page reports and selects the requested car (selector lists
  the whole roster), the **state hash equals the node producer's** for that car and
  tick, the **car matrix is bit-identical**, the camera agrees within 1e-6, and the
  car is framed by the chase camera.
- **Packet-hash agreement: 18 of 20 exact.** The two exceptions (Dodge tick 0,
  Focus RS tick 240) differ by one ulp in the camera (max |Δ| 2.3e-13) with a
  bit-identical car matrix. Measured cause: `Math.atan2` returns
  `-1.5707963889283709236` in Node 24's V8 but `-1.5707963889283707` in Edge 156's
  V8 for the same input; the chase-camera yaw comes from `atan2` of the car's
  forward axis. This is a JS-engine transcendental difference, not a simulation
  difference, and is recorded in `packetHashAgreement` instead of being hidden.
- **Camera occlusion:** at tick 150 the Focus RS, Dodge and Lotus are still among
  the start-area props, so those three `-mid.png` frames show terrain (HUD still
  shows car/speed/position). Their `-coast.png` frames show the car on the surface;
  the extra tick was added for usable per-car visual evidence. The camera has no
  occlusion avoidance (pre-existing, out of scope here).

Screenshots: `_work/e1-drive/browser-<slug>-{start,mid,coast,end}.png` (+ `-car`
crops); the default car's are copied to `browser-{start,mid,coast,end}.png`.

## Artifact changes caused by this task

| artifact | change | reason |
| --- | --- | --- |
| packet hash (Corvette) | `fa7e660b…` → `b30b7e2b…` | the packet now names the car it describes (`extras.drive.car`) |
| collision surface | 282 → 381 triangles; box `x −120…−30` → `x −120…−10` | the AWD car travels 69.45 m (to x = −18.6); the old box ended at x = −31.9, so the car left the drawn surface |
| geometry mesh bytes | 1,088,544 → 1,090,380 | +99 triangles from the same parser/selection rule |
| wasm module | unchanged | the library already took a field list; no C++ change |
| physics state hashes | unchanged (Corvette anchor) | no physics change |

## What is proven

- Five real `RP_CarDynamics` cars, selected at runtime from the same wasm module,
  produce five distinct, individually deterministic drivetrain-consistent drives.
- The existing Corvette slice is unchanged: same state sequence hash, same module,
  same spawn and script.
- Each car renders in a real browser through the committed WebGPU consumer with a
  clean console and geometry uploaded once.

## Limits

- **One car at a time.** No opponents, no traffic, no per-car body mesh: every car
  is drawn with the committed Corvette C3 body, labelled
  (`bodyMeshReason`), and wheels are not drawn.
- **Same scenario for all cars.** One spawn, one straight 300-tick script, one
  block of collision mesh. No steering-phase comparison, no lap, no race rules.
- **Not a handling model claim.** The T-005d labels still apply (box gravity
  proxy from the car's own XT geometry, neutral surface grip/rolling/MI scales,
  unresolved `physicsParameters` handle). Differences between cars come from the
  decoded records; they are not validated against the retail game's handling.
- **`reverseGearRatio` is 0 in every record** and tyre `loadDependence` is 0 in
  every record; both are carried as decoded and neither is exercised.
- **Camera:** no occlusion avoidance (three tick-150 frames show terrain), and the
  orbit yaw is `Math.atan2`-based, so the packet hash is only bit-exact across JS
  engines when their `atan2` agrees (18/20 here).
- **Materials/road** remain diagnostic; the road is collision geometry; native
  numeric parity is still blocked by the DirectX SDK.

## Evidence index

| path | content |
| --- | --- |
| `_work/e1-drive/cars.json` | 62 records + gate + selection + per-car values/hashes |
| `_work/e1-drive/cars/<slug>.fields` | decoded field list per car (not committed) |
| `_work/e1-drive/run.json` | 164 checks, per-car drive + determinism + packet |
| `_work/e1-drive/{state,packet,packet-validation}-<slug>.json` | per-car timeline |
| `_work/e1-drive/browser-evidence.json` | 20 captures, console, hash agreement |
| `_work/e1-drive/browser-<slug>-*.png` | per-car screenshots |
| `_work/logs/e1-drive/{verify.log,capture.out.txt,edge-process.log,asset-probe-skip-build.log}` | gate logs |
| `docs/work/analysis/e1-drive-slice.md` §10 | analysis and numbers |
| `probes/e1-drive/README.md` | commands, roster, limits |
