# T-005e — level streaming through the engine on wasm32

**Date:** 5 November 2026 (P30/P27 sections added; P22/P18 sections below kept as history)
**Status:** bounded spike. P30 adds constant material rows, the 57 instance
`g_mWorld` matrices and a 312-record packet-v1.1-compatible draw list (§13).
P22 made the engine's own
`RenderingData::Target::Scene` archive parse `Level.levelrender` on wasm32 and
produce the 359 `ChunkInfo` records with no GPU object. **P27 adds the CPU-side
resource and render-list import and a deterministic draw list for
`usa_la_river`** (§12): resource blocks, vertex/index buffers, texture LODs and
`RenderListNode::Primitive` records are deserialised with the engine's own
archive code into data-only structures, and 95 direct draws of block 88 /
node 283 are emitted and compared with `probes/asset-reader`. No renderer, GPU,
vehicle or game claim is made.
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

## 12. P27 — the CPU-side draw list

This section supersedes §11.7 items 1 and 2 for the draw-list slice. It is a
data-extraction record: no renderer, GPU, vehicle or game claim is made.

### 12.1 What is imported now

`Target::Scene` (the level index from §11) is unchanged. On top of it the web
build now deserialises, with the engine's own archive code:

| Object | Engine path | Data-only result |
| --- | --- | --- |
| inline loaded block | `Target::Deserialise(ResourceBlock&)` (`WorldRender::ReadScene`'s loop) | LOD count, vertex/index buffers, nodes, textures; `m_resources` usable |
| streamed block item | `Target::Deserialise(LodReader<ResourceBlock::Resources>&)` | same, per `ChunkInfo` item |
| `IndexBuffer` / `VertexBuffer` | `Target::Deserialise(...)` | descriptor (`count`, `stride`/width, byte size, alignment, compression) plus the payload bytes when uncompressed |
| texture LOD | `Target::Deserialise(LodReader<Texture>&)` | name, hash, LOD, header size, payload size; no texture created (`m_discard = 1`) |
| vertex declaration | `Target::Deserialise(VertexDeclaration&)` | every element (`stream,offset,type,method,usage,usageIndex`) kept in order |
| render list | base `RenderListNode` serialiser + `Target::Deserialise(RenderListNode::Primitive&)` | primitives, instances, base primitives, bounds, source lists, chunk data |
| primitive | as above | `{effect, declaration, topology, indexBuffer, flags, base/instance material, blend descriptor, lods, primitive streams, archive offset}` |

Two rules are load-bearing:

1. **A descriptor is not a fallback.** `CreateIndexBuffer`, `CreateVertexBuffer`
   and `CreateVertexDeclaration` are never called. Their archive position is
   replaced by a record of what the call would have been asked for, and the
   blob is retained only when it is uncompressed. `gpuObjectsCreated` is 0 and
   the gate asserts it.
2. **A GPU object that would be required is still a fail-loud abort.** The
   render-state table (`FX::g_RenderStateMgr.InsertRenderState`) is not run; a
   primitive keeps its serialised blend descriptor and `blendState = -1`. Every
   renderer entry point in `display_fail_loud.cpp` still aborts. The legacy
   (`<v2`) `RenderListNode::Reallocate` relocation path is not ported and
   aborts by name (`Target::RenderListNode::Reallocate (legacy render list)`).

The buffer destructors in `target/resources.cpp` guard `DestroyIndexBuffer` /
`DestroyVertexBuffer` with `if (m_data.IsCreated())` on web, because nothing was
created; the PC statement is unchanged.

`Target::RenderListNode` has no out-of-line virtual in this build (the renderer
TU is not compiled), so clang emitted no vtable and the wasm link failed. The
patch declares its destructor on web only and defines it in `target/archive.cpp`
as the class key function. This is a link anchor; it adds no behaviour.

### 12.2 The draw list

`engine/harness/t005e/stream_harness.cpp` locates the chunks **from the engine's
own `ChunkInfo` table** (never from a probe table), loads them through
`StreamManager::LoadChunk`/`GetChunkData`, copies the bytes, and parses each item
with `WebSpike::ParseResourceBlockLodArchive` — the same
`LodReader<ResourceBlock::Resources>` deserialiser `ProcessLoadChunk` uses. It
then walks `Resources::nodes`, picks the node whose virtual `IsNode` reports
`NODE_TYPE_RENDER_LIST_PLATFORM`, and emits one line per primitive:

```text
webfiledraw draw 3 chunk=68 nodeIndex=1 primitive=3 source=3248 bound=1 reason=none
  declaration=6 topology=1 lod=0 lodCount=1 effect=0 vb=88:0 ib=88:0 vbSource=2 ibSource=1
  firstIndex=0 indexCount=582 triangles=194 lodOffset=977 lodIndices=510
  minIndex=454 nVertices=332 baseMaterial=0:0 instanceMaterial=1:0 flags=0x00000000
  blend=1,5,0,0,0,0,1 bounds=ok boundsMin=... boundsMax=...
  world=null worldReason=instanceTransformNotImported
```

- `source` is the archive byte offset of the primitive record's fields (the
  binary archive writes a 2-byte `AR` tag and a `U16` object version before
  them, so the record starts 4 bytes earlier).
- `vb`/`ib` are the resolved `(resource block, resource index)` identities.
- `vbSource`/`ibSource` are the indices into the node's own source lists.
- `firstIndex`/`indexCount` are the converted triangle-list span, computed from
  the retained index payload with the same strip parity and degenerate-triangle
  rule the committed reader uses.
- `world = null` with a reason: instance transforms live in runtime material
  rows (`g_mWorld`), which this slice does not import. No matrix is guessed.
  The serialised instance rows (`primitiveIndex`, material `index:list`, flags,
  stream count) and the archived primitive/instance bounds are printed.

### 12.3 Measured result (`verify_stream.py --fresh`, exit 0)

| Check | Result |
| --- | --- |
| patch | 16 files modified, 0 added, sha256 `fd4de55b0a69d55ddca1f5ec8765021e9b663faa8107f84ef079ce2a2f881b3f` |
| build | 55 TUs, wasm **794,845 B**, sha256 `67c4feed29a86efb...`, two builds identical |
| harness | **46/46** checks, two runs identical |
| inline loaded block | 1 block, LOD 9, 0 vertex buffers, 0 index buffers, 1 node, 0 textures |
| geometry chunk | block 88 -> chunk 136, offset 54,616,064 / 589,824 B; 5 VBs, 1 IB, 0 nodes; 587,228 B retained, 0 compressed |
| node chunk | block 283 -> chunk 68, offset 3,737,600 / 104,448 B; 1 render list at node 1: 255 primitives, 0 instances, 0 base primitives |
| draw list | **95 bound draws, 160 other-block primitives, 0 unbound, 0 index errors** |
| ranges | **9,343 triangles, 17,782 vertices**, draw-list hash `fd525c1452869aee` |
| reference (draws) | 95/95 `firstIndex`+`indexCount` spans equal to `level_inspect 88 283`; its metadata `primitiveCount 95`, `omittedOtherBlockPrimitives 160`, `triangleCount 9,343`, `vertexCount 17,782` |
| reference (instances) | block 27 / node 253 -> chunk 53: node 1 has **57 instances**, 36 base primitives, 5 primitives; `level_inspect --instances-all` reports the same `instanceCount 57` / `basePrimitiveCount 36` |
| GPU | 0 objects created, 0 refused calls, 0 unsupported paths |
| PC parity | `streammanager.cpp` 108,025, `streamdata.cpp` 111,514, `archive.cpp` 111,399, `resources.cpp` 108,104 preprocessed lines identical with/without the patch |

The 160 other-block primitives are the reference's own
`omittedOtherBlockPrimitives`: they bind geometry blocks this slice did not
import. Their descriptors, spans and bounds are still printed, with
`vb`/`ib` set and `reason=geometryBlockNotImported`; they are counted, not
silently dropped and not drawn.

### 12.4 Determinism

Two independent wasm builds are byte-identical (`deterministic=True`), and the
two harness runs produce identical stdout, which contains every draw record.
The draw-list hash is recomputed in-process from the printed numeric fields; it
is `fd525c1452869aee` on both runs and on a fourth, fresh-tree run.

### 12.5 Explicit failures (new in P27)

| Case | Result |
| --- | --- |
| buffer blob descriptor differs from its declared size | `Unsupported` with record kind, count, stride, expected/declared bytes and archive offset |
| blob alignment not a power of two <= 4096, or blob object marker/version wrong | `Unsupported` |
| compressed buffer | payload dropped, `compression != 0`, `compressedBuffers` counted; the gate requires 0 for the draw-list chunks |
| record arrays over bound (buffers/declarations/primitives/LODs/streams) | counter incremented and `Unsupported`; the gate requires all zero |
| legacy (`<v2`) render list | `Target::RenderListNode::Reallocate` aborts by name |
| index outside `minIndex..minIndex+nVertices-1` or beyond the buffer | `reason=indexOutsidePrimitiveRange`, counted in `indexerrors`; gate requires 0 |
| missing POSITION0 declaration/stream, unknown topology, unaligned stream offset | named `reason` token on that draw |

### 12.6 Remaining blockers (all renderer/packet work)

1. **Instance transforms and materials are not imported.** `g_mWorld` lives in
   the constant material rows; the draw list prints `world:null` with a reason.
   That is the next packet field (v1.1: `world` + `materialId`).
2. **Textures are described, never created.** Texture LOD names/hashes/sizes are
   consumed and recorded; no texture data is decoded and no sampler state is
   created.
3. **`StreamData::ProcessLoadChunk` is still not run.** The harness calls the
   same deserialiser, but the chunk state machine (prerequisite refresh,
   pending swap-in, unload) is not driven. `CacheChunk` is exercised only for
   chunks 0 and the first prerequisite-bearing chunk (§11.4).
4. **Only two block pairs are imported** (88/283 for draws, 27/253 for the
   instance count). The level has 1,227 resource blocks; a full scene would
   need visibility/culling, which is not implemented.
5. **No visibility, culling, LOD selection, sorting or batching.** The list is
   archive order with LOD0 only.
6. **No renderer, GPU, audio, vehicle, browser or game claim.** The module runs
   under node; no browser OPFS/worker work is included.
7. `C_OverlayFs` remains a single read-only layer.

### 12.7 Next step toward packet v1.1

The packet seam (`docs/work/analysis/e1-renderer-strategy.md`) needs
`world: [16]` and `materialId`. The cheapest next slice reads the render list's
constant material rows through the already-compiled
`Deserialise(MaterialListData)` path, follows `type8` nested references, and
exposes `g_mWorld` per instance and the `g_tAlbedo`/`g_MeshTexture` texture
index per primitive. That keeps the same rule as this slice: a value is either
read from the archive or reported as `null` with a reason. It must not be
described as rendering.

### 12.8 Evidence (P27)

| Path | Size | SHA-256 (16) | Content |
| --- | ---: | --- | --- |
| `engine/patches/t005b-stream-overlay.patch` | 77,217 | `FD4DE55B0A69D55D` | 16 web-only files |
| `engine/verify_stream.py` | 64,804 | `08587B17E9ECEC1A` | the gate |
| `engine/harness/t005e/stream_harness.cpp` | 50,574 | `54227404E78014F4` | stream + scene + draw list |
| `engine/harness/t005e/web_drawlist.cpp` | 3,383 | `854C25917D446110` | record storage |
| `engine/harness/t005e/engine_stream_prelude.h` | 8,555 | `E4595AEC87065B87` | record types + counters |
| `engine/harness/t005e/scene_target_web.cpp` | 3,691 | `D1872A4A3A1A7473` | renderer-TU link shims |
| `_work/engine-stream-spike/out/stream_harness_a.wasm`* | 794,845 | `67C4FEED29A86EFB` | 55 objects |
| `_work/logs/engine-stream-spike/verify-summary.json`* | — | — | every number above |
| `_work/logs/engine-stream-spike/reference-mesh-88-283.json`* | — | — | committed-reader direct draws |
| `_work/logs/engine-stream-spike/reference-instances-27-253.json`* | — | — | committed-reader instance counts |

`*` = regenerated by `engine/verify_stream.py`.

### 12.9 Commands

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
& $py engine/verify_stream.py --fresh
& $py engine/verify_stream.py
& $py engine/verify_stream.py --skip-native
```

Recorded result (`--fresh`, exit 0, 119.5 s):

```text
patch           sha256=fd4de55b0a69d55d
files           16 modified, 0 added
objects         55
wasm            794845 B sha256=67c4feed29a86efb deterministic=True
harness         46/46 checks pass
index           359 chunks, blocks=1227, initial=1
engine index    359 ChunkInfo records == range_probe + level_inspect
scene cursor    2464509 B (== probe parsedUntilOffset), tablehash=aae9814242df9d36
scene facts     16 decl / 10 shared textures, 10784 items, 603 prereqs, gpu=0, openstream hint=-1
stream          244682752 B, largest=2045952 B, chunks=359
chunk hashes    359/359 match independent Python
geometry        chunk 157 fnv=0x74dd025de4430925 sha256=b07b386c5da5b915
draw list       95 bound / 160 other-block, 9343 triangles, 17782 vertices, hash=fd525c1452869aee
draw compare    95 firstIndex/indexCount spans equal to level_inspect 88/283; instances=57, baseprimitives=36
levelrender     9873988 B fnv=0x0ef5c027f0924307
levelphysics    1945409 B fnv=0xb9594f7ce52caa2e
pc parity       4 TUs preprocessed identical (streammanager.cpp:108025, streamdata.cpp:111514, archive.cpp:111399, resources.cpp:108104 lines)
verdict         PASS
```

## 13. P30 — constant materials, instance transforms and packet draw list

This section supersedes §12.6 items 1 and 2 and §12.7 for the packet seam.
It is still a data-extraction record: no renderer, GPU, vehicle or game claim
is made. The new public functions read values back from structures the P27
archive walk already produced; nothing in this slice re-parses an archive
independently.

### 13.1 Constant material rows (read back, not reinterpreted)

`RenderingData::Target::RenderListNode` already exposes
`GetConstantMaterialListData()` and `GetConstantMaterialTypes()`, and the base
`Deserialise(RenderListNode)` already calls `DeserialiseMaterialData` for the
`ConstantMaterialTypes` / constant rows (§197-230 of the upstream
`target/archive.cpp`, unchanged by the patch). P30 reads those rows back in the
harness:

- `g_mWorld` is accepted only as `MATERIAL_ELEMENT_TYPE_F32` with `count == 16`,
  finite, and affine (`m[3] == m[7] == m[11] == 0`, `m[15] == 1`). The row that
  supplied it is reported.
- `g_tAlbedo` / `g_MeshTexture` are accepted only as
  `MATERIAL_ELEMENT_TYPE_TEXTURE_INDEX` with `count >= 1`; the serialised value
  is emitted as the original row plus texture index, and the render list's
  `GetTextureSource(index)` is emitted as `block:index` when in range.
- `MATERIAL_ELEMENT_TYPE_MATERIAL_INDEX` (serialised element type 8) children
  are followed recursively with a 32-deep cycle guard, in the same order the
  committed source-shaped reader uses (`instance.material`, instance streams,
  primitive/base material, primitive streams). `DATA_INDEX` / `TEXTURE_PTR`
  values are runtime-only: the field is reported null with
  `runtimeOnlyAlbedoParameter`, never read as a static value.
- No material is created, copied or written. No blend state is created.

The only engine-side record added is `PrimitiveRecord::blendEnable`, filled from
the serialised `BlendState::AlphaBlendEnable`. It is used only to label the
packet's `layer` as `opaque`/`alpha`; the raw serialised blend tuple is still
printed and remains the authoritative value.

### 13.2 Instance transforms (block 27 / node 253)

For the 57 instances of block 27 / node 253 the harness resolves the instance's
base primitive from the P27 primitive-record stream (base primitives are the
records after the list's own primitives), resolves the position stream from the
instance streams overridden by the base-primitive streams, and applies the
resolved `g_mWorld` to the packet record. The geometry block 27 item is imported
with the same `LodReader<ResourceBlock::Resources>` deserialiser; it is the
seventh item of chunk 88, so only that item's buffers (2 VBs / 1 IB) are
snapshotted and addressed with the reference's 0-based source indices.

Direct primitives of block 88 / node 283 have no instance placement. Their
packet records keep `world: null` with `worldReason=noInstanceTransform`; an
identity matrix is never substituted.

### 13.3 Packet-v1.1-compatible draw list

The harness emits one `webfiledraw packet` record per direct primitive (255,
including the 160 other-block primitives) and per instance (57), in that order:

```text
mesh, vb=block:index, ib=block:index,
vtxOffset, vtxCount, idxOffset, idxCount,
world (16 floats or null) + worldRow + worldReason,
materialId ("g_tAlbedo:row:texIndex" or null) + materialRow + albedoIndex +
  albedo=block:index + materialReason,
bounds min/max,
layer, instance, primitive, source archive offset, drawable, reason
```

The packet hash is FNV-1a 64 over every printed field in a fixed order. It is
recomputed independently in Python from the printed lines by
`engine/verify_stream.py`.

### 13.4 Measured result (`verify_stream.py --fresh`, exit 0, 121.8 s)

| Check | Result |
| --- | --- |
| patch | 16 modified, 0 added, 77,284 B, sha256 `5fa2b1b743c388030d1a0bc8b73fe951acfea92406a29cf7b71b2dbb75019b71` |
| build | 56 TUs, wasm **814,345 B**, sha256 `552e3407552f4356bbc6d2114a44aaa2674a99000a70c73b8cd88dd83415675b`, two builds identical |
| harness | **65/65** checks, two runs identical |
| constant rows | node 283: 187 rows / 18 types (1 world row, 103 albedo rows); node 253: 56 rows / 8 types (37 world rows, 18 albedo rows) |
| constant rows total | **243 rows / 26 types**, 121 albedo rows, 38 world rows, **0 type-8 rows** (River has no nested `MATERIAL_INDEX` element; the resolver implements the rule, the data does not exercise it) |
| direct draws | 95 bound / 160 other-block; 9,343 triangles; 17,782 vertices; P27 hash `fd525c1452869aee` (unchanged) |
| instance draws | 57 instances / 36 base primitives; **22 drawable / 35 other-block**; **10,308 triangles / 13,162 vertices** |
| world matrices | **57/57** constant affine `g_mWorld`, 0 invalid; **22/22** compared with `level_inspect --instances-all` at 1e-5; 22/22 archived instance bounds at 1e-5 |
| VB/IB bindings | **57/57** equal to the committed reader's `instanceSources` |
| Stage A+B rows | **57/57** transform rows equal to `_work/level-instances/stageB-python-reference.json` |
| packet draw list | **312 records** (255 direct + 57 instance), **117 drawable**, 195 omitted (160 direct + 35 instance), hash `4603a94e0871461c` |
| materials on draws | 255/255 direct and 57/57 instance records carry a static `g_tAlbedo` id; 0 null |
| direct transforms | 255/255 direct records `world=null reason=noInstanceTransform` |
| GPU | 0 objects created, 0 refused calls, 0 unsupported paths |
| PC parity | `streammanager.cpp` 108,025, `streamdata.cpp` 111,514, `archive.cpp` 111,399, `resources.cpp` 108,104 preprocessed lines identical with/without the patch |

The 56-stage grouping (`stageAB`: 56 instances, 34,632 vertices, 25,521
triangles) is a bounds-group construct from the committed bundle reference. Its
per-instance transform rows are compared (57/57); its geometry totals are not
reproduced because blocks 15, 17, 26 and 32 are not imported by this slice. The
22 in-scope instance matrices are the direct comparison against
`level_inspect --instances-all`, the same reader that produced the P27 direct
draws. The direct-draw reference does not expose material values, so `materialId`
has no independent reference; it is a serialised `TEXTURE_INDEX` read with the
original row and index, and the gate covers its determinism and non-null count,
not a visual result.

### 13.5 Determinism and PC parity

- Two independent wasm builds are byte-identical; the two harness runs print
  identical stdout, including all 312 packet records.
- The packet hash is recomputed in Python from the printed records and compared
  to the in-module hash on every run.
- PC preprocessing of the four modified engine TUs is identical with and
  without the patch (same normalisation as §11.5).
- One TU was added to the link closure: `renderingdata/source/noninterface/
  materialsizes.cpp` (the `materialDataTypeSizes`/`Alignment` arrays referenced
  by the inline `MaterialType::GetOffset`). It is unmodified upstream source and
  emits no web-specific code.

### 13.6 Remaining blockers (unchanged in kind, narrower in scope)

1. **Textures are indices, not images.** The packet carries the constant
   `g_tAlbedo`/`g_MeshTexture` texture index and the render-list texture source
   `block:index`; no texture is decoded, created or sampled.
2. **`StreamData::ProcessLoadChunk` is still not driven.** The harness calls the
   same `LodReader<ResourceBlock::Resources>` deserialiser, but the chunk state
   machine (prerequisite refresh, pending swap-in, unload) is not run.
3. **No visibility, culling, LOD selection, sorting or batching.** The list is
   archive order, LOD0 only, and only two node/geometry pairs are imported
   (88/283 and 27/253). The 56-stage geometry needs blocks 15, 17, 26 and 32.
4. **Runtime-only material values are not imported.** `DATA_INDEX` and
   `TEXTURE_PTR` elements would be reported null with a reason; River's two
   lists contain none, so the `type8`/runtime reason paths are implemented but
   not exercised by this level.
5. **No blend state is created.** `layer` is a label derived from the serialised
   `AlphaBlendEnable`; the raw descriptor remains the packet's authoritative
   blend data.
6. **No renderer, GPU, audio, vehicle, browser or game claim.** The module runs
   under node; `C_OverlayFs` remains a single read-only layer.

### 13.7 Evidence (P30)

| Path | Size | SHA-256 |
| --- | ---: | --- |
| `engine/patches/t005b-stream-overlay.patch` | 77,284 | `5fa2b1b743c388030d1a0bc8b73fe951acfea92406a29cf7b71b2dbb75019b71` |
| `engine/verify_stream.py` | 80,342 | `5ae830872f033710cb0e11b86519dbef3a54f93a9c75622e61a55ae2f395034e` |
| `engine/harness/t005e/stream_harness.cpp` | 89,142 | `32a442e48d799dc794fcb02f77bd57641039117c4a8222b716dfae39fd6db8fb` |
| `engine/harness/t005e/engine_stream_prelude.h` | 8,624 | `d5fd42dcb660bad106a558892aaca481d05e750326ec702cd0d3fe9f48305853` |
| `_work/engine-stream-spike/out/stream_harness_a.wasm`* | 814,345 | `552e3407552f4356bbc6d2114a44aaa2674a99000a70c73b8cd88dd83415675b` |
| `_work/engine-stream-spike/out/stream_harness_b.wasm`* | 814,345 | `552e3407552f4356bbc6d2114a44aaa2674a99000a70c73b8cd88dd83415675b` |
| `_work/logs/engine-stream-spike/verify-summary.json`* | — | — |
| `_work/logs/engine-stream-spike/reference-instances-27-253.json`* | — | — |
| `_work/logs/engine-stream-spike/p30-verify-fresh-final.log` | — | — |

`*` = regenerated by `engine/verify_stream.py`. The full hash table and all
per-record values are in `verify-summary.json`; the separate verification
record is `docs/work/verification/T-007-drawlist-v2.md`.

### 13.8 Commands

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
& $py engine/verify_stream.py --fresh
& $py engine/verify_stream.py            # reuse the tree
& $py engine/verify_stream.py --skip-native
& $py tools/verify_asset_probe.py --skip-build
```

Recorded result (`--fresh`, exit 0, 121.8 s):

```text
patch           sha256=5fa2b1b743c38803
files           16 modified, 0 added
objects         56
wasm            814345 B sha256=552e3407552f4356 deterministic=True
harness         65/65 checks pass
draw list       95 bound / 160 other-block, 9343 triangles, 17782 vertices, hash=fd525c1452869aee
packet          312 records (255 direct / 57 instance), drawable=117, omitted=195, hash=4603a94e0871461c
materials       243 constant rows / 26 types, albedoRows=121, worldRows=38, type8Rows=0
transforms      57 instance world matrices (0 invalid), 22 equal to level_inspect at 1e-5; 57 VB/IB bindings equal
stage A+B       57 transform rows equal to _work/level-instances/stageB-python-reference.json
pc parity       4 TUs preprocessed identical (streammanager.cpp:108025, streamdata.cpp:111514, archive.cpp:111399, resources.cpp:108104 lines)
verdict         PASS
```
