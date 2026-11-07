# probes/e1-drive — drivable E1 slice (wasm vehicle physics → render packet → WebGPU)

The first **connector** between the two proven halves of E1:

- the wasm vehicle physics of `engine/harness/t005d-vehicle/` (the real
  RacingPhysics/Gravity integrator on `usa_la_river/Level.levelphysics`, T-007), and
- the dynamic render-packet consumer of `probes/render-packet/web/` (v1.1
  `nodes[]`/`updates[]`, fixed-step, interpolated, T-007/E1b).

The page runs a **point-to-point sprint** on the measured covered segment of
the real River draw: a 3-2-1 countdown, a running timer, two checkpoints that must
be crossed in order, a finish gate before the drawn road ends, a results overlay
with a per-car best time in `localStorage`, `R` restart and a respawn at the last
checkpoint when the car leaves the surface. Behind **`?course=lap`** it also runs
a **3-lap race** on the P61 `loop-01` closed collision loop (222.040 m), and
behind **`?course=free`** a **free-roam mode** on the P65/P68 measured spawn
basin (`R04`, 7,702.25 m²) with no gates, no finish and the P74 R04-V2
447-collider `all-visible` prop layer. The rules are presentation/bookkeeping
only and do not change the physics (the verifier replays every scripted sprint's
input sequence into a fresh module and gets identical state hashes).

`G` replays a completed run as a **ghost** (your fastest clean run for this car and
course, else the committed deterministic reference trace) with a labelled
translucent diagnostic tint and a HUD time/distance gap. It is a replay, not an
AI: it never steps the engine, collides or writes a physics value. See
`docs/work/verification/T-007-ghost.md`.

`?telemetry=1&car=<slug>` runs a deterministic **telemetry mode** instead: three
scripted manoeuvres (standing start, 80 km/h brake, steering sweep), a metric
table and three 60 Hz traces in a panel, and a JSON report
(`_work/e1-drive/telemetry-<slug>.json`). It is a diagnostic validation, not a
retail-fidelity claim.

The car also has **engine audio** after the first real user gesture (a click or
a driving key). It plays the six decoded retail `Race_V8_engine` RPM loops from
the committed `probes/audio/web/engine-audio.js` module and follows the wasm
`Engine().RPM()` once per frame; `M` mutes/unmutes and `?audio=0` forces it off.
A missing WAV or `AudioContext` leaves the page silent with a typed
`audio unavailable: <reason>` HUD row. The WAVs stay read-only under
`_work/audio/` and are not committed. A server process started before this
change must be restarted so it serves the new `/audio/` and `/_work/audio/`
routes. See `docs/work/verification/T-007-audio.md`.

The car is drawn from each car's own committed part manifest
(`probes/car-parts/`): the Corvette ZR1 has **34 parts / 100 draws**, the Lotus
Exige Cup260 **23 / 88**, the Dodge Challenger **31 / 104**, the Ford Focus RS
**31 / 115** and the Audi R8 V10 **29 / 84**, each with **four wheel groups**
whose tyre/rim/brake-disc members spin about the proven element-local `+X` axis
using that car's physics wheel angular velocity. Brake calipers stay static
(`VehicleActor.cpp:5198`). Each body now samples the **P52 static albedo image on
its own committed UV0 stream** for **673 of its 1,378 draws** (112 images, 46.51 MB
of RGBA); the other 267 draws (45 runtime paint lookups, 66 light off/on blends,
156 other `_NO_ALBEDO` shaders) keep the diagnostic per-part colour and the
committed P52 reason. The wheel spin marker remains a debug aid. See
`docs/work/verification/T-007-textured-cars.md`.

The 22 committed level-instance props (River `block27/node253`, 13,162 vertices /
10,308 triangles) now sample their **real static albedo and source UV0 on 18
draws / 10,212 triangles** (14 visible in the driven view). Four decoded BC1
images (`car01_lic_diff`, `car02_lic_diff`, `car03_lic_diff`,
`bigtruck02_diff`, 8,192 B) come from the P73a export; the `4` cab draws that
resolve to `cab01alphas_diff` (DXT5/BC3) stay explicitly **diagnostic** as
`bc3-alpha-rule-missing` because no alpha rule is declared. No alpha value,
texture or UV is guessed. See `docs/work/verification/T-007-prop-textures.md`.

The car drives on the whole River collision mesh, but the **drawn** track is the
real River render geometry: the committed `level_inspect` direct draws
(block88/node283, 95 draws / 17,782 vertices / 9,343 triangles, plus the
drive-covering block56/node289 section) **plus the six measured sections of the
539.81 m River corridor**, merged into one labelled `river.track.visual` mesh
(394 draws / 96,494 vertices / 57,133 triangles). **297 of those draws sample
their own static `g_tAlbedo` texture with the real P45 UV0 stream** (136 textures,
439,360 decoded RGBA bytes); the 2 runtime-only albedo draws and the 95
block88/node283 draws with no P45/P47 binding row keep the labelled diagnostic
albedo. The diagnostic collision surface is no longer drawn; it stays in the
packet as hidden physics provenance (`visible:false`). See
`docs/work/verification/T-007-track-visual.md` for the two original sections,
`T-007-ledge-fix.md` for the corridor and `T-007-textured-track.md` for the
textured pass.

### The playable sprint is the measured 310 m P48 course

The default course is the **P48 collision-only drivable path**: 310.395 m from the
committed spawn (−88, 1050) to (103.5, 1292.5), 1,245 samples at 0.25 m, max step
1.55 cm, max 2‑m grade 3.09 %, minimum distance to a steep collision face 7.78 m.
P51 measured **100 % draw coverage** from section `river.block56.node289` at the
car-width band, so the whole course is already drawn. The gates are derived from
that path (`tools/build_sprint.mjs` → `_work/e1-drive/sprint.json`):

| gate | arc | point | heading | width | coverage |
| --- | ---: | --- | ---: | ---: | --- |
| start | 0.000 | (−88.0, 1050.0) | 0.7674 | 6 m | 61/61 |
| checkpoint 1 | 100.108 | (−18.50, 1122.05) | 0.7674 | 6 m | 61/61 |
| checkpoint 2 | 200.075 | (42.83, 1200.56) | 0.5839 | 6 m | 61/61 |
| finish | 300.160 | (97.53, 1284.18) | 0.6222 | 6 m | 61/61 |

The finish is **10.24 m before the measured end** so the car can stop before the
surface narrows to 2.0 m at +4 m. The 29 m straight is kept as the regression
course behind `?course=short` (`_work/e1-drive/sprint-short.json`), unchanged from
P37. Both courses use the same rules engine; the 310 m course uses the Stanley
path follower in `web/sprint-script.js`, the 29 m course keeps the P37 throttle
hold.

### The extended corridor is a survey, not a course

The 539.81 m corridor measured by `probes/track-coverage` is **drawn** and
**measured**, but it is **not a race course**: its measured centre line crosses a
50 m vertical collision face at **arc 57.82 m** (and again at 530.71 m), and the
faithful box chassis stops on the 6.4 cm section-join rise at **52.7-53.4 m**. It
is reported as a survey:

- `?survey=1` labels the drawn corridor in the page (no gate, timer or result
  changes) and states the measured limit;
- `_work/e1-drive/corridor-survey.json` is the measured record (six-section
  totals, the four survey gates and their 61/61 coverage, the four path/face
  crossings with the engine's own solidity test, the section-join rise, the 31 %
  drop near the end and the three coverage gaps);
- `_work/e1-drive/corridor-survey.html` is the labelled survey page;
- `_work/e1-drive/corridor-probe*.json` is the per-car physical limit, measured by
  placing the car on the measured line and driving at it.

The survey, its limits and the rejected proxy fix are recorded in
`docs/work/verification/T-007-ledge-fix.md`.

Nothing in this directory is engine code and nothing here edits the probes it
reuses. The engine still runs the car; the packet still describes the frame; the
WebGPU backend still renders the packet.

```
keyboard / scripted input / sprint / telemetry / ?car=<slug>
        │  set_input(tick)
        ▼
wasm  e1_*  ── one C_Scene::Simulate(1/60) per tick ──►  JSON state
        │                                                   │
        │                                                   ▼
        │                                   web/packet-adapter.js: updates[] (camera + matrix)
        ▼                                                   │
web/fixed-step.js (1/60, 4-tick cap, pause rule)            ▼
        └────────────────────► web/packet-consumer.js (WebGPU, geometry uploaded once)
```

## Maps (M3 first map: `usa_amboy`)

`?map=river` is the default and is byte-for-byte the existing M1 page (same
paths, geometry, layouts, spawn, best-time keys and pins). `?map=amboy` swaps
only the map half:

| item | value |
|---|---|
| map package | `_work/map-slice/amboy-render` (AMB1) + `_work/map-slice/amboy` (MAP2/READ1) |
| generated page input | `_work/e1-drive/amboy/map.json` + `layout.json` (`tools/build_map_amboy.mjs`) |
| physics | `game-data/Blur/levels/usa_amboy/Level.levelphysics`, served read-only at `/map-data/usa_amboy/…` |
| opaque draws | **1,201 / 269,300 triangles**, one merged mesh (529,624 vertices, 1,046,844 indices) |
| textures | **179** merged RGBA8 mip0 blobs, 2,654,272 B (186 sources; 7 duplicate pairs) |
| normals | **0 vertex normals**; the consumer's existing screen-space derivative normal path is used |
| skipped | **334** additive/decal draws + **71** diagnostic draws (labelled; no fallback texture/colour) |
| geometry blockers | **27** unsupported sections, **366** instance descriptions, `instancesApplied:false` |
| collision | 63,708 static triangles; the Box, four Cylinders and the InstancedTriangleMesh are outside the triangle package |
| path | measured **2,060.595408 m** point-to-point, spawn `(230, 1128)` heading `-2.35619449`, checkpoints `686.862337` / `1,373.667341` m |
| rules | the same R1-style SprintRules: 90-tick countdown, ordered checkpoints, finish, respawn, best time |
| best time | `e1-drive.sprint.best.v3.amboy` (separate from River) |

The page loads the map document, verifies its content hash, the layout file hash,
the source render/slice content pins and the physics SHA-256 before creating the
world (`crypto.subtle`). A mismatch fails loudly; there is no fallback map.
The Amboy controller uses a lower cruise speed and short pure pursuit
(`AMBOY_CONTROL` in `web/sprint-script.js`) because the measured path turns back
on itself several times; this is a controller choice, not a physics or map value.

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
& $node probes/e1-drive/tools/build_map_amboy.mjs          # writes _work/e1-drive/amboy/{map,layout}.json
& $node probes/e1-drive/tools/verify_e1_map.mjs            # pins, 61/61 settle, scripted finish, replay
& $node probes/e1-drive/tools/serve.mjs --port 8801        # /?map=amboy&script=sprint
& $node probes/e1-drive/tools/capture_browser.mjs --mode map --port 8801
```

`verify_e1_map.mjs` records `_work/e1-drive/map-amboy-run.json` (the node anchor
the browser capture compares against) and `_work/e1-drive/map-amboy-verify.json`.
The verified scripted run finishes at **222.050 s / tick 13,413** with both
checkpoints, 0 respawns, wheel contact on every tick and a bit-identical input
replay. River's sprint/lap/free/MP modes are unchanged; run their existing gates
to confirm the regression.

Limits: the path is measured draw coverage, not a retail start line; there are no
Amboy prop colliders, power-ups, opponents, AI, lap or retail race rules. This is
one playable point-to-point map, not a full-game claim.

## Cars

**Fifteen real cars** are selectable at runtime from the 62 `RP_CarDynamics`
records in `gamedata\xt\racingphysics.bin` (T-007/E1g): the five original T-007
reference anchors plus the ten V1-audited batch-1 class-B cars
(`docs/work/verification/T-007-vehicle-batch1.md`).

| slug | record | id | drivetrain | mass | wheelbase |
| --- | ---: | ---: | --- | ---: | ---: |
| `corvette-zr1-stock` (default) | 37 | 1554942492 | RWD | 1600 kg | 2.652 m |
| `lotus-exige-cup260-stock` | 15 | 805568925 | RWD | 890 kg | 2.323 m |
| `dodge-challenger-stock` | 9 | 528964602 | RWD | 1700 kg | 2.981 m |
| `ford-focusrs-stock` | 50 | 2563977008 | FWD | 1400 kg | 2.787 m |
| `audi-r8v10-stock` | 55 | 2936683857 | AWD | 1600 kg | 2.635 m |
| `audi-tt-stock` | 10 | 553815980 | AWD | 1400 kg | 2.479 m |
| `ford-f100-offroad` | 13 | 641771883 | AWD | 1600 kg | 3.051 m |
| `ford-fr100-stock` | 77 | 4067498883 | RWD | 1350 kg | 3.233 m |
| `volkswagen-golfw12650-stock` | 17 | 967622623 | RWD | 1600 kg | 2.633 m |
| `ford-mustanggtr-stock` | 80 | 4248192450 | RWD | 1300 kg | 2.718 m |
| `dodge-viperacr-stock` | 33 | 1411916496 | RWD | 1500 kg | 2.507 m |
| `audi-s3-stock` | 2 | 345654945 | AWD | 1400 kg | 2.583 m |
| `ford-bronco-offroad` | 19 | 1025798142 | AWD | 1650 kg | 2.297 m |
| `nissan-skyliner34ztune-stock` | 46 | 2352181282 | AWD | 1600 kg | 2.687 m |
| `chevrolet-socalhhr-stock` | 74 | 3917320611 | RWD | 1350 kg | 2.622 m |

`cars/roster.json` is the committed selection (checked against the decoded
records: a wrong name/id/index is a hard failure). `tools/car_roster.py` decodes
**every** record with the T-005d extractor, gates it on the fields the physics
needs, and writes one `name<TAB>value` field list per selected car plus
`_work/e1-drive/cars.json` (all 62 records, their values and the gate result).
Nothing is invented: a record that failed the gate would be excluded with the
exact field and value, never patched.

Select at runtime with `?car=<slug>` in the page (there is also a car selector in
the page), or `--car <slug>` on the two node tools.

Each car also has **its own visual body**: `probes/car-parts/tools/build_all_manifests.py`
maps the record name to `\models\vehicles\<lowercased name>.model`, decodes the
pak entry, and builds a part manifest from it. `_work/car-parts/cars/index.json`
is the mapping evidence; `build_geometry.mjs` pins every manifest SHA-256, so a
regenerated or hand-edited manifest is a hard failure. The fifteen models are
distinct, and so are the fifteen body mesh hashes.

| slug | body model | parts | draws | textured | textures |
| --- | --- | ---: | ---: | ---: | ---: |
| `corvette-zr1-stock` | `corvette_zr1_stock.model` | 34 | 100 | 50 | 9 |
| `lotus-exige-cup260-stock` | `lotus_exigecup260_stock.model` | 23 | 88 | 48 | 9 |
| `dodge-challenger-stock` | `dodge_challenger_stock.model` | 31 | 104 | 42 | 7 |
| `ford-focusrs-stock` | `ford_focusrs_stock.model` | 31 | 115 | 37 | 7 |
| `audi-r8v10-stock` | `audi_r8v10_stock.model` | 29 | 84 | 47 | 8 |
| `audi-tt-stock` | `audi_tt_stock.model` | 39 | 100 | 52 | 7 |
| `ford-f100-offroad` | `ford_f100_offroad.model` | 24 | 78 | 34 | 7 |
| `ford-fr100-stock` | `ford_fr100_stock.model` | 23 | 71 | 33 | 8 |
| `volkswagen-golfw12650-stock` | `volkswagen_golfw12650_stock.model` | 26 | 92 | 43 | 8 |
| `ford-mustanggtr-stock` | `ford_mustanggtr_stock.model` | 21 | 101 | 55 | 7 |
| `dodge-viperacr-stock` | `dodge_viperacr_stock.model` | 30 | 83 | 48 | 7 |
| `audi-s3-stock` | `audi_s3_stock.model` | 37 | 99 | 49 | 7 |
| `ford-bronco-offroad` | `ford_bronco_offroad.model` | 23 | 82 | 25 | 6 |
| `nissan-skyliner34ztune-stock` | `nissan_skyliner34ztune_stock.model` | 32 | 96 | 46 | 7 |
| `chevrolet-socalhhr-stock` | `chevrolet_socalhhr_stock.model` | 26 | 85 | 64 | 8 |

### Vehicle batch 1 (15 cars)

The first ten V1-audited class-B cars are integrated without moving the five
original state anchors: Audi TT, Ford F100 OffRoad, Ford FR100, VW Golf W12,
Ford Mustang GTR, Dodge Viper ACR, Audi S3, Ford Bronco, Nissan Skyline R34 and
Chevrolet SoCal HHR. Each has its exact `.model` body/wheels, its own P52
texture pack (or the committed runtime-only reason), a measured 310 m and 29 m
run, a committed ghost on both courses, a 3-lap and free-roam run, and a restart
in the same wasm instance. The 15-car build and verification record is
`docs/work/verification/T-007-vehicle-batch1.md`.

The single geometry document grew from 45,374,377 B to **106,864,802 B**
(+135.5 %, ≈6.15 MB per added car). It is inside the declared 128 MiB batch-1
budget and the 15-car sprint capture passes, but the next ten cars would exceed
it; batch 2 must split one car chunk per slug before it ships (plan in the batch
record, §2.1).

External pins at report time: the portable suite is **44/45** (the one failure is
`prop-collision-v2` pinning the whole geometry file; its collider data is
unchanged) and the PoC checker is **20/23** (three hard-coded five-car totals in
`tools/check_e1_poc.py`). Both are owned outside this task; the exact pins are in
`docs/work/verification/T-007-vehicle-batch1.md` §6.

## Commands

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

# 0. one-time prerequisites (already produced by the T-007 gates)
& $node probes/render-packet/tools/build_packet.mjs
& $py   engine/verify_vehicle.py --skip-build        # objects + car.fields, no rebuild
& $py   probes/car-parts/tools/build_all_manifests.py # one real body per roster car (read-only input)

# 1. build the library module (185 reused T-005d objects + this slice's harness TU)
& $node probes/e1-drive/tools/build_module.mjs --force-objects

# 2. collision surface under the drive (physics provenance; kept hidden, not drawn)
& $py   probes/e1-drive/tools/extract_track.py

# 2b. real UV0 + static albedo texture export (P45/P47 rows + committed BC1 decode)
& $py   probes/e1-drive/tools/build_track_textures.py

# 2c. per-car material/texture resolution + car UV0 export (P52 record, read-only)
& $py   probes/e1-drive/tools/build_car_textures.py

# 2d. level-instance prop UV0 + 4 decoded BC1 images (P73a export, read-only)
& $py   probes/e1-drive/tools/build_level_instance_textures.py

# 3. static geometry (level packet + real level_inspect track visual + 5 car bodies + hidden collision)
& $node probes/e1-drive/tools/build_geometry.mjs

# 4. decode the car roster (every RP_CarDynamics record + one field list per car)
& $py   probes/e1-drive/tools/car_roster.py            # --list prints all 62

# 4b. measured course line + extended corridor survey (survey only, not a course)
& $node probes/e1-drive/tools/build_course.mjs                    # writes course.json
& $node probes/e1-drive/tools/build_corridor_survey.mjs           # survey.json + survey.html
& $node probes/e1-drive/tools/corridor_probe.mjs                   # per-car physical limit

# 5. derive all four sprint layouts from the measured data:
#    sprint.json = the default 310 m P48 course, sprint-short.json = the 29 m regression,
#    sprint-lap.json = the P61 loop-01 3-lap race, sprint-free.json = the P65/P68 free-roam basin
& $node probes/e1-drive/tools/build_sprint.mjs

# 6. scripted drive of every roster car twice, both sprint courses + respawn +
#    layout/band checks, telemetry series twice + input replay, 10 create/reset
#    rebuilds per car in one instance, one-instance telemetry and sprint restart,
#    packet validation, the extended-corridor survey/limit checks, the per-car
#    albedo/UV checks, the ghost replay reconstruction/store/delta checks and the
#    free-roam layout/run/containment/restart/prop checks and the level-prop
#    UV0/BC1 pack checks (2254 checks)
& $node probes/e1-drive/tools/verify_e1_drive.mjs      # --car <slug> for one car
& $node probes/e1-drive/tools/verify_e1_drive.mjs --write-ghosts  # regenerate the committed reference ghosts

# 7. headless Edge/WebGPU screenshots + console gate
& $node probes/e1-drive/tools/capture_browser.mjs                  # drive captures
& $node probes/e1-drive/tools/capture_browser.mjs --mode sprint    # 310 m: start/mid/checkpoint/finish per car
& $node probes/e1-drive/tools/capture_browser.mjs --mode sprint --course short  # 29 m regression
& $node probes/e1-drive/tools/capture_browser.mjs --mode lap       # ?course=lap: start/lap1/lap2/finish per car
& $node probes/e1-drive/tools/capture_browser.mjs --mode free      # ?course=free: spawn/mid/prop/reset per roster car
& $node probes/e1-drive/tools/capture_browser.mjs --mode map       # ?map=amboy: start/checkpoint/mid/finish
& $node probes/e1-drive/tools/capture_browser.mjs --mode props     # roster cars x tick-120/near-field truck/free-prop/sprint/lap
& $node probes/e1-drive/tools/capture_browser.mjs --mode collision-v2 --port 8802  # lap sign + free concrete pipe: approach/stopped/settled
& $node probes/e1-drive/tools/derive_sprint_exclusions.mjs         # measured 9-id 310 m driven-line exclusion artifact
& $node probes/e1-drive/tools/capture_browser.mjs --mode quality --label before --port 8802  # texture before (committed consumer)
& $node probes/e1-drive/tools/capture_browser.mjs --mode quality --label after  --port 8802  # texture after (sRGB + mips)
& $node probes/e1-drive/tools/capture_browser.mjs --mode survey    # ?survey=1 corridor label
& $node probes/e1-drive/tools/capture_browser.mjs --mode ghost     # 5-car ghost-visible frames + G toggle
& $node probes/e1-drive/tools/capture_browser.mjs --mode respawn   # respawn diagnostic
& $node probes/e1-drive/tools/capture_browser.mjs --mode telemetry # metric panel per car
& $node probes/e1-drive/tools/capture_browser.mjs --mode restart   # R on a finished sprint, roster cars
& $node probes/e1-drive/tools/capture_browser.mjs --mode telemetry-restart # R in telemetry, no reload
& $node probes/e1-drive/tools/capture_browser.mjs --mode audio    # gesture, 1500/3015/6000 RPM, mute

# 8. one-instance rebuild reproduction (10+ create/reset cycles, exact trap + heap/pool log)
& $node probes/e1-drive/tools/repro_reset.mjs --cycles 10
& $node probes/e1-drive/tools/repro_reset.mjs --cycles 20 --mode reset
& $node probes/e1-drive/tools/build_module.mjs --debug            # symbol-map build for wasm stacks
& $node probes/e1-drive/tools/repro_reset.mjs --debug

# 9. deterministic soak session (headless Edge/WebGPU): 5 simulated minutes,
#    drive -> sprint -> telemetry, e1_reset rebuild at every segment; two runs
& $node probes/e1-drive/tools/soak_browser.mjs --minutes 5 --runs 2
& $node probes/e1-drive/tools/soak_browser.mjs --minutes 5 --runs 2 --ticks-per-frame 1  # one tick per rAF

# interactive
& $node probes/e1-drive/tools/serve.mjs            # http://127.0.0.1:8801/ (keyboard sprint)
& $node probes/e1-drive/tools/serve.mjs --port 8801  # /?script=sprint&car=audi-r8v10-stock
                                                     # /?telemetry=1&car=audi-r8v10-stock
& $node probes/e1-drive/tools/serve.mjs --port 8802 --with-room --room-port 8811
                                                     # M1: page + unchanged net-mvp room service
                                                     # /?mp=1&host=1  and  /?mp=1&room=CODE

# 10. M1 two-browser multiplayer capture (game 8802, room 8811)
& $node probes/e1-drive/tools/capture_browser.mjs --mode mp --port 8802 --room-port 8811

# 11. M2/PWR2+PWR2a power-up capture (Mine/Shield/Repair/Nitro/Shock, two browsers)
& $node probes/e1-drive/tools/boost_model_tests.mjs
& $node probes/e1-drive/tools/powerups_model_tests.mjs
& $node probes/e1-drive/tools/capture_browser.mjs --mode mp-powerups --port 8802 --room-port 8811
```

Outputs go to `_work/e1-drive/` (module, geometry, track, roster, per-car packets
and states, screenshots, evidence) and `_work/logs/e1-drive/` (build/verify/Edge
logs). None of it is committed.

## Multiplayer (M1) — two browsers, one 310 m race

Status: M1 gate, 7 November 2026. Two browser pages join a room through the
unchanged `probes/net-mvp/server.mjs` room service, both drive the real wasm car
on the measured 310 m P48 course, see each other through the ghost draw pipeline,
and finish with one shared result. This is an original project room/snapshot
layer, not a retail network protocol claim.

### URLs and launcher

| role | URL |
|---|---|
| host | `http://127.0.0.1:8802/?mp=1&host=1&script=sprint` (the lobby shows the allocated code) |
| guest | `http://127.0.0.1:8802/?mp=1&room=CODE&script=sprint` |

`?room=CODE&host=1` is accepted: the host creates a room and the lobby displays
the **allocated** code; room codes are not reservable. `?name=`, `?car=`,
`?mpServer=ws://host:port/ws` and `?mpPace=` (capture-only scripted pace) are
optional. The default room endpoint is `ws://<page-host>:8811/ws`.

```powershell
# one process: game server + unchanged room service
& $node probes/e1-drive/tools/serve.mjs --port 8802 --with-room --room-port 8811
# or two terminals
& $node probes/e1-drive/tools/serve.mjs --port 8802
& $node probes/net-mvp/server.mjs --port 8811
# two-browser headless proof
& $node probes/e1-drive/tools/capture_browser.mjs --mode mp --port 8802 --room-port 8811
```

The game server now serves `/net-mvp/` (the dependency-free client/protocol
modules) and `/race-rules/` (the M1 rules modules) read-only. Both paths are new
routes in `tools/serve.mjs`; `probes/net-mvp/**` and `probes/race-rules/**` are
unmodified.

### Session flow

1. Each page loads the engine and the measured course **before** opening the room
   socket (the 45 MB geometry parse would otherwise starve the room heartbeat).
2. Host `?mp=1&host=1` creates a room and becomes slot 1; guest
   `?mp=1&room=CODE` joins slot 2. The lobby shows the roster, slot, host marker,
   ready state, room code and connection status.
3. Host presses start only when every connected player is ready; the room
   service enforces the same rule. `room.started` gives both pages the same seed
   and tick rate.
4. Both pages start the local wasm engine on the provisional race-rules grid
   (2.2 m spacing, two per row; project-specific, not a retail start table) and
   the 90-tick countdown. Each sends its **60 Hz input** and **20 Hz state**
   through the room service.
5. Host runs `RaceSession` over both cars for ordered checkpoints, finish
   validation and the authoritative result; the host's own car is the only
   host-simulated physics body. The remote car is drawn from the owner's 20 Hz
   state (peer-state relay) — see the limit below.
6. At the finish each page sends `client.finished {tick, hash}`. The room's
   `room.finished` broadcast is turned into the same pure result table on both
   pages; the overlay shows positions, ticks and race times. The host's
   `RaceSession` validation is recorded in the HUD/evidence.

### Authority, sync and correction

- **Host result authority.** The host owns the rules session, validates ordered
  gates/finish and records the session hash; it keeps ticking after its own
  finish until the guest's finish is observed (bounded) so the validation is not
  lost to the 20 Hz relay.
- **Snapshot shape.** `{tick, position:[x,y,z], quaternion:[x,y,z,w], speed}`
  from the E1 state; the sender builds the quaternion from the engine's body
  axes. The room service relays it unchanged.
- **Remote rendering.** One remote slot reuses the existing ghost draw path:
  the already-uploaded car mesh, a second set of node matrices, a translucent
  cyan diagnostic tint and a `REMOTE · … · no collision` tag. The ghost replay
  itself is disabled in an MP page (one slot).
- **Interpolation.** `sampleRemote(playerId, renderTick - 3)` lerps position and
  slerps the quaternion; it never extrapolates. The remote wheel spin is static
  because the E1 state snapshot has no wheel angle (labelled, not guessed).
- **Correction.** A remote-display delta above **0.5 m** or **0.25 rad** is a
  counted hard set; a smaller delta blends over **3 frames**. The local engine
  is never teleported. The HUD shows the correction/hard-set/blend counts.
- **Finish/result.** `buildMpResult({layout, room, results})` is a pure function
  of the committed layout and the room finish broadcast. Both clients render the
  same rows/hash. The winner is the lowest validated finish tick; ties share a
  position. A missing/invalid tick is an explicit DNF row, never a guessed time.
- **Disconnect/reconnect.** The net-mvp client auto-reconnects with its 24-byte
  resume token inside the 30 s window; the page shows a labelled
  `RECONNECTING` state, the room keeps the slot, and the same player id/slot/host
  returns. A dropped remote is tagged `REMOTE · … · RECONNECTING`, with no
  guessed pose.

### M1 scope and limits

- **One map, one car for both bodies.** The session loads the host's car; the
  guest's lobby car pick is metadata (the guest must open with the same
  `?car=`). Power-ups and AI are M2.
- **WebSocket loopback room service**, not UDP/WebRTC. No STUN/TURN, no NAT
  test, no TLS/auth/accounts/database; the room code is a lookup key.
- **Peer-state remote authority.** The host runs the authoritative rules/result
  and its own physics; it does not run a second physics body for the guest. The
  guest's 20 Hz state is what the host validates and relays. The host result is
  therefore host-validated, but a peer could report a false pose; M1 has no
  anti-cheat claim.
- **20 Hz relay.** The host's RaceSession can observe the guest finish one or
  two 60 Hz ticks before/after the guest's own report; the displayed table uses
  the room's finish ticks, and the validation delta is recorded.
- **Late join after start is rejected** by the room service; host migration is
  not implemented (the URL role stays fixed).
- **Single remote slot.** The ghost pipeline's one extra draw set is used for
  the M1 opponent; a second remote slot is M2 work.
- **Same-machine clocks.** Both pages share one machine clock; cross-machine
  clock skew and real WAN behavior are not tested.
- **No full-game claim.** This is one measured River course, one 310 m sprint,
  one opponent slot and no power-ups.

Files added/changed: `web/mp-client.js` (room wrapper + pure result builder),
`web/mp-remote.js` (interpolation/correction + nine node matrices), the MP hooks
in `web/app.js`, `web/index.html`, `web/style.css`, `web/sprint-script.js`
(optional scripted-pace constants), `tools/serve.mjs` (read-only `/net-mvp/` and
`/race-rules/` routes plus `--with-room`), and `tools/verify_e1_drive.mjs` /
`tools/capture_browser.mjs` (Node protocol gate and `--mode mp`). The full
verification record is `docs/work/verification/T-007-multiplayer.md`.

## Power-ups (M2/PWR2+PWR2a) - Mine, Shield, Repair, Nitro, Shock

Status: M2 first slice, 7 November 2026. `?powerups=1` (multiplayer only,
default off) adds a host-authoritative power-up world on top of the M1 race.
The full record is `docs/work/verification/T-007-powerups.md`.

| Item | Behaviour |
|---|---|
| integrated types | **Bomb/Mine, Shield, Repair, Nitrous (Nitro), Shock** (Shunt/Blindfire/Barge/projectiles deferred) |
| placement | six **provisional** items on the measured 310 m arcs 40/90/140/190/240/280 m cycling Bomb/Shield/Repair/Nitrous/Shock/Bomb; PWR3 owns real placement |
| collection | host proximity against the recovered `PickupRadius=2.0 m`; one inventory slot; `pickup-rejected inventory-full` |
| values | Bomb `Radius 1.0 / Outer 3.5 / Damage 100 / Lifespan 60 / Prime 0.3 / PlaceBehind 5`; Shield `Health 50 / Lifetime 6`; Repair `AmountToRepair 400`; Nitro `300 m/s²`, 0.5 s force window, 1.3 s duration, exact PWR1 Hermite target (class A, 55 m/s project cap); Shock exact PWR1 curve target, 10 mph floor, `Inner 7 / Outer 14 / Lifetime 1.5 / Damage 100`; deactivate `0.6 s` — all from `_work/powerups/powerups.json` |
| use | guest sends a use intent; the host validates and broadcasts sequenced events (`mine-placed`, `mine-armed`, `mine-detonated`, `mine-expired`, `shield-activated`, `shield-absorbed`, `shield-broken`, `repaired`, `nitro-activated`, `shock-activated`, `effect-expired`, `damage`, `wrecked`, `respawn`, `pickup*`, `use-rejected`) |
| damage | 100 HP **diagnostic** pool; full Bomb damage inside `Radius`, typed `mine-near-miss` between `Radius` and `OuterRadius`, no damage outside `OuterRadius`; Shock applies its recovered 100 damage inside `OuterRadius` |
| nitro / shock | host-sequenced; each page applies the event to its **own** car through `e1_boost_queue` **before** `C_Scene::Simulate` (no post-tick velocity/pose write); the host does not simulate the guest body |
| wreck/respawn | `wrecked` at 0 HP, labelled 1.0 s diagnostic delay, `respawn` at the R1 `respawnTargetForGate(lastPassedGate)` target; the car is rebuilt through `respawnAt()` |
| HUD | one-slot icon/letter + type, health, shield capacity/remaining seconds, active Nitro/Shock timer/status/target, last six sequenced events; icon is a labelled diagnostic glyph (retail `perk_icons` binding not recovered) |
| effects | bounded octahedron marker pass (16 slots, ghost pipeline, no new buffer/texture): pickups, mines, shield bubbles and Nitro/Shock owner markers |
| control channel | `/_powerups/relay`, an ordered in-memory HTTP relay beside the unchanged `probes/net-mvp` room service |

The page must be served by `tools/serve.mjs`; it now serves
`/_work/powerups/powerups.json`, `/powerups/engine.js` and `/_powerups/relay`.
A server process started before this change must be restarted so it serves the
new routes.
The new files are `web/powerups.js` (host model + client reducer),
`web/boost-model.js` (exact PWR1 Hermite targets + queue model),
`tools/powerups_model_tests.mjs` (79 Node checks), the boost tests below and the
capture mode. Deferred types stay typed in `POWERUP_DEFERRED`; no damage, radius,
timer or projectile rule is invented. No retail/full-game claim.

### Nitro and Shock (M2a)

Nitro and Shock are host-sequenced engine effects, not input multipliers or
post-tick writes:

- `e1_boost_queue(kind, startTick, ticks, targetMps, magnitude, dx,dy,dz)` and
  `e1_boost_state()` are exported by the wasm module. `e1_step` applies the
  force **before** `C_Scene::Simulate`; `e1_create`/`e1_reset` clear the queue.
- Nitro: `300 m/s² * mass * adjust` along horizontal body +Z, 0.5 s (30-tick)
  force window inside a 1.3 s (78-tick) effect. The target is the exact PWR1
  Hermite value at the fire speed: **52.758963 m/s** at the 24.73 m/s sprint
  speed for class A (B/C/D 50.121015 / 47.483066 / 44.845120), capped at
  **55 m/s** by a project safety value. The car's retail class is not recorded
  by the e1 roster, so M2a uses class A and labels the choice in every event.
- Shock: `E_FAKE_SPEED_BRAKE`-shaped force to the exact Shock curve target
  (**19.995236 m/s** at the 24.73 m/s sprint speed) with the **10 mph** floor,
  `Inner 7 / Outer 14 / Lifetime 1.5 s / Damage 100` from PWR1.
- Authority: the host validates the use, sequences `nitro-activated` /
  `shock-activated` (target, target speed, ticks, magnitude, fire speed, class
  table) and emits `effect-expired`. Each page applies the event to its own car
  at `localTick + delayTicks - 1`; the host does not simulate the guest body.
- Measured wasm (BOOST1 fixture, pre speed 25.1475 m/s, class-A target
  53.21259 m/s): 57.822 m/s at 0.5 s, 51.370 at 1.3 s (**+18.294** over the
  33.076 baseline), peak 58.608 (**+25.532**), 0 NaN, deterministic in two
  fresh instances. Shock at 20.116619 m/s measured 18.283 at 1.3 s
  (**-14.793**).
- Two-browser capture: host Nitro 10.15 → 48.49 m/s peak, guest Nitro
  12.51 → 48.82; both Shock directions with 100 damage; console 0/0, relay 0
  dropped, identical host/guest event counts. Screenshots
  `browser-mp-powerups-nitro-*.png` / `…-shock-*.png`.

The Shock hit test is a documented project planar distance inside the recovered
`OuterRadius`; PWR1 does not serialize the retail hit/falloff rule. Shunt, Barge,
Blindfire and projectiles remain deferred with typed reasons. Full record:
`docs/work/verification/T-007-powerups.md` section 10 and
`docs/work/analysis/e1-drive-slice.md` section 35.

```powershell
& $node probes/e1-drive/tools/boost_model_tests.mjs
& $node probes/e1-drive/tools/powerups_model_tests.mjs
& $node probes/e1-drive/tools/capture_browser.mjs --mode mp-powerups --port 8802 --room-port 8811
```

The capture grants/uses items through the page's capture-only `window.__powerups`
API: host/guest Nitro, host/guest Shock, host mine placement, guest
wreck/respawn, guest shield absorb/break and guest repair. It records the
identical host/guest event counts, HUD text, marker-pass stats, relay stats,
console and screenshots under `_work/e1-drive/browser-mp-powerups-*.png`.

## The module API

`native/e1_drive_lib.cpp` compiles into the same 186-object closure as the T-005d
harness, with the batch harness replaced by a library ABI:

| export | meaning |
| --- | --- |
| `e1_create(level, levelLen, fields, fieldsLen, x, z, heading)` | decode/validate the car field list, load the level, build the scene, place the car at the ground-probed `(x,z)` with `heading`, run the 180-tick settle. Returns 1/0. **The field list is the car selector**: one `cars/<slug>.fields` per roster car, decoded from its `RP_CarDynamics` record. |
| `e1_reset()` | rebuild scene + car and re-run the settle; `tick` goes back to 0. Rebuilds the same instance in place; the scene creates and destroys its own scheduler groups, so it can be called repeatedly (measured 10–20 times per instance, `T-007-reset-fix.md`). |
| `e1_set_input(throttle, brake, steer, handbrake)` | the next `e1_step` uses these `CarControls`. |
| `e1_step()` | exactly one `C_Scene::Simulate(1/60)` + `PhysicsTimer::UpdatePhysicsTimer()`. |
| `e1_get_state()` | JSON snapshot of this tick: position, the three body axes, velocity, angular velocity, ground-relative speed, four wheel records (contact, suspension, position, spin, surface, userData, ground normal), `finite`, `anyContact`, and the input actually applied. |
| `e1_info()` | car name, XT handle id, ground/start Y, dt, settle-tick count, current tick, reset count, `sizeof(CarDynamicsXt)`. |
| `e1_engine_rpm()` | the live `RacingPhysics::Car::Engine().RPM()` as a float; `-1` before a world is ready. This is the value the retail audio graph publishes as `RPMInput` (`BaseMessageHandler.cpp:1940/1970`); the page's engine audio consumes it once per frame. |
| `e1_boost_queue(kind, startTick, ticks, targetMps, magnitude, dx, dy, dz)` | queue one engine-integrated effect for a receiver tick: `1` Nitro (forward force while below target, 30-tick force window), `2` brake (velocity-opposed force while above target), `3` one-shot impulse. Applied **before** `C_Scene::Simulate`; cleared by `e1_create`/`e1_reset`. |
| `e1_boost_state()` | JSON read-back of the boost queue: `seq/kind/startTick/ticks/remaining/applied/forceTicks/forceN/targetMps/magnitude/lastSpeed/queued/effects[]` for the HUD and verifier; not on the physics path. |
| `e1_ground_probe(x, z)` | the same fill+trace the wheel uses, as JSON: hit, height, normal, cached triangle count. Used to prove the spawn instead of guessing it. |
| `e1_diag()` | diagnostic snapshot of the live world: scene/body/car pointers, the scene's scheduler group handle and policy, and the scheduler pool (size, free-list head, global counters, per-group queued/executing/dependencies/next/event). Used by `tools/repro_reset.mjs` and the verifier to prove rebuilds do not leak groups; not on the physics path. |
| `e1_last_error()` | the message behind a 0 return. |

Floats are printed with `%.9g` (round-trip exact for binary32). A non-finite
value is emitted as the string `"NaN"`/`"Inf"` and the tick's `finite` flag goes
0, so the JSON never becomes unparseable and a NaN can never hide.

Measured: build 1,004,335 B, deterministic across two links; `e1_create` including
the 180-tick settle takes 15–37 ms in node for the roster cars, 300 scripted ticks
take 24–34 ms. The library takes no per-car code path: the XT record alone decides
mass, inertia scales, geometry, suspension, steering, brakes, engine, gearbox,
tyres and drivetrain, and `e1_info().car` reports which record it decoded.

## Packet adapter

`web/packet-adapter.js` is shared by the browser and the node verifier, so the
packet the browser renders is produced by the same code the verifier validates.

- `draws[]`: 22 committed level instances (world-space, identity transform) + the **real
  River track visual** (394 `level_inspect`/track-coverage direct draws, each with
  its own UV0 and, for 297 of them, a static `g_tAlbedo` texture id) + that car's
  own draw ranges (100 / 88 / 104 / 115 / 84).
  Every car draw carries its manifest `partId`/`partKind`, `wheelPart`, `spins`,
  `nodeId`, a labelled `diagnosticColour` and — for the 50 / 48 / 42 / 37 / 47
  draws P52 resolved to a static image — a `textureId`, a `textureBinding` record
  and `uvFlipU:true` / `uvFlipV:false`. The other 267 car draws keep the committed
  P52 reason.
  Every track draw keeps its source
  index range and is labelled `trackVisual:"asset-reader-direct-draws"`.
- `meshes[]`: exactly three — the level mesh, the real track visual (one merged
  mesh, 96,494 vertices / 57,133 triangles, 192,988 UV0 values) and the selected
  car's own body mesh with its real UV0 stream (33,048 / 32,136 / 28,365 / 32,267
  / 31,429 vertices). One body per packet keeps the upload bounded (3 uploads,
  ~3.95–4.08 MB with the UV buffers) instead of growing with the roster. The
  collision surface is **not** in `meshes`.
- `textures[]` / `texturePack`: 136 decoded static track albedo RGBA bitmaps
  (439,360 B), the 4 decoded level-prop BC1 images (8,192 B) and that car's own
  7–9 P52 images (2.58–5.00 MB), their `block:index` / `shared:index` identity
  and hashes. The producer metadata still describes the source data (`repeat`,
  linear, mip0, `rgba8unorm`, raw decoded texels); the consumer's GPU sampling
  policy is separate and documented on `TEXTURE_SAMPLER`: `rgba8unorm-srgb`,
  a derived full mip chain, trilinear filtering and anisotropy 8 where the
  adapter supports it (the capture adapter reports 1). The car pack also carries
  `uvConvention` (`u' = 1 − u`, `v' = v`) with its pixel evidence; the track and
  level packs keep the raw stream. See
  `docs/work/verification/T-007-texture-quality.md`.
- `physicsSurfaces[]`: one hidden collision surface (`visible:false`,
  `physicsOnly:true`, 230 vertices / 381 triangles) carried for provenance only;
  it is not uploaded and not drawn.
- `nodes[]`: **nine** nodes — `e1.car.body` (all non-wheel parts) plus, per wheel
  corner, a `.spin` node (tyre/rim/brake disc) and a `.static` node (brake
  caliper). Each car draw is owned by exactly one node; static level/track draws
  need no node.
- `updates[]`: one entry per engine tick: the occlusion-resolved chase-orbit
  camera (with its per-tick request/hit record), the body matrix
  (three body axes as columns + position) and eight wheel matrices. The wheel
  matrix is `body × MdlDat rest translation × Rx(angle)`; the angle integrates
  `e1_get_state().wheels[].angular` at the fixed 1/60 s step. The caliper node is
  `body × rest` only. Every tick is hashed with the committed canonical form.
- `draws[].bounds` for the car are recomputed from the mesh's local AABB at the
  tick-0 pose, so the reference frame's bounds are real.
- `diagnostics.extras.track`: the real track visual label
  (`asset-reader-direct-draws`), 394 draws / 96,494 vertices / 57,133 triangles,
  the seven source sections with their pinned reference SHA-256 values, the
  UV0/texture coverage (297 textured / 2 runtime-only / 95 no-binding-row, 136
  textures / 439,360 B) and the measured collision coverage (3,845 covered /
  2,088 no-draw triangles).
- `diagnostics.extras.collisionSurface`: the hidden collision surface
  (`visible:false`, `physicsOnly:true`, 381 triangles) and where it came from.
- `diagnostics.extras.drive.car`: the car this timeline describes (name, record
  index/id, drivetrain, mass, field-file SHA-256) **and the real body it draws**
  (`bodyMesh`, `bodyManifest`, `bodyManifestSha256`, `bodyVertexCount`,
  `bodyDrawCount`, `bodyPartCount`, plus the model pak path and SHA-256).
- `diagnostics.extras.parts` / `.wheels`: part/draw/node counts, that car's
  manifest (path, SHA-256, model pak path, tyre proof tier, ambiguous wheel
  draws), the textured-draw/texture/UV counts and draw classes, the rest-pose/spin
  source and the diagnostic-colour label.
- `diagnostics.extras.textures`: the uploaded level/track pack, this car's own
  P52 pack (count, bytes, manifest, scene report, sampler, `uvConvention`, draw
  classes) and the bounded total the packet actually uploads.
- `diagnostics.extras.wheels`: the four wheel corners spin about element-local
  `+X`; physics wheel records are assigned to the nearest manifest wheel
  translation in body-local space.

The camera is an orbit camera behind the car; yaw follows the car with a fixed
per-tick lag, so it is a pure function of the tick sequence (no wall clock). Its
distance is collision-limited: every tick casts the segment from the car's aim
point to the desired eye against the **visible static geometry** (level props +
real track visual, 67,441 triangles) and places the eye 0.4 m in front of the
first hit. Pull-in is immediate, push-out is eased by 0.08 of the gap per tick.
Each update carries `camera.occlusion { requestedDistance, distance, blocked,
nearField, hitDistance, hitMesh }`, and `diagnostics.extras.camera.occlusion`
states the rule, the occluder and the parameters. `?camdist`/`?camheight`/
`?camyaw` still change the requested orbit and are resolved the same way. The
hidden `physicsSurfaces` and the car body are not occluders, and a hit closer
than 3.4 m is a `nearField` prop crossing (the car is inside the prop) that the
camera holds instead of collapsing into the car.

## Sprint rules

The page is a **point-to-point sprint**, not a lap. Two measured courses are
derived and re-derived by the verifier, so no coordinate is typed in:

- **default `310m`** — the P48 collision-only path (310.395 m, 1,245 samples at
  0.25 m). Gates sit on measured samples, perpendicular to the local 5 m tangent;
  the finish is 10.24 m before the measured end. `_work/e1-drive/sprint.json`.
- **`?course=short`** — the original 29 m P37 straight on the spawn corridor.
  `_work/e1-drive/sprint-short.json`.

| gate | 310 m arc | 310 m point | heading | width | coverage |
| --- | ---: | --- | ---: | ---: | --- |
| start | 0.000 | (−88.0, 1050.0) | 0.7674 | 6 m | 61/61 drawn + 61/61 collision |
| checkpoint 1 | 100.108 | (−18.50, 1122.05) | 0.7674 | 6 m | 61/61 + 61/61 |
| checkpoint 2 | 200.075 | (42.83, 1200.56) | 0.5839 | 6 m | 61/61 + 61/61 |
| finish | 300.160 | (97.53, 1284.18) | 0.6222 | 6 m | 61/61 + 61/61 |

The 310 m course is 1204/1204 samples covered (100 %, max surface delta 0.929 mm),
and the verifier independently re-measures **7 stations × 1202 samples = 8,414**
car-width points (envelope 1.676 m + 0.30 m margin): 8,414/8,414 drawn and
physical. The engine's own `_e1_ground_probe` agrees with the layout at every gate
and every 10th sample (125 probes, max delta < 1 cm).

The 310 m sprint now binds the **P74 base V2 `roadside` layer** additively after
the engine tick: profile 553 of 651 colliders, minus **9 measured driven-line
exclusions** = **544 active**. The exclusions are derived from the committed
reference ghosts (`tools/derive_sprint_exclusions.mjs`) and are the only active
roadside colliders the committed scripted line actually grazes; all five state
sequences and finish ticks are unchanged and the run has 0 contacts. The four
measured on-course arcs stay mapped but inactive (the same P66/P74 policy); the
other 544 colliders — including the visible pipes, containers, signs and poles
away from the driven line — are solid. `run.json` carries the ids, arcs and
content hash of the exclusion set. The browser sprint capture
(`--mode sprint`) also matches 20/20 node state hashes and finish times, console
0.

| gate | 29 m x | width | coverage |
| --- | ---: | ---: | --- |
| start (spawn line) | −88.00 | 6 m (z 1047…1053) | 61/61 drawn + 61/61 collision samples |
| checkpoint 1 | −78.25 | 6 m | 61/61 + 61/61 |
| checkpoint 2 | −68.75 | 6 m | 61/61 + 61/61 |
| finish | −59.00 | 6 m | 61/61 + 61/61 |

Short-course rule: a column is covered when every 0.1 m sample across the spawn
corridor (z = spawn z ± 3 m) has **both** a real `block56/node289` triangle over
it and a collision triangle under it. The fully covered segment runs from the
spawn to **x = −57.00**; the finish sits 2 m before that.

| rule | value |
| --- | --- |
| countdown | 90 ticks (1.5 s, labels 3 / 2 / 1), input held at zero; timer starts at GO |
| timer | engine ticks from GO at 60 Hz; keeps running across a respawn, freezes on the finish |
| gate order | checkpoints count only in index order; a finish before the last checkpoint is recorded as `finish-blocked` |
| progress | 310 m: arc of the nearest point on the measured polyline; 29 m: x against the spawn corridor |
| respawn | 310 m: > 1 m below the measured ground at the car's arc, 30 airborne ticks, or outside the ±6 m band; 29 m: spawn ground and ±3 m corridor |
| respawn target | last passed checkpoint, at its gate point and measured heading |
| best time | per car and per course: `e1-drive.sprint.best.v2.310m` / `…v2.short`; only a faster finish overwrites |
| restart | `R` resets the engine, timeline, timer and gate progress; the best time is kept |

## Three-lap race (`?course=lap`)

The lap course is derived from the committed P61 artifact
`_work/lap-search/loops.json` (`loop-01`, component 5): 902 samples at 0.25 m,
222.040 m, line at the first sample perpendicular to the 5 m seam tangent. The
spawn is **on the loop**, because loop-01 is separated from the old spawn
component by a measured 1.118 m wall. `_work/e1-drive/sprint-lap.json` is pinned
to the loops file and canonical hash; a different artifact is a hard failure.

| rule | value |
| --- | --- |
| countdown | 90 ticks, input held at zero; timer starts at GO |
| lap gate | one physical start/finish line, 4 m wide, crossed forward three times |
| lap count | a crossing counts only after `lapDistance` reaches the next full lap; neither the spawn nor a respawn on the line counts |
| timer | engine ticks from GO; lap times are race-clock deltas; best lap is the minimum |
| respawn | outside the declared ±1.25 m band, or the P48 airborne/ground rules; target is the current lap line |
| props | P74 V2 `all-visible` layer (651 colliders) applied additively after the engine tick; loop-01 is clear of them (0 contacts) |
| restart | `R` resets engine, timeline, lap counter and timer |

Measured scripted races (`_work/e1-drive/run.json` → `sprint.lapCourse`):

| car | lap 1 | lap 2 | lap 3 | total | finish tick | max lateral | min steep-face |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Corvette ZR1 | 29.000 | 28.550 | 28.550 | **86.100 s** | 5256 | 0.784 m | 2.056 m |
| Lotus Exige Cup260 | 29.117 | 28.583 | 28.583 | **86.283 s** | 5267 | 0.810 m | 2.063 m |
| Dodge Challenger | 29.050 | 28.550 | 28.517 | **86.117 s** | 5257 | 0.854 m | 2.040 m |
| Ford Focus RS (FWD) | 29.167 | 28.533 | 28.550 | **86.250 s** | 5265 | 0.984 m | 1.949 m |
| Audi R8 V10 (AWD) | 28.650 | 28.400 | 28.417 | **85.467 s** | 5218 | 0.812 m | 2.041 m |

Every car: three ordered crossings, no respawn, wheel contact on every tick, 0
NaN, a bit-identical replay with the rules off, a deterministic state-sequence
anchor and a valid packet timeline. The `all-visible` prop layer is active and
inert on the clear loop (0 contacts). The page checks the same run in the browser
(`capture_browser.mjs --mode lap`).

## Free roam (`?course=free`)

A fourth layout on the **P65/P68 measured spawn basin**: the committed spawn
`(-88, 1050)` at heading `pi/2`, no countdown, no gates, no finish, no lap
counter and no corridor band. `_work/e1-drive/sprint-free.json` is derived from
the pinned P65 `regions.json` (R04, 9,689.5 m², 100 % drawn) and the P74
R04-V2 spawn region; a different basin artifact is a hard failure.

| rule | value |
| --- | --- |
| containment box | `x -108.5…5.0, z 1027.5…1164.0` (measured spawn component) + 2.0 m documented margin |
| reset reasons | outside the box, > 1 m below the local measured ground, or 30 airborne ticks |
| reset target | the committed spawn `(-88, 1050)` at `pi/2` — never a corridor point |
| timer | a session clock (engine ticks / 60); no finish, no best time, no ghost |
| props | **P74 R04-V2 `all-visible` manifest, 447 colliders** (file + content SHA-256 pinned) |
| restart | `R` rebuilds at the spawn and restarts the clock |
| ground | 2 m collision-mesh lattice over the box: 3,418 measured + 515 filled cells (recorded) |

The visible-prop layer takes a **manifest/profile/hash pin set** per course: the
lap uses the base V2 manifest all-visible (**651** colliders), the 310 m sprint
uses the same base V2 manifest roadside (**553**, minus the 9 measured
driven-line exclusions = **544** active), and free roam uses
`_work/free-roam-prop/colliders-r04-v2.json` (variant `free-roam-r04`, **447**
colliders, content `sha256:663e2570…`). No manifest was regenerated. The spawn is
clear (0 contacts); a 31 m/s head-on into the R04 wreck `level.instance.00` stops
on the near face (max penetration 0.073 m, residual 0), a 31 m/s hit on a 0.02 m
container panel does not tunnel, and a 31 m/s head-on into the free concrete pipe
`draw.95.component.010` stops in the pipe cluster (no tunnelling). The 310 m
exclusion set is derived from the committed reference ghosts and recorded with
its 9 ids and arcs, never silently dropped.

The scripted free drive (`?script=sprint&course=free`) is a speed-capped,
tick-only diagnostic manoeuvre (no path follower, no route file). Five roster
cars, 401 ticks each:

| car | travel | max speed | prop contacts | respawns | state sequence hash |
| --- | ---: | ---: | ---: | ---: | --- |
| Corvette ZR1 | 24.635 m | 7.067 m/s | 0 | 0 | `bede912e…05a3b920` |
| Lotus Exige Cup260 | 22.710 m | 6.273 m/s | 0 | 0 | `f198bd7b…8f383f8e` |
| Dodge Challenger | 25.594 m | 7.044 m/s | 0 | 0 | `ee6018bf…6a0f2369` |
| Ford Focus RS (FWD) | 23.344 m | 6.795 m/s | 0 | 0 | `f590e4ad…bc27390b` |
| Audi R8 V10 (AWD) | 29.198 m | 7.076 m/s | 0 | 0 | `4d4a4323…79ade5ca` |

All five reference cars: contained, wheel contact on every tick, 0 NaN, replay-identical, a
pinned anchor and a valid packet. The real-engine containment test drives the
derived lane `(-24.5, 1037.5)` east and resets at `x = 7.076` on tick 199
(`outside-bounds`), rebuilding **0.0053 m** from the spawn; `R` after 200 ticks
returns to the same spawn. The committed five-car browser capture (`--mode
free`) is 5 cars × spawn / mid / prop approach / reset, console 0, 0 assertions,
20/20 state hashes; the batch-1 record re-samples the Corvette on the same mode
with the 15-car artifacts (`browser-evidence-free.json`). Details, the 52 new
checks and the limits are in `docs/work/verification/T-007-free-roam.md`.

### Collision-v2 capture (`--mode collision-v2`, `?collisionprobe=…`)

A capture-only proof that the newly solid structures stop the real car. The page
starts the engine at a manifest-derived pose (`distanceMetres` outside the near
face of the target record), applies throttle until the additive layer reports a
contact and then brake + handbrake. There are no race rules, gates or timer.
Two targets: the reachable lap no-parking sign `draw.257.component.000` (6 m
approach) and the free concrete pipe `draw.95.component.010` (12 m approach).
Five cars × approach (tick 30) / stopped (tick 360) / settled (tick 420):
**30 captures, console 0, 0 assertions**, stopped sides 1.962–2.673 m (sign) and
2.712–2.875 m (pipe), speeds ≤ 0.064 m/s, settled pose moves < 0.05 m. The 44 m
building wall `draw.355` is on the upper terrace and cannot be reached from the
loop; its 31 m/s head-on (side 1.501 m, residual 0) is the resolver proof.
Screenshots `browser-<slug>-collision-{lap-sign,free-pipe}-{approach,stopped,settled}.png`,
evidence `browser-evidence-collision-v2.json`.

Modes: `/` = keyboard sprint on the 310 m course, `?course=lap` = keyboard
three-lap race on loop-01, `?course=free` = keyboard free roam on the R04 basin,
`?script=sprint` = deterministic scripted sprint (Stanley path follower while
running, brake after the finish), `?script=sprint&course=lap` = scripted lap
race, `?script=sprint&course=free` = scripted free drive,
`?course=short` = the 29 m regression course, `?script=sprint&sprintfall=1` =
diagnostic driver that steers off the course to exercise respawn,
`?script=drive` = the original 300-tick drive with no rules (kept for the
P23/P31/P36 evidence), `?collisionprobe=lap-sign|free-pipe` = a capture-only
manifest-derived collision probe (throttle until the additive layer contacts,
then brake + handbrake; no race rules or timer) and `?survey=1` = the label for the drawn
extended corridor (below; it changes no gate, timer or result). Rules never touch
physics: the verifier records each scripted sprint's input sequence, replays it
into a fresh module with the rules switched off, and requires every state hash
to match.

Measured scripted sprints on the default course (`_work/e1-drive/run.json` →
`sprint.cars`):

| car | finish | tick | checkpoint 1 | checkpoint 2 | max speed | max lateral | state sequence hash |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Corvette ZR1 | **14.650 s** | 969 | 5.700 s | 9.950 s | 24.73 m/s | 0.59 m | `da7e14f1…f9a553` |
| Lotus Exige Cup260 | **14.767 s** | 976 | 5.783 s | 10.067 s | 24.69 m/s | 0.61 m | `83f05df4…92367e` |
| Dodge Challenger | **14.917 s** | 985 | 5.950 s | 10.233 s | 24.65 m/s | 0.79 m | `accf125a…6ac8210a` |
| Ford Focus RS (FWD) | **15.217 s** | 1003 | 6.267 s | 10.550 s | 24.63 m/s | 0.85 m | `1094698d…d9f2063f` |
| Audi R8 V10 (AWD) | **14.150 s** | 939 | 5.183 s | 9.450 s | 24.81 m/s | 0.70 m | `0b32413d…f14b5ca` |

Every car: 2/2 checkpoints in order, no respawn, wheel contact on every tick, 0
NaN, a bit-identical replay with the rules off, and a restart in the same wasm
instance that reproduces the finish tick, time and every state hash. Among the
five reference cars the AWD Audi is fastest and the FWD Focus slowest, as the
unchanged physics predicts.

The ten batch-1 cars also finish the same 310 m script (finish time / tick):
Audi TT 15.483 s / 1019, Ford F100 OffRoad 14.817 s / 979, Ford FR100
14.500 s / 960, VW Golf W12 14.533 s / 962, Ford Mustang GTR 14.800 s / 978,
Dodge Viper ACR 14.517 s / 961, Audi S3 15.250 s / 1005, Ford Bronco
15.350 s / 1011, Nissan Skyline R34 14.100 s / 936, Chevrolet SoCal HHR
14.767 s / 976. Their state hashes, ghost records, lap/free runs and per-car
proof are in `docs/work/verification/T-007-vehicle-batch1.md`.

The 29 m regression course keeps the P37 values exactly:

| car | finish | tick | checkpoint 1 | checkpoint 2 | state sequence hash |
| --- | ---: | ---: | ---: | ---: | --- |
| Corvette ZR1 | **2.800 s** | 258 | 1.683 s | 2.317 s | `fdd893bd…e62622` |
| Lotus Exige Cup260 | **2.850 s** | 261 | 1.733 s | 2.350 s | `c9b17397…b52dfc` |
| Dodge Challenger | **3.000 s** | 270 | 1.783 s | 2.450 s | `438e2e12…e12684` |
| Ford Focus RS (FWD) | **3.267 s** | 286 | 1.967 s | 2.683 s | `cc911ea3…2af937` |
| Audi R8 V10 (AWD) | **2.283 s** | 227 | 1.317 s | 1.850 s | `d52d4b8f…44dea` |


## Ghost / rival replay (`G`)

The page can replay one completed run as a **ghost**: your fastest clean run on
this car and course, or — before you have finished — the **committed deterministic
reference trace** (the scripted Stanley follower's own run, labelled as such). The
ghost is a replay, not an AI opponent: it never steps the engine, never collides,
never writes a physics value, and is not a packet field.

- `G` toggles it; `?ghost=1` shows it from the start. It is **off by default**, so
  the console/hash gates of the drive, sprint, telemetry, respawn, restart and
  soak passes are unchanged.
- The HUD row `ghost` names the source (`your best` / `reference`), the race-clock
  gap `Δt` (positive = you are behind) and the distance gap `Δd`, and the on-screen
  tag reads `GHOST · … · replay, no collision`.
- The ghost is drawn from the **already uploaded** car mesh (the same per-car
  body/wheel parts, 84–115 draws) with a cyan translucent diagnostic tint and a
  depth test that does not write depth. One extra draw set per frame; **no
  geometry, texture or buffer upload** and no new GPU buffer (the ghost uniforms
  use reserved slots of the existing uniform buffer). `G` hides/shows it in place
  without a reload.
- Record: one sample per engine tick from the settled tick 0 to the finish tick,
  `position3 + rotationQuaternion4 + wheelAngle4` as little-endian float32
  (11 × 4 B/tick, base64). `web/ghost-replay.js` rebuilds the body matrix from the
  quaternion and each wheel matrix exactly like `packet-adapter.js`
  (`body × manifest rest × Rx(angle)`); the verifier proves the reconstruction
  against the run's own packet matrices.
- Hash: canonical JSON SHA-256 of the whole record (including the sample payload).
  The same run derives the same hash in the browser and in Node; the committed
  reference files under `probes/e1-drive/ghosts/` are regenerated by
  `verify_e1_drive.mjs --write-ghosts` and compared byte-for-byte on every normal
  run, so a stale or hand-edited ghost fails the gate.
- Storage: `localStorage` key `e1-drive.sprint.ghost.v1.310m` / `…v1.short`, a map
  from car slug to the fastest clean ghost. A slower run never overwrites it; a run
  with a respawn is not recorded (its engine tick axis restarts); a tampered record
  is dropped and reported, never replayed.
- Fallback: if storage has no record for the car, the page fetches the committed
  reference trace for that car and course. If that is missing or fails its hash,
  the HUD says why and the ghost stays off — there is no guessed pose.

`?ghostoffset=<ticks>` is a **capture-only presentation offset**: it shifts where
the ghost is drawn (the headless ghost capture uses `+60` ticks so the ghost is
visibly ahead of the identical scripted player run). It does not change the
record, the pose at the reported tick, the delta, the packet or the physics.

`probes/e1-drive/ghosts/index.json` lists the thirty committed reference records
(15 cars × 310 m / 29 m) with their file SHA-256, canonical ghost hash, finish time,
tick count and the sprint state sequence hash they were recorded from.


## Extended corridor survey (`?survey=1`)

The six measured corridor sections are drawn (394 real draws / 57,133 triangles in
one mesh) and the measured 539.81 m line, its four gates and their 61/61 coverage
are recorded in `_work/e1-drive/corridor-survey.json` — but the corridor is **not a
course**:

| measurement | value |
| --- | --- |
| measured corridor | 539.808 m, 2,257 samples at 0.25 m, 2,251 covered, 3 gaps (1.413 m) |
| six-section totals | 299 draws / 47,790 triangles / 78,712 vertices |
| survey gates | start 0.00 m, checkpoints 179.88 / 359.80 m, finish 537.69 m, all 61/61 covered |
| path/face crossings | 4 measured, 2 engine-confirmed solid (57.82 m and 530.71 m, both 50 m tall) |
| measured course limit | **57.82 m** — the measured line crosses a vertical collision face |
| section-join rise | 6.36 cm in 0.94 m (6.7 %) at 52.19 m |
| steepest local grade | −31.24 % at 534.23 m |
| per-car physical limit | the car stops at **52.7–53.4 m** (rise) and never reaches 56.5 m (pinch) |

Coverage (a draw within 0.5 m of the collision surface) does not test walls, width,
steps or slope: a 50 m cliff face is both drawn and collided, so its cells count as
covered and the measured Dijkstra line can run straight through it. `?survey=1`
labels exactly that; the playable sprint is the measured 310 m P48 course (or the
29 m regression straight with `?course=short`).

## Telemetry (`?telemetry=1`)

Three deterministic manoeuvres per car, measured from the engine state and shown
as a metric table plus three 60 Hz traces. Inputs are functions of the tick only
(the brake step tick is measured in the accel run of the same series). All three
manoeuvres run in **one wasm instance**, rebuilt with `e1_reset()` between them
(one `e1_create` + two resets per series), and `R` re-runs the series in the same
instance without a page reload. See `T-007-reset-fix.md`.

| manoeuvre | input | measured |
| --- | --- | --- |
| `accel` | throttle on every tick, fixed 86 m window | 0–50 / 0–80 / 0–100 km/h, top speed, speed at 86 m |
| `brake` | throttle, then brake from the measured 80 km/h tick | entry speed, distance, peak/mean deceleration |
| `lateral` | 120 throttle ticks, then 4 square half-periods of 36 ticks at ±0.6 | peak lateral g, peak yaw rate, yaw lag per reversal |

Measured (`_work/e1-drive/telemetry.json`; one strip, diagnostic only):

| car | 0–50 | 0–100 | speed at 86 m | brake 80–0 | peak / mean decel | lateral peak | yaw peak | yaw response |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Audi R8 V10 (AWD) | 1.133 s | **2.650 s** | **135.2 km/h** | **13.34 m** | 24.77 / 15.46 m/s² | **1.52 g** | 22.7 °/s | 12.7 ticks |
| Corvette ZR1 | 1.817 s | 3.650 s | 126.5 km/h | 14.83 m | 20.80 / 15.13 m/s² | 0.86 g | 22.2 °/s | 15.3 ticks |
| Lotus Exige | 1.900 s | 3.833 s | 119.1 km/h | 17.00 m | 18.40 / 12.65 m/s² | 0.99 g | 22.7 °/s | 12.3 ticks |
| Dodge Challenger | 2.100 s | 4.633 s | 108.2 km/h | 17.07 m | 18.47 / 13.34 m/s² | 0.84 g | 19.0 °/s | 14.7 ticks |
| Ford Focus RS (FWD) | 2.400 s | 5.133 s | 107.1 km/h | 18.73 m | 16.59 / 11.76 m/s² | 1.32 g | 26.3 °/s | 13.3 ticks |

The 0–100 order (Audi < Corvette < Lotus < Dodge < Focus) is exactly the XT
`torqueScaleNm / mass` order; the AWD car is quickest and the FWD car slowest.
Stopping distances follow the same order, but the Lotus is an anomaly: highest XT
brake-to-mass ratio, third-shortest stop. Full comparison in
`docs/work/verification/T-007-telemetry.md`. Physics is unchanged: the verifier
pins all fifteen drive and sprint state sequence hashes and all fifteen drive packet
hashes, and the page recomputes the series itself and matches the node metrics
and per-tick state hashes exactly.

## Soak (`?soak=1`)

`?soak=1&soakSeconds=<n>&soakTicksPerFrame=<k>&car=<slug>` runs a deterministic
session endurance plan with no wall-clock input:

1. **drive** — the 300-tick scripted drive, then `e1_reset()` and a new packet timeline;
2. **sprint** — countdown, both checkpoints, finish, 120-tick brake tail, then `e1_reset()`;
3. **telemetry** — the three diagnostic manoeuvres, each after an `e1_reset()`;
4. repeat until `soakSeconds` of 1/60 s ticks have run.

Every segment after the first drive builds a new world (full level import +
180-tick settle) and reloads the packet's three meshes. The browser page (not the
engine) records one wall-clock frame interval and CPU work time per rendered frame,
one wasm-heap/scheduler/buffer sample per simulated second, the state sequence and
packet hash after every segment, and the telemetry metrics/trace hashes. `tools/soak_browser.mjs` runs the
plan twice in two fresh page instances, takes start/mid/end screenshots, and gates:

- 0 console messages of any kind;
- requested simulated tick budget reached (fixed 1/60 s ticks, deterministic
  sequence independent of frame pacing);
- no NaN/Inf state and no abort;
- wasm heap constant, scheduler pool head/group handles constant, GPU packet
  buffers bounded (created − destroyed = live = one packet's 11 buffers: three
  meshes × (positions, indices, UV) + uniform + scene) and textures bounded
  (live = 136 track + 4 level prop + 7–9 car = 147–149, exactly one packet's
  textures; a 1-minute run with the default 9-image car creates 596 = 4 loads ×
  149 and destroys 447, so live stays 149);
- exactly three mesh uploads per timeline load and one uniform write/draw set
  per frame;
- every complete drive/sprint segment reproduces the node verifier's state
  sequence hash and finish, every telemetry segment reproduces the node metrics
  and per-tick trace hashes, and the two soak runs have identical checkpoint
  hashes. Browser packet hashes may differ from Node in the documented
  `Math.atan2`/`Math.sin` last bit; state sequences are the exact gate.
  **Known issue (pre-existing, not texture related):** since the 310 m course
  became the default the soak world boots on its measured start tangent
  (0.767411 rad), so the soak's *drive* and *telemetry* segments are not the
  node's π/2-spawn runs and those two tool comparisons fail; the sprint segment
  still matches its node anchor and the page's own soak report is PASS.
  `docs/work/verification/T-007-textured-cars.md` §Soak records the reproduction.

The page's frame-time percentiles are measurements of this headless WebGPU loop.
Headless Edge is not vsync-limited and this is not a claim about the user's GPU,
display or retail frame rate. See `docs/work/verification/T-007-soak.md`.


`web/app.js` owns the loop: character-key input (WASD/arrows/space, R to restart),
the fixed-step driver, the engine step, the sprint rules, the adapter append, and
the render. It renders `tick - 1 + alpha` so interpolation between the two most
recent ticks is real, and holds an exact integer tick when `?hold=` is used for
screenshots. `web/sprint-rules.js` is the tick-driven rules state machine
(countdown, timer, gate order, finish, respawn), `web/sprint-layout.js` derives /
validates the gates, `web/sprint-best.js` is the `localStorage` best-time store,
and `web/sprint-script.js` holds the scripted sprint driver plus the off-course
respawn diagnostic. `web/ghost-replay.js` is the ghost record (compact float32
samples + canonical hash), the per-course `localStorage` store and the HUD delta;
`web/packet-consumer.js` draws the ghost as one extra pass over the uploaded car
mesh. `tools/serve.mjs` serves the committed `/ghosts/` reference tree read-only.
The page adds a countdown numeral, an event banner, a sprint
HUD block, a results overlay and the ghost tag.
`web/cars.js` resolves `?car=<slug>` against the generated roster and fills the
page's car selector; `?car` defaults to the roster's recorded default, so the
original single-car links still work.

`web/packet-consumer.js` is a copy of the committed consumer with these additions:
`syncTimeline()`, which accepts ticks appended after `load()`; a soak-only
buffer lifecycle (`releaseGeometry()` + `stats.packetLoads/buffersCreated/
buffersDestroyed`, invoked at every `load()`) so repeated timeline rebuilds cannot
grow GPU memory; and the textured delta — a second vertex buffer with the
mesh's UV0 (track, the level props' real P73a instance stream and car), one
`rgba8unorm-srgb` texture + bind group per static albedo source with a
deterministic full mip chain derived from mip0 (2×2 box in linear light),
trilinear sampling, anisotropy 8 where supported, a 1×1 white placeholder for
untextured draws, an exact sRGB output encode, and `texParams` in the draw
uniform (`x` = texture bound, `y`/`z` = the declared U/V flip flags; the car pack
uses `u' = 1−u`, `v' = v`). The sRGB decision and its evidence are recorded on
`TEXTURE_SAMPLER` and in
`docs/work/verification/T-007-texture-quality.md`; the producer manifests and
geometry/packet pins are unchanged.
No other render/pipeline logic changed.

`web/fixed-step.js` and `web/interpolate.js` are verbatim copies of the committed
modules; `web/packet-camera.mjs` is a verbatim copy of the producer/validator
camera maths so the per-tick orbit reconstruction agrees exactly.

## Scripted drive

`web/drive-script.js` — 300 ticks at 60 Hz: **120 throttle, 120 coast, 60 brake**,
input chosen by tick number, never by wall time. Same script, same spawn
`(-88, 1050)`, same level for every car; only the field list changes:

| car | travel | peak speed | t=120 | t=240 | t=300 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Corvette ZR1 | 45.38 m | 15.44 m/s | 14.99 | 11.04 | 0.45 |
| Lotus Exige Cup260 | 40.64 m | 15.08 m/s | 14.65 | 8.40 | 0.27 |
| Dodge Challenger | 41.04 m | 13.85 m/s | 13.35 | 10.06 | 0.22 |
| Ford Focus RS (FWD) | 30.66 m | 12.36 m/s | 11.66 | 5.87 | 1.34 |
| Audi R8 V10 (AWD) | 69.45 m | 21.54 m/s | 21.22 | 16.91 | 0.93 |

All five reference cars: **301/301 ticks with wheel contact**, **0 NaN**, distinct state
sequence hash, and the Corvette's sequence hash is exactly the T-007 value
(`83f76590…`), so the roster did not change the existing car. All fifteen roster
cars run the same 300-tick script in `run.json → cars[].drive`.

## Evidence

`_work/e1-drive/run.json` (all cars, including the camera ranges and
blocked/near-field counts), `state-<slug>.json`, `packet-<slug>.json`,
`sprint.json` (the default 310 m layout), `sprint-short.json` (the 29 m regression
layout), `sprint-<slug>.json` / `sprint-short-<slug>.json` (per-car sprint ticks,
events, inputs and the start/mid/checkpoint/finish capture updates),
`telemetry-<slug>.json` (full 60 Hz traces, metrics, hash aggregates and unit
definitions),
`geometry.json` (level packet + real track visual + one real body per car with
its own UV0 and albedo textures + hidden collision), `car-textures.json` (the
P52 draw/material/texture resolution, the UV convention and per-car coverage),
`car-uv-<slug>.bin` (the fifteen committed UV0 streams), `track-textures.json` (UV0
stream, sampler, 136 texture records and 394 per-draw bindings), `track-uv.bin` +
`textures/*.rgba` (the exported UV and pixel bytes),
`level-instance-textures.json` (the 22-draw P73a UV0/BC1 pack, 18/4 split,
manifest and content hashes), `level-textures/*.rgba` (the four decoded BC1
images, 8,192 B), `browser-evidence-props.json` (5 cars × 5 level-prop frames),
`browser-evidence-prop-textures.json` (before/after pixel diff),
`before-prop/*.png` + `browser-<slug>-prop-*.png`, `cars.json` (the 62-record
roster + gate), `reset-cycles.json`
(10 create/reset cycles per car in one instance with per-cycle hashes, heap and
scheduler pool, plus the one-instance telemetry and sprint-restart comparison),
`browser-evidence.json`,
`browser-evidence-sprint.json`, `browser-evidence-respawn.json`,
`browser-evidence-survey.json`,
`browser-<slug>-survey.png`,
`corridor-survey.json` + `corridor-survey.html` (the measured corridor survey),
`course.json`, `corridor-probe.json` + `corridor-probe-<slug>.json` (per-car
measured limit),
`browser-evidence-telemetry.json`, `browser-evidence-restart.json`,
`browser-evidence-telemetry-restart.json`, `browser-evidence-soak.json`,
`browser-evidence-texture.json` (close-up texture proof),
`browser-evidence-quality-{before,after}.json` + `browser-<slug>-quality-<frame>-{before,after}.png`
(texture-quality before/after: sprint start, tick-120 truck, free prop, lap;
scene-only sharpness/alias metrics, diff, mip hash, deterministic scene crop),
`browser-evidence-ghost.json` (ghost replay: roster cars in the committed 5-car reference evidence, G toggle, pose/delta/upload gates),
`browser-evidence-audio.json` + `browser-audio-{running,muted}.png` (engine audio:
force-off, gesture gate, 1500/3015/6000 RPM live gains/rates/RMS, mute),
`probes/e1-drive/ghosts/index.json` + `ghosts/<slug>-{310m,short}.json` (committed
deterministic reference ghost per car and course),
`soak-run-{1,2}.json`, `browser-soak-run{1,2}-{start,mid,end}.png`,
`browser-<slug>-{start,mid,coast,end}.png`,
`browser-<slug>-sprint-{start,mid,checkpoint,finish}.png`,
`browser-<slug>-sprint-short-{start,mid,checkpoint,finish}.png` (29 m regression),
`sprint-lap.json` (the P61 loop-01 3-lap layout), `sprint-lap-<slug>.json`
(per-car three-lap ticks, lap times, inputs and start/lap1/lap2/finish updates),
`browser-evidence-lap.json` + `browser-<slug>-sprint-lap-{start,lap1,lap2,finish}.png`
(5-car lap race, console and prop-layer gates),
`sprint-free.json` (the P65/P68 free-roam layout), `sprint-free-<slug>.json`
(per-car free-roam ticks, inputs, containment and the four capture updates),
`browser-evidence-free.json` + `browser-<slug>-free-{spawn,mid,prop,reset}.png`
(5-car free roam, console and 447-collider layer gates),
`browser-evidence-collision-v2.json` + `browser-<slug>-collision-{lap-sign,free-pipe}-{approach,stopped,settled}.png`
(30 collision-probe captures, console and stop gates),
`browser-evidence-map-amboy.json` + `browser-<slug>-map-amboy-{start,checkpoint,mid,finish}.png`
(M3 usa_amboy map capture, console and package/upload gates),
`browser-<slug>-sprint-restart-{before,countdown,finish}.png`,
`browser-<slug>-sprint-respawn.png`,
`browser-<slug>-sprint-ghost.png` + `browser-<slug>-sprint-ghost-off.png` (G toggle),
`browser-<slug>-telemetry.png` (+ `-car.png`),
`browser-<slug>-telemetry-restart-{before,after}.png`,
`browser-<slug>-wheels-240.png` (side view, wheel geometry),
`browser-evidence-wheels.json`; `packet.json`/`state_a.json` are the default
car's aliases. The track visual, its source sections and the coverage limit
are recorded in `docs/work/verification/T-007-track-visual.md`; the six-section
corridor, its survey, the measured course limit and the rejected proxy fix are
recorded in `docs/work/verification/T-007-ledge-fix.md`; the static albedo
texture export, the 297/97 coverage and the declared sampler are recorded in
`docs/work/verification/T-007-textured-track.md`; the per-car
body/wheel integration is recorded in
`docs/work/verification/T-007-per-car-meshes.md`; the per-car albedo/UV pass is
recorded in `docs/work/verification/T-007-textured-cars.md`; the chase-camera occlusion
rule, the before/after frames and the near-field limit are recorded in
`docs/work/verification/T-007-camera-collision.md`; the sprint rules, gate
derivation and respawn are recorded in
`docs/work/verification/T-007-sprint-rules.md`; the telemetry manoeuvres,
per-car metrics and plausibility comparison are recorded in
`docs/work/verification/T-007-telemetry.md`; the rebuild-limit root cause, the
10-cycle/one-instance measurements and the restart evidence are recorded in
`docs/work/verification/T-007-reset-fix.md`; details and numbers:
`docs/work/analysis/e1-drive-slice.md` §10–17 and
`docs/work/verification/T-007-multi-car.md`.

## Limits (also carried in the packet's own diagnostics)

- **Materials remain diagnostic, except the static albedo pixels.** The 297
  textured track draws sample their own `g_tAlbedo` texture with the real UV0,
  and the 224 textured car draws sample their own P52 `g_MeshTexture` image with
  the car mesh's own UV0 (sampled as `(1−u, v)`: the decoded images are stored
  row 0 = top and V already matches, while the model's U axis runs opposite to
  the image reading direction on every readable island, so the raw stream renders
  plates, badges and emblems horizontally mirrored). Material colour, blend
  state, shader stages and per-material texture matrices are not applied, and the
  sampler's anisotropy is a declared quality choice. Mips and sRGB **are** now
  applied by the consumer: the stored texels are uploaded as `rgba8unorm-srgb`,
  a full deterministic mip chain is derived from mip0, and filtering is
  trilinear. The sRGB proof, the per-source gap for the track/level packs and the
  applied anisotropy (1 on the capture adapter) are in
  `docs/work/verification/T-007-texture-quality.md`. The 267
  runtime-only car draws (45 paint lookups, 66 light blends, 156 other
  `_NO_ALBEDO`), props and the 97 unbound track draws keep diagnostic colours.
  One directional light, screen-space derivative normals; no shadows, post or
  particles. Paint and material parameters are not decoded. The track pack keeps
  its raw UV stream unchanged; its road textures carry no readable text, so its
  own U/V orientation is an open item rather than an assumption. The P55
  `(u, 1−v)` claim is superseded by `docs/work/verification/T-007-car-uv-orientation.md`.
- **One car at a time, selected at runtime.** No opponents, no traffic. Each
  physics car now draws **its own real body and wheels** from its own
  `root.pak` model (body mesh, parts, wheel groups per car; see the counts in
  the Cars section). The body is labelled with `bodyMesh`, `bodyMeshReason` and
  the manifest SHA-256.
- **Wheel corner identity is bounds evidence.** Symmetric wheel sets cannot be
  resolved by AABB alone: the ZR1 has 10 ambiguous wheel draws, the Lotus 12,
  the Dodge 16, the Focus 20 and the Audi 16. Those draws are still drawn and
  spun on their wheel node, but their `partKind` is `unclassified` and the
  pairing is `previewAssignment` — no corner label is claimed. The Audi tyre tier
  is `containment` because its element boxes are larger than the geometry.
- **The track visual is real River render geometry, but it does not cover the
  whole script.** It is built from the committed `level_inspect` direct draws:
  block88/node283 (95 draws / 17,782 vertices / 9,343 triangles, as instructed)
  and block56/node289 (49 / 14,508 / 9,824), merged with the six measured
  corridor sections (299 / 78,712 / 47,790; merged mesh 394 draws / 96,494
  vertices / 57,133 triangles). Measured fact: block88/node283
  bounds are `x 944…2478, z 2206…3237` and do **not** overlap the drive box
  (`x −120…−10, z 1010…1090`); block56/node289 does (its road y at the spawn is
  5.80685 vs the engine's 5.8074 ground probe). The 310 m P48 course is fully
  drawn by block56/node289 (P51: 100 % at the car-width band, 8 draws), while the
  tail of the 300-tick drive (`?script=drive`) and the off-road area have no
  committed real draw, so no ground is drawn there. The HUD
  says `394 real draws · 57133 tri · 297 textured (136 tex, 439360 B) · no-draw 2088 tri · slab hidden`.
- **The extended corridor is a survey, not a course.** The measured line crosses
  two engine-confirmed 50 m vertical collision faces (arc 57.82 m and 530.71 m)
  and a cliff pinch at 55.7-59.7 m; every car stops at 52.66-53.37 m on the
  section-join rise and at 55.49-56.20 m at the pinch. `?survey=1` labels the drawn
  corridor; nothing about the playable 310 m course or the 29 m regression changes.
- **The 310 m course is point-to-point.** It is the farthest point of the spawn
  collision component; there is no lap. Its finish is at arc 300.160 m, 10.24 m
  before the measured end, because the surface narrows to 2.0 m at +4 m past that
  end. The course crosses five draw-to-draw seams in the same section
  (50.18 / 76.89 / 168.64 / 222.78 / 242.00 m); P51 measured 0 uncovered
  sub-samples at 0.02 m across them, but they are seams in one section, not extra
  road.
- **The collision surface is physics-only and hidden.** The wheels still trace
  `Level.levelphysics`, but the collision mesh is now carried in
  `packet.physicsSurfaces` with `visible:false`; it is not uploaded and not
  drawn. The diagnostic slab is therefore gone; only real draw geometry is
  rendered. Nearly edge-on real slabs still speckle (derivative normals at
  grazing angles).
- **Wheels use rest-pose placement and physics spin only.** The four wheel groups
  sit at their `MdlDat` element translations; tyre/rim/brake disc rotate about
  element-local `+X` by the integrated physics wheel angular velocity, and the
  caliper stays static. No suspension travel, steer or camber is applied because
  the state does not carry those per-wheel rotations.
- **Wheel spin is integrated, not read as an angle.** `e1_get_state()` reports
  `wheels[].angular` (rad/s); the adapter integrates it at 1/60 s starting from
  zero on the settled tick, so the angle is a pure function of the tick sequence.
- **The spin marker is diagnostic.** A local-angle band makes rotation visible on
  rotationally symmetric tyre/rim/disc geometry; it is not a material or texture.
- **Box gravity proxy and neutral surface scalars**, no XT physics handle — the
  T-005d labels, unchanged. The box is sized from the selected car's own XT
  geometry, so it differs per car.
- **The car mesh frame to chassis frame mapping is not recovered** (that is the
  model import), so each body is drawn directly in the engine body frame. The
  five bodies visibly fit the engine chassis at the spawn, but the retail
  mesh→body alignment offset is not proven.
- **The chase camera resolves occlusion, but only with one cast per tick.**
  The eye is pulled in front of the first hit against the visible static
  geometry (level props + real track visual); the hidden collision surface and
  the car body are not occluders, and nothing is swept between ticks (no
  continuous collision). Pull-in is immediate, push-out eased by 0.08/tick, so
  dense prop areas give a close rear view (resolved 3.02–9.31 m over a script;
  at the recorded tick 150 the blocked cars sit at 3.15 / 4.61 / 5.34 / 6.32 m).
  A hit closer than 3.4 m is a `nearField` prop crossing: the car is inside the
  prop (physics has no prop collision), the camera holds its distance, and the
  frame shows the prop — 26–36 ticks per car, recorded per tick, not hidden.
  The consumer's manual drag/zoom debug camera is not occlusion-checked;
  `?camdist/camheight/camyaw` are, change only the camera and never physics, and
  the default page never sets them.
- **Engine audio is one retail graph, RPM only.** The page plays the six decoded
  `Race_V8_engine` loops through the committed module; it does not reproduce the
  retail mixer, throttle/damage/induction layers, the decel layer (flat zero in
  this graph) or a car-to-bank mapping. The WAVs are game data under
  `_work/audio/` and are not committed. See `T-007-audio.md`.
- **The ghost is a recorded replay, not an AI opponent.** One ghost per car and
  course; it has no collision, no input, no physics body and no packet entry, and
  no retail rival behaviour is reproduced. It follows the recorded engine-tick
  axis, so a run that used a respawn is not stored as a ghost. The committed
  reference trace is the deterministic scripted follower's run, not a human best.
  `?ghostoffset` is a capture-only presentation offset (it moves only the drawn
  ghost) and the tint is a diagnostic colour, not a recovered material.
- **The sprint is one measured segment, not a lap.** The committed real draws
  cover 29 m from the spawn to x = −57 (last fully covered column); the finish is
  at x = −59. There is no start/finish loop, no second sector, and the car cannot
  drive a lap on drawn ground. Gates are **rules geometry only**: no gate mesh is
  added to the render packet, so the gates appear in the HUD/banner, not as 3D
  objects. The checkpoints are 1/3 and 2/3 of the measured span.
- **Telemetry is a diagnostic validation on that same strip.** The standing start
  is 86 m, braking is from 80 km/h, and the lateral figure is a fixed-steer
  response, not a grip limit; "top speed" is the maximum inside the 86 m window.
  No Vmax run, 100–0 km/h stop, lap time or retail handling claim. All numbers
  come from the unchanged engine and are traceable to `telemetry-<slug>.json`.
- **One wasm instance can be rebuilt (fixed in P40).** A 3rd `e1_reset()` / 4th
  `e1_create()` used to abort because the `C_Scene` never created or set its
  scheduler group handles, so `Scheduler::Flush` indexed stale heap bytes. The
  scene now creates its two groups with `Scheduler::CreateGroup()`, installs them
  like `GameWorld.cpp:562-563`, and destroys them with the scene. Measured: 10
  create/reset cycles per car in one instance with identical state hashes,
  constant 256 MiB heap and a constant scheduler pool; six telemetry manoeuvres
  and the sprint restart also run in one instance. Root cause, measurements and
  remaining limits: `docs/work/verification/T-007-reset-fix.md`.
- **The rebuild is still a full rebuild.** Each `e1_reset()`/`e1_create()`
  re-imports the level and re-runs the 180-tick settle (15–37 ms), so a restart
  or respawn is a one-frame hitch; it is not a resumable hot reload. The
  scheduler pool has 16 slots and this library returns its two per world, so the
  free-list head does not move; a build that leaked groups would fail loudly in
  `CreateGroup`.
- **Respawn rebuilds the world at the last checkpoint.** That is the module's
  `e1_create` path (180-tick settle), so a respawn costs a one-frame hitch and the
  car restarts from rest at the gate; the attempt timer keeps running and the
  passed checkpoints are kept. The page's best time is per car and local to the
  browser (`localStorage`), not a server record.
- **One car, one block, no game.** No opponents, traffic, AI, race audio,
  multiplayer, culling or engine streaming, and no per-car handling claim. The
  sprint rules are this slice's own bookkeeping; they are not the retail race
  mode and carry no BPR/score/XP claim.
- **The soak is a session endurance proxy, not a retail frame-rate claim.** It
  runs deterministic fixed 1/60 s ticks; `?soakTicksPerFrame=` (default 1 on the
  page, 4 in the tool's fast path) controls how many ticks one animation frame
  advances. Frame times and JS heap are measured in headless Edge/WebGPU; the
  headless compositor is not vsync-limited, so the wall-clock intervals are not
  the user's display cadence. GPU buffer count is bounded by destroying the
  previous packet's buffers on every reload; the soak gate requires
  created − destroyed = live = 11 (three meshes × positions/indices/UV + uniform +
  scene), and texture objects are destroyed with the packet (live = 136 track +
  4 level prop + 7–9 car = 147–149, exactly one packet; 596 created − 447 destroyed
  = 149 live in the 1-minute run with the default 9-image car). Five simulated
  minutes = 18,000 ticks; a one-tick-per-frame run
  completed in ~70 s here because headless rAF is not throttled to 60 Hz.
- **Free roam is one measured basin, contained by a box.** `?course=free` is the
  P65 R04 basin at the committed spawn. The reset box is the P68a/P68b
  spawn-component rectangle (+2 m), not the exact free mask: it includes
  void/pocket corners, and the ground lattice fills those cells from the nearest
  measured one (515 of 3,933, recorded). The rule is an out-of-box / below-ground /
  airborne reset, not an invisible wall; the real-engine test leaves through a
  measured sub-cell slot at the C03 clearance ring and is reset at x = 7.076.
  Draw coverage is the P65 100 % measurement consumed read-only. The scripted
  free drive is a speed-capped tick-only diagnostic of 23–29 m, not a racing line
  or a lap, and there is no free-roam ghost or best time.
- **The free-roam prop manifest is a region replacement.** It is the P74 R04-V2
  `all-visible` manifest (447 colliders, variant `free-roam-r04`) for this mode
  only; the lap uses the base V2 manifest all-visible (651) and the timed 310 m
  course uses the same base V2 manifest roadside (553 profile, 544 active after
  9 measured driven-line exclusions). The layer is still a visible-mesh kinematic
  approximation, not retail collision.
- **Native parity** is blocked by the DirectX SDK, as recorded in
  `T-007-vehicle-physics.md`.
