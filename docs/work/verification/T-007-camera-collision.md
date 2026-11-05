# T-007 camera collision — chase camera stays out of props and terrain

**Date:** 5 November 2026
**Owner:** P36 (sub-agent)
**Scope:** `probes/e1-drive/**`, `_work/e1-drive/**`, `_work/logs/e1-drive/**`,
`docs/work/analysis/e1-drive-slice.md` §14 and this record. No change to
`probes/asset-reader/`, `probes/render-packet/`, `probes/car-parts/`, the engine,
tools, `upstream/` or `game-data/`. No vehicle-physics change, no race rules,
audio, multiplayer or game claim.

## Result

The chase camera now casts the segment from the car's aim point to the desired
eye against the **visible static geometry** (level props + real track visual) and
places the eye in front of the first hit. `verify_e1_drive.mjs` is **268/268
PASS** (231 P31 checks + 37 camera checks), all five physics state sequence
hashes are unchanged, and 20 headless Edge/WebGPU captures plus one near-field
diagnostic capture have **0 console messages**.

| before (P31) | after (P36) |
| --- | --- |
| `browser-ford-focusrs-stock-mid.png`: the frame is the inside of a prop | the Focus RS is visible at 3.15 m |
| `browser-dodge-challenger-stock-mid.png`: prop/berm fills the frame | the Dodge is visible at 4.61 m |
| `browser-lotus-exige-cup260-stock-mid.png`: prop/berm fills the frame | the Lotus is visible at 5.34 m |

The before images are preserved byte-for-byte under
`_work/e1-drive/camera-before/`; the after images are
`_work/e1-drive/camera-after/` (identical to the current
`_work/e1-drive/browser-<slug>-{start,mid,coast,end}.png`).

## The measured defect

`_work/e1-drive/run.json` (P31) and the P31 record state it plainly: at tick 150
the slower cars are still among the start-area props, so their mid frame shows
terrain. Re-casting the **unoccluded** P31 camera (`target -> target + distance *
orbit direction`) against the scene reproduces the defect with numbers:

| car | tick 150 unoccluded eye | first visible hit | hit geometry |
| --- | ---: | ---: | --- |
| Ford Focus RS | 9.315 m behind the aim point | 4.040 m | `river.block27.instances-all` |
| Dodge Challenger | 9.315 m | 6.918 m | `river.block27.instances-all` |
| Lotus Exige Cup260 | 9.315 m | 7.949 m | `river.block27.instances-all` |
| Corvette ZR1 | 9.315 m | 9.219 m | `river.block27.instances-all` |
| Audi R8 V10 | 9.315 m | clear | — |

(Corvette, Dodge, Lotus and Focus were all affected; the Audi had already
cleared the cluster at tick 150. The verifier's cross-car check pins the three
cars the P31 record named.)

## Algorithm

`web/camera-occlusion.js` builds a deterministic median-split triangle BVH from
`geometry.meshes`: the level props mesh (`river.block27.instances-all`, 13,162
vertices / 10,308 triangles) and the merged real track visual
(`river.track.visual`, 32,290 / 19,167) = **29,475 triangles, 8,191 nodes, leaf
size 8**, built once per geometry object (`WeakMap`) and reused by every car, run
and page. The occluder only accepts `coordinateSpace:'world'` meshes; a mesh in
any other space is a hard error rather than a silent skip. The tree is built with
no randomness and no wall clock, so the same geometry gives the same hits.

`web/packet-adapter.js` `ChaseCamera.update(state)`:

1. advance yaw/pitch with the existing per-tick lag (unchanged parameters,
   `?camdist`, `?camheight`, `?camyaw` still feed `orbitDistance`/`yawOffset`);
2. target = engine chassis position + `lookHeight` (1.0 m);
3. cast `target -> desired eye` (the natural orbit distance, 9.3145 m for the
   default 9.0/2.4) with a two-sided Möller–Trumbore test in the BVH;
4. if the first hit is farther than `nearFieldMetres` (3.4 m), the allowed
   distance is `hit - margin` (`margin` 0.4 m), hard floor 0.05 m;
5. **pull-in is immediate** — the eye is never left behind a resolvable surface
   for a tick; **push-out is eased** by 0.08 of the remaining gap per 1/60 s tick,
   so leaving a prop does not pop;
6. the eye is rebuilt with `cameraFromOrbit(target, distance, yaw, pitch)` and
   `orbit.distance` is the distance actually used, so the committed validator
   still rebuilds view/projection from the declared orbit.

Every tick carries its own record, so the decision is inspectable and hashed:

```json
"occlusion": {
  "enabled": true,
  "requestedDistance": 9.314504817756013,
  "distance": 3.1530483728225986,
  "blocked": true,
  "nearField": false,
  "hitDistance": 4.039736040874657,
  "hitMesh": "river.block27.instances-all",
  "marginMetres": 0.4,
  "nearFieldMetres": 3.4
}
```

`packet.diagnostics.extras.camera.occlusion` states the rule, the occluder's
mesh list/triangle count, the parameters, and why the hidden physics surface is
not an occluder. The camera distance and the pull-in are shown on the page HUD
(`camera 3.15 m / 9.31 · pulled from 4.04 m hit`).

### Near-field: the one case the camera cannot fix

The car is simulated against the road only; it drives through the start-area
props. When the first hit is **closer than 3.4 m to the aim point**, the prop
crosses the car itself: pulling the eye in front of that hit would put it inside
the car body, and leaving it behind cannot reveal the car either. Those ticks
hold the current distance and set `nearField:true` instead of pretending the
occlusion was resolved. Counts per 301-tick script (verifier, independent
re-cast):

| car | blocked ticks | resolvable (hit > 3.4 m) | near-field | resolved clear |
| --- | ---: | ---: | ---: | ---: |
| Corvette ZR1 | 55 | 23 | 32 | 269 |
| Lotus Exige Cup260 | 58 | 24 | 34 | 267 |
| Dodge Challenger | 60 | 26 | 34 | 267 |
| Ford Focus RS | 70 | 34 | 36 | 265 |
| Audi R8 V10 | 44 | 18 | 26 | 275 |

`_work/e1-drive/browser-ford-focusrs-stock-nearfield-129.png` (tick 129) shows
the documented limit: the Focus is inside the wrecked-truck prop, hit at
0.013 m, and the frame shows the prop. No camera distance can show a car from
inside a prop; that is a scenario limit, not a camera regression.

## Verification gate

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $node probes/e1-drive/tools/verify_e1_drive.mjs
& $node probes/e1-drive/tools/capture_browser.mjs --port 8811
& $py   tools/verify_asset_probe.py --skip-build
```

### Recorded result

- `_work/e1-drive/run.json` — **PASS, 268/268 checks, 0 failures** (231 P31 +
  37 camera checks). `camera.occluder` = 29,475 triangles / 8,191 nodes; margin
  0.4 m; near-field 3.4 m; recovery 0.08/tick; `continuousCollision:false`;
  `hiddenPhysicsSurfacesUsed:false`.
- Physics unchanged: every state sequence hash equals P31, including the T-007
  Corvette anchor `sha256:83f76590…008e1f`. 301/301 wheel-contact ticks, 0 NaN
  for all five cars.
- Packet hashes changed, as they must: every update now carries the camera
  distance actually used and its `occlusion` record. Draws/nodes are unchanged
  (266/254/270/281/250 draws, 9 nodes), packets are 6.82–7.09 MB.

| car | packet bytes | packet hash | camera distance range |
| --- | ---: | --- | --- |
| Corvette ZR1 | 7,090,041 | `sha256:9462fda8…ea59157a` | 3.10–9.31 m |
| Lotus Exige Cup260 | 7,046,522 | `sha256:f2956330…8f278e62` | 3.04–9.31 m |
| Dodge Challenger | 6,824,999 | `sha256:d866be00…f960373e` | 3.02–9.31 m |
| Ford Focus RS | 6,987,000 | `sha256:fa9e334d…77d46a28` | 3.07–9.31 m |
| Audi R8 V10 | 6,895,945 | `sha256:4a9b3179…3e05c189` | 3.11–9.31 m |

- Camera checks added per car: occluder provenance (visible meshes only, exact
  triangle total, no collision mesh), independent re-cast of the page's stored
  camera and of the unoccluded P31 camera, "clear on every resolvable blocking
  tick", "pulled in front of the first hit on every resolvable blocking tick",
  per-tick record validity, near-field ticks recorded and held, the four capture
  ticks (0/150/240/300) fully clear with no near-field exception, distance
  identical in the second module instance, and the requested distance as the
  upper bound. Cross-car: the recorded tick-150 occlusion is reproduced by the
  unoccluded camera and resolved by the colliding one.
- `tools/verify_asset_probe.py --skip-build` — **Passed 29 checks** (no
  regression; this slice's own gate is the verifier above).
- Geometry is untouched: `_work/e1-drive/geometry.json` 12,215,183 B, SHA-256
  `dfb93f39…e3dc3a3`, geometry v4, 144 track draws / 19,167 triangles (the P31
  file).

## Browser evidence

Headless Edge/WebGPU, 1600×900, adapter `nvidia / blackwell`, 20 captures
(5 cars × ticks 0/150/240/300), then one diagnostic capture at tick 129:

- **0 console messages** in every capture (no errors, warnings or logs);
  `browser-evidence.json` verdict `clean-console-and-gates`, 0 assertion
  failures.
- **3 geometry uploads** per page, bytes 1,623,888–1,716,240 depending on the
  body, constant across frames; `drawsIssued = frames × draws`.
- Page state hash equals node's for every capture; the car matrix is
  bit-identical; camera within 1e-6. Packet hashes are byte-exact for **17/20**;
  the other three (Dodge tick 0, Focus RS ticks 150/240) are the documented
  Node-24 vs Edge-156 `Math.atan2` last-bit difference, not a physics change.
- At tick 150 the page camera is pulled in for the four blocked cars: Corvette
  6.32 m, Lotus 5.34 m, Dodge 4.61 m, Focus 3.15 m of 9.315 m requested; the
  Audi is at 9.09 m (recovering from an earlier pull) with no hit.
- The page HUD reports the same values, e.g. Focus tick 150:
  `camera 3.15 m / 9.31 · pulled from 4.04 m hit`.
- The manual camera parameters still work and are resolved the same way: a
  diagnostic load with `?script=drive&car=corvette-zr1-stock&hold=150&camdist=14&camheight=3`
  ran with 0 console messages, requested 14.32 m, hit at 9.09 m, eye at 6.24 m
  (`browser-evidence-camdist.json`, `browser-corvette-zr1-stock-camdist-150.png`).

### Before / after (tick 150, the recorded P31 defect)

| car | before (`camera-before/`) | SHA-256 | after (`camera-after/`) | SHA-256 |
| --- | --- | --- | --- | --- |
| Lotus Exige Cup260 | `<slug>-mid.png` | `e20248a4…1b32cff` | `<slug>-mid.png` | `fabb815a…bf1c0500` |
| Dodge Challenger | `<slug>-mid.png` | `ce9a013e…fc83dd5` | `<slug>-mid.png` | `1bef6e95…e7daa4e46` |
| Ford Focus RS | `<slug>-mid.png` | `910ab4b7…e5d3dbfc` | `<slug>-mid.png` | `015b5891…058ac6d48` |

All 20 after captures are also in `_work/e1-drive/browser-<slug>-<label>.png`
(+ 2× car crops). The near-field diagnostic capture is
`_work/e1-drive/browser-ford-focusrs-stock-nearfield-129.png` with
`browser-evidence-nearfield.json`.

## What changed

| file | change |
| --- | --- |
| `probes/e1-drive/web/camera-occlusion.js` | **new**: triangle collection from world-space meshes, deterministic median-split BVH, two-sided segment cast |
| `probes/e1-drive/web/packet-adapter.js` | `ChaseCamera` occlusion (cast, margin, near-field hold, eased push-out, per-tick `camera.occlusion`), occluder in `createSession`, diagnostics `extras.camera`, limits |
| `probes/e1-drive/web/app.js` | HUD `camera` row and `cameraDistance`/`cameraOcclusion` on `window.e1DriveProbe` |
| `probes/e1-drive/tools/verify_e1_drive.mjs` | 37 camera checks, independent re-cast, `camera` block in `run.json` |
| `probes/e1-drive/tools/capture_browser.mjs` | page-camera clear check, tick-150 occlusion check, camera fields in the evidence |
| `probes/e1-drive/README.md`, `docs/work/analysis/e1-drive-slice.md` §14 | record |

## Limits

- **One cast per tick, no continuous collision.** The segment is tested at the
  resolved yaw/pitch for that packet tick; nothing is swept between ticks. A
  prop edge crossed inside one 1/60 s tick is only seen on the next tick.
- **Visible geometry only.** `packet.physicsSurfaces` is `visible:false` and is
  neither uploaded nor drawn, so it is not an occluder; neither is the car body
  (which sits on the segment). Pulling the camera in for an undrawn surface
  would produce a close-up with no visible cause.
- **Near-field is not resolved, it is labelled.** When a prop crosses the car
  (first hit < 3.4 m), the camera holds its distance and sets `nearField:true`.
  The car is inside the prop; the frame shows the prop. This is the 26–36
  ticks per car listed above, not a hidden failure.
- **Framing gets close in dense props.** The resolved distance ranges
  3.02–9.31 m over a script; at tick 150 the blocked cars sit at 3.15 m (Focus),
  4.61 m (Dodge), 5.34 m (Lotus) and 6.32 m (Corvette), so the car fills more of
  the frame than the 9.31 m default. Pull-in is along the orbit ray, so the eye
  also lowers with the distance; there is no "rise over the obstacle" behaviour.
- **The manual orbit is not occlusion-checked.** Dragging/zooming in the
  consumer switches to its debug override camera, which is unchanged; the packet
  chase camera and `?camdist`/`?camheight`/`?camyaw` are resolved the same way.
- **Presentation camera, not the engine camera.** This remains a chosen chase
  orbit, not `Cam2::I_Feed::SetRenderOffset`; the camera distance per tick is a
  pure function of the state sequence (run A = run B packet hash), not a
  wall-clock animation.
- **No visibility, culling or game claim.** No race rules, audio, multiplayer,
  opponents or engine streaming; native-vs-wasm parity remains blocked by the
  DirectX SDK (`T-007-vehicle-physics.md` §7).

## Evidence paths

| path | content |
| --- | --- |
| `_work/e1-drive/run.json` | 268 checks, per-car camera ranges/blocked/near-field counts, occluder |
| `_work/e1-drive/browser-evidence.json` | 20 captures, console log, page-camera clear checks, hash agreement |
| `_work/e1-drive/browser-evidence-nearfield.json` | tick-129 near-field diagnostic capture |
| `_work/e1-drive/browser-evidence-camdist.json` | `?camdist=14&camheight=3` tick-150 diagnostic capture |
| `_work/e1-drive/camera-before/*.png` | the P31 frames (occluded mid frames) preserved |
| `_work/e1-drive/camera-after/*.png` | the P36 frames at the same ticks |
| `_work/e1-drive/browser-<slug>-*.png` | the recorded after set (+ 2× car crops) |
| `_work/logs/e1-drive/verify-p36.log`, `edge-p36.log`, `edge-nearfield.log`, `verify-asset-probe-p36.log` | raw runs |
| `docs/work/analysis/e1-drive-slice.md` §14 | the analysis record |
