# T-005b — the engine file layer on wasm32, over a browser-style range source

**Date:** 2 November 2026
**Status:** bounded spike, complete. One overlay patch adds three new engine files
and carries two one-block platform/grammar fixes. A wasm32 module built from a
fresh upstream copy reads the real installed `cache/root.pak` through
`Sys::I_File` / `Sys::I_FileSystem`, and then through the engine's **own PAK
reader** (`Pak::ReadPak`, `C_PakIoMediator`, `C_PakEntryFile`, packet-zlib): the
PAK index matches `probes/range-file` field by field and two entries decompress
to bytes whose hash an independent decoder reproduces.
**Prerequisite:** `engine/patches/t005c-web-scheduler.patch` (T-005c), applied
first. The file layer itself needs nothing from the scheduler, but the logging
closure it links against (`FileOpenError`/`FileRwError`) only compiles for wasm32
after the T-005c platform identity, and the PAK codec runs its inflate tasks on
that scheduler.
**Design input:** `docs/work/analysis/t005-streaming-design.md` §4.2, §7.2, §8.
**Predecessor probes:** `probes/range-file` (range reader + independent PAK
parser), `probes/asset-reader` (codec-4 packet format), `docs/work/analysis/engine-web-shims.md` (T-005c measurements).

## 0. What this is, and what it is not

It is: the engine's **file layer**, and the first real consumer above it. `Sys::I_File`, `Sys::I_FileSystem`,
`Sys::SetDefaultFileSystem`, the buffered `Underflow` contract, and a C ABI
(`platform/file`) whose only wasm32 implementation is an imported JS range-source
registry. It compiles, links and reads a 533 MiB PAK on `wasm32-unknown-emscripten`
under node, byte for byte; the engine's own PAK reader then enumerates the FAT
and decompresses real entries on top of it.

It is not, and nothing below claims:

- no browser: no OPFS, no `FileSystemSyncAccessHandle`, no worker, no
  `SharedArrayBuffer`, no COOP/COEP, no `fetch` range, no screenshot;
- no logicalfs above the PAK file: no `C_PakFs`, no `C_OverlayFs`, no mount
  table, no `StreamManager`, no level, no game, no renderer, no audio, no save
  path;
- no texture, model or level decoding. The PAK FAT and two whole PAK entries
  (209 B and 128 KiB) are read; nothing interprets their contents;
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
| `.../core/include/core/threads/misc.h` | +9 / −0 | `MT::GetThreadId()` gains a `PLATFORM_WEB` branch (§3.2) |
| `.../system/include/System/Misc/Security.h` | +1 / −1 | `= NULL` → `= 0`: a pure-specifier must be the literal zero |

Tooling (repo, not engine source):

| Path | Purpose |
|---|---|
| `engine/patches/t005b-file-overlay.patch` | the overlay: 3 files added, 2 one-block fixes |
| `engine/apply_file_overlay.py` | scheduler patch then file patch, refuses dirty upstream / trees inside `upstream/` |
| `engine/verify_file_overlay.py` | fresh tree, two builds, harness runs, index + entry bytes + PC parity |
| `engine/harness/t005b/smoke_webfile.cpp` | the harness: file layer, then the engine PAK reader |
| `engine/harness/t005b/web_file_source.js`, `pre.js` | the `platform/file` provider and the node range source |
| `engine/harness/t005b/msvc_crt_web.h` | build prelude: `_vsnprintf_s` for `BizAssert.cpp` |

The whole implementation is inside `#if defined(PLATFORM_WEB)`, headers and
source. `PLATFORM_WEB` is a build define; `TL_PLAT_WEB` comes from the T-005c
patch. On PC the new translation unit compiles to `SystemPch.h` plus nothing, and
the object contains no `C_WebFile` symbol (§7). Both edits to existing files are
invisible to the PC build: one is `PLATFORM_WEB`-guarded, the other is a token
MSVC expands identically (§7).

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

### 3.1 The engine PAK reader over this layer (first real consumer)

The harness then uses the engine's own PAK reader. The exact API path:

```cpp
Scheduler::Policy piStreamer[] = { 0, 0, 7, 7, 7, 7, 7, 7 };   // SchedulerConfig.cpp:49-50
Scheduler::PolicyHandle policy = Scheduler::CreatePolicy( piStreamer );
Scheduler::Init();
Scheduler::Start();
Scheduler::SetGroupPoolSize( 64 );                             // game: E_SchedulerGroup_Count + 128
Pak::SetPacketCompressionPolicy( (S32)policy );                // GameSystems.cpp:135

Pak::C_PakFile* pak = Pak::ReadPak( *Sys::GetDefaultFileSystem(),
                                    Sys::C_FilePath( "/cache/root.pak" ),
                                    Sys::E_FileAccess_Read, NULL,
                                    Sys::C_OpenParams( 32 * 1024 ) );

Pak::C_PakFatEntry* fe = pak->GetFatEntry( Sys::C_FilePath( path ) );
Pak::C_PakEntryFile file;
file.Open( pak, fe, Sys::C_FilePath( path ), Sys::E_FileAccess_Read,
           Sys::C_OpenParams( 0 /* unbuffered, the streamer's shape */ ), NULL );
```

`Pak::ReadPak` (`Pak.cpp:739-760`) opens the PAK through `Sys::I_FileSystem`, then
runs `ReadPreHeader` → `ReadHeader` → `ReadStringTable` → `ReadFat`
(`PakRead.cpp`). For a version 2 PAK the 40-byte on-disk FAT entries are converted
to the 32-byte in-memory `C_PakFatEntry`, the parent offsets are rescaled from the
disk stride to the memory stride, and the stored physical size is kept in
`pStoredSizes`. Every one of those reads goes through `C_PakIoMediator` → our
`C_WebFile` → `pf_read_at` → the JS source.

`Pak::C_PakEntryFile` is the logical entry stream. For codec 4 it builds
`Pak::C_PakCompressPacketZLib`, which submits raw-deflate packets as
`Scheduler::AddTask` jobs and drains them with `Scheduler::Flush` — i.e. the PAK
payload path now runs on the T-005c single-context scheduler.

Results on `cache/root.pak` (559,652,864 B, version 2, codec 4, 3,601 entries):

| Check | Result |
|---|---|
| engine header (`version/sector/codec/fat/entries/strings`) | 2 / 2048 / 4 / 0 / 3,601 / 170,406 — equal to the reference |
| all 3,601 FAT records: path, path CRC, logical size, stored size, payload offset, parent index, directory flag | equal field by field to `range_probe pak` |
| `\animations\cameras\start_3_frontcamera.cycle` (209 B logical, 77 B stored, 1 packet) | 209 B, FNV-1a 64 `7a5224df7820ffae`, unbuffered and buffered agree, equals the independent decoder |
| `\graphics\textures\postprocess\la_river_02_lut.dds` (131,200 B logical, 73,819 B stored, 3 packets, partial last packet) | 131,200 B, FNV-1a 64 `583354161ab2a52c`, unbuffered and buffered agree, equals the independent decoder |

The independent decoder is Python (`pak_entry_plaintext` in
`engine/verify_file_overlay.py`): block-size `65536`, then repeated
`[u32 stored][stored bytes]`, `stored == 0xFFFFFFFF` meaning a raw 64 KiB block,
otherwise raw deflate — the layout implemented by
`probes/asset-reader/web/packet.js` and by `PakCompressPacketZLib.cpp` itself. It
reads the stored bytes straight from the file with `open()/seek()`, i.e. without
the engine, so the comparison covers storage *and* decompression.

**What could not be honoured: `C_PakFs` itself.** `LogicalFs::C_PakFs::OpenPak` is a
short wrapper around `Pak::ReadPak`, and `C_PakFs::Open` is a short wrapper around
`C_PakEntryFile::Open`; both would have been usable, but `C_PakFs` has a
virtual `DirectoryInfo` that calls `C_DirectoryInfo::FileInfoArray()`, whose
implementation lives in `system/source/serialise/C_FileSystem.cpp`. That TU is the
Win32 file system the design keeps out of the web build (design §1.2), and linking
it pulls `AsyncFile` and the IO thread. The harness therefore calls the two
engine functions `C_PakFs` calls, not a reimplementation of the reader: `ReadPak`
and `C_PakEntryFile::Open` are engine code, byte for byte, and `C_PakEntryFile`
*is* the `I_File` the rest of the engine would receive.

**What else could not be honoured: PAK signature verification.** On a non-PC,
non-PS3 target `Pak::Sha1::C_Context::Create()` returns `true` and `UpdateHash`
does nothing (`PakSha1.cpp:19-41,129-150`), so `C_HashContext` would report
success without hashing. The harness therefore passes `pSecurity = NULL` and makes
no authenticity claim; a web build must not enable `E_Security_Enabled` until a
real SHA-1 exists.

### 3.2 `MT::GetThreadId()` had no web branch

`Pak::C_AtomicJobList` locks through `MT::AtomicLock`, which compares
`GetThreadId()`. `core/threads/misc.h` implements that function for
`PLATFORM_PC`, `PLATFORM_PS3` and `PLATFORM_SPU` only, and has no `#else`. On
wasm32 the non-void function therefore fell off the end, which clang lowers to a
wasm `unreachable` trap — the first run died inside
`C_AtomicJobList::Initialise`, exactly the defect class T-005c fixed in
`Atomic.h`. The patch adds a `PLATFORM_WEB` branch returning `(ThreadId)1`: one
execution context, one constant non-zero id, so `AtomicLock`'s "already owned by
me" test and its recursive count behave as documented. The PC translation unit is
unaffected (§7).

## 4. Exact commands

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

# apply scheduler + file overlay to a fresh copy of upstream (refuses dirty upstream)
& $py engine/apply_file_overlay.py --tree _work/engine-file-spike/tree

# full gate: fresh tree, two wasm builds, harness x2, index + hash + PC parity
& $py engine/verify_file_overlay.py --fresh

# same, on a host without MSVC (records the gap instead of claiming parity)
& $py engine/verify_file_overlay.py --skip-native

# regenerate the patch from _work/engine-file-spike/src after editing a source
& $py _work/engine-file-spike/make_patch.py          # --check to compare
```

Build configuration (identical to T-005c except `-fexceptions`, the CRT prelude
and the stack size):

```text
-DBUILD_CONFIG_SPEED -DPLATFORM_WEB -std=c++14 -O2
-fdelayed-template-parsing -D__restrict= -fdeclspec -fexceptions
-Wno-nonportable-include-path -Wno-ignored-attributes
-Wno-deprecated-register -Wno-return-type -Wno-c++20-extensions
-include engine/harness/t005b/msvc_crt_web.h     (_vsnprintf_s, harness only)
-include engine/harness/t005c/web_platform.h
link: -sENVIRONMENT=node -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=16777216
      -sMAXIMUM_MEMORY=268435456 -sEXIT_RUNTIME=1 -sDISABLE_EXCEPTION_CATCHING=0
      -sSTACK_SIZE=2097152                       (packet-zlib uses alloca)
      --pre-js <harness/pre.js> --js-library <harness/web_file_source.js>
```

`-fexceptions` is needed because the probe parsers signal validation failures by
throwing and the harness catches them to print the reason. The engine file layer
throws nothing. It is a harness build flag, not a proposed engine flag.
`-sSTACK_SIZE=2097152` is required by the packet-zlib inflate task, which
allocates two 64 KiB buffers with `alloca`; the default 64 KiB stack traps.

The 56 objects: the file layer (3), the logging closure (9 + 2 shims), the
scheduler (5 jobqueue TUs, `Thread`, `RwLock`, `Mutex`, `Event`,
`CoreMemoryAligned`, `Time`), `BizAssert`, `endian`, `FilePath`,
`FsPerfLogger`, `Debug`, `Variables`, `C_MemoryStream`, the engine PAK reader (12
logicalfs TUs), the harness, the two probe parser TUs and eight vendored zlib C
files. The logging closure and the scheduler are T-005c's; this patch adds no
engine TU beyond the three new files.

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
| Engine PAK header (12 `ReadPak` fields) | 2 / 2048 / 4 / 0 / 3,601 / 170,406 — equal to the reference |
| Engine FAT (3,601 records, v2 40→32-byte conversion) | equal to the reference, field by field (§3.1) |
| Two entries through `C_PakEntryFile` + packet-zlib | 209 B and 131,200 B, hashes equal to an independent decoder, unbuffered and buffered |
| Deterministic | two runs identical, two builds byte-identical wasm |
| Largest range the ABI ever received | 139,690 B — the string-table tail after a 32 KiB resident buffer, inside the metadata region (not a whole file, not a whole table) |
| Ranges refused | 7, each with offset/length/size on stderr |

The independent whole-file hash matters more than the index comparison: the
index touches 314 KB of a 533 MB file. The hash is a streaming pass in bounded
chunks through `I_File::Read`, computed twice (both `Underflow` paths) and
compared against Python's FNV-1a 64 over the same file. It is a checksum, not a
cryptographic digest, and is labelled as one.

Cost, measured, not optimised: 16,446 `pf_read_at` calls carrying
1,120,880,888 bytes for the two whole-file passes plus the index, the PAK reader
and the negative tests. The split is visible in the counters: the direct pass is
8,540 range requests of 65,536 B, the buffered pass is ~4,270 requests of
131,072 B (one refill per 32 four-kilobyte `Read` calls), the small-buffer index
parse takes the direct path for every parser read of 16 bytes or more, and the PAK
reader adds two large metadata reads (the string-table tail, 139,690 B, and the
FAT tail, 112,902 B) plus 6 resolution reads for the two entries. The buffered
path re-reads nothing but still moves the file twice in total — the R9 seek cost
from the design, unchanged from PC behaviour.

Cost of the PAK consumer itself: the 209-byte entry is one `I_File::Read` and the
131,200-byte entry three; the stored bytes behind them are 73,896 B in total, all
read through the same buffer as the metadata.

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

Four statements, in increasing strength:

1. **The patch's new files are additive, and its two edits are named and
   bounded.** Machine-checked by `verify_file_overlay.py` (`structural_check`):
   the three added paths are exactly the expected set, the two modified paths are
   exactly `misc.h` (+9/−0) and `Security.h` (+1/−1), and the changed lines must
   contain the expected tokens. `git apply -p1 --check` accepts the patch against
   `upstream/BlurRebuilt`.
2. **Preprocessed PC translation units do not change.** The overlay is applied on
   top of T-005c, so comparing upstream against the tree would also show the
   scheduler's own `map.h`/`sortedbinarytree.h` grammar fixes and would say
   nothing about this patch. The A/B is therefore *with* and *without* the patch:
   MSVC preprocesses `C_FileSystem.cpp` and `C_File.cpp` (the file-layer
   neighbours) and `Pak.cpp` (the one TU that includes both edited headers) in the
   PC configuration (`/DBUILD_CONFIG_SPEED /DPLATFORM_PC /DWIN32 /D_WINDOWS`),
   the three added files are deleted, the two modified files are restored from
   upstream, all three units are preprocessed again, and the overlay is
   re-applied. Result: 155,789 / 155,943 / 125,082 non-blank lines,
   **identical**. `misc.h`'s added block is `PLATFORM_WEB`-guarded, and
   `Security.h`'s `NULL` preprocesses to the same token `0` MSVC sees in `= 0`.
3. **The new TU is inert on PC.** `cl /c /W4 /std:c++14` on `C_WebFile.cpp` in the
   PC configuration: no warning attributed to `C_WebFile.cpp` or `C_WebFile.h`
   (engine headers emit their own, as in any PC TU), and `dumpbin /symbols`
   contains no mangled `@C_WebFile@` symbol. Object size 7,314 B — the
   `SystemPch.h` inlines only.
4. **The engine TUs the consumer needs still compile natively.** `Pak.cpp`,
   `PakRead.cpp`, `PakEntryFile.cpp`, `PakIoMediator.cpp`, `PakFile.cpp`,
   `PakUtil.cpp`, `PakSha1.cpp`, `PakAtomicJobList.cpp`,
   `PakCompressPacketZLib.cpp` are already part of the project's PC build; the
   patch does not touch them. The gates above cover the two headers they include.

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
2. **The harness is committed** as `engine/harness/t005b/`, so
   `verify_file_overlay.py` runs from a clean checkout. `msvc_crt_web.h` there is a
   build prelude (`_vsnprintf_s` → `vsnprintf`), not engine code; the engine's own
   MSVC-CRT dependency remains a real gap for a future engine build (§9.2).
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
9. **`C_PakFs` is not linked** (see §3.1): `DirectoryInfo` needs
   `C_DirectoryInfo`, whose code lives in `C_FileSystem.cpp`, which the design
   excludes from the web build. The PAK reader below it is engine code; the
   `I_FileSystem` wrapper is not exercised.
10. **Two entries are read, not a corpus.** They were chosen to cover a
    single-packet and a three-packet (partial last packet) stream and both are
    verified against an independent decoder, but 3,599 other entries were not
    opened. Nothing here proves every codec-4 variation in the install.
11. **The scheduler runs the inflate jobs serially.** `-sSTACK_SIZE=2097152` is a
    build flag because the inflate task uses `alloca` twice per task; the harness
    build is single-context, so at most one task's stack frame is live.

## 9. Blockers and the next smallest step

Blockers, in order of cost:

1. **Nothing of this is in `upstream/`.** The owning phase has to take
   `engine/patches/t005b-file-overlay.patch` on top of the scheduler patch, add
   the three new files to the engine's source lists, run the native gate, and
   decide how the two existing-file edits are to be adopted. Until then every
   number here comes from an overlay tree.
2. **The engine still needs an MSVC-CRT story for the web build.**
   `_vsnprintf_s` is answered by a harness prelude here; a real engine build needs
   either the T-005c-style `crt_compat` mapping in the engine or call-site fixes.
   The same is true, separately, of `BizAssert.cpp`'s other MSVC spellings.
3. **No browser provider.** An `opfs:` source with a real
   `FileSystemSyncAccessHandle`, plus the COOP/COEP decision, is the first
   browser-dependent piece. It is also the first place risk R2 (heap growth
   detaching views) can be measured for real.
4. **PAK signature verification is a no-op on web** (§3.1): no `E_Security_Enabled`
   until a real SHA-1 exists.
5. **`C_PakFs` / logicalfs is the next layer up.** It needs a web-safe home for
   `C_DirectoryInfo` (or a `PLATFORM_WEB` branch in `C_FileSystem.cpp`) so the
   `I_FileSystem` wrapper can link. After that the mount table
   (`GameSystems.cpp:103,116,126`) and `C_OverlayFs` are the next engine code.

Next smallest step: **give `C_DirectoryInfo` a web implementation** — either move
its four small member functions out of `C_FileSystem.cpp` into a shared TU, or add
a `PLATFORM_WEB` branch in `C_FileSystem.cpp` that compiles without `AsyncFile` (the
design already requires the latter for `Open`). Then `C_PakFs::OpenPak` and
`C_PakFs::Open` replace the two hand-called engine functions in the harness, and
the mount-table + overlay layer becomes the next consumer. Nothing else in this
document changes: the reader below `C_PakFs` is already proven byte-exact.

## 10. Evidence

All hashes are SHA-256 unless stated; `*` = regenerated by
`engine/verify_file_overlay.py`.

| Path | Size | SHA-256 (16) | Content |
|---|---:|---|---|
| `engine/patches/t005b-file-overlay.patch` | 25,317 | `668599f98dd8f4af` | the overlay: 3 files added, 2 one-block fixes |
| `engine/apply_file_overlay.py` | 7,134 | `76e7a0b233034478` | ordered apply, newline-preserving modify path, guards |
| `engine/verify_file_overlay.py` | 43,600 | `91550a0287a07fa1` | the full gate |
| `engine/harness/t005b/smoke_webfile.cpp` | 24,304 | `f58819157a6bf706` | harness: file layer + PAK consumer |
| `engine/harness/t005b/msvc_crt_web.h` | 1,267 | `06c8139291f1f242` | `_vsnprintf_s` build prelude |
| `_work/logs/engine-file-spike/verify-summary.json`* | 2,282,996 | `2c819ae055de2236` | every number below, machine-written |
| `_work/engine-file-spike/out/webfile_harness_a.wasm`* | 495,593 | `7429ca1a4637f5e8` | the module (56 objects) |
| `_work/engine-file-spike/out/webfile_harness_b.wasm`* | 495,593 | `7429ca1a4637f5e8` | second build, identical |
| `_work/engine-file-spike/out/webfile_harness_a.js`* | 98,304 | `798b12d890fbd145` | glue + provider + pre.js |
| `_work/logs/engine-file-spike/a__run1.log`* | 1,109,732 | `5dbbcc017b6ced9a` | full harness transcript (`a__run2.log` is identical) |
| `_work/logs/engine-file-spike/range-probe.log`* | 716,497 | `1cdf3df46790d769` | `range_probe pak` reference |
| `_work/engine-file-spike/src/C_WebFile.cpp` | 12,605 | `63a07c3af6f6dd6c` | patch source |
| `_work/engine-file-spike/src/C_WebFile.h` | 6,449 | `12751422f55c8a5d` | patch source |
| `_work/engine-file-spike/src/PlatformFileWeb.h` | 3,913 | `96d038ed288e30cd` | patch source |
| `_work/engine-file-spike/src/modified/misc.h` | 1,436 | — | patch source (upstream + web block) |
| `_work/engine-file-spike/src/modified/Security.h` | 270 | — | patch source (upstream, `= 0`) |
| `_work/engine-file-spike/tree/.overlay/file-overlay.json`* | 1,124 | `588924ebc13d57d9` | both patch hashes, order, file lists, upstream commit |

Recorded run (exit 0). `--fresh` re-copies `upstream/` and takes about 111 s;
reusing the tree takes about 98 s.

```text
patch           sha256=668599f98dd8f4af
files           3 added, 2 modified
objects         56
wasm            495593 B sha256=7429ca1a4637f5e8 deterministic=True
harness         40/40 checks pass, refusals=7
index           3601 entries, requests=3609, bytes=314522
engine pak      3601 FAT records, 2 entries decompressed (209 B, 131200 B)
fnv1a64         2f291abb5648e078 (both paths)
pc parity       preprocessed TUs identical, /W4 clean, no PC symbols
verdict         PASS
```

Provider counters for that run (`[platform/file] summary`): `open=7 close=7
read=16446 readBytes=1120880888 largestRequest=139690 writeRefused=1
enqueueRefused=1 exists=4 failures=7 liveHandles=0`.
Engine counters: `openAttempts=7 openSucceeded=5 writeOpenRefused=1
unmountedOpenRefused=1 bufferHintRefused=0 reads=16446 readBytes=1120880888
readFailures=2 closes=5 exists=1 fileInfo=1 unsupportedCalls=1 abiMismatch=0`.
The two read failures are the deliberate end-of-file read and the async-only
source; the PAK reads produced no failure. `largestRequest=139,690` is the
string-table tail after the 32 KiB resident buffer, inside the 318,128-byte
metadata region — not a whole file and not a whole table.
