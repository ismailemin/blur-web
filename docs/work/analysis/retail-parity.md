# Retail-parity audit and comparison harness — Corvette ZR1 stock, River 0–100 m

**Date:** 8 November 2026
**Owner:** PARITY1 (sub-agent)
**Scope:** `probes/retail-parity/`, `_work/retail-parity/`,
`_work/logs/retail-parity/` and this document. Read-only inputs: the committed
E1 geometry chunks, packet consumer/adapter/camera code, the measured P48 path,
the Corvette sprint run and the P52/P60/P73 material manifests. **No file under
`probes/e1-drive`, `probes/asset-reader`, `probes/map-slice`, the engine,
`tools/`, another probe, `upstream/` or `game-data/` is modified.**

**No retail-parity claim is made.** This document measures what the browser slice
contains, defines four fixed camera poses and a retail capture protocol, and
ranks the gaps. It has no retail reference frames yet; the "identical" rows below
mean *identical to the committed source data through the packet*, not *identical
pixels to the game*.

---

## 0. Result

| item | measured value |
|---|---|
| parity target | `corvette-zr1-stock` + `usa_la_river` 0–100 m of the 310.395 m P48 path |
| audited datum classes | **38** (22 car, 16 map) |
| identical to committed source data | **8** (geometry, draw ranges, UV streams, albedo mip0 texels) |
| partial | **8** (sampling choices, material identity only, wheels, decals-as-albedo, camera) |
| missing | **22** (paint, light blend, material colour, normals, specular/lightmap, blend states, shaders, LOD, shadows, lighting, effects, HUD, 35 omitted instances, undrawn terrain) |
| draws submitted per frame | **516** = 394 track + 22 level props + 100 car |
| textured / diagnostic draws | **365 / 151** (70.7 % / 29.3 %) |
| draws carrying the 0–100 m section | **118** = 6 track + 12 props + 100 car; 38,820 triangles |
| in-band track | **6 draws / 223 triangles**, **6/6 textured** (5 images) |
| in-band props | **12 draws / 3,552 triangles**, **8 textured / 4 diagnostic** (BC3 alpha, 56 tri) |
| car body | **100 draws / 33,048 vertices / 35,045 triangles / 34 parts / 20 wheel draws / 9 textures (4,538,368 B)** |
| car material split | **50 static albedo, 10 paint, 17 light blend, 23 other `_NO_ALBEDO`** |
| submitted textures | **149** (136 track + 4 prop + 9 car), **4,985,920 B** mip0, 907 derived mip levels (**6,648,180 B** on GPU, anisotropy applied 1), hash `0x8942c723` |
| geometry upload | **3 uploads / 4,083,912 B per packet** (12 across the four poses) |
| level instances | **22 of 57 emitted (35 omitted)**; 3 placed objects / 12 primitives in the 0–100 m band |
| reference screenshots | **4 × 1600×900 PNG**, clean console (0 messages), byte-identical across two runs |
| console | **0 messages** in every capture |

The slice reproduces the game's **geometry, draw ranges, UV streams and decoded
albedo mip0 texels**. It does not reproduce the game's **material system**
(paint lookup, light blend, material colour, blend/alpha, specular, shaders),
**lighting/shadows**, **normals**, **instances beyond 22**, **decals/effects**,
**LOD selection** or **HUD**. Geometry is close to 1:1; appearance is not.

---

## 1. Target and inputs

### 1.1 Target

| | |
|---|---|
| car | `corvette-zr1-stock` (XT record 37 / id 1554942492, RWD, 1600 kg, 2.652 m wheelbase) |
| map | `usa_la_river` |
| section | P48 arc **0.000–100.108 m** (start spawn to checkpoint 1) |
| spawn | `(-88.0, 1050.0)`; the engine spawn call uses heading `1.5707963` (legacy drive-slice convention), while the sprint page places the car on the measured start tangent: forward axis `(0.694274, 0.719711)`, course heading **`0.767411 rad`**; ground `5.807372` |
| checkpoint 1 | `(-18.4982, 1122.049)`, arc `100.107736 m`, sprint tick **432** |
| course | measured P48 path, 310.395196 m, 1,245 samples at 0.25 m, 100 % draw coverage |

The 0–100 m band is measured with the P48 centre line and a **12 m radius**
(6 m declared corridor + 6 m to include the road shoulder). A triangle belongs
to the band when its centroid is within 12 m of a dense 0.1 m resample of the
first 100 m. This is a data-derived band, not a retail lane.

### 1.2 Committed inputs

| input | bytes | SHA-256 |
|---|---:|---|
| `_work/e1-drive/level.geometry.json` | 9,663,610 | `838d33408c23f2d8a9c3911cc92a9a4b3fcc3b5eeb53276c59db09efcf88483d` |
| `_work/e1-drive/cars/corvette-zr1-stock.geometry.json` | 8,468,680 | `d848d901b5dd909ed88a0350ad6ffe7be1aa50298b930f7643f02c3235acf640` |
| `_work/e1-drive/sprint-corvette-zr1-stock.json` | 880,458 | `e7a0a6dfbf03e4f1cc7599d9bf99b2e6de6518ce0ba87d3180a4723e3de51cae` |
| `_work/drivable-path/path.json` | 56,136 | `81eac0ce413075de33e2b3c0e1c077412b35002420b199d9f05d2fdeef230e7f` |
| `_work/e1-drive/module/e1_drive.wasm` (producer, not run by this probe) | 1,004,335 | see `_work/e1-drive/module/build.json` |

The level document carries the two static meshes (`river.block27.instances-all`
13,162 vertices / 10,308 triangles and `river.track.visual` 96,494 / 57,133),
22 level draws, 394 track draws, 136 track textures, 4 prop textures and the
hidden collision surface. The car chunk carries the body mesh, 9 textures,
34 parts, 4 wheel groups and 100 draws.

---

## 2. What "identical / partial / missing" means here

- **Identical** — the same committed datum reaches the GPU unchanged: positions,
  indices, draw ranges, UV float bits, decoded albedo mip0 bytes. This is
  checkable against the source artifacts, not against a retail frame.
- **Partial** — the source datum is used but a required factor is a declared PoC
  choice or is absent: a global UV inversion instead of per-material matrices,
  derived mips instead of source mips, a course material *identity* without its
  colour/blend, wheel spin without steering/suspension, decal artwork sampled as
  ordinary albedo, a non-retail camera.
- **Missing** — the datum is not in the packet or not applied at all (paint
  lookup, light blend, material colour, normals, specular/lightmap, blend
  states, shaders, LOD, shadows, effects, HUD, 35 instances, undrawn terrain).

Textures are **decoded source texels**, not a claim about retail appearance.
"Albedo mip0 identical" does not mean the material looks the same.

---

## 3. Parity matrix

### 3.1 Car — Corvette ZR1 stock

Producer facts are in `_work/e1-drive/cars/corvette-zr1-stock.geometry.json` and
`_work/car-materials/roster/cars/corvette-zr1-stock/materials.json`. Consumer
references are `probes/e1-drive/web/packet-consumer.js` (shader and pipeline) and
`packet-adapter.js` (car matrix, wheel nodes, chase camera).

| # | datum | source / producer field | count | status | consumer evidence |
|---:|---|---|---:|---|---|
| C1 | body geometry (positions, indices) | car chunk `mesh.positions/indices` (decoded `.model`, manifest SHA-256 `7c51c738…`) | 33,048 v / 35,045 tri | **identical** | `packet-consumer.js:762-826` uploads once |
| C2 | draw ranges / part ownership | `carDraws[].indexOffset/indexCount`, `partId`, `nodeId` | 100 draws / 34 parts | **identical** | `packet-adapter.js:396-437` keeps the ranges |
| C3 | UV0 stream | car chunk `mesh.uv` (66,096 float32 values) | 100/100 draws | **identical** | uploaded as buffer 1 (`packet-consumer.js:783-805`) |
| C4 | UV sampling direction | `carDraws[].uvFlipU/uvFlipV` | 50 textured draws | **partial** | `u' = 1-u`, `v' = v` (`packet-consumer.js:91-93`); one global car rule, not a per-material texture matrix (P59) |
| C5 | static albedo images | `carDraws[].textureId` from `g_MeshTexture` `TEXTURE_INDEX` | 50 draws / 9 images / 4,538,368 B | **identical texels** | `rgba8unorm-srgb` upload (`packet-consumer.js:842-878`) |
| C6 | texture sampling | P52 sampler row + `TEXTURE_SAMPLER` | 9 car images | **partial** | sRGB + derived mips + trilinear + anisotropy 8 request (`packet-consumer.js:229-249`); source declares maxAnisotropy 0, adapter reports 1; mips are derived, not source |
| C7 | material rows (`g_MeshTexture` identity) | P52 `material.id/stage/typeName` | 50 rows | **partial** | identity is used; no material parameter values are consumed |
| C8 | material colour (`g_tMaterial`-class rows) | 243 constant rows / 26 types read by P30 | 0 applied | **missing** | no colour input in `DrawUniforms` (`packet-consumer.js:58-63`); albedo is diagnostic or sampled |
| C9 | paint lookup | `g_sPaintMaterialTexture` (runtime) | 10 draws | **missing** | diagnostic `diagnosticColour`; P60 records `paintLookup.resolved:false` |
| C10 | light off/on blend | `g_sOffTexture`/`g_sOnTexture` + runtime `g_vRenderColour.w` | 17 draws | **missing** | diagnostic colour; masks decoded but blend not applied (P60 §9.3) |
| C11 | other `_NO_ALBEDO` | `veh_Default*`, `veh_Glass*`, `veh_Alloy*`, `veh_Neon*` | 23 draws (8 glass, 4 alloy, 11 default) | **missing** | diagnostic colour; no glass/reflection/neon shader |
| C12 | blend / alpha state | serialized `BlendState::AlphaBlendEnable` in the material layer | 0 of 100 | **missing** | main pipeline is opaque, alpha written 1.0 (`packet-consumer.js:620-623`); only the ghost pass blends (`:642-655`) |
| C13 | vertex normals | none exported by the reader/packet | 0 / 33,048 | **missing** | face normal from `cross(dpdx, dpdy)` (`packet-consumer.js:108-110`), `abs(dot)` two-sided |
| C14 | specular / lightmap / reflection | not in packet | 0 | **missing** | Lambert only (`:111-123`); ambient `0.16` (`:968`) |
| C15 | wheels | 4 wheel groups / 20 draws (8 tyre, 4 rim, 4 disc, 4 caliper) | 16 spin + 4 static | **partial** | spin integrated from `wheels[].angular` (`packet-adapter.js:1069-1086`); no steer, camber or suspension; caliper static (correct per `VehicleActor.cpp:5198`) |
| C16 | LODs | only the first RenderList LOD0 imported | 100/100 draws LOD0 | **missing** | no distance selection; all 100 submitted every frame |
| C17 | decals / damage | `corvette_zr1_decals` sampled on 13 draws | 13/100 | **partial** | artwork is albedo, not a decal pass; no dirt/damage/dent/scratch compositing |
| C18 | shaders | 21 distinct `veh_*.fx` effects recorded by P52 | 21 effects / 0 executed | **missing** | one hand-written WGSL shader for every draw (`packet-consumer.js:57-134`) |
| C19 | shadows | none | 0 | **missing** | one opaque pass only (`packet-consumer.js:610-623`); no shadow map/pass |
| C20 | lighting | packet `light` is `id:"diagnostic-key"` | 1 directional | **missing** | white light `(0.371,0.743,0.557)`, intensity 1, ambient 0.16 (`packet-consumer.js:963-968`); source says "no original level or vehicle light is recovered" |
| C21 | camera / FOV | `cameraIntrinsics` copied from the PoC packet (`FOV_Y = π/4`) | 1 | **partial** | 45° vertical, near 0.1562, far 230.04; chase 9.0 m / 2.4 m (`packet-adapter.js:150-152`); not a retail camera |
| C22 | HUD | page HUD is diagnostic only | 1 overlay | **missing** | no retail HUD; the parity page is HUD-free |

Car totals: **4 identical, 6 partial, 12 missing**.

Note on `g_tMaterial`: the committed P30 constant-material table for River
(243 rows / 26 types) is read only for `g_tAlbedo` (121 rows) and `g_mWorld`
(38 rows). No `g_tMaterial` colour value is recovered into the packet, and
`DrawUniforms` has no material-colour input at all
(`packet-consumer.js:58-63`); the albedo is either a sampled static image or the
labelled diagnostic colour.

### 3.2 Map section — River 0–100 m

Track draws are `river.block56.node289` primitives (the P51 course-covering
section); props are the `river.block27.instance10…21` primitives. Counts are
triangles whose centroid lies in the 12 m band.

| # | datum | source / producer field | count in band | status | evidence |
|---:|---|---|---:|---|---|
| M1 | track geometry (positions, indices) | `trackVisual.draws[].indexOffset/indexCount` over the merged direct-draw mesh | 6 draws / 223 tri | **identical** | source buffers preserved; `build_geometry.mjs` re-hashes the `level_inspect` references |
| M2 | track UV0 | `river.track.visual` mesh `uv` (192,988 values total) | 6/6 draws | **identical** | buffer uploaded (`packet-consumer.js:783-805`), raw `(u,v)` |
| M3 | track `g_tAlbedo` texels | `draw.textureId`; 136 decoded track albedos | 6/6 draws, 5 images | **identical texels** | `rgba8unorm-srgb` (`packet-consumer.js:842-878`) |
| M4 | track sampling | `TEXTURE_SAMPLER` | 6 draws | **partial** | raw stream, derived mips, repeat/linear; the U-inversion question from P59 is still open for the track (`e1-drive-slice.md` §24.2) |
| M5 | track material colour / blend | constant material rows; `layer:"opaque"` | 0 applied | **missing** | no material colour/blend/specular; one diagnostic light |
| M6 | prop geometry (3 placed objects) | `levelDraws[].id` (`block27.instance10…21`) | 12 draws / 3,552 tri | **identical** | world-baked direct draws at their source positions |
| M7 | prop static albedo | `levelDraws[].textureId` | 8 textured / 4 diagnostic | **partial** | 2 images (`level.albedo.1074.0`, `.1118.0`); the 4 `blocked-bc3-alpha` cab draws (56 tri) stay diagnostic (P73b) |
| M8 | remaining level instances | Stage B measured 57 instances / 56 supported | **35 omitted** (22 emitted) | **missing** | `levelInstances.emitted:22, omitted:35`; other blocks 15/17/26/32 and block31 prerequisite are not in the page; their bounds were not tested against the band |
| M9 | other track sections | 7 imported sections, 394 draws | 0 in band, 388 outside | **missing** | block88/node283 (95 draws) is 1 km away and has no binding row; the rest of the River render list is not imported |
| M10 | decals / effect layers | `Racification*`, banners, start/finish arch; not enumerated for River | **not measured** | **missing** | no decal/additive pass exists; Amboy measured 334 such draws / 56,860 tri, Gracia 518 / 113,461 tri — River is unquantified, not zero |
| M11 | track/prop normals | not exported | 0 / 3,775 tri in band | **missing** | derivative face normals only |
| M12 | lightmap / vertex colour | not in packet | 0 | **missing** | one directional light + ambient |
| M13 | shadows | none | 0 | **missing** | one opaque pass only (`packet-consumer.js:610-623`); no shadow pass; no contact shadow under car/props |
| M14 | terrain outside the drawn road section | not in the committed draw set | large void | **missing** | visible as the black wedge in poses B/D; P31 measured only **67 of 381** collision triangles in the drive box covered by a real draw, and the collision mesh extends further than the render mesh |
| M15 | particles / skid / dust | none | 0 | **missing** | no particle system |
| M16 | gates / start arch / HUD | gate lines are presentation-only | 2 gates in band | **missing** | no retail start gantry, checkpoint arch, signs or HUD |

Map totals: **4 identical, 2 partial, 10 missing**.

The band's three prop objects are the wrecked-car/shack cluster on the left
(instances 12–16, x ≈ −80…−71), the wood-panel/pipe barrier on the right
(instances 17–21, x ≈ −60…−52), and their four alpha/cab primitives
(instances 14/15 and 19/20, 56 triangles, diagnostic BC3). Their retail
appearance is **albedo only, no material/light**.

### 3.3 Draw accounting

| class | submitted | textured | diagnostic |
|---|---:|---:|---:|
| track (`river.track.visual`) | 394 | 297 (75.4 %) | 97 (95 no binding row, 2 runtime-only) |
| level props (`block27`) | 22 | 18 (81.8 %) | 4 BC3 alpha |
| car body | 100 | 50 (50.0 %) | 50 (10 paint, 17 light, 23 no-albedo) |
| **frame** | **516** | **365 (70.7 %)** | **151 (29.3 %)** |
| 0–100 m band only | 118 | 64 | 54 |

Frame cost recorded by the capture: **3 geometry uploads / 4,083,912 B and 149
textures / 4,985,920 B mip0 (6,648,180 B with the derived chain) per pose** (the
page re-loads the packet for each pose; 12 uploads across the four poses), 907
mip levels, mip hash `0x8942c723`, anisotropy applied 1, and two render frames
per pose (`load()` plus the explicit pose frame → 1,032 `drawIndexed` in pose A;
cumulative 4,128 after the four poses). No culling: all 516 draws are submitted
at every pose, including 388 track draws outside the band.

---

## 4. Four fixed camera poses and our reference frames

All poses use the committed camera intrinsics: **vertical FOV 45.000°**
(horizontal 72.734° at 16:9), near `0.156196`, far `230.0365`, aspect `16/9`.
**45° is a PoC value** (`FOV_Y = Math.PI/4` in
`probes/render-packet/tools/build_packet.mjs:36`), not a recovered retail FOV.
Poses A/C are the committed `ChaseCamera` (distance 9.0 m, height 2.4 m,
look height 1.0 m, occlusion on) evaluated from the recorded sprint pose; the
real sprint camera history/smoothing is not replayed. Poses B/D are fixed world
orbits derived from the measured P48 path.

| pose | view | tick | car position | eye (world) | target (world) | yaw / pitch / distance | FOV | file |
|---|---|---:|---|---|---|---|---|---|
| **A** | start, car chase | 0 | `(-87.997, 6.165, 1050.000)` | `(-94.2444, 9.5646, 1043.5224)` | `(-87.9967, 7.1646, 1050.0005)` | `-2.374299 / 0.260602 / 9.314505` | 45° | `_work/retail-parity/screenshots/pose-A-start-chase.png` |
| **B** | start, map overview | 0 | same | `(-103.2707, 19.9646, 1034.1668)` | `(-87.9967, 6.9646, 1050.0005)` | `-2.374184 / 0.533708 / 25.553865` | 45° | `.../pose-B-start-map.png` |
| **C** | exit 100 m, car chase | 432 | `(-18.4215, 5.7790, 1122.3702)` | `(-24.7066, 9.1790, 1115.9284)` | `(-18.4215, 6.7790, 1122.3702)` | `-2.368511 / 0.260602 / 9.314505` | 45° | `.../pose-C-exit100-chase.png` |
| **D** | exit 100 m, map overview | 432 | same | `(-36.5506, 19.3790, 1103.3378)` | `(-18.4982, 6.3790, 1122.0490)` | `-2.374112 / 0.463648 / 29.068884` | 45° | `.../pose-D-exit100-map.png` |

![Pose A — start, car chase](../../../_work/retail-parity/screenshots/pose-A-start-chase.png)

*Pose A. The real 100-draw Corvette with 50 sampled albedos, the real road
section and the three prop groups. Paint is diagnostic grey, glass is a
diagnostic cyan, shadows are absent and the sky is the clear colour.*

![Pose B — start, map overview](../../../_work/retail-parity/screenshots/pose-B-start-map.png)

*Pose B. Elevated start view. The black wedge is **undrawn terrain** (M14), not
a rendering error: the committed render section covers the road and embankment,
the collision mesh extends further.*

![Pose C — exit 100 m, car chase](../../../_work/retail-parity/screenshots/pose-C-exit100-chase.png)

*Pose C. Checkpoint 1 at 100.108 m: concrete pipes and the wood-panel barrier on
the right, parked/wrecked cars behind, no material colour, no shadows.*

![Pose D — exit 100 m, map overview](../../../_work/retail-parity/screenshots/pose-D-exit100-map.png)

*Pose D. The same point from 29 m behind / 13 m above; the road is textured, the
terrain left of the road is not drawn.*

Screenshot properties: 1600×900, RGB PNG, HUD-free, no overlay, **console 0
messages**. Two independent runs produced byte-identical PNGs (SHA-256 in §7.2).

Pose files are machine-readable in `_work/retail-parity/camera-poses.json`
(position, target, view matrix, projection matrix, near/far/FOV/aspect, tick,
screenshot path).

---

## 5. Retail capture protocol

The goal is four retail frames that can be compared with the four frames above.
**Without these frames 1:1 cannot be measured**; the source-data work
(materials, instances, decals) can proceed in parallel.

### 5.1 Build and settings

Record these with the captures (a plain text or JSON sidecar per session):

| item | required value / action |
|---|---|
| game | retail Blur, PC build (record version/patch and store); console build acceptable if it exposes the same free camera |
| resolution | **1600×900**, 16:9, window/borderless, 100 % render scale, device pixel ratio 1 |
| image | all quality settings at maximum; record AA mode, motion blur, depth of field, film grain, bloom, v-sync |
| HUD | **off** if the build exposes a HUD toggle. If it does not, record that fact, keep the HUD in a separate frame, and exclude the HUD rectangle from the diff |
| map | River (`usa_la_river`); single-player race/time attack; no power-ups; AI opponents must not be within 150 m of the camera (record if they are) |
| car | **Corvette ZR1 (stock)**; record the exact paint name/number and wheel option — our paint lookup is missing, so paint is an expected mismatch, not a failure of the protocol |
| assists | default; record traction/ABS/steering settings because they change the car pose only if it moves |

### 5.2 Where to put the car

Two positions, both on the measured P48 centre line:

| position | world coordinates (engine level space) | heading | landmark recipe (no debug camera) |
|---|---|---|---|
| start | `x=-88.0, z=1050.0`, ground `y=5.807` | tangent `(0.694274, 0.719711)` → yaw `atan2(t.x, t.z) = 0.767411 rad` (43.97°) | the start line / first gate; the three prop objects occupy `x -79.7…-52.0, z 1047.7…1066.8` (9–36 m from the spawn), with the large red truck on the left and the pipe/barrier stack on the right |
| 100 m | `x=-18.498, z=1122.049`, ground `y=5.779` | tangent `(0.69432, 0.71966)` → yaw `atan2(t.x, t.z) = 0.76742 rad` (43.97°) | the concrete pipe stack and the wood-panel barrier **ahead** (pipes right of centre, barrier left), roughly 5–20 m past the checkpoint; the parked/wrecked cars are behind you |

If the retail build has a debug teleport/free camera, use the coordinates
directly. These are the engine's level-space coordinates; the committed render
mesh matches the collision surface at the spawn to 0.0006 m, so the same level
asset is being addressed. If the build has no teleport, drive to the landmark
and stop with the car's rear axle on it; record the actual position from the
game's own HUD/debug readout if one exists, otherwise record the landmark.

### 5.3 Camera positions

**Tier 1 — free/replay camera available.** Use the exact pose table from §4:
eye, target, yaw/pitch/distance, **45° vertical FOV** (72.734° horizontal at
16:9), near/far as the game allows. If retail's FOV cannot be set to 45°,
capture at the game's FOV and also capture one calibration frame with a known
object (the car's rear track width) so the diff can rescale; record the retail
FOV and whether it is quoted horizontally or vertically.

**Tier 2 — no free camera.** Use the in-game chase camera:
- Pose A: car stationary at the start; chase camera fully settled (wait ≥ 2 s).
- Pose C: car stationary at 100 m; chase camera fully settled.
- Record the actual chase distance/height if the game exposes it; otherwise
  estimate from the car's on-screen size and state the estimate.
- Poses B/D are **not obtainable** without a free camera; mark them unmatched
  and compare the map qualitatively from A/C.

For every pose take **four screenshots**: at `t0`, `t0+0.5 s`, `t0+1.0 s`,
`t0+2.0 s` with the car and camera frozen. The four frames expose temporal
effects (shadows, particles, TAA, LOD hysteresis); geometry and materials must
be identical across them. A 2× crop of the car and of one landmark can be
derived losslessly from the full frame; do not upscale the capture.

Name files `retail_<pose>_<t>s.png` (for example
`retail_A_0s.png`, `retail_A_0p5s.png`, …) and record the sidecar fields:
map, car, paint, settings, pose, world position, yaw, FOV, resolution,
timestamp, file SHA-256. A ready-to-fill sidecar is
`probes/retail-parity/retail-capture-template.json`.

### 5.4 Diff checklist

Compare our frame (same pose, 1600×900, HUD-free) with retail at the same
`t`; align on the car's rear plate centre first. "Match" is defined per item:

| item | what to compare | "match" means | expected today |
|---|---|---|---|
| geometry | silhouette of car, road edges, prop outlines | same feature edges within **2 px** after plate alignment; same visible prop count | close; car/road geometry is identical source data |
| textures | rear plate `DQF 9760`, badges, tyre wall, road surface | **same artwork and orientation** (glyphs readable in the same order); sharpness may differ | albedo artwork matches; decals/dirt missing |
| colours | 5 patches: paint, glass, road, verge, sky | mean sRGB ΔE2000 ≤ **3** for road/verge/sky/tyre; paint excluded until the palette is recovered | road/verge approximate; paint/glass differ |
| lighting / shadows | shadow under car, prop shadows, light direction | shadow present, direction within **15°**, length within **20 %** | **fail**: no shadows, diagnostic light |
| props | the 3 placed objects at 0–100 m | all present at the same relative positions within **0.5 m** projected | geometry yes; material/colour partial; 4 BC3 cab draws diagnostic |
| decals / effects | track decals, lane lines, start banner, skid/dust | same decal set and placement; effects may differ in density | **fail**: no decal/effect pass; River decals unmeasured |
| FOV / framing | angular width of the car and of a fixed prop; car screen box centre | FOV within **3 %**; car centre within **2 %** of frame; horizon within **1 %** | protocol issue: our 45° is a PoC choice; measure retail FOV first |
| HUD | HUD layout, if it cannot be disabled | layout/elements only; HUD is excluded from geometry/colour scoring | our reference frames have no HUD; retail may differ |
| terrain coverage | ground/terrain outside the road | no unexplained void where retail has ground | **fail** in B/D: undrawn terrain (M14) |

Record each item as `match / partial / missing / not-comparable`, with the
measured number (px, ΔE, degrees, %) rather than a word. A frame is **not** a
1:1 match unless every row is `match`; today the expected result is
`match` for geometry and texture artwork, `partial` for colours/props/UV
sampling, and `missing` for lighting, shadows, decals, instances beyond 22 and
terrain.

---

## 6. Top gaps, effort and next implementation tasks

Impact is judged on this section and this car at 1600×900: **5** = dominates the
frame, **1** = barely visible. Effort is engineering effort for a first honest
slice: **1** = days, **5** = multi-week.

| rank | gap | affected draws | impact | effort | limit | recommended task |
|---:|---|---|---:|---:|---|---|
| 1 | material colour / paint / light blend | **50/100 car draws** (10 paint, 17 light, 23 no-albedo); **0** track material rows applied | 5 | 4 | **data-limited** for paint lookup (`g_sPaintMaterialTexture` is runtime) and light weight (`g_vRenderColour.w`); **renderer-limited** for the serialized material rows/blend | PARITY2: apply constant material rows + layer blend, add a documented palette source for paint (retail capture or an explicitly labelled default), keep runtime-only draws labelled |
| 2 | lighting / shadows | all 516 draws | 5 | 5 | **data-limited** (no level/vehicle light recovered; packet light is `diagnostic-key`) + **renderer-limited** (no shadow pass) | PARITY2/PARITY4: import level light probes if they exist; otherwise a single documented directional + contact shadow, labelled |
| 3 | normals | 100 car + 6 track + 12 prop draws (33,048 car vertices; 3,775 band triangles) | 4 | 3 | **data-limited**: the reader exports no normals; source vertex buffers may contain them (needs a reader pass) | PARITY4: export/verify vertex normals; fall back to geometric normals only where absent, labelled |
| 4 | instances | **35/57 level instances omitted** (61 %); the 22 in-scope instances (12 primitives in the band) are drawn, but the 35 omitted bounds were **not tested** against the band in this pass | 3 here / 5 globally | 2 | **renderer/wiring-limited**: Stage B data already measures 56; block31 prerequisite remains | PARITY3: wire the 56-instance set (block15/17/26/32 + block31 prerequisite), keep culling |
| 5 | decals / effect layers | River count **not measured**; Amboy 334 draws / 56,860 tri and Gracia 518 / 113,461 tri show the scale | 4 | 4 | **data-limited** (River enumeration) + **renderer-limited** (additive/alpha pass) | PARITY3: enumerate River `Racification*`/banner/arch draws, then add a separate labelled additive pass |
| 6 | LOD | 100 car + 394 track draws always LOD0 | 2 near / 4 far | 3 | **data-limited**: only the first RenderList LOD0 is imported; higher LODs exist in the source | after PARITY2: import LOD levels and select by distance, prove the switch with a fixed-pose diff |
| 7 | texture filtering / resolution | 149 textures | 2 | 2 | **data-limited**: 16×16 ground source, 512 decoder bound (two 1024 source LODs undecoded); **renderer-limited**: adapter anisotropy is 1 | keep P75 policy; decode the 1024 LODs with an explicit higher bound and record it; do not upscale |
| 8 | camera / FOV / HUD | 4 poses | 4 (measurement, not look) | 1 | **renderer/protocol**: 45° is a PoC choice, chase 9.0/2.4 m, no retail HUD | make FOV/distance/HUD parameters of the capture page (this probe already has HUD-free frames); measure retail FOV in the first capture session |

Recommended order: **PARITY2** (materials/colour/blend + a first shadow), then
**PARITY4** (normals, then image diff), then **PARITY3** (instances, decals).
Paint colour and light blend cannot be finished from data alone; the retail
capture protocol is the gate for those two rows, not an optional extra.

---

## 7. Evidence, commands, limits

### 7.1 Commands

```powershell
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"

# inventory of the car and the 0-100 m band (read-only)
& $py probes/retail-parity/tools/inventory.py

# four fixed-pose frames, headless Edge/WebGPU, console gate, evidence JSON
& $node probes/retail-parity/tools/capture_parity.mjs

# optional: inspect the page manually (read-only static server)
& $node probes/retail-parity/tools/serve_parity.mjs 8844
# then open http://127.0.0.1:8844/probes/retail-parity/web/index.html
```

The capture tool writes `_work/retail-parity/screenshots/*.png`,
`_work/retail-parity/capture.json` and `camera-poses.json`, and logs the Edge
process to `_work/logs/retail-parity/edge-capture.log`; the two commands' stdout
is in `_work/logs/retail-parity/{inventory,capture}.log`. It exits non-zero if
any console error/warning appears. It reuses the committed packet consumer and
adapter; it does not step the engine and does not modify e1-drive.

### 7.2 Output hashes

| file | bytes | SHA-256 |
|---|---:|---|
| `_work/retail-parity/inventory.json` | 11,086 | `6a35016b1237d966fd86e125567893150122d9d50e10c398b09c6b08d4a252f6` |
| `_work/retail-parity/capture.json` | 15,500 | `d8d2e3ea6674dd1d89b059245745284a5ed7eac3f61afe8989cfabcfa63b457b` |
| `_work/retail-parity/camera-poses.json` | 5,732 | `214a3247fc7e095e3465051500c9dc25c12d5550c1a9b9af4624d425d6e96aaa` |
| `screenshots/pose-A-start-chase.png` | 375,949 | `14c9d89e88fe782004f3fd0d0204a28174f7f297b86baa43545d379470256dcd` |
| `screenshots/pose-B-start-map.png` | 506,719 | `857be047e90f255e4af4be8714f3247a5fb25b17056641d0305b76f17cca215c` |
| `screenshots/pose-C-exit100-chase.png` | 400,231 | `18f27bfc464cc4c9523fd5c4ed88fdcb7caf9a17ba2737e8159125a3e189017c` |
| `screenshots/pose-D-exit100-map.png` | 557,605 | `f7764d3e21b6eb9eab9f68d213633039f4624bccc7b20d8169269d902eb739b1` |

The PNG hashes are identical when `capture_parity.mjs` is run twice
(deterministic frame and encoder).

### 7.3 Limits

- **No retail reference frame is present in this repository.** The protocol in §5
  is the input required to make the "identical/partial/missing" table a measured
  parity result rather than a current-state audit.
- **The car pose is reconstructed, not simulated.** Poses A–D take the
  committed sprint run's recorded `position` and `axisZ` and rebuild
  `axisX/axisY` with a world-up orthonormalisation; the four wheel records are
  the manifest rest translations. No physics tick runs in this probe, so the
  frames are renderer references, not new state anchors.
- **The camera is not retail.** 45° vertical is the committed PoC packet camera
  (`FOV_Y = π/4`), chase 9.0 m / 2.4 m, no retail FOV, exposure, tone mapping or
  camera shake.
- **The "identical" rows are source-data identity.** Positions, indices, UV bits
  and albedo mip0 texels reach the GPU unchanged; the appearance built from them
  is not claimed.
- **The 0–100 m band is a measured 12 m band**, not a retail lane; the counts
  depend on that declared radius (the drawing code is in `inventory.py`).
- **River decal/effect counts are unmeasured**, unlike Amboy (334) and Gracia
  (518); the audit reports `not measured`, never zero.
- **Only the first RenderList LOD0** is imported; higher LODs, damage states,
  paint variants and runtime light states remain unimported.
- **Headless Edge is a proxy** for the user's physical browser; the adapter
  reported `nvidia / blackwell` in the capture.
- **No full-game, retail-parity or frame-rate claim.** This is a verification
  plan plus a current-state audit.
