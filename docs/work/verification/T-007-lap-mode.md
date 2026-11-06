# T-007 — three-lap race on the P61 `loop-01` closed loop

**Status:** implemented and verified in Node and headless Edge; browser capture is
recorded in §6. Course id `lap`, URL `?course=lap`.
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

The lap mode consumes the P66 manifest read-only
(`_work/prop-collision/colliders.json`, 468 colliders, profile `all-visible`)
and applies `probes/prop-collision/lib/resolver.mjs` **after** each engine tick.
The engine state, input and tick clock stay authoritative; only the pose handed
to the render packet, rules observer and camera is resolved. On loop-01 the
layer is **active and inert**: 0 contacts, 0 blocked ticks. This was measured,
not assumed; `verify_e1_drive` fails if the profile, collider count or contact
count changes.

The 310 m sprint keeps its existing policy. P66 measured four visible-prop
clusters on that line (52.90–61.13, 114.28–121.76, 124.76–127.75,
181.40–206.85 m), so enabling `all-visible` there would close the committed
course.

The layer is tested against **real P66 colliders** (there is none on loop-01):

| test | result |
| --- | --- |
| 31 m/s head-on into `level.instance.00` (5.39 m truck) | stops on the near face, 0 residual overlap, engine state not mutated |
| 31 m/s head-on into a 0.02 m fence component | no tunnel, ≥7 substeps, 0 residual overlap |
| 5° glancing along the 44.7 m building `…draw.102.component.005` at 19.9 m/s | 99.7 % of free travel retained, 0 residual overlap |
| five-car lap runs | 468 colliders active, 0 contacts, 0 blocked ticks, 0 residual |

## 5. Verification

```powershell
node probes/e1-drive/tools/build_sprint.mjs
node probes/e1-drive/tools/verify_e1_drive.mjs
node probes/e1-drive/tools/capture_browser.mjs --mode lap
python tools/verify_asset_probe.py --skip-build
```

| gate | result |
| --- | --- |
| `verify_e1_drive.mjs` | **766/766 checks, 0 failures** |
| 310 m sprint / 29 m regression | unchanged, all previous checks pass |
| ghost replay | unchanged; no 310 m/29 m hash moved |
| lap determinism | replay with rules off matches every state hash; restart matches finish tick/time |
| packet | valid v1.1 timeline, 9 matrices per update, lap packet script label |
| browser capture | **PASS** — see §6 |
| `_work/e1-drive/run.json` | `sha256:d4ad4b242620d32db928657a903a3b6ab18b1514407253d109597e4583861d89` |

## 6. Browser capture

`node probes/e1-drive/tools/capture_browser.mjs --mode lap` drives all five cars
in headless Edge and captures start / lap 1 / lap 2 / finish. The capture holds
the exact node tick, compares the browser state hash, the car matrix (bit-equal),
the 1e-12 matrix delta, the camera (1e-6), the geometry uploads and the draw
count, reads the overlay text and requires a clean console.

Result: **PASS** - 20 captures (5 cars x start / lap 1 / lap 2 / finish), **0 console messages of any kind**, **0 assertion failures**, **20/20** browser state hashes equal to the node lap states, every car matrix bit-identical, max camera delta **1.14e-13**, max matrix delta **1.11e-16**. **15/20** packet hashes are byte-exact; the five differences are the documented Node 24 / Edge 156 last-bit transcendental cases checked separately. Overlay checks: start is countdown 3 on lap 1/3; lap 1/lap 2 show the exact node crossing tick, the completed lap time and the next lap running; finish shows the total, the three lap times, best lap and car name, and persists the race best in the lap namespace. Screenshots are browser-<slug>-sprint-lap-{start,lap1,lap2,finish}.png (+ -car crops), evidence _work/e1-drive/browser-evidence-lap.json (a verified copy is browser-evidence-lap-verified.json).

Evidence file SHA-256: `sha256:19ad2a7efacfaee048b3d5c26ba814cf744a613b1e90cd29343b8b6d8820814c`
(20 captures).

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
  the loop is clear of props, so it does not exercise a block on this course.
- No AI opponent, no full-game claim.
