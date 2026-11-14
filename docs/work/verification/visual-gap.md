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
