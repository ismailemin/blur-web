# T-007 draw list — six-section 540 m track corridor

**Date:** 5 November 2026
**Scope:** engine CPU draw list only. No GPU, renderer, browser, vehicle or game
claim. Nothing rasterises or binds the packet.
**Extends:** `docs/work/verification/T-007-drawlist-57.md` (P38) and
`engine-level-stream.md` §17. P27's direct draws, P30's block-27 subset, P32's
56-instance bundle, P34's 102 textures and P38's 57-instance full node are
unchanged.

## Gate

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
& $py engine/verify_stream.py --fresh
& $py engine/verify_stream.py
& $py tools/verify_asset_probe.py --skip-build
```

Result: **PASS**, exit 0, **125.5 s** fresh and **113.8 s** on the reused tree.
Both full runs have the same wasm, hashes and totals. The portable suite is
**29/29 PASS**.

- Harness **88/88 checks** (was 80/80 at P38).
- Patch `engine/patches/t005b-stream-overlay.patch` is **unchanged**:
  16 modified files, 77,284 B, SHA-256
  `5fa2b1b743c388030d1a0bc8b73fe951acfea92406a29cf7b71b2dbb75019b71`.
- Build **56 objects**, wasm **859,568 B**, SHA-256
  `bbd084b3e763225171a7b2eaa4f10dee48fbfa7b151804e4748e9f834c3269e0`;
  the two builds inside each run are byte-identical and the two full runs
  reproduce the same module, packet hash and totals.
- Only `engine/harness/t005e/stream_harness.cpp` and `engine/verify_stream.py`
  changed. The patch is untouched, so the four engine TUs still preprocess
  identically: `streammanager.cpp` 108,025, `streamdata.cpp` 111,514,
  `archive.cpp` 111,399, `resources.cpp` 108,104 code lines.

## Section import

The six P41 sections are imported with the same selection rule as the committed
survey (`tools/inspect_level_chunk.py`, `geometry()`): a primitive belongs to a
section when its POSITION vertex-buffer block and its index-buffer block both
equal that section's geometry block. No vertex, triangle, matrix or colour is
typed in.

For each section the engine:

1. locates the geometry block and the node block through its own `ChunkInfo`
   table (`findChunkItem(block, lod=0)`). The match count is printed
   (`geometryMatches`/`nodeMatches`); 0 or >1 matches stops the section with
   the exact block, lod, match count and
   `sectionGeometryBlockNotInStream`/`…Ambiguous` (or the node equivalent);
2. runs the P38 prerequisite flow for both chunks. All twelve declare **0**
   prerequisites, printed from the engine table;
3. reads both chunks through `StreamManager` and parses them with the engine's
   `LodReader<ResourceBlock::Resources>` deserialiser (`gpuObjectsCreated = 0`);
4. emits the primitives into a **separate** packet with the
   `webfiledraw section` prefix, leaving the P30 packet and the P34 texture set
   untouched;
5. computes the section bounds from the retained source POSITION0 bytes in the
   arena using the declaration element (`type` 6/7/9 only; any other type,
   method, compression, endianness or missing payload is a named failure).

A missing or ambiguous block/node item stops that section with its exact block,
chunk and item; there is no empty or identity fallback.

The six node chunks each contain **one render list and zero instances**. There
is no instance world matrix to emit for these sections, so direct draws keep
`world=null`, `worldReason=noInstanceTransform`, exactly as P27 does, and the
vertices are already at their source world positions. `instancesApplied:false`
is preserved and no transform is invented.

## Per-section result

| section | geometry block / chunk / item | node block / chunk / item | draws | triangles | vertices |
| --- | --- | --- | ---: | ---: | ---: |
| `g56-n289` | 56 / 121 / 0 | 289 / 71 / 0 | 49 | 9,824 | 14,508 |
| `g58-n265` | 58 / 156 / 0 | 265 / 59 / 0 | 41 | 7,393 | 12,227 |
| `g50-n265` | 50 / 155 / 0 | 265 / 59 / 0 | 44 | 7,740 | 13,874 |
| `g71-n209` | 71 / 122 / 0 | 209 / 31 / 0 | 56 | 6,736 | 11,524 |
| `g64-n209` | 64 / 154 / 0 | 209 / 31 / 0 | 40 | 6,688 | 11,145 |
| `g59-n265` | 59 / 119 / 0 | 265 / 59 / 0 | 69 | 9,409 | 15,434 |
| **total** | | | **299** | **47,790** | **78,712** |

Every section has `unbound=0`, `indexErrors=0`, `gpu=0`, and zero arena,
buffer, primitive and declaration overflow.

## Reference match

The verifier reads `_work/track-coverage/corridor.json`, pins its canonical
hash `sha256:10e197c119a5edc79d7c54d1f5f728c4f1e2a8006a3e76d08caf0e0c8a349d0c`,
and cross-checks the six sections in `visual.json`
(SHA-256 `877b4dc7e1f5ece197f0776239b33d23b0350f8cf77ef462c0c7a266a6abcb67`).

| Check | Result |
| --- | --- |
| section set, geometry block, node block | 6/6 equal |
| geometry/node chunk indices | 6/6 equal; every lookup selected item 0, the reference's first LOD0 item |
| draws / triangles / vertices | **6/6 exactly equal** |
| bounds at 1e-5 | **6/6 equal**, max absolute difference **4.49e-6** |
| per-draw primitive offsets | **299/299 equal** (`engine_source − 4 == reader primitiveOffset`) |
| sums | **299 / 47,790 / 78,712** |
| corridor vs visual counts and bounds | equal |
| first mismatch / byte offset | **none**, so none is reported |

The primitive-offset comparison is the exact-draw check: it compares the node
chunk's draw records in archive order, not only the counts. A mismatch would
name the section, chunk, item, draw index and both byte offsets. None occurred,
so there is no offset to report.

## Packet and materials

| Field | Result |
| --- | --- |
| section packet records | **1,355** (all direct; `instanceRecords=0`) |
| drawable | **299** |
| omitted other-block | **1,056**, every one with reason `geometryBlockNotImported` |
| packet hash (FNV-1a 64 over every printed field) | **`8b3a40324410327f`**, recomputed independently in Python and pinned |
| static material ids | **297/299** drawable records carry `g_tAlbedo:<row>:<index>` with `materialReason=none` |
| runtime-only materials | **2/299**, `g50-n265` node-chunk primitives 241 and 242: `materialId=null`, `materialReason=runtimeOnlyAlbedoParameter` |
| world transforms | 0 instance matrices; direct draws keep `world=null`/`noInstanceTransform` |
| GPU objects | **0** |

The two runtime-only material values are `DATA_INDEX`/`TEXTURE_PTR` references
that the committed path does not import. The record says so explicitly; no id
is fabricated.

## Determinism and PC parity

- Two independent wasm builds are byte-identical; the two harness runs inside a
  verify run print identical stdout (`a__run1.log` == `a__run2.log`).
- Two full verify runs reproduce the same wasm SHA-256, section packet hash,
  per-section rows and totals.
- The patch is unchanged, so the four patched engine TUs preprocess identically
  with and without the patch (`108,025 / 111,514 / 111,399 / 108,104` lines).
- The modified files are wasm-harness/gate code; no engine source or patch
  changed.

## Remaining blockers

1. Textures are indices plus CPU RGBA only; nothing is created, sampled or
   bound. The P34 102/102 set is unchanged and the section pass does not extend
   it.
2. Two `g50-n265` draws use runtime-only material values; their albedo id is
   null by design.
3. `StreamData::ProcessLoadChunk` is still not driven. These six chunks declare
   no prerequisites, so the resolved property is the read/parse path, not the
   engine's concurrent cache residency.
4. No visibility, culling, LOD selection, sorting or batching; LOD0 direct
   draws only. `instancesApplied:false` and the zero-instance node chunks are
   preserved.
5. No renderer, GPU, browser, vehicle or game claim; `C_OverlayFs` remains one
   read-only layer.

## Evidence

| Path | Content |
| --- | --- |
| `_work/logs/engine-stream-spike/p44-verify-fresh-final-3.json` | every number above, machine-written |
| `_work/logs/engine-stream-spike/p44-verify-fresh-final-3.log` | fresh PASS transcript, 125.5 s |
| `_work/logs/engine-stream-spike/p44-verify-reuse-final-3.log` | second full run, identical, 113.8 s |
| `_work/logs/engine-stream-spike/a__run1.log` / `a__run2.log` | identical harness stdout, all section records |
| `_work/logs/engine-stream-spike/p44-asset-suite-final-2.log` | 29/29 portable suite |
| `_work/track-coverage/corridor.json` | P41 section reference and canonical hash |
| `_work/track-coverage/visual.json` | P41 per-draw offsets and bounds |
| `_work/engine-stream-spike/out/stream_harness_a.wasm` | module, 859,568 B |
| `docs/work/analysis/engine-level-stream.md` §17 | P44 analysis record |

File hashes at this result:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `engine/patches/t005b-stream-overlay.patch` | 77,284 | `5fa2b1b743c388030d1a0bc8b73fe951acfea92406a29cf7b71b2dbb75019b71` |
| `engine/harness/t005e/stream_harness.cpp` | 147,304 | `4803c429c3c1b3feb08252feffe663738510febf09a3db10aa917480c36b74b7` |
| `engine/verify_stream.py` | 138,888 | `62cda74a9d0e59095bc13b1d42dd955d8ba0b56140b50f775d35895b955e7d0b` |
| `_work/engine-stream-spike/out/stream_harness_a.wasm` | 859,568 | `bbd084b3e763225171a7b2eaa4f10dee48fbfa7b151804e4748e9f834c3269e0` |
