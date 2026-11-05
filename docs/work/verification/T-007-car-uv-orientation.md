# T-007 car UV orientation — plates and decals read correctly

**Date:** 6 November 2026
**Owner:** P59
**Scope:** `probes/e1-drive/**`, `_work/e1-drive/**`, `_work/logs/e1-drive/**`,
`docs/work/analysis/e1-drive-slice.md` §24 and this record. No change to
`probes/car-materials/`, `probes/car-parts/`, `probes/drivable-path/`, the engine,
`probes/render-packet/`, `tools/`, `upstream/` or `game-data/`.
This corrects the sampling direction introduced by P55
(`docs/work/verification/T-007-textured-cars.md` §Sampling convention); its
`(u, 1−v)` claim is **superseded** here. Physics, sprint, camera, telemetry,
restart and soak behaviour are untouched.

## Result

The 224 textured car draws now sample `(1 − u, v)`. Plates, badges and emblems
read left-to-right and upright; V is left raw. Before this pass the same draws
sampled `(u, 1 − v)`, which rotated every readable island by 180°: the Audi rear
plate read upside-down with the `E` strip on the right and the Corvette plate
read upside-down `DQF 9760`.

- `verify_e1_drive.mjs` is **570/570, 0 failures** (same check count as P55; the
  convention check was rewritten, not added to, and the five packet anchors were
  re-pinned).
- All five drive **state sequence hashes are unchanged**.
- 20 headless Edge/WebGPU captures: **0 console messages**, 0 assertion failures,
  the same textured-draw and texture counts as P55.
- No UV, pixel, texture count, RGBA byte or draw count changed. Only the
  per-draw U sampling direction changed.

## Root cause

The committed inputs were already consistent:

- the P52 `.rgba` files are stored **row 0 = top**, so `v = 0` samples the top row;
- the committed `scene_inspect.exe` UV0 stream already maps the **upper** edge of
  a plate to the **small** `v` (top rows), so **V needs no flip**;
- the model's **U** axis runs opposite to the image's left-to-right reading
  direction on every readable island, so the raw stream displays a horizontal
  mirror (glyph order reversed, glyphs upright);
- flipping V as P55 did produced a vertical mirror; V-flip plus the existing U
  mirror is a 180° rotation, which is the state P55 recorded as "still mirrored".

### Measured evidence from the committed mesh

| island | committed positions → UV | conclusion |
| --- | --- | --- |
| ZR1 rear plate `nyc_10` (draw 14) | `x=+0.124 → u=0.935`; `x=-0.124 → u=0.072`; `y=+0.328 → v=0.077`; `y=+0.194 → v=0.917` | U increases toward world `+x` (screen-left from behind); V decreases as the plate rises → V already upright |
| Audi rear plate `spain10` (draws 51/52) | `x=+0.258 → u=0.981`; `x=-0.258 → u=0.018`; `y=0.338 → v=0.079`; `y=0.231 → v=0.939` | same one convention |
| ZR1 side badges `corvette_zr1_decals` (draws 39/44) and front/rear emblems | U increases toward the screen-left on the outside of the body | same convention on the sides and at the front as at the rear |
| Dodge rear plate `cali_09` (draw 28) and front plate (draw 29) | decoded images row 0 = top; front and rear both read normally with `1 − u` | validates the rule on a front-facing island too |

### Transform comparison on the same ZR1 frame

The P55 exploration cropped the four possible axes from the identical rendered
frame; the files are retained in `_work/e1-drive/`:

| transform | observed | file |
| --- | --- | --- |
| raw `(u, v)` | `DQF 9760` in reverse glyph order, glyphs upright; `NEW YORK` at the plate top | `p55-plate-asis.png` |
| `(u, 1 − v)` (P55, reverted here) | upright glyph order but upside-down glyphs; 180° look with the raw U mirror | `p55-plate-vflip.png` |
| `(1 − u, 1 − v)` | 180° rotation | `p55-plate-rot180.png` |
| **`(1 − u, v)` (this fix)** | **`DQF 9760` and `NEW YORK` read normally** | `p55-plate-uflip.png` |

## The rule

For every car draw whose P52 status is `static_albedo_image_resolved` (224 of
491), sample the committed UV0 stream as:

```text
u' = 1 − u
v' = v
```

The UV values are not modified in the vertex buffer; the consumer applies the
transform in the vertex stage from per-draw flags.

| layer | change |
| --- | --- |
| `tools/build_car_textures.py` | `uvConvention` now records `sampleU:"1 - uv0.u"`, `sampleV:"uv0.v (unchanged)"`, `sampleUV:"(1 - uv0.u, uv0.v)"`; the 224 textured draws get `uvFlipU:true` / `uvFlipV:false`, all other draws both `false` |
| `tools/build_geometry.mjs` | carries `uvFlipU` and `uvFlipV` per draw; `textureBinding.uvConvention` is `sampled as (1 - u, v)` |
| `web/packet-adapter.js` | requires `uvFlipU:true, uvFlipV:false` on textured car draws and rejects either flag on track draws |
| `web/packet-consumer.js` | `uv' = (select(u, 1-u, texParams.y), select(v, 1-v, texParams.z))`; `texParams.y/z` are the two per-draw axis flags |
| `tools/verify_e1_drive.mjs` | checks the new convention, the 224 textured draws, the 267 untextured draws and the 394 track draws; packet anchors re-pinned |
| `probes/e1-drive/README.md` | documents `(1 − u, v)` and the open track question |

Track and level draws keep the raw stream (`uvFlipU` and `uvFlipV` both false).
The track pack has no readable text, so its orientation is left as accepted P49
evidence and recorded as an open item, not silently flipped.

## Before / after

| view | before (P55, V flip) | after (P59, U flip) |
| --- | --- | --- |
| Audi R8 V10 rear plate | `350L EMO` upside-down, `E` strip on the right (`_work/e1-drive/p55-zoom-audi-plate.png`) | `E 350L EMO` upright, `E` strip on the left (`_work/e1-drive/browser-audi-r8v10-stock-p59-uflip6-150.png`, crop `p59-audi-plate.png`) |
| Corvette ZR1 rear plate | upside-down `DQF 9760` (`_work/e1-drive/p55-plate-vflip.png`) | `NEW YORK` / `DQF 9760` upright (`_work/e1-drive/browser-corvette-zr1-stock-p59-uflip6-150.png`, crop `p59-zr1-plate.png`) |
| Dodge Challenger rear plate | would have been rotated the same way | `California 2SBI653` upright (`_work/e1-drive/browser-dodge-challenger-stock-p59-uflip6-240.png`, crop `p59-dodge-plate.png`) |
| Audi rings badge | upside-down rings | rings upright (`p59-audi-plate.png`) |
| ZR1 crossed-flags emblem | upside-down | upright (`p59-zr1-plate.png`) |
| Dodge side livery stripe | present | present, unchanged geometry (`browser-dodge-challenger-stock-p59-side-240.png`) |

Screenshots are headless Edge/WebGPU at 1600×900 with a diagnostic camera
override (`?camdist=6&camheight=2`; `camyaw=1.6` for the side view). The override
only changes the chase orbit and is recorded as such by the capture tool.

## Verification gate

```powershell
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"

& $py   probes/e1-drive/tools/build_car_textures.py
& $node probes/e1-drive/tools/build_geometry.mjs
& $node probes/e1-drive/tools/verify_e1_drive.mjs
& $node probes/e1-drive/tools/capture_browser.mjs --evidence-name p59-browser-evidence.json --port 8820 --debug-port 9360
```

| gate | result |
| --- | --- |
| `build_car_textures.py` | 5 cars / 491 draws / **224 textured** / 40 textures / 18,178,048 B, exit 0 |
| `build_geometry.mjs` | geometry v6, 45,193,728 B, exit 0 |
| `verify_e1_drive.mjs` | **PASS, 570/570**, 0 failures → `_work/e1-drive/run.json` |
| `capture_browser.mjs` | **clean-console-and-gates**, 20 captures, 0 console messages, 0 assertion failures |

### What moved and what did not

| value | result |
| --- | --- |
| drive state hashes | **unchanged**: `83f76590…`, `8d6cd4d4…`, `b1c63d20…`, `fb3909b6…`, `5b4ae49d…` |
| packet hashes | moved to `4c82e8f8…`, `77e70bec…`, `da25d019…`, `0590c3e8…`, `61e030bf…` because the per-draw UV flags changed; the five `PHYSICS_ANCHORS.packet` constants are re-pinned with that note |
| sprint / telemetry / restart / reset | unchanged |
| textured car draws | **224** (50 / 48 / 42 / 37 / 47); 267 runtime-only draws still diagnostic |
| textures / RGBA | **40 / 18,178,048 B**, byte-identical to P55; no texture was re-decoded |
| UV stream | **314,490 values / 1,257,960 B**, byte-identical to P55; no UV was modified |
| browser uploads | 143–145 textures and the same 3 geometry uploads per page |

## Browser evidence

`_work/e1-drive/p59-browser-evidence.json` — 20 captures (5 cars × 4 ticks),
`verdict: clean-console-and-gates`, `console.totalMessages: 0`,
`console.errorsAndWarnings: 0`, `assertions.ok: true`.

| car | drive state hash | packet hash | textured car draws | textures |
| --- | --- | --- | ---: | ---: |
| Corvette ZR1 | `83f76590…` | `4c82e8f8…` | 50 | 9 |
| Lotus Exige Cup260 | `8d6cd4d4…` | `77e70bec…` | 48 | 9 |
| Dodge Challenger | `b1c63d20…` | `da25d019…` | 42 | 7 |
| Ford Focus RS | `fb3909b6…` | `0590c3e8…` | 37 | 7 |
| Audi R8 V10 | `5b4ae49d…` | `61e030bf…` | 47 | 8 |

17/20 per-tick packet hashes are byte-exact between Node and Edge; the three
differences are the already-documented Node 24 / Edge 156 `Math.atan2` last-bit
case (Dodge tick 0, Focus ticks 150 and 240), not a UV issue.

## Files and hashes at this result

| file | bytes | SHA-256 |
| --- | ---: | --- |
| `_work/e1-drive/car-textures.json` | 608,511 | `7d885ecdd53b51878a7343d0ee3ebb266c94ff648b555517a4492bdaf3973169` |
| `_work/e1-drive/geometry.json` | 45,193,728 | `85a321000868042a11ccabffeb65feaa16e36d35220f1843ea46b48244eb0445` |
| `_work/e1-drive/run.json` | 856,685 | `3e6ae33ffce41c929fbf3c9c6fd9d4037c9eee5b324d3faaf10bc7fae72c5f97` |
| `_work/e1-drive/p59-browser-evidence.json` | 1,293,065 | `0ce595ea67b2675b340d3e0ac98a03031edddd644e9f56017fbdda3003843ea5` |

Logs: `_work/logs/e1-drive/p59-build-car-textures.log`,
`p59-build-geometry.log`, `p59-verify-1.log` (packet-anchor failures before
re-pin), `p59-verify-2.log` (570/570), `p59-capture-all.log`,
`p59-capture-audi.log`, `p59-capture-corvette6.log`, `p59-capture-dodge240.log`,
`p59-capture-dodge-side.log`, `p59-capture-dodge-front.log`,
`p59-capture-ford-front.log`.

## Limits

- One declared **global car U inversion**, not a recovered per-material texture
  matrix. A future model that mixes U directions on one car would need a
  per-material transform; this pass does not invent one.
- 267 of 491 car draws stay diagnostic: 45 runtime paint lookups, 66 light
  off/on blends and 156 other `_NO_ALBEDO` shaders.
- No mip chain, sRGB conversion, anisotropy, material colour, blend state or
  original shader. Sampling is `rgba8unorm` mip0, repeat/linear — a declared PoC
  choice, not recovered engine state.
- The track pack keeps its raw UV stream. Its road textures carry no readable
  text; whether it needs the same U inversion is an open item.
- The Focus glass still binds an alpha image and renders it opaque (no blend
  state). Diagnostic body/light colours remain where P52 has no static image.
- Screenshots use a diagnostic camera override; they are not gameplay framing.
- **No full-game claim.** One car at a time, one loaded block, no race rules,
  opponents, audio, culling or streaming.
