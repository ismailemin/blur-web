# T-007 UV0 streams and static albedo bindings — 540 m track sections

**Date:** 5 November 2026
**Scope:** CPU data extraction only. No renderer, GPU, sampler, browser,
vehicle or game claim. No texture is created, bound, sampled or uploaded; no UV
is synthesised and no material value is fabricated. This record extends
`docs/work/verification/T-007-drawlist-track.md` (P44),
`docs/work/verification/T-007-engine-textures.md` (P34) and
`docs/work/analysis/engine-level-stream.md` §17; the P27/P30/P32/P34/P38/P44
geometry, material, texture, transform, packet and draw-list results are
unchanged.

## Gate

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
& $py engine/verify_stream.py --fresh
& $py engine/verify_stream.py                 # second full run, reused tree
& $py tools/verify_asset_probe.py --skip-build
```

| Run | Result | Time |
| --- | --- | --- |
| `--fresh` | **PASS**, exit 0 | **125.7 s** |
| second full run | **PASS**, exit 0 | **115.3 s** |

- Harness **92/92 checks** (was 88/88 at P44). The four new checks are
  `drawlist_section_uv0`, `drawlist_section_uv0_hash`,
  `drawlist_section_binding`, `drawlist_section_bind_hash`.
- Patch `engine/patches/t005b-stream-overlay.patch` is **unchanged**:
  16 modified files, 77,284 B, SHA-256
  `5fa2b1b743c388030d1a0bc8b73fe951acfea92406a29cf7b71b2dbb75019b71`.
  No engine source or patch edit was needed.
- Build **56 objects**, wasm **870,155 B**, SHA-256
  `d76f77f74f75b6ab6026ee3846a58afb029b51c3e8cec0ab2d957d9f24d2409f`.
  The two builds inside each run are byte-identical, and both full runs
  reproduce the same module, UV aggregate, binding aggregate and totals.
- Portable suite `tools/verify_asset_probe.py --skip-build` → **29/29 PASS**.
- Only `engine/harness/t005e/stream_harness.cpp` and `engine/verify_stream.py`
  changed. The four patched engine TUs still preprocess identically:
  `streammanager.cpp` 108,025, `streamdata.cpp` 111,514,
  `archive.cpp` 111,399, `resources.cpp` 108,104 code lines.
- P44 is unchanged: section packet **1,355 records / 299 drawable**, packet
  hash `8b3a40324410327f`; P34 is unchanged: **102/102** textures, aggregate
  `9c5686eed9334ca4`.

## UV0 resolution rule

For every drawable section draw the harness resolves UV0 from serialised
fields only:

1. the primitive's **declaration** (`draws.decl[primitive.declaration]`) must
   contain exactly one element with `usage == 5` (`VERTEX_ELEMENT_USAGE_TEXCOORD`,
   `vertexbuffer.h:26-27`) and `usageIndex == 0`; a missing or duplicate element
   is `noUv0Declaration` / `duplicateUv0Declaration`;
2. `method` must be 0, and the type must be one of the committed shapes —
   `5` = F32_2, `8` = F16_2, `9` = F16_4 (first two components of F16_4 are
   UV0, exactly as `probes/asset-reader/FORMAT-scene.md` states) — otherwise
   `uv0Method` / `uv0Type`;
3. the **declaration's own stream** (not the POSITION stream) must be bound
   by exactly one primitive stream record with `frequency == 0`; that record
   supplies the geometry-local vertex-buffer index and the **stream byte
   offset**. The buffer source must resolve to the section's geometry block and
   must be imported, uncompressed, non-endian-swapped and payload-retained;
4. `streamByteOffset % stride == 0` gives the vertex shift; the element must fit
   inside the stride; the LOD vertex range `minIndex .. minIndex+vertices` must
   fit the buffer. The per-draw byte range is
   `payload + (minIndex+shift)*stride + elementOffset` up to
   `+ (vertices-1)*stride + elementSize - 1`.

Every address above is derived from those fields; nothing is inferred from the
POSITION element and no value is generated. When any step fails the draw prints
`uv0:null` with the reason token and no hash — there is no zero pair or
identity fallback. The engine's web `BufferRecord` records stride/count but not
the stored per-element `VertexFormat` (`engine/harness/t005e/
engine_stream_prelude.h`), so the declaration element is the format authority
here, exactly as P44's section bounds already use it for POSITION. The
asset-reader comparison below independently re-reads the stored elements and
rejects a stored/declaration mismatch (its `draw_uv_available` fails with
"UV0 declaration does not match bound vertex format"), so for these 299 draws
the stored elements are proven to repeat the declaration.

## Measured UV0 result

| Check | Result |
| --- | --- |
| drawable section draws | **299** |
| UV0 resolved (`uvnull=0`) | **299 / 299** |
| `uv0:null` | **0** |
| non-finite UV component | **0** |
| declaration element index / byte offset | **2 / 16** for all 299 |
| declaration streams | **stream 0** for all 299 (same stream as POSITION) |
| stream byte offset / vertex shift | **0 / 0** for all 299 |
| `uvfirst == packet vtxOffset` | **299/299** (UV on the POSITION stream) |
| types | **292 × F16_4/type 9**, **7 × F16_2/type 8** |
| strides | 24 ×221, 28 ×35, 44 ×39, 36 ×3, 32 ×1 |
| per-draw vertex range | 3 … 3,527 vertices, **95,324** vertex references over all draws |
| per-draw byte range | **2,731,480 B** total addressed |
| UV value range (all draws) | u −37.96875 … 53.28125, v −43.25 … 28.84375 |
| UV aggregate (FNV-1a 64) | **`2ed1f4b0b3c9148e`** |

Per section:

| section | draws | F16_4 / F16_2 | decoded / undecoded / runtime | strides |
| --- | ---: | --- | --- | --- |
| `g56-n289` | 49 | 48 / 1 | 23 / 26 / 0 | 24×30, 28×2, 36×3, 44×14 |
| `g58-n265` | 41 | 41 / 0 | 23 / 18 / 0 | 24×33, 28×3, 44×5 |
| `g50-n265` | 44 | 43 / 1 | 22 / 20 / 2 | 24×35, 28×6, 44×3 |
| `g71-n209` | 56 | 54 / 2 | 27 / 29 / 0 | 24×45, 28×7, 44×4 |
| `g64-n209` | 40 | 40 / 0 | 25 / 15 / 0 | 24×23, 28×8, 32×1, 44×8 |
| `g59-n265` | 69 | 66 / 3 | 31 / 38 / 0 | 24×55, 28×9, 44×5 |
| **total** | **299** | **292 / 7** | **151 / 146 / 2** | |

The 1,056 other-block primitives of these six node chunks are not imported
(P44 omits them with `geometryBlockNotImported`), so they have no UV0 buffer in
this pass and no UV row is invented for them. The 299 UV rows are exactly the
drawable draws.

## Asset-reader comparison

The committed C++ asset reader is re-run per section as
`level_inspect <levelrender> <geometry-chunk> <node-chunk> <geometryBlock>
<nodeBlock>` and therefore exercises `level_mesh_inspect`. That reader emits

- `uv0`: flat stored TEXCOORD0 of every used vertex buffer, and
- one `uv0Available` per direct draw, true only when the declared UV0 element
  is on the POSITION stream (its own rule; separate UV streams are not
  merged).

It is a comparable set for these sections: all **299** draws report
`uv0Available:true` and no placeholder pair is written. For each draw the
verifier hashes the reader's UV0 pairs — `uv0[2*index], uv0[2*index+1]` for every
index of that draw's emitted triangle span, in the reader's own triangle order
(strip parity applied, degenerate triples skipped) — as F32 bits and requires
exactly the engine's `uvhash`. That is **299/299 per-draw value hashes over
143,370 index references / 286,740 F32 components**, plus a containment check of
the engine's printed value range against the reader's referenced range.

| Check | Result |
| --- | --- |
| draws with `uv0Available` and a UV row | **299/299** |
| per-draw UV0 value hash (F32 bits) | **299/299 equal** |
| engine UV0 value range contains the reader's referenced range | **299/299** |
| declaration-visible element offset/stride/count | 299/299 consistent with the packet span |
| first mismatch / byte offset | **none**, so none is reported |

A mismatch would name the section, the draw, both hashes, the engine UV stream,
element index and byte offset, stride, first vertex and count, and the exact
engine byte range `uvarena..uvlastbyte` before raising. None occurred.

### Signed zero

37 UV0 components of the committed reader's `uv0` are negative zero
(`g58-n265` 14, `g59-n265` 23; first at `g58-n265` uv0 component 6088). The
reader prints them as the bare JSON token `-0`; a default `json.loads` turns
that into the integer `0` and loses the sign. With the default parser the first
per-draw hash mismatch is the 17th UV row of `g58-n265` (engine draw 131,
packet vertex offset 3090, count 9, byte range 74,176..74,375):

```text
engine   0e734590c6211238
reader   6ea1bdc38555d9b8   (signed zero collapsed to +0)
```

The verifier now parses the reader output with a signed-zero-preserving integer
hook (`_load_signed_zero_json`), after which that draw and all others match
bit-exactly. This is the same trap `probes/asset-reader/FORMAT-scene.md` records
for canonical float-byte comparisons; it is a parser issue, not a data
difference.

## Static albedo bindings

The binding is read from the same material probe P44 uses (instance material,
base material, then every active stream material; `MATERIAL_ELEMENT_TYPE_
MATERIAL_INDEX` children followed with the 32-deep cycle guard). Texture
identity comes from the **P34 decode registry of this run**: each texture the
P34 phase decoded and already compared against `texture_inspect --raw` is
registered as `block:index`, archive name, texture hash, width, height, level
count, format and RGBA hash. A section source in that registry prints that
identity; a source outside it keeps its `block:index`, prints
`texture=null`, and names the engine `ChunkInfo` chunk/item that holds it. The
registry is not extended by the section pass (the P34 102-source set, its
aggregate hash and its checks are untouched).

| Check | Result |
| --- | --- |
| drawable draws | **299** |
| static `g_tAlbedo` id | **297** |
| runtime-only (`materialId=null`, `materialReason=runtimeOnlyAlbedoParameter`) | **2** (`g50-n265` node primitives 241, 242) |
| distinct `block:index` sources | **137** (136 static + the runtime pair) |
| draws bound to a **P34-decoded** source | **151** on **40** distinct sources |
| draws bound to a **not-decoded** source | **146** on **96** distinct blocks |
| static source whose block is absent from the stream | **0** |
| binding aggregate (FNV-1a 64) | **`70237f9bb7f0a20c`** |

Every one of the 96 not-decoded blocks is present in the engine `ChunkInfo`
table with a unique `(block, lod=0)` item (`missingblock=0`), and each draw's
printed `texturechunk`/`textureitem` is checked against that table by the
verifier. The pixels are therefore obtainable by the same P34 path; they were
simply not part of the two River lists P34 covered, and this pass does not
decode them.

Not-decoded blocks — 96 in total; the per-draw chunk/item is in the run log
and `_work/logs/engine-stream-spike/p45-verify-fresh.json`:

```text
359-376, 407-414, 537, 542, 543, 549-560, 657, 668, 669, 672, 679, 680, 681,
697, 751, 752, 806, 812, 814, 845, 852, 856, 857, 876, 877, 878, 884, 885, 892,
893, 896-902, 920, 921, 929, 930, 931, 932, 944, 945, 946, 949, 967, 982, 983,
988, 1004, 1009, 1014, 1015, 1039, 1044, 1070, 1087, 1102, 1146
```

The 40 P34-decoded sources used by the sections are `block:index`
`561:0, 562:0, 682:0, 757:0, 794:0, 809:0, 816:0, 957:1, 966:0, 977:0, 978:0,
986:0, 998:0, 999:0, 1000:0, 1016:0, 1017:0, 1031:0, 1034:0, 1036:0, 1081:0,
1082:0, 1083:0, 1091:0, 1110:0, 1117:0, 1124:0, 1129:0, 1136:0, 1144:0,
1150:1, 1153:0, 1167:0, 1175:1, 1178:0, 1189:0, 1192:0, 1193:0, 1207:0,
1224:0`.

The verifier also requires each draw's printed binding row to equal the
`albedo` / `materialRow` / `materialId` of that draw's P44 packet record, so the
binding is the packet's material resolution, not a second opinion.

## Determinism and PC parity

- Two independent wasm builds per run are byte-identical; the two harness runs
  inside each run print identical stdout (`a__run1.log` == `a__run2.log`,
  2,269,143 B each).
- Both full runs reproduce the same wasm SHA-256, UV aggregate
  `2ed1f4b0b3c9148e`, binding aggregate `70237f9bb7f0a20c`, section summaries
  and totals.
- The UV and binding aggregate hashes are recomputed in Python from the printed
  per-draw rows on every run and compared with the in-module values before the
  pinned constants are checked.
- The patch is untouched, so the four patched engine TUs preprocess identically
  with and without it (`108,025 / 111,514 / 111,399 / 108,104` lines).
- Modified files are wasm-harness/gate code only. Portable suite: **29/29
  PASS**, no regression.

## Remaining blockers

1. **146 of 297 static bindings have no pixels in this pass.** They carry the
   exact `block:index` and the engine chunk/item; 96 distinct texture blocks
   must be decoded through the same P34 path before those draws can be
   textured. No name/hash/format is fabricated for them.
2. **No sampling.** Wrap mode, filter, anisotropy, mip selection and texture
   matrices are not resolved. UV0 values outside `[0,1]` occur (u −37.97 … 53.28,
   v −43.25 … 28.84), so the address mode must be proven before a faithful
   binding.
3. **Two draws have no static albedo.** `g50-n265` primitives 241/242 resolve
   to `DATA_INDEX`/`TEXTURE_PTR` runtime values; they stay `null` with
   `runtimeOnlyAlbedoParameter` and cannot be bound from committed static data.
4. **UV1 and higher sets are not extracted.** Only `usage 5 / usageIndex 0` is
   resolved; the second TEXCOORD set, lightmap/damage streams and the tangent
   streams are outside this pass.
5. **The stored per-buffer VertexFormat is not retained by the web
   `BufferRecord`.** The declaration element is the engine-side authority; the
   committed reader's stored-element check backs it up for these 299 draws, but
   a future buffer-format reader should record the elements directly.
6. **`StreamData::ProcessLoadChunk` is still not driven**, and there is still no
   visibility, culling, LOD selection, sorting or batching (LOD0 direct draws
   only, `instancesApplied:false`).
7. **No renderer, GPU, browser, vehicle or game claim.** `C_OverlayFs` remains
   one read-only layer.

## Evidence

| Path | Content |
| --- | --- |
| `_work/logs/engine-stream-spike/p45-verify-fresh.json` | every number above, fresh run |
| `_work/logs/engine-stream-spike/p45-verify-fresh.log` | fresh PASS transcript, 125.7 s |
| `_work/logs/engine-stream-spike/p45-verify-reuse.json` / `.log` | second full run, identical, 115.3 s |
| `_work/logs/engine-stream-spike/a__run1.log` / `a__run2.log` | identical harness stdout, all 299 UV rows |
| `_work/logs/engine-stream-spike/p45-asset-suite.log` | 29/29 portable suite |
| `_work/logs/engine-stream-spike/reference-mesh-<g>-<n>.json` | the six committed `level_mesh` outputs |
| `_work/logs/engine-stream-spike/engine-textures.json` | P34 102-texture registry (unchanged) |
| `_work/engine-stream-spike/out/stream_harness_a.wasm` | module, 870,155 B |
| `docs/work/analysis/engine-level-stream.md` §18 | P45 analysis record |

File hashes at this result:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `engine/patches/t005b-stream-overlay.patch` | 77,284 | `5fa2b1b743c388030d1a0bc8b73fe951acfea92406a29cf7b71b2dbb75019b71` |
| `engine/harness/t005e/stream_harness.cpp` | 168,176 | `7452f354682af46454d07fc6de9dcf154716b87dd722c0c72ad316fa4350cc42` |
| `engine/verify_stream.py` | 163,801 | `f92349825656ce5ee12a39041417fe893984169cc22c7582c93019774aae21f9` |
| `_work/engine-stream-spike/out/stream_harness_a.wasm` | 870,155 | `d76f77f74f75b6ab6026ee3846a58afb029b51c3e8cec0ab2d957d9f24d2409f` |
| `_work/logs/engine-stream-spike/a__run1.log` | 2,269,143 | `1d54a7330fc932e941eeacd6e936f47ee71045ea10473d5147cb163d81be82ad` |
| `_work/logs/engine-stream-spike/p45-verify-fresh.json` | 814,001 | `8d4715579fab51e301f567f1fa0434472af27e5488a40e379f7d968caaaab848` |

## Recorded result (`--fresh`, exit 0)

```text
patch           sha256=5fa2b1b743c38803
files           16 modified, 0 added
objects         56
wasm            870155 B sha256=d76f77f74f75b6ab deterministic=True
harness         92/92 checks pass
track UV0       299/299 draws with a resolved UV0 stream (types {'9': 292, '8': 7}), 299 values equal to level_mesh UV0, aggregate=2ed1f4b0b3c9148e
track bindings  297 static / 2 runtime-only, 151 draws on 40 P34-decoded sources, 146 on 96 undecoded blocks, aggregate=70237f9bb7f0a20c
pc parity       4 TUs preprocessed identical
verdict         PASS
```

Harness summary line (single line in the log):

```text
webfiledraw section uv summary records=299 uvpresent=299 uvnull=0 uvnonfinite=0 static=297 runtime=2 decoded=151 notdecoded=146 missingblock=0 registryoverflow=0 uvhash=0x2ed1f4b0b3c9148e bindhash=0x70237f9bb7f0a20c
```
