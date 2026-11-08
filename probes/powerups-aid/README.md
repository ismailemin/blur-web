# probes/powerups-aid

True **world-position** retail pickup placement for the e1-drive power-up slice.
Nothing here changes `probes/powerups/`, `probes/e1-drive/`, `game-data/`,
`upstream/` or `_work/`. The only inputs are read-only committed documents.

This probe answers one question: *if a retail pickup is put at its actual
retail world position, is that position inside the measured course's drivable
band?* It is not an arc-fraction remap and it never moves a pickup onto the
course.

## Contents

| path | purpose |
| --- | --- |
| `tools/build_physical_placement.mjs` | deterministic builder for the JSON + module |
| `tools/physical_placement_module.template.mjs` | template for the generated browser module |
| `tools/verify_physical_placement.mjs` | independent re-derivation, band/count/determinism verifier |
| `data/physical-placement.json` | committed per-map rows, placeable list, off-course list, counts, residuals |
| `physical-placement.mjs` | browser-importable `physicalPlacementsFor(mapId, layout)` |

## Command

```powershell
node probes/powerups-aid/tools/build_physical_placement.mjs
node probes/powerups-aid/tools/verify_physical_placement.mjs
```

Both are dependency-free Node scripts. The builder is deterministic: two runs
are byte-identical.

## Rule

```text
routePoint    = interpolate(route.points, retail.arc)          // .aid racing line, line index 5
tangent       = normalize(routePoint[i+1] - routePoint[i-1])   // planar
normal        = (tangent.z, -tangent.x)                        // .aid frame normal = (fz, -fx)
lateralOffset = retail.lateral - retail.width * racingOffsets[retail.segment]
candidate     = routePoint + normal * lateralOffset
retailWorld   = the candidate (normal or -normal) that reproduces the committed
                retail WorldMatrix.aw position; `normalSign` records which one
aidResidualM  = planar distance between retailWorld and the committed retail position

nearest       = clamped segment projection of retailWorld onto the measured polyline
inside        = nearest.distance <= band.halfWidthMetres
placeable     = inside: x/z = retailWorld, y = nearest measured sample groundY,
                arc = nearest.arc (exact measured arc), retailArc = retail.arc,
                lateral = retail.lateral, residualM = nearest.distance
off-course    = not inside: distanceToCourseM = nearest.distance,
                distanceToBandM = nearest.distance - band, nearestMeasuredArc = nearest.arc
```

The `.aid` serializes the lateral normal as `(tangentX, -tangentZ)`; its sign
relative to the stored point order is authored per route (for example
`TrainAltOne` and `AltFive` are reversed). The builder therefore compares the
two candidates with the committed retail `WorldMatrix.aw` and keeps the one
that reproduces it. That comparison is a **sign disambiguation, not a position
source**; `aidResidualM` records how closely the kept candidate reproduces the
committed position. Every pickup's residual is stored, and the verifier
re-derives it independently.

The band is `course.band.halfWidthMetres` when present, otherwise
`course.corridor.halfWidthMetres`. It is a declared controller/respawn band, not
a road-width claim.

## Result on the committed layouts

| map | layout | measured length | band | retail | placeable | off-course |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| amboy | `_work/e1-drive/amboy/layout.json` | 2,060.595 m | ±6 m | 82 | **2** | **80** |
| gracia | `_work/e1-drive/gracia/layout.json` | 624.914 m | ±6 m | 59 | **2** | **57** |
| river | `_work/e1-drive/sprint.json` (310 m) | 310.395 m | ±6 m | 54 | **0** | **54** |

### Placeable pickups

| map | uid | type | retail route | retail arc | measured arc | centreline residual |
| --- | ---: | --- | --- | ---: | ---: | ---: |
| amboy | 505192272 | Shunt | `JunctionTwo` | 8.430 m | 1,050.115 m | 0.464 m |
| amboy | 4245419773 | Blindfire | `AltTwo` | 566.125 m | 521.439 m | 1.675 m |
| gracia | 5715789 | Bomb | `MainLoop` | 2,219.311 m | 391.213 m | 4.996 m |
| gracia | 2287257657 | Blindfire | `MainLoop` | 2,218.246 m | 383.085 m | 0.813 m |

The nearest off-course pickups are Amboy uid 4158343510 (8.896 m from the
centreline, 2.896 m outside the band), Gracia uid 2234632569 (6.997 m,
0.997 m outside) and River uid 1332285785 (72.818 m, 66.818 m outside). They
stay off-course; no coordinate is invented to pull them in.

### Residuals

| map | `.aid` reconstruction residual median / max | placeable centreline residual median / max | off-course distance to centreline min / median / max | off-course distance outside band min / median / max |
| --- | --- | --- | --- | --- |
| amboy | 0.057 / 0.758 m | 1.069 / 1.675 m | 8.896 / 210.233 / 720.227 m | 2.896 / 204.233 / 714.227 m |
| gracia | 0.085 / 0.724 m | 2.904 / 4.996 m | 6.997 / 449.417 / 992.034 m | 0.997 / 443.417 / 986.034 m |
| river | 0.033 / 0.908 m | n/a (0 placeable) | 72.818 / 490.687 / 1,395.758 m | 66.818 / 484.687 / 1,389.758 m |

The `.aid` reconstruction residual is the planar distance between the
reconstructed retail world position and the committed retail `WorldMatrix.aw`
position. It is a decode check: a sub-metre value means the route/arc/lateral
decode reproduces the retail actor position. It is not used to move anything.

## Import contract

```js
import {
  PHYSICAL_PLACEMENT_SCHEMA, PHYSICAL_PLACEMENT_DATA_SCHEMA,
  PHYSICAL_PLACEMENT_DATA, physicalPlacementsFor
} from '../../powerups-aid/physical-placement.mjs';

const set = physicalPlacementsFor('amboy', layout);
// layout = the measured layout the page drives:
//   { course: { lengthMetres, band|corridor, samples: [{ arc, x, z, groundY }, ...] } }
// set = {
//   schema: 'blur.powerups-aid-physical-placement/1',
//   mapId, physicalProjection: true, source,
//   pickups: [ ...placeable... ],
//   offCourse: [ ...off-course... ],
//   unsupported: [ ...cannot be evaluated (empty layout / no band)... ],
//   counts: { retailPlacements, placeable, offCourse, unsupported }
// }
//
// pickups[]: {
//   id, uid, type, x, y, z, arc, measuredArc, retailArc, routeLengthM,
//   lateral, retailLateral, route, routeIndex, segment, aidResidualM,
//   residualM, sampleIndex, physicalProjection: true, source
// }
// offCourse[]: {
//   id, uid, type, reason, x, z, retailArc, nearestMeasuredArc,
//   distanceToCourseM, distanceToBandM, route, routeIndex, segment, aidResidualM
// }
```

`pickups[]` is the same shape as `retail-placement-physical.mjs` (plus
`residualM`/`aidResidualM`); `offCourse[]` is the corresponding "not placed"
list. `unsupported[]` is only used when the layout cannot be evaluated at all
(empty `course.samples` or no band), so a valid layout always classifies every
retail uid into `pickups` or `offCourse`.

The module is layout-driven: it embeds the retail rows (retail world x/z,
retail arc, lateral) and recomputes the nearest measured point and the band test
for the layout passed in. It does not reject a different measured layout; it
reports the result for that layout. The committed JSON records the result for
the committed layouts.

## Scope labels

- **True world position, not a remap:** every placed `x/z` is the retail world
  position reconstructed on the committed `.aid` racing line from the decoded
  route, arc and lateral. There is no global arc fraction and no `fraction`
  field. `retailArc` and `arc`/`measuredArc` are both recorded so the two
  coordinate systems stay auditable.
- **Off-course is a result, not a fallback:** a pickup whose retail world
  position is outside the measured band is not moved. It keeps its retail world
  x/z and records `distanceToCourseM`, `distanceToBandM` (distance beyond the
  band edge) and `nearestMeasuredArc`. No pickup is dropped silently.
- **No invented coordinate:** the only use of the committed retail position is
  the `.aid` normal-sign disambiguation. `aidResidualM` records that check for
  every pickup. If a pickup had no route or no racing-line points it would be
  returned in `unsupported` with the uid and reason.
- **Band is a declared band:** `course.band.halfWidthMetres` (Amboy/Gracia) or
  `course.corridor.halfWidthMetres` (River 310 m), both ±6 m. It is a
  controller/respawn band, not a road-width claim.
- **Counts:** every retail uid appears exactly once in `rows` and exactly once
  in `placeable` or `offCourse`. The count per map is checked against
  `pickup-routes.json` (82 / 59 / 54).
- **Not a renderer claim:** this is placement data only. No draw, GPU, physics
  or gameplay claim.

## Verifier

`verify_physical_placement.mjs` does not import the builder. It re-reads
`pickup-routes.json`, the measured layouts, the committed JSON and the generated
module, re-implements the `.aid` reconstruction and the measured-band test, and
checks:

1. schemas, source pins and module exports;
2. layout identity (path, sha256, bytes, length, sample count, band);
3. every pickup's retail world position, normal sign and reconstruction residual;
4. every placeable pickup is inside the band and every off-course pickup is
   outside it with the exact centreline distance, band excess and nearest arc;
5. counts against `pickup-routes.json` and one classification per retail uid;
6. module output matches the committed lists and re-derives the same values;
7. two builder runs are byte-identical and match the committed JSON and module.

Result on the committed data: **6,424 / 6,424 checks passed**, two builds
byte-identical.

## Sources (read-only)

- `probes/powerups/data/pickup-routes.json` — retail `.aid` route network and
  per-pickup route/arc/lateral/width/segment (`sha256 362643ba…`).
- `_work/e1-drive/amboy/layout.json`, `_work/e1-drive/gracia/layout.json`,
  `_work/e1-drive/sprint.json` — measured courses the page drives.

The `.aid` decode itself is PWR8's committed artifact; this probe does not
re-decode the pak and does not modify PWR8.
