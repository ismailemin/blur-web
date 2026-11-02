# Blur Web

Browser port of the original **Blur** using the BlurRebuilt source as the
reference implementation. The long-term goal is a private-room race for a group
of friends: game logic and adapted engine subsystems run as WebAssembly in each
player's desktop Chromium browser, and rendering targets WebGPU.

**This repository is not a playable game yet.** It currently contains portable
asset readers, a WebGPU asset preview, extensive native/WASM verification, and
a native Windows reference build and race harness.

## Current state

- PAK V1/V2 metadata, packet-zlib decoding, PC model chunks.
- Sequential PC Scene reader: first resource block, first RenderList, LOD0 base
  primitives, per-draw UV0, ordered materials, shared embedded textures.
- Resource-texture metadata across all loaded resource blocks, with original
  descriptor and exact payload spans; complete LOD0 images bind 12 more draws.
- Corvette C3 body: 30,591 vertices, 36,193 triangles, 80 draws; 26 static draws
  use original images (14 shared + 12 resource-block LOD0).
- Level index + direct geometry from original `.levelrender` and `.levelstream`:
  River wide 17,782 vertices / 9,343 triangles, Showroom 11,590 / 7,987.
- Bounded first-instance transform API: River block27/node253 instance0 gives
  805 vertices / 726 triangles; archived-bounds error 3.86511e-05.
- Multi-instance API on the same block: 14 instances, 7,308 vertices / 6,106
  triangles; 8 bounds-mismatched and 35 other-block instances are counted, not
  guessed.
- Multi-block scan (blocks15/17/26/27/31/32): block27+15 yield 18 instances,
  8,688 vertices / 7,085 triangles; remaining blocks need stream semantics or
  prerequisites.
- PC texture decoder (BC1/BC2/BC3 and selected uncompressed formats).
- XT/FLSK schema metadata only.
- Native x64 Amax Release build passes; stationary Brighton race renders.
- Not implemented: the other 56 level instances, higher resource-texture LODs,
  full scene traversal and materials, physics, controls, audio, save/streaming,
  single-player race, multiplayer.

The authoritative handoff is [`docs/handoff/CURRENT.md`](docs/handoff/CURRENT.md).
The chronological engineering log is [`docs/STATUS.md`](docs/STATUS.md).

## Repository layout

```text
PLAN.md                 project goals, phases, risks
docs/                   plans, format notes, research, handoff and work records
probes/asset-reader/    portable C++17 readers, WASM build, browser preview
tools/                  Python diagnostics, fixture preparation, verification
upstream/               read-only BlurRebuilt checkout (ignored by Git)
game-data/              local game copy (ignored by Git)
_work/                  generated fixtures, builds and evidence (ignored by Git)
```

`upstream/`, `game-data/` and `_work/` are not part of the repository. Game data
is never redistributed. No payload signature or retail-authenticity validation
is performed by the readers.

## Quick start

Use the bundled Python if `python` resolves to the Windows Store alias:

```powershell
C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe tools/verify_asset_probe.py --skip-build
C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe tools/serve_asset_probe.py
```

Open <http://127.0.0.1:8765/>. The server is loopback-only and exposes only the
web folder plus bounded ranges from an explicit whitelist of installed PAK and
level files.

Full rebuild (native + WASM) requires Visual Studio 2022 C++ tools, Windows SDK,
CMake and the pinned Emscripten 6.0.13 under `_work/toolchains/emsdk`:

```powershell
python tools/verify_asset_probe.py
```

## Documentation

Read in this order:

1. [`PLAN.md`](PLAN.md) — goals and phase gates.
2. [`docs/handoff/CURRENT.md`](docs/handoff/CURRENT.md) — current position and next task.
3. [`docs/handoff/NEXT.md`](docs/handoff/NEXT.md) — next three tasks and acceptance criteria.
4. [`probes/asset-reader/README.md`](probes/asset-reader/README.md) — probe build/run/test.
5. [`docs/setup/native-source-build.md`](docs/setup/native-source-build.md) — native reference build.
6. [`docs/work/README.md`](docs/work/README.md) — task board and record-keeping rules.

Agent operating rules are in [`AGENTS.md`](AGENTS.md).

For a physical Chrome/Brave check of the current asset viewer, see
[`docs/handoff/PHYSICAL_BROWSER_TEST.md`](docs/handoff/PHYSICAL_BROWSER_TEST.md).
That build is an asset viewer, **not** a playable game.

## Scope and non-goals

- Players must not need to install the Windows game or BlurRebuilt.
- The Windows build is a development, comparison and debugging reference only.
- Unknown formats are reported as unsupported; values are never guessed.
- Desktop Chromium, keyboard and gamepad first; mobile and all browsers later.
