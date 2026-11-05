# T-007 track textures — the remaining 96 static sources (146 draws)

**Date:** 5 November 2026
**Scope:** CPU data extraction only. No renderer, GPU, sampler, browser,
vehicle or game claim. No texture is created, bound, sampled or uploaded; no
pixel, address mode or mip level is chosen. This record closes blocker 1 of
`docs/work/verification/T-007-uv-binding.md` (P45) for the six P44 track
sections. It extends `docs/work/verification/T-007-engine-textures.md` (P34),
`docs/work/verification/T-007-uv-binding.md` (P45) and
`docs/work/verification/T-007-drawlist-track.md` (P44); the
P27/P30/P32/P34/P38/P44 geometry, material, texture, transform, packet,
draw-list and UV0 results are unchanged.

## Gate

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
& $py engine/verify_stream.py --fresh
& $py engine/verify_stream.py                 # second full run, reused tree
& $py tools/verify_asset_probe.py --skip-build
```

| Run | Result | Time |
| --- | --- | --- |
| `--fresh` | **PASS**, exit 0 | **130.9 s** |
| second full run | **PASS**, exit 0 | **113.8 s** |
| portable suite | **29/29 PASS** | — |

- Harness **99/99 checks** (was 92/92 at P45). The seven new checks are
  `texture_registry_p34`, `track_texture_sources`, `track_texture_decoded`,
  `track_texture_unsupported`, `track_texture_hash`, `track_texture_registry`
  and `track_texture_no_gpu`.
- Patch `engine/patches/t005b-stream-overlay.patch` is **unchanged**:
  16 modified files, 77,284 B, SHA-256
  `5fa2b1b743c388030d1a0bc8b73fe951acfea92406a29cf7b71b2dbb75019b71`.
  No engine source or patch edit was needed.
- Build **56 objects**, wasm **872,798 B**, SHA-256
  `ac6635f967d5c5993d4af5ef110a4e892ce790dbaacced1bfdecb64ddcf7deb2`.
  The two builds inside each run are byte-identical; the fresh and reused runs
  reproduce the same module, texture aggregates, binding aggregate and totals.
- P34 is unchanged: **102/102** textures, aggregate `9c5686eed9334ca4`,
  109,808 descriptor+texel B, 628,800 RGBA B. P44 is unchanged: section packet
  `8b3a40324410327f`, **299** drawable / 1,355 records. P45 UV0 is unchanged:
  **299/299** resolved, aggregate `2ed1f4b0b3c9148e`.

## Why the P45 binding aggregate changed

P45 printed `texture=null` and `texstate=notDecodedInP34Set` for 146 draws on 96
distinct blocks; those 146 rows were part of the binding aggregate
`70237f9bb7f0a20c`. They now resolve to verified decodes, so their `texstate`
becomes `decoded` and their texture identity enters the same aggregate. The new
value is **`9cc08756505dd497`**. The UV0 aggregate folds only UV fields, so it
stays `2ed1f4b0b3c9148e`. P34's 102-source aggregate and checks are untouched.

## Source collection and decode path

`stream_harness.cpp` runs the six section pairs twice:

1. **Stage 0, quiet prepass.** The same node/geometry chunks are loaded and
   parsed and `emitNodeDraws` runs with `g_sectionPrepass`. `emitOneDraw` stops
   immediately after the same `resolveAlbedo` material probe the real pass uses
   and records the drawable static source `block:index` in a bounded 256-entry
   track-ref set. It prints no list, material, packet, UV or binding row and
   updates no counter; only drawable draws (`bound && boundIb && lod`) are
   collected, exactly the P45 binding set. The 2 runtime-only draws have no
   static `block:index` and are not collected.
2. **Track decode.** The refs are sorted by `block:index` and passed to
   `decodeTextureRefSet`, the P34 path factored into one function:
   `findChunkItem` resolves the unique LOD0 `ChunkInfo` item;
   `StreamManager::LoadChunk` + `GetChunkData` read the chunk through
   `C_OverlayFs`; `parseChunkUpToItem` walks the engine
   `Deserialise(LodReader<ResourceBlock::Resources>)` to each item's own
   start/end; `parseTextureItem` reads the committed PC resource-texture layout
   (platform tag, LOD 0, three empty geometry vectors, texture array, 28-byte
   `TextureDesc`, complete mip chain); `decodeTextureMip0` applies the committed
   BC1/BC2/BC3 rule. The call uses `skipRegistered`, so the 40 sources already
   in the P34 registry are not decoded twice and are reported as `already`.
3. **Stage 1, real pass.** Packet/UV/binding totals are reset and the same six
   sections are emitted normally against the complete 198-entry registry. Each
   binding row carries `texset=p34|track|none` in addition to the P45 fields.

No GPU object is created. A source that cannot be proven fails with
`tracktexture_unsupported block=<b> index=<i> chunk=<c> [item=<t>]
reason=<token>` and no pixels; the tokens are `textureBlockNotInStream`,
`textureChunkWalkFailed`, `textureItemNotRecorded`, `textureLodMarker`,
`texturePayload`, `textureDescriptorShape`, `textureMipChainMismatch`,
`unsupportedTextureFormat`, `unsupportedTextureDecodeFormat`,
`textureIndexOutOfRange` and `decodedTextureRegistryOverflow`. None occurred.

## Measured result

| Check | Result |
| --- | --- |
| track static sources | **136** (0 overflow) |
| already in P34 registry | **40** |
| newly decoded | **96 / 96**, **0 unsupported**, 0 GPU objects |
| combined registry | **198** (P34 102 + track 96), 0 overflow |
| track descriptor+texel bytes | **51,536 B** |
| track CPU RGBA (mip0, no flip) | **281,600 B** |
| track aggregate FNV-1a 64 | **`8d91645d4ee00831`** |
| combined blob / RGBA | **161,344 B** / **910,400 B** |
| track formats | **96 × DXT1/BC1** (format 827611204); all 2D type 3, depth 1 |
| track mip chains | every payload equals the declared level sum; no truncation |
| track sizes | 43 ×16×16/5, 17 ×32×16/6, 6 ×32×32/6, 5 ×16×32/6, 9 ×64×16/7, 5 ×16×64/7, 2 ×64×32/7, 2 ×64×64/7, 5 ×128×16/8, 1 ×8×128/8, 1 ×32×128/8 |
| track payload / RGBA range | 184 … 2,760 B / 1,024 … 16,384 B |
| distinct names | **91** (a name can repeat on different blocks) |
| static bindings resolved | **297 / 297** |
| P34-bound draws / sources | **151** / **40** |
| track-bound draws / sources | **146** / **96** |
| runtime-only | **2** (`g50-n265` primitives 241/242), still null with `runtimeOnlyAlbedoParameter` |
| distinct static sources | **136** (40 P34 + 96 track) |
| binding aggregate | **`9cc08756505dd497`** |
| UV0 aggregate | **`2ed1f4b0b3c9148e`** (unchanged) |

The 96 decoded blocks (index 0 except `988:1`) are:

```text
359-376, 407-414, 537, 542-543, 549-560, 657, 668-669, 672, 679-681, 697,
751-752, 806, 812, 814, 845, 852, 856-857, 876-878, 884-885, 892-893,
896-902, 920-921, 929-932, 944-946, 949, 967, 982-983, 988, 1004, 1009,
1014-1015, 1039, 1044, 1070, 1087, 1102, 1146
```

The full per-texture list, including name, texture hash, dimensions, format,
descriptor size, payload size, blob hash and RGBA hash, is
`_work/logs/engine-stream-spike/track-textures.json`.

## Committed asset-reader comparison

The P34 comparison helper is now generic over a texture set and is run for the
96 track sources with the same independent readers and decoder:

- the committed Python readers (`tools/inspect_car_level_assets.py`,
  `tools/inspect_car_materials.texture_lod`,
  `tools/inspect_level_instances.read_lists`) re-read the same engine chunk
  table and rebuild each descriptor+texel blob from the engine-located item;
- the harness blob must equal that blob byte for byte, with the first differing
  offset reported on failure;
- `texture_inspect --raw` (the committed BC1/BC2/BC3 decoder) decodes the same
  blob and must agree on name, texture hash, width × height, levels, format,
  encoded mip-chain bytes, RGBA length and RGBA FNV-1a 64.

| Field | Track result |
| --- | --- |
| descriptor+texel bytes | **96/96 byte-identical**; first mismatch: **none** |
| name | **96/96** equal |
| texture hash | **96/96** equal |
| width × height, levels | **96/96** equal |
| format / formatCode | **96/96** equal |
| payload / encoded mip-chain bytes | **96/96** equal |
| RGBA bytes / FNV-1a 64 | **96/96** equal; first pixel mismatch: **none** |
| combined P34 + track | **198/198** equal on every field |

A mismatch would name the texture, both hashes, the first byte offset, both
blobs' bytes at that offset and their sizes. None occurred, so no pixels were
substituted or fabricated. The B/C3-style Pillow rounding question does not
apply: all 96 are DXT1 and both sides implement the committed rule.

## Determinism and PC parity

- Two independent wasm builds per run are byte-identical; the two harness runs
  inside each run print identical stdout (`a__run1.log` == `a__run2.log`).
- Both full runs reproduce the same wasm SHA-256, track aggregate
  `8d91645d4ee00831`, binding aggregate `9cc08756505dd497`, registry size 198,
  section summaries and byte totals.
- The track texture aggregate is recomputed in Python from the printed rows and
  compared with the in-module value before the pinned constant is checked; the
  binding aggregate is recomputed the same way.
- The patch is untouched, so the four patched engine TUs preprocess identically:
  `streammanager.cpp` 108,025, `streamdata.cpp` 111,514, `archive.cpp` 111,399,
  `resources.cpp` 108,104 lines.
- Modified files are wasm-harness/gate code only: `stream_harness.cpp` and
  `verify_stream.py`. Portable suite: **29/29 PASS**, no regression.

## Remaining blockers

1. **No sampling.** Wrap mode, filter, anisotropy, mip selection and texture
   matrices are not resolved. UV0 leaves `[0,1]` (P45), so the address mode must
   be proven before a faithful binding.
2. **The 2 runtime-only draws have no static texture.** `g50-n265` primitives
   241/242 resolve to `DATA_INDEX`/`TEXTURE_PTR`; they stay `null` with
   `runtimeOnlyAlbedoParameter`.
3. **Shared (`block == -1`) textures are metadata only.** None occurs in these
   297 static bindings; the 10 scene shared-texture envelopes stay unexercised.
4. **`StreamData::ProcessLoadChunk` and higher texture LODs are not driven.**
   Only LOD0 and its declared mip chain are read.
5. **No colour or material transform.** sRGB interpretation, material colour,
   alpha blending and texture matrices are not applied; the decoder is
   structural.
6. **No renderer, GPU, browser, vehicle or game claim.** The RGBA is data; it is
   never uploaded, sampled or drawn. `C_OverlayFs` remains one read-only layer
   and `instancesApplied:false` is unchanged.

## Evidence

| Path | Content |
| --- | --- |
| `_work/logs/engine-stream-spike/p47-verify-fresh.json` | every number above, fresh run |
| `_work/logs/engine-stream-spike/p47-verify-fresh.log` | fresh PASS transcript, 130.9 s |
| `_work/logs/engine-stream-spike/p47-verify-reuse.json` / `.log` | second full run, identical, 113.8 s |
| `_work/logs/engine-stream-spike/track-textures.json` | 96 per-texture records, hashes and comparison |
| `_work/logs/engine-stream-spike/engine-textures.json` | P34 102-texture registry (unchanged) |
| `_work/logs/engine-stream-spike/textures/tex-*-*.raw` | embedded blobs fed to the committed decoder |
| `_work/logs/engine-stream-spike/p47-asset-suite.log` | 29/29 portable suite |
| `_work/logs/engine-stream-spike/a__run1.log` / `a__run2.log` | identical harness stdout |
| `_work/engine-stream-spike/out/stream_harness_a.wasm` | module, 872,798 B |
| `docs/work/analysis/engine-level-stream.md` §19 | P47 analysis record |

File hashes at this result:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `engine/patches/t005b-stream-overlay.patch` | 77,284 | `5fa2b1b743c388030d1a0bc8b73fe951acfea92406a29cf7b71b2dbb75019b71` |
| `engine/harness/t005e/stream_harness.cpp` | 174,886 | `b2cf6b7236f6b5cbf6b2829d5f9dab8dcf237d2e0ede9e79ab9f103245cce67c` |
| `engine/verify_stream.py` | 170,144 | `0531fadae0d903a5f99afcc9fc885937ab73d1f4ab8cacdaef86b9856de11c29` |
| `_work/engine-stream-spike/out/stream_harness_a.wasm` | 872,798 | `ac6635f967d5c5993d4af5ef110a4e892ce790dbaacced1bfdecb64ddcf7deb2` |
| `_work/logs/engine-stream-spike/track-textures.json` | 36,734 | `47b9eb5e5f440eb4c6ec76592a5475684e1c04641fa7dd24beec1b5970e47dd0` |
| `_work/logs/engine-stream-spike/p47-verify-fresh.json` | 854,069 | `91b1fd4f948951a18af037a8bb1f3ae4f8b572df906ae212fd8fdf78da841992` |

## Recorded result (`--fresh`, exit 0)

```text
patch           sha256=5fa2b1b743c38803
files           16 modified, 0 added
objects         56
wasm            872798 B sha256=ac6635f967d5c599 deterministic=True
harness         99/99 checks pass
textures        102/102 P34 static textures decoded, 0 unsupported, 109808 B, aggregate=9c5686eed9334ca4
track textures  96/96 track static textures decoded (40 already in P34), 0 unsupported, 51536 B, 281600 RGBA B, aggregate=8d91645d4ee00831
texture compare 102/102 + 96/96 name+hash+size+format+RGBA equal to texture_inspect --raw (combined 198/198)
track bindings  297 static / 2 runtime-only, 297 draws on 136 decoded sources (151 on 40 P34, 146 on 96 track), 0 undecoded, aggregate=9cc08756505dd497
pc parity       4 TUs preprocessed identical
verdict         PASS
```

Harness summary lines:

```text
webfiledraw texture summary refs=102 decoded=102 unsupported=0 overflow=0 payloadBytes=109808 rgbaBytes=628800 aggregateHash=0x9c5686eed9334ca4 gpu=0
webfiledraw tracktexture summary refs=136 decoded=96 already=40 unsupported=0 overflow=0 payloadBytes=51536 rgbaBytes=281600 aggregateHash=0x8d91645d4ee00831 registry=198 gpu=0
webfiledraw section uv summary records=299 uvpresent=299 uvnull=0 uvnonfinite=0 static=297 runtime=2 decoded=297 notdecoded=0 missingblock=0 registryoverflow=0 uvhash=0x2ed1f4b0b3c9148e bindhash=0x9cc08756505dd497
```
