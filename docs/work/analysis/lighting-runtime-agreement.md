# Lighting: the packet light is diagnostic, the retail sun is baked

**Date:** 8 November 2026
**Scope:** the driving page's directional light vs the committed lighting table
(`probes/lighting/runtime-lighting.mjs`).

## Finding

The renderer takes its directional light from the packet (`packet.lights[0]`).
The committed retail lighting table records a different sun for every map:

| map | packet direction | committed direction | committed sun colour | verdict |
| --- | --- | --- | --- | --- |
| river | (from the packet) | `[0.7198, 0.3420, -0.6040]` | `[0,0,0]` | baked |
| amboy | (from the packet) | `[-0.3345, 0.2079, -0.9192]` | `[1,1,1]` | live colour |
| gracia | (from the packet) | `[-0.2418, 0.7071, -0.6645]` | `[0,0,0]` | baked |
| longbeach | (from the packet) | `[0.8627, 0.0872, -0.4981]` | `[0,0,0]` | baked |

`agree: false` for all four (max direction delta 1.05–1.22, max colour delta 1.0).

## Why the committed sun cannot simply replace the packet light

Three of the four maps author `LightingInfo.SunColour.rgb = [0,0,0]` because
they bake the sun into lightmaps / light samples. A renderer without the
lightmap decode would go black if it used that colour. The page therefore keeps
the packet's diagnostic light and says so.

## Update: the lightmap is now decoded

`probes/lighting` decoded the lightmap set: **455 retail textures** across the
four maps (DXT5/BC3, mip 0), bound through material `g_tLightmap`:

| map | textures | dimensions | set sha256 |
| --- | ---: | --- | --- |
| river | 132 | 127 × 256², 5 × 512² | `84e50944…` |
| amboy | 96 | 92 × 256², 4 × 512² | `5ccaf5a0…` |
| gracia | 113 | 113 × 256² | `9def070c…` |
| longbeach | 114 | 112 × 256², 2 × 512² | `6da2bbc3…` |

`lighting.lightmap` is a `texture-set` with `decoded: true`, the per-texture
source offsets, `sha256` and `decodedRgbaSha256`, and the shader rule
(`SunSkyLightmap` on `.g`/`.b`, or `RGBLightmapNormalisedGamma` on
`(.rgb*.a)^2`). `lightmap-decode` is no longer in `missing`.

**The page still renders with the packet light.** Wiring the decoded lightmap
into the packet consumer is the remaining step: the consumer must bind the
material's `g_tLightmap` texture and the `TEXCOORD0.zw` lightmap UV, then apply
the shader rule above. Until that lands, `state.lightingAgreement` keeps
reporting `agree: false` and the diagnostic light stays labelled.

### The blocker: the lightmap UV is not in the committed package

The lightmap UV is `TEXCOORD0.zw`, but the map-slice UV0 stream is **2
components** (`"role": "merged section UV0 pairs, 2 ..."` in every
`_work/map-slice/<map>/slice.json`). The renderer therefore has no lightmap UV
to sample with. Exporting the full 4-component TEXCOORD0 from the map-slice
producer is the prerequisite; guessing a planar projection would be a fabricated
UV, so it is not done.

### What was applied instead

The committed **ambient** term is now applied: the packet consumer's scene
uniform uses the luminance of `lighting.ambient.upNormalAmbientScaled` instead of
the old hardcoded `0.16`. Measured per map: river `0.2532`, amboy `0.1331`,
gracia `0.1780`, longbeach `0.7699`. `state.ambientApplied` records the value and
`consumer.stats.ambient` carries it into the probe.

## What the page records

`state.lightingAgreement` (in the probe) carries, per map:

```json
{
  "mapId": "amboy",
  "source": "packet",
  "packet": { "direction": [...], "colour": [...] },
  "committed": { "direction": [...], "colour": [...] },
  "maxDirectionDelta": 1.05,
  "maxColourDelta": 1.0,
  "agree": false,
  "note": "the retail sun is a live directional colour; a mismatch means the packet light is diagnostic"
}
```

For the baked maps the note says the retail sun is `[0,0,0]` because it is baked
into lightmaps.

## Next step for real lighting parity

1. Decode the lightmap / light-sample data (`probes/lighting` already reads the
   `LS` block and the per-point RGBSH samples).
2. Apply it as a vertex or texture term in the packet consumer, with a
   before/after screenshot and a hash of the applied table.
3. Only then replace the packet diagnostic light.

Until then, the diagnostic light is labelled and the retail table is exposed
read-only.
