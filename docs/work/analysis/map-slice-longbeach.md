# `usa_la_longbeachdocks` map slice, texture binding and render-ready package

**Date:** 7 November 2026
**Owner:** MAP8 (sub-agent)
**Scope:** `probes/map-slice/**` (level-name generalization and one new diagnostic
status), `_work/map-slice/longbeach*/`, `_work/logs/map-slice/**`,
`tools/verify_asset_probe.py` (three verifier steps, per task step 5) and this
document. No change to `probes/e1-drive`, `probes/asset-reader`,
`probes/map-pipeline`, `upstream/` or `game-data/`.

**No renderer, GPU, browser, e1-drive integration, playable-game or full-game
claim is made.** This is a deterministic data package plus its upload contract.

---

## 0. Result

| item | measured value |
|---|---|
| collision triangles | **25,183** (18,051 surface, 4,982 steep, 2,150 other, 0 degenerate) |
| collision unique vertices | 14,483 (75,549 triangle-soup indices) |
| first-RenderList direct sections | **74 supported / 76 probed**; 2 unsupported |
| draw geometry | 864,473 vertices, 537,294 triangles, 1,141 draws |
| UV0 | 1,141/1,141 draws; 0 missing; 0 placeholder vertices |
| static albedo identity resolved (fixed reader) | **1,136/1,141** (1,129 resource-block + 7 shared), 5 identity-blocked |
| **bindable static albedo + original UV0** | **1,039 draws / 511,782 triangles** |
| blocked | **102 draws / 25,512 triangles** |
| distinct texture sources | 206 (175 bindable) |
| decoded RGBA mip0 | 204 sources; 2 sources exceed the 512 px decoder bound |
| bindable texture bytes | 1,263,744 B referenced; 1,239,168 B unique upload (10 merge groups, 21 sources → 10 blobs) |
| measured draw-covered path | **818.371716 m** point-to-point (declared 818.372) |
| path coverage of collision diameter | **47.29 %** (818.372 / 1,730.511) |
| checkpoints | 272.892714 m and 545.610534 m |
| spawn | (−519, 111), ground −0.098 m, heading −2.35619449 rad |
| spawn band | 25/25 hits, all up-facing, 1 m × 5 m, height spread **0.000000 m** |
| physics settle | 60 ticks, zero input, 4/4 wheel contacts on 61/61 states, finite |
| physics state sequence | `sha256:bb4d7efc…d408470c8` (two independent modules identical) |
| package bytes, slice + physics | 25,353,081 (25,356,446 incl. `verify.json`) |
| package bytes, textures | 21,356,429 (22,278,669 incl. `verify.json`) |
| package bytes, render | 26,092,882 (26,093,998 incl. `verify.json`) |
| verifier | slice **9,480** checks; bindings **9,967**; render **13,534**; all PASS |
| deterministic builds | slice **2/2 byte-identical**; render **2/2 byte-identical**, aggregate `5daf2fb0…110062f` |

The package is a **playable-slice input**, not a playable slice: no renderer, no
e1-drive integration, no UI, no retail start-line record, no lap. The measured
draw-covered route is only 47.3 % of the collision diameter, so it is **not** a
full-circuit geometry package.

---

## 1. Sources and extraction

| input | bytes | SHA-256 |
|---|---:|---|
| `game-data/Blur/levels/usa_la_longbeachdocks/Level.levelphysics` | 2,214,990 | `ce22c1cadbcff96074ff4d84741137162d2fe0697a5c354053e181944d6cca0d` |
| `game-data/Blur/levels/usa_la_longbeachdocks/level.levelrender` | 13,319,217 | `edccd6e676a41008f2f6099ffadc7f004fbf02285218d0cd080b3353d692ac5a` |
| `game-data/Blur/levels/usa_la_longbeachdocks/Level.levelstream` | 232,339,456 | `5cd242cc98270e6f8ae40379a6a3e0cff63c68ba5ae728ced4f938baf7364cac` |
| `_work/map-pipeline/candidates/usa_la_longbeachdocks.layout.json` | 233,993 | `0e59971280db70a2ca92fbd67191b9cafb7903bebfa06ba3ac20e24996e38700` |
| `_work/map-pipeline/covered/usa_la_longbeachdocks-path.json` | 22,576 | `964e4ba67a1d132db13821930e15648c13258cc1e749e48026b777c2dd84a920` |
| `_work/map-pipeline/covered/usa_la_longbeachdocks.json` | 5,226 | `7db4acda54023e132e991901266b5d58c75d915919df74d87a29cca70c09f3e2` |
| `_work/map-pipeline/grids/usa_la_longbeachdocks.npz` | 773,951 | `455578b9b9ec31eacd137503c3eca2f42ddf1df544327cc64a06ce5233a7e25f` |
| `_work/map-pipeline/draw-probes-all.json` | 1,267,866 | `00c86204c0485ca269da5e120bce8ed10232cb7f8fac172e11a339a0f4b61c55` |
| native reader `level_inspect.exe` | 249,856 | `a633a030f530b9939991b4fc5c67aebe60d00cd22d59a6fffb3f74b0fbf6965b` |
| decoder `texture_inspect.exe` | 57,856 | `745e80981b180bf9e9c3d7bf92597636cb919a28ce013ebf531495aec15e2427` |
| E1 module `e1_drive.mjs` | 11,480 | `5177ea975151fb085a44b8b960e384913d36a7e225078a1783f90e1f0b1bff2a` |
| E1 wasm `e1_drive.wasm` | — | `bcdc2d994a499cc399333b44cfc418d6594f8b5182a668c3a9df761d891de265` |
| E1 build `build.json` | 3,466 | `8493193cb8aacc5a9d108874318c612298b46edb5fe28b12c8558b7f0d5c7577` |
| `_work/e1-drive/car.fields` | 7,489 | `1c24bbd7f055f904062d1f1b7b377be727a7cf9f64e8ca2c72dff5b138a55381` |

Collision uses the committed map-pipeline `physics_scan.py` (stream version 10,
file version 0). The reader replay re-ran the current `level_inspect.exe` on all
74 supported staged chunks and aborted unless positions, UV0 bits, indices and
draw ranges matched the committed probe doc. Evidence:
`_work/logs/map-slice/reader-refresh/usa_la_longbeachdocks/` (74 JSON files).

---

## 2. Collision

| shape | type | shipped as triangles | reason |
|---:|---:|---|---|
| 0 | 0 TriangleMesh | yes, 25,147 | main static world mesh |
| 1, 10, 12 | 11 TriangleMeshBase | yes, 12 + 12 + 12 = 36 | three 8-vertex static triangle pairs |
| 2–9, 11, 13 | 10 InstancedTriangleMesh | no | 10 instance shapes not decoded |
| 14 | 17 FluidMesh | no | water collision; excluded from the drivable triangle surface |

After exact-position deduplication: **25,183 triangles**, 14,483 unique vertices,
75,549 soup indices. Geometric normal classification: 18,051 surface
(`normal.y > 0.94`), 4,982 steep (`|normal.y| < 0.5`), 2,150 other, 0 degenerate.
Bounds `[−1746.104126, −7.228000, −490.422028] … [0.0, 36.594002, 1044.550049]`.
Route count 11, routes not parsed.

`collision.shapes` carries the exact `FluidMesh (importType 17)` reason; the
committed scanner excludes it from `flatten_static_triangles`, so no water
triangle is in the collision binary.

---

## 3. Layout, spawn and path

The candidate layout is re-measured before adoption:

- 3,409 points at 0.25 m nominal spacing; polyline length **818.371716 m**
  (declared 818.372; error −0.00028355 m).
- Every layout point lies on the measured draw-covered polyline (max deviation
  **1.42e-14 m**). All **657** covered samples are embedded.
- The path sits on a **1/12 m** lattice; maximum coordinate error 0.0004 m.
- 657/657 covered samples are passable on the 1 m audit grid; 3,401/3,409 dense
  layout points fall on a passable nearest cell (the rest is the 1 m
  nearest-cell artifact).
- Direction: spawn → checkpoint 1 → checkpoint 2 → finish. No lap is claimed.

| station | x | z | ground (m) | cumulative (m) |
|---|---|---:|---:|---:|
| spawn | −519.0 | 111.0 | −0.098 | 0.0 |
| checkpoint 1 | −750.2611 | 24.7389 | −0.194 | 272.892714 |
| checkpoint 2 | −645.6875 | −181.3125 | −0.098 | 545.610534 |
| finish | −432.0 | −86.0 | −0.098 | 818.371716 |

Spawn heading is −2.35619449 rad, the first-2 m tangent (8th 0.25 m point); the
measured tangent is −2.3561944902 rad (heading error 1.92e-10 rad).

### 3.1 Spawn ground and 1 m band

A vertical collision ray at (−519, 111) hits **−0.098000005 m**. The layout
records −0.098 (delta −5e-9 m). The ray window is layout ground ±50 m
(`startY 49.902`, `minY −50.098`, `maxY 49.902`), recorded in
`slice.json.spawnProof.ray`. Twenty-five rays cover 5 stations (0–4 m) × 5
lateral offsets (−0.5, −0.25, 0, +0.25, +0.5 m): **25/25 hits, all up-facing**,
height spread **0.0 m**, max absolute deviation **0.0 m**. The dock spawn is
exactly planar within float32 precision.

---

## 4. Draws, textures and UV0

### 4.1 Supported geometry

74 of 76 first-RenderList direct sections are readable: **864,473 vertices,
537,294 triangles, 1,141 draws**. Every draw has original UV0 (1,141/1,141), 0
UV0-blocked, 0 placeholder vertices. The merged buffers are 10,373,676 B
positions, 6,915,784 B UV0, 6,447,528 B indices.

### 4.2 Static albedo identity (fixed reader)

The fixed reader resolves a static albedo identity for **1,136/1,141** draws
(1,129 resource-block + 7 shared) and reports 5 identity-blocked. It prints
1,141/1,141 UV0 hashes. Identity is not a binding: format, alpha, blend, shader
stage, sampler and pixels are not applied.

### 4.3 Bindable split after decoder/alpha join

| status | draws | triangles | reason |
|---|---:|---:|---|
| `bindable-static-albedo` | **1,039** | **511,782** | static `g_tAlbedo`, decoded image, opaque alpha, UV0 |
| `blocked-alpha-rule-missing` | 93 | 24,921 | BC3 source with non-opaque alpha; no alpha-test/blend rule |
| `blocked-decoder-size-limit` | 4 | 430 | source is 1,024–4,096 px wide; committed decoder bound is ≤512 |
| `blocked-runtime-albedo-parameter` | 4 | 8 | `Advert_LN_NV` serialises `g_tAlbedo` as runtime `DATA_INDEX` |
| `blocked-no-static-albedo` | 1 | 153 | `Ocean_LN` primitive material stack has **no** `g_tAlbedo`/`g_tTexture` assignment |
| `blocked-effect-not-static-albedo` | 0 | 0 | this level has no additive decal/effect layer in the direct pass |
| **total** | **1,141** | **537,294** | |

No UV0 blocker exists. 69 of 74 supported sections carry at least one bindable
draw. The 5 sections with none are:

| section | draws | reason |
|---|---:|---|
| `g227-n228` | 1 | decoder-size (large source) |
| `g233-n234` | 1 | BC3 alpha |
| `g385-n386` | 1 | `Ocean_LN`, no static albedo |
| `g393-n394` | 20 | BC3 alpha |
| `g413-n414` | 16 | BC3 alpha |

`blocked-no-static-albedo` is a new, explicitly labelled status introduced by
this task. It is **not** folded into the effect layer: there is no shader texture
to name and no image identity. The diagnostic record is
`{blocker:"no-static-albedo", sourceTextureId:null, fallback:"none"}`.

### 4.4 Texture sources

| bucket | sources | RGBA bytes |
|---|---:|---:|
| bindable resource-block `longbeach.albedo.<block>.<index>` | 173 | in bindable total |
| bindable shared `longbeach.shared.<index>` | 2 | in bindable total |
| **bindable total** | **175** | **1,263,744** |
| decoded but non-bindable (BC3 alpha) | 29 | 61,440 |
| size-blocked, no RGBA | 2 | 0 |
| **all sources** | **206** (203 resource-block + 3 shared) | 1,325,184 decoded |

The two decoder-size sources are `ladockscitywrap2left_diff`
(`longbeach.albedo.589.0`, 4096×256 BC3) and shared `barriergrey_diff`
(`longbeach.shared.11`, 1024×128 BC1); together they carry 4 draws / 430
triangles. The 29 alpha-blocked sources are BC3 decoration/foliage atlases. No
image was resized, upcoloured or invented.

The most-shared bindable sources by draw count are `cranecropsheet_diff`
(71 draws), `lampost_various_diff` (64), `railsplain01_diff` (37) and
`tallgreybrick01_diff` (33). 16 distinct decoded dimensions occur
(4×4 … 256×512); the bindable set uses 15.

Ten RGBA payloads are byte-identical across two or three sources, so the render
package uploads 164 blobs for 175 sources; the merge saves 11 sources, 24,576 B
mip0 and 32,780 B in the expected chain. One group is a 3-way merge
(`longbeach.albedo.1060.0` ≡ `…684.0` ≡ `…950.0`); the verifier now counts merge
groups by distinct duplicate hash, not by `sources − blobs`.

### 4.5 Unsupported sections (2)

Both stop in the committed native reader on POSITION0 **type 7**, method 0. The
byte offset is relative to the extracted geometry chunk. Both resolve a static
albedo on the texture side for at least one primitive.

| section | geometry block | node block | byte offset | effect | stride |
|---|---:|---:|---:|---|---:|
| `g199-n346` | 199 | 346 | 362,668 | `FoliageBillBoard_LN` | 28 |
| `g204-n418` | 204 | 418 | 241,712 | `LightFlare_LN` | 24 |

This is a geometry-reader blocker (no type-7 position decoder), not a missing
texture stream.

### 4.6 Skipped instances (33 sections, 7,476 descriptions)

| measure | value |
|---|---:|
| sections | 33 |
| instance descriptions | **7,476** |
| static `g_tAlbedo` resolved | 7,476 / 7,476 |
| UV0 declaration present | 7,476 / 7,476 |
| referenced geometry blocks | 588 (all available) |
| first-item-of-record blocks | 116 |
| upper-bound triangles (LOD0 counts) | **5,948,518** |
| single-chunk `--instances-all` | 0 emitted; omitted-other-block = section count |
| bundled prerequisite errors | 29 / 33 |

Instances are **not applied**. The texture side is ready; the blocker is
other-block geometry plus the chunk prerequisite policy. This is the largest
instance opportunity of the three sliced maps (Amboy 366, Gracia 2,714).

---

## 5. Physics proof

The existing E1 wasm module imports the supplied longbeach physics bytes,
including the TriangleMesh, the three TriangleMeshBases, the 10
`InstancedTriangleMesh` records and the FluidMesh. Inputs: the physics file
above, `car.fields`, spawn (−519, 111), heading −2.35619449. The module runs its
180-tick warm-up, then 60 ticks with zero input.

| field | value |
|---|---|
| create | ok, `car=Corvette_ZR1_Stock` |
| tick-0 position | `[−519.000061, 0.258286208, 110.99987]` |
| tick-60 position | `[−519.000061, 0.258286208, 110.999855]` |
| ground / start Y | −0.0980072021 / 0.427992821 |
| ride height (tick 0 above ground) | 0.3562934 m |
| wheel contacts | 4/4 on all 61 states |
| finite / anyContact | true / true on all 61 states |
| max / final speed | 1.966e−05 / 1.966e−05 m/s |
| drift over 60 ticks | 1.5e−05 m |
| vertical delta | 0.0 m |
| state sequence | `sha256:bb4d7efc9114036a832b05e743b4f65e28564cd386c34270fefcef5d408470c8` |
| tick-0 state hash | `sha256:6cc86e58…74a1c41f` |
| tick-60 state hash | `sha256:c46a2a28…7574a2e63` |

Two independent module instances produced identical per-tick hashes. This proves
the car sits on the longbeach collision at the candidate spawn; it does not prove
a driven line, lap, race or rendered frame.

---

## 6. Package

### 6.1 Slice `_work/map-slice/longbeach/`

| file | bytes | SHA-256 |
|---|---:|---|
| `slice.json` | 1,100,708 | `7525436d662d230cd4244dfb7821b1f41ed586ce0bb950b2ae3478199cf084b7` |
| `collision.positions.f32.bin` | 173,796 | `63ebcd1e6cafaa7fbacc58b3943ab455b4235aa2f2b31f1fd5ec8796491103f3` |
| `collision.indices.u32.bin` | 302,196 | `ebdaf54f3a74e2dabded97e15ca453076134c4eb69053fd7b2f0a3cb47275e18` |
| `draws.positions.f32.bin` | 10,373,676 | `5fbabc9075c873cbaed50be9ea91292435a0ef502a03ba43dac9897f737f72d3` |
| `draws.uv0.f32.bin` | 6,915,784 | `b207a1ba8cb9f7292be920308f4d2e2fbb29f3879aff573704f7377b34a95474` |
| `draws.indices.u32.bin` | 6,447,528 | `fa1f83bd49d85c7d4cb7d2ec5165c5900ec95c400d949892d5902e0ec1664294` |
| `physics-settle.json` | 39,393 | `4e30306ace24efd61274ee37d1b105cbeecab60f6834cfd172ea758fa0950fbb` |
| `verify.json` | 3,365 | `1f4cfe1b5e76bce04cd0d5eee99b18fcda5cfd71284da163b70c47b0744d134b` |

`slice.json` content hash (canonical body excluding `hashes`):
`c800503f986e94bd84fc16295f424a779e965cd9c499affdeb65edcf0d008f39`.
Payload + manifest + physics = **25,353,081 B**; including `verify.json`
**25,356,446 B**.

A second extraction into `_work/map-slice/longbeach-regen` produced **all seven
files byte-identical** (slice.json, both collision buffers, all three draw
buffers, physics-settle.json).

### 6.2 Bindings `_work/map-slice/longbeach-textures/`

| file | bytes | SHA-256 |
|---|---:|---|
| `bindings.json` | 1,341,862 | `26220094e0e67925369de7a62c616708222669f806f788b9cb308129ba7b1717` |
| `summary.json` | 62,112 | `881832d8928509a59786907a4f98ec80228a16837b96d79d35a8c34f5d8ef8f7` |
| `blockers.json` | 287,905 | `175284aad9aed91ed68f45b738fa8380c1a7a691ec07c837f94b55c74240a11f` |
| `verify.json` | 922,240 | `cc00c261218231312e88e9b5d4881d0d2a7bba8dfb8c68d29e15226c4626e3b7` |
| `raw/*.raw` | 206 files / 1,726,888 B | per-file SHA-256 in `bindings.json` |
| `textures/*.rgba` | 204 files / 1,325,184 B | per-file SHA-256 in `bindings.json` |
| `instance-native/*.json` | 64 files / 2,317,438 B | native instance attempts |
| `instance-chunks/*.chunk` | 21 files / 14,295,040 B | first-item blocks for the bundle attempts |

### 6.3 Render `_work/map-slice/longbeach-render/`

| file | bytes | SHA-256 |
|---|---:|---|
| `render.json` | 985,213 | `c79d5ea8653aa8c88fa115d7a048b91b308d85ca6502582f0605a7220086ec3a` |
| `diagnostics.json` | 90,605 | `6e5afe89bec49161d4bb7b2597f168ade3fd854f622680c28facdfe0b2399de0` |
| `draws.positions.f32.bin` | 10,373,676 | `5fbabc9075c873cbaed50be9ea91292435a0ef502a03ba43dac9897f737f72d3` |
| `draws.uv0.f32.bin` | 6,915,784 | `b207a1ba8cb9f7292be920308f4d2e2fbb29f3879aff573704f7377b34a95474` |
| `draws.indices.u32.bin` | 6,447,528 | `fa1f83bd49d85c7d4cb7d2ec5165c5900ec95c400d949892d5902e0ec1664294` |
| `layout.points.f32.bin` | 40,908 | `c781299c40293e6eb341b5d80ecd20cc9f68947c048a78956f917f48b65420c8` |
| `textures/tex-000.rgba … tex-163.rgba` | 1,239,168 / 164 files | aggregate `c0d0562b3f9e49d3232a43add728da9e9ae04e2e6ae3bcba3a1c4be0fa53da95` |
| `verify.json` | 1,116 | `679e020740afb247a773b93f1e211de5d0be5e794462d1ee02c4fe9387b8d656` |

`render.json.hashes.files` pins 169 payload files (three buffers, layout,
diagnostics and every texture) by size and SHA-256. Manifest content hash:
`c8bfff56018c059efdf31ae749c353435aab25d8359577b307606d378c032199`.
The three geometry buffers are **byte-identical** to the slice buffers; only
texture bindings, diagnostics and the float32 layout were added. Package bytes
excluding `verify.json` **26,092,882**; including it **26,093,998**.

---

## 7. Upload contract

Same shape as Amboy/Gracia, with longbeach counts:

| slot | format | count | file |
|---|---|---:|---|
| vertex buffer 0 | `float32x3` position | 864,473 | `draws.positions.f32.bin` |
| vertex buffer 1 | `float32x2` UV0 | 864,473 | `draws.uv0.f32.bin` |
| index buffer | `uint32` | 1,611,882 | `draws.indices.u32.bin` |

- Upload the three buffers once; all draw lists share them.
- `render.json#draws` is the 1,039-entry opaque list
  (`{firstIndex, indexCount, textureSlot, textureId, uvHash}`).
- This level has **no effect-decal draws**. `diagnostics.json#groups.effectDecal`
  is present with `draws:0, indexRanges:[]` so consumers keep one schema.
- `diagnostics.json#draws` holds all 102 blocked draws
  (4 decoder-size, 93 alpha, 4 runtime, 1 no-static-albedo).
- 164 RGBA8 mip0 blobs, 1,239,168 B, all alpha-opaque, upload as
  `rgba8unorm`; `rgba8unorm-srgb` and mip generation are **hints only**
  (`applied:false`). 15 bindable dimensions differ, so no array/atlas packing was
  done; one texture + sampler bind group per `textureSlot`.
- No vertex expansion or remap is required; ranges are global.
- `layout.points.f32.bin` is 3,409 `x,z,h` float32 points. Float32 packing gives
  length 818.3507690429688 m (−0.020946957 m, ~25.6 ppm) and heading
  −2.356188768026391 rad (5.72e-6 rad from source); exact readings are recorded
  in `render.json.layout.pointsFloat32`.

---

## 8. Verification

| gate | result |
|---|---|
| `verify_slice.py --package _work/map-slice/longbeach` | **PASS, 9,480 checks, 0 errors** |
| `verify_amboy_texture_bindings.py --level usa_la_longbeachdocks` | **PASS, 9,967 checks, 0 failures** |
| `verify_amboy_render.py --package _work/map-slice/longbeach-render --level usa_la_longbeachdocks` | **PASS, 13,534 checks, 0 errors** |
| slice repeat build | all 7 files byte-identical |
| render determinism | two fresh builds byte-identical, aggregate `5daf2fb020622fb8df60d2b4f70659a143366fedd2bbee1d38c0a0a8a110062f` |
| texture-binding repeat build | bindings/summary byte-identical after output-path normalisation |
| UV0 hashes | 1,141/1,141 recomputed and matched |
| draw join | 1,141/1,141 slice↔binding ranges, 0 mismatches |

The slice verifier re-parses the physics file, re-extracts all 25,183 triangles,
re-reads all 74 native sections, rebuilds the merged buffers and 1,141 draw
records, re-measures the path/checkpoints/embedded samples, re-casts the 25-ray
band, and re-hashes the 61 physics states. The binding verifier re-derives every
material chain with the committed P73a resolver, recomputes every UV0 hash,
re-extracts every blob, re-decodes every in-bound texture and re-runs the binder
for byte determinism. The render verifier re-checks every texture, draw range,
index/UV hash, diagnostic classification, layout byte and manifest pin, then
builds the package twice.

---

## 9. Amboy/Gracia regression

The tools stay byte-compatible with the committed Amboy and Gracia packages:

| gate | result |
|---|---|
| `verify_slice.py --package _work/map-slice/amboy` | **PASS, 12,367 checks** |
| `verify_amboy_texture_bindings.py` | **PASS, 13,093 checks** |
| `verify_amboy_render.py --package _work/map-slice/amboy-render` | **PASS, 17,813 checks**; two builds byte-identical, aggregate `53fba81b…88d5e` (unchanged) |
| `verify_slice.py --package _work/map-slice/gracia` | **PASS, 26,797 checks** |
| `verify_amboy_texture_bindings.py --level spa_barcelona_gracia` | **PASS, 32,782 checks** |
| `verify_amboy_render.py --package _work/map-slice/gracia-render --level spa_barcelona_gracia` | **PASS, 45,590 checks**; two builds byte-identical, aggregate `4a863063…e22f` (unchanged) |

The generalization changes are level-neutral:

- `map_slice_common.SHORT_NAMES` gains `usa_la_longbeachdocks → longbeach`.
- `extract_slice.py` gains exact exclusion reasons for `importType 13 (Fluid)` and
  `17 (FluidMesh)`; neither occurs in Amboy or Gracia.
- `build_amboy_render.py` carries the `blocked-no-static-albedo` status and adds
  the `noStaticAlbedo` diagnostic group **only when such a draw exists**, so the
  Amboy and Gracia manifests are byte-identical.
- `verify_amboy_render.py` adds the corresponding conditional checks; for
  Amboy/Gracia the check count is unchanged.
- The merge-group expectation now counts distinct duplicate-hash groups instead
  of `sources − blobs`; the two are equal for Amboy/Gracia and differ only for a
  3-way merge.

`tools/verify_asset_probe.py --skip-build` passed **54** steps before the
longbeach steps were added and **57** steps with `longbeach-slice`,
`longbeach-textures` and `longbeach-render` appended.

---

## 10. Differences from Amboy/Gracia

| measure | `usa_amboy` | `spa_barcelona_gracia` | `usa_la_longbeachdocks` |
|---|---:|---:|---:|
| collision triangles | 63,708 | 113,270 | **25,183** |
| section support | 48/75 | 88/92 | **74/76** |
| unsupported sections | 27 | 4 | **2** |
| draws / triangles | 1,606 / 348,948 | 3,580 / 550,632 | **1,141 / 537,294** |
| bindable / blocked draws | 1,201 / 405 | 2,627 / 953 | **1,039 / 102** |
| bindable triangles | 269,300 | 365,451 | **511,782** |
| effect-decal draws | 334 | 518 | **0** |
| no-static-albedo draws | 4 (runtime) | 4 (runtime) | **1** |
| texture sources / blobs | 186 / 179 | 739 / 734 | **206 / 164** |
| bindable RGBA bytes | 2,654,272 | 3,247,360 | **1,239,168** |
| instance descriptions | 366 in 3 sections | 2,714 in 14 sections | **7,476 in 33 sections** |
| path | 2,060.59538 m | 624.91378 m | **818.371716 m** |
| draw coverage of collision diameter | 97.6 % | 99.6 % | **47.3 %** |
| spawn ground | −0.0942 m | 129.9989 m | **−0.098 m** |
| spawn band spread | 0.10073 m | 0.00078 m | **0.0 m** |
| physics sequence | `d25c4592…` | `4fd8ae0c…` | `bb4d7efc…` |

Longbeach has the lowest collision triangle count and the best section ratio, and
its spawn is exactly planar, but its direct-draw route covers less than half of
the collision diameter (195 covered components, 209,375 covered collision cells,
33.9 % of the 618,324 passable cells). It also
has the largest skipped-instance opportunity (~5.95 M upper-bound triangles) and
**no** additive effect layer; instead the water surface (`Ocean_LN`) is the only
draw with no static albedo at all. The fluid mesh is excluded from collision.

---

## 11. Limits

1. Data only: no renderer, GPU, browser, playable-game or full-game claim.
2. The draw-covered path is **47.3 %** of the collision diameter; the remaining
   collision surface has no direct-draw geometry in this package.
3. Materials, alpha/blend, shader stages, sampler wrap/filter, mips and sRGB are
   not applied; `srgbHint`/`mipHint` are contract hints.
4. The committed decoder is bounded to 2D ≤512×512; 2 sources remain undecoded
   (4 draws), and 93 draws stay alpha-blocked for lack of an alpha rule. No
   fallback texture was invented.
5. 2 sections stop on POSITION0 type 7; both resolve a static albedo on the
   texture side. They are geometry-reader blockers.
6. `instancesApplied:false`: 7,476 descriptions remain other-block geometry.
7. Collision excludes the 10 `InstancedTriangleMesh` shapes and the `FluidMesh`;
   only the static triangle meshes are in the package.
8. Spawn and course are derived from the measured path, not a retail start line;
   point-to-point only, no lap/respawn/race rules.
9. No normals are exported.
10. The spawn ray window is layout ground ±50 m, recorded in the manifest.
11. No frame, screenshot, console capture or GPU timing exists for longbeach.

---

## 12. Commands and evidence

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py probes/map-slice/tools/extract_slice.py --level usa_la_longbeachdocks
& $py probes/map-slice/tools/amboy_texture_bindings.py --level usa_la_longbeachdocks
& $py probes/map-slice/tools/amboy_blocker_report.py --level usa_la_longbeachdocks
& $py probes/map-slice/tools/build_amboy_render.py --level usa_la_longbeachdocks
& $py probes/map-slice/tools/verify_slice.py --package _work/map-slice/longbeach
& $py probes/map-slice/tools/verify_amboy_texture_bindings.py --level usa_la_longbeachdocks
& $py probes/map-slice/tools/verify_amboy_render.py --package _work/map-slice/longbeach-render --level usa_la_longbeachdocks

# Amboy/Gracia regression and the repository suite
& $py probes/map-slice/tools/verify_slice.py --package _work/map-slice/amboy
& $py probes/map-slice/tools/verify_amboy_texture_bindings.py
& $py probes/map-slice/tools/verify_amboy_render.py --package _work/map-slice/amboy-render
& $py probes/map-slice/tools/verify_slice.py --package _work/map-slice/gracia
& $py probes/map-slice/tools/verify_amboy_texture_bindings.py --level spa_barcelona_gracia
& $py probes/map-slice/tools/verify_amboy_render.py --package _work/map-slice/gracia-render --level spa_barcelona_gracia
& $py tools/verify_asset_probe.py --skip-build
```

| path | content |
|---|---|
| `_work/map-slice/longbeach/slice.json` | manifest, collision, 1,141 draws, layout, spawn, hashes |
| `_work/map-slice/longbeach/physics-settle.json` | 61 states, 25 ground probes, determinism |
| `_work/map-slice/longbeach/verify.json` | 9,480-check slice verifier |
| `_work/map-slice/longbeach-regen/` | second extraction, all 7 files byte-identical |
| `_work/map-slice/longbeach-textures/bindings.json` | per-draw material/albedo/UV0 binding manifest |
| `_work/map-slice/longbeach-textures/blockers.json` | 2 unsupported sections + 33 instance sections |
| `_work/map-slice/longbeach-textures/verify.json` | 9,967-check binding verifier |
| `_work/map-slice/longbeach-render/render.json` | 1,039 opaque draws, 164 textures, layout, contract |
| `_work/map-slice/longbeach-render/diagnostics.json` | 102 blocked draws + empty decal list |
| `_work/map-slice/longbeach-render/verify.json` | 13,534-check render verifier |
| `_work/logs/map-slice/longbeach-extract.log` | slice extraction |
| `_work/logs/map-slice/longbeach-textures-extract.log` | binding extraction |
| `_work/logs/map-slice/longbeach-blockers.log` | unsupported/instance report |
| `_work/logs/map-slice/longbeach-render-build.log` | render build |
| `_work/logs/map-slice/longbeach-verify-slice.log` | 9,480 checks |
| `_work/logs/map-slice/longbeach-textures-verify.log` | 9,967 checks |
| `_work/logs/map-slice/longbeach-render-verify.log` | 13,534 checks + determinism |
| `_work/logs/map-slice/longbeach-regen-extract.log` | second slice build |
| `_work/logs/map-slice/amboy-verify-slice-regression.log` | Amboy 12,367 checks |
| `_work/logs/map-slice/amboy-textures-verify-regression.log` | Amboy 13,093 checks |
| `_work/logs/map-slice/amboy-render-verify-regression.log` | Amboy 17,813 checks |
| `_work/logs/map-slice/gracia-verify-slice-regression.log` | Gracia 26,797 checks |
| `_work/logs/map-slice/gracia-textures-verify-regression.log` | Gracia 32,782 checks |
| `_work/logs/map-slice/gracia-render-verify-regression.log` | Gracia 45,590 checks |
| `_work/logs/map-slice/asset-probe-longbeach-skip-build.log` | repository suite |
| `probes/map-slice/tools/map_slice_common.py` | level names, package dirs, ray window |
| `probes/map-slice/tools/extract_slice.py` | generalized slice builder + fluid reasons |
| `probes/map-slice/tools/amboy_texture_bindings.py` | generalized binding resolver |
| `probes/map-slice/tools/amboy_blocker_report.py` | generalized blocker report |
| `probes/map-slice/tools/build_amboy_render.py` | generalized render builder + no-static-albedo group |
| `probes/map-slice/tools/verify_slice.py` | generalized slice verifier |
| `probes/map-slice/tools/verify_amboy_texture_bindings.py` | generalized binding verifier |
| `probes/map-slice/tools/verify_amboy_render.py` | generalized render verifier |
| `tools/verify_asset_probe.py` | three longbeach verifier steps |

No file under `probes/e1-drive`, `probes/asset-reader`, `probes/map-pipeline`,
`upstream/` or `game-data/` was modified by this task. `_work/` packages and
decoded textures are generated game data and are not committed.
