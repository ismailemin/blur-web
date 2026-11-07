# Map slice probe

Self-describing, data-only map slice packages built from the committed readers.
This probe does **not** integrate a map into `e1-drive`, render a frame, drive a
lap or claim a playable game. It packages one level's collision, first-RenderList
direct draw geometry, measured layout, spawn proof and an E1 wasm physics settle
so a later integration task has bounded, hashed inputs.

Current packages: `usa_amboy` (2,060.6 m measured draw-covered path) and
`spa_barcelona_gracia` (624.9 m, 88/92 sections). The tools take a level name
and package directory, so a new level does not need a code fork:

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
& $py probes/map-slice/tools/extract_slice.py --level spa_barcelona_gracia
& $py probes/map-slice/tools/amboy_texture_bindings.py --level spa_barcelona_gracia
& $py probes/map-slice/tools/amboy_blocker_report.py --level spa_barcelona_gracia
& $py probes/map-slice/tools/build_amboy_render.py --level spa_barcelona_gracia
& $py probes/map-slice/tools/verify_slice.py --package _work/map-slice/gracia
& $py probes/map-slice/tools/verify_amboy_texture_bindings.py --level spa_barcelona_gracia
& $py probes/map-slice/tools/verify_amboy_render.py --package _work/map-slice/gracia-render --level spa_barcelona_gracia
```

Amboy stays the default for every tool. Details:
[`docs/work/analysis/map-slice-gracia.md`](../../docs/work/analysis/map-slice-gracia.md)
(Gracia) and
[`docs/work/analysis/map-slice-amboy.md`](../../docs/work/analysis/map-slice-amboy.md)
(Amboy). Amboy was refreshed 7 November 2026 with reader
`level_inspect.exe` 249,856 B /
`a633a030f530b9939991b4fc5c67aebe60d00cd22d59a6fffb3f74b0fbf6965b`; all 48
supported sections were replayed with byte-identical geometry (see
[Reader refresh](#reader-refresh)).

## What is in the package

`_work/map-slice/amboy/`:

| file | content |
|---|---|
| `slice.json` | self-describing manifest: level, collision, draws, `draws.nativeReaderRefresh`, textures, layout, spawn, unsupported sections, integration gaps, hashes |
| `collision.positions.f32.bin` | 34,057 collision vertices, float32 LE x,y,z |
| `collision.indices.u32.bin` | 191,124 indices, 63,708 triangles |
| `draws.positions.f32.bin` | 529,624 draw vertices, float32 LE x,y,z |
| `draws.uv0.f32.bin` | 529,624 UV0 pairs, float32 LE u,v |
| `draws.indices.u32.bin` | 1,046,844 indices, 348,948 triangles |
| `physics-settle.json` | E1 wasm 60-tick zero-input settle, per-tick state hashes, 25 ground probes |
| `verify.json` | deterministic verifier output, 12,367 checks, PASS |

`slice.json` embeds the 8,673-point layout and all 1,606 per-draw ranges. No
separate layout texture binary is written because the package has **0 bound
albedo images**. The fixed reader resolves a static albedo identity for
1,268/1,606 direct draws (1,163 resource-block + 105 shared) and reports 338
blocked; MAP3 joins that identity to decoder/alpha evidence for 1,201 bindable /
405 blocked draws. Identity is not binding: no pixel, format, alpha, blend,
shader or sampler state is applied. See `textures.identity`,
`draws.nativeReaderRefresh` and `textures.attempts` in `slice.json`.

## Render-ready package

`_work/map-slice/amboy-render/` turns the slice + MAP3 bindings into one upload
set. It is **data only**: no renderer, GPU, browser or playable claim.

| file | content |
|---|---|
| `render.json` | manifest: buffers, 1,201 opaque draws, 179 merged textures, layout/spawn, upload contract, hashes |
| `diagnostics.json` | 405 blocked draws: 334-draw separate additive-decal list, 50 decoder-size, 17 BC3-alpha, 4 runtime |
| `draws.positions.f32.bin`, `draws.uv0.f32.bin`, `draws.indices.u32.bin` | byte-identical to the slice buffers (529,624 vertices, 1,046,844 indices) |
| `layout.points.f32.bin` | 8,673 `x,z,h` float32 points; same SHA-256 as the slice layout |
| `textures/tex-NNN.rgba` | 179 deduplicated RGBA8 mip0 blobs (186 sources) |
| `verify.json` | 17,813-check independent verifier, PASS |

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py probes/map-slice/tools/build_amboy_render.py --out _work/map-slice/amboy-render
& $py probes/map-slice/tools/verify_amboy_render.py --package _work/map-slice/amboy-render
```

The verifier recomputes every draw range and UV0 hash against MAP3, checks the
1,201/405 split and the 334-entry decal list, hashes all 179 texture blobs,
re-measures the layout/spawn, and builds the package twice byte-identically.
Texture merge totals: 2,672,704 B referenced mip0 → 2,654,272 B unique mip0;
expected chain 3,564,368 B → 3,539,772 B. sRGB and mip generation are recorded
as **hints only** (`applied:false`). No fallback texture is invented.

Details and the exact e1 integration gap:
[`docs/work/analysis/map-slice-amboy-render.md`](../../docs/work/analysis/map-slice-amboy-render.md).

## E1 module pin policy (behaviour-based)

The slice packages do **not** hard-fail when `_work/e1-drive/module` is rebuilt
with the same physics behaviour. `verify_slice.py` treats the module/build files
as soft pins: it re-runs the current module on the package physics at the
recorded spawn, twice, and compares all 61 per-tick state hashes plus the
sequence hash to `physics-settle.json`. A byte/hash drift is accepted only when
those match; otherwise it fails with the first mismatching tick and both hashes.
The current identity is recorded informationally in `verify.json`.

`probes/map-slice/tools/refresh_module_pin.py` refreshes the recorded identity
after a rebuild without touching collision, draw, UV0, index, layout or spawn
bytes:

```powershell
& $py probes/map-slice/tools/refresh_module_pin.py --package _work/map-slice/amboy
& $py probes/map-slice/tools/refresh_module_pin.py --package _work/map-slice/gracia
```

Current identity at the 7 November 2026 refresh: module 11,480 B /
`5177ea975151fb085a44b8b960e384913d36a7e225078a1783f90e1f0b1bff2a`, build
3,466 B / `8493193cb8aacc5a9d108874318c612298b46edb5fe28b12c8558b7f0d5c7577`,
wasm `bcdc2d994a499cc399333b44cfc418d6594f8b5182a668c3a9df761d891de265`.
Amboy sequence `d25c4592…53491b38`, Gracia sequence `4fd8ae0c…386e8e30`; both
replayed 61/61 ticks identically. Hashes and the exact policy:
[`docs/work/analysis/map-slice-module-pin-policy.md`](../../docs/work/analysis/map-slice-module-pin-policy.md).

## Reproduce

Use the bundled Python and Node:

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py probes/map-slice/tools/extract_slice.py --level usa_amboy --out _work/map-slice/amboy
node probes/map-slice/tools/physics_settle.mjs --package _work/map-slice/amboy
& $py probes/map-slice/tools/verify_slice.py --package _work/map-slice/amboy
```

`extract_slice.py` runs `physics_settle.mjs` itself and pins the settle file in
`slice.json`; running the node command separately is only useful when
re-measuring the physics proof. It also replays the current native reader on
every supported staged chunk (`_work/logs/map-slice/reader-refresh/<level>/`)
and aborts if positions, UV0 bits, indices or draw ranges differ from the
committed probe doc. That replay only records additive identity fields; it does
not rewrite the package draw schema.

The verifier re-reads the original level files and the committed map-pipeline
artifacts, recomputes collision, draws, layout, spawn band and physics summary,
and fails on any hash or value mismatch. Two full extraction runs with the final
code produced byte-identical payload, manifest and reader-replay files; repeated
verifier runs produced a byte-identical `verify.json`.

## Inputs (read-only)

| input | use |
|---|---|
| `game-data/Blur/levels/usa_amboy/Level.levelphysics` | collision |
| `game-data/Blur/levels/usa_amboy/level.levelrender` | draw source |
| `_work/map-pipeline/draw-probes-all.json` + `_work/map-pipeline/probes/usa_amboy-g*/native.json` | committed native `level_inspect` direct-draw output |
| `_work/build/asset-reader-native/Release/level_inspect.exe` | current reader identity and 48-section replay |
| `_work/map-pipeline/candidates/usa_amboy.layout.json` | measured candidate layout |
| `_work/map-pipeline/covered/usa_amboy-path.json` | measured draw-covered path |
| `_work/map-pipeline/grids/usa_amboy.npz` | 1 m audit grid |
| `_work/e1-drive/car.fields`, `_work/e1-drive/module/e1_drive.{mjs,wasm}`, `build.json` | physics settle |

Collision extraction uses `probes/map-pipeline/tools/physics_scan.py`, which
follows the upstream Gravity serializer. The committed collision oracle alone
stops at Amboy's first shape (Box); `physics_scan.py` parses the documented
stream and its triangle payload is decoded by the committed oracle code. No
offset or size is guessed.

The committed `draw-probes-all.json` was produced by the **pre-READ1** reader
(`nativeReaderSha256 63ee2801…`); its `native.json` files carry no
material/albedo identity. The extractor therefore replays the current reader for
identity evidence and keeps the committed probe geometry byte-for-byte.

## What the package proves

- Collision: 63,708 static triangles (55,812 up-facing, 2,482 steep, 5,414
  other, 0 degenerate) from the two static triangle meshes. The box, four
  cylinders and the `InstancedTriangleMesh` are recorded as excluded.
- Draws: 48/75 first-RenderList direct sections, 529,624 vertices, 348,948
  triangles, 1,606 draws. 27 sections are unsupported with the exact native
  byte offset. All 1,606 draws have UV0; 0 image textures are bound; 0 use
  placeholder UVs.
- Material identity: the fixed-reader replay resolves 1,268/1,606 static
  albedo identities (1,163 resource-block + 105 shared), reports 338 blocked,
  prints 1,606/1,606 UV0 hashes, and sees 38 shared texture identities per
  section. `draws.nativeReaderRefresh` records the additive field set and
  counts; draw records keep the v1 `albedoTexture:null` schema.
- Layout: 2,060.59538 m point-to-point, 8,673 points at 0.25 m, two checkpoints
  at 686.8623 m and 1,373.6673 m, finish at 2,060.59538 m. Every point lies on
  the measured draw-covered polyline; all 1,543 covered samples are embedded.
- Spawn: (230, 1128), ground −0.094210 m (collision ray), layout −0.0942 m,
  engine probe −0.094223 m; heading −2.35619449 rad. A 1 m × 5 m band (25 rays)
  has 25/25 up-facing hits; height spread 0.10073 m.
- Physics: the existing E1 wasm module loads the Amboy physics bytes (not
  hard-coded to River), settles 60 ticks with zero input, stays finite with 4/4
  wheel contacts on all 61 sampled ticks, and produces an identical state
  sequence in two independent module instances.

## Unsupported draw sections

All 27 unsupported first-RenderList direct sections stop at the committed native
reader with `Unsupported position vertex format`; the byte offset is relative to
the extracted geometry chunk. The full table is in
`docs/work/analysis/map-slice-amboy.md` and in
`slice.json.draws.unsupportedSections`.

## Reader refresh

The package pins the current reader (`249,856` B,
`a633a030f530b9939991b4fc5c67aebe60d00cd22d59a6fffb3f74b0fbf6965b`) and replays
it on all 48 supported staged chunks. For every section, positions, UV0 bits,
indices and draw ranges are identical to the committed pre-fix probe doc. The
replay records these additive draw fields, absent from the committed probe doc:

`resourceBlock`, `resourceIndex`, `material`, `materialRow`, `uvHash`,
`bindingStatus`, `bindingReason`

plus the level-wide `sharedTextures` list (38 identities) and
`metadata.materialAlbedoResolved`. One schema note: in the fixed reader,
`albedoTexture` is a **shared-texture index** for 105 draws, not a bound image.
The package keeps its own `albedoTexture:null` draw schema so downstream counts
and the 12,367-check verifier remain stable; identity lives in
`draws.nativeReaderRefresh` and the MAP3 manifest.

Evidence: `_work/logs/map-slice/reader-refresh/usa_amboy/` (48 JSON files).

## Limits

- Direct-draw LOD0 only; `instancesApplied:false`. Three supported sections
  carry skipped instance descriptions (366 total), and instance-only geometry
  can add surfaces.
- No decoded vertex normals: the committed direct-draw reader exports positions,
  UV0, indices, draw ranges and static material identity, but no normal stream.
- 0 bound albedo images. Static albedo identity is resolved for 1,268/1,606
  draws (1,201 bindable after MAP3's decoder/alpha join), but no pixel, format,
  alpha, blend, shader or sampler state is applied. Identity is not binding. No
  texture is invented.
- The package draw records come from the committed pre-fix probe doc. Do not
  merge the fixed reader's `albedoTexture` shared-texture index into the package
  schema; it is identity, not a bound image.
- Collision excludes simple shapes and instanced triangle-mesh geometry.
- The spawn and course are derived from the measured path, not a retail start
  line or a lap.
- No renderer, GPU, browser frame, vehicle drive, playable-game or full-game
  claim.
