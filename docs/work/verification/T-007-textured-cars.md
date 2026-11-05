# T-007 textured cars — real per-car albedo on each car's own UV0

> **Superseded in part by P59** (`T-007-car-uv-orientation.md`): the car sampling
> convention is `(1-u, v)`, not `(u, 1-v)`; the U flip makes plates/decals read
> correctly. Counts, textures and physics hashes are unchanged.

**Date:** 6 November 2026
**Owner:** P55
**Scope:** `probes/e1-drive/**`, `_work/e1-drive/**`, `_work/logs/e1-drive/**`,
`docs/work/analysis/e1-drive-slice.md` §23 and this record. No change to
`probes/car-materials/`, `probes/car-parts/`, `probes/drivable-path/`, the engine,
`probes/render-packet/`, `tools/`, `upstream/` or `game-data/`.
Physics, sprint (310 m + short), camera, telemetry, restart and soak behaviour are
untouched; this pass adds texture data and one sampling path to the car bodies.

## Result

The five E1 roster cars now sample the **P52 static albedo image** on **their own
UV0 stream** for **224 of their 491 draws**. The other **267** draws stay on the
labelled diagnostic albedo with the committed P52 reason: **45** `_NO_ALBEDO`
paint lookups, **66** light off/on blends and **156** other `_NO_ALBEDO` shaders.
No UV, colour, pixel, wrap state or mip is invented.

- `verify_e1_drive.mjs` is **570/570 checks, 0 failures** (was 550/550; 20 new
  car-texture/UV checks).
- All five drive **state sequence hashes are unchanged**; the skeleton, sprint,
  telemetry, restart and reset checks are unchanged.
- 20 headless Edge/WebGPU captures (5 cars × 4 ticks) report **0 console
  messages** of any kind and pass every browser gate.
- A 1-minute two-run soak keeps **145 live textures** — exactly one packet — and
  **0 console messages**; no texture leak.
- The bodies show their own plates, decals, badges, tyre/brake textures and
  interior weave; see §Browser evidence.

## Inputs (all read-only, pinned)

| input | content | pin |
| --- | --- | --- |
| `_work/car-materials/roster/index.json` | P52 per-car record index (491 draws / 224 static / 40 textures) | `sha256:77e73bff…74cd76` |
| `_work/car-materials/roster/cars/<slug>/materials.json` | draw → material row → texture id/name/hash | `manifestSha256` from the index (5/5 equal) |
| `_work/car-materials/roster/cars/<slug>/textures/*.rgba` | committed mip0 RGBA of every referenced image | `decoded.rgba.sha256` per texture, re-hashed |
| `_work/car-parts/cars/index.json` | model / part-manifest / mesh map | `sha256:5042e714…9bc315` |
| `_work/car-parts/cars/<slug>/manifest.json` | draw ownership, ranges, part ids | `manifestSha256` from the car index |
| `_work/car-parts/cars/<slug>/mesh.json` | positions + indices the body is drawn from | `meshSha256`, positions/indices value hashes |
| `_work/car-parts/cars/<slug>/scene-report.json` | committed `scene_inspect.exe` output: **uv0 array + per-draw `uv0Available`** | pinned per car (see the exporter constants) |

The P52 `.rgba` files are referenced, not copied: the exporter re-hashes each one
against its recorded SHA-256 and the geometry re-hashes it again before it embeds
the bytes.

## Export rule (`build_car_textures.py`)

For each car, in the e1-drive roster order:

1. load the P52 materials manifest with a **signed-zero-preserving** JSON parser
   (the reader prints `-0`) and require its hash to equal the index record;
2. load the part manifest, the mesh and the committed scene report; require
   `scene.positions == mesh.positions` **numerically**, `len(uv0) == 2 ×
   vertexCount`, every component finite, and every draw's `firstIndex/indexCount`
   and `uv0Available` flag to agree between the three files;
3. require every draw's `index`, `partId` and `renderPartId` to agree between the
   P52 manifest and the part manifest, so the draw order is proven, not assumed;
4. for each draw compute the FNV-1a 64 over the referenced float32 UV pairs (the
   same step `build_track_textures.py` uses) and store it with the draw's UV
   range;
5. resolve a `staticAlbedo` draw's single texture, require it to be listed for
   that draw in P52, require `uv0Available`, and emit `(u, 1-v)` because of the
   evidence in §Sampling convention;
6. re-hash every referenced `.rgba`, require `width × height × 4 == rgbaBytes`
   and the declared size, then write `car-uv-<slug>.bin` and the manifest.

A draw whose P52 status is runtime-only keeps `textureId:null`, the committed
`runtimeReason` and its class label. The build aborts on any mismatch, so a
regenerated or hand-edited input cannot slip in silently.

## Coverage

| car | draws | textured | paint | light | no-albedo | textures | RGBA bytes | UV values |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Corvette ZR1 | 100 | 50 | 10 | 17 | 23 | 9 | 4,538,368 | 66,096 |
| Lotus Exige Cup260 | 88 | 48 | 0 | 14 | 26 | 9 | 4,997,120 | 64,272 |
| Dodge Challenger | 104 | 42 | 11 | 13 | 38 | 7 | 2,637,824 | 56,730 |
| Ford Focus RS | 115 | 37 | 15 | 13 | 50 | 7 | 3,424,256 | 64,534 |
| Audi R8 V10 | 84 | 47 | 9 | 9 | 19 | 8 | 2,580,480 | 62,858 |
| **total** | **491** | **224** | **45** | **66** | **156** | **40** | **18,178,048** | **314,490** |

These are exactly the P52 counts (`docs/work/analysis/car-materials.md` §2); the
build fails if any total differs. `textured + paint + light + no-albedo = draws`
for every car.

Per-car texture sets are distinct (ids are `car.<slug>.<block|shared>-<i>`); the
shared tyre/disc images decode to the same pixels on every car that references
them, which the probe records per occurrence instead of assuming.

## Sampling convention (explicit, not recovered engine state)

| state | value | reason |
| --- | --- | --- |
| UV0 | committed `scene_inspect.exe` stream, **unmodified** (signed zeros kept) | the stream is the original vertex data |
| sample direction for car draws | `(u, 1 − v)` | the decoded images are stored V-down and the UV0 stream addresses them V-up; see the evidence below |
| address mode U/V | `repeat` | same declared choice as the track pack |
| mag/min filter | `linear` | one choice, applied to the uploaded mip0 |
| mip levels uploaded | **1 (mip0 only)** | the declared chain is recorded, not generated |
| format | `rgba8unorm` | the committed P52 decode, no channel transform |
| sRGB | **not applied** | no colour-space conversion is claimed |
| material colour / blend / shader stages | **not applied** | only the albedo pixels are bound; textured draws are tinted white |

A draw without a texture samples a 1×1 white placeholder and mixes back to its
diagnostic colour (`texParams.x = 0`), so `textureSample` has no non-uniform
control flow. `texParams.y` is the per-draw V flag.

### Why `v' = 1 − v`

The raw stream renders the artwork vertically mirrored. The committed plate and
decal pixels make this visible and testable:

| draw | texture | raw `v` | sampled `1 − v` |
| --- | --- | --- | --- |
| ZR1 rear plate | `nyc_10` (shared 6) | `NEW YORK` at the plate bottom, number mirrored | `NEW YORK` at the top, `DQF 9760` upright |
| Audi rear plate | `spain10` (shared 7) | glyphs vertically mirrored | `E` strip and glyph vertical order correct |
| ZR1 rear emblem | `corvette_zr1_decals` (block 8) | emblem vertically mirrored | emblem upright |

Glyph **order** is preserved in both cases and only the vertical axis changes, so
this is a V inversion, not a per-draw transform and not a 180° rotation. Both
texture storage kinds (shared and resource block) show it, so it is one
convention. The track and level packs keep the raw stream in this pass — the
accepted P49 track evidence is not silently changed — and **the same inversion is
likely present there**; road textures carry no readable text, so P49 could not
see it. Re-opening that pack needs its own evidence pass and is an open item.

Per-material texture matrices are not recovered: the Audi rear plate's `E` strip
stays on the mirrored side even with the correct V direction, i.e. that quad's U
axis is mirrored in the model and the engine's compensating transform is unknown.
That is recorded, not patched.

## Measured result

| check | result |
| --- | --- |
| committed P52 record reproduced | 5/5 cars, every draw/material/texture count equal |
| static albedo draws | **224** (50 / 48 / 42 / 37 / 47) |
| runtime-only draws | **267** = 45 paint + 66 light + 156 no-albedo |
| textures | **40** (9 / 9 / 7 / 7 / 8 per car), all re-hashed |
| RGBA payloads | **18,178,048 B**, every embedded payload equal to its P52 file |
| UV0 | **314,490 values / 1,257,960 B**, byte-equal to the exported `car-uv-*.bin` |
| per-draw UV0 hash | **224/224** recomputed from the mesh stream and equal to the export |
| packet texture set | 136 track + 7–9 car = **143–145** per page |
| geometry | **v6**, 45,180,725 B |

## Determinism

- `build_car_textures.py` was run twice (and again at the final gate): the
  manifest, the five UV binaries and its SHA-256 are byte-identical
  (`sha256:0342a3c6…719d2b`, 596,530 B).
- `build_geometry.mjs` was run twice on the same inputs: `geometry.json` is
  byte-identical (`sha256:c6fdd249…74d13d`, 45,180,725 B).
- Every draw's UV0 hash is recomputed from the embedded stream by the geometry
  builder and again by the verifier; the texture binding can only belong to the
  draw whose UVs produced it.
- No `Math.random`, no wall clock and no unordered map iteration is on the output
  path.

## Verification gate

```powershell
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"

& $py   probes/e1-drive/tools/build_car_textures.py     # 40 textures / 224 draws
& $node probes/e1-drive/tools/build_geometry.mjs        # geometry v6
& $node probes/e1-drive/tools/build_course.mjs
& $node probes/e1-drive/tools/build_corridor_survey.mjs
& $node probes/e1-drive/tools/build_sprint.mjs
& $node probes/e1-drive/tools/verify_e1_drive.mjs       # 570 checks
& $node probes/e1-drive/tools/capture_browser.mjs       # 20 captures, console gate
& $node probes/e1-drive/tools/soak_browser.mjs --minutes 1 --runs 2
```

| gate | result |
| --- | --- |
| `build_car_textures.py` | 5 cars / 491 draws / 224 textured / 40 textures / 18,178,048 B, exit 0 |
| `build_geometry.mjs` | geometry v6, 45,180,725 B, `sha256:c6fdd249…`, exit 0 |
| `verify_e1_drive.mjs` | **PASS, 570/570**, 0 failures → `_work/e1-drive/run.json` |
| `capture_browser.mjs` | **clean-console-and-gates**, 20 captures, 0 console messages |
| `soak_browser.mjs` | page report **PASS** in both runs, 0 console messages, 145 live textures; the tool's node-anchor comparisons fail for a pre-existing reason (§Soak) |
| `verify_asset_probe.py --skip-build` | **30/30 PASS** |
| `tools/check_e1_poc.py` | **19 PASS, 0 FAIL** — geometry v6, car texture manifest, car UV streams and car RGBA bitmaps all match their pins |

### What moved and what did not

- **Unchanged:** the five drive state sequence hashes (`83f76590…`, `8d6cd4d4…`,
  `b1c63d20…`, `fb3909b6…`, `5b4ae49d…`), the five sprint (310 m and short)
  state hashes and times, telemetry metrics, restart/reset checks and every
  camera result.
- **Changed:** the whole-packet hash, because the packet now carries the car UV
  stream and that car's textures. The five `PHYSICS_ANCHORS.packet` constants are
  re-pinned to the P55 values (`746853ba…`, `8b9ef8d0…`, `3b21364b…`, `b92c1053…`,
  `fb23b0cc…`) with a comment that only the packet body changed.
- `geometry.json` grew from 18,791,525 B (v5) to **45,180,725 B** (v6):
  +1,257,960 B of UV as base64 and +24,237,520 B of car RGBA as base64 plus
  metadata. The five packet files are now 18.1–21.4 MB each.

## Browser evidence

Headless Edge/WebGPU, 1600×900, adapter `nvidia / blackwell`, 20 captures
(5 cars × ticks 0/150/240/300):

| car | geometry upload bytes | UV upload bytes | textures | texture bytes | textured car draws | draws |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Corvette ZR1 | 4,083,912 | 1,141,632 | 145 | 4,977,728 | 50 | 516 |
| Lotus Exige Cup260 | 4,066,848 | 1,134,336 | 145 | 5,436,480 | 48 | 504 |
| Dodge Challenger | 3,954,096 | 1,104,168 | 143 | 3,077,184 | 42 | 520 |
| Ford Focus RS | 4,020,436 | 1,135,384 | 143 | 3,863,616 | 37 | 531 |
| Audi R8 V10 | 3,999,824 | 1,128,680 | 144 | 3,019,840 | 47 | 500 |

- 3 geometry uploads per page (level + own body + track), constant across frames;
  the car mesh now uploads a **real** UV buffer instead of zeros.
- 136 track + 7–9 car textures per page, destroyed with the packet.
- `drawsIssued = frames × draws` in every capture; 0 console messages.
- Browser state hash equals Node's for every capture; the car matrix is
  bit-identical; 17/20 packet hashes are byte-exact (the three differences are
  the documented Node 24 / Edge 156 `Math.atan2` last-bit case).

Screenshots:

| file | what it shows |
| --- | --- |
| `_work/e1-drive/browser-corvette-zr1-stock-mid.png` / `-car.png` | ZR1 rear: upright `DQF 9760` NY plate, crossed-flags emblem, interior weave through the glass, tyre texture, HUD `car tex 50 textured (9 tex, 4538368 B) · diag 50 (paint 10, light 17, no-albedo 23) · uv 33048` |
| `_work/e1-drive/browser-lotus-exige-cup260-stock-mid-car.png` | Lotus rear: upright `YOU 3517` plate, decals, brake/caliper artwork and black body |
| `_work/e1-drive/browser-dodge-challenger-stock-mid-car.png` | Dodge: body, glass and rear deck with its own 7-texture set |
| `_work/e1-drive/browser-ford-focusrs-stock-mid-car.png` | Focus: body and rear window; the four glass draws bind `focusrs-alpha` and render opaque (no blend state) |
| `_work/e1-drive/browser-audi-r8v10-stock-mid-car.png` | Audi: rings badge, plate, tail-light strip and carbon inserts |
| `_work/e1-drive/browser-<slug>-{start,coast,end}.png` | the same car at the other three scripted ticks |

![Audi R8 V10, mid drive](../../../_work/e1-drive/browser-audi-r8v10-stock-mid-car.png)

*`_work/e1-drive/browser-audi-r8v10-stock-mid-car.png`: the R8's own body with
its own P52 albedo textures (rings, plate, light strip, carbon inserts) sampled
on its own UV0 stream. The base paint draw uses its diagnostic colour because its
P52 status is a runtime paint lookup.*

Before/after for the same car and tick (`_work/e1-drive/browser-corvette-zr1-stock-mid.png`):

| build | plate | tyres / interior |
| --- | --- | --- |
| P54 (diagnostic colours) | flat coloured plate rectangle | flat coloured tyre bands |
| P55 (textured) | `DQF 9760` + `NEW YORK`, upright | tread/wall texture, weave visible through the glass |

The full-size screenshots are the evidence; the numbers above are the browser's
own upload counters.

## Soak

`soak_browser.mjs --minutes 1 --runs 2` (4,320 ticks per run, ticks-per-frame 4):

| measure | run 1 | run 2 |
| --- | ---: | ---: |
| page soak report | **PASS** | **PASS** |
| console messages | 0 | 0 |
| packet loads | 4 | 4 |
| textures created / destroyed / live | 580 / 435 / **145** | 580 / 435 / **145** |
| textures per packet | 145 | 145 |
| live texture samples (all checkpoints) | `[145]` | `[145]` |
| buffers live | 11 | 11 |

580 = 4 loads × 145, 435 = 580 − 145, so every reload releases exactly the
previous packet's textures: **no texture leak**. The page's new check
`GPU textures stayed bounded across every reload (no texture leak)` is one of its
eight PASS checks.

**Known pre-existing soak-gate failure (not texture related).** The tool's two
node-anchor comparisons fail:

- `every complete drive segment reproduces the node drive state sequence`
  (`7089f001…` vs the node `83f76590…`);
- `every telemetry segment matches the node metrics and trace hashes`.

Cause, proven by reproduction: the page boots the soak world on the **310 m
course start tangent** (`layoutStartHeading` = 0.767411 rad, `web/app.js`
`loadEngine`, since the P50 310 m default) and then resets to that same pose for
every segment, while the node anchors are the *drive-spawn* heading (π/2) runs.
`_work/logs/e1-drive/p55-soak-baseline.mjs` runs the committed drive script from
both headings: the π/2 run reproduces the node anchor `83f76590…`, the 0.767411
run reproduces the soak's `7089f001…` exactly (`matchesObserved: true`). The
sprint segment matches its node anchor because it starts on the same tangent.
This is a soak-baseline mismatch introduced by the 310 m default, independent of
textures; changing the soak's start pose is out of this task's "soak unchanged"
scope, so it is recorded rather than patched here.

## Limits

- **267 of 491 car draws stay diagnostic.** The runtime paint lookup (45), the
  light off/on blend (66) and the other `_NO_ALBEDO` shaders (156) have no static
  image in the source; they keep their diagnostic colour and the committed P52
  reason.
- **No mip chain, no sRGB, no anisotropy, no material colour, no blend, no
  original shader.** Sampling is `rgba8unorm` mip0, repeat/linear.
- **Wrap/filter are a declared PoC choice**, not recovered engine state.
- **Per-material UV transforms are not recovered.** The `(u, 1−v)` direction is
  one declared convention with pixel evidence; a mirrored plate quad still looks
  mirrored in U (Audi rear plate).
- **The same V inversion is likely present in the P49 track pack.** It is left
  unchanged here so the accepted track evidence is not modified silently; it is
  an open item for a dedicated pass.
- **Focus glass binds an alpha image and renders it opaque** because no blend
  state is applied; the four draws are labelled as alpha textures in P52.
- **No full-game claim.** One car, one loaded block, one camera, no race rules,
  audio, opponents, culling or streaming.

## Evidence

| path | content |
| --- | --- |
| `probes/e1-drive/tools/build_car_textures.py` | the export (new) |
| `probes/e1-drive/tools/build_geometry.mjs` | geometry v6: car UV + textures + bindings |
| `probes/e1-drive/tools/verify_e1_drive.mjs` | 570 checks, packet anchors re-pinned |
| `probes/e1-drive/web/packet-adapter.js` | bounded per-car texture set + UV validation |
| `probes/e1-drive/web/packet-consumer.js` | UV vertex buffer, per-draw `(u, 1−v)` |
| `probes/e1-drive/web/app.js` | car texture HUD/probe fields, soak texture-bound check |
| `probes/e1-drive/tools/capture_browser.mjs` | car texture/UV browser gates |
| `_work/e1-drive/car-textures.json` | 5 cars, 491 draw records, 40 textures, UV convention |
| `_work/e1-drive/car-uv-<slug>.bin` | the five committed UV0 streams (1,257,960 B) |
| `_work/e1-drive/geometry.json` | geometry v6 with the car UV streams and textures |
| `_work/e1-drive/run.json` | 570 checks, per-car body/texture/UV records |
| `_work/e1-drive/browser-evidence.json` | 20 captures, console log, texture/UV uploads |
| `_work/e1-drive/browser-evidence-soak.json` | 1-minute two-run soak, live texture counts |
| `_work/logs/e1-drive/p55-build-car-textures.log` | export summary |
| `_work/logs/e1-drive/p55-build-geometry.log` | geometry v6 summary |
| `_work/logs/e1-drive/p55-verify-final.log` | the 570/570 PASS transcript |
| `_work/logs/e1-drive/p55-capture-final.log` | the 20-capture clean-console transcript |
| `_work/logs/e1-drive/p55-soak.log` | the soak transcript |
| `_work/logs/e1-drive/p55-soak-baseline.mjs` | the heading reproduction for §Soak |
| `_work/logs/e1-drive/p55-check-e1-poc.log` | the 19-check PoC readiness gate |
| `_work/logs/e1-drive/p55-asset-probe-skip-build.log` | the 30-check asset suite |

File hashes at this result:

| file | bytes | SHA-256 |
| --- | ---: | --- |
| `_work/e1-drive/geometry.json` | 45,180,725 | `c6fdd2499ffa22284724831fac3883610536abc42d6d93f497ca50a37a74d13d` |
| `_work/e1-drive/car-textures.json` | 596,530 | `0342a3c6411f292de993e823fff2b400445037618c623961056590bd7f719d2b` |
| `_work/e1-drive/run.json` | 855,972 | `5a0180711dc0802f98d93a20dcecaba6830971c0c40e2507f65e7c9f9724d134` (contains per-run timings, so its hash moves between identical runs) |
| `_work/e1-drive/browser-evidence.json` | 1,293,066 | `bfe315d6768f211e400d853436531455cd4c2d79421a664f1f92d3fa92e3476d` |
| `_work/e1-drive/browser-evidence-soak.json` | 14,419 | `cfb457b6291e98e783552d0835e394e69403182a5c00d2bb11bb57c8038d2aa6` |
| `_work/e1-drive/car-uv-<slug>.bin` (5 files) | 1,257,960 | per-file SHA-256 in the manifest |
