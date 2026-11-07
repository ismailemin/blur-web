# Map-slice E1 module pin policy (behavior-based)

**Date:** 7 November 2026
**Owner:** MAP5 follow-up
**Scope:** `probes/map-slice/**`, `_work/map-slice/**`,
`_work/logs/map-slice/**` and `docs/work/analysis/map-slice-*.md`. No change to
`probes/e1-drive`, `probes/asset-reader`, `probes/map-pipeline`, `tools/`,
`upstream/` or `game-data/`.

**No renderer, GPU, browser, playable-game or full-game claim is made.**

---

## 1. Why the pin changed

The slice packages used to hard-pin the E1 wasm module by file hash. Any
`_work/e1-drive/module` rebuild — the 15-car batch, Nitro work or a local
rebuild — changed those bytes even when the recorded physics behaviour was
identical, so `verify_slice.py` failed on module/build/wasm hashes while every
collision, draw, layout, spawn and per-tick state check still passed.

The canonical Amboy and Gracia packages were replayed with the current module
and now record the current identity, but the verifier no longer depends on byte
equality for future rebuilds.

## 2. Policy

`verify_slice.py` treats `source.e1Module` and `source.e1Build` as **soft
pins**:

1. The path must exist; the current module/build bytes and SHA-256 are read and
   recorded as informational `observedE1Identity`.
2. The package's own `physics-settle.json` must remain internally consistent
   with the package's recorded pin (`physics.module.packagePin`).
3. The verifier runs the **current** `_work/e1-drive/module/e1_drive.mjs` on the
   package physics bytes at the recorded spawn, twice, through
   `physics_settle.mjs --out _work/logs/map-slice/physics-replay/<level>.json`.
4. It compares **all 61 per-tick state hashes** and the sequence hash with the
   committed `physics-settle.json`. A binary/module hash drift is accepted only
   when both match. If they differ, the verifier fails with the first mismatching
   tick and the exact expected/replayed hashes.
5. The current module/build/wasm identity is reported in
   `verify.json.recomputed.physics.e1ModulePolicy` and
   `verify.json.observedE1Identity`; it is not a failure condition by itself.

This keeps the hard proof on behaviour (the same simulation result) while
allowing independent module rebuilds. Geometry, collision, draws, layout, spawn,
textures and manifests are still hard-pinned.

## 3. Current identity at refresh

| item | bytes | SHA-256 |
|---|---:|---|
| `_work/e1-drive/module/e1_drive.mjs` | 11,480 | `5177ea975151fb085a44b8b960e384913d36a7e225078a1783f90e1f0b1bff2a` |
| `_work/e1-drive/module/build.json` | 3,466 | `8493193cb8aacc5a9d108874318c612298b46edb5fe28b12c8558b7f0d5c7577` |
| `_work/e1-drive/module/e1_drive.wasm` | — | `bcdc2d994a499cc399333b44cfc418d6594f8b5182a668c3a9df761d891de265` |

Both packages replayed to their committed sequences with 61/61 tick hashes
equal:

| package | sequence hash | ticks | result |
|---|---|---|---:|
| `usa_amboy` | `sha256:d25c4592df994e6a90ca362ebdbdea33c7a247f36b05395b9f786f6d53491b38` | 61/61 | identical |
| `spa_barcelona_gracia` | `sha256:4fd8ae0c0256758eaa9378c4cd3e46e7b04c39803a3ef81b7cc83eb2386e8e30` | 61/61 | identical |

## 4. Refresh tool

`probes/map-slice/tools/refresh_module_pin.py` refreshes only the recorded
module/build identity:

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
& $py probes/map-slice/tools/refresh_module_pin.py --package _work/map-slice/amboy
& $py probes/map-slice/tools/refresh_module_pin.py --package _work/map-slice/gracia
```

It replays the current module into
`_work/logs/map-slice/refresh/<short>-physics-settle.json`, refuses to continue
if any tick/sequence hash differs, then rewrites only:

- `slice.json.source.e1Module` / `source.e1Build`;
- `slice.json.physicsProof` (settle hash/summary/determinism/wasm hash);
- `slice.json.hashes.files["physics-settle.json"]` and the content hash;
- `physics-settle.json` (module identity block and the added `pinnedSha256` /
  `pinnedBuildJsonSha256` informational fields; tick records unchanged);
- the `inputs.slice.sha256` pin in `bindings.json`, `blockers.json` and
  `summary.json`.

No collision, draw, UV0, index, layout or spawn byte is rewritten. The texture
data rows are unchanged; the texture verifier re-runs the binder and compares
the patched manifest byte-for-byte.

## 5. Canonical package hashes after refresh

### `usa_amboy`

| file | bytes | SHA-256 |
|---|---:|---|
| `_work/map-slice/amboy/slice.json` | 1,632,556 | `8f5e07d681353b47abb799fdcd69b716fecca225d7a2f76dab48bf14b501b3d7` |
| `_work/map-slice/amboy/physics-settle.json` | 40,213 | `79f1a2bcc944e7bdb13d3860206496e4dc7910050f15d3827a4e64ffe7427a97` |
| `_work/map-slice/amboy/verify.json` | 3,328 | `c24d7acf8f4c717c60386f67754e1505f75de42b1b8be964a499d64e0a6de910` |
| `_work/map-slice/amboy-textures/bindings.json` | 1,906,505 | `10b3d30f4dab6d71c1367c85fa7c4c4aeafacadf5fd19d8eabe8fb5267bb5e6a` |
| `_work/map-slice/amboy-textures/blockers.json` | 108,445 | `2316e341dbf24e96dae8e5d7f30f271c637e46a154c6f90bed844a01a1c06a18` |
| `_work/map-slice/amboy-textures/summary.json` | 58,414 | `bba658ca217a9ffc2745cac51ec3aeacc364752ad89abfbe1bac2f5b93cfcbf9` |
| `_work/map-slice/amboy-textures/verify.json` | 1,200,667 | `eff75804b198545f5a19b5890a8568651592e10d2107edf4c0865046c709a496` |
| `_work/map-slice/amboy-render/render.json` | 1,096,353 | `0f73b248a58fe8b650b0f862898ad8b9affdcb61f0f6e70f9637d24d96231117` |
| `_work/map-slice/amboy-render/verify.json` | 1,113 | `29b568fad3b522ef4a840815123546853d48d1c3788f716b0fe01f7e5205aa53` |

Slice content hash: `61915aedfaab43b6b327c3ef803c896ea55397bc7dc7a4d2757f340632043ec8`.
Render content hash: `626d39534bc3a37e5878c6801443c580aba576e45f3cba10ddb73a7edc50bf71`.

### `spa_barcelona_gracia`

| file | bytes | SHA-256 |
|---|---:|---|
| `_work/map-slice/gracia/slice.json` | 2,656,163 | `e1e1fe62c6e36d8ea71a7b82303b4ff4b6abafcb9fad2810e019be1292652534` |
| `_work/map-slice/gracia/physics-settle.json` | 39,160 | `58738fa6efe2cf591533c46c3926b7eff5c49426032d9aed911dffd24ef18e07` |
| `_work/map-slice/gracia/verify.json` | 3,360 | `99cdb80cb93e3091b04c71de39334613786aa60b34cdf4c8e10b8fc99af20af8` |
| `_work/map-slice/gracia-textures/bindings.json` | 4,568,799 | `14ea1b636535834bd7ac1fa72803c5c66bfa24a911c06413f198d5706a111fa6` |
| `_work/map-slice/gracia-textures/blockers.json` | 124,114 | `89daa123156b6e341ef8df2120492e2882079dcae58059b4a1ecde83e57bc170` |
| `_work/map-slice/gracia-textures/summary.json` | 244,013 | `e170b2429d59c322e605d494bde88bad342971869385aa363cdb0cd2a0d27cf4` |
| `_work/map-slice/gracia-textures/verify.json` | 3,022,346 | `4f3ffcecb74a2b9f53a7446d2e8396e3fcc67f22f52a89245bb9354e1b072018` |
| `_work/map-slice/gracia-render/render.json` | 3,079,731 | `fd6266501fedb8eada56a0bc2e0b166eb3baff0345e1548786c8bcf4e2b3f514` |
| `_work/map-slice/gracia-render/verify.json` | 1,118 | `5605dd41eca9e84c3ff3f3a095c345926a4f43e96c049a1f802bd09a31487d71` |

Slice content hash: `c1bdf1a7c91d0cd0d1866e28ab9140975401e9927f8466facded2cc5d6e89fef`.
Render content hash: `1fae82cf504afd9e3a88f55a0f310d7b09c8d42e494d23d775e80ef8b8516280`.

## 6. Verification after refresh

| gate | result |
|---|---|
| `verify_slice.py --package _work/map-slice/amboy` | **PASS, 12,367 checks, 0 errors**; 61/61 tick hashes; sequence identical |
| `verify_slice.py --package _work/map-slice/gracia` | **PASS, 26,797 checks, 0 errors**; 61/61 tick hashes; sequence identical |
| `verify_amboy_texture_bindings.py` | **PASS, 13,093 checks, 0 failures** |
| `verify_amboy_render.py --package _work/map-slice/amboy-render` | **PASS, 17,813 checks, 0 errors**; two builds identical `53fba81b…88d5e` |
| `verify_amboy_texture_bindings.py --level spa_barcelona_gracia` | **PASS, 32,782 checks, 0 failures** |
| `verify_amboy_render.py --package _work/map-slice/gracia-render --level spa_barcelona_gracia` | **PASS, 45,590 checks, 0 errors**; two builds identical `4a863063…e22f` |
| `python tools/verify_asset_probe.py --skip-build` | **43/43 PASS**, including `pickup-placements`, `map-slice-amboy`, `amboy-textures`, `amboy-render` |

The texture verifier's repeat build is the proof that the patched
`bindings.json`/`summary.json` input pins are exactly what a fresh binder would
emit; it compares the files byte-for-byte after normalising only the output
directory path.

## 7. Limits

1. Data only: no renderer, GPU, browser, playable-game or full-game claim.
2. Behaviour equality is the 60-tick zero-input settle at the recorded spawn
   with the committed car record; it is not a driven lap or a full input sweep.
3. A future module that changes physics behaviour while preserving the 61 state
   hashes is not detected by this policy; that is the price of accepting
   binary drift. Any state-hash change fails with the exact tick/hash.
4. Geometry, collision, draws, layout, spawn, textures and byte-level manifest
   pins remain hard failures.
5. `_work/` packages and decoded textures are generated game data and are not
   committed.
