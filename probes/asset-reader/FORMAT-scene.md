# Sequential bounded PC Scene preview reader

`scene_inspect(decodedModel, size)` / `scene_free(result)` is a portable C++17
decoder for a **subset** of actual PC render scene archives. It replaces fixture
anchors with sequential source serializer traversal. Input is an already decoded
PC `.model`, at most 64 MiB. No whole-file SHA gate or byte-pattern scanning is
used. Success is geometry for the first render list's base primitives in resource
block 0, LOD0; it is **not a complete scene import**.

## Sequential route

1. PC marker, Model container children, opaque Render wrapper, inner Render
   container, Header v0 and Scene data chunk. Parent bounds, chunk counts,
   compression flags and duplicate named chunks are checked.
2. Scene-relative ARCH v1/endian0 + inner ARCH v0, ReadScene format v1.
3. Target Scene v0/1, PlatformType (an RA0 object containing S32, **not** a bare
   enum), base Scene v0, RootNode v0 / CullNode v0..2 / Node v0, including child
   ResourceIndex vector, bounds and bit vectors.
4. Vertex declarations (S16 stream/S16 offset/S32 type/method/usage/S8 usageIndex,
   **17 serialized bytes**), target/base effects, resource block count, shared
   texture list and its embedded target Texture envelopes; target/base StreamData
   and target dynamic material lists.
5. ResourceBlock v0 -> PlatformType -> LOD count -> ResourceBlockLod v0 ->
   PlatformType -> LOD0 -> pointer vectors of VertexBuffer/IndexBuffer ->
   polymorphic node vector. Null and unknown resource pointers are rejected.
6. Known CullNode, RootNode, Node and GroupNode variants can precede a
   `RenderingData::RenderListNode_Common` target v0/base v2..4. Its CullNode and
   constant MaterialList/type/data are read, then base primitive vector.
7. The first render list's instance and batch descriptions, base-primitive
   descriptions, constant material data, render passes, bounds, PVS extents,
   empty portal map, node dynamic MaterialLists and VB/IB/texture source vectors
   are read sequentially. Node dynamic lists are **values**, whereas target
   Scene dynamic lists are pointer values. The parser stops after TextureSource.

Instance/batch descriptions are skipped by their source fields and are not
rendered. PVS vectors are bounded but visibility is not applied. Following
ChunkData, resource texture LODs, remaining nodes, later resource blocks and
world/model instance transforms are not parsed. Metadata always has
`partialSceneTraversal:true`, exact
`parsedUntilOffset`, node index, `coordinateSpace:"object-local"`,
`nodeTransformsApplied:false` and `material:"diagnostic-only"`. Only referenced
primary POSITION buffers are retained, in ascending global-buffer index order.
Unused vertices inside a retained buffer may remain; bounds are buffer bounds,
not final render-visible bounds.

## Geometry and texture output

`positions` is flat POSITION0 from F32_3/type6 or F16_4/type9, method0, original buffer
order. Vehicle MainVS explicitly replaces stored W with1; XYZ half components
are ordinary object-local values with no guessed scale/bias. Multiple referenced source buffers are concatenated. `indices` is triangle-list U32
indices referencing that concatenation. Source topology0 lists and topology1
strips are supported. Each primitive's first LOD is converted separately; strip
parity advances over degenerate connector triples, which are omitted.

The unique POSITION0 element's declaration selects its stream, independently
of primitive stream-array order. Frequency0 auxiliary streams can be present;
their deformation/tangent geometry is not applied in this diagnostic. Active
instancing frequencies and duplicate stream bindings are rejected. `vertexOffset` is a **byte
offset**, as proven by `Scene::CombineVertexBuffers` (`offset * vertexSize`) and
`Context::SetStreamData`; it must be stride-aligned and becomes a vertex base in
the output. Buffer references, draw ranges, minIndex/nVertices and every index
are checked. Unsupported POSITION formats or resource bindings fail explicitly.

Primitive VB/IB indices address **node source lists**, not resource arrays
directly. VertexBufferSource and IndexBufferSource must resolve to resource
block0 with in-range buffer indices. Unknown/external mappings fail; missing or
unsupported tail syntax also fails because those mappings cannot be verified.

`uv0` is flat original TEXCOORD0, method0, F16_2/type8, F16_4/type9 (first two components), or F32_2/type5. It is empty
unless every emitted vertex buffer has a supported UV0. Half subnormals and
signed zero use IEEE754 values; half Inf/NaN are rejected. UVs are **not flipped**.
No material-to-UV binding is assumed.

`draws` contains `{firstIndex,indexCount,albedoTexture,binding}` for each converted
base primitive; spans partition the emitted triangle-list indices in primitive
order. `albedoTexture` is a sharedTextures index or `null` with an explicit
binding reason. Resolution follows the **primitive stream's** MaterialIndex,
constant material list0 row, that row's MaterialType `g_tAlbedo` scalar
TEXTURE_INDEX/type7, node TextureSource and ResourceIndex(block=-1,index).
Dynamic lists, missing/array parameters, invalid rows/indices and non-shared
texture resources yield no binding. The primitive's baseMaterial is not used as
an albedo shortcut. Shaders, lighting, alpha/cull policies and sampler fidelity
remain separate renderer work.

`sharedTextures` records serialized names/hashes and bounded `dataOffset` /
`dataBytes` for embedded PC texture blobs in this same decoded file. The geometry
reader skips those opaque blobs by their declared size. It does not decode them
or authenticate hashes, and does not equate the first texture with an albedo
material. Sampler v0/1 envelopes are read by their source field width.

Empty PvsCellData can contain arbitrary nCells/cellSize scalar bits in real
assets. Source `renderlist.cpp::PvsCellData::Build` initializes these only when
there are source bits to pack, and the type has no constructor; runtime
`target/spufetch.cpp::GetPvsData` returns no visibility data for empty vectors.
This reader skips those scalars and bounds vector extents independently. It
does not use arbitrary scalar bits as allocation sizes or claim visibility
validation. Nonempty portal maps are currently an unsupported traversal variant.

Limits: 64 MiB input; 100,000 visited RA objects; 4 KiB strings; bounded
collections; at most 256 resource buffers, 1,000,000 output vertices and 2,000,000
output triangles. Unsupported versions, compressed/endian-swapped raw vertex or
index buffers, streamed Scene collections and unknown node classes fail with
`status:"error"` and byte position. Output is malloc-owned JSON, freed with
`scene_free`.

## Verification

The native source-shaped synthetic test constructs a different model from the
retail fixture: 6 F32 vertices, one triangle-list primitive, one buffer pair and
no embedded game data (the synthetic shared texture has an empty payload). It
includes a source-shaped material tail and checks success, every truncated prefix, byte stream
offset36 selecting vertices3/4/5, unaligned stream offsets, out-of-range indices,
nonfinite positions, invalid material references returning null bindings,
external buffer mappings rejected, platform rejection and deterministic output. An optional
retail fixture argument verifies 100 vertices, 114 triangles and sequential
cursor6968, draw spans0/30 and30/312, both albedo bindings shared0. Build with
`scene_reader.cpp` and run `scene_reader_tests [fixture]`.

The 28-file locally generated `_work/model-corpus/manifest.json` corpus gives
26 successful base-geometry previews after declaration-driven stream selection.
Two light/firework models contain no RenderListNode and remain explicit errors.
Successful models include both trafficcylinders, both seatbelts, coneb,
envsphere, barriers, wiremeshfence, signs, powerbox, litterdrum and lighttube.
No game fixtures are included in source control.

The original 100-vertex fixture's F32 position/U32 triangle hashes match the
independent Python mesh diagnostic. This cross-check does not establish that
every supported field/asset variant has been independently decoded; synthetic
bounds tests and explicit subset restrictions remain necessary.

## Source authority

Upstream BlurRebuilt `5270304b81983b9e3edbd569ba25235c17bbabd7` (unmodified):

- `graphics/world_render/source/RenderModel.cpp`, `WorldRender.cpp`: chunk route
  and ReadScene format/resource block ordering.
- `graphics/renderingdata/source/noninterface/target/archive.cpp`: Target Scene,
  shared textures, MaterialList data, resource LOD, vertex/index buffers,
  RenderListNode v2..4 and Primitive deserialization.
- `graphics/renderingdata/include/renderingdata/noninterface/archive.inl`:
  Node/Cull, VertexFormat, material types, primitive draw/stream/LOD, StreamData,
  sampler and declared serialization versions.
- `graphics/renderingdata/include/renderingdata/vertexbuffer.h`, `material.h`,
  `datatypes.h`, `streaming.h`, `renderlist.h`: member widths and semantic types.
- `graphics/renderingdata/source/noninterface/build/resourceblockbuild.cpp`:
  byte stream offsets in `CombineVertexBuffers` / `RemapVertexBuffer`.
- `graphics/renderingdata/source/noninterface/target/context.cpp`:
  `SetStreamData` submits the byte offset to Display.
- `common/misc_shared/include/misc_shared/archive/`: binaryarchive.h, string.h,
  vector.h, bitvector.h, pointer.h, serialisationinfo.h, serialiser.h, utmaths.h.

All paths are under `upstream/BlurRebuilt/code/mercury/library/`.

## Level index and selected streamed mesh APIs

`level_index_inspect(levelPtr,levelLen)` accepts an original PC `.levelrender`
file,20bytes..16MiB. It follows C_RenderLevel's length-based child traversal
through the opaque Render FileBlock, parses Header v0/1 (EffectVariation is a
length-prefixed Util::C_String), and then source Scene declarations, shared
texture envelopes, full StreamData/ChunkInfo tables and initial loaded-block
count. C_String8 identifiers end at their first NUL; real LS has stale bytes
after it, which are not identifier characters.

Output contains `streamChunks:[{offset,storedBytes,logicalBytes,items:[{block,lod}],prerequisites:[]}]`,
`resourceBlockCount`, `initiallyLoadedBlocks` and metadata identifying this as
an index-only parse. Offsets and sizes are source U64 values; overflow and values
outside exact JavaScript integer range are rejected. The caller separately
checks ranges against the companion stream file. `logicalBytes` is the original
ChunkInfo field, not an instruction to whole-chunk decompress; some real values
are zero. Btl byte-vector bitsets, chunk item references and dependency indices
are bounded and validated. No initial resource blocks are imported by this API.

`level_mesh_inspect(levelPtr,levelLen,geometryPtr,geometryLen,nodePtr,nodeLen,geometryBlock,nodeBlock)`
accepts three separate original byte buffers, each at most16MiB. Block IDs must
be distinct, declared in Scene and the unique first LOD0 item of a ChunkInfo
record. Exact supplied lengths and stream item counts must match those records;
selected chunks with additional prerequisites currently return unsupported.
There is no model wrapper construction or fixture hash gate.

Each stream range has its own ARCH/C_MemoryStream origin0. Geometry input must
start with LOD0 resources containing supported VBs/IBs, no nodes and no resource
textures. Node input must start with a node-only LOD0 resource. The first
supported RenderList is read with its instance/batch/base-primitive descriptions
and material tail to resolve real node VB/IB source mappings. Only direct
primitive LOD0 draws whose POSITION/index sources bind the selected geometry
block are emitted. Other-block direct draws are counted as omitted; instances,
batches, instance base primitives, later resource items/LODs and transforms are
not rendered. Materials remain diagnostic-only and albedo bindings are null.

Metadata includes `instancesApplied:false`, `nodeTransformsApplied:false`,
`coordinateSpace:"source-level"`, skipped description counts, both source stream
offsets and separate parse cursors. Structural interpretation is not hash/
provenance validation. A different same-length format-valid input is not
authenticated by the ChunkInfo length check.

The native three-input river fixture yields344vertices,208triangles,five direct
draws, while explicitly skipping57instances and36instance base primitives.
Source geometry/triangle hashes match independent Python exactly. Native index
tables equal independent Python records for all19installed levels. Existing
28model corpus + Corvette JSON results match the previous native implementation
exactly (29regression outputs), including all error results. See
`docs/plan/level-chunk-format.md` for concrete source ranges and evidence.

Real fixture checks can run as
`scene_reader_tests --level <level.levelrender> <geometry.chunk> <node-53.chunk>`.
They cover actual counts/draw spans, input truncation/limits, item/primitive/
source-vector counts, nonfinite positions, index bounds, incorrect block mapping,
swapped buffers, EffectVariation string bounds and deterministic results.

The 1 November native completion audit rebuilt this reader and its tests with
MSVC C++17 `/W4 /O2` with zero warnings. The synthetic/traffic/three-input level
tests pass; all 28 model JSON results and the Corvette result are unchanged from
the preceding reader build. All 19 installed level indexes match the independent
Python ChunkInfo records, and river geometry matches both canonical hashes.
Audit evidence is `_work/level-finish/audit.json`. Canonical float-byte comparisons
must preserve JSON `-0` as negative floating zero (JavaScript does so; Python's
default integer-token parser needs an explicit signed-zero conversion).
