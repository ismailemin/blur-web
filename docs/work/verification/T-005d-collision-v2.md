# T-005d verification — collision oracle format contract v2

**Date:** 5 November 2026
**Owner:** P24 (sub-agent)
**Scope:** bounded probe-contract cleanup. Only `probes/collision-oracle/**`,
`docs/work/analysis/t005-collision-oracle.md` and this document were changed.
No engine patch, verifier, harness, project source, tool, `upstream/`,
`game-data/` or `_work/native-source/` file was modified. `engine/verify_gravity.py`
and `engine/harness/t005d/` are P17-owned and were not touched; wiring them to
v2 is the main agent's step. No vehicle, renderer or game claim.

**Result: PASS.** Native x64, wasm32 and the independent Python reference emit
**byte-identical** `formatVersion 2` canonical records for the same 24 ray + 24
sphere + 8 cache queries. A manual field-level comparison against the existing
real-Gravity v1 output shows every engine-assigned field now matches, including
the six fields that previously diverged.

```text
formatVersion            2
queryHash                620eceeaf22edeed5069ecfc7ce5a709be51963974e081a8f6ead6d986c1063f
canonicalRecordBytes     9816
native = wasm32 = Python yes (record-for-record)
input                    Level.levelphysics, 1 945 409 B
                         sha256 1e678b2dff61b6d3a3d5d95a5160c3f713290251667cb27c55e262175efe4e28
retired v1 hash          f87365b79fc1217da4280d6d5748ca6dc6808b89382b87de43ddcbfe6c9b5d6e (7 768 B)
```

---

## 1. What changed

`formatVersion 1` mixed two meanings in one field. The real Gravity code and
the probe therefore disagreed on six values, even though the geometry matched.
v2 stores the exact engine value and the probe-derived reporting value in
separate, explicitly named fields:

| # | v1 mismatch | v2 engine value | v2 probe-derived value |
| ---: | --- | --- | --- |
| 1 | sphere material packing | `bodyPhysicsMaterial` / `trianglePhysicsMaterial` / `enginePhysicsMaterial = body \| triangle<<16` (same for effect) | the split body/triangle fields |
| 2 | patch normal vs per-contact normal | `patchNormal` (engine `C_ContactPatch::m_Normal`) | `contactNormalDerived` (exact `1/sqrt`) |
| 3 | `engineTriangleIndex` vs ordinal | `engineTriangleStreamValue`, `leafStartOrdinal` | `perTriangleOrdinal` |
| 4 | unassigned trace `collisionFlags` | `collisionFlagsAssignedByEngine=0`, `engineCollisionFlagsValue=0` | `cachedTriangleCollisionFlags` |
| 5 | stored vs normalised trace normal | `engineNormalStored` | `normalDerivedNormalised` |
| 6 | zero-length contact normal | `patchNormal = (0,0,0)` (non-PS3 `ReciprocalSqrt`) | `contactNormalDerived` (NaN) |

Every record starts with `u8 kind, u8 hit, u16 formatVersion=2, u32 queryIndex`.
Exact layouts: `probes/collision-oracle/README.md` §4. Record sizes: ray 80 B,
sphere 32 B + 80 B/contact, cache 32 B + 76 B/entry + 88 B/trace.

The parse, query table, fixture inputs and query outcomes are unchanged:
24 rays (15 hit), 24 sphere queries (17 hit, 60 contacts), 8 cache queries
(fills 3/1/1/1/4/4/0/4; 5 traces hit).

## 2. Gate

```powershell
python probes/collision-oracle/tests/run_collision_oracle.py
```

Result: **24/24 PASS** (full rebuild): configure, native build, `/W4` warning
gate, wasm build, both binaries, selftest, CTest, native run ×2, native
determinism, `formatVersion 2`, wasm run ×2, wasm determinism, native-vs-wasm
records, native-vs-wasm whole document (only `build` and `input.label`
excluded), Python reference, native-vs-Python records, 13/13 malformed
rejections.

Reuse gate: `python probes/collision-oracle/tests/run_collision_oracle.py
--skip-build` → **20/20 PASS**, same `queryHash`.

Determinism: native JSON byte-identical across two runs; wasm JSON
byte-identical across two runs; repeated full runs give the same v2 hash.
Native MSVC `/W4 /permissive-` produces **0 warnings**; CTest **2/2**.

## 3. Gravity comparison (manual, no verifier edit)

The engine harness still emits v1 and `engine/verify_gravity.py` expects v1, so
its `queryHash` is not comparable with v2. The probe ships a documented v1
reader/comparator:

```powershell
python probes/collision-oracle/tests/compare_engine_v1_to_v2.py `
  --engine _work/engine-gravity-spike/gravity_a.json `
  --probe  _work/collision-oracle/native.json
```

Measured: **840 assigned field groups match**, including bit-identical
`enginePhysicsMaterial`/`engineEffectMaterial`, `patchNormal`,
`engineTriangleStreamValue`, `engineNormalStored`, contact points,
penetrations and distances.

Remaining delta: **`trace.collisionFlags`**. The engine's thin
`C_LineCollisionCache::Trace` branch never assigns
`C_RayTracingResult::m_CollisionFlags` (`LineCollisionCache_Trace.inl:184-225`;
the constructor at `Ray.h:26-27` also does not initialise it). The engine words
measured in the existing document vary: `0x44a2fcbc`, `0x44863571`,
`0x440a8229`, `0x448807cd`, `0x43060611`. v2 therefore records
`collisionFlagsAssignedByEngine=0` and a zero sentinel, and reports the cached
triangle's flags separately. It is excluded from the equality claim, not
silently equalised.

**Conclusion:** engine and probe now match exactly on every engine-assigned
field; the only remaining difference is an engine-out field that the engine
never writes and that no deterministic contract can include. Full v2
`queryHash` equality becomes testable once the main agent wires
`engine/harness/t005d` and `engine/verify_gravity.py` to v2.

## 4. v1 lifecycle

v1 production is retired. The v1 layout stays documented (README §4.5) and the
pre-change evidence is preserved under `_work/collision-oracle/v1/` for one
cycle. A v1 document cannot produce a v2 hash because it never recorded body
materials, patch normals, leaf-start ordinals or the stored trace normal.
`compare_engine_v1_to_v2.py` is the documented v1 reader for that cycle.

## 5. Limits

- Probe contract only: no vehicle physics, renderer, browser/WebGPU,
  performance or playable-game claim.
- Retail-binary bit equality is not claimed. Retail `Normalise()` is
  `_mm_rsqrt_ps` followed by one Newton–Raphson step
  (`SIMD_SSE.inl:926-941`); v2 uses the non-PS3 exact `1/sqrt` with the zero
  guard for the engine-shaped field and labels the probe-derived field.
- Fat/swept-sphere ray, capsule/box proxies, constraints, `Routes` scenes and
  non-identity instance transforms remain unsupported as documented in the
  analysis §8.
- `trace.collisionFlags` is not an engine contract value.

## 6. Evidence

| topic | path |
| --- | --- |
| v2 schema and commands | `probes/collision-oracle/README.md` §4, §7 |
| v2 native / wasm / Python documents | `_work/collision-oracle/{native,native2,wasm,wasm2,reference}.json` |
| run summary | `_work/collision-oracle/summary.json` |
| preserved v1 evidence | `_work/collision-oracle/v1/` |
| engine v1 document | `_work/engine-gravity-spike/gravity_a.json` |
| v1→v2 field comparison tool | `probes/collision-oracle/tests/compare_engine_v1_to_v2.py` |
| full v2 gate log | `_work/collision-oracle/logs/run-v2-final.log` |
| engine comparison log | `_work/collision-oracle/logs/compare-engine-v1-v2.log` |
| main `--skip-build` suite log | `_work/collision-oracle/logs/verify-asset-probe-skipbuild.log` |
| analysis | `docs/work/analysis/t005-collision-oracle.md` |
