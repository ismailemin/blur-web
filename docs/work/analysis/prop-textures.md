# Prop textures — read-only feasibility study for the visible E1 props (P72a)

**Date:** 7 November 2026
**Owner:** P72a (sub-agent)
**Scope:** `probes/prop-textures/**`, `_work/prop-textures/**`,
`_work/logs/prop-textures/**` and this document. Read-only inputs:
`_work/e1-drive/geometry.json` v6, `_work/e1-drive/track-textures.json`,
`_work/e1-drive/track-uv.bin`, `_work/e1-drive/textures/*.rgba`, the committed
`probes/e1-drive/tools/build_track_textures.py`, `_work/e1-drive/packet.json`
(cameras), the committed P66/P68 collider manifests, and the retail
`game-data/Blur/levels/usa_la_river/{level.levelrender,level.levelstream}`.
No e1-drive, geo build, texture, tool, other probe, `upstream/` or `game-data/`
file was modified. **Data/analysis only: no renderer or e1-drive change, no GPU
or browser claim, no full-game claim, no invented texture.**

---

## 0. Summary

| | |
| --- | --- |
| track draws | 394 = **297 bound-static-albedo** + **2 runtime-only** + **95 no-binding-row** |
| diagnostic track draws | **97** (9,347 triangles), but **0 of them are visible structural props** |
| structural props (P66/P68) | 460 / 423 track-visual components, **all `bound-static-albedo`** |
| diagnostic visible props | **22 level instance draws / 8 placements / 10,308 triangles** |
| why the 22 are untextured | the committed instance reader exports POSITION only: `uv0Available:false`, `albedoTexture:null`, `material:"diagnostic-only"`; the level mesh has no `uv` array |
| source truth for the 22 | declaration 0 declares UV0 usage5 type8 at **byte offset 16**; the node material chain resolves **5 static `g_tAlbedo` images** |
| textures | `car01_lic_diff` 32×16 BC1, `car02_lic_diff` 32×16 BC1, `car03_lic_diff` 32×16 BC1, `bigtruck02_diff` 32×16 BC1, `cab01alphas_diff` **16×16 BC3**; **9,216** decoded RGBA bytes; **0** already in the 136-texture track pack |
| feasible next step | export instance UV0 + the material binding: **18 draws / 10,212 triangles** become bindable with the proven BC1 path; **4 draws / 96 triangles** are BC3-alpha and need a declared alpha rule |
| already-visible opportunity (safe BC1) | **14 draws / 8,222 triangles**; 4 more safe draws (1,990 tri) are behind the spawn |
| screen-area proxy | unique coverage **5.18 %** at tick 0, peak **39.64 %** at tick 120 (near-field truck crossing), **0.33 %** at tick 150, **0** after tick 170; mean **4.91 %** over 31 samples; **1.52** full-frame equivalents over the 301-tick drive |
| diagnostic track screen | **0** coverage at all capture ticks and **0.0** pixel-frames of triangle area; the 95 block88 draws are ≥1,468.16 m away, outside the 230.04 m camera far plane |
| manifest | `_work/prop-textures/candidates.json`, **1,112,082 B**, SHA-256 `43b10472f63fdc6004a99186fadcf32d9ee911db55deadc50f6961653971f168`, content hash `sha256:fbaaaec7…e153972` |
| verifier | **49/49 PASS**, 0 failures; second build is byte-identical |
| evidence | `_work/prop-textures/{candidates,summary,level-props,verify}.json`, `level-instances-all.json`, `level-textures/*.rgba`, `_work/logs/prop-textures/` |

---

## 1. Question and method

The task assumed that the 97 diagnostic draws of the 394-draw track visual are the
visible props (trucks, wrecks, buildings, fences, pipes, racks). The committed data
does not support that assumption:

- the **structural props** (fences, pipes, racks, walls, containers) are inside the
  six measured corridor sections and are already textured;
- the **only visible diagnostic props** are the 22 level instance draws, which are
  a separate mesh (`river.block27.instances-all`) outside the 394 track draws;
- the 97 diagnostic track draws are a far, unbound section and two tiny
  runtime-only draws.

The method is strictly source-driven:

1. classify all 416 committed draws (394 track + 22 level) from their own
   `textureBinding`/`materialId` fields, the P66/P68 collider provenance and the
   level instance matrices;
2. for each diagnostic group, record the exact field that prevents binding;
3. for the level props, follow the committed node253 material stack (instance →
   base → stream) to `g_tAlbedo`, then to the node texture-source table, then to
   the committed P34/P47 registry and the committed BC decoder;
4. measure a screen-area proxy with the committed 301-tick packet cameras;
5. write one deterministic candidate manifest and verify it independently.

Everything below is a **source/geometry measurement**, not a rendered result.

---

## 2. What the diagnostic sets actually are

### 2.1 The 394 track draws by section

| section | draws | status | triangles | note |
| --- | ---: | --- | ---: | --- |
| `river.block88.node283` | 95 | `noBindingRowForSection` | 9,343 | instructed section, ≥1.47 km from the drive, no P44/P45/P47 row |
| `river.block56.node289` | 49 | `bound-static-albedo` | 9,824 | drive-covering corridor section |
| `river.block58.node265` | 41 | `bound-static-albedo` | 7,393 | corridor |
| `river.block50.node265` | 42 + **2** | 42 bound + **2 `runtimeOnlyAlbedoParameter`** | 7,740 | the two runtime draws are primitives 241/242 |
| `river.block71.node209` | 56 | `bound-static-albedo` | 6,736 | corridor (longest share) |
| `river.block64.node209` | 40 | `bound-static-albedo` | 6,688 | corridor (finish) |
| `river.block59.node265` | 69 | `bound-static-albedo` | 9,409 | corridor |
| **total** | **394** | **297 / 2 / 95** | **57,133** | |

### 2.2 The 22 level instance draws

`river.block27.instances-all` has 22 draws, 13,162 vertices, 10,308 triangles.
Grouping them by their recorded `instanceMatrix` gives **8 placements**:

| placement | draws | instances | triangles | bounds (x, y, z) | P66 shape class | source albedo |
| ---: | ---: | --- | ---: | --- | --- | --- |
| 0 | 2 | 0, 1 | 995 | −40.995…−36.649, 5.673…7.204, 1071.661…1076.809 | `vehicle-sized-wreck` | `car01_lic_diff` |
| 1 | 2 | 2, 3 | 995 | −43.848…−39.402, 5.703…7.234, 1070.179…1075.267 | `vehicle-sized-wreck` | `car02_lic_diff` |
| 2 | 2 | 4, 5 | 995 | −105.922…−100.494, 5.863…7.394, 1023.861…1026.082 | `vehicle-sized-wreck` | `car02_lic_diff` |
| 3 | 2 | 6, 7 | 995 | −106.653…−101.227, 5.886…7.417, 1031.022…1033.243 | `vehicle-sized-wreck` | `car02_lic_diff` |
| 4 | 2 | 8, 9 | 995 | −48.803…−43.318, 5.702…7.233, 1068.800…1071.497 | `vehicle-sized-wreck` | `car03_lic_diff` |
| 5 | 2 | 10, 11 | 995 | −62.231…−59.053, 5.791…7.322, 1058.202…1063.680 | `vehicle-sized-wreck` | `car03_lic_diff` |
| 6 | 5 | 12–16 | 2,169 | −79.725…−71.895, 5.778…9.736, 1047.756…1053.884 | `building-sized` | `bigtruck02_diff` + `cab01alphas_diff` |
| 7 | 5 | 17–21 | 2,169 | −60.275…−52.120, 5.730…9.688, 1062.323…1066.740 | `building-sized` | `bigtruck02_diff` + `cab01alphas_diff` |

P66's class is a **shape rule** (“height ≤ 2.1 m and footprint ≤ 40 m²” vs
“height > 2.1 m”). The two height>2.1 m placements resolve to
`bigtruck02_diff`/`cab01alphas_diff`; the source texture names indicate trucks, so
this document keeps P66's shape class and reports the texture name separately
rather than silently reclassifying them.

### 2.3 The key correction

- **97 diagnostic track draws ≠ 97 props.** They are exactly P66's
  `no-material` class: 95 block88 draws (9,343 tri) + 2 runtime-only draws
  (4 tri) = 97 draws / 9,347 tri. Their classification is **95
  `unknown/no-material (far section)` + 2 `unknown/runtime-only`**, and **0
  `prop` with a source material reference**. Neither group has a
  truck/building/fence/pipe material reference.
- **All 460 P66 track-visual prop components (2,746 triangles) and all 423 P68
  components are `bound-static-albedo`.** Fences, pipes, racks, walls and
  containers are already textured; the 95 P66 components that are inactive for
  collision are still rendered with their albedo.
- **The visible untextured props are the 22 level instance draws.** They are
  outside the 394-draw set and are the only level instances in the scene
  (`levelInstances.emitted = 22`).

---

## 3. Why each diagnostic group is untextured (exact evidence)

### 3.1 The 22 level props — the reader drops UV0 and the material binding

| evidence | exact field / value |
| --- | --- |
| geometry mesh | `meshes[id="river.block27.instances-all"]` keys are `coordinateSpace, id, indexCount, indices, indicesSha256, positions, positionsSha256, source, storage, vertexCount` — **no `uv` array** |
| geometry draws | `materialId: null`; `materialReason: "level material list is decoded but not applied by the asset reader (Level instance diagnostic; materials not applied); no colour or texture is assigned by this packet"` |
| committed instance reader output | all 22 draws: `"uv0Available": false`, `"albedoTexture": null`, `"albedoParameter": null`, `"resourceBlock": null`, `"resourceIndex": null`, `"binding": "Level instance diagnostic; materials not applied"`; metadata `"material": "diagnostic-only"` |
| source vertex declaration | node253 declaration 0: POSITION usage0 type6 method0 @**0**, NORMAL usage3 type11 @**12**, **UV0 usage5 type8 @16**; the referenced block27 VBs are stride **20** (`docs/work/analysis/level-instance-streams.md` §3) |
| source material data | node253 has 56 constant material rows. Each of the 22 draws has an `Instance` row (`g_mWorld`, a transform) and one stream material row (`default_LN_NB_NL_NV.fx`) with `g_tAlbedo` and `g_tMaterial`. The base and instance material refs are index 0 (empty). |
| source texture table | `sources.texture[0..24]` includes `{1073:0, 1112:0, 1118:0, 1074:0, 1205:0}`; `g_tAlbedo` is a slot index into this table |
| what the reader does | `level_instances_all()` writes POSITION only and never calls `apply_material()` for instance draws; it prints `uv0Available:false` unconditionally |

So there are two independent, labelled blockers: **(a) UV0 is not exported** and
**(b) the material/albedo binding is not resolved**. The source carries both.
This is not a missing-format problem; it is an unimplemented instance path in the
committed reader. Nothing was guessed to reach that conclusion.

### 3.2 The 2 runtime-only draws — albedo exists only as a runtime parameter

`river.block50.node265.draw.226` and `draw.227` (primitives 241/242):

| field | draw 226 | draw 227 |
| --- | --- | --- |
| vertices / triangles | 4 / 2 | 4 / 2 |
| bounds min | −111.360, 12.822, 988.109 | −74.450, 11.214, 986.327 |
| bounds max | −103.013, 16.981, 988.323 | −66.101, 15.372, 986.352 |
| `textureBinding.status` | `runtimeOnlyAlbedoParameter` | same |
| `textureBinding.reason` | `runtimeOnlyAlbedoParameter` | same |
| `textureId` | `null` | `null` |
| `textureBinding.uvHash` | `0x7a40a08e747ef402` | `0xe29b3255e60f18b9` |

The P47 row is `texstate=runtimeOnly`, `albedo=-1:-1`, `texture=null`
(`build_track_textures.py` lines 421–435 rejects any other shape). There is no
static image to bind. They are ≈8.35 m × 4.16 m cards, 0.21 m and 0.026 m thick
respectively; the source gives no name, so they are reported as **unknown
runtime-only**, not as a guessed sign/banner.

### 3.3 The 95 block88 draws — no binding row was ever measured

`river.block88.node283` draws (e.g. `draw.0`):

| field | value |
| --- | --- |
| `textureBinding.status` | `noBindingRowForSection` |
| `textureBinding.reason` | “the committed P44/P45/P47 section pass covers the six measured corridor sections only; block88/node283 has no binding row, so the draw keeps the diagnostic albedo” |
| `textureId` | `null` |
| `textureBinding.uvHash` | `null` |
| source UV0 | the mesh reference exists (`reference-mesh-88-283.json`, 35,564 UV values), but the P45 pass did not hash this section |
| section bounds | x 944.037…2477.923, y −4.258…39.143, z 2205.934…3237.170 |
| distance to the drive box | **≥1,468.16 m** (nearest AABB corner; the drive box is x −120…−10, z 1010…1090) |
| packet camera far | **230.0365 m** |
| screen proxy | **0** coverage at all capture ticks; 0 triangle area |

A texture cannot be bound without guessing an albedo row; none is invented. The
section is also not observable in the E1 chase view (beyond the far plane), so it
is the lowest-value extension.

### 3.4 The structural props are already textured

The P66 manifest classifies 460 track-visual components as `structure`, with
10 distinct texture names: `concretepipe_diff` (108 components),
`constructionfence01_diff` (96), `metalstructure02_diff` (84),
`woodenfence_diff` (48), `constructionfence03_diff` (48), `steelpole_diff` (44),
`greybrickwall01_diff` (18), `cargocontainer_red` (8), `wall03_diff` (3),
`cargocontainer_orange` (3). Every one resolves to a
`bound-static-albedo` draw; the verifier checks 460/460 (P66) and 423/423 (P68).
Example: `river.block56.node289.draw.102` binds
`track.albedo.1136.0` (`wall03_diff`, 32×32) with UV0 hash
`0x0874b2cbe817b2e6`.

---

## 4. Albedo + UV0 feasibility for the 22 level props

### 4.1 Resolved material chain

The committed reader order is instance material → base material → every stream
material (`scene_reader.cpp` `apply_material`). For the 22 draws:

- the instance row is an `Instance`/`InstanceReset` transform (`g_mWorld`), not an
  albedo;
- the base material and instance material refs are index 0 (empty);
- the stream material is one of three `default_LN_NB_NL_NV.fx` rows.

| draw group | stream material index | `g_tAlbedo` slot | `sources.texture` | registry name |
| --- | ---: | ---: | --- | --- |
| instances 0, 1 | 9 | 1 | 1073:0 | `car01_lic_diff` |
| instances 2–7 | 12 | 3 | 1112:0 | `car02_lic_diff` |
| instances 8–11 | 19 | 5 | 1118:0 | `car03_lic_diff` |
| instances 12, 13, 16, 17, 18, 21 | 24 | 10 | 1074:0 | `bigtruck02_diff` |
| instances 14, 15, 19, 20 | 27 | 12 | 1205:0 | `cab01alphas_diff` |

The verifier re-derives all 22 chains from the pre-existing
`_work/level-instances/usa_la_river-g252-n253.json` report (22/22 match), i.e. the
claim does not depend on the new extraction code.

### 4.2 The five source images

All five were decoded with the committed `_work/build/asset-reader-native/Release/texture_inspect.exe --raw`;
the decoded RGBA was re-hashed against the P34/P47 registry (`rgbaHash`, FNV-1a 64)
and written to `_work/prop-textures/level-textures/`.

| source | name | size | format | draws | triangles | RGBA bytes | RGBA SHA-256 |
| --- | --- | --- | --- | ---: | ---: | ---: | --- |
| 1073:0 | `car01_lic_diff` | 32×16 | DXT1/BC1 | 2 | 995 | 2,048 | `b09bbc45…05ef49` |
| 1112:0 | `car02_lic_diff` | 32×16 | DXT1/BC1 | 6 | 2,985 | 2,048 | `f8a074bd…01450f` |
| 1118:0 | `car03_lic_diff` | 32×16 | DXT1/BC1 | 4 | 1,990 | 2,048 | `a2d1ee06…b0f0e5` |
| 1074:0 | `bigtruck02_diff` | 32×16 | DXT1/BC1 | 6 | 4,242 | 2,048 | `dae1ca2c…a37a99` |
| 1205:0 | `cab01alphas_diff` | 16×16 | **DXT5/BC3** | 4 | 96 | 1,024 | `70206f66…92dbd` |

**9,216 RGBA bytes total, 0 of the five sources are in the 136-texture track
pack**, so a level-prop pack is 5 new images / 9,216 B. The 32×16 / 16×16
resolution is the source resolution; no mip, upscale or invented image is used.
The BC3 image has a non-trivial alpha channel (the decoded RGBA alpha spans
0–209, 67 distinct values), which is why the four cab draws are a separate blocker.

### 4.3 UV0: declared, not yet exported

- Declaration 0 says UV0 is `usage 5`, `usageIndex 0`, `type 8`, `method 0`,
  at byte offset **16**. NORMAL is type 11 at 12, POSITION type 6 at 0; the
  documented stride is **20** bytes.
- The committed `level_instances_all()` output says `uv0Available:false` for all
  22 draws and the geometry mesh has no `uv` array.
- Therefore the source **declares** a UV0 stream that the existing instance reader
  does not export. No UV value, UV range or per-draw UV hash is claimed here; the
  next reader must export the values and the P45-style FNV-1a 64 hash must be
  recorded before a texture is accepted.

This distinction is deliberate: “the declaration exists” is proven; “the values
are valid and non-degenerate” is **not** claimed until they are exported and
hashed.

### 4.4 What the existing texture pipeline can reuse

The committed pipeline already supports everything after the reader:

- `texture_inspect --raw` decodes both BC1 and BC3 sources (proven here on all
  five);
- the packet consumer already uploads one `rgba8unorm` mip0 texture per source,
  binds a per-draw `textureId`, samples a UV vertex buffer and applies the
  declared U/V flags (`texParams.y/z`); the track and car packs use exactly this
  path.

The missing work is in the **reader/geometry export**, not in the WebGPU
consumer.

---

## 5. Opportunity quantification

### 5.1 Draws and triangles

| status | draws | triangles | can be bound with the proven readers today? |
| --- | ---: | ---: | --- |
| `already-textured` (track) | 297 | 47,786 | already bound |
| `candidate-static-albedo-not-exported` (level, BC1) | **18** | **10,212** | no — reader must export UV0 + binding |
| `blocked-alpha-source` (level, BC3) | 4 | 96 | no — no alpha/blend state |
| `blocked-runtime-only-albedo` (track) | 2 | 4 | no — runtime parameter only |
| `blocked-unmeasured-albedo` (track, block88) | 95 | 9,343 | no — no measured binding row; not visible |
| **candidates** | **119** | **19,655** | **0 today** |

Of the 22 level props, **18 draws / 8,318 triangles are in the driven view**
(placements 0, 1, 4, 5, 6, 7) and **4 draws / 1,990 triangles are behind the
spawn** (placements 2 and 3, x ≈ −106…−100, z ≈ 1023…1033; zero coverage in every
sampled frame). Of the visible 18, **14 draws / 8,222 triangles are BC1-safe** and
**4 draws / 96 triangles are BC3 cab/glass** (placements 6 and 7).

### 5.2 Screen-area proxy (data only, no GPU claim)

Method: project the committed world triangles through the committed
`packet.json` 301-tick default-car cameras, clip to the 1600×900 viewport, and
rasterize a 320×180 unique-coverage mask. This has **no depth test, no occlusion
and no backface cull** (the committed consumer uses `cullMode:'none'`); the mask is
a unique-pixel coverage proxy, and the separate triangle-area sum is an upper
bound (it can exceed 100 % because it double-counts overlapping triangles).
Camera source: the committed `packet.json` 300-tick drive (301 cameras, default
car). The 310 m sprint starts at the same spawn and would see the same start
cluster, but no per-tick sprint camera timeline was separately projected; this is
a start-area measurement, not a whole-course claim.

**Aggregate level props (22 draws), every 10th tick:**

| tick | 0 | 30 | 60 | 90 | 100 | 110 | **120** | 130 | 150 | 160 | 170–300 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| coverage | 5.18 % | 5.41 % | 6.83 % | 11.93 % | 16.34 % | 25.52 % | **39.64 %** | 0.97 % | 0.33 % | 0.13 % | 0 % |

- mean over 31 samples: **4.91 %**; sum: **1.5229 full-frame equivalents**.
- peak: **39.64 % at tick 120**, where the chase camera is beside the first truck
  (placement 6). The peak is a near-field camera crossing, not a claim that the
  truck fills 40 % of a normal racing frame.
- the four committed capture ticks 0 / 150 / 240 / 300 are **5.18 % / 0.33 % /
  0 % / 0 %**.

**Per placement (6 sampled ticks, 320×180 unique coverage):**

| placement | triangles | peak coverage | peak tick | visible |
| ---: | ---: | ---: | ---: | --- |
| 0 | 995 | 0.314 % | 120 | yes |
| 1 | 995 | 0.351 % | 120 | yes |
| 2 | 995 | 0 % | — | no (behind spawn) |
| 3 | 995 | 0 % | — | no (behind spawn) |
| 4 | 995 | 0.410 % | 120 | yes |
| 5 | 995 | 1.203 % | 120 | yes |
| 6 (truck 1) | 2,169 | **36.293 %** | 120 | yes |
| 7 (truck 2) | 2,169 | 2.738 % | 120 | yes |

**The BC3 cab draws:** at tick 120, each of the two cab draws of truck 1 covers
**3.901 %**, and each of the two cab draws of truck 2 covers **0.186 %**
(per-draw, overlapping; the pair bounds are identical). This is the part that
cannot be bound without an alpha decision.

**The 97 diagnostic track draws:** unique coverage **0** at every capture tick;
total triangle area **0.0 pixel-frames** over all 301 ticks — effectively zero.
The 95 block88 draws are beyond the 230.04 m far plane; the 2 runtime cards are
outside the driven view.

### 5.3 Bytes added

| item | bytes |
| --- | ---: |
| 5 level albedo images (mip0, RGBA8) | **9,216** |
| level UV0 stream if exported for the 13,162-vertex mesh (2 × float32) | **105,296** (expected; not yet measured) |
| **total GPU delta** | **≈114,512 B** plus 5 bind groups |

No new shader, pipeline or pass is required by the existing consumer contract;
the delta is data.

---

## 6. Blocked cases

| case | draws | triangles | reason | what would unblock it |
| --- | ---: | ---: | --- | --- |
| level BC3 cab/glass | 4 | 96 | `cab01alphas_diff` is DXT5/BC3; the proven sampler applies no alpha test, blend or material colour | declare and validate an alpha rule (alpha-test or blend) in a renderer task, or leave diagnostic |
| level UV0/material reader | 22 (all) | 10,308 | `uv0Available:false`, `albedoTexture:null`, `material:"diagnostic-only"` | extend the committed instance reader (Section 7) |
| runtime-only track draws | 2 | 4 | P47 `texstate=runtimeOnly`, `albedo=-1:-1`, `texture=null` | a runtime albedo source would have to be recovered first; not attempted |
| block88 no-binding draws | 95 | 9,343 | no P44/P45/P47 binding row; UV0 exists but albedo was never measured; ≥1,468 m away and outside the far plane | run the P44/P45/P47 pass on block88/node283; low visual value |
| level props behind spawn | 4 | 1,990 | not a blocker to texturing, but zero screen area in the committed drive | still bind for consistency if the reader is fixed |

The total candidate set is 119 draws / 19,655 triangles; **0 can be textured with
the current proven readers**, and the 18 BC1-safe level draws are the only
candidates that become bindable with a bounded reader extension.

---

## 7. Recommended next implementation step

**Extend the committed level instance reader, then export and verify the level
prop UV0 + material binding. Do not change the renderer.**

### 7.1 Reader change (single stream)

In `probes/asset-reader/src/scene_reader.cpp`, inside `expand_instance`:

1. Resolve declaration element `usage 5 / usageIndex 0` (UV0) from the same
   primitive declaration already used for POSITION; require its `type == 8` and
   `method == 0`. For each emitted instance vertex, read the two float32 values at
   `vb.data + vertex*stride + element.offset` (offset 16, stride 20 for block27)
   and append them to a new `uv0` array parallel to `positions`.
2. Resolve the material stack with the existing `apply_material()`/`MaterialState`
   code: instance material → base material → every active stream material. Reject
   a non-zero `listIndex` as runtime-only, as the direct-draw path already does.
3. Emit per draw: `uv0Available:true`, `albedoTexture` (name), `resourceBlock`,
   `resourceIndex`, and the existing `binding`/`material` fields with their real
   state. Keep `uv0Available:false` for any draw where the declaration, material
   or texture source cannot be resolved; never bind a guessed texture.
4. Add the P45-style per-draw UV0 FNV-1a 64 hash over the referenced index range,
   so the export is auditable exactly like the track and car streams.

### 7.2 Expected result

| expected | value |
| --- | ---: |
| level draws / triangles | 22 / 10,308 |
| static albedo sources | 5 |
| RGBA bytes | 9,216 |
| BC1-safe draws / triangles | **18 / 10,212** |
| BC3-alpha draws / triangles | **4 / 96** |
| visible BC1-safe draws / triangles | **14 / 8,222** |
| UV0 values for the 13,162-vertex mesh | 26,324 float32 / 105,296 B |
| new textures relative to the 136-track pack | 5 (0 overlap) |

**Safe to bind after the reader + UV export + P45-style hash:** instances
0–3, 8–13, 16–18, 21 (BC1). **Do not bind yet:** instances 14, 15, 19, 20
(BC3 alpha). **Bind for consistency but no screen gain:** instances 4–7
(placements 2/3, behind the spawn).

### 7.3 Downstream work (separate task; not this one)

1. `build_geometry.mjs`: consume the new instance reference, verify the UV0 hash
   and the 5 texture identities, and emit the level mesh with `uv` plus per-draw
   `textureId`/`textureBinding` (`uvFlip` convention: raw, like the track pack,
   unless a readable island proves otherwise).
2. `packet-adapter.js`: include the level mesh UV stream and the 5 level textures
   in the packet; the consumer already has the per-draw texture select, the UV
   buffer and the `texParams` path.
3. Verification: count/UV/RGBA gates analogous to P49 (`22/22` UV hashes,
   `5/5` RGBA re-hashes), then a browser capture with a screenshot and a clean
   console before any visual claim.
4. Renderer/alpha task: decide and label the alpha rule for
   `cab01alphas_diff`; otherwise those four draws stay diagnostic.

### 7.4 What must remain diagnostic

- the 4 BC3 cab/glass draws (96 tri) until an alpha rule is declared and checked;
- the 95 block88 draws (9,343 tri) — no binding row, not visible, must not be
  guessed;
- the 2 runtime-only draws (4 tri) — no static albedo exists;
- every draw whose reader output still says `uv0Available:false` or whose UV0 hash
  does not match;
- all material features beyond static albedo: `g_tMaterial`, material colour,
  blend state, shader stages, sampler wrap/filter, mip chain and sRGB.

Expected visual gain if the safe BC1 level draws are bound: the start-area prop
cluster covers **5.18 %** of the 1600×900 frame at tick 0 and up to **39.64 %** at
tick 120, with **0.33 %** at tick 150 and **0** after tick 170. This is a
start-area gain, not a whole-course change.

---

## 8. Verification record

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py probes/prop-textures/tools/extract_level_props.py
& $py probes/prop-textures/tools/build_candidates.py
& $py probes/prop-textures/tools/verify_candidates.py
```

`_work/prop-textures/verify.json` — **PASS, 49/49 checks, 0 failures**:

- 394 track draws, 297/2/95 split, 136 textures, 439,360 track RGBA bytes;
- 299/299 tracked UV0 hashes recomputed independently from `track-uv.bin`;
- 22 level draws / 10,308 triangles / 5 textures / 9,216 RGBA bytes decoded by the
  committed BC reader and re-hashed;
- 22/22 level material chains match the pre-existing node253 report;
- 460/460 P66 and 423/423 P68 track-visual components are `bound-static-albedo`,
  and the 8 level instances are diagnostic in both manifests;
- 416/416 per-draw record hashes, content hash, status/triangle totals;
- screen proxy recomputed at the capture ticks, per-draw coverage, 301-tick
  triangle area for all 22 level draws, and zero coverage for the 97 diagnostics;
- a second builder run is **byte-identical** to `candidates.json`.

| artifact | bytes | SHA-256 |
| --- | ---: | --- |
| `_work/prop-textures/candidates.json` | 1,112,082 | `43b10472f63fdc6004a99186fadcf32d9ee911db55deadc50f6961653971f168` |
| `_work/prop-textures/summary.json` | 3,514 | recorded in `verify.json` / `summary.json` |
| `_work/prop-textures/level-props.json` | 31,269 | `8e551a2b1c49c70b569c3e36c35d64faa2ae78fad9cb881ea89d8bce0bd69461` |
| `_work/prop-textures/level-instances-all.json` | 635,711 | `d7dd7804ee9a35ebf15d1a91b0b61c93559e275bc7772df07fbf69969d287eff` |
| `_work/prop-textures/node253.chunk` | 26,624 | `65aec287878fa58405fa5ed585e6c43f3ba5ff683e825c0759b29f8fe8ccf20c` |
| `_work/prop-textures/block27-geometry.chunk` | 1,624,064 | `a813745141466d0918374927c40ad19b682121a10c2ddda1126257392f6c3b78` |
| `_work/prop-textures/verify.json` | — | `manualSha256` = the candidate manifest above |

Input hashes are recorded in `candidates.json.inputs` (`geometry.json`
`85a32100…eb0445`, `track-textures.json` `81945fa6…7d6cca`, `track-uv.bin`
`8133b9fc…fb599b5`, `packet.json` `c95423e7…e83efd`, P66 `a98fb8eb…317af4`,
P68 `5c7bba74…98a4805`, level render `0408e434…b557f9`, level stream
`c6b1485c…683b33e9`).

---

## 9. Limits

1. **Feasibility, not a rendered result.** The 18 BC1 candidates are bindable
   *after* a reader extension; no texture has been sampled in a frame, and no GPU
   or browser claim is made. A screenshot plus a clean console is required before
   calling the binding visually correct.
2. **UV0 values are unmeasured.** The declaration (offset 16, type 8, stride 20)
   is proven; the actual per-vertex values and the per-draw hash must be exported
   and checked next.
3. **Screen metrics are a geometric proxy.** No depth test, no occlusion, no
   backface cull; the triangle-area sum is an upper bound and can exceed 100 %.
   The 320×180 unique-coverage raster is the primary figure; the 4-tick capture
   values and the 10-tick curve are the sampled evidence.
4. **Low source resolution.** The five albedo images are 32×16 / 16×16. They are
   the retail source at mip0; no upscale, mip chain or invented detail is used.
5. **Material features remain unapplied.** `g_tMaterial` (a second parameter in
   every level material row), material colour, blend state, shader stages,
   sampler wrap/filter, anisotropy, mips and sRGB are not resolved for the level
   props (same limits as the P49 track and P55/P59 car packs).
6. **The two “building-sized” placements** are P66's shape class; their source
   albedo names (`bigtruck02_diff`, `cab01alphas_diff`) indicate trucks. This
   document does not change the committed class.
7. **One level, one measured drive.** No other level instance node, no other prop
   cluster, no visibility/PVS, no streaming, no full-game claim.
8. **No game-data modification.** The retail level render/stream, `upstream/`,
   e1-drive and every texture remain read-only; the manifest is data under
   `_work/`.

---

## 10. Evidence paths

| path | content |
| --- | --- |
| `probes/prop-textures/README.md` | tool map, reproduce commands, status vocabulary |
| `probes/prop-textures/tools/extract_level_props.py` | node253/block27 material + UV0-declaration extraction, 5 decodes |
| `probes/prop-textures/tools/build_candidates.py` | deterministic 416-record manifest + screen proxy |
| `probes/prop-textures/tools/verify_candidates.py` | independent 49-check verifier + reproducible rebuild |
| `probes/prop-textures/tools/report_numbers.py` | tables used above |
| `_work/prop-textures/candidates.json` | the manifest (416 draws, 119 candidates, per-draw hashes/provenance) |
| `_work/prop-textures/summary.json` | status counts, screen curve, texture table, hashes |
| `_work/prop-textures/level-props.json` | 22 chains → `g_tAlbedo` → source, 5 textures, UV0 declaration, current-reader fields |
| `_work/prop-textures/level-instances-all.json` | committed `level_inspect --instances-all` output (22 draws, diagnostic) |
| `_work/prop-textures/level-textures/*.rgba` | the 5 decoded source images |
| `_work/prop-textures/repeat-candidates.json` | byte-identical second build |
| `_work/prop-textures/verify.json` | 49/49 PASS record |
| `_work/logs/prop-textures/{extract,build,verify,numbers}.log` | command logs |
| `docs/work/analysis/level-instance-streams.md` §3 | declaration 0 / stride-20 source proof |
| `docs/work/analysis/prop-collision.md` §3 | P66 shape classification and the 8 level instances |
| `docs/work/verification/T-007-textured-track.md` | P49 track texture pipeline and its 297/2/95 split |
| `docs/work/verification/T-007-textured-cars.md`, `T-007-car-uv-orientation.md` | the proven BC decode + UV sampling path reused here |

**No full-game claim, no invented texture, no renderer or e1-drive change.**
