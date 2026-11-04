# T-007/E1c verification — minimal vehicle physics on wasm32

**Date:** 5 November 2026
**Scope:** real RacingPhysics/Gravity car step on a static River mesh; no
renderer, loop or game.

## Gate

```powershell
python engine/verify_vehicle.py --fresh
```

Result: **PASS** (544 s).

- Patch `engine/patches/t005d-vehicle-overlay.patch` — 12,583 B, 9 files,
  +109/−14, SHA-256
  `6fd6f2d1e2ed752251467dd779b0e27d30dfd2d5f23e483b78f28323051a86bd`.
- **186 objects**, wasm **1,024,869 B**, two builds byte-identical
  (`8015f063c5b998b8…`).
- 23 RacingPhysics TUs + 118 Gravity TUs + 44 closure + harness; link closes
  with `-sERROR_ON_UNDEFINED_SYMBOLS=1`.

## Car data

Real XT, no invented values: `gamedata\xt\racingphysics.bin` →
`RP_CarDynamics` record 37, id `1554942492`, `Corvette_ZR1_Stock`, 184 fields.

- mass 1600 kg, wheelbase 2.652 m, track 1.656/1.637 m, tyre radius 0.356 m
- limiter 7250 rpm, 6 gears, RWD, torque curve
- labelled gaps: `surfaceMappingsApplied:false`,
  `physicsParametersResolved:false` (handle `0x4c` needs the XT database),
  body shape is a box from XT geometry

## Motion

Start at the collision-oracle contact point `(281.2833, 1823.6890)`, ground
`y=2.726`, `dt=1/60`. 180 ticks at rest + 300 at full throttle:

| | |
| --- | --- |
| wheel contact | **480/480 ticks** |
| NaN ticks | **0** |
| speed | 0.7737 → **31.0948 m/s**, peak **35.1341 m/s** |
| distance | **96.142 m** |
| settle hash | `27f9c4eb…e086` |
| drive hash | `1eba531c…ce66` |
| whole run | `2bbc0a18…e974f5` |

Per-tick 45 canonical bytes, distinct hash each tick; two runs byte-identical
(document SHA-256 `5dfe2499…27bd40`).

## Native parity

**Blocked, measured:** the PC configuration needs the legacy DirectX SDK
(`racingphysics/stdafx.h → Display/Core/Includes.h → dxerr.h`), which is not
installed; the web configuration cannot be built with MSVC (`__atomic_*`,
`__builtin_trap`, `__fsel`). Substitute evidence: MSVC preprocessing of all
7 web-only files is identical with and without the patch (only `__LINE__`/
`__FILE__` normalised), and the 2 unconditional grammar fixes compile `/W4`
with 0 errors.

## Limits

- No native numeric reference; wasm-vs-native state equality is **not** claimed.
- Surface grip mappings and the XT physics handle are unresolved; body shape is
  a box, not the retail composite.
- Single vehicle, no renderer/loop/input/audio/game claim.
- `Scene_DebugRender` (DX11), `GJKSPU`, rope/cloth and Featherstone TUs are
  excluded with measured reasons.

Evidence: `_work/logs/engine-vehicle-spike/verify-vehicle.json`,
`_work/engine-vehicle-spike/`, `docs/work/analysis/engine-vehicle-physics.md`.
