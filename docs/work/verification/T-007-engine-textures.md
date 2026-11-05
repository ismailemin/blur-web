# T-007 engine textures — River draw-list static sources (102)

**Date:** 5 November 2026
**Scope:** CPU-only texture extraction and decode for the two River render
lists already covered by P30/P32 (node 283 / geometry block 88 and node 253 /
geometry block 27). No sampler, renderer, GPU, browser, vehicle or game claim is
made. No texture is created or bound. This extends
`docs/work/verification/T-007-drawlist-56.md` (P32) and
`docs/work/analysis/engine-level-stream.md` §14; the P27/P30/P32 geometry,
material, transform, packet and draw-list results are unchanged.

## Gate

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
& $py engine/verify_stream.py --fresh
```

Result: **PASS**, exit 0, **122.8 s**; a second full run (reused tree) is also
**PASS**, 110.2 s, with the same wasm, hashes and totals.

- Harness **76/76 checks** (70 P32 checks + 6 P34 texture checks).
- Patch `engine/patches/t005b-stream-overlay.patch` is **unchanged** from P32:
  16 modified files, 77,284 B, SHA-256
  `5fa2b1b743c388030d1a0bc8b73fe951acfea92406a29cf7b71b2dbb75019b71`.
- Build **56 TUs**, wasm **844,802 B**, SHA-256
  `43e81c62a2ba8d4a31d84f94f672c05b709b9c1176b861313fccc9af2a9e7978`;
  the two builds in the run are byte-identical, and the second full run produces
  the same module.
- Portable suite at the same revision:
  `python tools/verify_asset_probe.py --skip-build` → **29/29 PASS**.

## Texture enumeration

The sources were recorded by `resolveAlbedo` while the 312 packet records were
emitted, deduplicated by `block:index` and bounded (overflow counter must stay
0). Every record's `g_tAlbedo`/`g_MeshTexture` is a static
`MATERIAL_ELEMENT_TYPE_TEXTURE_INDEX`; no `DATA_INDEX`/`TEXTURE_PTR` or shared
(`block == -1`) source occurs in these lists.

| List | Material-row refs | Distinct `block:index` |
| --- | ---: | ---: |
| direct (node 283) | 103 | 89 |
| instance (node 253) | 13 | 13 |
| union | **116** | **102** |

The 116 row references share sources: 102 distinct resource blocks, one texture
index per block referenced (98 × index 0, 4 × index 1: blocks 566, 957, 1150,
1175). Some blocks carry 2–3 textures; only the referenced index is decoded.

## Decode path

The engine's own table and streamer locate every item:

1. `findChunkItem` resolves `block` with `lod == 0` from the engine's 359
   `ChunkInfo` records; ambiguous or missing blocks are refused.
2. `StreamManager::LoadChunk` + `GetChunkData` read the chunk through
   `C_OverlayFs`; the harness keeps a private copy.
3. `parseChunkUpToItem` runs the engine's
   `Deserialise(LodReader<ResourceBlock::Resources>)` to the highest needed
   item and records each item's own archive start/end offsets.
4. The target item's byte range is read with the committed PC
   resource-texture layout (platform tag, LOD 0, three empty geometry vectors,
   texture array). The 28-byte `TextureDesc` and complete mip texel chain are
   retained.
5. The engine's `Deserialise(LodReader<Texture>)` is GPU-bound here (it consumes
   the descriptor and skips the payload), so the committed format rules from
   `probes/asset-reader/FORMAT-texture.md` are applied to the engine-located
   bytes: exact mip-chain byte count, then BC1/BC2/BC3 mip0 to CPU RGBA.

No GPU object, texture or sampler is created. A texture block that carried
vertex/index/node vectors would be reported `textureBlockHasGeometry`, not
silently skipped. Other explicit failure reasons are listed in §15.2 of the
analysis document; none occurs in this run.

## Result

| Check | P34 result |
| --- | --- |
| distinct texture sources | **102** |
| decoded | **102 / 102** |
| unsupported | **0** |
| descriptor + texel bytes | **109,808 B** |
| CPU RGBA (mip0, no flip) | **628,800 B** |
| aggregate FNV-1a 64 | **`9c5686eed9334ca4`** |
| formats | **101 DXT1/BC1**, **1 DXT5/BC3** (`cab01alphas_diff`, block 1205) |
| descriptor shape | all 2D type 3, depth 1, 4–256 px, 3–9 levels |
| mip chains | every payload equals the declared level sum; no truncation |
| largest blob | 43,732 B (`terrain01_diff`, block 1043, 256×256/9) |
| GPU | 0 objects created, 0 refused calls |

Texture sizes: 38 × 16×16/5, 27 × 32×16/6, 13 × 32×32/6, 7 × 16×32/6,
4 × 64×16/7, 3 × 256×16/9, 3 × 64×64/7, 2 × 128×16/8, 2 × 128×64/8,
1 × 256×256/9, 1 × 16×128/8, 1 × 4×4/3. The complete per-texture list, including
name, texture hash, dimensions, format, descriptor size, payload size, blob
hash and RGBA hash, is `_work/logs/engine-stream-spike/engine-textures.json`.

## Committed asset-reader comparison

For every reference the harness's descriptor+texel bytes were compared with an
independent re-read of the same engine chunk table by the committed Python
readers (`tools/inspect_car_level_assets.py`,
`tools/inspect_car_materials.texture_lod`,
`tools/inspect_level_instances.read_lists`). The bytes must be identical
(checked byte by byte, first mismatch offset is reported if any), then the
committed native decoder `texture_inspect --raw` decodes the same embedded
blob.

| Field | Result |
| --- | --- |
| descriptor+texel bytes | **102/102 byte-identical**; first mismatch: none |
| name | **102/102** equal |
| texture hash | **102/102** equal |
| width × height, levels | **102/102** equal |
| format / formatCode | **102/102** equal |
| payload / encoded mip-chain bytes | **102/102** equal |
| RGBA bytes / FNV-1a 64 | **102/102** equal; first pixel mismatch: none |

The single BC3 texture is the one case that could expose the known Pillow
rounding difference (Pillow floors, the Microsoft/committed rule rounds). Both
the harness and `texture_inspect` implement the committed rule, so the RGBA
hash matches exactly; no Pillow comparison is claimed.

## Determinism and PC parity

- Two independent wasm builds are byte-identical; the two harness runs inside a
  verify run print identical stdout, including all 102 texture records and
  219,616 hex characters of descriptor+texel data.
- The second full run reproduces the same wasm SHA-256, texture aggregate hash,
  byte totals and comparison result.
- The patch is untouched, so the four patched engine TUs still preprocess
  identically: `streammanager.cpp` 108,025, `streamdata.cpp` 111,514,
  `archive.cpp` 111,399, `resources.cpp` 108,104 lines.
- Modified files are wasm-harness/gate code only: `stream_harness.cpp` and
  `verify_stream.py`. The portable suite has no regression (29/29 PASS).

## Remaining blockers

1. **Sampling is not implemented.** No sampler, UV transform, wrap/filter,
   anisotropy or mip selection; only mip0 is converted to RGBA.
2. **Runtime-only textures are not imported.** `DATA_INDEX`/`TEXTURE_PTR`
   values remain null with a reason; these lists contain none.
3. **Higher texture LODs and the stream state machine are not driven.** Only
   LOD0 plus its full mip chain is read; `StreamData::ProcessLoadChunk` is still
   not exercised.
4. **No colour or material transform.** sRGB interpretation, material colour,
   alpha blending and texture matrices are not applied.
5. **Shared textures are not covered.** No `block == -1` source occurs; the 10
   scene shared-texture envelopes stay metadata only.
6. **No renderer, GPU, browser, vehicle or game claim.** The RGBA is data; it is
   never uploaded, sampled or drawn.

## Evidence

| Path | Content |
| --- | --- |
| `_work/logs/engine-stream-spike/verify-summary.json` | every number above, machine-written |
| `_work/logs/engine-stream-spike/engine-textures.json` | 102 per-texture records, hashes and comparison |
| `_work/logs/engine-stream-spike/textures/*.raw` | 102 embedded descriptor+texel blobs fed to the committed decoder |
| `_work/logs/engine-stream-spike/p34-verify-fresh-final.log` | fresh PASS transcript |
| `_work/logs/engine-stream-spike/p34-verify-reuse-1.log` | second full run, identical |
| `_work/logs/engine-stream-spike/p34-asset-suite.log` | 29/29 portable suite |
| `_work/engine-stream-spike/out/stream_harness_a.wasm` | module, 844,802 B |
| `docs/work/analysis/engine-level-stream.md` §15 | P34 analysis record |

File hashes at this result:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `engine/patches/t005b-stream-overlay.patch` | 77,284 | `5fa2b1b743c388030d1a0bc8b73fe951acfea92406a29cf7b71b2dbb75019b71` |
| `engine/harness/t005e/stream_harness.cpp` | 121,506 | `fc09a8072dd71b083874cbdecf220ec2e189446ced99a348f5fae58288b052e6` |
| `engine/verify_stream.py` | 102,690 | `27711ed47f4befc6fa7b788fcaf0bc31644008ac08132dcc75b49e52c80755a4` |
| `_work/engine-stream-spike/out/stream_harness_a.wasm` | 844,802 | `43e81c62a2ba8d4a31d84f94f672c05b709b9c1176b861313fccc9af2a9e7978` |

## Commands

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py engine/verify_stream.py --fresh
& $py engine/verify_stream.py                 # second full run
& $py engine/verify_stream.py --skip-native   # development run, no PC parity
& $py tools/verify_asset_probe.py --skip-build
```

Recorded (`--fresh`, exit 0):

```text
patch           sha256=5fa2b1b743c38803
files           16 modified, 0 added
objects         56
wasm            844802 B sha256=43e81c62a2ba8d4a deterministic=True
harness         76/76 checks pass
textures        102/102 static textures decoded, 0 unsupported, 109808 B, aggregate=9c5686eed9334ca4
texture compare 102/102 name+hash+size+format+RGBA equal to probes/asset-reader texture_inspect --raw
verdict         PASS  (122.8 s)
```
