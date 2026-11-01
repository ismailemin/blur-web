# Level instance transform evidence and next implementation

`tools/inspect_level_instances.py` independently reads original source-shaped
RenderList records, constant material fields, instance/base associations and
stream resource mappings. It leaves game data and upstream source unchanged.
This document started as Python-only evidence; the bounded C++/WASM
`level_instances_inspect` first-instance path is now implemented.

**Implemented result:** River block27/node253 instance0 produces805vertices/
726triangles, archived-bounds error`3.86511e-05`; native/WASM JSON and the F32
position / U32 index hashes match this diagnostic exactly. The browser exposes a
single-instance preset. The other56instances, materials, visibility and higher
LODs remain open.

## What the current browser presets contain

The first RenderList of River geometry88/node283 and showroom geometry3/node10
contains **zero instances and zero base primitives**. Each contains an identity
`g_mWorld` constant. Their omitted geometry therefore requires further resource
blocks/render nodes; expanding instances in these same nodes cannot assemble
the rest of either level.

The original small River node253 contains57instances and36base primitives. All
57resolve to an explicit constant affine `g_mWorld`;16distinct matrices occur.
Their index resources come from blocks15/17/26/27/31/32, in chunks86/86/85/88/96/88
respectively. Reading only the selected direct-geometry block252 is insufficient.

## Actual render order and matrix semantics

Authoritative source under `upstream/BlurRebuilt/code/mercury/library/`:

- `graphics/renderingdata/include/renderingdata/noninterface/archive.inl:838`
  serializes Instance primitiveIndex,material,primitiveStreams,flags. **No matrix
  is serialized directly in the Instance record.**
- `graphics/renderingdata/source/noninterface/target/context.cpp:320`
  selects `basePrimitives[instance.primitiveIndex]`, applies instance.material,
  binds instance primitive streams, then calls RenderPrimitive(base,lod).
- The same file at414 applies the base material and base primitive streams
  before drawing. Base streams override matching instance stream slots. At467,
  streamIndex-1is ignored; active zero-size placeholder streams can still apply
  material parameters. At679, MATERIAL_INDEX fields recursively apply materials
  in field order. Runtime DATA_INDEX/material lists require separate handling.
- `graphics/shader/include/shader/common/Transform.h:26` creates
  `float4(inputPosition.xyz,1)`. At91-93, EvaluateWorldPosition uses
  `mul(position,g_mWorld)`. `graphics/fx/source/Fx.cpp:172` uses MatrixRow44A16 for
  FX matrix storage; the material is16F32 components, with translation at12..14.

For serialized row-vector matrix `m`, world component `a` is:

`world[a] = x*m[a] + y*m[4+a] + z*m[8+a] + m[12+a]`.

The diagnostic evaluates constant material assignments in the above order,
including nested MATERIAL_INDEX references, and rejects unsupported dynamic
transform dependencies, recursion, nonfinite values and non-affine matrices.
It does not infer an identity matrix when no explicit transform is available.

## One complete real transformed instance

River node block253, first RenderList, instance0:

- basePrimitive0; effect `default_LN_NB_NL_NV.fx`.
- instance material10 sets `g_mWorld` at node-chunk byte9870; subsequent base and
  stream materials do not replace it.
- Translation: `[-38.88801193237305,5.673437118530273,1074.29736328125]`; the full
  matrix contains a nonidentity rotation/reflection and is in the JSON evidence.
- POSITION0 F32_3,stream0; VB ResourceIndex(27,0),IB ResourceIndex(27,0).
- LOD0 index offset4166,count1353,minIndex138,nVertices805,triangle strip.
- Degenerate connectors removed with strip parity restarted per draw:
  **805referenced vertices,726triangles**.

Block27 is the **eighth resource item** of stream chunk88, at original stream
offset12,478,464,stored1,624,064bytes. Its serialized resource spans chunk-relative
1,187,268..1,377,340. These offsets were obtained by sequential typed parsing of
preceding blocks1,4,5,6,10,16,20, including their buffers,nodes and texture tails.
They are evidence; an implementation must not hardcode these positions.

World bounds from the transformed referenced geometry:

| Axis | Minimum | Maximum |
| --- | ---: | ---: |
| X | -40.9950174085 | -36.6486578872 |
| Y | 5.6734369905 | 7.2041411137 |
| Z | 1071.6613682861 | 1076.8089986120 |

These agree with the separately serialized instance bounds within
**0.000038652**world units. The tool fails above0.0001. This supplies an
independent check of association,matrix orientation and translation rather than
only checking a transform against its own output.

Canonical output hashes:

- World XYZ F32LE:
  `5125314b04f46b997d4575478b11377ea72304aa9f2ee62d82f5bd7b1c1aa116`
- Compact U32LE triangle indices:
  `886e28559f186137e3ef5225768f61c4eccebf76ed4292ef5298c6ce887009fa`

The world hash uses Python binary64 products/sums rounded once toF32. Native/GPU
FMA and intermediate rounding can differ; this is not a bit-exact native shader
claim. A later C++ comparison should check bounded numeric error,counts,indices
and archived bounds, then document its arithmetic choice.

## Implementation status (first proof)

Completed:

1. `level_instances_inspect` searches every item in the geometry ChunkInfo
   record and parses all preceding items with origin0.
2. Node chunk first-item RenderList, instances, base primitives and material
   constants are parsed; instance/base streams are merged by slot.
3. Explicit constant affine `g_mWorld` is applied in source material order;
   dynamic, recursive, missing and non-affine transforms are rejected.
4. Real instance0 matches independent local vertices/indices, material trace
   and archived bounds. Native/WASM JSON is identical.

Still open: the other57instances, visibility, materials, higher LODs, GPU
instance buffers and gameplay. The API emits one CPU-expanded instance only.

## Implementation handoff

1. Extend bounded streamed resource traversal beyond first item. Source
   `target/streamdata.cpp:1007` ProcessLoadChunk consumes all ChunkInfo items in
   order with the same BinaryInputArchive origin. Block27 is not the first item,
   so the current `level_mesh_inspect` first-item requirement cannot load it.
2. Preserve per-resource metadata/cursors. Traverse every preceding resource's
   node and texture envelopes without resetting alignment to the item start;
   origin remains byte0of the containing stream chunk.
3. Preserve Instance records and base primitives, resolve declaration-selected
   streams and ResourceIndex mappings, then apply explicit constant world
   transforms per instance. Reject unsupported dynamic transforms/frequencies.
4. Test the real instance0above against independent local vertices,indices,
   material trace and archived bounds; add wrong-index/matrix/stream/range cases.
5. Only then assemble the remaining57instances and other source resources.
   Visibility,materials,higherLODs,instance batches and gameplay remain separate.

### Proposed additive C ABI boundary

Keep existing direct-only API behavior stable. Add a separate bounded function:

```cpp
char* level_instances_inspect(
    const unsigned char* level, size_t levelBytes,
    const unsigned char* geometryChunk, size_t geometryBytes,
    const unsigned char* nodeChunk, size_t nodeBytes,
    int32_t geometryBlock, int32_t nodeBlock);
// Free result with scene_free.
```

For the first proof the caller selects geometryBlock27,nodeBlock253. It obtains
both original ranges from `level_index_inspect` ChunkInfo records. The geometry
lookup must search **any item** matching(block27,lod0), require uniqueness, then
parse the containing archive from byte0through preceding items. Inputs remain
original levelrender + original complete source ranges, each<=16MiB; no generated
wrapper,fixture offset,JSON reference or guessed matrix crosses the runtime API.
The node block can retain the present first-item requirement for this first
implementation. Exact ChunkInfo lengths, nItems, item order and prerequisites
must be validated as in the existing API.

Return only instances whose selected POSITION and index resources both resolve
to the supplied geometryBlock, with transformed world-space positions,original
triangle topology,per-instance draw spans and source instance/base IDs. Other
resource dependencies must be counted as omitted. Mark transform application
explicitly (`instancesApplied:true`, constant affine matrices only); do not mark
the entire scene complete. CPU vertex expansion per instance is acceptable for
the first proof; GPU instance buffers are a subsequent optimization. Dynamic
materials,unresolved transforms,skinning or frequency streams remain explicit
unsupported cases. Never silently substitute identity for an unknown matrix.

Ignored evidence is in `_work/level-instances/`: three bounded node reports,
`first-instance.json`, `instance-node.chunk`, `instance-geometry.chunk` and
`inspection.log`, plus `verification.json`. Two repeated original parses produce
identical reports. Six malformed cases are rejected: rotation inconsistent with
archived bounds,LOD outside the IB,frequency stream,dynamic matrix reference,
missing explicit matrix,and recursive material. Node chunk SHA256 is
`65aec287878fa58405fa5ed585e6c43f3ba5ff683e825c0759b29f8fe8ccf20c`;
geometry chunk SHA256 is
`a813745141466d0918374927c40ad19b682121a10c2ddda1126257392f6c3b78`.

Run with the workspace Python runtime:

`python tools/inspect_level_instances.py`.
