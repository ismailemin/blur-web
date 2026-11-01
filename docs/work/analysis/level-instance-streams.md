# River node253 instance bounds: transform-group evidence

**Status:** read-only analysis. No source, task card, upstream file or game data was
modified; no fix is claimed. One document was written (this file) plus temporary
scripts and one JSON artifact under `_work/`.

**Date:** 2 November 2026
**Level:** `game-data/Blur/levels/usa_la_river`
**Node chunk:** 53 (`block 253`, LOD0 item 0)
**Geometry blocks referenced by the node list:** 15, 17, 26, 27, 31, 32

## 1. Question

`level_instances_all` emits 18 of node253's 57 instances (block27 14 + block15 4)
and skips 39: 38 with `unsupportedBoundsInstances` and one (block31) because the
geometry chunk declares prerequisites. The open question was whether those
instances need extra vertex streams/deformation, a different LOD selection, a
non-affine/dynamic transform, a different index range, or whether the archived
bounds had been compared incorrectly. Task cards and verification notes currently
attribute the failure to "base primitive 11–35 stream semantics"
(`docs/work/tasks/T-003-scene-traversal.md:30-33,58-59`,
`docs/work/verification/T-003.md:21-23,52-53`).

**Result of this analysis:** the mismatch is a bounds-record semantics error.
`instanceBounds[i]` is not the bound of draw `i`; it is the bound of the
*CullNode* (one placed object) that produced draw `i`, serialized once per draw.
Every mismatch is exactly an instance whose object contributes more than one draw
to this RenderList. No vertex data, stream, LOD range or transform is missing.

## 2. Inputs and reproduction

Artifacts (all under `_work/`, not committed):

| Path | Content |
| --- | --- |
| `_work/level-instances/bounds-253.json` | per-instance arrays: base, block, VB/IB indices, stride, LOD, used vertices, matrix trace, per-draw world AABB, archived record, errors |
| `_work/level-instances/bounds-groups-253.json` | per-transform-constant groups, member lists, archived record, group-union AABB, union error, byte-identity flag |
| `_work/level-instances/an5.py` … `an14.py` | temporary read-only probes used for this document |
| `_work/logs/p2-bounds-analysis.log` | console output of the bounds run |

`bounds-groups-253.json` is deterministic: two consecutive runs (an6 → an12)
produce SHA-256 `0784c6ff0cc68e92656aaae6ac040ae242366aeeed8e0266f7a12dacecf53c23`.

Canonical hashes computed during this analysis:

| Object | Offset / size | SHA-256 |
| --- | --- | --- |
| `level.levelrender` | — | `0408e434e5c7f28e5c8f873fac7b33832daf0de29ae404e8a4205433a8b557f9` |
| node chunk 53 (block 253) | 2 990 080 / 26 624 | `65aec287878fa58405fa5ed585e6c43f3ba5ff683e825c0759b29f8fe8ccf20c` |
| geometry chunk 88 (blocks 27, 32) | 12 478 464 / 1 624 064 | `a813745141466d0918374927c40ad19b682121a10c2ddda1126257392f6c3b78` |
| geometry chunk 86 (blocks 15, 17) | 9 093 120 / 2 045 952 | `15a3e7efd0ea82235d3765a2ef494d9c7e08d43809f5f9e07beba76c7625c565` |
| geometry chunk 85 (block 26) | 7 477 248 / 1 615 872 | `da8aaa1a23a0c3f18660ffaf65d747fecc9618bc743ec33f387ebc8704211c37` |
| geometry chunk 96 (block 31) | 21 426 176 / 1 312 768 | `71ae1efe0be4ee9e92ac0d8b4e280b0d900beddb1f0e9d6f1b3a3273622ba275` |

Commands (bundled runtime):

```powershell
C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe _work/level-instances/an6.py
C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe _work/level-instances/an10.py
C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe _work/level-instances/an11.py
C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe _work/level-instances/an12.py
C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe _work/level-instances/an13.py
```

The probes reuse the repository readers (`tools/inspect_car_level_assets.py`,
`tools/inspect_level_chunk.py`, `tools/inspect_level_instances.py`,
`tools/inspect_car_materials.py`) and never write to game data.

## 3. Serialized layout actually observed

`RenderListNode_Common` serialization order
(`probes/asset-reader/src/scene_reader.cpp:258-278`,
`tools/inspect_level_chunk.py:31-67`):

1. version, `CullNode`, material types + material data
2. `primitives[5]`, `instances[57]`, `instanceBatches[0]`, `basePrimitives[36]`
3. constant transform rows, `[6]` trailing 24-byte records
4. `primitiveBounds[5]`, `instanceBounds[57]`, `instanceBatchBounds[0]`
5. three PVS blocks, visibility vector, `[0]` flags
6. dynamic material lists (version 0 here), index/vertex/texture source tables
7. chunk data (25 entries)

The three bounds arrays are `RenderingData::Bounds`
(`upstream/.../include/renderingdata/bounds.h:11-16`): `Point3 aabbMin`,
`Point3 aabbMax`, `float distanceMin`, `float distanceMax` = 8 float32 = 32 bytes.
Each serialized element is preceded by an archive object marker
(`scene_reader.cpp:43` `void bounds(){ar();skip(32);}`,
`inspect_level_chunk.py:39`), so one entry is 36 bytes.

`archive.inl:932-934` names the three arrays `PrimitiveBounds`, `InstanceBounds`,
`InstanceBatchBounds`. `inspect_level_instances.py:34` and
`scene_reader.cpp:268-270` read them in that order; nothing else in the tail
changes the interpretation.

Recorded facts for node253:

| Fact | Value |
| --- | --- |
| instances / base primitives / primitives / batches | 57 / 36 / 5 / 0 |
| constant transform rows / trailing 24-byte records | 34 used / 6 |
| `instanceBounds` entries | 57 (same count as instances) |
| `primitiveBounds` entries | 5 (the 5 `primitives`, not the 36 base primitives) |
| `instanceBatchBounds` entries | 0 |
| declarations used by the 36 base primitives | only declaration 0 |
| declaration 0 | POSITION usage0/idx0 type6(F32_3) method0 stream0 @0; NORMAL usage3 type11 stream0 @12; UV0 usage5 type8 stream0 @16 |
| base primitive streams | exactly 1 per base, slot 0, `frequency 0`, `vertexOffset 0` |
| instance streams | 0 for all 57 instances |
| topology / index width | triangle strip (1) / uint16 (2) |
| effects | 10 = `default_LN_NB_NL_NM_NV.fx` (bases 34-35), 11 = `default_LN_NB_NL_NV.fx` (bases 0-33) |
| referenced VBs | stride 20, three elements, layout above |
| unreferenced extra VBs in the same items | stride 28, five elements: the three above plus type10 usage5 idx3 @20 and type11 usage5 idx4 @24 (block27 24 verts, block15 none, block17 1103, block26 144/56, block31 3442, block32 56) |

Whatever the extra stride-28 buffers are for, **no base primitive of this
RenderList references them**: the node's `vertexBuffer` sources are
`[{252,0},{27,0},{15,0},{26,1},{32,0},{17,0},{31,1}]`, and every base stream
resolves through one of those. They are also unnecessary for reproducing the
archived records (section 6).

## 4. What the archived instance bounds actually are

### 4.1 Upstream mechanism

`renderlistbuild.cpp:327-340` (`AddInstance`) creates one `InstanceSource` per
model primitive of a single placed object, all carrying the same `cullNode`; the
build loop at `:506-530` then appends one render-list instance per source. The
first statement of `AddInstanceToRenderList` is `renderlistbuild.cpp:579`:

```cpp
m_renderLists[pass].pNode->m_sceneGraphData.instanceBounds.PushBack(
    instanceSource.cullNode->GetBounds());
```

So one entry is appended per draw, but the value is the **CullNode's bound** (one
placed object), not the draw's own geometry bound. A CullNode contributing `n`
primitives to a render pass therefore writes the same record `n` times, in
consecutive order (the loop is over one model instance at a time). These bounds
are then used as instance culling bounds
(`StaticRenderListNode.cpp:316`, `scenebuild.cpp:1651`) and as culling volumes for
texture bounds (`scenetextures.cpp:273-293`), which is why they are conservative
with respect to a single draw.

The two scalar fields are draw-distance limits: `bounds.inl:38-52` merges
`distanceMin`/`distanceMax` with `Min`/`Max`, and `build.cpp:337` sets
`distanceMax = LodCalculator::LodDrawDistance(item.lod, …)` for a related bounds
record (chunk bounds), which fixes the meaning of the field even though the
CullNode construction path was not traced further here.

### 4.2 Measurement on node253

Per-draw world AABBs were computed independently from the original vertex/index
data (LOD0 strip indices, degenerate connectors dropped, one explicit constant
affine `g_mWorld` per instance, row-vector semantics
`world[a] = x·m[a] + y·m[4+a] + z·m[8+a] + m[12+a]`), see
`tools/inspect_level_instances.py:73-95,143-157` and
`scene_reader.cpp:798-878`.

Then the 57 entries were grouped by their single resolved `g_mWorld` constant row
(`matrixAssignments[0].material`; each instance has exactly one such assignment):

| Measurement | Result |
| --- | --- |
| instances | 57 |
| distinct resolved transform constants | **34** |
| distinct archived 8-float records (byte-exact) | **34** |
| distinct matrix *values* (16 as previously reported) | 16 |
| group sizes | 19×1, 9×2, 4×3, 2×4 |
| records byte-identical across members of one group | 34/34 |
| group members form contiguous instance ranges | 34/34 |
| max abs difference between group-union AABB and archived AABB | **6.024437e-05** |
| compare tolerance in the reader | 1e-4 |
| per-draw AABB contained in its archived record (all 57) | 57/57 |

The residual is float32 storage rounding, not geometry: the stored coordinates are
around |z| ≈ 1.0-1.1e3, where ULP(1024) = 1.22e-4 (half-ULP 6.1e-5). The largest
observed error, 6.024e-05, is just below one half-ULP at that magnitude.

Group table (constant → member instances, base primitives, geometry blocks):

| constant | instances | bases | blocks |
| ---: | --- | --- | --- |
| 10, 11, 13, 14, 15, 16, 17, 18, 20, 21, 22, 23, 25, 29 | singleton | one | 27 |
| 26 | 13, 14 | 7, 8 | 27, 27 |
| 28 | 15, 16 | 9, 10 | 27, 27 |
| 30 | 18, 19 | 7, 8 | 27, 27 |
| 31 | 20, 21 | 9, 10 | 27, 27 |
| 33 | 22 | 11 | 15 |
| 34 | 23, 24 | 12, 13 | 15, 15 |
| 36 | 25, 26 | 14, 15 | 15, 15 |
| 37 | 27, 28 | 16, 17 | 15, 15 |
| 39 | 29, 30 | 18, 19 | 15, 15 |
| 40, 41, 55 | 31, 32, 56 | 20, 21, 35 | 15 |
| 43 | 33, 34, 35 | 22, 23, 24 | **26, 26, 32** |
| 45 | 36, 37, 38, 39 | 25, 26, 27, 28 | **32, 32, 26, 26** |
| 46 | 40, 41, 42 | 23, 22, 24 | **26, 26, 32** |
| 47 | 43, 44, 45 | 29, 30, 31 | **32, 32, 26** |
| 48 | 46, 47, 48 | 31, 29, 30 | **26, 32, 32** |
| 49 | 49, 50, 51, 52 | 26, 25, 27, 28 | **32, 32, 26, 26** |
| 50 | 53, 54 | 32, 33 | 17, 17 |
| 53 | 55 | 34 | 31 |

Two constant rows can hold the *same* matrix values: constants 25/26/28 and 30/31
do (the level places the same object twice). Their records therefore share the
first six floats but differ in `distanceMin`/`distanceMax` — which is why grouping
by matrix value alone was rejected earlier (instances 0 and 1 have equal matrices
but different records).

## 5. Why the current check rejects 38 instances

`scene_reader.cpp:874-887` compares, for every instance independently, the draw's
own transformed AABB with `list.instance_bounds[instance_index]` and skips the draw
when the difference exceeds `1e-4`. Because the entry is the whole object's bound,
a draw that is only one part of a multi-primitive object covers a subset of it and
fails that equality check. Of the 38 rejections, 30 are outside the 18 instances
that blocks 27 and 15 currently emit (that is the "22 + 8" figure in the task
card); the remaining 8 are inside block 27.

This predicts the observed per-block numbers exactly — the number of rejected
instances equals the number of instances that belong to a multi-member group:

| Block | Instances | In multi-draw groups | Emitted today | Rejected today | Vertices / triangles (all) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 27 | 22 | 8 (13-16, 18-21) | 14 | 8 | 13 162 / 10 308 |
| 15 | 12 | 8 (23-26, 27-30) | 4 | 8 | 7 234 / 5 181 |
| 17 | 2 | 2 (53, 54) | 0 | 2 | 2 528 / 1 812 |
| 26 | 10 | 10 | 0 | 10 | 6 624 / 4 528 |
| 32 | 10 | 10 | 0 | 10 | 5 084 / 3 692 |
| 31 | 1 | 0 (singleton, already matches) | 0 (prerequisite) | 0 | 754 / 556 |
| **total** | **57** | **38** | **18** | **38** | **35 386 / 26 077** |

The triangle/vertex columns were produced with the same expansion rules as the
C++ path and reproduce the recorded block27 (7 308 / 6 106, 14 instances) and
block15 (1 380 / 979, 4 instances) totals exactly
(`docs/work/verification/T-003.md:42-51`), so they are a usable projection.

Blocks 26 and 32 are additionally blocked by record scope: their objects span
**both** blocks (groups 43, 45, 46, 47, 48, 49). The two blocks live in different
stream chunks (85 and 88), so no single-block call can reconstruct a group's record
from one chunk. Block 17's single group (53, 54) is fully inside chunk 86, and all
of block15's groups are inside chunk 86 as well.

## 6. Hypotheses checked and rejected

| Hypothesis | Evidence against |
| --- | --- |
| Missing additional vertex stream / deformation | All 36 base primitives use the same declaration (0) with one stream slot; all 57 instances carry zero streams; every base stream is `frequency 0, vertexOffset 0`; the extra stride-28 buffers are referenced by no base primitive; the effects are static (`default_LN_NB_NL_NV.fx`, `default_LN_NB_NL_NM_NV.fx`), no `*_skin_*` effect; and the group unions reproduce all 34 records from the POSITION data alone. |
| Wrong LOD / bounds selection | For every instance, bounds over the full LOD0 vertex range equal bounds over the referenced vertices (`errLod == errUsed` in all 57 rows), so the drawn index set covers the LOD range; using the LOD range does not change any error. |
| Non-affine / dynamic transform | Each instance resolves exactly one constant `g_mWorld`, all with `m[3]=m[7]=m[11]=0, m[15]=1`; all material refs use `listIndex 0`; no runtime (`type 9`) fields participate. |
| Primitive topology / index range | All 36 base primitives are triangle strips whose LOD0 ranges lie inside the bound IB (width 2); strip parity plus degenerate removal is what reproduces the recorded vertex/triangle counts for the emitted instances. |
| Invalid bounds comparison | Confirmed: the comparison is valid arithmetic against the wrong semantic target (per draw vs per placed object). |
| Bounds array is per base primitive or per batch | `instanceBatchBounds` is empty (0 entries); `primitiveBounds` has 5 entries that belong to the five `primitives` (declaration 5, IB 0, effects 9/2), none of which is used by any instance; the 57-entry array is the instance array and its records change with the transform constant, not with `basePrimitives` (base 7 appears in groups 26 and 30 with different records). |

## 7. Fields 7 and 8 of each record

Each record is `{aabbMin.xyz, aabbMax.xyz, distanceMin, distanceMax}`
(`bounds.h:13-16`, `archive.inl:51-54`). The first six floats are the world AABB;
the last two are distance limits and are ignored by the current comparison
(`scene_reader.cpp:875-878` compares indices 0-5 only).

The comparison does not need them, but for completeness: they are constant within
a group, and two groups with identical AABB (constants 26 and 28) carry different
pairs (`(-2^126, 150)` vs `(96, 250)`), so they are not derived from the geometry
AABB. Most records store `distanceMin` as the bit pattern `0xFE800000`
(exactly `-2^126`); `bounds.inl:6` documents `-FLT_MAX` as the `SetUniversal`
sentinel, so the exact producer of that value is **not verified**. This is
recorded as an open detail; it does not affect any conclusion above.

## 8. Smallest next implementation step (proposal only)

Do not change geometry expansion, stream selection, LOD selection or matrices —
they already reproduce the data. Change only the validation unit from "one draw"
to "one transform group", and emit the existing per-draw output unchanged.

The authoritative grouping key is the CullNode that produced the draw
(`renderlistbuild.cpp:579`), but the current reader skips node bodies
(`scene_reader.cpp:244-250`) and therefore has no CullNode-to-instance mapping.
On node253 the resolved `g_mWorld` constant row coincides with the CullNode group
in all 34 cases, so it is a usable proxy — provided the implementation verifies
that all members of a proxy group carry byte-identical archived records. If two
CullNodes ever shared one transform row, that check fails and the group is
reported unsupported instead of being silently over-merged. A later improvement
can key on the real CullNode once the node tree is traversed.

### Stage A — single-chunk groups (fixes blocks 27, 15, 17)

1. In `level_instances_impl`, resolve each candidate instance's constant transform
   row once (the existing `world_matrix` already returns it through
   `apply_transform`; expose the row index it used).
2. Before the bounds check, partition the instances whose VB/IB bind the selected
   geometry block by that row index.
3. For each group, compute the union of the members' world AABBs (the per-member
   boxes already exist in the loop), require (a) all members' archived records to be
   byte-identical and (b) `|union - record| <= tolerance` per axis.
4. Emit every member draw exactly as today (own positions, indices, matrix, draw
   span). Record `boundsGroupKey` (constant row), `boundsGroupMembers`,
   `boundsGroupSharedRecord`, `boundsGroupUnionError`, and a new
   `boundsSource:"transform-constant-group"`. Keep `instancesApplied:true` and the
   existing `unsupportedBoundsInstances` counter, which now must stay 0 for
   complete groups.
5. If a group is only partially present in the supplied geometry chunk, report the
   whole group as `incompleteBoundsGroup` and skip it — never silently drop one
   member and keep the rest.

Expected after Stage A: block27 22/22, block15 12/12, block17 2/2 → 36 instances,
22 924 vertices, 17 301 triangles. The 14 block27 and 4 block15 instances that are
already emitted must keep byte-identical positions/indices (their groups are
singletons).

### Stage B — cross-chunk groups (blocks 26, 32)

The node's `vertexBuffer`/`indexBuffer` sources already enumerate the blocks
(`requiredGeometryBlocks` = `[15,17,26,27,31,32]`). Stage B lets group validation
collect member geometry from more than one supplied chunk (85 for block 26, 88 for
block 32) while still emitting one draw per instance. Expected total: 56
instances, 34 632 vertices, 25 521 triangles.

Block 31 stays out of scope: chunk 96 declares prerequisites
`[82,90,91,87,94,95]` (`scene_reader.cpp:761`), independent of this finding.
Instance 55 already matches its record, so block 31 only needs the prerequisite
flow. With it, the full node would be 57 instances / 35 386 vertices / 26 077
triangles.

### Acceptance criteria for the change

- node253, all six blocks: worst group-union error `<= 1e-4`
  (expected `<= 6.03e-05`), no `unsupportedBoundsInstances` from a complete group.
- Determinism: repeated runs produce identical JSON, hashes and counts.
- Native/WASM JSON equality and the independent Python reference agree on the
  group membership and union bounds.
- Negative tests: perturbing one member's matrix, one LOD range, or one index
  buffer must fail the whole group (no partial emission); a truncated member list
  must be reported as an incomplete group, not as a pass.
- Tolerance: keep the absolute `1e-4` for this level, but document it as one
  half-ULP of float32 for |coordinate| < 2048; for larger coordinates a relative
  term (`2^-23 · max|value|`) is required, otherwise a correct record can exceed a
  fixed `1e-4` (at |x| = 4096 the ULP is 4.88e-4).
- Browser: no visual change is expected for the existing presets; a new preset
  that includes blocks 15/17 (and later 26/32) needs a screenshot and a clean
  console before it is called working.

### Explicit non-goals for that step

No material application, no visibility/PVS, no higher LODs, no GPU instance
buffers, no change to the CPU vertex-expansion path, and no change to
`primitiveBounds`/`instanceBatchBounds` handling.

## 9. Consequences for existing records (for the main agent)

- `docs/work/tasks/T-003-scene-traversal.md:30-33` and `:58-59`, and
  `docs/work/verification/T-003.md:21-23,52-53`, attribute the unsupported
  instances to missing "stream/deformation semantics" of base primitives 7–10 /
  11–35. The measurements above do not support that; the data has no deformation
  streams and the records are reproduced without them. Those statements should be
  corrected when the card is next updated. This analysis does not edit task cards.
- `docs/plan/level-instances.md:24` states "16 distinct matrices". That is correct
  for distinct matrix *values*, but there are 34 distinct transform constant rows,
  and the archived records key on the row, not on the value. The distinction
  matters for the fix and is worth recording.
- `docs/handoff/CURRENT.md:22-25,52-54` reports 18 supported instances and the
  stream-semantics blocker; the blocker description should be replaced by the
  bounds-group item once the change is implemented.

## 10. Open items (not resolved here)

1. The exact producer of the `distanceMin = -2^126` sentinel (section 7).
2. What the unreferenced stride-28 vertex buffers in these blocks are for. They
   are not part of node253's RenderList, but another node may reference them; this
   was not inspected.
3. Whether other RenderLists in this level use the same CullNode bound pattern for
   objects that span render passes (each pass is built separately at
   `renderlistbuild.cpp:506-530`), which would make a group non-contiguous in some
   other node. Only node253 was measured.
4. Whether a transform constant row can ever be shared by two different CullNodes
   in the same RenderList. It does not happen in node253 (34 rows, 34 records), and
   the proposed check would fail safe if it did, but the reader does not currently
   resolve the real CullNode grouping.
5. What chunk 96's prerequisites (`[82,90,91,87,94,95]`) provide beyond the item
   itself. Instance 55's bounds already match; the missing piece there is the
   prerequisite resource flow, which was not investigated in this analysis.
