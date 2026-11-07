# T-007 — M3 first map: `usa_amboy` playable in the E1 page

**Status:** implemented; Node gates pass. Browser capture recorded in §7.
**Map:** `usa_amboy` (M3 first map).
**URL:** `http://127.0.0.1:8801/?map=amboy&script=sprint` (or without
`script=sprint` for keyboard driving). `?map=river` (default) is unchanged.
**Source data:** the committed MAP2/READ1 slice
`_work/map-slice/amboy/` and the AMB1 render package
`_work/map-slice/amboy-render/`, plus the read-only
`game-data/Blur/levels/usa_amboy/Level.levelphysics`.

## 1. Map registry

`probes/e1-drive/web/map-registry.js` resolves `?map=`:

| id | routes | notes |
|---|---|---|
| `river` (default) | existing `/_work/e1-drive/{geometry,sprint*,spawn,Level.levelphysics}` | exact M1 paths, layouts, pins and best-time keys |
| `amboy` | `/_work/e1-drive/amboy/{map,layout}.json`, `/map-data/usa_amboy/Level.levelphysics` | hard pins below |

The page verifies the map and layout content hashes, the layout file SHA-256, the
map JSON's source package file/content hashes, the fetched `render.json` and
`slice.json` bytes, and the physics bytes (`crypto.subtle`) before `e1_create`.
No fallback map exists.

Amboy rejects `?mp=1`, `?telemetry=1`, `?soak=1`, `?survey=1`,
`?collisionprobe=…` and the River-only `short`/`lap`/`free` courses.

## 2. Generated inputs and pins

`probes/e1-drive/tools/build_map_amboy.mjs` reads the packages read-only and
writes:

| output | bytes | SHA-256 | content hash |
|---|---:|---|---|
| `_work/e1-drive/amboy/map.json` | 49,524,812 | `sha256:52acd10348ab1e747461eae3f5ec9854de1300910096dc50bc8ab7f06850e01a` | `sha256:9290bd3f91160f232d14e5fea14ed9253721fd91c2f3bb49daf0ca307244ffd4` |
| `_work/e1-drive/amboy/layout.json` | 1,198,445 | `sha256:b89ae430dff3aaea3511abc6244687430ec66433055bfbcb4eb63b3a1d364f8d` | `sha256:bccb6bed853827099e5efb55381cb638fda83690201ade40d80fbb095b08f644` |

Source pins verified by the builder and the page:

| source | bytes | SHA-256 / content |
|---|---:|---|
| `_work/map-slice/amboy-render/render.json` | 1,096,353 | `sha256:0f73b248a58fe8b650b0f862898ad8b9affdcb61f0f6e70f9637d24d96231117` / `626d3953…bf71` |
| `_work/map-slice/amboy/slice.json` | 1,632,556 | `sha256:8f5e07d681353b47abb799fdcd69b716fecca225d7a2f76dab48bf14b501b3d7` / `61915aed…43ec8` |
| `Level.levelphysics` | 4,442,528 | `sha256:18c73e1cca6f13c5bbd4937454f25ec3163a67553fea6842a7797400af2175f2` |

`build_map_amboy.mjs --check` re-builds both files byte-for-byte; a stale or
hand-edited output is a hard failure.

## 3. Layout

| field | value |
|---|---|
| path | measured draw-covered point-to-point line, **2,060.595408 m** (declared 2,060.595, +2.8e-5 m) |
| samples | 8,673 at the package's measured spacing |
| spawn | `(230, 1128)`, heading `-2.35619449 rad` (slice heading) |
| checkpoint 1 | arc **686.862337 m**, `(-281.1667, 1478.1667)` |
| checkpoint 2 | arc **1,373.667341 m**, `(-1.0, 1042.0)` (float32 reading) |
| finish | arc **2,060.595408 m**, `(-356, 860)` |
| gates | start/checkpoint/checkpoint/finish, 6 m wide, perpendicular to the 5 m tangent |
| band | declared **6 m** controller/respawn band (not a measured road width) |
| rules | 90-tick countdown, ordered checkpoints, finish, respawn, best time |

## 4. Render upload

| item | value |
|---|---|
| opaque draws | **1,201 / 269,300 triangles** |
| mesh | **529,624 vertices / 1,046,844 indices**, positions + UV0 + global index buffer |
| textures | **179** RGBA8 mip0 blobs, **2,654,272 B** (186 sources, 7 duplicate pairs) |
| skipped decals | **334** additive/decal draws / 56,860 triangles (separate labelled list; no additive pass) |
| skipped diagnostic | **71** draws (50 decoder-size, 17 BC3-alpha, 4 runtime albedo) |
| blocked total | **405** draws / 79,648 triangles |
| normals | **0 vertex normals**; the existing consumer screen-space derivative path is used |
| instances | `instancesApplied:false`, 366 descriptions in 3 sections |
| unsupported sections | **27** (`BillBoard_LN` POSITION type 7) |
| collision | 63,708 static triangles; Box, 4 Cylinders and InstancedTriangleMesh excluded |

The map branch uploads **two meshes** (Amboy map + selected car body) and one
draw list. The 334/71 blocked ranges remain in the shared index buffer but are
only reachable through the labelled lists.

## 5. Physics settle

The engine loads the complete `Level.levelphysics` via `_e1_create`; the
package's collision buffers are hidden physics provenance only.

| field | value |
|---|---|
| settle ticks | **61/61** state hashes equal to `_work/map-slice/amboy/physics-settle.json` |
| sequence | `sha256:d25c4592df994e6a90ca362ebdbdea33c7a247f36b05395b9f786f6d53491b38` |
| tick 0 / tick 60 | `d09314c6…de363` / `898d2711…8120b` |
| contacts | 4/4 on all 61 states |
| finite | true on all 61 states |

## 6. Scripted finish

`?map=amboy&script=sprint` on the Corvette ZR1 (`_work/e1-drive/car.fields`,
SHA-256 `1c24bbd7…5381`):

| field | value |
|---|---|
| finish | **222.050 s / tick 13,413** |
| checkpoint 1 | 68.617 s, arc 686.862337 m |
| checkpoint 2 | 131.617 s, arc 1,373.667341 m |
| respawns | **0** |
| max lateral | 1.472 m |
| max speed | 13.077 m/s |
| contacts | wheel contact on every tick |
| NaN/Inf | 0 |
| state sequence | `sha256:696e5f14e6d9efa19e0610d5afa4a81beb6724b920a599e3f7111102ae9a36d4` |
| input replay | every state hash reproduced in a fresh module |

The controller is `AMBOY_CONTROL` (12 m/s cruise, short pure pursuit) because
the measured path turns back on itself; it is a controller choice, not a physics
or map value. Node anchor: `_work/e1-drive/map-amboy-run.json`.

## 7. Browser capture

`node probes/e1-drive/tools/capture_browser.mjs --mode map --port 8801` drove
`?map=amboy&script=sprint` and held the node run's start / checkpoint / mid /
finish ticks:

| frame | engine tick | phase | checkpoints | progress | screenshot |
|---|---:|---|---:|---:|---|
| start | 0 | countdown | 0 | 0.000019 | `browser-corvette-zr1-stock-map-amboy-start.png` |
| checkpoint | 4,207 | running | 1 | 0.333362 | `…-checkpoint.png` |
| mid | 6,146 | running | 1 | 0.500013 | `…-mid.png` |
| finish | 13,413 | finished | 2 | 1 | `…-finish.png` |

**Verdict:** `clean-console-and-gates`; **console 0 messages / 0 errors or
warnings**. Every frame: 2 geometry uploads (Amboy map + car body), 1,201 opaque
draws + the car's draws, 179 textures / 2,654,272 B, browser state hash equal to
the node run, finish time 222.050 s. Evidence:
`_work/e1-drive/browser-evidence-map-amboy.json`;
console/log: `_work/logs/e1-drive/edge-map-amboy.log`.

## 8. Verification

| gate | result |
|---|---|
| `node probes/e1-drive/tools/verify_e1_map.mjs` | **23/23 checks**, 0 failures (incl. R1 `CourseModel` structural consumption) |
| builder determinism | `--check` reproduces both files |
| physics settle | 61/61 + sequence |
| scripted finish | 222.050 s, 2 checkpoints, 0 respawn, finite/contact, replay identical |
| `node probes/e1-drive/tools/verify_e1_drive.mjs` | **2254/2254** checks, River sprint/short/lap/free/MP models unchanged |
| `python tools/verify_asset_probe.py --skip-build` | **47/47 PASS** |
| `python tools/check_e1_poc.py` | **23 PASS, 0 FAIL** |

## 9. River regression

| gate | result |
|---|---|
| `node probes/e1-drive/tools/verify_e1_drive.mjs` | **2254/2254** checks: 310 m/short sprints, 3-lap, free roam, MP model, packets, ghosts, restarts |
| `python tools/verify_asset_probe.py --skip-build` | **47/47 PASS** |
| `python tools/check_e1_poc.py` | **23 PASS, 0 FAIL** |
| River browser sprint capture | **clean-console-and-gates**, console 0, 0 assertions; finish 14.650 s, 2 checkpoints |
| River browser MP capture | **clean-console-and-gates**, console 0/0; shared result `202db638…0767`, host 14.667 s / guest 16.400 s |
| River browser free-roam capture | **clean-console-and-gates**, console 0, 0 assertions, 60 frames (15 cars × spawn/mid/prop/reset), 45 exact packet hashes |
| River browser 3-lap capture | **clean-console-and-gates**, console 0, 0 assertions, 4 frames (Corvette regression sample; all 15 cars in the Node lap run) |

The map branch in `packet-adapter.js` only activates when `geometry.mapRender`
exists; River packets still upload the three original meshes and the original
draw list. `sprint-script.js` only selects `AMBOY_CONTROL` for
`courseId === 'amboy'`; all River inputs are unchanged.

River capture evidence: `browser-evidence-sprint.json`,
`browser-evidence-mp.json`, `browser-evidence-free.json` and
`browser-evidence-lap.json` under `_work/e1-drive/`; all four modes report
console 0, 0 assertions.

## 10. Limits

1. First-map integration: one map, one car at a time; no opponents, props,
   power-ups, AI, lap or retail race director.
2. The path is measured draw coverage, not a retail start line. The 6 m band is a
   declared rule, not a measured width.
3. 27 unsupported sections and 366 instance descriptions can add surfaces;
   collision excludes the Box, four Cylinders and the InstancedTriangleMesh.
4. 334 additive/decal draws and 71 diagnostic draws are skipped with labels; no
   fallback texture or colour is invented.
5. No vertex normals; derivative normals are the documented fallback.
6. No full-game claim.

## 11. Evidence files

| path | content |
|---|---|
| `_work/e1-drive/amboy/map.json` | map document (mesh, draws, textures, collision, labels, pins) |
| `_work/e1-drive/amboy/layout.json` | measured layout, gates, rules |
| `_work/e1-drive/map-amboy-run.json` | node scripted run, captures, per-tick state hashes |
| `_work/e1-drive/map-amboy-verify.json` | 22-check verifier output |
| `_work/e1-drive/browser-evidence-map-amboy.json` | browser capture evidence |
| `_work/logs/e1-drive/map-amboy-build.log` | builder output |
| `_work/logs/e1-drive/map-amboy-verify.log` | verifier output |
| `_work/logs/e1-drive/edge-map-amboy.log` | headless Edge console/log |
| `probes/e1-drive/tools/build_map_amboy.mjs` | package builder |
| `probes/e1-drive/tools/verify_e1_map.mjs` | map verifier |
| `probes/e1-drive/web/map-registry.js` | map registry + pins |
| `probes/e1-drive/web/map-amboy.js` | validator + merge |
