# `spa_barcelona_gracia` map slice, texture binding and render-ready package

**Date:** 7 November 2026
**Owner:** MAP5 (sub-agent)
**Scope:** `probes/map-slice/**` (generalized tools), `_work/map-slice/gracia*/`,
`_work/logs/map-slice/**` and this document. No change to `probes/e1-drive`,
`probes/asset-reader`, `probes/map-pipeline`, `tools/`, `upstream/` or
`game-data/`. The slice, binding and render tools were generalized to take a
level name and package directory; the committed Amboy package bytes are
unchanged and were re-checked.

**No renderer, GPU, browser, e1-drive integration, playable-game or full-game
claim is made.** This is a deterministic data package plus its upload contract.

---

## 0. Result

| item | measured value |
|---|---|
| collision triangles | **113,270** (67,552 surface, 42,358 steep, 3,349 other, 11 degenerate) |
| collision unique vertices | 66,775 (339,810 triangle-soup indices) |
| first-RenderList direct sections | **88 supported / 92 probed**; 4 unsupported |
| draw geometry | 738,905 vertices, 550,632 triangles, 3,580 draws |
| UV0 | 3,580/3,580 draws; 0 missing; 0 placeholder vertices |
| static albedo identity resolved (fixed reader) | **3,058/3,580** (3,044 resource-block + 14 shared), 522 identity-blocked |
| **bindable static albedo + original UV0** | **2,627 draws / 365,451 triangles** |
| blocked | **953 draws / 185,181 triangles** |
| distinct texture sources | 846 (739 bindable) |
| decoded RGBA mip0 | 841 sources; 5 sources exceed the 512 px decoder bound |
| bindable texture bytes | 3,253,504 B referenced; 3,247,360 B unique upload (5 duplicate pairs merged) |
| measured draw-covered path | **624.91378 m** point-to-point (declared 624.914) |
| path coverage of collision diameter | 99.60 % (624.914 / 627.399) |
| checkpoints | 208.343397 m and 416.652055 m |
| spawn | (336, −23), ground 129.998887 m, heading 2.15879893 rad |
| spawn band | 25/25 hits, all up-facing, 1 m × 5 m, height spread 0.00078 m |
| physics settle | 60 ticks, zero input, 4/4 wheel contacts on 61/61 states, finite |
| physics state sequence | `sha256:4fd8ae0c…6e8e30` (two independent modules identical) |
| package bytes, slice + physics | 26,241,366 (26,243,435 incl. `verify.json`) |
| package bytes, render | 28,799,891 (28,801,009 incl. `verify.json`) |
| verifier | slice **26,797** checks; bindings **32,782**; render **45,590**; all PASS |
| deterministic render builds | **2/2 byte-identical**, aggregate `4a863063…e22f` |

The package is a **playable-slice input**, not a playable slice: no renderer, no
e1-drive integration, no UI, no retail start-line record, no lap.

---

## 1. Sources and extraction

| input | bytes | SHA-256 |
|---|---:|---|
| `game-data/Blur/levels/spa_barcelona_gracia/Level.levelphysics` | 5,569,121 | `acfb58a20ff7adced0b2424dc39474509e6b4c4c805729fd9463bdd310a173c0` |
| `game-data/Blur/levels/spa_barcelona_gracia/level.levelrender` | 9,095,776 | `4eb86ff62ecdb4bf0804e19da4641a1b9d3e8e45b46bc76e5fe1204370d95176` |
| `game-data/Blur/levels/spa_barcelona_gracia/Level.levelstream` | 489,828,352 | `384697f6d8ff889a726c5d8ba2c8a84a6e209835ed34ecac3dc5980b9a7fa341` |
| `_work/map-pipeline/candidates/spa_barcelona_gracia.layout.json` | 172,762 | `8190f0913f2c0213ca9d071b29b99212deab516f9bd7f2870b3d0779cc0e7572` |
| `_work/map-pipeline/covered/spa_barcelona_gracia-path.json` | 18,234 | `b802730389a9ece2d92e45e55d7c9bb01b8bfc76a5ef441a69e82d7e9f2b7848` |
| `_work/map-pipeline/covered/spa_barcelona_gracia.json` | 5,744 | `1158c0ace544ff923adb3a5eab9e8a1edcd4fcd243c058de4b6c9e7e6fa310c4` |
| `_work/map-pipeline/grids/spa_barcelona_gracia.npz` | 919,038 | `f1380ee0a388de2d11092c69426363e04f5928d5ae9ddb925fccd4bb2bb37671` |
| `_work/map-pipeline/draw-probes-all.json` | 1,267,866 | `00c86204c0485ca269da5e120bce8ed10232cb7f8fac172e11a339a0f4b61c55` |
| native reader `level_inspect.exe` | 249,856 | `a633a030f530b9939991b4fc5c67aebe60d00cd22d59a6fffb3f74b0fbf6965b` |
| decoder `texture_inspect.exe` | 57,856 | `745e80981b180bf9e9c3d7bf92597636cb919a28ce013ebf531495aec15e2427` |
| E1 module `e1_drive.mjs` | 11,480 | `5177ea975151fb085a44b8b960e384913d36a7e225078a1783f90e1f0b1bff2a` |
| E1 wasm `e1_drive.wasm` | — | `bcdc2d994a499cc399333b44cfc418d6594f8b5182a668c3a9df761d891de265` |
| E1 build `build.json` | 3,466 | `8493193cb8aacc5a9d108874318c612298b46edb5fe28b12c8558b7f0d5c7577` |
| `_work/e1-drive/car.fields` | 7,489 | `1c24bbd7f055f904062d1f1b7b377be727a7cf9f64e8ca2c72dff5b138a55381` |

Collision uses the committed map-pipeline `physics_scan.py` (stream version 10,
file version 0). The reader replay re-ran the current `level_inspect.exe` on all
88 supported staged chunks and aborted unless positions, UV0 bits, indices and
draw ranges matched the committed probe doc. Evidence:
`_work/logs/map-slice/reader-refresh/spa_barcelona_gracia/` (88 JSON files).

---

## 2. Collision

| shape | type | shipped as triangles | reason |
|---:|---:|---|---|
| 0, 1 | 2 Box | no | simple collision shapes |
| 2, 3 | 0 TriangleMesh | yes | 84,392 + 28,862 triangles |
| 4, 25 | 11 TriangleMeshBase | yes | 8 + 8 triangles |
| 5–24, 26–41 | 10 InstancedTriangleMesh | no | 38 instance shapes not decoded |

After exact-position deduplication: **113,270 triangles**, 66,775 unique
vertices, 339,810 soup indices. Geometric normal classification: 67,552 surface
(`normal.y > 0.94`), 42,358 steep (`|normal.y| < 0.5`), 3,349 other, 11
degenerate. Bounds `[-649.784, -0.078, -521.632] … [925.636, 311.586,
621.052]`. Route count 6, routes not parsed.

---

## 3. Draws, textures and UV0

### 3.1 Supported geometry

88 of 92 first-RenderList direct sections are readable: **738,905 vertices,
550,632 triangles, 3,580 draws**. Every draw has original UV0 (3,580/3,580), 0
UV0-blocked, 0 placeholder vertices. The merged buffers are 8,866,860 B
positions, 5,911,240 B UV0, 6,607,584 B indices.

### 3.2 Static albedo identity (fixed reader)

The fixed reader resolves a static albedo identity for **3,058/3,580** draws
(3,044 resource-block + 14 shared) and reports 522 identity-blocked. It prints
3,580/3,580 UV0 hashes. Identity is not a binding: format, alpha, blend, shader
stage, sampler and pixels are not applied.

### 3.3 Bindable split after decoder/alpha join

| status | draws | triangles | reason |
|---|---:|---:|---|
| `bindable-static-albedo` | **2,627** | **365,451** | static `g_tAlbedo`, decoded image, opaque alpha, UV0 |
| `blocked-effect-not-static-albedo` | 518 | 113,461 | `Racification*` additive layer exposes `g_tTexture`, not `g_tAlbedo` |
| `blocked-decoder-size-limit` | 5 | 4,765 | source is 1,024–2,048 px; committed decoder bound is ≤512 |
| `blocked-alpha-rule-missing` | 426 | 66,945 | BC3 source with non-opaque alpha; no alpha-test/blend rule |
| `blocked-runtime-albedo-parameter` | 4 | 10 | `Advert_LN_NV` serialises `g_tAlbedo` as runtime `DATA_INDEX` |
| **total** | **3,580** | **550,632** | |

No UV0 blocker exists. 30 of 88 sections contain no bindable draw (mostly
vegetation/imposter alpha atlases and effect-line corridors); the other 58
sections carry bindable draws.

### 3.4 Texture sources

| bucket | sources | RGBA bytes |
|---|---:|---:|
| bindable resource-block `gracia.albedo.<block>.<index>` | 735 | 1,418,496 |
| bindable shared `gracia.shared.<index>` | 4 | 1,835,008 |
| **bindable total** | **739** | **3,253,504** |
| decoded but non-bindable (BC3 alpha) | 102 | 358,400 |
| decoded, size-blocked (no RGBA) | 5 | 0 |
| **all sources** | **846** | 3,611,904 decoded |

The five decoder-size sources are `vista_d_pt_diff` (1024×512 BC3),
`vista_b2_pt_diff` (2048×512 BC3), `vista_a2_pt_diff` (2048×512 BC3),
`vista_c_pt_diff` (1024×512 BC3) and shared `garage_pump_new_diff` (1024×1024
BC1). The 102 alpha-blocked sources are mostly road-marking/railing/decoration
BC3 atlases (`rg_dashwhiteline_diff`, `rg_yellowline_01_diff`,
`rg_patchjoin_diff`, `crowdatlas_imposters_0_0`, …). No image was resized,
upcoloured or invented.

The most-shared bindable sources by draw count are `kerb01_diff`
(`2045:0`, 188 draws / 27,231 tri), `pavement01_diff` (`2041:0`, 126 / 13,571),
`rg_concretewall_01_diff` (`2034:0`, 68 / 7,944) and `rg_tarmac_01_diff`
(`1951:0`, 43 / 5,074). 15 distinct dimensions occur (4×4 … 512×512).

Five RGBA payloads are byte-identical across two sources, so the render package
uploads 734 blobs for 739 sources:
`1069.0`≡`1397.0`, `1510.0`≡`548.0`, `1581.0`≡`1865.0`, `1660.0`≡`1736.0`,
`1802.0`≡`606.0`. Merge saves 6,144 B mip0 and 8,188 B in the expected chain.

### 3.5 Unsupported sections (4)

All four stop in the committed native reader on POSITION0 **type 7**,
method 0. The byte offset is relative to the extracted geometry chunk.

| section | geometry block | node block | byte offset | effect | stride | texture side |
|---|---:|---:|---:|---|---:|---|
| `g137-n250` | 137 | 250 | 371,526 | `FoliageBillBoard_LN` | 28 | static `g_tAlbedo` resolved |
| `g281-n282` | 281 | 282 | 327,320 | `FoliageBillBoard_LN` | 28 | static `g_tAlbedo` resolved |
| `g321-n322` | 321 | 322 | 18,116 | `LightFlare_LN` | 24 | **no static albedo** (`noAlbedo`) |
| `g349-n350` | 349 | 350 | 32,588 | `LightFlare_LN` | 24 | **no static albedo** (`noAlbedo`) |

The two foliage billboards have a resolvable albedo but no type-7 position
decoder; the two light flares expose no static albedo at all. This is a
geometry-reader blocker, not a missing texture stream for the foliage pair.

### 3.6 Skipped instances (14 sections, 2,714 descriptions)

| measure | value |
|---|---:|
| sections | 14 |
| instance descriptions | 2,714 |
| static `g_tAlbedo` resolved | 2,714 / 2,714 |
| UV0 declaration present | 2,714 / 2,714 |
| referenced geometry blocks | 378 (all available) |
| first-item-of-record blocks | 275 |
| upper-bound triangles (LOD0 counts) | 2,261,020 |
| single-chunk `--instances-all` | 0 emitted; omitted-other-block = section count |
| bundled prerequisite errors | 14 / 14 |

Instances are **not applied**. The texture side is ready; the blocker is
other-block geometry plus the chunk prerequisite policy.

---

## 4. Layout, spawn and path

The candidate layout is re-measured before adoption:

- 2,571 points at 0.25 m nominal spacing; polyline length **624.913780 m**
  (declared 624.914; error −0.000219714 m).
- Every layout point lies on the measured draw-covered polyline (max deviation
  **1.42e-14 m**). All **541** covered samples are embedded.
- The path sits on a **1/12 m** lattice; maximum coordinate error 0.0004 m.
- 541/541 covered samples are passable on the 1 m audit grid; 2,538/2,571 dense
  layout points fall on a passable nearest cell (the rest is the 1 m
  nearest-cell artifact).
- Direction: spawn → checkpoint 1 → checkpoint 2 → finish. No lap is claimed.

| station | x | z | ground (m) | cumulative (m) |
|---|---:|---:|---:|---:|
| spawn | 336.0 | −23.0 | 129.9989 | 0.0 |
| checkpoint 1 | 506.1393 | −57.1393 | 130.0 | 208.343397 |
| checkpoint 2 | 682.1364 | −107.1364 | 130.0 | 416.652055 |
| finish | 876.0 | −142.0 | 128.1618 | 624.91378 |

Spawn heading is 2.15879893 rad, the first-2 m tangent (8th 0.25 m point); the
measured tangent is 2.1587989303 rad (heading error 3.42e-10 rad). Note this is
**not** the first 0.25 m segment (2.356194 rad) because the path turns inside
the first two metres; the candidate rule is the 2 m tangent.

### 4.1 Spawn ground and 1 m band

A vertical collision ray at (336, −23) hits **129.998887 m** with normal
`[0.000056, 0.99999998, −0.000205]`. The layout records 129.9989 (delta
−1.28e-5 m); the E1 engine ground probe returns 129.99884 m.

Because the ground is far outside Amboy’s legacy ray window, the Gracia ray
window is documented as layout ground ±50 m (79.9989 … 179.9989 m) and is
recorded in `slice.json.spawnProof.ray`. Twenty-five rays cover 5 stations
(0–4 m) × 5 lateral offsets (−0.5, −0.25, 0, +0.25, +0.5 m): **25/25 hits,
all up-facing**, height spread **0.000779868 m**, max absolute deviation
0.000710 m. The surface at the spawn is nearly planar.

---

## 5. Physics proof

The existing E1 wasm module imports the supplied Gracia physics bytes (not a
River hard-code), including the two Boxes, two TriangleMeshes, two
TriangleMeshBases and 38 `InstancedTriangleMesh` records. Inputs: the physics
file above, `car.fields`, spawn (336, −23), heading 2.15879893. The module runs
its 180-tick warm-up, then 60 ticks with zero input.

| field | value |
|---|---|
| create | ok, `car=Corvette_ZR1_Stock` |
| tick-0 position | `[335.733368, 130.347549, −22.8329945]` |
| tick-60 position | `[335.724213, 130.347031, −22.829401]` |
| ground / start Y | 129.99884 / 130.524841 |
| ride height (tick 0 above ground) | 0.348709 m |
| wheel contacts | 4/4 on all 61 states |
| finite / anyContact | true / true on all 61 states |
| max / final speed | 0.011933 / 0.009078 m/s |
| drift over 60 ticks | 0.009835 m |
| vertical delta | −0.000518 m |
| state sequence | `sha256:4fd8ae0c0256758eaa9378c4cd3e46e7b04c39803a3ef81b7cc83eb2386e8e30` |
| tick-0 state hash | `sha256:2dfd03c7…4fc062` |
| tick-60 state hash | `sha256:f17f9eb4…5461c8` |

Two independent module instances produced identical per-tick hashes. This
proves the car sits on the Gracia collision at the candidate spawn; it does not
prove a driven line, lap, race or rendered frame.

---

## 6. Package

### 6.1 Slice `_work/map-slice/gracia/`

| file | bytes | SHA-256 |
|---|---:|---|
| `slice.json` | 2,656,163 | `dd97ba09155abd44226fda1e2944851863049360369451044d8e23eed566bfc4` |
| `collision.positions.f32.bin` | 801,300 | `8a70a122a0e8792c3d407fdede0f8a3a02f6fe777d4ae5800d953c8e0dab4829` |
| `collision.indices.u32.bin` | 1,359,240 | `6a72ebd65175c619bf2076f236082f3e5379689913eca18b9de5ecac21ed1bf2` |
| `draws.positions.f32.bin` | 8,866,860 | `f6edf5720a7399665e83018fee83de97a21b9f3cdc7fde7fcf310caca971ba11` |
| `draws.uv0.f32.bin` | 5,911,240 | `62f8ae72d860e9fc17395a5707791add9cbf46a1197cfc595a50d66aa52c5abc` |
| `draws.indices.u32.bin` | 6,607,584 | `dea21ba6dcb38b88ac0d303f4346c12f781d7998e2c0e4e525f033c6964e789f` |
| `physics-settle.json` | 38,979 | `413414633b3cc76a8bf02ca2c5f6dbe0e1dbcd50f8c23e5bd7a90c5308eb46b9` |
| `verify.json` | 2,069 | `24fe05073800e1bdd4c92e005385b1ef3df4e632b817a9d07de6a8b541ba2d85` |

`slice.json` content hash (canonical body excluding `hashes`):
`9f9799e7fa72ae6bf34c0865f9baba9d95e739ec2c7d2c7589196acdb337e721`.
Payload + manifest + physics = **26,241,366 B**; including `verify.json`
**26,243,435 B**.

### 6.2 Bindings `_work/map-slice/gracia-textures/`

| file | bytes | SHA-256 |
|---|---:|---|
| `bindings.json` | 4,568,799 | `d3086493383d00f71203e340f26811f151411baa654964bde41be5ee1e098351` |
| `summary.json` | 244,013 | `14e029f2650d912501870c50395301756272e957a6e8f75701a232b3a3964262` |
| `blockers.json` | 124,114 | `64557d7cce5fc8ffa0a6a695fae8f2563659ebb3ca4657d0228260d3dcc57765` |
| `verify.json` | 3,022,346 | `5229a0bc412136f27a373b0adc7fbfaaf1c7e2c67f0a7a265bc8a5ae61dd94eb` |
| `raw/*.raw` | 846 files / 5,595,592 B | per-file SHA-256 in `bindings.json` |
| `textures/*.rgba` | 841 files / 3,611,904 B | per-file SHA-256 in `bindings.json` |
| `instance-native/*.json` | 28 files / 871,774 B | native instance attempts |
| `instance-chunks/*.chunk` | 29 files / 10,100,736 B | first-item blocks for the bundle attempts |

### 6.3 Render `_work/map-slice/gracia-render/`

| file | bytes | SHA-256 |
|---|---:|---|
| `render.json` | 3,079,731 | `075c8c595c0c0e35780707e262aa084d4827dd875722e37a0a1185c855a14050` |
| `diagnostics.json` | 1,056,264 | `4188b56a0bce108d250b2cb7fd165c715bc5e571a469913b7fc5b7d7289352b6` |
| `draws.positions.f32.bin` | 8,866,860 | `f6edf5720a7399665e83018fee83de97a21b9f3cdc7fde7fcf310caca971ba11` |
| `draws.uv0.f32.bin` | 5,911,240 | `62f8ae72d860e9fc17395a5707791add9cbf46a1197cfc595a50d66aa52c5abc` |
| `draws.indices.u32.bin` | 6,607,584 | `dea21ba6dcb38b88ac0d303f4346c12f781d7998e2c0e4e525f033c6964e789f` |
| `layout.points.f32.bin` | 30,852 | `c4cd21db2781acd87ebcda822d8233a1c2ecb4f434bba89bd4fe7faf9f9c845f` |
| `textures/tex-000.rgba … tex-733.rgba` | 3,247,360 / 734 files | aggregate in `render.json` |
| `verify.json` | 1,118 | `e846028b3964a6d2e4a052142e5f1b2f0a83b3457a9e61518b93498fd921b7ef` |

`render.json.hashes.files` pins 739 payload files. Manifest content hash:
`9c5a87e060b8491152b0c1240e55087d4da9e000b4fc82fc659a9e89da201031`.
The three geometry buffers are **byte-identical** to the slice buffers; only
texture bindings, diagnostics and the float32 layout were added. Package bytes
excluding `verify.json` **28,799,891**; including it **28,801,009**.

---

## 7. Upload contract

Same shape as Amboy, with Gracia counts:

| slot | format | count | file |
|---|---|---:|---|
| vertex buffer 0 | `float32x3` position | 738,905 | `draws.positions.f32.bin` |
| vertex buffer 1 | `float32x2` UV0 | 738,905 | `draws.uv0.f32.bin` |
| index buffer | `uint32` | 1,651,896 | `draws.indices.u32.bin` |

- Upload the three buffers once; all draw lists share them.
- `render.json#draws` is the 2,627-entry opaque list
  (`{firstIndex, indexCount, textureSlot, textureId, uvHash}`).
- `diagnostics.json#groups.effectDecal.indexRanges` is the separate 518-entry
  additive/alpha-tested decal list; it is **not** opaque albedo.
- `diagnostics.json#draws` holds all 953 blocked draws (435 diagnostic-only:
  5 decoder-size, 426 alpha, 4 runtime).
- 734 RGBA8 mip0 blobs, 3,247,360 B, all alpha-opaque, upload as
  `rgba8unorm`; `rgba8unorm-srgb` and mip generation are **hints only**
  (`applied:false`). 15 dimensions differ, so no array/atlas packing was done;
  one texture + sampler bind group per `textureSlot`.
- No vertex expansion or remap is required; ranges are global.
- `layout.points.f32.bin` is 2,571 `x,z,h` float32 points. Float32 packing
  gives length 624.911865234375 m (−0.001914766 m, ~3.06 ppm) and heading
  2.15879893 rad; exact readings are recorded in `render.json.layout`.

---

## 8. Verification

| gate | result |
|---|---|
| `verify_slice.py --package _work/map-slice/gracia` | **PASS, 26,797 checks, 0 errors** |
| `verify_amboy_texture_bindings.py --level spa_barcelona_gracia` | **PASS, 32,782 checks, 0 failures** |
| `verify_amboy_render.py --package _work/map-slice/gracia-render --level spa_barcelona_gracia` | **PASS, 45,590 checks, 0 errors** |
| render determinism | two fresh builds byte-identical, aggregate `4a863063865b45b7ec2dacaa5e6c0682a2a21cef7c7e7d5b16bc82b7de95e22f` |
| texture-binding repeat build | bindings/summary byte-identical after output-path normalisation |
| UV0 hashes | 3,580/3,580 recomputed and matched |
| draw join | 3,580/3,580 slice↔binding ranges, 0 mismatches |

The slice verifier re-parses the physics file, re-extracts all 113,270
triangles, re-reads all 88 native sections, rebuilds the merged buffers and
3,580 draw records, re-measures the path/checkpoints/embedded samples, re-casts
the 25-ray band, and re-hashes the 61 physics states. The binding verifier
re-derives every material chain with the committed P73a resolver, recomputes
every UV0 hash, re-extracts every blob, re-decodes every in-bound texture and
re-runs the binder for byte determinism. The render verifier re-checks every
texture, draw range, index/UV hash, diagnostic classification, layout byte and
manifest pin, then builds the package twice.

---

## 9. Amboy regression

The tools were generalized with Amboy defaults. Regression evidence:

| gate | result |
|---|---|
| `extract_slice.py --level usa_amboy` into `_work/map-slice/amboy-regen` | all five payload binaries **byte-identical**; layout points hash, draw records, sections, unsupported offsets, collision metrics and spawn proof equal |
| `verify_slice.py --package _work/map-slice/amboy-regen` | **PASS, 12,367 checks** |
| `verify_amboy_texture_bindings.py` | **PASS, 13,093 checks** |
| `verify_amboy_render.py --package _work/map-slice/amboy-render` | **PASS, 17,813 checks**; two builds byte-identical, aggregate `53fba81b…88d5e` (unchanged) |

**External drift (not caused by this task):** while this task ran, another
session changed `probes/e1-drive` (`git status` shows `e1_drive_lib.cpp`,
`build_module.mjs`, web files) and rebuilt `_work/e1-drive/module`. The
committed `_work/map-slice/amboy/slice.json` still pins the old module
(11,368 B / `31bcd0fe…`), build (3,356 B / `e7d4f5be…`) and wasm
(`eb9efc00…`). Running `verify_slice.py --package _work/map-slice/amboy`
therefore reports exactly 6 failures, all source/physics **module pins**
(`source.e1Module.*`, `source.e1Build.*`, `physics.module.wasmHash`,
`physics.module.buildWasmHash`); every geometry, draw, layout, spawn and
physics-state check still passes. The regenerated Amboy slice records the
current module and passes all 12,367 checks. Refreshing the committed Amboy
package is outside this task’s file ownership.

`python tools/verify_asset_probe.py --skip-build` currently fails at
`pickup-placements` (1,415 checks, 2 failures) in the concurrently modified
e1 power-up work, before reaching the map-slice steps. The three Amboy map-slice
steps and the three Gracia steps were run directly and are green except for the
committed-package e1 pin drift above.

---

## 10. Differences from Amboy

| measure | `usa_amboy` | `spa_barcelona_gracia` |
|---|---:|---:|
| collision triangles | 63,708 | **113,270** |
| section support | 48/75 | **88/92** |
| unsupported sections | 27 | **4** |
| draws / triangles | 1,606 / 348,948 | **3,580 / 550,632** |
| bindable / blocked draws | 1,201 / 405 | **2,627 / 953** |
| bindable triangles | 269,300 | **365,451** |
| texture sources / blobs | 186 / 179 | **739 / 734** |
| bindable RGBA bytes | 2,654,272 | **3,247,360** |
| instance descriptions | 366 in 3 sections | **2,714 in 14 sections** |
| path | 2,060.59538 m | **624.91378 m** |
| spawn ground | −0.0942 m | **129.9989 m** |
| spawn band spread | 0.10073 m | **0.00078 m** |
| physics sequence | `d25c4592…` | `4fd8ae0c…` |

Gracia has more geometry, far better section support and a near-planar spawn,
but many more alpha-blocked BC3 decoration atlases (426 draws vs 17) and a much
larger instance opportunity (2.26 M upper-bound triangles). The `Racification`
effect layer is the same shader family and remains a separate additive pass.

---

## 11. Limits

1. Data only: no renderer, GPU, browser, playable-game or full-game claim.
2. Materials, alpha/blend, shader stages, sampler wrap/filter, mips and sRGB are
   not applied; `srgbHint`/`mipHint` are contract hints.
3. The committed decoder is bounded to 2D ≤512×512; 5 sources remain undecoded,
   and 426 draws stay alpha-blocked for lack of an alpha rule. No fallback
   texture was invented.
4. 4 sections stop on POSITION0 type 7; two (foliage) have a resolvable albedo
   and two (light flares) have none. They are geometry-reader blockers.
5. `instancesApplied:false`: 2,714 descriptions remain other-block geometry.
6. Collision excludes the 2 Boxes and 38 InstancedTriangleMeshes; only the
   static triangle meshes are in the package.
7. Spawn and course are derived from the measured path, not a retail start
   line; point-to-point only, no lap/respawn/race rules.
8. No normals are exported.
9. The spawn ray window is layout ground ±50 m, recorded in the manifest; it
   was chosen to bracket the ~130 m road surface, not to hide upper geometry
   (the highest hit in a −50…500 m test is the same road triangle).
10. No frame, screenshot, console capture or GPU timing exists for Gracia.

---

## 12. Commands and evidence

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py probes/map-slice/tools/extract_slice.py --level spa_barcelona_gracia
& $py probes/map-slice/tools/amboy_texture_bindings.py --level spa_barcelona_gracia
& $py probes/map-slice/tools/amboy_blocker_report.py --level spa_barcelona_gracia
& $py probes/map-slice/tools/build_amboy_render.py --level spa_barcelona_gracia
& $py probes/map-slice/tools/verify_slice.py --package _work/map-slice/gracia
& $py probes/map-slice/tools/verify_amboy_texture_bindings.py --level spa_barcelona_gracia
& $py probes/map-slice/tools/verify_amboy_render.py --package _work/map-slice/gracia-render --level spa_barcelona_gracia
```

| path | content |
|---|---|
| `_work/map-slice/gracia/slice.json` | manifest, collision, 3,580 draws, layout, spawn, hashes |
| `_work/map-slice/gracia/physics-settle.json` | 61 states, 25 ground probes, determinism |
| `_work/map-slice/gracia/verify.json` | 26,797-check slice verifier |
| `_work/map-slice/gracia-textures/bindings.json` | per-draw material/albedo/UV0 binding manifest |
| `_work/map-slice/gracia-textures/blockers.json` | 4 unsupported sections + 14 instance sections |
| `_work/map-slice/gracia-textures/verify.json` | 32,782-check binding verifier |
| `_work/map-slice/gracia-render/render.json` | 2,627 opaque draws, 734 textures, layout, contract |
| `_work/map-slice/gracia-render/diagnostics.json` | 953 blocked draws + 518-entry decal list |
| `_work/map-slice/gracia-render/verify.json` | 45,590-check render verifier |
| `_work/logs/map-slice/gracia-extract.log` | slice extraction |
| `_work/logs/map-slice/gracia-textures-extract.log` | binding extraction |
| `_work/logs/map-slice/gracia-blockers.log` | unsupported/instance report |
| `_work/logs/map-slice/gracia-render-build.log` | render build |
| `_work/logs/map-slice/gracia-verify-slice.log` | 26,797 checks |
| `_work/logs/map-slice/gracia-textures-verify.log` | 32,782 checks |
| `_work/logs/map-slice/gracia-render-verify.log` | 45,590 checks + determinism |
| `_work/logs/map-slice/amboy-regen-extract.log` | Amboy regression extraction |
| `_work/logs/map-slice/amboy-regen-verify-slice.log` | Amboy regen 12,367 checks |
| `_work/logs/map-slice/amboy-textures-verify-regression.log` | Amboy 13,093 checks |
| `_work/logs/map-slice/amboy-render-verify-regression.log` | Amboy 17,813 checks |
| `_work/logs/map-slice/asset-probe-gracia-skip-build.log` | repository suite attempt |
| `probes/map-slice/tools/map_slice_common.py` | level names, package dirs, ray window |
| `probes/map-slice/tools/extract_slice.py` | generalized slice builder |
| `probes/map-slice/tools/amboy_texture_bindings.py` | generalized binding resolver |
| `probes/map-slice/tools/amboy_blocker_report.py` | generalized blocker report |
| `probes/map-slice/tools/build_amboy_render.py` | generalized render builder |
| `probes/map-slice/tools/verify_slice.py` | generalized slice verifier |
| `probes/map-slice/tools/verify_amboy_texture_bindings.py` | generalized binding verifier |
| `probes/map-slice/tools/verify_amboy_render.py` | generalized render verifier |

No file under `probes/e1-drive`, `probes/asset-reader`, `probes/map-pipeline`,
`tools/`, `upstream/` or `game-data/` was modified by this task. `_work/`
packages and decoded textures are generated game data and are not committed.

---

## 13. Behavior-based module pin refresh (7 November 2026 follow-up)

`verify_slice.py` no longer hard-fails on E1 module/build/wasm byte drift. It
replays the current `_work/e1-drive/module/e1_drive.mjs` on this package's
physics at the recorded spawn, twice, and accepts the drift only when all 61
per-tick state hashes and the sequence hash match `physics-settle.json`. The
current identity is recorded in `verify.json` informationally; a behaviour
change fails with the exact tick and hashes.

| item | refreshed value |
|---|---|
| module | 11,480 B / `5177ea975151fb085a44b8b960e384913d36a7e225078a1783f90e1f0b1bff2a` |
| build | 3,466 B / `8493193cb8aacc5a9d108874318c612298b46edb5fe28b12c8558b7f0d5c7577` |
| wasm | `bcdc2d994a499cc399333b44cfc418d6594f8b5182a668c3a9df761d891de265` |
| sequence | `sha256:4fd8ae0c…386e8e30`, 61/61 ticks identical |
| `slice.json` | 2,656,163 B / `e1e1fe62c6e36d8ea71a7b82303b4ff4b6abafcb9fad2810e019be1292652534`, content `c1bdf1a7…e89fef` |
| `physics-settle.json` | 39,160 B / `58738fa6efe2cf591533c46c3926b7eff5c49426032d9aed911dffd24ef18e07` |
| `verify.json` | **26,797 checks, PASS**, `99cdb80c…20af8` |

Collision, draw, UV0, index, layout and spawn bytes are unchanged. The
binding/blocker/summary input pins were updated to the new slice hash and the
render package was rebuilt. Policy and full hashes:
[`map-slice-module-pin-policy.md`](map-slice-module-pin-policy.md).
