# T-007 draw list — full Stage A+B set (56 instances)

**Date:** 5 November 2026
**Scope:** engine CPU draw list only. No GPU, renderer, browser, vehicle or game
claim. The packet is data; nothing rasterises it.
**Extends:** `docs/work/verification/T-007-drawlist-v2.md` (P30) and
`engine-level-stream.md` §13. P27's direct-draw result and P30's block-27 subset
are unchanged.

## Gate

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
& $py engine/verify_stream.py --fresh
```

Result: **PASS**, exit 0, **122.2 s**; a second full run (reused tree) is
also **PASS**, 111.8 s, with the same wasm, hashes and totals.

- Harness **70/70 checks**.
- Patch `engine/patches/t005b-stream-overlay.patch` is **unchanged** from P30:
  16 modified files, 77,284 B, SHA-256
  `5fa2b1b743c388030d1a0bc8b73fe951acfea92406a29cf7b71b2dbb75019b71`.
- Build **56 TUs**, wasm **823,931 B**, SHA-256
  `d716589963011041ae26bc47e0ca34e9d20edca4de4e26723c32dd7023e20f6b`;
  the two builds in the run are byte-identical, and the two full runs produce
  the same module.
- Portable suite at the same revision:
  `python tools/verify_asset_probe.py --skip-build` → **29/29 PASS**.

## Geometry imported

The instance list's five supplied blocks are read with the already-compiled
`LodReader<ResourceBlock::Resources>` deserialiser, same CPU-only path as P27:
no GPU object is created (`gpuObjectsCreated = 0`).

| Block | Stream chunk | Item | LOD |
| ---: | ---: | ---: | ---: |
| 15 | 86 | 2 | 0 |
| 17 | 86 | 3 | 0 |
| 26 | 85 | 1 | 0 |
| 27 | 88 | 7 | 0 |
| 32 | 88 | 8 | 0 |

Each distinct chunk is parsed **once**, up to its highest requested item, and
every item's own vertex/index buffer slice is recorded. Parsing one chunk per
block would have retained the preceding items twice and exceeded the arena.

- Node chunk 53 (block 253) is parsed first, so its primitive records start at
  index 0; geometry chunks append after it.
- Parsed: **3 chunks / 15 items / 22 VBs / 15 IBs**, **2,595,776 B** retained,
  **0** compressed buffers, 0 arena exhaustion, 0 buffer/primitive/LOD/stream
  overflow.
- Block 31 is not imported. Chunk 96 declares **6 prerequisites**
  (`[82,90,91,87,94,95]`); its one instance is emitted with
  `reason=geometryBlockPrerequisite`, not as an empty or identity draw.

## Instance result

| Check | P32 result |
| --- | --- |
| instance records | **57** (all node253 instances) |
| drawable instance records | **56** |
| omitted instance records | **1** (block 31, prerequisite) |
| vertices | **34,632** |
| triangles | **25,521** |
| world matrices | 57/57 constant affine `g_mWorld`, 0 invalid |
| matrices vs committed Stage B reader | **56/56 equal at 1e-5** |
| matrices vs P30 block-27 reader | **22/22 equal at 1e-5** |
| archived instance bounds | **56/56 equal at 1e-5** |
| VB/IB bindings vs Stage B `instanceSources` | **57/57 equal** |
| material ids | 57/57 instance records carry a static `g_tAlbedo`; 0 null |

The P30 block-27 subset is unchanged inside the extended list:
**22 draws / 10,308 triangles / 13,162 vertices**.

`vertexCount` is the number of **distinct referenced source vertices** per
instance, which is what the committed Stage B reader reports. For block 27 the
LOD range and the referenced set coincide (hence P30's 13,162); for blocks
15/17/26/32 they do not, so counting the LOD range width gave 44,056 and was
corrected to the referenced set. Triangles are the same non-degenerate strip
count as the committed reader.

## Reference match

- New evidence file
  `_work/logs/engine-stream-spike/reference-instances-bundle.json` is the output
  of the committed `level_inspect --instances-bundle` reader over blocks
  15/17/26/27/32. It is **byte-identical** to
  `_work/level-instances/stageB-all.json`, SHA-256
  `647ee7d374555764d85500060f8aedc364600c8edcfcc91b1ed89c58fbb7148d`
  (the Stage B bundle hash recorded in T-003).
- `_work/level-instances/stageB-python-reference.json`:
  57 transform rows match, and its `stageAB` totals **56 / 34,632 / 25,521**
  equal both the bundle reader and the engine.
- The committed reader reports `boundsMaxAbsoluteDifference`
  `6.02443715e-05` (group union vs archived CullNode record). The engine's
  per-instance archived bounds and matrices match at 1e-5; no mismatch was
  found, so there is no first-mismatch offset to report.
- Reference order: 15, 17, 26, 27, 32; `geometryChunks` 86/86/85/88/88,
  item indices 2/3/1/7/8 — identical to the engine's located chunks.

## Packet draw list

One record per direct primitive and per instance, in archive order:

- **312 records** = 255 direct + 57 instance.
- **151 drawable** (95 direct + 56 instance), **161 omitted**
  (160 other-block direct + 1 prerequisite instance; every omission carries a
  reason).
- Packet hash (FNV-1a 64 over every printed field) is
  **`96b24f076495aea5`**, recomputed independently in Python from the printed
  lines on every run.
- Constant materials are unchanged from P30: **243 rows / 26 types**,
  121 `g_tAlbedo` rows, 38 `g_mWorld` rows, 0 type-8 rows; **255/255** direct
  and **57/57** instance records have a non-null albedo id.
- P27 direct result is unchanged: **95 bound, 9,343 triangles, 17,782
  vertices, draw-list hash `fd525c1452869aee`**, 160 other-block primitives.

## Determinism and PC parity

- Two independent wasm builds are byte-identical; the two harness runs inside a
  verify run print identical stdout; two full verify runs reproduce the same
  wasm SHA-256, packet hash and totals.
- The four patched engine TUs preprocess identically with and without the
  patch: `streammanager.cpp` 108,025, `streamdata.cpp` 111,514,
  `archive.cpp` 111,399, `resources.cpp` 108,104 code lines.
- The modified files in this task (`stream_harness.cpp`, `verify_stream.py`) are
  wasm-harness/gate code; the patch itself is untouched, so PC parity of the
  engine TUs is unchanged.

## Remaining blockers

1. Textures are indices only; nothing is decoded, created or sampled.
2. `StreamData::ProcessLoadChunk` state machine is still not driven.
3. No visibility, culling, LOD selection, sorting or batching; one RenderList
   (node253), LOD0 only.
4. Block 31 needs the prerequisite flow (`[82,90,91,87,94,95]`); the full node
   would then be 57 instances / 35,386 vertices / 26,077 triangles.
5. Runtime-only material values (`DATA_INDEX`/`TEXTURE_PTR`) are not imported;
   River's lists contain none.
6. No renderer, GPU, browser, vehicle or game claim; `C_OverlayFs` is still one
   read-only layer.

## Evidence

| Path | Content |
| --- | --- |
| `_work/logs/engine-stream-spike/verify-summary.json` | every number above, machine-written |
| `_work/logs/engine-stream-spike/p32-verify-fresh-final.log` | final fresh transcript, PASS |
| `_work/logs/engine-stream-spike/p32-verify-reuse-1.log` | second full run, identical |
| `_work/logs/engine-stream-spike/p32-verify-skipnative-2.log` | first green run (no PC parity) |
| `_work/logs/engine-stream-spike/p32-asset-suite.log` | 29/29 portable suite |
| `_work/logs/engine-stream-spike/reference-instances-bundle.json` | committed Stage B reader output, byte-identical to `stageB-all.json` |
| `_work/logs/engine-stream-spike/level-inspect-instances-bundle.log` | reader invocation log |
| `_work/engine-stream-spike/out/stream_harness_a.wasm` | module, 823,931 B |
| `docs/work/analysis/engine-level-stream.md` §14 | P32 analysis record |

File hashes at this result:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `engine/patches/t005b-stream-overlay.patch` | 77,284 | `5fa2b1b743c388030d1a0bc8b73fe951acfea92406a29cf7b71b2dbb75019b71` |
| `engine/harness/t005e/stream_harness.cpp` | 97,022 | `9e640956af17b8e1a008bd6e8165be65e190bd66839af08f53fa94603054f228` |
| `engine/verify_stream.py` | 87,482 | `6e1b8153585d3a0111d17d243334db6184c68c0d64f271da337d60e7e0b938c4` |
