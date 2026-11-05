# T-007 textured track — real static albedo on the real UV0 stream

**Date:** 5 November 2026
**Owner:** P49
**Scope:** `probes/e1-drive/**`, `_work/e1-drive/**`, `_work/logs/e1-drive/**`,
`docs/work/analysis/e1-drive-slice.md` §21 and this record. No change to
`probes/track-coverage/`, `probes/drivable-path/`, `probes/car-parts/`,
`probes/render-packet/`, the engine, `tools/`, `upstream/` or `game-data/`.
Physics, cars, sprint, camera, telemetry, restart and soak behaviour are
untouched; this record adds texture data and one sampling path to the existing
visual.

## Result

The E1 drive PoC now samples the **real static `g_tAlbedo` texture** on the
**real UV0 stream** for **297 of the 394** track draws. The other **97** draws stay
on the labelled diagnostic albedo: `2` because their albedo is a runtime-only
material parameter and `95` because block88/node283 has no P44/P45/P47 binding
row. No UV, colour, address mode or pixel is invented.

- `verify_e1_drive.mjs` is **522/522 checks, 0 failures** (was 514/514; eight new
  texture/UV checks).
- All five drive/sprint **state sequence hashes are unchanged** from P36/P37.
- 20 headless Edge/WebGPU captures (5 cars × 4 ticks) have **0 console messages**
  of any kind and pass every browser gate.
- A 1-minute two-run soak is **PASS**, with **136** live textures at the end (the
  same count as one packet) and 0 console messages.
- The road pixels change from the diagnostic neutral `206,206,206` to the sampled
  texture colour; see §Browser evidence.

## Inputs (all read-only, pinned by hash)

| input | content | pin |
| --- | --- | --- |
| `_work/logs/engine-stream-spike/a__run1.log` | P47 harness stdout, one `webfiledraw section uv0` row per drawable corridor draw | SHA-256 recomputed and folded to the P45 aggregate; `a__run1.log` must equal `a__run2.log` |
| `_work/logs/engine-stream-spike/p47-verify-fresh.json` | P47 gate totals | `verdict=PASS`, `uvAggregate=2ed1f4b0b3c9148e`, `bindingAggregate=9cc08756505dd497` |
| `_work/logs/engine-stream-spike/reference-mesh-<g>-<n>.json` | committed C++ `level_inspect` mesh reference (`uv0` + draws) | float32 positions must equal the geometry input; indices and draw ranges must equal it; per-draw UV0 hash must equal the P47 row |
| `_work/logs/engine-stream-spike/track-textures.json` / `engine-textures.json` | P34/P47 per-texture decode records | name, texture hash, size, levels, format, RGBA bytes/hash compared with the decode |
| `_work/logs/engine-stream-spike/textures/tex-<b>-<i>.raw` | descriptor+texel blob per source | blob FNV must equal the P47 record; the committed decoder re-decodes it |
| `_work/build/asset-reader-native/Release/texture_inspect.exe` | committed BC1 reader (`--raw`) | no BC1 decode is re-implemented |
| `_work/level-candidates/probes/{00-...-g88-n283,08-...-g56-n289}/reference.json` | the geometry inputs for the two `level_inspect` sections | the pins `build_geometry.mjs` already uses (`e2a830f4…`, `ac570f64…`) |
| `_work/track-coverage/visual.json` | the 46-section draw map for the other five sections | `877b4dc7…` (the pin `build_geometry.mjs` uses) |

## Export rule (`build_track_textures.py`)

For each of the seven merged sections, in the same order as
`build_geometry.mjs`:

1. load `reference-mesh-<g>-<n>.json` with a **signed-zero-preserving** parser
   (the reader prints `-0`; the default Python parser loses the sign — P45 §Signed
   zero); require `len(uv0) == 2 × vertexCount` and every component finite;
2. require the mesh reference's float32 positions to equal the geometry input's
   positions and its indices/draw ranges to equal the geometry input's, so the UV
   pairs are addressed by the same vertex indices the merged mesh uses;
3. for each draw, resolve the P47 row by section key + primitive index, require
   `uvnull=0`, recompute the UV0 FNV-1a 64 over the referenced indices exactly as
   `verify_stream.py` does, and require it to equal the row's `uvhash`
   (**299/299 equal**; a mismatch names the section, draw, both hashes and
   aborts);
4. fold the parsed rows with the same field order/encoding as
   `verify_stream.py::section_uv_hash` and require the P45 aggregate
   `2ed1f4b0b3c9148e` before writing anything;
5. for each distinct static `block:index`, run the committed decoder on the blob,
   require `width×height×4 == rgbaBytes`, require the RGBA FNV-1a 64 to equal the
   P34/P47 record and the name/hash/size/levels/format to match, and write the
   RGBA bytes to `_work/e1-drive/textures/track.albedo.<block>.<index>.rgba`;
6. write the concatenated UV0 stream as float32 LE and the manifest.

A draw with no P47 row (block88/node283) is **not** given a texture. Its UV0 is
still the real reader stream (it is exported for mesh completeness) but
`textureId:null` + `bindingStatus:"noBindingRowForSection"` says why it is not
sampled. The two `materialId=null` draws get
`bindingStatus:"runtimeOnlyAlbedoParameter"` and stay diagnostic.

## Ordered textures and coverage

| section | draws | textured | UV values | UV stream SHA-256 (first 16) |
| --- | ---: | ---: | ---: | --- |
| `river.block88.node283` | 95 | 0 | 35,564 | `54c81e79625a…` |
| `river.block56.node289` | 49 | 49 | 29,016 | `82729d1cb3f2…` |
| `river.block58.node265` | 41 | 41 | 24,454 | `481a39e75c8e…` |
| `river.block50.node265` | 44 | 42 | 27,748 | `53fb48ec362a…` |
| `river.block71.node209` | 56 | 56 | 23,048 | `b322522ffbe5…` |
| `river.block64.node209` | 40 | 40 | 22,290 | `07e8752e0f44…` |
| `river.block59.node265` | 69 | 69 | 30,868 | `42fc6a1189a1…` |
| **total** | **394** | **297** | **192,988** | total `8133b9fc…` |

The UV value range is exactly P45's: u **−37.96875 … 53.28125**, v
**−43.25 … 28.84375**. Values outside `[0,1]` are real; the sampler repeats them
(§Sampling contract).

## Measured result

| check | result |
| --- | --- |
| merged track draws / vertices | **394 / 96,494** |
| draws textured | **297** (six measured corridor sections) |
| diagnostic fallback | **97** = 2 runtime-only + 95 no-binding-row |
| static albedo sources | **136** (`40` P34 + `96` P47), 0 unsupported |
| distinct texture names | 131 (a name can repeat on another block) |
| texture sizes | 4×4 … 256×16; 55 × 16×16, 25 × 32×16, 16 × 32×32, 11 × 64×16, … |
| declared mip levels | 3 … 9 (recorded; only mip0 is uploaded) |
| encoded payload + descriptor | **75,888 + 3,808 = 79,696 B** |
| decoded CPU RGBA (mip0) | **439,360 B** |
| RGBA range | 64 B (4×4) … 32,768 B (128×64) |
| draws per texture | 1 … 16 |
| UV0 values / bytes | **192,988 / 771,952 B** |
| UV0 aggregate | **`2ed1f4b0b3c9148e`** (unchanged from P45) |
| P47 binding aggregate | **`9cc08756505dd497`** (unchanged from P47) |

Road/terrain names in the 29 m drive section include `grounddirt08_diff`,
`mudfloorbaked01_diff`, `offroadbaked01b_diff`, `concretefloorsmooth01_diff`,
`mudsidewall02_diff`; the prop names include `concretepipe_diff`,
`constructionfence01_diff`, `constructionfence03_diff`, `greywall01_diff`,
`cargocontainer_red`, `crane01_diff`, `steelpole_diff`.

## Sampling contract (explicit, not recovered engine state)

P45/P47 state that wrap mode, filter, anisotropy, mip selection and texture
matrices are **not resolved**. This pass therefore publishes one declared choice
(`geometry.texturePack.sampler`, mirrored by `TEXTURE_SAMPLER` in the consumer):

| state | value | reason |
| --- | --- | --- |
| address mode U/V | `repeat` | UV0 leaves `[0,1]`; repeating follows the real UV stream instead of clamping it |
| mag/min filter | `linear` | one choice, applied to the uploaded mip0 |
| mip levels uploaded | **1 (mip0 only)** | the declared chain is recorded, not generated or uploaded |
| texture format | `rgba8unorm` | the committed BC1 decode of the stored texels, uploaded without a channel transform |
| sRGB | **not applied** | no sRGB-to-linear conversion is claimed; the RGBA values are the decoder's |
| material colour / blend / shader stages | **not applied** | only the albedo pixels are bound; a textured draw is tinted white so the texel is used unchanged |

A draw without a texture samples a **1×1 white placeholder** and mixes back to its
diagnostic albedo (`texParams.x = 0`), so the fragment shader has no non-uniform
control flow around `textureSample`. Mip/sRGB/anisotropy/retail sampler fidelity
is **not** claimed.

## Determinism

- `build_track_textures.py` was run twice (and again at the final gate): the
  manifest, UV binary and all 136 RGBA files are byte-identical, and the printed
  SHA-256 is the file's SHA-256 (the manifest is written with LF bytes and no
  platform newline translation).
- `build_geometry.mjs` was run twice on the same inputs: `geometry.json` is
  byte-identical (`sha256:91846bac…`).
- The manifest's per-draw UV hash is recomputed from the mesh stream and compared
  with the P47 row; the UV aggregate is recomputed in Python before the pinned
  constant is checked.
- All 394 texture bindings are a function of the committed data: no `Math.random`,
  no wall clock, no unordered map iteration in the output.

## Verification gate

```powershell
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"

& $py   probes/e1-drive/tools/extract_track.py
& $py   probes/e1-drive/tools/build_track_textures.py
& $node probes/e1-drive/tools/build_geometry.mjs
& $node probes/e1-drive/tools/build_course.mjs
& $node probes/e1-drive/tools/build_corridor_survey.mjs
& $node probes/e1-drive/tools/build_sprint.mjs
& $node probes/e1-drive/tools/verify_e1_drive.mjs
& $node probes/e1-drive/tools/capture_browser.mjs --port 8814
& $node probes/e1-drive/tools/soak_browser.mjs --minutes 1 --runs 2 --port 8852 --debug-port 9352
```

| gate | result |
| --- | --- |
| `build_track_textures.py` | 136 textures / 439,360 RGBA B / 394 draws / 297 textured, exit 0 |
| `build_geometry.mjs` | geometry **v5**, 18,791,525 B, `sha256:91846bac…`, exit 0 |
| `verify_e1_drive.mjs` | **PASS, 522/522**, 0 failures, `_work/e1-drive/run.json` |
| `capture_browser.mjs` | **clean-console-and-gates**, 20 captures, 0 console messages |
| `soak_browser.mjs` (1 min, 2 runs) | **PASS**, 0 failures, 0 console messages |

The eight new checks are: UV stream present for all 96,494 vertices; manifest and
geometry UV hashes agree; 297/2/95 binding split with per-draw status; 136 unique
`block:index` textures; 136 embedded RGBA payloads re-hash to the exported files;
the sampler contract; every textured draw samples finite UV0; the runtime-only
pair is exactly `g50-n265` primitives 241/242.

### What moved and what did not

- **Unchanged:** the five drive state sequence hashes
  (`83f76590…`, `8d6cd4d4…`, `b1c63d20…`, `fb3909b6…`, `5b4ae49d…`), the five
  sprint state hashes, sprint times, checkpoint ticks, respawn, restart, telemetry
  metrics and all camera results.
- **Changed:** the whole-packet hash, because the packet now carries the UV stream
  and the 136 textures. The five `PHYSICS_ANCHORS.packet` constants are re-pinned
  to the P49 values
  (`3f0bd5a1…`, `9daf559a…`, `d4e9f055…`, `10a2e092…`, `5b96bc3d…`) with a comment
  that only the packet body changed. `geometry.json` grew from 16,971,391 B to
  18,791,525 B (+1,820,134 B: 771,952 B UV as base64 + 439,360 B RGBA as base64
  + metadata). The five packet JSON files are now 14.1-14.4 MB each.

## Browser evidence

Headless Edge/WebGPU, 1600×900, adapter `nvidia / blackwell`, 20 captures
(5 cars × ticks 0/150/240/300):

| car | geometry upload bytes | textures | texture bytes | textured track draws | UV vertices |
| --- | ---: | ---: | ---: | ---: | ---: |
| Corvette ZR1 | 4,083,912 | 136 | 439,360 | 297 | 96,494 |
| Lotus Exige Cup260 | 4,066,848 | 136 | 439,360 | 297 | 96,494 |
| Dodge Challenger | 3,954,096 | 136 | 439,360 | 297 | 96,494 |
| Ford Focus RS | 4,020,436 | 136 | 439,360 | 297 | 96,494 |
| Audi R8 V10 | 3,999,824 | 136 | 439,360 | 297 | 96,494 |

- 3 geometry uploads per page (level + track + that car), constant across frames;
  the extra bytes are the per-mesh UV buffers (track real, level/car explicit
  zero buffers) plus each car's own body size.
- 136 texture uploads / 439,360 B per page, destroyed with the packet (soak:
  created 816 = 6 loads × 136, destroyed 680, live 136).
- `drawsIssued = frames × draws` in every capture; 516 draws for the Corvette
  (22 level + 394 track + that car's own 100) and 500-531 for the roster.
- 0 console messages (errors, warnings or logs) in all 20 captures and in the
  close-up capture.
- Browser state hash equals Node's for every capture; the car matrix is
  bit-identical; the packet hash is byte-exact wherever Node 24 and Edge 156 agree
  on `Math.atan2` (the documented ulp case).

Screenshots:

| file | what it shows |
| --- | --- |
| `_work/e1-drive/browser-corvette-zr1-stock-start.png` | tick 0: textured road under the settled car |
| `_work/e1-drive/browser-corvette-zr1-stock-mid.png` | tick 150: textured dirt road and embankment; HUD `394 real draws · 57133 tri · 297 textured (136 tex, 439360 B)` |
| `_work/e1-drive/browser-corvette-zr1-stock-coast.png` | tick 240: car on the textured section |
| `_work/e1-drive/browser-corvette-zr1-stock-end.png` | tick 300: the last ~12 m still has no committed real draw |
| `_work/e1-drive/browser-<slug>-*.png` | the same four ticks for all five roster cars |
| `_work/e1-drive/browser-corvette-zr1-stock-texture-proof--150.png` / `-car.png` | close chase view (`camdist=7&camheight=2.4`) of the textured road |

![Textured track under the car](../../../_work/e1-drive/browser-corvette-zr1-stock-mid.png)

*`_work/e1-drive/browser-corvette-zr1-stock-mid.png`: the road and embankment now
sample their own static albedo textures; previously the same geometry was a flat
diagnostic grey.*

Before/after (same 394-draw geometry, same chase camera family, different tick):

| build | file | road patch (380,580) 40×40 average RGB |
| --- | --- | --- |
| P46 (pre-texture) | `_work/e1-drive/browser-corvette-zr1-stock-sprint-mid.png` | **206, 206, 206** (neutral diagnostic) |
| P49 (textured) | `_work/e1-drive/browser-corvette-zr1-stock-mid.png` | **129, 130, 111** (sampled, lit texture) |

The patch is a fixed screen region over the road; the exact tick differs, so the
number is a colour-shift indicator, not a pixel-diff. The neutral albedo cannot
produce the R>G>B shift, so the colour comes from the bound texture.

## Limits

- **97 of 394 draws are still diagnostic.** 2 draws (`g50-n265` primitives
  241/242) point at `DATA_INDEX`/`TEXTURE_PTR` runtime values; 95 block88/node283
  draws have no P44/P45/P47 binding row. Their UV0 is real but no texture is
  invented.
- **No mip chain, no sRGB, no anisotropy, no material colour, no blend state, no
  original shader.** Sampling is `rgba8unorm` mip0, repeat/linear. Retail
  sampler fidelity is not claimed.
- **Wrap/filter are a declared PoC choice**, not recovered engine state. UV0
  outside `[0,1]` repeats.
- **Not the whole track.** block88/node283 is three kilometres from the drive
  box and block56/node289 ends near `x = −55`; the last ~12 m has no draw.
- **No culling, sorting, batching, visibility or LOD selection.** All 394 track
  draws are submitted every frame; `instancesApplied:false` is unchanged.
- **No full-game claim.** One car, one loaded block, one read-only overlay
  layer; no race rules, audio, multiplayer, engine streaming or retail material
  pipeline.

## Evidence

| path | content |
| --- | --- |
| `_work/e1-drive/track-textures.json` | manifest: pins, sampler, 7 sections, 136 textures, 394 draw records |
| `_work/e1-drive/track-uv.bin` | 192,988 float32 LE UV0 components |
| `_work/e1-drive/textures/track.albedo.<b>.<i>.rgba` | 136 RGBA8 mip0 bitmaps (439,360 B total) |
| `_work/e1-drive/geometry.json` | geometry v5 with the UV stream, textures and per-draw bindings |
| `_work/e1-drive/run.json` | 522 checks, per-car state/packet hashes, texture report |
| `_work/e1-drive/browser-evidence.json` | 20 captures, console log, texture/UV/upload fields |
| `_work/e1-drive/browser-evidence-texture.json` | close-up capture (texture proof) |
| `_work/e1-drive/browser-evidence-soak.json` | 1-minute two-run soak, live texture/buffer counts |
| `_work/logs/e1-drive/p49-verify-final3.log` | the 522/522 PASS transcript |
| `_work/logs/e1-drive/p49-capture-final2.log` | the 20-capture clean-console transcript |
| `_work/logs/e1-drive/p49-capture-texture-final.log` | the close-up capture transcript |
| `_work/logs/e1-drive/p49-soak-final.log` | the soak transcript |
| `_work/logs/e1-drive/p49-build-textures-final.log` | export summary |
| `_work/logs/e1-drive/p49-build-geometry-final3.log` | geometry v5 summary |

File hashes at this result:

| file | bytes | SHA-256 |
| --- | ---: | --- |
| `_work/e1-drive/geometry.json` | 18,791,525 | `91846bac308b71f552f96e8aadcb3aad6e654c0daca5042f7d4da4bce052eb81` |
| `_work/e1-drive/track-textures.json` | 309,345 | `81945fa6e2764103b94fa1c6dd3967b86e7670fb810beff568ecac235b7d6cca` |
| `_work/e1-drive/track-uv.bin` | 771,952 | `8133b9fc4dc490a86664c4f1f28384f3d2b8ccd48aa6d6ec2b5b2dcd7fb599b5` |
| `_work/e1-drive/run.json` | 583,844 | `1d5dab1a2e719801154decf8002dae5f7b0bd09f6d88c14467ce2d60a46e1da8` |
| `_work/e1-drive/browser-evidence.json` | 1,284,186 | `90c362433075b0b32e7042c4179e9497fb51af91462246232211f1e07b6717d1` |
| `_work/e1-drive/textures/` (136 files) | 439,360 | per-file SHA-256 in the manifest |
| `probes/e1-drive/tools/build_track_textures.py` | — | new export tool |
| `probes/e1-drive/tools/build_geometry.mjs` | — | geometry v5: UV + textures + bindings |
| `probes/e1-drive/tools/verify_e1_drive.mjs` | — | 522 checks, packet anchors re-pinned |
| `probes/e1-drive/web/packet-consumer.js` | — | UV vertex buffer, texture bind groups, sampling |
| `probes/e1-drive/web/packet-adapter.js` | — | passes `uv`, `textures`, `texturePack` |
| `probes/e1-drive/web/app.js`, `index.html` | — | HUD texture line, updated legend |
| `probes/e1-drive/tools/capture_browser.mjs` | — | texture/UV browser gates |
| `docs/work/analysis/e1-drive-slice.md` §21 | — | P49 analysis record |
