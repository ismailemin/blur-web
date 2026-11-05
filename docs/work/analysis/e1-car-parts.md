# E1 car-part manifest — Corvette C3, plus one real manifest per roster car

**Date:** 5 November 2026
**Owner:** P26 (sub-agent), extended by P29
**Scope:** a reusable, deterministic part manifest extracted from a real
`.model`, plus a standalone WebGPU preview that draws the manifest with per-part
diagnostic colours and spins the four identified wheel groups. P29 generalised
the builder to any PC vehicle model and built one manifest for each of the five
E1 roster cars. New directory `probes/car-parts/`, generated output under
`_work/car-parts/`, logs under `_work/logs/car-parts/`, and this document.
No change to `probes/asset-reader`, `probes/render-packet`, the engine, `tools/`,
`upstream/` or `game-data/`.

**Result (P29):** the same builder now produces complete manifests for the
Corvette ZR1, Lotus Exige Cup260, Dodge Challenger, Ford Focus RS and Audi R8
V10 from each car's own `root.pak` model. Every model mapped unambiguously by
exact normalised name; the five body meshes are distinct; the Corvette C3
manifest still classifies 29 parts / 80 draws / 76 proven / 4 ambiguous. The
drive slice draws each car's own body and wheels
(`docs/work/verification/T-007-per-car-meshes.md`).

**C3 result (P26, unchanged semantics):** 29 parts / 80 draws; 76 draws carry a
proven part or group id, four front-disc/caliper draws are explicitly
unclassified because their left/right element bounds are identical. Four wheel
groups use the file's own `e_wheel_*` names and `MdlDat` translations and spin
about element-local +X. Two independent builds produce byte-identical manifests;
headless Edge/WebGPU renders five fixed-angle screenshots with a clean console.

---

## 0. Summary

| | |
| --- | --- |
| model (C3) | `_work/car-level-assets/corvette_c3_race.model.decoded` — 3,169,212 B, SHA-256 `77840511e5ca416ff9e7cbdc9ee9fc960fce0205f83c9be77e0803607c32cb9d` |
| scene geometry | committed `scene_inspect.exe` first RenderList LOD0: **30,591 vertices / 36,193 triangles / 80 draws**, object-local |
| MdlDat | offset 40 / 10,933 B, SHA-256 `1263afddb8d8e7be1bc55fb0ac826d1d2f90edbd0913632cfc1f8fb1eff7f0cc`, version 1, **18 models / 71 elements / 0 constraints** |
| manifest (C3) | `_work/car-parts/manifest.json` — **269,046 B**, SHA-256 `5df83a6b0fac6f24df642bcb742cfe798bd5ff5d154f097674d165d70ede5dbf` |
| mesh (C3) | `_work/car-parts/mesh.json` — 1,748,966 B, positions `5c845980…9140b2`, indices `dcd98521…4cdd1d` |
| parts (C3) | **29** = 27 named parts + `body.shell` + `interior.shell`; 4 wheel groups, 4 glass, 14 light, 4 plate/mirror, 1 steering, 2 shells |
| draws (C3) | **76 proven** (44 specific element + 32 shell-group) and **4 unclassified** (front brake disc/caliper side) |
| wheel groups (C3) | 4; **20 wheel draws**: 16 corner-proven, 4 side-ambiguous |
| roster cars | **5 of 5 mapped** by exact normalised model name; draws/parts: ZR1 100/34, Lotus 88/23, Dodge 104/31, Focus 115/31, Audi 84/29 |
| browser | headless Edge/WebGPU, 1600×900, adapter `nvidia / blackwell`, **0 console messages**, 5 fixed-angle screenshots + 5 wheel-view screenshots per roster car |
| determinism | two independent builds: identical manifest, mesh and scene report (C3 and a roster car); repeated fixed-angle screenshot byte-identical |
| verification | `_work/car-parts/verify.json` — **PASS**, 0 failures, five mapped cars, five distinct body mesh hashes |

No engine integration and no game claim. Materials are diagnostic colours; the
manifest is metadata + geometry ranges, not a reconstructed retail renderer.

---

## 1. What was built

```text
one decoded .model  (C3 + the five roster cars)
        │
        ├── scene_inspect.exe ──► positions / indices / draws / UV0 / binding
        ├── model_inspect.exe ──► top-level chunk tree (Model/MdlDat/Render/Coll)
        └── MdlDat parser ─────► models, elements, StrTab, HMat43, C_AxisBox
        │
        ▼
build_manifest.py ──► manifest.json + mesh.json + scene-report.json
        │
        ▼
probes/car-parts/web/ (WebGPU)  ──► per-part colours + four spinning wheels
        │
        ▼
capture_browser.mjs (headless Edge) ──► 5 screenshots + console gate
verify_manifest.py ──► two-build determinism + schema + pixel checks
```

The part layer is deliberately separate from the geometry reader. The mesh is
the committed reader's output, unchanged. The manifest adds names, element
matrices and draw→part links; the viewer applies the transforms at draw time.

---

## 2. Inputs and authority

### 2.1 Scene geometry (existing reader)

`scene_inspect.exe` is the committed native port of the sequential Scene
reader (`probes/asset-reader/FORMAT-scene.md`). It returns:

- `positions` — flat POSITION0, 30,591 vertices;
- `indices` — 108,579 U32 triangle-list indices;
- `draws[80]` — `{firstIndex,indexCount,albedoTexture,binding,...}`;
- `metadata` — `nodeIndex:19`, `resourceBlock:0`,
  `partialSceneTraversal:true`, `coordinateSpace:"object-local"`,
  `nodeTransformsApplied:false`, `parsedUntilOffset:2042579`.

The scene report is stored verbatim as `_work/car-parts/scene-report.json`
(SHA-256 `cfc88cb47bacb2c3212bb9d3b87912cc3aca255dd8221804f87e6b56bc7d7b73`).

### 2.2 MdlDat (source-justified parser)

`probes/car-parts/tools/build_manifest.py` parses the `MdlDat` file-block
sequence with the same layout the upstream reader uses
(`code/mercury/library/gamesys/game_resource/source/ModelData.cpp:453-599`):

| field | serialized width | source |
| --- | ---: | --- |
| file version, model/element/constraint counts | 4 × S32 | `Header` |
| bounds (version ≥ 1) | 2 × 3 × F32 = 24 B | `C_AxisBox` |
| model/element matrix | 4 × 3 × F32 = 48 B | `HMat43` (`Matrix.inl:3038-3049`) |
| local bounds | 2 × 3 × F32 = 24 B | `C_AxisBox` |
| name id, index, counts, hierarchy links | 7 × S32 | `ModelData.h` |
| element `m_RenderMeshId`, `m_PhysicsShapeId` | S32, U32 | `ModelData.h` |
| string table | U32 offset vector + U32 byte vector | `StringTable.h:187-195` |

The block layout was verified by exact payload arithmetic:
`Models` = 18 × 100 = 1,800 B, `Element` = 71 × 104 = 7,384 B, `StrTab` =
1,629 B, `Header` = 56 B; the block boundaries land exactly on `MdlDat`'s
declared end (10,973) with an empty `Constr` block before `Render`.

For the C3, all 18 model matrices and all 71 element matrices are translation-only
within `1e-6`; across the five roster models the worst DefaultModel linear
deviation is 9.1e-6 (float32 rotation noise on one Audi plate). The linear part
is recorded (`matrixRows`, `matrixColumnMajor`, `linearIdentity` within `1e-4`,
`linearDeviation`) and never decomposed or transposed. `m_RenderMeshId` is `-1`
on every element; it is recorded but **not** used for mapping. See §2.5 for the
element matrix frame.

### 2.3 Why the mapping is bounds-based

The manifest does not rely on a render-list node name shortcut, and
`m_RenderMeshId` is `-1` on every element, so there is no name/id shortcut
from a draw to an element. The manifest therefore links a draw only when its
index-range AABB proves it. Scene draws carry primitive positions in their
element's local frame (the committed reader reports
`nodeTransformsApplied:false`), so matching is element-local:

| rule | threshold | used for |
| --- | ---: | --- |
| wheel draw contained in a wheel element's local bounds | 0.005 m slack | wheel candidate set |
| wheel draw symmetric AABB difference | ≤ 0.15 m | rejects a small body draw inside the wheel box |
| wheel part kind | smallest difference among the containing elements | tyre / rim / disc / caliper |
| tyre element reproduced by a union of 1–3 draws | ≤ 0.05 m | tyre proof (tier `union`) |
| tyre draw only contained in the element | containment only | tyre fallback (tier `containment`) |
| draw AABB contained in element local bounds | 0.005 m slack | glass, lights, plates, mirrors, steering, shells |
| symmetric AABB difference | ≤ 0.05 m | glass, lights, plates, mirrors, steering |
| element candidate tie | within 0.01 m of the best | ambiguity, never a corner claim |

The match record keeps the measured difference. A draw with no proven match is
`partKind:"unclassified"` and carries the reason; it is never given a guessed
part name. A wheel draw whose corner is not provable keeps its wheel part kind
but is `unclassified` for identity and only paired to a corner for drawing
(`previewAssignment`).

### 2.4 Roster mapping (P29)

`build_all_manifests.py` maps each roster record to a model with one rule,
recorded per car:

```
roster name  Corvette_ZR1_Stock
normalised   corvette_zr1_stock
pak entry    \models\vehicles\corvette_zr1_stock.model   (exactly one match)
```

Every other `\models\vehicles\*.model` whose file name starts with the
normalised name is recorded in `prefixCandidates`, so the exclusion of `_race`,
`_legend_*`, `_tuner` and `_talon` variants is visible rather than implicit. The
separate `\models\vehicles\wheels\<name>.model` resource is recorded
(`wheelsResource`) but **not** used: the body model's own `e_wheel_*` subtree
carries the tyre/rim/disc/caliper geometry and the rest-pose transforms. A car
with zero or several exact matches would be recorded as unmapped with the reason
and would keep the committed Corvette C3 body, labelled.

| car | record | model pak path | model bytes | SHA-256 (model) |
| --- | --- | --- | ---: | --- |
| Corvette ZR1 | 37 / 1554942492 | `\models\vehicles\corvette_zr1_stock.model` | 4,594,975 | `c55cdc1e…e2313453` |
| Lotus Exige Cup260 | 15 / 805568925 | `\models\vehicles\lotus_exigecup260_stock.model` | 5,867,996 | `1b6af978…2e0ab786` |
| Dodge Challenger | 9 / 528964602 | `\models\vehicles\dodge_challenger_stock.model` | 4,163,371 | `6195243f…dc487c5` |
| Ford Focus RS | 50 / 2563977008 | `\models\vehicles\ford_focusrs_stock.model` | 5,530,523 | `0668854b…c9fbe4` |
| Audi R8 V10 | 55 / 2936683857 | `\models\vehicles\audi_r8v10_stock.model` | 3,659,117 | `2e71aaa7…426120` |

`_work/car-parts/cars/index.json` (72,194 B, SHA-256
`5042e714a309e28e19498a0d35e18fef941c0fac850e87bc0f986117bb9bc315`) holds the
mapping table, the decoded-model hash, the manifest and mesh hashes and the
per-car counts.

### 2.5 Element matrix frame

In every gated asset the serialized element translation already includes its
parent's offset: a wheel member repeats its `e_wheel_*` parent translation, and
summing the parent chain would double the offset and place the wheels outside
the body AABB. The parser therefore uses the serialized translation as the
model-space translation, records the parent links without composing them, and
checks every wheel-group translation against the model bounds. One Audi element
(`e_LicensePlate_Front`) carries float32 rotation noise of 9.1e-6; the linear
deviation is recorded per element and `linearIdentity` uses a 1e-4 tolerance.

---

## 3. Manifest schema

`kind:"blur.car-part-manifest"`, `version:1` — identical for the C3 and for every
roster car.
Full file: `_work/car-parts/manifest.json` (C3) and
`_work/car-parts/cars/<slug>/manifest.json` (roster cars).

```json
{
  "kind": "blur.car-part-manifest",
  "version": 1,
  "source": {
    "model": "_work/car-parts/models/<sha>.decoded",
    "modelSha256": "...",
    "modelPakPath": "\\models\\vehicles\\<name>.model",
    "car": { "slug": "...", "name": "...", "mapping": "roster name ... -> pak entry ..." },
    "sceneReaderOutputSha256": "...",
    "modelChunks": [ ... ],
    "elementMatrixFrame": "model-space; parent links recorded, not composed"
  },
  "matching": { "containToleranceMeters": 0.005, "exactDifferenceMeters": 0.05,
                "wheelMaximumDifferenceMeters": 0.15, "tyreUnionToleranceMeters": 0.05,
                "ambiguityMarginMeters": 0.01 },
  "mdlDat": { "offset": 40, "bytes": 10933, "models": [...], "elements": [...],
              "nonIdentityModelElements": [] },
  "mesh": { "path": "mesh.json", "pathBase": "manifest-directory",
            "vertexCount": 30591, ... },
  "parts": [ ... ],
  "draws": [ ... ],
  "wheelGroups": [ ... ],
  "tyres": [ ... ],
  "tyreProofTier": "union",
  "wheelKindCounts": [ ... ],
  "unclassifiedDraws": [ ... ],
  "diagnostics": { "drawCount": 80, "partCount": 29, ... },
  "limits": [ ... ]
}
```

`mesh.path` is relative to the manifest file, so two builds into different output
directories stay byte-identical. `parts[]`, `draws[]` and `wheelGroups[]` keep
the P26 shape; `tyres[]`, `tyreProofTier` and `wheelKindCounts[]` are the
generalised wheel evidence. `source.car` is `null` for the C3 (not a roster car).

### 3.1 Part record

| field | meaning |
| --- | --- |
| `id` | stable id, e.g. `glass.e_window_front`, `wheel.frontleft`, `body.shell` |
| `partKind` | `body`, `wheel`, `glass`, `light`, `interior`, `unclassified` |
| `name` | original `MdlDat` StrTab name, or `null` for a shell |
| `elementIndex`, `modelIndex` | source element/model (shells use the nearest element) |
| `draws` | draws this part renders (wheels include the preview-only pair members) |
| `provenDraws` | draws with a proven identity for this part |
| `ambiguousDraws` | wheel members whose left/right side is not proven |
| `drawIndexRanges` | `[{firstIndex,indexCount}]` in the flat index array |
| `vertexRange` | `{min,max,unique}` over all part draws |
| `triangleCount` | sum of draw index counts / 3 |
| `localBounds` | element-local AABB, or draw-union AABB for shells |
| `localTransform` | `{matrixRows,translation,linearIdentity}` — HMat43 rows `[AX,AY,AZ,AW]` |
| `worldTransform` | `{coordinateSpace:"model",translation,matrixColumnMajor}` |
| `memberParts` | wheel only: tyre/rim/disc/caliper names, bounds, `spins` |
| `spin` | wheel only: axis, axis space, spin/static members, source evidence |
| `proof` | `{tier,reason,difference?}` |

`matrixRows` keeps the serialized row-vector convention
(`world = x·AX + y·AY + z·AZ + AW`). `matrixColumnMajor` is the transposed
16-float array the WebGPU viewer consumes. For this asset all linear parts are
identity, so the two differ only by the translation placement.

### 3.2 Draw record

| field | meaning |
| --- | --- |
| `index` | 0…79, Scene primitive order |
| `firstIndex`, `indexCount`, `indexRange` | range in `mesh.indices` |
| `minIndex`, `maxIndex`, `uniqueVertexCount`, `vertexRange` | range in `mesh.positions` |
| `bounds` | AABB computed from the draw's own indices |
| `albedoTexture`, `albedoParameter`, `binding` | committed reader material class |
| `partId`, `partKind`, `partName` | proven identity (`null`/`unclassified` if unresolved) |
| `renderPartId`, `previewPartId` | where the viewer draws it; preview only for the 4 ambiguous wheels |
| `evidence` | wheel/part match record (`element`, `role`, `difference`, `wheelPart`) |
| `unclassifiedReason` | present for the 4 ambiguous draws |

### 3.3 Diagnostics

```json
{
  "drawCount": 80,
  "partCount": 29,
  "namedPartCount": 27,
  "unclassifiedPartCount": 0,
  "provenDrawCount": 76,
  "unclassifiedDrawCount": 4,
  "wheelDrawCount": 20,
  "provenWheelDrawCount": 16,
  "ambiguousWheelDrawCount": 4,
  "tyreDrawCount": 8,
  "rimDrawCount": 4,
  "brakeDiscDrawCount": 4,
  "brakeCaliperDrawCount": 4,
  "wheelGroupCount": 4,
  "wheelElementCount": 16,
  "tyreProofTier": "union",
  "glassDrawCount": 4,
  "lightDrawCount": 18,
  "bodyDrawCount": 31,
  "interiorDrawCount": 7
}
```

`provenDrawCount` counts draws with a proven part identity; a draw whose
`partKind` is `unclassified` is counted only there, so the two numbers always
add to `drawCount`. Per-car values differ (see §4.7).

The manifest also carries `tyres[]` (per tyre element: chosen draws, union
difference, matched corners, proof tier) and `wheelKindCounts[]` (proven /
ambiguous per wheel part kind).

---

## 4. Part proof

### 4.1 Wheel groups

The file has four `e_wheel_*` elements under `e_wheels`, each with four
children. The element matrix is translation-only; these translations are used
verbatim:

| group | source name | translation (x, y, z) | proven draws | ambiguous |
| --- | --- | --- | --- | --- |
| front-left | `e_wheel_frontleft` | `(-0.774300, 0.000000, 1.239200)` | 40, 41, 74 | 7, 11 |
| front-right | `e_wheel_frontright` | `( 0.774300, 0.000000, 1.239200)` | 38, 39, 72 | 10, 12 |
| back-left | `e_wheel_backleft` | `(-0.774335, 0.000000, -1.239249)` | 8, 13, 36, 37, 71 | — |
| back-right | `e_wheel_backright` | `( 0.774335, 0.000000, -1.239249)` | 9, 14, 42, 43, 73 | — |

Tyre assignment is proven by the exact union of a tread draw and a sidewall
draw against the tyre element's local bounds:

| tyre element | tread draw | sidewall draw | union difference |
| --- | ---: | ---: | ---: |
| `E_Tyre_FrontLeft` | 40 | 41 | 0.000343 |
| `E_Tyre_FrontRight` | 39 | 38 | 0.000343 |
| `E_Tyre_BackLeft` | 36 | 37 | 0.000648 |
| `E_Tyre_BackRight` | 43 | 42 | 0.000648 |

Rims, rear discs and rear calipers match one element each (differences
0.00009–0.00043 m). Front discs (11, 12) and front calipers (7, 10) have
**byte-identical** left/right element-local bounds (`E_BrakeDisc_FrontLeft` vs
`…FrontRight`, `E_BrakeCaliper_FrontLeft` vs `…FrontRight`), so their side is
not provable. They are emitted as `partKind:"unclassified"` draw records with
the reason and are paired to the two front wheels only for the preview
(`previewPartId`), never as a corner proof.

**Spin axis.** Wheel and rim local bounds are thin on X (wheel ±0.16…0.21,
rim ±0.22) and round on Y/Z (±0.34 / ±0.23); the wheel matrix's first axis is
therefore the axle. Upstream
`code/amax/game/Game/GameActors/Vehicles/VehicleActor.cpp` at commit
`5270304b`:

- lines 5158–5167 compute `blur2pcSpinRate` about `wheelMatrix.AX()`;
- lines 5170–5196 write that wheel matrix for `Tyre`, `AlloyRim` and
  `BrakeDisc`;
- line 5198 states “Brake calipers mustn't rotate”.

The viewer therefore spins tyre, rim and disc about element-local `+X` and
keeps the caliper static. The axis is also recorded in
`wheelGroups[].spin` with this source reference.

`Alloy` (the separate cosmetic wheel model resource) is **not** in this model's
MdlDat; only the in-model `E_AlloyRim_*` elements are present, so no external
wheel resource is claimed or loaded.

### 4.2 Glass

| part | draw | element-bounds difference |
| --- | ---: | ---: |
| `glass.e_window_front` | 76 | 0.000599 |
| `glass.e_window_back` | 75 | 0.001692 |
| `glass.e_window_left` | 77 | 0.001381 |
| `glass.e_window_right` | 78 | 0.001381 |

The names and bounds are the file's own. The material binding is
`_NO_ALBEDO`/runtime; the glass shader, blend and texture are **not** decoded.
“Glass” here means the named window element, not a recovered material.

### 4.3 Lights

18 draws match 14 named light elements. Four signal lights have two draws each
(lens/housing), hence 8 + 10 = 18:

| part | draws | part | draws |
| --- | --- | --- | --- |
| `E_Headlight_Left` | 70 | `E_Headlight_Right` | 69 |
| `e_RearLight_Left` | 44 | `e_RearLight_Right` | 45 |
| `e_BrakeLight_Left` | 49 | `e_BrakeLight_Right` | 50 |
| `e_ReverseLight_Left` | 51 | `e_ReverseLight_Right` | 48 |
| `e_SignalLight_FrontLeft` | 17, 31 | `e_SignalLight_FrontRight` | 18, 32 |
| `e_SignalLight_BackLeft` | 20, 34 | `e_SignalLight_BackRight` | 19, 33 |
| `e_Spotlight_FrontLeft` | 46 | `e_Spotlight_FrontRight` | 47 |

All 10 draws the committed reader classifies as `runtime_light_blend`
(44–51, 69, 70) are in this set, which corroborates the element-bound names.
Differences are 0.0014–0.0223 m; the largest is the signal-light housing.

### 4.4 Body and interior shells

- `body.shell` — 26 draws, 20,325 triangles, contained in `e_exterior`
  (nearest containing element; the shell spans multiple panels).
- `interior.shell` — 6 draws, 4,030 triangles, nearest containing element in
  the `e_interior` subtree.
- `body.e_licenseplate_front/back` (draws 22 / 23, 24) and
  `body.e_mirror_left/right` (57 / 53) have tight element matches and are named.
- `interior.e_SteeringWheel` is draw 35 (difference 0.000431).

The 32 shell draws are **group-proven** (the branch is known) but are not given
a leaf panel name. This is the honest limit of AABB matching when one draw
spans several elements.

### 4.5 Unclassified draws

| draw | wheel part | candidates | reason |
| ---: | --- | --- | --- |
| 7 | brake caliper | `E_BrakeCaliper_FrontLeft/Right` | identical left/right local bounds |
| 10 | brake caliper | `E_BrakeCaliper_FrontLeft/Right` | identical left/right local bounds |
| 11 | brake disc | `E_BrakeDisc_FrontLeft/Right` | identical left/right local bounds |
| 12 | brake disc | `E_BrakeDisc_FrontLeft/Right` | identical left/right local bounds |

They are still rendered: `previewDraws` in the two front wheel groups assigns
one disc and one caliper to each front wheel with a deterministic sort. The
manifest labels this `previewAssignment`; it is not a proof.

### 4.6 Full part list

| part id | kind | source name | draws | tris | proof |
| --- | --- | --- | ---: | ---: | --- |
| `body.e_licenseplate_back` | body | `e_licenseplate_back` | 2 | 64 | element-bounds |
| `body.e_licenseplate_front` | body | `e_licenseplate_front` | 1 | 64 | element-bounds |
| `body.e_mirror_left` | body | `e_mirror_left` | 1 | 355 | element-bounds |
| `body.e_mirror_right` | body | `e_mirror_right` | 1 | 355 | element-bounds |
| `body.shell` | body | — | 26 | 20,325 | branch-containment |
| `glass.e_window_back` | glass | `e_window_back` | 1 | 134 | element-bounds |
| `glass.e_window_front` | glass | `e_window_front` | 1 | 112 | element-bounds |
| `glass.e_window_left` | glass | `e_window_left` | 1 | 41 | element-bounds |
| `glass.e_window_right` | glass | `e_window_right` | 1 | 41 | element-bounds |
| `interior.e_SteeringWheel` | interior | `e_SteeringWheel` | 1 | 532 | element-bounds |
| `interior.shell` | interior | — | 6 | 4,030 | branch-containment |
| `light.E_Headlight_Left` | light | `E_Headlight_Left` | 1 | 160 | element-bounds |
| `light.E_Headlight_Right` | light | `E_Headlight_Right` | 1 | 160 | element-bounds |
| `light.e_BrakeLight_Left` | light | `e_BrakeLight_Left` | 1 | 42 | element-bounds |
| `light.e_BrakeLight_Right` | light | `e_BrakeLight_Right` | 1 | 42 | element-bounds |
| `light.e_RearLight_Left` | light | `e_RearLight_Left` | 1 | 56 | element-bounds |
| `light.e_RearLight_Right` | light | `e_RearLight_Right` | 1 | 56 | element-bounds |
| `light.e_ReverseLight_Left` | light | `e_ReverseLight_Left` | 1 | 42 | element-bounds |
| `light.e_ReverseLight_Right` | light | `e_ReverseLight_Right` | 1 | 42 | element-bounds |
| `light.e_SignalLight_BackLeft` | light | `e_SignalLight_BackLeft` | 2 | 18 | element-bounds |
| `light.e_SignalLight_BackRight` | light | `e_SignalLight_BackRight` | 2 | 18 | element-bounds |
| `light.e_SignalLight_FrontLeft` | light | `e_SignalLight_FrontLeft` | 2 | 18 | element-bounds |
| `light.e_SignalLight_FrontRight` | light | `e_SignalLight_FrontRight` | 2 | 18 | element-bounds |
| `light.e_Spotlight_FrontLeft` | light | `e_Spotlight_FrontLeft` | 1 | 70 | element-bounds |
| `light.e_Spotlight_FrontRight` | light | `e_Spotlight_FrontRight` | 1 | 70 | element-bounds |
| `wheel.backleft` | wheel | `e_wheel_backleft` | 5 | 2,332 | element-name+matrix+bounds |
| `wheel.backright` | wheel | `e_wheel_backright` | 5 | 2,332 | element-name+matrix+bounds |
| `wheel.frontleft` | wheel | `e_wheel_frontleft` | 5 | 2,332 | element-name+matrix+bounds |
| `wheel.frontright` | wheel | `e_wheel_frontright` | 5 | 2,332 | element-name+matrix+bounds |

### 4.7 Roster car manifests (P29)

The same builder, run on each car's own model, produces a complete manifest with
the same schema. Every draw is owned exactly once; there are no unclassified
*parts* (a draw that matched no element would be `unclassified.<n>`, and none
occurred).

| car | draws | parts | named parts | wheel draws | proven wheel | ambiguous wheel | proven draws | tyre tier |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Corvette ZR1 | 100 | 34 | 30 | 20 | 10 | 10 | 90 | union |
| Lotus Exige Cup260 | 88 | 23 | 19 | 20 | 8 | 12 | 76 | union |
| Dodge Challenger | 104 | 31 | 27 | 20 | 4 | 16 | 88 | union |
| Ford Focus RS | 115 | 31 | 27 | 20 | 0 | 20 | 95 | union |
| Audi R8 V10 | 84 | 29 | 25 | 20 | 4 | 16 | 68 | containment |

Wheel evidence per car (all four groups, all four member kinds):

| car | tyre draws | rim | disc | caliper | wheel element names |
| --- | ---: | ---: | ---: | ---: | --- |
| Corvette ZR1 | 8 | 4 | 4 | 4 | `e_Tyre_*`, `e_alloyRim_*`, `e_BrakeDisc_*`, `e_BrakeCaliper_*` |
| Lotus Exige Cup260 | 8 | 4 | 4 | 4 | `e_Tyre_*` (incl. `e_Tyre_RearRight`), `e_alloyRim_*`, `e_BrakeDisc_*`, `e_BrakeCaliper_*` |
| Dodge Challenger | 8 | 4 | 4 | 4 | `e_Tyre_*`, `e_AlloyRim_*`, `e_BrakeDisc_*`, `e_BrakeCaliper_*` |
| Ford Focus RS | 8 | 4 | 4 | 4 | `E_Tyre_*`, `e_alloyRim_*`/`e_AlloyRim_*`, `e_BrakeDisc_*`, `e_BrakeCaliper_*` |
| Audi R8 V10 | 8 | 4 | 4 | 4 | `E_Tyre_*`, `E_AlloyRim_*`, `e_BrakeDisc_*`, `e_BrakeCaliper_*` |

Spelling differs per asset (`E_`/`e_`, `alloyRim`/`AlloyRim`), so the kind rule
is a case-insensitive prefix on the serialized name; the original spelling is
kept in every record. The wheel axis proof is measured per car: the group's
member union bounds are thinnest on X and round on Y/Z within 10% (the Audi's
tyre is 5% taller than wide, so 3% would have failed). `+X` is recorded with the
measured extents in `wheelGroups[].spin.axisEvidence`.

Proof quality varies with the asset, which is why the per-car numbers differ:

- **Corvette ZR1** — back tyres/rims and back calipers are corner-proven; both
  front tyres share identical element bounds (front pair ambiguous), the front
  rims differ by only 3 mm (ambiguous), and the discs are identical front/back
  (axle ambiguous, side provable).
- **Lotus** — all four tyre element boxes are nearly identical, so every tyre is
  ambiguous; the second (inner sidewall) draw per tyre is only contained, so all
  eight tyre draws are preview-paired. Rims and discs are similarly close.
  All 12 ambiguous wheel draws are decoded tyre/rim geometry, not body panels.
- **Dodge** — tyres and rims are front/back-identical within 3 mm, so 16 wheel
  draws are preview-paired; no draw was left unclassified.
- **Ford Focus** — every wheel part is identical within 4 mm between its front
  and back element, so all 20 wheel draws are preview-paired. This is the honest
  limit of AABB evidence on a symmetric wheel set.
- **Audi** — no union of its tyre draws reproduces the element bounds (the
  element box is 2–5 cm larger than the geometry), so the tyre tier is
  `containment`; each corner still gets two tyre draws (one wide, one narrow) by
  a deterministic equal-share pairing, labelled preview-only.

The `unclassified` label therefore means *identity not proven*, never *geometry
not drawn*: every wheel draw stays on its wheel node and spins, and the manifest
records `previewPartId` plus the candidate elements.

---

## 5. Browser preview

The standalone preview draws the Corvette C3 manifest by default (it is the
committed `_work/car-parts/manifest.json`); the per-car manifests are consumed
by the E1 drive slice, not by this page.

`probes/car-parts/web/` is standalone:

- `index.html` / `style.css` — overlay HUD, legend, wheel panel, controls;
- `math.js` — column-major camera/matrix helpers adapted from the committed
  packet consumer;
- `renderer.js` — WebGPU pipeline, one mesh upload, 80 dynamic draws per frame,
  diagnostic colours, wheel spin, local-angle spin marker;
- `app.js` — loads the manifest + mesh, drives the UI and publishes
  `window.carPartsProbe` for the capture gate.

Colours: tyre = wheel-corner colour, rim = silver, brake disc = red, caliper =
yellow (static), glass = cyan, lights = yellow, body/interior = blue/orange.
The local-angle band on spinning wheel members is a diagnostic marker so the
rotation is visible on rotationally symmetric geometry; it is not a material.

Commands (bundled Python/Node):

```powershell
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"

& $py   probes/car-parts/tools/build_manifest.py
& $node probes/car-parts/tools/capture_browser.mjs
& $py   probes/car-parts/tools/verify_manifest.py
& $node probes/car-parts/tools/serve.mjs        # http://127.0.0.1:8806/
```

Headless Edge (`--headless=new --enable-unsafe-webgpu`) at 1600×900, five
captures:

| file | URL query | what it shows |
| --- | --- | --- |
| `_work/car-parts/browser-parts-angle090.png` | `angle=0.9&spin=0&yaw=0.95&pitch=0.27&dist=7.6` | 3/4 front-right, wheels at +0.9 rad, marker bands rotated |
| `_work/car-parts/browser-parts-angle000.png` | `angle=0&spin=0&yaw=0.95&pitch=0.27&dist=7.6` | same view, wheels at 0 rad |
| `_work/car-parts/browser-parts-side.png` | `angle=0&spin=0&yaw=1.5708&pitch=0.02&dist=8.6` | right-side view; front-right/back-right tyres use their corner colours |
| `_work/car-parts/browser-parts-rear.png` | `angle=0.55&spin=0&yaw=-2.25&pitch=0.33&dist=7.4` | rear 3/4, rear lights/wing and back wheels |
| `_work/car-parts/browser-parts-angle090-repeat.png` | same as first | identical bytes, determinism check |

Measured in `_work/car-parts/browser-evidence.json`:

- each capture: `parts=29`, `draws=80`, `provenDrawCount=76`,
  `unclassifiedDrawCount=4`, `wheelDrawCount=20`, 4 wheel groups,
  `geometryUploads=2`, `drawsIssued = frame × 80`;
- **console: 0 messages of any kind** (no errors, warnings or logs);
- repeated fixed-angle screenshot: byte-identical
  (`7a9107ed…4e6a`), stable probe;
- adapter: `nvidia / blackwell`;
- pixel difference between wheel angle 0 and 0.9 rad: **7,149** pixels above
  the threshold; the side view has 103,482 non-background pixels.

![Corvette parts at wheel angle 0.9 rad](../../../_work/car-parts/browser-parts-angle090.png)

*`_work/car-parts/browser-parts-angle090.png`: 29 parts, four wheel groups, diagnostic colours, wheels at +0.9 rad.*

Screenshot hashes:

| file | SHA-256 |
| --- | --- |
| `browser-parts-angle090.png` | `7a9107ed31449e1d790364db7fd6fe48545b219786f4cab926d5fa2642404e6a` |
| `browser-parts-angle000.png` | `34d001da66c195031f2166f1c8b0b1b8ce9a39655d398aea4a413eb8289d8ac5` |
| `browser-parts-side.png` | `311dfb770251f1a82c241b5a48058c273b28746453917c6347446dd91e0a3f1f` |
| `browser-parts-rear.png` | `b2dd4ed70b41696bbb14b45ecd2750780e543eb2b9cb701d7c2e0a71c1bc84c6` |
| `browser-parts-angle090-repeat.png` | `7a9107ed…4e6a` (identical to the first) |

---

## 6. Determinism and verification

`verify_manifest.py` runs `build_manifest.py` twice into separate directories
and compares:

- `manifest.json` byte-identical (C3 SHA-256 `5df83a6b…ede5dbf`);
- `mesh.json` byte-identical (`05605c87…61c9f3`);
- `scene-report.json` byte-identical (`cfc88cb4…7d7b73`);
- the same three files for a non-C3 roster car (Corvette ZR1) and that the
  rebuilt manifest equals the committed per-car one;
- all 80 C3 draws owned by exactly one part; no duplicate/omitted draw;
- for every roster manifest: kind/version, draw ownership, wheel kind counts,
  four wheel groups with `+X` and measured axis evidence, tyre union arithmetic,
  mesh value hashes, mapping text and pak path;
- the five roster models are distinct and the five body mesh hashes are distinct;
- 76 proven / 4 unclassified for the C3;
- browser evidence: 5 captures, clean console, 2 geometry uploads,
  `frame × 80` draws, identical repeat screenshot, non-blank side view.

Result: **PASS**, 0 failures (`_work/car-parts/verify.json`,
SHA-256 `40f48beb…f627dc`, five mapped cars).

Artifacts:

| path | content |
| --- | --- |
| `_work/car-parts/manifest.json` | C3: 29 parts / 80 draws / wheel groups / MdlDat records |
| `_work/car-parts/mesh.json` | C3: 30,591 positions, 108,579 U32 indices |
| `_work/car-parts/scene-report.json` | exact `scene_inspect.exe` output |
| `_work/car-parts/cars/index.json` | roster mapping, per-car hashes and counts |
| `_work/car-parts/cars/<slug>/` | one manifest + mesh + scene report per car |
| `_work/car-parts/models/` | decoded per-car models + `.source.json` pak provenance |
| `_work/car-parts/browser-evidence.json` | per-capture probe/console/hashes |
| `_work/car-parts/verify.json` | verification result |
| `_work/car-parts/verify-a`, `verify-b`, `verify-car-a`, `verify-car-b` | independent build outputs |
| `_work/logs/car-parts/` | build/capture/verify logs |

The manifest also records the exact `model_inspect.exe` chunk tree
(`Model` at 4/3,155,245; `Header` 20/20; `MdlDat` 40/10,933; `Render`
10,973/3,115,004; `Coll` 3,125,977/29,272; `MtaDbg` 3,155,249/13,963), so the
MdlDat parser is cross-checked against the committed model reader.

---

## 7. Limits

- **First RenderList, LOD0 only.** Later render lists, higher LODs, damage,
  paint variants and runtime light states are not imported. The 80-draw scene
  report is the committed reader's explicitly partial output.
- **Draw→part identity is AABB evidence, not a render-mesh id.** All 71
  elements carry `m_RenderMeshId = -1`; the first RenderList node name is empty.
  The manifest therefore relies on measured bounds and records every difference.
  A draw can be proven to belong to a shell branch without a leaf panel name;
  that is reported as `branch-containment`, not as a guessed part.
- **32 shell draws have no leaf name.** `body.shell` (26) and `interior.shell`
  (6) are proven groups, not per-panel names.
- **Four C3 wheel draws are side-ambiguous.** Front brake discs and calipers
  have identical left/right element-local bounds. Their `partKind` is
  `unclassified`; the preview pairing is deterministic but explicitly not a
  proof. No “front-left” label is claimed for those draws.
- **Per-car wheel ambiguity is larger and is reported, not hidden.** The ZR1
  has 10 ambiguous wheel draws, the Lotus 12, the Dodge 16, the Focus 20 and
  the Audi 16 (see §4.7). In those cases the draw keeps its wheel part kind but
  its corner is `unclassified` and only paired for drawing. That keeps the
  rendered wheel count and placement correct while claiming nothing the bounds
  do not prove.
- **The Audi tyre tier is `containment`.** Its tyre element boxes are 2–5 cm
  larger than any union of the tyre draws, so draws are only proven to lie
  inside the element; the equal-share pairing is preview-only.
- **Element matrices are recorded, never decomposed.** In every gated asset the
  DefaultModel linear part is identity within float32 noise (worst measured
  deviation 9.1e-6 on one Audi plate). A real rotation/scale would appear in
  `linearIdentity`/`linearDeviation` and in `matrixColumnMajor`; no camber, toe,
  suspension travel, steering or damage rotation is applied.
- **The caliper is kept static.** This follows the source comment
  `VehicleActor.cpp:5198`; the per-element runtime assignment for every other
  vehicle part is not reconstructed.
- **Diagnostic rendering.** Flat per-part colours, one directional light,
  derivative normals, no textures, shadows, post, particles or shader fidelity.
  The spin marker band is a viewer aid, not a game material.
- **The body/interior split is branch-based.** A draw contained in
  `e_interior` may be a trim piece; no material semantics are decoded.
- **No engine integration, no game claim.** This manifest is a candidate input
  for a later draw list; it does not prove retail placement, animation,
  collision, paint, damage or gameplay.

---

## 8. Next step

**Done in P29.** The E1 drive packet now consumes one manifest per roster car:
each car's own body mesh, parts and wheel groups, with `tyre/rim/disc` spun by
that car's physics wheel angular velocity and `brakeCaliper` static
(`docs/work/verification/T-007-per-car-meshes.md`). The separate
`\models\vehicles\wheels\<car>.model` cosmetic resource is still not used; the
body model's own `e_wheel_*` subtree supplies the wheels.

Remaining open items:

1. recover the actual per-element wheel matrices from the vehicle runtime
   (suspension, steer, camber) instead of the rest-pose `MdlDat` translation;
2. resolve the side/axle-ambiguous wheel draws from a render-list
   instance/order field we have not parsed (or from the separate wheel resource);
3. add the separate `Alloy` wheel model resource if the cosmetic rim is needed
   for the PoC;
4. only then claim retail-level car appearance in the E1 drive slice.
