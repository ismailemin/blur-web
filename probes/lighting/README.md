# probes/lighting

Retail per-level lighting recovery for the eleven playable maps (`river`,
`amboy`, `gracia`, `longbeach`, `observatory`, `downtown`, `mharuna`,
`highrise`, `shutoko`, `oval`, `amboy-mp`) and the browser-importable runtime
table derived from it.

Every number in this probe is traceable to a retail byte stream (offset recorded
in the manifest) or to an upstream shader/engine constant (`file:line` recorded).
Nothing is guessed, scaled or interpolated.

## Contents

| Path | Role |
| --- | --- |
| `tools/lighting_data.py` | Read-only recovery from `Level.levelrender` (`Lights`, `LS`, Scene declarations), `Level.levelstream` (normal bytes) and `cache/gamedata.pak` (`amax.bin` `City.EnvironmentSettings`). |
| `tools/lightmap_data.py` | Read-only decode of the static-world lightmap set: scans `Level.levelstream` LOD0 resource-block textures, resolves material `g_tLightmap` through the RenderList texture-source list, extracts each PC TextureDesc + DXT5/BC3 blob and decodes mip 0 with the committed `texture_inspect` decoder. |
| `tools/build_manifest.py` | Writes the per-map manifests `_work/lighting/<map>.json` and `_work/lighting/index.json` (schema `blur-lighting/1`), including the `lightmap` block. |
| `tools/verify_lighting.py` | 18,429-check manifest verifier (provenance, ranges, unit consistency, byte re-derivation, lightmap source re-derivation, typed unsupported records, determinism). |
| `tools/build_runtime_lighting.mjs` | Deterministic builder for the committed browser table. Copies values verbatim; never rounds or scales. |
| `tools/runtime_lighting_module.template.mjs` | Module template used by the builder. |
| `data/runtime-lighting.json` | Committed runtime table (schema `blur.lighting-runtime/1`). |
| `runtime-lighting.mjs` | Generated browser module. Do not edit by hand. |
| `tools/verify_runtime_lighting.mjs` | 33,376-check runtime table verifier (lighting + lightmap, typed null sun/lightmap handling). |
| `tools/lightmap_reference.py` | Independent lightmap reference: re-scans the retail bytes and re-decodes every lightmap without importing the manifest builder. |
| `tools/verify_lightmap.mjs` | Lightmap verifier: compares the reference to the manifest and runtime table, checks the `g_tLightmap` reference set, and checks two reference builds are byte-identical. |
| `tools/export_lightmap_rgba.py` | Deterministic exporter: writes each decoded mip-0 RGBA8 buffer to `_work/lighting/<map>/lightmap/<name>.rgba` plus a per-map `index.json`. |
| `lightmap-runtime.mjs` | Renderer resolver: maps a map id and `g_tLightmap` name to the exported `.rgba` URL, byte count and sha256, and returns the committed shader rule. |
| `tools/verify_lightmap_runtime.mjs` | Export verifier: re-derives the index, checks every file hash/size, checks the resolver against the index, and checks determinism. |

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
LIGHTING_MAPS;   // ['river', 'amboy', 'gracia', 'longbeach', 'observatory',
                 //  'downtown', 'mharuna', 'highrise', 'shutoko', 'oval',
                 //  'amboy-mp'] (frozen, build order)

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
  sun: null | {
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
    decoded: true,               // false on downtown/highrise (typed unsupported)
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

### Lightmap pixel resolver

`lightmap-runtime.mjs` joins the committed table to the exported `.rgba` files.
It imports `runtime-lighting.mjs`, so it needs no `_work` read at import time and
embeds no pixels.

```js
import {
  LIGHTMAP_RUNTIME_SCHEMA,
  LIGHTMAP_MAPS,
  lightmapSetFor,
  lightmapTextureFor,
  lightmapShaderFor,
  LightmapRuntimeError
} from './probes/lighting/lightmap-runtime.mjs';

LIGHTMAP_RUNTIME_SCHEMA; // 'blur.lightmap-runtime/1'
LIGHTMAP_MAPS;           // ['river', 'amboy', 'gracia', 'longbeach', 'observatory',
                         //  'downtown', 'mharuna', 'highrise', 'shutoko', 'oval',
                         //  'amboy-mp'] (frozen; downtown/highrise have no set)

const set = lightmapSetFor('river');
// {
//   mapId: 'river',
//   count: 132,
//   uvSet: 'luxlightmap',
//   shader: { uvSource, sunSky, rgbNormalisedGamma },
//   textures: [{ name, width, height, url, bytes, sha256 }]
// }

const texture = lightmapTextureFor('river', 'lightmap_main_000-a');
// {
//   name: 'lightmap_main_000-a', width: 256, height: 256,
//   url: '/_work/lighting/river/lightmap/lightmap_main_000-a.rgba',
//   bytes: 262144, sha256: '93d7f2f6…37d1'
// }   // or null

const shader = lightmapShaderFor('river');
// { uvSource, sunSky, rgbNormalisedGamma }, verbatim from the runtime table
```

`url` is `/_work/lighting/<map>/lightmap/<name>.rgba`, `bytes` is the file size
(`width * height * 4`) and `sha256` is the file hash, so a consumer can verify
the download before uploading it as an RGBA8 texture. `lightmapSetFor` throws
`LightmapRuntimeError` with `code === 'invalid-map-id'`, `'unknown-map'` or
`'lightmap-unavailable'` (the last also for `downtown` and `highrise`, which
have no decoded set). `lightmapTextureFor` returns `null` for a name outside
the set (including a non-string name). `lightmapShaderFor(mapId)` returns the
same frozen object as `lightmapSetFor(mapId).shader`.

The shader object is the committed rule, not a choice: a material effect decides
whether it uses `sunSky` (`.g`/`.b`) or `rgbNormalisedGamma` (`(.rgb*.a)^2`).
The resolver does not pick one, apply it, generate mips, or bind a sampler.

### Field semantics

- `sun.direction` is the unit vector pointing from the surface toward the sun
  (`C_LightList::GetSunDirection` returns matrix row Z, `LightList.cpp:90-98`).
- `sun.colour` is `LightingInfo.SunColour.rgb`, the value the retail diffuse
  term multiplies (`shader/common/Lighting.h:153-165`). It is `[0,0,0]` on
  `river`, `gracia`, `longbeach`, `observatory` and `oval`, which bake the sun
  into lightmaps and light samples; `amboy`, `mharuna`, `shutoko` and
  `amboy-mp` author a live sun colour. A consumer must not substitute a white
  sun for the zero-colour maps. The decoded `lightmap` set is the baked term
  those maps rely on; bind it through the material's `g_tLightmap` name instead
  of inventing a directional sun. `sun` is `null` on `downtown` and `highrise`,
  which serialize no directional sun at all (their `LightingInfo.SunColour` is
  also zero).
- `sun.intensity` is the serialized `C_Light` colour alpha (`1.0` on every map
  that serializes a sun). The retail shader does not scale `SunColour` by it; it
  is reported, not applied.
- `sun.lightObjectColour` is the serialized `C_Light` colour (`[1,1,1]` on every
  map that serializes a sun). The runtime shader does not read it; it is kept
  for traceability.
- `sky.colour` is `LightingInfo.SkyColour.rgb`. It is `[0,0,0]` on `gracia` and
  `oval`.
- `sky.dome.intensity` is `skySettings.intensity`, which scales the sky dome
  texture, not the diffuse `sky.colour` term.
- `ambient.upNormalAmbientScaled` is the baked ambient term for an up-facing
  normal (`SH(+Y) * BakedColour`); `ambient.sh` is the raw 12-coefficient RGBSH
  sample so a consumer can evaluate any normal.
- `fog` is `null` only when the level authors no fog record; all eleven maps
  serialize one.
- `lightmap` is the decoded static-world lightmap set, not a single atlas. Every
  texture is a levelstream LOD0 resource-block texture bound by at least one
  material `g_tLightmap` field. `lightmap.textures` is sorted by name; the
  renderer looks up the material's `g_tLightmap` name and binds that entry.
  `lightmap.decoded` is `false` on `downtown`/`highrise`; their `textures` list
  is the decoded `lightmap_*` subset and `unsupported` records the reference
  that is outside it.
- `lightmap.uvSet` is `'luxlightmap'`; the shader reads the lightmap UV from
  `TEXCOORD0.zw` (`shader/common/Parameters.h:11`).
- `lightmap.shader.sunSky` and `lightmap.shader.rgbNormalisedGamma` are the two
  retail decode terms (`shader/lighting/Lightmap.h:16-38`). Which term applies
  is per material effect; the table records both and does not choose one.
- `lightmap.width`/`height` are `null` when the set mixes dimensions; the
  `dimensions` census is the authoritative distribution. `gracia` is the only
  decoded map whose whole set is 256x256.
- `lightmap.bytes` is the sum of each texture's 28-byte PC TextureDesc plus its
  encoded mip chain. It is not the decoded RGBA byte count; that is
  `decodedRgbaBytes` per texture (`width * height * 4`).
- `lightmap.sha256` and `decodedRgbaSha256` are set hashes over canonical JSON
  of `(name, texture sha256)` and `(name, decoded mip-0 sha256)` pairs sorted by
  name. The rule is repeated in `lightmap.provenance.setHashRule` in the
  manifest.
- The runtime table carries identity, dimensions, byte counts, source offsets
  and hashes. It does not carry pixels. `tools/export_lightmap_rgba.py` writes
  the mip-0 pixels to `_work/lighting/<map>/lightmap/` (section below), and
  `lightmap-runtime.mjs` resolves them; a renderer can also decode the source
  blob with the committed reader and verify the hashes.

### `missing`

Values the retail data does not serialize are absent from the returned object
and listed in `missing` as `{ code, field, reason }`. `field` is the absent
dotted path; `code` is `not-serialized` or `not-decoded`. Current entries, per
map (`ambient.lightmap` is conditional: absent on the nine decoded maps and
present on `downtown`/`highrise`; `sun` is present only on `downtown` and
`highrise`, which serialize no directional sun):

| `field` | `code` | Why |
| --- | --- | --- |
| `sun.occlusion` | `not-serialized` | `m_fSunOcclusion` is per-vertex/per-material from the LS sample and baked lightmaps. |
| `sun.intensityScale` | `not-serialized` | The shader multiplies `SunColour` directly; no serialized multiplier exists. |
| `sky.occlusion` | `not-serialized` | `m_fSkyOcclusion` is per-vertex/per-material. |
| `ambient.perInstanceInterpolation` | `not-serialized` | One probe at the measured spawn; the engine interpolates the nearest light sample per instance. |
| `sky.domePixels` | `not-decoded` | The dome texture path is serialized; its pixels are not decoded here. |
| `sun` | `not-serialized` | `C_LightList` `hasSun=0` on `downtown`/`highrise`; the code-only fallback direction (`LightList.cpp:97`) is not substituted. |

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
| `observatory` | `[0.739942, 0.258819, -0.620885]` | `[0, 0, 0]` | `[0.088943, 0.113937, 0.137192]` | `[1, 1, 1]` | `0.0004` |
| `downtown` | `—` (`hasSun=0`) | `—` | `[0.142822, 0.162781, 0.178024]` | `[1, 1, 1]` | `0.00025` |
| `mharuna` | `[-0.526541, 0.573577, -0.627507]` | `[1, 1, 1]` | `[0.043911, 0.074844, 0.118744]` | `[1, 1, 1]` | `0.0005` |
| `highrise` | `—` (`hasSun=0`) | `—` | `[0.165527, 0.173035, 0.209793]` | `[1, 1, 1]` | `0.0005` |
| `shutoko` | `[0.353553, 0.707107, 0.612372]` | `[1, 1, 1]` | `[0.030533, 0.044205, 0.058563]` | `[1, 1, 1]` | `0.00025` |
| `oval` | `[0.000000, 0.258819, 0.965926]` | `[0, 0, 0]` | `[0.273651, 0.258270, 0.236572]` | `[0, 0, 0]` | `0.001` |
| `amboy-mp` | `[-0.334546, 0.207912, -0.919158]` | `[1, 1, 1]` | `[0.177612, 0.123734, 0.149323]` | `[1, 1, 1]` | `0.001` |

`sun.intensity` is `1.0` and `sun.lightObjectColour` is `[1, 1, 1]` on every map
that serializes a sun. `downtown` and `highrise` serialize no directional sun
(`C_LightList` `hasSun=0`), so `sun` is `null` and the manifest carries a typed
`sunUnsupported` record; the code-only fallback direction (`LightList.cpp:97`)
is not substituted. Exact values (not the 6-decimal display above) are in
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
| `observatory` | 48 | 44 × 256x256, 4 × 512x512 | 4,195,648 | `f9762279870c60b93eea1055b54d19f258ceca3f12bdd31f142bd0892854c9ae` | `9aaef5327bbdcf71cb40865ac62b57f9f5df6a84f07f24ba2d8290ba2fa8bdf6` |
| `mharuna` | 167 | 149 × 256x256, 18 × 512x512 | 15,667,780 | `87df32b8cefdd3d55c9f852d833da9a0c33ca2b46037aff9c65277fb07905bc3` | `568d088706c358d1cf2b8cb6cf197981699284218cfe1210d191588889d4f7ce` |
| `shutoko` | 104 | 102 × 256x256, 2 × 512x512 | 7,342,944 | `8c7df050230a55b095d09ad621f53fa4a2f925be1566639187b70fc34be92321` | `43f87ec2653e5e5b7c3f2424a05f382200035dc2197420d697b6bfded632b635` |
| `oval` | 114 | 113 × 256x256, 1 × 512x512 | 7,736,440 | `9420d372815cf75f34be741180ebb9caec2011b9d0ff5d7127a9c1e8ead75905` | `172c6c50adbc59371a7b0e63145a6c423422c56fce75ee3cb39d0bca1c550405` |
| `amboy-mp` | 37 | 36 × 256x256, 1 × 512x512 | 2,688,012 | `6c2f7e32653d0e076cc2148939b672c7e6467d25710b331a5f9c54e7e9d3f527` | `c5a20523d26e610d7599fee7cc9d53e22275f76c5a00d15d6d5316c7f819ebb0` |

`downtown` and `highrise` do **not** have a decoded set. Their manifests decode
the `lightmap_*` subset (102 textures / 7,736,104 bytes and 77 textures /
13,174,892 bytes respectively) but mark the block `decoded: false` because one
`g_tLightmap` reference is outside the clean lightmap set. The runtime table
sets `lightmap: null` and the exporter writes no files for them. See
[Unsupported maps](#unsupported-maps).

### Unsupported maps

Two maps carry typed `unsupported` records; nothing is substituted.

| map | field | typed record | exact source |
| --- | --- | --- | --- |
| `downtown` | `sun` | `not-serialized` | `Level.levelrender` `Lights` block, `hasSun=0`; `sunUnsupported` records block offset 4,223,991 / 567,652 B. The `LightList.cpp:97` fallback is not substituted. |
| `downtown` | `lightmap` | `g_tLightmap resolves to a non-lightmap texture` | `DefaultColour`, block 1073 / index 3, material `FlashingNeon_LN_NV.fx`, stream record 126 at offset 9,684,992 (102,400 B). |
| `highrise` | `sun` | `not-serialized` | `Level.levelrender` `Lights` block, `hasSun=0`; `sunUnsupported` records block offset 1,152,778 / 203,060 B. The `LightList.cpp:97` fallback is not substituted. |
| `highrise` | `lightmap` | `texture block/index not found in the LOD0 scan` | `g_tLightmap` key `[215, 0]`, stream record 28 at offset 288,768; no LOD0 texture with that block/index exists. |

The manifest keeps the decoded `lightmap_*` subset and its hashes, but
`lightmap.decoded` is `false`; the runtime table has `sun: null`,
`lightmap: null`, and `ambient.lightmap` in `missing`. The exporter prints
`unsupported: runtime table has no decoded lightmap set` and writes no
`.rgba`/`index.json` for those maps.

The per-texture names, dimensions, source block/index, stream record offsets,
blob sha256 and decoded RGBA sha256 are in each manifest's `lightmap.textures`
and in the runtime table's `lightmap.textures`.

## Exported lightmap pixels (renderer input)

The runtime table carries identity and hashes, not pixels. `tools/export_lightmap_rgba.py`
re-runs the committed decode and writes the mip-0 RGBA8 buffer of every
`g_tLightmap` texture:

```text
_work/lighting/<map>/lightmap/<name>.rgba    raw mip-0 RGBA8, width*height*4 bytes
_work/lighting/<map>/lightmap/index.json     per-texture size/hash + set hash
```

`_work/` is gitignored: the pixels are a local build artifact and are never
committed. The export is byte-deterministic — two runs produce identical files
and identical `index.json` bytes.

| map | textures | `.rgba` files | exported bytes |
| --- | ---: | ---: | ---: |
| `river` | 132 | 132 | 38,535,168 |
| `amboy` | 96 | 96 | 28,311,552 |
| `gracia` | 113 | 113 | 29,622,272 |
| `longbeach` | 114 | 114 | 31,457,280 |
| `observatory` | 48 | 48 | 15,728,640 |
| `mharuna` | 167 | 167 | 57,933,824 |
| `shutoko` | 104 | 104 | 28,835,840 |
| `oval` | 114 | 114 | 30,670,848 |
| `amboy-mp` | 37 | 37 | 10,485,760 |
| `downtown` | — | — | unsupported (no decoded set) |
| `highrise` | — | — | unsupported (no decoded set) |

925 files, 271,581,184 bytes in total across the nine decoded maps.

### `.rgba` byte contract

- Raw mip 0, no header and no mip chain: exactly `width * height * 4` bytes.
- Row-major, row 0 first (the D3D top row), channels R, G, B, A, 8 bits each
  (`texture_reader.cpp` writes `out[(py*width+px)*4]`).
- The bytes are the decoded DXT5/BC3 texels. No sRGB decode, gamma or colour
  transform is applied (`colorTransformApplied: false`, matching the decoder's
  `colorTransformApplied:false`).
- Per texture, `sha256` (the file) and `decodedRgbaSha256` (the pixel buffer) are
  equal by construction; the index keeps both names so a consumer can check
  either.

### `index.json`

```json
{
  "schema": "blur.lightmap-rgba/1",
  "kind": "lightmap-rgba-export",
  "mapId": "river",
  "level": "usa_la_river",
  "uvSet": "luxlightmap",
  "format": "RGBA8",
  "sourceFormat": 894720068,
  "sourceFormatName": "DXT5/BC3",
  "mipLevel": 0,
  "colorTransformApplied": false,
  "count": 132,
  "width": null,
  "height": null,
  "dimensions": { "256x256": 127, "512x512": 5 },
  "bytes": 38535168,
  "sha256": "8cba30f8a8667746f04f9f57c17fcb30f8f7615296854951e3c05b4cd7708059",
  "setHashRule": "sha256 over canonical JSON of the per-texture (name, decodedRgbaSha256) pairs sorted by name; ...",
  "textures": [
    {
      "name": "lightmap_main_000-a",
      "width": 256,
      "height": 256,
      "bytes": 262144,
      "sha256": "93d7f2f67689e86c7fc6ed7fee8c159f428a446489d34228445dc9437d4837d1",
      "decodedRgbaSha256": "93d7f2f67689e86c7fc6ed7fee8c159f428a446489d34228445dc9437d4837d1",
      "file": "river/lightmap/lightmap_main_000-a.rgba"
    }
  ],
  "source": "..."
}
```

`file` is relative to the export root (`_work/lighting`), so the index is
identical whichever `--out-root` is used. The set-level `sha256` uses the
manifest rule over `(name, decodedRgbaSha256)`, so it equals the manifest and
runtime table `lightmap.decodedRgbaSha256` — for `river` that is
`8cba30f8…8059`, the value in the table above.

The exporter aborts, writing no index, when a decode fails, when a decoded field
disagrees with the PC TextureDesc (dimensions, format, mip count, pixel offset,
encoded byte count), or when the committed runtime table disagrees with the
retail bytes. A map whose runtime table has `lightmap: null` is skipped with a
typed `unsupported` line before any decode. It never writes a placeholder, a
white texture or a partial set; stale `.rgba` files from a previous larger set
are removed only after the new set decodes cleanly.

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
python probes/lighting/tools/verify_lighting.py          # expect 18429/18429

# 2. Rebuild the committed runtime table and verify it.
node probes/lighting/tools/build_runtime_lighting.mjs
node probes/lighting/tools/verify_runtime_lighting.mjs   # expect 33376/33376

# 3. Independently re-derive and verify the lightmap set.
python probes/lighting/tools/lightmap_reference.py --levels river,amboy,gracia,longbeach,observatory,downtown,mharuna,highrise,shutoko,oval,amboy-mp
node probes/lighting/tools/verify_lightmap.mjs           # expect 21889/21889, two builds identical

# 4. Export the decoded mip-0 RGBA8 pixels and verify the renderer resolver.
python probes/lighting/tools/export_lightmap_rgba.py     # writes _work/lighting/<map>/lightmap/
node probes/lighting/tools/verify_lightmap_runtime.mjs   # expect 12336/12336
```

`export_lightmap_rgba.py` exports the nine maps with a decoded set and prints a
typed `unsupported` line for `downtown` and `highrise`; it never writes a
placeholder. `--maps river --out-root <dir>` exports a subset to another root;
`--quiet` suppresses the per-map summary. The output is byte-deterministic and
the index is independent of the root.

`verify_lightmap_runtime.mjs` checks the export index against the committed
runtime table (count, dimensions, byte totals, set sha256, every per-texture
hash), checks every `.rgba` file's size and sha256, checks that no stale
`.rgba` remains, and checks that `lightmap-runtime.mjs` returns exactly the
index and the committed shader rule. It then runs the exporter twice into fresh
temporary roots and requires both indexes to be byte-identical to each other and
to the committed export, with every re-derived file hash matching. It exits `1`
on any failure. Set `PYTHON` to the bundled interpreter when `python` is not on
`PATH`.

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

- One ambient probe per map, at the measured spawn. The four original maps use
  `_work/map-slice/*-render/render.json` `layout.spawn`; the seven added maps
  use `_work/e1-drive/<map>/layout.json` `course.spawn.x/z` plus
  `course.spawnGroundY` (committed source `probes/map-laps/data/<map>-path.json`).
  The engine interpolates the nearest light sample per model instance; that
  interpolation is not serialized.
- The lightmap block is `decoded: true` for nine maps: every `g_tLightmap`
  texture's mip 0 is decoded and hashed. It is a **texture-set** term, not a
  single atlas. `width`/`height` are `null` when the set mixes dimensions; use
  `dimensions` and the per-texture entries. `downtown` and `highrise` are
  `decoded: false` with a typed `unsupported` record; they are not treated as
  decoded sets.
- The lightmap block records identity, dimensions, format, source offsets and
  hashes. It does **not** include pixels. The exported `.rgba` files carry the
  mip-0 pixels, but they still do not bind a sampler, generate mips, apply an
  sRGB/colour transform, or choose between `SunSkyLightmap` and
  `RGBLightmapNormalisedGamma`. Those remain renderer/material responsibilities.
- The exported pixels are mip 0 only and are a gitignored `_work/` artifact. The
  committed contract is the runtime table plus the export index schema; a
  consumer that regenerates the pixels must check them against the table's
  `decodedRgbaSha256`.
- Exporting the pixels does not supply the lightmap UV. `uvSet` is
  `'luxlightmap'` (`TEXCOORD0.zw`), but the committed map-slice UV0 stream is
  2 components, so a renderer still has no lightmap UV to sample with. A planar
  projection would be a fabricated UV and is not generated here (see
  `docs/work/analysis/lighting-runtime-agreement.md`).
- The lightmap set covers the whole level, not just the measured map-slice. A
  renderer that draws a subset still needs the per-material `g_tLightmap` name
  from the material binding.
- Retail cars use a projected drop shadow; no shadow map, cascade, bias or PCF
  parameter exists in the data.
- Emissive and light-blend states are per-material; only the per-level
  `EmissiveColour` scale is recovered by the manifest (and is not part of the
  runtime table).
- The runtime table covers all eleven playable maps. A map whose
  `C_LightList` has `hasSun=0` has `sun: null`; a map whose `g_tLightmap` set is
  unclean has `lightmap: null`. Both are listed in `missing` with a typed code;
  the builder never substitutes a fallback sun or a placeholder texture.
