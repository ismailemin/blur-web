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

## Blockers (measured, not guessed)

1. **`Level.levelrender` is not parsed in-engine.** The target `Scene` archive
   stores DX11 `Display2` types by value: `archive.cpp` `Deserialise(Scene)`
   produces **456 errors**; `streamdata.cpp` 33 errors
   (`Display::Device()->AllocMemory/FreeMemory`, `PERF_EVENT`);
   `RenderLevel.cpp` 71 errors. The chunk table currently comes from the two
   committed probes, which agree.
2. `StreamData::OpenStreamFile` requests buffer hint **0**; the web file system
   accepts 1–1 MiB. The harness opens with 16 KiB. A real wiring must resolve
   this in the file layer or call site.
3. `StreamData` prerequisite/queue logic (`CacheChunk`, `ProcessLoadChunk`) is
   not compiled or exercised — same renderer dependency.
4. No chunk decompression, browser, renderer, vehicle or game claim.

## Next

Give the target archive a narrow fail-loud type facade so
`RenderingData::StreamData` compiles, then produce the 359 `ChunkInfo` records
with the engine's own serialiser and compare to the same references.

Evidence: `_work/logs/engine-stream-spike/verify-summary.json`,
`engine/harness/t005e/`, `docs/work/analysis/engine-level-stream.md`.
