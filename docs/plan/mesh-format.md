# First mesh: source-grounded byte layout

The decoded retail `trafficcylinder.model` contains a real render mesh: 100 vertices,
202 16-bit strip indices, two primitive draws and 114 triangles after discarding
index-degenerate strip triangles. Positions are extracted using the serialized
vertex declaration, not by searching for plausible floating-point numbers.

This is a bounded fixture profile, not a general model/scene decoder. Fixed object
anchors are permitted only after checking the complete decoded file's SHA-256 and
length. Changing the file causes an explicit unsupported-fixture error. The
portable mesh reader and browser viewer must preserve this distinction.

## Fixture identity

- Source: local retail `root.pak`, entry
  `\models\objects\usa_la_river\misc\trafficcylinder.model`.
- Decoded file: `_work/model-probe/trafficcylinder.model`, 8,015 bytes.
- SHA-256: `57f28fb4026a638c2a93469148b8597ebf93ac79c22acd3c836d58e32fc1565b`.
- Source reference: `upstream/BlurRebuilt`, commit
  `5270304b81983b9e3edbd569ba25235c17bbabd7`.
- Verification tool: `tools/inspect_mesh_layout.py`; it only reads the input and
  writes its JSON report to stdout. `--geometry` includes positions and indices.
- Independent local report: `_work/mesh-layout/trafficcylinder.json` (generated
  evidence, not a redistributable game asset).

## Archive envelope and alignment

All offsets below are absolute byte offsets in the decoded model. Multibyte
primitive fields for this PC fixture are little-endian.

| Offset | Structure | Meaning |
| ---: | --- | --- |
| 0 | `20 20 43 50` | PC model platform tag |
| 4 | `Model`, size 7676 | Model container ends at 7680 |
| 20 | `Header`, size 20 | Model header |
| 40 | `MdlDat`, size 610 | Model data; not decoded by the mesh profile |
| 650 | `Render`, size 6510 | Opaque model-level render wrapper |
| 666 | `Render`, size 6494 | Inner render container; two children |
| 682 | `Header`, size 20 | File version 0 at 698 |
| 702 | `Scene`, size 6458 | Scene data ends at 7160 |
| 718 | outer `ARCH`, version 1 | **Scene stream/alignment origin** |
| 726 | endian flag 0 | No endian swap |
| 730 | inner `ARCH`, version 0 | Binary object archive |
| 738 | S32 value 1 | `WorldRender::ReadScene` format version |
| 742 | `RA`, U16 version 1 | Target scene object |
| 7160 | `Coll`, size 520 | Collision data; not render geometry |
| 7680 | `MtaDbg`, size 335 | Trailing debug metadata |

`RenderModel.cpp` reads the inner `Render` container and dispatches its `Scene`
child to `WorldRender::ReadScene`. That function creates `Arch::BinaryInputArchive`,
reads a version and the target scene, then resource blocks. The binary archive
places a two-byte marker and U16 version before nonprimitive objects. The source
uses the multicharacter value `'AR'`; on disk in this little-endian fixture the
bytes are `52 41` (`RA`). Primitive values have no class header.

`Arch::Deserialiser` serializes U32 byte size, U32 alignment, U32 compression type,
then a U8 endian-swap flag. Both mesh buffers have compression 0 and alignment 16.
Raw data begins after alignment relative to the scene stream at **718**, not to
the start of the whole model. File-relative alignment would produce incorrect
vertex/index bytes.

## Vertex buffer

| Offset | Field | Value |
| ---: | --- | --- |
| 2731 | VertexBuffer class marker/version | `RA`, 1 |
| 2735 | VertexFormat class marker/version | `RA`, 0 |
| 2739 | VertexFormat data size S32 | 20 bytes per vertex |
| 2743 | Elements vector | `RA`, 0; count 3 at 2747 |
| 2751 | First VertexElement | `RA`, 0; `(6,0,0,0)` at 2755 |
| 2771 | Second VertexElement | `RA`, 0; `(11,0,3,0)` at 2775 |
| 2791 | Third VertexElement | `RA`, 0; `(8,0,5,0)` at 2795 |
| 2811 | Element offsets vector | `RA`, 0; count 3 at 2815 |
| 2819 | U16 offsets | 0, 12, 16 |
| 2825 | Vertex count S32 | 100 |
| 2829 | Deserialiser class | `RA`, 0 |
| 2833 | Buffer byte size U32 | 2000 |
| 2837 | Alignment U32 | 16 |
| 2841 | Compression U32 | 0 |
| 2845 | Endian swap U8 | 0 |
| 2846 | Raw vertex bytes | 2000 bytes; end 4846 |

Each VertexElement tuple is `(type, method, usage, usageIndex)`, four S32 values.
The corresponding source enums identify the following layout:

| Byte offset in vertex | Type | Semantic |
| ---: | --- | --- |
| 0 | `VERTEX_ELEMENT_TYPE_F32_3` (6) | POSITION (usage 0), three F32 values |
| 12 | `VERTEX_ELEMENT_TYPE_U8_4N` (11) | NORMAL (usage 3), packed normalized bytes |
| 16 | `VERTEX_ELEMENT_TYPE_F16_2` (8) | TEXCOORD (usage 5), two half floats |

The diagnostic viewer only needs the source-supported POSITION field initially.
It does not interpret the packed normals as signed vectors or claim to reproduce
the original material shading.

## Index buffer and primitive draws

| Offset | Field | Value |
| ---: | --- | --- |
| 4855 | IndexBuffer class | `RA`, 1 |
| 4859 | Index count S32 | 202 |
| 4863 | IndexType S32 | 0 (`INDEX_TYPE_U16`) |
| 4867 | Deserialiser class | `RA`, 0 |
| 4871 | Buffer byte size U32 | 404 |
| 4875 | Alignment U32 | 16 |
| 4879 | Compression U32 | 0 |
| 4883 | Endian swap U8 | 0 |
| 4894 | Aligned raw index bytes | 404 bytes; end 5298 |

All indices are in `[0,99]`. The primitive topology is explicitly serialized as
1, `PRIMITIVE_TYPE_TRIANGLE_STRIP`; it is not inferred from the index pattern.

`RenderListNode::Primitive`, class version 1, serializes effect, vertex declaration,
primitive type, index-buffer index and flags as S32 values; base material and
instance material; blend state; LOD vector; primitive-stream vector. MaterialIndex
contains S32 index and S32 listIndex. BlendState is three S32 enum values, four U8
flags/alpha values, then two S32 values; its 24-byte payload is not six semantic
U32 fields.

| Primitive marker | Lod marker | First index | Index count | Min vertex | Vertex count | Triangles |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 6094 | 6178 | 179 | 23 | 84 | 16 | 10 |
| 6238 | 6322 | 0 | 179 | 0 | 84 | 104 |

Both primitives use effect 0, declaration 0, index buffer 0 and flags 0. Their
single streams use vertex buffer 0, stream index 0, vertex offset 0, frequency 0,
and material index 1/listIndex 0. Each has one LOD. The first primitive ends
exactly at 6238; the second ends at 6382.

The two strips must be submitted as separate draws, or converted separately to
triangle lists. Drawing all 202 indices in one strip creates triangles across
primitive boundaries. For triangle-list conversion, alternate winding for each
consecutive triple, including through degenerate triples; discard triples with
repeated indices; restart parity at each primitive. The evidence JSON uses
serialized primitive order (23-index strip followed by 179-index strip).

## Reproducible geometry evidence

Object-local position bounds from the declared position field:

| Axis | Minimum | Maximum |
| --- | ---: | ---: |
| X | -0.03491896390914917 | 0.03491906076669693 |
| Y | 0.007205004338175058 | 0.8298954963684082 |
| Z | -0.035457611083984375 | 0.035457611083984375 |

Independent cross-language hashes avoid JSON whitespace/float-format differences:

- Position hash: flatten vertices in original buffer order, each `(x,y,z)` packed
  as three IEEE754 F32 little-endian values. SHA-256:
  `3e1d911eabbe6208d60351899a8da141cddca7a19439cd77bd7e8693c23a8648`.
- Triangle-index hash: flatten the converted 114 triangles in serialized primitive
  order, each index packed as U32 little-endian. SHA-256:
  `121761aaeeecc41ca4c4a10d599cf8720f3bbb0eb3df3874618f9636f70ca2cc`.

These are object-local vertices. The base rendering Node's serialized `Location`
is a `ResourceIndex` (block/index), not a transform matrix. Model data, instance
materials and their possible transforms are not fully decoded. No assumption of
an identity world/model transform is made. Preview centering/scaling is a viewer
operation and must not overwrite or be presented as source geometry.

## Authoritative local source

Paths below are relative to `upstream/BlurRebuilt/code/mercury/library/`:

- `graphics/world_render/source/RenderModel.cpp`: render chunk/header/scene dispatch.
- `graphics/world_render/source/WorldRender.cpp`: `WorldRender::ReadScene`.
- `graphics/renderingdata/source/noninterface/target/archive.cpp`: target Scene,
  ResourceBlock, resource LOD reader, VertexBuffer, IndexBuffer and Primitive
  deserialization, including platform-specific conversion.
- `graphics/renderingdata/include/renderingdata/noninterface/archive.inl`:
  VertexFormat, VertexElement, PrimitiveStream, Primitive::Lod, MaterialIndex,
  BlendState, base Node and shared serialization field order.
- `graphics/renderingdata/include/renderingdata/datatypes.h`: vertex and index enums.
- `graphics/renderingdata/include/renderingdata/vertexbuffer.h`: usage enums and
  VertexFormat member types (including U16 offsets).
- `graphics/renderingdata/include/renderingdata/renderenums.h`: primitive topology.
- `graphics/renderingdata/include/renderingdata/node.h`: `m_location` type.
- `common/misc_shared/include/misc_shared/archive/binaryarchive.h`: archive
  envelopes, version markers and stream-relative alignment.
- `common/misc_shared/include/misc_shared/archive/serialiser.h`: raw buffer envelope.
- `common/misc_shared/include/misc_shared/archive/vector.h`: vector count/elements.

The next generalized reader needs an actual sequential scene/resource/node archive
walker with reference handling, rather than scanning marker bytes or reusing these
anchors for other assets. Texture decoding, shader/material translation, animation,
scene instances, cars, tracks and gameplay remain separate work.
