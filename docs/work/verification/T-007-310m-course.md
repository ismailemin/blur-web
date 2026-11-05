# T-007 310 m course — the measured P48 collision-clean sprint is the default

**Date:** 5 November 2026
**Owner:** P50 (sub-agent)
**Scope:** `probes/e1-drive/**`, `_work/e1-drive/**`, `_work/logs/e1-drive/**`,
`docs/work/analysis/e1-drive-slice.md` §22 and this record. No change to
`probes/drivable-path/`, `probes/track-coverage/`, `probes/car-parts/`,
`probes/collision-oracle/`, `probes/render-packet/`, the engine, `tools/`,
`upstream/` or `game-data/`. The P48 path artifact is consumed **read-only**; its
file and canonical hashes are pinned. No vehicle physics, packet body, camera,
telemetry or reset behaviour changed.

## Result

The default playable sprint is now the **measured 310.395 m P48 collision-clean
course** instead of the 29 m straight. All five roster cars finish it with the
deterministic Stanley follower, **0 respawns, 0 NaN, wheel contact on every
tick**, and **14.150–15.217 s** finishing times. The 29 m course is kept behind
`?course=short` as the regression course and still finishes with the exact P37
times and state hashes.

`verify_e1_drive.mjs` is **550/550 checks, 0 failures** (was 522/522; 28 new
layout, band, ground, short-course, rules and best-key checks). The five long
sprint state sequences and the five 29 m state sequences are re-pinned/kept as
anchors; the five drive and packet anchors are unchanged.

- default course: `_work/e1-drive/sprint.json`, layout
  `sha256:3ef478e06ef363ffbe195ffc8576cf8c112ad86c239c9bbf62616b2532c4fa22`
- regression course: `_work/e1-drive/sprint-short.json`, layout
  `sha256:56188178f9d4e398fe6c963a208f76b6855fe4f1c70274589f1bdf3fb536fe18`
- the long course is 100 % drawn and physical: 1,204/1,204 centre samples and
  8,414/8,414 car-width stations (7 stations × 1,202 samples), max surface delta
  0.929 mm.

## 1. The course

The course line is the P48 artifact
`_work/drivable-path/path.json` (56,136 B, SHA-256
`sha256:81eac0ce413075de33e2b3c0e1c077412b35002420b199d9f05d2fdeef230e7f`,
canonical hash `sha256:4b725b10e6619e7cc2f3ef0b0ea03f3a252660a8ffaad0ffe04cb96e0318605b`).
`tools/build_sprint.mjs` refuses any other file. No point is smoothed, rounded
(beyond 6 dp for stable hashing) or re-routed.

| field | value |
| --- | --- |
| measured length | **310.395196 m** |
| samples | **1,245** at 0.25 m |
| start | (−88.0, 1050.0), ground 5.8074 m |
| measured end | (103.5, 1292.5), ground 5.8813 m |
| max step / max 2 m grade | 1.55 cm engine / 3.09 % (P48) |
| min steep-face distance | 7.7836 m (P48 `verify.json`) |
| draw coverage | section `river.block56.node289`, 8 draws, P51 measured 100 % |

### 1.1 Gates (derived, not typed)

| gate | arc | sample | point | tangent heading | width | drawn/collision |
| --- | ---: | ---: | --- | ---: | ---: | --- |
| start | 0.000 | 0 | (−88.0, 1050.0) | 0.767411 | 6 m | 61/61 + 61/61 |
| checkpoint 1 | 100.107736 | 401 | (−18.4982, 1122.049) | 0.767411 | 6 m | 61/61 + 61/61 |
| checkpoint 2 | 200.074803 | 802 | (42.8327, 1200.5576) | 0.583878 | 6 m | 61/61 + 61/61 |
| finish | 300.159666 | 1203 | (97.5348, 1284.1824) | 0.622165 | 6 m | 61/61 + 61/61 |

- The start is arc 0 (the committed spawn); the two checkpoints are the 1/3 and
  2/3 points of the finish span, snapped to the nearest measured sample.
- Every gate line is the left normal of the local **5 m tangent**, so it is
  perpendicular to the road at that point (the verifier requires
  `|tangent · (b − a)| < 0.02`).
- The gate is 6 m wide and sits inside the 16–24 m drawn surface; no gate had to
  narrow. The measured off-course band is ±6.0 m, below the 7.7836 m minimum
  steep-face distance.

### 1.2 Why the finish is at arc 300.160

The measured surface ends at 310.395 m and narrows to 2.0 m at +4 m past it
(P48 §4.1). The finish is the last measured sample at or before
`310.395 − 10.0 = 300.395` m, i.e. arc **300.159666 m**, **10.2355 m before the
measured end**. The follower slows to 13 m/s over the last 18 m (`finishSpeed`),
so the post-finish brake stops the car at arc ≈303–308, still on the ≥3 m wide
part of the surface. In the five runs the car stops at 306.06–307.94 m and no run
reaches the narrowing.

A finish at the measured end (310.395) was rejected: a car crossing at 13 m/s then
braking would stop past 315 m, where the measured width is 0.5 m and then void.
Finishing 5 m earlier would leave only 5 m of run-off at the measured stop; 10 m
is the documented P48 recommendation.

## 2. The follower

`web/sprint-script.js` uses the P43 Stanley form (heading error to a point 10 m
ahead + lateral term to the nearest measured point + yaw damping), with a
speed-dependent steering gain and a per-tick steering rate limit. It is a pure
function of the engine state and the committed layout: the previous steer comes
from `state.input[2]`, not from controller memory, so the recorded input sequence
replays bit-identically with the rules off.

Two measured facts drove the tuning (`_work/e1-drive/p50-steer.mjs`):

- the engine's steering authority is strongly speed-dependent: at 24 m/s a 0.1
  request gives ~0.01 rad/s yaw and 1.0 gives ~1.3 rad/s. The controller therefore
  scales its gain with `clamp(speed / 6, 1, 3)`.
- the committed spawn heading is +X (π/2) while the measured course leaves the
  spawn at 43.97°. The page and the verifier create the car **on the start gate,
  facing the measured tangent** (`layoutStartHeading`), a start-line convention;
  the committed drive-slice spawn (π/2) and its state hashes are unchanged.

Constants (`SPRINT_CONTROL`): cruise 24 m/s, lookahead 10 m, steer gain 3.0,
lateral gain 2.0, yaw damping 0.8, steer rate 0.08/tick, lateral accel 4.0 m/s²,
finish speed 13 m/s from 18 m out, minimum speed 6 m/s.

The follower stays within **0.85 m** of the measured centre line on all five cars,
well inside the ±6 m band and the 3 m gate half-width.

## 3. Per-car results (default 310 m course)

`_work/e1-drive/sprint-<slug>.json`, summarised in `run.json` → `sprint.cars`:

| car | finish | tick | checkpoint 1 | checkpoint 2 | max speed | max lateral | contacts | NaN | respawns | state sequence hash |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Corvette ZR1 | **14.650 s** | 969 | 5.700 s | 9.950 s | 24.73 m/s | 0.590 m | every tick | 0 | 0 | `sha256:da7e14f1…f9a553` |
| Lotus Exige Cup260 | **14.767 s** | 976 | 5.783 s | 10.067 s | 24.69 m/s | 0.615 m | every tick | 0 | 0 | `sha256:83f05df4…92367e` |
| Dodge Challenger | **14.917 s** | 985 | 5.950 s | 10.233 s | 24.65 m/s | 0.795 m | every tick | 0 | 0 | `sha256:accf125a…6ac8210a` |
| Ford Focus RS (FWD) | **15.217 s** | 1003 | 6.267 s | 10.550 s | 24.63 m/s | 0.845 m | every tick | 0 | 0 | `sha256:1094698d…d9f2063f` |
| Audi R8 V10 (AWD) | **14.150 s** | 939 | 5.183 s | 9.450 s | 24.81 m/s | 0.704 m | every tick | 0 | 0 | `sha256:0b32413d…f14b5ca` |

Each car: 2/2 ordered checkpoints, finish inside the 6 m finish line at arc
300.159666, a real sprint (moving at the finish), rules-gated input (zero in the
countdown, brake after the finish), every input sequence replayed without the
rules reproduces every state hash, and an `e1_reset()` restart in the same wasm
instance reproduces the finish tick, time and every state hash
(`run.json` → `sprint.restartCars`). The AWD car is fastest and the FWD car
slowest, as the unchanged physics predicts.

## 4. Verification

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $node probes/e1-drive/tools/build_sprint.mjs          # sprint.json + sprint-short.json
& $node probes/e1-drive/tools/verify_e1_drive.mjs
& $node probes/e1-drive/tools/capture_browser.mjs --mode sprint --port 8831
& $node probes/e1-drive/tools/capture_browser.mjs --mode sprint --course short --port 8832
& $node probes/e1-drive/tools/capture_browser.mjs --mode restart --port 8833
& $node probes/e1-drive/tools/capture_browser.mjs --mode respawn --port 8834
& $node probes/e1-drive/tools/capture_browser.mjs --mode survey --port 8835
& $py   tools/verify_asset_probe.py --skip-build
```

`verify_e1_drive.mjs` — **PASS, 550/550 checks, 0 failures**
(`_work/e1-drive/run.json`). New checks in this pass:

1. the P48 path file SHA-256 and canonical hash are the recorded ones;
2. the default layout is exactly the derivation of that path + geometry;
3. the 29 m layout is exactly the derivation of the geometry;
4. both layouts pass structural validation;
5. the default course is 310.395 m / 1,245 samples with the 10 m finish clearance;
6. start + two checkpoints + finish are ordered on measured arcs;
7. gates sit on measured samples and are perpendicular to the 5 m tangent;
8. the course re-measures 1,204/1,204 covered with no gaps;
9. the 29 m regression keeps its P37 gates/span/clearance;
10. every 310 m gate line is independently 61/61 drawn + collision;
11. every 29 m gate line is independently 61/61 drawn + collision;
12. the whole 310 m car-width band is independently drawn and physical
    (8,414/8,414 at seven stations);
13. the 29 m covered segment is still contiguous to x = −57.00;
14. the layout ground matches the engine `_e1_ground_probe` (125 probes, max
    delta < 1 cm);
15–18. per car, the 310 m run: band stay, finish arc, contact/NaN/replay and the
    sprint packet;
19–25. per car, the 29 m regression: finish, checkpoints, contact/NaN/replay;
26. path-course rules: out-of-order checkpoint/finish-blocked, local-ground
    below-ground respawn, outside-corridor respawn, respawn gate heading;
27. per-course best-time keys are independent;
28. the long and short state sequences are both anchored.

Physics: the five drive state sequence hashes and the five whole-packet hashes
are the P49 values (unchanged). The 29 m sprint state hashes are the P37 values.
The 310 m sprint hashes are new anchors because the course timeline is new, not
because the physics moved. The packet body itself did not change; only the sprint
packet's tick timeline and its `script` label changed.

### Recorded hashes

| file | bytes | SHA-256 |
| --- | ---: | --- |
| `_work/e1-drive/sprint.json` | 386,521 | `sha256:335db516a8a7981afcf92e3ce0f8dc47c67c607d5b577c4163fddd7c2409d190` |
| `_work/e1-drive/sprint-short.json` | 11,495 | `sha256:bda4d0668a5f21aee3275db99d4a2458c03e218aa45631373f732ff207c7b374` |
| `_work/drivable-path/path.json` (read-only) | 56,136 | `sha256:81eac0ce413075de33e2b3c0e1c077412b35002420b199d9f05d2fdeef230e7f` |
| `_work/e1-drive/geometry.json` (unchanged) | 18,791,525 | `sha256:91846bac308b71f552f96e8aadcb3aad6e654c0daca5042f7d4da4bce052eb81` |
| `_work/e1-drive/run.json` | 845,235 | `sha256:8cba04315dc339639d000f5613cfbd3833bdca00b0af1e25f39c226e5be6df12` |
| `_work/e1-drive/browser-evidence-sprint.json` | 170,492 | `sha256:65bbe48c9d57b572cd02186b9eb34746fcdf23f714e3fbe9bdcf42fa52869f74` |

Canonical hashes: long layout `sha256:3ef478e06ef363ffbe195ffc8576cf8c112ad86c239c9bbf62616b2532c4fa22`,
short layout `sha256:56188178f9d4e398fe6c963a208f76b6855fe4f1c70274589f1bdf3fb536fe18`.

## 5. Browser evidence

Headless Edge/WebGPU, 1600×900, adapter `nvidia / blackwell`, fresh profile per
run. `--mode sprint` (default course) produced **20 captures** (5 cars ×
start / mid / checkpoint / finish), **0 console messages of any kind**, and
**0 assertion failures** in `_work/e1-drive/browser-evidence-sprint.json`:

- start: countdown `3`, timer 0.000 s, HUD `course 310 m P48 (default) · 310.4 m
  measured · finish 300.2 m`, 0/2 cp;
- mid: tick 534–599, ~50 % progress, ~22–23 m/s, 1/2 cp, textured road under the
  car;
- checkpoint: the exact CP1 crossing tick (401–466), banner and 1/2 cp;
- finish: results overlay with the node time (14.150–15.217 s), car, 2/2 cp,
  respawns 0, and the per-course best time written to `localStorage`.

Browser state hash equals Node in every capture, the car matrix is bit-identical,
every matrix is within 1e-12 and the camera within 1e-6. **13/20 packet hashes are
byte-exact**; the seven differences are the documented Node 24 / Edge 156
last-bit transcendental cases (camera |Δ| ≤ 4.55e-13 with the car matrix
bit-identical), checked separately as in P37/P43/P49.

The 29 m regression is captured the same way with `--course short`
(`_work/e1-drive/browser-evidence-sprint-short.json`,
`browser-<slug>-sprint-short-*.png`). The HUD names the regression course and the
results overlay writes the `…v2.short` best key.

## 6. Limits

- **Point to point, no lap.** The source component is a one-way band; the finish
  is before the 2.0 m narrowing. No lap, sector or loop is claimed.
- **Three small seams.** The drawn course crosses five draw-to-draw seam
  transitions inside `g56-n289` (50.18 / 76.89 / 168.64 / 222.78 / 242.00 m).
  P51 measured 0 uncovered sub-samples at 0.02 m across each; they are not gaps,
  but they are seams in the committed draws.
- **The start-line heading is a convention.** The car is created at the committed
  spawn position facing the measured tangent (0.767411 rad), not the drive-slice
  heading π/2. The drive mode and its hashes are unchanged.
- **The follower is a deterministic PoC driver.** It is not an AI opponent, not a
  racing line optimiser and not a claim of retail handling. It slows to 13 m/s for
  the finish and stays within 0.85 m of the measured line.
- **The off-course band is a declared rule.** ±6.0 m is below P48's measured
  7.7836 m minimum steep-face distance; it is not a measured lane and not a legal
  racing width.
- **The course ground is the collision provenance mesh**, cross-checked against the
  engine probe at every gate and every 10th sample. Beyond the finish the surface
  is unmeasured (P51 §9.6) and is not driven.
- **No materials, opponents or game loop are added.** Texture/material limits are
  P49's. No lap, no traffic, no race audio.

## 7. What changed

| file | change |
| --- | --- |
| `probes/e1-drive/web/sprint-layout.js` | `deriveLongCourseLayout` (P48 path → gates/coverage/band/reference), `longCourseSamples`, `lineCoverage`, `courseGateRecord`, `layoutStartHeading`; short layout gains `courseId` |
| `probes/e1-drive/web/sprint-rules.js` | path-course branch: arc progress, lateral band, local-ground fall rule, gate-heading respawn, `maxLateral`; 29 m x-branch unchanged |
| `probes/e1-drive/web/sprint-script.js` | Stanley path follower with a measured speed-dependent gain and steering rate limit; 29 m keeps the throttle hold; 3,600-tick bound |
| `probes/e1-drive/tools/build_sprint.mjs` | writes `sprint.json` (310 m) and `sprint-short.json` (29 m), pins the P48 file hash |
| `probes/e1-drive/web/app.js` | `?course=short`, per-course best key, start-gate heading, HUD course line, 3,600-tick sprint/soak bound, survey text |
| `probes/e1-drive/web/index.html` | legend names the 310 m default and the short regression |
| `probes/e1-drive/web/sprint-best.js` | per-course key prefix documented |
| `probes/e1-drive/tools/verify_e1_drive.mjs` | both layouts, independent gate + band + ground checks, both per-car runs, path rules tests, anchors, short regression block; 550 checks |
| `probes/e1-drive/tools/capture_browser.mjs` | `--course 310|short`, per-course best key, mid frame, short regression evidence |
| `probes/e1-drive/README.md` | default course, gates, times, commands, limits |
| `docs/work/analysis/e1-drive-slice.md` §22 | analysis record |

## 8. Evidence paths

| path | content |
| --- | --- |
| `_work/e1-drive/sprint.json` | default 310 m layout: gates, coverage, band, samples, rules |
| `_work/e1-drive/sprint-short.json` | 29 m regression layout |
| `_work/e1-drive/sprint-<slug>.json` | per-car 310 m ticks, inputs, events, captures |
| `_work/e1-drive/sprint-short-<slug>.json` | per-car 29 m ticks, inputs, events |
| `_work/e1-drive/run.json` | 550 checks, both sprint blocks, anchors, respawn |
| `_work/e1-drive/browser-evidence-sprint.json` | 20 default-course captures, console, hash agreement |
| `_work/e1-drive/browser-evidence-sprint-short.json` | 20 short-course captures |
| `_work/e1-drive/browser-<slug>-sprint-{start,mid,checkpoint,finish}.png` | default-course frames (+ `-car` crops) |
| `_work/e1-drive/browser-<slug>-sprint-short-{start,mid,checkpoint,finish}.png` | 29 m regression frames (+ `-car` crops) |
| `_work/logs/e1-drive/p50-*.log` | build, verify, capture, asset-probe logs |
| `_work/e1-drive/p50-*.mjs` | scratch coverage, layout, follower, steering-response probes |
