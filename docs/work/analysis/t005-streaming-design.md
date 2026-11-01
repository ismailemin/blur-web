# T-005b — PAK/level streaming adapter design

**Date:** 2 November 2026
**Scope:** read-only design. No `upstream/` file, project source, build file, task
card or game data was modified; the game was not run. Numbers marked *measured*
come from reading the installed reference data with the existing native probe
binary and `Get-ChildItem`, both read-only.
**Status:** design only. Nothing in this document is implemented.
**Predecessor:** `docs/work/analysis/engine-wasm-probe.md` (T-005a).

## 0. Problem statement

The installed game data is 7.48 GB across 5,113 files (measured,
`game-data/Blur`). The browser WASM module currently caps its heap at 256 MiB
(`tools/build_asset_probe.py:48`, `-sMAXIMUM_MEMORY=268435456`,
`-sINITIAL_MEMORY=16777216`). The T-005b requirement is therefore not "load the
game files" but "give the engine's own file interfaces a byte-range source that
resolves against storage outside the WASM heap, and make every consumer ask for
ranges small enough to fit".

Two read shapes exist in the engine and they must not be conflated:

1. **Pointer-targeted bulk reads** — a caller hands over a destination pointer
   and a (offset, size) pair. This is what the streamer does today
   (`StreamManager::LoadChunk`, `streammanager.cpp:263-286`). The byte never
   needs to pass through a stream abstraction.
2. **Synchronous stream reads** — `Sys::I_File::Read` on a stream whose
   implementation buffers internally (`I_BinaryStream.inl:92-147`). This is what
   logicalfs, `C_FileBlock` and the save system do.

Only shape 1 can be made genuinely asynchronous on the web. Shape 2 must hit
data that is already resident. The design below separates them explicitly
instead of hiding a promise behind a blocking call.

## 1. Engine interfaces to replace or wrap

All paths are under `upstream/BlurRebuilt/code/mercury/library/`.

| # | Interface | Definition | Contract the web layer must satisfy | Disposition |
|---|---|---|---|---|
| 1 | `Sys::I_File` | `common/system/include/system/serialise/I_File.h:15-40` | `Length`, `GetPosition`, `SetPosition`, `Underflow`, endian flag, `Flush` | **Reimplement** as `C_WebFile` |
| 2 | `Sys::I_BinaryStream` (`UnderflowContext`) | `.../serialise/I_BinaryStream.h:25-33,45,78`; read loop `I_BinaryStream.inl:92-147` | large reads bypass the stream buffer and land directly in the caller's pointer via `ctx.readTarget` | **Keep**, drives the adapter's fast path |
| 3 | `Sys::I_FileSystem` | `.../serialise/I_FileSystem.h:136-193` | `Open`, `FileExists`, `FileInfo`, `DirectoryInfo`, `CreateDirectory`, `GetSystemFilePath` | **Reimplement** as `C_WebFileSystem`; injected as default FS |
| 4 | `Sys::SetDefaultFileSystem` | `.../serialise/FileSystemGlobals.h:28-32` | single global injection point | **Keep** (this is the seam) |
| 5 | `Sys::C_FileSystem` | `.../serialise/C_FileSystem.h:74`; impl `.../source/serialise/C_FileSystem.cpp:46-95` | Win32 `CreateFile`/`ReadFile`/`_findfirst` | **Bypass** on web; not compiled |
| 6 | `Sys::C_File` | `.../serialise/C_File.h:15-104`; impl `.../source/serialise/C_File.cpp` | buffered read/write, `CreateFile` at `:86`, `ReadFile` at `:348`, `FlushFileBuffers` at `:463` | **Bypass**; its POSIX branch is unusable (see 1.1) |
| 7 | `AsyncFile` + `IoFileOpen/IoFileRead` | `.../include/system/io/async.h:133-140,169-244`; `.../source/io/AsyncFile.cpp:154-360` | background IO thread + condition variable | **Stub** on web; must not be selected |
| 8 | `C_FileBlock` | `.../serialise/C_FileBlock.h:67,126` | nested block wrapper that seeks over child blocks on the parent stream | **Keep**; requires cheap `SetPosition` |
| 9 | `C_FilePath` | `.../serialise/FilePath.h:23-117`; inline `FilePath.inl:1-8,457-479` | lowercases `A-Z`, rewrites the non-local separator to the local one, fixed 260-byte buffer (`Btl::String260`, `FilePath.h:113`) | **Keep**, must be made to compile on web |
| 10 | `LogicalFs::C_PakFs` | `util/logicalfs/include/pakfs/PakFs.h:30,41-43,87-91` | `I_FileSystem` over one PAK; `OpenPak(I_FileSystem*, path, security, params)` | **Keep** |
| 11 | `Pak::ReadPreHeader/ReadHeader/ReadStringTable/ReadFat` | `util/logicalfs/include/pakfs/impl/PakRead.h:13-19` | metadata parsing, sector-aligned prefixes | **Keep** |
| 12 | `Pak::C_PakIoMediator` | `impl/PakIoMediator.h:18-21,36,94-95`; impl `source/pakfs/impl/PakIoMediator.cpp:53-82` | serialised random access on the *physical* PAK file: `SetPosition` then `Read`, one mutex | **Keep**; hostile to concurrent sources (see risk R7) |
| 13 | `Pak::C_PakEntryFile` | `impl/PakEntryFile.h:21`; impl `source/pakfs/impl/PakEntryFile.cpp:99,124,142,247-271` | logical entry stream: 32 KiB buffer, physical start = `sector * sectorSize`, forward seek by repeated 8 KiB reads | **Keep**; the seek path is the cost centre |
| 14 | `LogicalFs::C_OverlayFs` | `util/logicalfs/include/overlayfs/OverlayFs.h:22,75-91,108` | path → best layer, per-media-layer stacks, writable layer | **Keep** |
| 15 | `LogicalFs::GameHelpers::MountPakLayer` | `util/logicalfs/include/gamefs/GameHelpers.h:21-29`; call sites `mercurygame/game/GameSystems.cpp:103,116,126` | mounts `cache/root.pak` at `/`, `cache/models.pak` at `/models/`, `gamedata.pak` at `/gamedata/`, … | **Keep**; mount table becomes data, not code |
| 16 | `RenderingData::ChunkInfo` / `StreamData` | `graphics/renderingdata/include/renderingdata/streamdata.h:26-63,67-90` | offset, compressed/original size, items, prerequisites, dependants | **Keep**; the unit of streaming |
| 17 | `StreamData::OpenStreamFile` | `.../source/noninterface/target/streamdata.cpp:133-154` | `GetDefaultFileSystem()->Open(file, Read, params)` with `m_BufferSizeHint = 0` (unbuffered) | **Keep**; becomes an unbuffered range stream |
| 18 | `StreamManager::LoadChunk` / loading thread | `.../target/streammanager.cpp:151-184,263-286` | allocates from a 4 MiB chunk allocator and reads on a thread | **Branch** on web to enqueue a platform range read |
| 19 | `StreamManager` chunk allocator | `.../target/streammanager.cpp:25,233-234`; consumer `streamdata.cpp:100` | 4 MiB total (`0x400000`); chunks above it are permanently disabled | **Keep the size**; it is the streaming memory contract |
| 20 | `UI::C_SaveSystem` | `.../library/ui/include/ui/Game/SaveSystem/SaveSystem.h:277-354` | `StartAsyncLoad/Save/Delete` + `Continue*`; whole-file buffers | **Keep**, backend swap |
| 21 | `C_AsyncLoadThread` (PC save backend) | `.../ui/source/ui/Game/SaveSystem/SaveSystem_pc.cpp:45-137,176-238` | `%APPDATA%\Bizarre Creations\Blur\<saveRoot>\<file>`, `C_FileSystem::Open` read/write | **Reimplement** path root + storage |
| 22 | `IoInitialise/IoShutdown` | `.../source/io/IoService.cpp:553-566` | device/dvd/hdd media layers (PS3) / no-op (PC) | **Stub** on web |

### 1.1 Concrete porting blockers inside these interfaces

Four defects/limits in the existing implementations decide the shape of the web
backend. They are the reason to write a new implementation rather than reuse the
existing non-Windows branch:

1. `C_File.cpp:402` — `if (ctx.readSize >= sizeof(buffer))`. `buffer` is a `U8*`,
   so the gate is `sizeof(pointer)` (4 on wasm32, 8 on x64), not the allocated
   buffer size. On wasm32 every read of 4 bytes or more takes the "direct read"
   path and leaves `m_pCurBuffer`/`m_pBufferEnd` null. Behaviour changes with
   pointer width, which is exactly the kind of silent divergence the project
   forbids.
2. `C_File.cpp:372-380` — the non-Windows `fread` branch compares
   `size_t bytesRead = fread(data, size, 1, m_f)` (an element count, 0 or 1)
   against `size` (a byte count). A one-element read of 32 KiB is reported as
   failure. The branch has never been exercised.
3. `C_File.cpp:296` — `BIZ_ASSERT(newPosition < 2^31);`. `^` is XOR, so the
   bound is `2 XOR 31 = 29`. Any seek to offset ≥ 29 fires the assert in the
   non-Windows branch.
4. `C_File.cpp:151` — `FSERRORSPAM(g_SystemIoLog, C_File::Open, failed to open %s", …)`
   is malformed (missing opening quote). It only compiles because the macro is
   empty in most configurations; it is reported in
   `docs/work/analysis/engine-wasm-probe.md:166-167`.

Additionally `FilePath.inl:457-479` `#error`s on any platform that is not
`PLATFORM_PC`, `PLATFORM_PS3`, `PLATFORM_SPU` or `PLATFORM_LINUX`
(lines 463-465 and 475-477). `PLATFORM_WEB` must be added there before
`C_FilePath` can compile at all.

### 1.2 The blocking problem, stated precisely

`C_FileSystem::Open` returns an `AsyncFile` for every read access
(`C_FileSystem.cpp:50-74`). `AsyncFile::Underflow` issues an `IoFileRead` and
then blocks the *calling* thread on a condition variable until the IO thread
signals completion (`AsyncFile.cpp:189-199`, and the buffered loop at
`:213-360`, wait at `:191-192`). A wasm32 build has no second thread to run that
loop, so this path either deadlocks or silently degrades. Under `PLATFORM_WEB`,
`C_FileSystem::Open` must take the `C_File` branch unconditionally (a compile-time
branch, not the runtime `gSystemIoDisableAsyncFile` flag at
`C_FileSystem.cpp:41,51`), and `AsyncFile` must not be linked.

## 2. Measured data characteristics

Command used for every row (native probe already in `_work/`, read-only):

```powershell
_work/build/asset-reader-native/Release/level_inspect.exe --index `
  game-data/Blur/levels/<level>/Level.levelrender
```

| Quantity | Measured value | Why it matters |
|---|---|---|
| Installed data | 7.48 GB, 5,113 files | never copy the install |
| `cache/` | 1.16 GB | |
| `levels/` | 4.83 GB, 19 levels | |
| Largest PAK | `root_streaming.pak` 558.9 MB (`root.pak` 533.7 MB, `boot.pak` 69.6 MB) | `arrayBuffer()` of a whole PAK is impossible |
| `usa_la_river/Level.levelrender` | 9,873,988 B | index only |
| `usa_la_river/Level.levelstream` | 244,682,752 B | stream source |
| River stream chunks | 359; sum of stored sizes = 244,682,752 B (the whole file) | chunk table is complete and contiguous |
| River chunk size | min 2,048 B, max 2,045,952 B | one chunk = one range request |
| Chunk max over all 19 levels | 2,623,488 B | fits the 4 MiB engine allocator with room |
| River chunks with prerequisites | 222 / 359 | ordering cannot be ignored |
| Max items per chunk | 254 | a chunk can feed many blocks/lods |
| `levelrender` parse cursor, all levels | max 7,021,820 B (`uk_london_hackney`) of max file 13,687,680 B | a fixed 4 MiB index prefix would fail |
| Max PAK metadata | 64 MiB probe limit (`probes/asset-reader/FORMAT.md`, "Limits") | probe limit, not a format limit |

The two consequences that drive everything else: the largest *unit* the adapter
must ever hold is ~2.6 MB per streamed chunk, and the *index* of a level can
need up to ~7 MB read sequentially. Neither is a whole file.

## 3. Browser byte-source primitives

### 3.1 What is synchronous, and where

| Primitive | Sync? | Context | Use |
|---|---|---|---|
| `File.slice(start,end)` | creates a `Blob` synchronously, reads nothing | any | cheap handles over a user-selected install |
| `Blob.arrayBuffer()` / `Blob.stream()` | no | any | prefetch only |
| `FileReaderSync.readAsArrayBuffer(blob)` | **yes** | worker contexts only | last-resort synchronous fill for `File`-backed mounts |
| `FileSystemSyncAccessHandle.read(buffer,{at})` | **yes** | dedicated worker, OPFS file only | the correct synchronous store (see 3.3) |
| `fetch` + `Range` | no | any | network prefetch only |
| sync `XMLHttpRequest` | "yes" | workers, deprecated | **rejected** — blocks the worker event loop, removal in progress |
| `Atomics.wait` | blocks | workers only | usable only with `SharedArrayBuffer` ⇒ COOP/COEP |
| `indexedDB` | no | any | metadata / small blobs |

Consequence: a *general* synchronous read of an arbitrary HTTP range does not
exist in the browser. The design must therefore guarantee that by the time
engine code calls `I_File::Read`, the bytes are local. That guarantee is the
core of the adapter.

### 3.2 Range validation rules (shared by JS, the dev server and C++)

Applied before any request is issued and again when the response is consumed:

1. `offset`, `length` are `Number.isSafeInteger`, `offset >= 0`, `length >= 1`.
2. `offset <= size - length` computed without overflow (reject
   `offset > size` first, then `length > size - offset`).
3. `size` itself is a safe integer and equals the value recorded at mount time.
4. Response status is `206` **and** `Content-Range` matches the request
   (the current probe client only checks `response.ok`, `level.js:36-37`).
5. Received byte length equals the requested length; otherwise fail with the
   short length recorded. `level.js:37` already does this for levels.
6. The *server* re-validates independently (`tools/serve_asset_probe.py:53,85`);
   a client-side check alone is not evidence of a correct range.

### 3.3 Staging: OPFS is the only store that can answer `I_File::Read`

`navigator.storage.getDirectory()` gives an origin-private file system. Inside a
dedicated worker, `FileSystemSyncAccessHandle` provides `read(buffer, {at})`,
`write`, `truncate`, `flush`, `getSize`, `close` — synchronous, offset-addressed,
and exactly the shape `Sys::I_File` needs. That makes OPFS the primary cache and
save store:

- **Cache** (`opfs:/cache/<contentId>/<blockIndex>`): 64 KiB or 256 KiB
  aligned blocks, filled by `fetch`/`File.slice` prefetch, read synchronously.
  A block that is not present is a hard failure, never a zero fill.
- **Staging** for a `File`-selected install: either cache the needed blocks into
  OPFS, or read directly with `FileReaderSync` (worker only) when the user has
  not granted persistent storage.
- **Saves** (`opfs:/saves/<saveRoot>/<file>`), see section 6.

### 3.4 Worker vs main thread

The engine belongs in a dedicated module worker (`new Worker(url,{type:'module'})`):

- `Atomics.wait`, `FileReaderSync` and `FileSystemSyncAccessHandle` are
  worker-only; the main thread cannot provide the synchronous store.
- Rendering (OffscreenCanvas / WebGPU) also moves off the main thread, so a
  long chunk decode does not stall the compositor.
- WASM memory growth detaches existing `HEAPU8` views. Within one worker this is
  detectable (`wasmMemory.buffer !== cachedBuffer`), but any transferable
  `ArrayBuffer` or `SharedArrayBuffer` view held elsewhere is not repaired
  automatically. Keep the byte cache inside WASM-managed allocations or
  re-derive views after every growth (risk R2).

The main thread keeps: file pickers (`showOpenFilePicker` / `<input type=file>`),
user-facing progress and errors. It passes `File`/`FileSystemFileHandle` objects
to the worker via structured clone; `File` objects remain lazy ranges, so this
is cheap.

### 3.5 COOP/COEP

`SharedArrayBuffer` (hence `Atomics.wait`) requires a cross-origin isolated
context: `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` on every response. The current
probe server sends only `Cache-Control: no-store` and `X-Content-Type-Options`
(`tools/serve_asset_probe.py:20-23`). Two options, both must be supported:

- **Isolated** (headers present): `Atomics.wait` blocking is available; a
  worker can block on a range fetch.
- **Not isolated**: fall back to OPFS-only staging and prefetch-then-enter
  (no blocking primitive at all). This is the default path and must work
  without the headers.

## 4. From the probe range server to a production adapter

### 4.1 What the probe does today (and what it hardcodes)

| Site | Hardcoded item |
|---|---|
| `tools/serve_asset_probe.py:14` | `PACKAGES = {boot.pak, root.pak, gamedata.pak, …}` (7 names) |
| `tools/serve_asset_probe.py:15` | `LEVELS = {usa_la_river, showroom, spa_barcelona_bowl_multiplayer}` |
| `tools/serve_asset_probe.py:16` | `LIMIT = 64 * 1024 * 1024` |
| `tools/serve_asset_probe.py:39,51` | `game-data/Blur/levels/<level>/level.levelrender` lowercase, i.e. Windows-only |
| `tools/serve_asset_probe.py:108` | binds `127.0.0.1` only |
| `tools/serve_asset_probe.py:96-101` | static serving restricted to `probes/asset-reader/web` |
| `probes/asset-reader/web/app.js:131-139` | URL shape `/reference/{info,prefix,range}` |
| `probes/asset-reader/web/level.js:6-13` | demo block/node ids and level names |

Measured: the installed files are `Level.levelrender`, `Level.levelstream`,
`Level.level`, `Level.levelphysics` (all 19 levels, capital `L`). The server's
lowercase literal works only because Windows is case-insensitive. A production
resolver must match the on-disk case or carry an explicit index; it must not
rely on the filesystem being case-insensitive.

The probe's *client* abstraction is already the right shape and is what the
production adapter generalises: `{name, size, readPrefix(n), readRange(offset,
length)}` constructed at `app.js:114` for a `File` and at `app.js:131-139` for
the reference server. There is no abstraction leak below that point: offsets
always come from the WASM index (`level.js:4-5,44-47`), never from cached JSON.

### 4.2 The production boundary: one C ABI, one JS registry

Proposed (not created) `platform/file` interface, replacing the
"open/read-range/size/close/write" item already recommended in
`engine-wasm-probe.md:303-308`:

```c
// uint32 handle; 0 == invalid. All calls are synchronous.
uint32_t pf_open (const char* virtualPath, uint32_t access);
uint64_t pf_size (uint32 handle);
uint32_t pf_read_at (uint32 handle, uint64_t offset, void* dst, uint32 bytes);
uint32_t pf_write_at(uint32 handle, uint64_t offset, const void* src, uint32 bytes);
void     pf_close (uint32 handle);
uint32_t pf_exists(const char* virtualPath);
// bulk path used by the streamer; dst is a WASM linear address
int32_t  pf_enqueue_read(uint32 handle, uint64_t offset, uint32 bytes, uint32 dstAddr);
```

`pf_read_at` is implemented by an imported JS function and must either return
the full requested length or `0`. A partial or missing range is a read error
that reaches `Sys::FileRwError` (`FileSystemGlobals.h:40`); zero filling is
forbidden by the project rules.

JS side registers *sources*, never paths:

```js
registerSource('blob:root.pak',   {size, readSync(o,n), readAsync(o,n), identity});
registerSource('opfs:cache/<id>', {size, blockSize, readSync(o,n), readAsync(o,n)});
registerSource('http:probe',      {size, readAsync(o,n)});   // no readSync
```

`readSync` exists only for stores that can answer synchronously (section 3.1).
A source without `readSync` can only feed `pf_enqueue_read`; any `I_File::Read`
that lands on it fails explicitly.

Mount table (data, not code) maps the engine's virtual paths, which arrive
already lowercased and separator-normalised by `C_FilePath`
(`FilePath.inl:1-8`), to a source plus a base offset:

| Engine virtual path | Source | Purpose |
|---|---|---|
| `/` | `pak:cache/root.pak` | `GameSystems.cpp:103` |
| `/models/` | `pak:cache/models.pak` | `GameSystems.cpp:103` |
| `/graphics/shaders/speed/` | `pak:cache/shaders-speed.pak` | `GameSystems.cpp:116` |
| `/gamedata/` | `pak:cache/gamedata.pak` | `GameSystems.cpp:116` |
| `/levels/<name>/` | `file:levels/<name>/` | levelrender/levelstream |
| `/user/` | `opfs:user/` | writable, `LOGFS_INIT("./user/logfs")` `GameSystems.cpp:76` |

The path→(source, offset) resolution and the PAK FAT live in C++ (logicalfs), not
JS. JS only answers "bytes at offset N of source S".

### 4.3 What must not be hardcoded

- Package names, level names, block ids, node ids, stream offsets.
- Any byte limit (64 MiB in the server, 16 MiB in `packet.js:2`). Limits must be
  derived from the mount's `size` and from the engine's allocator, and must be
  reported when exceeded.
- `127.0.0.1`, `/reference/…` URL shapes, the `probes/asset-reader/web` root.
- The assumption that the level files are lowercase.
- The assumption that a whole `levelrender`/PAK prefix fits one buffer: the
  measured index cursor reaches 7,021,820 B.

## 5. Level streaming

### 5.1 Index phase (`Level.levelrender`)

`C_RenderLevel` traversal is sequential and length-driven; the probe follows it
through the opaque Render `FileBlock` (`probes/asset-reader/FORMAT-scene.md:177-183`).
The same growth protocol the PAK path already uses (`app.js:36-53`: start at
64 B, read `report.requiredBytes`, retry, bounded attempts) applies unchanged,
with the bound derived from the file size instead of the constant 16 MiB.

Output contract already fixed and reusable:
`streamChunks:[{offset,storedBytes,logicalBytes,items:[{block,lod}],prerequisites:[]}]`,
`resourceBlockCount`, `initiallyLoadedBlocks`
(`FORMAT-scene.md:185-192`, `scene_reader.cpp:682-688`). `logicalBytes` is the
`ChunkInfo::m_originalSize` field (`streamdata.h:62`,
`archive.inl:973-977`), not an instruction to decompress the whole chunk — some
real values are zero (`FORMAT-scene.md:189-191`). The adapter must fetch
`storedBytes` and never `logicalBytes`.

Validation before a chunk request: `offset + storedBytes` must not overflow and
must be within the mount size; `storedBytes == 0` is a format error.

### 5.2 Prerequisites

`ChunkInfo::m_prerequisites` / `m_dependants` (`streamdata.h:58-59`) are ordered
by the engine: `SetLoadChunk` pulls prerequisites in
(`streamdata.cpp:415-433`) and `CacheChunk` refuses to load until every
prerequisite is `loaded` or `cached` (`streamdata.cpp:436-443`). 222 of 359 River
chunks declare prerequisites.

The adapter must surface prerequisites to the queue and must not issue a
dependent read first. The probe's current behaviour — refuse a selected chunk
whose record has additional prerequisites, `FORMAT-scene.md:194-199` and
`:264-265` — is the correct explicit failure and must be preserved. Fetching all
359 chunks to sidestep ordering is not acceptable: it is 244 MB.

### 5.3 Queue and backpressure

- Unit: one `ChunkInfo` record = one request of `storedBytes` (≤ 2,623,488 B
  measured).
- Destination: the engine's own chunk allocator (4 MiB, `streammanager.cpp:233-234`),
  so the destination pointer is the allocator's, and the JS pump writes into it
  with `HEAPU8.set`. No intermediate copy.
- In-flight budget: bounded both by request count and by bytes, and the byte
  budget must be ≤ remaining allocator space. A request that cannot be
  allocated is refused, matching `LoadChunk`'s existing `pDest == 0` failure
  (`streammanager.cpp:270,284-285`).
- Priority: `IoPriority` semantics are already documented in the engine — high
  within 1/4 s, medium 2 s, low 8 s (`async.h:9-14`). Map them to three FIFO
  bands, never to a single queue.
- Cancellation: `ClearRequests` (`streammanager.cpp:297-300`) and chunk unload
  must abort in-flight fetches (`AbortController`), and a late response for a
  discarded chunk must be dropped by generation counter, not written into a
  recycled allocator block.
- Completion: engine code polls a completion list today
  (`StreamManager::GetChunkData`, `streammanager.cpp:317-333`). On web the pump
  pushes completions between engine ticks. This is the T-005c interface; T-005b
  only requires that `LoadChunk` and `GetChunkData` keep their signatures so the
  branch is local (`streammanager.cpp:151-184,263-333`).

### 5.4 Decompression

A chunk with `m_compressedSize != m_originalSize` is decoded by the PAK codec
path (`I_PakCompress`, `impl/IPakCompress.h`) and, in the probe, by the packet
zlib decoder (`probes/asset-reader/web/packet.js:5-18,20-28`, codec 4). The range
layer only ever supplies stored bytes; decoding stays where it is. Decoded size is
checked against `originalSize`, and a mismatch is a hard error
(`packet.js:12,15`).

## 6. Save and settings storage

### 6.1 Engine behaviour to preserve

`C_SaveSystem` exposes `StartAsyncLoad/Save/Delete` + `Continue*`
(`SaveSystem.h:301-322`). The PC backend builds
`%APPDATA%\Bizarre Creations\Blur\<saveRoot>\<file>` (`SaveSystem_pc.cpp:22-40,
94-105,185-200`), reads the whole file into a heap buffer (`:113-137`) and writes
the whole buffer (`:202-238`), through `Sys::C_FileSystem` — **not** through the
logicalfs overlay. Save files are small; whole-file semantics stay.

### 6.2 Web mapping

- Root: `opfs:/saves/<saveRoot>/<file>`, exposed to the engine through a
  writable `C_WebFileSystem` mount. Because the PC backend targets
  `C_FileSystem` directly, the web build either (a) points a second
  `C_WebFileSystem` instance at the save root and changes the two call sites to
  use it, or (b) remaps `C_FileSystem`'s path resolution on `PLATFORM_WEB`.
  (a) is smaller and keeps `SaveSystem_pc.cpp:94-238` untouched.
- Atomicity: write `<file>.tmp`, `flush()`, then `move()`/rename over the target,
  and delete the temp on failure. `C_File::Flush` maps to
  `syncAccessHandle.flush()` (`C_File.cpp:459-470`).
- Deletion and enumeration: `DirectoryInfo` over OPFS
  (`SaveSystem_pc.cpp:56-82` enumerates before load).
- Settings: a separate versioned IndexedDB key-value store, so a corrupt save
  cannot wedge settings and a settings migration cannot corrupt a save.
- Quota: `navigator.storage.estimate()` before a save, `persist()` at first run.
  On `QuotaExceededError` propagate an explicit save error
  (`E_UiGameProfile_Error`, `SaveSystem.h:303-322`), leave the previous file
  intact, and report the byte deficit. Note the existing silent-success path in
  `SaveSystem.h:297-298` ("save won't work - but will report ok") — the web
  backend must not reproduce it.

## 7. Minimal first slice

### 7.1 What can compile for wasm32 today

From T-005a (`engine-wasm-probe.md:246-290`): vendored zlib, `<core/Core.h>` with
one compat define, and the whole `probes/asset-reader` set. `I_File.h` /
`I_FileSystem.h` pull `Btl`/`Core` and are behind the maths gate; `FilePath`,
`C_MemoryStream` and `C_File` are "maths gate only" and become available the
moment that 7-error gate is fixed (`engine-wasm-probe.md:163-166,257-261`).

So slice 1 deliberately contains **no engine header**. It introduces the platform
C ABI and proves it with the existing readers, which are already wasm32.

### 7.2 Slice 1 contents (proposed; nothing created)

1. `range_source.h` — the C ABI above, no engine includes, C++17, `/W4` clean.
2. `range_file.cpp` — `RangeFile` implementing the *same* buffered contract as
   `Sys::I_File` (Length/Position/SetPosition/Underflow/UnderflowContext),
   without including engine headers; a thin adapter to `Sys::I_File` follows
   once `I_File.h` compiles.
3. `range_index.cpp` — `pak_index_range(reader, size)` and
   `level_index_range(reader, size)` reusing the existing parsers, replacing the
   prefix-buffer entry points (`pak_reader.h:7-9`).
4. `web/range-source.js` — the JS registry with `blob:`, `opfs:` and `http:`
   providers and the shared validator from 3.2.
5. The probe server loses its hardcoded allow-list (4.3) and becomes one
   provider.

### 7.3 Acceptance tests for slice 1

| Test | Invariant | Reference |
|---|---|---|
| Native/wasm parity, PAK index over range reads | identical JSON to `pak_inspect` on all 7 installed PAKs | `_work/verification/pak-native-wasm.json` |
| Level index over range reads, all 19 levels | identical `streamChunks` (offset/storedBytes/items/prerequisites) and `parsedUntilOffset` | `level_inspect --index` output |
| One streamed chunk (River block 252, 10,240 B) | geometry hashes match | `8e00a620…` positions, `7ad84d31…` indices (`_work/verification/level-native-wasm.json`) |
| Prerequisite rejection | a chunk with prerequisites is refused, not fetched | `FORMAT-scene.md:194-199` |
| Range rejection | offset<0, len=0, len>size, offset+len overflow, short response, `206` with wrong `Content-Range` all fail with the offending offset | 3.2 |
| Stale cache | bumped generation must not serve old bytes | risk R6 |
| Determinism | two runs produce identical hashes | project gate |

### 7.4 Stubbed, explicitly, in slice 1

`AsyncFile`, `IoFileOpen/IoFileRead/IoFileClose` (complete the request with
`kIoEvent_Failed` and `kIoError_NoDeviceMapping`, `async.h:24-45`),
`I_FileSystem::DirectoryInfo`
(returns `false`), the write path (`pf_write_at` returns 0 until the save slice),
`IoCachePrioritise`. Each stub must be a compile-time `PLATFORM_WEB` branch with a
comment, never a runtime guess.

## 8. Risks

**R1 — Whole-file reads creeping in.** 558.9 MB PAK, 244.7 MB levelstream.
Any `arrayBuffer()` on a whole file, or a 64 MiB "prefix", is an OOM. Detection:
assert every request `≤ mountSize` and log the largest request; a request equal
to the mount size is a design error.

**R2 — WASM memory growth detaches views.** `ALLOW_MEMORY_GROWTH=1`
(`build_asset_probe.py:48`) moves the heap; cached `HEAPU8`/`DataView` objects
become zero-length, and pointers held in JS stay valid but views do not. Every
cache write must re-derive the view, and no `ArrayBuffer` from WASM memory may be
retained across a call that can allocate.

**R3 — Async reentrancy.** A synchronous `I_File::Read` cannot await. If
someone "fixes" a missing range by pumping the event loop inside the read, JS
re-enters the engine while a stream is mid-`Underflow` — `C_PakIoMediator`
already holds a mutex across the read (`PakIoMediator.cpp:53-82`), so the result
is a deadlock or a torn stream. Rule: no re-entry; missing bytes fail.

**R4 — COOP/COEP.** Without the two headers there is no `SharedArrayBuffer`,
no `Atomics.wait`, and no cross-origin isolated context; with `require-corp`
every fetched asset needs CORP/CORS. Shared workers and module workers must be
served with the same headers. The fallback (OPFS staging, prefetch-then-enter)
must be the default-tested path, not the emergency path.

**R5 — Case and path assumptions.** The probe hardcodes lowercase
`level.levelrender` (`serve_asset_probe.py:39,51`) and 260-byte
`Btl::String260` paths (`FilePath.h:113`); PAK entry paths can be far longer in
the format. A virtual path longer than 259 characters cannot be represented by
the engine, so very long PAK entries must be reachable only through the PAK FAT,
never by string path.

**R6 — Cache invalidation.** Key by content identity (size + hash of the first
4 KiB + PAK header/FAT digest), not by path or `File.lastModified` (both are
user-controlled and survive copied installs). A stale key silently returns
wrong bytes — the one failure mode the project forbids. Validate a sample on
mount and drop the whole cache namespace on mismatch.

**R7 — Concurrency assumptions in logicalfs.** `C_PakIoMediator` assumes one
physical reader per PAK with a single mutex (`PakIoMediator.h:18-21,94-95`), and
`C_OverlayFs` protects its layer stacks with an `MT::RwLock`
(`OverlayFs.h:148`). A single-threaded web build satisfies both trivially; a
T-005c multi-worker design does not. Mounting one PAK from two workers is
unsupported and must be documented as such.

**R8 — Quota and persistence.** OPFS is origin-private and evictable.
`persist()` is a request, not a guarantee; a browser may clear the cache between
sessions, and private windows report a small quota. The adapter must be correct
with an empty cache (refetch, not corrupt) and must never treat a cache miss as
zero-filled data.

**R9 — Seek cost inside compressed PAK entries.** Forward seeks inside a
compressed entry are implemented as repeated 8 KiB reads
(`PakEntryFile.cpp:247-271`) and the code itself warns that physical seeks in a
compressed PAK are "crippling" (`:271`). Sector size is 2 KiB, entry buffer
32 KiB (`PakDefinitions.h:15,18`). Random access into a compressed entry is
therefore O(bytes) and must not sit on the frame path.

## 9. What this document does not claim

- No adapter, no `platform/file`, no JS provider exists. Sections 4.2, 6.2 and
  7.2 are proposals.
- No browser runtime, worker, OPFS, COOP/COEP or WASM behaviour was exercised.
- The measurements in section 2 are native probe reads of installed reference
  data; they describe the data, not any port.
- `PLATFORM_WEB` is still a proposal from T-005a (`engine-wasm-probe.md:297-299`);
  nothing in the engine compiles under it yet.
- The first-slice acceptance table (7.3) is a plan. It is not evidence.

## 10. Recommended boundary, first slice, top risks

**Boundary.** Keep `Sys::I_FileSystem` / `Sys::I_File` as the engine-facing
contract and keep logicalfs, PAK FAT parsing and `ChunkInfo` in C++. Insert one
narrow C ABI (`platform/file`: open/size/read-at/write-at/close + a
pointer-targeted `enqueue_read`) whose only implementation on wasm32 is an
imported JS range source registry (`blob:`, `opfs:`, `http:`). Synchronous reads
are legal only against OPFS (`FileSystemSyncAccessHandle`) or an already
resident block; anything else must be prefetched through the async queue, and a
missing range is an explicit read error.

**First slice.** `platform/file` C ABI + `RangeFile` buffered implementation +
`pak_index_range` / `level_index_range` over the existing parsers, proved by
native/wasm parity on all 7 PAKs and all 19 level indexes, plus one real streamed
chunk matching the recorded geometry hashes. No engine header, no browser
storage, no save path yet.

**Top risks.** (1) WASM heap growth detaching views; (2) a blocking
`I_File::Read` being "solved" by event-loop re-entry; (3) missing COOP/COEP
removing the only blocking primitive; (4) content-identity cache invalidation;
(5) prerequisite-ordered chunk reads being flattened into "fetch everything".
