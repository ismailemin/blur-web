# probes/car-parts — per-car part manifests + WebGPU wheel preview

Builds deterministic, evidence-backed part manifests from real vehicle `.model`
files, and renders one of them (the Corvette C3 by default) in a standalone
WebGPU page with per-part diagnostic colours and four spinning wheels.

Nothing here is engine code and nothing here edits the committed probes:

- geometry comes from `probes/asset-reader` (`scene_inspect.exe`);
- chunk provenance comes from `probes/asset-reader` (`model_inspect.exe`);
- part names, element matrices and bounds come from the same file's `MdlDat`
  block, parsed with the documented `C_ModelData::Read` layout;
- the shader/pipeline/dynamic-uniform pattern is adapted from
  `probes/e1-drive/web/packet-consumer.js` (itself a copy of
  `probes/render-packet/web/packet-consumer.js`) into `web/renderer.js`.

No game integration, no gameplay, no material fidelity is claimed.

## Cars

`build_all_manifests.py` maps each E1 roster car to its own `root.pak` model and
builds one manifest per car. Mapping is one rule: the roster name lowercased plus
`.model` must match exactly one `\models\vehicles\*.model` entry. Variant
candidates (`_race`, `_legend_*`, `_tuner`, …) and the separate
`\models\vehicles\wheels\<name>.model` resource are recorded, not used.

| slug | pak model | draws | parts | wheel draws | tyre proof |
| --- | --- | ---: | ---: | ---: | --- |
| `corvette-zr1-stock` | `corvette_zr1_stock.model` | 100 | 34 | 20 | union |
| `lotus-exige-cup260-stock` | `lotus_exigecup260_stock.model` | 88 | 23 | 20 | union |
| `dodge-challenger-stock` | `dodge_challenger_stock.model` | 104 | 31 | 20 | union |
| `ford-focusrs-stock` | `ford_focusrs_stock.model` | 115 | 31 | 20 | union |
| `audi-r8v10-stock` | `audi_r8v10_stock.model` | 84 | 29 | 20 | containment |

A car with zero or several exact matches would be reported as unmapped with the
reason; it would keep the committed Corvette C3 body in the drive slice, labelled.
All five currently map.

### Typed absent wheel part

A vehicle model may genuinely have no brake-caliper element (for example
`Hummer_H2_OffRoad`, record 60). The builder accepts that only when the
DefaultModel has **zero** `e_brakecaliper_*` elements: the wheel group keeps its
three proven members (`tyre`, `rim`, `brakeDisc`) and records
`caliper:"absent"` plus an `absentMembers` diagnostic. No caliper mesh is
invented, borrowed or silently substituted. A renamed, merged or differently
parented caliper is still rejected.

`dump_model_parts.py` prints the MdlDat element names/parents/bounds for one
decoded model. `verify_staged_manifest.py` verifies one manifest directory
(shared schema/accounting checks plus optional body, wheel-group, UV0 and
material evidence) without touching the committed roster.

## Commands

```powershell
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"

# 0. native reader binaries (only if _work/build/asset-reader-native is missing)
& $py tools/verify_asset_probe.py --skip-build

# 1. Corvette C3 manifest + mesh + scene report (the standalone preview input)
& $py probes/car-parts/tools/build_manifest.py

# 2. map + decode + build one manifest per roster car
& $py probes/car-parts/tools/build_all_manifests.py

# 3. any other model (same schema), e.g. a single car
& $py probes/car-parts/tools/build_manifest.py --model _work/car-parts/models/<sha>.decoded `
     --out-dir _work/car-parts/cars/<slug> --mesh-out ... --car-slug <slug> --car-name <name>

# 4. headless Edge/WebGPU screenshots + console gate
& $node probes/car-parts/tools/capture_browser.mjs

# 5. two-build determinism + schema + per-car mapping + screenshot verification
& $py probes/car-parts/tools/verify_manifest.py

# 6. one staged manifest (no roster/browser dependency)
& $py probes/car-parts/tools/dump_model_parts.py --model <decoded.model> --model-index 0 --out <parts.json>
& $py probes/car-parts/tools/verify_staged_manifest.py --manifest-dir <dir> --slug <slug> \
     --materials <corvette-materials.json> --uv0 <corvette-uv0.json> --out <result.json>

# interactive
& $node probes/car-parts/tools/serve.mjs        # http://127.0.0.1:8806/
```

Inputs:

- `_work/car-level-assets/corvette_c3_race.model.decoded` — decoded C3 model,
  SHA-256 `77840511…2cb9d` (3,169,212 bytes).
- `_work/car-parts/models/<sha>.decoded` — decoded roster models, extracted from
  `root.pak` with the committed PAK index reader and packet-zlib decoder.
- `_work/build/asset-reader-native/Release/{scene_inspect,model_inspect}.exe`.

Outputs (all ignored by Git):

| path | content |
| --- | --- |
| `_work/car-parts/manifest.json` | the C3 manifest (schema below) |
| `_work/car-parts/mesh.json` | 30,591 positions + 108,579 U32 indices used by the viewer |
| `_work/car-parts/scene-report.json` | exact `scene_inspect.exe` output |
| `_work/car-parts/cars/index.json` | roster mapping, per-car hashes and counts |
| `_work/car-parts/cars/<slug>/` | one manifest + mesh + scene report per roster car |
| `_work/car-parts/browser-*.png` | 1600×900 Edge/WebGPU screenshots |
| `_work/car-parts/browser-evidence.json` | per-capture probe, console and hashes |
| `_work/car-parts/verify.json` | verification result |
| `_work/logs/car-parts/` | build/capture/verify logs |

`mesh.path` in a manifest is relative to the manifest file, so builds into
different directories stay byte-identical.

## Manifest in one paragraph (Corvette C3)

`parts[]` holds 29 parts: 4 wheel groups, 4 glass windows, 14 light parts,
4 licence-plate/mirror parts, the steering wheel, and 2 shell groups
(`body.shell`, `interior.shell`). Each part carries its original `MdlDat`
element name (where one is proven), element index, local bounds, local and
model-space transforms, draw ranges and a proof record. `draws[]` holds all
80 draws with index/vertex ranges, AABB, material binding and the part they
belong to. Four draws (front-left/right brake disc and caliper) are
`partKind:"unclassified"` because both sides have identical element-local
bounds; they are still rendered through a labelled preview-only pairing.

The four wheel groups use the file's own names:

```
e_wheel_frontleft   T = (-0.774300,  0.000000,  1.239200)
e_wheel_frontright  T = ( 0.774300,  0.000000,  1.239200)
e_wheel_backleft    T = (-0.774335,  0.000000, -1.239249)
e_wheel_backright   T = ( 0.774335,  0.000000, -1.239249)
```

Spin axis is element-local `+X`: the group's member bounds are measured thinnest
on X and round on Y/Z (recorded in `wheelGroups[].spin.axisEvidence`), and
upstream `VehicleActor.cpp:5158-5167` spins about `wheelMatrix.AX()`. Tyre, rim
and brake disc spin; the caliper is kept static because line 5198 says
"Brake calipers mustn't rotate".

Per-car wheel proof quality varies (symmetric wheel sets cannot be told apart by
bounds): the ZR1 has 10 ambiguous wheel draws, the Lotus 12, the Dodge 16, the
Focus 20, the Audi 16 — all still drawn and spun, with `unclassified` identity
and a recorded candidate list.

## Viewer

- `?angle=0.9&spin=0` holds a fixed wheel angle; `spin=1` (default) animates.
- `?yaw=…&pitch=…&dist=…` selects the orbit camera.
- Colours: tyre = wheel-corner colour, rim = silver, disc = red, caliper =
  yellow, glass = cyan, lights = yellow, body/interior = blue/orange.
- A local-angle band on spinning wheel members makes rotation visible on
  rotationally symmetric geometry. It is a diagnostic marker, not a material.
- Drag orbits, the wheel zooms, `Kamerayı sıfırla` resets.

See `docs/work/analysis/e1-car-parts.md` for the schema, proof table,
screenshots, hashes and limits. The per-car drive integration is recorded in
`docs/work/verification/T-007-per-car-meshes.md`.
