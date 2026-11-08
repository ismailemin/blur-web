# Refreshing `_work/` artifacts in dependency order

Several verifiers pin the **bytes** of a `_work/` document that another producer
writes. When a producer changes, re-run the chain below in this order; otherwise
a verifier fails with `stale pin` even though the code is correct. This is an
operational step, not a code change.

Use the bundled Python:

```text
C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe
```

## Order

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

# 1. Power-up placement chain (each step pins the previous file)
& $py probes/powerups/tools/extract_pickup_placement.py
& $py probes/powerups/tools/extract_pickup_placement_levels.py --level usa_amboy
& $py probes/powerups/tools/extract_pickup_placement_levels.py --level spa_barcelona_gracia
node probes/powerups/tools/build_runtime_placement.mjs

# 2. Map pipeline: blocked inventory pins map-registry.js bytes
& $py probes/map-pipeline/tools/blocked_inventory.py
& $py probes/map-pipeline/tools/build_map_decisions.py

# 3. Nineteen-level batch (pins the registry map set and the probe docs)
& $py probes/map-batch/build_map.py --all

# 4. Lighting and car materials
& $py probes/lighting/tools/build_manifest.py
node probes/lighting/tools/build_runtime_lighting.mjs
& $py probes/car-materials/tools/build_runtime_materials_table.py
node probes/car-materials/tools/build_runtime_materials.mjs

# 5. Instances and decals (instances first, decals second)
& $py probes/instances/tools/extract_instances.py
& $py probes/instances/tools/extract_decals.py

# 6. Measured laps and the Gracia decision
& $py probes/map-laps/tools/build_amboy_lap.py
& $py probes/map-laps/tools/build_gracia_no_lap.py
```

Then run the gate:

```powershell
& $py tools/verify_asset_probe.py --skip-build
```

## Why the order matters

| document | pins |
| --- | --- |
| `_work/powerups/placements.json` | its own file hash |
| `_work/powerups/placements-<map>.json` | its own file hash |
| `probes/powerups/data/runtime-placement.json` | `placements.json` + `placements-<map>.json` hashes |
| `_work/map-pipeline/blocked/inventory-19.json` | `map-registry.js` bytes, probe docs |
| `_work/map-batch/<level>/manifest.json` | the registry map set, probe docs, tool pins |
| `probes/lighting/data/runtime-lighting.json` | `_work/lighting/<map>.json` hashes |
| `probes/car-materials/data/runtime-materials.json` | the roster + amax/vehicles bytes |
| `probes/map-laps/data/*.json` | the collision/loop probe hashes |

`map-registry.js` is pinned as **working-tree bytes**. A `git checkout` that
rewrites the file with CRLF can change that hash; re-run
`blocked_inventory.py` afterwards.
