# T-003 verification — Stage B cross-chunk CullNode groups

**Date:** 5 November 2026
**Scope:** `level_instances_bundle_inspect`; River `usa_la_river`, node253,
geometry blocks 15/17/26/27/32. Stage A single-chunk APIs are unchanged.
**Level inputs:** `game-data/Blur/levels/usa_la_river/level.levelrender` and
`level.levelstream` (read-only). No engine or game file was modified.

## Change

The single-chunk `level_instances_all_inspect` groups contiguous instances by a
byte-identical archived CullNode record and the resolved constant transform row.
On node253 that row is the CullNode proxy: 34 constant rows produce 34 distinct
archived records, while the six multi-draw objects that span blocks 26 and 32
mix both blocks inside one CullNode group (for example constant 45: instances
36–39 bind 32, 32, 26, 26). A grouping key that also required equal VB/IB block
pairs therefore split those objects and could never validate them from one chunk.

Stage A's key is kept for same-block groups. The equality of the **resolved
constant transform row** replaces equality of the block pair only for the bundle
path; the archived 8-float record must still be byte-identical across every
member, and each member's VB and IB block must resolve independently to one of
the supplied chunks:

```text
world = union of member draw AABBs
valid <=> all member records byte-identical
        && |world.min - record[0..2]| <= 1e-4
        && |world.max - record[3..5]| <= 1e-4
```

If some members resolve and some do not, the whole group is withheld as
incomplete (no partial emission). If the union misses the record, every member is
rolled back and counted in `unsupportedBoundsInstances`. The transform row is
recorded in `boundsGroupDetails[].transformConstantRow`; an ambiguous double
assignment prevents merging instead of over-merging.

Compatibility note: the single-chunk APIs keep every existing JSON field and
value except `boundsGroups` on `level_instances_all_inspect`. It now reports the
34 constant-row groups instead of the 40 block-pair segments that Stage A
produced when six cross-block objects were split; emitted instances, vertices,
triangles, bounds errors and hashes are unchanged. The single-instance API keeps
`boundsGroups:0` and its previous fields.

## API

```c
char* level_instances_bundle_inspect(
    const unsigned char* level_bytes, size_t level_size,
    const unsigned char* node_bytes, size_t node_size,
    int32_t node_block,
    const int32_t* geometry_blocks,
    const unsigned char* const* geometry_bytes,
    const size_t* geometry_sizes,
    size_t geometry_count);
```

- `geometry_count` is bounded to 1..16; blocks must be distinct and must not
  equal `node_block`.
- Every supplied chunk is located in the Scene ChunkInfo table by its block
  LOD0 item, must match the stored byte size, and must have no additional
  prerequisites.
- Geometry is parsed sequentially to the selected item (preceding items included),
  exactly as the Stage A path does for one chunk.
- One draw per instance is emitted; `instancesApplied:true`,
  `nodeTransformsApplied:true`, `coordinateSpace:"world"` and
  `material:"diagnostic-only"` are retained.
- New bundle fields: `bundledGeometry`, `geometryBlocks`,
  `geometryChunks[]`, `incompleteBoundsGroups`,
  `incompleteBoundsGroupInstances`, `unsuppliedGeometryBlocks`,
  `boundsGroupDetails[]`. Single-chunk fields, including `geometryBlock`, are
  preserved.
- `requiredGeometryBlocks` still reports `[15,17,26,27,31,32]`; block31 remains
  unsupplied because chunk96 declares prerequisites `[82,90,91,87,94,95]`.

## Group result

| Scope | Emitted | Unsupported | Incomplete | Omitted | Vertices | Triangles | Max error |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| block26 only (partial rejection) | 0 | 0 | 10 (6 groups) | 47 | 0 | 0 | — |
| blocks26+32 | 20 | 0 | 0 | 37 | 11,708 | 8,220 | 5.90474e-05 |
| blocks15/17/26/27/32 | **56** | **0** | **0** | **1** (block31) | **34,632** | **25,521** | **6.02443715e-05** |
| block27 regression | 22 | 0 | 0 | 35 | 13,162 | 10,308 | 6.02443715e-05 |

The six cross-chunk groups (43 + 45 + 46 + 47 + 48 + 49) are emitted as single
groups with 3, 4, 3, 3, 3 and 4 members. Group byte identity and union bounds are
independently rebuilt by
`probes/asset-reader/tests/verify_instances_bundle_reference.py`; its totals are
Stage A 36/22,924/17,301, blocks26+32 20/11,708/8,220, Stage A+B
56/34,632/25,521, and the full node including the block31 reference
57/35,386/26,077.

## Determinism and hashes

Three consecutive native bundle runs are byte-identical.

- bundle JSON SHA-256: `647ee7d374555764d85500060f8aedc364600c8edcfcc91b1ed89c58fbb7148d`
- world POSITION float32-LE SHA-256: `3d1c48dd146b8e3d439ee46a1e5f6e692dabd247e2ac7501d96010deca7db2e8`
- index U32-LE SHA-256: `06d1c77d0c08839b7248a013e2828022b96f845b8aff353cc5c2cb1f3e268389`

Input chunk hashes (from the Stage A analysis, re-checked): chunk85 block26
`da8aaa1a23a0c3f18660ffaf65d747fecc9618bc743ec33f387ebc8704211c37`;
chunk86 blocks15/17
`15a3e7efd0ea82235d3765a2ef494d9c7e08d43809f5f9e07beba76c7625c565`;
chunk88 blocks27/32
`a813745141466d0918374927c40ad19b682121a10c2ddda1126257392f6c3b78`;
node chunk53
`65aec287878fa58405fa5ed585e6c43f3ba5ff683e825c0759b29f8fe8ccf20c`.

Evidence: `_work/level-instances/stageB-all.json`,
`stageB-26-32.json`, `stageB-26-only.json`,
`stageB-python-reference.json`, `stageB-determinism.json`,
`_work/verification/level-instances-native-wasm.json`.

## Tests

- `verify_instances_wasm.mjs` now calls the bundle API from native and WASM and
  asserts deep JSON equality, 56/34,632/25,521 counts, 34 groups, a 1-instance
  omission (`block31`), 56 draws, deterministic output, group byte identity, and
  agreement with the independent Python group list/union bounds.
- Negative cases, native and WASM: duplicate block, truncated chunk, swapped
  chunk size, corrupt ARCH signature, unknown block, and **one ULP change in one
  member's archived record**. The last case splits the byte-identical group and
  rejects all three members (17 emitted, 3 unsupported), proving a one-byte
  difference cannot be silently merged.
- Partial rejection: block26 alone withholds all 10 of its instances as six
  incomplete groups instead of emitting a subset.
- CTest **15/15 PASS** (new `level_instance_bundle_fixture`).
- Full gate `python tools/verify_asset_probe.py`: **30/30 steps PASS**
  (includes the native+WASM rebuild and CTest).
- Portable `python tools/verify_asset_probe.py --skip-build`: **29/29 PASS**.
- Native MSVC `/W4` `/permissive-` build warning-free.

## Browser visual check

Headless Edge 1600×900 with WebGPU (`--enable-unsafe-webgpu`,
`--enable-features=Vulkan`, `--use-angle=d3d11`), CDP-driven preset click.

| Preset | Status line | WebGPU mesh | Console |
| --- | --- | --- | --- |
| River · blok26+32 · 20 instance | `20 instance çizildi · 0 sınır uyuşmazlığı · 4 blok kapsam dışı · 8220 üçgen` | 11,708 vertex / 8,220 üçgen | empty |
| River · tüm desteklenen · 56 instance | `56 instance çizildi · 0 sınır uyuşmazlığı · 1 blok kapsam dışı · 25521 üçgen` | 34,632 vertex / 25,521 üçgen | empty |
| River · 22 instance (regression) | `22 instance çizildi · 0 sınır uyuşmazlığı · 35 başka blok · 10308 üçgen` | 13,162 vertex / 10,308 üçgen | empty |

Screenshots and console summaries:
`_work/logs/t003-stageB-river-cross-chunk.png`,
`_work/logs/t003-stageB-river-all-blocks.png`,
`_work/logs/t003-stageB-river-instances.png`,
`_work/logs/t003-stageB-browser-*.json`,
`_work/logs/t003-stageB-browser.json`.

## Limits

- Blok31 is not emitted; chunk96's prerequisites are not traversed.
- This is 56 of node253's 57 instances, one RenderList in one level; it is not a
  full track, game, material application, visibility/PVS pass or higher LOD.
- Tolerance remains an absolute `1e-4`, valid as roughly one half-ULP for
  |coordinate| < 2048. Larger coordinates would need a relative term.
- The grouping proxy is the constant transform row, not a traversed CullNode
  node tree; a shared row between two CullNodes fails safe by splitting, but the
  real node tree is still open.
- Headless Edge is a proxy; the user's physical Chrome/Brave check should confirm
  the same counts.
- The bundle tests require the local `_work/level-instances/block15.chunk`,
  `block17.chunk`, `block26.chunk` and `block32.chunk` fixtures, like the
  pre-existing `instance-geometry.chunk`/`instance-node.chunk`; the suite does
  not regenerate them. Their SHA-256 values are recorded above.
