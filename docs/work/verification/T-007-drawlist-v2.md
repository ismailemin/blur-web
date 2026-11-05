# T-007 draw list v2 — instance transforms, constant materials, packet shape

**Date:** 5 November 2026
**Scope:** engine CPU draw list only. No GPU, renderer, browser, vehicle or game
claim. The packet is data; nothing rasterises it.
**Supersedes for the packet seam:** `engine-level-stream.md` §12.6 items 1-2 and
§12.7. P27's direct-draw result is unchanged.

## Gate

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
& $py engine/verify_stream.py --fresh
```

Result: **PASS** (121.8 s, exit 0).

- Patch `engine/patches/t005b-stream-overlay.patch`, SHA-256
  `5fa2b1b743c388030d1a0bc8b73fe951acfea92406a29cf7b71b2dbb75019b71`
  (16 modified files, 0 added, 77,284 B).
- **56 objects**, wasm **814,345 B**, SHA-256
  `552e3407552f4356bbc6d2114a44aaa2674a99000a70c73b8cd88dd83415675b`;
  two builds byte-identical.
- Harness **65/65 checks**; two runs print identical stdout.
- PC parity: `streammanager.cpp` 108,025, `streamdata.cpp` 111,514,
  `archive.cpp` 111,399, `resources.cpp` 108,104 preprocessed lines identical
  with and without the patch.

## Constant materials

The P27 archive walk already deserialises the render list's constant material
table. P30 reads it back through
`GetConstantMaterialListData()` / `GetConstantMaterialTypes()`:

| List | Types | Rows | `g_mWorld` rows | `g_tAlbedo` rows | Type-8 rows |
| --- | ---: | ---: | ---: | ---: | ---: |
| block 88 / node 283 | 18 | 187 | 1 | 103 | 0 |
| block 27 / node 253 | 8 | 56 | 37 | 18 | 0 |
| **total** | **26** | **243** | **38** | **121** | **0** |

- `g_mWorld` is read only as finite affine F32×16; `g_tAlbedo` / `g_MeshTexture`
  only as `TEXTURE_INDEX`, reported as the original `row:textureIndex`.
- `MATERIAL_INDEX` element type 8 children are followed recursively with a
  depth/cycle guard. River contains no type-8 element, so that path is
  implemented but not exercised by this data.
- `DATA_INDEX` / `TEXTURE_PTR` would be reported null with
  `runtimeOnlyAlbedoParameter`; none occurs here.
- No material, texture, render state or blend state is created. The packet layer
  label comes from the serialised `BlendState::AlphaBlendEnable`; the raw blend
  tuple stays authoritative.

## Instance transforms

Block 27 / node 253 (geometry imported from block 27, the seventh item of chunk
88: 2 VBs / 1 IB):

- **57/57** instances have a provable constant affine `g_mWorld`; 0 invalid.
- **22/22** emitted instance matrices and 22/22 archived instance bounds equal
  `level_inspect --instances-all` within **1e-5**.
- **57/57** VB/IB source bindings equal the committed reader's
  `instanceSources`.
- **57/57** transform rows equal `_work/level-instances/stageB-python-reference.json`
  (the 56-stage Stage A+B reference). Its geometry totals are not reproduced:
  blocks 15, 17, 26 and 32 are not imported.
- **10,308 triangles / 13,162 vertices** for the 22 in-scope instance draws,
  equal to the committed instances-all metadata.

Direct primitives of block 88 / node 283 keep `world = null` with
`reason = noInstanceTransform` (255/255); no identity matrix is substituted.

## Packet draw list

One record per direct primitive and per instance, in archive order:

- **312 records** = 255 direct (95 drawable, 160 other-block) + 57 instance
  (22 drawable, 35 other-block).
- **117 drawable**, 195 omitted; every omitted record carries a reason
  (`geometryBlockNotImported` for the 195).
- Fields: `mesh`, `vb=block:index`, `ib=block:index`, `vtxOffset`, `vtxCount`,
  `idxOffset`, `idxCount`, `world[16]`/`null`, `worldRow`, `worldReason`,
  `materialId`, `materialRow`, `albedoIndex`, `albedo=block:index`,
  `materialReason`, bounds, `layer`, instance/primitive/source offsets,
  `drawable`, `reason`.
- Packet hash (FNV-1a 64 over every printed field) is **`4603a94e0871461c`**
  and is recomputed independently in Python from the printed lines.
- All **255/255** direct and **57/57** instance records carry a static
  `g_tAlbedo` material id; 0 null.
- P27 direct-draw result is unchanged: 95 bound, 9,343 triangles, 17,782
  vertices, hash `fd525c1452869aee`.

## Materials/transform comparison result

Matched:

- 22/22 instance matrices and bounds at 1e-5 (`level_inspect --instances-all`);
- 57/57 instance VB/IB sources and 57/57 Stage A+B transform rows;
- 22/22 in-scope instance triangle/vertex totals;
- 95/95 direct index spans and P27 totals;
- packet hash C++ == independent Python.

Not matched / not claimed:

- The Stage A+B **geometry** totals (34,632 vertices / 25,521 triangles) need
  blocks 15, 17, 26, 32; only block 27 is imported.
- The committed direct-draw API does not expose material values, so
  `materialId` has no independent reference. It is a serialised
  `TEXTURE_INDEX` (original row and index), covered by determinism and the
  255/255 + 57/57 non-null count, not by a visual result.
- `materialId` is a texture source index, not a decoded image.

## Remaining blockers

1. Textures are indices only; nothing is decoded, created or sampled.
2. `StreamData::ProcessLoadChunk` state machine is still not driven.
3. No visibility, culling, LOD selection, sorting or batching; only 88/283 and
   27/253 are imported, LOD0 only.
4. Runtime-only material values (`DATA_INDEX`/`TEXTURE_PTR`) are not imported;
   River's lists contain none.
5. No renderer, GPU, browser, vehicle or game claim; `C_OverlayFs` is still one
   read-only layer.

## Evidence

| Path | Content |
| --- | --- |
| `_work/logs/engine-stream-spike/verify-summary.json` | every number above, machine-written |
| `_work/logs/engine-stream-spike/p30-verify-fresh-final.log` | final fresh transcript |
| `_work/logs/engine-stream-spike/reference-instances-27-253.json` | committed-reader instance reference |
| `_work/logs/engine-stream-spike/reference-mesh-88-283.json` | committed-reader direct-draw reference |
| `_work/engine-stream-spike/out/stream_harness_a.wasm` | module, 814,345 B |
| `docs/work/analysis/engine-level-stream.md` §13 | full P30 analysis record |

Repository-wide portable suite at the same revision:
`python tools/verify_asset_probe.py --skip-build` → **29/29 PASS** (no
regression).
