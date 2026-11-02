# engine/ — T-005c web scheduler overlay

A reproducible, reviewable patch that makes the engine's scheduler compile and
run on `wasm32-unknown-emscripten` with **one execution context**, plus the tools
that materialise it and check it. Nothing here is a game or a renderer: it is
the smallest overlay that lets `Scheduler::AddTask` / `Flush` execute a real
engine job under node.

Provenance:

| | |
| --- | --- |
| upstream reference | `upstream/BlurRebuilt` at commit `5270304b81983b9e3edbd569ba25235c17bbabd7` |
| patch | `engine/patches/t005c-web-scheduler.patch` (20 files, 691 insertions, 35 deletions) |
| patch SHA-256 | `B939B39C7F7598B19677F29286655DE554762CB3CBD1471833D17C873C3FDEF2` |
| toolchain | Emscripten 6.0.13 (clang 24.0.0git), pinned under `_work/toolchains/emsdk` |
| evidence | `docs/work/analysis/engine-web-shims.md` (all measurements) |
| spike harness | `_work/engine-web-spike/` (scratch, not in the repo) |

`upstream/` is never written to: the tools copy the files the patch touches into
a caller-supplied tree and patch the copies. `apply_overlay.py` refuses to run if
`upstream/BlurRebuilt` is dirty.

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
overlay. It adds **three files and modifies none** (`+777/−0`), all inside
`#if defined(PLATFORM_WEB)`:

- `PlatformFileWeb.h` — the narrow `pf_*` C ABI (`open/size/read_at/close` plus
  an async enqueue).
- `C_WebFile.h/.cpp` — `Sys::C_WebFile` over `I_File` and
  `Sys::C_WebFileSystem` over `I_FileSystem`, with a C++-side mount table.
  Selection is the existing `Sys::SetDefaultFileSystem()` seam; no game code is
  touched.

```powershell
& $py engine/apply_file_overlay.py --tree _work/engine-file-spike/tree   # scheduler, then file
& $py engine/verify_file_overlay.py --fresh
```

`verify_file_overlay.py` (≈80 s) rebuilds twice and runs the node harness:
**PASS**, 21 objects, 373,202 B wasm, deterministic, 32/32 checks, 7 explicit
refusals. Through the engine layer it reads the real `cache/root.pak`
(559,652,864 B):

- PAK header + all **3,601** entries field-identical to `probes/range-file`;
- **3,609** source requests / **314,522** B, largest 65,536,
  `fullFileBytesCopied=0`;
- whole-file FNV-1a 64 `2f291abb5648e078` on both `Underflow` paths, equal to an
  independent Python hash;
- EOF-crossing, past-EOF, zero-length, oversized, write, enqueue, unmounted,
  write-handle, async-only and directory cases all refused explicitly.

PC parity: the patch modifies zero existing files; `C_FileSystem.cpp`/`C_File.cpp`
preprocess identically with and without the three additions; the new TU compiles
at `/W4` with no PC symbol emitted.

Limits: no browser OPFS/worker/COOP-COEP test yet; `pf_open` takes a source id,
not a path (the path→source table is C++-side by design); no real engine consumer
has opened a PAK through it yet. Evidence: `docs/work/analysis/engine-file-layer.md`.

## Layout

```
engine/
  patches/t005c-web-scheduler.patch   scheduler overlay, unified diff vs upstream/BlurRebuilt
  patches/t005b-file-overlay.patch    additive file layer, applied after the scheduler
  apply_overlay.py                    copy + patch a caller-supplied tree (stdlib only)
  apply_file_overlay.py               scheduler + file patch in one tree
  verify_overlay.py                   fresh-tree rebuild, A2/A3/A4, fail-loud, engine caller
  verify_file_overlay.py              fresh-tree rebuild + real root.pak read + PC parity
  native_parity.py                    MSVC TU-equality check + native compile
  make_patch.py                       regenerate the scheduler patch from the spike overlay
  harness/t005c/                      scheduler probe + platform shims (committed source)
  harness/t005b/                      file-layer node harness (smoke_webfile.cpp, JS glue)
  README.md                           this file
```

The harness sources are committed here so both verifiers run from a clean
checkout. Build outputs and trees stay under `_work/`. `verify_file_overlay.py`
additionally needs `_work/range-file-probe/build/range_probe.exe`; if it is
missing it stops with `Blocked` and the build hint instead of skipping the index
comparison.
