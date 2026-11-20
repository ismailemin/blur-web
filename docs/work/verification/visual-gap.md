# Visual gap — our frames vs the retail reference video

Status: measured 15 November 2026. Answers "did we make the same game?" with
numbers instead of impressions. It is **not** a claim of visual parity.

## Method

The browser decodes the reference video (`Blur PC Gameplay in 4K.mp4`, 1280x720)
and draws frames to a canvas, so no ffmpeg is needed. For each frame it reports
mean luminance, luminance standard deviation (contrast), mean saturation and the
share of near-black pixels. The same numbers are computed for our screenshots.

```powershell
node _work/compare_visual.mjs      # writes _work/visual-compare.json + _work/video-frames/
```

## Numbers

| frame | mean luminance | contrast (std) | saturation | near-black share |
| --- | ---: | ---: | ---: | ---: |
| retail 3 s (menu / cinematic) | 0.112 | 0.148 | 0.621 | 0.571 |
| retail 8 s (menu / cinematic) | 0.073 | 0.129 | 0.792 | 0.760 |
| retail 15 s (gameplay, dusk street) | 0.279 | 0.180 | 0.370 | 0.061 |
| retail 25 s (gameplay, day city) | **0.369** | **0.249** | 0.280 | 0.059 |
| retail 40 s (gameplay, day) | 0.303 | 0.179 | 0.484 | 0.023 |
| retail 60 s (gameplay, day) | 0.278 | 0.191 | 0.416 | 0.074 |
| ours — Amboy | 0.374 | 0.193 | **0.247** | 0.226 |
| ours — Hackney | **0.127** | **0.076** | 0.299 | 0.319 |
| ours — Brighton | **0.106** | **0.069** | 0.504 | 0.628 |

The four gameplay frames (15/25/40/60 s) are the reference: mean luminance
**0.278-0.369**, contrast **0.179-0.249**, saturation **0.280-0.484**. The 3 s
and 8 s frames are menu/cinematic shots and are not used for the comparison.

Reading:

- **Hackney and Brighton are 2-3x too dark and 2.5x too flat.** Luminance
  0.106-0.127 against 0.278-0.369; contrast 0.069-0.076 against 0.179-0.249.
- **Amboy's luminance and contrast are already in range** (0.374 / 0.193), but
  its saturation is below every gameplay frame (0.247 vs 0.280-0.484) and the
  frame is a bare ground apron: the city geometry is not in that shot. Amboy's
  gap is **composition and colour**, not exposure.
- Every gameplay frame has a visible sky, road markings, other cars, bloom and
  a shadow under the car. Our frames have none of those in the same shot.

## What the retail frames have that we do not

| retail feature | our state | committed data we already hold |
| --- | --- | --- |
| **Sky dome** (texture, rotation, intensity) | hardcoded clear colour `0.043/0.075/0.106` | `sky.dome.texture` = `graphics/textures/skies/s10.texture`, `rotation`, `intensity`, `fogColour`, `blackHeight`, `blackSize` — already in the runtime lighting table |
| **HDR exposure + tone map** | direct linear → sRGB write, no exposure | `postProcess.exposureMin/Max` (2.0-3.0), `middleGrey` 0.1, `gamma` 2.2 — now in the runtime table |
| **Bloom** | none | `postProcess.bloomThreshold` 1.0, `bloomScale` 0.7-1.0 |
| **Shadows** | none | `shadow` block: projected blob shadows, `DropShadowHeight`, `ShadowSize`, `impostershadow.texture` |
| **Light flares / neon** | none | `lightFlares` block per level |
| **Particles, skid marks, smoke** | none | not serialized per level; needs the effect system |
| **Car reflection / specular** | flat paint colour only | `carPaint` colour is applied; no specular term |
| **Road markings** | present in the albedo, but washed out at 0.07 contrast | texture set is bound (1,251/1,301 draws textured) |

## Two concrete renderer defects visible in the screenshots

1. **Floating white quads near props** (truck, containers): a draw whose
   texture is missing or whose UVs are degenerate. The packet labels blocked
   draws, so this is a draw that *is* bound but samples a placeholder.
2. **Green glass slabs** in the first screenshot: a transparent/effect material
   drawn as opaque geometry.

Both need a per-draw check against the packet's `textureName`/`status` and the
`blocked-*` groups; neither is a lighting problem.

## The shader also skips two committed terms

The runtime table documents the retail rule
(`shader/common/Lighting.h:153-165`):

```text
diffuse = ((baked * BakedColour) + SkyColour*skyOcc*saturate(n.y*0.5+0.5)
           + SunColour*saturate(dot(n,sunDir))*sunOcc) * albedo * diffuseIntensity
```

Our fragment shader implements `SunColour*lambert*sunOcc + ambient*skyOcc` and
drops `baked * BakedColour` and the `saturate(n.y*0.5+0.5)` hemisphere term.
That is a correctness gap against our own committed rule, not a taste choice.

## Ordered plan

1. **Sky dome** — decode `graphics/textures/skies/s10.texture` through the
   map-slice texture pipeline and draw it as a background. Biggest single
   "this is a place" win; the data is already identified.
2. **HDR exposure + tone map** — needs a frame-luminance reduction (16x16
   downsample + async readback) so the committed
   `middleGrey / (luminance + 0.001)` rule, clamped to `exposureMin/Max`, can be
   applied instead of a guessed constant.
3. **Bloom** — threshold 1.0, scale from `bloomScale`; needs an HDR target.
4. **Blob shadows** — `shadow` block; a projected quad per car, no shadow map.
5. **Fix the two draw defects** (floating quads, opaque glass) by checking the
   packet status per draw.
6. **Shader terms** — add `baked*BakedColour` and the hemisphere term.

Items 1-3 are the difference between "a scene" and "Blur"; 4-6 are polish.

## Second pass — 20 November 2026: retail lightmap rule, draw defects, HDR post-process

Status: measured with the same method. **No parity claim.** The committed lightmap
rule, the two named draw defects and a data-driven HDR exposure/tone-map pass are
now implemented in `probes/e1-drive/web/`.

### Which lighting rule the shipped game actually runs

The earlier note above cited `shader/common/Lighting.h:153-165` (the Mercury
shader library). The effects the game ships are built from
`code/amax/game/Shaders/`, and the committed evidence there is unambiguous:

| evidence | value |
| --- | --- |
| `GameResource::EffectVariations::SetVariation("_LN")` (`AmaxWorldLayer.cpp:603`, `GameAppResources.cpp:366`) | every level runs the `_LN` effect variation |
| `code/amax/game/Shaders/shaders.jam:23,36` and `vehicle/shaders.jam:20` | `_LN` compiles with `-D NIGHT_LIGHTING` |
| `code/amax/game/Shaders/Common/Lighting.h:143-149` | `NIGHT_LIGHTING` → `Lighting/NightLighting.h` |
| `Lighting/NightLighting.h:24-40` | `m_vLighting = 1`; `ENABLE_LIGHTMAP` → `RGBLightmapNormalisedGamma` (`(sample.rgb*sample.a)^2`), else `RGBSH`; `EvaluateDiffuse = (static + dynamicLights) * albedo` |
| `Lightmap.h:20-26` | `RGBLightmapNormalisedGamma: vSample.rgb *= vSample.a; vColour *= vSample.rgb * vSample.rgb` |

Every map package's draws are `_LN` effects (Amboy 1201/1201, Hackney 2481/2512,
Brighton 1486/1512; the remainder are effect classes the slice does not draw), so
the RGB rule is not a per-map choice. The renderer previously used
`SunSkyLightmap` whenever a level serialized a live sun colour
(`baked ? 2 : 1`), which is why Amboy (SunColour `[1,1,1]`) read `.g`/`.b` as
occlusion. It now applies **mode 2 for every level**. `bakedColour` stays
multiplied in (the previously accepted `Lighting.h` term); note that
`NightLighting.h` itself does not reference `g_vBakedColour` — recorded as an
open divergence, not silently removed.

Two renderer defects were also fixed in the fragment stage:

- **Derivative normal orientation.** The pipeline is `cullMode:'none'` and has no
  vertex normal; WebGPU's framebuffer Y runs down-screen, so a horizontal ground
  triangle's derivative normal could be `-Y`. Then `dot(n,sunDir)` and
  `saturate(n.y*0.5+0.5)` were both 0 and the ground was black. The normal is now
  flipped up (`face.y < 0 → -face`) before either term.
- **Floating white quads.** A draw whose only albedo is an undeclared DXT5/BC3
  alpha source (`textureBinding.status === 'blocked-bc3-alpha'`, River's
  `cab01alphas_diff`, 4 draws) is now discarded in the fragment. The draw call,
  the packet and every hash are unchanged (`stats.suppressedDraws = 4` on River).
- **Opaque cyan glass.** Car draws with `partKind === 'glass'` (4 per car) are now
  submitted in a separate alpha-blended pass with a dark glass tint and alpha
  0.55. The material blend state is not recovered, so this is labelled as a
  presentation fallback.

### Data-driven HDR exposure, tone map and bloom

`app.js` passes `table.postProcess` to `consumer.setPostProcess()` and re-applies
it after every `consumer.load()`. The scene pass now writes linear radiance to an
`rgba16float` target; a 1x1 luminance pass reduces a 16x16 grid; the tone-map pass
applies the committed values (`psHDR.h PsToneMap`, `psLuminance.h` weights):

```text
exposure   = clamp(middleGrey / (frameLuminance + 0.001), exposureMin, exposureMax)
toneMapped = radiance * exposure * (middleGrey / (frameLuminance * exposure + 0.001))
encoded    = pow(toneMapped, 1 / gamma)
```

Bloom uses the committed `bloomThreshold`/`bloomScale` with a single-pass 5-tap
box. The retail bright pass and its bloom-curve texture are not decoded, and the
retail bloom downsample chain is not reproduced — labelled, not claimed. A caller
that never calls `setPostProcess` keeps the previous direct swap-chain path
(fallback preserved).

### Numbers (same measurement, same frames)

| frame | mean luminance | contrast (std) | saturation | near-black share |
| --- | ---: | ---: | ---: | ---: |
| retail gameplay (15/25/40/60 s) | 0.278-0.369 | 0.179-0.249 | 0.280-0.484 | 0.023-0.074 |
| ours — Amboy, before | 0.374 | 0.193 | 0.247 | 0.226 |
| **ours — Amboy, now** | **0.280** | **0.128** | **0.230** | **0.094** |
| ours — Hackney, before | 0.127 | 0.076 | 0.299 | 0.319 |
| **ours — Hackney, now** | **0.297** | **0.141** | **0.230** | **0.070** |
| ours — Brighton, before | 0.106 | 0.069 | 0.504 | 0.628 |
| **ours — Brighton, now** | **0.260** | **0.168** | **0.430** | **0.123** |

All three maps are now inside the retail luminance band (Hackney 2.3x, Brighton
2.5x brighter). Contrast improved but is still below retail (0.128-0.168 vs
0.179-0.249), and Amboy/Hackney saturation is still under every gameplay frame:
those are composition gaps (no sky dome, no city in frame, no shadows), not
exposure. Amboy's dark share fell from 0.226 to 0.094.

Reproduce:

```powershell
node probes/e1-drive/tools/serve.mjs --port 8801
node _work/check_showcase.mjs amboy     # also hackney, brighton, river
node _work/compare_visual.mjs
```

Console: 0 errors, 0 warnings on Amboy, Hackney, Brighton and River. Draw
accounting is unchanged (`drawsIssued == renders * draws` on all four), and
`lightingApplied.status` is `applied` (it previously stayed `pending-scene`).

### Still open

Sky dome, projected blob shadows, light flares, particles and car reflections are
untouched. Car lighting still uses the labelled ambient+sun proxy rather than the
retail `RGBSH` light-sample term, and the exact retail bloom chain (bright pass,
downsample, bloom curve) is not reproduced.

## Third pass — 20 November 2026: sky dome and projected blob shadows

Status: measured with the same method. Presentation systems only; the packet,
hashes and physics are untouched.

### Sky dome (item 1)

Every map's `sky.dome` record in the runtime table names one real retail texture.
The shipped renderer is `Effect::Sky::C_TexturedSkyDome`
(`effect/source/sky/TexturedSkyDome.cpp`, `vsTexturedSkyDome.vsh`,
`psTexturedSkyDome.psh`) with its 25x25 `BuildSphere()` dome. The shader rule is:

```text
v     = ring * 2 / rings          (= 2 * acos(ray.y) / pi)
u     = segment / segments + rotation
fog   = saturate((v + fogTop - 1) / fogTop) ^ fogCurve      (fogTop = fogAlpha = 1)
black = saturate((blackHeight - v) * blackSize)
sky   = texture(u, v).rgb * texture.a * texture.a * intensity
colour= lerp(sky, fogColour, fog) * black
```

`TexturedSkyDome::OnCreate` only calls `SetSRGB()` when the file is *not* a
`.texture`, so the dome texture is uploaded as `rgba8unorm` (linear); the alpha
channel is the brightness term (`rgb * a * a`), which is why the DXT5 alpha must
be decoded too.

The exporter `probes/lighting/tools/export_sky_dome.py` extracts all 14 distinct
dome textures from `game-data/Blur/cache/root.pak`, decodes them and writes
`_work/lighting/skies/<name>.rgba` (2048x512 RGBA8), `skies/index.json`, and a
per-map `_work/lighting/<map>/sky.json` carrying the committed parameters. All
14 are 2048x512 DXT5/BC3 single-mip; any other format aborts with a typed reason
and byte offset. The native `texture_inspect.exe` refuses >512 px textures on
purpose, so the DXT5 block decode is a byte-for-byte port of its `pixels()`
(`probes/asset-reader/src/texture_reader.cpp`); the exporter decodes a committed
256x256 DXT5 sample (`dontship/textures/debugback.texture`) with both and aborts
unless the RGBA buffers are identical (`decoderSelfCheck.match = true`).

The consumer draws the dome as a full-screen pass **before** opaque geometry
(depth write off), with the exact per-pixel mapping above; the page fetches the
per-map `sky.json` and the RGBA buffer and calls `consumer.setSkyDome(...)`,
re-applied after every `consumer.load()`.

### Blob shadows (item 4)

`_work/lighting/<map>.json` carries `amax.bin City.EnvironmentSettings.
shadowSettings` (ShadowSize 6, ShadowHeight 0.5/1, DropShadowIntensity 0.75,
DropShadowHeight 30/50, MaxShadows 6) and the imposter texture
`graphics/textures/shadows/impostershadow.texture`. That texture is a 32x32 **A8**
image: a filled square with a 1-2 px edge (`{255,255,255,a}` after decode), and
the retail path blurs it per channel and composites it in screen space. That full
chain is not reproduced. The consumer draws the committed texture on a
ground-projected quad under the car (and every active remote/ghost car), aligned
with the car's yaw, sized from its footprint and clamped to `ShadowSize`, with
alpha = texture alpha × `DropShadowIntensity` × a radial smoothstep standing in
for the retail blur. It is labelled `projected-imposter-approximation`; no packet
draw, hash or physics value changes.

### Numbers (same measurement, same frames)

| frame | mean luminance | contrast (std) | saturation | near-black share |
| --- | ---: | ---: | ---: | ---: |
| retail gameplay | 0.278-0.369 | 0.179-0.249 | 0.280-0.484 | 0.023-0.074 |
| Amboy — 2nd pass | 0.280 | 0.128 | 0.230 | 0.094 |
| **Amboy — now** | **0.262** | **0.148** | **0.164** | **0.044** |
| Hackney — 2nd pass | 0.297 | 0.141 | 0.230 | 0.070 |
| **Hackney — now** | **0.281** | **0.150** | **0.204** | **0.045** |
| Brighton — 2nd pass | 0.260 | 0.168 | 0.430 | 0.123 |
| **Brighton — now** | **0.273** | **0.174** | **0.230** | **0.234** |

The sky is now the largest single "this is a place" change: luminance stays in the
retail band, contrast rises on all three maps, and the bare-clear-colour
near-black share falls to 0.044 on the two daytime maps. Saturation falls because
the dome (a hazy sunset for Amboy/Hackney) now occupies a large part of the
frame; Brighton's near-black share rises because its committed dome is a night
sky. The retail comparison frames are daytime gameplay, so Brighton's numbers are
reported, not targeted.

Reproduce:

```powershell
python probes/lighting/tools/export_sky_dome.py
node probes/e1-drive/tools/serve.mjs --port 8801
node _work/check_showcase.mjs amboy     # also hackney, brighton, river
node _work/compare_visual.mjs
```

Console: 0 errors, 0 warnings on all four maps; `skyFrames == renders`,
`shadowDraws == renders` (one local car), `drawsIssued` still
`renders * packet draws`.

### Still open (updated)

Light flares, particles, car reflections and the exact retail deferred blob chain
remain. Car lighting still uses the labelled ambient+sun proxy, and the bloom
chain remains the single-pass approximation. The sky dome is drawn per-pixel with
no dome geometry, so it does not reproduce the retail sphere's tessellation
(visually equivalent for a camera at the centre, which is what the retail dome
enforces).


