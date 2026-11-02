# T-005b verification — engine web file layer

**Date:** 2 November 2026
**Scope:** second engine overlay (file layer) applied on top of the scheduler
overlay; standalone harness, no game integration.

## Patch

`engine/patches/t005b-file-overlay.patch` — 24,073 B, SHA-256
`6e691f285033a27030419e8c40d5d6d400d3162094b4adb5d4e3c65df202fe40`.
**3 files added, 0 modified** (`+777/−0`), all inside `#if defined(PLATFORM_WEB)`.

## Gate

```powershell
python engine/apply_file_overlay.py --tree _work/engine-file-spike/tree
python engine/verify_file_overlay.py --fresh
```

Result: **PASS** (78.5 s).

- 21 objects, wasm **373,202 B**, two builds byte-identical.
- Harness: **32/32 checks**, 7 explicit refusals, no leaked handles.
- Real `cache/root.pak` (559,652,864 B) read through `Sys::I_File`:
  - header + **3,601** entries field-identical to `probes/range-file`;
  - **3,609** source requests, **314,522** B, largest 65,536,
    `fullFileBytesCopied=0`;
  - whole-file FNV-1a 64 `2f291abb5648e078` on both buffer paths, equal to an
    independent Python hash.
- PC parity: zero existing files modified; `C_FileSystem.cpp`/`C_File.cpp`
  preprocess identically with and without the additions; new TU compiles `/W4`
  and emits no PC symbol.
- Main suite unaffected: `verify_asset_probe.py --skip-build` 29/29.

## Reproducibility

The node harness (`smoke_webfile.cpp`, `web_file_source.js`, `pre.js`) is
committed under `engine/harness/t005b/`; the scheduler probe/shims under
`engine/harness/t005c/`. Both verifiers run from a clean checkout. The PAK index
cross-check needs `_work/range-file-probe/build/range_probe.exe`; if missing, the
verifier stops with `Blocked` and a build hint (no silent skip).

## Limits

- No browser evidence: OPFS, worker, COOP/COEP and real `fetch` ranges untested.
- `pf_open` takes a source id, not a virtual path; the path→source table is
  C++-side by design.
- No engine consumer (`C_PakFs::OpenPak`) has opened a PAK through it yet.
- No renderer, physics, audio or game claim.

Evidence: `_work/logs/engine-file-spike/verify-summary.json`,
`_work/logs/engine-file-harness.log`,
`docs/work/analysis/engine-file-layer.md`.
