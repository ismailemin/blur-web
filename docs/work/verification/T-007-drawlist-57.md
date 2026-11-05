# T-007 draw list — full node including block 31 (57 instances)

**Date:** 5 November 2026
**Scope:** engine CPU draw list only. No GPU, renderer, browser, vehicle or game
claim. The packet is data; nothing rasterises it.
**Extends:** `docs/work/verification/T-007-drawlist-56.md` (P32) and
`engine-level-stream.md` §16. P27's direct-draw result, P30's block-27 subset and
P32's 56-instance bundle are unchanged.

## Gate

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
& $py engine/verify_stream.py --fresh
& $py engine/verify_stream.py
```

Result: **PASS**, exit 0, **125.2 s** fresh and **111.6 s** on the reused tree.
Both runs have the same wasm, hashes and totals.

- Harness **80/80 checks** (was 70/70 at P32).
- Patch `engine/patches/t005b-stream-overlay.patch` is **unchanged**:
  16 modified files, 77,284 B, SHA-256
  `5fa2b1b743c388030d1a0bc8b73fe951acfea92406a29cf7b71b2dbb75019b71`.
- Build **56 TUs**, wasm **849,609 B**, SHA-256
  `0931971d45fec171044d5bff29e8466f2201885c99da7bb5f1ba2a54088093ab`;
  the two builds inside each run are byte-identical, and the two full runs
  produce the same module and packet hash.
- Only `engine/harness/t005e/stream_harness.cpp` and `engine/verify_stream.py`
  changed. The patch itself is untouched, so the four engine TUs still
  preprocess identically: `streammanager.cpp` 108,025, `streamdata.cpp`
  111,514, `archive.cpp` 111,399, `resources.cpp` 108,104 code lines.

## Prerequisite resolution (chunk 96)

`ChunkInfo` prerequisites are **chunk indices**, not item indices. The engine
semantics used here is the committed one in `streamdata.cpp`:

- `StreamData::CacheChunk(chunk)` refuses a chunk while any direct prerequisite
  is neither loaded nor cached.
- `StreamData::SetLoadChunk(chunk, true)` walks the same prerequisite list
  recursively, so the whole graph is loaded before the dependent chunk.

The harness does not drive the GPU-bound cache state machine
(`ProcessLoadChunk` is still not run). It resolves the same graph through the
engine `ChunkInfo` table and the mounted web file / `StreamManager`: every
prerequisite is read once in post-order, then chunk 96 is read. A missing,
empty, oversized or cyclic prerequisite is reported with its exact index and
stops the resolution; there is no empty/identity fallback.

| Field | Result |
| --- | --- |
| target chunk | **96** (block 31, item 2) |
| direct prerequisites | **`[82,90,91,87,94,95]`** |
| declaration | 6 entries, identical to the engine `ChunkInfo[96]` list |
| transitive chunks resolved | **14**, each exactly once |
| resolution order | `82,87,85,81,83,86,90,89,91,88,84,94,92,95` |
| bytes read | **15,079,424 B** |
| aggregate FNV-1a 64 | **`116a3286acb5f6c0`** (concatenated chunk bytes) |
| per-chunk hashes | 14/14 equal to independent Python over the stream file |
| missing / unsupported kind | **none encountered** |

The six direct prerequisites total 5,513,216 B. They cannot all stay resident
in the 4 MiB web chunk allocator at once, so this gate reproduces the
prerequisite **graph and order**, not the engine's concurrent loaded/cached
residency. That limitation is recorded below, not hidden.

Direct prerequisite chunks:

| Chunk | Stored bytes | Items | FNV-1a 64 |
| ---: | ---: | ---: | --- |
| 82 | 55,296 | 143 | `223786e115d02f67` |
| 90 | 1,175,552 | 96 | `548af9ad77711a57` |
| 91 | 1,585,152 | 175 | `3ac24a9afa731fc1` |
| 87 | 1,339,392 | 172 | `5958a6fa08d75c05` |
| 94 | 972,800 | 83 | `24b15ac535fef6ae` |
| 95 | 385,024 | 67 | `0033d8ace663324f` |

## Geometry imported

Block 31 is now the sixth supplied block. Chunks 86/85/88/96 are parsed once
each, up to the highest item the set needs; every item keeps its own buffer
slice. Chunk 96 is parsed to item 2 and block 31's own VB/IB slice is used.

| Block | Stream chunk | Item | LOD |
| ---: | ---: | ---: | ---: |
| 15 | 86 | 2 | 0 |
| 17 | 86 | 3 | 0 |
| 26 | 85 | 1 | 0 |
| 27 | 88 | 7 | 0 |
| 31 | 96 | 2 | 0 |
| 32 | 88 | 8 | 0 |

- Parsed: **4 chunks / 18 items / 26 VBs / 18 IBs**, **3,031,070 B** retained,
  **0** compressed buffers, 0 arena exhaustion, 0 buffer/primitive/LOD/stream
  overflow.
- Block 31 contributes **754 referenced vertices / 1,072 indices / 556
  triangles**, VB index 1, IB index 0, LOD0.
- `gpuObjectsCreated = 0`.

## Instance result

| Check | P38 result |
| --- | --- |
| instance records | **57** (all node253 instances) |
| drawable instance records | **57** |
| omitted instance records | **0** |
| vertices | **35,386** |
| triangles | **26,077** |
| base primitives | 36 (unchanged) |
| world matrices | 57/57 constant affine `g_mWorld`, 0 invalid |
| matrices vs committed Stage B bundle reader | **56/56 equal at 1e-5** |
| matrices vs independent `bounds-253` reference | **57/57 equal at 1e-5** |
| archived instance bounds | **57/57 equal at 1e-5** |
| VB/IB bindings vs Stage B `instanceSources` | **57/57 equal** |
| material ids | 57/57 instance records carry a static `g_tAlbedo`; 0 null |

The P30 block-27 subset is unchanged inside the full list:
**22 draws / 10,308 triangles / 13,162 vertices**. The extra block-31 draw is
exactly the difference to the P32 result: +754 vertices and +556 triangles.

Instance 55 (block 31) uses transform row 53. Its matrix, archived bounds,
VB/IB source and span are compared with the independent Python
`_work/level-instances/bounds-253.json` row, which records block 31 / chunk 96
/ item 2, VB 1, IB 0, 754 used vertices, 1,072 indices and 556 triangles.
Engine record:

```text
webfiledraw instance 55 chunk=53 nodeIndex=1 primitiveIndex=34 base=39
material=53:0 flags=0x00000000 streams=0 world=ok worldRow=53
materialId=g_tAlbedo:52:24 materialReason=none vb=31:1 ib=31:0
vtxCount=754 idxCount=1072 triangles=556 drawable=1 reason=none
```

## Reference match

- **No mismatch occurred**, so there is no first mismatch or byte offset to
  report. The verifier reports the instance, source, primitive offset and
  component if one appears.
- Committed Stage B bundle reader: 56/56 matrices and archived bounds equal at
  1e-5; 57/57 `instanceSources` VB/IB rows equal; its result remains
  56 / 34,632 / 25,521.
- Independent full-node reference
  (`_work/level-instances/stageB-python-reference.json`,
  `fullNodeWithBlock31Reference`): **57 / 35,386 / 26,077**, equal to the
  engine. Its 57 transform rows also match the engine's `worldRow`.
- Independent per-instance reference (`bounds-253.json`): 57 rows compared at
  1e-5, including instance 55.
- P27 direct-draw result unchanged: **95 bound / 9,343 triangles / 17,782
  vertices / draw hash `fd525c1452869aee`**, 160 other-block primitives.

## Packet draw list

One record per direct primitive and per instance, in archive order:

- **312 records** = 255 direct + 57 instance.
- **152 drawable** (95 direct + 57 instance), **160 omitted**
  (160 other-block direct; every omission carries a reason).
- `instanceOtherBlock = 0`; all 57 instance records are bound.
- Packet hash (FNV-1a 64 over every printed field) is
  **`7c29fb2ec7769709`**, recomputed independently in Python from the printed
  lines and pinned by the gate.
- Constant materials are unchanged from P34: **243 rows / 26 types**,
  121 `g_tAlbedo` rows, 38 `g_mWorld` rows, 0 type-8 rows; **255/255** direct
  and **57/57** instance records have a non-null albedo id.

## Determinism and PC parity

- Two independent wasm builds are byte-identical; the two harness runs inside
  a verify run print identical stdout; two full verify runs reproduce the same
  wasm SHA-256, packet hash, prerequisite hash and totals.
- The four patched engine TUs preprocess identically with and without the
  patch (`108,025 / 111,514 / 111,399 / 108,104` code lines).
- The modified files in this task (`stream_harness.cpp`, `verify_stream.py`)
  are wasm-harness/gate code; the patch itself is untouched, so PC parity of
  the engine TUs is unchanged.

## Remaining blockers

1. Textures are indices plus CPU RGBA only; nothing is created, sampled or
   bound. Block 31 does not change the P34 102/102 texture set.
2. `StreamData::ProcessLoadChunk` is still not driven. The prerequisite graph
   is resolved sequentially through `ChunkInfo` + `StreamManager`; the engine's
   concurrent loaded/cached residency is not reproduced (the six direct
   prerequisites total 5,513,216 B against a 4 MiB web chunk allocator).
3. No visibility, culling, LOD selection, sorting or batching; one RenderList
   (node253), LOD0 only.
4. Runtime-only material values (`DATA_INDEX`/`TEXTURE_PTR`) are not imported;
   River's lists contain none.
5. No renderer, GPU, browser, vehicle or game claim; `C_OverlayFs` is still one
   read-only layer.

## Evidence

| Path | Content |
| --- | --- |
| `_work/logs/engine-stream-spike/verify-summary.json` | every number above, machine-written |
| `_work/logs/engine-stream-spike/p38-verify-fresh-final-2.log` | final fresh transcript, PASS, 125.2 s |
| `_work/logs/engine-stream-spike/p38-verify-reuse-final-2.log` | second full run, identical, 111.6 s |
| `_work/logs/engine-stream-spike/a__run1.log` / `a__run2.log` | identical harness stdout, including every prerequisite record |
| `_work/logs/engine-stream-spike/reference-instances-bundle.json` | committed Stage B reader output (56 instances) |
| `_work/level-instances/stageB-python-reference.json` | independent 57-instance full-node totals and transform rows |
| `_work/level-instances/bounds-253.json` | independent 57-row matrix/archived-bounds reference, including instance 55 |
| `_work/engine-stream-spike/out/stream_harness_a.wasm` | module, 849,609 B |
| `docs/work/analysis/engine-level-stream.md` §16 | P38 analysis record |

File hashes at this result:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `engine/patches/t005b-stream-overlay.patch` | 77,284 | `5fa2b1b743c388030d1a0bc8b73fe951acfea92406a29cf7b71b2dbb75019b71` |
| `engine/harness/t005e/stream_harness.cpp` | 130,724 | `3c953cc0ea1d18b8d30d6823cc066b76129ddf3bd95a5913ccf9990d6cf201cd` |
| `engine/verify_stream.py` | 117,693 | `413479f9ae77e0c0d850c2ae306af265db52694b7328982c7de3a3a1dbefcfdd` |
| `_work/engine-stream-spike/out/stream_harness_a.wasm` | 849,609 | `0931971d45fec171044d5bff29e8466f2201885c99da7bb5f1ba2a54088093ab` |
