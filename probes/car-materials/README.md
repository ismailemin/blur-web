# probes/car-materials — per-car material/albedo texture extraction

Deterministic, evidence-backed extraction of the static albedo/diffuse image
behind every draw of the five E1 roster cars, plus decoded mip0 RGBA for each
referenced texture.

Two stages share this probe:

1. `build_roster_materials.py` — the 224 static `g_MeshTexture` albedo draws.
2. `build_runtime_textures.py` — the static `TEXTURE_INDEX` references on the
   267 runtime-only draws (45 paint, 66 light, 156 other `_NO_ALBEDO`).

The second stage resolves paint dent/scratch/bump references and light
off/on/damage masks, but never invents a paint colour or a light blend state.
A paint lookup (`g_sPaintMaterialTexture`) and a light blend
(`g_vRenderColour.w`) are serialized only as runtime inputs and stay
`unsupported`.

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
| `_work/car-materials/roster/cars/<slug>/materials.json` | P52 runtime-only draw classification |
| `_work/car-parts/models/<sha>.decoded` | car model bytes |
| `_work/build/asset-reader-native/Release/scene_inspect.exe` | draw binding + resource texture metadata |
| `_work/build/asset-reader-native/Release/texture_inspect.exe --raw` | PC descriptor + chain → RGBA |
| `tools/inspect_car_materials.py` | independent source-shaped material/LOD parser (imported, not modified) |

## Commands

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

# stage 1: one per-car manifest + decoded static albedo textures
& $py probes/car-materials/tools/build_roster_materials.py
& $py probes/car-materials/tools/verify_roster_materials.py

# stage 2: static references of the 267 runtime-only draws
& $py probes/car-materials/tools/build_runtime_textures.py
& $py probes/car-materials/tools/verify_runtime_textures.py
```

Default output: `_work/car-materials/roster/` for stage 1 and
`_work/car-materials/runtime/` for stage 2. `--out-dir` changes it; each
verifier rebuilds into its own `verify-a` / `verify-b` directories and requires
them to be absent so a stale tree cannot pass.

## Output

Stage 1 (`_work/car-materials/roster/`):

| path | content |
| --- | --- |
| `cars/<slug>/materials.json` | per-car draw/part/material/texture manifest |
| `cars/<slug>/textures/*.rawtexture` | original descriptor + complete mip chain |
| `cars/<slug>/textures/*.rgba` | native mip0 RGBA8, top-left row-major, no V flip |
| `cars/<slug>/textures/*.png` | same pixels for inspection |
| `index.json` | per-car coverage, texture table and hashes |
| `verify.json` | gate result, 40 native re-decodes, determinism |

Stage 2 (`_work/car-materials/runtime/`):

| path | content |
| --- | --- |
| `cars/<slug>/materials.json` | 267-draw classification, static bindings, runtime reasons, textures |
| `cars/<slug>/textures/*` | static paint dent/scratch/bump and light mask images |
| `index.json` | per-car paint/light/no-albedo coverage and texture table |
| `verify.json` | gate result, 24 native re-decodes, determinism |

Texture file paths inside a manifest are relative to that manifest, so builds
into different directories stay byte-identical.

## Scope labels

Stage 1 sets `materialsApplied:false`, `shaderExecuted:false`,
`samplerApplied:false`, `paintLookupRecovered:false`,
`lightBlendRecovered:false` and `rendererClaim:false`. Stage 2 sets the same
flags and adds `staticReferencesDecoded:true`. A decoded image is a source
texture, not a reproduced retail appearance. In stage 2 every paint draw keeps
`paintLookup.resolution:"unsupported"` and every light draw keeps
`lightBlend.resolution:"unsupported"`; only the referenced static masks are
decoded. Draws whose wheel corner is unclassified keep `partId:null` and are
grouped under an explicit synthetic `partId:null` record; the original part
manifest still carries them as preview-only draws.

See `docs/work/analysis/car-materials.md` for method, coverage, hashes and
limits.
