# probes/powerups

Data-only power-up recovery for the Blur Web project. Nothing here changes
`game-data/`, `upstream/`, `probes/e1-drive/`, `probes/race-rules/`,
`probes/net-mvp/`, `probes/asset-reader/` or `tools/`.

## Contents

| path | owner | purpose |
| --- | --- | --- |
| `tools/xt_decode.py` | PWR1 | bounded FLSK v1/v2 table/schema/payload reader |
| `tools/build_powerups.py` | PWR1 | 11 pickup types, levels, balancing, HUD/audio manifest |
| `tools/verify_powerups.py` | PWR1 | independent verifier for `_work/powerups/powerups.json` |
| `rules/engine.js`, `rules/tests.mjs` | PWR1 | standalone rules prototype driven by recovered values |
| `tools/extract_pickup_placement.py` | PWR3 | recover `usa_la_river` pickup placement |
| `tools/verify_pickup_placement.py` | PWR3 | independent direct-offset verifier for `placements.json` |
| `tools/build_projectiles.py` | PWR4 | projectile/impulse manifest from XT + source |
| `tools/verify_projectiles.py` | PWR4 | independent direct-offset verifier for `projectiles.json` |
| `rules/projectiles.js`, `rules/projectiles.test.mjs` | PWR4 | typed projectile/impulse model + 19 tests |
| `tools/build_supershield.py` | SS1 | SuperShield data/provenance manifest |
| `tools/verify_supershield.py` | SS1 | independent direct-offset verifier for `supershield.json` |
| `rules/supershield.js`, `rules/supershield.test.mjs` | SS1 | typed SuperShield model + 17 tests |
| `tools/build_pickup_runtime.py` | PWR6 | final runtime placement set (byte offsets, yaw, structure, reachability) |
| `tools/verify_pickup_runtime.py` | PWR6 | independent direct-offset verifier + two-build determinism |
| `tools/pickup_runtime_common.py` | PWR6 | projection and collision/visible-geometry queries |
| `tools/build_runtime_placement.mjs` | PWR7 | deterministic browser placement JSON + module from `_work/` |
| `tools/verify_runtime_placement.mjs` | PWR7 | independent projection/bounds/respawn/determinism verifier |
| `tools/runtime_placement_module.template.mjs` | PWR7 | template for the generated browser module |
| `data/runtime-placement.json` | PWR7 | committed generated placement data |
| `runtime-placement.mjs` | PWR7 | browser-importable `placementsFor(mapId, layout)` |
| `tools/build_pickup_routes.mjs` | PWR8 | retail `.aid` route network + per-pickup arc/projection |
| `tools/verify_pickup_routes.mjs` | PWR8 | independent pak/`.aid` re-decode + projection verifier |
| `data/pickup-routes.json` | PWR8 | committed retail route network and per-pickup arc |
| `tools/build_retail_placement.mjs` | PWR9 | deterministic retail pickup source + browser module builder |
| `tools/verify_retail_placement.mjs` | PWR9 | independent re-derivation, band/count/determinism verifier |
| `tools/retail_placement_module.template.mjs` | PWR9 | template for the generated browser module |
| `data/retail-placement.json` | PWR9 | committed retail pickup source rows + measured layout identity |
| `retail-placement.mjs` | PWR9 | browser-importable `retailPlacementsFor(mapId, layout)` |
| `tools/build_arc_correspondence.mjs` | PWR10 | measured-arc ↔ retail-arc monotone correspondence table builder |
| `data/arc-correspondence.json` | PWR10 | committed correspondence segments, residuals and rejected runs |
| `tools/build_physical_placement.mjs` | PWR10 | physically-corresponded placement source + module builder |
| `tools/retail_physical_module.template.mjs` | PWR10 | template for the generated physical-placement module |
| `data/retail-placement-physical.json` | PWR10 | committed physical placement source rows + unsupported list |
| `retail-placement-physical.mjs` | PWR10 | browser-importable `physicalPlacementsFor(mapId, layout)` |
| `tools/verify_physical_placement.mjs` | PWR10 | independent correspondence/placement/band/count/determinism verifier |

## SuperShield (SS1)

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py probes/powerups/tools/build_supershield.py
& $py probes/powerups/tools/verify_supershield.py
node probes/powerups/rules/supershield.test.mjs
```

Outputs (not committed):

- `_work/powerups/supershield.json` — `PickupType` 619, `PickupLevel` 523,
  `SuperShieldBalancingData` absolute offset 96048, HUD entry at 400664, MP/SP
  selection evidence, runtime rules, event contract, source citations.
- `_work/powerups/supershield.verify.json` — 571 independent checks.
- `_work/logs/powerups/ss1-*.log` — build, verify, test and suite logs.

The shipped data has no multiplayer SuperShield bit and hard-excludes it from
random pickup selection; single-player also has no recovered grant path. The
entity, wire path (type nibble 10), FX and HUD exist, so the document classifies
it as **integrable as a project extension**, with the MP enable/spawn rule
labelled `provisional`. Full analysis: `docs/work/analysis/supershield.md`.

## Projectile / impulse recovery (PWR4)

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py probes/powerups/tools/build_projectiles.py
& $py probes/powerups/tools/verify_projectiles.py
node probes/powerups/rules/projectiles.test.mjs
```

Outputs (not committed):

- `_work/powerups/projectiles.json` — Blindfire/Bolt, Shunt, Barge and Shock
  projectile/weapon fields, `PerkForceEffects`, AI controller, HUD/audio bindings,
  runtime source citations and the integration contract.
- `_work/powerups/projectiles.verify.json` — 888 independent checks.
- `_work/logs/powerups/pwr4-*.log` — build, verify and test logs.

Full analysis: `docs/work/analysis/powerup-projectiles.md`.

## Recovered placement (PWR3)

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py probes/powerups/tools/extract_pickup_placement.py
& $py probes/powerups/tools/verify_pickup_placement.py
```

Outputs (not committed):

- `_work/powerups/placements.json` — 54 `PickupPosition` slots for the raced
  `usa_la_river` route, with provenance, type ids, row/shuffle groups,
  collision checks, 310 m/loop-01 projections and the provisional diff.
- `_work/powerups/placements.verify.json` — 1401 checks, independent reader.
- `_work/logs/powerups/placement-*.log` — build and verify logs.

Source chain:
`multiplayer.bin MultiplayerRace.route` → `amax.bin Route.MultiplayerActorLists`
→ `actorpack.xt LevelActorList 2512484467` → 54 `PickupPosition` actors.

The 54 slots belong to the retail River route (record 1643385212,
`RouteNumber 3`), which is not the measured 310 m collision-only course. Two
slots are within the 2.0 m pickup radius of loop-01; none are on the 310 m
course. The manifest also compares against PWR2's provisional 6-slot plan
(`probes/e1-drive/web/powerups.js`, read-only): 0/6 slots are within 2.0 m of a
recovered position; nearest 73.04 m. Full analysis:
`docs/work/analysis/pickup-placement.md`.

## Generalized placement (PWR5)

`extract_pickup_placement_levels.py` takes any level id and resolves every
`racing` MultiplayerRace route; it keeps every raced circuit variant and marks
one `primary` (most racing races, then most total races, then lowest route
record id). `verify_pickup_placement_levels.py` is its independent
direct-offset verifier.

```powershell
& $py probes/powerups/tools/extract_pickup_placement_levels.py --level usa_amboy
& $py probes/powerups/tools/extract_pickup_placement_levels.py --level spa_barcelona_gracia
& $py probes/powerups/tools/verify_pickup_placement_levels.py --level usa_amboy
& $py probes/powerups/tools/verify_pickup_placement_levels.py --level spa_barcelona_gracia

# Discovery only: all 29 raced routes / 14 cities with a PickupPosition list.
& $py probes/powerups/tools/extract_pickup_placement_index.py
```

Outputs (not committed):

- `_work/powerups/placements-amboy.json` — routes 633252245 (83) and
  2779865848 (52), 2,060.595 m measured-path projection, collision, groups,
  provisional diff.
- `_work/powerups/placements-gracia.json` — routes 46220414 (59), 2844032875
  (45) and 3824353713 (40), 624.914 m measured-path projection.
- `_work/powerups/placements-{amboy,gracia}.verify.json` — 3,670 and 4,060
  independent checks, PASS.
- `_work/powerups/placement-route-index.json` — 29 raced routes / 1,523
  placements across 14 cities; discovery only.

The retail routes are not the measured e1-drive paths. The primary Amboy route
has 2 placements within 2.0 m of the measured centreline (nearest 0.45 m); the
primary Gracia route has 1 (0.83 m). All other placements are off-path but have
ground. Full contract: `docs/work/analysis/pickup-placement.md` §11–§14.

## Runtime placement set for Amboy and Gracia (PWR6)

`build_pickup_runtime.py` is the integration artifact: it re-decodes every
retail `PickupPosition` of every raced route with absolute byte offsets, adds
retail yaw, measures the slot against the measured e1-drive path, the committed
collision mesh and the committed draw buffers, and publishes the ordered host
set (spawn set, measured-course set, shuffle groups, typed exclusions/flags,
River-identical respawn/reset rules).

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py probes/powerups/tools/build_pickup_runtime.py --level usa_amboy
& $py probes/powerups/tools/build_pickup_runtime.py --level spa_barcelona_gracia
& $py probes/powerups/tools/verify_pickup_runtime.py --level usa_amboy
& $py probes/powerups/tools/verify_pickup_runtime.py --level spa_barcelona_gracia
```

Outputs (not committed):

- `_work/powerups/runtime-amboy.json` — routes 633252245 (83) and 2779865848
  (52), each slot with provenance offsets, `yaw.radians`, row group,
  measured-path distance/arc/signed cross, ground/cover/wall clearances and
  `reachability`.
- `_work/powerups/runtime-gracia.json` — routes 46220414 (59), 2844032875 (45)
  and 3824353713 (40).
- `_work/powerups/runtime-{amboy,gracia}.verify.json` — 8,268 and 8,852 checks,
  PASS, two-build determinism.
- `_work/powerups/pwr6-summary.json` — condensed tables.
- `_work/logs/powerups/pwr6-*.log` — build, verify and River regression logs.

Primary results: Amboy 82/83 spawnable (1 `PickupActiveLevel 0` excluded),
2 placements within 2.0 m of the measured path (nearest 0.452 m); Gracia 59/59
spawnable, 1 within 2.0 m (0.834 m). All 8 MP types are on both primary routes;
the measured sub-course touches only Shunt/Blindfire (Amboy) and
Blindfire/Bomb (Gracia). SuperShield stays a project extension with no slot.
Full contract and tables: `docs/work/analysis/pickup-placement-all-maps.md`.

## runtime-placement (PWR7)

`runtime-placement.mjs` is the committed, browser-importable ES module for the
e1-drive power-up slice. It embeds `data/runtime-placement.json` (145 KB, under
the 200 KB embed limit) and exports `RUNTIME_PLACEMENT_SCHEMA` and
`placementsFor(mapId, layout)`.

```powershell
node probes/powerups/tools/build_runtime_placement.mjs
node probes/powerups/tools/verify_runtime_placement.mjs
```

Import contract:

```js
import { RUNTIME_PLACEMENT_SCHEMA, placementsFor } from '../../powerups/runtime-placement.mjs';
const set = placementsFor('amboy');         // { schema, mapId, source, pickups, unsupported }
const lap = placementsFor('river', 'lap');  // river: '310m' (default) or 'lap'
// pickups[]: { id, type, x, y, z, respawnSeconds, lapMin, lapMax, source }
//   id is "<mapId>:<retail PickupPosition uid>"
// unsupported[]: { id, type, reason }
```

Scope labels:

- **Projected:** every pickup's `source` names the retail `PickupPosition` uid,
  actorpack record, route record and the nearest-segment `(arc, lateral,
  distance)` on the named measured layout. The rule is the committed
  `probes/race-rules/course-model.mjs` `CourseModel.project` (clamped segment,
  sample-arc interpolation, ties to the earlier segment). A clamped projection
  is labelled `endpoint-clamped`.
- **Not moved:** `x/y/z` are the retail `WorldMatrix.aw` world coordinates. The
  measured layout is a sub-course of the retail route; the projection is
  reported, never applied. This is the PWR6 rule "projections are reported, not
  used to move a slot".
- **Respawn:** `Normal` is `null` (not serialized); `Long` 5 s and `VeryLong`
  20 s come from `MultiplayerConfig`. The host must supply a labelled Normal
  timer and must not guess one here.
- **Lap window:** every recovered `ActivationLap` is 0, so `lapMin` is 0 and
  `lapMax` is the layout's lap count (1 for the sprint layouts, 3 for River
  `lap`). There is no per-lap activation gate in the retail data.
- **Unsupported:** only the retail `PickupActiveLevel != 1` slot (Amboy uid
  4231571987) is excluded, with reason `pickup-active-level-0`. No placement is
  dropped silently; every retail uid appears once in `pickups` or
  `unsupported`.
- **Primary route only:** Amboy 633252245, Gracia 46220414, River 1643385212.
  Alternate raced variants stay in `_work/powerups` and are not mixed into one
  set.
- **Counts:** Amboy 82 pickups / 1 unsupported, Gracia 59 / 0, River 54 / 0
  (both `310m` and `lap`). Verifier **7,828/7,828** checks, two builds
  byte-identical.

## Retail pickup routes (PWR8)

PWR6/PWR7 measured every retail pickup against the *measured* e1-drive
sub-course. Only 2/82 (Amboy) and 2/59 (Gracia) are within 5 m of it, because
the measured layout is a sub-course of the retail route. The retail slots do lie
on the retail route, and that route is recoverable from committed data.

Source chain (all read-only):

`amax.bin Route` record → `Route.Name` → `LevelState.cpp:298`
(`.\gamedata\levels\<city>\<route>.aid`) → `gamedata.pak` entry →
`AI_Amax.cpp:1595-2163` (`LoadVersionSix`) → `AITrackDataRoutes` /
`AITrackDataSegments` / `AITrackDataLines`.

| map | route record | route name | `.aid` entry | routes | pickups |
| --- | ---: | --- | --- | ---: | ---: |
| amboy | 633252245 | `USA_Amboy_3` | `\gamedata\levels\usa_amboy\usa_amboy_3.aid` | 46 | 82 |
| gracia | 46220414 | `SPA_Barcelona_Gracia_2` | `\gamedata\levels\spa_barcelona_gracia\spa_barcelona_gracia_2.aid` | 13 | 59 |
| river | 1643385212 | `USA_LA_River_3` | `\gamedata\levels\usa_la_river\usa_la_river_3.aid` | 22 | 54 |

```powershell
node probes/powerups/tools/build_pickup_routes.mjs
node probes/powerups/tools/verify_pickup_routes.mjs
```

Result:

| map | on-route (corridor) | off-route | route network ≤2 m / ≤5 m / ≤10 m | corridor max |
| --- | ---: | ---: | --- | ---: |
| amboy | **82/82** | 0 | 24 / 49 / 68 | 0.000 m |
| gracia | **59/59** | 0 | 14 / 28 / 46 | 0.000 m |
| river | **54/54** | 0 | 21 / 28 / 44 | 0.000 m |

Verifier: **1,610/1,610** checks, two builds byte-identical
(`sha256 362643ba…`, 1,215,413 bytes). An independent Python cross-check with
the committed `probes/course/tools/aid_decode.py` agrees on all 81 routes
(points, widths, racing offsets, byte offsets, lengths) and all 195 pickups
(route, segment, corridor distance, racing-line distance, arc).

Import contract:

```js
import { readFileSync } from 'node:fs';
const doc = JSON.parse(readFileSync('probes/powerups/data/pickup-routes.json', 'utf8'));
const map = doc.maps['amboy'];
// map.aid:  { pakPath, sha256, logicalBytes, revision, routeCount, ... }
// map.routes[]: { index, name, flags, flagNames, closed, closureMetres,
//                 segmentCount, lineCount, byteOffset, firstSegmentByteOffset,
//                 segmentStrideBytes, endByteOffset, routeLengthM, lengthMetres,
//                 stepMinMetres, stepMaxMetres,
//                 points: [[x, y, z, arc], ...],   // racing line, line index 5
//                 widths: [w, ...],                // serialized segment width
//                 racingOffsets: [o, ...] }        // serialized racing-line offset
// map.pickups[]: { id, uid, type, position: [x, y, z],
//                  route, routeIndex, segment, arc, offset, lateral, width, along,
//                  containingRoutes: [{ name, index, width }, ...],
//                  distanceToRouteNetwork, distanceToAssignedRacingLine,
//                  distanceToCorridor, onRoute, status }
// map.offRoute[]: { id, uid, distance }
// map.counts: { retailPlacements, onRoute, offRoute, corridorMaxMetres,
//               within2mOfRouteNetwork, within5mOfRouteNetwork,
//               within10mOfRouteNetwork, medianDistanceToRouteNetwork }
```

Scope labels:

- **Recovered, not synthesized:** every point is
  `origin + normalize(tangentX, -tangentZ) * width * line[5].offset` with
  `origin = (xFile, -zFile)` and `y = line[5].height`, exactly
  `AITrackDataSegments::GetPositionFromOffset` (`trackdata.h:477-490`). The
  builder re-implements the committed `probes/course/tools/aid_decode.py`
  reader; the verifier re-implements it a second time.
- **Route network, not one loop:** the race loop is `MainLoop`
  (amboy 1,713 segments / 6,746.7 m, gracia 1,268 / 4,986.2 m, river 1,062).
  The retail slots also sit on the alternate and catch routes of the same
  `.aid`, so the artifact keeps all 46/13/22 routes. `MainLoop` alone is within
  2 m for only 6/82 (amboy) and 5/59 (gracia), and its corridor contains only
  **43/82** (amboy), **48/59** (gracia) and **41/54** (river) of the retail
  slots; the rest are on the alternate/catch branches. That is why the network,
  not the loop, is the correct carrier.
- **Overlapping corridors:** a slot can sit inside several corridors at once
  (`MainLoop` + `Logic` + an alternate). `containingRoutes` lists every carrier,
  exact containment first and narrowest first; `route` is the most specific one.
  `Logic` is a wide catch-all (median width 111 m amboy, 227 m gracia) and is
  never preferred over a real road.
- **On-route rule:** the engine's own segment quad
  (`AITrackDataSegments::GetSegmentBounds` / `InSegmentWidths`,
  `trackdata.h:1055-1122`): lateral offset in `[0, 1] * width`, longitudinal in
  `[-2, +2] m` around a 4 m sample. `corridorMetres: 0.5` is numerical slack;
  every slot is genuinely inside a quad (`corridorMaxMetres: 0`), not snapped.
- **Distances are reported, never applied:** `position` is the retail
  `WorldMatrix.aw` copied from `runtime-placement.json`. `arc`, `offset`,
  `lateral` and the distances are metadata. Nothing is moved.
- **Racing line vs corridor:** `distanceToRouteNetwork` is the planar distance
  to the nearest racing-line polyline of the whole network (median 3.57 m
  amboy, 5.25 m gracia). It is large because the serialized corridor is
  14.5-74.8 m wide on the three `MainLoop`s (median 28.8-36.1 m) and the
  pickups sit off the AI racing line; the corridor test is the on-track test.
- **`y` is the racing-line height**, not ground: the retail pickup origin sits
  about 3 m above it (the collection box is an oriented box at
  `WorldMatrix.aw`). Vertical placement stays PWR6's job.
- **Excluded slot:** amboy uid `4231571987` (`PickupActiveLevel 0`) is not in
  the committed `runtime-placement.json`, so it is not in this artifact. It also
  falls inside the corridor (checked against `_work/powerups/runtime-amboy.json`,
  not committed).
- **Not a renderer claim:** this is decoded route geometry and planar
  projection only. No draw, GPU, physics or gameplay claim.

## Retail pickup placement (PWR9)

`retail-placement.mjs` is the committed, browser-importable ES module that
places the retail pickups from `data/pickup-routes.json` on the measured layout
the e1-drive page drives (`layout.course.samples`). It embeds
`data/retail-placement.json` (63 KB) and exports
`RETAIL_PLACEMENT_SCHEMA` and `retailPlacementsFor(mapId, layout)`.

```powershell
node probes/powerups/tools/build_retail_placement.mjs
node probes/powerups/tools/verify_retail_placement.mjs
```

Import contract:

```js
import { RETAIL_PLACEMENT_SCHEMA, retailPlacementsFor } from '../../powerups/retail-placement.mjs';
const set = retailPlacementsFor('amboy', layout);
// layout = the measured layout the page drives:
//   { course: { lengthMetres, band|corridor, samples: [{ arc, x, z, groundY }, ...] } }
// set = { schema, mapId, source, pickups, unsupported }
// pickups[]: { id, uid, type, x, y, z, arc, lateral, retailLateral, clamped,
//              clampedBy, fraction, route, routeIndex, retailArc,
//              routeLengthM, sampleIndex, source }
// unsupported[]: { id, uid, type, reason }
```

Rule (recorded in every `source` string):

```text
fraction       = retail.arc / retail.routeLengthM
measuredArc    = fraction * layout.course.lengthMetres
sample         = nearest measured sample (ties to the earlier sample)
appliedLateral = clamp(retail.lateral, -band, +band)
x/z            = sample.x/z + leftNormal(sample) * appliedLateral
y              = sample.groundY
```

The measured band is `layout.course.band.halfWidthMetres` when present,
otherwise `layout.course.corridor.halfWidthMetres` (Amboy/Gracia 6 m, River
310 m 6 m, River loop-01 1.25 m). A retail lateral outside the band is clamped
and `clamped: true` records the applied value; an inside lateral is kept
unchanged. `retailLateral` and `retailArc` stay in the output so the clamp is
auditable.

Result on the committed layouts:

| map | layout | measured length | band | pickups | unsupported | clamped |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| amboy | `_work/e1-drive/amboy/layout.json` | 2,060.595 m | ±6 m | 82 | 0 | 56 |
| gracia | `_work/e1-drive/gracia/layout.json` | 624.914 m | ±6 m | 59 | 0 | 44 |
| river | `_work/e1-drive/sprint.json` (310 m) | 310.395 m | ±6 m | 54 | 0 | 38 |

Verifier: **6,122/6,122** checks, two builds byte-identical. The verifier
re-reads `pickup-routes.json` and the measured layout files, re-applies the rule
independently, checks every placed pickup is inside the measured band, checks
every clamped pickup is exactly on the band edge, checks every retail uid
appears once in `pickups` or `unsupported`, and compares the committed JSON and
module with two fresh builder runs.

The largest clamps are recorded in `counts.clampedMaxOverM`: Amboy 52.633 m
(uid 3288031175, carrier `Logic`), Gracia 144.002 m (uid 410117243, carrier
`Logic`, serialized width 217.597 m) and River 37.197 m (uid 3370233259,
carrier `MainLoop`). The Gracia/Amboy `Logic` entries are the wide catch-all
route documented in PWR8, not a road lane; the clamp is a project placement
choice, not a road-width claim.

Scope labels:

- **Applicable, not a physical projection:** the rule is applicable to every
  retail pickup (finite arc, positive route length, non-empty measured samples,
  finite band), so no pickup is unsupported. It is a linear arc-fraction remap,
  not a physical projection: the measured layout is a sub-course of the retail
  route and its arc origin differs from the retail `MainLoop` origin. The
  committed `soundness` block records the numbers, e.g. Amboy's measured start
  is 83.108 m from the nearest `MainLoop` point (retail arc 5,572.740 m) and its
  measured end is 282.426 m away (retail arc 657.510 m); Gracia 157.452 m /
  2,000.170 m and 15.718 m / 2,436.710 m; River 41.028 m / 2,608.170 m and
  81.772 m / 2,922.310 m. The rule is a project placement choice, not retail
  parity.
- **Lateral is the decoded engine lateral:** `retail.lateral` is the
  `pickup-routes.json` segment lateral (origin-relative, `[0, width]`), not a
  racing-line-relative offset. The clamp is applied to that value and the
  applied value is what the module returns.
- **No invented coordinate:** every `x/y/z` comes from a committed measured
  sample plus the clamped lateral along that sample's left normal `(-tz, tx)`.
  A pickup with no finite arc, no positive route length or no measured sample
  is returned in `unsupported` with the uid and reason; it is never dropped or
  guessed.
- **Not a renderer claim:** this is placement data only. No draw, GPU, physics
  or gameplay claim.

## Physical retail placement (PWR10)

PWR9's rule is a global arc-fraction remap: it is applicable to every pickup but
a pickup's position is not its retail world position. PWR10 replaces the global
fraction with a committed **measured-arc ↔ retail-arc correspondence table** and
keeps every pickup whose retail arc has no measured correspondence in
`unsupported`.

```powershell
node probes/powerups/tools/build_arc_correspondence.mjs
node probes/powerups/tools/build_physical_placement.mjs
node probes/powerups/tools/verify_physical_placement.mjs
```

`retail-placement-physical.mjs` is the committed, browser-importable ES module.
It embeds `data/arc-correspondence.json` (107 KB) and
`data/retail-placement-physical.json` (126 KB) and exports
`PHYSICAL_PLACEMENT_SCHEMA`, `ARC_CORRESPONDENCE`, `PHYSICAL_PLACEMENT_DATA` and
`physicalPlacementsFor(mapId, layout)`.

### Correspondence table

`data/arc-correspondence.json` projects every measured sample onto every retail
racing line (clamped segment projection, closed routes wrap), keeps the residual
distance and retail arc, splits each route into contiguous runs inside
`gateMetres = 6.0 m` (the measured band half-width), unwraps the retail arc
across a closure and takes the longest non-decreasing subsequence (monotone
chain). A run is kept only when it has at least 8 samples, 2 m of measured arc
and 1 m of retail arc. A run that travels backwards along the retail route
collapses to one point and is dropped; the dropped runs are recorded under
`rejectedRuns` with the reason.

| map | measured | samples inside 6 m | segments | measured m | residual median / max | nearest network min / median / max | nearest MainLoop median |
| --- | ---: | ---: | ---: | ---: | --- | --- | ---: |
| amboy | 2,060.595 m | 888 / 8,673 | 0 | 0 | n/a | 0.004 / 22.979 / 196.744 m | 71.226 m |
| gracia | 624.914 m | 876 / 2,571 | 5 | 221.361 m | 3.538 / 5.990 m | 0.029 / 9.635 / 151.987 m | 10.027 m |
| river | 310.395 m | 0 / 1,245 | 0 | 0 | n/a | 34.869 / 66.822 / 81.758 m | 70.790 m |

The measured draw paths are not the retail racing line. Amboy's in-gate runs are
either reverse (the measured course travels backwards along the retail route, so
the monotone chain collapses to one point) or a crossing with a monotone chain
that is too short or too narrow in retail arc; the largest is `Logic` measured
991.3–1,060.3 m (293 samples, chain 7, retail span 0.21 m). River's whole course
runs 34.9–81.8 m from the retail network, so no sample is inside the gate. Only
Gracia has a usable correspondence: measured 300.9–571.4 m maps to retail
`MainLoop` 2,143.9–2,391.6 m (four segments) plus a 13.4 m `Logic` segment.

### Result

| map | placeable / retail | unsupported | clamped | mapping residual median / max | retail world error median / max |
| --- | ---: | ---: | ---: | --- | --- |
| amboy | 0 / 82 | 82 | 0 | n/a | n/a |
| gracia | 5 / 59 | 54 | 4 | 4.689 / 5.091 m | 10.337 / 19.396 m |
| river | 0 / 54 | 54 | 0 | n/a | n/a |

The five Gracia pickups (uids `2234632569`, `3669525037`, `5715789`,
`2287257657`, `2161991382`) sit on `MainLoop` retail arcs 2,217.2–2,221.6 m and
map to measured arcs 382.0–388.0 m. Every other retail pickup is `unsupported`
with a `no-measured-correspondence` reason naming the route, the retail arc and
the correspondence ranges. No pickup is dropped silently, and no map with no
usable match is filled with a synthetic correspondence.

Import contract:

```js
import {
  PHYSICAL_PLACEMENT_SCHEMA, ARC_CORRESPONDENCE, PHYSICAL_PLACEMENT_DATA,
  physicalPlacementsFor
} from '../../powerups/retail-placement-physical.mjs';
const set = physicalPlacementsFor('gracia', layout);
// layout = the measured layout the page drives:
//   { course: { lengthMetres, band|corridor, samples: [{ arc, x, z, groundY }, ...] } }
// set = { schema, mapId, physicalProjection: true, source, pickups, unsupported }
// pickups[]: { id, uid, type, x, y, z, arc, measuredArc, retailArc, routeLengthM,
//              lateral, retailLateral, clamped, clampedBy, route, routeIndex,
//              segmentId, mappingResidualM, sampleIndex, physicalProjection: true, source }
// unsupported[]: { id, uid, type, reason }
```

Rule (recorded in every `source` string):

```text
segment       = the correspondence segment of the pickup route whose retail-arc
                interval contains the pickup retail arc
measuredArc   = interpolate(segment.points, retail.arc)
sample        = nearest measured sample to measuredArc (ties to the earlier)
appliedLateral= clamp(retail.lateral, -band, +band)
x/z           = sample.x/z + leftNormal(sample) * appliedLateral
y             = sample.groundY
```

Scope labels:

- **Physical along-track correspondence:** `measuredArc` is interpolated from the
  committed correspondence segment that contains the pickup's retail arc. There
  is no global fraction. The module rejects a layout whose length, sample count
  or first/last sample differ (`layout-mismatch`) and an empty layout
  (`no-measured-sample`), returning every retail uid as unsupported instead of
  placing on the wrong course.
- **Gate is the measured band:** `gateMetres = 6.0` is the measured band
  half-width. It is a placement-consistency gate, not a road-width claim: a
  residual larger than the band would move a pickup further than the band the
  placement itself declares.
- **Lateral is the PWR9 convention:** every retail pickup sits on the retail
  racing line (`lateral = width * offset` to within 1e-4 m). The applied lateral
  is still the origin-relative `pickup-routes.json` lateral, clamped to ±band. It
  is a corridor coordinate, not an offset from the racing line, so it is a
  project placement choice. The world-position error (median 10.337 m, max
  19.396 m on the five Gracia pickups) is dominated by that clamp; the
  along-track arc is the physical claim.
- **No invented correspondence:** Amboy and River have no usable monotone
  segment. Their numbers are recorded in the table above and every pickup stays
  unsupported. A world-position projection would place 2 Amboy pickups
  (`505192272`, `4245419773`) within 6 m of the measured polyline, but that is a
  different rule and is not applied here.
- **Counts:** every retail uid appears exactly once in `pickups` or
  `unsupported`; the count per map is checked against `pickup-routes.json`
  (82 / 59 / 54).
- **Not a renderer claim:** this is placement data only. No draw, GPU, physics
  or gameplay claim.

Verifier: **2,621/2,621** checks, two builds byte-identical. The verifier
re-reads `pickup-routes.json`, the measured layouts and the committed
correspondence, re-implements the monotone-chain match and the placement rule,
checks every segment is monotone in measured and retail arc, every residual is
inside the gate, every placed pickup is inside the measured band, every retail
uid appears once, and compares two fresh builder runs with the committed JSON
and module.

## PWR1 definitions

```powershell
& $py probes/powerups/tools/build_powerups.py
& $py probes/powerups/tools/verify_powerups.py
node probes/powerups/rules/tests.mjs
```

`_work/powerups/powerups.json` is the definition manifest; see
`docs/work/analysis/powerups.md` for the field set, unknowns and rules
prototype.

## Rules

- Read-only game data. No decrypted fixture, manifest or `_work/` output is
  committed.
- No guessed position, type, row, enum integer or respawn value. Unknowns stay
  typed in the manifest.
- Placement data is not a renderer, GPU or full-game claim.
