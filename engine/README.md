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
| patch | `engine/patches/t005c-web-scheduler.patch` (20 files, 681 insertions, 35 deletions) |
| patch SHA-256 | `DBD4AC27D43722D304313AC0709F38C28BF7DE67BE3AEC4495F9B7D816622E8B` |
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
  spike shim outside the engine (`_work/engine-web-spike/shims/`), not by this
  patch.
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

## Layout

```
engine/
  patches/t005c-web-scheduler.patch   the overlay, unified diff vs upstream/BlurRebuilt
  apply_overlay.py                    copy + patch a caller-supplied tree (stdlib only)
  verify_overlay.py                   fresh-tree rebuild, A3/A4, fail-loud, engine caller
  native_parity.py                    MSVC TU-equality check + native compile
  make_patch.py                       regenerate the patch from the spike overlay
  README.md                           this file
```

Not engine code, not committed game data: the probe sources used by
`verify_overlay.py` (`smoke_sched.cpp`, `smoke_caller.cpp`) and the two platform
shims (`platform_net_web.cpp`, `web_runtime.cpp`) live under
`_work/engine-web-spike/`, where they are regenerated and measured.
