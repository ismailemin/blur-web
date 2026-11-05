# T-005e — level streaming through the engine on wasm32

**Date:** 5 November 2026 (P22 section added; P18 sections below kept as history)
**Status:** bounded spike. P18 proved the streamer over engine-loaded ranges; P22
(replacing the "measured blocked" state for the index) makes the engine's own
`RenderingData::Target::Scene` archive parse `Level.levelrender` on wasm32 and
produces the 359 `ChunkInfo` records itself, with no GPU object created. It is
still not a full level load: resource blocks, render lists, materials and
textures are not imported, and `ProcessLoadChunk` is compiled but not run. No
renderer, vehicle, audio or game claim is made.
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

37 TUs were compiled and linked (P18; P22 links 54, §11.1): the streamer (2), the T-005b file layer
(3 + logging closure + `FilePath`/`FsPerfLogger`/`Debug`/`Variables`), the T-005c
single-context scheduler (5 `jobqueue*` TUs plus `Thread`/`RwLock`/`Mutex`/
`Event`/`CoreMemoryAligned`/`Time`/`BizAssert`/`endian`), `MemoryBuffer.cpp`,
`C_OverlayFs` + `C_OverlayLayer`, the two platform shims and the harness. The
full list is `TUS` in `engine/verify_stream.py`.

`streammanager.cpp` needed one real web body and two web guards (§2). It compiled
with **0 errors** under the flags in `engine/verify_stream.py`.

### 1.2 The level index and render scene (P18 measurement; superseded by §11)

> **Superseded for `Level.levelrender` by §11 (P22).** The Scene object and its
> `StreamData`/`ChunkInfo` table now compile and parse on wasm32 through the
> engine's own archive code. The measurements below remain the record of the
> *full* target/renderingdata and world-render closure, which is still not
> ported; §11 lists what is now compiled and what remains a renderer task.

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

1. **`StreamData::OpenStreamFile` asked for `m_BufferSizeHint = 0`.** P22 resolved
   this at the call site with a documented rule (§11.3): the web branch passes
   `C_OpenParams::kBufferSizeHintDefault` (the file layer's 16 KiB default)
   instead of 0, because the T-005b layer refuses 0. Chunk reads still take the
   pointer-targeted direct path, so the byte path is unchanged. This is the
   only contract change and it is `PLATFORM_WEB`-guarded.
2. **The engine now parses `levelrender` (§11).** `RenderingData::Target::Scene`
   compiles on wasm32 with a data-only two-function web branch (vertex
   declarations, textures); every GPU entry point is a fail-loud abort. The 359
   `ChunkInfo` records are produced by `archive.inl`'s serialiser and match both
   committed readers field by field. Resource blocks and the world-render stack
   (O5) are still renderer tasks.
3. **`StreamData`'s prerequisite/queue logic** is now partially exercised:
   `CacheChunk` runs on chunk 0 and refuses chunk 89 (first with a
   prerequisite). `ProcessLoadChunk` compiles but is not run: it deserialises
   streamed resource blocks, which need GPU buffers (§11.7).
4. **No renderer, vehicle, audio, game or browser claim.** No `levelrender`
   resource block, node, material or transform is imported; no chunk is
   decompressed. The module runs under node, not in a browser (T-005b's OPFS/
   worker gap still applies).
5. **`C_OverlayFs` is a single read-only layer.** The writable/user layer and
   `GameHelpers::CreateGameFs` remain T-005b limits.
6. **No native runtime streamer parity.** MSVC cannot link the scheduler/log
   closure in this checkout (T-005b §7); the PC gate is preprocessor equality of
   three TUs (§11.6), not a native run.

### Next smallest step (after P22)

Import one streamed resource block through `ProcessLoadChunk` behind a data-only
`LodReader<ResourceBlock::Resources>` branch (vertex/index buffers as byte ranges,
no device objects), then bind the already-verified chunk 157 ranges to the
resource metadata path. That is renderer-facing and must not be claimed as
drawing or gameplay.

## 8. Evidence (P18; superseded by §11.8 for the current patch)

> The patch and verifier hashes below are the P18 state. The current patch
> (14 files) and the P22 module are in §11.8.

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

## 9. Commands (P18; P22 result in §11.9)

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

## 11. P22 — the engine parses `Level.levelrender` itself

This section supersedes §1.2 and §7.1-7.3 for the level-index slice. It is a
technical record; it makes no renderer or game claim.

### 11.1 What compiles on wasm32 now

54 TUs link. 17 are new relative to P18:

| Group | TU | Why |
| --- | --- | --- |
| archive | `renderingdata/source/noninterface/target/archive.cpp` | `Deserialise(Target::Scene)`, vertex declarations, shared textures, `StreamData` |
| stream | `.../target/streamdata.cpp` | `OpenStreamFile`, `CacheChunk`, `ProcessLoadChunk`, chunk state |
| stream | `.../target/resources.cpp` | `ResourceBlock`/`Texture`/buffer destructors and `SharedTextureManager` |
| types | `renderingdata/source/noninterface/{archive,scene,node,renderstates,material,effect}.cpp` | handler registration, base `Scene`/`Node`, material types |
| serialise | `common/system/source/serialise/{C_FileBlock,C_MemoryStream}.cpp` | the engine block walk and `ProcessLoadChunk` stream |
| archive | `common/misc_shared/source/misc_shared/archive/handler.cpp` | `SerialisationIdManager` storage |
| memory | `common/system/source/memory/{BlockAllocator,VirtualMemory}.cpp` | the resource allocator the texture-name strings use |
| harness | `engine/harness/t005e/{scene_target_web,display_fail_loud,web_scene_report}.cpp` | data-only engine link shims + fail-loud renderer boundary |

The archive path is the engine's: `Sys::C_FileBlock` walks the level's `Render`
block exactly as `C_RenderLevel::Read` does, then `Arch::BinaryInputArchive`
reads `RenderingData::Target::Scene`. The `ChunkInfo` records come from
`renderingdata/noninterface/archive.inl` (`Serialise(ChunkInfo)`,
`Serialise(StreamData)`), not from the probes. The probes remain the
independent reference the output is compared against.

### 11.2 The narrow display/FX facade

`engine/harness/t005e/stub/` contains data-only complete types that
`target.h`/`streaming.h` need by value (`Display2::C_IndexBuffer`,
`C_VertexBuffer`, `C_VertexDeclaration`, `Display::C_Texture2D`,
`FX::SharedBindingBits`, `ImmediateParameter`). Every renderer entry point
(`Display::Device`, `Display2::Device` and all texture/buffer/effect calls) is
defined in `display_fail_loud.cpp` and prints `[t005e] GPU call refused: <api>
at <file>:<line>` then aborts. No call returns a fake success: a facade texture
reports `IsCreated() == false` (the same state a failed device creation leaves),
and `IsCreated` is a query, not a creation.

Two Scene-path deserialisers must consume real bytes without a device, so they
have data-only `PLATFORM_WEB` branches in `archive.cpp`:

- `Deserialise(Target::VertexDeclaration)` reads the 17-byte element records
  through the engine's own `VertexElement` serialiser and leaves `m_pData = 0`;
- `Deserialise(Target::Texture)` reads platform tag, name, sampler state, hash
  and the declared `S32` blob in 4 KiB steps, sets `m_discard = 1` (exactly what
  the upstream path does after a failed `CreateTexture2D`) and records the name
  and byte count. Bounds are checked after every read and a short range calls
  `WebSpike::ArchiveUnderflow`, which aborts with the byte counts.

Everything else in `archive.cpp` is compiled, not removed: buffer/LOD/render-list
deserialisers exist and would abort on their first device call. The counters
(`gpuCalls`, `perfEvents`, `unsupportedCalls`) are printed by the harness; the
gate requires `gpuCalls == 0`.

`StreamData::BeginTasks` (the view/SPU request worker) is `PLATFORM_WEB`-guarded
to `WEBSPIKE_UNSUPPORTED`, which aborts. It is never reached in this slice
(`Request` is not called) and its counter is asserted to be 0.

### 11.3 The buffer-hint rule (resolved)

Upstream `StreamData::OpenStreamFile` asks for `m_BufferSizeHint = 0`
("unbuffered", `streamdata.cpp:143-147`). The T-005b web file layer accepts
1..1 MiB and refuses 0 (`C_WebFile.cpp:413-422`). The two contracts cannot both
hold. The web branch therefore passes
`Sys::C_OpenParams::kBufferSizeHintDefault`, the layer's documented sentinel for
its 16 KiB default. This is a call-site rule, not a file-layer change:

- chunk loads are `I_File::Read(destination, storedBytes)` with a destination
  pointer, so `C_WebFile::Underflow` takes the direct range path whenever
  `readSize >= m_bufferBytes` (`C_WebFile.cpp:241-267`); the largest chunk is
  2,045,952 B, so every chunk load takes it;
- the hint only sizes the small header reads;
- the harness records the sentinel (`-1`) and the gate fails if hint 0 is passed
  or the layer's `bufferHintRefused` counter is non-zero.

### 11.4 Measured result (fresh run, exit 0)

Inputs unchanged: `levelrender` 9,873,988 B, `levelstream` 244,682,752 B,
`levelphysics` 1,945,409 B.

| Check | Result |
| --- | --- |
| Scene archive | outer read-scene version **1**, target `Scene` version 0, `resourceBlockCount` **1227**, `initiallyLoadedBlocks` **1** |
| vertex declarations | **16** declarations / **67** element records, `m_pData = 0` |
| effects | **43** names read (data only, shader pointers null) |
| shared textures | **10** envelopes, **2,196,056** stored bytes consumed, 0 textures created |
| engine `ChunkInfo` | **359** records, **10,784** items, **603** prerequisites, **603** dependants, **0** disabled over the 4 MiB allocator |
| stream sizes | stored **244,682,752 B**, original **238,442,906 B** (the latter is the field, not a decode) |
| field-by-field | 359/359 equal to `range_probe level` and `level_inspect --index` (offset, storedBytes, logicalBytes, every `(block,lod)` item, every prerequisite) |
| scene cursor | **2,464,509 B** absolute, equal to the probe `parsedUntilOffset`; Scene payload at **62**; consumed 2,464,447 B of the 2,465,603 B Scene body (bounds check) |
| table hash | `aae9814242df9d36` (FNV-1a 64 over the printed records), identical in C++ and Python |
| GPU calls | **0** refused, **0** unsupported |
| chunk streams | **359/359** loaded from the engine table through `StreamManager`, **244,682,752 B**, largest **2,045,952 B** |
| chunk hashes | **359/359** FNV-1a 64 equal to independent Python at the engine `(offset, storedBytes)` |
| geometry chunk 157 | offset 68,937,728 / 10,240 B, FNV `0x74dd025de4430925`, SHA-256 `b07b386c...b710` |
| `levelrender` / `levelphysics` | FNV `0x0ef5c027f0924307` / `0xb9594f7ce52caa2e`, equal to Python |
| `OpenStreamFile` | opened 1, hint `-1` (sentinel), `bufferHintRefused = 0` |
| `CacheChunk(0)` | returned 1, index 0, offset 0, 4096 B, FNV `0x6902d748913089e9` == Python |
| prerequisite refusal | chunk **89** (first with a prerequisite) refused before any read |
| provider | 12 opens / 12 closes / 568 reads / 259,008,905 B / largest 2,045,952 / 0 failures / 0 live handles |
| engine counters | `readFailures = 2` (the two deliberate EOF requests), `abiMismatch = 0` |

The 603 prerequisites duplicate the 222/359 chunks with at least one
prerequisite from `t005-streaming-design.md` §2; the per-chunk lists are the
gate, not the sum.

### 11.5 Determinism and PC parity

- Two independent wasm builds: 54 objects, **664,137 B**, SHA-256
  `5df210f16a0d8642255671058e1beb7d510f7427eef1cb52b915c27c03d578a0` on both.
- Two harness runs on the same module: stdout identical, exit 0, **30/30
  checks**.
- PC preprocessing (`/P`, `BUILD_CONFIG_SPEED + PLATFORM_PC + WIN32 + _WINDOWS`)
  from the patched tree and from a full T-005c + T-005b tree, same include set:
  `streammanager.cpp` 108,025 code lines, `streamdata.cpp` 111,514,
  `archive.cpp` 111,399 — identical after removing line markers, comments and
  the `__LINE__` argument of log locations (the same normalisation
  `engine/native_parity.py` uses). The real Display2/FX headers need the absent
  DXSDK, so both sides use the committed facade, as P18 did for
  `streammanager.cpp`.
- The patch is reproducible from `_work/engine-stream-spike/make_stream_patch.py`
  (14 files, no added files).

Link-order note: the sorted object order is deliberate. The wasm
`__wasm_call_ctors` order follows link order, and the renderingdata TUs resolve
`Debug::GetLogger` at static-init time. TUS order alone left `LogManager`'s
singleton unconstructed in one build; sorting the object list is deterministic
and is part of the gate now.

### 11.6 Explicit failures

Every one aborts or fails a named check; none zero-fills:

- archive read short of its declared bytes → `WebSpike::ArchiveUnderflow` with
  wanted/available;
- negative texture blob length → unsupported;
- chunk range crossing EOF and range starting past EOF → `LoadChunk` allocates,
  `Read` fails, `loadFailed = 1` (the two counted failures);
- one byte over the 4 MiB allocator → refused, no completion;
- a chunk with prerequisites → `CacheChunk` returns false before `LoadChunk`;
- any renderer entry point → GPU call refused + abort (never reached in the
  gate: `gpuCalls == 0`).

### 11.7 Remaining blockers (all renderer-facing)

1. **Resource blocks and render lists are not imported.** `Deserialise(ResourceBlock)`
   and the render-list tail still need `CreateIndexBuffer`/`CreateVertexBuffer`/
   `CreateVertexDeclaration`/render states. `initiallyLoadedBlocks = 1`, so the
   Scene block is followed by one LOD0 resource block that is deliberately not
   read; the parse stops after the loaded-block count, which is exactly the
   probe's boundary.
2. **`ProcessLoadChunk` is compiled, not run.** It deserialises streamed
   `LodReader<ResourceBlock::Resources>` into GPU resources. Running it is the
   next renderer slice (§7 "next step").
3. **The streaming request worker is unsupported.** `StreamData::BeginTasks`
   aborts if reached; no view/frustum request has a wasm port.
4. **No textures are created and no chunk is decompressed.** The 10 shared
   texture blobs are consumed and discarded; chunk bytes are hashed as stored.
   `logicalBytes` is a field, not a decode.
5. **No browser/GPU, renderer, vehicle, audio or game claim.** The module runs
   under node. T-005b's OPFS/worker gap still applies.
6. **`C_OverlayFs` remains a single read-only layer.**

### 11.8 Evidence (P22)

| Path | Size | SHA-256 (16) | Content |
| --- | ---: | --- | --- |
| `engine/patches/t005b-stream-overlay.patch` | 58,286 | `9461EC7A9EEBCC08` | 14 web-only files |
| `engine/verify_stream.py` | — | `CCBE0537B3354416` | the gate |
| `engine/harness/t005e/stream_harness.cpp` | — | `1ABAC1ECC6CED198` | Scene parse + stream + cache |
| `engine/harness/t005e/engine_stream_prelude.h` | 4,095 | `EDB5BD48E9DEF0BD` | PERF_EVENT + fail-loud boundary |
| `engine/harness/t005e/display_fail_loud.cpp` | 4,739 | `7E199D699BBA3067` | renderer abort bodies |
| `engine/harness/t005e/scene_target_web.cpp` | 3,269 | `84EAB823C402D4FC` | Scene/Effect/allocator link shims |
| `engine/harness/t005e/web_scene_report.cpp` | 1,409 | `9EBAA3CF5F91F962` | counters |
| `engine/harness/t005e/stub/Display.h` | 6,954 | `DDBD1E9BA0EAB367` | data-only display types |
| `engine/harness/t005e/stub/fx/fx.h` | 1,708 | `3AD7A76AA6F51258` | data-only FX types |
| `_work/engine-stream-spike/out/stream_harness_a.wasm`* | 664,137 | `5DF210F16A0D8642` | module (54 objects) |
| `_work/engine-stream-spike/out/stream_harness_b.wasm`* | 664,137 | `5DF210F16A0D8642` | second build, identical |
| `_work/logs/engine-stream-spike/verify-summary.json`* | — | — | every number above |

`*` = regenerated by `engine/verify_stream.py`.

### 11.9 Commands and recorded verdict

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
& $py engine/verify_stream.py --fresh
& $py engine/verify_stream.py            # reuse the tree
& $py engine/verify_stream.py --skip-native
```

Recorded result (`--fresh`, exit 0, 118.3 s):

```text
patch           sha256=9461ec7a9eebcc08
files           14 modified, 0 added
objects         54
wasm            664137 B sha256=5df210f16a0d8642 deterministic=True
harness         30/30 checks pass
index           359 chunks, blocks=1227, initial=1
engine index    359 ChunkInfo records == range_probe + level_inspect
scene cursor    2464509 B (== probe parsedUntilOffset), tablehash=aae9814242df9d36
scene facts     16 decl / 10 shared textures, 10784 items, 603 prereqs, gpu=0, openstream hint=-1
stream          244682752 B, largest=2045952 B, chunks=359
chunk hashes    359/359 match independent Python
geometry        chunk 157 fnv=0x74dd025de4430925 sha256=b07b386c5da5b915
levelrender     9873988 B fnv=0x0ef5c027f0924307
levelphysics    1945409 B fnv=0xb9594f7ce52caa2e
pc parity       3 TUs preprocessed identical (streammanager 108025, streamdata 111514, archive 111399 lines)
verdict         PASS
```

A separate `tools/verify_asset_probe.py --skip-build` run at the same time
passed 22 steps and failed `level-instances-native-wasm` (`Complete native/WASM
instance JSON differs`). The cause is another session's uncommitted edits under
`probes/asset-reader/src/` (scene reader/CLI), which this task did not touch;
it is recorded here so the failure is not attributed to the engine patch.

### 11.10 Source authority (P22 additions)

Upstream BlurRebuilt `5270304b81983b9e3edbd569ba25235c17bbabd7`, unmodified:

- `graphics/renderingdata/source/noninterface/target/archive.cpp:302-349`
  (target `StreamData` and `Scene` deserialisers), `:622-690`
  (vertex element/declaration mapping), `:1014-1057` (`Texture`);
- `.../include/renderingdata/streamdata.h:26-90`,
  `noninterface/streamdata.inl:1-72`, `noninterface/archive.inl:952-1002`;
- `.../source/noninterface/target/streamdata.cpp:133-166,406-459,1007-1121`,
  `streamrequest.h:30-54`, `resources.cpp:15-236`;
- `.../source/noninterface/{archive,scene,node,renderstates,material,effect}.cpp`;
- `graphics/display/source/view/ViewFrustum.cpp:8-15` (constructor/destructor
  reproduced in `scene_target_web.cpp`);
- `common/system/source/memory/{BlockAllocator,VirtualMemory}.cpp` (wasm page
  branch added in VirtualMemory.cpp);
- `common/system/source/serialise/{C_FileBlock,C_MemoryStream}.cpp`;
- `common/misc_shared/source/misc_shared/archive/handler.cpp`.

`ProcessLoadChunk`'s first archive read is the chunk item count
(`streamdata.cpp:1034-1040`); that is the boundary between the compiled slice
and the renderer work that remains.
