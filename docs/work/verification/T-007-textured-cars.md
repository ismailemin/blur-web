# T-007 verification — textured car bodies

**Date:** 6 November 2026
**Scope:** per-car albedo/UV texturing of the E1 drive cars; no paint/light
blends, no mip/sRGB, no engine integration.

## Result

- **224 / 491** car draws now sample real static albedo textures with UV0
  (50 Corvette, 48 Lotus, 42 Dodge, 37 Focus, 47 Audi).
- **40 textures**, **18,178,048 B** RGBA (from the P52 per-car manifests).
- Remaining **267** draws stay diagnostic and labelled: 45 paint lookups,
  66 light off/on blends, 156 `_NO_ALBEDO` shaders.
- Sampler: repeat / linear / mip0 / rgba8unorm; no sRGB or material colour.
- Geometry v6: **45,180,725 B**; 3 geometry uploads; car UV streams
  **1,257,960 B**.

HUD example (Audi): `car tex 47 textured (8 tex, 2580480 B) · diag 37
(9 paint, 9 light, 9 no-albedo) · uv 31429`.

## Gate

```powershell
node probes/e1-drive/tools/verify_e1_drive.mjs
node probes/e1-drive/tools/capture_browser.mjs --port 8811
node probes/e1-drive/tools/soak_browser.mjs --minutes 1 --runs 2
```

- `verify_e1_drive`: **570/570 PASS**.
- 20 drive captures, **0 console messages**, 5 cars; packet hashes exact 17/20
  (3 documented Node/Edge last-bit cases).
- 1-minute 2-run soak: PASS, 0 console, bounded texture/geometry uploads.
- Physics state hashes unchanged; car/textured draws do not alter simulation.
- `tools/verify_asset_probe.py --skip-build`: 29/29 (30/30 with net-layout).

## Limits

- No paint lookup, light blend, damage, mip chain, sRGB, anisotropy or original
  shader; diagnostic fallback for 267 draws.
- Per-car source LOD0 only; two 1024² livery LODs decoded from their 512² chain.
- Textures are PoC assets in `_work`, not redistributed.
- No full-game claim.

Evidence: `_work/e1-drive/browser-<car>-*.png`,
`browser-evidence-texture.json`, `car-textures.json`,
`_work/logs/e1-drive/p55-*.log`.
