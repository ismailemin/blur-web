# T-005d — Real Gravity static-collision code on wasm32: build, query run and probe comparison

**Date:** 2 November 2026
**Owner:** P17 (sub-agent)
**Scope:** bounded spike. One overlay patch (empty by measurement), one verifier,
one harness directory and this document. No modification of `upstream/`,
`game-data/`, `_work/native-source/`, project tools, `engine/README.md` or any
existing engine file. No vehicle physics, no renderer, no game claim.

**Result: the real Gravity translation units compile and run on wasm32 and the
ray path reproduces the committed probe byte for byte (24/24 canonical
records). The whole `queryHash` does not match, and cannot: six fields in the
probe's canonical record carry a different meaning from the value the engine
returns. The first divergence, every divergent field and the measured delta are
recorded below. No equality is claimed.**

```text
median queryHash (engine)  77a533556fe5ed1cee5e3633d685b233990ed6d5a7858265668d39bd6626f94c
committed probe queryHash  f87365b79fc1217da4280d6d5748ca6dc6808b89382b87de43ddcbfe6c9b5d6e
canonical record bytes     7768 (both)
```

---

## 0. Summary

1. **The real code runs.** Eight upstream Gravity TUs plus the logging and
   platform closure (33 objects) compile for `wasm32-unknown-emscripten` against
   the existing T-005c scheduler and T-005b file overlays. The module loads
   `usa_la_river/Level.levelphysics` through Gravity's own
   `OptimisedAABBTree::DeSerialise` and answers the probe's fixed table through
   Gravity's own `RayTracing<CollideRayTriangleMesh>`,
   `Collide<6,16,CollideSphereTriangleMesh>`, `FillLineCollisionCache` and
   `C_LineCollisionCache::Trace`.
2. **The overlay patch is empty (0 B).** No engine shim was needed: the two
   published overlays are sufficient. This is a measurement, not an omission —
   the verifier checks all 350 files under the tree's `gravity/` directory are
   byte-identical to upstream.
3. **Rays are exact.** All 24 canonical ray records are byte-identical to the
   probe's native document, including traversal order, last-hit-wins ties,
   leaf-local quantisation, byte-offset `m_TriangleIndex`, material flags and
   the `cosAngle` test.
4. **Sphere and cache geometry is exact; six reporting fields are not.** Contact
   counts, points, penetrations, ordinals, hashes, patch indices, cached
   triangle vertices, ordinals, materials and flags all match. `queryHash`
   differs because these fields do not:
   - sphere contact `physicsMaterial` / `effectMaterial` (engine packs
     `shape | header << 16`),
   - sphere contact `normal` (engine reports the *patch* normal, unnormalised;
     the probe reports a per-contact, normalised normal),
   - cache entry `engineTriangleIndex` (engine records the header group's first
     ordinal, the probe records the per-triangle ordinal),
   - cache trace `collisionFlags` (the thin `Trace` branch never assigns it),
   - cache trace `normal` (engine copies the stored, non-unit normal; the probe
     normalises),
   - cache trace `engineTriangleIndex` (same group-start issue).
5. **First divergence:** canonical query 24 (`point-vertex-0`), byte 48,
   `contact[0].physicsMaterial` — engine `0x00000000` bytes `00 00 00 00`
   (`0x00010000`) versus probe `0x00000001`. The engine packs the mesh shape's
   material in the low half and the triangle header's material in the high half;
   the probe stored only the header value.
6. **Deterministic.** Two fresh builds produce the same 134 318-byte `.wasm`
   (`63217ebf…c15609`); two runs on that module produce byte-identical JSON.
   The cache-trace `collisionFlags` value is stable across runs but is
   uninitialised by the engine (see §6.4), so it is reported as indeterminate,
   not as a contract.

---

## 1. Smallest Gravity TU set and the exact source anchors

The probe re-expressed four query paths. Their real definitions live in these
headers, and the loading code lives in two source TUs:

| role | source |
| --- | --- |
| tree stream load (`Head`/v10 counts, vertices, normals, nodes, per-leaf quantisation, triangle stream) | `gravity/source/narrowphase/OptimisedAABBTree.cpp:141-337`; node/triangle deserialisers `:16-100` |
| tree ray trace, thin branch | `gravity/include/gravity/narrowphase/OptimisedAABBTree.inl:146-228` |
| ray/triangle test | `.../RayTriangle.inl:44-114`; `IntersectTriangleSegmentSB` `.../Primitive.inl:520-544` |
| wheel box fill | `.../OptimisedAABBTree_FillCache.inl:87-212`; `IntersectAABBTriangle` `:12-85`; `C_AxisBoxMinMax::Intersects` `.../AxisBox.inl:76-88` |
| cache trace, thin branch | `.../LineCollisionCache_Trace.inl:184-225` (entry `:17`) |
| sphere vs mesh | `.../SphereTriangle.inl:94-202`; `ClosestPtPointTriangle` `.../PrimitiveClosestPointsTest.cpp:493-558`; `C_CollisionResult` `.../CollisionResult.h:28-98` |
| quantised leaf box | `.../AxisBox.h:271-280`; `Fixed3_S16<14>` decode `core/include/core/maths/hvec/Vector.inl:1960-1970` |
| `HenDN3` decode | `core/include/core/maths/hvec/Storage.inl:250-261` |
| ray setup / result | `.../Ray.h:22-117, 166-190` |
| sphere shape | `.../Shapes.h:107-124`; `C_Shape` `.../Shape.h:76-190` |
| fixed stack, SPU cache no-ops | `.../sharedphysics/SafeStack.h:7-92`; `.../sharedphysics/SPU_Memory.h:363-391` |
| constants (`CloseNormal = 0.995f`) | `gravity/source/sharedphysics/GravityConstants.cpp:11` |
| filter defaults | `.../CollisionFilter.h:43-50`, `CollisionFilter.inl:8-43` |

Compiled translation units (all upstream, unmodified):

```text
gravity/source/narrowphase/OptimisedAABBTree.cpp      tree load + FillLineCollisionCache
gravity/source/narrowphase/LineCollisionCache.cpp      C_LineCollisionCache::Trace
gravity/source/narrowphase/Shapes.cpp                  shape construction support
gravity/source/narrowphase/PrimitiveClosestPointsTest.cpp  ClosestPtPointTriangle
gravity/source/narrowphase/PrimitiveIntersectTest.cpp  supporting primitive tests
gravity/source/narrowphase/AABB.cpp                    AABB support
gravity/source/sharedphysics/SPU_Memory.cpp            C_SmallSPUCache
gravity/source/sharedphysics/GravityConstants.cpp      SharedPhysics constants
```

The query templates are instantiated by the harness TU (`OptimisedAABBTree.inl`
is otherwise only included by the huge `SPUScene.cpp`); the template bodies are
unchanged. The remaining 22 objects are the logging/debug closure, time and
thread primitives, `SIMD.cpp`/`Constants.cpp` (the `c_ScalarOne` and
`Maths::Constants` storage), `C_MemoryStream`, `BizAssert`, `endian`,
`CoreMemoryAligned`, and the two existing T-005c platform shims.

`/W4`-equivalent warning gate: the harness itself compiles with
`-Wall -Wextra -Wpedantic -Wno-unused-parameter` and **0 warnings**. The engine
TUs keep their pre-existing upstream warnings (uninitialised `C_Deactivator`
fields, `offsetof` on a non-standard-layout type, an unused expression in
`btl/sequence.h`); none is introduced by this spike.

---

## 2. Loading path

`engine/harness/t005d/gravity_harness.cpp` does the minimum a game caller does:

1. a bounded read finds the `Main` child of the `Physic` root (the framing
   proven in `docs/work/analysis/t005-collision-oracle.md` §1);
2. a `Sys::C_MemoryStream` over the `Main` data is wrapped in
   `Sys::BinaryDeserialiser<Ut::NoEndianSwap>` and given version 10;
3. after `Head` + version, **the first `U32` is the first shape record's type**
   (offset 68), not a stream-level type. The engine reads one type per record
   (`Importer.cpp:271-337`); the harness does the same and does not consume an
   extra word (an early version did, which shifted the tree header by four bytes
   and produced a 1.5 GB `numNodes` — recorded here because the failure is a
   useful boundary check);
4. each record is `ImportBasic` (52 bytes) → `OptimisedAABBTree::DeSerialise` →
   `C_ShapeInstance` (84 bytes); the `0x0fffffff` shape terminator and the
   `0xffffffff` constraint terminator land exactly on the `Main` block end.

Parsed result, identical to the probe (and to the oracle document):

| | mesh 0 | mesh 1 |
| --- | ---: | ---: |
| vertices | 44 970 | 17 671 |
| normals | 25 540 | 1 264 |
| triangles | 31 860 | 12 384 |
| leaves / nodes | 4 147 / 8 293 | 1 768 / 3 535 |
| triangle headers | 6 420 | 1 780 |
| active-edge normal sets | 4 894 | 3 165 |
| triangle stream bytes | 485 040 | 177 088 |

The `m_NumTriangles` field is still the stream's byte capacity, and the load
rewrites it to the used byte count; both values are reported (`485040` /
`177088` used).

---

## 3. Query fixture and engine calls

The harness rebuilds the probe's table from the decoded engine tree, not from
the probe's parse structures: it walks the leaves in the same load-time order,
groups by header, and decodes vertices through the engine's
`Fixed3_S16<14>`/`HenDN3` path. The verifier then compares the emitted ray and
sphere inputs against the committed oracle document: **all 24 ray start /
direction / `maxCosAngle` / `maxDistance` values and all 24 sphere centre /
radius values are bit-identical**. The oracle document does not publish the
eight cache boxes, so those are recorded in the harness JSON for inspection but
have no independent copy to compare against.

Engine calls per probe:

- **ray:** `OptimisedAABBTree::RayTracing<adapter>` where the adapter calls the
  real `CollideRayTriangleMesh`; the adapter exists only to report which leaf
  and header group the engine selected, which `C_RayTracingResult` does not
  expose.
- **sphere:** `OptimisedAABBTree::Collide<6,16,adapter>` with a
  `C_SphereShape`, a `C_CRAxisBox` and a `C_CollisionObject`; the adapter calls
  the real `CollideSphereTriangleMesh<6,16>` **once per triangle** so the
  per-contact append order can be recovered (the group call only distinguishes
  patches). This is semantically the group loop: the function is stateless
  except for `res`, which is threaded through unchanged. Contact geometry now
  matches the probe for all 24 sphere queries; before this adapter the one
  multi-patch query (`sphere-near-2`) differed only in contact order.
- **cache:** `OptimisedAABBTree::FillLineCollisionCache` into a real
  `C_LineCollisionCache`, then `C_LineCollisionCache::Trace` on the same
  object. The engine does not expose the fill counters
  (`bodiesConsidered`, `bodiesAccepted`, `headersFiltered`, `trianglesTested`,
  `trianglesRejectedByNormal`) or which triangle a cache slot holds. The
  harness derives the counters with a scan that must reproduce the engine's
  cached set exactly (same leaf, same per-triangle ordinal) or the run fails
  with `cache_derived_mismatch`; that check passes for all eight queries.

The canonical record writer is a copy of the probe's `probe_io.h` (namespace
renamed `probe`) so the byte layout cannot drift.

---

## 4. Build and run evidence

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

# fresh copy of upstream + scheduler/file overlays + (empty) t005d patch,
# then build twice, run twice, compare with the oracle
& $py engine/verify_gravity.py --fresh

# reuse _work/engine-gravity-spike/tree and the existing modules
& $py engine/verify_gravity.py
```

Measured on this machine:

| gate | result |
| --- | --- |
| patch | `engine/patches/t005d-gravity-overlay.patch`, **0 bytes**, SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| tree | fresh `robocopy` of upstream `5270304b`, then T-005c + T-005b |
| objects | 33 |
| wasm | **134 318 B**, SHA-256 `63217ebf14b9bd089c968f2c0ac3c26947fc0ad655faecef2196871f14c15609` |
| build determinism | rebuild SHA-256 identical |
| run determinism | two node runs byte-identical (`620331d5…fae82d8`) |
| warning gate | harness 0 warnings; engine TUs unchanged upstream warnings |
| Gravity source edits | 0 of 350 files under the tree's `gravity/` differ from upstream |
| mesh structure | both meshes match the oracle counts |
| fixture inputs | 24/24 rays and 24/24 spheres bit-identical to the oracle |
| canonical record bytes | 7 768 (both) |
| `queryHash` | engine `77a533556fe5ed1cee5e3633d685b233990ed6d5a7858265668d39bd6626f94c`; oracle `f87365b7…96e`; **not equal** |
| elapsed | 64.6 s for the full `--fresh`-equivalent run |

The verifier exits 0 with status `DIVERGED (documented)`; `--require-hash` makes
a hash mismatch a hard failure for a caller that wants that gate.

---

## 5. Equality: what matches and what does not

### 5.1 Rays — 24/24 byte-identical

No divergent byte. This covers the whole portability question for the ray path:
`Fixed3_S16<14>` quantisation, `HenDN3` decode, node-box decode, traversal
order, last-hit-wins, the shrinking segment end, the `cosAngle` test, leaf-local
byte-offset `m_TriangleIndex`, header/material reporting and `bodiesTested`
(1 or 2).

### 5.2 Spheres — geometry exact, 6 reporting fields differ

8/24 records are byte-identical. The other 16 differ only in
`contact.physicsMaterial`, `contact.effectMaterial` and
`contact.normal.{x,y,z}`. Contact count, point, penetration, `triangleOrdinal`,
`engineHashValue`, `patch` and `mesh` are identical for every contact of every
query.

### 5.3 Cache fills — cached set exact, three fields differ

1/8 records (the miss with an empty cache) is byte-identical. For the rest, the
cached triangles' vertices, per-triangle ordinals, leaf indices, collision
flags, materials, user data and packed normals are identical; the trace contact
point, distance, ordinals, leaf, materials and user data are identical. Only the
fields below differ.

### 5.4 The six divergent fields, with measured values

| # | field | engine (real code) | probe re-expression | source of the difference |
| --- | --- | --- | --- | --- |
| 1 | sphere `physicsMaterial` / `effectMaterial` | `0x00010000` / `0x00060000` for `point-vertex-0` | `1` / `6` | `OptimisedAABBTree.inl:112-113,126-128` packs `shapeMaterial \| headerMaterial << 16`; `CollisionResult.h:36-38` documents high 16 = body A, low 16 = body B. The probe stored the header value. |
| 2 | sphere contact `normal` | patch normal, e.g. `(0.636080, −0.067159, 0.768695)` repeated for all four points of a patch; zero for a radius-0 point exactly on a vertex | per-contact normalised `d`; `0xffc00000` (NaN) for the zero-length case | `SphereTriangle.inl:158-168` stores the normal on the **patch**; `C_ContactPoint` has no normal (`CollisionResult.h:28-40`). `C_Normal(d)` uses `Maths::ReciprocalSqrt` (`MathsUtil.h:562-566`), which returns 0 for `src <= 0`; the probe's exact `1/sqrt` yields NaN at zero. |
| 3 | cache entry `engineTriangleIndex` | header group's first ordinal + leaf stream start: `cache-0` = `[0,0,0]`, `cache-5` = `[421428,421428,421428,421616]` | per-triangle ordinal: `[0,1,10]`, `[421431,421433,421436,421616]` | `OptimisedAABBTree_FillCache.inl:201` passes `a` (the group's first ordinal), not `a+b`, to `AddTriangle`. |
| 4 | cache trace `collisionFlags` | `0x44a7d3ac` (`cache-0`), `0x4307a311` (`cache-5`) | `0x0000017f` (the cached triangle's flags) | the thin branch of `LineCollisionCache_Trace.inl:184-225` assigns contact, distance, index, materials, user data, shape and node but **never** `m_CollisionFlags`. The value is whatever the result object contained. |
| 5 | cache trace `normal` | non-unit copy, e.g. `(0.092864, 0.990225, −0.093933)`, length 0.998996; `(−0.012708, 0.999022, 0)` length 0.999103 | unit: `(0.092957, 0.991220, −0.094028)` / `(−0.012719, 0.999919, 0)` | `LineCollisionCache_Trace.inl:210` assigns `C_Normal(tri.m_Normal, UNIT_LENGTH_VECTOR)`, which copies without normalising (`Vector.inl:8013-8016`); `AddTriangle` stored the decoded `HenDN3` the same way (`LineCollisionCache.h:122`). The probe normalised. |
| 6 | cache trace `engineTriangleIndex` | `cache-1`: `84085` | `84086` | same group-start versus per-triangle ordinal issue as #3, carried through `m_result.m_TriangleIndex` (`LineCollisionCache_Trace.inl:212`). |

Consequences:

- The **first** divergent canonical query is 24 (`point-vertex-0`), byte 48
  (`contact[0].physicsMaterial`), engine `00` vs probe `01`. The first cache
  divergence is query 48 (`cache-0`), record byte 100
  (`entry[1].engineTriangleIndex`), engine `0` vs probe `1`.
- Fields #1, #2, #4, #5 are *reporting semantics*, not query results. The
  contact point, penetration, distance and triangle identity agree. Field #3/#6
  are the engine's documented "not a triangle id" value; the probe's doc
  claimed it was `triangleOrdinal + node.triangleStartIndex`, but the engine
  passes the group's first ordinal. This is a probe documentation error, and it
  matters for anyone who uses the cache index to look a triangle up.
- **Field #4 is an engine defect** (an unassigned out-field in the thin trace
  branch), not a port choice. A port that wants a defined value has to add one;
  the probe already did (by copying the cached triangle's flags) without
  recording that it was adding information the engine does not return.
- No numeric difference from `Normalise()` appears in the ray path: the web
  scalar path's `Maths::ReciprocalSqrt` is exact IEEE `1/sqrt`, and the ray
  records match. The only normalisation difference is the zero-length guard
  (#2) and the fact that #5 does not normalise at all.

---

## 6. Overlay patch: empty by measurement

`engine/patches/t005d-gravity-overlay.patch` is 0 bytes. The T-005c scheduler
overlay and T-005b file overlay are sufficient to compile the Gravity
translation units above with:

```text
-DBUILD_CONFIG_SPEED -DPLATFORM_WEB -std=c++14 -O2 -fno-fast-math
-ffp-contract=off -fdelayed-template-parsing -D__restrict= -fdeclspec
-include engine/harness/t005b/msvc_crt_web.h
-include engine/harness/t005c/web_platform.h
```

`-fdelayed-template-parsing` and `-D__restrict=` are the T-005a grammar
workarounds already required by the engine headers (measured: removing
`-fdelayed-template-parsing` fails in `Geometry.inl`/`SI.inl`). No new numeric
or platform shim was needed. In particular the `Maths::Abs/Sign/Reciprocal/
ReciprocalSqrt(float)` specialisations that look empty on PS3 have a non-PS3
definition at `MathsUtil.h:499-524, 536-566`, and `c_ScalarOne` /
`Maths::Constants` come from the upstream `SIMD.cpp` / `Constants.cpp` TUs.

The verifier proves the absence of engine edits two ways:

1. `engine/verify_gravity.py` applies the patch and records `files: []`;
2. it compares all **350** files under the tree's
   `code/mercury/library/physics/gravity/` with upstream byte for byte and
   fails on any difference (`gravityTree: {files: 350, changed: 0}`).

PC path: no engine source is edited, so the PC build is unchanged by
construction. The only committed artefacts are this document, the empty patch,
`engine/verify_gravity.py`, and new files under `engine/harness/t005d/`.

---

## 7. What is not claimed

- **Not** bit-equality with the committed probe: `queryHash` differs, and §5.4
  names every field responsible.
- **Not** retail-binary equality. This compares the wasm build of the source
  with the probe's source-level re-expression, not with `Amax.exe`.
- **Not** the fat/swept-sphere ray (`m_bFatTrace`), capsule/box/OBB proxies,
  constraints, `Routes` scenes, non-identity instances, the contact solver, the
  vehicle, the renderer or a playable game.
- **Not** a statement that the cache `engineTriangleIndex` is a triangle id. It
  is not; see §5.4 #3.
- **Not** a claim that the uninitialised `m_CollisionFlags` (#4) is stable. It
  was identical across the two runs measured here, but the engine never assigns
  it, so no caller may rely on its value.

---

## 8. Blockers and the next smallest step

**Blockers at the end of this spike:** none for the static mesh query. The
sphere/cache equality gate cannot be closed without deciding, in the probe's
contract, which of the six fields are "engine output" and which are
"probe-added reporting". That decision is a contract change, not a port fix.

**Next smallest step (proposed, not done):** add a second canonical record
definition (`formatVersion 2`) that reports the engine's actual values:

1. sphere materials as `shapeMaterial | headerMaterial << 16` (or split them
   into explicit `bodyMaterial` / `triangleMaterial` fields, which is clearer);
2. sphere normals as `patchNormal` plus an explicit `patchIndex`, with the
   per-contact normal only if the probe recomputes it (and then labelled);
3. cache `engineTriangleIndex` renamed to `engineTriangleStreamValue` and
   accompanied by `leafStartOrdinal` and `perTriangleOrdinal`;
4. cache trace `collisionFlags` labelled `unassignedByEngine` (or omitted)
   until the engine's thin branch is fixed;
5. cache trace `normal` labelled `storedNonUnit` (the engine's value) and
   `normalised` if the caller wants both.

That change would make a future `queryHash` an engine contract, and the 24/24
ray result shows the hard part (decode, traversal, intersection) is already
exact. Only then is a vehicle/D2 comparison meaningful.

---

## 9. Evidence index

| topic | path |
| --- | --- |
| verifier (fresh tree → build×2 → run×2 → record compare) | `engine/verify_gravity.py` |
| overlay patch (0 B) | `engine/patches/t005d-gravity-overlay.patch` |
| harness source | `engine/harness/t005d/gravity_harness.cpp` |
| canonical-record helpers (probe copy) | `engine/harness/t005d/probe_io.h` |
| node driver | `engine/harness/t005d/run_gravity_wasm.mjs` |
| verification report | `_work/logs/engine-gravity-spike/verify-gravity.json` |
| engine document (run a) | `_work/engine-gravity-spike/gravity_a.json` |
| engine document (repeat) | `_work/engine-gravity-spike/gravity_b.json` |
| build/run logs | `_work/logs/engine-gravity-spike/` |
| wasm module | `_work/engine-gravity-spike/out/gravity_a.mjs` + `.wasm` |
| committed probe and oracle | `probes/collision-oracle/`, `_work/collision-oracle/native.json` |

Source anchors were read from `upstream/BlurRebuilt@5270304b`.
