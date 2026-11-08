# Map texture coverage — decoder bounds, BC3 alpha, runtime references, decal sources

**Date:** 8 November 2026
**Owner:** TEX1 (sub-agent)
**Scope:** new `probes/textures/**`, `_work/textures/**`,
`_work/logs/textures/**` and this document. No change to `probes/e1-drive`,
`probes/map-slice`, `probes/asset-reader`, `tools/`, `upstream/` or `game-data/`;
no commit. **Data and decode only: no renderer, GPU, browser, playable-game or
full-game claim, and no invented texture or colour.** The DECAL1 agent owns the
decal *pass*; this study owns the decal *textures*.

---

## 0. Result

| item | `usa_amboy` | `spa_barcelona_gracia` |
|---|---:|---:|
| direct draws / triangles | 1,606 / 348,948 | 3,580 / 550,632 |
| **bindable static albedo + UV0 today** | **1,201 (74.8 %) / 269,300 tri (77.2 %)** | **2,627 (73.4 %) / 365,451 tri (66.4 %)** |
| **+ decoder-size fix** | **+49 / +18,998 tri** (1 source reclassifies to alpha) | **+1 / +4,464 tri** (4 sources reclassify to alpha) |
| **+ declared alpha rule (test only)** | **+18 / +3,654 tri** | **+399 / +63,548 tri** |
| **+ alpha blend pass (needs sorting)** | 0 | **+31 / +3,698 tri** |
| decal `Racification*` draws (separate pass) | 334 / 56,860 tri | 518 / 113,461 tri |
| runtime-only draws (undecodable) | 4 / 136 tri | 4 / 10 tri |
| all identity-resolved draws bindable after both fixes | **1,268 (79.0 %) / 291,952 tri (83.7 %)** | **3,058 (85.4 %) / 437,161 tri (79.4 %)** |
| sources decoded by this probe | **195 / 195** (was 189) | **846 / 846** (was 841) |
| unique mip0 bytes now → all | 2,654,272 → **19,958,848** | 3,247,360 → **20,380,928** |
| derived-chain bytes now → all | 3,539,772 → **26,612,600** | 4,330,232 → **27,175,184** |
| verifier | **22,872 checks, 0 failures, PASS** | same run |

**Verdicts at a glance**

| blocker | counts (Amboy / Gracia) | decoder-limited? | data-limited? | resolution |
|---|---|---|---|---|
| decoder size | 50 / 5 draws | **yes** — the format decodes; the validator rejects >512 px and >10 mips | no — the blobs are complete | lift the two validator bounds; 49/50 and 1/5 bind immediately, the rest move to the alpha class |
| BC3 alpha | 17 / 426 draws | **no** — BC3 decodes and is byte-verified | **yes for the per-draw rule** — the alpha *semantics* (test/blend/coverage), not the pixels, are missing | 18 / 430 sources decoded and quantified by shape; a source-cited 0.5 alpha test covers the cutout sets (18 / 399 draws), blending needs a transparent pass (0 / 31 draws) |
| runtime-only | 4 / 4 draws | no | **yes** — `g_tAlbedo` is a type-9 `DATA_INDEX` with `listIndex=3` | cannot be decoded from the package; no static slot exists |
| decal layer | 334 / 518 draws | **no** | **no** — every `g_tTexture` decodes (6 sources, 19,520 / 12,352 B) | a pass/state problem for DECAL1, not a texture problem |

---

## 1. Method and provenance

1. Read the committed per-draw manifests
   `_work/map-slice/{amboy,gracia}-textures/bindings.json` (material row,
   `g_tAlbedo` parameter, texture source, UV0 hash, typed status) and the
   `raw/*.raw` blobs those passes reconstructed from `Level.levelstream` /
   `level.levelrender`. Every blob is re-hashed against the manifest before use.
2. Decode every blob with `probes/textures/bc_decode.py`, a dependency-free
   reimplementation of the committed decoder's texel algebra with the two
   *validator* bounds lifted (`probes/asset-reader/FORMAT-texture.md` §Accepted
   exact layout: "dimensions 1..512 … mip count … at most 10").
3. For the decal layer only, extract the six `g_tTexture` blobs per map from the
   retail archives with the already-proven record/texel parser
   (`amboy_texture_bindings.TextureArchive`), then decode them the same way.
4. For the runtime draws, re-run the committed node-chunk parser and print the
   exact `g_tAlbedo` material element (type, count, runtime list refs).
5. Join the decode with the per-draw status, assert the arithmetic, and pin the
   reader's own identity-resolved count as an independent anchor.
6. Verify: re-read + re-decode + re-hash every source, cross-check the committed
   native decoder (in bounds) and Pillow's DDS decoder (over the bound), and
   rebuild the whole decode twice.

No threshold, dimension, colour or alpha value is invented: the alpha-test
threshold is the one the shipped DX11 prepass compiles in (§4.3), and every byte
is the retail mip0.

---

## 2. Blocker 1 — decoder size (50 Amboy / 5 Gracia)

### 2.1 Exact cause

`probes/asset-reader/src/texture_reader.cpp` `inspect_payload()` rejects a
descriptor when

```cpp
if(width==0 || height==0 || width>512 || height>512 || depth!=1 ||
   type!=3 || levels==0 || levels>10)
    throw std::runtime_error("Only 2D PC textures up to 512x512 are supported");
```

`FORMAT-texture.md` states the same as an accepted-input bound. It is a
**validator bound, not a format property**: the descriptor is 28 bytes and the
mip chain is `Σ max(1,⌈w/2ᵐ/4⌉)·max(1,⌈h/2ᵐ/4⌉)·blockBytes` for every level.
For all eleven sources that sum equals `blobBytes − 28` **exactly**, and the
mip0 texels are ordinary BC1/BC3 blocks. Two bounds are hit: the dimension
(1024–2048 px, the first failing condition in the `||` chain) and the sibling
level cap (`levels` is 11–12; the natural count for 2048 is 12). Both must be
lifted together or a `2048×1024, 12 mip` source would still fail after a
dimension-only change.

The 8-MiB payload bound (`texture_raw_inspect`) is **not** hit: the largest blob
is 1,398,160 B.

### 2.2 Correct decode path and the limit used here

* same `descriptor + mip chain` layout, same BC1/BC3 texel rules, mip0 only;
* no split, tiling, resize or resample — the image is a single mip0;
* limit raised to **8192 px** and **natural mip count** (≤16), still bounded by
  the 8-MiB payload;
* the decoded RGBA of every in-bound source is **byte-identical** to the
  committed C++ decoder (1030/1030 sources; §8).

The 11 sources are 1024–2048 px and 11–12 mips, i.e. well inside the lifted
bound.

### 2.3 What the lift unlocks

| source | name | size | format | mips | blob B | mip0 RGBA B | alpha | draws | tri | verdict |
|---|---|---|---|---:|---:|---:|---|---:|---:|---|
| `amboy.albedo.518.0` | `farground02_diff` | 1024×128 | BC1 | 11 | 87,432 | 524,288 | 255..255 | 1 | 17 | **bindable now** |
| `amboy.shared.13` | `barrelbase02_diff` | 1024×256 | BC1 | 11 | 174,792 | 1,048,576 | 255..255 | 31 | 4,885 | **bindable now** |
| `amboy.shared.15` | `barrelbase03_diff` | 2048×1024 | BC1 | 12 | 1,398,120 | 8,388,608 | 255..255 | 8 | 1,102 | **bindable now** |
| `amboy.shared.17` | `gate01_diff` | 1024×512 | BC1 | 11 | 349,544 | 2,097,152 | 255..255 | 2 | 16 | **bindable now** |
| `amboy.shared.24` | `oilderek01_diff` | 1024×1024 | BC1 | 11 | 699,064 | 4,194,304 | 255..255 | 7 | 12,978 | **bindable now** |
| `amboy.albedo.546.0` | `vista01_diff` | 2048×128 | **BC3** | 12 | 349,712 | 1,048,576 | 0..255 (254 values) | 1 | 6 | **alpha rule** |
| `gracia.shared.2` | `garage_pump_new_diff` | 1024×1024 | BC1 | 11 | 699,064 | 4,194,304 | 255..255 | 1 | 4,464 | **bindable now** |
| `gracia.albedo.916.0` | `vista_d_pt_diff` | 1024×512 | BC3 | 11 | 699,088 | 2,097,152 | 0..255 (246) | 1 | 87 | **alpha rule** |
| `gracia.albedo.917.0` | `vista_b2_pt_diff` | 2048×512 | BC3 | 12 | 1,398,160 | 4,194,304 | 0..255 (254) | 1 | 54 | **alpha rule** |
| `gracia.albedo.919.0` | `vista_a2_pt_diff` | 2048×512 | BC3 | 12 | 1,398,160 | 4,194,304 | 0..255 (146) | 1 | 12 | **alpha rule** |
| `gracia.albedo.921.0` | `vista_c_pt_diff` | 1024×512 | BC3 | 11 | 699,088 | 2,097,152 | 0..255 (248) | 1 | 148 | **alpha rule** |

**Amboy:** 5 opaque BC1 images unlock **49 draws / 18,998 tri**; the BC3
`vista01_diff` (1 draw / 6 tri) does not stay "size-blocked", it becomes an
alpha case. **Gracia:** `garage_pump_new_diff` unlocks **1 draw / 4,464 tri**;
the four `vista_*_pt_diff` mattes (301 tri) become alpha cases.

The six BC1 images (5 Amboy + 1 Gracia) are opaque in the strict sense: **no**
texel has alpha ≠ 255 and no BC1 three-colour (transparent-index) block occurs,
so binding them as `rgba8unorm(-srgb)` opaque is safe.

**Cost:** +16,252,928 B mip0 (Amboy) and +4,194,304 B (Gracia). One image,
`barrelbase03_diff` (2048×1024), is 8,388,608 B mip0 / 11,184,808 B with the
consumer's derived chain — 52 % of the Amboy addition.

---

## 3. Blocker 4 — decal layer (334 Amboy / 518 Gracia)

These draws are the `Racification_LN` / `RacificationDLayer_LN` additive layer.
Their material stack exposes `g_tTexture`, not `g_tAlbedo`, so they are **not**
base albedo. This study quantifies only their textures (DECAL1 owns the pass).

| map | sources | mip0 B | chain B | draws | tri | opaque sources |
|---|---:|---:|---:|---:|---:|---:|
| Amboy | 6 | 19,520 | 26,056 | **334** | **56,860** | 4 / 6 |
| Gracia | 6 | 12,352 | 16,480 | **518** | **113,461** | 5 / 6 |

Per source:

| map | name | size | format | mip0 B | alpha | draws | tri |
|---|---|---|---|---:|---|---:|---:|
| Amboy | `whiteline_diff` | 4×4 | BC1 | 64 | 255..255 | 257 | 46,768 |
| Amboy | `wackymagicarmco_diff` | 128×16 | BC1 | 8,192 | 255..255 | 33 | 4,108 |
| Amboy | `blackline_diff` | 16×16 | BC1 | 1,024 | 255..255 | 39 | 5,108 |
| Amboy | `startfinisharch_diff` | 16×16 | **BC3** | 1,024 | 61..173 | 2 | 648 |
| Amboy | `startfinishbanner_diff` | 16×16 | BC1 | 1,024 | 255..255 | 2 | 200 |
| Amboy | `wackymagicarmcosortingfix_diff` | 128×16 | **BC3** | 8,192 | 254..255 | 1 | 28 |
| Gracia | `whiteline_diff` | 4×4 | BC1 | 64 | 255..255 | 437 | 103,097 |
| Gracia | `blackline_diff` | 16×16 | BC1 | 1,024 | 255..255 | 38 | 4,917 |
| Gracia | `wackymagicarmco_diff` | 128×16 | BC1 | 8,192 | 255..255 | 37 | 4,490 |
| Gracia | `startfinishbanner_diff` | 16×16 | BC1 | 1,024 | 255..255 | 2 | 200 |
| Gracia | `startfinisharch_diff` | 16×16 | **BC3** | 1,024 | 61..173 | 2 | 648 |
| Gracia | `checkerwithline_diff` | 16×16 | BC1 | 1,024 | 255..255 | 2 | 109 |

**Verdict: not texture-limited at all.** All 334 / 518 draws resolve a static
`g_tTexture` that decodes today with the committed bounds; the total texture
payload is 19,520 / 12,352 B. What is missing is the pass: `Racification.fx`
pass `p0` declares `AlphaBlendEnable = TRUE`, `AlphaTestEnable = TRUE`,
`SrcBlend = One`, `DestBlend = InvSrcAlpha`, `ZWriteEnable = FALSE`
(`Shaders/Racification/Racification.fx` lines 332–339 and 350–357) plus the
layer colour `g_vColour` `[1, 1, 0.7, 1]`. Binding these as opaque albedo would
be a semantic error. The only genuinely non-trivial alpha among them is
`startfinisharch_diff` (BC3, 61..173), which is a translucent arch decal.

---

## 4. Blocker 2 — BC3 alpha (17 Amboy / 426 Gracia)

### 4.1 Decode is not the blocker

BC3/DXT5 is fully supported by the committed decoder and by this one; the 17 /
426 draws' sources are **already decoded** by the committed manifest (3 Amboy
and 102 Gracia sources) and are re-verified here byte for byte. The blocker is
that the alpha channel is *not opaque* and **no per-draw alpha rule is applied
by the consumer** (`rgba8unorm(-srgb)`, one opaque pipeline in
`packet-consumer.js`).

### 4.2 Quantified alpha, by the rule a renderer needs

`shape` is computed from the decoded alpha only, with stated thresholds:

* `cutout` — `zeroFraction ≥ 1 %`: the alpha carves a shape out of a background,
  so a 0.5 alpha test reproduces it;
* `translucent-no-background` — no fully transparent texel and min < 128: the
  whole surface is see-through (net, glass, canopy, plastic sheet) → blending;
* `translucent-uniform` — no fully transparent texel and min ≥ 128 (none here).

Including the four BC3 images the size fix reclassifies:

| map | shape | sources | draws | tri | mip0 B | chain B |
|---|---|---:|---:|---:|---:|---:|
| Amboy | cutout | 4 | **18** | **3,654** | 1,051,648 | 1,402,232 |
| Gracia | cutout | 89 | **399** | **63,548** | 12,915,712 | 17,221,152 |
| Gracia | translucent-no-background | 17 | **31** | **3,698** | 23,552 | 31,396 |

* Amboy cutout set (3 imposters/bushes + `vista01_diff`): a 0.5 test keeps
  4.7 % … 56.0 % of texels (median 21.7 %) — the rest is atlas background and
  antialiased edges. The three 16×16 atlases are `crowdatlas_imposters_0_0`
  (9 draws), `drydesertbush01_diff` (4), `drydesertbush02_diff` (4).
* Gracia cutout set: 89 sources, a 0.5 test keeps 0.0 % … 86.7 % (median
  37.9 %). It includes line/railing/sign atlases (`rg_dashwhiteline_diff`,
  `genericrailings_*`, `rg_arrow_*`) whose interior is deliberately thin, and the
  four `vista_*_pt_diff` mattes (18–54 % of texels below 0.5).
* Gracia no-background set (17 sources, 31 draws): `flatsc_net01_diff`,
  `sw_glass_blackbar_alpha_diff`, `plasticsheetbarrier_alpha_diff`,
  `palace_b_ornateblack01_diff`, `b51_rotundaarch_aplha_diff`, the three
  `generic_canopy*plain_diff` canopies, the manhole covers, the brown "opaque
  alpha" variants, etc. These have no transparent background at all, so an
  alpha test would either keep everything or erode a uniform veil; they need a
  blend pass.

### 4.3 What the shader source declares (and what it does not)

| evidence | what it proves |
|---|---|
| `Shaders/Common/Pixel.h` lines 89–94: under `BLUR_DX11`, every prepass path ends in `clip(output.m_vColour.a - 0.5h)`; the comment records it as retail-recovered ("Every shipped PC prepass built from this path ends in texkill(alpha * lodfade - 0.5)"). | an **alpha test at 0.5** is shipped behaviour for the depth prepass of the material families used here |
| `Pixel.h` lines 24–30: `output.rgb *= output.a` unless `ALPHA_TO_COVERAGE`/`ALPHA_LUMINANCE`; `ENABLE_ALPHA_ENHANCE` does `a = saturate(a * 1.10)` | the main pass writes **premultiplied** colour; cutouts need the test, sheets need blending |
| `Shaders/Foliage.fx` lines 4–6: `ENABLE_ALPHA_ENHANCE`, `ENABLE_MIPMAP_ALPHA_ENHANCE`, `ALPHA_TO_COVERAGE` | the 2 `Foliage_LN_NL` Gracia draws have a **declared alpha-to-coverage** rule (`saturate(a·1.10)` and coverage), not a plain test |
| `scene_reader.cpp` line 452: the per-primitive list of 24-byte rows is parsed as `r.ar(); r.skip(24);` | the **per-draw render state (blend/alpha-test flags) is not exported** by the committed reader; its 24-byte layout is not documented, so it is not guessed here |

Consequently: the pixels are **decoder-resolved**; the per-draw *rule* is
**state-limited**. The honest split is (a) apply the prepass 0.5 test to the
cutout sets — source-cited and safe against the atlas background; (b) do not
invent a blend mode for the 31 Gracia sheets; keep them diagnostic until the
24-byte render-state rows or a transparent pass are decoded. The four
`vista_*_pt_diff` mattes are statistically cutouts but are large backdrop
surfaces: treat them as "test, screenshot-gated", not as proven.

---

## 5. Blocker 3 — runtime-only albedo (4 Amboy / 4 Gracia)

| map | section | draw | primitive | effect | row | `g_tAlbedo` type | runtime refs | tri |
|---|---|---:|---:|---|---:|---:|---|---:|
| Amboy | `g143-n284` | 8 | 80 | `Advert_LN_NV` | 73 | **9** | 6:3 | 34 |
| Amboy | `g143-n284` | 9 | 81 | `Advert_LN_NV` | 75 | **9** | 7:3 | 34 |
| Amboy | `g261-n262` | 11 | 163 | `Advert_LN_NV` | 85 | **9** | 3:3 | 34 |
| Amboy | `g261-n262` | 12 | 164 | `Advert_LN_NV` | 87 | **9** | 4:3 | 34 |
| Gracia | `g73-n310` | 85 | 204 | `Advert_LN_NV` | 189 | **9** | 1:3 | 4 |
| Gracia | `g73-n310` | 86 | 205 | `Advert_LN_NV` | 191 | **9** | 2:3 | 2 |
| Gracia | `g86-n220` | 42 | 149 | `Advert_LN_NV` | 107 | **9** | 0:3 | 2 |
| Gracia | `g165-n344` | 71 | 263 | `Advert_LN_NV` | 213 | **9** | 4:3 | 2 |

Every recorded material row serialises `g_tAlbedo` as material element **type 9,
count 1**, whose value is `{index, listIndex = 3}`. Type 9 is `DATA_INDEX`: a
reference into a material list that the runtime rebuilds. The committed reader
says the same in code: `scene_reader.cpp` line 262 maps type 9 to
`MaterialActionKind::Runtime`, and `apply_material()` line 514 rejects
`ref.list != 0` with "Dynamic material list is rebuilt at runtime; albedo value
unavailable".

**Verdict: data-limited.** There is no static texture slot to decode — no source
resolves for these draws (the parameter is consumed as a runtime value before
any slot lookup), and the referenced list index is 3 (non-zero = runtime).
`Advert.fx` samples `g_tAlbedo` as an ordinary texture, so the advert image is
composed at runtime outside the package. These 8 draws cannot be unblocked by any
decoder change and are not counted as an opportunity. The `vista` backdrops
(1.05 MB Amboy / 12.58 MB Gracia) are a different case — they have static slots —
and are counted under §4.

---

## 6. Coverage per map

### 6.1 Draws and triangles

| map | bindable now | + size | + alpha test | + blend | decal (separate) | runtime (never) | all identity-resolved |
|---|---:|---:|---:|---:|---:|---:|---:|
| Amboy draws | 1,201 | +49 | +18 | 0 | 334 | 4 | **1,268 / 1,606 (79.0 %)** |
| Amboy tri | 269,300 | +18,998 | +3,654 | 0 | 56,860 | 136 | **291,952 / 348,948 (83.7 %)** |
| Gracia draws | 2,627 | +1 | +399 | +31 | 518 | 4 | **3,058 / 3,580 (85.4 %)** |
| Gracia tri | 365,451 | +4,464 | +63,548 | +3,698 | 113,461 | 10 | **437,161 / 550,632 (79.4 %)** |

If only the size fix is integrated: Amboy 1,250 (77.8 %) / 288,298 tri
(82.6 %); Gracia 2,628 (73.4 %) / 369,915 tri (67.2 %).
If size + alpha test (no blend): Amboy **1,268** (79.0 %) / 291,952 tri;
Gracia **3,027** (84.6 %) / 433,463 tri (78.7 %).

**Arithmetic anchor.** `bindable + size + alpha` equals exactly the reader's own
`static-albedo-identity-resolved` count from the READ1 export: 1,268 Amboy and
3,058 Gracia. The remaining 338 / 522 identity-blocked draws are exactly the
334 / 518 decal draws plus the 4 / 4 runtime draws. This is the proof that no
draw is lost between identity resolution and bindability, and it is re-derived
independently by the verifier.

### 6.2 Where the gain lands (largest sections)

Amboy (size fix, the only change):

| section | draws | tri | bindable | size-unlocked | unlocked tri |
|---|---:|---:|---:|---:|---:|
| `g92-n262` | 55 | 7,856 | 45 | 10 | 1,721 |
| `g98-n236` | 36 | 9,758 | 29 | 7 | 3,167 |
| `g72-n290` | 29 | 9,594 | 24 | 5 | 2,472 |
| `g112-n236` | 41 | 9,040 | 36 | 5 | 1,000 |
| `g139-n278` | 33 | 6,718 | 28 | 5 | 416 |

Gracia: `g39-n344` is the only size section (+1 draw / 4,464 tri, 38 of its 39
draws were already bindable). The alpha gain is spread over the vegetation and
decoration corridors; `g45-n290` (39 draws) is entirely alpha-blocked.

---

## 7. Byte totals and GPU budget

| map | now (unique mip0) | size fix mip0 / chain | alpha mip0 / chain | decal mip0 | all mip0 / chain (unique) |
|---|---:|---:|---:|---:|---:|
| Amboy | 2,654,272 | 16,252,928 / 21,670,596 | 1,051,648 / 1,402,232 | 19,520 | **19,958,848 / 26,612,600** |
| Gracia | 3,247,360 | 4,194,304 / 5,592,404 | 12,939,264 / 17,252,548 | 12,352 | **20,380,928 / 27,175,184** |

* "chain" is the consumer's derived `mipLevels: full-chain-derived-from-mip0`
  kernel (`packet-consumer.js` `buildMipChain`), not a decoded source chain.
* Amboy's bindable set is 186 sources / 179 unique payloads (2,672,704 referenced
  → 2,654,272 unique; 7 duplicate pairs); Gracia's is 739 / 734 (3,253,504 →
  3,247,360, the exact render-package number, 5 duplicate pairs).
* Newly decoded pixels: **Amboy +17,301,504 B** (6 sources) and
  **Gracia +16,777,216 B** (5 sources); total decoded sources 195 / 846.
* The four `vista_*_pt_diff` + `vista01_diff` mattes alone are 12,582,912 B mip0
  in Gracia and 1,048,576 B in Amboy; `barrelbase03_diff` is 8,388,608 B.
* Nothing is uploaded: these are CPU RGBA byte counts. WebGPU's default
  `maxTextureDimension2D` is 8192, so 2048 px needs no feature.

---

## 8. Verification

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py probes/textures/extract.py --level usa_amboy
& $py probes/textures/extract.py --level spa_barcelona_gracia
& $py probes/textures/coverage.py
& $py probes/textures/verify.py
& $py probes/textures/report.py
```

`_work/textures/verify.json` — **PASS, 22,872 checks, 0 failures**:

| gate | result |
|---|---|
| source re-decode | 195 + 846 + 12 decal sources re-read, re-parsed, re-decoded, re-hashed; dimensions, format code, level count, mip-chain byte sum, RGBA length, RGBA SHA-256, RGBA FNV-1a 64 and 6 alpha fields each |
| committed decoder, in bounds | 1,030 in-bound RGBA hashes equal the manifest (which the native decoder produced); a deterministic 80-source sample per map re-decoded live with `texture_inspect.exe --raw` and matches byte for byte |
| extended sources | all 11 rejected live by the native binary with `Only 2D PC textures up to 512x512 are supported`; Pillow 13.0.0 DDS decode agrees — BC1 **byte-identical** (6/6), BC3 RGB **byte-identical** (5/5) with alpha `≤ 1/255` (the documented rounding-policy difference, `FORMAT-texture.md` §Real fixtures) |
| coverage arithmetic | status totals, bindable byte totals, unique byte totals and the identity anchor re-derived from the committed manifest |
| runtime proof | 8/8 draws: `g_tAlbedo` type 9, `listIndex` 3 |
| determinism | `extract.py` rebuilt both maps into a scratch directory: decode manifests byte-identical after normalising only the output path, and all 195 + 846 RGBA files re-hash identically |

Two decode-manifest hashes (path-normalised) are recorded in `verify.json`
(`8e22b19e…` Amboy, `753e9931…` Gracia).

---

## 9. Integration contract (for the e1 producer/consumer)

Nothing below was changed here; this is the delta the owning tasks must apply.

### 9.1 Producer — `probes/e1-drive/tools/build_track_textures.py`

1. **Decode path.** A map source over the committed bound must be decoded by the
   lifted-bound decoder (a rebuilt `texture_reader` or the standalone
   `probes/textures/bc_decode.py`) and pinned by `rgbaSha256`; the consumer
   already re-hashes `rgbaPath` against `rgbaSha256` in `build_geometry.mjs`
   (lines 1224–1232), so no new trust is needed. Do **not** substitute a 1×1
   placeholder.
2. **New texture records.** Add the 5 Amboy + 1 Gracia opaque records unchanged:
   `{id, block, index, name, textureHash, width, height, levels, format,
   formatName, payloadBytes, rgbaBytes, rgbaSha256, rgbaFnv1a64, rgbaPath}` — the
   fields are identical to what the panel already emits.
3. **Per-draw binding.** Set `textureId` for the 49 / 1 size-unlocked draws and
   the 18 / 430 alpha draws. The draw ranges, UV0 hashes and texture ids are the
   committed ones — no new geometry or UV work.
4. **Declared state (new fields).** Per draw: `alphaTest: {enabled, threshold:
   0.5}` for the cutout sets (18 Amboy / 399 Gracia, source: `Pixel.h:93`) and
   `alphaBlend: {enabled, src:'one', dst:'one-minus-src-alpha',
   depthWrite:false}` for the 31 Gracia sheets — premultiplied alpha, matching
   `Pixel.h`'s `rgb *= a`. This is a **declared consumer policy**, not recovered
   retail state; label it as such. `Foliage_LN_NL` (2 draws) additionally declares
   `alphaToCoverage: {enhance: 1.10}` from `Foliage.fx:4-6`.
5. **Manifest coverage block.** Record `texturesUnlockedByDecoder`,
   `drawsUnlockedByDecoder`, `alphaCutoutDraws`, `alphaBlendDraws`,
   `runtimeDraws`, `decalDraws` so a packet can be audited without this study.

### 9.2 Producer — `probes/e1-drive/tools/build_geometry.mjs`

* No structural change: it already validates `bytes.length === width*height*4`
  and the RGBA hash, copies `textureId` per draw and copies the texture records.
* Add the pass-through of `alphaTest` / `alphaBlend` / `alphaToCoverage` into the
  packet draw and the packet `texturePack` metadata.
* Packet size delta: base64 of the new RGBA. The Amboy size fix adds
  16,252,928 B of mip0 RGBA (21,670,596 B if the full derived chain is shipped);
  the Gracia size fix adds 4,194,304 B (5,592,404 B of chain). If packet size is
  a constraint, ship the mip0 and let the consumer derive the chain (it already
  does).

### 9.3 Consumer — `probes/e1-drive/web/packet-consumer.js`

1. **No size work.** 2048 px is inside the default WebGPU limit; `buildMipChain`
   already loops to 1×1 for any size.
2. **Alpha test.** Add one pipeline variant (or a `discard`) that samples
   `albedoTexture` and discards when `sampled.a < threshold`. This changes no
   other draw: untextured draws keep `texParams.x = 0`.
3. **Blend.** A second variant with premultiplied alpha (`one` /
   `one-minus-src-alpha`, matching `Pixel.h`'s `rgb *= a`),
   `depthWriteEnabled:false`, and back-to-front ordering by the existing distance
   sort. Until it exists, the 31 Gracia sheet draws stay diagnostic with
   `bindingStatus:"alpha-blend-required"`. Do not approximate them with a test.
4. **Foliage.** Alpha-to-coverage requires an MSAA target; if the pass has no
   MSAA, keep the 2 draws diagnostic rather than silently using a test.

### 9.4 Expected draw delta

| map | today | size fix | + alpha test | + blend | decal pass (DECAL1) |
|---|---:|---:|---:|---:|---:|
| Amboy | 1,201 | 1,250 | **1,268** | 1,268 | +334 |
| Gracia | 2,627 | 2,628 | **3,027** | **3,058** | +518 |

### 9.5 What must stay diagnostic

* the 8 `Advert_LN_NV` runtime draws — no static albedo exists;
* the 31 Gracia `translucent-no-background` draws until a blend pass exists;
* the 4 `vista_*_pt_diff` + `vista01_diff` mattes until the screenshot gate
  confirms the 0.5 test on a backdrop;
* every draw whose UV0 hash is absent or mismatched (none in this study);
* all material features beyond static albedo: `g_tMaterial`, material colour,
  the per-draw render state, shader stages, sampler wrap/filter, source mip
  chains and sRGB interpretation.

---

## 10. Hashes

Inputs (current files; read-only):

| input | bytes | SHA-256 |
|---|---:|---|
| `_work/map-slice/amboy-textures/bindings.json` | 1,906,505 | `10b3d30f4dab6d71c1367c85fa7c4c4aeafacadf5fd19d8eabe8fb5267bb5e6a` |
| `_work/map-slice/gracia-textures/bindings.json` | 4,568,799 | `14ea1b636535834bd7ac1fa72803c5c66bfa24a911c06413f198d5706a111fa6` |
| `game-data/.../usa_amboy/Level.levelrender` | 11,263,032 | `796c9289e224a6c15aff75b929eca875ef03d4d91b015f67aba704de1f9a3ea7` |
| `game-data/.../usa_amboy/Level.levelstream` | 331,728,896 | `09eb81f42879e1608fab3753de0bbbbb23c549c5098133ac1c31e40e0876c9e8` |
| `game-data/.../spa_barcelona_gracia/Level.levelrender` | 9,095,776 | `4eb86ff62ecdb4bf0804e19da4641a1b9d3e8e45b46bc76e5fe1204370d95176` |
| `game-data/.../spa_barcelona_gracia/Level.levelstream` | 489,828,352 | `384697f6d8ff889a726c5d8ba2c8a84a6e209835ed34ecac3dc5980b9a7fa341` |
| `_work/build/asset-reader-native/Release/texture_inspect.exe` | 57,856 | `745e80981b180bf9e9c3d7bf92597636cb919a28ce013ebf531495aec15e2427` |

The two `bindings.json` hashes differ from the pins in the MAP3/MAP5 documents
(`0b07f52b…` / `d3086493…`, same byte counts). Those packages were refreshed
after the documents were written: Amboy by MAP4 (`map-slice-amboy-textures.md`
§11.5) and Gracia by the module-pin follow-up (`map-slice-gracia.md` §13), which
rewrote the `inputs.slice.sha256` field. The per-draw content still reproduces
the documented status counts, draw counts and byte totals exactly (asserted by
the verifier), so the difference is the recorded input pin, not a re-resolution.

Artifacts (generated, `_work/` is not committed):

| path | bytes | SHA-256 |
|---|---:|---|
| `_work/textures/amboy/decode.json` | 256,753 | `ac085599b9342d7c1a886c82c5a6113f3b69545f623a65ce57965b3bb39f5943` |
| `_work/textures/gracia/decode.json` | 1,175,293 | `901168a33a6bb0d4615a0b47ce64556a46fac6c758619bbdc46d865ea4d49f28` |
| `_work/textures/coverage.json` | 126,793 | `bea2bb19597c1f489325e35f8d3fa3140343d5d01f93d823034414c06ed6601c` |
| `_work/textures/verify.json` | 1,400 | `15d1d9d5498f9b6df074541ceffedaaa0155050793d85b1806c8bf0091c6c969` |
| `_work/textures/{amboy,gracia}/rgba/*.rgba` | 195 / 846 files | per-file SHA-256 in `decode.json` |
| `_work/textures/{amboy,gracia}/decal-rgba/*.rgba` | 6 / 6 files | per-file SHA-256 in `decode.json` |
| `_work/logs/textures/coverage.log`, `verify.log` | 1,050 / 804 | `c7b9f869…`, `5b381319…` |

Tools:

| path | SHA-256 |
|---|---|
| `probes/textures/bc_decode.py` | `85e0289f69fbad593e04dcdc6373977d806d2f4b7e379b288e3f681d83895d40` |
| `probes/textures/extract.py` | `e4ea5d30f03c1da4c8777c1c6c98fb67ce68b482e01d83e25fa1c5eecf0a366e` |
| `probes/textures/coverage.py` | `171c9484896a65c7760be9776c565981a566b02f95fd0d2b6160293b6050f307` |
| `probes/textures/verify.py` | `9560fe87c3de9d792f35a3265a395e2f9b02a5a52df5cd06e529b21b667921fe` |
| `probes/textures/report.py` | `1cd4bcec92343295d6913f28318187336f4d4c503b3996f44646b3cf577f5b54` |

---

## 11. Limits

1. **Decode and data only.** No pixel was uploaded, sampled or rendered; no GPU,
   browser, playable-slice or full-game claim. A screenshot with a clean console
   is still required before calling any newly bound draw visually correct.
2. **The lift is a validator change, not a format discovery.** The 11 sources
   were always decodable in principle; the committed decoder's bounds are the
   only reason they were not decoded. This study does not modify the committed
   reader, so the committed binary still rejects them.
3. **Alpha rules are declared, not recovered.** The 0.5 test is the shipped
   DX11 prepass rule (`Pixel.h:93`); the main-pass blend state and the per-draw
   alpha-test flag live in the 24-byte per-primitive rows the reader skips
   (`scene_reader.cpp:452`), whose layout is undocumented and was not guessed.
   The cutout/translucent split is a statistical classification with stated
   thresholds, not artist intent.
4. **The four `vista_*_pt_diff` mattes and `vista01_diff`** are classified
   `cutout` by alpha statistics only (18–54 % of texels below 0.5). They are
   large backdrop surfaces; the report keeps them in the "screenshot-gated"
   bucket rather than claiming they are proven.
5. **The 31 Gracia translucent draws are not a decode opportunity.** They need a
   transparent pass with sorting; counting them as "unlocked by alpha" would be
   wrong.
6. **The decal pass is out of scope.** 334 / 518 draws are quantified by texture
   only; the additive alpha-tested pass, ordering, `g_vColour` and the depth
   interaction belong to DECAL1.
7. **Runtime draws are unrecoverable here.** The serialized parameter is a
   runtime list reference; the advert compositor is not in the partial source.
8. **Mip chains and sRGB are the consumer's existing policy**, not recovered
   retail state; the chain byte counts in §7 use that kernel.
9. **`_work/` textures are generated game data** and are not committed.
10. **Two maps only.** Longbeach was out of scope for this pass; the same four
    blocker classes are the ones its manifest would need to be checked against.
