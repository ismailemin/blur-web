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
| `tools/build_projectiles.py` | PWR4 | projectile/impulse manifest from XT + source |
| `tools/verify_projectiles.py` | PWR4 | independent direct-offset verifier for `projectiles.json` |
| `rules/projectiles.js`, `rules/projectiles.test.mjs` | PWR4 | typed projectile/impulse model + 19 tests |
| `tools/build_supershield.py` | SS1 | SuperShield data/provenance manifest |
| `tools/verify_supershield.py` | SS1 | independent direct-offset verifier for `supershield.json` |
| `rules/supershield.js`, `rules/supershield.test.mjs` | SS1 | typed SuperShield model + 17 tests |

## SuperShield (SS1)

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py probes/powerups/tools/build_supershield.py
& $py probes/powerups/tools/verify_supershield.py
node probes/powerups/rules/supershield.test.mjs
```

Outputs (not committed):

- `_work/powerups/supershield.json` — `PickupType` 619, `PickupLevel` 523,
  `SuperShieldBalancingData` absolute offset 96048, HUD entry at 400664, MP/SP
  selection evidence, runtime rules, event contract, source citations.
- `_work/powerups/supershield.verify.json` — 571 independent checks.
- `_work/logs/powerups/ss1-*.log` — build, verify, test and suite logs.

The shipped data has no multiplayer SuperShield bit and hard-excludes it from
random pickup selection; single-player also has no recovered grant path. The
entity, wire path (type nibble 10), FX and HUD exist, so the document classifies
it as **integrable as a project extension**, with the MP enable/spawn rule
labelled `provisional`. Full analysis: `docs/work/analysis/supershield.md`.

## Projectile / impulse recovery (PWR4)

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py probes/powerups/tools/build_projectiles.py
& $py probes/powerups/tools/verify_projectiles.py
node probes/powerups/rules/projectiles.test.mjs
```

Outputs (not committed):

- `_work/powerups/projectiles.json` — Blindfire/Bolt, Shunt, Barge and Shock
  projectile/weapon fields, `PerkForceEffects`, AI controller, HUD/audio bindings,
  runtime source citations and the integration contract.
- `_work/powerups/projectiles.verify.json` — 888 independent checks.
- `_work/logs/powerups/pwr4-*.log` — build, verify and test logs.

Full analysis: `docs/work/analysis/powerup-projectiles.md`.

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

## Generalized placement (PWR5)

`extract_pickup_placement_levels.py` takes any level id and resolves every
`racing` MultiplayerRace route; it keeps every raced circuit variant and marks
one `primary` (most racing races, then most total races, then lowest route
record id). `verify_pickup_placement_levels.py` is its independent
direct-offset verifier.

```powershell
& $py probes/powerups/tools/extract_pickup_placement_levels.py --level usa_amboy
& $py probes/powerups/tools/extract_pickup_placement_levels.py --level spa_barcelona_gracia
& $py probes/powerups/tools/verify_pickup_placement_levels.py --level usa_amboy
& $py probes/powerups/tools/verify_pickup_placement_levels.py --level spa_barcelona_gracia

# Discovery only: all 29 raced routes / 14 cities with a PickupPosition list.
& $py probes/powerups/tools/extract_pickup_placement_index.py
```

Outputs (not committed):

- `_work/powerups/placements-amboy.json` — routes 633252245 (83) and
  2779865848 (52), 2,060.595 m measured-path projection, collision, groups,
  provisional diff.
- `_work/powerups/placements-gracia.json` — routes 46220414 (59), 2844032875
  (45) and 3824353713 (40), 624.914 m measured-path projection.
- `_work/powerups/placements-{amboy,gracia}.verify.json` — 3,670 and 4,060
  independent checks, PASS.
- `_work/powerups/placement-route-index.json` — 29 raced routes / 1,523
  placements across 14 cities; discovery only.

The retail routes are not the measured e1-drive paths. The primary Amboy route
has 2 placements within 2.0 m of the measured centreline (nearest 0.45 m); the
primary Gracia route has 1 (0.83 m). All other placements are off-path but have
ground. Full contract: `docs/work/analysis/pickup-placement.md` §11–§14.

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
