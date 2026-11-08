# Remaining maps: four more playable, eight typed blockers

**Date:** 8 November 2026

## Playable now (11 total)

| map id | level | course | evidence |
| --- | --- | ---: | --- |
| `highrise` | `usa_la_multiplayer_highrise` | 14.268660 m | `?map=highrise` **3.45 s, 0 respawn**; `verify_e1_map` 22/22; `solo-highrise` 12/12 |
| `shutoko` | `jpn_tokyo_shutoko` | 279.005135 m | **21.83 s, 0 respawn**; 22/22; `solo-shutoko` 12/12 |
| `oval` | `spa_barcelona_oval` | 753.021127 m | **39.52 s, 0 respawn**; 22/22; `solo-oval` 12/12 |
| `amboy-mp` | `usa_amboy_multiplayer` | 122.293808 m | **13.53 s, 0 respawn**; 22/22; `solo-amboy-mp` 12/12 |

Plus the seven earlier maps: river, amboy, gracia, longbeach, observatory,
downtown, mharuna.

## The gate rule that made the wide courses work

On a wide collision course the driven line can pass a gate's measured arc
without intersecting its 8 m line segment, so the gate never fired and the car
respawned at the finish. The layout now declares `course.gateRule:
"arc-progression"` for those maps, and `sprint-rules.js` accepts reaching the
gate's measured arc (inside the corridor) as the crossing. The line crossing
stays the primary test; the fallback is documented and only applies to layouts
that declare it. `highrise`, `shutoko` and `oval` declare it; the earlier maps
do not, so their committed anchors are unchanged.

## Typed blockers (8)

| level | reason (from `_work/map-laps/<map>/blocked.json`) |
| --- | --- |
| `uk_london_hackney` | no path at 10-cell (5.0 m) clearance inside the 28-cell (14.0 m) corridor; the P48 raster is split (spawn component 120, finish component 126) |
| `usa_ny_dumbo` | no path at 3-cell (1.5 m) clearance inside the 14-cell corridor; the 3-cell erosion is split (spawn component 3, finish component 1) |
| `uk_brighton` | the nearest 10-cell eroded cell to a committed endpoint is outside the 14-cell corridor (finish snap 23.2 m) |
| `usa_sanfran_sausalito` | the car half-width lateral band is blocked at 3 of 4,033 samples (the finish sits in a ~2.25 m passage) |
| `usa_sanfran_russianhill` | the car half-width band is blocked at 11 of 697 samples; the spawn has no 8–10-cell eroded cell within 40 m |
| `usa_la_downtown_multiplayer` | resampled station 336 `(182.115, -173.308)` is not on P48 passable ground; the straight endpoint connector crosses a barrier |
| `spa_barcelona_bowl_multiplayer` | resampled station 1,472 `(22.000, 366.750)` is not on P48 passable ground |
| `showroom` | `unsupported`: not a race/sprint map (`showroom-mode` in map-pipeline) |

These are data limits, not guesses: each is recorded with the exact blocked
samples and the raster components. A different spawn/finish pose or a wider
corridor would be needed, and that is a design decision, not an extraction fix.

## Also changed

- `map_batch_lib.grade_for`: an integrated map is `playable` even when its
  draw-covered path is shorter than 25 m, because the committed collision path
  is the course authority (Highrise: 6.24 m draw, 14.27 m course).
- `verify_batch.registry_maps` and the map-pipeline decision checks accept the
  hyphenated `amboy-mp` id and use the collision path for the playable floor.
- `build_e1_package.py` gained the four entries and the
  `blocked-missing-texture-source` label; `build_map_batch.mjs` gained the four
  entries.
- `map-batch` **1450/1450**, `verify_map_decisions` **1809/1809**,
  `verify_blocked` PASS, `verify_batch_paths` **406/406**,
  `verify_remaining_paths` **124/124**.
