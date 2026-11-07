# T-007 — three-lap race on the P61 `loop-01` closed loop

**Status:** implemented and verified in Node and headless Edge; browser capture is
recorded in §6 (P74b binds the V2 651-collider all-visible layer). Course id `lap`,
URL `?course=lap`.
**Source data:** `_work/lap-search/loops.json` (`loop-01`, component 5) and
`_work/e1-drive/geometry.json` v6 (committed P48/P54/P61 data).
**Layout file:** `_work/e1-drive/sprint-lap.json`,
canonical hash `sha256:167643a9a108bc927d093da2b3d1408d639c1cc4110920511455b68c68ad1f91`.

## 1. Layout

The lap layout is derived from the committed P61 artifact, not typed in:

| field | value |
| --- | --- |
| loop | `loop-01`, collision component 5 |
| length | **222.040211 m** |
| samples | 902 at 0.25 m (last sample repeats the first; ring = 901) |
| spawn | `(115.5, 1164.0)`, heading `1.638873 rad` (5 m seam tangent) |
| start/finish line | first sample, perpendicular to the seam tangent, **4.0 m** wide (not narrowed) |
| laps | 3 |
| countdown | 90 ticks (1.5 s) |
| drawn sections | block88/283, block56/289, block58/265, block50/265, block71/209, block64/209, block59/265 |

The builder verifies the loops file SHA-256 and canonical hash against the pinned
`LAP_LOOPS_PATH` before deriving anything: a different artifact is a hard failure,
never a silently different lap.

**Coverage.** The centreline is **902/902 samples** covered (100 %, max surface
delta 0.899 mm, 0 gaps). The seven-station car-width band is **6,286/6,307 =
99.667 %**; the 21 misses are all on the inner edge (stations −1.138 / −0.838 m)
at arc 82.65–99.31 m, where the nearest real draw is ~3.9 m away. They are
recorded, not hidden; the driven line stays inside the drawn band.

**Spawn warning.** Loop-01 is separated from the old spawn component by a measured
1.118 m wall (P61). The lap mode therefore spawns on the loop itself; it is a
separate layout, not a gate change on the 310 m sprint.

## 2. Rules

`LapRules` has the same public surface as `SprintRules`, but the start/finish
line is one physical line crossed three times:

- a crossing counts only after `lapDistance` has accumulated the next full lap
  (222.040 m − 2 m tolerance); the spawn and a respawn on the line can never
  count as a lap;
- lap times are race-clock deltas from GO; the best lap is the minimum;
- the timer never resets on a respawn; the respawn target is the current lap
  line at its measured heading;
- the declared off-course band is ±1.25 m (P61 steep-face distance and the
  measured following error), not the physical 11.75 m road width;
- diagnostics (`lapRuntime`) expose `lapIndex`, `lapDistance`, `lastArc`,
  `lapCrossings` and `maxLateral`.

### Defect found and fixed during this task

The first implementation also required `previousSample.arc > length / 2`. At the
seam the closed polyline repeats its first point, so a position a few centimetres
before the line projects onto the **start** segment (arc ≈ 0) instead of the end
segment (arc ≈ length). All five cars completed lap 1 and then never counted
lap 2, even though the geometric crossings were present (Audi crossed at ticks
1667, 3222, 4780, 6334; only the first was accepted). The previous-arc guard was
redundant because `lapDistance` already guarantees a full lap, so it was removed
and the reason is documented in `web/sprint-rules.js`.

## 3. Scripted three-lap results

All five roster cars, one deterministic run each (`node
probes/e1-drive/tools/verify_e1_drive.mjs`, `_work/e1-drive/run.json` →
`sprint.lapCourse`):

| car | lap 1 | lap 2 | lap 3 | total | finish tick | max lateral | min steep-face |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Corvette ZR1 | 29.000 | 28.550 | 28.550 | **86.100 s** | 5256 | 0.784 m | 2.056 m |
| Lotus Exige Cup260 | 29.117 | 28.583 | 28.583 | **86.283 s** | 5267 | 0.810 m | 2.063 m |
| Dodge Challenger | 29.050 | 28.550 | 28.517 | **86.117 s** | 5257 | 0.854 m | 2.040 m |
| Ford Focus RS (FWD) | 29.167 | 28.533 | 28.550 | **86.250 s** | 5265 | 0.984 m | 1.949 m |
| Audi R8 V10 (AWD) | 28.650 | 28.400 | 28.417 | **85.467 s** | 5218 | 0.812 m | 2.041 m |

Every car: three ordered crossings, **0 respawns**, wheel contact on every tick,
0 non-finite states, a bit-identical replay with the rules off, and the same
finish after `e1_reset()` in the same wasm instance. The Audi is fastest and the
Focus slowest, matching the unchanged physics.

State-sequence hashes:

```text
corvette-zr1-stock        sha256:96094fd474df161837e37d5263b2f31287287c8e11a4ff994d684d7726d29094
lotus-exige-cup260-stock  sha256:cc837eca88cdb533af7d7bf1c16e2064ab5e6f075ac9d0cde015509002beb291
dodge-challenger-stock    sha256:5dafaf94701047727d6263ced1acf336d20820282bde35dfb8d917f63f051099
ford-focusrs-stock        sha256:3ae7599e00f0c2418d1823e9f47a501eb8848562605abb96353e81c5c9ea53cb
audi-r8v10-stock          sha256:d2e2eadd8642df6dddae200f25590e5c7951b3ab7b929f10a3c603e35dadc129
```

## 4. Visible-prop layer

The lap mode consumes the **P74 V2 base manifest**
(`_work/prop-collision/colliders-v2.json`) read-only, profile `all-visible`
(**651 colliders**), and applies `probes/prop-collision/lib/resolver.mjs`
**after** each engine tick. The engine state, input and tick clock stay
authoritative; only the pose handed to the render packet, rules observer and
camera is resolved. On loop-01 the layer is **active and inert**: 0 contacts,
0 blocked ticks. This was measured, not assumed; `verify_e1_drive` fails if the
profile, collider count or contact count changes.

| pin | lap |
| --- | --- |
| manifest | `_work/prop-collision/colliders-v2.json` |
| file SHA-256 | `sha256:3348875297fdb79699410069548c724840761c61b3386e3d5bbb5974448751d7` |
| content SHA-256 | `sha256:736207391f8efc0457a652c126c7d3beaa51e3a4ca55619be84f2f02be4db9ee` |
| variant | `playable-regions-v2` |
| profile | `all-visible` |
| colliders | **651** |
| loop line | **0 of 901** car poses blocked; nearest centre-to-box 0.748749 m at arc 97.8563 m (`draw.233.component.009`) |

The V2 manifest covers the lap corridor at 8 m, so the 56 lap components that
P66/P68 did not map (building wall `draw.355`, garage `draw.299`, balcony
`draw.233`, no-parking sign `draw.257`, low grey wall `draw.276`) are now solid.
P74 measured the loop clear at 0/902 and this task re-measures 0/901 unique poses
with the same car envelope.

The layer is tested against **real V2 colliders**:

| test | result |
| --- | --- |
| 31 m/s head-on into the 5.39 m truck `level.instance.00` | stops at side 4.184 m (near face + car half-length), residual 0, max penetration 0.0728 m |
| 31 m/s head-on into the lap building wall `river.block59.node265.draw.355.component.000` (44.37 × 0.02 m) | stops at side **1.501 m** = 1.49 m car half-length + 0.01 m wall half-thickness + slop, residual 0, max penetration 0.0728 m, target only |
| 31 m/s head-on into the no-parking sign `draw.257.component.000` | stops on the target at side 1.501 m, residual 0 |
| four-direction rays (20 m/s) at the wall | **4/4 blocked**; two hits are the wall, two the adjacent balcony in the same building cluster |
| five-car lap runs | **651 colliders active, 0 contacts, 0 blocked ticks, 0 residual**; every state-sequence anchor is unchanged |

The 310 m sprint binds the same base V2 file with the **`roadside` profile
(553)** but, because the committed scripted line grazes nine active edge
components, it excludes exactly those nine measured ids (544 active). The
sprint's five state-sequence anchors and finish ticks are unchanged. Details:
`docs/work/verification/T-007-free-roam.md` and
`docs/work/analysis/e1-drive-slice.md` §31.

The layer is a kinematic 2.5D response: it resolves the pose handed to the
packet, rules observer and camera after each engine tick. It is not retail
collision, has no rotation sweep, suspension or vertical dynamics, and box
penetration is bounded by one 8 cm substep.

## 5. Verification

```powershell
node probes/e1-drive/tools/build_sprint.mjs
node probes/e1-drive/tools/verify_e1_drive.mjs
node probes/e1-drive/tools/capture_browser.mjs --mode lap
python tools/verify_asset_probe.py --skip-build
```

| gate | result |
| --- | --- |
| `verify_e1_drive.mjs` | **856/856 checks, 0 failures** |
| 310 m sprint / 29 m regression | unchanged, every previously pinned state hash and finish tick matches; the 310 layer is 544 active (553 roadside profile minus 9 measured driven-line exclusions) with 0 contacts |
| ghost replay | unchanged; no 310 m/29 m hash moved |
| lap determinism | replay with rules off matches every state hash; restart matches finish tick/time |
| packet | valid v1.1 timeline, 9 matrices per update, lap packet script label |
| browser capture | **PASS** — see §6 |
| `python tools/verify_asset_probe.py --skip-build` | **36/36 PASS** |
| `python tools/check_e1_poc.py` | **21/23** — its two free-roam items still pin the V1 `colliders-r04.json` 431 colliders/content hash; the P74 V2 free layer is 447 and this checker is outside the P74b file scope (tools/) |
| `_work/e1-drive/run.json` | all checks plus `propV2`; per-run timings make the file hash non-deterministic, so the anchors and the prop pins are the determinism record |

## 6. Browser capture

`node probes/e1-drive/tools/capture_browser.mjs --mode lap` drives the roster in
headless Edge and captures start / lap 1 / lap 2 / finish. The capture holds the
exact node tick, compares the browser state hash, the car matrix (bit-equal), the
1e-12 matrix delta, the camera (1e-6), the geometry uploads and the draw count,
reads the overlay text and requires a clean console.

P74b regression (the lap now binds the V2 651-collider all-visible layer): the
Corvette's full three-lap race was re-captured in headless Edge with the same
four frames. Result: **PASS** — **4/4** browser state hashes equal to the node
lap states, every car matrix bit-identical, max camera delta **1.42e-14**, max
matrix delta **5.55e-17**, **2/4** packet hashes byte-exact (the two differences
are the documented Node 24 / Edge 156 last-bit transcendentals), **0 console
messages**, **0 assertion failures**. Screenshots
`browser-corvette-zr1-stock-sprint-lap-{start,lap1,lap2,finish}.png`. Evidence
`_work/e1-drive/browser-evidence-lap.json`
(`sha256:fd77f5fc…a10ed8`, 4 captures). The earlier five-car 20-capture evidence
is preserved as `browser-evidence-lap-p74b-previous.json`; a full five-car
headless rerun is left to the main agent because one lap frame exceeded the
original 240 s poll window (the window is now 600 s). The Node verifier still
runs all five cars, 651 colliders, 0 contacts, anchors unchanged.

The same lap binds the V2 all-visible layer (651) and is captured in
`--mode collision-v2`: all five cars drive into the reachable loop-side
no-parking sign `draw.257.component.000` and stop (side 1.962–2.673 m, speed
0.001–0.064 m/s, 0 console). The 44 m building wall `draw.355` is on the upper
terrace and cannot be reached from the loop; its 31 m/s head-on is the resolver
proof (1.501 m side, residual 0). See
`docs/work/verification/T-007-free-roam.md` §7b and
`docs/work/analysis/e1-drive-slice.md` §31.

## 7. Limits

- The lap is a **new spawn/layout in collision component 5**, not a loop in the
  old spawn component; the 310 m sprint is unchanged and still the default.
- No ghost/rival on the lap: ghost arcs reset every lap and no committed lap
  reference exists, so `G` reports the reason instead of replaying a mismatched
  clock.
- The 1.25 m band is a declared respawn rule, not the 11.75 m physical width.
- The 21 inner-edge band misses at arc 82.65–99.31 m are drawn-gap evidence, not
  a claim of full car-width coverage there.
- The prop layer is a visible-mesh kinematic approximation, not retail collision;
  the driven loop is clear of props (0 contacts), so the five-lap runs do not
  exercise a block. The V2 building wall, sign and grey-wall components are
  tested separately in the resolver, and the reachable lap sign is captured in
  `--mode collision-v2`. The 44 m building wall `draw.355` is on the upper
  terrace (ground 6.514 m) and cannot be reached by the car from the loop at
  ~3.2 m; its head-on proof is at its own measured ground.
- No AI opponent, no full-game claim.
