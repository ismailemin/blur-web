# T-007 prop textures — real static albedo + UV0 on the 18 BC1 level-instance draws

**Date:** 7 November 2026
**Owner:** P73b
**Scope:** `probes/e1-drive/**`, `_work/e1-drive/**`, `_work/logs/e1-drive/**`,
`probes/e1-drive/README.md`, `docs/work/analysis/e1-drive-slice.md` §29 and this
record. Read-only inputs: `_work/asset-reader/{level-instance-textures.json,
level-instance-uv.bin,level-instances-all.json}` (P73a), the committed
`engine-textures.json` registry / `texture_inspect.exe` BC reader, the committed
P52 car texture manifest, the P45/P47 track texture manifest, `upstream/`,
`game-data/` and every other probe. No asset-reader, engine, tool, other probe,
`upstream/` or `game-data/` file was modified.

## Result

The 22 River `block27/node253` level-instance props (trucks/wrecks, 13,162
vertices / 10,308 triangles) now draw **18 of their 22 draws with the real static
BC1 albedo and the real source UV0** (**10,212 triangles**, **14 visible** in the
driven view). The **4 BC3 cab draws** (96 triangles) stay explicitly
**diagnostic** as `bc3-alpha-rule-missing`: no alpha rule, pixel, texture or UV
is invented for them.

- `verify_e1_drive.mjs` **838/838 checks, 0 failures** (was 826; +12 level-prop
  and per-car packet checks).
- Full `verify_asset_probe.py` **31/31 PASS**; `check_e1_poc.py` **23/23 PASS**.
- Browser: **25 level-prop captures** (5 cars × 5 frames) with **0 console
  messages** and **0 assertion failures**; the existing drive (20 captures),
  free, sprint and lap passes remain **0 console / 0 assertions**.
- The 18 textured draws gain the sampled image; the before/after pixel delta at
  the tick-120 near-field truck is **37.13 %** of the frame (P72a's geometric
  proxy was 39.64 % coverage at the same tick).
- Physics is untouched: all five drive/sprint state sequence hashes and the
  finish times are unchanged; only the whole-packet hash moves because the
  packet now carries the UV stream and four images.

## Inputs and pins

| input | content | pin |
| --- | --- | --- |
| `_work/asset-reader/level-instance-textures.json` | P73a 22-draw UV0 + `g_tAlbedo` identity export | SHA-256 `1a33893026887f0e022eeec782791cbedf9153146d389b7c076f9d0b84f47fb4` |
| `_work/asset-reader/level-instance-uv.bin` | 26,324 float32 / 105,296 B UV0 pairs | SHA-256 `158a3ac81b4cf7a5b1b92d327d8dfcd97ab29100387eb72d3b84f1f333962c83`, aggregate `0xb07310e198de4c19` |
| `_work/asset-reader/level-instances-all.json` | reader mesh (13,162 vertices, 30,924 indices) and the 22 draw ranges | SHA-256 `fc0a99138bb946f8d91e14d47d66f862f7603760e853a4bc4db64cb975960b9b` |
| `_work/logs/engine-stream-spike/engine-textures.json` | committed P34 decode registry for the five sources | SHA-256 `e1243615ab3630c8141062926dea1c2594d48d52231ec185f31c051aa3048cd8` |
| `_work/logs/engine-stream-spike/textures/tex-<b>-<i>.raw` | descriptor+texel blob per source | blob FNV must equal the registry record |
| `_work/build/asset-reader-native/Release/texture_inspect.exe` | committed BC1/BC3 reader (`--raw`) | no pixel decode is re-implemented |

The four decoded BC1 sources are exported to
`_work/e1-drive/level-textures/level.albedo.<block>.<index>.rgba` and re-hashed
against the registry. The BC3 source (`1205:0 cab01alphas_diff`) is **not
decoded or uploaded** by this pass.

## Export rule (`build_level_instance_textures.py`)

1. Require the three P73a files and the P34 registry by SHA-256; require
   `kind/version`, 13,162 vertices, 10,308 triangles, 26,324 UV values,
   105,296 bytes and the `0xb07310e198de4c19` UV aggregate.
2. Recompute every per-draw P45-style UV0 FNV-1a 64 from
   `level-instance-uv.bin` + the reader indices and require it to equal the
   P73a `uvHash` (22/22; a mismatch names the draw).
3. For each of the 4 DXT1/BC1 sources, run the committed decoder on the blob,
   require the registry width/height/bytes and RGBA FNV-1a 64, write the RGBA
   file and record its SHA-256.
4. Emit 18 `bound-static-albedo-bc1` records with `textureId`, and 4
   `blocked-bc3-alpha` records with `textureId:null`, the real UV hash, the real
   `1205:0` identity and the exact reason `bc3-alpha-rule-missing`.
5. Write one deterministic manifest (`e1-drive.level-instance-textures` v1) with
   a canonical content hash. The file pin is used by `build_geometry.mjs` and the
   verifier; the content hash is exposed in the page probe.

Output manifest: `_work/e1-drive/level-instance-textures.json`, **32,343 B**,
file SHA-256 `80857371e8aeb3cf2f0d50cd956b8c117825abec39dc2b7e31bc6adbc3bcb788`,
content hash `sha256:d30dcae6ffa5d17b5e674ccadbb99a0b433f283dfc788ef63ed9e559f9df6499`.
A second build is byte-identical.

## The split and per-draw UV0

| split | draws | triangles | rule |
| --- | ---: | ---: | --- |
| `bound-static-albedo-bc1` | **18** | **10,212** | static `g_tAlbedo` is DXT1/BC1 and the real UV0 is exported |
| `blocked-bc3-alpha` | **4** | **96** | `cab01alphas_diff` is DXT5/BC3; `bc3-alpha-rule-missing` |

| instance | tri | UV0 hash | resource | texture | status |
| ---: | ---: | --- | --- | --- | --- |
| 0 | 726 | `0xefa29d38b989ce85` | `1073:0` | `car01_lic_diff` | bound |
| 1 | 269 | `0xe084faf3172bad17` | `1073:0` | `car01_lic_diff` | bound |
| 2 | 726 | `0xefa29d38b989ce85` | `1112:0` | `car02_lic_diff` | bound |
| 3 | 269 | `0xe084faf3172bad17` | `1112:0` | `car02_lic_diff` | bound |
| 4 | 726 | `0xefa29d38b989ce85` | `1112:0` | `car02_lic_diff` | bound |
| 5 | 269 | `0xe084faf3172bad17` | `1112:0` | `car02_lic_diff` | bound |
| 6 | 726 | `0xefa29d38b989ce85` | `1112:0` | `car02_lic_diff` | bound |
| 7 | 269 | `0xe084faf3172bad17` | `1112:0` | `car02_lic_diff` | bound |
| 8 | 726 | `0xefa29d38b989ce85` | `1118:0` | `car03_lic_diff` | bound |
| 9 | 269 | `0xe084faf3172bad17` | `1118:0` | `car03_lic_diff` | bound |
| 10 | 726 | `0xefa29d38b989ce85` | `1118:0` | `car03_lic_diff` | bound |
| 11 | 269 | `0xe084faf3172bad17` | `1118:0` | `car03_lic_diff` | bound |
| 12 | 68 | `0xd30ff3db7523d9ac` | `1074:0` | `bigtruck02_diff` | bound |
| 13 | 1,307 | `0x44e32b8cef9392d0` | `1074:0` | `bigtruck02_diff` | bound |
| 14 | 24 | `0xdd685574c32fa6ad` | `1205:0` | `cab01alphas_diff` | **diagnostic** |
| 15 | 24 | `0xc6d16d604e22504a` | `1205:0` | `cab01alphas_diff` | **diagnostic** |
| 16 | 746 | `0xfb603a02151d5258` | `1074:0` | `bigtruck02_diff` | bound |
| 17 | 68 | `0xd30ff3db7523d9ac` | `1074:0` | `bigtruck02_diff` | bound |
| 18 | 1,307 | `0x44e32b8cef9392d0` | `1074:0` | `bigtruck02_diff` | bound |
| 19 | 24 | `0xdd685574c32fa6ad` | `1205:0` | `cab01alphas_diff` | **diagnostic** |
| 20 | 24 | `0xc6d16d604e22504a` | `1205:0` | `cab01alphas_diff` | **diagnostic** |
| 21 | 746 | `0xfb603a02151d5258` | `1074:0` | `bigtruck02_diff` | bound |

The 22/22 hashes are exactly P73a. The UV stream is 26,324 float32 values /
105,296 B, aggregate `0xb07310e198de4c19`. The wreck draws use the full
`[0,1]²` island (spans ≈0.998); the truck draws leave it (`u` up to **3.41**,
`v` up to **1.994**), so the declared `repeat` address mode is required and is
the same explicit choice as the track pack.

## Textures

| id | name | size | format | draws | tri | RGBA SHA-256 | RGBA FNV-1a 64 |
| --- | --- | --- | --- | ---: | ---: | --- | --- |
| `level.albedo.1073.0` | `car01_lic_diff` | 32×16 | DXT1/BC1 | 2 | 995 | `b09bbc4538599acaf6f13761fe1bc90a674ba7190cc756fc78be22a81105ef49` | `9c50f12ab558e917` |
| `level.albedo.1112.0` | `car02_lic_diff` | 32×16 | DXT1/BC1 | 6 | 2,985 | `f8a074bd18f2a2e74b89e47f214f34e912f6095a6885eaba52f12cf05101450f` | `b37a10d8ace3c11d` |
| `level.albedo.1118.0` | `car03_lic_diff` | 32×16 | DXT1/BC1 | 4 | 1,990 | `a2d1ee061438aba5a6561cfe73c67cf27fefa83e7d6a54a42e757d8ef4b0f0e5` | `aa5f8e12e7a29982` |
| `level.albedo.1074.0` | `bigtruck02_diff` | 32×16 | DXT1/BC1 | 6 | 4,242 | `dae1ca2c2a885e3f44af5221beef7b3617bc54609c02055cf259fcd0aaa37a99` | `b9d41044917e09ae` |

**8,192 decoded RGBA bytes.** The SHA-256 values match P72a's
`level-props.json` evidence; the FNV values match the P34 registry. None of the
four is in the 136-texture track pack.

## Geometry / packet integration

- `build_geometry.mjs` pins the manifest, re-derives every per-draw UV hash from
  the level mesh indices, embeds the UV0 stream on the level mesh and the four
  RGBA images in `geometry.levelTextures`, and adds
  `geometry.levelPropTexturePack`.
- `packet-adapter.js` concatenates `geometry.levelTextures` into the packet
  texture set, keeps the 22 level draws at their committed index ranges and
  transforms, and adds `diagnostics.extras.levelProps`.
- `packet-consumer.js` is unchanged: it already supports a per-draw `textureId`,
  a mesh UV buffer and `texParams`. Textured draws use a white tint and sample
  the image; the 4 blocked draws keep the labelled neutral diagnostic colour.
- The geometry document stays **v6**: the level-prop pack is additive, which
  keeps every committed layout/ghost pin (they include `geometryVersion`) valid
  for the unchanged sprint geometry.

| quantity | before | after | delta |
| --- | ---: | ---: | ---: |
| level mesh vertices / triangles | 13,162 / 10,308 | 13,162 / 10,308 | 0 |
| level draws | 22 | 22 | 0 |
| level draws sampling a texture | 0 | **18** | +18 |
| level diagnostic draws | 22 | **4** | −18 |
| level UV values uploaded | 0 (zero-filled buffer) | **26,324** (105,296 B) | +105,296 B |
| packet textures (Corvette) | 145 | **149** | +4 |
| packet texture bytes (Corvette) | 4,977,728 | **4,985,920** | +8,192 B |

`geometry.json` is 45,374,377 B, SHA-256
`a64530094750503e53e7ddfc74d0a173377bb5bb9b9a77cca3f4da3681021aab`.
The four uploads add 8,192 B; the level UV buffer replaces a same-size
zero-filled buffer, so the mesh upload byte total is unchanged.

## Verification

### Commands

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

# 1. deterministic level-prop export (repeat builds are byte-identical)
& $py probes/e1-drive/tools/build_level_instance_textures.py

# 2. static geometry + packet data
node probes/e1-drive/tools/build_geometry.mjs
node probes/e1-drive/tools/build_sprint.mjs
node probes/e1-drive/tools/build_corridor_survey.mjs

# 3. verifier (twice: --write-ghosts regenerates the layout-hash-bearing ghost
#    records once, then a normal run compares them byte-for-byte)
node probes/e1-drive/tools/verify_e1_drive.mjs --write-ghosts
node probes/e1-drive/tools/verify_e1_drive.mjs

# 4. browser captures
node probes/e1-drive/tools/capture_browser.mjs --mode props          # 5 cars x 5 frames
node probes/e1-drive/tools/capture_browser.mjs                        # drive, 5 cars x 4 ticks
node probes/e1-drive/tools/capture_browser.mjs --mode free  --car corvette-zr1-stock
node probes/e1-drive/tools/capture_browser.mjs --mode sprint --car corvette-zr1-stock
node probes/e1-drive/tools/capture_browser.mjs --mode lap   --car corvette-zr1-stock

# 5. before/after pixel evidence
& $py probes/e1-drive/tools/compare_prop_captures.py

# 6. project gates
& $py tools/verify_asset_probe.py
& $py tools/check_e1_poc.py
```

### Results

- **`verify_e1_drive.mjs`: 838/838, 0 failures.** The 12 new checks cover the
  manifest file/content pins, the 13,162-vertex / 26,324-value UV stream, the
  18/4 split (10,212/96 triangles), the per-draw UV re-derivation, the four
  unique RGBA files and re-hashes, the texture/UV binding, the explicit sampler,
  and the per-car packet texture set (136 track + 4 level + that car's P52).
- **`verify_asset_probe.py` (full native + WASM rebuild): 31/31 PASS.**
- **`check_e1_poc.py`: 23/23 PASS.**
- **Native/WASM/Python reader output and CTest are unchanged** (no reader file
  was touched); the P73a export is a read-only input.
- **Determinism:** a second `build_level_instance_textures.py` run produces the
  same 32,343 B / same SHA-256; a second geometry build is identical.
- **Browser props mode:** 25 captures / 5 cars, console **0**, assertions **0**,
  every frame reports 22 draws (18 textured + 4 diagnostic), 4 images /
  8,192 B, 13,162 UV vertices, the pinned manifest and content hash, and the
  blocked instances `[14, 15, 19, 20]`.
- **Existing browser modes after the change:** drive 20/20 (console 0,
  assertions 0), free 4/4, sprint 4/4, lap 4/4 (console 0, assertions 0).
- **Physics:** the five drive/sprint state sequence hashes and finish times are
  unchanged; the per-car *packet* anchor was re-pinned because the packet body
  now contains the level UV stream and four images.

### Before / after screenshots

Both sets use the same URL, tick, camera and 1600×900 viewport. "Before" is
geometry v6 with the level props on the diagnostic neutral albedo; "after" is the
same geometry with the P73b pack. Every pair differs; the changed percentage is
the fraction of the 1,440,000 pixels with any channel difference.

| frame | before | after | changed |
| --- | --- | --- | ---: |
| drive tick 120 (near-field truck 1, camera `nearField:true`, `hitMesh:river.block27.instances-all`) | `_work/e1-drive/before-prop/browser-corvette-zr1-stock-drive-120.png` | `_work/e1-drive/browser-corvette-zr1-stock-prop-tick120.png` | **37.125 %** (534,602 px; bbox 95,115–1600,900) |
| free-roam prop approach | `_work/e1-drive/before-prop/browser-corvette-zr1-stock-free-prop.png` | `_work/e1-drive/browser-corvette-zr1-stock-prop-free.png` | **5.630 %** (81,065 px) |
| 310 m sprint start (truck cluster ahead) | `_work/e1-drive/before-prop/browser-corvette-zr1-stock-sprint-start.png` | `_work/e1-drive/browser-corvette-zr1-stock-prop-sprint-start.png` | **5.351 %** (77,048 px) |
| loop-01 lap start (regression frame, trucks not in view) | `_work/e1-drive/before-prop/browser-corvette-zr1-stock-sprint-lap-start.png` | `_work/e1-drive/browser-corvette-zr1-stock-prop-lap-start.png` | **0.096 %** (1,382 px; HUD best-time line) |

The screenshot file SHA-256 values and the full diff report are in
`_work/e1-drive/browser-evidence-prop-textures.json`. The lap-start delta is a
HUD best-time line, not a truck; loop-01 is ~180 m from the truck cluster.

## Limits

1. **Static albedo only.** `g_tMaterial`, material colour, blend state, shader
   stages, sampler wrap/filter, anisotropy, mips and sRGB remain **unapplied**,
   exactly as on the track/car paths. The sampler is the explicit
   repeat/linear/mip0 `rgba8unorm` choice, not recovered engine state.
2. **4 BC3 cab draws stay blocked.** `cab01alphas_diff` is DXT5/BC3 with a real
   non-trivial alpha channel and no declared alpha-test/blend rule. The draws
   keep their real UV0, source identity and labelled neutral diagnostic colour;
   no alpha value, texture or UV is invented.
3. **Low source resolution.** 32×16 BC1 at mip0; no upscale, mip chain or
   invented detail.
4. **Source UV orientation is raw.** The level pack samples the stream as
   exported (no U/V flip), the same convention as the track pack. The car pack's
   documented `(1−u, v)` convention does not apply here.
5. **No vertex-normal stream.** The committed render-packet/consumer path carries
   positions + UV0 only and lights with screen-space derivative normals. P73b
   carries the real world-space positions and UV0; it does not invent a vertex
   normal array. Adding one would be a new renderer/shader semantic, outside this
   task.
6. **Start-area gain, not whole-course.** The 18 draws are 14 visible in the
   driven view (4 are behind the spawn). P72a's proxy covers 5.18 % of the frame
   at tick 0, peaks at 39.64 % at tick 120 and is 0 after tick 170; the measured
   37.13 % frame delta at tick 120 is the visual confirmation of that peak, not a
   claim about every frame.
7. **No full-game claim.** One level, one node, one drive. No other level
   instance node, visibility/PVS, streaming, higher LOD, shadow, post-process or
   retail material fidelity is claimed.

## Evidence paths

| path | content |
| --- | --- |
| `probes/e1-drive/tools/build_level_instance_textures.py` | deterministic P73a → BC1 pack export |
| `probes/e1-drive/tools/compare_prop_captures.py` | before/after pixel report |
| `_work/e1-drive/level-instance-textures.json` | 22-draw manifest, 4 textures, content hash |
| `_work/e1-drive/level-textures/*.rgba` | four decoded BC1 images, 8,192 B |
| `_work/e1-drive/geometry.json` | geometry v6 + level UV stream + level textures |
| `_work/e1-drive/packet-<slug>.json` | per-car packet with the level pack |
| `_work/e1-drive/browser-evidence-props.json` | 25-capture props pass |
| `_work/e1-drive/browser-evidence-prop-textures.json` | before/after diff report |
| `_work/e1-drive/before-prop/*.png` | the four before frames |
| `_work/e1-drive/browser-<slug>-prop-*.png` | the after frames |
| `_work/logs/e1-drive/verify-p73b.log` | 838/838 verifier log |
| `_work/logs/e1-drive/verify-asset-probe-p73b-full.log` | 31/31 suite log |
| `_work/logs/e1-drive/edge-props-run.log` | props capture log |

**No full-game claim, no invented texture, no alpha guess, no UV guess.**
