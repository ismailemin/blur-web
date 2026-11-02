# T-005b — the engine file layer on wasm32, over a browser-style range source

**Date:** 2 November 2026
**Status:** bounded spike, complete. One overlay patch adds three new engine files;
nothing existing is modified. A wasm32 module built from a fresh upstream copy
reads the real installed `cache/root.pak` through `Sys::I_File` /
`Sys::I_FileSystem` and reproduces the `probes/range-file` PAK index exactly.
**Prerequisite:** `engine/patches/t005c-web-scheduler.patch` (T-005c), applied
first. The file layer itself needs nothing from the scheduler, but the logging
closure it links against (`FileOpenError`/`FileRwError`) only compiles for wasm32
after the T-005c platform identity.
**Design input:** `docs/work/analysis/t005-streaming-design.md` §4.2, §7.2, §8.
**Predecessor probes:** `probes/range-file` (range reader + independent PAK
parser), `docs/work/analysis/engine-web-shims.md` (T-005c measurements).

## 0. What this is, and what it is not

It is: the engine's **file layer**. `Sys::I_File`, `Sys::I_FileSystem`,
`Sys::SetDefaultFileSystem`, the buffered `Underflow` contract, and a C ABI
(`platform/file`) whose only wasm32 implementation is an imported JS range-source
registry. It compiles, links and reads a 533 MiB PAK on `wasm32-unknown-emscripten`
under node, byte for byte.

It is not, and nothing below claims:

- no browser: no OPFS, no `FileSystemSyncAccessHandle`, no worker, no
  `SharedArrayBuffer`, no COOP/COEP, no `fetch` range, no screenshot;
- no logicalfs, no `C_PakFs`/`C_OverlayFs`/`C_PakEntryFile`, no
  `StreamManager`, no level, no game, no renderer, no audio, no save path;
- no PAK payload, texture or model decoding — the PAK FAT and the file bytes,
  nothing above them;
- no performance claim. A sequential pass in 4 KiB reads over the 533 MiB file
  costs 136,634 `I_File::Read` calls and 4,270 range requests (one 128 KiB refill
  per 32 reads) because the engine's `C_File` contract refills a whole buffer;
  that is measured and reported, not optimised.

## 1. What was added

| Path (in `upstream/BlurRebuilt`) | Lines | Purpose |
|---|---:|---|
| `code/mercury/library/common/system/include/system/serialise/PlatformFileWeb.h` | 87 | the `platform/file` C ABI, plain C, no engine type |
| `.../system/include/system/serialise/C_WebFile.h` | 197 | `Sys::C_WebFile` (`I_File`), `Sys::C_WebFileSystem` (`I_FileSystem`), mount table, counters |
| `.../system/source/serialise/C_WebFile.cpp` | 493 | the implementation |

Tooling (repo, not engine source):

| Path | Purpose |
|---|---|
| `engine/patches/t005b-file-overlay.patch` | the overlay: 3 files, +777 lines, 0 deletions |
| `engine/apply_file_overlay.py` | scheduler patch then file patch, refuses dirty upstream / trees inside `upstream/` |
| `engine/verify_file_overlay.py` | fresh tree, two builds, harness runs, index + hash + PC parity |

The whole implementation is inside `#if defined(PLATFORM_WEB)`, headers and
source. `PLATFORM_WEB` is a build define; `TL_PLAT_WEB` comes from the T-005c
patch. On PC the new translation unit compiles to `SystemPch.h` plus nothing, and
the object contains no `C_WebFile` symbol (§7).

### 1.1 Contract mapping to the design

| Design item (`t005-streaming-design.md`) | Implementation here |
|---|---|
| §4.2 `pf_open/size/read_at/write_at/close/exists/enqueue_read` | `PlatformFileWeb.h`, exactly those names; `pf_abi_version()` added (see §2) |
| §4.2 "JS registers sources, never paths" | `C_WebFileSystem::Mount(prefix, sourceId)` resolves engine paths in C++; `pf_open` receives an opaque source id only |
| §4.2 "a missing range is a read error … zero filling is forbidden" | `pf_read_at` returns `bytes` or `0`; `C_WebFile::ReadRange` fails the read and calls `Sys::FileRwError` |
| §3.2 validation rules | implemented in the JS provider (`web_file_source.js`) with offset/length/size in the message; the C++ side never requests outside the source |
| §1.1.1 `sizeof(buffer)` direct-read gate | replaced by `ctx.readSize >= m_bufferBytes` (the allocated size) |
| §1.2 `AsyncFile` must not be selected | `C_WebFileSystem` is a separate class; `C_FileSystem`/`AsyncFile` are not compiled and not touched |
| §7.4 `DirectoryInfo` stub, write path stub | `DirectoryInfo` returns `false` and counts the call; `E_FileAccess_Write/Append` and `pf_write_at` refuse |
| §4.2 async enqueue | `pf_enqueue_read` declared and explicitly refused (`-1`); the completion pump belongs to the streamer (T-005c) |

### 1.2 Deliberate deviations, with reasons

1. **`pf_open(const char* sourceId, uint32_t access)`, not `pf_open(virtualPath, …)`.**
   The design's signature would move the engine-path → source table into JS,
   which contradicts the same section's "path→(source, offset) resolution and the
   PAK FAT live in C++ (logicalfs), not JS". The table is
   `C_WebFileSystem::Mount`, and JS only ever answers "bytes at offset N of
   source S". The ABI is one argument narrower and one responsibility clearer.
2. **No `pf_last_error()`.** The design says a rejected range "reaches
   `Sys::FileRwError`". `Sys::FileRwError` only invokes a callback if one is
   installed (`FileSystemGlobals.cpp:51-55`), so on its own it is silent. The
   provider therefore writes one stderr line per rejection, including the
   offset, length, source size and reason, and the verified refusal count is an
   asserted value (`verify_file_overlay.py`: exactly 7). C++ side gets `0` and a
   failed `Read`, which is the engine's own error contract.
3. **`C_WebFileSystem::GetSystemFilePath` returns the virtual path.** There is no
   host path in a wasm32 build; returning a fabricated one would be a lie.
4. **A local 16 KiB default buffer, not `DEFAULT_FILE_STREAM_BUFFER_SIZE`.**
   The engine macro is `16*1024` without parentheses (`C_File.h:13`); the value is
   the same and the constant is documented at its use site.

## 2. The C ABI (`PlatformFileWeb.h`)

```c
uint32_t pf_abi_version(void);                    // 1, checked before every open
uint32_t pf_open  (const char* sourceId, uint32_t access);   // 0 on failure
uint64_t pf_size  (uint32_t handle);              // captured at open
uint32_t pf_read_at (uint32_t handle, uint64_t offset, void* dst, uint32_t bytes);
uint32_t pf_write_at(uint32_t handle, uint64_t offset, const void* src, uint32_t bytes);
void     pf_close (uint32_t handle);
uint32_t pf_exists(const char* sourceId);
int32_t  pf_enqueue_read(uint32_t handle, uint64_t offset, uint32_t bytes, uint32_t dstAddr);
```

Rules, enforced on both sides of the boundary:

- `pf_read_at` returns **exactly** `bytes` or `0`. A partial answer is a provider
  bug and is rejected as one.
- `offset`/`length` must be safe integers, `length >= 1`,
  `offset <= size`, `length <= size - offset` (subtraction form, so
  `offset + length` cannot overflow). Violations print the offending values and
  return 0.
- `pf_open` accepts `PF_ACCESS_READ` only. Write and append are refused, not
  downgraded.
- A source without `readSync` (a `Blob`, an HTTP range endpoint) can be opened —
  its size is known — but every `I_File::Read` on it fails explicitly with
  "source has no synchronous store".
- `pf_enqueue_read` returns `-1` and says why: no completion pump exists in this
  build. It is not a synchronous read in disguise.

On wasm32 with the default `WASM_BIGINT`, `uint64_t` parameters arrive in JS as
`BigInt` and `uint64_t` returns must be `BigInt`; this was measured before the
implementation (`_work/engine-file-spike/_probe/`), not assumed.

Provider mapping for a browser (documented, not exercised here):

| Source id | Browser store | `readSync` |
|---|---|---|
| `blob:<name>` | `File`/`Blob` + `File.slice()` | none — stage into OPFS first |
| `opfs:<path>` | `FileSystemSyncAccessHandle.read(buffer, {at})` | yes |
| `http:<name>` | `fetch` + `Range` | no — prefetch only |

The node harness installs `blob:root.pak` with `fs.readSync(fd, …, position)`,
which is the same shape as the OPFS access handle, and `http:async-only` with
`readAsync` only, to hold that contract to account.

## 3. The engine side

`C_WebFile` implements the buffered `I_File` contract:

- `Underflow` reads straight into the caller's target when
  `ctx.readSize >= m_bufferBytes`, otherwise refills the resident buffer. The
  buffered branch must **not** touch `ctx.bytesRead`:
  `I_BinaryStream::Read` (`I_BinaryStream.inl:122-147`) advances the caller's
  pointer by that count and then copies whatever the buffer holds, so reporting
  the fill there would double-count it. `C_File::Underflow` behaves the same way.
- `GetPosition`/`SetPosition` derive the logical position from `m_pCurBuffer`,
  exactly as `C_File::GetPosition` does. This is not cosmetic:
  `I_BinaryStream::Read` moves the cursor behind the file object's back, so a
  cached position counter goes stale after any read served from the buffer. The
  first version of this class cached the position; the harness caught it as
  byte-level corruption of the PAK FAT at three different offsets, in three
  different runs, while the *sequential* whole-file hashes still matched. Both
  the bug and the detection are recorded here because it is the failure mode a
  file layer must never have.
- `Length` is the source size captured at open. A read at end of file returns
  `false` after delivering the bytes that exist (`C_File` semantics), and the
  platform is never asked for a byte past the end.
- A failed range calls `Sys::FileRwError(Name(), m_bWriting, m_IsCritical, 0)` and
  fails the read.

`C_WebFileSystem`:

- `Mount(prefix, sourceId)` — at most 8 mounts, 96-byte ids, longest prefix wins
  with a path-boundary check, so `/cache/root.pak` can live beside a `/` mount.
- `Open` honours `C_OpenParams::m_BufferSizeHint` (1 … 1 MiB; anything else is
  refused with `FileOpenError`, never clamped).
- `FileExists`, `FileInfo` (size from the provider, `E_FileType_File`),
  `DirectoryInfo` (false, counted), `GetSystemFilePath`.
- Counters for the harness: open attempts/successes, refusals by kind, reads,
  bytes, failures, closes, `exists`, `fileInfo`, unsupported calls, ABI
  mismatches.

Selection is `Sys::SetDefaultFileSystem()` — the engine's single injection point
(`FileSystemGlobals.h:28-32`). Nothing else chooses a file system, and no game
code was changed.

## 4. Exact commands

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

# apply scheduler + file overlay to a fresh copy of upstream (refuses dirty upstream)
& $py engine/apply_file_overlay.py --tree _work/engine-file-spike/tree

# full gate: fresh tree, two wasm builds, harness x2, index + hash + PC parity
& $py engine/verify_file_overlay.py --fresh

# same, on a host without MSVC (records the gap instead of claiming parity)
& $py engine/verify_file_overlay.py --skip-native

# the development loop that produced the numbers (spike scratch)
& $py _work/engine-file-spike/run_spike.py

# regenerate the patch from _work/engine-file-spike/src after editing a source
& $py _work/engine-file-spike/make_patch.py          # --check to compare
```

Build configuration (identical to T-005c except `-fexceptions`):

```text
-DBUILD_CONFIG_SPEED -DPLATFORM_WEB -std=c++14 -O2
-fdelayed-template-parsing -D__restrict= -fdeclspec -fexceptions
-Wno-nonportable-include-path -Wno-ignored-attributes
-Wno-deprecated-register -Wno-return-type -Wno-c++20-extensions
-include _work/engine-web-spike/shims/web_platform.h
link: -sENVIRONMENT=node -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=16777216
      -sMAXIMUM_MEMORY=268435456 -sEXIT_RUNTIME=1 -sDISABLE_EXCEPTION_CATCHING=0
      --pre-js <harness/pre.js> --js-library <harness/web_file_source.js>
```

`-fexceptions` is needed because the probe parsers signal validation failures by
throwing and the harness catches them to print the reason. The engine file layer
throws nothing. It is a harness build flag, not a proposed engine flag.

The 21 objects: `C_WebFile`, `FileSystemGlobals`, `Time`, the nine logging TUs
(`LogManager`, `Logger`, `Format`, `DebugLevel`, `Filter`, `ThreadContext` and
the three subscribers), `Thread`, `RwLock`, `Mutex`, `Event`, `platform_net_web`,
`web_runtime`, the harness, and `range_file` + `pak_index_range`. The logging
closure is the one T-005c already established; `FileOpenError` and `FileRwError`
are that closure's clients, not this patch's.

## 5. What was read

Input: `game-data/Blur/cache/root.pak`, 559,652,864 bytes, PAK version 2,
sector 2048, codec 4 (`packet-zlib`), 3,601 FAT entries.

| Check | Result |
|---|---|
| PAK header through the engine stream | identical to `range_probe pak` |
| All 3,601 FAT entries (path, path CRC, logical/physical size, payload offset, parent, directory flag) | identical field by field |
| Range statistics | **identical**: 3,609 requests, 314,522 bytes, largest request 65,536, `fullFileBytesCopied = 0` — the engine layer reproduces the probe's read sequence exactly, for both buffer sizes |
| Whole file, direct `Underflow` (64 KiB reads, 16 KiB buffer) | FNV-1a 64 `2f291abb5648e078` = Python reference |
| Whole file, buffered `Underflow` (4 KiB reads, 128 KiB buffer) | FNV-1a 64 `2f291abb5648e078` = Python reference |
| Two `Underflow` configurations produce the same index | yes (16-byte and 128 KiB buffers) |
| Deterministic | two runs identical, two builds byte-identical wasm |
| Largest range the ABI ever received | 131,072 bytes (a 128 KiB buffer refill) |
| Ranges refused | 7, each with offset/length/size on stderr |

The independent whole-file hash matters more than the index comparison: the
index touches 314 KB of a 533 MB file. The hash is a streaming pass in bounded
chunks through `I_File::Read`, computed twice (both `Underflow` paths) and
compared against Python's FNV-1a 64 over the same file. It is a checksum, not a
cryptographic digest, and is labelled as one.

Cost, measured, not optimised: 16,435 `pf_read_at` calls carrying
1,120,333,384 bytes for the two whole-file passes plus the index and the
negative tests. The split is visible in the counters: the direct pass is 8,540
range requests of 65,536 B, the buffered pass is ~4,270 requests of 131,072 B
(one refill per 32 four-kilobyte `Read` calls), and the rest is the small-buffer
index parse, where every parser read of 16 bytes or more takes the direct path.
The buffered path therefore re-reads nothing but still moves the file twice in
total — the R9 seek cost from the design, unchanged from PC behaviour.

## 6. Explicit failures (all verified)

| Case | Path exercised | Result |
|---|---|---|
| read that crosses end of file | `I_File::Read` after `SetPosition(size-4)` | returns `false` after the 4 real bytes |
| range crossing EOF at the ABI | `pf_read_at(size-4, 16)` | `0` + stderr (`4 bytes available`) |
| range starting past EOF | `pf_read_at(size, 1)` | `0` + stderr |
| zero-length range | `pf_read_at(0, 0)` | `0` + stderr |
| oversized length | `pf_read_at(1, 0xFFFFFFFF)` | `0` + stderr |
| write through the ABI | `pf_write_at` | `0` + stderr |
| write handle | `Open(..., E_FileAccess_Write)` | `0`, counted, `FileOpenError` logged |
| async enqueue | `pf_enqueue_read` | `-1` + stderr |
| unmounted engine path | `Open("/nope/x.pak")` | `0`, counted, `FileOpenError` logged |
| source without a synchronous store | `Open` ok, `Read` | `false` + stderr ("stage it into OPFS first") |
| directory listing | `DirectoryInfo` | `false`, counted |
| ABI mismatch | provider version ≠ header | open refused, counted (§2); coded, not exercised (the provider is this build) |

## 7. PC parity (measured)

Three statements, in increasing strength:

1. **The patch modifies nothing.** Machine-checked by `verify_file_overlay.py`
   (`structural_check`): every file section starts at `/dev/null`, the
   modification list is empty. `git apply -p1 --check` accepts it against
   `upstream/BlurRebuilt`.
2. **Preprocessed PC translation units do not change.** The overlay is applied on
   top of T-005c, so comparing upstream against the tree would also show the
   scheduler's own `map.h`/`sortedbinarytree.h` grammar fixes and would say
   nothing about this patch. The A/B is therefore *with* and *without* the three
   added files: MSVC preprocesses `C_FileSystem.cpp` and `C_File.cpp` in the PC
   configuration (`/DBUILD_CONFIG_SPEED /DPLATFORM_PC /DWIN32 /D_WINDOWS`),
   the three files are deleted, both units are preprocessed again, and the files
   are restored by re-applying the overlay. Result: 155,789 and 155,943 non-blank
   lines, **identical**. The PC build cannot see the file layer at all.
3. **The new TU is inert on PC.** `cl /c /W4 /std:c++14` on `C_WebFile.cpp` in the
   PC configuration: no warning attributed to `C_WebFile.cpp` or `C_WebFile.h`
   (engine headers emit their own, as in any PC TU), and `dumpbin /symbols`
   contains no mangled `@C_WebFile@` symbol. Object size 7,314 B — the
   `SystemPch.h` inlines only.

The wasm warning gate: `-Wall -Wextra -Wpedantic` on `C_WebFile.cpp` yields **no
diagnostic attributed to the new file** except ten `-Wignored-qualifiers`
warnings on `const bool` / `const C_StreamSize` return types. Those come from the
engine's own interface convention (`I_File.h`, `C_File.h`, `FixedString.h` use
the same form); the qualifier has no effect on a scalar return, and dropping it
in the new class would make it cosmetically disagree with the interface it
implements. They are counted and reported, not hidden.

## 8. Limits and open questions

1. **No browser evidence exists.** OPFS, `FileSystemSyncAccessHandle`, workers,
   `SharedArrayBuffer`, COOP/COEP headers and `fetch` ranges were not exercised.
   The provider is written against those APIs' shape, and the node source uses
   `fs.readSync(fd, …, position)`, which is the same synchronous,
   offset-addressed contract — that is a shape argument, not a browser result.
2. **The harness lives in `_work/engine-file-spike/`, not in the repo.**
   `verify_file_overlay.py` requires it (and the T-005c platform shims) and fails
   with the exact missing path rather than silently skipping. Rationale: the
   patch is the deliverable, the harness is the instrument. Committing the
   harness with the task card is the first follow-up (§9).
3. **`pf_open` acquires nothing.** In a browser, obtaining a
   `FileSystemSyncAccessHandle` is asynchronous (it is `.createSyncAccessHandle()`
   on a `FileSystemFileHandle`). Acquisition therefore has to happen before the
   engine enters a synchronous read, which is exactly the design's
   prefetch-then-enter rule; the ABI stays synchronous. Not exercised here.
4. **One process, one mount table, no concurrency.** `C_PakIoMediator`'s single
   mutex and `C_OverlayFs`'s `RwLock` are satisfied trivially by a single context.
   Mounting one source from two workers remains unsupported (design R7).
5. **`SetPosition` past EOF is accepted**, as `C_File` accepts it; the following
   read fails. If the owning phase wants an immediate error, that is a deliberate
   behaviour decision for the shared file interface, not a spike change.
6. **Exception support is a harness build flag.** An eventual engine build that
   keeps `-fno-exceptions` still links: nothing in `C_WebFile.cpp` throws. Only
   the probe parser used by the harness does.
7. **`pf_read_at` has no destination-capacity parameter.** The ABI trusts the
   engine to ask for a range that fits its buffer; the provider cannot detect an
   over-long request except by the source size. A `bytes` larger than the caller's
   destination is a C++ bug, not something the ABI can catch.
8. **The 64 MiB metadata / 100,000 entry / 4 KiB path limits are the probe
   parser's**, inherited from `probes/range-file`. They are not format limits and
   are not claimed as such.

## 9. Blockers and the next smallest step

Blockers, in order of cost:

1. **Nothing of this is in `upstream/`.** The owning phase has to take
   `engine/patches/t005b-file-overlay.patch` on top of the scheduler patch, put
   the three files into the engine's source lists (they are new files, so no
   generated target list changes unless the build enumerates directories), and
   run the native gate. Until then every number here comes from an overlay tree.
2. **The harness is not committed.** Move `smoke_webfile.cpp`,
   `web_file_source.js` and `pre.js` next to the T-005c probes (or into
   `engine/`), then `verify_file_overlay.py` becomes runnable from a clean
   checkout without `_work/`.
3. **No browser provider.** A `opfs:` source with a real
   `FileSystemSyncAccessHandle`, plus the COOP/COEP decision, is the first
   browser-dependent piece. It is also the first place risk R2 (heap growth
   detaching views) can be measured for real.
4. **logicalfs is the next layer up.** `C_PakFs::OpenPak` + `C_PakIoMediator`
   over this file system is the first *engine* consumer; it needs `C_FilePath`,
   `Btl::Vector` and `xt2`, all of which T-005c showed compile, but it has not
   been tried. Until it is, "the engine can read a PAK" is only true through the
   file layer and the probe's independent parser.

Next smallest step: **land the patch and the harness**, then point
`GameSystems.cpp`'s mount table at `C_WebFileSystem::Mount` and take
`C_PakFs::OpenPak("cache/root.pak")` as the first real consumer. That single
step turns three measured claims (compiles, reads the FAT, byte-exact) into an
engine-level one, and it is the smallest change that exercises
`C_PakIoMediator`'s seek pattern instead of the probe's.

## 10. Evidence

All hashes are SHA-256 unless stated; `*` = regenerated by
`engine/verify_file_overlay.py`.

| Path | Size | SHA-256 (16) | Content |
|---|---:|---|---|
| `engine/patches/t005b-file-overlay.patch` | 24,073 | `6e691f285033a270` | the overlay: 3 files, +777, −0 |
| `engine/apply_file_overlay.py` | 5,248 | `22bceca40389585f` | ordered apply + upstream/tree guards |
| `engine/verify_file_overlay.py` | 28,139 | `9c1a1b62a66b8bcf` | the full gate |
| `_work/logs/engine-file-spike/verify-summary.json`* | 1,169,181 | `d7b26c67e2bd63bc` | every number below, machine-written |
| `_work/engine-file-spike/out/webfile_harness_a.wasm`* | 373,202 | `dbc1ad42b73ce004` | the module (21 objects) |
| `_work/engine-file-spike/out/webfile_harness_b.wasm`* | 373,202 | `dbc1ad42b73ce004` | second build, identical |
| `_work/engine-file-spike/out/webfile_harness_a.js`* | 97,472 | `8e18eca740cf604c` | glue + provider + pre.js |
| `_work/logs/engine-file-spike/a__run1.log`* | 720,489 | `8e02ed1b58de234c` | full harness transcript (`a__run2.log` is identical) |
| `_work/logs/engine-file-spike/range-probe.log`* | 716,497 | `1cdf3df46790d769` | `range_probe pak` reference |
| `_work/engine-file-spike/src/C_WebFile.cpp` | 12,605 | `63a07c3af6f6dd6c` | patch source |
| `_work/engine-file-spike/src/C_WebFile.h` | 6,449 | `12751422f55c8a5d` | patch source |
| `_work/engine-file-spike/src/PlatformFileWeb.h` | 3,913 | `96d038ed288e30cd` | patch source |
| `_work/engine-file-spike/harness/smoke_webfile.cpp` | 14,495 | `99eed1b9309aa0ec` | harness driver |
| `_work/engine-file-spike/harness/web_file_source.js` | 8,743 | `e4574bb1513af255` | `platform/file` provider |
| `_work/engine-file-spike/harness/pre.js` | 3,132 | `e5cb4e5e5a768d9d` | node range source |
| `_work/engine-file-spike/tree/.overlay/file-overlay.json`* | 674 | `df8dbe140237129e` | both patch hashes, order, upstream commit |

Recorded run (exit 0). `--fresh` takes about 77 s because it re-copies
`upstream/`; the run below reused the tree and took 64 s.

```text
patch           sha256=6e691f285033a270
files           3 added, 0 modified
objects         21
wasm            373202 B sha256=dbc1ad42b73ce004 deterministic=True
harness         32/32 checks pass, refusals=7
index           3601 entries, requests=3609, bytes=314522
fnv1a64         2f291abb5648e078 (both paths)
pc parity       preprocessed TUs identical, /W4 clean, no PC symbols
verdict         PASS
```

Provider counters for that run (`[platform/file] summary`): `open=6 close=6
read=16435 readBytes=1120333384 largestRequest=131072 writeRefused=1
enqueueRefused=1 exists=4 failures=7 liveHandles=0`.
Engine counters: `openAttempts=6 openSucceeded=4 writeOpenRefused=1
unmountedOpenRefused=1 bufferHintRefused=0 reads=16435 readBytes=1120333384
readFailures=2 closes=4 exists=1 fileInfo=1 unsupportedCalls=1 abiMismatch=0`.
The two read failures are the deliberate end-of-file read and the async-only
source; no unexpected failure occurred.
