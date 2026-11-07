# Game-logic audit probe

Read-only audit of the upstream race/game logic needed for a full race.
No engine, e1-drive, asset-reader, tools, upstream or game-data file is modified.

## Outputs

| Path | Meaning |
|---|---|
| `inventory.py` | deterministic scan of 481 race-relevant files; writes the JSON below |
| `verify_inventory.py` | re-runs the scan, recomputes counts, checks provenance, upstream cleanliness and closure |
| `compile_ai_probe.py` | compiles all 29 `mercury/library/ai/air` TUs with the existing web headers |
| `_work/game-logic-audit/game-logic-inventory.json` | module inventory with path, lines, classes, classification and dependency flags |
| `_work/game-logic-audit/ai-compile-probe.json` | per-TU object compile result (not a link or run) |
| `_work/logs/game-logic-audit/` | compiler and audit logs |
| `docs/work/analysis/game-logic-audit.md` | English audit, rules-layer design and blocker order |

## Run

```powershell
# Bundled Python
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py probes/game-logic-audit/compile_ai_probe.py   # optional; needs _work/engine-vehicle-spike/tree
& $py probes/game-logic-audit/inventory.py
& $py probes/game-logic-audit/verify_inventory.py
```

`compile_ai_probe.py` is optional; without `ai-compile-probe.json` the inventory
still works and reports `auditProbeCompiledFiles: 0`.

## Scope

Included trees:

- `code/amax/game/GameLogic/RaceLogicCore`
- `code/amax/game/GameLogic/RaceModes`
- `code/amax/game/GameLogic/RaceRules`
- `code/amax/game/GameLogic/GameModes`
- `code/amax/game/GameLogic/Pickups`
- `code/amax/game/GameLogic/SinglePlayer`
- selected `GameLogic/Structures`, `GameLogic/GameData`, `GameLogic/PlayMode`
- `code/amax/game/Game/GameActors/Components/VehicleLogic`
- `code/amax/game/AI`
- `code/mercury/library/ai/air`
- race-specific actors: traffic, split line, start position, start line info,
  pickup position

Excluded on purpose: crowd, cutscene, camera, audio, UI/Lua, profile, save,
achievements, DemonWare, renderer and the rest of `amax/game`.

## Limits

- Classification is a source-level decision, not a runtime claim.
- `portable` means "compiled as an object in the audit probe"; no link, run or
  numerical parity is claimed.
- No retail tuning value is recovered or invented here.
