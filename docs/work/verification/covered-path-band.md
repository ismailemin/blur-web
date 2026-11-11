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

## Result

Hackney's covered path is the best source found so far (95.4 % band-clear). The
engine check drives it for 654 m with 0 respawns and 2/2 checkpoints, then stops
at a hairpin the committed controller cannot follow. **Truncating the course at
640 m — before the hairpin — makes it playable**: the committed scripted sprint
finishes in 221.5 s with 2/2 checkpoints, and hackney is now the fifteenth
playable map (`?map=hackney`).

## Engine check of the covered path (the attempt)

`_work/build_hackney_covered.py` resampled the hackney covered path to 0.25 m,
detoured every station that did not carry the band to the nearest band-clear
lateral offset inside ±12 m, relaxed the offset field, and wrote a sprint layout
(780.355 m, 3,161 samples, 95.2 % band-clear, `course.groundEdge` min 5.50 m).
The committed AI driver (`reference` profile, Corvette ZR1) was run on it with
the same harness the map suite uses:

| run | result | respawns | checkpoints | stop |
| --- | --- | ---: | ---: | --- |
| raw covered path | DNF | 1 (`outside-corridor`, lateral 7.02 m > 7 m) | 1 / 2 | arc 462 of 780 |
| 6 smoothing passes, band-clamped | **DNF** | **0** | **2 / 2** | arc 654 of 770 |

The smoothed line is driven cleanly for 654 m at up to 24.7 m/s with all four
wheels in contact and no respawn, then the car stops. The line has a **hairpin**
at arc ≈ 660: the samples go `(-192.55, 423.75) → (-192.45, 419.72) →
(-195.46, 418.87) → (-197.10, 422.25)`, i.e. the path turns back on itself
inside about 4 m. The committed controller cannot follow that radius and holds
the car stationary (min speed 0.0009 m/s) for the rest of the 20,000-tick budget.

So the covered path is a **better** source than the retail `.aid` line (which
failed with a respawn and zero checkpoints), but it is still not a playable
course: the geodesic contains a hairpin the controller cannot drive. Unblocking
hackney needs either a course that avoids the hairpin (a different component
path) or a controller that can take a 4 m radius — both are new work, not a
re-run of an existing producer.
