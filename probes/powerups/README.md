# probes/powerups

Data-only power-up recovery for the Blur Web project. Nothing here changes
`game-data/`, `upstream/`, `probes/e1-drive/`, `probes/race-rules/`,
`probes/net-mvp/`, `probes/asset-reader/` or `tools/`.

## Contents

| path | owner | purpose |
| --- | --- | --- |
| `tools/xt_decode.py` | PWR1 | bounded FLSK v1/v2 table/schema/payload reader |
| `tools/build_powerups.py` | PWR1 | 11 pickup types, levels, balancing, HUD/audio manifest |
| `tools/verify_powerups.py` | PWR1 | independent verifier for `_work/powerups/powerups.json` |
| `rules/engine.js`, `rules/tests.mjs` | PWR1 | standalone rules prototype driven by recovered values |
| `tools/extract_pickup_placement.py` | PWR3 | recover `usa_la_river` pickup placement |
| `tools/verify_pickup_placement.py` | PWR3 | independent direct-offset verifier for `placements.json` |

## Recovered placement (PWR3)

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py probes/powerups/tools/extract_pickup_placement.py
& $py probes/powerups/tools/verify_pickup_placement.py
```

Outputs (not committed):

- `_work/powerups/placements.json` — 54 `PickupPosition` slots for the raced
  `usa_la_river` route, with provenance, type ids, row/shuffle groups,
  collision checks, 310 m/loop-01 projections and the provisional diff.
- `_work/powerups/placements.verify.json` — 1401 checks, independent reader.
- `_work/logs/powerups/placement-*.log` — build and verify logs.

Source chain:
`multiplayer.bin MultiplayerRace.route` → `amax.bin Route.MultiplayerActorLists`
→ `actorpack.xt LevelActorList 2512484467` → 54 `PickupPosition` actors.

The 54 slots belong to the retail River route (record 1643385212,
`RouteNumber 3`), which is not the measured 310 m collision-only course. Two
slots are within the 2.0 m pickup radius of loop-01; none are on the 310 m
course. The manifest also compares against PWR2's provisional 6-slot plan
(`probes/e1-drive/web/powerups.js`, read-only): 0/6 slots are within 2.0 m of a
recovered position; nearest 73.04 m. Full analysis:
`docs/work/analysis/pickup-placement.md`.

## PWR1 definitions

```powershell
& $py probes/powerups/tools/build_powerups.py
& $py probes/powerups/tools/verify_powerups.py
node probes/powerups/rules/tests.mjs
```

`_work/powerups/powerups.json` is the definition manifest; see
`docs/work/analysis/powerups.md` for the field set, unknowns and rules
prototype.

## Rules

- Read-only game data. No decrypted fixture, manifest or `_work/` output is
  committed.
- No guessed position, type, row, enum integer or respawn value. Unknowns stay
  typed in the manifest.
- Placement data is not a renderer, GPU or full-game claim.
