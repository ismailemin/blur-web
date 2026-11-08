# map-laps-aid — retail AI racing line projected onto collision

This probe builds a sprint path from the retail AI racing line (`.aid`) for the
seven `map-laps` levels that the collision point-to-point builder could not
solve:

`uk_london_hackney`, `usa_ny_dumbo`, `uk_brighton`, `usa_sanfran_sausalito`,
`usa_sanfran_russianhill`, `usa_la_downtown_multiplayer`,
`spa_barcelona_bowl_multiplayer`.

`showroom` is not attempted: it is not a race/sprint map and remains
`unsupported` in `probes/map-laps/data/remaining-paths.json`.

## Commands

```powershell
# Build the committed path documents and the per-level summary.
python probes/map-laps-aid/tools/build_aid_paths.py

# Compare the generated documents with the committed files.
python probes/map-laps-aid/tools/build_aid_paths.py --check

# Independent verifier: re-derives every verdict from the pak, .aid, routes,
# spawn/path documents and the P48 raster.
node probes/map-laps-aid/tools/verify_aid_paths.mjs
```

Use the bundled Python:

```text
C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe
```

Determinism: two consecutive `build_aid_paths.py` runs produce byte-identical
`data/aid-paths.json` and `data/dumbo-aid-path.json`.

## Result

| level | mapId | verdict | `.aid` file / record | length | gate arcs (m) | blocker |
| --- | --- | --- | --- | ---: | --- | --- |
| `usa_ny_dumbo` | `dumbo` | **path** | `usa_ny_dumbo_2.aid`, `MainLoop` route 2, record `2270742337` | 361.999436 m | 0, 160.749632, 199.999614, 361.999436 | — |
| `uk_london_hackney` | `hackney` | blocked | `uk_london_hackney_4.aid`, `MainLoop` route 1, record `1602485103` | — | — | no band-clear lateral at station 2,890/10,012, racing point **(-227.278106, -133.764788)**; 222 stations |
| `uk_brighton` | `brighton` | blocked | `uk_brighton_2.aid`, `MainLoop` route 3, record `2322912142` | — | — | no band-clear lateral at station 609/8,662, racing point **(73.591833, -174.809792)**; 952 stations |
| `usa_sanfran_sausalito` | `sausalito` | blocked | `usa_sanfran_sausalito_1.aid`, `MainLoop` route 5, record `1501209191` | — | — | no band-clear lateral at station 4/18,196, racing point **(709.521209, -1434.502293)**; 7,909 stations |
| `usa_sanfran_russianhill` | `russianhill` | blocked | `usa_sanfran_russianhill_1.aid`, `MainLoop` route 0, record `2877899465` | — | — | no racing line within 25 m of the spawn; nearest point **(-48.467753, 322.743199)** at **175.140 m** |
| `usa_la_downtown_multiplayer` | `downtown-mp` | blocked | `usa_la_downtown_multiplayer_figureof8.aid`, `Mainracing` route 0, record `4228808123` | — | — | projected path fails the car band at 20/334 samples; first station 112, **(233.226968, -162.573127)** |
| `spa_barcelona_bowl_multiplayer` | `bowl` | blocked | none | — | — | no `.aid` file exists under `\gamedata\levels\spa_barcelona_bowl_multiplayer\` |

The only path is **`dumbo`**. It is the `MainLoop` racing line (line index 5)
between the point nearest the committed spawn and the point nearest the
committed draw-path end. The racing line itself is car-half-width clear on this
segment, so no lateral shift was needed (`lateralOffsets` are all zero).

Recorded projections for `dumbo`:

- spawn → path start: **11.2225 m**;
- committed draw-path end → path end: **399.3514 m**;
- committed draw path length: 1292.449927 m (not the authority);
- path length: 361.999436 m; 1,449 samples at 0.25 m.

The 399.3514 m finish projection is a real data mismatch: the committed
draw-path end is not on this retail racing line. The path ends at the nearest
point on the line to that end. This is recorded in
`course.span.finishClearanceMetres` and `source.aid.finishProjectionMetres`;
it is not a claim that the path is the committed sprint course.

## Method

1. **Find the `.aid` files.** The retail rule is
   `LevelState.cpp:298`:
   `.\gamedata\levels\<city>\<route tag>.aid`. The builder enumerates every
   `.aid` entry under `\gamedata\levels\<level>\` in
   `game-data/Blur/cache/gamedata.pak` and decodes each with the committed
   reader `probes/course/tools/aid_decode.py` (a re-implementation of
   `AI_Amax.cpp:1595-2163`, `LoadVersionSix`). The enumeration is used because
   the route tag is not exposed by `routes.json`; it is the numeric route
   number for the six numbered files and `figureof8` for
   `usa_la_downtown_multiplayer_figureof8.aid`. The record id for that file is
   the city's single `AmaxRoute` record (`4228808123`).
2. **Choose the racing line.** Candidates are routes with `ROUTE_LOOPED`
   (bit 1), without `ROUTE_LOGIC_ZONE` (bit 32), at least 300 m long, with the
   11-line layout. The winner is the candidate whose racing line (line index 5,
   `RACING`) passes nearest the committed spawn pose. Ties go to the longer
   route, then the lower route index. The route record id comes from
   `_work/powerups/routes.json` by city and route number.
3. **Cut the segment.** The path starts at the point on the line nearest the
   committed spawn and ends at the point nearest the committed draw-path end,
   following the route's forward direction.
4. **Project onto P48.** The segment is resampled at 0.25 m. Each station is
   checked against `_work/map-laps/<mapId>/grid.npz` `base` (the same P48
   passable raster the existing builder uses) and the car half-width
   (1.138 m) lateral band. If the racing line itself is band-clear, it is the
   path. If not, a deterministic dynamic program shifts each station laterally
   within `min(10 m, serialized width / 2)` to the nearest band-clear position.
   A station with no band-clear lateral position is a typed blocker with its
   exact coordinate. A resampled station whose band is blocked is a typed
   blocker with its exact coordinate.
5. **Gates.** The same rule as `probes/map-laps/tools/build_batch_paths.py`:
   start at sample 0, finish at the last sample, checkpoints at the straightest
   sample within ±12 % of the nominal 1/3 and 2/3 arcs, a 5 m tangent window,
   an 8 m gate line narrowed to the widest line that is at least 50 % passable
   with a fully passable car-half-width centre, and an approach point at least
   1 m from the gate. Gate lines are rules geometry only.

No coordinate is invented. Every emitted sample is either a decoded `.aid`
racing-line point or a lateral shift inside that segment's own serialized
width, and every sample is on the P48 passable raster with a passable car band.

## Why most levels are still blocked

The retail racing line is an AI route, not a collision-clear surface. On these
levels the P48 raster (0.5 m cells, 2.5 cm step limit, 0.5 m wall dilation) is
narrower than the 2.276 m car band at the recorded stations, or the line leaves
the spawn's connected passable component entirely. The blockers are witnesses,
not guesses:

- `hackney`, `brighton`, `sausalito`: a station on the racing line has no
  band-clear lateral position anywhere in the searched part of the serialized
  `.aid` width.
- `russianhill`: the only shipped `MainLoop` passes 175.140 m from the
  committed spawn, beyond the 25 m (six 4 m route steps) match limit. The
  route record for the spawn's route number has no shipped `.aid`.
- `downtown-mp`: the lateral DP finds a path, but the resampled path's local
  tangent turns the car band into a blocked cell at 20 samples; the first is
  `(233.226968, -162.573127)`.
- `bowl`: the level directory ships no `.aid` at all.

These are data limits of the committed collision slice, not extraction
failures. A different spawn/finish pose, a wider raster rule or decoded
instanced/fluid collision would be needed; that is a design decision, not a
guess this probe is allowed to make.

## Scope labels

The path document carries:

- `scope.collisionOnly: true`
- `scope.retailRacingLine: true`
- `scope.retailStartLine: false`
- `scope.rendererClaim: false`
- `scope.vehiclePhysics: false`
- `scope.gameRun: false`
- `scope.pathDriven: false`

The path is **the retail AI racing line projected onto collision, not a retail
start line**. It is a data layout, not an e1-drive integration: no gate mesh,
no race director, no lap timing, no car simulated. A path is not a playable
map; no lap was driven.

## Files

| file | bytes | sha256 |
| --- | ---: | --- |
| `probes/map-laps-aid/data/dumbo-aid-path.json` | 194,979 | `14bee4c51e8f41f44c10d186a09fa0ac432e26453b81ed14bc31d4e5bf5ae79c` |
| `probes/map-laps-aid/data/aid-paths.json` | 8,916 | `8ccfa6ee82b4f9b160e129becdc6d8e319e20d1b35835f6ca6d3c0b646077fef` |

`dumbo-aid-path.json` content hash (canonical JSON, excluding `hash`):
`sha256:f2015e5b99af0be85bf6a1fae056e6fcf791bd186201c66107ceb0fc2ce42cbf`.

## Verifier

`verify_aid_paths.mjs` re-derives:

- the `.aid` route choice (closed, non-logic, ≥ 300 m, nearest spawn) from the
  pak and compares it with the recorded route;
- the `.aid` record identity (pak path, route name/index, record id, route
  number, sha256) against `routes.json` and the pak;
- every path sample against the P48 `base` raster and the car half-width band;
- the gate order, arcs, ±12 % checkpoint window, 1 m approach side and gate-line
  passability;
- every blocked witness: the spawn match distance, the station with no
  band-clear lateral position, or the resampled path's band failure.

Current result:

```text
111/111 checks passed
```
