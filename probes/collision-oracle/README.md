# T-005d collision oracle probe

Standalone, engine-free proof that the static collision mesh of a shipped
`Level.levelphysics` can be decoded and queried with the **same integer and
binary32 results** on native x64 and wasm32, cross-checked against an
independent Python implementation.

It is a probe, not engine code: no Gravity header is included, no engine code is
linked, the game is not run, and nothing here is wired into the browser build.

Scope labels recorded in every output document:

```json
"scope": {
  "engineIntegration": false,
  "vehiclePhysics": false,
  "gameRun": false,
  "rayRadius": "0x00000000",
  "fatTrace": "unsupported",
  "sphereQuery": "CollideSphereTriangleMesh<6,16>",
  "normalisation": "exact-ieee-1/sqrt",
  "instanceTransforms": "none (C_ShapeInstance is reported, not applied)"
}
```

---

## 1. What it does

1. Parses the PC block stream (`"  CP"` fourcc, `Physic` root, `Header`/`Main`/
   `Routes` children) with bounded reads; every failure names a byte offset.
2. Parses the Gravity import stream (`Head` + stream version, then
   `E_ImportTriangleMesh_Shape` descriptors) and each `OptimisedAABBTree` v10,
   including the per-leaf vertex quantisation that the engine performs at load
   time.
3. Answers a fixed, reproducible query table:
   - **24 thin ray casts** through `OptimisedAABBTree::RayTracing` +
     `CollideRayTriangleMesh` (radius 0, `maxCosAngle` −0.25 for the twelve
     wheel-style downward rays and +1.0 for the twelve diagnostic rays);
   - **24 sphere / point queries** through
     `CollideSphereTriangleMesh<Static_MaxPatches=6, Static_MaxContacts=16>`
     (6 radius-0 point queries on decoded vertices, 10 near-surface spheres,
     8 empty-space spheres);
   - **8 line-cache queries**: `FillLineCollisionCache` (the wheel ground-query
     box, 4-entry cache) followed by `C_LineCollisionCache::Trace`.
4. Emits a deterministic JSON document plus a `queryHash` = SHA-256 over a fixed
   binary record per query.

Every float is emitted as its **8-digit hex binary32 bit pattern**, never as
decimal text, so native and wasm32 documents are byte-identical without relying
on libc float formatting.

---

## 2. Layout

```text
probes/collision-oracle/
  CMakeLists.txt                 native build (MSVC /W4 /permissive- /fp:precise)
  src/oracle_math.h              scalar re-expression of the HVec3 operations used
  src/level_physics.h|.cpp       block framing + import + tree parse (bounded)
  src/queries.h|.cpp             ray trace, cache fill, cache trace, sphere query
  src/query_table.h|.cpp         fixed query fixture (seeded xorshift32)
  src/probe_io.h                 LE binary writer, SHA-256, JSON emitter
  src/oracle_run.h|.cpp          shared driver + structural self-test
  src/probe_main.cpp             native CLI
  src/wasm_entry.cpp             wasm32 exports
  tests/oracle_tests.cpp         synthetic rejection, prefix cuts, real-file checks
  tests/reference_oracle.py      independent Python implementation
  tests/verify_oracle_wasm.mjs   node driver for the wasm module
  tests/run_collision_oracle.py  builds/runs/compares everything
```

All build output and evidence go to `_work/collision-oracle/`; nothing generated
is written under `probes/`.

---

## 3. Build and run

Use the bundled Python if `python` is a Store alias:
`C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe`.

### One command (native + wasm32 + Python + determinism + malformed input)

```powershell
python probes/collision-oracle/tests/run_collision_oracle.py
```

Reuse existing binaries:

```powershell
python probes/collision-oracle/tests/run_collision_oracle.py --skip-build
```

### Manual native build

```powershell
$cmake = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
& $cmake -S probes/collision-oracle -B _work/build/collision-oracle-native -G "Visual Studio 17 2022" -A x64
& $cmake --build _work/build/collision-oracle-native --config Release
& "_work/build/collision-oracle-native/Release/collision_oracle_tests.exe" game-data/Blur/levels/usa_la_river/Level.levelphysics
& "_work/build/collision-oracle-native/Release/collision_oracle_cli.exe" --selftest
& "_work/build/collision-oracle-native/Release/collision_oracle_cli.exe" `
    --in game-data/Blur/levels/usa_la_river/Level.levelphysics `
    --out _work/collision-oracle/native.json
```

CTest (2 tests; the unit binary takes the level path as an optional argument):

```powershell
& "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\ctest.exe" `
  --test-dir _work/build/collision-oracle-native -C Release --output-on-failure
```

### Manual wasm32 build and run

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
& $py _work/toolchains/emsdk/upstream/emscripten/em++.py `
  probes/collision-oracle/src/level_physics.cpp probes/collision-oracle/src/queries.cpp `
  probes/collision-oracle/src/query_table.cpp probes/collision-oracle/src/oracle_run.cpp `
  probes/collision-oracle/src/wasm_entry.cpp `
  -std=c++17 -O2 -fno-fast-math -ffp-contract=off `
  '-sMODULARIZE=1' '-sEXPORT_ES6=1' '-sENVIRONMENT=node,web' `
  '-sALLOW_MEMORY_GROWTH=1' '-sINITIAL_MEMORY=67108864' --no-entry `
  '-sEXPORTED_FUNCTIONS=_oracle_run,_oracle_free,_oracle_selftest,_oracle_flags,_malloc,_free' `
  '-sEXPORTED_RUNTIME_METHODS=UTF8ToString,stringToUTF8,lengthBytesUTF8,HEAPU8' `
  -o _work/collision-oracle/build/collision_oracle.mjs
node probes/collision-oracle/tests/verify_oracle_wasm.mjs `
  _work/collision-oracle/build/collision_oracle.mjs `
  game-data/Blur/levels/usa_la_river/Level.levelphysics `
  _work/collision-oracle/wasm.json
```

### Python reference only

```powershell
python probes/collision-oracle/tests/reference_oracle.py `
  --in game-data/Blur/levels/usa_la_river/Level.levelphysics `
  --out _work/collision-oracle/reference.json
```

### CLI

```text
collision_oracle_cli --in <Level.levelphysics> [--out <json>]
collision_oracle_cli --selftest
```

Exit codes: `0` ok, `1` self-test failure, `2` bad argument, `3` read failure,
`4` write failure, `5` the oracle reported `status:"error"`.

---

## 4. Canonical records and `queryHash`

`queryHash` is SHA-256 over the concatenation of one fixed little-endian record
per query. Integer fields are `u32` LE, float fields are their binary32 bit
pattern as `u32` LE.

**Ray record** (`kind=1`), 80 bytes:

| # | Field |
| --- | --- |
| 1 | `u8 kind=1`, `u8 hit`, `u16 0` |
| 2 | `u32 queryIndex` |
| 3 | `u32 mesh` (`0xffffffff` = none) |
| 4 | `u32 leaf` (node index) |
| 5 | `u32 triangleOrdinal` (within the leaf) |
| 6 | `u32 engineTriangleIndex` (leaf-relative byte offset, see §6) |
| 7 | `u32 headerIndex` |
| 8 | `u32 collisionFlags` |
| 9 | `u32 physicsMaterial` |
| 10 | `u32 effectMaterial` |
| 11 | `u32 userData` |
| 12 | `u32 normalPacked` (raw `HenDN3`) |
| 13..15 | contact `x y z` |
| 16..18 | normal `x y z` |
| 19 | `f32 distance` |
| 20 | `u32 bodiesTested` |

**Sphere record** (`kind=2`): `u8 kind, u8 hit, u16 0, u32 queryIndex,
f32 radius, f32 centre xyz, u32 headersFiltered, u32 contactCount`, then per
contact `u32 mesh, u32 triangleOrdinal, u32 engineHashValue, u32 patch,
u32 physicsMaterial, u32 effectMaterial, f32 point xyz, f32 surfaceNormal xyz,
f32 penetration`.

**Cache record** (`kind=3`): `u8 kind, u8 hit, u16 0, u32 queryIndex,
u32 cachedTriangles, u32 bodiesConsidered, u32 bodiesAccepted,
u32 headersFiltered, u32 trianglesTested, u32 trianglesRejectedByNormal`, then
per cached triangle `u32 engineTriangleIndex, u32 triangleOrdinal, u32 leaf,
u32 collisionFlags, u32 physicsMaterial, u32 effectMaterial, u32 userData,
u32 normalPacked, f32 a xyz, f32 b xyz, f32 c xyz`, then the trace result
`u32 engineTriangleIndex, u32 triangleOrdinal, u32 leaf, u32 collisionFlags,
u32 physicsMaterial, u32 effectMaterial, u32 userData, u32 normalPacked,
f32 contact xyz, f32 normal xyz, f32 distance`.

A miss writes `0xffffffff` for the index fields and `0` for the material/flag
fields; the trace part writes `0xffffffff` for the first three fields only.

---

## 5. Query fixture

All coordinates are derived from the parsed mesh with pinned integer/float
operations; nothing is a hand-tuned constant.

- `ray-down-N` (12): a 4×3 grid over the union bounds, origin `hi.y + 4`,
  direction `-Y`, distance `(hi.y−lo.y)+8`, `maxCosAngle = −0.25` (the wheel
  value from `car.cpp:618`).
- `ray-random-N` (12): pick global triangle `rng.next() % total`, aim at its
  centroid from `centroid + dir*40`, `maxCosAngle = +1.0` so every facing is
  accepted. This exercises traversal order and ties.
- `point-vertex-N` (6): a radius-0 sphere centred exactly on the decoded `A`
  vertex of triangle `(N*total)/6`. A correct decode must produce a contact with
  penetration 0.
- `sphere-near-N` (10): centroid of a random triangle offset by
  `normal*(0.5*radius)`, radius `0.25 + 2*u`.
- `sphere-empty-N` (8): uniform point in the level bounds, radius `0.5 + 3*u`.
- `cache-N` (8): a 1.5 m box around `centroid + normal`, and one whole-level box
  (`cache-7`) that fills the 4-entry cache immediately; fill with
  `normal = -Y`, `maxCosAngle = −0.25`, then trace down from above the box.

`Rng` is xorshift32 with per-query seeds `0xA5A50000+i`, `0xBEEF0000+i`,
`0xC0DE0000+i`; `unit()` is `(next() >> 8) * 2^-24`, exact in binary32. Each
draw is sequenced into its own statement: relying on function-argument
evaluation order made MSVC (right-to-left) and clang (left-to-right) consume
the RNG differently, which silently swapped the x/z components of the first
fixture. That divergence is why the fixture is written this way.

---

## 6. Engine quirks that are reproduced, not fixed

| Quirk | Effect | Source |
| --- | --- | --- |
| Triangles store **leaf-local `u8` indices** (the file writes `u8` because the target field is `u8`, even though `OldAABBTreeTriangle` used `u32`) | a triangle index is only meaningful with its leaf | `OptimisedAABBTree.h:66-88`, `OptimisedAABBTree.cpp:29-53` |
| `m_NumTriangles` in the file is a **byte capacity** for the in-memory triangle stream, not a triangle count | 485 040 bytes for 31 860 triangles; the actual stream equals the capacity exactly | `OptimisedAABBTree.cpp:187, 306-310` |
| `C_TriangleHeader` is 15 serialised bytes but `sizeof()` 16; `AABBTreeTriangle` is 11 serialised bytes but `sizeof()` 12 | stream offsets and `engineTriangleIndex` use the 16/12 in-memory sizes | `OptimisedAABBTree.cpp:282-305` |
| `C_LineCollisionCache` stores `effectMaterial` in a `U16` | the value is truncated to its low 16 bits | `LineCollisionCache.h:18, 151` |
| `FillLineCollisionCache` records `triangleOrdinal + node.triangleStartIndex` (a byte offset) | the cache "triangle index" is not a triangle id | `OptimisedAABBTree_FillCache.inl:201` |
| `CollideRayTriangleMesh` records `offset + 12*i` (leaf-relative byte offset) and keeps the **last** accepted triangle in the leaf, not the nearest | ray ties are resolved by traversal order | `RayTriangle.inl:96-104` |
| The tree ray loop passes `ray.m_result.m_contact` as the segment end, and a leaf hit shortens it | later leaves are tested against a shorter segment | `OptimisedAABBTree.inl:176, 217` |
| `C_LineCollisionCache::Trace` (thin) keeps the **last** hit in cache order and compares the plane test against the *original* `ray.m_end` while the triangle test uses the shrinking contact | a further hit can override a nearer one | `LineCollisionCache_Trace.inl:184-205` |
| `FillLineCollisionCache` **returns** as soon as the cache is full | later bodies/leaves are not visited | `OptimisedAABBTree_FillCache.inl:199-200` |
| `CollideSphereTriangleMesh` prepares a patch slot, then may merge into an existing patch and not count the slot | `numPatches` does not simply increase per contact | `SphereTriangle.inl:162-183` |
| Sphere patch merge threshold is `dot >= 0.995` (`CloseNormal`) | contacts within ~5.7° share a patch | `GravityConstants.cpp:11` |

Because of the byte-offset "triangle index", the probe also reports
`triangleOrdinal` (within the leaf), `leaf`, and `headerIndex` so a hit can be
identified unambiguously. No global triangle id is invented by the engine.

---

## 7. Results (this machine, 2 November 2026)

Command: `python probes/collision-oracle/tests/run_collision_oracle.py`

```text
configure-native                   PASS
build-native                       PASS
native-warning-free                PASS 0 warning line(s)
build-wasm                         PASS
native-selftest                    PASS
native-unit-tests                  PASS
run-native                         PASS 0.02s
run-native-repeat                  PASS
determinism-native                 PASS
native-vs-wasm                     PASS
native-vs-wasm-document            PASS (input.label excluded)
determinism-wasm                   PASS
run-reference                      PASS 0.34s
native-vs-python                   PASS
malformed-rejection                PASS 13/13
23/23 checks passed
```

- `queryHash` (native = wasm32 = Python):
  `f87365b79fc1217da4280d6d5748ca6dc6808b89382b87de43ddcbfe6c9b5d6e`
- canonical record bytes: 7 768
- input: `Level.levelphysics`, 1 945 409 bytes,
  SHA-256 `1e678b2dff61b6d3a3d5d95a5160c3f713290251667cb27c55e262175efe4e28`
- native MSVC `/W4 /permissive-`: **0 warnings**
- CTest: 2/2 (`collision_oracle_selftest`, `collision_oracle_unit`)
- wasm32: 121 219 B `.wasm`, node run 0.08 s; native 0.02 s
- CTest unit binary also validates the real file: two meshes, 44 244
  triangles, `triangleBufferBytes == triangleCapacityBytes`, identity instance
  transforms, 64 evenly spaced file truncations rejected.

Parsed level:

| | mesh 0 | mesh 1 |
| --- | ---: | ---: |
| vertices | 44 970 | 17 671 |
| normals | 25 540 | 1 264 |
| triangles | 31 860 | 12 384 |
| leaves | 4 147 | 1 768 |
| nodes | 8 293 | 3 535 |
| triangle headers | 6 420 | 1 780 |
| active-edge normals | 4 894 | 3 165 |
| triangle capacity / stream bytes | 485 040 / 485 040 | 177 088 / 177 088 |
| descriptor `m_CollisionFlag` | `0x0001017f` | `0x0000005d` |
| instance transform | identity | identity |
| triangle hash | `07df0bb23c210bfb…` | `e9e01fc59eeb918a…` |

Union bounds: min `(−117.030, −107.368, 834.968)`, max
`(1692.342, 125.976, 3485.234)`.

Query outcomes: 15/24 rays hit, 60 sphere contacts across 17/24 sphere queries,
cache fills 3/1/1/1/4/4/0/4 triangles, 5/8 cache traces hit.

Two concrete rows:

| query | mesh | leaf | tri | engineIndex | distance | normal |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `ray-down-5` | 0 | 2862 | 0 | 16 | 126.9792 | (0.1760, 0.9814, −0.0607) |
| `ray-random-23` | 1 | 1571 | 1 | 28 | 0.4238 | (0.9990, 0.0000, −0.0254) |

---

## 8. Malformed / truncated input

13 cases: corrupted PC marker, corrupted root id, root size beyond EOF, four
plain truncations, and five truncations whose root/Main sizes were patched so
the block framing stays self-consistent and the bounded reader is what fails.
Native and wasm32 produce identical codes and offsets; the Python reference
rejects every case (its guard order differs, so its diagnostic is recorded
rather than required to match).

| case | native/wasm32 code | offset | Python code |
| --- | --- | ---: | --- |
| `marker-bad` | `bad_pc_marker` | 0 | `bad_pc_marker` |
| `root-id-bad` | `bad_root_block` | 4 | `bad_root_block` |
| `root-size-bad` | `block_overruns_parent` | 4 | `block_overruns_parent` |
| `truncate-1024` | `block_overruns_parent` | 4 | `block_overruns_parent` |
| `truncate-empty` | `file_too_small` | 0 | `file_too_small` |
| `inner-truncate-139` | `read_u32` | 136 | `read_u32` @136 |
| `inner-truncate-900000` | `read_u32` | 899 997 | `read_u32` @899 997 |
| `inner-truncate-1896890` | `read_f32` | 1 896 888 | `read_f32` @1 896 888 |
| `inner-truncate-1024` | `vertex_count_overruns` | 124 | `read_f32` @1024 |
| `inner-truncate-641965` | `node_count_overruns` | 124 | `read_s16` @641 964 |

Full table and the exact files: `_work/collision-oracle/summary.json`,
`_work/collision-oracle/malformed/`.

---

## 9. Not implemented — deliberate, with the reason

| Missing | Reason |
| --- | --- |
| **Fat ray / swept sphere trace** (`m_bFatTrace`, the wheel's real query) | needs `IntersectTriangleSegmentSB`'s swept-sphere branch (`Primitive.inl:780-830`) *and* the wheel radius, which comes from car/XT data, not from the level file. `rayRadius` is fixed at 0 and reported. |
| **Sphere/capsule/box proxies of real bodies** | only the sphere path (`CollideSphereTriangleMesh`) is implemented; OBB/capsule/cylinder meshes go through GJK/MPR TUs that are a different closure. |
| **Constraint records** | the probe accepts only an empty constraint list; this file has none. Any other type stops with `unsupported_constraint` at the byte offset. |
| **`Routes` import scenes** (7 in this file) | not parsed; the block is validated and reported (`routesParsed:false`). They are route/trigger geometry, not the main static mesh. |
| **Other import shape types** | only `E_ImportTriangleMesh_Shape` (0) is accepted; anything else stops with `unsupported_shape_type` at the offset. |
| **`C_ShapeInstance` transform application** | reported, not applied. All instances in this file are identity, so applying them would be a no-op, but the probe does not claim to support non-identity instances. |
| **The engine's approximate `Normalise`** | the retail PC build uses `_mm_rsqrt_ps` + one Newton–Raphson step (`SIMD_SSE.inl:937-939`), which is not correctly rounded and has no wasm equivalent. The probe uses exact `1/sqrtf` and records `normalisation:"exact-ieee-1/sqrt"`. Any port that must be bit-identical to retail normals has to emulate that instruction. |
| **Engine integration, vehicle physics, a playable game** | explicitly out of scope. |

---

## 10. Evidence

```text
_work/collision-oracle/summary.json       all checks, hashes, malformed table
_work/collision-oracle/native.json        native x64 document
_work/collision-oracle/native2.json       repeat run (byte-identical)
_work/collision-oracle/wasm.json          wasm32 document
_work/collision-oracle/reference.json     independent Python document
_work/collision-oracle/logs/*.log         every command's stdout/stderr
_work/collision-oracle/malformed/*.bin    the rejected inputs
```

Analysis document: `docs/work/analysis/t005-collision-oracle.md`.
