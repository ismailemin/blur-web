# T-005d — Static collision oracle for `Level.levelphysics`: format proof and probe

**Date:** 2 November 2026
**Owner:** P15 (sub-agent)
**v2 update:** 5 November 2026, P24 (format contract only; see §11)
**Scope:** bounded, read-only format probe. One new probe directory
(`probes/collision-oracle/`), its evidence under `_work/collision-oracle/`, and
this document. No engine file, tool, task card, `upstream/`, `game-data/` or
`_work/native-source/` was modified. The game was not run. Nothing is wired into
the browser build.

**Result: the format is proven and implemented.** Two static mesh bodies of
`usa_la_river/Level.levelphysics` are decoded from bounded reads, and a fixed
query table produces **identical** `queryHash` values from a native x64 build, a
wasm32 build and an independent Python implementation
(`620eceeaf22edeed5069ecfc7ce5a709be51963974e081a8f6ead6d986c1063f`, format
contract v2). All 13 malformed/truncated inputs are rejected with a byte offset.
Parts that are deliberately not implemented are listed in §8 with the exact
stopping point.

---

## 0. Summary

1. The file is **not** an opaque format. It is a `Sys::C_FileBlock` stream with a
   little-endian PC fourcc, a `Physic` root, and `Header`/`Main`/`Routes`
   children. `Main` is a Gravity `C_ImportScene` stream (`"Head"`, version 10)
   holding two `E_ImportTriangleMesh_Shape` records, each containing an
   `OptimisedAABBTree` v10 and a `C_ShapeInstance`.
2. Every field the probe needs is fixed by source, not inferred: block framing,
   shape descriptor prefix, node record, triangle record, per-leaf vertex
   quantisation, index width, and the exact query loops.
3. The parse is **validated by consumption**: the two mesh records plus the
   `0x0fffffff` / `0xffffffff` terminators end exactly at the `Main` block
   boundary (1 896 928), with zero unread bytes, and each mesh's streamed
   triangle bytes equal its declared capacity byte-for-byte
   (485 040 and 177 088). Independent Python reads the same bytes to the same
   hashes.
4. The query surface implemented is the one the car actually uses on the ground:
   `C_Scene::FillCache` → `OptimisedAABBTree::FillLineCollisionCache` →
   `C_LineCollisionCache::Trace`, plus the tree ray trace and the static-mesh
   sphere query. Thin ray only; the wheel's fat/swept-sphere branch is **not**
   implemented (see §8).
5. Two portability findings fall out of the work and matter for T-005e/f:
   - retail `Normalise()` uses `_mm_rsqrt_ps` + one Newton–Raphson step, which is
     not correctly rounded and has no wasm equivalent; the probe uses exact
     `1/sqrtf` for its derived field and labels the deviation.
   - relying on function-argument evaluation order made MSVC and clang consume
     the query-seed RNG differently; all draws are now sequenced explicitly.
6. **Format contract v2 separates engine values from probe-added reporting.**
   The six fields where the real Gravity code and the v1 probe disagreed
   (material packing, patch vs per-contact normal, group-start vs per-triangle
   ordinal, unassigned trace flags, stored vs normalised trace normal, and the
   zero-length normal) are stored as explicit field pairs. Native, wasm32 and
   Python now agree byte for byte on the v2 records
   (`620eceea…c1063f`, 9 816 bytes). See §11.

---

## 1. File framing (proven)

| Claim | Source |
| --- | --- |
| PC fourcc is `'PC  '`, stored little-endian as `20 20 43 50` (`"  CP"`) | `code/mercury/library/common/system/include/system/misc/Platform.h:29` |
| block header = `C_String8 id` + `U32 size` + `U16 count` + `S8 type` + `S8 compression`, 16 bytes | `.../system/include/system/serialise/C_FileBlock.h:23-62` |
| `C_String8` is `C_FixedString<8>` and serialises as **8 raw characters**, not a length-prefixed string | `.../core/include/core/containers/FixedString.h:87-97`, `:158` |
| primitives are raw little-endian (`NoEndianSwap` on PC) | `.../system/include/system/serialise/BinarySerialise.h:21-48, 81-107`, `endian.h:82-90` |
| `size` counts from the start of the block header to the end of its data | `C_FileBlock.h:58`; `C_FileBlock.cpp:127-173` |
| block ids are matched by `HeaderId()` string compare; unread bytes are warned and skipped | `C_FileBlock.cpp:127-145` |
| `C_PhysicsLevel::Load` walks `Header` (version, routeCount), `Main`, `Routes` | `code/mercury/library/gamesys/game_resource/source/PhysicsLevel.cpp:41-111` |

Measured for `usa_la_river`:

| offset | block | size | count | type | contents |
| ---: | --- | ---: | ---: | ---: | --- |
| 0 | `"  CP"` | — | — | — | PC fourcc |
| 4 | `Physic` | 1 945 405 | 3 | 0x43 (header) | root; ends exactly at EOF (1 945 409) |
| 20 | `Header` | 24 | 0 | 0x41 | `fileVersion = 0`, `routeCount = 7` |
| 44 | `Main` | 1 896 884 | 0 | 0x41 | Gravity import stream |
| 1 896 928 | `Routes` | 48 481 | 7 | 0x43 | 7 route import scenes (not parsed) |

The `Header` block's `fileVersion` is the *physics-level* version (0 =
`E_PhysicsFileVersion_Initial`); it is not the Gravity data version. The Gravity
version is the in-stream `"Head"` version (10). Both are reported.

---

## 2. Import stream (proven)

`C_ImportScene::Import` reads a 4-byte `"Head"` fourcc, a `U32` version and a
`U32` shape type, then loops shape records until `0x0fffffff`, then constraints
until `0xffffffff` (`gravity/source/importer/Importer.cpp:271-337, 550-621`).

| field | layout | source |
| --- | --- | --- |
| `"Head"` | 4 raw bytes | `Importer.cpp:280-287` |
| stream version | `U32`; `10` here | `Importer.cpp:289-291`; `GRAVITY_CURRENT_VERSION` |
| shape type | `U32` `E_ImportShapeType`; `0` = `E_ImportTriangleMesh_Shape` | `Importer.cpp:292-298`; `gravity/include/gravity/narrowphase/Shape.h:20-46` |
| shape descriptor prefix (`ImportBasic`, v ≥ 7) | `F32 margin, F32 epsilon, U32 physicsMaterial, U32 effectMaterial, U32 collisionFlag, U32 nodeFlag, F32 mass, S32 originalExportID, HVec3 renderOffset (3×F32), U32 remapped, U32 userDataFlag` = **52 bytes** | `gravity/include/gravity/sdk/BodyHelper.h:149-160` |
| `HVec3` on the wire | 3 floats, 12 bytes | `core/include/core/maths/hvec/Vector.inl:4543-4558` |
| instance | `HVec3 position (12) + Matrix33 rotation (9×F32=36) + Matrix33 inertia (36)` = **84 bytes** | `BodyHelper.h:190-224`; `core/include/core/maths/storage.h:625-659` |
| mesh shape import | `ImportBasic` then `OptimisedAABBTree::DeSerialise` | `gravity/source/sdk/ShapeDescriptors.cpp:966-976` |

Measured record boundaries:

| mesh | record start | descriptor | tree header | tree end | instance | record end |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 68 (type) | 72 | 124 | 1 379 660 | 1 379 660 | 1 379 744 |
| 1 | 1 379 744 (type) | 1 379 748 | 1 379 800 | 1 896 836 | 1 896 836 | 1 896 920 |

Descriptor values are identical for both meshes except `m_OriginalExportID`
(0 and 1) and `m_CollisionFlag` (`0x0001017f`, `0x0000005d`):
`margin=0`, `epsilon=0x3c23d70a` (=`Maths::Constants<HF32>::Epsilon2()` = 0.01),
`physicsMaterial=0`, `effectMaterial=0`, `nodeFlag=16`, `mass=1.0`,
`renderOffset=(0,0,0)`, `remapped=0`, `userData=0`.

The `0x0fffffff` terminator sits at 1 896 920 and `0xffffffff` at 1 896 924, so
the shape stream ends at 1 896 924 and the block ends at 1 896 928. The probe
requires exactly this (`main_block_trailing` otherwise).

---

## 3. Triangle mesh encoding (proven)

`OptimisedAABBTree::DeSerialise` for stream version ≥ 10
(`gravity/source/narrowphase/OptimisedAABBTree.cpp:141-337`).

### 3.1 Tree header

```text
U32 m_NumVertices, m_NumNormals, m_NumTriangles, m_NumNodes
HVec3 m_Low, m_High                       (3 floats each)
Float3 m_pVertices[numVertices]           (3 floats each, 12 bytes)
HenDN3 m_pNormals[numNormals]             (U32 each; 11-11-10 packed normal)
OptimisedAABBNode m_pNodes[numNodes]
```

`m_NumTriangles` is **not** a triangle count. It is the byte capacity of the
in-memory triangle stream (`m_Triangles.Resize(m_NumTriangles)`,
`OptimisedAABBTree.cpp:187`), and the constructor overwrites it with the number
of bytes actually used (`:306-310`). For this level the stream uses exactly the
declared capacity: 485 040 and 177 088 bytes.

### 3.2 Node record

```text
C_QuantizedAxisBoxMinMax m_BoundingBox   six S16: min xyz, max xyz (12 bytes)
U32 m_TriangleSizeIndices                triangles in this leaf (0 = internal)
U32 m_TriangleStartIndex / m_RightChildOffset (union)
if version >= 10: U32 m_VerticeStartIndex, U32 m_NumVertices
```

28 bytes per node (`OptimisedAABBTree.h:276-293`, `OptimisedAABBTree.cpp:16-27`).
The quantised box is decoded with `local * (high − low) + low`
(`gravity/include/gravity/narrowphase/AxisBox.h:271-280`) where `local` is
`Fixed3_S16<14>` scaled by 2^−14 (`core/include/core/maths/hvec/Vector.inl:1960-1970`).

### 3.3 Triangle stream and index width

The triangle data is **not** a flat array. It is a byte stream laid out in leaf
order (the same stack order as the load-time traversal), where each group is:

```text
C_TriangleHeader: U32 collisionFlags, U16 physicsMaterial, U32 effectMaterial,
                  U32 userDataFlags, U8 numTriangles            (15 bytes on disk)
AABBTreeTriangle: U8 indexA, U8 indexB, U8 indexC,
                  U32 surfaceNormal (HenDN3), U32 activeEdgeDataIndex  (11 bytes)
```

| fact | evidence |
| --- | --- |
| indices are **`U8` on disk** because they are read into `U8 m_IndexA/B/C` | `OptimisedAABBTree.h:66-88`; `OptimisedAABBTree.cpp:29-53` |
| indices are **leaf-local**, i.e. offsets into `m_pVertices + m_VerticeStartIndex` | `OptimisedAABBTree_FillCache.inl:144, 182-187`; `OptimisedAABBTree.inl:200` |
| the writer's in-memory `sizeof` values (16 and 12) are used for buffer offsets, not the on-disk 15/11 | `OptimisedAABBTree.cpp:282-305` |
| `C_TriangleStream` is a raw `U8*` buffer, not a serialised container | `OptimisedAABBTree.h:122-193` |

Because `sizeof(C_TriangleHeader)` is 16 and `sizeof(AABBTreeTriangle)` is 12,
the load-time traversal advances its *buffer* offset by 16/12 while the file
cursor advances 15/11. Both counters are reproduced separately; confusing them
shifts every subsequent node. The probe asserts
`bufferBytes <= capacity` and reports both.

### 3.4 Per-leaf vertex quantisation

At load time each leaf quantises the stream vertices that belong to it, against
**its own decoded box**:

```text
recip     = 1 / (box.max - box.min)                 componentwise
local     = (vertexStream[i] - box.min) * recip      componentwise
vertexS16 = (S16)(local * 16384.0f)                  truncation toward zero
```

(`OptimisedAABBTree.cpp:246-275`; conversion `Vector.inl:1992-2002`.)

At query time vertices are reconstructed against the **same node box**:

```text
value = decode(vertexS16) * (box.max - box.min) + box.min
```

(`OptimisedAABBTree_FillCache.inl:150, 185-187`; `OptimisedAABBTree.inl:60, 76-81`.)
The range is therefore the *quantised* box range, not the exporter's original
range — a real precision quirk that must be reproduced bit-for-bit. Note also
that `OptimisedAABBTree::GetVertex()` (`OptimisedAABBTree.h:381-388`) uses the
tree-wide `m_Low/m_High` instead; the four query paths implemented here do not
call it, so the probe follows the leaf-box form used by the traffic paths.

### 3.5 Normals

`HenDN3` is an 11-11-10 signed normalised triple in one `U32`
(`core/include/core/maths/storage.h:905-918`), decoded as
`x/1023, y/1023, z/511` with sign extension
(`core/include/core/maths/hvec/Storage.inl:250-261`). Query paths wrap it in
`C_Normal(v, UNIT_LENGTH_VECTOR)`, whose two-argument constructor **copies
without normalising** (`Vector.inl:8013-8016`), so the decoded vector is used
as-is. That matters: the values are not exactly unit length.

### 3.6 Endianness and units

Everything is little-endian, consistent with the `NoEndianSwap` deserialiser on
PC (`endian.h:82-90`). No scale factor is applied at any stage: the decoded
coordinates are the coordinates the tree stores, and the probe never converts
units. Whether one unit is one metre is **not proven here** and is not assumed.

### 3.7 Parsed result

| | mesh 0 | mesh 1 |
| --- | ---: | ---: |
| vertices | 44 970 | 17 671 |
| normals | 25 540 | 1 264 |
| nodes / leaves | 8 293 / 4 147 | 3 535 / 1 768 |
| triangle headers | 6 420 | 1 780 |
| triangles | 31 860 | 12 384 |
| triangle buffer bytes / capacity | 485 040 / 485 040 | 177 088 / 177 088 |
| active-edge normal sets | 4 894 | 3 165 |
| local bounds min | (−117.030, −7.972, 834.968) | (−106.212, −107.368, 835.026) |
| local bounds max | (1692.342, 125.976, 3485.234) | (841.192, 109.226, 2569.558) |
| instance | identity | identity |
| vertex-stream hash | `520de8aa045bf75f…` | `24fa74d0d9e42e18…` |
| quantised-vertex hash | `03df2169e0cb8a0c…` | `5878d059ec8b369f…` |
| normal-array hash | `540430dd5f3dc93e…` | `ca43cc2493e03fe4…` |
| triangle hash | `07df0bb23c210bfb…` | `e9e01fc59eeb918a…` |

The union bounds are min `(−117.030, −107.368, 834.968)` and max
`(1692.342, 125.976, 3485.234)`. All 44 244 triangles have valid leaf-local
indices, and every leaf box is well formed.

---

## 4. Query paths implemented

Four paths, each re-expressed from source with the same traversal order, the
same early-outs and the same integer fields:

| path | function | source |
| --- | --- | --- |
| thin ray | `OptimisedAABBTree::RayTracing` + `CollideRayTriangleMesh` | `OptimisedAABBTree.inl:146-228`, `RayTriangle.inl:44-114` |
| ray setup | `C_Ray::InitialiseRay(start, dir, maxDistance, filter, radius)` | `Ray.h:166-190` |
| wheel box fill | `C_Scene::FillCache` → `FillLineCollisionCache` | `Scene_FillCache.inl:11-56`, `OptimisedAABBTree_FillCache.inl:12-212` |
| cache trace | `C_LineCollisionCache::Trace` (thin branch) | `LineCollisionCache_Trace.inl:184-228` |
| sphere vs mesh | `CollideSphereTriangleMesh<6,16>` driven by `OptimisedAABBTree::Collide` | `SphereTriangle.inl:94-202`, `OptimisedAABBTree.inl:13-137`, `ResultSize.h:4-5` |
| supporting math | `IntersectTriangleSegmentSB`, `ClosestPtPointTriangle`, `IntersectRayAABBMinMax`, `IntersectAABBTriangle`, `C_AxisBoxMinMax::Intersects` | `Primitive.inl:520-544`, `PrimitiveClosestPointsTest.cpp:493-558`, `PrimitiveTest.inl:377-408`, `OptimisedAABBTree_FillCache.inl:12-85`, `AxisBox.inl:76-88` |

Constants: `DEFAULT_CACHE_SIZE = 4` (`LineCollisionCache.h:9`),
`Static_MaxPatches = 6`, `Static_MaxContacts = 16` (`ResultSize.h:4-5`),
`CloseNormal = 0.995f` (`gravity/source/sharedphysics/GravityConstants.cpp:11`),
`Epsilon = FLT_EPSILON`, `Epsilon2 = 0.01f`
(`core/source/maths/hvec/Constants.cpp.inl:8-10`).

The wheel parameters come from `Car::CreateGravityCache`
(`racingphysics/source/vehicles/Car/car.cpp:597-627`): box extrusion by
`(velocity/60 + normal*2.0)*0.5`, `normal = −Y`, `maxCosAngle = −0.25`; and
`CarWheel::GetGroundIntersection` (`carwheel.cpp:418-471`) sets
`maxCosAngle = −0.25` on the ray. The probe uses these as the documented
fixture values for the cache queries.

The collision filter is `C_CollisionFilter()`'s default (flags and mask all
ones, body flags/mask all ones, no negation; `CollisionFilter.h:43-50`), because
the car's real wheel filter is data-driven and not present in the level file.
With that filter, `CanCollide(flags)` is `flags != 0`
(`CollisionFilter.inl:39-43`); in this level every header has non-zero collision
flags, so nothing is filtered and the report shows `headersFiltered = 0`.

### 4.1 Query table

24 rays, 24 sphere/point queries, 8 cache queries, all derived deterministically
from the mesh (see the probe README §5). Points worth noting:

- the 12 `ray-random-*` rays aim at a triangle centroid, so they exercise the
  traversal, the last-hit-wins rule and the `cosAngle` test;
- the 6 `point-vertex-*` radius-0 queries sit exactly on a decoded vertex, so a
  correct decode must produce penetration 0 — a cheap end-to-end self-check;
- `cache-7` uses a whole-level box to force the 4-entry cap and the early return.

---

## 5. Native / wasm32 / Python equality (the gate)

```text
python probes/collision-oracle/tests/run_collision_oracle.py
```

| gate | result |
| --- | --- |
| native MSVC `/W4 /permissive-` | 0 warnings |
| CTest | 2/2 (`collision_oracle_selftest`, `collision_oracle_unit`) |
| native run, twice | byte-identical JSON |
| wasm32 run, twice | byte-identical JSON |
| native vs wasm32, whole document | identical except the recorded `build` block and `input.label` |
| native vs wasm32, `queryHash` | **identical** |
| native vs Python, `queryHash` and every canonical record | **identical** |
| Python vs native, mesh hashes (vertices, quantised vertices, normals, nodes, triangles) | **identical** |
| malformed/truncated inputs | 13/13 rejected; native and wasm32 agree on code and offset |
| formatVersion | 2 in the native, wasm32 and Python documents |
| timings | native 0.02 s, wasm32 0.09 s (node), Python reference 0.35 s |

```text
formatVersion 2
queryHash 620eceeaf22edeed5069ecfc7ce5a709be51963974e081a8f6ead6d986c1063f
canonicalRecordBytes 9816
input 1 945 409 B sha256 1e678b2dff61b6d3a3d5d95a5160c3f713290251667cb27c55e262175efe4e28
```

The retired v1 hash is `f87365b79fc1217da4280d6d5748ca6dc6808b89382b87de43ddcbfe6c9b5d6e`
(7 768 bytes). It is documented as superseded in §11 and in the probe README;
the v1 evidence is preserved under `_work/collision-oracle/v1/`.

Outcomes: 15/24 rays hit, 17/24 sphere queries hit with 60 contacts total, cache
fills produced 3/1/1/1/4/4/0/4 triangles, 5/8 cache traces hit.

How exactness was achieved (each of these was a measured failure first):

1. **All floats are emitted as binary32 bit patterns**, never decimal text, so
   no libc formatting difference can appear in the document.
2. **Contraction is disabled on both targets**: `#pragma fp_contract(off)` on
   MSVC and `-ffp-contract=off` on clang, so no `a*b+c` becomes an FMA on one
   target.
3. **Evaluation order of RNG draws is explicit.** The first version passed three
   `rng.unit()` calls as function arguments; MSVC evaluates right-to-left and
   clang left-to-right, so the x and z components of the ray fixture were
   swapped between targets. The twelve downward rays (no RNG) matched; all
   twelve random rays differed. Sequencing each draw fixed every record.
4. **Per-operation binary32 rounding in Python.** Python is binary64; the
   reference rounds after every `+ − × ÷ √` so it reproduces the C++ scalar
   results exactly, including the IEEE inf/NaN cases that Python raises on.
5. **`minf/maxf` and `Select` are written as explicit conditionals** so a NaN
   operand takes the same branch as `_mm_min_ps` / `Maths::Select`.

---

## 6. Findings that affect the port

### 6.1 `Normalise()` is not correctly rounded on retail PC

`HVec3::Normalised()` → `v * ReciprocalSqrt(length2)` →
`HF32::RcpSqrt()` → `SIMD_ScalarReciprocalSqrt` → `SSE_RcpSqrtSS`, which is
`_mm_rsqrt_ps` followed by one Newton–Raphson step
(`core/include/core/maths/hvec/SIMD_SSE.inl:926-941`, `Scalar.inl:625-672`,
`VectorOp.inl:1246-1292`). `_mm_rsqrt_ps` is a 12-bit estimate; after one NR step
the result is close to, but not necessarily equal to, the correctly rounded
`1/sqrt`. Consequences:

- normals produced by `C_Normal(HVec3)` (the sphere path, the cache trace
  result, ray results) are **not** reproducible on wasm by simply calling
  `1.0f/sqrtf`.
- A port that must match retail bit-for-bit has to emulate the instruction
  (seed table + NR) or accept a documented difference. v2 records the
  engine-shaped value with the non-PS3 `ReciprocalSqrt` rule (exact `1/sqrt`,
  zero for `len2<=0`) as `patchNormal`/`engineNormalStored`, and the probe-derived
  exact value as `contactNormalDerived`/`normalDerivedNormalised`. Neither is
  claimed to equal the retail binary's normal bits.
- Note the triangle/segment and closest-point paths do **not** normalise, so the
  geometry-level results (contacts, distances, indices) are unaffected by this;
  only reported surface normals are.

### 6.2 The four-entry cache makes order part of the answer

`FillLineCollisionCache` returns as soon as `cache.Full()`
(`OptimisedAABBTree_FillCache.inl:199-200`) and `Trace` keeps the **last**
accepted triangle in cache order, not the nearest
(`LineCollisionCache_Trace.inl:184-205`). `cache-5` and `cache-7` in this fixture
cache four triangles immediately; `cache-7`'s trace then misses because the
20 m downward segment from the top of the whole-level box does not reach a
surface at that x/z, which is a property of the fixture, not of the cache.
Any change in node traversal order changes *which* triangles are available and
therefore the answer — the same risk the T-005d feasibility analysis flagged for
D2.

### 6.3 Byte-offset "triangle indices" and the v2 split

`RayTriangle.inl:104` writes
`m_TriangleIndex = triangleStartIndex + sizeof(Triangle) * triangleIndex`,
where `triangleStartIndex` is a leaf-relative **byte** offset into the in-memory
stream and `triangleIndex` is the accepted triangle's ordinal inside the header
group. That is a genuine engine value and v2 names it
`engineTriangleStreamValue`.

`OptimisedAABBTree_FillCache.inl:201` passes
`a + fetchedNode->m_TriangleStartIndex`, where `a` is the header **group's
first** leaf-local ordinal (not the per-triangle ordinal) and the second term is
the leaf stream's byte start. The v1 probe stored the per-triangle ordinal
instead; v2 now reports all three separately:

- `engineTriangleStreamValue` — the exact value the engine passes to
  `AddTriangle` (leaf byte start + group first ordinal);
- `leafStartOrdinal` — the header group's first ordinal;
- `perTriangleOrdinal` — the actual triangle's leaf-local ordinal.

None of these is a global triangle id, and the probe does not invent one. The
same split is carried through the cache trace (`LineCollisionCache_Trace.inl`),
which copies the cache entry's `m_TriangleIndex`.

---

## 7. What was proven, and how

| claim | how it was checked |
| --- | --- |
| block framing and sizes | root size equals file size − 4; each child lies inside its parent; `Main` consumes exactly 1 896 884 bytes |
| import stream layout | two shapes parse, terminators land on the block end, zero unread bytes |
| descriptor size (52) | next field (`numVertices`) lands on a plausible value only at 124, and the whole main block then closes exactly |
| node record (28) | 8 293 nodes end exactly where the triangle stream begins, and the stream then closes exactly |
| triangle records (15/11 on disk) | total stream bytes equal the declared capacity to the byte, twice |
| index width/locality | all 44 244 triangles have `index < leaf.numVertices`; the radius-0 vertex point queries return contacts with penetration 0 |
| quantisation | Python recomputes the quantised array and hashes it; hashes match native and wasm32 |
| query semantics | 56 canonical v2 records match across three implementations (native, wasm32, Python) |

Reproduce: `python probes/collision-oracle/tests/run_collision_oracle.py`
(see `probes/collision-oracle/README.md` for every manual command).
Evidence: `_work/collision-oracle/{summary,native,native2,wasm,reference}.json`
and `_work/collision-oracle/logs/`.

---

## 8. Explicitly unsupported — with the exact stopping point

| not implemented | why, and what the probe does instead |
| --- | --- |
| **fat/swept-sphere ray** (`m_bFatTrace`, which is what the wheel actually uses because `CollisionRadius() > 0`) | needs `IntersectTriangleSegmentSB`'s swept-sphere branch (`Primitive.inl:780-830`, `TriangleSurfaceSweptSphere`/`EdgeSweptSphere`) **and** the wheel radius, which comes from car/XT data, not from the level file. The probe fixes `rayRadius = 0`, reports `rayRadius:"0x00000000"` and `fatTrace:"unsupported"`, and implements only the thin branch. |
| **sphere/capsule/box proxies of real bodies** | only `CollideSphereTriangleMesh` is implemented. OBB/capsule/cylinder vs mesh run through GJK/MPR TUs (`CollisionManager_Mesh.cpp:104-165`), a different closure. |
| **constraints** | the probe accepts only an empty constraint list and reports `unsupported_constraint` with the offset of the offending type word. This file has none (`0xffffffff` immediately after the shape terminator at 1 896 924). |
| **`Routes` scenes** (7 blocks) | validated as a block and reported (`routesParsed:false`); route/trigger geometry is not part of the main static mesh query. |
| **other import shape types** | anything other than `E_ImportTriangleMesh_Shape` (0) stops with `unsupported_shape_type` at the type word. |
| **non-identity `C_ShapeInstance` transforms** | reported, not applied; all instances here are identity. A non-identity instance would be reported (`identityInstance:false`) without being applied, and the probe would then be answering in local space. |
| **this file's own `Routes`-local meshes, cloth/fluid/deformable shapes, triggers** | not parsed. |
| **engine integration, vehicle physics, playable game** | out of scope. No `Scheduler::`, `C_Scene`, DX11 or game code is involved. |

No geometry, transform, scale or material is fabricated anywhere: every emitted
number comes from the file or from arithmetic on file-derived values, and every
query that the probe cannot answer is a named, reported state
(`hit:false`, `unsupported`, or a parse error with an offset).

---

## 9. Recommended next slice

1. **Wire the probe into the main suite** (`tools/verify_asset_probe.py`): one
   step, `('collision-oracle', [sys.executable,
   'probes/collision-oracle/tests/run_collision_oracle.py'])`. The main agent
   owns that file.
2. **Wire the engine harness to formatVersion 2** and update
   `engine/verify_gravity.py` to read the v2 layout and expect
   `620eceea…c1063f`. That is the main agent's change (P17's files); this probe
   only defines and proves the contract. Once wired, the only permitted
   difference is the unassigned `trace.collisionFlags`, which v2 represents as
   `assigned=0` plus a sentinel.
3. **Add the fat-ray branch** only after the wheel radius is available from a
   decoded car/XT record, so the swept-sphere path is exercised with a real
   radius. Until then a fat-ray oracle would need an invented radius.
4. **Decide the `Normalise()` policy** before any D2 comparison: emulate
   `_mm_rsqrt_ps` + NR, or use the non-PS3 exact `1/sqrt` with the zero guard.
   v2 already separates the engine-shaped value from the probe-derived value, so
   the choice changes only the labelled field.
5. **Reuse this reader for the `Routes` blocks** if route/trigger geometry is
   needed; the container layout is identical (only the shape list differs).

---

## 10. Evidence index

| topic | path |
| --- | --- |
| probe, build, CLI, records | `probes/collision-oracle/` (README §1-§10) |
| run summary, hashes, malformed table | `_work/collision-oracle/summary.json` |
| native / repeat / wasm / wasm repeat / Python documents (v2) | `_work/collision-oracle/{native,native2,wasm,wasm2,reference}.json` |
| preserved v1 evidence (superseded) | `_work/collision-oracle/v1/` |
| engine v1 vs probe v2 field comparison | `probes/collision-oracle/tests/compare_engine_v1_to_v2.py` |
| command logs | `_work/collision-oracle/logs/` |
| rejected inputs | `_work/collision-oracle/malformed/` |
| feasibility context | `docs/work/analysis/t005-physics-feasibility.md` |
| task card | `docs/work/tasks/T-005-single-player-vertical-slice.md` |

Source anchors (all read-only, `upstream/BlurRebuilt@5270304b`), with
`code/mercury/library/` abbreviated as `…/`:

| claim | source |
| --- | --- |
| PC fourcc | `…/common/system/include/system/misc/Platform.h:29` |
| block header + sizes | `…/common/system/include/system/serialise/C_FileBlock.h:23-62`; `…/source/serialise/C_FileBlock.cpp:75-173` |
| fixed 8-char id | `…/common/core/include/core/containers/FixedString.h:87-97, 158` |
| primitive serialisation | `…/serialise/BinarySerialise.h:21-48, 81-107`; `endian.h:82-90` |
| physics level load | `…/gamesys/game_resource/source/PhysicsLevel.cpp:41-111` |
| import scene, shapes, terminators | `…/physics/gravity/source/importer/Importer.cpp:271-337, 550-621` |
| shape descriptor | `…/physics/gravity/include/gravity/sdk/BodyHelper.h:149-160, 190-224` |
| mesh shape import | `…/physics/gravity/source/sdk/ShapeDescriptors.cpp:966-997, 1037-1094` |
| AABB tree v10 | `…/physics/gravity/source/narrowphase/OptimisedAABBTree.cpp:16-100, 141-337` |
| node/triangle/header structs | `…/physics/gravity/include/gravity/narrowphase/OptimisedAABBTree.h:66-120, 276-293, 604-618` |
| quantised box | `…/physics/gravity/include/gravity/narrowphase/AxisBox.h:232-316` |
| Fixed3_S16<14> codec | `…/common/core/include/core/maths/storage.h:746-760`; `…/hvec/Vector.inl:1940-2004` |
| HenDN3 codec | `…/common/core/include/core/maths/storage.h:905-918`; `…/hvec/Storage.inl:230-263` |
| HVec3 wire size | `…/hvec/Vector.inl:4543-4558` |
| Matrix33 wire size | `…/common/core/include/core/maths/storage.h:625-659` |
| fill cache | `…/physics/gravity/include/gravity/sdk/Scene_FillCache.inl:11-56`; `…/narrowphase/OptimisedAABBTree_FillCache.inl:12-212` |
| cache size + trace | `…/narrowphase/LineCollisionCache.h:9, 132-155`; `…/LineCollisionCache_Trace.inl:17-228` |
| ray trace | `…/narrowphase/OptimisedAABBTree.inl:146-228`; `…/RayTriangle.inl:44-114`; `…/Ray.h:166-190` |
| sphere vs mesh | `…/narrowphase/SphereTriangle.inl:94-202`; `…/OptimisedAABBTree.inl:13-137`; `…/ResultSize.h:4-5` |
| supporting primitives | `…/narrowphase/Primitive.inl:520-544`; `…/PrimitiveClosestPointsTest.cpp:493-558`; `…/PrimitiveTest.inl:377-408`; `…/AxisBox.inl:76-88` |
| constants | `…/physics/gravity/source/sharedphysics/GravityConstants.cpp:6-27`; `…/common/core/source/maths/hvec/Constants.cpp.inl:8-10` |
| collision filter | `…/physics/gravity/include/gravity/narrowphase/CollisionFilter.h:43-50`; `CollisionFilter.inl:8-43` |
| `Normalise` on PC | `…/common/core/include/core/maths/hvec/SIMD_SSE.inl:926-941`; `Scalar.inl:625-672`; `VectorOp.inl:1246-1292` |
| wheel query parameters | `…/physics/racingphysics/source/vehicles/Car/car.cpp:597-627`; `carwheel.cpp:418-471` |

---

## 11. Format contract v2 (engine value vs probe-added reporting)

The Gravity spike (`docs/work/analysis/engine-gravity-layer.md`) found six
fields where the real engine's query results and the v1 probe's re-expression
disagreed. None was a geometric error; all six were **reporting semantics**.
v1 mixed the two meanings in one field, so no exact engine/probe equality was
possible. `formatVersion 2` makes the distinction explicit.

| # | v1 problem | v2 engine-value field(s) | v2 probe-derived field(s) |
| ---: | --- | --- | --- |
| 1 | sphere materials | `body*Material`, `triangle*Material`, `engine*Material = body \| triangle<<16` | the split body/triangle fields |
| 2 | sphere normals | `patchNormal` (`C_ContactPatch::m_Normal`, engine `ReciprocalSqrt`, zero at `len2<=0`) | `contactNormalDerived` (exact `1/sqrt`, NaN at zero) |
| 3 | cache triangle index | `engineTriangleStreamValue`, `leafStartOrdinal` | `perTriangleOrdinal` |
| 4 | trace `collisionFlags` | `collisionFlagsAssignedByEngine=0`, `engineCollisionFlagsValue=0` | `cachedTriangleCollisionFlags` |
| 5 | trace normal | `engineNormalStored` (non-unit decoded `HenDN3`) | `normalDerivedNormalised` |
| 6 | zero-length contact | `patchNormal = (0,0,0)` | `contactNormalDerived = NaN` |

Exact v2 byte layouts are in `probes/collision-oracle/README.md` §4. Sizes:
ray 80 B, sphere 32 B + 80 B/contact, cache 32 B + 76 B/entry + 88 B/trace.
This file's canonical stream is 9 816 bytes and hashes to
`620eceeaf22edeed5069ecfc7ce5a709be51963974e081a8f6ead6d986c1063f`.

### 11.1 Engine comparison without editing the engine verifier

`engine/harness/t005d/` still emits v1 records and
`engine/verify_gravity.py` is P17-owned; neither was modified here. The probe
ships `tests/compare_engine_v1_to_v2.py`, which decodes the **existing** engine
v1 document and compares every engine-assigned field with the v2 engine-value
field:

```powershell
python probes/collision-oracle/tests/compare_engine_v1_to_v2.py `
  --engine _work/engine-gravity-spike/gravity_a.json `
  --probe  _work/collision-oracle/native.json
```

Measured result: **840 assigned field groups match**, including
bit-identical packed materials, patch normals and stored trace normals. The
only remaining delta is `trace.collisionFlags`: the thin
`C_LineCollisionCache::Trace` branch never writes `m_CollisionFlags`
(`LineCollisionCache_Trace.inl:184-225`; `C_RayTracingResult`'s constructor does
not initialise it), so the engine words vary
(`0x44a2fcbc`, `0x44863571`, `0x440a8229`, `0x448807cd`, `0x43060611`). v2
cannot and must not hash that memory; it reports `assigned=0`, writes the zero
sentinel, and stores the cached triangle's flags as separate reporting.

No v2 `queryHash` equality is claimed: the engine still emits v1 records. Once
the harness is wired to v2, the hash comparison becomes meaningful; the
field-level result above shows the decode/traversal/intersection values are
already exact.

### 11.2 v1 lifecycle

v1 production is retired. The v1 layout remains documented (probe README §4.5)
and the pre-change evidence is preserved under `_work/collision-oracle/v1/`, so
v1 documents stay readable for one cycle. A v1 document cannot be converted to a
v2 hash: it never recorded body materials, patch normals, leaf-start ordinals or
the stored trace normal. `compare_engine_v1_to_v2.py` is the documented reader
for that cycle.

### 11.3 Limits

- This is a **probe contract**, not engine code: no vehicle physics, renderer,
  browser/WebGPU or playable-game claim is made.
- Retail-binary bit equality is still not claimed; the retail `Normalise`
  (`_mm_rsqrt_ps` + NR) is not emulated. v2 only separates the non-PS3
  engine-shaped value from the probe-derived one.
- The fat/swept-sphere ray, capsule/box proxies, constraints, `Routes` scenes
  and non-identity instance transforms remain unsupported exactly as §8 states.
- `trace.collisionFlags` is excluded from the engine equality claim because the
  engine never assigns it; it is not a contract value.
