# First genuine streamed level mesh

Implemented independent evidence tool `tools/inspect_level_chunk.py` and portable C++ APIs `level_index_inspect` / `level_mesh_inspect` in scene_reader.h/.cpp. Source/game checkout remains unchanged. This is a direct-mesh milestone with an explicit partial-scene boundary, not an assembled playable track.

## Exact source route

`C_RenderLevel::Read` reads opaque Render children by their lengths, then calls `WorldRender::ReadScene` for Scene. Header v1 contains a Util::C_String EffectVariation (river `LN`, length2), not a fixed U32 enum. C_BlockHeaderId is C_String8 and terminates at first NUL; river's LS header contains stale `ID` bytes after NUL. Those do not change its identifier.

ReadScene's ARCH file version1 serializes Target Scene, then the initially loaded resource count and ResourceBlocks. Scene's StreamData contains source ChunkInfo items, prerequisites, offsets and sizes. Index tables are parsed in WASM/native from `.levelrender`; browser range offsets need not come from generated diagnostic JSON.

Target StreamData::CacheChunk sends ChunkInfo's exact U64 offset/stored size to StreamManager::LoadChunk. ProcessLoadChunk creates a C_MemoryStream over that range, constructs BinaryInputArchive and reads nItems, then one LodReader<ResourceBlock::Resources> per `(block,lod)` item in Scene's listed order.

**Alignment origin is byte0 of each individual stream range.** It is neither the levelrender Scene payload origin nor the absolute levelstream file offset. Raw VB/IB serializer alignment must use this separate origin. Stored chunk bytes already start with ARCH; whole-chunk zlib inflation would be incorrect. Individual serialized buffer compression is a separate feature and currently unsupported by the bounded C++ geometry path.

## Proven river inputs and association

Original `levels/usa_la_river/level.levelrender`:9873988bytes;1227resource blocks;359stream chunks;only block0 initially loaded. Companion stream244682752bytes. The independent inventory validates all stored ranges against the real companion length and all chunk prefix item counts.

| Input | Scene record | Stream offset | Stored length | Resource item |
| --- | ---: | ---: | ---: | --- |
| Geometry | chunk157 | 68937728 | 10240 | first(block252,lod0),then lod1..5 |
| Node | chunk53 | 2990080 | 26624 | first(block253,lod0),then later LODs |

Both records have no prerequisites. Geometry chunk SHA256 `b07b386c5da5b9154aa393e121614236d7f828d5c5f985e720c01bb192d5b710`; node chunk SHA256 `65aec287878fa58405fa5ed585e6c43f3ba5ff683e825c0759b29f8fe8ccf20c`. Hashes record local fixture identity, not retail authenticity.

Node chunk53 has a CullNode followed by RenderListNode_Common at node index1. Its source lists contain slot0 VB ResourceIndex(252,0),slot0 IB ResourceIndex(252,0), and other slots for unrelated instance geometry. The RenderList has five direct primitives,57instances and36instance base primitives. Independent traversal parses all source-shaped descriptions and ChunkData; the C++ preview stops after the source vectors and never treats instance descriptions as rendered geometry.

## Geometry layout and real draw ranges

Geometry block252LOD0:

- OneVB,344vertices,stride24; actual vertex data offset192 in its chunk.
- POSITION0 F32_3(type6),method0,offset0.
- NORMAL U8_4N@12;TEXCOORD0 F16_2(type8)@16;COLOR0 U8_4N@20.
- OneU16IB,544indices,index data offset8496.
- Zero nodes and zero resource textures in this first resource item.

Original declaration5 agrees with that VB's POSITION stream0/offset0. All five direct primitive stream bindings select node slot0,byteOffset0,frequency0. All use node IB slot0. Actual TRIANGLE_STRIP LOD0 spans, in serialized primitive order:

| Primitive offset in node chunk | IB offset | Source index count | Minimum vertex | Vertex range | Output triangles |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1578 | 467 | 77 | 295 | 49 | 30 |
| 1722 | 0 | 237 | 0 | 147 | 90 |
| 1866 | 237 | 157 | 147 | 98 | 60 |
| 2010 | 439 | 28 | 275 | 20 | 10 |
| 2154 | 394 | 45 | 245 | 30 | 18 |

Each strip restarts winding parity. Repeated-index connector triangles are omitted. Result: **344vertices,208triangles,five draws**. Output spans in triangle-list index units: `(0,90),(90,270),(360,180),(540,30),(570,54)`.

Source coordinate bounds: X[-106.6171875,-16.634180068969727],Y[5.3559651374816895,8.061172485351562],Z[1023.9934692382812,1076.8780517578125]. They are retained as serialized level coordinates; no node/model instance transform is claimed applied.

- F32LE XYZ hash `8e00a620b8d915410e395a3bb01286ab8119e79a88a9a721e27a2c46a3271e86`.
- U32LE triangle hash `7ad84d315b14553f16f84ec66e52bd4b0e6bf10f2191d7952a33d9f5127739e6`.

## APIs, limits and verification

`level_index_inspect(levelPtr,levelLen)` returns streamChunks with source numeric offsets/stored/original sizes and typed `{block,lod}` items plus prerequisites. Source U64 values must fit exact browser integers. No stream file content is needed for the index; the server/frontend separately verifies requested ranges against the whitelisted companion file.

`level_mesh_inspect(levelPtr,levelLen,geoPtr,geoLen,nodePtr,nodeLen,252,253)` validates the provided IDs and exact lengths against unique ChunkInfo records beginning with those LOD0 blocks. It checks range envelopes, item counts, source declarations and slot mappings, typed-buffer extents, byte offsets, LOD index ranges and every emitted index. It reads the actual original buffers separately, with no generated Model wrapper. All three inputs are capped16MiB; first-item mixed geometry/node blocks and extra selected prerequisites are explicit unsupported cases.

The output contains positions,UV0,triangle-list indices,draw spans and bounds. Metadata has `instancesApplied:false`, skipped instance/base counts, separate parse offsets, stream offsets and `material:"diagnostic-only"`. Neither full original materials nor lighting/culling/visibility/physics are applied. Later resource items are outside scope. Source length/index validation is not cryptographic authentication of supplied bytes.

Native /W4 compilation is clean. Real three-input C++ tests pass; known malformed source counts, input limits/truncations, wrong block associations, swapped ranges, NaN positions and invalid indices are rejected. All19level stream indices match independent Python field-for-field. Existing28model fixtures plus Corvette match the previous native JSON exactly. River positions and indices match the independent Python reference hashes exactly.

Ignored evidence: `_work/level-chunk/{geometry.chunk,node-53.chunk,reference.json,river-geometry.json,native-verification.json}`. Tool scans actual source-defined candidate node prefixes and traverses their typed fields; all river node-chunk inspections completed without unsupported errors. It finds the association from RenderList source vectors rather than odd/even block-number patterns or scanning marker bytes.

## Authoritative local source

Under `upstream/BlurRebuilt/code/mercury/library/`:

- graphics/world_render/source/RenderLevel.cpp:Read/InitStreaming.
- graphics/world_render/include/world_render/RenderLevel.h:EffectVariation Util::C_String type.
- graphics/world_render/source/WorldRender.cpp:ReadScene ordering.
- graphics/renderingdata/include/renderingdata/streamdata.h:ChunkInfo U64 fields,item order and byte bit-vector types.
- graphics/renderingdata/include/renderingdata/noninterface/archive.inl:ChunkInfo,StreamData,Primitive,Instance,InstanceBatch,RenderList,ChunkData field serializers.
- graphics/renderingdata/source/noninterface/target/archive.cpp:Target Scene,ResourceBlock/LodReaderResources and typed-buffer layouts.
- graphics/renderingdata/source/noninterface/target/streamdata.cpp:CacheChunk/ProcessLoadChunk and prerequisite scheduling.
- graphics/renderingdata/source/noninterface/target/streammanager.cpp:LoadChunk exact range request.
- graphics/renderingdata/source/noninterface/target/context.cpp:RenderPrimitive/RenderPrimitiveInstance,stream byte offsets and draw LOD ranges.
- common/system/include/system/serialise/C_FileBlock.h:C_BlockHeaderId is Util::C_String8.
- common/misc_shared/include/misc_shared/archive/{binaryarchive.h,serialiser.h}:archive origin/alignment and typed buffer envelope.
