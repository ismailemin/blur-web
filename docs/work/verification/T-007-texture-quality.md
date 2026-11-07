# T-007 texture quality — proven sRGB decode, derived mip chain, trilinear sampling

**Date:** 7 November 2026
**Owner:** P75 (sub-agent)
**Scope:** `probes/e1-drive/web/packet-consumer.js`,
`probes/e1-drive/tools/capture_browser.mjs` (`--mode quality`),
`_work/e1-drive/**`, `_work/logs/e1-drive/**`, `probes/e1-drive/README.md`,
`docs/work/analysis/e1-drive-slice.md` §30 and this record. No builder, geometry,
packet, verifier, asset-reader, engine, tool, prop-collision, `upstream/` or
`game-data/` file was modified. Physics, collision, cars, sprint rules, camera,
ghost and audio are untouched.

> **Supersedes (sampling only):** the "mip chain and sRGB are not applied"
> limits in `T-007-textured-track.md`, `T-007-textured-cars.md` and
> `T-007-prop-textures.md`. Those records remain valid for their own
> projections, UVs, pixels and draw coverage; the consumer now applies the
> sRGB decode and a derived mip chain described below.

## Result

The PoC had two independent texture-sampling defects, both visible on the
track, the car decals and the level props:

1. **Colour transfer:** the committed BC1 decode was uploaded as
   `rgba8unorm` (raw stored texels, no sRGB-to-linear decode) and the shader
   then gamma-encoded the result with `pow(1/2.2)`. The stored texels are
   sRGB-encoded (proof below), so every texture was gamma-encoded twice: the
   washed-out, flat-looking pale track/trucks and pale car decals.
2. **Minification:** only mip0 was uploaded, with `mipmapFilter: 'nearest'` and
   no mip chain. Any minified pixel (distant road, props, the whole corridor)
   sampled a single mip0 texel, so it aliased/shimmered. The source descriptors
   record a full 3–10 level chain; the PoC uploaded one.

Both are fixed in the consumer at upload time, without touching the pinned
producer artefacts:

- every static albedo is uploaded as **`rgba8unorm-srgb`**;
- a **full deterministic mip chain** is derived from the committed mip0 with a
  documented **2×2 box in linear light** kernel (odd edges clamp);
- the sampler is **trilinear** (`mipmapFilter: 'linear'`), which the recovered
  retail sampler record also declares;
- `maxAnisotropy` 8 is requested where the adapter allows it; this adapter
  reports `maxSamplerAnisotropy: 1`, so **1 is applied** and reported (no
  capability is claimed that the device does not have).

`verify_e1_drive.mjs` stays **838/838**, the full suite **31/31**, the checker
**23/23**, and every existing browser capture stays **console 0 / 0 assertions**.
The before/after frames change on **91.1–99.6 %** of the scene pixels (the
colour transfer), the derived chain adds **1,662,260 B (+33.3 %)** per default
packet, and mip generation takes **30.3–33.6 ms** once per packet load (no
per-frame work).

## 1. Diagnosis (exact current path before the change)

| item | value before | where |
| --- | --- | --- |
| texture format | `rgba8unorm` | `packet-consumer.js` `TEXTURE_SAMPLER.format` |
| uploaded mips | **1** (mip0 only) | `createTexture` without `mipLevelCount`; one `writeTexture` |
| mip generation | none | producer embeds only the decoded mip0 RGBA |
| address mode | `repeat` / `repeat` | `TEXTURE_SAMPLER` |
| mag / min filter | `linear` / `linear` | `TEXTURE_SAMPLER` |
| mipmap filter | **`nearest`** | `TEXTURE_SAMPLER.mipmapFilter` |
| anisotropy | **not set** (WebGPU default 1) | `createSampler` |
| implicit LOD | `textureSample(texture, sampler, uv)` with one level | fragment shader |
| sRGB decode | **none** | texture format is `rgba8unorm` |
| output encoding | **`pow(1/2.2)`** | fragment shader return |
| material colour | **not applied** | `base = mix(draw.albedo.rgb, sampled, texParams.x)`; no stored colour is carried |
| UV scale | raw P45/P47/P73a UV0; only the car pack declares `u' = 1-u` | `texParams.y/z`, `uvFlipU/uvFlipV` |

The producer metadata (`geometry.texturePack.sampler`,
`geometry.carTextures.sampler`, `geometry.levelPropTexturePack.sampler`) still
declares the source data as `rgba8unorm` mip0 raw decode. That is correct for the
data: the builders and `build_geometry.mjs` were not changed, so every manifest
file hash, geometry pin, packet hash and layout/ghost pin stays valid. The new
policy is a **consumer GPU sampling policy**, recorded on `TEXTURE_SAMPLER` and
in `window.__e1TextureSampling`.

## 2. sRGB decision and proof

**Decision: decode sRGB.** The consumer uploads `rgba8unorm-srgb`, so the
hardware converts the stored texel to linear before filtering/lighting, and the
fragment shader writes the exact sRGB OETF back to the non-sRGB swap chain.

Evidence, in the order it was checked:

1. **The engine's serialized sampler record says `sRGB=1`.** The committed P52
   roster materials (`_work/car-materials/roster/cars/<slug>/materials.json`)
   carry the exact `SamplerState version1` for **16/16** car resource-block
   albedos: `[0,0,0,1,1,1,0,0,0,1]` = address U/V/W = WRAP, mag/min/mip =
   LINEAR, `maxAnisotropy` 0, `maxMipLevel` 0, `lodBias` 0, **`sRGB` = 1**.
   The same record for the committed level scene shared texture
   `trafficcylinder_diff` is `sRGB=1`
   (`docs/plan/material-binding.md` line 34, decoded by
   `tools/inspect_material_binding.py` from the real serialized object).
2. **The stored values are the sRGB-encoded texel values.** The BC1 decode is
   byte-for-byte the stored texel (the decoder explicitly reports untransformed
   texels; `probes/asset-reader/FORMAT-texture.md`). `sRGB=1` in the sampler is
   exactly the declaration that those bytes are sRGB-encoded.
3. **The project already treats them as sRGB in its committed viewer.**
   `probes/asset-reader/web/mesh-viewer.js` uploads every decoded albedo as
   `rgba8unorm-srgb` (`format:'rgba8unorm-srgb'`).
4. **The visual result matches the source image, not a guessed tint.** The
   committed `bigtruck02_diff` RGBA
   (`_work/e1-drive/level-textures/level.albedo.1074.0.rgba`) is a dark
   red/brown 32×16 texture
   (`_work/e1-drive/texproof/bigtruck02_diff-nearest.png`). Before the change
   the rendered truck was pale pink (double gamma); after it is the stored dark
   red with the white panels still white. No colour value was invented.

**Per-source gap, stated explicitly:** the committed P47/P73a manifests do not
carry the per-source `SamplerState` for the **136 track** and **4 level-prop**
sources (P45/P47 record "No sampler"). All of those are resource-block textures,
and the 16/16 committed **resource-block** car records are the same serialized
`SamplerState version1` with `sRGB=1`; the car pack's **shared** textures are
covered by the committed `trafficcylinder_diff` shared-texture fixture. The
manifest/consumer metadata therefore labels the application as the same sampler
class, not as per-source recovered engine state. If a future task recovers those
per-source records, they can be checked against the same `sRGB` field.

**Output encoding:** the shader now uses the exact sRGB OETF (piecewise
12.92/1.055 curve), not `pow(1/2.2)`, because `pow(1/2.2)` is not the inverse of
the sRGB EOTF the hardware applies. Diagnostic (untextured) colours are authored
in linear-ish space and keep the same treatment; the difference at 0.8 is
0.903 vs 0.906, i.e. sub-1 % on the dialog-free HUD/diagnostic parts.

## 3. Mip chain and sampler parameters

**Kernel** (`buildMipChain`): for each destination texel, the four source texels
of the 2×2 footprint are sampled with clamped edges when a source dimension is
odd; RGB is converted to linear with the standard sRGB EOTF table (256
entries), averaged, and encoded back with the standard sRGB OETF and
round-to-nearest. Alpha
is a straight byte average. The chain continues to 1×1. Nothing is upscaled and
no detail is invented: every level is derived from the committed mip0. Hash:
FNV-1a 32 over all derived levels (level 1..n) per texture, folded with the
texture id into the packet aggregate `0x8942c723` for the default packet.

| pack | textures | mip0 bytes | derived mip bytes | total | fraction | levels | chain hash |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| track | 136 | 439,360 | 146,696 | 586,056 | 0.3339 | 800 | `0xf7538a20` |
| level props | 4 | 8,192 | 2,736 | 10,928 | 0.3340 | 24 | `0x4580a61d` |
| car `corvette-zr1-stock` | 9 | 4,538,368 | 1,512,828 | 6,051,196 | 0.3333 | 83 | `0x37771c88` |
| car `lotus-exige-cup260-stock` | 9 | 4,997,120 | 1,665,748 | 6,662,868 | 0.3333 | 85 | `0x665b0f15` |
| car `dodge-challenger-stock` | 7 | 2,637,824 | 879,316 | 3,517,140 | 0.3333 | 64 | `0xaef6c57a` |
| car `ford-focusrs-stock` | 7 | 3,424,256 | 1,141,460 | 4,565,716 | 0.3333 | 65 | `0x05986f81` |
| car `audi-r8v10-stock` | 8 | 2,580,480 | 860,208 | 3,440,688 | 0.3334 | 71 | `0xe7a78214` |

For the default packet: **149 textures**, **907 levels**, mip0 **4,985,920 B**,
derived **1,662,260 B**, total **6,648,180 B** (`+33.33 %`), aggregate hash
`0x8942c723`.

**Chain length is the source chain length where the source declares it:** the
derived full chain matches the committed descriptor `levels` for **136/136 track**
and **4/4 level-prop** sources (800 and 24 levels in total). For **21/40 car**
sources the descriptor declares 5 levels (the packed source chain) while the
consumer derives the full chain to 1×1 (up to 10 levels) from mip0; those extra
levels are derived, not source data. This is recorded rather than silently
presented as source.

**Sampler descriptor** (`packet-consumer.js`, `createSampler`):

```text
addressModeU: 'repeat'      (proven WRAP for the car records and the fixture)
addressModeV: 'repeat'
magFilter: 'linear'         (proven LINEAR)
minFilter: 'linear'         (proven LINEAR)
mipmapFilter: 'linear'      (proven LINEAR; previously 'nearest')
maxAnisotropy: 8 requested, min(8, device.limits.maxSamplerAnisotropy)
format: rgba8unorm-srgb
```

The recovered `SamplerState` declares `maxAnisotropy 0`; the value 8 is a
**declared rendering-quality choice for this PoC**, not a claim of retail state.
On the capture adapter (`nvidia / blackwell`, D3D11 backend) the adapter and
device `maxSamplerAnisotropy` are both **1**, so the applied value is **1**; the
policy remains 8 for adapters that expose it. `mipLevelCount` is the derived
chain length; `lodMaxClamp` is left at the WebGPU default and is bounded by the
texture's own `mipLevelCount`.

## 4. Material colour / tint

**Not applied.** The packet carries no stored material colour for these draws:
the textured path uses `texParams.x = 1` and `mix()` selects the sampled image
with the draw's diagnostic albedo as the untextured fallback; the diagnostic
colour is not a stored game value. The car's **45 paint-lookup**, **66 light
blend** and **156 `_NO_ALBEDO`** draws stay diagnostic exactly as before, so the
pale-blue body panels and the 4 BC3 cab draws are unchanged and still labelled.
No colour is invented and no runtime paint/light input is guessed.

## 5. Verification

### Commands (this run)

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

# 1. physics/packet/browser-state verifier (uses the unchanged producer)
& $node probes/e1-drive/tools/verify_e1_drive.mjs                 # 838/838

# 2. project gates
& $py   tools/verify_asset_probe.py                               # full, 31/31
& $py   tools/verify_asset_probe.py --skip-build                  # 30/30 (no rebuild step)
& $py   tools/check_e1_poc.py                                     # 23/23

# 3. existing browser captures (all on port 8802)
& $node probes/e1-drive/tools/capture_browser.mjs --port 8802                  # drive 20
& $node probes/e1-drive/tools/capture_browser.mjs --mode sprint --port 8802    # 20
& $node probes/e1-drive/tools/capture_browser.mjs --mode props  --port 8802    # 25
& $node probes/e1-drive/tools/capture_browser.mjs --mode free   --port 8802    # 20
& $node probes/e1-drive/tools/capture_browser.mjs --mode lap    --port 8802    # 20

# 4. texture-quality before/after (identical URL/tick/camera)
#    "before" was captured with the committed HEAD consumer; "after" with this change.
& $node probes/e1-drive/tools/capture_browser.mjs --mode quality --label before --port 8802
& $node probes/e1-drive/tools/capture_browser.mjs --mode quality --label after  --port 8802
```

`ctest` is not installed in this environment (`ctest.exe` is absent from PATH and
the toolchains); the native CTest cases are covered by the full
`verify_asset_probe.py` run, which rebuilt native + WASM and passed 31/31.

### Recorded results

- **`verify_e1_drive.mjs`: 838/838, 0 failures.** All physics state hashes,
  sprint/lap/free results, packet hashes and per-car texture checks are unchanged.
- **`verify_asset_probe.py` (full native + WASM rebuild): 31/31 PASS.**
  `--skip-build`: 30/30 PASS (the 31st step is the rebuild itself).
- **`check_e1_poc.py`: 23/23 PASS.**
- **Existing browser captures:** drive 5 cars × 4 ticks, sprint 20, props 25,
  free 20, lap 20 — every evidence file is
  `verdict: clean-console-and-gates`, **console 0**, **0 assertion failures**.
  The drive mode's `textureUploadBytes` gate still matches the **mip0** sum,
  because that counter keeps its original meaning; the derived bytes are the new
  `textureMipBytes`/`textureTotalBytes` (exposed via
  `window.__e1TextureSampling`).
- **Determinism:** the quality mode repeats the sprint-start frame; the HUD-free
  scene crop is byte-identical (`sceneSha256` unchanged), the scene metrics are
  bit-identical, and `mipChainHash` is `0x8942c723` on both captures. Two full
  after runs produce the same metrics and hash.
- **No per-frame work:** mip generation runs once per `load()`; `renderFrame`
  adds only the sampler state and the sRGB encode in the fragment shader. Draw
  count, uniform writes, geometry uploads and texture count are unchanged.
- **Memory:** +1,662,260 B per default packet (mip0 4,985,920 B → 6,648,180 B,
  +33.33 %). Textures live stays **149** (one packet's set); `releaseGeometry`
  still destroys them on the next load, so the soak bound is unchanged.
- **Performance:** `mipBuildMs` **30.33–33.64 ms** once per packet load for 149
  textures / 5.0 MB mip0 on the capture machine (two runs). No measured
  per-frame cost is claimed; the sampler/aniso state is free at draw time and the
  encode adds a handful of shader instructions.

### Before / after frames

All four frames use the same URL, tick, camera and 1600×900 viewport; `before`
is the committed HEAD consumer (raw `rgba8unorm` mip0, `pow(1/2.2)`), `after`
is this change. The diff is computed over the scene only (HUD boxes masked).

| frame | tick / URL | before | after | changed | metrics (before → after) |
| --- | --- | --- | --- | ---: | --- |
| sprint start | 0, `?script=sprint` | `browser-corvette-zr1-stock-quality-sprint-start-before.png` | `…-after.png` | **91.08 %** | mean lum 0.4472→0.2457; sharpness 0.01085→0.01136 (+4.7 %); noise/edge 0.2875→0.2895 |
| tick-120 truck | 120, `?script=drive` | `…-quality-truck-120-before.png` | `…-after.png` | **92.29 %** | mean lum 0.4317→0.2407; sharpness 0.01249→0.01090 (−12.7 %); noise/edge 0.2537→0.2525 |
| free prop | 82, `?script=sprint&course=free` | `…-quality-free-prop-before.png` | `…-after.png` | **92.04 %** | mean lum 0.4392→0.2351; sharpness 0.01258→0.01222 (−2.9 %); noise/edge 0.2846→0.2841 |
| lap start | 0, `?script=sprint&course=lap` | `…-quality-lap-start-before.png` | `…-after.png` | **99.60 %** | mean lum 0.5275→0.3395; sharpness 0.01478→0.01483 (+0.4 %); noise/edge 0.2843→0.2803 (−1.4 %) |

`sharpness` is the mean absolute 4-neighbour Laplacian of luminance,
`noise/edge` the pixel-scale 3×3 residual divided by the central-difference edge
energy (a scale-free aliasing proxy). The absolute sharpness drop on the truck
frame is the sRGB darkening, not lost detail: `sharpnessPerLuminance` rises from
0.02893 to 0.04529 (+56.6 %) and `noiseToEdgeRatio` falls. The dominant change is
the colour transfer, which is why the changed fraction is ~91–99 %.

Side-by-side crops (same crop box, before on top):
`_work/e1-drive/quality-crops/{sprint-start,truck-120,free-prop,lap-start}-before-after.png`.
The committed dark-red `bigtruck02_diff` reference is
`_work/e1-drive/texproof/bigtruck02_diff-nearest.png`; the after truck is that
colour, the before truck is pale pink.

Screenshot file SHA-256 (full 1600×900 PNG, HUD included — the HUD frame counter
changes between captures, so the deterministic comparison uses the HUD-free
scene crop below):

| frame | before SHA-256 | after SHA-256 |
| --- | --- | --- |
| sprint-start | `3d4cf0a4c4a73ae4c3aabc9c5e26f56ea465df548947e57f34fd278f5d07e59a` | `1ce9da2ed59794df11d6b838df034604e7f1b1b39cdbbe17a4021322b8a0e007` |
| truck-120 | `4f40fb610164ae759d16482e02b6b2dc2207a885bbf807755b28b2e60dd13944` | `9e074c54bf2edee33cf7a1e533fd55d25ebfd8c60587f2a0a71b128f921d96af` |
| free-prop | `6f46057dedaef39d52dd4b75e84237fed6513a5bb320d015605ad417da05b524` | `61465b570f6e96e6a4c4db031bf635fe0d78c98fd4b2fe6ab2b15a739504b433` |
| lap-start | `5504d46e65d598036368b9b1599694e52ec7f934eaa105155703756ec6c97053` | `c7be341536ba76d47a4e3f992c1d9a9661be16007a4e87dccd253c36f80ef007` |

Scene-crop determinism: `repeat.sceneSha256` =
`sha256:e32f03c5ebdb20de6bd22756d5e6887b25b4406dda7b6aa077713172fbecb526`,
identical to the first sprint-start capture; the repeated metrics are
bit-identical and the mip hash is the same.

The after-run full PNG hash is not a determinism gate (the HUD `frames` and
`uniform` counters are live DOM text); the scene crop, the metrics and
`mipChainHash` are. The before/after PNG SHA-256 values above are in
`browser-evidence-quality-before.json` / `-after.json`.

## 6. Limits

1. **Source resolution is unchanged and not upscaled.** The ground uses 16×16
   `mudfloorbaked01_diff` / `grounddirt08_diff`; a 16×16 texel magnified across
   metres is a smooth gradient. No generated detail, super-resolution or
   invented texel is added. Mips and sRGB cannot create detail the source does
   not contain.
2. **Per-source sRGB records for the track/level packs are absent.** The
   decision rests on the 16/16 car `SamplerState` records, the level fixture and
   the committed viewer, as stated in §2; it is not presented as per-source
   recovered engine state.
3. **Anisotropy is not available on this capture adapter** (`maxSamplerAnisotropy`
   1), so the applied value is 1. The policy requests 8 for devices that expose
   it. No visual anisotropy claim is made for this run.
4. **No material colour, paint lookup, light blend, alpha rule or shader stage.**
   The car's 267 non-static draws and the 4 BC3 cab draws keep their labelled
   diagnostic colour. No stored colour was available, so none is applied.
5. **No UV transform.** The raw committed UV0 is used; a texture-transform/scale
   is not recovered, so a stretched-looking source stays stretched rather than
   being rescaled by a guessed factor.
6. **No normals.** The pipeline still lights with screen-space derivative
   normals; no vertex-normal array is invented, so the shading remains faceted.
7. **Metrics are static-frame diagnostics** of a headless 1600×900 capture, not
   a display, retail or GPU-performance claim. The `sharpness`/`noise` numbers
   include the sRGB luminance change; the normalised columns are provided for
   that reason.
8. **No full-game claim.** One level, one car at a time, one drive. No other
   level, LOD, streaming, shadow, post-process or material system is claimed.

## 7. Evidence paths

| path | content |
| --- | --- |
| `probes/e1-drive/web/packet-consumer.js` | sRGB upload, derived mip chain, trilinear/aniso sampler, exact sRGB output, `window.__e1TextureSampling` |
| `probes/e1-drive/tools/capture_browser.mjs` | `--mode quality` + `--label before/after`, PNG decoder, scene-only sharpness/noise metrics, repeat determinism |
| `_work/e1-drive/browser-<slug>-quality-<frame>-{before,after}.png` | 4 before + 4 after frames |
| `_work/e1-drive/browser-evidence-quality-{before,after}.json` | console, assertions, sampling policy, metrics, diffs, hashes |
| `_work/e1-drive/quality-crops/*-before-after.png` | side-by-side visual comparison |
| `_work/e1-drive/texproof/bigtruck02_diff-nearest.png` | committed source texture (dark red), proving the after colour |
| `_work/e1-drive/mip-stats.json` | per-pack mip bytes/levels/hashes, source manifest hashes |
| `_work/logs/e1-drive/verify-p75.log` | 838/838 verifier |
| `_work/logs/e1-drive/suite-p75-full.log` | 31/31 full suite |
| `_work/logs/e1-drive/check-e1-poc-p75.log` | 23/23 checker |
| `_work/logs/e1-drive/edge-quality-{before,after}-run.log` | quality captures |
| `_work/logs/e1-drive/edge-{drive,sprint,props,free,lap}-p75.log` | existing captures, console 0 |

Handoff/status/task-card updates are left to the main agent because this
sub-agent's file ownership excludes `docs/handoff/**`, `docs/STATUS.md` and the
task cards.

**No source texture was invented, upscaled or recoloured; no physics, collision,
UV, layout or packet value changed.**
