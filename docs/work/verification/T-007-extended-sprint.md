# T-007 extended sprint — the measured 539.81 m corridor and the chassis grade limit

**Date:** 5 November 2026
**Owner:** P43 (sub-agent)
**Status:** **historical record, superseded where noted by
[`T-007-ledge-fix.md`](T-007-ledge-fix.md) (P46, 5 November 2026).** The corridor
geometry, the `course.json` artifact, the four gates and the coverage numbers below
are kept and re-verified. Superseded claims: (a) the chassis grade limit is **one**
blocker, not the only one — the measured line also crosses two engine-confirmed 50 m
vertical collision faces (arc 57.82 m and 530.71 m), so the corridor is not drivable
by any proxy; (b) the playable sprint is **back to the 29 m straight** and the
corridor is a labelled survey (`?survey=1`, `corridor-survey.json`); (c) the DNF
sprint hashes below are therefore historical. The proxy fix was implemented and
measured in P46 (`--proxy-lift`, default 0) and is **not** the shipped physics.
**Scope:** `probes/e1-drive/**`, `_work/e1-drive/**`, `_work/logs/e1-drive/**`,
`docs/work/analysis/e1-drive-slice.md` §19 and this record. No change to the
engine, the wasm module, `probes/track-coverage/`, `probes/render-packet/`,
`probes/car-parts/`, `tools/`, `upstream/` or `game-data/`. Physics and collision
surfaces are unchanged; the collision provenance mesh only gained the triangles
that intersect the measured corridor box.

## Result

The drive slice **draws and measures the whole 539.81 m corridor** and the sprint
layout places its start, two checkpoints and finish **on the measured path** with
99.73 % re-measured coverage. The scripted car, however, **cannot drive it**: the
E1 chassis is the documented box proxy whose skid plate sits at ground level, and
the collision surface under the measured path rises **6.4 cm in 0.94 m (6.7 %)** at
the `g58 → g50` section join (the full rise across that seam is 7.16 cm). All five
roster cars stop there.

`verify_e1_drive.mjs` is **490/496**. The six failures are exactly one recorded
drivability check plus one DNF check per car — no other check regressed. This is a
measured, reproducible blocker, not a control-tuning issue: the same car drives
the 29 m P37 sprint and 53 m of the corridor, then stalls with all four wheels in
contact and 0.07–0.53 m/s.

## 1. Track visual: six corridor sections

`tools/build_geometry.mjs` now merges the instructed `block88/node283` section
with the six measured corridor sections. `block56/node289` still comes from its
pinned `level_inspect` reference; the other five come from the pinned 46-section
track-coverage draw map (`_work/track-coverage/visual.json`, SHA-256
`877b4dc7…aabcb67`), each pinned again by the positions/indices hashes that
track-coverage measured. `build_geometry.mjs` asserts that the two independent
readers agree exactly on `block56/node289` before using either.

| section | source | draws | triangles | vertices | course metres |
| --- | --- | ---: | ---: | ---: | ---: |
| `river.block88.node283` | level_inspect | 95 | 9,343 | 17,782 | — |
| `river.block56.node289` | level_inspect | 49 | 9,824 | 14,508 | 19.67 |
| `river.block58.node265` | track-coverage map | 41 | 7,393 | 12,227 | 45.01 |
| `river.block50.node265` | track-coverage map | 44 | 7,740 | 13,874 | 31.55 |
| `river.block71.node209` | track-coverage map | 56 | 6,736 | 11,524 | 303.23 |
| `river.block64.node209` | track-coverage map | 40 | 6,688 | 11,145 | 130.90 |
| `river.block59.node265` | track-coverage map | 69 | 9,409 | 15,434 | 8.04 |
| **corridor subtotal** | | **299** | **47,790** | **78,712** | **539.81** |
| **merged visual** | | **394** | **57,133** | **96,494** | |

The corridor subtotal is exactly the measured 299 / 47,790 / 78,712 from
`docs/work/analysis/track-coverage.md` §4.3; no section is duplicated (7 unique
sections, 394 unique draw ids). Draw ranges are the source ranges; the geometry
still has **2 meshes** (level + one track visual), so the browser still performs
**3 geometry uploads** per load.

`_work/e1-drive/geometry.json` — 16,971,391 B,
`sha256:1ba1e25ca54217666e08d853057c5195be35f40b1f4f063c536a16cee673e621`.

### 1.1 Collision provenance

`tools/extract_track.py` now selects the union of the legacy drive box and the
measured corridor box (read from `_work/track-coverage/corridor.json`, +10 m
margin) with a triangle-AABB-intersects-box rule, because an "all vertices inside"
rule left holes where the low-poly valley triangles cross the box edge. The
provenance mesh is 3,599 vertices / 5,933 triangles (3,845 covered by a corridor
draw, 2,088 without). It is still `visible:false` and is **not** uploaded; the
wasm wheels still trace the complete `Level.levelphysics` file.

## 2. Course and gates

`tools/build_course.mjs` copies the measured 0.25 m samples
(`course_samples.json`, SHA-256 `fe44e27b…dfbb1f76`) and accumulates their arc
length. No smoothing, rounding or invented point reaches the course line.

`_work/e1-drive/course.json` — 278,779 B,
`sha256:a7c7350fe0dd631ae31015ecfaf75c4028fe57b0e30bf0b06f4c4d27e1443444`,
hash `sha256:5a8753fb…db00d0`, 2,257 samples, 2,251 covered, 3 gaps (1.413 m),
length **539.808 m**.

`web/sprint-layout.js` (v2) places the gates on that line:

| gate | arc (m) | point (x, z) | path tangent | width | surface delta |
| --- | ---: | --- | --- | ---: | ---: |
| start | 0.000 | (−88.0, 1050.0) | −Z (π) | 6 m | 0.0007 m |
| checkpoint 1 | 179.880 | (30.0, 1066.5) | 0.258 rad | 6 m | 0.0006 m |
| checkpoint 2 | 359.801 | (130.0, 1205.0) | 0.669 rad | 6 m | 0.0005 m |
| finish | 537.687 | (266.5, 1302.5) | 1.881 rad | 6 m | 0.0005 m |

- Checkpoints are the measured samples nearest the 1/3 and 2/3 arcs
  (179.88 m / 359.80 m; requested 179.936 / 359.872).
- The finish is the last measured sample before `539.808 − 2 m`
  (537.687 m, **2.121 m before the corridor end**).
- Every gate line is **perpendicular to the 5 m path tangent at its sample**
  (|dot| ≤ 1e-3), every gate point **is** a measured sample, and every gate line
  is re-measured independently: 61/61 samples have a collision triangle and a real
  draw within **0.5 m of that collision surface** (track-coverage rule).
- No gate needed narrowing (all six-metre lines are covered).

### 2.1 Coverage re-measured

The verifier re-measures all 2,248 course samples inside the finish with its own
barycentric code and plane-height formula: 2,245/2,248 collision hits,
2,242/2,248 draws within 0.5 m (6 misses = the three measured seams), recorded
coverage 2,242/2,248 = **99.733 %**, gap total **1.414 m** in **3** runs. The
values agree with P41's 99.734 % / 1.413 m to rounding.

### 2.2 Driver control reference

The measured path is a 1 m-grid Dijkstra line with 45° staircase kinks; no car can
follow it. `sprint-layout.js` therefore derives a **control reference** as an 8 m
moving average of the measured path, re-tests every point against the measured
path and the measured corridor band, and **fails the derivation** if the line
leaves the band. Recorded: max deviation 0.803 m, minimum band margin 1.197 m.
The course, gates and progress stay on the measured samples; the reference is a
driver aid only and is labelled as such in the layout.

## 3. Rules (v2, path-based)

| rule | implementation |
| --- | --- |
| progress | nearest point on the measured polyline; `progress = maxArc / finishArc`, clamped |
| next gate | distance along the path to the next gate (`arc − currentArc`) |
| off-course | lateral distance to the measured path > measured band half-width at that arc + 1 m (band = `max(3, width/2 + 1)`) |
| below-ground | **local** measured ground at the car's arc − 1 m (not the spawn height; the corridor descends 2.8 m) |
| respawn target | the gate point and **gate heading** of the last passed checkpoint |
| gate crossing | signed side of the arbitrary A→B gate segment (unchanged maths, now arbitrary segments) |
| restart | `R` / `e1_reset()` produces the identical input sequence, state hashes and result |

The previous absolute-spawn fall rule was a real bug on a descending course and is
fixed here: the car at arc 300 sits ~2 m below the spawn and is healthy.

## 4. Scripted sprint — measured DNF

`web/sprint-script.js` is now a real path follower: Stanley control (heading error
to the 8 m reference tangent + lateral term + yaw damping), a speed target from
the measured band ahead and the reference curvature, and a launch guard. It is a
pure function of the engine state and the committed layout.

The run stops on a deterministic stall rule (600 ticks without 5 cm of new arc) or
at the 3600-tick bound. Per car (`_work/e1-drive/sprint-<slug>.json`):

| car | ticks | stopped | max arc | progress | last position | last speed | state sequence |
| --- | ---: | --- | ---: | ---: | --- | ---: | --- |
| Corvette ZR1 | 1,633 | stuck | 53.81 m | 0.1001 | (−51.90, 1014.23) | 0.38 m/s | `sha256:7a452dfd…57eb4a` |
| Lotus Exige Cup260 | 1,434 | stuck | 53.37 m | 0.0993 | (−52.58, 1014.12) | 0.53 m/s | `sha256:50818707…7f87af` |
| Dodge Challenger | 1,366 | stuck | 53.23 m | 0.0990 | (−52.59, 1014.34) | 0.25 m/s | `sha256:3f3b7544…35ee79` |
| Ford Focus RS (FWD) | 1,272 | stuck | 53.48 m | 0.0995 | (−52.93, 1014.03) | 0.17 m/s | `sha256:afd971df…b40449` |
| Audi R8 V10 (AWD) | 3,048 | stuck | 53.72 m | 0.0999 | (−52.01, 1014.22) | 0.07 m/s | `sha256:883024cb…3910e` |

Every car: 0 respawns, wheel contact on **every** tick, **0** non-finite states,
input replay without rules reproduces **every** state hash, and the restart in one
instance reproduces the same record. The cars differ in how long they fight the
rise (1,272–3,048 ticks), which is the unchanged physics responding to different
masses and drivetrains.

### 4.1 The blocker, measured

The collision surface under the measured path around arc 52–53:

| arc (m) | point | collision height | drawn height |
| ---: | --- | ---: | ---: |
| 52.43 | (−54.00, 1014.00) | 5.6403 | 5.6296 |
| 52.66 | (−53.83, 1013.83) | 5.6583 | 5.6287 |
| 52.90 | (−53.67, 1013.67) | 5.6762 | 5.6278 |
| 53.13 | (−53.50, 1013.50) | 5.6940 | 5.6269 |
| 53.37 | (−53.33, 1013.33) | 5.7119 | 5.6260 |

The collision surface rises **7.16 cm across the seam (from arc 52.43 to 53.37); the
verifier's first 1 m window above 5 cm is 6.36 cm in 0.94 m = 6.7 %** while the drawn
road stays flat: this is the `g58 → g50` section join (coverage gap 1 of 3). A direct
probe (`_work/e1-drive/p43-ledge.mjs`) shows the car cannot move south across it from
rest at full throttle, while the same car drives north (downhill) and climbs 2.5 %
grades elsewhere. The box chassis rides on a skid plate at ground level
(`packet-adapter.js`: `carBodyShape: box-from-XT-geometry`), so a 7 cm lip strikes
the plate and stops it. This is a **vehicle-proxy limit**, not a corridor-survey
error; the real full-chassis car has suspension travel the proxy does not model.

Consequences: the two checkpoints (179.9 m, 359.8 m) and the finish (537.7 m) are
**unreachable in this PoC**. The `g64 → g59` hump near arc 528–535 (up to 31 %
local grade, 61 cm total) is a second, later blocker.

## 5. Verification gate

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"

& $node probes/e1-drive/tools/build_course.mjs
& $node probes/e1-drive/tools/build_geometry.mjs
& $node probes/e1-drive/tools/build_sprint.mjs
& $node probes/e1-drive/tools/verify_e1_drive.mjs
& $node probes/e1-drive/tools/capture_browser.mjs --mode sprint --port 8813
python tools/verify_asset_probe.py --skip-build
```

Recorded:

- `verify_e1_drive.mjs` — **490/496 checks, 6 failures** (the drivability check and
  the five per-car finish checks). The 490 passing checks include the new geometry
  totals, the pinned course artifact, the layout re-derivation, the independent
  course and gate re-measure, the coverage parity, the reference-line margin, the
  direction probe, the path-based rule tests, the per-car contact/NaN/replay/
  restart checks and all pre-existing drive, camera, telemetry, reset and soak
  checks.
- `capture_browser.mjs --mode sprint` — **15 captures** (5 cars × start / mid /
  stop), **0 console messages of any kind**, all browser gates clean,
  **10/15 packet hashes byte-exact**; the five differences are the documented
  Node-24 vs Edge-156 `Math.atan2`/`Math.sin` last-bit differences with camera
  ≤ 1.1e-13 and the car matrix bit-identical. Geometry uploads: **3** per page,
  `drawsIssued = frames × draws`, nine matrices per rendered tick.
- `python tools/verify_asset_probe.py --skip-build` — **Passed 29 checks**
  (`_work/logs/e1-drive/verify-asset-probe-p43.log`).
- `soak_browser.mjs --minutes 5 --runs 2` — **PASS**: two 18,000-tick (300 s)
  sessions in fresh pages, 7 drive / 7 corridor-sprint / 6 telemetry segments each,
  **20 identical checkpoint records** across the two runs, **0 console messages**,
  p50 frame 7.75 / 7.94 ms, 0 long frames, no NaN. The sprint segment now ends at
  the measured stall (≈1,600 ticks) instead of the 3,600-tick cap; the page and the
  soak tool use the same deterministic stall rule.
  `_work/e1-drive/browser-evidence-soak.json`,
  `_work/logs/e1-drive/edge-soak-p43.log`.

### Recorded sprint/track hashes

| file | SHA-256 |
| --- | --- |
| `_work/e1-drive/geometry.json` | `sha256:1ba1e25ca54217666e08d853057c5195be35f40b1f4f063c536a16cee673e621` |
| `_work/e1-drive/course.json` | `sha256:a7c7350fe0dd631ae31015ecfaf75c4028fe57b0e30bf0b06f4c4d27e1443444` |
| `_work/e1-drive/sprint.json` | `sha256:db85843e986f117e040141ffb62c5e9a645f8b941286782f9053cb8d8a8fe455` |
| sprint layout hash | `sha256:51c840b41d728e986a14a9fb027e73e1f4d0ff6e942b9c5ef235850f38c4dfa4` |
| `_work/e1-drive/track.json` | `sha256:d49bc468a8667389c6480fc6117ab617e570d5f704410d5e1b1dd90f8d9a839c` |

## 6. Browser evidence

Headless Edge/WebGPU, 1600×900, adapter `nvidia / blackwell`:

| screenshot | what it shows |
| --- | --- |
| `browser-<slug>-sprint-start.png` | countdown `3`, car on the start line, timer 0.000 s |
| `browser-<slug>-sprint-mid.png` | corridor road + props, `394 real draws · 57133 tri · no-draw 2088 tri · slab hidden`, `0/2 cp · next checkpoint-1 in 126.2 m · 10 %` |
| `browser-<slug>-sprint-stop.png` | the recorded DNF tick, car stalled at the 6.7 % rise, same HUD, no results overlay |

The `mid` capture is the tick at half of the checkpoint tick (or half the run when
no checkpoint is reached); `stop` is the verifier's recorded DNF tick. All frames
show the real corridor draws; the diagnostic slab stays hidden.

## 7. Limits

> **P46 (5 November 2026):** this section's "fix options, all outside this slice's
> ownership" were resolved in `T-007-ledge-fix.md`. Option (a) was implemented
> (`--proxy-lift`, element offset, no mass/COM/inertia change) and measured: it
> clears the 6.4 cm section-join rise, but the corridor still fails at a 50 m
> vertical collision face it crosses at arc 57.82 m (and 530.71 m), engine-confirmed.
> Option (c) was shipped: the playable sprint is the 29 m straight and the corridor
> is a labelled survey over the same drawn track visual. Option (b) was not taken:
> a course ending before arc 52 m is shorter than the minimal fix and still leaves
> the corridor's own line crossing the cliff.

- **The extended sprint cannot be completed by this chassis.** The measured
  corridor crosses a 6.7 % collision rise at arc 52.66 m and a 31 % local hump near
  arc 528–535. The box-proxy skid plate stops the car at the first. The layout,
  gates, coverage and rules are measured and verified; the finish is not reached.
- **Fix options, all outside this slice's ownership:** (a) give the proxy a raised
  body/skid plate or suspension travel (engine/harness change); (b) accept a
  shorter sprint that ends before arc 52 (a 50 m course, not the measured
  corridor); (c) keep the corridor as visual-only and retain the 29 m P37 sprint
  as the playable course.
- **No lap.** The corridor is point-to-point; P41 measured no closed component.
- **Gates are rules geometry only**; no gate mesh is added to the packet.
- **Reference line, not a new road.** The 8 m moving-average control line is a
  driver aid bounded inside the measured band; it is not claimed as recovered
  geometry.
- **Collision provenance box.** `track.json` now includes every triangle whose AABB
  intersects the corridor box (5,933 triangles). It is not uploaded and the wasm
  physics still uses the full level file.
- **Browser packet hashes** differ from Node in the documented last-bit
  transcendental cases; state hashes, car matrices and all-matrix/camera tolerances
  are checked separately.
- **Superseded records.** `T-007-sprint-rules.md` (P37) describes the 29 m
  straight sprint and `T-007-track-visual.md` (P31) the two-section 144-draw
  visual; both are historical now. This record replaces their sprint/track claims;
  the main agent owns marking them `Superseded`. The P42 soak numbers (379-tick
  sprint segments, finish hashes) are likewise superseded by the soak record in
  §5, which was regenerated on the corridor layout.
- **Native-vs-wasm parity** remains blocked by the DirectX SDK
  (`T-007-vehicle-physics.md` §7).

## 8. What changed

| file | change |
| --- | --- |
| `probes/e1-drive/tools/build_geometry.mjs` | six corridor sections from the pinned level_inspect reference + track-coverage map; corridor totals; corridor draw coverage; new section/source records |
| `probes/e1-drive/tools/extract_track.py` | collision box = legacy drive box + measured corridor box (from `corridor.json`), triangle-AABB selection |
| `probes/e1-drive/tools/build_course.mjs` | **new**: pinned measured course → `_work/e1-drive/course.json` |
| `probes/e1-drive/web/sprint-layout.js` | **v2**: path gates, arc progress, measured band, control reference, per-gate re-measurement; straight-column layout removed |
| `probes/e1-drive/web/sprint-rules.js` | path progress/off-course, local-ground fall rule, gate heading respawn, path-based snapshot |
| `probes/e1-drive/web/sprint-script.js` | **new** Stanley path follower, 3600-tick bound, deterministic stall rule |
| `probes/e1-drive/tools/build_sprint.mjs` | loads `course.json`, derives v2 layout |
| `probes/e1-drive/web/app.js` | v2 layout fields, controller state argument, 3600-tick sprint/soak bound |
| `probes/e1-drive/web/packet-adapter.js` | corridor limits text |
| `probes/e1-drive/tools/verify_e1_drive.mjs` | corridor geometry/coverage, course artifact, layout re-derivation, independent re-measure, drivability record, DNF-aware sprint/restart checks |
| `probes/e1-drive/tools/capture_browser.mjs` | start / mid / stop captures, DNF-aware gates |
| `probes/e1-drive/tools/soak_browser.mjs` | sprint segment gate accepts the measured DNF record |
| `probes/e1-drive/web/app.js` | v2 layout fields, controller state argument, 3600-tick sprint/soak bound, deterministic soak sprint stall |
| `probes/e1-drive/README.md` | course section, commands, recorded DNF |
| `docs/work/analysis/e1-drive-slice.md` §19 | analysis record |

## 9. Evidence paths

| path | content |
| --- | --- |
| `_work/e1-drive/geometry.json` | 7 sections, corridor subtotal 299/47,790/78,712 |
| `_work/e1-drive/course.json` | measured 2,257-sample course, 539.808 m |
| `_work/e1-drive/sprint.json` | v2 path layout, gates, coverage, control reference |
| `_work/e1-drive/run.json` | 496 checks, 6 recorded failures, per-car DNF records |
| `_work/e1-drive/sprint-<slug>.json` | per-car tick table, inputs, blocked record |
| `_work/e1-drive/browser-evidence-sprint.json` | 15 captures, console log, hash agreement |
| `_work/e1-drive/browser-<slug>-sprint-{start,mid,stop}.png` | screenshots (+ `-car` crops) |
| `_work/e1-drive/p43-ledge.mjs`, `p43-run.mjs` | the direct grade/stall probes |
| `_work/logs/e1-drive/verify-p43.log`, `edge-sprint-p43.log`, `p43-*.log` | raw runs |
