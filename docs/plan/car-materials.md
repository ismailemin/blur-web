# Corvette material and UV binding evidence

Inspected source revision `5270304b81983b9e3edbd569ba25235c17bbabd7`, without modifying it. The diagnostic consumes the actual decoded `corvette_c3_race.model` (3,169,212 bytes, SHA-256 `77840511e5ca416ff9e7cbdc9ee9fc960fce0205f83c9be77e0803607c32cb9d`).

`tools/inspect_car_materials.py` now parses the complete seven resource blocks, all their texture LOD descriptors/buffers, the first render list's constant/dynamic material input tables, its 80 primitive descriptions and source lists. The exact resource traversal ends at the original Scene boundary. It writes bounded per-draw evidence and original UV values under `_work/car-materials/`; these are local artifacts, not distributed game data.

## Why the body has no ordinary diffuse image

The `_a` suffix means **`_NO_ALBEDO`**, not “enable albedo”. This is explicit in `graphics/vehicle/shaders.jam:29`. The first four draws use `veh_Paint_a_b_c.fx`: those shaders deliberately do not read `g_MeshTexture`. Their constant stream material provides dent/scratch textures, which must not be mistaken for paint colour.

For paint, `vehicle_common.h` evaluates a shared **runtime** `g_sPaintMaterialTexture` at `(NdotV,0)`, then uses that value in `EvaluateSurfaceColour`. `VehicleModelManager.cpp` exposes the texture pointer and `VehicleModel.cpp` supplies it from `m_PaintJob.GetMaterialTexture()`. `customisation/PaintEditor.cpp::C_PaintJob::UpdateMaterialTexture` builds the lookup from paint colour/reflectivity state.

The car model alone does not identify the user's selected paint job or provide a finished runtime lookup. Both `runtimePaintColourRecovered` and `runtimePaintTextureRecovered` are therefore **false**. No colour was invented or inferred from the first shared texture.

## Actual draw classifications

The independent report contains exactly 80 direct LOD0 draw descriptions:

| Classification | Draws | Meaning |
| --- | ---: | --- |
| `shader_no_albedo` | 44 | `_a` variant: no ordinary albedo sample. Six are paint-family draws requiring the runtime lookup. |
| `static_albedo_image_resolved` | 26 | The original scalar `g_MeshTexture` assignment and its texture source are known, and the draw has a valid original UV0 binding. |
| `runtime_light_blend` | 10 | Off/on texture inputs are known, but original appearance blends UV0.xy/zw samples using runtime `g_vRenderColour.w`. |

`completeOriginalMaterialReproduced` remains false for every draw. Resolving an original input image does not reproduce lighting, reflection, colour interpolation, alpha behavior, damage, transforms or the complete shader.

The 26 statically resolved ordinary albedo inputs are:

| Original texture | Source | Draw indices |
| --- | --- | --- |
| `corvetterace_interior` | Resource block6, texture0 | 6,15–20,61,65,66 |
| `breakdisc` | Shared texture6 | 11–14 |
| `corvetterace_dials` | Resource block2, texture0 | 21,79 |
| `spain01` | Shared texture2 | 22,23 |
| `tyretred` | Shared texture3 | 36,39,40,43 |
| `tyrewall` | Shared texture5 | 37,38,41,42 |

These names and resource indices are decoded values, not filename guesses. The material field is **`g_MeshTexture`**, unlike ordinary prop shaders' `g_tAlbedo`.

## Material order and runtime recipes

The source applies primitive instance material, then base material, then each primitive stream material in serialized order. `Context::SetPrimitiveStream` can still apply a material when its vertex buffer is an absent zero-size placeholder. Therefore geometry's selected POSITION stream cannot also be assumed to hold every relevant material assignment.

For the first Corvette draw:

- POSITION stream slot0 uses node VB0 → resource block0/global VB2, stride32, byte offset119616.
- Stream slots3 and1 use node VB1 → source `(-1,-1)`, an absent placeholder.
- Slot0 material1 supplies dent/scratch textures; slot3 material2 is empty; slot1 material3 supplies `DATA_INDEX` references for local SH node and code damage scale.
- The base material is list1/index0. Serialized list1 contains `Element` and `AnimatedParam` input recipes. `C_Model::BuildDynamicMaterialList` rebuilds a different list for world matrices/exposed parameters at runtime. Treating `Element.Index=2` as ready paint or albedo values would be wrong.

The tool traces all ordered direct constant calls, recursively handles constant `MATERIAL_INDEX`, retains `DATA_INDEX` as unknown runtime values, and does not guess carried shader state when an albedo assignment is absent.

## UV0 support must be per draw

Used global vertex buffers0..9 hold30,591 positions. Buffers0,3,5 have **no UV0**, covering12,636 vertices; this is legal because those shader declarations do not require an ordinary albedo sample. Buffer10 is also missing UV0 but is not used by these direct body draws.

Other used buffers1,2,4,6,7,8,9 have original **F16_4 TEXCOORD0** at offset12. Preserve `.xy` as ordinary albedo UV0, and preserve `.zw` separately if light/damage shaders are implemented. No V flip or arbitrary rescale is applied. The diagnostic checks the declaration's stream/offset/type against the bound buffer, applies its byte offset divided by stride, and computes bounds from the actual LOD0 indexed vertices.

Every one of the 26 statically textured draws has a valid UV0 binding. The C++ Scene reader now retains all17,955 original UV pairs and inserts exactly12,636 zero placeholder pairs for used buffers without UV0. `uv0Available` remains a per-draw declaration/buffer check: placeholder pairs never authorize a texture binding. This preserves position/UV buffer alignment while allowing the supported subset to render with its actual mapping.

`corvette-uv0.json` preserves actual pairs, bounds and canonical F32LE hashes per buffer. It deliberately omits UV arrays for formats without that semantic.

## Resource texture LOD warning

Block textures differ from shared textures. Their descriptors and texels are not contiguous in the archive: a descriptor is followed by an archive buffer envelope/alignment. The initial LOD0 contains a complete small mip chain (for example interior16×16BC1,184texel bytes). Later populated LODs often contain **only the new top mip**, although the descriptor describes the enlarged complete chain. Source `Target::Deserialise(Texture::LodReader)` loads new texels and copies existing lower mips from the front texture.

Do not pass a later descriptor plus its new-mip buffer directly to a decoder expecting the complete chain. Either reconstruct the source mip chain faithfully or initially use the complete LOD0 descriptor/texels, labeled as that source LOD. The report preserves every LOD's descriptor/data offsets, sizes and paired-source metadata.

## Reproduction and validation

From the workspace root, with the installed bundled Python:

```powershell
python tools/inspect_car_materials.py
```

Outputs:

- `_work/car-materials/corvette-materials.raw.json`: complete sequentially parsed material/resource evidence.
- `_work/car-materials/corvette-materials.json`: 80 bounded per-draw classifications, ordered material calls, exact static texture sources and unsupported/runtime reasons.
- `_work/car-materials/corvette-uv0.json`: original UV0 values and hashes per buffer.

The independent diagnostic parses the real file to its exact Scene end; all26 resolved texture indices and UV/index ranges validate. Two consecutive outputs were deterministic. Truncation inside the Model container and a corrupted PC marker are rejected. Unrelated trailing MtaDbg metadata is outside this diagnostic's scope. The diagnostic itself does not modify C++, browser, source or game files.

The subsequent C++ integration recognizes `g_MeshTexture`, ordered instance/base/all-active-stream materials, recursive constant `MATERIAL_INDEX`, and unknown runtime overrides. It binds only the14 direct draws whose static albedo is a shared image (`breakdisc`, `spain01`, `tyretred`, `tyrewall`). The12 other static image draws still report unsupported external resource textures; paint and light blends remain explicitly unimplemented. Native synthetic tests cover material order, missing auxiliary buffers, recursive references, runtime invalidation, declaration mismatches and mixed UV availability; the real-car mode is `scene_reader_tests.exe --car <decoded-model>`.

`probes/asset-reader/tests/verify_car_wasm.mjs` additionally compares complete native/WASM JSON against independent Python geometry, material and UV reports. It checks every original UV pair and per-buffer F32 hash, all80 draw availability flags, exact14 shared image names/indices/byte ranges,12 unsupported external-image draws, zero placeholders, and false runtime-paint claims. Large equality failures use bounded messages. Run it after regenerating both native and WASM binaries:

```powershell
node probes/asset-reader/tests/verify_car_wasm.mjs
```

Its successful result is written to `_work/verification/car-native-wasm.json`; merely updating this test or building C++ does not establish native/WASM agreement.

## Source authority

Relative to `upstream/BlurRebuilt/code/mercury/library/`:

- `graphics/vehicle/shaders.jam`: `_a`→`_NO_ALBEDO` and other feature variants.
- `graphics/vehicle/include/vehicle/shaders/vehicle_common.h`: `g_MeshTexture`, UV0 F16_4, MeshTextureSampler, `.xy` sampling, light off/on `.xy/.zw`, paint lookup and surface colour formulas.
- `graphics/vehicle/source/VehicleModelManager.cpp`: exposed runtime texture/colour parameters.
- `graphics/vehicle/source/VehicleModel.cpp`: runtime paint texture pointer from the paint job.
- `graphics/vehicle/source/customisation/PaintEditor.cpp`: lookup generation from paint state.
- `graphics/world_render/source/RenderModelData.cpp`: `ReadMaterialInput`, `GetDynamicMaterialInput`, `BuildDynamicMaterialList`; serialized input recipes are rebuilt at runtime.
- `graphics/renderingdata/source/noninterface/target/context.cpp`: `RenderPrimitive`, `SetPrimitive`, `SetPrimitiveStream`, `SetMaterial`; application order, texture source lookup and runtime material references.
- `graphics/renderingdata/source/noninterface/target/archive.cpp`: RenderList tail, texture LOD descriptor/buffer loading and lower-mip copying.
- `graphics/renderingdata/include/renderingdata/noninterface/archive.inl`: material types/values, primitive streams and sampler serialization order.
