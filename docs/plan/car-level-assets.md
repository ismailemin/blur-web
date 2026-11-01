# Real car and level assets: measured next steps

Diagnostic: `tools/inspect_car_level_assets.py`. It reads original installed files, extracts two explicit car fixtures with the existing bounded packet-zlib decoder, traverses source-defined Scene/resource/stream headers, invokes the current native probe, and writes ignored comparison outputs under `_work/car-level-assets/`. No source/game files are changed.

## Car candidate and exact position format

`root_streaming.pak` is **raw audio**,67 `.baf` files,68 total FAT entries including a directory. It does not hold car meshes. Production vehicle bodies and separate wheel models are in normal packet-zlib `root.pak`.

The smallest named production body, excluding the small `default.model` placeholder and separate wheel assets, is `\models\vehicles\corvette_c3_race.model`:

- PAK offset410621952,1365634packed bytes,3169212decoded bytes,49packets.
- Decoded SHA256 `77840511e5ca416ff9e7cbdc9ee9fc960fce0205f83c9be77e0803607c32cb9d`.
- Seven declared resource blocks; all7 loaded in the model; zero external stream chunks; seven embedded shared textures and23effect variants.
- First resource block has ten resource LODs,11vertex buffers,2index buffers,21nodes. First RenderList is node19 with80base primitives. First RenderList parsing ends at2030042; source binding vectors end at2042579.

Global VBs0..9 all declare POSITION0 type9(F16_4),method0,offset0. No normalized integer or bounds-based decompression is required. The vertex counts/strides are:

| Global VB | Count | Stride |
| --- | ---: | ---: |
| 0 | 9943 | 16 |
| 1 | 4907 | 24 |
| 2 | 8349 | 32 |
| 3 | 2129 | 24 |
| 4 | 628 | 36 |
| 5 | 564 | 28 |
| 6 | 314 | 32 |
| 7 | 609 | 36 |
| 8 | 196 | 40 |
| 9 | 2952 | 28 |

VB10 is a separate42vertex F32_3 buffer, stride12, not a primary POSITION source of these80draws. Compact diagnostic output should retain only referenced primary buffers, in ascending global index order.

Source `graphics/vehicle/include/vehicle/shaders/vehicle_common.h:294` declares `float4 vPos : POSITION annotation(format(F16_4))`. MainVS around1052 copies this input and explicitly overwrites `position.w=1`. Every stored W in the30591half vertices is0, so multiplying stored W through the camera would be incorrect. Decode the first three IEEE754 half components and supply homogeneous1. Later code optionally applies damage/control-point deformation, then g_mWorld and g_mViewProj. A raw object-local body preview omits those runtime changes and must say so.

## Declaration-driven stream selection

The first primitive uses declaration3, with POSITION0 on stream0 at byte0. Its three stream bindings are:

| Stream | Node VB slot | Byte offset | Frequency |
| --- | ---: | ---: | ---: |
| 0 | 0 | 119616 | 0 |
| 3 | 1 | 324 | 0 |
| 1 | 1 | 324 | 0 |

Node VB slot0 resolves to ResourceIndex(0,2), so main position buffer is globalVB2,stride32,starting vertex3738. Node VB slot1 is ResourceIndex(-1,-1), an absent auxiliary placeholder, **not globalVB1**. Full node-to-global mapping: `[2,absent,1,7,0,9,6,3,4,5,8]`, all nonabsent entries in block0.

Declaration3's stream0 contains POSITION F16_4@0,NORMAL U8_4N@8,UV0 F16_4@12,damage semantics at20/24 andCOLOR0@28. Stream3 has TANGENT/BINORMAL F16_4@0/8. No declaration element uses stream1 in this primitive. The PC shader's ordinary undeformed position uses stream0; SPU stream3 positions are selected in the PS3 branch or special export-damage hack. `Context::SetPrimitiveStream` permits an absent buffer with vertexSize0 and still applies its material. A diagnostic can exclude absent auxiliary geometry while retaining explicit damage-off scope; it cannot pretend to support active instancing or runtime deformation.

UV0F16_4's first two components are the primary surface UV; remaining components have documented damage/scratch semantics. Select POSITION and UV from the vertex declaration's declared streams and validate against the actual VB semantic/type/offset. Do not assume the first stream or a global VB index equals the node slot.

## Independent real-car geometry

`_work/car-level-assets/corvette-geometry.json` contains source-derived, compact positions, triangles and80draw ranges. Selection is first RenderList base primitives,LOD0,undeformed object-local. Each primitive restarts strip parity; repeated-index connector triangles are discarded. Source indexBuffer/node source mappings and byte offsets are validated.

- Used global VBs0..9;30591vertices;36193triangles;80draws.
- Bounds: X[-0.9619140625,0.9619140625],Y[-0.33642578125,0.86181640625],Z[-2.33203125,2.37890625].
- Flattened F32LE position hash `318260f08a06754c191df26b4275a715f8d545a2e251d1800682a30c67697ff8`.
- Flattened U32LE triangle hash `dcf9852110002000edfe482676fc3ed4c8de450a7feb7a3db8e71404994cdd1d`.
- Draw0 firstIndex0,indexCount15495;draw1 firstIndex15495,indexCount18489.

These verify a real vehicle body. Separate wheel model placement, model/instance transforms, all render nodes, damage and the original vehicle shader remain distinct steps before claiming a complete assembled or driveable car.

## Level containers and streaming

All19 installed `level.levelrender` Scene headers/stream tables were parsed sequentially. Every declared stored stream range was checked against the corresponding `level.levelstream` file, and each chunk ARCH prefix's item count/platform/first LOD matched the Scene metadata. Full inventory is roughly38MB: read selected fields, not the entire JSON into a model context.

Levels begin with PC marker then an opaque outer `Render` FileBlock whose children are read by sizes, despite type0x41/count0. Header is render version1 plus **Util::C_String EffectVariation** (U32length+bytes, e.g. river `LN`), not a bare integer enum. Scene uses the same ARCH serialization as models. Other chunks hold Lights,LS,PVSData,CubePt2,Portals,Crowd as present. C_BlockHeaderId is C_String8; only bytes before the first NUL form its name. River's LS identifier contains stale `ID` bytes after NUL, which must not be mistaken for an invalid name.

| Level | Render bytes | Declared blocks | Stream chunks | Companion stream bytes |
| --- | ---: | ---: | ---: | ---: |
| showroom | 978033 | 145 | 31 | 24725504 |
| spa_barcelona_bowl_multiplayer | 962088 | 382 | 84 | 85737472 |
| usa_la_river | 9873988 | 1227 | 359 | 244682752 |

Each loads only resourceBlock0 initially: zero VBs,zero IBs,one CullNode. `.levelrender` alone cannot provide the track geometry. The real path is Scene resource references plus `ChunkInfo` dependencies and bounded reads from its companion `.levelstream`.

Useful extracted ignored chunks:

- River chunk157: offset68937728,size10240,block252LOD0..5,no prerequisites or dependants. OneVB344vertices,stride24,POSITION F32_3@0,NORMAL U8_4N@12,UV0F16_2@16,COLOR0@20; oneU16IB544indices; zero nodes. `_work/car-level-assets/usa_la_river.geometry-chunk.bin`,SHA256 `b07b386c5da5b9154aa393e121614236d7f828d5c5f985e720c01bb192d5b710`.
- Showroom chunk6: offset1544192,size1206272,firstblock1LOD0,194items,prerequisite chunk5. First item has twoVBs and oneIB but zero nodes. `_work/car-level-assets/showroom.geometry-chunk.bin`.
- Barcelona bowl chunk15: offset13481984,size495616,firstblock21LOD0,19items,no prerequisites. First item has twoVBs,oneIB,zero nodes. `_work/car-level-assets/spa_barcelona_bowl_multiplayer.geometry-chunk.bin`.

These geometry chunks do not carry their own RenderList draws. The next reader must resolve the level node chunks whose VertexBufferSource/IndexBufferSource point at these blocks. It must not invent a whole-IB triangle strip: actual draw ranges and topology come from the node's primitives.

`ChunkInfo` offsets/stored/original sizes areU64. The stored range begins directly with an ARCH envelope and nItems, followed by each `LodReader<ResourceBlock::Resources>` in the listed `(block,lod)` order. It is not a PAK packet or a ResourceBlock wrapper. PC ProcessLoadChunk creates a C_MemoryStream over the stored range; archive alignment origin is therefore chunk byte0. Buffers may carry their own compression; do not whole-chunk-inflate based on the field name CompressedSize. Some originalSize values are0; they are not a valid decoded output size assumption.

## Source authority

Relative to `upstream/BlurRebuilt/code/mercury/library/`:

- `graphics/world_render/source/RenderModel.cpp`,RenderLevel.cpp,WorldRender.cpp: FileBlock dispatch,ReadScene,nonstream loaded block counts,InitStreaming.
- `graphics/renderingdata/source/noninterface/target/archive.cpp`: Scene,ResourceBlock,LodReaderResources,vertex/index serialized buffers and type mapping.
- `graphics/renderingdata/include/renderingdata/noninterface/archive.inl`: field order for declarations,streams,primitives,StreamData,ChunkInfo.
- `graphics/renderingdata/include/renderingdata/vertexbuffer.h`: declaration element field widths (S16stream,S16offset,threeS32 enums,S8usageIndex).
- `graphics/renderingdata/include/renderingdata/streamdata.h`: U64 offsets/sizes,ChunkInfoitems,byte-based ChunkDefs::BitVector.
- `graphics/renderingdata/source/noninterface/target/streamdata.cpp`: CacheChunk/ProcessLoadChunk,dependency order,item->block/lod dispatch.
- `graphics/renderingdata/source/noninterface/target/streammanager.cpp`: exact range loading.
- `graphics/vehicle/include/vehicle/shaders/vehicle_common.h`: F16_4 position,forced homogeneous1,optional damage,world/view projection.
- `graphics/renderingdata/source/noninterface/target/context.cpp`: declared stream data/material application.
- `common/misc_shared/include/misc_shared/archive/{binaryarchive.h,serialiser.h,bitvector.h}`: envelopes,alignment,buffer headers,bit-count plusU8 buffer serialization.
- `common/core/include/btl/Containers/bitvector.h`: BitVector usesU8;BitVector32 is a separate type. Reserve may exceed the minimum used byte count.
