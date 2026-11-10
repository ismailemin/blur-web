# Raster passability limit — the five blocked levels

Status: measured, final typed blocker for the map set. 10 November 2026.

## Question

The P48 passable raster rejects a cell when the height step to a neighbour
exceeds `min(STEP_LIMIT, GRADE_LIMIT * CELL)` = `min(0.05, 0.05 * 0.5)` =
**0.025 m** (a 5 % grade at 0.5 m cells). The five blocked levels fail that
rule. Would a documented wider step limit make their retail racing line
drivable?

## Measurement

`probes/map-laps-aid/tools/probe_step_limit.py` reads the committed `.aid`
racing line and the committed `grid.npz` and reports the cell step `dh` at every
line station:

| level | stations | over 0.025 m | p50 | p90 | p99 | max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `uk_london_hackney` | 756 | 157 (20.8 %) | 0.0078 | 0.0522 | 0.0726 | **0.0773 m** |
| `uk_brighton` | 785 | 182 (23.2 %) | 0.0104 | 0.0423 | 0.0721 | **0.1611 m** |
| `usa_sanfran_sausalito` | 1,396 | 538 (38.5 %) | 0.0041 | 0.1040 | 0.1768 | **28.0818 m** |
| `usa_sanfran_russianhill` | 692 | 514 (74.3 %) | 0.0503 | 0.1118 | 0.1515 | **0.1762 m** |

So the retail line crosses steps of 0.077 m (hackney), 0.161 m (brighton) and
0.176 m (russianhill); sausalito crosses a 28 m wall.

## Wider rule tried

`probes/map-laps-aid/tools/build_wide_raster.py` rebuilds the same raster with
`STEP_LIMIT_WIDE = 0.20 m`, `GRADE_LIMIT_WIDE = 0.40` (0.20 m at 0.5 m cells).
The bound is below the committed Corvette wheel radius (0.356 m,
`Corvette_ZR1_Stock` XT), so a wheel can climb it.

| level | passable cells (strict) | passable cells (wide) | change |
| --- | ---: | ---: | ---: |
| `uk_london_hackney` | 957,907 | 2,747,539 | +186.8 % |
| `uk_brighton` | 2,369,675 | 2,747,539 | +16.0 % |
| `usa_sanfran_sausalito` | 2,414,470 | 2,747,539 | +13.8 % |
| `usa_sanfran_russianhill` | 253,336 | 2,747,539 | +984.5 % |
| `spa_barcelona_bowl_multiplayer` | 81,770 | 2,747,539 | +3,260.1 % |

`2,747,539` is **every cell of the grid**. The wider rule does not widen the
road; it declares the entire level drivable, including the terrain and the
buildings the wall mask does not catch. A course built on it would be a course
over hillsides, which is not a road and cannot be claimed as one.

## Conclusion

The 0.025 m step limit is the road/terrain discriminator, not a conservative
safety margin. Widening it to admit the retail line's 0.08–0.18 m steps admits
the whole level, so the wider raster is rejected as a course source.

The five levels stay typed blockers with these exact measurements:

- `uk_london_hackney` — retail line max step 0.0773 m; wide raster admits 100 %
  of the grid.
- `uk_brighton` — retail line max step 0.1611 m; wide raster admits 100 %.
- `usa_sanfran_sausalito` — retail line crosses a 28.0818 m wall; no step limit
  makes it drivable.
- `usa_sanfran_russianhill` — retail line max step 0.1762 m; wide raster admits
  100 %; the nearest racing-line point is also 175.14 m from the committed
  spawn.
- `spa_barcelona_bowl_multiplayer` — no `.aid` file; the widest ring inside the
  passable component has 0 % draw coverage (invisible), so it cannot be shown.

`showroom` is not a race map.

## Reproduce

```powershell
C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe probes/map-laps-aid/tools/probe_step_limit.py
C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe probes/map-laps-aid/tools/build_wide_raster.py
```

`build_wide_raster.py` writes `_work/map-laps/<map>/grid-wide.npz`; the file is
not committed and is not used by any producer.


## Engine check of the retail line (the last attempt)

The raster is only a proxy. `probes/map-laps-aid/tools/build_aid_line_course.py`
emits the committed retail `.aid` line as a course with the band check NOT
applied (`courseSource: "retail-aid-line-unverified"`, `bandVerified: false`), so
the engine decides. The line was integrated for hackney (2,949.698 m, 11,800
stations) and `verify_e1_map --map hackney` was run:

```text
failures:
  the scripted sprint reaches the finish: respawn at tick 12668: outside-corridor
  both checkpoints are crossed in order: undefined
  the run has 0 respawns: {"tick":12668,"reasons":["outside-corridor"]}
sprint: maxSpeedMps 10.346, maxLateralMetres 2.428, checkpoints [], finish null
```

The scripted controller drove 12,668 ticks (211 s) at up to 10.3 m/s with a
2.43 m maximum lateral, crossed **no checkpoint**, and left the declared 6 m
band. The retail line is therefore not drivable by the committed controller
within the 20,000-tick budget, so hackney stays blocked and the integration was
reverted (registry, `MAP_BUILDS`, `build_map_batch.mjs`).

This is the final typed blocker for the map set: the five levels are not
drivable from the committed collision data with the committed controller.
