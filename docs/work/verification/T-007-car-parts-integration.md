# T-007/E1i verification — Corvette parts and spinning wheels in the E1 drive slice

**Date:** 5 November 2026
**Scope:** `probes/e1-drive/**`, `_work/e1-drive/**`, `_work/logs/e1-drive/**`,
`docs/work/analysis/e1-drive-slice.md` and this file. The committed
`_work/car-parts/manifest.json` is read only. No change to `probes/car-parts/`,
`probes/render-packet/`, the engine, `tools/`, `upstream/` or `game-data/`.
Physics is unchanged.

## Gate

```powershell
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"

& $py   probes/car-parts/tools/build_manifest.py      # committed manifest input
& $node probes/e1-drive/tools/build_geometry.mjs
& $node probes/e1-drive/tools/verify_e1_drive.mjs
& $node probes/e1-drive/tools/capture_browser.mjs     # add --port 8811 if 8801 is busy
```

Result: **PASS**.

| check | result |
| --- | --- |
| `verify_e1_drive.mjs` | **202/202 checks, 0 failures** (164 pre-existing + 38 part/wheel checks) |
| all five cars | **301/301 wheel-contact ticks**, **0 NaN**, 0 rigid-matrix failures |
| determinism | run A = run B packet hash for every car; Corvette state sequence = `sha256:83f765902ce5c610889e8a27e9bfe747f86142bddea24ecb987b29be29008e1f` |
| browser | 20 captures (5 cars × 4 ticks), **0 console messages**, 3 geometry uploads / 1,090,380 B |
| package hashes | geometry `sha256:f25c9cd36dc8bc21ef5620749ad84862d05d77e02be560336bc49900ab233fd1`; manifest `sha256:24aa45f37cce2738b2f6b90bcd043aee736be6db8d7e2e855eb86048f7dbf602` |

## What the packet now contains

The manifest is validated and embedded by `build_geometry.mjs`. The committed
manifest SHA-256 is pinned in the tool, so a regenerated or hand-edited file is a
hard failure:

- **29 parts / 80 draws / 4 wheel groups**; all 80 car draws match their manifest
  index range exactly (a mismatch is a hard failure).
- **9 nodes**: `e1.car.body` (60 draws) + `.spin` and `.static` per wheel corner
  (16 spinning draws, 4 caliper draws).
- **9 matrices per tick**: body + 8 wheel nodes. Wheel matrices are
  `body × MdlDat rest translation × Rx(angle)`; the caliper node is
  `body × rest`.
- The spin axis is element-local `+X` (`VehicleActor.cpp:5158-5197`). Tyre, rim
  and brake disc spin; the caliper is static (`VehicleActor.cpp:5198`).
- The angle integrates `e1_get_state().wheels[].angular` at the fixed 1/60 s
  step, starting at 0 on the settled tick. Physics wheels are assigned to the
  nearest manifest wheel translation in body-local space.
- Draws carry `partId`, `partKind`, `wheelPart`, `spins`, `nodeId` and a labelled
  `diagnosticColour`; `materialsApplied` remains `false`.

| car | packet bytes | packet hash | nodes | draws |
| --- | ---: | --- | ---: | ---: |
| Corvette ZR1 | 4,288,582 | `sha256:4e8eb90f9c10679614f6eb5ba816daead1ac0142489a8019efc5cedbc63d2b74` | 9 | 103 |
| Lotus Exige Cup260 | 4,297,042 | `sha256:c97b1a6a7f8a814da05fb737a8b549c5c532242c9eb6a3fdd09e53334b7eae97` | 9 | 103 |
| Dodge Challenger | 4,289,142 | `sha256:5c732e9e3e0672d234da4ab340ee1bcabc8b9b100f0f1be4c8bfa1b028178e51` | 9 | 103 |
| Ford Focus RS | 4,287,489 | `sha256:81600e06e3d2772c0baa56c4d681bab571af7f2cc8aadb9d0f2879ca88013987` | 9 | 103 |
| Audi R8 V10 | 4,287,529 | `sha256:ec0c9abf337726f25d53cebee16c5795a8715917393972e7710845517bcbf614` | 9 | 103 |

## Wheel evidence

The verifier reads the rotation angle back out of each per-tick matrix
(`R_body^T · R_wheel = Rx(angle)`) and checks:

- the angle advances on more than 60% of tick steps by > 0.001 rad;
- the spinning wheel matrix at tick 300 differs from tick 0;
- the caliper node's relative angle stays < 1e-4 rad for every tick.

Browser-side accumulated angles (front-left, unwrapped):

| tick | Corvette | Lotus | Dodge | Focus RS | Audi |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 0 | 0 | 0 | 0 | 0 |
| 150 | 84.637 | 69.139 | 94.530 | 88.536 | 110.374 |
| 240 | 138.223 | 117.625 | 138.695 | 125.483 | 195.659 |
| 300 | 148.603 | 125.977 | 147.091 | 127.291 | 218.144 |

All values in radians. The HUD publishes the angle of the displayed tick, not
the one-tick-ahead engine tick.

## Screenshots and console

Screenshots are `_work/e1-drive/browser-<slug>-{start,mid,coast,end}.png` plus
`-car` crops. The default car's captures also keep the historical
`browser-{start,mid,coast,end}.png` names.

- Corvette mid: `_work/e1-drive/browser-corvette-zr1-stock-mid.png` — 29-part
  body, cyan glass, yellow lights, rear tyre corner colours, HUD
  `29 parts · 80 draws · 9 nodes (8 wheel)`.
- Corvette start/mid/coast/end: wheel angle max 0 / 84.6 / 138.2 / 148.6 rad.
- Every capture: blueprint **0 console messages**, 3 uploads, 1,090,380 B,
  `drawsIssued = frames × 103`.
- The per-tick car matrix is bit-identical to the node producer and the camera
  matches within 1e-6. **17/20 packet hashes are byte-exact**; the three others
  differ only in the last `Math.atan2` bit of the chase camera (documented
  Node-24 vs Edge-156 ulp caveat), not in physics or matrices.

## Limits

- **Rest-pose matrices.** Wheel placement is the `MdlDat` translation; no
  suspension travel, steer or camber (the state does not carry it).
- **Corvette-only parts.** Every roster car is still drawn with the Corvette
  body/wheel manifest.
- **Diagnostic materials/colours.** Per-part colours and the spin marker band are
  debug aids, not game materials or texture pixels.
- **Spin is integrated from angular velocity**, not read as an angle.
- **Four side-ambiguous front disc/caliper draws** use the manifest's
  preview-only corner pairing; the caliper still does not rotate.
- **Chase camera.** The rear wheel groups are visible; front wheels are occluded
  from behind. Rotation is proven by the per-tick matrices and HUD angles.
- **32 shell draws** remain group-proven only (`body.shell` 26,
  `interior.shell` 6).

## Evidence

| path | content |
| --- | --- |
| `_work/e1-drive/geometry.json` | 29 parts, 4 wheel groups, 9 nodes, 80 enriched car draws |
| `_work/e1-drive/run.json` | 202 checks, per-car drive, determinism, packets |
| `_work/e1-drive/packet-<slug>.json` | 301-tick packets with 9 matrices per tick |
| `_work/e1-drive/browser-evidence.json` | 20 captures, console, packet-hash agreement, wheel angles |
| `_work/e1-drive/browser-<slug>-*.png` | per-car screenshots |
| `_work/logs/e1-drive/verify.log`, `edge-process.log` | verifier and Edge logs |
| `docs/work/analysis/e1-drive-slice.md` §11 | full record and limits |
