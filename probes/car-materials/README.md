# probes/car-materials — per-car material/albedo texture extraction

Deterministic, evidence-backed extraction of the static albedo/diffuse image
behind every draw of the five E1 roster cars, plus decoded mip0 RGBA for each
referenced texture.

This probe **does not render, sample, or integrate anything**. It reads the
committed part manifests and the cars' own decoded `.model` files, re-runs the
committed C++ readers, resolves material rows to texture identity, assembles
original PC descriptors plus complete mip chains, and decodes with the committed
`texture_inspect.exe --raw`. Runtime-only inputs (paint lookup, light blend,
`_NO_ALBEDO` shaders) are reported with exact source reasons and are never
guessed.

## Inputs (read-only)

| input | use |
| --- | --- |
| `_work/car-parts/cars/index.json` | five-car mapping, model/manifest hashes |
| `_work/car-parts/cars/<slug>/manifest.json` | part/draw ownership |
| `_work/car-parts/cars/<slug>/scene-report.json` | committed `scene_inspect.exe` output |
| `_work/car-parts/models/<sha>.decoded` | car model bytes |
| `_work/build/asset-reader-native/Release/scene_inspect.exe` | draw binding + resource texture metadata |
| `_work/build/asset-reader-native/Release/texture_inspect.exe --raw` | PC descriptor + chain → RGBA |
| `tools/inspect_car_materials.py` | independent source-shaped material/LOD parser (imported, not modified) |

## Commands

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

# build one per-car manifest + decoded textures
& $py probes/car-materials/tools/build_roster_materials.py

# full gate: 40/40 native re-decodes + Pillow policy + two-build determinism
& $py probes/car-materials/tools/verify_roster_materials.py
```

Default output: `_work/car-materials/roster/`. `--out-dir` changes it; the
verifier always rebuilds into `_work/car-materials/verify-a` and `verify-b` and
requires them to be absent so a stale tree cannot pass.

## Output

| path | content |
| --- | --- |
| `cars/<slug>/materials.json` | per-car draw/part/material/texture manifest |
| `cars/<slug>/textures/*.rawtexture` | original descriptor + complete mip chain |
| `cars/<slug>/textures/*.rgba` | native mip0 RGBA8, top-left row-major, no V flip |
| `cars/<slug>/textures/*.png` | same pixels for inspection |
| `index.json` | per-car coverage, texture table and hashes |
| `verify.json` | gate result, 40 native re-decodes, determinism |

Texture file paths inside a manifest are relative to that manifest, so builds
into different directories stay byte-identical.

## Scope labels

The manifest sets `materialsApplied:false`, `shaderExecuted:false`,
`samplerApplied:false`, `paintLookupRecovered:false`,
`lightBlendRecovered:false` and `rendererClaim:false`. A decoded image is a
source texture, not a reproduced retail appearance. Draws whose wheel corner is
unclassified keep `partId:null` and are grouped under an explicit synthetic
`partId:null` record; the original part manifest still carries them as
preview-only draws.

See `docs/work/analysis/car-materials.md` for method, coverage, hashes and
limits.
