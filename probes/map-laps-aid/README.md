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

## Detour tiers

A station whose racing point is not car-half-width (1.138 m) clear may move
along its own normal to a band-clear position. Two bounded windows are tried in
order:

| tier | window | meaning |
| --- | ---: | --- |
| `band` | ±12 m | the declared respawn band (`CORRIDOR_HALF_WIDTH`); tried first |
| `wide` | ±24 m | **a new course**, twice the declared band; tried only when `band` fails |

A tier is accepted only when the **whole** detoured line is band-clear and
continuous (consecutive samples at most 0.5 m apart) and returns to the racing
line when the racing point becomes clear. The `wide` tier is never a substitute
for a `band` result: it is attempted only after `band` has a station with no
band-clear lateral position (or no continuous detour). A level is `path` only
when one tier passes end to end; otherwise it stays `blocked` with the first
station that cannot be detoured at the widest attempted tier.

The path document records the tier bound as `source.aid.detourSearchMetres`
(12 or 24). A `wide` path additionally records `source.aid.detourTier: "wide"`
and the failed `band` attempt in `source.aid.detourTierAttempts`. The `band`
tier is the default and is not named in the document; this keeps the two
committed band documents byte-identical to the versions pinned by
`probes/e1-drive/web/map-registry.js` (`layoutFileSha256`).

## Result

| level | mapId | verdict | tier tried | `.aid` file / record | length | detour stations (max offset) | blocker |
| --- | --- | --- | --- | --- | ---: | --- | --- |
| `usa_ny_dumbo` | `dumbo` | **path** | `band` | `usa_ny_dumbo_2.aid`, `MainLoop` route 2, record `2270742337` | 361.999436 m | 0 (0 m) | — |
| `usa_la_downtown_multiplayer` | `downtown-mp` | **path** | `band` | `usa_la_downtown_multiplayer_figureof8.aid`, `Mainracing` route 0, record `4228808123` | 86.452776 m | 231 (9.5 m) | — |
| `uk_london_hackney` | `hackney` | blocked | `band` → `wide` | `uk_london_hackney_4.aid`, `MainLoop` route 1, record `1602485103` | — | — | 221 stations have no band-clear lateral even at ±24 m; first at station 2,890/10,012, racing point **(-227.278106, -133.764788)** |
| `uk_brighton` | `brighton` | blocked | `band` → `wide` | `uk_brighton_2.aid`, `MainLoop` route 3, record `2322912142` | — | — | `band`: 810 stations, first at 609 **(73.591833, -174.809792)**; `wide`: 24 stations, first at 670 **(84.516652, -185.448468)** |
| `usa_sanfran_sausalito` | `sausalito` | blocked | `band` → `wide` | `usa_sanfran_sausalito_1.aid`, `MainLoop` route 5, record `1501209191` | — | — | `band`: 7,799 stations; `wide`: 7,024 stations; first at station 4/18,196, racing point **(709.521209, -1434.502293)** |
| `usa_sanfran_russianhill` | `russianhill` | blocked | none | `usa_sanfran_russianhill_1.aid`, `MainLoop` route 0, record `2877899465` | — | — | no racing line within 25 m of the spawn; nearest point **(-48.467753, 322.743199)** at **175.140 m**; nearest band-clear point **(-49.698497, 323.774200)** at **175.147 m**, beyond the 25 m snap limit |
| `spa_barcelona_bowl_multiplayer` | `bowl` | blocked | none | none | — | — | no `.aid` file exists under `\gamedata\levels\spa_barcelona_bowl_multiplayer\`; the directory ships only `actorpack.xt` |

Two levels are paths: **`dumbo`** (the racing line itself is clear) and
**`downtown-mp`** (231 of its 334 stations detour, up to 9.5 m, inside the
declared ±12 m band). The wide tier was attempted on the three
`no-band-clear-lateral` levels and did not make any of them a path.

### Wide-tier outcome, per level

The wide tier is a real search, not a formality: on `brighton` it resolves 786
of the 810 band-tier blockers (station 609 gains 21 clear offsets at −24.00 …
−19.00 m). It still cannot finish the line.

| level | band (±12 m) undetourable | wide (±24 m) undetourable | first wide station | wide result |
| --- | ---: | ---: | --- | --- |
| `hackney` | 221 in 3 runs (longest 103) | 221 in 3 runs (longest 103) | 2,890 (-227.278106, -133.764788) | no gain; the same stations are blocked |
| `brighton` | 810 in 16 runs (longest 206) | 24 in 5 runs (longest 14) | 670 (84.516652, -185.448468) | 786 resolved, 24 remain |
| `sausalito` | 7,799 in 24 runs (longest 2,060) | 7,024 in 24 runs (longest 1,878) | 4 (709.521209, -1434.502293) | 775 resolved, 7,024 remain |

The first blockers are inside the P48 raster (not a coverage hole): passable
ground is 0.5–7.4 m away, but no 2.276 m car band fits perpendicular to the
racing line anywhere in the window. These are data limits of the committed
collision slice, not extraction failures.

### `dumbo`

The `MainLoop` racing line (line index 5) between the point nearest the
committed spawn and the point nearest the committed draw-path end. The racing
line itself is car-half-width clear on this segment, so no lateral shift was
needed (`lateralOffsets` are all zero, 0 detour stations, tier `band`).

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
4. **Project onto P48 with a bounded lateral detour, in tiers.** The segment is
   resampled at 0.25 m. Each station is checked against
   `_work/map-laps/<mapId>/grid.npz` `base` (the same P48 passable raster the
   existing builder uses) and the car half-width (1.138 m) lateral band. The
   detour rule is:

   - if every station's racing point is band-clear, the racing line is the
     path (no detour);
   - otherwise a station whose racing point is not band-clear may move along
     its own normal to a band-clear position inside the tier window (`band`
     ±12 m, then `wide` ±24 m), searched at **0.25 m**;
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

   A station with no band-clear position anywhere in the tier window is a
   typed blocker (`no-band-clear-lateral`) with its exact coordinate. A station
   that no continuous detour can reach is a typed blocker (`detour-dp`) with its
   exact coordinate. The band tier is tried first; the wide tier is tried only
   after it fails, and both attempts are recorded in
   `blocker.detourTierAttempts`.
5. **Snap the spawn (only when the line is out of match range).** If no racing
   line passes within 25 m of the committed spawn, the builder measures the
   nearest band-clear 0.25 m station on the whole closed line, using the same
   0.5 m central-difference tangent the path validation uses. A candidate
   farther than 25 m keeps the level blocked; the distance and the candidate
   pose (x, z, heading, groundY, arc) are recorded in `blocker.spawnSnap`. A
   candidate inside 25 m would become the path start.
6. **Gates.** The same rule as `probes/map-laps/tools/build_batch_paths.py`:
   start at sample 0, finish at the last sample, checkpoints at the straightest
   sample within ±12 % of the nominal 1/3 and 2/3 arcs, a 5 m tangent window,
   an 8 m gate line narrowed to the widest line that is at least 50 % passable
   with a fully passable car-half-width centre, and an approach point at least
   1 m from the gate. Gate lines are rules geometry only.

No coordinate is invented. Every emitted sample is either a decoded `.aid`
racing-line point or a lateral shift along that station's own normal inside the
attempted tier window, and every sample is on the P48 passable raster with a
passable car band. The detour is a geometric lane shift, not a driven line.

## Why five levels are still blocked

The retail racing line is an AI route, not a collision-clear surface. On these
levels the P48 raster (0.5 m cells, 2.5 cm step limit, 0.5 m wall dilation) is
narrower than the 2.276 m car band at the recorded stations, even after the
±24 m wide search, or the line leaves the spawn's connected passable component
entirely. The blockers are witnesses, not guesses:

- `hackney`: 221 stations have no band-clear lateral position in either window
  (the wide tier gains nothing). The first is station 2,890 at
  **(-227.278106, -133.764788)**.
- `brighton`: the wide tier resolves 786 of the 810 band-tier blockers, but 24
  stations remain in 5 short runs. The first wide-tier blocker is station 670
  at **(84.516652, -185.448468)**; the band-tier first is station 609 at
  **(73.591833, -174.809792)**.
- `sausalito`: 7,024 stations remain undetourable at ±24 m (from 7,799 at
  ±12 m), including the first station 4 at **(709.521209, -1434.502293)**.
  The line is blocked for most of the 4,548.891 m segment.
- `russianhill`: the only shipped `MainLoop` passes 175.140 m from the
  committed spawn, beyond the 25 m (six 4 m route steps) match limit. The
  nearest band-clear point on that line is 175.147 m away at
  **(-49.698497, 323.774200)**, so the snap is also beyond the limit. The
  route record for the spawn's route number has no shipped `.aid`.
- `bowl`: the level directory ships no `.aid` at all; its only entry is
  `actorpack.xt`.

These are data limits of the committed collision slice, not extraction
failures. A different spawn/finish pose, a wider raster rule or decoded
instanced/fluid collision would be needed. The wide tier is deliberately capped
at ±24 m: beyond that it would stop being a bounded detour of the retail line
and become an unrelated course.

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
| `probes/map-laps-aid/data/dumbo-aid-path.json` | 197,466 | `6f9b500f43b6a6537ca42f0ef200e19e172d8e3310451c64630ccb55e1f20f86` |
| `probes/map-laps-aid/data/downtown-mp-aid-path.json` | 148,900 | `5aa5f4522759130c08ed4a35300e0d3709afd8777ddc9f21e2194f177ce0c25b` |
| `probes/map-laps-aid/data/aid-paths.json` | 14,946 | `9eb658d9cff4c57cfcb0f8c4309e0c9b14dbe34a3df93e6f88ab5702013f027c` |

Content hashes (canonical JSON, excluding `hash`):

- `dumbo-aid-path.json`:
  `sha256:526736bf09cb7b168a2cd12685859eb2386a215c904fe852f2dba403254f2bf3`
- `downtown-mp-aid-path.json`:
  `sha256:d0a109d8a48bf59d5d756a3488c912f2b8c68bf6336bf7271001a83179816779`

The two path documents are unchanged from the previous revision (same bytes and
hashes); only `aid-paths.json` gained the tier fields. This keeps the
`probes/e1-drive` `layoutFileSha256` pins valid.

## Verifier

`verify_aid_paths.mjs` re-derives:

- the `.aid` route choice (closed, non-logic, ≥ 300 m, nearest spawn) from the
  pak and compares it with the recorded route;
- the `.aid` record identity (pak path, route name/index, record id, route
  number, sha256) against `routes.json` and the pak;
- every path sample against the P48 `base` raster and the car half-width band;
- the detour tier: the summary tier name and window, the path document's
  `detourSearchMetres`, the `wide` tier name when used, and that every lateral
  offset stays inside the tier window;
- every detour record: the racing point, the detour point, the lateral offset,
  the band clearance in both frames, the 0.5 m continuity bound, the return to
  the racing line (a detour run is bounded by zero-offset samples, starts and
  ends within one 0.25 m step, and contains at least one blocked racing point),
  and the path start/finish projections;
- the gate order, arcs, ±12 % checkpoint window, 1 m approach side and gate-line
  passability;
- every blocked witness: the spawn match distance and its band-clear snap
  candidate, the per-tier undetourable station counts and first stations, or
  the `detour-dp` station;
- the `bowl` directory: no `.aid` entry and the exact recorded directory
  contents.

Current result:

```text
281/281 checks passed
```
