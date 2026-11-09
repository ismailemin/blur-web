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

A station whose racing point is not band-clear may move along its own normal to
a band-clear position. Three bounded tiers are tried in order:

| tier | window | band | margin | meaning |
| --- | ---: | ---: | ---: | --- |
| `band` | ±12 m | 2.276 m | 0.30 m | the declared respawn band (`CORRIDOR_HALF_WIDTH`); tried first |
| `wide` | ±24 m | 2.276 m | 0.30 m | **a new course**, twice the declared band; tried only when `band` fails |
| `narrow` | ±24 m | 1.680 m | 0 | **a new course** with the documented maximum car width and **no safety margin**; tried only when `wide` fails |

The `narrow` band is exactly 1.68 m: half-width 0.84 m sampled at 0.21 m
(9 samples, outermost at ±0.84 m). It is the documented maximum car width with
no safety margin — a design choice, not a recovered retail hull. The committed
`CAR_WIDTH` constant is 1.676 m; the tier records the documented 1.68 m value.

A tier is accepted only when the **whole** detoured line is band-clear and
continuous (consecutive samples at most 0.5 m apart) and returns to the racing
line when the racing point becomes clear. A later tier is never a substitute
for an earlier one: it is attempted only after the previous tier has a station
with no band-clear lateral position (or no continuous detour). A level is
`path` only when one tier passes end to end; otherwise it stays `blocked` with
the first station that cannot be detoured at the last attempted tier.

The path document records the tier bound as `source.aid.detourSearchMetres`
(12 or 24). A `wide` or `narrow` path additionally records
`source.aid.detourTier`, `source.aid.bandMetres`, `source.aid.marginMetres`,
`source.aid.detourTierReason`, the failed attempts in
`source.aid.detourTierAttempts`, and a `source.clearance.band` object. The
`band` tier is the default and is not named in the document; this keeps the two
committed band documents byte-identical to the versions pinned by
`probes/e1-drive/web/map-registry.js` (`layoutFileSha256`).

## Result

| level | mapId | verdict | tier tried | `.aid` file / record | length | detour stations (max offset) | blocker |
| --- | --- | --- | --- | --- | ---: | --- | --- |
| `usa_ny_dumbo` | `dumbo` | **path** | `band` (2.276 m) | `usa_ny_dumbo_2.aid`, `MainLoop` route 2, record `2270742337` | 361.999436 m | 0 (0 m) | — |
| `usa_la_downtown_multiplayer` | `downtown-mp` | **path** | `band` (2.276 m) | `usa_la_downtown_multiplayer_figureof8.aid`, `Mainracing` route 0, record `4228808123` | 86.452776 m | 231 (9.5 m) | — |
| `uk_london_hackney` | `hackney` | blocked | `band` → `wide` → `narrow` (1.68 m) | `uk_london_hackney_4.aid`, `MainLoop` route 1, record `1602485103` | — | — | `band`: 221; `wide`: 221; `narrow`: 219 stations; first narrow at station 2,890/10,012, racing point **(-227.278106, -133.764788)** |
| `uk_brighton` | `brighton` | blocked | `band` → `wide` → `narrow` (1.68 m) | `uk_brighton_2.aid`, `MainLoop` route 3, record `2322912142` | — | — | `band`: 810, first 609 **(73.591833, -174.809792)**; `wide`: 24, first 670 **(84.516652, -185.448468)**; `narrow`: 6, first 671 **(84.692995, -185.625677)** |
| `usa_sanfran_sausalito` | `sausalito` | blocked | `band` → `wide` → `narrow` (1.68 m) | `usa_sanfran_sausalito_1.aid`, `MainLoop` route 5, record `1501209191` | — | — | `band`: 7,799; `wide`: 7,024; `narrow`: 6,972 stations; first narrow at station 5/18,196, racing point **(709.746329, -1434.611018)** |
| `usa_sanfran_russianhill` | `russianhill` | blocked | none (spawn match) | `usa_sanfran_russianhill_1.aid`, `MainLoop` route 0, record `2877899465` | — | — | no racing line within 25 m of the spawn; nearest point **(-48.467753, 322.743199)** at **175.140 m**; nearest band-clear point **(-49.698497, 323.774200)** at **175.147 m**, beyond the 25 m snap limit |
| `spa_barcelona_bowl_multiplayer` | `bowl` | blocked | none | none | — | — | no `.aid` file exists under `\gamedata\levels\spa_barcelona_bowl_multiplayer\`; the directory ships only `actorpack.xt` |

Two levels are paths: **`dumbo`** (the racing line itself is clear) and
**`downtown-mp`** (231 of its 334 stations detour, up to 9.5 m, inside the
declared ±12 m band). The `wide` and `narrow` tiers were attempted on the three
`no-band-clear-lateral` levels; neither made any of them a path.

### Tier outcome, per level

The wider tiers are real searches, not formalities: on `brighton` the wide tier
resolves 786 of the 810 band-tier blockers (station 609 gains 21 clear offsets
at −24.00 … −19.00 m), and the narrow tier resolves 18 of the remaining 24.
Neither can finish the line.

| level | band (±12 m, 2.276 m) | wide (±24 m, 2.276 m) | narrow (±24 m, 1.68 m) | first narrow station |
| --- | ---: | ---: | ---: | --- |
| `hackney` | 221 in 3 runs (longest 103) | 221 in 3 runs (longest 103) | 219 in 3 runs (longest 102) | 2,890 (-227.278106, -133.764788) |
| `brighton` | 810 in 16 runs (longest 206) | 24 in 5 runs (longest 14) | 6 in 2 runs (longest 4) | 671 (84.692995, -185.625677) |
| `sausalito` | 7,799 in 24 runs (longest 2,060) | 7,024 in 24 runs (longest 1,878) | 6,972 in 28 runs (longest 1,878) | 5 (709.746329, -1434.611018) |

The first narrow-tier blockers are still inside the P48 raster (not a coverage
hole): passable ground is 0.5–7.4 m away, but no 1.68 m band fits perpendicular
to the racing line anywhere in the ±24 m window at those stations. These are
data limits of the committed collision slice, not extraction failures.

For `russianhill` the narrow tier is not reached: the spawn-match rule fails
first (the line is 175.140 m from the committed spawn). As a diagnostic, the
1.68 m band on that line still has 5,416 undetourable stations in 32 runs, the
first at station 1,628 **(212.172739, 11.903677)** — so even a successful snap
would not have produced a path.

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
   existing builder uses) and the tier's car band. The detour rule is:

   - if every station's racing point is band-clear, the racing line is the
     path (no detour);
   - otherwise a station whose racing point is not band-clear may move along
     its own normal to a band-clear position inside the tier window (`band`
     ±12 m, then `wide` ±24 m, then `narrow` ±24 m), searched at **0.25 m**;
   - the band is 2.276 m (1.676 m car + 0.30 m margin per side) for `band` and
     `wide`, and 1.680 m (the documented car width, no margin) for `narrow`.
     The narrow band is sampled at 0.21 m so its outermost samples are exactly
     ±0.84 m;
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
   exact coordinate. The tiers are tried in order; a later tier is attempted
   only after the previous one fails, and every attempt is recorded in
   `blocker.detourTierAttempts` with its band and margin.
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
narrower than even the 1.68 m no-margin band at the recorded stations, even
after the ±24 m search, or the line leaves the spawn's connected passable
component entirely. The blockers are witnesses, not guesses:

- `hackney`: 219 stations have no 1.68 m band-clear lateral position in the
  ±24 m window (221 at 2.276 m). The first is station 2,890 at
  **(-227.278106, -133.764788)**.
- `brighton`: the wide tier resolves 786 of the 810 band-tier blockers and the
  narrow tier resolves 18 of the remaining 24, but 6 stations remain in 2 short
  runs. The first narrow-tier blocker is station 671 at
  **(84.692995, -185.625677)**; the band-tier first is station 609 at
  **(73.591833, -174.809792)**.
- `sausalito`: 6,972 stations remain undetourable at 1.68 m (from 7,799 at
  2.276 m), including the first station 5 at **(709.746329, -1434.611018)**.
  The line is blocked for most of the 4,548.891 m segment.
- `russianhill`: the only shipped `MainLoop` passes 175.140 m from the
  committed spawn, beyond the 25 m (six 4 m route steps) match limit. The
  nearest band-clear point on that line is 175.147 m away at
  **(-49.698497, 323.774200)**, so the snap is also beyond the limit. The
  route record for the spawn's route number has no shipped `.aid`. The 1.68 m
  band would not have helped either: its first undetourable station is 1,628 at
  **(212.172739, 11.903677)**.
- `bowl`: the level directory ships no `.aid` at all; its only entry is
  `actorpack.xt`.

These are data limits of the committed collision slice, not extraction
failures. A different spawn/finish pose, a wider raster rule or decoded
instanced/fluid collision would be needed. The detour window is deliberately
capped at ±24 m: beyond that it would stop being a bounded detour of the retail
line and become an unrelated course. The `narrow` tier deliberately drops the
0.30 m safety margin; it is the documented car width, not a recovered retail
hull, and it is the smallest band this probe will test.

## Collision-raster project course

The `.aid` verdicts above are unchanged. The five `blocked` levels also have an
independent **project course** derived from the committed P48 passable raster,
not from the retail racing line. It is a project course, not retail data:
`courseSource` is `collision-raster-project-course` and `retailLineUsed` is
`false`.

```powershell
# Build the five raster-course documents.
python probes/map-laps-aid/tools/build_raster_course.py

# Compare the generated documents with the committed files.
python probes/map-laps-aid/tools/build_raster_course.py --check

# Independent verifier: re-derives the erosion, component, clearance,
# passability, closure and length from the committed raster.
node probes/map-laps-aid/tools/verify_raster_course.mjs
```

### Rule

The course is the **outer boundary of the clearance-eroded passable component
that contains the committed spawn**:

1. Load `_work/map-laps/<mapId>/grid.npz` (`base`, `height`, `xs`, `zs`) and
   the committed spawn in `_work/map-batch/<level>/spawn.json`
   (`layout.spawn`).
2. Erode `base` by **2 8-connected layers**. A retained cell has every cell
   within Chebyshev distance 2 passable, so the nearest blocked cell is at
   least **1.5 m** away. The raster border is treated as blocked.
3. Label the eroded mask and take the 8-connected component containing the
   spawn cell, or the component of the nearest eroded cell when the spawn cell
   is eroded. The snap is capped at **25 m** and recorded.
4. Trace the outer boundary of that component with an 8-connected Moore
   boundary trace and map the contour to the eroded foreground cells.
5. Resample the closed ring at **0.25 m**, rotate it so station 0 is the
   station nearest the committed spawn, and validate every station:
   - on the P48 passable raster;
   - on the eroded mask;
   - the **1.68 m car band** is passable perpendicular to the station's
     central-difference tangent (half-width 0.84 m, 0.21 m steps, 9 samples);
   - the closed loop is continuous (station spacing ≤ 0.5 m, including the
     closing seam).

The 1.68 m band is the documented maximum car width (1.676 m) with no safety
margin, the same `narrow` band the `.aid` probe tests. The 2.276 m band
(1.676 m car + 0.30 m margin per side) is a stronger clearance; it needs a
3-cell erosion and selects a smaller component, so this builder deliberately
uses the documented minimum car band.

No point is hand-placed and no corridor is invented. Every station is on the
committed P48 passable raster and on the eroded component boundary. The course
is a **project course**, not retail data; it is a data layout, not a driven
lap.

### Result

| level | mapId | verdict | loop length | stations | clearance | spawn projection | component cells |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| `uk_london_hackney` | `hackney` | **course** | 5,185.101941 m | 21,361 | 1.68 m | 0.3727 m | 115,111 |
| `uk_brighton` | `brighton` | **course** | 10,864.527376 m | 44,381 | 1.68 m | 22.5499 m | 416,280 |
| `usa_sanfran_sausalito` | `sausalito` | **course** | 2,802.765115 m | 11,343 | 1.68 m | 1.0000 m | 447,809 |
| `usa_sanfran_russianhill` | `russianhill` | **course** | 382.315040 m | 1,578 | 1.68 m | 4.4721 m | 9,582 |
| `spa_barcelona_bowl_multiplayer` | `bowl` | **course** | 1,112.809704 m | 4,507 | 1.68 m | 2.0000 m | 63,513 |

All five levels have a closed band-clear loop. No level is blocked by the
raster course. The station count is the number of distinct 0.25 m stations;
the loop closes through the last-to-first seam (≤ 0.25 m), which is included
in the loop length. The spawn projection is the distance from the committed
spawn to station 0 (the nearest loop station); the spawn is recorded, not
moved.

The `brighton` loop is the outer boundary of the eroded component containing
the spawn (416,280 cells) and is 10.9 km long; the `russianhill` loop is the
outer boundary of a 9,582-cell component and is 382 m long. These lengths are
the raster boundary lengths, not a driven racing line.

### Files

| file | bytes | sha256 | content hash |
| --- | ---: | --- | --- |
| `probes/map-laps-aid/data/hackney-raster-course.json` | 2,039,776 | `7ce8491edfc923c175f52d032f45bf1595a827477ab4307c3351981b71766b23` | `sha256:e17d2b4a11e936c33c97f61803b92f9d5a7be3447e40457075b07ced59aa9f04` |
| `probes/map-laps-aid/data/brighton-raster-course.json` | 4,077,110 | `666164da10a868c5f4c1ac36c2fc480765b15bf38d8bfa54ce198686f76b4d0a` | `sha256:e784b9a89bb11a96900c1ec35255ea22ed903228f83e075431eb6d1682e2e9a5` |
| `probes/map-laps-aid/data/sausalito-raster-course.json` | 1,050,845 | `c59f5af1c4688fe57be599fe213791ce60e61d8cd4589f258dc2d721fa2495c1` | `sha256:9fbe00eb7f2b639cde5467a9467fdb186ffc1310250fbbd11f12dcb9e4161a39` |
| `probes/map-laps-aid/data/russianhill-raster-course.json` | 146,065 | `adbbec155bc04b0caf62ba3c4142a4bc04f9c98828db63e0ec63f522b062a1e0` | `sha256:b6d958820dac4000e4126752bae1c81575d111961261a97ec73b682c1bcbb40b` |
| `probes/map-laps-aid/data/bowl-raster-course.json` | 410,788 | `66c3d2384b4555795c29404eb0dc7b73678134f9a03c8bea9fcafe1ceda09594` | `sha256:93d357c3d1c8cf478ac06ff33442bbf9bfe5f6e79c0177b0b7cf1dc394809b76` |

### Verifier

`verify_raster_course.mjs` re-derives from the committed raster and spawn
document only:

- the raster and spawn file hashes;
- the 2-cell 8-connected erosion of the passable raster;
- the eroded component containing the committed spawn (or the nearest eroded
  cell within 25 m), its cell count, area and bounding box;
- every station: on the passable raster, on the eroded mask, inside the
  component, and with a passable 1.68 m car band perpendicular to the
  station's central-difference tangent;
- the closure (the last-to-first seam is ≤ 0.5 m), the station spacing, the
  loop length and the arcs;
- the start (station 0 is the station nearest the committed spawn) and the
  recorded spawn projection distance;
- the ground height at every station and the minimum raster clearance;
- the document's canonical hash and the recorded algorithm parameters.

Current result:

```text
365/365 checks passed
```

The `.aid` verifier is unchanged and still passes:

```text
317/317 checks passed
```

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
| `probes/map-laps-aid/data/aid-paths.json` | 18,232 | `249c378f4845690f9f2c545c683ed7994e84423a70c1ebdeabc107f29229ffd1` |

Content hashes (canonical JSON, excluding `hash`):

- `dumbo-aid-path.json`:
  `sha256:526736bf09cb7b168a2cd12685859eb2386a215c904fe852f2dba403254f2bf3`
- `downtown-mp-aid-path.json`:
  `sha256:d0a109d8a48bf59d5d756a3488c912f2b8c68bf6336bf7271001a83179816779`

The two path documents are unchanged from the previous revision (same bytes and
hashes); only `aid-paths.json` gained the `narrow` tier fields. This keeps the
`probes/e1-drive` `layoutFileSha256` pins valid.

## Verifier

`verify_aid_paths.mjs` re-derives:

- the `.aid` route choice (closed, non-logic, ≥ 300 m, nearest spawn) from the
  pak and compares it with the recorded route;
- the `.aid` record identity (pak path, route name/index, record id, route
  number, sha256) against `routes.json` and the pak;
- every path sample against the P48 `base` raster and the tier's band
  (2.276 m for `band`/`wide`, 1.680 m sampled at 0.21 m for `narrow`);
- the detour tier: the summary tier name, window, band and margin; the path
  document's `detourSearchMetres`, `detourTier`, `bandMetres`, `marginMetres`
  and `clearance.band`; and that every lateral offset stays inside the tier
  window;
- every detour record: the racing point, the detour point, the lateral offset,
  the band clearance in both frames, the 0.5 m continuity bound, the return to
  the racing line (a detour run is bounded by zero-offset samples, starts and
  ends within one 0.25 m step, and contains at least one blocked racing point),
  and the path start/finish projections;
- the gate order, arcs, ±12 % checkpoint window, 1 m approach side and gate-line
  passability;
- every blocked witness: the spawn match distance and its band-clear snap
  candidate, the per-tier undetourable station counts and first stations (with
  each tier's band and margin), or the `detour-dp` station;
- the `bowl` directory: no `.aid` entry and the exact recorded directory
  contents.

Current result:

```text
317/317 checks passed
```


## Raster course to E1 layout (status: not yet drivable)

	ools/build_raster_layout.mjs converts a committed raster course into the
e1-drive.sprint layout the page consumes (data/<map>-raster-layout.json).
It is verified to build and the packages build from it, but the course is
**not yet drivable** by the scripted sprint controller:

| map | loop | draw coverage of the loop | scripted sprint |
| --- | ---: | ---: | --- |
| russianhill | 382.315 m | 82.8% | respawn outside-corridor at tick ~1458 |
| hackney | 5,185.102 m | 48.1% | not run |
| brighton | 10,864.527 m | 38.6% | not run |
| sausalito | 2,802.765 m | 100% | not run |
| bowl | 1,112.810 m | 0% | no draw geometry under the loop |

The traced loop is a grid staircase on the 0.5 m passable raster; a centred
moving average over +/- 2 stations is applied in the layout, but the result is
still tighter than the controller can follow. The next step is a curvature-
limited centreline (a smoothed spline with a documented minimum radius), not a
hand-placed point. The .aid verdicts are unchanged and the five levels stay
locked in id-paths.json.
