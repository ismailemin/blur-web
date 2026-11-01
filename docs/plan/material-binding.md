# First original mesh/material binding

Verified fixture: decoded `\models\objects\usa_la_river\misc\trafficcylinder.model`,8015bytes,SHA256 `57f28fb4026a638c2a93469148b8597ebf93ac79c22acd3c836d58e32fc1565b`. Diagnostic `tools/inspect_material_binding.py` is intentionally identity-gated, with explicit source-profile anchors and sequential field parsing. It is evidence for this fixture, not the general reader.

## Binding chain recovered from the actual serialized objects

Both primitives (6094 and6238) have stream0 material `{index:1,listIndex:0}`. List0 is the constant material list. Material1 has type1, `default_NB_NL_NM_NV.fx`, with single element `g_tAlbedo` of MATERIAL_ELEMENT_TYPE_TEXTURE_INDEX(7), count1, value0. Node texture-source slot0 is ResourceIndex `{block:-1,index:0}`. Block-1 means scene-shared texture0, named `trafficcylinder_diff`.

The primitive **base material** is `{index:0,listIndex:1}`, a dynamic Element/Index parameter list, not the texture material. Instance material0/list0 resets g_lodFade. The albedo binding comes from the **primitive stream** material applied by Context::SetStream, so the three material associations must not be conflated.

| Source object | Decoded value |
| --- | --- |
| Constant material types start | 5897 |
| Constant type0 | InstanceReset: g_lodFade F32×4 |
| Constant type1 | default_NB_NL_NM_NV.fx: g_tAlbedo TEXTURE_INDEX×1 |
| Instance/instance-batch/base-primitive vectors | empty,6382..6406 |
| Constant material data | count2,declared20bytes,6406..6442 |
| Constant material0 | type0:g_lodFade=[0,0,1,1] |
| Constant material1 | type1:g_tAlbedo=0 |
| Render pass records | six,6442..6618 |
| Primitive/instance/batch bounds | counts2,0,0 |
| Dynamic material list | one **value**, not a pointer; Element/Index |
| IndexBufferSource vector | 6920:ResourceIndex(0,0) |
| VertexBufferSource vector | 6936:ResourceIndex(0,0) |
| TextureSource vector | 6952:ResourceIndex(-1,0) |
| Binding traversal end | 6968,before ChunkData |

## Embedded original texture

Scene shared-texture list entry0 has name `trafficcylinder_diff` and hash `0x9fd5721f`. The stored target texture repeats this name/hash. Its raw PC descriptor + entire mip chain occupies decoded-model bytes1155..2599 (1444bytes). There is **no standalone Texture/FileBlock wrapper** around the embedded payload.

TextureDesc: width16,height128,depth1,levels8,DXT1/BC1,type3(2D),usage0. Texels begin at1183 (descriptor+28). The eight levels occupy1416bytes. Payload SHA256 `f0f6f6e4892bdf5be3f3e44ed6f6126485cc03358b0e970d89edbf6d676afa3b`.

SamplerState version1: addressU/V/W=0(WRAP), mag/min/mip=1(LINEAR), maxAnisotropy0,maxMipLevel0,lodBias0,sRGB1. A mip0-only diagnostic uses the same wrap and min/mag semantics but has no full original mip filtering. Decode sRGB deliberately if using the sampler's color-space semantics; the standalone CPU decoder reports untransformed texel values.

No `trafficcylinder_diff.texture` entry exists in the six installed V2 cache PAK indices inspected. The independently proven binding already points to embedded shared texture0; no filename guessing or external texture download is needed.

`texture_raw_inspect(ptr,size)` now accepts the raw embedded TextureDesc+texels directly, sharing the standalone decoder's exact bounds/format logic. Metadata says `container:"PC embedded texture"`, pixelDataOffset28 and contains **no invented standalone flags**. Pass only the independently validated Scene sharedTexture dataOffset/dataBytes range, never scan for plausible TextureDesc bytes.

## Original UV mapping

The source vertex declaration stores TEXCOORD0 as F16_2 (type8,method0,usage5,index0), offset16 in stride20 records. All100 original pairs are decoded; finite range `[0,0]..[1,0.958984375]`. Flattened F32LE UV SHA256 `ddc04d8c319e4d7e6d4396fa5efb972fe81a7c42fcb4aeb9d46163a01c50df13`.

The shader copies TEXCOORD0 directly through EvaluateTexCoord for this non-lightmapped variant. EvaluateAlbedo samples g_tAlbedo at those `.xy` coordinates. Preserve vertex order and UV values; no arbitrary V-flip/UV rescale is justified. WebGPU UV(0,0) and source PC texture row0 refer to the top row. Preview camera centering/scaling affects positions only.

## Source authority

Relative to `upstream/BlurRebuilt/code/mercury/library/`:

- `graphics/renderingdata/include/renderingdata/noninterface/archive.inl`: MaterialType/MaterialElement/MaterialIndex, PrimitiveStream, Primitive, RenderListNode field order; SamplerState values.
- `graphics/renderingdata/source/noninterface/target/archive.cpp`: DeserialiseMaterial/Data, RenderListNode tail, SharedTextureList/Texture PC raw payload.
- `graphics/renderingdata/source/noninterface/target/context.cpp`: SetStream applies primitiveStream.material; SetMaterial resolves TEXTURE_INDEX through node renderDataTarget texture slot.
- `graphics/renderingdata/source/noninterface/target/render.cpp`: Scene::Bind node TextureSource, block-1 maps to shared texture list.
- `graphics/renderingdata/include/renderingdata/renderstates.h`: wrap0 and linear1 enum values.
- `graphics/shader/include/shader/common/Parameters.h`: TEXCOORD0 F16_2 annotation.
- `graphics/shader/include/shader/common/Transform.h`: EvaluateTexCoord passes original primary UV.
- `graphics/shader/include/shader/common/Material.h`: g_tAlbedo, AlbedoSampler, EvaluateAlbedo.
- `graphics/shader/source/Default.fx`: shader include/feature chain.

## Verification and scope

Tool output `_work/material-binding/trafficcylinder.json` contains decoded material lists, source vectors, sampler, original UV pairs and hashes. It also writes the exact raw texture payload, a diagnostic standalone wrapper, and independent Pillow-decoded RGBA/PNG. The wrapper is an adapter for testing; no descriptor or texel byte is modified.

Native texture_raw_inspect output exactly equals all8192 independent Pillow RGBA bytes, SHA256 `3f344e835035cb8f481de1c80d3ab163d6aecc45e6d1c0fd60f076f8efb28040`. Native `/W4` builds clean; known pixel/raw descriptor/bounds tests pass, including real16×128 embedded fixture.

Rendering the actual albedo on actual UVs with diagnostic lighting is a valid next proof. It does not recreate the complete original shader, mip streaming, scene transforms, lighting, weather, or gameplay. General material resolution should parse these associations sequentially and reject unsupported cases rather than assume the first texture belongs to every model.
