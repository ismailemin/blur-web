# probes/physics — per-car vehicle physics envelope (PHYS1)

Data probe only. It decodes the real `RP_CarDynamics` records and produces a
per-car physical envelope so the renderer/collision consumers can stop using one
fixed 2.98 × 1.68 × 1.35 m box and one fixed wheel geometry for every car.

No engine tick, no browser, no renderer claim, no game claim. It does not modify
`probes/e1-drive`, `probes/prop-collision`, `probes/asset-reader`, `tools/`,
`upstream/` or `game-data/`.

## What it produces

| artifact | content |
| --- | --- |
| `_work/physics/envelope.json` | 62 records: every XT value with field id, offset, raw bits and unit; derived axle/body/engine envelopes; per-car deltas; typed missing fields; coverage; integration contract |
| `_work/physics/verify.json` | 3,289 checks, determinism (two fresh builds), independent source agreement |
| `_work/physics/measure-course.json` | 310 m course impact of the fixed / axle / body envelope per integrated car, via the committed P74 resolver |
| `_work/physics/tables.md` | the per-car tables used by the analysis document |

## Commands

```powershell
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"

& $py   probes/physics/tools/build_envelope.py
& $py   probes/physics/tools/verify_envelope.py
& $node probes/physics/tools/measure_course.mjs
```

Logs: `_work/logs/physics/{build,verify,measure-course}.log`.

## Inputs

| input | role |
| --- | --- |
| `game-data/Blur/cache/gamedata.pak` → `\gamedata\xt\racingphysics.bin` | physics authority (decoded by the committed `engine/harness/t005d-vehicle/car_xt.py`, imported read-only) |
| `_work/car-parts/cars/index.json` + `<slug>/manifest.json` | body AABB and wheel rest geometry for the 25 roster cars |
| `_work/vehicle-pipeline/c-staging-results.json` + `c-staging/<slug>/manifest.json` | body AABB for the staged C aliases |
| `_work/vehicle-pipeline/cars.json` | V1 audit physics values (independent check) and Scene-report AABB for the remaining mapped cars |
| `_work/e1-drive/cars.json` | committed `.fields` consumer input (independent check) and the 15-car integrated order |
| `_work/prop-collision/colliders-v2.json`, `_work/e1-drive/geometry.json`, `_work/drivable-path/path.json` | course-impact measurement only |

Every input is SHA-256 pinned in the manifest. A missing or changed input fails
loudly; nothing is inferred from a name.

## Envelope choices

* `collisionUpperBound` — the visible mesh AABB (X width, Y height, Z length).
  An **upper bound**: it includes mirrors, spoilers and any detail inside the
  mesh. Retail imports a composite collision shape; that import does not exist
  here.
* `chassisFootprint` — `wheelBase × max(trackWidthFront, trackWidthRear)`, the
  wheel-centre rectangle. A **lower bound**; it excludes overhangs and tyre
  width.
* `engineBodyBox` — `(trackWidthFront/2, tyreRadius, wheelBase/2)`, the box the
  T-005d harness already builds per car. A chassis proxy, not the body.

The XT record has **no collision extents, body length/width/height, wheel width
or ride-height field**. Those are recorded as `absent` with the source that would
have to supply them. Ride height is derived (`tyre radius + suspension
movementUp`) with the exact harness line quoted.
