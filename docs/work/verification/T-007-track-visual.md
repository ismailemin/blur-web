# T-007 track visual — real River direct draws instead of the collision slab

> **Superseded in part by P43/P46** (`T-007-extended-sprint.md`,
> `T-007-ledge-fix.md`): the default visual now includes the six-section 540 m
> corridor (394 draws / 57,133 triangles) behind `?survey=1`, and the playable
> sprint remains the 29 m course. This document records the original two-section
> visual and its measurements.

**Date:** 5 November 2026
**Owner:** P31 (sub-agent)
**Scope:** `probes/e1-drive/**`, `_work/e1-drive/**`, `_work/logs/e1-drive/**`,
`docs/work/analysis/e1-drive-slice.md` §13 and this record. No change to
`probes/asset-reader/`, `probes/render-packet/`, `probes/car-parts/`, the engine,
tools, `upstream/` or `game-data/`. No race rules, audio, multiplayer or game
claim.

## Result

The E1 drive PoC now draws the **real River render geometry** from the committed
`level_inspect` direct-draw references and keeps the collision surface only for
physics. `verify_e1_drive.mjs` is **231/231 PASS**, the five physics state
sequence hashes are unchanged, and 20 headless Edge/WebGPU captures have a clean
console.

## Inputs (committed, pinned by SHA-256)

| section | file | vertices | triangles | draws | reference SHA-256 |
| --- | --- | ---: | ---: | ---: | --- |
| River block88/node283 | `_work/level-candidates/probes/00-usa_la_river-g88-n283/reference.json` | 17,782 | 9,343 | 95 | `e2a830f40af73ddcab928f719212c0bbdc77416b276b83c5a6e05ac48c887b89` |
| River block56/node289 | `_work/level-candidates/probes/08-usa_la_river-g56-n289/reference.json` | 14,508 | 9,824 | 49 | `ac570f64be34a0e0480173c8c31f3784e28200e7a6ddfe14a7bf462a458dccaf` |
| **track visual (merged)** | `river.track.visual` | **32,290** | **19,167** | **144** | both pinned above |

`build_geometry.mjs` re-hashes the reference positions and indices in Node before
using them; a regenerated or hand-edited reference is a hard failure. The two
sections are concatenated without transform or clipping, and every source draw
range (`primitiveIndex`, `firstIndex`, `indexCount`, declared offset, topology,
source buffers) is preserved. Draws carry
`trackVisual:"asset-reader-direct-draws"`; materials stay diagnostic
(`materialId:null`, `materialsApplied:false`).

### Why block88/node283 alone is not the ground

The instructed section's committed bounds are `x 944.037…2477.923,
z 2205.934…3237.170`; the drive box is `x −120…−10, z 1010…1090`. Zero of its
17,782 vertices overlap the drive area, so it cannot appear under the car. It is
included verbatim (95 draws / 17,782 / 9,343) at its true source position.
`block56/node289` is the committed section that does overlap: its road height at
the spawn `(-88, 1050)` is **5.80685**, within 0.0006 m of the engine's
`e1_ground_probe` height **5.8074**.

### Collision provenance and coverage

The collision surface (`river.collision.surface`, 230 vertices / 381 triangles)
is carried in `packet.physicsSurfaces[0]` with `visible:false` and
`physicsOnly:true`. It is not in `packet.meshes`, so it is neither uploaded nor
drawn. The wasm wheels still trace the whole `Level.levelphysics` mesh.

Coverage test (data-derived; no triangle moved or invented): a collision
triangle is covered when its centroid is inside a `block56/node289` triangle in
XZ and its height is within 1.0 m of that triangle.

| collision triangles in the drive box | covered by a real draw | no committed real draw |
| ---: | ---: | ---: |
| 381 | 67 | 314 |

The no-draw part is the last ~12 m of the script (block56/node289 ends near
`x = −55`) and the off-road area. No ground is drawn there; the chase
`coast`/`end` frames show the car against the background. The HUD reports
`144 real draws · 19167 tri · no-draw 314 tri · slab hidden`.

## Verification gate

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py   probes/e1-drive/tools/extract_track.py
& $node probes/e1-drive/tools/build_geometry.mjs
& $node probes/e1-drive/tools/verify_e1_drive.mjs
& $node probes/e1-drive/tools/capture_browser.mjs --port 8811
```

`--port 8811` is used because 8801 was already bound during this run; the tool's
default remains 8801.

### Recorded result

- `_work/e1-drive/geometry.json` — **12,215,183 B**, SHA-256
  `dfb93f39301477ce6848ab946525dddd07365c4bf7d0ffebb1c6aaee9e3dc3a3`,
  geometry v4, `meshes.length:2` (level + track visual), track visual
  144 draws / 32,290 vertices / 19,167 triangles.
- `_work/e1-drive/run.json` — **PASS, 231/231 checks, 0 failures** (214 P29 +
  17 track/collision checks).
- Physics unchanged: every car's state sequence hash equals P29:

| car | state sequence hash | draws | packet bytes | packet hash |
| --- | --- | ---: | ---: | --- |
| Corvette ZR1 | `sha256:83f76590…008e1f` | 266 | 6,984,197 | `sha256:994a0a4b…83753e6` |
| Lotus Exige Cup260 | `sha256:8d6cd4d4…dac66c2` | 254 | 6,940,535 | `sha256:dc7c6ff5…abefd89a` |
| Dodge Challenger | `sha256:b1c63d20…7220a7e2` | 270 | 6,719,038 | `sha256:96834cd9…b9c89d51` |
| Ford Focus RS | `sha256:fb3909b6…c9bdb6` | 281 | 6,880,669 | `sha256:e1580e57…348b314d` |
| Audi R8 V10 | `sha256:5b4ae49d…4fd4067` | 250 | 6,790,388 | `sha256:7c94f801…5ee3b4e5` |

Each packet is `22 level props + 144 track draws + car draws`, 9 nodes, 301
ticks; the collision surface is present only in `physicsSurfaces`.

## Browser evidence

Headless Edge/WebGPU, 1600×900, adapter `nvidia / blackwell`, 20 captures
(5 cars × ticks 0/150/240/300):

- **0 console messages** in every capture (no errors, warnings or logs);
- **3 geometry uploads** per page — level + real track visual + that car's body;
  bytes 1,623,888 (Dodge) to 1,716,240 (Corvette), constant across frames;
- `drawsIssued = frames × draws` in every capture;
- every capture reports `trackVisual:"asset-reader-direct-draws"`,
  `trackDraws:144`, `trackTriangles:19,167`, `collisionVisible:false`;
- browser state hash equals node's for every capture; the car matrix is
  bit-identical; the packet hash is byte-exact for **17/20** captures. The other
  three (Dodge tick 0, Focus RS ticks 150/240) are the documented Node-24 vs
  Edge-156 `Math.atan2` camera ulp, with the camera within 1e-6 and the car
  matrix exact — not a physics difference.

Screenshots (full list in `_work/e1-drive/browser-evidence.json`):

| file | what it shows |
| --- | --- |
| `_work/e1-drive/browser-corvette-zr1-stock-start.png` | tick 0: real road/terrain under the settled car, level props ahead |
| `_work/e1-drive/browser-corvette-zr1-stock-mid.png` | tick 150: real road and embankment, HUD `144 real draws · 19167 tri · no-draw 314 tri · slab hidden` |
| `_work/e1-drive/browser-corvette-zr1-stock-coast.png` | tick 240: car on the real section near its end |
| `_work/e1-drive/browser-corvette-zr1-stock-end.png` | tick 300: last ~12 m, no committed real draw; background visible (documented limit) |
| `_work/e1-drive/browser-<slug>-*.png` | the same four ticks for all five roster cars |

![Real River track under the car](../../../_work/e1-drive/browser-corvette-zr1-stock-mid.png)

*`_work/e1-drive/browser-corvette-zr1-stock-mid.png`: real block56/node289 direct
draws (road + embankment), not the diagnostic collision slab; the slab is hidden
in `packet.physicsSurfaces`.*

## Limits

- **Not the whole track.** block88/node283 does not overlap the drive box;
  block56/node289 ends near `x = −55`. The last ~12 m and the off-road area have
  no committed real draw, so no ground is drawn there.
- **Diagnostic materials.** Source draw ranges are preserved, but the track is
  shaded with the diagnostic albedo; no level material, texture pixel or original
  shader is bound.
- **No visibility or culling.** All 144 direct draws are submitted every frame;
  the far block88/node283 geometry is outside the chase view and is not culled.
- **Collision is physics-only.** The collision slab is hidden and not uploaded;
  it stays in `packet.physicsSurfaces` only for provenance.
- **One car, one loaded block, no game.** No race rules, audio, multiplayer,
  opponents or engine-streaming claim; native-vs-wasm parity remains blocked by
  the DirectX SDK (`T-007-vehicle-physics.md` §7).

## Evidence paths

| path | content |
| --- | --- |
| `_work/e1-drive/geometry.json` | geometry v4: level, merged real track visual, 5 car bodies, hidden collision |
| `_work/e1-drive/run.json` | 231 checks, per-car drives/packets, track and coverage counts |
| `_work/e1-drive/browser-evidence.json` | 20 captures, console log, per-capture track fields and hash agreement |
| `_work/logs/e1-drive/verify.log` | the exact check list |
| `docs/work/analysis/e1-drive-slice.md` §13 | the analysis record |
