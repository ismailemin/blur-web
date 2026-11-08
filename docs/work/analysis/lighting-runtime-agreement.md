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

`probes/lighting/runtime-lighting.mjs` lists the lightmap decode in its `missing`
array (`not-decoded`), so this is a documented gap, not an assumption.

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
