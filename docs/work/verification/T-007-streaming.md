# T-005e / E1a verification — engine level streaming on wasm32

**Date:** 4 November 2026
**Scope:** real `StreamManager` chunk streaming through the engine file layer;
no scene parse, renderer or game.

## Gate

```powershell
python engine/verify_stream.py --fresh
```

Result: **PASS** (97.4 s).

- Patch `engine/patches/t005b-stream-overlay.patch`, SHA-256
  `A2BB6D9DDD339A809233BB766C424FB677CCF7D10CA70B24F05897C2819C6F50`
  (6 web-only files).
- 37 objects, wasm **246,726 B**, two builds byte-identical.
- Harness **20/20 checks**, two runs identical.
- PC parity: `streammanager.cpp` preprocessed identical with and without the
  patch (187,697 lines).

## What streamed

Real `Level.levelstream` through `C_OverlayFs` → `C_WebFile` → node range source:

- **359/359 chunks** via `StreamManager::LoadChunk` / `GetChunkData`
- **244,682,752 B** (whole stream), largest chunk **2,045,952 B** inside the
  4 MiB allocator
- **359/359 chunk FNV-1a 64** equal to an independent Python read of the same
  `(offset, storedBytes)`
- chunk table field-by-field equal: 359 records, `resourceBlockCount=1227`,
  `initiallyLoadedBlocks=1`
- `levelrender` 9,873,988 B FNV `0x0ef5c027f0924307`; `levelphysics` 1,945,409 B
  FNV `0xb9594f7ce52caa2e`; both equal Python
- geometry chunk 157: offset 68,937,728 / 10,240 B, FNV
  `0x74dd025de4430925`
- EOF-crossing, past-EOF and oversize requests fail loudly; exactly the two
  deliberate read failures are counted; no zero-fill

## P22 — engine-parsed levelrender (5 November 2026)

`verify_stream.py --fresh` → **PASS** (121.4 s), **30/30** checks.

- 54 TUs, wasm **664,137 B**, two builds identical.
- `Sys::C_FileBlock` → `Arch::BinaryInputArchive` → `Deserialise(Target::Scene)`
  now runs on wasm; **0 GPU calls**.
- Engine table: **359 ChunkInfo records**, **10,784 items**, **603
  prerequisites**, 603 dependants, 0 disabled; stored 244,682,752 B / logical
  238,442,906 B.
- Field-by-field **359/359 equal** to `range_probe level` and
  `level_inspect --index`, including every item and prerequisite.
- Cursor **2,464,509 B** equals the probe `parsedUntilOffset`; table hash
  `aae9814242df9d36` identical in C++ and Python.
- Scene data: 16 declarations / 67 elements, 43 effects, 10 shared textures
  (2,196,056 B), data-only.
- `OpenStreamFile` now passes `kBufferSizeHintDefault` (sentinel → 16 KiB)
  instead of 0; `bufferHintRefused=0`.
- `CacheChunk(0)` = 4,096 B FNV `6902d748913089e9`; a chunk with a prerequisite
  is refused before reading.
- PC parity: `streammanager.cpp` 108,025, `streamdata.cpp` 111,514,
  `archive.cpp` 111,399 preprocessed lines identical with/without the patch.

## Blockers (measured, not guessed)

1. **Resource blocks and render lists are not imported**
   (`CreateIndexBuffer/VertexBuffer/VertexDeclaration`, render states); parsing
   stops at the loaded-block count, exactly the probe boundary.
   `ProcessLoadChunk` compiles but is not run.
2. `StreamData::BeginTasks` aborts if reached (never reached here).
3. No texture creation, chunk decompression, browser/GPU renderer, vehicle or
   game claim; `C_OverlayFs` still one read-only layer.

## P27 — engine CPU draw list (5 November 2026)

`verify_stream.py --fresh` → **PASS** (119.9 s), **46/46** checks.

- 55 objects, wasm **794,845 B**, two builds identical.
- Scene target imports resource blocks and the render list into CPU structures;
  **0 GPU objects created**, `renderListHandler=1`.
- `usa_la_river` block 88 → chunk 136 (54,616,064 / 589,824 B; 5 VBs, 1 IB,
  587,228 B payload, 0 compressed); node block 283 → chunk 68
  (3,737,600 / 104,448 B; 1 render list, node 1, 255 primitives).
- **95 bound draws**; 160 other-block primitives printed with block/span/reason
  (`geometryBlockNotImported`), not drawn.
- **9,343 triangles / 17,782 vertices**, 0 index errors, draw-list hash
  `fd525c1452869aee` (same on reused and fresh trees).
- Instance list block 27/node 253 → 57 instances / 36 base primitives.
- Reference comparison: **95/95 `firstIndex`+`indexCount` spans equal** to
  `level_inspect 88 283`, plus `primitiveCount 95`, `triangleCount`,
  `vertexCount`; `instanceCount 57` / `basePrimitiveCount 36` equal.
- Each draw carries chunk/node/primitive/archive offsets, declaration,
  topology, LOD, effect, resolved `vb=block:index`/`ib=block:index`,
  firstIndex/indexCount, bounds, materials; `world:null` with
  `instanceTransformNotImported`.

All 55 TUs include the P27 harness; PC preprocessing of `streammanager.cpp`,
`streamdata.cpp`, `archive.cpp`, `resources.cpp` is identical.

### Blockers on the way to packet v1.1

1. Instance transforms (`g_mWorld`) and runtime materials are not imported;
   `world:null` with a reason.
2. Textures are described (name/hash/LOD/size), never created; no decompression.
3. `ProcessLoadChunk` state machine is still not driven.
4. Only block pairs 88/283 and 27/253 are imported; no visibility/culling/LOD
   selection/sorting/batching.
5. Legacy `<v2` render lists abort by name.

## Next

Give the target archive a narrow fail-loud type facade so
`RenderingData::StreamData` compiles, then produce the 359 `ChunkInfo` records
with the engine's own serialiser and compare to the same references.

Evidence: `_work/logs/engine-stream-spike/verify-summary.json`,
`engine/harness/t005e/`, `docs/work/analysis/engine-level-stream.md`.
