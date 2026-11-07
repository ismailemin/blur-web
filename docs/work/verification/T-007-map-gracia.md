# T-007 — M3 second map: `spa_barcelona_gracia` playable in the E1 page

**Status:** implemented; Node gates pass; browser capture recorded in §7.
**Map:** `spa_barcelona_gracia` (M3 second map, MAP5 package).
**URL:** `http://127.0.0.1:8801/?map=gracia&script=sprint` (or without
`script=sprint` for keyboard driving). `?map=river` (default) and `?map=amboy`
are unchanged.
**Source data:** the committed MAP5 slice `_work/map-slice/gracia/`, the render
package `_work/map-slice/gracia-render/`, and the read-only
`game-data/Blur/levels/spa_barcelona_gracia/Level.levelphysics`.

No renderer, GPU or browser claim is made by the data package itself; this task
integrates it into the existing E1 page and records the browser evidence below.
No full-game claim is made.

## 1. Map registry

`probes/e1-drive/web/map-registry.js` resolves `?map=`:

| id | routes | notes |
|---|---|---|
| `river` (default) | existing `/_work/e1-drive/{geometry,sprint*,spawn,Level.levelphysics}` | exact M1 paths, layouts, pins and best-time keys |
| `amboy` | `/_work/e1-drive/amboy/{map,layout}.json`, `/map-data/usa_amboy/Level.levelphysics` | existing pins, unchanged |
| `gracia` | `/_work/e1-drive/gracia/{map,layout}.json`, `/map-data/spa_barcelona_gracia/Level.levelphysics` | hard pins below |

The page verifies the map and layout content hashes, the layout file SHA-256, the
map JSON's source package file/content hashes, the fetched `render.json` and
`slice.json` bytes, and the physics bytes (`crypto.subtle`) before `e1_create`.
No fallback map exists. Gracia rejects `?mp=1`, `?telemetry=1`, `?soak=1`,
`?survey=1`, `?collisionprobe=…` and the River-only `short`/`lap`/`free` courses
with typed errors.

The builder/validator were generalized for the second map:

- `tools/map_package_builder.mjs` is the shared builder; `build_map_amboy.mjs`
  and `build_map_gracia.mjs` are one-line instantiations.
- `web/map-package.js` is the shared pin/shape validator and merger;
  `web/map-amboy.js` re-exports the original Amboy names.
- `packet-adapter.js` reads the map id/level/package from the merged document,
  accepts either `*-direct-draws` label, and derives every diagnostic string
  from the map package.
- `sprint-script.js` uses the measured-path controller for both `amboy` and
  `gracia`.

## 2. Generated inputs and pins

`probes/e1-drive/tools/build_map_gracia.mjs` reads the packages read-only and
writes:

| output | bytes | SHA-256 | content hash |
|---|---:|---|---|
| `_work/e1-drive/gracia/map.json` | 72,616,715 | `sha256:562b56889b80d3368d5a1f08f009d6f351b6d3de33b3539df51c666a737a6a0d` | `sha256:dc60abe8527d28d659af1dbed2098928214f31dc3b62d0984369b40238b1b831` |
| `_work/e1-drive/gracia/layout.json` | 312,569 | `sha256:e2f9a1114c283ca84838db96286c5482e9b7b6c4fec779b34bbb4a579991a3b8` | `sha256:1aa622fd77a4637d5b2ddfd9292cc8cd3afd61df197db581db078826133faf30` |

Source pins verified by the builder and the page:

| source | bytes | SHA-256 / content |
|---|---:|---|
| `_work/map-slice/gracia-render/render.json` | 3,079,731 | `sha256:fd6266501fedb8eada56a0bc2e0b166eb3baff0345e1548786c8bcf4e2b3f514` / `1fae82cf…16280` |
| `_work/map-slice/gracia/slice.json` | 2,656,163 | `sha256:e1e1fe62c6e36d8ea71a7b82303b4ff4b6abafcb9fad2810e019be1292652534` / `c1bdf1a7…89fef` |
| `Level.levelphysics` | 5,569,121 | `sha256:acfb58a20ff7adced0b2424dc39474509e6b4c4c805729fd9463bdd310a173c0` |

`build_map_gracia.mjs --check` re-builds both files byte-for-byte; a stale or
hand-edited output is a hard failure. `build_map_amboy.mjs --check` still
reproduces its committed outputs and both registry pins.

Package bytes (MAP5): slice payload + manifest + physics **26,241,366 B**
(26,243,435 B incl. `verify.json`); render package **28,799,891 B**
(28,801,009 B incl. `verify.json`). The generated E1 map document adds the
merged mesh, draw list, textures and hidden collision provenance: **72,616,715 B**.

## 3. Layout

| field | value |
|---|---|
| path | measured draw-covered point-to-point line, **624.913781 m** (declared 624.914 m, −2.2e-4 m) |
| samples | 2,571 at the package's measured 0.25 m spacing |
| spawn | `(336, -23)`, heading `2.15879893 rad` (slice first-2 m tangent) |
| checkpoint 1 | arc **208.343387 m**, `(506.1667, -57.1667)` (slice distance 208.343397 m) |
| checkpoint 2 | arc **416.652048 m**, `(682.1667, -107.1667)` (slice distance 416.652055 m) |
| finish | arc **624.913781 m**, `(876, -142)` |
| gates | start/checkpoint/checkpoint/finish, 6 m wide, perpendicular to the 5 m tangent |
| band | declared **6 m** controller/respawn band (not a measured road width) |
| rules | 90-tick countdown, ordered checkpoints, finish, respawn, best time |
| best time | `e1-drive.sprint.best.v3.gracia` (separate namespace) |

## 4. Render upload

| item | value |
|---|---:|
| opaque draws | **2,627 / 365,451 triangles** |
| mesh | **738,905 vertices / 1,651,896 indices**, positions + UV0 + global index buffer |
| textures | **734** RGBA8 mip0 blobs, **3,247,360 B** (739 sources, 5 duplicate pairs) |
| blocked total | **953 draws / 185,181 triangles** |
| skipped decals | **518** Racification additive/alpha draws / 113,461 triangles (separate labelled list; no additive pass) |
| skipped diagnostic | **435** draws: 426 BC3-alpha, 5 decoder-size, 4 runtime-albedo (66,945 / 4,765 / 10 triangles) |
| normals | **0 vertex normals**; the existing consumer screen-space derivative path is used |
| instances | `instancesApplied:false`, **2,714** descriptions in 14 sections |
| unsupported sections | **4** (`FoliageBillBoard_LN` ×2, `LightFlare_LN` ×2) |
| collision | 113,270 static triangles; the two Boxes and 38 `InstancedTriangleMesh` records are excluded from the triangle package |

The map branch uploads **two meshes** (Gracia map + selected car body) and one
draw list. The 953 blocked ranges remain in the shared index buffer but are only
reachable through the labelled lists. The blocked block records the label counts
(`racificationEffectDecal` 518, `bc3AlphaRuleMissing` 426, `decoderSizeLimit` 5,
`runtimeAlbedoParameter` 4) and embeds the 518-entry effect/decal range list; the
435 diagnostic draws' per-draw records remain in the read-only
`_work/map-slice/gracia-render/diagnostics.json`, which the page serves but does
not upload. Textures use the existing consumer policy
(`rgba8unorm-srgb` + derived mip chain); the producer's sRGB/mip hints remain
`applied:false`.

## 5. Physics settle

The engine loads the complete `Level.levelphysics` through `_e1_create`; the
package's collision buffers are hidden physics provenance only. Spawn
`(336, -23)`, heading `2.15879893`.

| field | value |
|---|---|
| settle ticks | **61/61** state hashes equal to `_work/map-slice/gracia/physics-settle.json` |
| sequence | `sha256:4fd8ae0c0256758eaa9378c4cd3e46e7b04c39803a3ef81b7cc83eb2386e8e30` |
| tick 0 / tick 60 | `2dfd03c7…4fc062` / `f17f9eb4…5461c8` |
| contacts | 4/4 on all 61 states |
| finite | true on all 61 states |

## 6. Scripted finish

`?map=gracia&script=sprint` on the Corvette ZR1 (`_work/e1-drive/car.fields`,
SHA-256 `1c24bbd7…5381`):

| field | value |
|---|---|
| finish | **66.266667 s / tick 4,066** |
| checkpoint 1 | 26.783333 s, arc 208.343387 m |
| checkpoint 2 | 47.916667 s, arc 416.652048 m |
| respawns | **0** |
| max lateral | 1.276489 m |
| max speed | 12.723160 m/s |
| contacts | wheel contact on every tick |
| NaN/Inf | 0 |
| state sequence | `sha256:cf089202c5ca82327bc068b2a56124f8213443f817c9446fb49c95b8a8e39ce7` |
| input replay | every state hash reproduced in a fresh module |

The controller is the same `AMBOY_CONTROL` measured-path policy (12 m/s cruise,
short pure pursuit). This is a controller choice, not a physics or map value.
Node anchor: `_work/e1-drive/map-gracia-run.json`.

## 7. Browser capture

`node probes/e1-drive/tools/capture_browser.mjs --mode map --map gracia --port 8804`
drove `?map=gracia&script=sprint` and held the node run's start / checkpoint /
mid / finish ticks:

| frame | engine tick | phase | checkpoints | progress | screenshot |
|---|---:|---|---:|---:|---|
| start | 0 | countdown | 0 | 0 | `browser-corvette-zr1-stock-map-gracia-start.png` |
| checkpoint | 1,697 | running | 1 | 0.333565 | `…-map-gracia-checkpoint.png` |
| mid | 2,287 | running | 1 | 0.500178 | `…-map-gracia-mid.png` |
| finish | 4,066 | finished | 2 | 0.999942 | `…-map-gracia-finish.png` |

**Verdict:** `clean-console-and-gates`; **console 0 messages / 0 errors or
warnings**. Every frame: 2 geometry uploads (Gracia map + car body), 2,627 opaque
draws + the car's draws, 734 textures / 3,247,360 B, browser state hash equal to
the node run, finish time 66.266667 s. The finish frame's progress is 0.999942
because the finish gate fires slightly before the last measured sample; the
capture gate accepts `>= 0.999` (the rules still freeze the finish time and
progress is clamped to the finish arc).

Evidence: `_work/e1-drive/browser-evidence-map-gracia.json`; console/log:
`_work/logs/e1-drive/edge-map-gracia.log`. Visual check: city blocks, pavement,
road texture and the car are rendered at start/checkpoint/mid/finish; the HUD
reports `GRACIA · spa_barcelona_gracia measured path 624.914 m · 2627 opaque
draws / 365451 tri · 734 tex / 3247360 B`.

## 8. Verification

| gate | result |
|---|---|
| `node probes/e1-drive/tools/verify_e1_map.mjs --map gracia` | **23/23 checks**, 0 failures (incl. R1 `CourseModel` structural consumption) |
| builder determinism | `--check` reproduces both files |
| physics settle | 61/61 + sequence |
| scripted finish | 66.267 s, 2 checkpoints, 0 respawn, finite/contact, replay identical |
| `node probes/e1-drive/tools/verify_e1_drive.mjs` | **2254/2254** checks, River sprint/short/lap/free/MP models unchanged |
| `python tools/verify_asset_probe.py --skip-build` | **50/50 PASS** |
| `python tools/check_e1_poc.py` | **23 PASS, 0 FAIL** |

## 9. River + Amboy regression

| gate | result |
|---|---|
| `verify_e1_map.mjs --map amboy` | **23/23**, settle sequence `d25c4592…`, finish 222.050 s / tick 13,413, replay identical |
| `build_map_amboy.mjs --check` | both files byte-identical; map `52acd103…`, layout `b89ae430…` |
| `verify_e1_drive.mjs` | **2254/2254**: 310 m/short sprints, 3-lap, free roam, MP model, packets, ghosts, restarts |
| `verify_asset_probe.py --skip-build` | **50/50 PASS** |
| `check_e1_poc.py` | **23 PASS, 0 FAIL** |
| River browser sprint capture | **clean-console-and-gates**, console 0, 60 frames, finish 14.650 s, 2 checkpoints |
| Amboy browser map capture | **clean-console-and-gates**, console 0, start/checkpoint/mid/finish, finish 222.050 s |

The map branch in `packet-adapter.js` only activates when `geometry.mapRender`
exists; River packets still upload the three original meshes and the original
draw list. `sprint-script.js` selects the measured-path controller only for
`courseId === 'amboy' || 'gracia'`; all River inputs are unchanged.

## 10. Evidence files

| path | content |
|---|---|
| `_work/e1-drive/gracia/map.json` | map document (mesh, 2,627 draws, 734 textures, collision, labels, pins) |
| `_work/e1-drive/gracia/layout.json` | measured layout, gates, rules |
| `_work/e1-drive/map-gracia-run.json` | node scripted run, captures, per-tick state hashes |
| `_work/e1-drive/map-gracia-verify.json` | 23-check verifier output |
| `_work/e1-drive/browser-evidence-map-gracia.json` | browser capture evidence |
| `_work/e1-drive/browser-corvette-zr1-stock-map-gracia-{start,checkpoint,mid,finish}.png` | WebGPU screenshots |
| `_work/logs/e1-drive/map-gracia-build.log` | builder output |
| `_work/logs/e1-drive/map-gracia-verify.log` | verifier output |
| `_work/logs/e1-drive/edge-map-gracia.log` | headless Edge console/log |
| `probes/e1-drive/tools/map_package_builder.mjs` | shared package builder |
| `probes/e1-drive/tools/build_map_gracia.mjs` | Gracia builder instantiation |
| `probes/e1-drive/tools/verify_e1_map.mjs` | map verifier (`--map amboy|gracia`) |
| `probes/e1-drive/web/map-registry.js` | map registry + pins |
| `probes/e1-drive/web/map-package.js` | generalized validator + merge |
| `probes/e1-drive/web/packet-adapter.js` | generalized map packet branch |

## 11. Coverage limits

1. Second-map integration: one map, one car at a time; no opponents, props,
   power-ups, AI, lap or retail race director.
2. The path is measured draw coverage, not a retail start line. The 6 m band is a
   declared rule, not a measured width.
3. 4 unsupported sections and 2,714 instance descriptions can add surfaces;
   collision excludes the two Boxes and 38 `InstancedTriangleMesh` records.
4. 518 Racification additive/alpha draws and 435 diagnostic draws (426 BC3-alpha,
   5 decoder-size, 4 runtime) are skipped with labels; no fallback texture or
   colour is invented.
5. No vertex normals; derivative normals are the documented fallback.
6. No full-game claim.
