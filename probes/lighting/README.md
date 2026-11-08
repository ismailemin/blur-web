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
| `tools/lightmap_data.py` | Read-only decode of the static-world lightmap set: scans `Level.levelstream` LOD0 resource-block textures, resolves material `g_tLightmap` through the RenderList texture-source list, extracts each PC TextureDesc + DXT5/BC3 blob and decodes mip 0 with the committed `texture_inspect` decoder. |
| `tools/build_manifest.py` | Writes the per-map manifests `_work/lighting/<map>.json` and `_work/lighting/index.json` (schema `blur-lighting/1`), including the `lightmap` block. |
| `tools/verify_lighting.py` | 7,490-check manifest verifier (provenance, ranges, unit consistency, byte re-derivation, lightmap source re-derivation, determinism). |
| `tools/build_runtime_lighting.mjs` | Deterministic builder for the committed browser table. Copies values verbatim; never rounds or scales. |
| `tools/runtime_lighting_module.template.mjs` | Module template used by the builder. |
| `data/runtime-lighting.json` | Committed runtime table (schema `blur.lighting-runtime/1`). |
| `runtime-lighting.mjs` | Generated browser module. Do not edit by hand. |
| `tools/verify_runtime_lighting.mjs` | 16,108-check runtime table verifier (lighting + lightmap). |
| `tools/lightmap_reference.py` | Independent lightmap reference: re-scans the retail bytes and re-decodes every lightmap without importing the manifest builder. |
| `tools/verify_lightmap.mjs` | Lightmap verifier: compares the reference to the manifest and runtime table, checks the `g_tLightmap` reference set, and checks two reference builds are byte-identical. |

`_work/lighting/` is a gitignored build artifact. The committed runtime table
pins each manifest path, byte count and sha256, so a stale or edited manifest is
rejected instead of silently consumed.

## Import contract

```js
import {
  LIGHTING_SCHEMA,
  LIGHTING_MAPS,
  lightingFor,
  lightmapTexture,
  LightingError
} from './probes/lighting/runtime-lighting.mjs';

LIGHTING_SCHEMA; // 'blur.lighting-runtime/1'
LIGHTING_MAPS;   // ['river', 'amboy', 'gracia', 'longbeach'] (frozen, build order)

const lighting = lightingFor('river');
const lightmap = lighting.lightmap;             // decoded set, or null
const texture = lightmapTexture('river', 'lightmap_main_000-a');
```

`lightmapTexture(mapId, name)` returns one deep-frozen texture entry from
`lightingFor(mapId).lightmap.textures`. It throws `LightingError` with
`code === 'invalid-texture-name'` for a non-string name,
`'lightmap-unavailable'` when the map has no decoded set, and
`'unknown-lightmap-texture'` for a name outside the set.

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
  lightmap: null | {
    kind: 'texture-set',
    decoded: true,
    uvSet: 'luxlightmap',
    format: 894720068,           // D3DFORMAT DXT5/BC3
    formatName: 'DXT5/BC3',
    count,                       // number of g_tLightmap textures
    width: number | null,        // null when the set mixes dimensions
    height: number | null,
    dimensions: { '256x256': n, '512x512': m },
    bytes,                       // sum of TextureDesc + encoded mip-chain bytes
    sha256,                      // set hash over (name, texture sha256)
    decodedRgbaSha256,           // set hash over (name, decoded mip-0 sha256)
    shader: { uvSource, sunSky, rgbNormalisedGamma },
    textures: [{
      name, width, height, format, formatName, levels,
      bytes, payloadBytes, sha256, decodedRgbaBytes, decodedRgbaSha256,
      referenceCount,            // material g_tLightmap fields that bind it
      source: { kind, block, index, streamRecordIndex, streamRecordOffset,
                streamRecordBytes, headerOffsetInChunk, headerBytes,
                dataOffsetInChunk, dataBytes }
    }],
    source: '...'
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
  substitute a white sun for those maps. The decoded `lightmap` set is the
  baked term those maps rely on; bind it through the material's `g_tLightmap`
  name instead of inventing a directional sun.
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
- `lightmap` is the decoded static-world lightmap set, not a single atlas. Every
  texture is a levelstream LOD0 resource-block texture bound by at least one
  material `g_tLightmap` field. `lightmap.textures` is sorted by name; the
  renderer looks up the material's `g_tLightmap` name and binds that entry.
- `lightmap.uvSet` is `'luxlightmap'`; the shader reads the lightmap UV from
  `TEXCOORD0.zw` (`shader/common/Parameters.h:11`).
- `lightmap.shader.sunSky` and `lightmap.shader.rgbNormalisedGamma` are the two
  retail decode terms (`shader/lighting/Lightmap.h:16-38`). Which term applies
  is per material effect; the table records both and does not choose one.
- `lightmap.width`/`height` are `null` when the set mixes dimensions; the
  `dimensions` census is the authoritative distribution. `gracia` is the only
  built map whose whole set is 256x256.
- `lightmap.bytes` is the sum of each texture's 28-byte PC TextureDesc plus its
  encoded mip chain. It is not the decoded RGBA byte count; that is
  `decodedRgbaBytes` per texture (`width * height * 4`).
- `lightmap.sha256` and `decodedRgbaSha256` are set hashes over canonical JSON
  of `(name, texture sha256)` and `(name, decoded mip-0 sha256)` pairs sorted by
  name. The rule is repeated in `lightmap.provenance.setHashRule` in the
  manifest.
- The runtime table carries identity, dimensions, byte counts, source offsets
  and hashes. It does not carry pixels. A renderer decodes the source blob with
  the committed reader, or uses its own decoder and verifies the hashes.

### `missing`

Values the retail data does not serialize are absent from the returned object
and listed in `missing` as `{ code, field, reason }`. `field` is the absent
dotted path; `code` is `not-serialized` or `not-decoded`. Current entries, per
map (`ambient.lightmap` is conditional and absent on all four built maps
because the lightmap set is decoded):

| `field` | `code` | Why |
| --- | --- | --- |
| `sun.occlusion` | `not-serialized` | `m_fSunOcclusion` is per-vertex/per-material from the LS sample and baked lightmaps. |
| `sun.intensityScale` | `not-serialized` | The shader multiplies `SunColour` directly; no serialized multiplier exists. |
| `sky.occlusion` | `not-serialized` | `m_fSkyOcclusion` is per-vertex/per-material. |
| `ambient.perInstanceInterpolation` | `not-serialized` | One probe at the measured spawn; the engine interpolates the nearest light sample per instance. |
| `sky.domePixels` | `not-decoded` | The dome texture path is serialized; its pixels are not decoded here. |

`ambient.lightmap` (`not-decoded`) is kept only when a level's lightmap set
could not be decoded. The builder records the exact stream record and byte
offsets in `lightmap.unsupported` and leaves the entry in `missing`; it never
substitutes a white or partial set.

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

### Lightmaps (decoded mip 0)

Every texture is DXT5/BC3 (`format` `894720068`); `bytes` is the sum of the
28-byte PC TextureDesc plus the encoded mip chain. `set sha256` and
`decoded RGBA sha256` are the set hashes described above.

| map | textures | dimensions | bytes | set sha256 | decoded RGBA sha256 |
| --- | ---: | --- | ---: | --- | --- |
| `river` | 132 | 127 × 256x256, 5 × 512x512 | 9,965,168 | `84e509444e05a44e27b540a863a52ff7153781e901853c273f1c25b0fbadc55a` | `8cba30f8a8667746f04f9f57c17fcb30f8f7615296854951e3c05b4cd7708059` |
| `amboy` | 96 | 92 × 256x256, 4 × 512x512 | 7,342,720 | `5ccaf5a0158aa0d1a6260578e9b9ef3ebde22b743eca3af0b2ca2aaf3187fdfb` | `56aea82e923cfc552ab7c43ed3ac6db63ea10b9f4442a316eb71b708cf1efb9c` |
| `gracia` | 113 | 113 × 256x256 | 7,408,732 | `9def070cf24cd0922de829b598f4be2f8cfb92d259eeb09f1b3eb5f416471444` | `dadd3a16453055a0dc6185621364b7bcb8728934ff25860e466c96690ac3bd6a` |
| `longbeach` | 114 | 112 × 256x256, 2 × 512x512 | 7,998,584 | `6da2bbc3a3b542c255f692a931aaaf64920ffef33015e79e78651e2476929e49` | `537921bbd652e5e09febf9524064f9cef3f70ecf59c1c6d8e1c5f076a2f9e6af` |

The per-texture names, dimensions, source block/index, stream record offsets,
blob sha256 and decoded RGBA sha256 are in each manifest's `lightmap.textures`
and in the runtime table's `lightmap.textures`.

## Commands

Use the bundled Python:

```text
C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe
```

The lightmap decode needs the committed native texture decoder. Build it once
with `python tools/verify_asset_probe.py` (or reuse an existing
`_work/build/asset-reader-native/Release/texture_inspect.exe`).

```powershell
# 1. Rebuild the manifests from retail data (writes _work/lighting/).
python probes/lighting/tools/build_manifest.py
python probes/lighting/tools/verify_lighting.py          # expect 7490/7490

# 2. Rebuild the committed runtime table and verify it.
node probes/lighting/tools/build_runtime_lighting.mjs
node probes/lighting/tools/verify_runtime_lighting.mjs   # expect 16108/16108

# 3. Independently re-derive and verify the lightmap set.
python probes/lighting/tools/lightmap_reference.py --levels river,amboy,gracia,longbeach
node probes/lighting/tools/verify_lightmap.mjs           # expect N/N, two builds identical
```

`verify_runtime_lighting.mjs` re-derives every value from
`_work/lighting/<map>.json` without importing the builder, rejects any numeric
field that has no manifest source, checks unit length of every declared
direction, checks the `missing` list, checks every lightmap texture against the
manifest, and confirms two builder runs are byte-identical to each other and to
the committed JSON/module. It exits `1` on any failure.

`verify_lightmap.mjs` spawns `lightmap_reference.py` twice, compares the two
reference builds byte-for-byte, and compares the reference to the manifest and
the committed runtime table. The reference does not import the manifest builder;
it re-reads the retail bytes and re-decodes every lightmap. It exits `1` on any
failure.

The runtime and lightmap verifiers are not yet wired into
`tools/verify_asset_probe.py`; run them directly until that suite step is added.

## Scope and limits

- One ambient probe per map, at the measured spawn (`_work/map-slice/*`
  `layout.spawn`). The engine interpolates the nearest light sample per model
  instance; that interpolation is not serialized.
- The lightmap block is `decoded: true` for all four maps: every `g_tLightmap`
  texture's mip 0 is decoded and hashed. It is a **texture-set** term, not a
  single atlas. `width`/`height` are `null` when the set mixes dimensions; use
  `dimensions` and the per-texture entries.
- The lightmap block records identity, dimensions, format, source offsets and
  hashes. It does **not** include pixels, bind a sampler, generate mips, apply
  sRGB/colour transforms, or choose between `SunSkyLightmap` and
  `RGBLightmapNormalisedGamma`. Those remain renderer/material responsibilities.
- The lightmap set covers the whole level, not just the measured map-slice. A
  renderer that draws a subset still needs the per-material `g_tLightmap` name
  from the material binding.
- Retail cars use a projected drop shadow; no shadow map, cascade, bias or PCF
  parameter exists in the data.
- Emissive and light-blend states are per-material; only the per-level
  `EmissiveColour` scale is recovered by the manifest (and is not part of the
  runtime table).
- The runtime table covers the four built maps only. A fifth map needs a
  manifest first; the builder refuses anything else.
