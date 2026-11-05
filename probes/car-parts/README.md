# probes/car-parts — Corvette part manifest + WebGPU wheel preview

Builds a deterministic, evidence-backed part manifest from the real
`corvette_c3_race.model`, then renders it in a standalone WebGPU page with
per-part diagnostic colours and four spinning wheels.

Nothing here is engine code and nothing here edits the committed probes:

- geometry comes from `probes/asset-reader` (`scene_inspect.exe`);
- chunk provenance comes from `probes/asset-reader` (`model_inspect.exe`);
- part names, element matrices and bounds come from the same file's `MdlDat`
  block, parsed with the documented `C_ModelData::Read` layout;
- the shader/pipeline/dynamic-uniform pattern is adapted from
  `probes/e1-drive/web/packet-consumer.js` (itself a copy of
  `probes/render-packet/web/packet-consumer.js`) into `web/renderer.js`.

No game integration, no gameplay, no material fidelity is claimed.

## Commands

```powershell
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"

# 0. native reader binaries (only if _work/build/asset-reader-native is missing)
& $py tools/verify_asset_probe.py --skip-build

# 1. deterministic manifest + mesh + scene report
& $py probes/car-parts/tools/build_manifest.py

# 2. headless Edge/WebGPU screenshots + console gate
& $node probes/car-parts/tools/capture_browser.mjs

# 3. two-build determinism + schema + screenshot verification
& $py probes/car-parts/tools/verify_manifest.py

# interactive
& $node probes/car-parts/tools/serve.mjs        # http://127.0.0.1:8806/
```

Inputs:

- `_work/car-level-assets/corvette_c3_race.model.decoded` — decoded PC model,
  SHA-256 `77840511…2cb9d` (3,169,212 bytes). Regenerate with
  `python tools/inspect_car_level_assets.py` if missing.
- `_work/build/asset-reader-native/Release/{scene_inspect,model_inspect}.exe`.

Outputs (all ignored by Git):

| path | content |
| --- | --- |
| `_work/car-parts/manifest.json` | the part manifest (schema below) |
| `_work/car-parts/mesh.json` | 30,591 positions + 108,579 U32 indices used by the viewer |
| `_work/car-parts/scene-report.json` | exact `scene_inspect.exe` output |
| `_work/car-parts/browser-*.png` | 1600×900 Edge/WebGPU screenshots |
| `_work/car-parts/browser-evidence.json` | per-capture probe, console and hashes |
| `_work/car-parts/verify.json` | verification result |
| `_work/logs/car-parts/` | build/capture/verify logs |

## Manifest in one paragraph

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

Spin axis is element-local `+X` (wheel/rim bounds are thin on X and round on
Y/Z; upstream `VehicleActor.cpp:5158-5167` spins about `wheelMatrix.AX()`).
Tyre, rim and brake disc spin; the caliper is kept static because line 5198
says "Brake calipers mustn't rotate".

## Viewer

- `?angle=0.9&spin=0` holds a fixed wheel angle; `spin=1` (default) animates.
- `?yaw=…&pitch=…&dist=…` selects the orbit camera.
- Colours: tyre = wheel-corner colour, rim = silver, disc = red, caliper =
  yellow, glass = cyan, lights = yellow, body/interior = blue/orange.
- A local-angle band on spinning wheel members makes rotation visible on
  rotationally symmetric geometry. It is a diagnostic marker, not a material.
- Drag orbits, the wheel zooms, `Kamerayı sıfırla` resets.

See `docs/work/analysis/e1-car-parts.md` for the schema, proof table,
screenshots, hashes and limits.
