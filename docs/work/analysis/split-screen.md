# Split-screen — 1–4 local players in the browser build

**Status:** design study, 8 November 2026. No split-screen renderer was built and
no browser capture was run for this record. Every time number comes from a
recorded frame; every count comes from a recorded packet or map package. Values
that are estimates are labelled **estimate** and are not verdicts.

**Scope:** one browser tab, one canvas, 1–4 local players, WebGPU backend. The
current page is a single viewport; retail Blur supports local split-screen. This
document answers whether 2–4 local players are feasible with the measured draw
counts, and fixes the layout, camera, input, ownership and pass design before a
renderer task starts.

**Question:** can the existing WebGPU consumer draw the same scene into 2–4
viewports at 60 Hz on the documented adapter, and if not, what is the fallback?

**Answer in one line:** on River, **2 players fit 60 Hz** under both bounds
(13.95–16.58 ms of a 16.667 ms frame); **4 players do not** (27.90–43.93 ms).
4 players fit **30 Hz** only with a proposed remote-car LOD (29.72 ms); the
large maps (Amboy, Gracia, Longbeach) have no measured frame and are **not
certified** for split-screen at 60 Hz.

---

## 1. Evidence and method

The parallel PERF1 task committed `docs/work/analysis/performance-budget.md`
while this study was in progress; it is used for the 25-car draw/vertex range and
cross-checked below. The frame anchor here is the **current 516-draw** soak,
not the older 266-draw run that PERF1 uses.

| input | value | source |
|---|---|---|
| frame anchor | **6.945 / 6.975 / 7.09 ms** p50 / p95 / max, 516 draws/frame | `_work/e1-drive/browser-evidence-soak.json` runs 1–2 |
| CPU work in that frame | **1.055 / 1.408 / 2.415 ms** p50 / p95 / max, 4 ticks/frame | same file |
| viewport / adapter | 1600×900, DPR 1, headless Edge, **nvidia / blackwell** | same file |
| earlier anchor | 7.63 ms p50 at **266** draws, 1 tick/frame | `docs/work/verification/T-007-soak.md` |
| camera intrinsics | vFOV 45°, near 0.156 m, far 230.04 m | `_work/e1-drive/geometry.json` |
| River packet | 516 draws = 394 track + 22 level + **100 car**; 102,486 tri; 149 textures | `_work/e1-drive/packet-corvette-zr1-stock.json` |
| Amboy | 1,201 static draws + 100 car; 269,300 + 35,045 tri; 179 + 9 textures; 15.86 MB geometry | `_work/e1-drive/browser-evidence-map-amboy.json` |
| Gracia | 2,627 static draws + 100 car; 365,451 + 35,045 tri; 734 + 9 textures; 22.47 MB geometry | `_work/e1-drive/browser-evidence-map-gracia.json` |
| Longbeach | 1,039 static draws + 100 car; 511,782 + 35,045 tri; 164 + 9 textures | `docs/work/analysis/map-slice-longbeach.md` §10 |
| per-car range (25 chunks) | **71–123 draws**, 27,758–40,018 verts, 29,403–41,270 tri, 6–9 textures | `docs/work/analysis/performance-budget.md` §2.1 |

**The frame interval is a cadence, not a GPU timestamp.** The 266-draw run
measured 7.63 ms p50; the later 516-draw run measured 6.945 ms p50. A 94 %
increase in draws did not increase the frame interval: headless rAF is running
at ~144 Hz and the GPU finishes inside that window. The interval is therefore an
**upper bound** on GPU + compositor for one view, not a breakdown of GPU cost.
There is no GPU timestamp query in the consumer and none was added.

This forces two bounds rather than one invented number:

1. **Linear-view bound.** Each view costs at most the measured full frame, so
   N views cost at most `N × 6.975 ms` (p95). This ignores the extra car draws
   a view gains when more players are visible.
2. **Draw-bound estimate.** Every submitted draw is charged the average measured
   frame time per draw: `6.945 / 516 = 13.459 µs`. This charges the compositor
   share to every draw, so it deliberately over-charges. It is a conservative
   **estimate**, not a measurement of Amboy/Gracia/Longbeach.

A player count is called **feasible** only when both bounds fit the budget
**and the map has a measured frame**. If both bounds fit but the map is
unmeasured it is **estimate-fits-unmeasured**. If only the linear bound fits it
is **marginal-linear-only**. Neither is certified.

**Anchor reconciliation.** `performance-budget.md` uses the older 266-draw,
5-minute soak (8.06 ms p95) and charges **30.3 µs/draw**. Applied to the current
516-draw packet that would predict 15.6 ms for a scene measured at 6.945 ms p50
/ 6.975 ms p95. The two anchors disagree because the frame interval is
cadence-bound, not draw-bound. This record calibrates on the **current packet**:
`6.945 / 516 = 13.459 µs/draw`. Both constants are scaling heuristics, not GPU
measurements; the current-packet constant is the only one consistent with the
current measured frame.

---

## 2. Frame budgets

| target | frame budget | usable share behind the measured one-view frame |
|---|---:|---:|
| 60 Hz | **16.667 ms** | 9.72 ms p50 / 9.69 ms p95 |
| 30 Hz | **33.333 ms** | 26.39 ms p50 / 26.36 ms p95 |

At 60 Hz the whole frame, including browser work outside the measured consumer,
must fit in 16.667 ms. At 30 Hz it must fit in 33.333 ms.

### 2.1 Time bounds for River

| players | linear p50 | linear p95 | linear max | draw-bound | 60 Hz | 30 Hz |
|---:|---:|---:|---:|---:|---|---|
| 1 | 6.95 | 6.97 | 7.09 | 6.95 | **feasible** | feasible |
| 2 | 13.89 | 13.95 | 14.18 | **16.58** | **feasible (99.5 % of budget on the draw bound)** | feasible |
| 3 | 20.84 | 20.93 | 21.27 | 28.91 | infeasible (125.5 %) | feasible |
| 4 | 27.78 | 27.90 | 28.36 | 43.93 | infeasible (167.4 %) | marginal without LOD (131.8 %); feasible with LOD |

- 2P at 60 Hz: **13.95 ms** linear, **16.58 ms** draw-bound, **0.09 ms** margin on
  the pessimistic bound. It fits, but the margin is thin: any extra pass or a
  DPR of 2 removes it.
- 3P at 60 Hz: 20.93 ms linear, 125.5 % of budget. No.
- 4P at 60 Hz: 27.90–43.93 ms, 167–264 %. No.
- 4P at 30 Hz: 27.90 ms linear fits (83.7 %), but the full draw bound 43.93 ms
  does not (131.8 %). The **remote-car LOD** lever brings it to **29.72 ms**
  (89.2 %) and is the documented fallback.

The table uses the measured **100-draw Corvette** (`CAR`). The 25-car roster is
71–123 draws; §3.6 gives the 123-draw envelope and shows that 2P at 60 Hz needs
either ≤100 draws per car or the 12-draw remote-car LOD.

### 2.2 CPU and memory

The measured CPU work per frame is 1.055 / 1.408 / 2.415 ms p50 / p95 / max for
**four engine ticks plus one submit**. A 4-player frame advances four cars one
tick each, which is the same four-tick total; charging four full frames instead
is a deliberate over-bound:

| CPU bound for 4 players | p50 | p95 | max | share of 60 Hz |
|---|---:|---:|---:|---:|
| 4 × measured work | 4.22 ms | 5.63 ms | 9.66 ms | 25.3 % / 33.8 % / 58.0 % |

CPU is **not** the limit at 2P or 4P. The wasm memory is:

- the current module has one car world per instance; the AI path already runs
  one instance per simulated car;
- heap per instance: **268,435,456 B** (measured, constant in the soak);
- 4 local cars = **1,073,741,824 B** of wasm heap (~1 GiB), plus ~40 MB JS heap
  and the GPU resources below. This is the real 4-player constraint on a browser
  tab, not CPU or draw time.

GPU memory is shared, not multiplied by viewport:

| 4 players, distinct cars | textures | texture bytes | geometry bytes | uniform A | uniform B |
|---|---:|---:|---:|---:|---:|
| River | 176 | 18.60 MB | 7.33 MB | 0.84 MB | 0.21 MB |
| Amboy | 215 | 20.81 MB | 18.02 MB | 1.64 MB | 0.41 MB |
| Gracia | 770 | 21.40 MB | 24.63 MB | 3.10 MB | 0.78 MB |
| Longbeach | 200 | 19.39 MB | 26.98 MB | 1.47 MB | 0.37 MB |

`uniform A` duplicates the whole per-draw uniform band per view. `uniform B`
keeps one shared draw band and adds one 256 B view band per view; it is the
intended final layout because it removes an N× uniform fill per frame.

---

## 3. Per-view and per-frame work

`draws/view = static + N × 100`; `tris/view = static + N × 35,045`;
`verts/view = static + N × 33,048`. One car is 100 draws, 35,045 triangles and
33,048 vertices (Corvette ZR1 stock). Every view renders every car, so the car
term is N per view and N² per frame.

### 3.1 River (416 static draws, 67,441 static tri, 109,656 static verts)

| players | draws/view | tris/view | verts/view | index MB/view | uniform A KB/view | frame draws | frame tris | frame index MB | uniform A MB/frame | uniform B MB/frame |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 516 | 102,486 | 142,704 | 1.23 | 129.0 | 516 | 102,486 | 1.23 | 0.13 | 0.13 |
| 2 | 616 | 137,531 | 175,752 | 1.65 | 154.0 | 1,232 | 275,062 | 3.30 | 0.32 | 0.16 |
| 3 | 716 | 172,576 | 208,800 | 2.07 | 179.0 | 2,148 | 517,728 | 6.21 | 0.55 | 0.18 |
| 4 | 816 | 207,621 | 241,848 | 2.49 | 204.0 | 3,264 | 830,484 | 9.97 | 0.84 | 0.21 |

### 3.2 Amboy (1,201 static draws, 269,300 static tri, 529,624 static verts)

| players | draws/view | tris/view | verts/view | index MB/view | uniform A KB/view | frame draws | frame tris | frame index MB | uniform A MB/frame | uniform B MB/frame |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1,301 | 304,345 | 562,672 | 3.65 | 325.3 | 1,301 | 304,345 | 3.65 | 0.33 | 0.33 |
| 2 | 1,401 | 339,390 | 595,720 | 4.07 | 350.3 | 2,802 | 678,780 | 8.15 | 0.72 | 0.36 |
| 3 | 1,501 | 374,435 | 628,768 | 4.49 | 375.3 | 4,503 | 1,123,305 | 13.48 | 1.15 | 0.39 |
| 4 | 1,601 | 409,480 | 661,816 | 4.91 | 400.3 | 6,404 | 1,637,920 | 19.66 | 1.64 | 0.41 |

### 3.3 Gracia (2,627 static draws, 365,451 static tri, 738,905 static verts)

| players | draws/view | tris/view | verts/view | index MB/view | uniform A KB/view | frame draws | frame tris | frame index MB | uniform A MB/frame | uniform B MB/frame |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 2,727 | 400,496 | 771,953 | 4.81 | 681.8 | 2,727 | 400,496 | 4.81 | 0.70 | 0.70 |
| 2 | 2,827 | 435,541 | 805,001 | 5.23 | 706.8 | 5,654 | 871,082 | 10.45 | 1.45 | 0.72 |
| 3 | 2,927 | 470,586 | 838,049 | 5.65 | 731.8 | 8,781 | 1,411,758 | 16.94 | 2.25 | 0.75 |
| 4 | 3,027 | 505,631 | 871,097 | 6.07 | 756.8 | 12,108 | 2,022,524 | 24.27 | 3.10 | 0.78 |

### 3.4 Longbeach (1,039 static draws, 511,782 static tri, 864,473 static verts)

| players | draws/view | tris/view | verts/view | index MB/view | uniform A KB/view | frame draws | frame tris | frame index MB | uniform A MB/frame | uniform B MB/frame |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1,139 | 546,827 | 897,521 | 6.56 | 284.8 | 1,139 | 546,827 | 6.56 | 0.29 | 0.29 |
| 2 | 1,239 | 581,872 | 930,569 | 6.98 | 309.8 | 2,478 | 1,163,744 | 13.96 | 0.63 | 0.32 |
| 3 | 1,339 | 616,917 | 963,617 | 7.40 | 334.8 | 4,017 | 1,850,751 | 22.21 | 1.03 | 0.34 |
| 4 | 1,439 | 651,962 | 996,665 | 7.82 | 359.8 | 5,756 | 2,607,848 | 31.29 | 1.47 | 0.37 |

The index MB figures are submission volume, not measured hardware bandwidth.
They show where the draw cost sits: Longbeach already submits 6.56 MB of
indices per view at 1P, Gracia 4.81 MB, Amboy 3.65 MB, River 1.23 MB.

### 3.5 Estimates for the unmeasured maps

| map | players | linear p95 | draw-bound **estimate** | 60 Hz | 30 Hz |
|---|---:|---:|---:|---|---|
| River | 2 | 13.95 | 16.58 | **feasible** | feasible |
| River | 4 | 27.90 | 43.93 | infeasible | marginal (LOD feasible, 29.72) |
| Amboy | 1 | 6.97 | 17.51 | not certified | not certified |
| Amboy | 2 | 13.95 | 37.71 | not certified | not certified |
| Gracia | 1 | 6.97 | 36.70 | not certified | not certified |
| Gracia | 2 | 13.95 | 76.10 | not certified | not certified |
| Longbeach | 1 | 6.97 | 15.33 | not certified | not certified |
| Longbeach | 2 | 13.95 | 33.35 | not certified | not certified |

Only River has a measured frame. The draw-bound estimates say Amboy and Gracia
may already be below 60 Hz single-player, and that 2P at 60 Hz is not safe on
any of the three. They are a **warning to measure**, not a claim that those maps
run at those times. The first split-screen task on a map package must record its
own frame time before any 2P claim.

### 3.6 Car draw-count sensitivity

The tables above use the measured default car: **100 draws / 35,045 tri /
33,048 verts** (Corvette ZR1). The 25-car audit gives **71–123 draws** per car
(123 = Nissan 350Z Nismo), 29,403–41,270 triangles and 27,758–40,018 vertices.
A mixed 4-car session therefore has a car-draw envelope, not a constant 100. The
envelope below combines the maximum of each column (no single car has all three
maxima), which is conservative.

| River case | draws/view | frame draws | draw-bound | 60 Hz | 30 Hz |
|---|---:|---:|---:|---|---|
| 2P, 100-draw reference | 616 | 1,232 | 16.58 ms | **feasible** | feasible |
| 2P, 123-draw envelope | 662 | 1,324 | **17.82 ms** | marginal (107 %) | feasible |
| 2P, envelope + 12-draw remote LOD | 551 | 1,102 | **14.83 ms** | **feasible** | feasible |
| 4P, 100-draw reference | 816 | 3,264 | 43.93 ms | infeasible | marginal without LOD |
| 4P, 123-draw envelope | 908 | 3,632 | **48.88 ms** | infeasible | marginal (147 %) |
| 4P, envelope + remote LOD | 575 | 2,300 | **30.96 ms** | infeasible | **feasible (92.9 %)** |

Consequence: **2P at 60 Hz is certified only for cars at or below 100 draws**
unless the remote car uses LOD. The 123-draw car pushes the conservative bound to
17.82 ms, 1.15 ms over budget; the 12-draw remote LOD brings it back to 14.83 ms.
The design therefore records a 2P car-draw budget of **≤100 draws per car** or
remote-car LOD, rather than assuming the Corvette for every player. The same LOD
keeps 4P at 30 Hz feasible with the envelope (30.96 ms of 33.333 ms).

---

## 4. Layouts and aspect-aware FOV

Canvas 1600×900 at DPR 1 (1,440,000 device pixels). Rects are in device pixels;
the existing render ratio `min(devicePixelRatio, 2)` multiplies them at runtime.

| layout | players | viewport | aspect | vFOV | hFOV | pixel share | HUD scale |
|---|---:|---|---:|---:|---:|---:|---:|
| `solo` | 1 | 1600×900 (0,0) | 1.778 | 45.00° | 72.73° | 100 % | 1.0 |
| `split-h` | 2 | 1600×450 (0,0) | 3.556 | **37.06°** | **100.00°** | 50 % | 0.85 |
| `split-h` | 2 | 1600×450 (0,450) | 3.556 | 37.06° | 100.00° | 50 % | 0.85 |
| `split-v` | 2 | 800×900 (0,0) | 0.889 | 45.00° | **40.43°** | 50 % | 0.9 |
| `split-v` | 2 | 800×900 (800,0) | 0.889 | 45.00° | 40.43° | 50 % | 0.9 |
| `three` | 3 | 1600×450 (0,0) | 3.556 | 37.06° | 100.00° | 50 % | 0.75 |
| `three` | 3 | 800×450 (0,450) | 1.778 | 45.00° | 72.73° | 25 % | 0.75 |
| `three` | 3 | 800×450 (800,450) | 1.778 | 45.00° | 72.73° | 25 % | 0.75 |
| `quad` | 4 | 800×450 (0,0) | 1.778 | 45.00° | 72.73° | 25 % | 0.7 |
| `quad` | 4 | 800×450 (800,0) | 1.778 | 45.00° | 72.73° | 25 % | 0.7 |
| `quad` | 4 | 800×450 (0,450) | 1.778 | 45.00° | 72.73° | 25 % | 0.7 |
| `quad` | 4 | 800×450 (800,450) | 1.778 | 45.00° | 72.73° | 25 % | 0.7 |

The naming is by divider: `split-h` has a **horizontal divider** and stacks the
views; `split-v` has a **vertical divider** and puts them side by side.

**FOV rule (`preserve-vertical-cap-horizontal`).** Start from the committed
45° vertical FOV at 16:9 (hFOV 72.73°). A wider viewport keeps 45° vertical and
gains horizontal FOV; when that horizontal FOV reaches **100°** it is capped and
the vertical FOV is derived from the cap. A narrower viewport keeps 45° vertical
and loses horizontal coverage. Nothing is stretched; the rendered pixel aspect
is always the viewport aspect.

- `split-h`: 32:9 view → hFOV capped at 100°, vFOV **37.06°**. Without the cap
  the hFOV would be 111.7°, which is a fisheye.
- `split-v`: 8:9 view → vFOV 45°, hFOV **40.43°**. It is legal but narrow; it is
  why `split-h` is the recommended 2P layout.
- `quad`: 800×450 is native 16:9, so the base 45° / 72.73° applies unchanged.
  This is the best-behaved multi-view layout per pixel.

**DPR.** The consumer renders at `min(devicePixelRatio, 2)`. On a DPR-2 display
`quad` renders 4 × 1600×900 = 5.76 MP, four times the measured 1.44 MP. The
split-screen page must cap the render ratio at 1 for 3–4 players (or scale 0.75)
until a DPR-2 measurement exists. Resolution scale only reduces fill; it cannot
fix a draw-bound frame.

---

## 5. Per-player camera rules

One `ChaseCamera` per player, not one shared camera:

| rule | value |
|---|---|
| eye model | orbit behind the player's own `state.axisZ`, target `position + 1.0 m` |
| distance / height | 9.0 m / 2.4 m (orbit distance 9.3145 m) |
| yaw / pitch lag | 0.18 per tick, per player, independent |
| projection | per-view vFOV/aspect from §4; near 0.156 m, far 230.04 m |
| occlusion | same BVH, **one segment cast per player per tick** |
| pull-in | immediate; push-out 0.08/tick; margin 0.4 m; near-field 3.4 m |
| interpolation | each view uses its player's tick + alpha; no shared yaw |

The camera is pure (no wall clock): the same tick sequence with the same inputs
reproduces the same four cameras. Each camera records its own
`camera.occlusion` block. Sharing one camera between views is rejected: a player
looking at their own car must not inherit another player's yaw or occlusion
pull-in.

---

## 6. HUD placement

The HUD stays a DOM overlay; it is not a canvas pass and it does not enter the
packet. The split-screen container uses the exact CSS rects of the views.

| element | position in each view | note |
|---|---|---|
| speed | bottom-left | same formatter as today |
| lap / position | top-left | per-player race row |
| power-up slot | bottom-right | icon, name, timer |
| health / shield | directly above the power-up slot | two bars |
| player tag | top-right | `P1`…`P4`, accent colour |
| divider | CSS 2 px on the split edge | never drawn by WebGPU |

Scale is 1.0 (solo), 0.85 (`split-h`), 0.9 (`split-v`), 0.75 (`three`), 0.7
(`quad`). Margins are 16 px at scale 1 and scale with the view; the `quad` and
`three` layouts reserve a 4 px gutter so text never sits on the split line.
Accent colours are presentation only: cyan, orange, green, magenta for P1–P4.

---

## 7. Input allocation (2–4 local players)

| player | primary | alternate | note |
|---|---|---|---|
| P1 | keyboard: WASD / arrows, Space handbrake | gamepad 0 | keyboard and pad 0 are the same logical player; pad wins while any pad input is active |
| P2 | gamepad 1 | none | the keyboard cannot drive a second player |
| P3 | gamepad 2 | none | |
| P4 | gamepad 3 | none | |

Gamepad mapping (Gamepad API, polled once per animation frame):

| control | binding |
|---|---|
| steer | left stick X, deadzone 0.15 |
| throttle | right trigger (analog) |
| brake | left trigger (analog) |
| handbrake | A / Cross |
| power-up | X / Square |
| pause | Start / Options |
| assignment | connection order: index 0 → P1, 1 → P2, 2 → P3, 3 → P4 |
| disconnect | that player's input is lost, the car coasts; no silent reassignment |

Minimum hardware: 2P = keyboard + one gamepad (or two gamepads); 3P = three
gamepads; 4P = four gamepads. Keyboard-only 2P is not supported and is recorded
as a limit, not worked around with an ambiguous key split.

The existing keyboard mapping (steer inverted by default, `I` toggles) stays P1
only. The scripted sprint/telemetry driver bypasses the input layer and is
unaffected.

---

## 8. State ownership (host-authoritative, local peers)

"Local peer" here means a second controller and view in the **same tab**, not a
second browser. The authority rule is the same one the online mode uses.

| party | owns | authority |
|---|---|---|
| host (P1) | simulation of every car, race gates/timer, power-up state, results, pause | **authoritative** |
| P2–P4 | input intent, camera preference, HUD | none |

- The host steps every car at 60 Hz and writes one in-process snapshot per tick:
  each car pose, race row and power-up state. No WebSocket, no room service.
- Input → host is same-frame; no reconciliation is needed. `RemoteDisplay`
  blending is reused only if a peer view is deliberately decoupled.
- Determinism: each car keeps its per-car state hash; a 4-car local session adds
  a session hash over the four rows.
- Pause: the host applies it; any player may request it. A disconnected pad
  pauses that player's input only, never the session.
- The wasm module has one car world per instance. The AI path already creates one
  instance per AI, so 4 local cars = 4 instances and ~1 GiB of wasm heap. A
  single multi-car world is the long-term fix; it is an engine task, not this
  renderer task.

---

## 9. Renderer integration

### 9.1 Pass and viewport structure

The correct WebGPU encoding is **one render pass with N viewport stages**, not N
passes that each clear:

```
beginRenderPass(color clear once, depth clear once)
  for each view v:
    setViewport(v.x, v.y, v.w, v.h, 0, 1)
    setScissorRect(v.x, v.y, v.w, v.h)
    setPipeline(opaque); bind scene + shared draw list; draw with v's uniform band
    [ghost / power-up groups with v's uniform band]
endPass
queue.submit once
```

`loadOp:'clear'` clears the whole attachment, not the current scissor. A
per-view clear in a second pass would erase the first view. If separate passes
are ever required, the first pass clears and later passes use
`colorLoadOp:'load'` and `depthLoadOp:'load'`; depth is still partitioned by the
scissor, so views do not fight over depth. The design record recommends the
single-pass form.

| pass | count today | split-screen count |
|---|---:|---|
| color/depth scene pass | 1 | **1** |
| viewport/scissor stages | 1 | **N** |
| shadow pass | 0 | **0** (one shared pass if shadows are added; never N) |
| post pass | 0 | **0** |
| GPU occlusion query pass | 0 | **0** |
| CPU camera-occlusion casts | 1/tick | **N/tick** |
| queue submits | 1 | **1** |

The current consumer has no shadow, post-process, particle or GPU occlusion
pass. Its occlusion is a CPU BVH cast (`camera-occlusion.js`, 29,475 triangles /
8,191 nodes). Split-screen adds one cast per player per tick, against the same
shared BVH. A future directional shadow map is view-independent: one shared
shadow pass, then N view stages. Per-view cascades would multiply the shadow
pass and must be budgeted separately.

### 9.2 Uniform buffers

The current consumer packs `viewProjection` into every draw's 256 B uniform
(`mat4 viewProjection`, `mat4 world`, albedo, texParams). Two options:

| option | layout | per-frame bytes, River 4P | shader change |
|---|---|---:|---|
| **A (minimal)** | one buffer of `N × drawCount × 256 B`; `setBindGroup(0, ..., [viewBase + drawIndex×256])` | 0.84 MB | none |
| **B (target)** | one shared draw band `drawCount × 256 B` + N view bands of 256 B; VP moves to a view bind group | 0.21 MB | small WGSL/bind-group change |

Option A is the first integration because it touches only the consumer. Option B
is the intended final layout: it cuts the CPU fill from `N × drawCount × 40`
floats to `drawCount × 40 + N × 16` (world, albedo and texParams are written
once; only the 16-float view-projection is per view). The 256 B stride is the WebGPU
`minUniformBufferOffsetAlignment`; the bound range stays 160 B, so the default
64 KiB binding limit is not involved.

### 9.3 Packet changes

Packet **v1.2**, additive:

```json
"views": [
  { "playerId": 1, "camera": { "view": [16], "projection": [16], "...": "..." } },
  { "playerId": 2, "camera": { "view": [16], "projection": [16], "...": "..." } }
]
```

- `camera` remains player 1's camera, so a v1.1 consumer still works.
- `draws` stays **one shared list** containing every player's car; there is no
  per-view draw list.
- Car nodes use one prefix per player (`p1..p4`); world matrices are shared
  across views, only `viewProjection` differs.
- Diagnostics add `players`, `views`, `perViewCulling` and keep
  `instancesApplied:false`. Per-view culling, if added, must report its culled
  count per view and must not silently change the shared list.

### 9.4 Minimum consumer changes

1. `renderFrame({ cursor, views })`; default `views` is the full canvas with
   `frame.camera`, preserving the single-player path.
2. Grow the draw uniform buffer to `N × drawCount × 256 B` (A) or add view bands
   (B).
3. One render pass, one clear; loop `setViewport` / `setScissorRect` per view.
4. Re-issue the shared opaque, ghost and power-up groups per view with that
   view's uniform offset.
5. Clamp every device rect to the canvas; reject zero or negative sizes; round
   to integers.
6. Report `drawsIssued = views × draws`, plus per-view counters.
7. Expose `views[].rect` in CSS pixels to the HUD module; the HUD stays DOM.
8. Resize path: recompute rects from the CSS canvas size × render ratio, not from
   a hard-coded 1600×900.

### 9.5 Adapter and session changes

- `appendPlayers([{ state, car }])` instead of `appendState` for a local session;
  one car node prefix per player.
- One `ChaseCamera` per player with the same intrinsics but a per-view FOV/aspect;
  one shared occluder BVH.
- One wasm instance per car for the short term (matches the AI path). Record the
  1 GiB heap in the session diagnostics.

### 9.6 Integration order

1. Packet v1.2 `views[]` + one extra car in the shared draw list.
2. Consumer `renderFrame({ views })`; single view unchanged.
3. `split-h` at 2 players; one measured frame and one screenshot.
4. HUD DOM slots from the same rects.
5. Gamepad input + local host session (2 wasm instances).
6. `quad` at 4 players; remote-car LOD and per-view culling only if the measured
   frame misses the target.
7. A map-package split test (Amboy first, then Longbeach, then Gracia) with its
   own measured frame before any claim.

---

## 10. Verdict

| question | answer | numbers |
|---|---|---|
| 2 local players at 60 Hz | **feasible on River with the 100-draw reference car** | 13.95 ms linear, 16.58 ms draw-bound, 16.667 ms budget (0.09 ms margin); the 123-draw envelope is 17.82 ms (marginal), LOD 14.83 ms |
| 3 local players at 60 Hz | **no** | 20.93 ms linear (125.5 %); 28.91 ms draw-bound |
| 4 local players at 60 Hz | **no** | 27.90 ms linear (167.4 %); 43.93 ms draw-bound (48.88 ms envelope) |
| 4 local players at 30 Hz | **yes with remote-car LOD** | 27.90 ms linear; 29.72 ms LOD draw-bound of 33.333 ms (89.2 %); 30.96 ms with the 123-draw envelope |
| 2–4 local players on Amboy/Gracia/Longbeach | **not certified** | no measured frame; conservative 2P estimates 33–76 ms |

**Fallbacks, in order:**

1. **30 Hz target for 4P with remote-car LOD** — 27.90 ms linear fits with
   5.43 ms margin; the 29.72 ms LOD draw bound fits with 3.61 ms (30.96 ms with
   the 123-draw envelope, 2.38 ms margin).
2. **Remote-car LOD (12 draws per remote car)** — brings River 4P from 43.93 to
   29.72 ms at 30 Hz and 2P from 17.82 to 14.83 ms at 60 Hz with the 123-draw
   car. It does not rescue 4P at 60 Hz.
3. **Per-view frustum culling** — reduces draws per view but must be measured;
   the shared draw list is not culled today.
4. **Per-view resolution scale 0.75 or DPR cap 1** — only helps a fill-bound
   frame; it cannot fix the draw-bound term.
5. **3P instead of 4P at 30 Hz** — 20.93 ms linear / 28.91 ms draw-bound, both
   inside 33.333 ms.

**Do not claim** 2P at 60 Hz on Amboy/Gracia/Longbeach until each has its own
measured frame. The draw-bound estimates are 33.35 ms (Longbeach 2P), 37.71 ms
(Amboy 2P) and 76.10 ms (Gracia 2P).

---

## 11. Machine-readable plan and verifier

| path | content |
|---|---|
| `_work/split-screen/plan.json` | layouts, resolutions, per-view/per-frame work, budgets, pass counts, input, ownership, verdict, limits |
| `_work/logs/split-screen/verify.log` | one line per check |
| `probes/split-screen/layout.mjs` | layout rects + FOV rule |
| `probes/split-screen/budget.mjs` | counts + two time bounds |
| `probes/split-screen/build-plan.mjs` | deterministic plan builder + plan hash |
| `probes/split-screen/verify.mjs` | 251 checks |
| `probes/split-screen/print-tables.mjs` | the Markdown tables in this document |

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
& $node probes/split-screen/build-plan.mjs
& $node probes/split-screen/verify.mjs
```

Result: **PASS 251/251** checks, 0 failures. `planHash`
`sha256:3899f93870730f2fb6e4e1b59ded778c176fbe7db58c5ddbe22ed5d180fea779`.
The verifier recomputes every layout, FOV, per-view count, per-frame total,
uniform size, budget, feasibility row and the plan hash; it also checks that
`plan.json` is byte-identical to a fresh deterministic build.

The 251 checks cover: 71 layout/FOV rules across 5 layouts; 8 budget constants;
16 map/player work rows × 8 rules; 6 time checks; 9 verdict checks; 7 car-envelope
checks; 3 LOD checks; 19 plan-file rules.

---

## 12. Limits

1. **Not implemented.** No split-screen renderer or page was built or run. This
   is a design with arithmetic, not a renderer.
2. **One measured frame.** Only River has a frame time. Amboy, Gracia and
   Longbeach per-view times are estimates from draw counts.
3. **The frame interval is a cadence.** 6.945 ms is a headless rAF interval
   (~144 Hz), not a GPU timestamp. It bounds one view from above; it does not
   split fill from draw cost.
4. **The draw-bound constant is an average.** 13.459 µs/draw is the whole frame
   divided by 516 draws; it over-charges fixed/compositor work and is not a
   per-draw hardware measurement.
5. **`split-v` is legal but narrow.** 40.43° horizontal is uncomfortable for
   driving; `split-h` is the recommended 2P layout.
6. **DPR 2 is unmeasured.** Quad at DPR 2 is 5.76 MP, four times the anchor.
   Cap the render ratio at 1 for 3–4P until measured.
7. **Four wasm instances = ~1 GiB.** The current module has one car world per
   instance. A single multi-car world is an engine change.
8. **Keyboard supports one player.** 3–4P need 3–4 gamepads; no ambiguous key
   split is defined.
9. **No per-view culling or LOD exists.** Both are budget levers with arithmetic
   in the plan, not implemented paths.
10. **Car draw count is not constant.** The roster is 71–123 draws per car; the
    2P 60 Hz verdict assumes ≤100 draws per car or remote LOD. The envelope is a
    mixed-car upper bound, not one measured car.
11. **No shadows, post or GPU occlusion queries.** If added per view they would
    multiply the pass count; the budget here is for the current pass set.
12. **No retail parity claim.** This is a browser feasibility design, not a
    reproduction of retail split-screen presentation.

---

## 13. References

- `docs/work/verification/T-007-soak.md` — 5-minute deterministic soak, frame
  and CPU percentiles, 266-draw baseline.
- `_work/e1-drive/browser-evidence-soak.json` — 516-draw, 4-tick/frame anchor
  used here.
- `docs/work/analysis/performance-budget.md` — 25-car draw/triangle/vertex range,
  8-car model and the older 8.06 ms / 266-draw anchor.
- `docs/work/analysis/e1-renderer-strategy.md` — packet seam, E1/E2 boundary.
- `docs/plan/FULL_GAME.md` — M5 game shell (4–8 players) and host authority.
- `probes/e1-drive/web/packet-consumer.js` — single-pass consumer, 256 B draw
  uniform stride, 160 B bound range.
- `probes/e1-drive/web/packet-adapter.js` — `ChaseCamera`, packet v1.1 camera.
- `probes/e1-drive/web/camera-occlusion.js` — CPU BVH, one cast per tick.
- `docs/work/analysis/map-slice-longbeach.md` — Longbeach draw/vertex/texture
  counts.
- `_work/map-slice/{amboy,gracia,longbeach}-render/` — map packages.
