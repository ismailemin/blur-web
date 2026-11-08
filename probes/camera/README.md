# probes/camera — retail camera parity

Read-only recovery of the shipped Blur camera parameters and a numeric comparison
with the browser PoC chase camera. No game data, upstream source, `probes/e1-drive`
or `tools/` file is modified.

## Result

- The **normal retail chase** is `C_HollywoodVehicleCamera` (`C_VehicleFeed::Init`,
  `m_Future=false`) using each car's `HollywoodVehicleParams` record.
- `C_AmaxChaseCamera` / `AmaxChaseParam` is the **legacy/future feed**
  (`m_Future=true`), not the normal chase. Its per-car data is 4.65 m / 1.4 m /
  65 deg / tilt -8 deg / behindSpring 3.0/s for every E1 roster car.
- The PoC uses 9.0 m / 2.4 m above a 1.0 m target (3.4 m absolute) / 45 deg /
  0.18 per-tick smoothing / no look-ahead. It is not the retail camera.
- Manifest: `_work/camera/camera.json` (511 parameters; data 309, code 82,
  provisional 120). Verifier: `_work/camera/verify.json`, **8760 checks, 0
  failures**.

## Commands

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py probes/camera/tools/build_camera_manifest.py
& $py probes/camera/tools/verify_camera_manifest.py
```

The builder reads `game-data/Blur/cache/gamedata.pak` entry
`\gamedata\xt\amax.bin` through the committed `inspect_asset_layout.pak_index`
and `probes/powerups/tools/xt_decode.py` decoder. It also reads the committed
`_work/vehicle-pipeline/amax-vehicles.jsonl`, `_work/e1-drive/cars.json`,
`_work/e1-drive/geometry.json`, `probes/e1-drive/web/packet-adapter.js`,
`probes/render-packet/tools/build_packet.mjs` and the cited upstream files.
Every value in the manifest carries a `provenance` tag (`data`, `code`,
`provisional`), a unit and a source.

## Files

| path | content |
| --- | --- |
| `tools/build_camera_manifest.py` | deterministic manifest builder |
| `tools/verify_camera_manifest.py` | manifest/source/range/determinism gate |
| `_work/camera/camera.json` | the manifest |
| `_work/camera/verify.json` | gate result |
| `docs/work/analysis/camera-parity.md` | analysis, comparison, patch values, limits |

## Limits

- The source revision's `SetIdealPitch` unit disagrees with the serialized
  `IdealPitch` degrees; the derived eye height/look-down is **provisional**.
- The high-speed FOV multiplier is serialized but `m_highSpeed` is never set true
  in the committed source; it is not applied at 30 m/s.
- Only the five E1 roster cars are mapped; the 62 `RP_CarDynamics` records are not
  all enumerated.
- No retail binary was executed and no browser capture was taken. This is data
  and code evidence, not a pixel-parity claim.
