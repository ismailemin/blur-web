# T-005b verification — range-file probe

**Date:** 2 November 2026
**Scope:** first T-005b code slice, standalone; no engine link.

## Native build and unit tests

```powershell
& _work/range-file-probe/build/range_file_tests.exe
```

Result: **PASS** — range rejection (7 shapes, no source call), slice boundaries,
no zero fill, 8 PAK fixture combinations at window7, determinism/window
independence, 11 malformed PAK inputs.

## Independent reference

```powershell
python probes/range-file/tests/compare_reference.py
```

Result: **PASS**

- 7/7 PAKs, 6,775 entries field-by-field vs `pak_inspect.exe`
- 6/6 V2 PAKs vs independent Python PAK reader (V1 explicitly skipped)
- 19/19 levelrender indexes, 7,555 stream chunks, exact `parsedUntilOffset`
- two native runs byte-identical; 4 KiB vs 64 KiB window records identical

Evidence: `_work/range-file-probe/reference-comparison.json`

## wasm32 parity

```powershell
python probes/range-file/tests/verify_wasm.py
```

Result: **PASS** — Emscripten 6.0.13, Node `NODERAWFS`; 7 PAKs + 19 levels,
14,330 records, identical JSON/stats, deterministic, clang
`-Wall -Wextra -Wpedantic -Werror` clean.

Evidence: `_work/range-file-probe/wasm-comparison.json`

## Bounded-read examples

| Input | Size | Bytes read | Largest request |
| --- | ---: | ---: | ---: |
| `root.pak` | 559,652,864 | 314,522 | 65,536 |
| `root_streaming.pak` | 586,088,448 | 4,188 | 1,392 |
| River `Level.levelrender` | 9,873,988 | 199,359 | 30 |
| Hackney `Level.levelrender` | 11,081,735 | 344,195 | 66 |

## Limits

Metadata only; no payload decompression/geometry/materials/instances. No engine
`Sys::I_File`/logicalfs/streamer/save integration and no browser/OPFS path. The
probe has independent PAK/level parsers; integration must share one metadata
reader. `fullFileBytesCopied == 0` is bookkeeping, not measured peak RSS.
