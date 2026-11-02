# T-005b slice 1 — range-file probe

Standalone, read-only probe for the first code slice of T-005b: read a large
installed file through bounded byte ranges and reconstruct the PAK metadata
index and the `Level.levelrender` ChunkInfo index without ever copying the whole
file.

This directory is self-contained. It does not modify or link against
`probes/asset-reader/`, `tools/verify_asset_probe.py`, `upstream/`, game data or
engine source. It is **not** engine integration and makes no browser/GPU claim.

## Delivered files

| Path | Purpose |
|---|---|
| `src/byte_source.h` | `ByteSource` contract, `FileByteSource` (seek/read, no whole-file load), `MemoryByteSource` for tests. |
| `src/range_file.h/.cpp` | `RangeFile`: overflow-safe range validation and windowed reads; source-request statistics. |
| `src/pak_index_range.h/.cpp` | Minimal independent PAK metadata parser driven by `RangeFile`. |
| `src/level_index_range.h/.cpp` | Minimal independent level Scene/ChunkInfo parser driven by `RangeFile`. |
| `src/range_probe_cli.cpp` | `range_probe pak|level <path> [--window N]`, one JSON object on stdout. |
| `tests/range_file_tests.cpp` | Range rejection, slice boundaries, no-zero-fill, PAK fixtures, determinism, malformed PAK rejection. |
| `tests/compare_reference.py` | Real-data parity against the existing native probes and the independent Python PAK reference. |
| `tests/verify_wasm.py` | wasm32 build with the project Emscripten toolchain and native/wasm parity under Node `NODERAWFS`. |
| `CMakeLists.txt` | Native build and CTest registration. |

## Range model

`RangeFile` is the only path into the parsers:

- `readAt(offset, length)` rejects `length == 0`, `offset > size`,
  `length > size - offset` (subtraction form, so `offset + length` cannot
  overflow), and a null destination **before** any source call.
- A valid request is split into source reads of at most `--window` bytes
  (default 64 KiB, maximum 16 MiB). Bytes are written directly into the
  caller's destination; there is no intermediate file-sized buffer.
- `ByteSource::read` must copy the complete range or throw. A partial/short
  read propagates; the missing tail is never zero-filled.
- Statistics record `sourceSize`, `windowBytes`, `sourceRequests`, `bytesRead`,
  `largestSourceRequest` and `fullFileBytesCopied` (always 0 in this probe).

The PAK index reads its 16-byte pre-header, settings prefix, string table and
each FAT record through these ranges. The level parser is a random-access
cursor over `RangeFile` that mirrors the block bounds of the existing
`scene_reader.cpp` traversal. Neither parser includes an engine header.

## Build

Native Windows x64 (MSVC `/W4`, C++17). Run from a Developer PowerShell, or use
the `cmd /c` form that loads `vcvars64.bat` first:

```powershell
cmd /c '"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul && "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe" -S probes/range-file -B _work/range-file-probe/build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_MAKE_PROGRAM="C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe" && "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe" --build _work/range-file-probe/build'
```

wasm32 (Emscripten 6.0.13 already under `_work/toolchains/emsdk`):

```powershell
& "_work/toolchains/emsdk/upstream/emscripten/em++.exe" -std=c++17 -O2 `
  probes/range-file/src/range_file.cpp `
  probes/range-file/src/pak_index_range.cpp `
  probes/range-file/src/level_index_range.cpp `
  probes/range-file/src/range_probe_cli.cpp `
  -o _work/range-file-probe/wasm/range_probe.js `
  -sNODERAWFS=1 -sENVIRONMENT=node -sALLOW_MEMORY_GROWTH=1 `
  -sINITIAL_MEMORY=16777216 -sMAXIMUM_MEMORY=268435456 -sEXIT_RUNTIME=1
```

`verify_wasm.py` performs the same build; the explicit command is shown for
reproducibility.

## Run

Use the bundled Python if `python` is a Windows Store alias:

```powershell
$python = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
```

Unit tests:

```powershell
& _work/range-file-probe/build/range_file_tests.exe
ctest --test-dir _work/range-file-probe/build -C Release --output-on-failure
```

One file:

```powershell
& _work/range-file-probe/build/range_probe.exe pak   game-data/Blur/cache/root.pak
& _work/range-file-probe/build/range_probe.exe level "game-data/Blur/levels/usa_la_river/Level.levelrender"
```

The level filename case differs per installed level (`Level.levelrender` and
`level.levelrender` both occur). Pass the real on-disk name; the comparison
scripts enumerate the actual case instead of assuming one.

Full native parity (7 PAKs, all 19 `levelrender` indexes, two runs per input,
plus a 4 KiB window run):

```powershell
& $python probes/range-file/tests/compare_reference.py
```

The script compares against:

- `_work/build/asset-reader-native/Release/pak_inspect.exe`
- `_work/build/asset-reader-native/Release/level_inspect.exe --index`
- the independent Python PAK reader in `tools/inspect_asset_layout.py`
  (imported read-only; V1 `shaders-speed.pak` is skipped by that reference)

wasm32 parity (builds unless `--skip-build`):

```powershell
& $python probes/range-file/tests/verify_wasm.py
& $python probes/range-file/tests/verify_wasm.py --skip-build
```

## Evidence (2 November 2026)

Report files:

- `_work/range-file-probe/reference-comparison.json`
- `_work/range-file-probe/wasm-comparison.json`
- `_work/range-file-probe/logs/unit-tests.log`
- `_work/range-file-probe/logs/reference-comparison.log`
- `_work/range-file-probe/logs/wasm-comparison.log`
- `_work/range-file-probe/logs/wasm-warnings.log`
- `_work/range-file-probe/logs/ctest.log`
- `_work/range-file-probe/logs/root-pak.json`, `river-level.json` and the
  matching `wasm-*.json` single-file outputs

Results:

| Check | Result |
|---|---|
| Native unit suite (`range_file_tests.exe`) | PASS |
| CTest `range_file_unit` | PASS |
| Native PAK parity | 7/7 PAKs, 6,775 entries compared field-by-field |
| Python PAK reference | 6/6 V2 PAKs compared; V1 skipped explicitly |
| Native level parity | 19/19 levels, 7,555 stream chunks compared exactly |
| Determinism (native) | Two runs byte-identical for every PAK and level |
| Window independence | 4 KiB vs 64 KiB records/header identical |
| wasm32 parity | 7 PAKs + 19 levels, 14,330 records, identical JSON and range stats |
| Warning gates | MSVC `/W4` clean; wasm32 clang `-Wall -Wextra -Wpedantic -Werror` clean |

Representative bounded-read measurements (from the reports):

| Input | Size | `bytesRead` | Largest source request | Index result |
|---|---:|---:|---:|---|
| `cache/root.pak` | 559,652,864 | 314,522 | 65,536 | 3,601 entries |
| `cache/root_streaming.pak` | 586,088,448 | 4,188 | 1,392 | 68 entries |
| `levels/usa_la_river/Level.levelrender` | 9,873,988 | 199,359 | 30 | 359 chunks, `parsedUntilOffset` 2,464,509 |
| `levels/uk_london_hackney/Level.levelrender` | 11,081,735 | 344,195 | 66 | 533 chunks, `parsedUntilOffset` 7,021,820 |

Hashes:

- Native probe executable SHA-256:
  `0b5cdb2e2740a28a1f56549fc944806e59f709cd3a852ef5c3ced93d6a00e234`
- wasm JS glue SHA-256:
  `ce9f71b4458dfc86cf43df031f10e0d19ea4cccee50870d566921ecf6f97a74f`
- wasm module size: 172,373 bytes

Per-input output hashes are stored in the two JSON reports. The reports also
record the reference executable hashes and the probe source/binary used.

## Test coverage

`range_file_tests.cpp`:

1. Seven rejected range shapes (EOF, past EOF, underflow, zero length,
   `UINT64_MAX` overflow, null destination, bad seek/skip) with proof that no
   source call was issued.
2. Slice-boundary reads at offsets 0, 62, 63, 64, 994, 999 and 1000, typed
   reads across a window boundary, and no cursor advance after a failed read.
3. Partial and missing source ranges: source bytes are preserved, the rest of
   the destination is untouched, and the error propagates.
4. Eight PAK fixture combinations (little/big endian, regular/secure FAT,
   V1/V2) parsed through a 7-byte window; entry path, CRC, logical size,
   payload offset, physical size and parent are checked.
5. Two identical parses produce byte-identical JSON; a 4 KiB window produces
   the same records as a 7-byte window.
6. Eleven malformed PAK inputs are rejected: bad version, non-power-of-two
   sector, entry limit, FAT length mismatch, parent out of range, payload
   overflow, payload outside file, bad FAT type, bad codec, unterminated path,
   truncated FAT position.

Real-data parity additionally checks:

- every PAK header field and every entry field against `pak_inspect`;
- the independent Python PAK index and path CRC;
- `resourceBlockCount`, `initiallyLoadedBlocks`, every `streamChunks` record and
  `parsedUntilOffset` against `level_inspect --index`;
- `largestSourceRequest <= window`, `fullFileBytesCopied == 0`, and
  `bytesRead < fileSize` for PAKs;
- two identical native runs and two identical wasm runs per input.

## Limits and non-claims

- **No engine integration.** No `Sys::I_File`, `I_FileSystem`, logicalfs,
  `C_PakIoMediator`, streamer or save-system code is included or modified. The
  PAK and level parsers are independent ports, not the engine readers.
- **No browser path.** wasm32 runs under Node with `NODERAWFS`; OPFS,
  `FileSystemSyncAccessHandle`, workers, COOP/COEP, HTTP ranges and WebGPU were
  not exercised. No screenshot or browser-console evidence exists.
- **Metadata only.** No PAK payload/entry is opened, decoded or decompressed;
  no zh/XDEC/XT schema, texture, model or level geometry is read. No signature
  or authenticity validation is performed.
- **Explicit limits inherited from the existing probes:** PAK metadata is
  capped at 64 MiB, level input at 16 MiB, paths at 4,096 bytes, FAT entries at
  100,000. A larger input fails with an error; it is never partially accepted.
- **Level filename case is data.** The comparison scripts enumerate the actual
  on-disk name; they do not assume `Level` or `level`.
- `fullFileBytesCopied == 0` and the window statistics are bookkeeping from the
  probe; they show every source request stayed within the window and no
  source-sized buffer was requested. They are not a measured peak-RSS figure.
- The level parser mirrors the source traversal's rules, including its
  `parsedUntilOffset` definition, so parity is evidence that the range reader
  is transparent for this traversal, not proof that every future
  `levelrender` variant is supported.
- The PAK parser duplicates `probes/asset-reader/src/pak_reader.cpp`. The
  comparison suite is the drift guard; the eventual engine integration should
  share one metadata reader rather than keep two.

## Integration note for the main agent

The intended first-slice landing is:

1. move `RangeFile` / `ByteSource` behind the platform `pf_read_at` boundary;
2. replace the two prefix-buffer entry points with range-driven ones;
3. keep `fullFileBytesCopied == 0`, per-request `<= window`, and explicit
   failures for missing ranges as invariants;
4. run `compare_reference.py` and `verify_wasm.py` unchanged as regression
   gates while integrating.

Nothing in this directory is wired into `tools/verify_asset_probe.py` or the
main build; the main agent owns that integration and the commit.
