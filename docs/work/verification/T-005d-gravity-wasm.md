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

Result: **PASS (v2 field-level)**. The engine harness still emits
`formatVersion 1` records; the probe now emits `formatVersion 2`, which separates
engine values from probe-added reporting. `verify_gravity.py` maps every
engine-assigned field to the corresponding v2 engine-value field:

- **840 assigned field groups match**, including packed materials, patch
  normals, `engineTriangleStreamValue`, `engineNormalStored`, contact points,
  penetrations and distances.
- `trace.collisionFlags` is excluded: the engine's thin
  `C_LineCollisionCache::Trace` never assigns it (v2 records
  `collisionFlagsAssignedByEngine:0`).
- `queryHash` equality is **not** claimed across different record layouts.
  Engine v1 `77a53355…f94c`; probe v2 `620eceea…063f` (9,816 B).
- The former v1 divergences (materials, patch normal, triangle ordinal, flags,
  stored normal) are now explicit v2 field pairs; a v1 document cannot produce a
  v2 hash.

Build determinism PASS, run determinism PASS, mesh structure PASS (2 meshes,
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
