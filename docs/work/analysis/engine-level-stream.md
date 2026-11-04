# T-005e — level streaming through the engine on wasm32

**Date:** 4 November 2026
**Status:** bounded spike, complete for the slice below. It is not a full level
load: the render-scene reader (`RenderingData::Target::Scene`) and the world
render/levelload stack are measured as blocked (§1.2, §7). No renderer, vehicle,
audio or game claim is made.
**Prerequisites:** `engine/patches/t005c-web-scheduler.patch` and
`engine/patches/t005b-file-overlay.patch` (both applied first).
**Design input:** `docs/work/analysis/t005-streaming-design.md` §5.
**Evidence:** `engine/verify_stream.py`, `_work/logs/engine-stream-spike/`,
`_work/engine-stream-spike/out/`.

## 0. What this is

A wasm32 module that mounts the installed `usa_la_river` level files through the
engine's file system (`Sys::C_WebFileSystem` → `Sys::C_WebFile` → `platform/file`
→ a node range source), above it the engine's overlay file system
(`LogicalFs::C_OverlayFs`, one read-only `E_Type_Newer` layer), and then loads
**all 359 stream chunks** of `Level.levelstream` through the engine's own
`RenderingData::Target::StreamManager::LoadChunk` / `GetChunkData` into its
4 MiB `ChunkAllocator`. Every chunk is hashed inside the module and compared with
an independent Python read at the same `(offset, storedBytes)`.

`Level.levelrender` and `Level.levelphysics` are opened and read through the same
overlay in bounded reads and hash-compared. Their **structure** is not parsed by
the engine in this slice: the `levelrender` ChunkInfo table comes from the two
committed readers (`probes/range-file` `range_probe level` and
`probes/asset-reader` `level_inspect --index`), which agree field by field; the
engine is exercised as the consumer of the ranges. This distinction is load
bearing and is repeated in §7.

## 1. The smallest TU set, and what actually compiles

### 1.1 The streamer itself (compiled)

All paths under `upstream/BlurRebuilt/code/mercury/library/`.

| Role | Definition | Cited lines |
| --- | --- | --- |
| `StreamManager` declaration, chunk allocator type, auto pointer | `graphics/renderingdata/include/renderingdata/streaming.h` | `378-438` |
| `ChunkAllocator::Allocate/Free`, used-map | `.../target/streammanager.cpp` | `25-77` |
| loading thread (PC) | `.../target/streammanager.cpp` | `81-214` |
| 4 MiB allocator creation | `.../target/streammanager.cpp` | `233-234` |
| `LoadChunk` | `.../target/streammanager.cpp` | `263-286` |
| `GetChunkData`, `FlushRequests` | `.../target/streammanager.cpp` | `317-333`, `302-310` |
| `Create` (scheduler groups) | `.../target/streammanager.cpp` | `423-442` |
| `LoadingStatistics::Read` | `.../target/streamingstatistics.cpp` | `80-100` |
| `ChunkInfo` members and serialised order | `renderingdata/streamdata.h:26-63`, `noninterface/archive.inl:949-1002` | |

37 TUs were compiled and linked: the streamer (2), the T-005b file layer
(3 + logging closure + `FilePath`/`FsPerfLogger`/`Debug`/`Variables`), the T-005c
single-context scheduler (5 `jobqueue*` TUs plus `Thread`/`RwLock`/`Mutex`/
`Event`/`CoreMemoryAligned`/`Time`/`BizAssert`/`endian`), `MemoryBuffer.cpp`,
`C_OverlayFs` + `C_OverlayLayer`, the two platform shims and the harness. The
full list is `TUS` in `engine/verify_stream.py`.

`streammanager.cpp` needed one real web body and two web guards (§2). It compiled
with **0 errors** under the flags in `engine/verify_stream.py`.

### 1.2 The level index and render scene (measured blocked)

| Role | Definition | Cited lines | Compile result |
| --- | --- | --- | --- |
| Target Scene deserialiser (`Scene`, resource blocks, shared textures, StreamData) | `graphics/renderingdata/source/noninterface/target/archive.cpp` | `307-345` | **456 errors** with the same include set; it needs `Display.h`, `Display2` buffers/textures and `fx` |
| Target types by value | `.../include/renderingdata/target.h` | `75-166`, `286-430` | pulls `Display2::C_IndexBuffer/VertexBuffer/VertexDeclaration` and `FX::Effect` |
| `RenderingData::Target::StreamData` open/cache/load | `.../target/streamdata.cpp` | `133-166`, `436-459`, `1007-1121` | **33 errors**; calls `Display::Device()->AllocMemory/FreeMemory` (`:78,644,1147`) and `PERF_EVENT` |
| `C_RenderLevel::Read` / `ReadScene` | `graphics/world_render/source/RenderLevel.cpp` | `52-146` | **71 errors** |
| `WorldRender::C_Scene` | `graphics/world_render/source/Scene.cpp` | `118-190` | sits above the same target scene and the scene graph |
| `GameResource::C_LevelResource::LoadResourceData/LoadLevelData/LoadPhysicsData` | `gamesys/game_resource/source/LevelResource.cpp` | `46-140`, `162`, `225` | includes `RenderLevel.h`, gravity importer, NavMesh, MetaDebug |

The blocker is the renderer, not the streamer: the level index lives *after*
effects, resource-block archives and shared textures inside the target Scene
serialiser, and that serialiser stores DX11 `Display2` objects by value. Porting
it is a renderer task (T-005e/§9), not a streaming task, and this spike does not
fake it. The streamer's own contract does not need it: `LoadChunk` takes
`(index, I_File*, offset, size)`, which is exactly a `ChunkInfo` record.

## 2. The overlay patch (6 files, no added files)

`engine/patches/t005b-stream-overlay.patch`, applied after T-005c + T-005b.
It contains no plan B: every change is `PLATFORM_WEB`-guarded and the PC
preprocessed unit is unchanged (§5.2).

| File | Change | Why |
| --- | --- | --- |
| `renderingdata/source/noninterface/target/streammanager.cpp` | `LoadingThread` gets a web body (`class ... : public MT::Thread` is the `#else` branch) that runs the same request list synchronously in `AddRequest`/`WaitUntilFinished`; `Start` is guarded; `BeginTasks` is a web no-op | a wasm32 build has one execution context, and `MT::Event::Wait` aborts (T-005c). The read, allocator, `loadFailed` flag and completion queue are the engine's, not a substitute |
| `renderingdata/include/renderingdata/datatypes.h` | `SHHD_3N`/`SDDD_3N` assign the anonymous-union fields in the body on web | clang rejects initialising several members of an anonymous union; MSVC accepts it |
| `core/include/core/threads/threadlocalstorage.h` | web branch stores the value per instance | the file's last branch was Linux `pthread_key_t`, which does not exist on wasm32; one context makes per-instance storage per-thread storage |
| `core/include/core/maths/utmaths/operator.h` | six dependent calls use `.template At<I>()` on web | clang requires `template` before a dependent template member |
| `core/include/btl/containers/sortedbinarytree.inl` | `Erase(Iterator)` qualifies the dependent base and uses the iterator's public `m_pNode` on web | clang requires qualification; `GetNode(Iterator)` returns a reference into its by-value parameter (`-Wreturn-stack-address`) and trapped under wasm |
| `core/include/btl/containers/skiplist.inl` | `Insert` qualifies `Base::Min/Max` on web | same dependent-base rule; `Sys::MemoryBuffer` uses this map |

The sortedbinarytree fix is not cosmetic: with the original `GetNode(i)` the
chunk free path trapped (`unreachable`) after hashing the first chunk. Replacing
the dangling reference with `i.m_pNode` fixed it; the PC branch keeps the
upstream text byte for byte.

## 3. Harness and mount

`engine/harness/t005e/stream_harness.cpp` + `pre.js`, reusing
`engine/harness/t005b/web_file_source.js` unchanged (the `platform/file`
provider and its range validation).

```cpp
Sys::C_WebFileSystem filesystem;
filesystem.Mount( "/levels/usa_la_river/Level.levelrender",  "blob:levelrender" );
filesystem.Mount( "/levels/usa_la_river/Level.levelstream",  "blob:levelstream" );
filesystem.Mount( "/levels/usa_la_river/Level.levelphysics", "blob:levelphysics" );
Sys::SetDefaultFileSystem( &filesystem );

LogicalFs::C_OverlayFs overlay;                       // the game's file system
overlay.SetWorkingDirectory( "/" );
LogicalFs::C_OverlayLayer::C_Params params;           // GameHelpers defaults
params.flags.layerType = LogicalFs::C_OverlayLayer::E_Type_Newer;
params.flags.writable = 0;
overlay.AddLayer( "/", &filesystem, "/", params, LogicalFs::E_MediaLayer_0, "usa_la_river" );
```

The JS provider registers `blob:levelrender|levelstream|levelphysics` with
`fs.readSync(fd, buffer, 0, length, position)`, the node equivalent of
`FileSystemSyncAccessHandle.read(buffer, {at})` used by T-005b. There is no
whole-file load and no zero fill: every range is validated in JS and in
`C_WebFile`.

The harness reads a manifest of the 359 `ChunkInfo` records
(`index offset storedBytes logicalBytes`) produced by `verify_stream.py` from
`range_probe level`, then for each record:

```cpp
manager.LoadChunk( index, streamFile, offset, storedBytes );   // 4 MiB allocator
manager.GetChunkData( index, loadFailed );                     // owner of the bytes
FNV-1a 64 over the returned pointer for storedBytes; owner frees it at scope exit
```

On web the read happens inside `LoadChunk`; `GetNumRequests()` is 0 and
`IsLoadingChunk()` is false afterwards. This is the T-005c single-context
completion model, not a fabricated success: a failed `I_File::Read` sets
`loadFailed`, and an allocation failure returns `false` and queues nothing.

`engine/harness/t005e/stub/` is a declarations-only display facade used by the
streaming TU. No renderer symbol is defined, so any real renderer call would
fail to link; `streammanager.cpp`'s data path does not call one.

## 4. Results (measured)

Inputs: `Level.levelrender` 9,873,988 B, `Level.levelstream` 244,682,752 B,
`Level.levelphysics` 1,945,409 B.

| Check | Result |
| --- | --- |
| stream chunks loaded through `StreamManager` | **359 / 359**, no failures |
| bytes streamed | **244,682,752** = whole `levelstream` |
| largest chunk | **2,045,952 B** (inside the 4,194,304 B allocator) |
| chunk hashes vs independent Python | **359 / 359 identical** (FNV-1a 64 over each stored range) |
| geometry chunk 157 | offset 68,937,728, 10,240 B, FNV `74dd025de4430925`; SHA-256 of the same range `b07b386c5da5b9154aa393e121614236d7f828d5c5f985e720c01bb192d5b710` — the documented geometry chunk (`docs/plan/level-chunk-format.md`) |
| `levelrender` through the overlay | 9,873,988 B, FNV `0ef5c027f0924307`, SHA-256 `0408e434e5c7f28e5c8f873fac7b33832daf0de29ae404e8a4205433a8b557f9` |
| `levelphysics` through the overlay | 1,945,409 B, FNV `b9594f7ce52caa2e`, SHA-256 `1e678b2dff61b6d3a3d5d95a5160c3f713290251667cb27c55e262175efe4e28` |
| `levelstream` SHA-256 (reference) | `c6b1485cb4164f6ef38ac129d553f7ce60b006ff751dc3889a9eff0c683b33e9` |
| stream-chunk table, field by field | `range_probe level` vs `level_inspect --index`: 359/359 records, `resourceBlockCount=1227`, `initiallyLoadedBlocks=1`, metadata identical |
| engine `I_File` counters | 529 reads, 256,502,153 B, 2 read failures (the two deliberate EOF requests), 0 ABI mismatches |
| provider counters | 9 opens, 529 reads, largest request 2,045,952 B, 0 refusals, 0 live handles |

The chunk table totals 244,682,752 B with no gap or overlap: the engine-loaded
byte count equals the file size, and every per-range hash matches. This is the
"reconstruct the whole stream from ranges, never from a whole-file buffer"
result. It does not decode any chunk; the geometry hash covers stored bytes.

## 5. Determinism and PC parity

### 5.1 Build and run

Two independent wasm builds: 37 objects, **246,726 B**, SHA-256
`410852f78e0b3a132e14a5b49c280a22cd0387687862cb29c545e5c2702d2e01` on both.
Two harness runs on the same module: stdout identical, exit 0, **20/20 checks
pass**. The `--fresh` and reused-tree runs both produce that hash and verdict.

### 5.2 PC preprocessed TU

`renderingdata/.../streammanager.cpp` is preprocessed with MSVC (`/P`,
`BUILD_CONFIG_SPEED + PLATFORM_PC + WIN32 + _WINDOWS`) from the tree **with**
and **without** the six-file patch, using the same declarations-only display
facade (the real `Display/Core/Includes.h` needs the absent DXSDK `dxerr.h`).
After stripping line markers and normalising source paths, both units are
**identical: 187,697 non-blank lines**. Every web branch preprocesses away,
including the whole `LoadingThread` replacement and the `BeginTasks` guard.

This is a delta test, not a claim that the PC renderer build runs here: it proves
this patch cannot change the PC translation unit. The engine TUs the streamer
needs (`MemoryBuffer`, scheduler, file layer) are T-005c/T-005b material.

## 6. Explicit failures (all verified)

| Case | Result |
| --- | --- |
| chunk range crossing EOF (`size-4, 16`) | `LoadChunk` allocates, `Read` fails, `loadFailed=1`, no bytes claimed |
| chunk range starting past EOF (`size, 16`) | same, `loadFailed=1` |
| chunk one byte over the allocator (`MaxChunkSize()+1`) | `LoadChunk` returns `false`, no completion (`index=-1`) |
| provider range outside a source | returns 0 with `offset/length/size` on stderr (T-005b contract) |
| missing level file / unmounted path | `C_WebFileSystem` refuses the open |
| open with a zero buffer hint | refused; this is a real blocker, §7.1 |

There is no silent fallback anywhere: a failed range is a failed `I_File::Read`,
not zero-filled bytes, and the engine counters show exactly the two deliberate
read failures.

## 7. Limits and blockers

1. **`StreamData::OpenStreamFile` asks for `m_BufferSizeHint = 0`
   (`streamdata.cpp:143-147`); `C_WebFileSystem` refuses 0
   (`C_WebFile.cpp:413-420`).** The harness opens the stream with the 16 KiB
   default and the range contract is unaffected, but direct
   `StreamData` wiring will fail until either the file layer accepts 0 as
   "unbuffered" or the call site uses the default sentinel. This is a T-005b
   decision, not papered over here.
2. **The engine did not parse `levelrender`.** That needs
   `RenderingData::Target::Scene` (456 measured errors) and the world-render
   stack (71 errors for `RenderLevel.cpp`). The table is from two committed
   readers that agree; the engine consumed the ranges. A future slice can
   deserialise `RenderingData::StreamData` with the engine's own `ChunkInfo`
   serialiser once the target Scene compiles, or first solve the renderer
   dependency.
3. **`StreamData`'s prerequisite/queue logic is not exercised.** The chunk
   table's prerequisite lists are compared, but `CacheChunk`/`SetLoadChunk`/
   `ProcessLoadChunk` (`streamdata.cpp:406-459,1007-1121`) need the target
   Scene and `Display::Device()`; they are explicitly not compiled.
4. **No renderer, vehicle, audio, game or browser claim.** No `levelrender`
   resource block, node, material or transform is imported; no chunk is
   decompressed. The module runs under node, not in a browser (T-005b's OPFS/
   worker gap still applies).
5. **`C_OverlayFs` is a single read-only layer.** The writable/user layer and
   `GameHelpers::CreateGameFs` remain T-005b limits.
6. **No native runtime streamer parity.** MSVC cannot link the scheduler/log
   closure in this checkout (T-005b §7); the PC gate here is preprocessor
   equality only.

### Next smallest step

Make `StreamData` compile without `Display2`/`fx` by giving the target archive
a narrow, fail-loud type facade (as the display stub does here), then use the
engine's `ChunkInfo` serialiser to produce the 359 records itself and compare
them to the same two references. That replaces the supplied manifest with an
engine-parsed table and is the first step towards `StreamData::CacheChunk` — it
does not require the renderer to draw anything.

## 8. Evidence

| Path | Size | SHA-256 (16) | Content |
| --- | ---: | --- | --- |
| `engine/patches/t005b-stream-overlay.patch` | 10,717 | `A2BB6D9DDD339A80` | the six-file web overlay |
| `engine/verify_stream.py` | 36,549 | `399D642BB970ADDC` | the gate |
| `engine/harness/t005e/stream_harness.cpp` | 14,249 | `7451A3909A3D08A5` | the harness |
| `engine/harness/t005e/pre.js` | — | `B7BCB8BE2CE886A0` | node range sources |
| `engine/harness/t005e/stub/Display.h` | — | `2480E42FF1B55835` | declarations-only display facade |
| `engine/harness/t005e/stub/fx/fx.h` | — | `3878A986BDBCAFB4` | FX declarations |
| `engine/harness/t005e/stub/Display/Core/Includes.h` | — | `F966976582F6C5D0` | empty DXSDK replacement |
| `_work/engine-stream-spike/out/stream_harness_a.wasm`* | 246,726 | `410852F78E0B3A13` | the module (37 objects) |
| `_work/engine-stream-spike/out/stream_harness_b.wasm`* | 246,726 | `410852F78E0B3A13` | second build, identical |
| `_work/logs/engine-stream-spike/verify-summary.json`* | — | — | every number above, machine-written |
| `_work/logs/engine-stream-spike/a__run1.log`* | — | — | harness transcript (`a__run2.log` identical) |

`*` = regenerated by `engine/verify_stream.py`.

## 9. Commands

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

# fresh upstream copy, T-005c + T-005b overlays, then the stream patch:
# two wasm builds, two harness runs, both probe readers, 359 chunk hashes,
# geometry/whole-file hashes, PC preprocess parity
& $py engine/verify_stream.py --fresh

# reuse the tree (the verifier re-applies the scheduler/file overlays and the
# stream patch; ~66 s)
& $py engine/verify_stream.py

# record the PC-parity gap on a host without MSVC
& $py engine/verify_stream.py --skip-native
```

Recorded result (`--fresh`, exit 0):

```text
patch           sha256=a2bb6d9ddd339a80
files           6 modified, 0 added
objects         37
wasm            246726 B sha256=410852f78e0b3a13 deterministic=True
harness         20/20 checks pass
index           359 chunks, blocks=1227, initial=1
stream          244682752 B, largest=2045952 B, chunks=359
chunk hashes    359/359 match independent Python
geometry        chunk 157 fnv=0x74dd025de4430925 sha256=b07b386c5da5b915
levelrender     9873988 B fnv=0x0ef5c027f0924307
levelphysics    1945409 B fnv=0xb9594f7ce52caa2e
pc parity       streammanager.cpp preprocessed identical (187697 lines)
verdict         PASS  (92.1 s)
```

## 10. Source authority

Upstream BlurRebuilt `5270304b81983b9e3edbd569ba25235c17bbabd7`, unmodified:

- `graphics/renderingdata/include/renderingdata/streaming.h`,
  `streamdata.h`, `target.h`;
- `graphics/renderingdata/source/noninterface/target/streammanager.cpp`,
  `streamdata.cpp`, `streamingstatistics.cpp`, `archive.cpp`;
- `graphics/renderingdata/include/renderingdata/noninterface/archive.inl`;
- `graphics/world_render/source/RenderLevel.cpp`, `Scene.cpp`;
- `gamesys/game_resource/source/LevelResource.cpp`;
- `common/system/source/serialise/C_WebFile.cpp` (T-005b overlay);
- `common/core/include/core/threads/threadlocalstorage.h`,
  `core/maths/utmaths/operator.h`, `btl/containers/sortedbinarytree.inl`,
  `btl/containers/skiplist.inl` (web-only branches in this patch).
