# engine/ — web scheduler and file-layer overlays

Two reproducible, reviewable patches plus the tools that materialise and check
them:

- `patches/t005c-web-scheduler.patch` makes the engine's scheduler compile and run
  on `wasm32-unknown-emscripten` with **one execution context**;
- `patches/t005b-file-overlay.patch` adds the `platform/file` C ABI and
  `Sys::C_WebFile`/`C_WebFileSystem` over `I_File`/`I_FileSystem`, and is applied
  second.

Applied to a fresh `upstream/BlurRebuilt`, the pair builds one wasm32 module that
reads the real installed `cache/root.pak` **through the engine's own PAK reader**
(`Pak::ReadPak`, `C_PakIoMediator`, `C_PakEntryFile`, packet-zlib) on top of the
new file layer. Nothing here is a game, a renderer or a browser: it is the
smallest overlay that lets the engine's file and PAK layers run under node.

Provenance:

| | |
| --- | --- |
| upstream reference | `upstream/BlurRebuilt` at commit `5270304b81983b9e3edbd569ba25235c17bbabd7` |
| scheduler patch | `engine/patches/t005c-web-scheduler.patch` (20 files, 691 insertions, 35 deletions) |
| scheduler SHA-256 | `B939B39C7F7598B19677F29286655DE554762CB3CBD1471833D17C873C3FDEF2` |
| file-layer patch | `engine/patches/t005b-file-overlay.patch` (4 files added, 3 small fixes) |
| toolchain | Emscripten 6.0.13 (clang 24.0.0git), pinned under `_work/toolchains/emsdk` |
| evidence | `docs/work/analysis/engine-web-shims.md` (scheduler), `docs/work/analysis/engine-file-layer.md` (file layer + PAK consumer) |

`upstream/` is never written to: the tools copy the files the patch touches into
a caller-supplied tree and patch the copies. `apply_overlay.py` and
`apply_file_overlay.py` refuse to run if `upstream/BlurRebuilt` is dirty, and
refuse any tree inside `upstream/`.

## Commands

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

# 1. materialise the overlay into a tree (fails if upstream is dirty)
& $py engine/apply_overlay.py --tree _work/engine-overlay-check

# 2. verify: apply to a fresh copy of upstream, rebuild the scheduler module,
#    run the A3/A4 cases + the fail-loud cases + the real engine caller
& $py engine/verify_overlay.py --fresh

# 3. native PC parity: the PC translation unit must not change, and the whole
#    closure (29 TUs) must still compile with MSVC
& $py engine/native_parity.py

# 4. regenerate the patch after changing the overlay (spike side)
& $py engine/make_patch.py          # --check to verify it is current
```

`apply_overlay.py` prints the tree, the upstream commit, the patch hash and a
manifest hash of the patched result, and writes `<tree>/.overlay/manifest.json`.
`git apply -p1 --check` also accepts the patch.

## What the overlay changes

Five groups, all under `code/mercury/library/common/`:

1. **Platform identity** — `PLATFORM_WEB` / `TL_PLAT_WEB`:
   `mercury_to_tl.h`, `tl_defs.h`, `tl_thread.h` (web body behind
   `tl_thread_web.h`), `jobqueue.h` (`jobqueue_web.h` selection).
2. **Scheduler backend** — new `system/source/scheduler/jobqueue_web.cpp`, the
   web sibling of `jobqueue_xenon.cpp` + `jobqueue_kernel_xenon.cpp`:
   `jqMaxWorkers = 0`, no worker contexts, `Flush` drains on the caller and
   ignores `bRunJobs`, fence dependencies abort.
3. **Policy flattening** — `jobqueue.cpp` `CreatePolicy`, **inside
   `#if defined(PLATFORM_WEB)` only**: the maximum of the 8 columns is replicated
   so a column-0 policy such as `piStreamer {0,0,7,7,7,7,7,7}` is not disabled
   by `GenerateWorkerPolicyOrder`; an all-zero policy aborts instead of being
   silently dropped.
4. **Platform primitives the engine never had for a non-PC/PS3 target** —
   `Atomic.h` (17 functions gain `__atomic_*` web branches; without them the
   non-void bodies fell off the end, which clang lowers to a wasm trap),
   `Core.h` (`snPause()` → `__builtin_trap()`), `Event.cpp`/`Mutex.cpp` (dead
   POSIX branches made real, still web-only), `Event.h` (`Mutex` forward
   declaration), `MathsUtil.h` (`Clamp` guard).
5. **Compiler-compatibility grammar fixes** shared with any non-MSVC build —
   `Vector.h`/`Vector.inl` (cv-qualified conversion operators),
   `sortedbinarytree.h`/`map.h`/`.inl` (missing `typename`, dependent-base
   qualification), `LogManager.cpp` (subscriber retention list: console only on
   web; the function registers nothing, so logging behaviour is unchanged).

## What it explicitly does not do

- **No renderer.** DX11/FX11 is untouched: `graphics/display*`, `fx`,
  `render`, `D3D11*` are not in the patch and cannot link.
- **No networking.** `system/source/network/*` is untouched; the only network
  symbol the scheduler closure needs, `Network::GetHostName()`, is answered by a
  harness shim (`engine/harness/t005c/platform_net_web.cpp`), not by this patch.
- **No Xenon kernel port.** `jobqueue_xenon.cpp` / `jobqueue_kernel_xenon.cpp`
  are neither modified nor compiled for web; `jobqueue_web.cpp` replaces them.
- **No threading.** The build is single-context: no `-pthread`, no
  `SharedArrayBuffer`, no workers. `tlCreateThread` returns an invalid handle and
  counts the refusal; `tlWaitForThread`, `tlExitEvent` and `MT::Event::Wait`
  abort through a fail-loud hook rather than block or fake success.
- **No new engine behaviour.** Every added block is `#if defined(PLATFORM_WEB)`
  or a new file selected by `TL_PLAT_WEB`.

## PC-path guarantee (measured, not asserted)

`PLATFORM_WEB` is undefined in the PC build, so every added block preprocesses
away. `engine/native_parity.py` proves it:

- `jobqueue.cpp` is preprocessed with MSVC in the PC configuration
  (`PLATFORM_PC`, `WIN32`, `_WINDOWS`) from upstream and from the overlay tree.
  After stripping line markers, the two 151,971-line translation units differ
  **only** in the `__LINE__` constant of two `LOGFATAL`/`LOGERROR` call sites
  (555→589), because the web block shifts the lines below `CreatePolicy`. No
  statement differs.
- The whole scheduler + logging closure, including the probe source, compiles
  natively: 29/29 TUs.

The native *runtime* A3/A4 probe cannot be linked from this checkout — not
because of the overlay, but because the PC `LogManager` retention list pulls the
file/socket/SMTP subscribers (`Sys::C_FileSystem` → `AsyncFile` → `ArteryMutex`,
`Network::TCPSocket`/`SMTPClient`), and `system/source/io/IoStream.cpp` does not
compile in this tree. See `docs/work/analysis/engine-web-shims.md` §7.3.

## What the covered probe proves (T-005c A2, A3, A4)

`verify_overlay.py` builds the scheduler from the applied tree and runs it under
node:

```text
A4 workers=0 max_workers=0                     single execution context
A4 flush_false ran=1 poll=1                    bRunJobs is the documented deviation
A2 phase1 seq=A a_ran=1 b_ran=0 a_queue=0 b_queue=1
A2 phase2 seq=AB b_ran=1 b_queue=0
A2 phase3 only_flush_D seq=ABCD c_ran=1 d_ran=1
A2 verdict=ok
A3 total=4/4                                   every game policy, incl. the streamer
```

- **A2 (group dependency).** Group B depends on A, and **B's task is enqueued
  first**, so a drain that ignored the group filter would run B early and a drain
  that ignored the dependency would strand A behind B. The observed *task order*
  (`seq`), recorded inside the job bodies, is `A` and only `A` after `Flush(A)`
  (B still queued), then `AB`. The second pair proves `Flush(D)` resolves its own
  dependency: only D is flushed, yet `C` runs before `D` (`seq=ABCD`).
- **A3 (policies).** One task per shipped policy, including
  `piStreamer = {0,0,7,7,7,7,7,7}`; each runs exactly once.
- **A4 (serial layout).** `GetNumWorkers() == 0`, `jqGetMaxWorkers() == 0`,
  `Flush(group,false)` still runs the task, and the queue layout
  (`jqAtomicQueuePtr`, `Task::ParamData`, `sizeof(Task)`) is asserted in-process.

What A2 does **not** prove: it exercises group→group dependencies only. The two
fence forms (`JQ_GROUP_SPURWLOCK`, `JQ_GROUP_LABEL`) have no producer in a single
context and are **refused**, not simulated — `Flush` aborts with the API name and
the reason (one of the four fail-loud cases). No test asserts that a fence would
eventually be satisfied, because nothing can satisfy it here.

## T-005b file layer (`t005b-file-overlay.patch`)

A second, additive patch layers a web file system on top of the scheduler
overlay. It adds **four files** and carries **three small platform/grammar
fixes** in existing files (no behaviour change on PC — see "PC-path guarantee"
above and §7 of the analysis doc):

- `PlatformFileWeb.h` — the narrow `pf_*` C ABI (`open/size/read_at/write_at/
  close/exists` plus an async enqueue that refuses).
- `C_WebFile.h/.cpp` — `Sys::C_WebFile` over `I_File` and
  `Sys::C_WebFileSystem` over `I_FileSystem`, with a C++-side mount table.
  Selection is the existing `Sys::SetDefaultFileSystem()` seam; no game code is
  touched.
- `C_WebDirectoryInfo.cpp` — `C_DirectoryInfo`'s members for web, so an
  `I_FileSystem` whose `DirectoryInfo` fills a `C_DirectoryInfo` (`C_PakFs`) can
  link without `C_FileSystem.cpp`/`AsyncFile`.
- `core/threads/misc.h` — `MT::GetThreadId()` gains a `PLATFORM_WEB` branch.
  Without it the function falls off the end (no PC/PS3/SPU branch is taken) and
  clang lowers that to a wasm `unreachable` trap; `Pak::C_AtomicJobList` uses
  `MT::AtomicLock`, which compares thread ids.
- `System/Misc/Security.h` — `= NULL` → `= 0` (a pure-specifier must be the
  literal zero; MSVC accepts `NULL`, clang does not).
- `system/source/serialise/C_FileSystem.cpp` — the `C_DirectoryInfo` member block
  is wrapped in `#if !defined(PLATFORM_WEB)`, so exactly one definition exists per
  configuration (PC/PS3 here, the new web TU there).

```powershell
& $py engine/apply_file_overlay.py --tree _work/engine-file-spike/tree   # scheduler, then file
& $py engine/verify_file_overlay.py --fresh
```

`verify_file_overlay.py` (≈115 s) rebuilds twice and runs the node harness:
**PASS**, 61 objects, 530,493 B wasm, deterministic, **50/50 checks**, 7 explicit
refusals. Through the engine layer it reads the real `cache/root.pak`
(559,652,864 B):

- PAK header + all **3,601** entries field-identical to `probes/range-file`;
- **3,609** source requests / **314,522** B, largest 65,536,
  `fullFileBytesCopied=0`;
- whole-file FNV-1a 64 `2f291abb5648e078` on both `Underflow` paths, equal to an
  independent Python hash;
- EOF-crossing, past-EOF, zero-length, oversized, write, enqueue, unmounted,
  write-handle, async-only and directory cases all refused explicitly.

### The engine consumers: `C_PakFs`, then `C_OverlayFs` over it

The same harness then uses the engine's PAK file system and, above it, the
engine's overlay file system — the same two layers the game mounts through
`GameHelpers::MountPakLayer`:

```cpp
LogicalFs::C_PakFs pakFs;
pakFs.OpenPak( Sys::GetDefaultFileSystem(), Sys::C_FilePath( "/cache/root.pak" ),
               NULL, Sys::C_OpenParams( 32 * 1024 ) );      // -> Pak::ReadPak

LogicalFs::C_OverlayFs overlay;                             // the game's m_pFileSystem
overlay.SetWorkingDirectory( "/" );
LogicalFs::C_OverlayLayer::C_Params params;                 // GameHelpers defaults
params.flags.layerType = LogicalFs::C_OverlayLayer::E_Type_Newer;
params.flags.writable = 0;
overlay.AddLayer( Sys::C_FilePath( "/" ), &pakFs, Sys::C_FilePath( "/" ),
                  params, LogicalFs::E_MediaLayer_0, "cache/root.pak" );

Sys::I_File* f = overlay.Open( Sys::C_FilePath( path ), Sys::E_FileAccess_Read,
                               Sys::C_OpenParams( 0 /* streamer */ ) );
```

`C_PakFs::Open` → `C_PakEntryFile` → `Pak::C_PakCompressPacketZLib` (codec 4) on
the T-005c scheduler; `C_OverlayFs::Open` resolves the path through its layer
stack and hands it to `C_PakFs`. Both wrappers, plus `FileExists`, `FileInfo` and
`DirectoryInfo`, are exercised:

| through the engine | result |
| --- | --- |
| header / 3,601 FAT records | equal to the reference field by field |
| `C_PakFs::Open` and `C_OverlayFs::Open`, unbuffered and buffered | FNV-1a 64 `7a5224df7820ffae` (209 B) and `583354161ab2a52c` (131,200 B), both equal to an independent decoder |
| `FileExists` / `FileInfo` for both entries, both layers | true; size 209 and 131,200, `E_FileType_File` |
| `DirectoryInfo("\models\objects\shared\construction")` | `C_PakFs`: 35 children in FAT order (FNV `d2d61563f2fc557e`); `C_OverlayFs`: the same 35 as a multiset (it deduplicates through a hash set, so the order differs by design) |

Build note: `OverlayFs.cpp` is compiled with `-DGLOBAL_DEBUG_MESSAGE_LEVEL=0`
(one TU, diagnostics only). Its `LOG*` calls otherwise need `LogicalFs::g_log`,
whose engine definition calls `Debug::GetLogger` at static-initialisation time and
traps (`unreachable`) under wasm-ld — an initialisation-order hazard, not a data
path. See §8 of the analysis doc.

PC parity: `C_FileSystem.cpp`, `C_File.cpp` and `Pak.cpp` preprocess identically
with the patch and without it (added files removed, modified files restored from
upstream); the new TU compiles at `/W4` with no PC symbol emitted.

Limits: no browser OPFS/worker/COOP-COEP test yet; `pf_open` takes a source id,
not a path (the path→source table is C++-side by design); PAK signature
verification is still a no-op on web, so `pSecurity` is NULL; the writable
`LOGFS_INIT("./user/logfs")` layer and `GameHelpers`' mount table are not
exercised; no level, streamer or serialiser sits on top yet. Evidence:
`docs/work/analysis/engine-file-layer.md`.

## Layout

```
engine/
  patches/t005c-web-scheduler.patch   scheduler overlay, unified diff vs upstream/BlurRebuilt
  patches/t005b-file-overlay.patch    file layer + PAK consumer, applied after the scheduler
  apply_overlay.py                    copy + patch a caller-supplied tree (stdlib only)
  apply_file_overlay.py               scheduler + file patch in one tree
  verify_overlay.py                   fresh-tree rebuild, A2/A3/A4, fail-loud, engine caller
  verify_file_overlay.py              fresh-tree rebuild, PAK index + entry bytes + PC parity
  native_parity.py                    MSVC TU-equality check + native compile
  make_patch.py                       regenerate the scheduler patch from the spike overlay
  harness/t005c/                      scheduler probe + platform shims (committed source)
  harness/t005b/                      file-layer + PAK-consumer harness (C++, JS glue,
                                      msvc_crt_web.h build prelude)
  README.md                           this file
```

The harness sources are committed here so both verifiers run from a clean
checkout. Build outputs and trees stay under `_work/`. `verify_file_overlay.py`
additionally needs `_work/range-file-probe/build/range_probe.exe`; if it is
missing it stops with `Blocked` and the build hint instead of skipping the index
comparison.
