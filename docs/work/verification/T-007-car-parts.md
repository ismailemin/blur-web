# T-007/E1i verification — car part manifest and wheels

**Date:** 5 November 2026
**Scope:** draw/part extraction from the real Corvette model; standalone WebGPU
preview. No engine integration or game claim.

## Gate

```powershell
python probes/car-parts/tools/build_manifest.py
python probes/car-parts/tools/verify_manifest.py
node   probes/car-parts/tools/capture_browser.mjs
```

Result: **PASS**, 0 failures.

- Manifest `_work/car-parts/manifest.json` — 240,578 B,
  SHA-256 `24aa45f3…dbf602`; mesh 30,591 positions / 108,579 U32 indices.
- **29 parts** (27 named + body/interior shells), **80 draws**:
  - **76 proven**, **4 unclassified** (front brake disc/caliper draws whose
    left/right `MdlDat` bounds are identical).
  - 44 draws have a specific element identity; 32 shell draws are group-proven
    only — no leaf panel name is invented.
- 4 wheel groups with translations and `+X` spin axis:

| group | translation | proven draws |
| --- | --- | ---: |
| front-left | (-0.774300, 0, 1.239200) | 40,41,74 |
| front-right | (0.774300, 0, 1.239200) | 38,39,72 |
| back-left | (-0.774335, 0, -1.239249) | 8,13,36,37,71 |
| back-right | (0.774335, 0, -1.239249) | 9,14,42,43,73 |

Tyre corner proof is the exact union of tread + sidewall draws
(0.000343–0.000648 m). Spin axis follows `VehicleActor.cpp:5158-5197`
(`wheelMatrix.AX()`); the caliper stays static per line 5198.

## Browser

Headless Edge + WebGPU, 1600×900, `nvidia / blackwell`:

- 5 fixed-angle screenshots, **console 0 messages**, 2 geometry uploads.
- Repeated fixed-angle load: byte-identical screenshot.
- Wheel angle 0 vs 0.9 rad: **7,149 changed pixels** (rotation visible).
- Screenshots: `_work/car-parts/browser-parts-angle090.png`,
  `browser-parts-side.png`.

## Limits

- First RenderList LOD0 only; higher LODs, damage, paint and runtime light states
  omitted.
- Draw→part identity is AABB evidence, not `m_RenderMeshId` (all `-1`).
- 32 shell draws are group-proven, not per-panel named.
- 4 front disc/caliper draws are side-ambiguous; preview pairing is not proof.
- Element matrices are translation-only rest poses; no suspension/steer/camber.
- Diagnostic colours/materials; no engine integration.

Evidence: `_work/car-parts/verify.json` (`a9e62c03…95343e`),
`browser-evidence.json`, `_work/logs/car-parts/`,
`docs/work/analysis/e1-car-parts.md`.
