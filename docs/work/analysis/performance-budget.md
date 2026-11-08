# Performance budget — 8 players, 7 AI, 19 maps, one browser

**Date:** 8 November 2026
**Owner:** PERF1 (sub-agent)
**Scope:** measurements from committed/generated artifacts, an explicit budget model,
snapshot-bandwidth estimators and the top scaling risks. No engine, net, map,
texture or browser-capture change. Owned paths: `probes/perf/**`,
`_work/perf/**`, `_work/logs/perf/**` and this document.

This document answers a shipping question that no prior record answered with
numbers: **what does the game cost when it is actually a game** — 2–8 players,
up to 7 AI cars, one of 19 maps, power-up props and a HUD — rather than one car
on one measured strip?

Everything below is derived from existing artifacts. No new browser capture was
run. The one frame-time dataset is the committed T-007 soak; the one draw/upload
dataset for the current packet is the committed one-minute soak. Sections that
could not be measured are labelled **not measured**, not estimated silently.

---

## 0. Result

| question | measured / modelled answer | evidence |
|---|---|---|
| per-car geometry | 27,758–40,018 vertices, 29,403–41,270 triangles, 71–123 draws | `_work/e1-drive/car-bodies.index.json` |
| per-car GPU geometry | 895,968–1,295,600 B (position f32x3 + UV0 f32x2 + index u32) | same |
| per-car texture RGBA | 2,379,776–4,997,120 B (7–9 images) | same |
| per-car chunk file | 5,468,922–9,018,247 B | same |
| per-car chunk JSON overhead | **32.6–38.1 % (median 36.0 %)** above the raw GPU payload | same |
| level chunk (River) | 9,663,610 B; 416 draws; 67,441 triangles; 3.00 MB GPU geometry; 0.60 MB GPU texture | `level.geometry.json` |
| Amboy page | **66.38 MB**; 49.52 MB map package; 1,201 map draws; 348,948 triangles | `_work/e1-drive/amboy/map.json` |
| Gracia page | **92.72 MB**; 72.62 MB map package; 2,627 map draws; 550,632 triangles | `_work/e1-drive/gracia/map.json` |
| Longbeach package | 26.09 MB render package (binary, **not page-integrated**); 1,039 draws; 537,294 triangles | `_work/map-slice/longbeach-render` |
| 8-car GPU, worst (Gracia, full textures) | **85.24 MiB** (89.38 MB): 30.28 MiB geometry + 54.96 MiB texture | model |
| 8-car GPU, worst (Gracia, mixed LOD) | **51.88 MiB** (54.40 MB): 30.28 MiB geometry + 21.60 MiB texture | model |
| 8-car GPU, best (River, mixed LOD) | **18.59 MiB** (19.49 MB): 9.70 MiB geometry + 8.89 MiB texture | model |
| 8-car draws, worst (Gracia) | **3,631** = 2,627 map + 984 car + 20 power-up | model |
| 8-car CPU per frame | **1.12–4.72 ms** p95 (engine 0.64–0.91 ms; measured one-car browser work 0.59 ms p95) | soak + README tick cost |
| measured frame p95, one car | **8.06 ms** (headless, 266 draws/frame in the 5-minute soak) | T-007-soak |
| 20 Hz snapshot, current JSON | **209.7 B mean / 212 B p95 per car** | packet body matrices |
| 8-peer state traffic | client down **1.76 MB/min**; server/host relay **14.09 MB/min** | model |
| 8-peer all-channel host relay | **51.95 MB/min = 6.93 Mbit/s** (state 14.09 + AI 8.23 + input 29.63) | model |
| delta/quantized binary estimate | 23.06 B per car, **89.0 % smaller**; host all channels **5.02 MB/min = 0.67 Mbit/s** | estimator |
| ghosts | 50 records, **1,874,624 B** total, 44 B/tick payload, 57,731 B for the Corvette 310 m ghost | ghost index |
| wasm | 1,012,634 B wasm + 11,480 B JS; **268,435,456 B heap constant** for 5 simulated minutes | module + soak |
| verifier | **562/562 checks, 0 failures** | `_work/perf/verify.json` |

**Verdict of the model:** the **CPU** side can carry 8 cars on River inside a
60 Hz frame on this machine (1.12–4.72 ms of a 16.67 ms budget), but **GPU/draw
cost is not demonstrated for 8 cars anywhere**: the draw-scaled bound is 30.4 ms
even on River and 110.0 ms on Gracia. Gracia and Longbeach are outside a safe
shipping budget today because of map package size, draw count and per-car texture
memory. The network state channel is not the risk; the host relay of inputs plus
AI poses is (6.93 Mbit/s all channels at 8 peers). The largest single saving is
to stop shipping map geometry as inline JSON text, and the next gate must be an
8-car Gracia capture, not another one-car soak.

---

## 1. Method

`probes/perf/tools/perf_budget.mjs` has two subcommands:

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
& $node probes/perf/tools/perf_budget.mjs measure
& $node probes/perf/tools/perf_budget.mjs verify
```

`measure` reads the artifacts listed below and writes
`_work/perf/measurements.json` and `_work/perf/budget-model.json`. `verify`
recomputes the same arithmetic and writes `_work/perf/verify.json`. Nothing is
read from the engine at runtime and nothing under `probes/e1-drive/**`,
`probes/net-mvp/**`, `tools/`, `game-data/` or `upstream/` is written.

Inputs:

| input | use |
|---|---|
| `_work/e1-drive/car-bodies.index.json` | 25 car chunks: bytes, vertices, triangles, draws, textures, UV/RGBA bytes, SHA-256 |
| `_work/e1-drive/level.geometry.json` | River level/track meshes, draws, textures |
| `_work/e1-drive/{amboy,gracia}/map.json` | page map packages and their counts |
| `_work/map-slice/{amboy,gracia,longbeach}-render/render.json` | texture mip-chain expectation, draw counts, dimensions |
| `_work/e1-drive/base.geometry.json`, `cars/<slug>.fields`, layouts, physics | page-total formula |
| `_work/e1-drive/browser-evidence-soak.json` (1 min) | current 516-draw packet, upload bytes, CPU work |
| `_work/logs/e1-drive/soak-summary-p42.json` (5 min) | frame p95 8.06 ms, work p95 0.59 ms, heap, buffers |
| `_work/e1-drive/packet-corvette-zr1-stock.json` | real per-tick body matrices → quaternions, 20 Hz samples |
| `_work/e1-drive/state-<slug>.json` | real position/speed for the 7-car AI batch estimator |
| `probes/e1-drive/ghosts/index.json` + one ghost file | ghost payload and inflation |
| `_work/e1-drive/module/e1_drive.{wasm,mjs}`, `build.json` | module sizes and build record |

### 1.1 Byte rules

- **GPU geometry** = `vertices × 12` (position f32x3) + `vertices × 8` (UV0
  f32x2) + `indices × 4` (u32). This is exactly what
  `packet-consumer.js` uploads; the one-minute soak reports 4,083,912 B per
  River packet = 3,002,412 level + 1,081,500 Corvette, which matches.
- **GPU texture** = RGBA8 mip0 + deterministic full mip chain ≈ `4/3 × mip0`.
  Map packages carry `uniqueExpectedChain` directly (Amboy 3,539,772 B,
  Gracia 4,330,212 B, Longbeach 1,652,408 B); car packs use the same `4/3`
  rule. Hardware tile padding is **not** modelled.
- **Page total** uses the page's own `mapBytes` formula: map package + base
  geometry + car chunk + layout + physics + car fields + render/slice source
  pins. River adds the measured index + wasm + module + roster extras.
- **Draw calls** count every visible packet draw plus the diagnostic power-up
  marker pass (16 markers + 4 rings = 20). The consumer has no frustum or
  occlusion culling, so every draw is submitted every frame.
- **MB** = 10^6 bytes; **MiB** = 2^20 bytes; frame budget = 16.67 ms.

---

## 2. Per-asset measurements

### 2.1 Cars (25 chunks)

Source: `_work/e1-drive/car-bodies.index.json`, measured 8 November 2026.

| slug | chunk B | verts | tris | draws | tex | rgba B | GPU geom B | GPU tex B |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| lotus-exige-cup260-stock | 9,018,247 | 32,136 | 35,143 | 88 | 9 | 4,997,120 | 1,064,436 | 6,662,827 |
| foose-stallion-stock | 8,489,161 | 35,511 | 34,426 | 103 | 8 | 4,472,832 | 1,123,332 | 5,963,776 |
| corvette-zr1-stock | 8,468,680 | 33,048 | 35,045 | 100 | 9 | 4,538,368 | 1,081,500 | 6,051,158 |
| chevrolet-camaro-ratdrift | 8,335,955 | 32,252 | 34,237 | 99 | 8 | 4,472,832 | 1,055,884 | 5,963,776 |
| dodge-challenger-tuner | 7,966,464 | 26,706 | 30,154 | 93 | 8 | 4,472,832 | 895,968 | 5,963,776 |
| nissan-350znismo-stock | 7,727,617 | 38,666 | 38,842 | 123 | 8 | 3,686,400 | 1,239,424 | 4,915,200 |
| koenigsegg-ccxr-stock | 7,602,321 | 40,018 | 41,270 | 97 | 9 | 3,563,520 | 1,295,600 | 4,751,360 |
| volkswagen-beetle-offroad | 7,538,809 | 36,201 | 38,128 | 85 | 8 | 3,702,784 | 1,181,556 | 4,937,046 |
| chevrolet-socalhhr-stock | 7,277,157 | 32,478 | 35,484 | 85 | 8 | 3,686,400 | 1,075,368 | 4,915,200 |
| chevrolet-camaro-stocke3 | 7,180,667 | 36,386 | 36,805 | 100 | 7 | 3,424,256 | 1,169,380 | 4,565,675 |
| toyota-supratrd-stock | 7,137,864 | 36,122 | 37,019 | 88 | 7 | 3,424,256 | 1,166,668 | 4,565,675 |
| ford-focusrs-stock | 6,896,981 | 32,267 | 31,057 | 115 | 7 | 3,424,256 | 1,018,024 | 4,565,675 |
| audi-s3-stock | 6,769,503 | 30,168 | 31,099 | 99 | 7 | 3,424,256 | 976,548 | 4,565,675 |
| bmw-m3e92-tuner | 6,762,185 | 30,152 | 30,925 | 94 | 8 | 3,432,448 | 974,140 | 4,576,598 |
| dodge-viperacr-stock | 6,587,291 | 27,758 | 29,403 | 83 | 7 | 3,424,256 | 907,996 | 4,565,675 |
| corvette-c3-rat | 6,154,740 | 33,764 | 38,276 | 83 | 8 | 2,768,896 | 1,134,592 | 3,691,862 |
| ford-f100-offroad | 6,076,860 | 37,051 | 39,669 | 78 | 7 | 2,588,672 | 1,217,048 | 3,451,563 |
| ford-fr100-stock | 6,076,045 | 37,522 | 39,745 | 71 | 8 | 2,576,384 | 1,227,380 | 3,435,179 |
| ford-mustanggtr-stock | 5,931,828 | 32,927 | 35,359 | 101 | 7 | 2,637,824 | 1,082,848 | 3,517,099 |
| ford-bronco-offroad | 5,791,133 | 36,527 | 39,225 | 82 | 6 | 2,392,064 | 1,201,240 | 3,189,419 |
| audi-tt-stock | 5,759,038 | 30,930 | 30,490 | 100 | 7 | 2,637,824 | 984,480 | 3,517,099 |
| volkswagen-golfw12650-stock | 5,755,564 | 32,045 | 33,569 | 92 | 8 | 2,580,480 | 1,043,728 | 3,440,640 |
| audi-r8v10-stock | 5,673,193 | 31,429 | 30,736 | 84 | 8 | 2,580,480 | 997,412 | 3,440,640 |
| dodge-challenger-stock | 5,657,014 | 28,365 | 32,032 | 104 | 7 | 2,637,824 | 951,684 | 3,517,099 |
| nissan-skyliner34ztune-stock | 5,468,922 | 32,550 | 29,447 | 96 | 7 | 2,379,776 | 1,004,364 | 3,173,035 |

The 25 chunks total **172,103,239 B** on disk. Only one chunk (plus the MP peer)
is resident today. The selected car is the largest single asset a player loads
after the map: 5.47–9.02 MB, or **4.4–7.2 s at 10 Mbit/s** before parse and GPU
upload.

Extremes used by the model:

| pool | car | value |
|---|---|---|
| largest GPU total | Lotus Exige Cup260 | 1.06 MB geometry + 6.66 MB texture |
| largest GPU geometry | Koenigsegg CCXR | 1,295,600 B |
| largest texture pack | Lotus Exige Cup260 | 4,997,120 B RGBA / 6,662,827 B with mips |
| largest draw count | Nissan 350Z Nismo | 123 draws |
| largest triangle count | Koenigsegg CCXR | 41,270 |
| smallest GPU geometry | Dodge Challenger Tuner | 895,968 B |
| smallest texture pack | Nissan Skyline R34 | 3,173,035 B with mips |
| smallest draw count | Ford FR100 | 71 draws |

### 2.2 River level chunk

| measure | value |
|---|---:|
| file | 9,663,610 B |
| meshes | 2 (level props + track visual) |
| vertices / triangles | 109,656 / 67,441 |
| draws | 416 (22 level + 394 track) |
| textures / RGBA | 140 / 447,552 B |
| GPU geometry | 3,002,412 B |
| GPU texture | 596,736 B |
| JSON overhead | **64.3 %** (file is 2.80× the raw GPU + texture payload) |

### 2.3 Maps

`page B` is the current page total (map + base + car + layout + physics +
fields + source pins), not just the package.

| map | package B | page B | verts | tris | draws | tex | rgba B | GPU geom B | GPU tex B | package overhead |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| River | 9,663,610 | 20,471,058 | 109,656 | 67,441 | 416 | 140 | 447,552 | 3,002,412 | 596,736 | 64.3 % (JSON) |
| Amboy | 49,524,812 | 66,382,292 | 529,624 | 348,948 | 1,201 | 179 | 2,654,272 | 14,779,856 | 3,539,772 | 64.8 % (JSON) |
| Gracia | 72,616,717 | **92,721,899** | 738,905 | 550,632 | 2,627 | 734 | 3,247,360 | 21,385,684 | 4,330,212 | 66.1 % (JSON) |
| Longbeach | 26,093,998 | 38,923,415* | 864,473 | 537,294 | 1,039 | 164 | 1,239,168 | 23,736,988 | 1,652,408 | 4.3 % (binary package) |

`*` Longbeach is not page-integrated; its page total is an explicit estimate
from the same app formula, using the binary render package. It is listed to show
the geometry extreme, not as a shipping measurement.

**Why the packages are so large.** The committed binary render packages are
already compact: Amboy `_work/map-slice/amboy-render` is **19,133,342 B**,
Gracia is **28,801,009 B** (28.80 MB), Longbeach is **26,093,998 B**. The page
then re-encodes the same geometry into `_work/e1-drive/<map>/map.json` as inline
JSON number arrays, which produces the 49.52 MB (Amboy) and 72.62 MB (Gracia)
page packages. The 28.80 MB Gracia render package in
[`map-slice-gracia.md`](map-slice-gracia.md) and the 92.72 MB Gracia page total
here describe two different serializations of the same map, not a contradiction.

### 2.3.1 Load time

Local load is fetch + hash + parse + world build; network time is payload at a
steady bitrate (no latency, TLS or server overhead).

| asset | local measured | @10 Mbit/s | @50 Mbit/s | @100 Mbit/s |
|---|---:|---:|---:|---:|
| River page | **75.5 ms** (chunked) | 16.4 s | 3.3 s | 1.6 s |
| Amboy page | **244.9–254.5 ms** (chunked) | 53.1 s | 10.6 s | 5.3 s |
| Gracia page | 574.4 / 634.3 ms* | **74.2 s** | 14.8 s | 7.4 s |
| Longbeach page (est.) | no page package | 31.1 s | 6.2 s | 3.1 s |
| car chunk, smallest (5.47 MB) | — | 4.4 s | 0.9 s | 0.4 s |
| car chunk, largest (9.02 MB) | — | 7.2 s | 1.4 s | 0.7 s |
| car switch, Corvette → Audi R8 | **535 ms** (parse+hash+rebuild) | — | — | — |
| Amboy map-mode car switch | **1.6–2.2 s** | — | — | — |

`*` The Gracia local time is the committed **pre-chunking** MP capture
(191.1 MB page). The current chunked 92.72 MB page has not been re-captured;
its network column is computed from the current file bytes, not measured in a
browser.

The package overhead column is the key: **Amboy and Gracia ship geometry as
inline JSON number arrays**, so about two thirds of a 50–73 MB package is text
encoding. The Longbeach binary render package carries 54 % more triangles than
Amboy in 47 % fewer bytes:

| package | triangles | bytes/triangle |
|---|---:|---:|
| Amboy JSON page package | 348,948 | 141.9 |
| Gracia JSON page package | 550,632 | 131.9 |
| Longbeach binary render package | 537,294 | 48.6 |

### 2.4 Ghosts

| measure | value |
|---|---:|
| committed records | 50 (25 cars × 310 m / 29 m) |
| total file bytes | 1,874,624 B |
| Corvette 310 m ghost | 57,731 B |
| ticks / payload | 970 / 42,680 B (44 B/tick: position3 + quaternion4 + wheelAngle4, float32le) |
| base64 payload | 56,908 chars; **14,228 B inflation** |
| metadata | 823 B |
| file bytes per tick | 59.5 B |

Ghosts are loaded on demand from `localStorage` or the committed tree; they are
not per-frame network traffic. Even 8 ghosts would be ≈0.46 MB of JSON, which is
not a budget item. The only scaling concern is `localStorage` if every car and
course is stored for every player (not implemented).

### 2.5 Wasm and heap

| measure | value |
|---|---:|
| wasm module | 1,012,634 B |
| JS glue | 11,480 B |
| build record | 3,466 B |
| initial heap | 268,435,456 B (256 MiB) |
| max heap (`ALLOW_MEMORY_GROWTH`) | 536,870,912 B (512 MiB) |
| heap / wasm ratio | 265× |
| 5-minute soak heap | 268,435,456 B constant in both runs |
| 5-minute JS heap drift | −1.82 MB / −1.76 MB (after-GC checkpoint means) |

**One world = 256 MiB.** The current M4 host runs one wasm instance per AI. At
the current 3-AI cap that is 4 worlds = **1 GiB**; the 7-AI scenario asks for 8
worlds = **2 GiB** initial heap (4 GiB if every world grows). That is the single
largest memory risk in the plan and is independent of GPU memory.

### 2.6 Soak: frame, CPU, draws, uploads

| measure | 1-minute soak (current packet) | 5-minute soak (older packet) |
|---|---:|---:|
| frame p50 / p95 / p99 | 6.945 / 6.975 / 7.000 ms | 7.63 / **8.06** / 8.535 ms |
| CPU work p50 / p95 / p99 | 1.055 / 1.408 / 1.614 ms (4 ticks/frame) | 0.325 / **0.59** / 0.68 ms (1 tick/frame) |
| draws/frame | **516** (22 + 394 + 100) | 266 |
| geometry upload / packet | 4,083,912 B | 1,716,240 B |
| texture upload / packet | 4,985,920 B | (not recorded) |
| live GPU buffers | 11 (3 positions + 3 indices + 3 UV + uniform + scene) | 8 |
| wasm heap | 268,435,456 B | 268,435,456 B |

The 5-minute soak predates the current 394-draw track visual (266 draws/frame),
so its frame/CPU numbers are used for **cadence and headroom**, and its draw
count is **not** used as the current packet size. The current packet is 516
draws, confirmed by the one-minute soak and by `packet-corvette-zr1-stock.json`.

**8.06 ms is a cadence, not a GPU time.** Headless rAF runs at about 123 Hz
(8,688 frames / 70 s; 1/123 s = 8.13 ms), so the 5-minute frame p95 is the
compositor cadence, not measured GPU work. The measured CPU work (0.325 / 0.59
ms p50/p95) is the real per-frame cost in that dataset. The draw-scaled column
in §3.2 is therefore a deliberately pessimistic bound, not a GPU measurement.

Per-tick engine cost from the module record: 300 scripted ticks take 24–34 ms in
node → **0.080–0.113 ms per car per tick**. The browser one-car frame work is
0.325 ms p50 / 0.59 ms p95; the difference is adapter, camera, packet submit and
one frame's overhead.

### 2.7 Chunk overhead

| asset | file bytes | raw GPU + texture | overhead |
|---|---:|---:|---:|
| car chunk, minimum | 5,468,922 | — | **32.6 %** |
| car chunk, median | — | — | **36.0 %** |
| car chunk, maximum | 9,018,247 | — | **38.1 %** |
| River level chunk | 9,663,610 | 3,449,964 | **64.3 %** |
| Amboy map package | 49,524,812 | 17,434,128 | **64.8 %** |
| Gracia map package | 72,616,717 | 24,633,044 | **66.1 %** |
| Longbeach binary package | 26,093,998 | 24,976,156 | **4.3 %** |

Car chunks keep textures and UV as base64 but positions/indices as inline
numbers; maps keep everything as inline JSON. The binary Longbeach package shows
the achievable overhead when the same data is stored as `.bin` plus a small
manifest.

---

## 3. Eight-player budget model

### 3.1 Assumptions (explicit)

1. **8 cars = 1 local + 7 remote/AI.** Worst case gives every car its own body
   and texture pack; mixed LOD gives the local car full resolution and the seven
   remotes half-width/height (quarter bytes).
2. **Current M4 is not 8 distinct cars.** It loads two car chunks (local + one
   human peer) and AI cars reuse the local body; the ghost shader samples no
   textures. The `currentM4` row models that today's page actually does.
3. **Every visible draw is submitted.** The consumer has no frustum/occlusion
   culling. Draw count = map draws + 8 × car draws + 20 power-up markers.
4. **GPU texture = 4/3 × RGBA8 mip0.** No hardware tile padding, no compressed
   GPU format. Mips and sRGB are applied by the consumer; sRGB does not change
   byte count.
5. **CPU high = 8 × measured one-car browser work p95 (0.59 ms).** CPU low =
   fixed frame overhead (0.59 − 0.113 = 0.477 ms) + 8 × measured engine tick.
   AI driver JS and GPU wait are excluded; they are not measured.
6. **Frame upper bound = measured 8.06 ms × (draws / 266).** This is a bound if
   the frame were draw-submission-bound, not a prediction. 8.06 ms is also the
   headless 123 Hz cadence (8.13 ms), so it is not a GPU time; the bound is
   deliberately pessimistic and the measured frame is not proven to scale this
   way. It exists to force an 8-car capture, not to predict fps.
7. **Power-up props = 20 draws** (16 marker slots + 4 Barge rings). HUD is DOM,
   not a GPU pass.

### 3.2 The table

| scenario | page MB | GPU geom MiB | GPU tex full MiB | GPU tex mixed MiB | total full MiB | total mixed MiB | draws | triangles | CPU p95 ms | frame bound ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **River (best)** | 20.47 | 9.70 | 24.78 | 8.89 | **34.48** | **18.59** | 1,004 | 302,665 | 1.12–4.72 | 30.4 |
| Amboy (mid) | 66.38 | 23.98 | 54.21 | 20.85 | 78.19 | 44.83 | 2,205 | 679,108 | 1.12–4.72 | 66.8 |
| **Gracia (worst)** | **92.72** | 30.28 | 54.96 | 21.60 | **85.24** | **51.88** | **3,631** | 880,792 | 1.12–4.72 | **110.0** |
| Longbeach (geometry worst) | 38.92* | 32.52 | 52.41 | 19.05 | 84.93 | 51.57 | 2,043 | 867,454 | 1.12–4.72 | 61.9 |
| Current M4 (2 bodies, no remote textures) | 92.72 | 22.87 | 10.48 | 10.48 | 33.35 | 33.35 | 3,631 | 880,792 | 1.12–4.72 | 110.0 |

`*` estimated page total; Longbeach is not page-integrated.

The `frame bound` column is the deliberately pessimistic draw-scaled bound from
assumption 6, **not** a measured frame time. The measured 8.06 ms is the
headless rAF cadence, not GPU work; see §2.6.

### 3.3 Breakdown

**GPU geometry (worst, 8 distinct bodies):**

| part | bytes | MiB |
|---|---:|---:|
| Gracia map | 21,385,684 | 20.39 |
| 8 × Koenigsegg (largest geometry) | 10,364,800 | 9.88 |
| **total** | **31,750,484** | **30.28** |

**GPU texture (worst):**

| part | full texture | mixed LOD |
|---|---:|---:|
| Gracia map (734 blobs, mip chain) | 4,330,212 B (4.13 MiB) | same |
| 8 × Lotus (largest pack) | 53,302,616 B (50.83 MiB) | 18,322,776 B (17.47 MiB) |
| **total** | **57,632,828 B (54.96 MiB)** | **22,652,988 B (21.60 MiB)** |

Mixed LOD saves **34.98 MB (65.6 %)** of car texture memory and **34.98 MB
(39.1 %)** of total GPU memory (89.38 → 54.40 MB). It preserves the local car at
full resolution and halves remote car textures, which are seen at distance
through a ghost tint today.

**Draw calls:**

| part | River | Amboy | Gracia | Longbeach |
|---|---:|---:|---:|---:|
| map | 416 | 1,201 | 2,627 | 1,039 |
| 8 × max car (123) | 984 | 984 | 984 | 984 |
| power-up markers/rings | 20 | 20 | 20 | 20 |
| **total** | **1,004** | **2,205** | **3,631** | **2,043** |

Gracia is **3.6×** River's draw count and **2.9×** its triangles. The measured
516-draw River frame is 8.06 ms p95; a draw-scaled bound is 110 ms for Gracia.
That bound is not observed; it is the reason the next task must be an 8-car
Gracia capture, not a claim that the game runs at 9 fps.

**CPU:**

| model | ms |
|---|---:|
| 8 × engine tick (0.080–0.113) | 0.64–0.91 |
| measured one-car browser work p50 / p95 | 0.325 / 0.59 |
| fixed-overhead + 8 physics (low) | **1.12** |
| linear browser work × 8 (high) | **4.72** |
| linear p50 × 8 | 2.60 |
| 3× slower CPU, high | **14.16** (85 % of 16.67 ms) |
| 3× slower CPU, low | 3.35 |

The model says an 8-car host has 12–15.5 ms of CPU headroom on this machine at
60 Hz, but a machine 3× slower than the capture machine is at the edge. AI driver
JS is additional and **not measured**; that is a gap, not a zero.

---

## 4. Snapshot bandwidth

### 4.1 Current wire size

The net-mvp client sends, at 20 Hz:

```json
{"type":"state","channel":"state","seq":N,"tick":T,
 "state":{"tick":T,"position":[x,y,z],"quaternion":[x,y,z,w],"speed":S},
 "sentAt":<epoch-ms>}
```

Values are quantized to 6 decimals by `quantizeState`, exactly as the client
sends them. Measured over 101 samples of the real Corvette timeline:

| encoding | p50 | p95 | mean | saving vs JSON |
|---|---:|---:|---:|---:|
| current JSON (1 car) | 210 B | 212 B | **209.7 B** | — |
| short-key JSON, 2 cm / 3 dp | 75 B | 76 B | 74.0 B | **64.7 %** |
| delta binary (proposed) | 23 B | 23 B | **23.06 B** | **89.0 %** |
| input JSON (60 Hz) | 147 B | 149 B | 147.0 B | — |
| input binary (proposed) | — | — | 12 B | 91.8 % |

The delta binary estimator is: 8 B envelope (type/channel/seq/tick) + first
frame 12 B absolute int32 centimetres, later 6 B int16 centimetres per axis +
7 B quaternion (largest-component index + three int16) + 2 B speed uint16 cm/s.
Measured fidelity: **max 5.0 mm position error** and **4.7 × 10⁻⁵ rad
quaternion error**; no sample overflowed int16 (±327 m of delta headroom at
20 Hz).

### 4.2 Eight peers

The room service relays every state message to every other peer. With 8 players
there are 8 senders × 7 recipients = 56 relayed state messages per 20 Hz tick.
The table separates **per client** from **host acting as relay** (the loopback
room service runs in the host process today).

| item | current JSON | delta binary | unit |
|---|---:|---:|---|
| per-car state | 209.7 B | 23.06 B | per message |
| client upload (state) | 0.252 | 0.028 | MB/min |
| client download (7 peers) | 1.761 | 0.194 | MB/min |
| server/host state egress (56×) | 14.091 | 1.550 | MB/min |
| AI pose batch, 7 cars | 979.4 B | 125 B | per message |
| host AI upload (1×) | 1.175 | 0.150 | MB/min |
| AI fan-out (7 guests) | 8.226 | 1.050 | MB/min |
| host state + AI relay | 22.318 | 2.600 | MB/min |
| input, 60 Hz, 8 peers (server egress) | 29.628 | 2.419 | MB/min |
| **host all channels** | **51.945** | **5.019** | **MB/min** |
| host all channels | **6.93 Mbit/s** | **0.67 Mbit/s** | — |
| client download all channels | 6.64 | 0.39 | MB/min |
| client download all channels | 0.89 Mbit/s | 0.052 Mbit/s | — |

The AI batch is `{tick, cars:[{id,tick,position,quaternion,speed}]}` for 7 cars,
measured with real per-car position/speed from the drive states and the real
Corvette quaternions. It is a byte-size estimator, not a seven-AI simulation.

**Reading the table:** state snapshots are not the problem (14.1 MB/min server
egress is 0.23 Mbit/s per receiving client). The problem is the 60 Hz input
channel (29.6 MB/min, 57 % of host traffic) and the AI fan-out. A host on a
10 Mbit/s uplink would spend 69 % of it on all-channel relay. On a 100 Mbit/s
LAN this is comfortable. The delta encoding cuts the host total by **90.3 %**.

### 4.3 Proposed delta/quantized encoding (not implemented)

The probe only measures the encoding; it does not change `probes/net-mvp/**`.
The proposal, in order of value:

1. **Binary state channel** (delta position, smallest-three quaternion, uint16
   speed, no redundant inner tick, server timestamp): 209.7 → 23.06 B, 89.0 %.
2. **Binary input channel** (four int8 controls, on-change + 10 Hz keepalive):
   147 → 12 B, and 60 Hz → change-driven. This is the larger absolute saving
   (29.6 MB/min → <2.4 MB/min even before change-driven reduction).
3. **Short-key JSON fallback** if a binary channel is too large a change:
   209.7 → 74.0 B, 64.7 %.
4. **AI pose batch delta** (same per-car payload, batch header once):
   979.4 → 125 B, 87.2 %.

All four are byte estimators over real values, not a protocol change.

---

## 5. Top five scaling risks

### Risk 1 — Full map package load (highest)

| number | value |
|---|---|
| Gracia page total | **92.72 MB** (72.62 MB map package) |
| Amboy page total | 66.38 MB (49.52 MB package) |
| River page total | 20.47 MB (9.66 MB package) |
| Gracia at 10 / 50 / 100 Mbit/s | **74.2 / 14.8 / 7.4 s** |
| Amboy at 10 / 50 / 100 Mbit/s | 53.1 / 10.6 / 5.3 s |
| River at 10 / 50 / 100 Mbit/s | 16.4 / 3.3 / 1.6 s |
| 19 maps, measured mean package (39.5 MB) | **≈750 MB** if all are shipped |
| Gracia JSON overhead | **66.1 %** (24.63 MB raw payload in 72.62 MB) |

**Mitigation:** ship the existing binary render package shape instead of the
inline-JSON page document. The Longbeach binary package is **26.09 MB for
537,294 triangles (48.6 B/tri)** against Amboy's **49.52 MB for 348,948
triangles (141.9 B/tri)** — same data class, 2.9× better per triangle. Applying
that rule to Gracia gives a **≈25.7 MB GPU payload** (21.39 MB geometry + 4.33 MB
texture) plus a small manifest, i.e. a **64.6 % package cut** before any
streaming. Then stream sections by measured path/visibility and keep the
`instancesApplied:false` sections out until they are applied.

### Risk 2 — Per-car texture memory at 8 cars

| number | value |
|---|---|
| 8 full car packs + Gracia map | **57.63 MB (54.96 MiB)** |
| mixed LOD (1 full + 7 half-res) | **22.65 MB (21.60 MiB)** |
| current M4 (1 texture pack, ghost shader untextured) | 6.66 MB car + 4.33 MB map |
| largest single pack | Lotus 4,997,120 B RGBA / 6,662,827 B with mips |
| 8-car full total GPU (geometry + texture) | **89.38 MB (85.24 MiB)** |

**Mitigation:** the mixed-LOD row is the shipping budget: **51.88 MiB total GPU**
for Gracia, **18.59 MiB** for River. Keep the ghost/AI shader textureless until
a real material is recovered (it already is), load a peer body only when its car
differs, and add LRU eviction (the current policy is 2 resident car chunks with
no eviction). Do not preload all 25 car chunks; the 25 chunks are 172.1 MB on
disk and 111.9 MB of RGBA.

### Risk 3 — Eight physics worlds and wasm heap

| number | value |
|---|---|
| one wasm instance | **256 MiB** initial, 512 MiB max |
| current 3-AI host | 4 worlds = **1 GiB** |
| 7-AI + host | 8 worlds = **2 GiB** initial (4 GiB max) |
| engine tick, one car | 0.080–0.113 ms |
| 8-car engine tick | 0.64–0.91 ms |
| 8-car browser work, model | 1.12–4.72 ms p95 |
| 3× slower CPU, high | **14.16 ms of 16.67 ms** |

**Mitigation:** do not multiply 256 MiB heaps blindly. Either (a) one wasm world
that owns N cars (the physics API is per-car; this is an engine change and must
be measured), (b) run AI at 30 Hz or with a reduced solver step, (c) keep the
current 3-AI cap until a 7-AI capture exists, or (d) move AI worlds to a worker
with its own bounded heap. The measured 1.12–4.72 ms CPU is affordable; the
2 GiB heap is the hard constraint on low-memory devices.

### Risk 4 — Draw calls and no culling

| number | value |
|---|---|
| River, 8 cars | 1,004 draws |
| Gracia, 8 cars | **3,631 draws** |
| Longbeach, 8 cars | 2,043 draws |
| measured one-car frame | 8.06 ms p95 at 266 draws (older) / 516 draws (current) |
| draw-scaled bound, Gracia | **110.0 ms** |
| draw-scaled bound, River | 30.4 ms |
| Gracia static draws | 2,627 |

The consumer filters `visible:false` but does not frustum- or occlusion-cull.
Every Gracia map draw is submitted every frame. **Mitigation:** add frustum
culling first (cheap, no asset change), then merge static draws by texture (734
textures is a lower bound on merged draw count), then instance the 953 blocked /
2,714 unapplied instances when they become renderable, and add a car LOD that
drops wheel/caliper/interior draws beyond ~30 m. The target is <1,500 draws for
the worst map; that is a 59 % cut from 3,631.

### Risk 5 — Host upload / relay fan-out

| channel | current | delta binary |
|---|---:|---:|
| state, 8 peers, server egress | 14.09 MB/min | 1.55 MB/min |
| AI poses, 7 cars, fan-out | 8.23 MB/min | 1.05 MB/min |
| input, 60 Hz, server egress | **29.63 MB/min** | 2.42 MB/min |
| **host all channels** | **51.95 MB/min (6.93 Mbit/s)** | **5.02 MB/min (0.67 Mbit/s)** |
| per client download | 6.64 MB/min (0.89 Mbit/s) | 0.39 MB/min (0.052 Mbit/s) |

**Mitigation:** the input channel is the dominant term. Send inputs on change
(buttons are not 60 Hz data) with a 10 Hz keepalive, quantize to int8, and batch
the four controls into one binary frame. Then add the state delta encoding.
Together the measured model is a **90.3 % host-traffic cut**. A dedicated relay
(not the host process) removes the fan-out from the host uplink entirely.

### Additional limit (not in the top five): render identity

The current M4 page loads **two** car bodies (local + one human peer); AI cars
reuse the local body and the ghost shader samples no textures. Eight players
with eight different cars are **not renderable today** without a per-peer body
pool. The model’s 85.24 MiB full-texture row is the cost of closing that gap,
and the 51.88 MiB mixed-LOD row is the recommended budget.

---

## 6. Nineteen maps

Only four maps have byte data: River, Amboy, Gracia and Longbeach (Longbeach is
not page-integrated). The measured package mean is **39.5 MB**
((9.66 + 49.52 + 72.62 + 26.09) / 4). Nineteen maps at that mean would be
**≈750 MB** of installed/served map data, but only one map is loaded per session.

The budget is per map, not per install:

| budget item | target | current worst |
|---|---:|---:|
| page bytes (map + base + car + layout + physics + source) | ≤25 MB | **92.72 MB (Gracia)** |
| map GPU geometry | ≤20 MiB | 23.74 MB / 22.64 MiB (Longbeach) |
| map GPU texture (mip chain) | ≤5 MiB | 4.13 MiB (Gracia) |
| map draws | ≤1,500 | **2,627 (Gracia)** |
| map triangles | ≤400k | 550,632 (Gracia) |

The other 15 maps are **not measured**. Do not extrapolate a shipping claim from
four maps; the next task must run the same measurement on all 19 packages as
they become available.

---

## 7. Verification

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
& $node probes/perf/tools/perf_budget.mjs measure
& $node probes/perf/tools/perf_budget.mjs verify
```

Result: **562/562 checks, 0 failures** (`_work/perf/verify.json`,
`_work/logs/perf/verify.log`).

The verifier is not a restatement of the model. It re-reads the artifacts and
recomputes:

- 25 cars × 13 checks = 325 checks: file bytes vs index, positive counts,
  indices = 3 × triangles, position/UV/index byte rules, GPU sums, texture
  ≥ mip0, file > raw payload, overhead 20–45 %, draw range, triangles/draw;
- 12 River-level checks: vertices, indices, GPU sum, overhead, draw counts;
- 4 maps × 8 checks + 4 ordering checks: positive counts, GPU sums, texture
  ≥ mip0, index/triangle relation, bytes/triangle, relative sizes;
- 4 page totals × 6 checks + 4 consistency checks: component sum, positivity,
  package bound, source label, Gracia > Amboy, River/Amboy anchors;
- ghost payload/base64 arithmetic (6 records × 3) and count/total;
- 16 wasm/heap/soak checks, including the exact 8.06 ms p95, 0.59 ms work p95,
  266/516 draw counts and constant heap;
- 6 chunk-overhead checks;
- 20 snapshot checks, including the measured delta saving, quantization error
  bounds and batch sizes;
- 24 bandwidth checks: every MB/min product, the 56-stream fan-out, the 8×
  client/server relation, input dominance and kbit/s conversion;
- 24 + model checks: every scenario’s GPU/draw/triangle/CPU arithmetic,
  worst/best car selection and total consistency.

The verifier fails on impossible values (negative bytes, texture below mip0,
draws not summing, p95 below p50, totals not adding up) and on a model that
silently changes an assumption.

---

## 8. Limits — what was not measured

1. **No new browser capture.** The only frame-time evidence is the committed
   T-007 soak (headless Edge/WebGPU, one car, River). This task did not open
   Edge, did not use port 8840+, and makes no 8-car frame-rate claim.
2. **No GPU timer.** GPU memory is arithmetic over the uploaded buffers and
   mip chain, not a driver query. Hardware tile padding and allocator overhead
   are not modelled.
3. **The 8-car frame bound is a bound, not a measurement.** It assumes the
   measured frame time scales with draw count. The measured frame is not proven
   to be draw-bound; the bound is there to size the risk, not to predict fps.
4. **No 8-player run exists.** Current M4 is 2 humans + 0–3 AI; AI cars reuse
   the local body. There is no per-peer body pool and no 7-AI capture.
5. **AI driver CPU is excluded.** The host runs one JS driver per AI; its cost
   is not in the soak. The CPU range is engine + adapter + submit only.
6. **The 5-minute soak is an older packet.** It measured 266 draws/frame and
   1.72 MB geometry/packet; the current packet is 516 draws and 4.08 MB. Its
   frame/CPU/heap numbers are used; its draw/upload numbers are not.
7. **Network is loopback.** No WAN latency, loss, jitter, NAT, TLS or
   cross-machine clock skew. MB/min is payload bytes only; WebSocket framing
   and TCP/IP overhead are excluded.
8. **Gracia and Longbeach page loads are computed, not captured.** Amboy and
   River have browser page totals (66.38 / 20.47 MB). Gracia's 92.72 MB is the
   app's own formula over current files; Longbeach is not integrated at all.
   The committed Gracia MP evidence (191.1 MB) predates chunking and is not the
   current page.
9. **Only four of nineteen maps have byte data.** The 19-map total is an
   extrapolation from four packages.
10. **HUD and audio are not in the GPU model.** The HUD is DOM; engine audio is
    a separate WAV graph and is not measured here.
11. **No compressed GPU textures.** The model uses RGBA8 + mips. BC1/BC3/ASTC
   would reduce VRAM and bandwidth substantially but is not implemented and is
   not measured (not a claim).
12. **Ghost storage is local only.** 50 records / 1.87 MB is fine; no cloud or
    per-player ghost sync exists.

---

## 9. Evidence

| path | content |
|---|---|
| `probes/perf/tools/perf_budget.mjs` | measurement, encoding estimator, model and 562-check verifier |
| `probes/perf/README.md` | commands and scope |
| `_work/perf/measurements.json` | all measured rows, snapshot samples and bandwidth table |
| `_work/perf/budget-model.json` | 8-player scenarios, assumptions, car pools |
| `_work/perf/verify.json` | 562 checks, PASS |
| `_work/logs/perf/measure.log` | measurement stdout |
| `_work/logs/perf/verify.log` | verifier stdout |
| `_work/e1-drive/car-bodies.index.json` | 25-car index source |
| `_work/e1-drive/browser-evidence-soak.json` | 1-minute current-packet soak |
| `_work/logs/e1-drive/soak-summary-p42.json` | 5-minute soak (8.06 ms p95, 0.59 ms work) |
| `_work/e1-drive/amboy/map.json` | Amboy page package, 49,524,812 B |
| `_work/e1-drive/gracia/map.json` | Gracia page package, 72,616,717 B |
| `_work/map-slice/longbeach-render/render.json` | binary package counts and texture mip-chain |
| `probes/e1-drive/ghosts/index.json` | 50 ghost records |

No file under `probes/e1-drive/**`, `probes/net-mvp/**`, `tools/`, `game-data/`
or `upstream/` was modified. No commit was made by this subagent.
