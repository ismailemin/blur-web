# Draw-covered path as an alternative course source — band measurement

Status: measured, 11 November 2026. Follows
[`raster-passability-limit.md`](raster-passability-limit.md), which rejected the
retail `.aid` line and the widened raster as course sources for the five blocked
levels.

## Question

The map pipeline already measured a **draw-covered component** per level: cells
that are collision-passable *and* have a declared draw triangle within 0.5 m of
the collision height. The component paths are committed under
`_work/map-pipeline/covered/<level>-path.json`:

| level | covered path samples (1 m) | covered path length |
| --- | ---: | ---: |
| `uk_london_hackney` | 712 | ~776 m |
| `uk_brighton` | 795 | ~975 m |
| `usa_sanfran_russianhill` | 153 | ~187 m |

Those paths are passable *and* visible. The open question is whether they carry
the **car band** at 0.25 m stations — the rule every playable map satisfies.

## Method

`probes/map-laps-aid/tools/probe_covered_band.py` resamples each covered path to
0.25 m, computes the central-difference tangent at every station, and applies the
same `band_passable` rule the aid pipeline uses (car half-width 1.138 m plus the
0.30 m safety margin, 11 samples across the band). It also reports the largest
single-cell height step along the line.

Reproduce:

```powershell
C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe probes/map-laps-aid/tools/probe_covered_band.py
```

## Result

| level | stations | band-clear | share | max cell step |
| --- | ---: | ---: | ---: | ---: |
| `uk_london_hackney` | 3,159 | 3,014 | **95.4 %** | 0.0200 m |
| `uk_brighton` | 4,049 | 3,179 | 78.5 % | 0.0436 m |
| `usa_sanfran_russianhill` | 775 | 508 | 65.5 % | 0.0097 m |

`spa_barcelona_bowl_multiplayer` has no covered path (draw coverage below 25 m),
and `showroom` is not a race map.

## Reading

- **Hackney is the strongest lead.** 95.4 % of the covered path already carries
  the band, and its largest cell step (0.020 m) is *under* the 0.025 m raster
  limit. The 145 failing stations (≈36 m of 790 m) are candidates for the same
  lateral detour the aid pipeline applies; this is a different line from the
  retail `.aid` line that failed the engine check, so it is not a repeat.
- **Brighton** is 78.5 % clear but crosses a 0.0436 m step, above the raster
  limit; a detour course would have to avoid that step.
- **Russianhill** is 65.5 % clear and its spawn is far from the covered
  component; the covered path would have to become the spawn, not the committed
  pose.

## Next step (not done)

Build a course document from the hackney covered path with the tiered lateral
detour, wire it through `build_map_batch.mjs`, and run `verify_e1_map --map
hackney` (engine sprint). If the scripted controller finishes with 0 respawns,
hackney becomes the fifteenth playable map; otherwise the failure is recorded as
the next typed blocker with the exact tick and reason.

This measurement does **not** claim hackney is playable today.
