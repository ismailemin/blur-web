# Hummer H2 OffRoad — part-layer resolution

**Date:** 8 November 2026
**Owner:** V4 (sub-agent), data/tooling only
**Scope:** `probes/car-parts/**`, `_work/vehicle-pipeline/**`, `_work/logs/vehicle-pipeline/**` and this document. No e1-drive, car-materials, asset-reader, vehicle-pipeline tool, `tools/`, `upstream/` or `game-data/` change.
**Record:** `Hummer_H2_OffRoad`, index 60, id 3340562994, AWD, 2500 kg, model `\models\vehicles\hummer_h2_offroad.model`.

## Result

**Resolution: absent.** The brake caliper is not a separate node, not a differently
named member and not a differently parented node. The vehicle model has no
caliper element at all. The committed builder now treats that as a **typed
absence**: each wheel group keeps its three proven members (`tyre`, `rim`,
`brakeDisc`) and records `caliper:"absent"` with a diagnostic. No caliper mesh is
invented, borrowed or substituted.

A complete staged manifest exists at
`_work/vehicle-pipeline/manifests/hummer-h2-offroad/`. It is **not** an E1 roster
entry and no drive or full-game claim is made.

The 62-car matrix row for #60 in `docs/work/analysis/vehicle-pipeline.md` is
updated from `B` to `B†` with `staged` in the `next` column; the footnote and
§7.1 point here. The generated V1 `cars.json`/`summary.csv`/`hashes.json` were
not regenerated.

## 1. Model and reader evidence

| item | value |
| --- | --- |
| model pak path | `\models\vehicles\hummer_h2_offroad.model` |
| decoded file | `_work/vehicle-pipeline/models/0e7f968b4df63a1df51d0f6a7a79f22e1f7565545756123d1d57d46d22d29869.decoded` |
| decoded bytes | 4,124,730 |
| SHA-256 | `0e7f968b4df63a1df51d0f6a7a79f22e1f7565545756123d1d57d46d22d29869` |
| MdlDat | 12,345 bytes, 21 models, 80 elements, 4 wheel groups |
| model 0 `DefaultModel` | 58 elements |
| Scene reader | 98 draws, 35,921 triangles, 33,879 vertices, partial traversal (`partialSceneTraversal:true`) |
| physics gate | pass |

Element/parent evidence comes from the committed `build_manifest.parse_mdldat`
parser, dumped read-only with `probes/car-parts/tools/dump_model_parts.py`.
The body dump is `_work/vehicle-pipeline/hummer-h2-offroad-body-parts.json`
(SHA-256 `d8dd98ac63fba9724e35e86b38c009aee42170563b756996ad4317a75652d5d9`).

## 2. Is the caliper a separate node, another name, or absent?

`DefaultModel` has exactly four `e_wheel_*` parents and twelve direct wheel
children:

| corner | members | parents |
| --- | --- | --- |
| frontleft | `e_tyre_frontLeft`, `e_alloyRim_frontLeft`, `E_BrakeDisc_FrontLeft` | `e_wheel_frontleft` (element 1) |
| frontright | `e_tyre_frontRight`, `e_alloyRim_frontRight`, `E_BrakeDisc_FrontRight` | `e_wheel_frontright` (element 2) |
| backleft | `e_tyre_backLeft`, `e_alloyRim_backLeft`, `E_BrakeDisc_backLeft` | `e_wheel_backleft` (element 3) |
| backright | `e_tyre_backRight`, `e_alloyRim_backRight`, `E_BrakeDisc_backRight` | `e_wheel_backright` (element 4) |

There are **zero** `e_brakecaliper_*` elements. Searching all 80 element names
finds only `e_brakeLight_Left/Right` and the four `E_BrakeDisc_*`; no caliper
name exists anywhere, including the collision, shadow and bone models.

The separate wheel resource
`\models\vehicles\wheels\hummer_h2_offroad.model` (108,594 bytes, SHA-256
`f75df742634b570e3631824891d58349655c03957b84050cc73f2b4f87210d2a`) has only
two models and three elements: `DefaultElement`, `m_Alloy`, `e_alloyblur`. It is
a cosmetic alloy/rim resource, not a caliper source. The pak has **no**
caliper-named entry (`_work/logs/vehicle-pipeline/hummer-pak-search.log`).

Comparison with the expected structure:

| asset | model 0 elements | wheel parents | wheel members | direct wheel children | caliper elements |
| --- | ---: | ---: | ---: | ---: | ---: |
| `Hummer_H2_OffRoad` | 58 | 4 | 12 | 12 | **0** |
| `Corvette_ZR1_Stock` | — | 4 | 16 | 16 | 4 |
| `Dodge_Challenger_Stock` | — | 4 | 16 | 16 | 4 |
| `Ford_FocusRS_Stock` | — | 4 | 16 | 16 | 4 |
| `Lotus_ExigeCup260_Stock` | — | 4 | 16 | 16 | 4 |
| `Audi_R8V10_Stock` | — | 4 | 16 | 16 | 4 |
| `Hummer_H2_Rat` (sibling) | 51 | 4 | 16 | 14 | 4 by name (1 parented to `DefaultElement`) |

The five proven cars each have 4 tyre + 4 rim + 4 disc + 4 caliper, and every
caliper is a direct child of its `e_wheel_*` parent. The sibling
`hummer_h2_rat.model` (SHA-256
`b12739764d20c79e81ce84088f9c4293b7731c4648c39a1ef610a9be2527f8f9`, dump
`_work/vehicle-pipeline/hummer-h2-rat-body-parts.json`, SHA-256
`43fb66e9139b33406fa55f9999dde0a39f8d2322bf983b558bd0c8f1bb0e7b1d`) has
`E_BrakeCaliper_*` elements, proving the vehicle family carries caliper nodes.
It is not a valid template: `E_BrakeCaliper_FrontRight1` and
`E_BrakeDisc_FrontRight1` are `DefaultElement` children, and its front-left
corner has no disc/caliper. It is comparison evidence only.

**Conclusion:** the OffRoad caliper is genuinely absent at the part layer. It is
not a renamed node, not a child of another parent, and not in the wheel resource.
The original blocker was exactly
`wheel frontleft members are ['brakeDisc', 'rim', 'tyre'], expected ['brakeCaliper', 'brakeDisc', 'rim', 'tyre']`.

## 3. `cali_01` is a license-plate texture, not caliper geometry

The independent material traversal lists `cali_01` as a referenced shared
texture. That name alone is not part identity. Its two draws are small
10-triangle plates fully inside the license-plate elements:

| draw | first index | triangles | texture | containing element | local AABB |
| ---: | ---: | ---: | --- | --- | --- |
| 42 | 49,329 | 10 | `cali_01` | `e_licenseplate_back` | min `[-0.1818, 0.1250, -2.3496]`, max `[0.1818, 0.3259, -2.3438]` |
| 87 | 98,769 | 10 | `cali_01` | `e_licenseplate_front` | min `[-0.1818, 0.2156, 2.3770]`, max `[0.1818, 0.4165, 2.3828]` |

They sit at the rear/front plate positions (Z ≈ −2.35 and +2.38), not at the
wheel corners. The four `breakdisc` draws (35–38, 60 triangles each) are thin,
symmetric discs inside the four `E_BrakeDisc_*` boxes. No draw can be attributed
to a caliper.

## 4. Builder rule

`probes/car-parts/tools/build_manifest.py` now accepts an absent caliper only
under this measured condition:

- model 0 has **zero** `e_brakecaliper_*` elements; and
- each wheel group has exactly `tyre`, `rim`, `brakeDisc` as direct children.

The group then records:

```json
"caliper": "absent",
"absentMembers": [{"wheelPart": "brakeCaliper", "reason": "...", "evidence": "..."}],
"spin": {"staticMembers": [], "absentMembers": ["brakeCaliper"], ...}
```

and the manifest records `diagnostics.absentWheelParts:["brakeCaliper"]` plus a
limit statement. A renamed, merged, partially present or differently parented
caliper still raises `Unsupported`. The shared verifier
`probes/car-parts/tools/verify_manifest.py` accepts the declared absence but
still requires `caliper:"absent"`, three members, no caliper draw and empty
`staticMembers`.

This is a documented fallback, not a silent one: every group and the manifest
diagnostics state the absence.

## 5. Staged manifest

Built with the committed builder into
`_work/vehicle-pipeline/manifests/hummer-h2-offroad/`, outside the E1 roster:

| item | value |
| --- | ---: |
| draws | 98 |
| parts | 36 (35 named; 4 are wheel groups; 1 unnamed body shell) |
| non-wheel parts | 32 |
| wheel groups | 4 |
| wheel draws | 16 (8 tyre, 4 rim, 4 disc, 0 caliper) |
| proven draws | 82 |
| preview-only wheel draws | 16 (0 proven) |
| body draws | 55 |
| light / glass / interior draws | 20 / 6 / 1 |
| UV0 buffers | 7 of 11 available, 11,783 valid vertices, 58/98 draws with UV0 |
| unique referenced textures | 6 |
| static-albedo / light / no-albedo draws | 23 / 20 / 55 |
| resource-block texture RGBA estimate | 2,097,152 bytes (2 × 512×512×4) |
| texture source bytes | 464,544 |

Every wheel group has `caliper:"absent"` and members
`["brakeDisc","rim","tyre"]`. The measured spin axis is element-local +X:
member union extent `[0.3784, 0.8741, 0.8747]`, thin X, round Y/Z
(relative delta 0.000609). Group translations are
`(-0.914971, 0.000036, 1.579840)` frontleft,
`(0.915000, 0.000036, 1.579840)` frontright,
`(-0.914971, 0.000036, -1.579800)` backleft,
`(0.915000, 0.000036, -1.579800)` backright.

All 16 wheel draws are preview-paired only because the four corners have
identical/nearly identical local bounds. The wheel group is complete and
drawable, but the per-corner identity is not proven, the same medium-confidence
tier as the Bronco, Skyline and SoCal HHR manifests.

The six textures are `hummer_1`, `hummer_alpha`, `tyretred_offroad`, `tyrewall`,
`cali_01` and `breakdisc`. `cali_01` is the plate texture described above, not a
caliper.

## 6. Verification

| check | result |
| --- | --- |
| `probes/car-parts/tools/verify_staged_manifest.py` | PASS, 0 failures |
| two independent builds | byte-identical manifest, mesh and scene report |
| present-caliper regression (Audi R8) | rebuilt manifest SHA-256 equals the committed manifest exactly |
| `probes/vehicle-pipeline/tools/verify_vehicle_pipeline.py` | PASS 542/542, 0 failures |
| full `verify_manifest.py --skip-build` | FAIL, pre-existing: the committed car index has 15 cars while the tool asserts five, and `audi-tt-stock` has an existing tyre row without draws; unrelated to this change |
| shared `verify_manifest.verify_manifest` on Audi R8 / Corvette ZR1 / Dodge Challenger | 0 failures each |

The vehicle-pipeline verifier was run against the existing V1 audit artifact;
the V1 `cars.json`/`summary.csv`/`hashes.json` were **not** regenerated. The
staged resolution is recorded here and in §7.1 of
`docs/work/analysis/vehicle-pipeline.md`.

## 7. Hashes and evidence paths

| artifact | bytes | SHA-256 |
| --- | ---: | --- |
| `_work/vehicle-pipeline/manifests/hummer-h2-offroad/manifest.json` | 331,188 | `7f4166c5a91a103fc0f69c400a0098d63bfdf5a4a85683e7c4562f47a2b9a56d` |
| `_work/vehicle-pipeline/manifests/hummer-h2-offroad/mesh.json` | 1,827,862 | `7d593cebc0bd551f52da4cfd65951a66ec13f8a84b28cebc210ea2584ba9954f` |
| `_work/vehicle-pipeline/manifests/hummer-h2-offroad/scene-report.json` | 2,193,670 | `08ff8fba25a055fe6eca565f11bdda06fb98dd6e72619137ad8269430c337784` |
| `_work/vehicle-pipeline/hummer-h2-offroad/staging-verify.json` | 3,298 | `6b70b3df5125cba01b8f4a2497ae243d4383da7456617f6275a3ddf0d7472722` |
| `_work/vehicle-pipeline/hummer-h2-offroad/resolution.json` | 12,461 | `50fe528a54606f4f8b16ee49115125731ed4b83a862d39687397f217eaffd20f` |
| `_work/vehicle-pipeline/hummer-h2-offroad-body-parts.json` | 33,095 | `d8dd98ac63fba9724e35e86b38c009aee42170563b756996ad4317a75652d5d9` |
| `_work/vehicle-pipeline/hummer-h2-offroad-wheels-parts.json` | 1,963 | `73ea794206207ec3f5c58aff87876c7c181e9afd325352c4fd712ae7b859f8e5` |
| `_work/vehicle-pipeline/hummer-h2-rat-body-parts.json` | 29,704 | `43fb66e9139b33406fa55f9999dde0a39f8d2322bf983b558bd0c8f1bb0e7b1d` |
| `_work/vehicle-pipeline/hummer-h2-offroad-draws.json` | 39,543 | `9d7c133007947656ff5e559ada3cf13b8a1b0bd2fbb8f83669572c1c15079007` |
| `_work/vehicle-pipeline/materials/hummer-h2-offroad/corvette-materials.json` | 547,523 | `79e65d2a7a599dbefee6cae8fc482e33c97cae863464179ef1179e00608a6ea0` |
| `_work/vehicle-pipeline/materials/hummer-h2-offroad/corvette-uv0.json` | 328,502 | `b2635752c1efe73c84689748e1f200782dbd1436964e2dfd85e335f825e6c10d` |

Logs: `_work/logs/vehicle-pipeline/hummer-manifest-build.json`,
`_work/logs/vehicle-pipeline/hummer-staging.log`,
`_work/logs/vehicle-pipeline/hummer-verify.log`,
`_work/logs/vehicle-pipeline/hummer-pak-search.log`.
Determinism directories: `_work/vehicle-pipeline/verify-hummer-a`,
`_work/vehicle-pipeline/verify-hummer-b`; regression:
`_work/vehicle-pipeline/verify-r8`.

## 8. Batch 2 readiness

**Can join batch 2: yes, as a manifest-complete medium-confidence car.** The
blocker is resolved without inventing geometry, the manifest covers all 98 draws
exactly once, has four valid wheel groups, UV0 on 58 draws and six resolved
textures. The remaining work is integration, not format work:

- E1 roster entry (chunking/batch 2 owns it);
- P52 committed material/texture manifest (only the independent traversal exists);
- geometry pins and ghost files;
- browser capture and drive verification.

The 16 preview-only wheel draws mean corner identity is not proven; batch 2 must
keep that label. This is the same limitation as several already-staged B cars,
not a new blocker.

## 9. Limits

- No E1 roster, drive, geometry-pin, ghost or browser claim.
- No full-game claim.
- The V1 62-car audit artifact was not regenerated; the matrix row and §7.1 are
  the documented resolution.
- Wheel corner identity is preview-only (all 16 wheel draws ambiguous).
- `cali_01` is a license-plate texture, not caliper evidence.
- The sibling `hummer_h2_rat.model` has caliper elements but is not a template:
  one is a `DefaultElement` child and its front-left corner lacks disc/caliper.
- The staged manifest is outside the committed E1 drive tree and must not be
  treated as a proven playable car.
