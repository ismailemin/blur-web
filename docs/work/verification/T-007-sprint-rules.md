# T-007 sprint rules — point-to-point gates, timer, finish and respawn on the measured River segment

**Date:** 5 November 2026
**Owner:** P37 (sub-agent)
**Scope:** `probes/e1-drive/**`, `_work/e1-drive/**`, `_work/logs/e1-drive/**`,
`docs/work/analysis/e1-drive-slice.md` §15 and this record. No change to the
engine, the wasm module, `probes/render-packet/`, `probes/car-parts/`, `tools/`,
`docs/work/verification/T-007-{track-visual,camera-collision}.md`, `upstream/` or
`game-data/`. No vehicle-physics change: all five state sequence hashes are the
P36 values and the legacy 300-tick packet hashes are unchanged.

## Result

The drive slice is now a **point-to-point sprint**: 3-2-1 countdown, running
timer, two ordered checkpoints, a finish gate inside the drawn road, a results
overlay with a per-car best time in `localStorage`, `R` restart, and a respawn at
the last checkpoint when the car leaves the measured surface. There is **no lap**;
29 m of committed real draw is the whole course.

`verify_e1_drive.mjs` is **348/348 PASS** (268 P36 checks + 80 sprint/layout/
respawn/best checks). 15 headless Edge/WebGPU sprint captures (5 cars × start /
checkpoint / finish) plus one respawn diagnostic capture have **0 console
messages**. The five 300-tick drive packets are byte-identical to P36; the sprint
packet hash is a separate timeline and is recorded per car.

## Gate layout (derived from the geometry, not typed in)

`tools/build_sprint.mjs` → `_work/e1-drive/sprint.json`
(SHA-256 `6d7f9b71a999e977d8f2b758a90a2f3e6d3200a2fc0e79caa8cb6de12dc24f40`,
layout hash `sha256:9e5b7befe60227ddf826ffa3fe5983e56ae091ac49e3cf1ad17005221da4f703`).

Derivation rule (`web/sprint-layout.js`):

1. corridor = the spawn z ± 3 m (6 m wide gate lines), heading +X;
2. a **column** is covered when every 0.1 m sample across the corridor has both a
   real `river.block56.node289` triangle over it in XZ **and** a collision
   triangle under it (the surface the wheels trace);
3. scan +X from the spawn in 0.25 m steps until the first uncovered column: the
   last fully covered column is `x = −57.00` (125 columns measured from −88.00,
   every one fully covered, no gap);
4. finish = last covered column − 2 m clearance = `−59.00`; start = spawn
   `−88.00`; checkpoints at 1/3 and 2/3 of the 29 m span, snapped to the 0.25 m
   grid;
5. spawn ground = highest collision triangle at the spawn = `5.807372` (the
   engine's `e1_ground_probe` in the P23 record is `5.8074`).

| gate | x | z span | width | drawn samples | collision samples | drawn height |
| --- | ---: | --- | ---: | ---: | ---: | --- |
| start (spawn line) | −88.00 | 1047…1053 | 6 m | 61/61 | 61/61 | 5.8035…5.8102 |
| checkpoint 1 | −78.25 | 1047…1053 | 6 m | 61/61 | 61/61 | 5.7674…5.7750 |
| checkpoint 2 | −68.75 | 1047…1053 | 6 m | 61/61 | 61/61 | 5.8165…6.5858 |
| finish | −59.00 | 1047…1053 | 6 m | 61/61 | 61/61 | 5.7935…5.7986 |

The verifier **re-derives the whole layout** from `geometry.json` and compares it
with the JSON file (any hand-edited gate fails), then **re-measures** every gate
sample with independent barycentric point-in-triangle code and an independent
plane height. It also re-scans the span and asserts no column beyond
`lastFullyCoveredX` is fully covered.

Measured span limit: the full 6 m band is covered to `x = −57.00`; along the
recorded car line the drawn road ends near `x = −48.5`. The finish is 2 m before
the band end, so the car crosses every gate line on drawn road. This is why the
course is 29 m and not a lap.

## Rules

| rule | implementation |
| --- | --- |
| countdown | 90 ticks (1.5 s), labels `3 / 2 / 1` for 30 ticks each, driver input held at `(0,0,0,0)`, car measured at rest (< 0.05 m / 0.05 m·s⁻¹) |
| start | GO at engine tick 90; timer starts at 0 on that tick; the car stands on the start line, so the start gate is armed at GO, not crossed |
| timer | `elapsedTicks` increments once per running engine tick at 60 Hz; it does not reset on a respawn and freezes at the finish |
| gate order | checkpoints count only when `gate.index === nextGateIndex`; a later gate is recorded as `gate-out-of-order`; a finish before the last checkpoint is `finish-blocked` (not a finish) |
| finish | crossing the finish segment with both checkpoints passed; recorded with tick, time, position on the gate line; phase becomes `finished` and the driver brakes |
| respawn | chassis > 1 m below the measured spawn ground, 30 consecutive ticks without wheel contact, or outside the gate corridor (±3 m + 1 m margin) / past the finish line + 2 m; target = last passed checkpoint (start line before CP1) |
| restart | `R`: engine reset + new timeline + countdown; gate progress and timer cleared; best time kept |
| best time | per car in `localStorage` `e1-drive.sprint.best.v1`, milliseconds; only a faster finish replaces it; malformed JSON / denied storage degrades to "no record" |

`web/sprint-rules.js` is a pure tick-driven state machine. It never calls the
engine, never writes a physics value, and only gates the *requested* input (zero
during the countdown, brake after the finish). `web/sprint-script.js` holds the
scripted driver and the diagnostic off-course driver.

## Verification gate

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $node probes/e1-drive/tools/build_sprint.mjs
& $node probes/e1-drive/tools/verify_e1_drive.mjs
& $node probes/e1-drive/tools/capture_browser.mjs --mode sprint --port 8813
& $node probes/e1-drive/tools/capture_browser.mjs --mode respawn --car corvette-zr1-stock --port 8813
& $node probes/e1-drive/tools/capture_browser.mjs --car corvette-zr1-stock --port 8813   # legacy drive regression
& $py   tools/verify_asset_probe.py --skip-build
```

### Recorded result

- `_work/e1-drive/sprint.json` — 11,472 B, file SHA-256
  `sha256:6d7f9b71…dc24f40`, layout hash `sha256:9e5b7bef…da4f703`.
- `_work/e1-drive/run.json` — **PASS, 348/348 checks, 0 failures**. 268
  pre-existing checks are unchanged; the 80 new checks cover the layout
  derivation and independent coverage, countdown rest, GO tick, timer
  monotonicity/freeze, ordered checkpoints, finish gate and span, input gating,
  rules-off replay, sprint packet validity, rules unit tests, best-time store and
  the real respawn.
- Per-car sprint results (`run.json` → `sprint.cars`):

| car | finish | tick | CP1 | CP2 | speed at finish | ticks in run | state sequence hash | packet hash |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| Corvette ZR1 | **2.800 s** | 258 | 1.683 s | 2.317 s | 22.35 m/s | 379 | `sha256:fdd893bd…e62622` | `sha256:3f7b526d…2c5e8c` |
| Lotus Exige Cup260 | **2.850 s** | 261 | 1.733 s | 2.350 s | 20.83 m/s | 382 | `sha256:c9b17397…b52dfc` | `sha256:a7565f65…ceaa9c` |
| Dodge Challenger | **3.000 s** | 270 | 1.783 s | 2.450 s | 19.05 m/s | 391 | `sha256:438e2e12…e12684` | `sha256:ce2f67f9…65a45a4c` |
| Ford Focus RS (FWD) | **3.267 s** | 286 | 1.967 s | 2.683 s | 18.70 m/s | 407 | `sha256:cc911ea3…2af937` | `sha256:9d212904…09d20c7c` |
| Audi R8 V10 (AWD) | **2.283 s** | 227 | 1.317 s | 1.850 s | 24.26 m/s | 348 | `sha256:d52d4b8f…44dea` | `sha256:b133916c…6f95c59` |

  Every car: two ordered checkpoints, no respawn, wheel contact on every tick,
  0 non-finite states, and the recorded input sequence replayed into a fresh
  module with the rules switched off produces **identical per-tick state hashes**
  (601 ticks for the Corvette, 379+ states per sprint run). The AWD car is fastest
  and the FWD car slowest, as the unchanged physics predicts.
- Physics unchanged: the five legacy drive state sequence hashes are exactly the
  P36 anchors (Corvette `sha256:83f76590…008e1f`) and the five legacy 300-tick
  packet hashes are unchanged (`9462fda8…`, `f2956330…`, `d866be00…`, `fa9e334d…`,
  `4a9b3179…`).
- Real respawn run (default car, off-course driver): one `respawn` event at
  tick 237 / 2.45 s with reason `outside-gate-band` (z 1045.86), target
  `checkpoint-1` (−78.25, 1050); `e1_ground_probe` at the target hits
  (`y = 5.771`), `e1_create` rebuilds at engine tick 0 with four wheels on the
  ground, the timer keeps running (2.45 s → 4.45 s), the checkpoint stays passed,
  and 120 ticks later the car is at 14.4 m/s inside the corridor, past
  checkpoint 2.
- Rules unit tests: finish rejected without checkpoints; out-of-order gate
  ignored; below-ground and 30-tick airborne respawns; restart clears timer/gates;
  best-time store keeps the fastest per car and survives corrupt JSON and a
  throwing storage.
- `tools/verify_asset_probe.py --skip-build` — **Passed 29 checks** (no
  regression; this slice's own gate is the verifier above).

## Browser evidence

Headless Edge/WebGPU, 1600×900, adapter `nvidia / blackwell`, fresh profile per
run:

- **sprint**: 15 captures (5 cars × start / checkpoint / finish), URL
  `/?script=sprint&car=<slug>&hold=<tick>` with the ticks taken from the node
  sprint run (start 0 / the exact CP1 crossing tick / finish tick per car).
  **0 console messages of any kind** in every capture. Each capture: 3 geometry
  uploads at the expected byte count,
  `drawsIssued = frames × draws`, 9 matrices per rendered tick, browser **state
  hash equal to node**, car matrix bit-identical, every node matrix within
  1e-12, camera within 1e-6. The results overlay at the finish shows the time and
  car and the best time is in `localStorage` for that car.
- **packet hash agreement: 12/15 exact.** The three exceptions differ only by a
  documented last-bit transcendental difference between Node 24's and Edge 156's
  JS: Dodge start is one `atan2` camera ulp (camera max |Δ| 2.3e-13 with the car
  matrix bit-identical), and Corvette finish and Dodge checkpoint are one
  `sin/cos` wheel-matrix ulp (5.6e-17 and 1.1e-16, camera exact). The state hash,
  car matrix, all-matrix 1e-12 tolerance and camera 1e-6 tolerance are checked
  separately, and the exact-match count is recorded in the evidence
  (`packetHashAgreement`).
- **respawn**: `/?script=sprint&sprintfall=1&car=corvette-zr1-stock` — one
  respawn, banner `respawn · outside-gate-band · 2.450 s`, rebuilt at
  checkpoint 1, results overlay hidden (run still running), **0 console
  messages**.
- The legacy drive mode was re-captured for the Corvette (ticks 0/150/240/300,
  `--label-prefix drive-regression`): **0 console messages**, 4/4 packet hashes
  exact, and the same positions/speeds as P36 (`−66.25, 1049.38` at 14.526 m/s at
  tick 150; `−42.64, 1048.58` at 0.448 m/s at tick 300).

Screenshots (`_work/e1-drive/`):

| file | what it shows |
| --- | --- |
| `browser-<slug>-sprint-start.png` | countdown `3`, car on the start line, timer 0.000 s, `0/2 cp` |
| `browser-<slug>-sprint-checkpoint.png` | `CHECKPOINT 1/2` banner at the exact crossing tick, timer 1.32–1.97 s, `1/2 cp`, progress 32–35 % |
| `browser-<slug>-sprint-finish.png` | results overlay with finish time and car, `2/2 cp`, best time written |
| `browser-corvette-zr1-stock-sprint-respawn.png` | respawn banner and the car rebuilt at checkpoint 1 |
| `browser-<slug>-sprint-*-car.png` | 2× car crops of the same frames |

The five cars are captured at the same semantic moments, so the start frames
show five different bodies/wheels at the same gate. The checkpoint gate sits in
the start-area prop cluster: the car drives through the wrecked truck (physics has
no prop collision), so the checkpoint frame is a documented **near-field** frame —
the banner, HUD, timer and state hashes prove the crossing, while the prop can
fill the camera view. The start and finish frames are clear.

## What changed

| file | change |
| --- | --- |
| `probes/e1-drive/web/sprint-layout.js` | **new**: corridor/gate derivation from the geometry, coverage measurement, structural validation and layout hash |
| `probes/e1-drive/web/sprint-rules.js` | **new**: countdown, timer, ordered gates, finish, respawn, snapshot; pure tick state machine |
| `probes/e1-drive/web/sprint-best.js` | **new**: per-car `localStorage` best-time store with defensive fallbacks |
| `probes/e1-drive/web/sprint-script.js` | **new**: scripted sprint driver and off-course respawn diagnostic |
| `probes/e1-drive/tools/build_sprint.mjs` | **new**: writes `_work/e1-drive/sprint.json` from `geometry.json` + `spawn.json` |
| `probes/e1-drive/web/app.js` | sprint mode (default + `?script=sprint`), countdown/results/HUD, `R` restart, respawn, probe fields; `?script=drive` kept byte-for-byte in behaviour |
| `probes/e1-drive/web/index.html`, `style.css` | countdown numeral, event banner, results overlay, sprint legend |
| `probes/e1-drive/web/packet-adapter.js` | only an optional `script` diagnostics label (the legacy default string is unchanged, so legacy packet hashes are unchanged) |
| `probes/e1-drive/tools/verify_e1_drive.mjs` | layout derivation/independent coverage, 5 sprint runs, rules-off replay, sprint packet, rules unit tests, best store, real respawn, sprint block in `run.json` |
| `probes/e1-drive/tools/capture_browser.mjs` | `--mode sprint` (start/checkpoint/finish per car) and `--mode respawn` (off-course diagnostic), overlay/local-storage/matrix-tolerance gates |
| `probes/e1-drive/README.md` | sprint section, commands, evidence, limits |
| `docs/work/analysis/e1-drive-slice.md` §15 | analysis record |

## Limits

- **No lap.** The committed real draw covers 29 m of the drive; the sprint is
  point-to-point on that measured segment. A lap, sectors, split times over a
  second lap and a start/finish loop are not claimed.
- **Gates are rules geometry only.** No gate mesh is added to the render packet;
  gates appear in the HUD, the checkpoint banner and the evidence, not as 3D
  objects in the frame.
- **Respawn rebuilds the world.** `e1_create` at the checkpoint re-runs the
  180-tick settle, so the respawn costs a frame hitch and the car restarts from
  rest at the gate. The timer keeps running; the passed checkpoints are kept.
- **Best time is local.** `localStorage`, per car, milliseconds; there is no
  server, account, ghost, replay upload or leaderboard.
- **No opponents, AI, traffic, race audio or multiplayer.** One car, one measured
  segment, one camera. Not the retail race mode and no BPR/score claim.
- **The checkpoint frame is a near-field frame.** Checkpoint 1 is inside the
  start-area prop cluster; the car drives through the wrecked truck (physics has no
  prop collision), so the chase camera holds at its near-field limit and the prop
  can fill the view. The crossing itself is measured by the banner, HUD, timer and
  the state/packet hashes; the start and finish frames are clear.
- **Rules are presentation/bookkeeping.** They gate requested input only; the
  rules-off replay proves the physics did not move. Any extra rule (penalty,
  collision, wrong-way) is out of scope.
- **Native-vs-wasm parity remains blocked** by the DirectX SDK
  (`T-007-vehicle-physics.md` §7).

## Evidence paths

| path | content |
| --- | --- |
| `_work/e1-drive/sprint.json` | derived gates, coverage samples, rules, layout hash |
| `_work/e1-drive/run.json` | 348 checks, sprint layout/cars/respawn/rule tests |
| `_work/e1-drive/sprint-<slug>.json` | per-car tick table, events, input sequence, start/cp/finish capture updates |
| `_work/e1-drive/browser-evidence-sprint.json` | 15 captures, console log, hash agreement, overlay/local-storage checks |
| `_work/e1-drive/browser-evidence-respawn.json` | respawn diagnostic capture |
| `_work/e1-drive/browser-evidence-drive-regression.json` | legacy drive re-capture (Corvette) |
| `_work/e1-drive/browser-<slug>-sprint-*.png` | start/checkpoint/finish frames (+ crops) |
| `_work/e1-drive/browser-corvette-zr1-stock-sprint-respawn.png` | respawn frame |
| `_work/logs/e1-drive/verify-p37.log`, `edge-sprint-p37.log`, `edge-respawn-p37.log`, `edge-drive-regression-p37.log`, `verify-asset-probe-p37.log` | raw runs |
| `docs/work/analysis/e1-drive-slice.md` §15 | analysis record |
