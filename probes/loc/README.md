# probes/loc — shipped localization catalog

Read-only decoding of Blur's `*.loc` (OLTX v1) tables and a build-time string
catalog for the browser shell/HUD. See
`docs/work/analysis/localization.md` for the derived format, coverage and limits.

## Tools

| file | role |
| --- | --- |
| `tools/olt.py` | strict OLTX v1 reader (header, locale table, key table, UTF-16LE values) |
| `tools/amax_loc.py` | `AmaxVehicle` / `AmaxManufacturer` / `City` / `Route` LocId resolution and the 62-car mapping |
| `tools/required_keys.py` | curated `(slot, file, key)` shell/HUD table |
| `tools/build_loc_catalog.py` | builds `_work/loc/*` |
| `tools/verify_loc_catalog.py` | independent re-parse and 2,533-check gate |

## Commands

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py probes/loc/tools/build_loc_catalog.py
& $py probes/loc/tools/verify_loc_catalog.py
```

## Outputs (`_work/loc/`, disposable)

- `strings.json` — `{locale: {key: [strings]}}` + provenance + per-locale hashes
- `inventory.json` — 23-file format/record/locale inventory
- `locales/<code>.json` — every key as `"<file>:<KEY>"`
- `shell/<code>.json` — 500 required slots, requested → en fallback already applied
- `slots.json`, `coverage.json`, `index.json`, `verify.json`

## Inputs

- `game-data/Blur/cache/gamedata.pak` (`gamedata.pak` codec 2 = zlib)
- `_work/vehicle-pipeline/cars.json`, `_work/vehicle-pipeline/c-aliases.json`
- `_work/powerups/powerups.json`

The last three are outputs of other probes and their SHA-256 values are pinned in
`strings.json.sources`; rebuild those probes first if `_work/` was cleared. The
`.loc` files, `amax.bin` and level directory list are read directly from game data.

No file in `upstream/`, `game-data/`, `tools/` or another probe is written.
