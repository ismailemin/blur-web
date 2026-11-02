# T-005d verification — real Gravity collision on wasm32

**Date:** 2 November 2026
**Scope:** engine-side Gravity static-collision port spike; no vehicle physics.

## What compiled

Eight upstream Gravity TUs, unmodified:

```
narrowphase/OptimisedAABBTree.cpp
narrowphase/LineCollisionCache.cpp
narrowphase/Shapes.cpp
narrowphase/PrimitiveClosestPointsTest.cpp
narrowphase/PrimitiveIntersectTest.cpp
narrowphase/AABB.cpp
sharedphysics/SPU_Memory.cpp
sharedphysics/GravityConstants.cpp
```

plus the logging/time/thread/SIMD/Constants/`C_MemoryStream` closure and the
existing T-005c shims: **33 objects**, wasm **134,318 B**, SHA-256
`63217ebf14b9bd089c968f2c0ac3c26947fc0ad655faecef2196871f14c15609`.

`engine/patches/t005d-gravity-overlay.patch` is **empty (0 B)**: the scheduler
and file overlays already compile the Gravity TUs; the spike needed no engine
source change. 350/350 Gravity files are identical to upstream.

## Gate

```powershell
python engine/verify_gravity.py --fresh
```

Result: **status DIVERGED (documented), exit 0** — the probe's
`formatVersion 1` records mix engine values with probe-added reporting, so the
full `queryHash` is not equal. The verifier now pins the exact allowed
divergence; any other difference fails.

| Kind | Same | Different | Divergent fields |
| --- | ---: | ---: | --- |
| rays | **24** | **0** | — |
| spheres | 8 | 16 | `contact.physicsMaterial` 56, `contact.effectMaterial` 118, `contact.normal.{x,y,z}` 56/62/57 bytes |
| cache | 1 | 7 | `entry.engineTriangleIndex` 13, `trace.collisionFlags` 20, `trace.engineTriangleIndex` 1, `trace.normal.{x,y,z}` 10/10/8 bytes |

First divergence: query 24 `point-vertex-0`, byte 48,
`contact[0].physicsMaterial` (engine `0x00010000`, probe `0x00000001`).
Record size is identical (7,768 bytes).

- Engine `queryHash 77a533556fe5ed1cee5e3633d685b233990ed6d5a7858265668d39bd6626f94c`.
- Probe `queryHash f87365b79fc1217da4280d6d5748ca6dc6808b89382b87de43ddcbfe6c9b5d6e`.
- Build determinism PASS, run determinism PASS, mesh structure PASS (2 meshes,
  44,970/17,671 vertices, 31,860/12,384 triangles), 24/24 ray *inputs*
  bit-identical.
- Harness compiles at `-Wall -Wextra -Wpedantic` with 0 warnings.

## Interpretation

The hard geometry path is exact: all 24 ray records are byte-identical, which
includes traversal, quantisation, ties, segment shrinking, `cosAngle` and the
byte-offset triangle index. The remaining differences are reporting choices:

1. material fields: engine packs `shape | header<<16`, probe exposes body and
   triangle material separately;
2. contact normal: engine reports the patch normal (unnormalised, zero for a
   zero-length `d`); probe wrote NaN;
3. cache `engineTriangleIndex`: engine records the header group's first
   ordinal; probe recorded the per-triangle ordinal;
4. `trace.collisionFlags`: the thin engine `Trace` never assigns it;
5. `trace.normal`: engine copies the stored, non-unit normal (length
   0.998996); probe normalises.

A `formatVersion 2` probe contract should separate engine values from
probe-added reporting before any equality claim.

## Limits

- Full `queryHash` equality is **not** claimed.
- Static mesh only; no vehicle, solver, XT or game integration.
- No browser/WebGPU or performance claim.

Evidence: `_work/logs/engine-gravity-spike/verify-gravity.json`,
`_work/engine-gravity-spike/`, `docs/work/analysis/engine-gravity-layer.md`.
