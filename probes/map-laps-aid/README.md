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
`data/aid-paths.json`, `data/dumbo-aid-path.json` and
`data/downtown-mp-aid-path.json`.

## Result

| level | mapId | verdict | `.aid` file / record | length | detour stations (max offset) | gate arcs (m) | blocker |
| --- | --- | --- | --- | ---: | --- | --- | --- |
| `usa_ny_dumbo` | `dumbo` | **path** | `usa_ny_dumbo_2.aid`, `MainLoop` route 2, record `2270742337` | 361.999436 m | 0 (0 m) | 0, 160.749632, 199.999614, 361.999436 | — |
| `usa_la_downtown_multiplayer` | `downtown-mp` | **path** | `usa_la_downtown_multiplayer_figureof8.aid`, `Mainracing` route 0, record `4228808123` | 86.452776 m | 231 (9.5 m) | 0, 27.102020, 66.218505, 86.452776 | — |
| `uk_london_hackney` | `hackney` | blocked | `uk_london_hackney_4.aid`, `MainLoop` route 1, record `1602485103` | — | — | — | no band-clear lateral in the ±12 m window at station 2,890/10,012, racing point **(-227.278106, -133.764788)**; 221 stations |
| `uk_brighton` | `brighton` | blocked | `uk_brighton_2.aid`, `MainLoop` route 3, record `2322912142` | — | — | — | no band-clear lateral in the ±12 m window at station 609/8,662, racing point **(73.591833, -174.809792)**; 810 stations |
| `usa_sanfran_sausalito` | `sausalito` | blocked | `usa_sanfran_sausalito_1.aid`, `MainLoop` route 5, record `1501209191` | — | — | — | no band-clear lateral in the ±12 m window at station 4/18,196, racing point **(709.521209, -1434.502293)**; 7,799 stations |
| `usa_sanfran_russianhill` | `russianhill` | blocked | `usa_sanfran_russianhill_1.aid`, `MainLoop` route 0, record `2877899465` | — | — | — | no racing line within 25 m of the spawn; nearest point **(-48.467753, 322.743199)** at **175.140 m** |
| `spa_barcelona_bowl_multiplayer` | `bowl` | blocked | none | — | — | — | no `.aid` file exists under `\gamedata\levels\spa_barcelona_bowl_multiplayer\` |

Two levels are paths: **`dumbo`** (the racing line itself is clear) and
**`downtown-mp`** (231 of its 334 stations detour, up to 9.5 m). The other five
keep a typed blocker with the exact first station that cannot be detoured.

### `dumbo`

The `MainLoop` racing line (line index 5) between the point nearest the
committed spawn and the point nearest the committed draw-path end. The racing
line itself is car-half-width clear on this segment, so no lateral shift was
needed (`lateralOffsets` are all zero, 0 detour stations).

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

### `downtown-mp`

The `Mainracing` racing line (line index 5) of
`usa_la_downtown_multiplayer_figureof8.aid`. The racing line is blocked for most
of the 83.293 m segment, so the detour rule moves 231 of the 334 stations
sideways. The detour is one continuous run from station 103 to station 333:

- station 103: offset **-0.25 m** (the first ramp step), racing point
  **(235.061774, -161.275209)**;
- station 333: offset **-9.50 m**, racing point **(180.040369, -174.901235)**,
  detour point **(179.756889, -165.405465)**;
- maximum lateral offset: **9.50 m** (inside the declared ±12 m respawn band);
- maximum jump between consecutive samples: **0.3536 m** (bound 0.5 m);
- path length: **86.452776 m**; 334 samples at 0.25 m.

The path start is **1.1894 m** from the committed spawn (no start detour). The
path end is **9.5976 m** from the committed draw-path end; the racing-line point
nearest that end is **0.0975 m** away, so the difference is the finish detour
offset. Both values are recorded (`source.endpoints.finishProjection.metres`
and `.racingLineProjectionMetres`); the path does not claim to end at the
committed draw-path end.

This is a big detour, not a retail racing line: the path is a lateral shift of
the AI line inside the declared respawn band. It is a data layout, not a driven
lap.

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
4. **Project onto P48 with a bounded lateral detour.** The segment is resampled
   at 0.25 m. Each station is checked against `_work/map-laps/<mapId>/grid.npz`
   `base` (the same P48 passable raster the existing builder uses) and the car
   half-width (1.138 m) lateral band. The detour rule is:

   - if every station's racing point is band-clear, the racing line is the
     path (no detour);
   - otherwise a station whose racing point is not band-clear may move along
     its own normal to a band-clear position inside the declared **±12 m
     respawn band** (`CORRIDOR_HALF_WIDTH`), searched at **0.25 m**;
   - the detour is **continuous**: consecutive detour points are at most
     **0.5 m** apart (with 0.25 m stations this is at most one 0.25 m lateral
     step);
   - the line **returns to the racing line** (offset 0) as soon as continuity
     allows; the path starts and ends on the racing line whenever the racing
     point there is band-clear;
   - the band at every sample is evaluated in two frames: the racing-line frame
     (the search frame) and the line's own local tangent (the 0.5 m central
     difference the verifier uses). A candidate must be clear in both;
   - a deterministic **second-order dynamic program** chooses the offsets. The
     state is the previous and current offset, so the tangent at station `i`
     (which depends on the points at `i-1` and `i+1`) is known when station `i`
     is validated. The cost is total lateral deviation plus 8× the lateral
     change, so the detour neither zigzags nor lingers. A first-order program
     cannot see that tangent and produces a zigzag whose rotated band fails;
   - every detour is recorded as
     `{ station, racingPoint, detourPoint, lateralOffset, reason }` in
     `source.aid.detours`.

   A station with no band-clear position anywhere in the ±12 m window is a
   typed blocker (`no-band-clear-lateral`) with its exact coordinate. A station
   that no continuous detour can reach is a typed blocker (`detour-dp`) with its
   exact coordinate.
5. **Gates.** The same rule as `probes/map-laps/tools/build_batch_paths.py`:
   start at sample 0, finish at the last sample, checkpoints at the straightest
   sample within ±12 % of the nominal 1/3 and 2/3 arcs, a 5 m tangent window,
   an 8 m gate line narrowed to the widest line that is at least 50 % passable
   with a fully passable car-half-width centre, and an approach point at least
   1 m from the gate. Gate lines are rules geometry only.

No coordinate is invented. Every emitted sample is either a decoded `.aid`
racing-line point or a lateral shift along that station's own normal inside the
declared ±12 m respawn band, and every sample is on the P48 passable raster with
a passable car band. The detour is a geometric lane shift, not a driven line.

## Why five levels are still blocked

The retail racing line is an AI route, not a collision-clear surface. On these
levels the P48 raster (0.5 m cells, 2.5 cm step limit, 0.5 m wall dilation) is
narrower than the 2.276 m car band at the recorded stations, even after a ±12 m
lateral search, or the line leaves the spawn's connected passable component
entirely. The blockers are witnesses, not guesses:

- `hackney`, `brighton`, `sausalito`: a station on the racing line has no
  band-clear lateral position anywhere in the ±12 m window (221, 810 and 7,799
  stations respectively). The first undetourable station is recorded with its
  exact coordinate. Widening the window further would leave the declared
  respawn band, so it is a design decision, not a guess this probe is allowed
  to make.
- `russianhill`: the only shipped `MainLoop` passes 175.140 m from the
  committed spawn, beyond the 25 m (six 4 m route steps) match limit. The
  route record for the spawn's route number has no shipped `.aid`.
- `bowl`: the level directory ships no `.aid` at all.

These are data limits of the committed collision slice, not extraction
failures. A different spawn/finish pose, a wider raster rule or decoded
instanced/fluid collision would be needed.

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
map; no lap was driven. The `downtown-mp` path additionally carries a lateral
detour of up to 9.5 m; it is still a data layout, not a driven racing line.

## Files

| file | bytes | sha256 |
| --- | ---: | --- |
| `probes/map-laps-aid/data/dumbo-aid-path.json` | 197,466 | `9043eb18027459c8cf59a25a5517582cf8ee255a5ed6c7932f521fa46610da8b` |
| `probes/map-laps-aid/data/downtown-mp-aid-path.json` | 148,900 | `4b04ad914b58d18f67c90edc0c4b029a2c9c4c1e68bf09a2a7a22f2122e65a27` |
| `probes/map-laps-aid/data/aid-paths.json` | 9,600 | `03d96d9d42b455cd3ce1dd291526d0e404272c5f646ddf4900ae046978d1db6f` |

Content hashes (canonical JSON, excluding `hash`):

- `dumbo-aid-path.json`:
  `sha256:6b894f65d60582db924811aeee49e0b7c1831f11e2c399710fc5b165ff6b0a33`
- `downtown-mp-aid-path.json`:
  `sha256:ca771a575293c68fed149373dced4d1148fb7bd1967b038d7b2fa7a823a4630e`

## Verifier

`verify_aid_paths.mjs` re-derives:

- the `.aid` route choice (closed, non-logic, ≥ 300 m, nearest spawn) from the
  pak and compares it with the recorded route;
- the `.aid` record identity (pak path, route name/index, record id, route
  number, sha256) against `routes.json` and the pak;
- every path sample against the P48 `base` raster and the car half-width band;
- every detour record: the racing point, the detour point, the lateral offset,
  the band clearance in both frames, the 0.5 m continuity bound, the return to
  the racing line (a detour run is bounded by zero-offset samples, starts and
  ends within one 0.25 m step, and contains at least one blocked racing point),
  and the path start/finish projections;
- the gate order, arcs, ±12 % checkpoint window, 1 m approach side and gate-line
  passability;
- every blocked witness: the spawn match distance, the station with no
  band-clear lateral position in the ±12 m window, or the `detour-dp` station.

Current result:

```text
213/213 checks passed
```
