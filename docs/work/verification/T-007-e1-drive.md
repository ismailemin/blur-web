# T-007/E1d–E1e verification — connected drive slice

**Date:** 5 November 2026
**Scope:** wasm vehicle physics → packet adapter → WebGPU consumer, scripted
drive on the River collision mesh; no race rules/audio/full game.

## Gate

```powershell
node probes/e1-drive/tools/verify_e1_drive.mjs
node probes/e1-drive/tools/capture_browser.mjs
```

Both **PASS**.

- Module: **1,003,249 B**, two links byte-identical, 186-object closure (185
  reused T-005d objects + this harness TU).
- Scripted drive: 120 throttle + 120 coast + 60 brake = **300 ticks**.
- Travel **45.378 m**; speed 0.002 → **14.986** → 11.044 → **0.448 m/s**.
- Wheel contact **301/301 ticks** (all four), **0 NaN**.
- State sequence hash `sha256:83f765902ce5c610889e8a27e9bfe747f86142bddea24ecb987b29be29008e1f`,
  identical across two separate wasm instances and reset+replay.
- Packet: 301 ticks, **103 draws**, **3,396,616 B**,
  `sha256:fa7e660bcd03f7a26e3b998a55ce1343faa634c48bd9520742505f79a1d769c1`;
  every per-tick hash recomputed with the committed Node definition.

## Browser

Headless Edge + WebGPU, 1600×900, `nvidia / blackwell`:

| tick | speed | frames | geometry uploads | draws | console |
| ---: | ---: | ---: | ---: | ---: | --- |
| 0 | 0.00 | 22 | 3 / 1,088,544 B | 2,266 | 0 |
| 150 | 14.53 | 363 | 3 / 1,088,544 B | 37,389 | 0 |
| 300 | 0.45 | 741 | 3 / 1,088,544 B | 76,323 | 0 |

Independent re-run: 742 frames, 299 ticks, 3 geometry uploads, 76,426 draws,
**0 console messages**. The page's per-tick state/packet hashes equal the Node
producer's — the browser simulated, it did not replay.

Screenshots: `_work/e1-drive/browser-{start,mid,end}.png` and `-car` crops.

## What is now proven

- Real RacingPhysics car state drives a real WebGPU frame on the real River
  collision mesh, with a chase camera, fixed step and scripted input.
- Geometry is uploaded once per mesh; per-frame cost is uniforms + draws.
- No NaN, no silent fallback, deterministic across instances.

## Limits

- Materials are diagnostic (identity albedo, one light, derivative normals, no
  textures/shadows/post). The road is **collision geometry** drawn as a labelled
  diagnostic surface; the committed River draw set is props, so grazing slabs
  speckle.
- **Wheels are not drawn** (no wheel mesh in scope); contact/suspension/spin are
  state + HUD only.
- Box gravity proxy, neutral surface scalars, unresolved XT handle; car
  mesh→chassis offset unrecovered.
- One car, one box of track; no audio/race rules/streaming/multiplayer.
- Native numeric parity still blocked by the DirectX SDK.

Evidence: `_work/e1-drive/{verify.json,browser-evidence.json}`,
`_work/logs/e1-drive/`, `probes/e1-drive/README.md`,
`docs/work/analysis/e1-drive-slice.md`.
