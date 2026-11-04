# T-007/E1b verification — render packet v1

**Date:** 4 November 2026
**Scope:** packet contract + WebGPU consumer spike; no engine integration.

## Gate

```powershell
node probes/render-packet/tools/verify_render_packet.mjs
```

Result: **PASS** — build twice, identical packet SHA-256, schema and range
conformance, camera containment, content assertions.

- Packet: `_work/render-packet/packet.json`
- Packet hash: `sha256:7ede3abd6264d8275a508260772345300e718961700b46ad68374f8ec4a0e0d1`
- Size: 2,906,496 B (canonical hashed body 2,432,052 B)
- Draws: **102** (22 level + 80 car); **43,753 vertices / 46,501 triangles**
- Determinism: two runs → identical file SHA-256 `14774a49…c536d5`
- No guessed materials: `materialsApplied:false`, identity materials only.

## Browser

Headless Edge + WebGPU (`--enable-unsafe-webgpu`), CDP, 1600×900, adapter
`nvidia / blackwell`:

| Capture | Draws | Console |
| --- | ---: | --- |
| packet camera | 102 | **empty** |
| level debug camera | 102 | empty |
| car debug camera | 102 | empty |

Screenshot: `_work/render-packet/browser-car-focus.png` (car + level geometry,
diagnostic shading). Evidence: `_work/render-packet/browser-evidence.json`.

## What is proven

- Packet v1 can carry real River level geometry and the Corvette body with
  explicit ranges, transforms, bounds and material reasons.
- A standalone WebGPU consumer renders it in a real browser with a clean
  console; the packet is deterministic and schema-conformant.
- The packet is engine-agnostic: no consumer reads asset-reader internals.

## v1.1 — dynamic consumer (5 November 2026)

```powershell
node probes/render-packet/tools/verify_render_packet.mjs
node probes/render-packet/tools/verify_tick_loop.mjs
```

Both **PASS**.

- Schema 1.0/1.1: `nodes[]` + per-tick `updates[]` (camera, alpha, rigid
  matrices, per-tick hash); 1.1 without a timeline is rejected, 1.0 with one too.
- Packet: 120 ticks, **3,099,828 B**, `sha256:c31ddb3f…f84c`; two builds
  byte-identical; **120/120 unique tick hashes**, identical between runs.
- `web/fixed-step.js` is a port of the T-005c probe; replaying the native
  probe's own deltas matches **10/10 scenarios with zero tolerance**.
- Live run: **90 ticks over 262 frames**; 127 frames ran zero ticks (headless
  rAF faster than 60 Hz).
- Geometry uploaded **once per mesh (2 uploads, 1,083,048 B)** at tick 0 and
  tick 90; per frame only one 26,112 B uniform write + 102 `drawIndexed`.
- Screenshots at tick 0 and tick 90: projected car displacement **190.16 px**,
  `matrixChecksum 0xdf2aade5 → 0xacaf5ec5`; console **0 messages**.
- Motion is **synthetic** (`motion:"synthetic"`, 43.895 m straight path, 9.688 m
  measured clearance), not physics.

## Limits

- Packet is a spike fixture (`tick:0`, inline JSON), not wasm engine output.
- Vehicle placement is a presentation anchor, not a spawn transform; the car is
  occluded in the wide shot because the anchor coincides with a level prop.
- Materials are identity only; no textures, paint, shadows, post, particles.
- Blocks 26/32/31, higher LODs, damage and wheels absent.
- Headless Edge is a proxy; the user's real browser should confirm.
- No engine scene integration or game claim.

Evidence: `_work/render-packet/{packet.report.json,verify.json,browser-evidence.json}`,
`probes/render-packet/README.md`, `docs/work/analysis/e1-render-packet.md`.
