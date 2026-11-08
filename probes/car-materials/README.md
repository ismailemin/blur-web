# probes/car-materials — per-car material/albedo texture extraction

Deterministic, evidence-backed extraction of the static albedo/diffuse image
behind every draw of the 25-car roster, plus decoded mip0 RGBA for each
referenced texture and a browser-importable runtime material table.

Three stages share this probe:

1. `build_roster_materials.py` — the 224 static `g_MeshTexture` albedo draws.
2. `build_runtime_textures.py` — the static `TEXTURE_INDEX` references on the
   267 runtime-only draws (45 paint, 66 light, 156 other `_NO_ALBEDO`).

The second stage resolves paint dent/scratch/bump references and light
off/on/damage masks, but never invents a paint colour or a light blend state.
A paint lookup (`g_sPaintMaterialTexture`) and a light blend
(`g_vRenderColour.w`) are serialized only as runtime inputs and stay
`unsupported`.

A third stage turns the retail XT material records into the browser-importable
25-car runtime material table:

3. `build_runtime_materials_table.py` → `build_runtime_materials.mjs` — the
   paint, glass, light and alloy values the renderer can apply, with the
   `metallic`/`roughness` gap recorded instead of guessed.

This probe **does not render, sample, or integrate anything**. It reads the
committed part manifests and the cars' own decoded `.model` files, re-runs the
committed C++ readers, resolves material rows to texture identity, assembles
original PC descriptors plus complete mip chains, and decodes with the committed
`texture_inspect.exe --raw`. Runtime-only inputs (paint lookup, light blend,
`_NO_ALBEDO` shaders) are reported with exact source reasons and are never
guessed. Stage 3 additionally decodes the retail XT material records; it copies
or derives values by a documented rule and records every field it cannot
recover.

## Inputs (read-only)

| input | use |
| --- | --- |
| `_work/car-parts/cars/index.json` | 25-car model/manifest hashes and the record-level `amaxTag` link |
| `_work/car-parts/cars/<slug>/manifest.json` | part/draw ownership |
| `_work/car-parts/cars/<slug>/scene-report.json` | committed `scene_inspect.exe` output |
| `_work/car-materials/roster/cars/<slug>/materials.json` | P52 runtime-only draw classification |
| `_work/car-parts/models/<sha>.decoded` | car model bytes |
| `_work/build/asset-reader-native/Release/scene_inspect.exe` | draw binding + resource texture metadata |
| `_work/build/asset-reader-native/Release/texture_inspect.exe --raw` | PC descriptor + chain → RGBA |
| `tools/inspect_car_materials.py` | independent source-shaped material/LOD parser (imported, not modified) |
| `probes/e1-drive/cars/roster.json` | authoritative 25 slugs and roster order |
| `gamedata.pak` `\gamedata\xt\amax.bin` | `AmaxVehicle` paint-job and material-override handles |
| `gamedata.pak` `\gamedata\xt\vehicles.bin` | `VEH_PaintJob`, `VEH_Curve`, `VEH_MaterialGlass|Light|Alloy` |

## Commands

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

# stage 1: one per-car manifest + decoded static albedo textures
& $py probes/car-materials/tools/build_roster_materials.py
& $py probes/car-materials/tools/verify_roster_materials.py

# stage 2: static references of the 267 runtime-only draws
& $py probes/car-materials/tools/build_runtime_textures.py
& $py probes/car-materials/tools/verify_runtime_textures.py

# stage 3: retail paint/glass/light/alloy table for all 25 roster cars
& $py probes/car-materials/tools/build_runtime_materials_table.py
node probes/car-materials/tools/build_runtime_materials.mjs
node probes/car-materials/tools/verify_runtime_materials.mjs
```

Default output: `_work/car-materials/roster/` for stage 1 and
`_work/car-materials/runtime/` for stage 2. `--out-dir` changes it; each
verifier rebuilds into its own `verify-a` / `verify-b` directories and requires
them to be absent so a stale tree cannot pass.

Stage 3 writes the committed `probes/car-materials/data/runtime-materials.json`
and `probes/car-materials/runtime-materials.mjs`. The Python stage needs the
installed game data; the Node builder and verifier only read committed files.

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

Stage 3 (committed):

| path | content |
| --- | --- |
| `data/runtime-materials.json` | per-car raw retail fields, derived runtime values, `missing`, provenance |
| `runtime-materials.mjs` | generated browser module: `MATERIAL_OVERRIDES` + `materialsFor(slug)` |

Texture file paths inside a manifest are relative to that manifest, so builds
into different directories stay byte-identical.

## Runtime material import contract

```js
import {
  MATERIAL_SCHEMA,          // 'blur.car-materials-runtime/1'
  MATERIAL_MANIFEST_SHA256, // sha256 of data/runtime-materials.json
  MATERIAL_SLUGS,           // 25 roster slugs, roster order
  MATERIAL_OVERRIDES,       // { [slug]: { baseColour, glass, emissive, emissiveStrength, alloy, missing } }
  materialsFor,             // (slug) => full entry
  CarMaterialError
} from './probes/car-materials/runtime-materials.mjs';

const material = materialsFor('corvette-zr1-stock');
// {
//   schema: 'blur.car-materials-runtime/1',
//   slug: 'corvette-zr1-stock',
//   baseColour: [r, g, b, a],   // linear RGBA, paint
//   glass: {
//     tint: [r, g, b],          // linear RGB
//     minAlpha, maxAlpha,
//     minReflectivity, maxReflectivity,
//     blend: { src: 'One', dest: 'InvSrcAlpha', alphaTest: true }
//   },
//   emissive: [r, g, b],        // linear RGB, VEH_MaterialLight.tint
//   emissiveStrength,           // VEH_MaterialLight.intensity
//   alloy: { colour: [r, g, b], specPow, specInt },
//   missing: [{ field, sourceField, present, searchedFields, reason }],
//   source: { amaxTag, amaxRecordId, paintJob, glass, light, alloy }
// }
```

`materialsFor` throws a `CarMaterialError` with `code === 'unknown-slug'` for a
slug outside the roster and `code === 'invalid-slug'` for a non-string. Returned
objects are deep-frozen.

What is recovered, and from where:

| field | source | rule |
| --- | --- | --- |
| `baseColour` | `VEH_PaintJob` paint ramp | ramp texel 511 (the shader's `NdotV -> 1` sample), sRGB→linear; alpha is the opaque paint alpha |
| `glass.*` | `VEH_MaterialGlass` | verbatim `tint`, `minAlpha`, `maxAlpha`, `minReflectivity`, `maxReflectivity` |
| `emissive`, `emissiveStrength` | `VEH_MaterialLight` | verbatim `tint` and `intensity` |
| `alloy.*` | `VEH_MaterialAlloy` | verbatim `colour`, `specPow`, `specInt` |

`metallic` and `roughness` are **absent**. `VEH_PaintJob` serializes no
metallic/F0 or roughness scalar, and `reflectivityCurve` is a Fresnel term, not
a PBR workflow input. Both are listed in `missing` with the absent
`Record.field` path and the fields that were searched instead; no default is
substituted. `verify_runtime_materials.mjs` proves the named field is absent
from the XT schema.

Colour spaces: `baseColour`, `glass.tint`, `emissive` and `alloy.colour` are
linear. The committed paint ramp bytes are sRGB-encoded RGBA8.

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

Stage 3 is a data table only: `shaderExecuted:false`, `samplerApplied:false`,
`rendererClaim:false`. It applies the retail material *values*, not the retail
shader. `baseColour` is one documented ramp sample, not the full 512x1
gradient; the exact ramp bytes and sha256 are committed in the manifest for a
renderer that wants the gradient. `metallic`/`roughness` stay absent by design.

See `docs/work/analysis/car-materials.md` for method, coverage, hashes and
limits.
