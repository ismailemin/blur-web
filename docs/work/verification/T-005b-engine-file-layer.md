# T-005b verification — engine web file layer

**Date:** 2 November 2026
**Scope:** second engine overlay (file layer) applied on top of the scheduler
overlay; standalone harness, no game integration.

## Patch

`engine/patches/t005b-file-overlay.patch` — SHA-256
`f9ccd59f46fcb2f4362e381496099ddb3d0bf8d7ec6bd702397c601154967397`.
**4 files added, 3 modified**; every added block is inside
`#if defined(PLATFORM_WEB)`. The modified files are web-only branches:
`MT::GetThreadId()` (single context → id 1), `Security.h`'s pure-specifier
(`= NULL` → `= 0`, rejected by clang), and one `#if !defined(PLATFORM_WEB)`
guard around `C_DirectoryInfo`'s PC body in `C_FileSystem.cpp` so the new web TU
is the only definition in that configuration.

## Gate

```powershell
python engine/apply_file_overlay.py --tree _work/engine-file-spike/tree
python engine/verify_file_overlay.py --fresh
```

Result: **PASS** (116.6 s).

- 61 objects, wasm **530,493 B**, two builds byte-identical.
- Harness: **50/50 checks**, 7 explicit refusals, no leaked handles.
- Real `cache/root.pak` (559,652,864 B) read through `Sys::I_File`:
  - header + **3,601** entries field-identical to `probes/range-file`;
  - **3,609** source requests, **314,522** B, largest 65,536,
    `fullFileBytesCopied=0`;
  - whole-file FNV-1a 64 `2f291abb5648e078` on both buffer paths, equal to an
    independent Python hash.
- Full `C_PakFs` wrapper path:
  `C_PakFs::OpenPak(GetDefaultFileSystem(), "/cache/root.pak", NULL, 32 KiB)`,
  `C_PakFs::Open`, `FileExists`, `FileInfo`, `DirectoryInfo`. All **3,601 FAT
  records** equal the reference field by field; two entries decompress through
  codec 4:
  `start_3_frontcamera.cycle` 209 B (`7a5224df7820ffae`) and
  `la_river_02_lut.dds` 131,200 B (`583354161ab2a52c`), each identical buffered
  and unbuffered and equal to an independent Python packet decoder.
  `DirectoryInfo("\models\objects\shared\construction")` returns 35 children,
  child-size FNV `d2d61563f2fc557e`, matching the reference index.
- `C_OverlayFs` path (the engine's own mount model):
  `AddLayer("/", &pakFs, "/", ...)` then `Open`/`FileExists`/`FileInfo`/
  `DirectoryInfo` on the overlay. The same two entries hash identically
  (buffered and unbuffered) and the directory returns 35 children. The overlay
  directory digest is compared as a multiset because `C_OverlayFs` deduplicates
  through a hash set (engine property); `C_PakFs` still compares FAT order
  exactly.
- PC parity: `C_FileSystem.cpp`, `C_File.cpp` and `Pak.cpp` preprocess
  identically with and without the patch; new TUs compile `/W4` and emit no PC
  symbol.
- Main suite unaffected: `verify_asset_probe.py --skip-build` 29/29.

## Reproducibility

The node harness (`smoke_webfile.cpp`, `web_file_source.js`, `pre.js`) is
committed under `engine/harness/t005b/`; the scheduler probe/shims under
`engine/harness/t005c/`. Both verifiers run from a clean checkout. The PAK index
cross-check needs `_work/range-file-probe/build/range_probe.exe`; if missing, the
verifier stops with `Blocked` and a build hint (no silent skip).

## Limits

- `C_DirectoryInfo` now has two bodies (PC in `C_FileSystem.cpp`, web in the new
  TU). They are identical today and exactly one is compiled per configuration,
  but a PC-side change must be mirrored by hand.
- `C_OverlayFs` works with one read-only PAK layer; the writable layer,
  `C_MemoryFs`, `GameHelpers::CreateGameFs` and `LOGFS_INIT("./user/logown")`
  are untested.
- Global debug-logger initialisation order is unsafe on wasm; the overlay TU is
  built with `-DGLOBAL_DEBUG_MESSAGE_LEVEL=0` (diagnostics only). A real build
  must construct `LogManager` before any `GetLogger` global.
- No browser evidence: OPFS, worker, COOP/COEP and real `fetch` ranges untested.
- PAK signature verification is a no-op on web (`PakSha1.cpp` returns success
  outside PC/PS3); `pSecurity = NULL`, no authenticity claim.
- Two entries and one directory, not a corpus; level/streamer/save paths are
  untested.
- `pf_open` takes a source id, not a virtual path; the path→source table is
  C++-side by design.
- No renderer, physics, audio or game claim.

Evidence: `_work/logs/engine-file-spike/verify-summary.json`,
`_work/logs/engine-file-harness.log`,
`docs/work/analysis/engine-file-layer.md`.
