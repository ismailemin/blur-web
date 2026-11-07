# `usa_amboy` render-ready package

**Date:** 7 November 2026
**Owner:** AMB1 (sub-agent)
**Scope:** `probes/map-slice/**` (two new tools), `_work/map-slice/amboy-render/**`,
`_work/logs/map-slice/**` and this document. No change to `probes/e1-drive`,
`probes/asset-reader`, `probes/map-pipeline`, `tools/`, `upstream/` or
`game-data/`. The MAP2 slice and MAP3 bindings are consumed read-only.

**No renderer, GPU, browser, playable-game or full-game claim is made.** This is a
deterministic data package plus its upload contract, not an e1 integration.

---

## 0. Result

| item | measured value |
|---|---|
| bindable opaque draws | **1,201** / 269,300 triangles / 807,900 indices |
| blocked draws | **405** / 79,648 triangles |
| `Racification*` additive-decal layer | 334 draws / 56,860 triangles |
| decoder-size blocked | 50 draws / 19,004 triangles |
| BC3-alpha blocked | 17 draws / 3,648 triangles |
| runtime-albedo blocked | 4 draws / 136 triangles |
| bindable texture sources | **186** (182 resource-block + 4 shared) |
| merged RGBA mip0 blobs | **179** (7 duplicate pairs removed) |
| RGBA bytes, draw-referenced | **2,672,704** |
| RGBA bytes, unique upload | **2,654,272** |
| expected mip-chain bytes, unique | **3,539,772** |
| package bytes excluding `verify.json` | **19,132,229** |
| package bytes including `verify.json` | **19,133,342** |
| manifest content hash | `sha256:84cda38d…d8e4b5` |
| verifier | **17,813 checks, 0 errors, PASS** |
| deterministic builds | **2/2 byte-identical** |

The three geometry buffers are **byte-identical** to the MAP2 slice buffers, so
every position, index and UV0 value is unchanged from the already-verified
slice. The package adds texture bindings, merged RGBA blobs, a diagnostic list
for the blocked draws and the upload contract.

---

## 1. Inputs

| input | bytes | SHA-256 |
|---|---:|---|
| `_work/map-slice/amboy/slice.json` | 1,632,556 | `d34a33d9a77ccd1eaca34b03b89216a6d0b70b6d8f8c8a555e717ed7796c94f7` |
| `_work/map-slice/amboy/draws.positions.f32.bin` | 6,355,488 | `5d85409b9b838227907eca2d53b34a4d7f37cb6d67158dc596b70bc24dbb2755` |
| `_work/map-slice/amboy/draws.uv0.f32.bin` | 4,236,992 | `200ae62a7c4a3b20c0a0052e5034121c089aa8e52770cb054a22f01f29bffdff` |
| `_work/map-slice/amboy/draws.indices.u32.bin` | 4,187,376 | `f4d77438b7ce99a809280e71b6cd356dedef784f613faf0147bd447c50b41e66` |
| `_work/map-slice/amboy-textures/bindings.json` | 1,906,505 | `0b07f52b69ae4427be5d2a6bd0dd03251cc6c95fda142b2a092f4e6ee5d4ddb3` |
| `_work/map-slice/amboy-textures/blockers.json` | 108,445 | `8bb488f08115b96baee45f1f93942b522a6fc32ac5827f374e8e4209e88548ee` |
| `_work/map-slice/amboy-textures/textures/*.rgba` | 2,675,776 / 189 files | per-file SHA-256 in the MAP3 manifest |

MAP2's `slice.json` draw records still use the pre-READ1 `albedoTexture:null`
schema. The render package takes geometry from those records and binding status
from the MAP3 manifest; it does not merge the READ1 shared-texture *index* into
an image claim.

---

## 2. Package layout

`_work/map-slice/amboy-render/`:

| file | bytes | SHA-256 |
|---|---:|---|
| `render.json` | 1,096,353 | `6d17b65f33b05d94d1d29b08e22c0af4c3855c81bad9298075674d6ead706285` |
| `diagnostics.json` | 497,672 | `b8696505fe46ff82cfcc69a771a9ad313a95e543139eb03f6cf3a75ef1e821c4` |
| `draws.positions.f32.bin` | 6,355,488 | `5d85409b9b838227907eca2d53b34a4d7f37cb6d67158dc596b70bc24dbb2755` |
| `draws.uv0.f32.bin` | 4,236,992 | `200ae62a7c4a3b20c0a0052e5034121c089aa8e52770cb054a22f01f29bffdff` |
| `draws.indices.u32.bin` | 4,187,376 | `f4d77438b7ce99a809280e71b6cd356dedef784f613faf0147bd447c50b41e66` |
| `layout.points.f32.bin` | 104,076 | `935e73575354f993a325e87ba41d4da63892cb21805a2f05ee706071c27f8754` |
| `textures/tex-000.rgba … tex-178.rgba` | 2,654,272 / 179 files | aggregate `79c52fb89d184e26fc5b3fd5b4bf70eb5f90a880a70e0635131897d97987f903` |
| `verify.json` | 1,113 | `c2533b2f42c83a6ee23029711d07b252a27c465bb743e5e8a9a092dae791f0d3` |

`render.json.hashes.files` pins 184 payload files (buffers, layout, diagnostics
and every texture) by size and SHA-256. `verify.json` and `render.json` are
excluded from that list. The manifest content hash is the SHA-256 of the
canonical JSON body excluding `hashes`:

```text
sha256:84cda38df5535ff2d5c8ecc9aa16994db503901bebb91e88d1eff7b875d8e4b5
```

### 2.1 Manifest sections

| key | content |
|---|---|
| `counts` | 1,606 draws, 1,201/405 split, triangles, vertices, texture source/blob counts |
| `buffers` | position/UV0/index records with dtype, stride and package-relative path |
| `textures` | merge groups, byte totals, 16 distinct dimensions, 179 per-blob records |
| `draws` | 1,201 opaque draw records with global index range, `textureId`, `textureSlot`, `uvHash` |
| `diagnostics` | summary + pin of `diagnostics.json` |
| `layout` | spawn, checkpoints, finish, 8,673-point metadata, float32 measurements |
| `uploadContract` | buffers, texture format/bind strategy, pass lists, sRGB/mip policy |
| `hashes` | payload file pins + content hash |

### 2.2 Diagnostics

`diagnostics.json` holds all 405 blocked draws and four labelled groups:

| group | draws | triangles | treatment |
|---|---:|---:|---|
| `effectDecal` | 334 | 56,860 | separate additive/alpha-tested decal list; **not** opaque albedo; aux `g_tTexture` identity + `g_vColour [1,1,0.7,1]` recorded |
| `decoderSize` | 50 | 19,004 | diagnostic only; sources are 1,024–2,048 px and exceed the 512 px decoder bound |
| `alphaRule` | 17 | 3,648 | diagnostic only; BC3 alpha is non-opaque and no alpha rule is declared |
| `runtimeAlbedo` | 4 | 136 | diagnostic only; `g_tAlbedo` is a runtime `DATA_INDEX` parameter |

Every diagnostic entry has `textureBound:false`, `albedoUsed:false`,
`fallback:"none"` and a non-empty source reason. No fallback texture or fallback
colour was invented. The 334 effect ranges are listed separately in
`groups.effectDecal.indexRanges` and index the same uploaded geometry buffer; no
decal index buffer is emitted in v1.

---

## 3. Texture compaction

MAP3 found 186 bindable sources. Seven RGBA payloads are byte-identical across
two resource blocks each, so the package uploads 179 blobs and maps both source
ids to one slot:

| duplicate group | ids |
|---|---|
| `a047ea80…` | `amboy.albedo.500.0`, `amboy.albedo.711.0` |
| `16de3b00…` | `amboy.albedo.501.0`, `amboy.albedo.722.0` |
| `b23fecda…` | `amboy.albedo.502.0`, `amboy.albedo.702.0` |
| `a3973b0c…` | `amboy.albedo.617.0`, `amboy.albedo.660.0` |
| `8419ae2f…` | `amboy.albedo.619.0`, `amboy.albedo.661.0` |
| `417e916c…` | `amboy.albedo.620.0`, `amboy.albedo.659.0` |
| `a784c5ac…` | `amboy.albedo.774.0`, `amboy.albedo.779.0` |

| measure | draw-referenced | unique upload |
|---|---:|---:|
| mip0 RGBA bytes | **2,672,704** | **2,654,272** |
| expected RGBA8 mip chain | **3,564,368** | **3,539,772** |
| bytes saved by merge | — | 18,432 (mip0), 24,596 (chain) |

The expected chain is `Σ max(1,w>>i)·max(1,h>>i)·4` for the source level count,
clamped to the natural chain. All 186 sources have `levels == natural`, so the
clamp never truncates. Dimensions span 16×16 … 512×512 with **16 distinct
sizes**.

Each texture record carries:

- `file`, `bytes`, `sha256`, `fnv1a64`;
- `width`, `height`, `levels`, `format`, `formatName`, raw 10-int `sampler`;
- `alpha` statistics (`alphaOpaque:true` for every uploaded blob);
- `sourceIds` (one or two MAP3 ids), `primaryId`, `drawCount`, `triangleCount`;
- `sourceBlob` and `sourceRgba` evidence pins;
- `srgbHint {colourSpace:"srgb", applied:false}`;
- `mipHint {sourceLevels, decodedLevels:1, generateMips:true, expectedChainBytes, applied:false}`;
- `upload {format:"rgba8unorm", srgbVariant:"rgba8unorm-srgb", bytesMip0}`.

No texture was resized, upscaled, re-coloured or mip-generated.

---

## 4. UV0 and draw integrity

Every draw range is `section.indexOffset + MAP3.firstIndex`, so the merged index
buffer and UV0 buffer are the same byte streams that the MAP2 verifier checks.
For each draw the verifier recomputes the MAP3 FNV-1a 64 hash over the
**referenced UV0 float32 bits**:

```text
for each global index in [firstIndex, firstIndex+indexCount):
    for axis in (u, v):
        fnv1a64_mix(float32_bits(uv0[index*2+axis]))
```

All **1,201/1,201** bindable hashes match the MAP3 manifest, and all 405 blocked
hashes are recomputed and match as well (1,606/1,606 total). Draw counts and
ranges are joined 1,606/1,606 against the slice records with zero mismatches.

Geometry totals:

| item | value |
|---|---:|
| vertices | 529,624 |
| indices | 1,046,844 |
| triangles | 348,948 |
| bindable indices | 807,900 |
| bindable unique vertices referenced | 448,622 |

Positions and UV0 are separate per-vertex buffers; the index buffer is global
and shared by the opaque, decal and diagnostic ranges.

---

## 5. Renderer upload contract

The package is shaped for **one upload**, not one draw call per primitive.

### 5.1 Geometry

| slot | format | count | file |
|---|---|---:|---|
| vertex buffer 0 | `float32x3` position | 529,624 | `draws.positions.f32.bin` |
| vertex buffer 1 | `float32x2` UV0 | 529,624 | `draws.uv0.f32.bin` |
| index buffer | `uint32` | 1,046,844 | `draws.indices.u32.bin` |

- Upload all three buffers once.
- `render.json#draws` is the 1,201-entry opaque draw list. Each entry supplies
  `{firstIndex, indexCount, textureSlot, textureId, uvHash}`.
- `diagnostics.json#groups.effectDecal.indexRanges` is the separate 334-entry
  additive-decal list. It is not mixed into the opaque list.
- `diagnostics.json#draws` holds the remaining 71 diagnostic-only ranges.
- No vertex expansion, remap or batching is required; ranges are already global.

### 5.2 Textures

- 179 RGBA8 mip0 blobs, 2,654,272 B, all alpha-opaque.
- Upload as `rgba8unorm`; the `rgba8unorm-srgb` variant is a **hint**, not an
  applied conversion. `srgbApplied:false` is recorded.
- Mip0 only is decoded. The renderer may generate the chain; the expected chain
  size per texture is recorded (`3,539,772 B` for the unique set).
- Texture dimensions differ (16 distinct sizes), so a single 2D texture array
  would require resizing or atlas packing, which this task did **not** perform.
  Recommended v1 binding: one texture + sampler bind group per `textureSlot`.
- The raw sampler state is recorded per texture; wrap/filter/anisotropy are
  **not** decoded or applied.
- Draws select a texture with `textureSlot`, not by material row.

### 5.3 Passes

| pass | draw list | draws | state |
|---|---|---:|---|
| opaque albedo | `render.json#draws` | 1,201 | real RGBA + real UV0; sRGB/mips are hints only |
| additive decal | `diagnostics.json#groups.effectDecal.indexRanges` | 334 | separate pass; `g_tTexture` + `g_vColour [1,1,0.7,1]`; not opaque albedo |
| diagnostic only | `diagnostics.json#draws` (71 non-decal) | 71 | no texture bound, no invented fallback |

### 5.4 Layout and spawn

`layout.points.f32.bin` is 8,673 points of `float32 x,z,h` (12 B each) and has
the same SHA-256 as the slice layout points
(`935e7357…`). `render.json#layout` carries the spawn
`(x=230.0, z=1128.0, ground=-0.0942, heading=-2.35619449)` and the two
checkpoints. The float32 packing shifts the measured polyline length from
2,060.59538 m to **2,060.610595703125 m** (+0.015215703 m, ~7.4 ppm); the exact
float32 reading and heading (`-2.356331771 rad`, 1.37e-4 rad from the source
value) are recorded instead of pretending they are bit-identical.

---

## 6. Verification

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py probes/map-slice/tools/build_amboy_render.py --out _work/map-slice/amboy-render
& $py probes/map-slice/tools/verify_amboy_render.py --package _work/map-slice/amboy-render
```

`verify_amboy_render.py` independently re-reads:

- the slice and MAP3 inputs, and re-checks their pinned bytes/SHA-256;
- all three geometry buffers against the slice files and every draw range;
- 1,201 UV0 hashes, index ranges and vertex ranges;
- all 405 diagnostics, including the 334-entry decal list, source dimensions,
  BC3 alpha and runtime-parameter classification;
- all 179 RGBA blobs: file hash, FNV-1a 64, dimensions, mip0 length, alpha,
  mip-chain size, MAP3 source-blob pin and source-id merge mapping;
- layout points hash, spawn, checkpoints, finish, float32 length/heading;
- every manifest file pin and the canonical content hash;
- **two fresh builds** in temporary directories, compared file-by-file and by
  aggregate SHA-256.

Result: **17,813 checks, 0 errors, PASS**. The verifier's own `verify.json` is
byte-identical on repeated runs. The two build aggregates are identical:

```text
build 1: 53fba81ba6504704ed3c15fa8a1fbf8f40c11d9d4bf6e4263c8313131ee88d5e
build 2: 53fba81ba6504704ed3c15fa8a1fbf8f40c11d9d4bf6e4263c8313131ee88d5e
```

(The aggregate covers the 184 payload files excluding `render.json`; the fresh
`render.json` is compared byte-for-byte separately.)

### 6.1 Determinism

- No timestamps, random ids, absolute output paths or platform-dependent
  ordering appear in the package.
- Two builder runs produce identical files and identical content hash.
- Two verifier runs produce an identical `verify.json`.
- The 179 texture files are written in sorted source-id order after grouping by
  RGBA SHA-256.

---

## 7. Exact gap to e1 integration

The package is not wired into e1-drive. To render Amboy the page still needs:

1. **Map registry / route.** `e1-drive` builds its `LEVEL` path, geometry packet
   and sprint layout from River. There is no `?map=amboy` branch and no map-id
   selection.
2. **Packet producer.** No code converts `render.json` into the e1 packet v1.1
   shape (or an equivalent typed-array packet). The producer must upload the two
   vertex buffers and one index buffer once, create 179 texture bind groups from
   `textures/tex-*.rgba`, and emit the 1,201-entry draw list.
3. **Upload/pipeline.** No WebGPU upload, sampler creation, sRGB view, mip
   generation, shader variant or pipeline state exists for Amboy. The contract
   says `rgba8unorm` + optional sRGB variant; the renderer must decide and record
   which one it uses. No per-texture array/atlas exists because the 179 blobs
   have 16 different sizes.
4. **Blocked passes.** The renderer must either skip the 334 effect-layer draws,
   or implement the separate additive/alpha-tested decal pass using the recorded
   `g_tTexture` and `g_vColour`. It must not bind them as opaque albedo. The 71
   decoder/alpha/runtime draws have no texture bound; the renderer must label
   them diagnostic rather than silently substituting a texture.
5. **Normals.** There are no decoded vertex normals. Shading needs a reader
   change or an explicit, documented geometric-normal fallback; this package
   does not invent one.
6. **Geometry coverage.** 27 `BillBoard_LN` sections stop at POSITION type 7 and
   366 instance descriptions are skipped (`instancesApplied:false`). Instance-
   only geometry and the unsupported billboards can add surfaces.
7. **Physics/collision.** The package does not copy collision. The existing
   slice + `Level.levelphysics` remain the physics inputs; the Box, four
   Cylinders and the `InstancedTriangleMesh` are still outside the triangle
   package.
8. **Spawn/layout/race.** Spawn and course are derived from the measured path,
   not a retail start line; there is no lap, respawn, gate trigger or race
   director.
9. **Evidence.** No frame, screenshot, console capture or GPU timing exists for
   Amboy. A visual claim requires the packet producer, upload, screenshot and a
   clean console.

---

## 8. Limits

1. Data only: no renderer, GPU, browser, playable-game or full-game claim.
2. The three geometry buffers are byte-identical to the MAP2 slice; blocked
   indices remain in the shared buffer but are only reachable through the
   diagnostic/decal lists.
3. Texture pixels are the committed CPU BC decode of mip0; alpha, blend, shader
   stages, sampler wrap/filter, mip generation and sRGB conversion are not
   applied.
4. `srgbHint` and `mipHint` are contract hints, not a GPU result.
5. The effect layer is identified by static source evidence; no additive pass is
   implemented here.
6. The 27 billboard sections and 366 instances remain geometry-reader blockers.
7. The float32 layout binary shifts the measured length by +0.0152 m and the
   heading by 1.37e-4 rad; both exact values are recorded.
8. No fallback texture was invented and no unknown format was guessed.

---

## 9. Evidence

| path | content |
|---|---|
| `_work/map-slice/amboy-render/render.json` | manifest, 1,201 draws, 179 textures, layout, upload contract |
| `_work/map-slice/amboy-render/diagnostics.json` | 405 blocked draws + separate 334-draw decal list |
| `_work/map-slice/amboy-render/*.bin` | byte-identical slice geometry + float32 layout points |
| `_work/map-slice/amboy-render/textures/*.rgba` | 179 merged RGBA8 mip0 blobs |
| `_work/map-slice/amboy-render/verify.json` | 17,813-check verifier, PASS |
| `_work/logs/map-slice/amboy-render-build.log` | build log |
| `_work/logs/map-slice/amboy-render-verify.log` | verifier log |
| `probes/map-slice/tools/build_amboy_render.py` | package builder |
| `probes/map-slice/tools/verify_amboy_render.py` | independent verifier |

No file under `probes/e1-drive`, `probes/asset-reader`,
`probes/map-pipeline`, `tools/`, `upstream/` or `game-data/` was modified.
