# T-007 extended sprint — chassis ledge fix, the cliff crossings and the survey fallback

**Date:** 5 November 2026
**Owner:** P46 (sub-agent)
**Scope:** `probes/e1-drive/**`, `_work/e1-drive/**`, `_work/logs/e1-drive/**`,
`docs/work/analysis/e1-drive-slice.md` §19, `docs/work/verification/T-007-extended-sprint.md`
and this record. No change to `probes/track-coverage/`, `probes/car-parts/`,
`probes/render-packet/`, the engine, `tools/`, `upstream/` or `game-data/`.

## Result

**The extended sprint is a fallback, not a fix: the 539.81 m corridor is not a
drivable route.** P43's measured chassis blocker is real and was fixed as a
documented proxy option, but it is the *second* problem: the measured corridor's
own centre line **crosses 50 m tall vertical collision faces**, twice confirmed
solid by the engine (arc **57.82 m** and **530.71 m**). A coverage path has no
notion of a wall, so the corridor runs straight through a cliff.

- The **playable sprint is the 29 m straight** on the measured covered segment
  (unchanged from P37/P42: same gates, same physics, same 488-check state, now
  **514/514 checks**).
- The **540 m track visual stays drawn** (394 real draws / 57,133 triangles in one
  mesh) and the corridor is available as a **labelled survey**: `?survey=1` in the
  page, `_work/e1-drive/corridor-survey.json`, `_work/e1-drive/corridor-survey.html`
  and the per-car `_work/e1-drive/corridor-probe*.json`.
- The **chassis proxy fix is implemented and measured but not shipped as the
  default**: `--proxy-lift=<m>` on `build_module.mjs` lifts the box's collision
  element inside the body without touching mass, inertia or centre of mass. It
  makes the car climb the section-join rise and does **not** get it past the cliff,
  so shipping it would change the verified physics for no course.

## 1. What P43's work reproduced

`git apply _work/p43-drive.diff` did not apply as saved: the diff was written
through a lossy console pipeline (UTF-8 bytes decoded as CP857 → `—` became
`ÔÇö`), so every non-ASCII context line differed. Reversing that (`encode('cp857')
.decode('utf-8')` per line) reproduced a patch that applies cleanly; the repaired
patch is `_work/e1-drive/p43-drive-repaired.diff` and the repair script
`_work/e1-drive/p46-repair.py`.

With P43's work applied and the shipped (faithful) box proxy:

| car | P43 sprint stop (arc) | P46 from-rest limit probe (arc) |
| --- | ---: | ---: |
| Corvette ZR1 | 53.81 m | 52.66 m |
| Lotus Exige Cup260 | 53.37 m | 52.66 m |
| Dodge Challenger | 53.23 m | 52.66 m |
| Ford Focus RS (FWD) | 53.48 m | 53.37 m |
| Audi R8 V10 (AWD) | 53.72 m | 52.90 m |

Both stop at the `g58 → g50` section join. The P43 numbers are the path follower
arriving at speed; the P46 probe starts from rest 5 m before the rise. The rise is
**6.36 cm in a 0.94 m window (6.7 %)** at arc 52.19 m, measured from the committed
0.25 m course samples.

## 2. The chassis proxy, measured

The harness builds its gravity body as a box of `trackWidth × 2·tyreRadius ×
wheelBase` centred on the car origin. Measured settled pose (Corvette, spawn):
body origin 6.1646 m, ground 5.8074 m, so the box's lower face sits **1.4 mm above
the ground** — the car skates on its chassis plate, which is why a 6-7 cm rise
stops it.

**The proxy is faithful to the XT data.** The committed body mesh's lowest vertex
is −0.3506 m in the body frame and the settled wheel-contact plane is −0.357 m, so
the real skid plate is also at the contact plane. Lowering or raising the box is a
*model* choice, not a recovery; it must be labelled and measured.

### 2.1 The lift, implemented as an option

`e1_drive_lib.cpp` now sets `C_ShapeDesc::m_RenderOffset = (0, lift, 0)` — the
retail *element offset* mechanism (`ShapeDescriptors.cpp` copies it to
`C_Shape::m_ElementOffset`) — so only the collision element moves:

| check | result |
| --- | --- |
| body origin / car state at tick 0 | **bit-identical** to the faithful proxy (`[-87.9946594, 6.16456938, 1050]`) |
| `e1_diag().collisionBox` centre | car origin **+0.0999 m** at lift 0.10, extent 0.3626 (0.356 + margin) |
| mass / inertia tensor / centre of mass | unchanged (same box, same mass) |
| `e1_info()` | reports `chassisProxy:"box-from-XT-geometry"`, `chassisProxyLift` |

`build_module.mjs --proxy-lift=<m>` (0-10 m, measurement only) builds a variant and
records it in `build.json`. The shipped module is the source default (**lift 0**):
`e1_info().chassisProxyLift === 0`, verified in the gate.

**Measured effect of the lift** (from-rest limit probe, Corvette; the 0.25 m row
is the P43-style scripted sprint, which is a different instrument):

| lift | instrument | section-join rise (arc 47.5 →) | cliff pinch (arc 54.8 →) |
| ---: | --- | --- | --- |
| 0.00 | limit probe | stops at 52.66 m | stops at 56.20 m |
| 0.10 | limit probe | crosses the rise, stops at 55.96 m | stops at 55.96 m |
| 0.25 | scripted sprint (path follower) | crosses the rise, reaches 57.88 m | not measured with the probe |

So the lift removes P43's blocker and the car then reaches the cliff pinch, where
it stops with the box **2.2 m clear of the ground** (measured: 21-27 cm under the
box corners at the stall). The remaining blocker is a lateral wall, not clearance.

### 2.2 One wrong measurement, recorded

`build_module.mjs` used to reuse `e1_drive_lib.o` when it existed, so a lift build
followed by a default build silently linked the *lifted* object. That produced one
wrong "the rise is passable at speed" reading before it was caught. The tool now
always recompiles its single translation unit; two consecutive default builds
produce the same wasm
(`sha256:836e7764985ba29dec026f5fe6376a6d75b3b3054b696f0484249e7e6626fdb8`,
`buildDeterministic: true`).

## 3. The real blocker: the corridor crosses cliffs

The corridor was measured by P41 as the path over cells where a committed draw is
within 0.5 m of the collision surface. The engine draws *and* collides the 50 m
vertical faces that bound the playable river valley, so their cells are "covered"
and the measured line can run through them.

Measured from the committed artifacts (`web/corridor-survey.js`, re-derived by the
verifier) and confirmed with the engine's own ray query (`e1_ray_probe`, the same
`FillCache`/`Trace` path the wheels use):

| crossing | point (x, z) | face height | engine-confirmed solid |
| --- | --- | ---: | --- |
| 10.66 m | (−84.70, 1040.70) | 50.0 m | **no** (the face is not collidable) |
| **57.82 m** | (−49.85, 1011.00) | 50.0 m | **yes** — hit at 1.53 m from 3 m back, |normal.y| = 0 |
| 177.15 m | (30.00, 1063.77) | 50.0 m | **no** (no vertical face hit by the engine rays) |
| **530.71 m** | (259.73, 1303.00) | 50.3 m | **yes** — hit at 1.83 m from 3 m back, |normal.y| = 0 |

The measured line also runs within 0.05-0.83 m of the two cliffs that meet at
(−47.08, 1011.79) between arc 55.7 and 59.7, which is the pinch every car stops in.

Per-car physical limit, measured by placing the car on the measured line and
holding full throttle with zero steer (`tools/corridor_probe.mjs`, re-run by the
verifier):

| car | rise station (from arc 47.48) | pinch station (from arc 54.78) |
| --- | --- | --- |
| Corvette ZR1 | stops at 52.66 m | stops at 56.20 m |
| Lotus Exige Cup260 | stops at 52.66 m | stops at 56.20 m |
| Dodge Challenger | stops at 52.66 m | stops at 55.96 m |
| Ford Focus RS (FWD) | stops at 53.37 m | stops at 55.49 m |
| Audi R8 V10 (AWD) | stops at 52.90 m | stops at 56.20 m |

Every station: wheel contact on every tick, **0** non-finite states. No car passes
56.5 m; the finish gate at 537.69 m is unreachable by construction.

## 4. What was kept, and what the gate now proves

Kept from P43 (verified again here): the six-section corridor draw merge
(**299 draws / 47,790 triangles / 78,712 vertices**; merged visual
**394 / 57,133 / 96,494**), the pinned `course.json` (539.808 m, 2,257 samples,
2,251 covered, 3 gaps / 1.413 m) and the four gates on the measured line
(start 0.00 m, checkpoints 179.88 / 359.80 m, finish 537.69 m), each 61/61 drawn
and collision-covered.

Reverted to the verified P37/P42 state: the sprint layout (29 m straight),
`sprint-rules.js`, `sprint-script.js` (throttle hold), the page sprint wiring, the
capture/soak tools and the verifier's sprint runs. The page now also carries
`?survey=1`, which labels the drawn corridor and states the measured limit without
touching any gate, timer, result or packet field.

New in the gate (514 checks, up from 488):

- the corridor survey artefact is re-derived with the engine's ray query and
  compared canonically (a hand-edited survey fails);
- the six-section totals, the four gates, their 61/61 coverage and the measured
  gate geometry (sample point, perpendicular 6 m line);
- the 6.36 cm / 6.7 % section-join rise and the −31.24 % drop near the end;
- the four path/face crossings, the two engine-confirmed solid ones and the
  measured course limit 57.82 m;
- the shipped proxy is the faithful one (`chassisProxyLift === 0`);
- per car: the rise stops it at 52.2-53.4 m, the pinch stops it at 55.2-56.4 m,
  and both probes keep contact and stay finite.

## 5. Verification

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $node probes/e1-drive/tools/build_module.mjs
& $py   probes/e1-drive/tools/extract_track.py
& $node probes/e1-drive/tools/build_geometry.mjs
& $node probes/e1-drive/tools/build_course.mjs
& $node probes/e1-drive/tools/build_corridor_survey.mjs
& $node probes/e1-drive/tools/build_sprint.mjs
& $node probes/e1-drive/tools/corridor_probe.mjs
& $node probes/e1-drive/tools/verify_e1_drive.mjs
& $node probes/e1-drive/tools/capture_browser.mjs --mode sprint --port 8821
& $node probes/e1-drive/tools/capture_browser.mjs --mode survey --port 8822
& $py   tools/verify_asset_probe.py --skip-build
```

Recorded:

- `verify_e1_drive.mjs` — **514/514 checks, 0 failures** (`_work/e1-drive/run.json`).
  Physics anchors: the five **drive state-sequence hashes are unchanged from
  P36** (`83f76590…`, `8d6cd4d4…`, `b1c63d20…`, `fb3909b6…`, `5b4ae49d…`) and the
  five sprint hashes are the P37 29 m values; the **packet** hashes moved because
  the packet now carries 394 track draws instead of 144 (recorded in
  `PHYSICS_ANCHORS` with that reason). The faithful proxy is untouched.
- `capture_browser.mjs --mode sprint` — **15 captures** (5 cars × start /
  checkpoint / finish), **0 console messages**, all gates clean, **12/15 packet
  hashes byte-exact** (the three differences are the documented Node-24 vs Edge-156
  transcendental ulp cases, camera ≤ 1e-13, car matrices bit-identical),
  `394 real draws · 57133 tri · no-draw 2088 tri · slab hidden`.
- `capture_browser.mjs --mode survey` — **1 capture**, **0 console messages**, the
  banner visible with the measured limit, 394 track draws, sprint layout hash equal
  to the 29 m layout
  (`sha256:9e5b7befe60227ddf826ffa3fe5983e56ae091ac49e3cf1ad17005221da4f703`).
- `verify_asset_probe.py --skip-build` — **Passed 29 checks**
  (`_work/logs/e1-drive/p46-asset-probe.log`).

### Recorded hashes

| file | bytes | SHA-256 |
| --- | ---: | --- |
| `_work/e1-drive/module/e1_drive.wasm` | 1,006,186 | `sha256:836e7764985ba29dec026f5fe6376a6d75b3b3054b696f0484249e7e6626fdb8` |
| `_work/e1-drive/geometry.json` | 16,971,391 | `sha256:1ba1e25ca54217666e08d853057c5195be35f40b1f4f063c536a16cee673e621` |
| `_work/e1-drive/course.json` | 278,779 | `sha256:a7c7350fe0dd631ae31015ecfaf75c4028fe57b0e30bf0b06f4c4d27e1443444` |
| `_work/e1-drive/sprint.json` | 11,472 | `sha256:6d7f9b71a999e977d8f2b758a90a2f3e6d3200a2fc0e79caa8cb6de12dc24f40` |
| `_work/e1-drive/corridor-survey.json` | 21,878 | `sha256:01307513ad429ccafa813c138484b7811ae280e9b1231ea2368dcf9fc1b3a768` |
| `_work/e1-drive/corridor-survey.html` | 3,911 | `sha256:8681c373a0edc9198e2e40c09426dbe207d8f77bb0657de5ca31627938d9a00a` |
| `_work/e1-drive/corridor-probe.json` | 3,938 | `sha256:1a88465abef4f139fea4977d1d18cbde05a43608ce6cc914a05f8d45f1c85199` |
| `_work/e1-drive/track.json` | 311,251 | `sha256:d49bc468a8667389c6480fc6117ab617e570d5f704410d5e1b1dd90f8d9a839c` |

Canonical hashes: course `sha256:5a8753fb…db00d0`, survey
`sha256:065613ec8201d77906c0da5db481fed9b9ef858bd667a193a6cf95c45c95e9d3`,
sprint layout `sha256:9e5b7befe60227ddf826ffa3fe5983e56ae091ac49e3cf1ad17005221da4f703`,
module source `sha256:b2bcaee40a380758cb857e58c47e789df145705be909da3638934c41d902ab86`.

## 6. Browser evidence

Headless Edge/WebGPU, 1600×900, adapter `nvidia / blackwell`:

| screenshot | what it shows |
| --- | --- |
| `browser-<slug>-sprint-start.png` | countdown `3`, car on the start line, timer 0.000 s |
| `browser-<slug>-sprint-checkpoint.png` | checkpoint 1 crossed, HUD `394 real draws · 57133 tri · no-draw 2088 tri · slab hidden` |
| `browser-<slug>-sprint-finish.png` | results overlay, 2/2 checkpoints, finish time |
| `browser-corvette-zr1-stock-survey.png` | `?survey=1`: the corridor label visible, 394 real draws, the 29 m sprint HUD |

![Survey label over the drawn corridor](../../../_work/e1-drive/browser-corvette-zr1-stock-survey.png)

## 7. Limits

- **The corridor is not a course.** Its measured line crosses two engine-confirmed
  50 m vertical faces (57.82 m, 530.71 m) and runs through a pinch between two
  cliffs at 55.7-59.7 m. No proxy makes that drivable; a new route would be a new
  measurement, not a layout change.
- **The proxy lift is an option, not the default.** It is implemented, labelled and
  measured (it clears the section-join rise), but the corridor still fails at the
  cliff and the verified 29 m physics must not move for no benefit.
- **The survey's engine confirmation depends on the built module.** The artefact
  includes the ray results, so a stale survey fails the canonical comparison; the
  documented build order is module → track → geometry → course → survey → probe →
  verify.
- **The lift variant's hash** is not shipped; the two variants used here
  (`--proxy-lift=0.10`, `--proxy-lift=0.25`) are recorded in
  `_work/logs/e1-drive/p46-build-module-lift0*.log` and the probe files they wrote.
- **No lap, no opponents, no materials** — unchanged from P37/P42.
- **P43's record is historical** where it differs: its "the chassis is the only
  blocker" reading is superseded here (the rise is one blocker of several), and its
  DNF sprint hashes are superseded because the sprint is the 29 m course again.
  The corridor geometry, course artifact and coverage measurements it produced are
  kept and re-verified.

## 8. What changed

| file | change |
| --- | --- |
| `probes/e1-drive/native/e1_drive_lib.cpp` | proxy lift via `m_RenderOffset` (default 0); `e1_info.chassisProxy*`; `e1_diag.collisionBox`; new `e1_ray_probe` |
| `probes/e1-drive/tools/build_module.mjs` | always recompile the harness TU; `--proxy-lift` measurement flag; export `_e1_ray_probe` |
| `probes/e1-drive/web/corridor-survey.js` | **new**: corridor section totals, gates, coverage, path/face crossings, engine confirmation, chassis rise, steepest grade |
| `probes/e1-drive/tools/build_corridor_survey.mjs` | **new**: writes `corridor-survey.json` + the labelled `corridor-survey.html` |
| `probes/e1-drive/tools/corridor_probe.mjs` | **new**: per-car physical limit at the rise and the pinch |
| `probes/e1-drive/tools/build_course.mjs` | kept from P43 (course artifact) |
| `probes/e1-drive/tools/build_geometry.mjs` | kept from P43 (six corridor sections, 394 draws) |
| `probes/e1-drive/tools/extract_track.py` | kept from P43 (corridor collision provenance) |
| `probes/e1-drive/web/app.js`, `index.html`, `style.css` | `?survey=1` label (no rules, timer, result or packet change) |
| `probes/e1-drive/tools/verify_e1_drive.mjs` | corridor survey + limit checks, 514 checks; packet anchors re-pinned |
| `probes/e1-drive/tools/capture_browser.mjs` | `--mode survey` capture |
| `probes/e1-drive/README.md` | sprint = 29 m, corridor = survey, commands and limits |
| `docs/work/verification/T-007-extended-sprint.md` | status note: superseded where it differs |
| `docs/work/analysis/e1-drive-slice.md` §19 | analysis record updated |

## 9. Evidence paths

| path | content |
| --- | --- |
| `_work/e1-drive/run.json` | 514 checks, 0 failures, per-car sprint and corridor probe records |
| `_work/e1-drive/corridor-survey.json` | the measured survey: sections, gates, coverage, crossings, limits |
| `_work/e1-drive/corridor-survey.html` | the labelled survey page |
| `_work/e1-drive/corridor-probe.json` | per-car limit summary (both stations) |
| `_work/e1-drive/corridor-probe-<slug>.json` | per-tick probe rows and inputs per car |
| `_work/e1-drive/browser-evidence-sprint.json` | 15 sprint captures, console and hash agreement |
| `_work/e1-drive/browser-evidence-survey.json` | the `?survey=1` capture and its gates |
| `_work/e1-drive/browser-<slug>-sprint-{start,checkpoint,finish}.png` | sprint screenshots (+ `-car` crops) |
| `_work/e1-drive/browser-corvette-zr1-stock-survey.png` | survey label screenshot |
| `_work/e1-drive/p43-drive-repaired.diff`, `p46-repair.py` | the repaired P43 patch and the mojibake repair |
| `_work/e1-drive/p46-*.mjs` | the scratch probes: proxy, stall, terrain, ray, crossings, width, sweep |
| `_work/logs/e1-drive/p46-*.log` | raw build, probe, verify, capture and asset-probe logs |
