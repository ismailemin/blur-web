# Render mesh decoder: first verified fixture

This is a narrowly scoped diagnostic decoder, not a general `.model` reader.
`mesh_inspect` accepts the **decoded** PC `trafficcylinder.model` of 8015 bytes,
SHA256 `57f28fb4026a638c2a93469148b8597ebf93ac79c22acd3c836d58e32fc1565b`.
Both length and SHA256 are checked in native C++ and therefore also in WASM
before any profile-specific offset is used. Same-size modified inputs are
rejected. A hash match identifies the fixture; it does not authenticate it.

The original PAK record is
`\models\objects\usa_la_river\misc\trafficcylinder.model` in `root.pak`.
The 3424-byte codec-4 record at 261296128 expands to this 8015-byte input.
The decoder does not open the PAK, decompress data, or read collision geometry.

## Source basis

Checked against public `upstream/BlurRebuilt` commit
`5270304b81983b9e3edbd569ba25235c17bbabd7`:

- `code/mercury/library/graphics/world_render/source/RenderModel.cpp` and
  `WorldRender.cpp`: Render/Header/Scene blocks and `ReadScene` archive entry.
- `code/mercury/library/graphics/renderingdata/source/noninterface/target/archive.cpp`:
  `VertexBuffer` v1, `IndexBuffer` v1, resource vectors.
- `code/mercury/library/graphics/renderingdata/include/renderingdata/noninterface/archive.inl`:
  VertexFormat, VertexElement, RenderListNode::Primitive, Lod, PrimitiveStream.
- `renderingdata/datatypes.h`, `vertexbuffer.h`, `renderenums.h`: vertex element
  types/usages and `RenderingData::TRIANGLE_STRIP` = 1.
- `code/mercury/library/common/misc_shared/include/misc_shared/archive/`:
  `binaryarchive.h`, `vector.h`, `pointer.h`, `serialiser.h`: RA markers,
  object versions, enum widths, vector counts, pointer tag, alignment and raw buffers.

The independent `tools/inspect_mesh_layout.py` and `docs/plan/mesh-format.md`
record the mapping independently of this C++ implementation.

## Verified serialized layout

Offsets below are absolute decoded-file offsets. All primitive integers and F32
values are little-endian. No floats are selected by plausibility scanning.

| Offset | Serialized content |
| --- | --- |
| 0 | PC marker `  CP` |
| 4 | Model container, size 7676, four children |
| 650 | Outer Render data block, size 6510 |
| 666 | Inner Render container, size 6494, two children |
| 682 | Header, size 20, Render file version 0 |
| 702 | Scene data block, size 6458 |
| 718 | Scene payload origin: outer ARCH v1/endian 0 |
| 730 | Inner ARCH v0; scene version at 738 is 1 |
| 2731 | Target::VertexBuffer archive v1 |
| 2735 | VertexFormat archive v0; stride 20 |
| 2743 | Elements vector v0, count 3 |
| 2751,2771,2791 | Element archives: F32_3 POSITION0; U8_4N NORMAL0; F16_2 TEXCOORD0 |
| 2811 | Offsets vector v0: U16 values 0,12,16 |
| 2825 | Vertex count 100 |
| 2829 | Deserialiser v0: 2000 bytes, alignment16, compression0, endianSwap0 |
| 2846..4846 | Actual vertex bytes; F32_3 positions at each stride20 offset0 |
| 4846 | Index buffer resource vector v0, count1, pointer tag2 |
| 4855 | Target::IndexBuffer archive v1, count202, type U16 |
| 4867 | Deserialiser v0: 404 bytes, alignment16, compression0, endianSwap0 |
| 4894..5298 | Actual U16 index bytes |
| 6094 | First Primitive archive v1: triangle strip, IB0 |
| 6178 | First Lod archive v0: offset179, count23, minIndex84, nVertices16 |
| 6206 | First PrimitiveStream v0: VB0, stream0, vertexOffset0 |
| 6238 | Second Primitive archive v1: triangle strip, IB0 |
| 6322 | Second Lod archive v0: offset0, count179, minIndex0, nVertices84 |
| 6350 | Second PrimitiveStream v0: VB0, stream0, vertexOffset0 |

**Alignment is relative to Scene payload origin 718**, not the whole file.
This is why the vertex and index byte offsets are 2846 and 4894.

The two strips are decoded separately. Winding alternates at every strip index,
including degenerate connector indices. Equal-index degenerate triangles are
removed; parity is preserved. Output has 114 triangles (10 + 104), 342 indices;
84 degenerate triangles are omitted. Indices remain absolute within the one
100-vertex buffer and are checked against each Lod's declared vertex range.

## API and limitations

`mesh_inspect(bytes, size)` returns malloc-owned UTF-8 JSON, released with
`mesh_free(pointer)`. Success includes `status:"ok"`, flat `positions`,
triangle-list `indices`, local `bounds`, and `metadata`. Errors use
`status:"error"` and `error`; no partial geometry is returned.

Metadata explicitly reports `fixtureOnly:true`, `coordinateSpace:"object-local"`,
`nodeTransformsApplied:false`, and `material:"diagnostic-only"`. Node transforms,
hierarchy and material/texture decoding are not implemented. Vertices are the
real render buffer's object-local positions, **not world positions**. The viewer
may center/scale these positions for inspection but must not describe this as
reconstructing in-game placement. Collision data is not used. Normals and UVs
are structurally validated but not emitted in this first implementation.

General model support requires real Scene/resource/node traversal, buffer
references, stream bindings, additional vertex element types/compression and
transforms. Other models are explicitly unsupported rather than interpreted
with this fixture's offsets.

`mesh_reader_tests` always exercises null/truncated/oversize/same-size synthetic
rejection. With a decoded fixture path as its first argument, it also verifies
100 positions, both separate strip ranges, triangle counts, known bounds,
determinism and seven same-length byte mutations rejected by SHA256. No game
asset is embedded in tests or source.
