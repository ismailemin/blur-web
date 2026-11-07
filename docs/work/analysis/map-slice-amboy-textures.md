# `usa_amboy` direct-draw albedo + UV0 binding study (MAP3)

**Date:** 7 November 2026
**Owner:** MAP3 (sub-agent)
**Scope:** additions under `probes/map-slice/` and `_work/map-slice/amboy-textures/`,
logs under `_work/logs/map-slice/`, and this document. No change to
`probes/e1-drive`, `probes/map-pipeline`, `probes/asset-reader`, the engine,
`tools/`, `upstream/` or `game-data/`. **Data/analysis only: no renderer, GPU,
browser, playable-game or full-game claim, and no invented texture.**

---

## 0. Result

| item | measured value |
|---|---|
| direct draws / triangles | **1,606 / 348,948** (48 sections) |
| draws whose material stack resolves a static `g_tAlbedo` | **1,268 / 291,952 tri** |
| **bindable real static albedo + UV0 today** | **1,201 draws / 269,300 triangles (74.8 % / 77.2 %)** |
| blocked | **405 draws / 79,648 tri** |
| distinct texture sources | **195** (187 resource-block + 8 shared) |
| decoded by the committed decoder | **189 of 195** (186 DXT1/BC1 + 3 DXT5/BC3; 6 exceed 512 px) |
| bindable texture sources | **186** |
| RGBA bytes | **2,675,776** total; **2,672,704** bindable |
| UV0 hashes recomputed | **1,606 / 1,606**; 0 missing |
| manifest | `_work/map-slice/amboy-textures/bindings.json`, 1,906,505 B, SHA-256 `0b07f52b69ae4427be5d2a6bd0dd03251cc6c95fda142b2a092f4e6ee5d4ddb3` |
| blocker report | `_work/map-slice/amboy-textures/blockers.json`, SHA-256 `8bb488f08115b96baee45f1f93942b522a6fc32ac5827f374e8e4209e88548ee` |
| verifier | **13,090 checks, 0 failures, PASS**; repeat build byte-identical after normalising only the output-directory path |
| unsupported 27 sections | **geometry-reader blocker**, texture side resolves for **27/27** |
| 366 skipped instances | **geometry-reader blocker**, static albedo **366/366**, UV0 declared **366/366** |

**Answer:** yes — 1,201 of the 1,606 direct draws can bind a real static albedo
image with the committed BC decoder and their original UV0 today. The remaining
405 are blocked for four distinct, labelled reasons, none of which is a missing
UV0 stream. This is **data-level bindability**: the native JSON export currently
discards the resolved identity, so the renderer must either consume this
manifest or the reader export must be extended (Section 8).

---

## 1. Why MAP2 saw `albedoTexture:null` on 1,606/1,606

The committed direct-draw reader **does** run material binding, but its JSON
printer discards the result.

| source location | behaviour |
|---|---|
| `probes/asset-reader/src/scene_reader.cpp` `geometry()` (lines 564–601) | calls `draw.uv_available = draw_uv_available(...)` and `bind_albedo(p, draw)` for every emitted direct primitive |
| `bind_albedo()` (lines 523–562) | applies instance → base → every active stream material, follows nested type-8 rows, last `g_tAlbedo`/`g_MeshTexture` wins; for a shared texture it sets `draw.albedo`; for a resource-block texture it sets `draw.resource_block` / `draw.resource_index`; it also sets `material_row` and `material` |
| `level_mesh()` JSON printer (lines 753–754) | emits the literal `"albedoTexture":null` and `"binding":"Level materials not applied in diagnostic preview"` for every draw and never prints `draw.albedo`, `draw.resource_block`, `draw.resource_index`, `draw.material_row` or `draw.material` |

So the correct statement is: **the material-binding path exists in the committed
reader code, but the direct-draw export hard-codes the diagnostic values.** This
supersedes the sentence “the direct-draw reader has no committed material-binding
path for base primitives” in `map-slice-amboy.md` §3.1.

The other MAP2 attempts failed for unrelated, non-material reasons:

- `scene_inspect --resources` requires a `Model` container; a levelrender starts
  as a level FileBlock graph, so it returns `Expected Model container at byte 20`
  (node and geometry chunks return `Unsupported archive signature at byte 0`).
  It is not evidence that the level has no materials. Log:
  `_work/logs/map-slice/amboy-scene-reader.log`.
- `level_inspect --instances-all` was run with a single geometry chunk; every
  instance in the three instance sections binds a different resource block, so
  the reader correctly reports `omittedOtherBlockInstances`.

### 1.1 Validation of the resolution used here

The manifest is produced by a source-shaped Python replica of `bind_albedo()`
order, not by guessing. It was cross-checked against committed external records:

| cross-check | result |
|---|---|
| River `g88-n283` direct primitives vs P30’s “255/255 carry static `g_tAlbedo`” | **255/255 static**, 0 runtime, 0 missing |
| River `node253` 22 instance draws vs P73a `level-instance-textures.json` | **22/22** material row, material type, resource block/index identical |
| River `block359/index0` texture blob reconstruction vs P47 `tex-359-0.raw` | **byte-identical**, SHA-256 `811f3fe8c578ff5e2f3826001c9dfd15da088bf96061a0c28268633e87c91f62` |

---

## 2. Method

1. Read `_work/map-slice/amboy/slice.json`; for each of the 48 supported sections
   read the committed map-pipeline stage (`node.chunk`, `geometry.chunk`,
   `native.json`, `reference.json`).
2. Parse the node chunk with the committed `tools/inspect_car_level_assets.py` /
   `tools/inspect_level_instances.py` modules: first RenderList direct
   primitives, constant material rows, texture-source table.
3. Resolve the material stack in the same order as `scene_reader.cpp`
   (`instanceMaterial → baseMaterial → every active stream`, nested type-8
   recursion, last `g_tAlbedo` wins).
4. Map each emitted draw to its source primitive with the same filter as
   `level_mesh()`: VB and IB block must equal the selected geometry block; LOD0;
   strips/lists counted with the same nondegenerate rule. The result is checked
   against both `reference.json` and `native.json` (draw count, primitive index,
   `firstIndex`, `indexCount`).
5. Recompute each draw’s FNV-1a 64 UV0 hash from `native.json` `uv0` and
   `indices`, exactly like the P45/P47 stream hash.
6. Resolve the texture source:
   - shared (`block == -1`) → levelrender Scene shared-texture list (`dataOffset`
     / `dataBytes`);
   - resource block → the `level.levelstream` ChunkInfo record, parse every
     preceding resource item, take the texture LOD0 descriptor and reconstruct
     `28-byte descriptor + texel payload`.
7. Decode each blob with the committed
   `_work/build/asset-reader-native/Release/texture_inspect.exe --raw`; hash the
   RGBA (SHA-256 + FNV-1a 64), record dimensions, format and alpha statistics.
8. Classify per draw. A draw is `bindable-static-albedo` only if the material
   resolves `g_tAlbedo`, the source is found, the decoder accepts it, its alpha
   is fully opaque, and the UV0 hash exists.

The blob reconstruction method was validated against the P47 River blob (table
above); the 28-byte descriptor + payload byte layout is therefore the same one
used by the already-proven track and car texture packs.

---

## 3. Binding result

### 3.1 Status split

| status | draws | triangles | reason |
|---|---:|---:|---|
| `bindable-static-albedo` | **1,201** | **269,300** | static `g_tAlbedo`, decoded image, opaque alpha, UV0 present |
| `blocked-effect-not-static-albedo` | 334 | 56,860 | `Racification*` additive layer exposes `g_tTexture`, not `g_tAlbedo` |
| `blocked-decoder-size-limit` | 50 | 19,004 | source is 1,024–2,048 px wide/tall; committed decoder is bounded to ≤512×512 |
| `blocked-alpha-rule-missing` | 17 | 3,648 | BC3 source with non-opaque alpha; no alpha-test/blend rule is declared |
| `blocked-runtime-albedo-parameter` | 4 | 136 | `Advert_LN_NV` `g_tAlbedo` is serialised type 9 (runtime `DATA_INDEX`) |
| **total** | **1,606** | **348,948** | |

Note: 1,268 draws resolve a static `g_tAlbedo` (269,300 + 19,004 + 3,648 tri).
The difference between 1,268 and 1,201 is exactly the decoder-size and alpha
blockers, not a material-resolution failure.

### 3.2 Bindable texture sources

| bucket | sources | RGBA bytes |
|---|---:|---:|
| resource-block `amboy.albedo.<block>.<index>` | 182 bindable of 187 | 575,552 bindable of 578,624 |
| shared `amboy.shared.<index>` | 4 bindable of 8 | 2,097,152 bindable of 2,097,152 |
| **bindable total** | **186** | **2,672,704** |
| non-bindable | 9 | 3,072 decoded + 6 undecoded |

All decoded images are DXT1/BC1 or DXT5/BC3 at the retail mip0 resolution
(16×16 … 512×512 for the bindable set). No upscale, mip chain or invented detail
is used. The largest bindable images by bytes are `bigbarrel01_diff` (512×512,
6 draws / 1,196 tri), `bigbarrel03_diff` (256×512, 2 / 144),
`drilltowertexture01_diff` (256×256, 27 / 15,267) and
`bigbarrelwoodbase01_diff` (512×128, 22 / 9,380); the highest-triangle bindable
image is `naturalbarrier1_diff` (512×16, 81 / 18,954).

The most-shared bindable source by draw count is `rocks01_diff`
(`amboy.albedo.866.0`, 219 draws / 27,212 tri), followed by
`naturalbarrier1_diff` (`858:0`, 81 / 18,954) and `desertroad01_diff`
(`854:0`, 74 / 9,476).

### 3.3 Per-section split

The full 48-row table is in `bindings.json.sections`. Sections with no bindable
draws are the effect-layer corridors (`g79-n288`, `g97-n266`, `g101-n288`,
`g108-n288`, `g130-n266`, `g147-n266`, `g149-n288`, `g160-n266`), the
decoder-size section `g167-n168` (1 draw), and the three instance sections’
direct draws, which are alpha-blocked vegetation/imposters (`g54-n184`,
`g237-n238`, `g251-n252`). All other sections are mostly or wholly bindable; the
largest single blocked group is the road-marking/armco decal set which is
intentionally not treated as albedo.

### 3.4 UV0

All 1,606 draws report `uv0Available:true` in `native.json`; all 1,606
FNV-1a 64 hashes were recomputed from the original index ranges and match the
manifest. There is **no UV0 blocker** anywhere in this study.

---

## 4. Blocked groups and exact evidence

### 4.1 `Racification` / `RacificationDLayer` (334 draws / 56,860 tri)

The shader source is `upstream/BlurRebuilt/code/amax/game/Shaders/Racification/Racification.fx`:

- texture parameter `g_tTexture`, not `g_tAlbedo`;
- `real4 texColour * input.m_vColour`, `rgb *= a`;
- `AlphaBlendEnable = TRUE`, `AlphaTestEnable = TRUE`, `SrcBlend = One`,
  `DestBlend = InvSrcAlpha`, `ZWriteEnable = FALSE` in the default pass.

It is an additive, alpha-tested decal/line layer, not a base albedo. Binding its
`g_tTexture` as an opaque albedo would be a semantic error. The static sources
are recorded as `auxTexture` (no RGBA binding claim):

| effect | aux source | draws |
|---|---|---:|
| `Racification_LN` | `whiteline_diff` (`869:0`) | 257 |
| `Racification_LN` | `wackymagicarmco_diff` (`827:0`) | 33 |
| `Racification_LN` | `blackline_diff` (`821:0`) | 32 |
| `RacificationDLayer_LN` | `blackline_diff` (`821:0`) | 7 |
| `Racification_LN` | `startfinisharch_diff` (`444:0`) | 2 |
| `Racification_LN` | `startfinishbanner_diff` (`445:0`) | 2 |
| `Racification_LN` | `wackymagicarmcosortingfix_diff` (`348:0`) | 1 |

The only recovered static fallback colour is the layer’s `g_vColour`
`[1, 1, 0.7, 1]` (and `g_vColourFresnel` the same). It is a source constant, not
an albedo.

### 4.2 Decoder size bound (50 draws / 19,004 tri)

| source | name | size | format | draws | tri |
|---|---|---|---:|---:|---:|
| `amboy.shared.13` | `barrelbase02_diff` | 1024×256 | BC1 | 31 | 4,885 |
| `amboy.shared.15` | `barrelbase03_diff` | 2048×1024 | BC1 | 8 | 1,102 |
| `amboy.shared.17` | `gate01_diff` | 1024×512 | BC1 | 2 | 16 |
| `amboy.shared.24` | `oilderek01_diff` | 1024×1024 | BC1 | 7 | 12,978 |
| `amboy.albedo.518.0` | `farground02_diff` | 1024×128 | BC1 | 1 | 17 |
| `amboy.albedo.546.0` | `vista01_diff` | 2048×128 | BC3 | 1 | 6 |

`texture_inspect` documents and enforces 2D textures up to 512×512
(`probes/asset-reader/FORMAT-texture.md`). These six images are the only reason
these 50 draws are not bound; the descriptor and texel blobs are complete and
recorded in `raw/`. A bounded decoder extension (or a size-limited mip0 path)
would make 49 BC1 draws decodable; their alpha still has to be checked, and the
BC3 `vista01_diff` still needs an alpha decision.

### 4.3 BC3 alpha (17 draws / 3,648 tri)

| source | name | size | alpha min/max/distinct | draws | tri |
|---|---|---|---:|---:|---:|
| `amboy.albedo.761.0` | `crowdatlas_imposters_0_0` | 16×16 | 0 / 174 / 78 | 9 | 2,848 |
| `amboy.albedo.860.0` | `drydesertbush01_diff` | 16×16 | 0 / 246 / 71 | 4 | 448 |
| `amboy.albedo.729.0` | `drydesertbush02_diff` | 16×16 | 0 / 254 / 66 | 4 | 352 |

These are vegetation/imposter atlases. The proven track/car consumer uploads
`rgba8unorm` and applies no alpha test or blend; binding them opaque would show
the atlas background. They stay labelled until an alpha rule is declared.

### 4.4 Runtime albedo (4 draws / 136 tri)

`Advert_LN_NV` rows serialise `g_tAlbedo` as material element type 9
(`DATA_INDEX`), which `scene_reader.cpp` explicitly treats as runtime-only.
There is no static image to decode. Draws are `g143-n284` (2) and `g261-n262`
(2).

---

## 5. The 27 unsupported sections: geometry, not texture

Every one of the 27 stops at the **same** source shape:

| field | value |
|---|---|
| effect | `BillBoard_LN` |
| failing element | `POSITION0`, stream 0, offset 0, **type 7**, method 0 |
| vertex stride | **28** |
| other elements | UV0 type 8 @16, type 8 @20 (usage 5 / index 3), type 11 @24 (usage 9) |
| committed reader rule | accepts POSITION type 6 (F32_3) or 9 (F16_4), method 0 |
| material | **static `g_tAlbedo` resolved for every in-scope primitive in all 27 sections** (27/27 `textureSideResolved`) |

The native error is therefore a **geometry-reader blocker**: the billboard
vertex format uses POSITION type 7, whose byte width is not documented in this
repository, so this study does not guess it. The texture side is already
resolvable; after a bounded type-7 reader extension, these sections could bind
the same way as the 1,201 draws. The 27 native byte offsets are preserved in
`blockers.json.unsupportedSections.sections[].nativeByteOffset`.

The reader stops at the first billboard primitive, so non-billboard primitives
later in those sections are not emitted either. This is a reader traversal
limit, not a material absence.

---

## 6. The 366 skipped instances: geometry, not texture

| section | instances | static `g_tAlbedo` | UV0 declared | referenced blocks | first-in-record blocks |
|---|---:|---:|---:|---:|---:|
| `g54-n184` | 262 | 262 | 262 | 32 | 9 |
| `g237-n238` | 40 | 40 | 40 | 18 | 3 |
| `g251-n252` | 64 | 64 | 64 | 16 | 2 |
| **total** | **366** | **366** | **366** | 66 (with repeats) | 14 |

- The material stack of all 366 instances resolves a static `g_tAlbedo`
  (`default_skin_LN_NB_NL_NM_NV.fx` 316, `default_skin_LN_NB_NL_NV.fx` 50).
- All 366 declare UV0 `usage 5 / usageIndex 0`; the declaration is present even
  though this package does not export instance UV0.
- The committed single-chunk `--instances-all` emits **0** for every section and
  reports **262 / 40 / 64 `omittedOtherBlockInstances`**.
- Supplying the 9 / 3 / 2 first-in-record chunks to `--instances-bundle`:
  - `g54-n184`, `g237-n238`: error
    `Selected geometry chunk needs additional prerequisites`;
  - `g251-n252`: status ok, **0 emitted**, 52 other-block, 12
    `unsupportedBoundsInstances` (grouped constant-affine bounds check).
- 23 of the 32 `g54-n184` referenced blocks are not the first item of their
  stream chunk, and many chunks carry prerequisites; the bounded reader accepts
  only a chunk whose first LOD0 item is the requested block and with no
  prerequisites.

Upper-bound instance geometry from the base-primitive LOD0 index counts:
**491,847 triangles** (strip `indexCount − 2`, before degenerates). This is a
large geometry opportunity, but it is not emitted or textured by this task.

**Classification:** texture side ready (static albedo + UV0 declaration),
**geometry-reader blocker** (other-block bindings, chunk selection/prerequisite
policy, grouped bounds). It is not a texture blocker.

---

## 7. Labelled fallback proposal (no invented textures)

The renderer must carry a per-draw fallback label; silent substitution is not
acceptable.

| group | draws | proposal |
|---|---:|---|
| bindable | 1,201 | bind the real RGBA image with the real UV0; no fallback |
| `Racification*` | 334 | **skip** the layer with `diagnosticEffectLayerSkipped:true`, or later add a separate additive-decal pass using the recorded `g_tTexture` + `g_vColour [1,1,0.7,1]` + the shader’s declared blend. Do **not** bind it as opaque albedo. |
| decoder-size | 50 | neutral diagnostic colour (`diagnosticFallback:"neutral"`, `textureBound:false`); or wireframe. A section material colour is **not** exposed by the committed readers for these base draws, so none is invented. |
| BC3 alpha | 17 | same neutral fallback, or skip until an alpha-test rule is declared. |
| runtime albedo | 4 | same neutral fallback; the runtime parameter is not recoverable. |

A neutral colour is a **documented constant**, not a recovered material value;
the manifest already records the exact reason per draw. If a later reader pass
recovers section material colour, it can replace the neutral constant for those
draws only, with the same `diagnosticFallback` marker.

---

## 8. Next concrete binding step for the renderer

1. **Export the fields the reader already computes.** In a separate reader task,
   replace the hard-coded `albedoTexture:null` block in
   `scene_reader.cpp:753-754` with `draw.albedo`, `resourceBlock`,
   `resourceIndex`, `albedoParameter`, `materialRow` and `material`, plus a
   `bindingStatus`/`uvHash` pair. No new format work is needed for the 1,201
   draws.
2. **Packet producer.** For `?map=amboy`, consume the manifest or the extended
   reader output: upload the 186 RGBA8 mip0 images, select the per-draw
   `textureId`, and reuse the existing `draws.uv0.f32.bin` stream and the
   proven `rgba8unorm`/per-draw texture path. No new shader or pass is required
   for the 1,201 bindable draws.
3. **Reader extensions, in value order:**
   - type-7 `BillBoard_LN` position decoding (27 sections; texture side ready);
   - decoder bound >512 for six textures (50 draws);
   - alpha-test rule for three BC3 imposters (17 draws);
   - multi-block instance bundle with prerequisites and grouped bounds
     (366 instances).
4. **Gates before any visual claim:** the packet counts/UV/RGBA hashes must
   match this manifest, then a browser screenshot with a clean console. This
   study itself does not produce a frame.

---

## 9. Limits

1. Data only; no renderer, GPU, browser, playable-game or full-game claim.
2. Static `g_tAlbedo`/`g_MeshTexture` identity and UV0 only. `g_tMaterial`,
   material colour, blend state, alpha test, shader stages, sampler wrap/filter,
   mip selection and sRGB are not applied.
3. The committed decoder is bounded to 2D ≤512×512; six source images are
   larger and remain undecoded here.
4. RGBA hashes are the committed CPU BC decode of mip0, not a GPU/sRGB result.
5. First-RenderList direct LOD0 only; instances and the 27 billboard sections
   are analysed separately and not emitted.
6. No visibility, occlusion, LOD selection, streaming or batching is evaluated.
7. Texture files under `_work/` are generated game data and are not committed.

---

## 10. Commands and evidence

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py probes/map-slice/tools/amboy_texture_bindings.py
& $py probes/map-slice/tools/amboy_blocker_report.py
& $py probes/map-slice/tools/verify_amboy_texture_bindings.py
& $py tools/verify_asset_probe.py --skip-build
```

Inputs (read-only), SHA-256:

| input | bytes | SHA-256 |
|---|---:|---|
| `game-data/Blur/levels/usa_amboy/level.levelrender` | 11,263,032 | `796c9289e224a6c15aff75b929eca875ef03d4d91b015f67aba704de1f9a3ea7` |
| `game-data/Blur/levels/usa_amboy/Level.levelstream` | 331,728,896 | `09eb81f42879e1608fab3753de0bbbbb23c549c5098133ac1c31e40e0876c9e8` |
| `_work/map-slice/amboy/slice.json` | 1,629,475 | `f6f8ae85970cbc8ffc2559460673872db6e462ead20584cd19db95672bf5cd45` |
| `_work/map-slice/amboy/draws.uv0.f32.bin` | 4,236,992 | `200ae62a7c4a3b20c0a0052e5034121c089aa8e52770cb054a22f01f29bffdff` |
| `texture_inspect.exe` | 57,856 | `745e80981b180bf9e9c3d7bf92597636cb919a28ce013ebf531495aec15e2427` |

Artifacts:

| path | bytes | SHA-256 |
|---|---:|---|
| `_work/map-slice/amboy-textures/bindings.json` | 1,906,505 | `0b07f52b69ae4427be5d2a6bd0dd03251cc6c95fda142b2a092f4e6ee5d4ddb3` |
| `_work/map-slice/amboy-textures/summary.json` | 58,414 | `421096e1a585e373ab5c642009df6f8265f797f47b1bf88a380da788e8e7762b` |
| `_work/map-slice/amboy-textures/blockers.json` | 108,445 | `8bb488f08115b96baee45f1f93942b522a6fc32ac5827f374e8e4209e88548ee` |
| `_work/map-slice/amboy-textures/verify.json` | 1,200,238 | `a0efc53e60f47d072b66044900f148ac2b5ca51a29113021313e89261ec3bc6d` |
| `_work/map-slice/amboy-textures/raw/*.raw` | 195 files / 3,515,180 B | per-file SHA-256 in the manifest |
| `_work/map-slice/amboy-textures/textures/*.rgba` | 189 files / 2,675,776 B | per-file SHA-256 in the manifest |
| `_work/map-slice/amboy-textures/instance-native/*.json` | 6 files | native `--instances-all` / `--instances-bundle` outputs |

Tools:

| path | SHA-256 |
|---|---|
| `probes/map-slice/tools/amboy_texture_bindings.py` | `848401e0f52da66456f4ee5abe1461d0e103c59ca09a3e6eea32b3fa03a0cf7d` |
| `probes/map-slice/tools/amboy_blocker_report.py` | `945cb660c7ccd9db33764a80f9f7c6153dd5eb7488647355092949781439cf90` |
| `probes/map-slice/tools/verify_amboy_texture_bindings.py` | `f51c63b7afe61e73e7c9dfb4a96660b6878599d9828a5848aaa642a60ff28afb` |

Logs: `_work/logs/map-slice/amboy-textures-extract.log`,
`amboy-blockers.log`, `amboy-textures-verify.log`,
`amboy-resolver-crosscheck.log`, `amboy-scene-reader.log`,
`asset-probe-skip-build.log`.

Repository gate: `python tools/verify_asset_probe.py --skip-build` →
**39 checks PASS**, including `map-slice-amboy`.

**No renderer/GPU/browser claim, no invented texture, no e1-drive change.**
