# Mount Haruna — seventh playable map; the engine ground probe needed a fix

**Date:** 8 November 2026

## Result

| | value |
| --- | --- |
| map id | `mharuna` (`jpn_mharuna`) |
| course | **309.170196 m** collision path, 1,248 samples at 0.25 m |
| gates | start 0 / checkpoint-1 67.304498 / checkpoint-2 171.944569 / finish 309.170196 |
| browser sprint | **18.83 s, 2 checkpoints, 0 respawns, 0 console errors** |
| node verifier | `verify_e1_map --map mharuna` **22/22** |
| e2e | `solo-mharuna` **12/12** |
| path verifier | `verify_batch_paths` **114/114** |

## The engine fix: a ground hint for the spawn probe

`e1_create` probes the ground with a **fixed column**: a 2 m x 2 m box spanning
Y -170..130 and a ray from Y 130 down 400 m. Mount Haruna's spawn is at
**Y 1064.43** (the level spans Y 510..1064), so the probe found nothing and the
page failed with `e1_create failed at -2693,-838: no ground`.

Three levels sit outside the fixed column:

| level | spawn ground |
| --- | ---: |
| `jpn_mharuna` | 1064.43 |
| `usa_la_multiplayer_highrise` | 218.18 |
| `uk_london_hackney` | -293.73 |

The fix has two parts:

1. **`e1_set_ground_hint(y)`** (new export). The page passes the layout's
   measured `spawnGroundY`; the probe column is then centred on it
   (`probeTop = hint + 130`). The hint is only applied when the ground is
   outside the fixed column's usable range (`> 130` or `< -170`), so every map
   that already worked keeps the exact probe its committed settle hashes were
   recorded with.
2. **A tall fallback column** (Y -4000..4000, 8,000 m ray, 512-entry cache) for
   callers that do not pass a hint. Only runs when the fixed column misses.

## The gate-ordering fix

The first mharuna run reached the finish arc but never fired the finish: the car
crossed the finish gate in the **reverse** direction. The path's last two samples
were identical (`(-2565, -1085)` twice), so the gate's approach point equalled
the gate centre, `line_side` returned 0, and `gate_line` flipped A/B. The car
then crossed from the negative to the positive side, which the rules treat as a
reverse crossing.

Two fixes in `build_batch_paths.py`:

- **Deduplicate resampled stations** (consecutive points closer than 1e-6), so
  arcs strictly increase and `CourseModel` accepts the document.
- **Pick the gate approach point at least 1 m from the gate**, walking back (or
  forward for the start gate) until that distance is reached.

Only mharuna had a duplicated final sample, so the other maps' gates are
unchanged.

## Files

| file | role |
| --- | --- |
| `probes/map-laps/data/mharuna-path.json` | committed collision path |
| `probes/map-batch/tools/build_e1_package.py` | `mharuna` entry (`decal_status=None`, `blocked-no-static-albedo` label) |
| `probes/e1-drive/tools/build_map_batch.mjs` | `mharuna` entry |
| `probes/e1-drive/native/e1_drive_lib.cpp` | ground hint + tall fallback |
| `probes/e1-drive/web/map-registry.js` | `mharuna` entry and pins |
| `probes/e2e/longbeach.mjs` | `soloMharuna` |
| `probes/e2e/expected.json` | `solo.mharuna` anchor |

## Reproduce

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
node probes/e1-drive/tools/build_module.mjs
& $py probes/map-laps/tools/build_batch_paths.py --map mharuna
node probes/e1-drive/tools/build_map_batch.mjs --map mharuna
node probes/e1-drive/tools/verify_e1_map.mjs --map mharuna      # 22/22
node probes/e2e/run.mjs --scenarios solo-mharuna
```

## Scope

- The path is collision-only; it is not a retail start line or racing line.
- 202 blocked draws (196 alpha-rule, 1 decoder-size, 2 runtime-albedo, 3
  no-static-albedo) are labelled and skipped; no fallback texture or colour.
- 34 unsupported sections and 416 instance descriptions are not applied.
- The map has no prop colliders yet (`propLayer: false`).
