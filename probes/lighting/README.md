# probes/lighting

Retail per-level lighting recovery for the four built maps (`river`, `amboy`,
`gracia`, `longbeach`) and the browser-importable runtime table derived from it.

Every number in this probe is traceable to a retail byte stream (offset recorded
in the manifest) or to an upstream shader/engine constant (`file:line` recorded).
Nothing is guessed, scaled or interpolated.

## Contents

| Path | Role |
| --- | --- |
| `tools/lighting_data.py` | Read-only recovery from `Level.levelrender` (`Lights`, `LS`, Scene declarations), `Level.levelstream` (normal bytes) and `cache/gamedata.pak` (`amax.bin` `City.EnvironmentSettings`). |
| `tools/build_manifest.py` | Writes the per-map manifests `_work/lighting/<map>.json` and `_work/lighting/index.json` (schema `blur-lighting/1`). |
| `tools/verify_lighting.py` | 581-check manifest verifier (provenance, ranges, unit consistency, byte re-derivation, determinism). |
| `tools/build_runtime_lighting.mjs` | Deterministic builder for the committed browser table. Copies values verbatim; never rounds or scales. |
| `tools/runtime_lighting_module.template.mjs` | Module template used by the builder. |
| `data/runtime-lighting.json` | Committed runtime table (schema `blur.lighting-runtime/1`). |
| `runtime-lighting.mjs` | Generated browser module. Do not edit by hand. |
| `tools/verify_runtime_lighting.mjs` | 973-check runtime table verifier. |

`_work/lighting/` is a gitignored build artifact. The committed runtime table
pins each manifest path, byte count and sha256, so a stale or edited manifest is
rejected instead of silently consumed.

## Import contract

```js
import {
  LIGHTING_SCHEMA,
  LIGHTING_MAPS,
  lightingFor,
  LightingError
} from './probes/lighting/runtime-lighting.mjs';

LIGHTING_SCHEMA; // 'blur.lighting-runtime/1'
LIGHTING_MAPS;   // ['river', 'amboy', 'gracia', 'longbeach'] (frozen, build order)

const lighting = lightingFor('river');
```

`lightingFor(mapId)` returns a deep-frozen object:

```js
{
  schema: 'blur.lighting-runtime/1',
  mapId: 'river',
  level: 'usa_la_river',
  city: 'USA_LA_River',
  manifest: { path, schema: 'blur-lighting/1', bytes, sha256 },
  sun: {
    direction: [x, y, z],        // unit, surface -> sun, = C_Light matrix row Z
    colour: [r, g, b],           // LightingInfo.SunColour.rgb (shader term)
    intensity,                   // C_Light colour alpha; reported, not applied
    lightObjectColour: [r, g, b],// C_Light colour rgb (debug renderer only)
    elevationDeg, azimuthDeg
  },
  sky: {
    colour: [r, g, b],           // LightingInfo.SkyColour.rgb (shader term)
    upAxis: [x, y, z],           // serialized hemisphere light object axis
    lightObjectColour: [r, g, b],// serialized hemisphere light object colour
    dome: { texture, rotation, intensity, fogColour, fogCurve, blackHeight, blackSize }
  },
  ambient: {
    upNormalAmbient: [r, g, b],        // SH evaluated at +Y, raw
    sh: [12],                          // RGBSH, order (x, y, z, constant) per channel
    bakedColour: [r, g, b],            // LightingInfo.BakedColour.rgb
    upNormalAmbientScaled: [r, g, b],  // upNormalAmbient * bakedColour
    probe: { model, pointIndex, sampleIndex, pointPosition, spawn, distance, searchRadius }
  },
  fog: null | {
    colour: [r, g, b],
    depth: { density, nearDistance, scale },
    height: { height, density, falloff, scale }
  },
  missing: [{ code, field, reason }],
  source: 'manifest _work/lighting/river.json (...) built by ...'
}
```

Only the ids in `LIGHTING_MAPS` are accepted; the retail package id
(`usa_amboy`) is not an alias. Errors are typed:

| Condition | `error.name` | `error.code` |
| --- | --- | --- |
| unknown map id | `LightingError` | `unknown-map` |
| non-string map id | `LightingError` | `invalid-map-id` |

### Field semantics

- `sun.direction` is the unit vector pointing from the surface toward the sun
  (`C_LightList::GetSunDirection` returns matrix row Z, `LightList.cpp:90-98`).
- `sun.colour` is `LightingInfo.SunColour.rgb`, the value the retail diffuse
  term multiplies (`shader/common/Lighting.h:153-165`). It is `[0,0,0]` on
  `river`, `gracia` and `longbeach`, which bake the sun into lightmaps and
  light samples; only `amboy` authors a live sun colour. A consumer must not
  substitute a white sun for those maps.
- `sun.intensity` is the serialized `C_Light` colour alpha (`1.0` on all four
  maps). The retail shader does not scale `SunColour` by it; it is reported, not
  applied.
- `sun.lightObjectColour` is the serialized `C_Light` colour (`[1,1,1]`). The
  runtime shader does not read it; it is kept for traceability.
- `sky.colour` is `LightingInfo.SkyColour.rgb`. It is `[0,0,0]` on `gracia`.
- `sky.dome.intensity` is `skySettings.intensity`, which scales the sky dome
  texture, not the diffuse `sky.colour` term.
- `ambient.upNormalAmbientScaled` is the baked ambient term for an up-facing
  normal (`SH(+Y) * BakedColour`); `ambient.sh` is the raw 12-coefficient RGBSH
  sample so a consumer can evaluate any normal.
- `fog` is `null` only when the level authors no fog record; the four built maps
  all serialize one.

### `missing`

Values the retail data does not serialize are absent from the returned object
and listed in `missing` as `{ code, field, reason }`. `field` is the absent
dotted path; `code` is `not-serialized` or `not-decoded`. Current entries, per
map:

| `field` | `code` | Why |
| --- | --- | --- |
| `sun.occlusion` | `not-serialized` | `m_fSunOcclusion` is per-vertex/per-material from the LS sample and baked lightmaps. |
| `sun.intensityScale` | `not-serialized` | The shader multiplies `SunColour` directly; no serialized multiplier exists. |
| `sky.occlusion` | `not-serialized` | `m_fSkyOcclusion` is per-vertex/per-material. |
| `ambient.perInstanceInterpolation` | `not-serialized` | One probe at the measured spawn; the engine interpolates the nearest light sample per instance. |
| `ambient.lightmap` | `not-decoded` | Static lighting is baked into `SunSkyLightmap`/`RGBLightmap` textures. |
| `sky.domePixels` | `not-decoded` | The dome texture path is serialized; its pixels are not decoded here. |

## Values (from the committed manifests)

Sun colour is `LightingInfo.SunColour.rgb`; ambient is
`upNormalAmbientScaled` (`SH(+Y) * BakedColour`).

| map | sun direction | sun colour | ambient (scaled) | sky colour | fog depth density |
| --- | --- | --- | --- | --- | --- |
| `river` | `[0.719846, 0.342020, -0.604023]` | `[0, 0, 0]` | `[0.259003, 0.255157, 0.216064]` | `[1, 1, 1]` | `0.0002` |
| `amboy` | `[-0.334546, 0.207912, -0.919158]` | `[1, 1, 1]` | `[0.173584, 0.120026, 0.143234]` | `[1, 1, 1]` | `0.001` |
| `gracia` | `[-0.241845, 0.707107, -0.664463]` | `[0, 0, 0]` | `[0.192719, 0.178528, 0.128769]` | `[0, 0, 0]` | `0.0003` |
| `longbeach` | `[0.862730, 0.087156, -0.498097]` | `[0, 0, 0]` | `[0.884033, 0.767029, 0.462158]` | `[1, 1, 1]` | `0.002` |

`sun.intensity` is `1.0` and `sun.lightObjectColour` is `[1, 1, 1]` on all four
maps. Exact values (not the 6-decimal display above) are in
`data/runtime-lighting.json` and `runtime-lighting.mjs`.

## Commands

Use the bundled Python:

```text
C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe
```

```powershell
# 1. Rebuild the manifests from retail data (writes _work/lighting/).
python probes/lighting/tools/build_manifest.py
python probes/lighting/tools/verify_lighting.py          # expect 581/581

# 2. Rebuild the committed runtime table and verify it.
node probes/lighting/tools/build_runtime_lighting.mjs
node probes/lighting/tools/verify_runtime_lighting.mjs   # expect 973/973
```

`verify_runtime_lighting.mjs` re-derives every value from
`_work/lighting/<map>.json` without importing the builder, rejects any numeric
field that has no manifest source, checks unit length of every declared
direction, checks the `missing` list, and confirms two builder runs are
byte-identical to each other and to the committed JSON/module. It exits `1` on
any failure.

The runtime verifier is not yet wired into `tools/verify_asset_probe.py`; run it
directly until that suite step is added.

## Scope and limits

- One ambient probe per map, at the measured spawn (`_work/map-slice/*`
  `layout.spawn`). The engine interpolates the nearest light sample per model
  instance; that interpolation is not serialized.
- Static world lighting is baked into lightmaps, which are not decoded here.
- Retail cars use a projected drop shadow; no shadow map, cascade, bias or PCF
  parameter exists in the data.
- Emissive and light-blend states are per-material; only the per-level
  `EmissiveColour` scale is recovered by the manifest (and is not part of the
  runtime table).
- The runtime table covers the four built maps only. A fifth map needs a
  manifest first; the builder refuses anything else.
