# T-007 — free-roam mode on the P65/P68 spawn basin (`?course=free`)

**Status:** implemented and verified in Node and headless Edge (P69; P74b binds the V2 447-collider layer).
**Course id:** `free`, URL `?course=free` (keyboard) or
`?script=sprint&course=free` (deterministic scripted drive).
**Layout file:** `_work/e1-drive/sprint-free.json`,
file `sha256:60a566f14dafe69a19defbfee4ad4354b66d2541ef8c7a28d4741b47c1582e1c`,
canonical layout hash `sha256:c1829cb2f9c99e12fb0d147c6aa3f0ddf9f90e232a1c3f51ada262acffab80a6`.
**Inputs (read-only):** `_work/free-roam/regions.json` (P65),
`_work/free-roam-prop/colliders-r04-v2.json` (P74 R04-V2), the committed
`_work/e1-drive/spawn.json`, `_work/e1-drive/geometry.json` and
`probes/prop-collision/lib/resolver.mjs`.

## 1. What this mode is

A fourth playable layout next to the unchanged 310 m sprint (default), the 29 m
regression straight (`?course=short`) and the P61 three-lap race
(`?course=lap`):

| item | free roam |
| --- | --- |
| spawn | `(-88, 1050)`, committed heading `pi/2` (`spawn.json`) |
| basin | P65 `R04`, 9,689.5 m², 100 % drawn (`g56-n289`) |
| containment | the measured P68b spawn-component box `x -108.5…5.0, z 1027.5…1164.0` + 2.0 m |
| gates / finish / lap | **none** — no checkpoint, no finish, no lap counter, no corridor respawn, no invisible wall |
| timer | a session clock (engine ticks / 60), not a race time |
| visible props | **P74 R04-V2 `all-visible` manifest, 447 colliders** |
| reset | `R` returns to the spawn; containment resets only out-of-box / below-ground / airborne |
| ghost | not available (stated in the HUD, `G` inert) |

The mode does not touch the other three layouts: their layouts, gates, rules,
hashes and browser captures are unchanged, and the verifier's whole existing
block still passes.

## 2. Layout derivation

`web/sprint-layout.js` → `deriveFreeRoamLayout(geometry, spawn, regionsDoc, { propContacts, carEnvelope })`.
Nothing is typed in except the committed spawn and the measured P68b box:

| field | value | source |
| --- | --- | --- |
| spawn / ground | `(-88, 1050)`, heading `1.5707963267948966` rad, ground `5.807372 m` | `spawn.json` + collision mesh |
| basin | `R04`, 9,689.5 m², bounds `[-108.5, 104.0, 1012.5, 1293.0]` | P65 `regions.json` (pinned, hash checked) |
| containment box | `x -108.5…5.0, z 1027.5…1164.0` | P68a/P68b spawn component |
| spawn-component area | 7,702.25 m² (committed manifest) / 7,415.00 m² (extended) | P68a / P68b |
| eastern channel | 1,321.25 m², **not** reachable, **not** spawned into | P68a (C03 prop wall) |
| margin | 2.0 m, out-of-box reset only | this task, declared |
| fall / airborne | > 1.0 m below local ground / 30 ticks | same rule shape as the sprint |
| ground lattice | 2 m over the box: 57 × 69 cells, **3,418 measured + 515 filled** | collision mesh, re-sampled |
| draw coverage | 9,687/9,687 = **100 %** at 1 m, section `g56-n289` | P65 measurement, consumed read-only |
| containment probe | `(-24.5, 1037.5)`, 31.5 m to the boundary, max ground step 0.0221 m/m | derived, see below |

The 2 m ground lattice takes the highest collision triangle at each cell. Cells
without one (the rectangle also covers void/pocket corners that are not part of
the component) are filled from the nearest measured cell by a deterministic
8-connected BFS; the count is recorded and never hidden. The rules always read a
finite local ground.

**Containment probe (measured, not typed in).** The layout scans every lattice
cell and keeps the *easternmost* cell whose straight 1 m samples east reach the
reset boundary over a collision surface with no step above 5 cm per metre (the
P48 calibration) and no P68b `all-visible` contact. The result is
`(-24.5, 1037.5)`, 31.5 m to the `x = 7.0` boundary. It is used only by the
containment test, never by the spawn.

The box is a **bounding rectangle**, not the exact free mask: it includes the
eastern-channel corner and southern void corners. That is deliberate — the task
asks for box containment — and it is why the rule is a reset, not a wall.

## 3. Rules

`web/sprint-rules.js` → `FreeRoamRules` has the same public surface as
`SprintRules`/`LapRules` (`reset/prime/rejoin/step/gateInput/snapshot/
respawnTarget`) so the page, capture probe and verifier share one shape:

- phase is `running` from the settled spawn tick; **no countdown** (`ticks: 0`);
- `gateInput` is a pass-through (no zero-input hold, no finish brake);
- `step` only observes and tests containment:
  - outside `[minX - 2, maxX + 2] × [minZ - 2, maxZ + 2]` → `outside-bounds`;
  - chassis more than 1 m below the nearest measured ground → `below-ground`;
  - 30 consecutive airborne ticks → `airborne`;
- every reset rebuilds at `(-88, 1050)` at `pi/2` (never a corridor point);
- `R` (`e1_reset`) rebuilds at the spawn and restarts the session clock.

## 4. Visible-prop layer

The layer is the same additive post-tick pose resolver as the lap, but
`web/prop-layer.js` now takes a **manifest/profile/hash pin set** as a parameter:

| pin | lap | 310 m sprint | free roam |
| --- | --- | --- | --- |
| manifest | `_work/prop-collision/colliders-v2.json` | same | `_work/free-roam-prop/colliders-r04-v2.json` |
| file SHA-256 | `sha256:33488752…751d7` | same | `sha256:b1b8f2c9…18211` |
| content SHA-256 | `sha256:73620739…db9ee` | same | `sha256:663e2570…20b38` |
| variant | `playable-regions-v2` | same | `free-roam-r04` |
| profile | `all-visible` | `roadside` | `all-visible` |
| manifest colliders | 651 | 651 | **447** |
| profile colliders | 651 | 553 | 447 |
| active layer | 651 | **544** (553 − 9 measured driven-line exclusions) | **447** |

A world whose profile or collider count disagrees with its pins is a hard
failure (`createPropLayer` throws a typed `PropManifestError`); the page also
hashes the manifest bytes before parsing and rejects a changed file. **No
manifest was regenerated or modified.** The 310 m measured exclusion set is
documented in §10 and `docs/work/analysis/e1-drive-slice.md` §31.

Measured on the real V2 colliders (`profile all-visible`):

| test | result |
| --- | --- |
| free spawn pose | **0 contacts** (447 colliders active); 6.165 m from the nearest prop |
| 31 m/s head-on into the 5.386 × 2.219 m wreck `level.instance.00` | blocks on the near face after 165 ticks; max penetration **0.0728 m** (≤ one 8 cm substep), residual **0**, stays on the approach side (4.184 m = car half-length + target half-depth) |
| 31 m/s into the 0.02 m container panel `river.block56.node289.draw.143.component.072` | blocks after 160 ticks; max penetration **0.0728 m**, residual **0**, no pass-through (1.501 m on the approach side) |
| 31 m/s head-on into the free concrete pipe `draw.95.component.004` | blocks after 101 ticks; first contact is the neighbouring pipe `draw.95.component.002` at side **2.032 m**; residual **0**, max penetration **0.0728 m**, no tunnelling |
| four-direction rays around the pipe | **4/4 blocked**; all four first hits are other `draw.95` pipe components in the cluster |
| 31 m/s into the free steel pole `draw.283.component.327` (single-collider world) | stops on the target at side **1.501 m**, residual **0** |
| five-car free drive | 447 colliders active, **0 contacts, 0 blocked ticks** |

The layer is a kinematic 2.5D response: it resolves the pose handed to the
packet, rules observer and camera after each engine tick. It is not retail
collision, has no rotation sweep, suspension or vertical dynamics, and box
penetration is bounded by one substep.

## 5. Scripted five-car free run

`web/sprint-script.js` → `freeScriptInput(tick, speed)` is a speed-capped,
tick-only diagnostic drive (throttle → tight left turn in the spawn bowl → run
west along the bowl → brake). It has no path follower and no route file; the
input is a pure function of the tick and the measured speed, so two runs are
identical. It is a diagnostic manoeuvre, not a claimed racing line.

`node probes/e1-drive/tools/verify_e1_drive.mjs` (401 ticks = 400 steps plus
the settled tick 0 per car):

| car | travel | max speed | prop contacts | respawns | contained | state-sequence hash |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| Corvette ZR1 | 24.635 m | 7.067 m/s | 0 | 0 | yes | `sha256:bede912e…05a3b920` |
| Lotus Exige Cup260 | 22.710 m | 6.273 m/s | 0 | 0 | yes | `sha256:f198bd7b…8f383f8e` |
| Dodge Challenger | 25.594 m | 7.044 m/s | 0 | 0 | yes | `sha256:ee6018bf…6a0f2369` |
| Ford Focus RS (FWD) | 23.344 m | 6.795 m/s | 0 | 0 | yes | `sha256:f590e4ad…bc27390b` |
| Audi R8 V10 (AWD) | 29.198 m | 7.076 m/s | 0 | 0 | yes | `sha256:4d4a4323…79ade5ca` |

Every car: wheel contact on every tick, 0 non-finite states, 0 prop contacts,
0 containment resets, replaying the recorded inputs without the rules/layer
reproduces every raw state hash, the packet validates as v1.1 with nine
matrices per update and the free script label.

## 6. Containment and restart

Rules-level (synthetic states, the established sprint-rule test shape):

| case | result |
| --- | --- |
| `x > maxX + 2` / `z > maxZ + 2` | 1 respawn, reason `outside-bounds`, target `(-88, 1050, pi/2)` |
| `x = maxX + 1.5` (inside the margin band) | 0 events |
| inside the box | 0 events |
| 1.2 m below the local measured ground | 1 respawn, reason `below-ground` |
| 30 airborne ticks | 1 respawn, reason `airborne` |
| every reset target | the committed spawn, never a corridor point |

Real engine (`runFreeContainmentScenario`, default car): the derived lane
`(-24.5, 1037.5)` is driven east at full throttle. At **tick 199**, at
`(7.076, 5.479, 1040.733)` (`x > maxX + 2`), the rules fire
`outside-bounds`; the world is rebuilt and the car is **0.0053 m** from the
committed spawn. Thirty further settled ticks produce **0** extra events.
This also records the honest finding behind the rule: the R04-V2
`all-visible` layer leaves a sub-cell slot at the C03 clearance ring (the real
boxes are > 1.68 m apart there while the 0.5 m raster + 1.0 m erosion closes
it), so the box reset is what keeps the car in the measured component — there
is no invisible wall.

`R` (`runFreeRestart`): after 200 scripted ticks (`(-88.83, 1057.14)`),
`e1_reset()` returns to `(-87.995, 6.165, 1050)`, **0.0053 m** from the spawn,
tick 0, session clock 0, 0 respawns, phase `running`. The page's reset capture
sees the same: `restarts === 1`, tick-0 state hash equal to the node run's
tick-0 hash, 0.005 m from the spawn.

## 7. Browser capture

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
& $node probes/e1-drive/tools/build_sprint.mjs
& $node probes/e1-drive/tools/verify_e1_drive.mjs
& $node probes/e1-drive/tools/capture_browser.mjs --mode free
```

`--mode free` drives all five cars through `?script=sprint&course=free` and
captures four frames per car: `free-spawn` (tick 0), `free-mid` (tick 200),
`free-prop` (the measured closest-prop approach tick), and `free-reset` (tick 0
after pressing `R` in place). Each frame holds the exact node tick and compares
the browser state hash, the car matrix (bit-equal), all nine matrices (1e-12),
the camera (1e-6), the geometry uploads, the draw count, the 447-collider layer
and the HUD text, and requires a clean console.

Result: **PASS** — 20 captures (5 cars × 4 frames), **0 console messages of any
kind**, **0 assertion failures**, **20/20** browser state hashes equal to the
node free-roam states, every car matrix bit-identical, max camera delta
**4.55e-13**, max matrix delta **1.11e-16**, **14/20** packet hashes byte-exact
(the six differences are the documented Node 24 / Edge 156 last-bit
transcendental cases, checked separately by the state hash and the matrix/camera
tolerances). Every frame: `profile all-visible`, 447 colliders, 0 contacts; the
HUD reads `FREE ROAM · R04 spawn basin`, `no gates/finish/lap`, the containment
box, `speed`, `position` and the prop row; no countdown and no results overlay.

Screenshots (one set per car):
`_work/e1-drive/browser-<slug>-free-{spawn,mid,prop,reset}.png`.
Evidence: `_work/e1-drive/browser-evidence-free.json`
(`sha256:4b38a289…c109073`), log `_work/logs/e1-drive/edge-free.log`.

The prop-approach frame is the run tick with the smallest upper bound on the
car-to-collider clearance (measured by growing the car envelope until the 447
world reports a contact): Corvette/Lotus/Dodge/Focus pass 3.5–3.75 m from the
building `level.instance.05` at ticks 74–82; the faster Audi finishes 1.75 m
from the west fence `…draw.139.component.002` at tick 356. These are approaches,
not contacts: the run's prop contact count is 0 on every tick.

## 7b. Collision-v2 browser capture

`node probes/e1-drive/tools/capture_browser.mjs --mode collision-v2 --port 8802`
drives the real page and the real additive layer into a reachable lap structure
and the free concrete pipe. The start pose is derived from the manifest target
record (`distanceMetres` outside the near face along `axis`); the engine gets
full throttle until the layer reports its first contact and then brake +
handbrake. No race rules, gates or timer are active (`phase collision-probe`).

| target | car | first contact (node probe) | stopped side | stopped speed | contacts |
| --- | --- | ---: | ---: | ---: | ---: |
| lap no-parking sign `draw.257.component.000` | Corvette | tick 65 | 2.314 m | 0.009 m/s | 72 |
| | Lotus | 68 | 2.264 m | 0.018 m/s | 76 |
| | Dodge | 69 | 2.673 m | 0.064 m/s | 49 |
| | Focus | 75 | 2.607 m | 0.013 m/s | 45 |
| | Audi | 51 | 1.962 m | 0.001 m/s | 47 |
| free concrete pipe `draw.95.component.010` | Corvette | 114 | 2.875 m | 0.017 m/s | 53 |
| | Lotus | 112 | 2.712 m | 0.009 m/s | 58 |
| | Dodge | 122 | 2.855 m | 0.023 m/s | 51 |
| | Focus | 118 | 2.868 m | 0.003 m/s | 59 |
| | Audi | 85 | 2.771 m | 0.001 m/s | 61 |

Frames: approach tick 30 (0 contacts), stopped tick 360, settled tick 420; the
stopped and settled poses differ by < 0.05 m for every car. Result: **PASS** —
30 captures (5 cars × 2 targets × 3 frames), **0 console messages**, **0
assertion failures**, every frame reports the pinned V2 layer (651 lap / 447
free), and the HUD states `COLLISION PROBE` and the target id. Screenshots:
`_work/e1-drive/browser-<slug>-collision-{lap-sign,free-pipe}-{approach,stopped,settled}.png`.
Evidence `_work/e1-drive/browser-evidence-collision-v2.json` (30 captures). The
44 m building wall `draw.355` is proven in the resolver at its own terrace
ground; it cannot be reached by the car from the loop, so the capture uses the
reachable lap sign. That substitution is stated, not hidden.

## 8. Verification

| gate | result |
| --- | --- |
| `node probes/e1-drive/tools/verify_e1_drive.mjs` | **856/856 checks, 0 failures** |
| 310 m / 29 m / lap / ghost blocks | unchanged; every previously pinned state hash, finish, lap time and ghost byte still matches. The 310 m layer is 544 active (V2 roadside 553 minus 9 measured driven-line exclusions) with 0 contacts |
| free determinism | two consecutive runs, identical five state-sequence hashes (pinned in `FREE_ANCHORS`) |
| `python tools/verify_asset_probe.py --skip-build` | **36/36 PASS** |
| `python tools/check_e1_poc.py` (server up) | **21/23** — its two free-roam items still pin the V1 `colliders-r04.json` (431 colliders + V1 hashes); the P74 V2 free layer is 447 and the checker is outside this task's file scope (`tools/`) |
| `capture_browser.mjs --mode free` | PASS, 0 console, 0 assertions, 20/20 state hashes, 447-collider layer |
| `capture_browser.mjs --mode sprint` | PASS, 0 console, 20/20 state hashes and finish times with the 310 layer (544 active); evidence `browser-evidence-sprint.json` (`sha256:74545aec…4523365`) |
| `capture_browser.mjs --mode collision-v2` | PASS, 0 console, 30 captures, lap sign and free pipe stopped; see §7b |
| `capture_browser.mjs --mode lap` / `--mode props` (regression) | PASS, 0 console; props 25/25 level-prop captures, lap Corvette 4/4 state hashes (full 5-car lap capture left to the main agent because of headless lap frame time; Node covers all five) |
| `_work/e1-drive/run.json` | all checks, the `sprint.freeRoam` and `propV2` blocks; the file also carries per-run timings, so the determinism record is the five pinned state-sequence anchors, not its file hash |

New verifier checks: the P65 regions artifact and R04, the P74 R04-V2 manifest
pins and 447-collider world, the base V2 pins per mode (310 roadside 553 minus
9 measured driven-line exclusions = 544; lap all-visible 651), the derived
layout (no hand edits), its structural validation, no gates/finish/lap/countdown,
the committed spawn/heading, the measured box and margin, the measured ground
lattice, the measured containment lane, spawn clearance, the truck head-on, the
0.02 m no-tunnelling case, the lap wall / free pipe / sign / pole head-ons, the
8/8 four-direction rays, per car spawn/contained/no-respawn/contact/NaN/replay/
anchor/packet, the synthetic containment cases, the real-engine boundary reset
and the `R` restart.
Artifacts: `_work/e1-drive/sprint-free-<slug>.json` (ticks, inputs, hashes,
capture expectations) and `sprint.freeRoam` in `run.json`.

## 9. Limits

1. **One basin, one spawn.** Free roam is the P65 `R04` basin at the committed
   spawn. It is not a second route, not a lap and not the eastern channel behind
   the C03 wall.
2. **Box containment, not the exact mask.** The reset box is a rectangle; the
   measured free component is smaller (7,702.25 m² committed / 7,415.00 m²
   extended). It includes void/pocket corners, which is why the ground grid
   fills 515 of 3,933 cells from the nearest measured cell. The rule is a reset,
   not a physical wall.
3. **Draw coverage is the P65 measurement.** The layout consumes the 100 %
   1 m coverage of R04 read-only; it does not re-sample the basin. The free
   drive itself is fully drawn (it stays in the R04 bowl).
4. **Visible-mesh prop approximation.** Colliders are minimum-area boxes fitted
   to visible components; the layer is a kinematic post-tick pose resolver with
   no rotation sweep, suspension or vertical dynamics. Box penetration is
   bounded by one 8 cm substep. It is not retail collision.
5. **The scripted run is a diagnostic.** A speed-capped tick-only manoeuvre of
   23–29 m, chosen by measurement for containment and prop clearance; it is not
   a racing line, a route or a lap. Five roster cars, one run each.
6. **The containment probe lane is a test device.** It is derived from measured
   ground + the 447 colliders and used only to prove the reset fires. The slot it
   exits through is a sub-cell gap in the clearance model, recorded above.
7. **The free-roam manifest is a region replacement.** `colliders-r04-v2.json`
   contains the reachable R04 component + 30 m ring (447), not the 310 m band;
   the base V2 file is used for the timed and lap courses. Do not cross-load.
8. **The 310 m timed course has 9 measured driven-line exclusions.** They are
   the only V2 roadside colliders that the committed scripted line actually
   grazes; excluding exactly those nine keeps all five anchored sprint runs
   bit-identical. They are recorded with ids/arcs, not silently removed. The
   manifest and profile (553) are unchanged.
9. **No full-game claim.** No opponents, traffic, AI, race audio, multiplayer,
   streaming or retail mode; one level, one basin, one manifest, five cars.
   Ghost replay, best times, lap and checkpoint rules are not part of free roam.

## 10. Evidence

| path | content |
| --- | --- |
| `_work/e1-drive/sprint-free.json` | free-roam layout: spawn, box, containment, measured ground lattice, containment probe, P65 coverage, P74 R04-V2 prop pins |
| `_work/e1-drive/sprint-free-<slug>.json` | per-car free run: 401 state rows, inputs, state sequence hash, containment, prop snapshot, four capture expectations |
| `_work/e1-drive/run.json` | all checks, `sprint.freeRoam` and the top-level `propV2` block |
| `_work/e1-drive/browser-evidence-free.json` | 20 captures, console, assertions, hashes, matrices, cameras |
| `_work/e1-drive/browser-evidence-collision-v2.json` | 30 collision captures (5 cars × 2 targets × approach/stopped/settled), sides, contacts, hashes |
| `_work/e1-drive/browser-<slug>-free-{spawn,mid,prop,reset}.png` | screenshots (5 cars × 4 frames) |
| `_work/e1-drive/browser-<slug>-collision-{lap-sign,free-pipe}-{approach,stopped,settled}.png` | collision screenshots (5 cars × 2 targets × 3 frames) |
| `_work/logs/e1-drive/edge-free.log` | headless Edge log |
| `_work/logs/e1-drive/edge-collision-v2.log` | headless Edge collision-probe log |
| `_work/e1-drive/sprint-driven-exclusions.json` | measured 9-id 310 m driven-line exclusion artifact (ids, arcs, source ghost hashes) |
| `_work/logs/e1-drive/p74b-*.log` | build, derive, verify, capture, asset-probe and PoC logs |
| `probes/e1-drive/web/prop-layer.js` | V2 manifest/profile/hash pin sets and the measured `SPRINT_DRIVEN_EXCLUSIONS`, typed `PropManifestError` |
| `probes/e1-drive/tools/derive_sprint_exclusions.mjs` | sweeps the committed reference ghosts to derive the 9 ids |
| `probes/e1-drive/web/app.js` | per-course manifest binding, `?collisionprobe=lap-sign\|free-pipe` |
| `probes/e1-drive/tools/build_sprint.mjs` | writes the fourth layout |
| `probes/e1-drive/tools/verify_e1_drive.mjs` | free layout/run/containment/restart/prop checks |
| `probes/e1-drive/tools/capture_browser.mjs` | `--mode free` |
| `probes/e1-drive/tools/serve.mjs` | read-only `/_work/free-roam-prop/` route |
