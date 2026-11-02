# T-005b verification — engine web file layer

**Date:** 2 November 2026
**Scope:** second engine overlay (file layer) applied on top of the scheduler
overlay; standalone harness, no game integration.

## Patch

`engine/patches/t005b-file-overlay.patch` — SHA-256
`668599f98dd8f4af053c70433f1412ff521d17cabdc357b28cc0a91690bf6b00`.
**3 files added, 2 modified**; every added block is inside
`#if defined(PLATFORM_WEB)`. The two modified files are web-only branches:
`MT::GetThreadId()` (single context → id 1) and `Security.h`'s pure-specifier
(`= NULL` → `= 0`, rejected by clang).

## Gate

```powershell
python engine/apply_file_overlay.py --tree _work/engine-file-spike/tree
python engine/verify_file_overlay.py --fresh
```

Result: **PASS** (111.8 s).

- 56 objects, wasm **495,593 B**, two builds byte-identical.
- Harness: **40/40 checks**, 7 explicit refusals, no leaked handles.
- Real `cache/root.pak` (559,652,864 B) read through `Sys::I_File`:
  - header + **3,601** entries field-identical to `probes/range-file`;
  - **3,609** source requests, **314,522** B, largest 65,536,
    `fullFileBytesCopied=0`;
  - whole-file FNV-1a 64 `2f291abb5648e078` on both buffer paths, equal to an
    independent Python hash.
- Engine PAK consumer path:
  `Pak::ReadPak(*GetDefaultFileSystem(), "/cache/root.pak", Read, NULL, 32 KiB)`
  then `C_PakEntryFile::Open` with the T-005c scheduler. All **3,601 FAT
  records** equal the reference field by field; two entries decompress through
  codec 4:
  `start_3_frontcamera.cycle` 209 B (`7a5224df7820ffae`) and
  `la_river_02_lut.dds` 131,200 B (`583354161ab2a52c`), both equal to an
  independent Python packet decoder and identical under buffered/unbuffered IO.
- PC parity: `C_FileSystem.cpp`, `C_File.cpp` and `Pak.cpp` preprocess
  identically with and without the patch; new TU compiles `/W4` and emits no PC
  symbol.
- Main suite unaffected: `verify_asset_probe.py --skip-build` 29/29.

## Reproducibility

The node harness (`smoke_webfile.cpp`, `web_file_source.js`, `pre.js`) is
committed under `engine/harness/t005b/`; the scheduler probe/shims under
`engine/harness/t005c/`. Both verifiers run from a clean checkout. The PAK index
cross-check needs `_work/range-file-probe/build/range_probe.exe`; if missing, the
verifier stops with `Blocked` and a build hint (no silent skip).

## Limits

- The full `C_PakFs` wrapper cannot link yet: its virtual `DirectoryInfo` needs
  `C_DirectoryInfo` from `C_FileSystem.cpp`, which drags `AsyncFile`. The harness
  calls the two engine functions `C_PakFs` wraps (`ReadPak`,
  `C_PakEntryFile::Open`); the `I_FileSystem` wrapper itself is not exercised.
- PAK signature verification is a no-op on web (`PakSha1.cpp` returns success
  outside PC/PS3); no authenticity claim.
- Two entries, not a corpus; level/streamer/save paths untested.
- No browser evidence: OPFS, worker, COOP/COEP and real `fetch` ranges untested.
- `pf_open` takes a source id, not a virtual path; the path→source table is
  C++-side by design.
- No renderer, physics, audio or game claim.

Evidence: `_work/logs/engine-file-spike/verify-summary.json`,
`_work/logs/engine-file-harness.log`,
`docs/work/analysis/engine-file-layer.md`.
