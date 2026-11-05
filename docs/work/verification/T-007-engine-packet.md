# T-007 engine packet v1.1 — static frame producer

**Date:** 5 November 2026
**Scope:** engine CPU draw-list data exported as a static render-packet JSON.
No GPU, renderer, browser, vehicle or game claim. Nothing rasterises, uploads
or samples the packet. No camera, light, vertex, matrix, material, texture or UV
value is invented; every field is the P30/P32/P38/P44/P45/P47 engine value or
`null` with a reason.
**Extends:** `docs/work/verification/T-007-drawlist-57.md` (P38),
`docs/work/verification/T-007-drawlist-track.md` (P44),
`docs/work/verification/T-007-uv-binding.md` (P45),
`docs/work/verification/T-007-track-textures.md` (P47) and
`docs/work/analysis/engine-level-stream.md` §20. The P27/P30/P32/P34/P38/P44/
P45/P47 results are unchanged.

## Gate

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
& $py engine/verify_stream.py --fresh
& $py engine/verify_stream.py                 # second full run, reused tree
& $py tools/verify_asset_probe.py --skip-build
```

| Run | Result | Time |
| --- | --- | --- |
| `--fresh` | **PASS**, exit 0 | **128.0 s** |
| second full run | **PASS**, exit 0 | **114.2 s** |
| portable suite | **29/29 PASS** | — |

- Harness **99/99 checks** — unchanged; this task adds a verifier gate, not a
  harness check.
- Patch `engine/patches/t005b-stream-overlay.patch` is **unchanged**:
  16 modified files, 77,284 B, SHA-256
  `5fa2b1b743c388030d1a0bc8b73fe951acfea92406a29cf7b71b2dbb75019b71`.
- Build **56 objects**, wasm **872,869 B**, SHA-256
  `06b80db39583c1110245387f4b2e2f5b6d8b2edf109629e61c2a9fe8ea013d36`;
  the two builds inside each run are byte-identical and both full runs
  reproduce the same module and packet hash.
- Only `engine/harness/t005e/stream_harness.cpp` and `engine/verify_stream.py`
  changed. The patch is untouched, so the four patched engine TUs still
  preprocess identically: `streammanager.cpp` 108,025, `streamdata.cpp`
  111,514, `archive.cpp` 111,399, `resources.cpp` 108,104 code lines.
- Additions from P47: one additive field on the P38 instance record
  (`topology=%d`, +55 B in `stream_harness.cpp`, +71 B wasm). It is not part of
  any pinned hash; the P30 packet hash `7c29fb2ec7769709`, the P44 section
  packet hash `8b3a40324410327f`, the P45 UV0/binding aggregates and the P34/
  P47 texture aggregates are all unchanged.

## Packet

| Field | Value |
| --- | --- |
| path | `_work/engine-stream-spike/out/packet-engine.json` |
| bytes | **2,246,207** |
| file SHA-256 | `7bbcc442a2b118becc4a7781288f064dfd057fbc7e7b9695e14e304e4d44e936` |
| packet hash | `sha256:0e57f1e51f539c052607171f3ee02eaaa1cc11710a2c962d7c203411582baba8` |
| hash rule | `sha256` over the UTF-8 compact, key-sorted JSON with `hash` removed; ECMAScript number form |
| hash cross-check | **equal** to the committed `probes/render-packet/tools/packet-format.mjs` `packetHash()` |
| determinism | two in-process builds and both full runs produce the same bytes and hash |

The hash is not a private convention: `verify_stream.py` implements the schema
rule (`_canonical_json`) and then runs the committed `packetHash()` from
`packet-format.mjs` under the bundled Node. Both values are pinned.

## Counts (must match the committed evidence)

| Quantity | Value |
| --- | --- |
| node-253 packet records | **312** = 255 direct + 57 instance |
| node-253 drawable | **152** = 95 direct + 57 instance |
| node-253 omitted | **160**, every one `geometryBlockNotImported` |
| instances emitted / omitted | **57 / 0** (all of node 253, 36 base primitives) |
| track sections | **6** |
| section packet records | **1,355**, drawable **299**, omitted **1,056** |
| section draws / triangles / vertices | **299 / 47,790 / 78,712** |
| combined records / drawable | **1,667 / 451** = 152 node + 299 section |
| packet `draws[]` | **451** |
| meshes | **35** |
| materials | **252** scoped ids (229 raw engine ids + 2 null draws) |
| tracks / layers | **451 strips** (`topology=1`), **451 opaque** |
| world kinds | **57 packet-transform** (instances), **394 baked-into-mesh** |
| triangles / vertices (committed totals) | **83,210 / 131,880** = 9,343 + 26,077 + 47,790 and 17,782 + 35,386 + 78,712 |
| UV0 rows | **299 / 299** resolved, **0** null, **2,731,480 B** addressed |
| UV0 types / strides | 292 × type 9 (F16_4), 7 × type 8 (F16_2); 24×221, 28×35, 44×39, 36×3, 32×1 |
| section static / runtime albedo | **297 / 2** (`g50-n265` primitives 241, 242) |
| all-draw static / runtime albedo | **449 / 2** |
| distinct texture sources in the packet | **170** = 74 P34 + 96 track |
| omitted records kept in `diagnostics.extras` | **1,216** (160 node + 1,056 section) |

Per section the packet carries the P44 row: `geometryBlock`, `geometryChunk`,
`geometryItem`, `nodeBlock`, `nodeChunk`, `nodeItem`, `records`, `drawable`,
`omitted`, `primitives`, `otherBlock`, `vbs`, `ibs`, `draws`, `triangles`,
`vertices`, `bounds`, `drawHash` (14,508 / 12,227 / 13,874 / 11,524 / 11,145 /
15,434 vertices, summing to 78,712).

## Mapping rules (no guessed value)

| Packet member | Engine source |
| --- | --- |
| `draws[].vertexOffset/vertexCount` | `lod->minIndex` / `lod->vertices` (source LOD vertex range) |
| `draws[].indexOffset/indexCount` | `lod->offset` / `lod->indices` (source index range) |
| `draws[].world` | instance `g_mWorld`, printed by the P38 record; identity for a baked direct draw |
| `draws[].worldKind` | `packet-transform` for an instance (raw VB is object-local, the matrix is applied by the consumer), `baked-into-mesh` for a direct/section draw (POSITION bytes are already level-world, P44) |
| `draws[].materialId` | `node<material chunk>:<raw engine id>`; the scope is required because the raw `g_tAlbedo:<row>:<index>` string collides across node material tables (46 collisions) |
| `draws[].materialReason` | the engine token (`none` / `runtimeOnlyAlbedoParameter`) |
| `draws[].layer` | `alpha` → `transparent`, everything else → `opaque`; all 451 are opaque |
| `draws[].bounds` | the engine draw record bounds (section bounds are P44's POSITION-derived values); not re-derived |
| `draws[].source.topology` | primitive topology (all 451 are `1`, triangle strip) |
| `draws[].source.texture` | `block:index`, name, texture hash, width/height/levels/format, RGBA hash, registry, engine chunk/item |
| `draws[].source.uv0` | section, draw, stream, element, element byte offset, type/method/components, stride, stream byte offset, vertex shift, first vertex/count, arena, first/last byte, byte count, UV range and FNV hash |
| `meshes[]` | `river.b<block>.vb<k>.b<block>.ib<j>`: `vertexCount`/`indexCount` are the **referenced extent** (max offset+count over the packet's draws), flagged `countKind: referencedExtent`; the full buffer record count is not printed for the instance/section chunks |
| `materials[]` | one per scoped material id, `albedoTextureIndex` into `diagnostics.extras.textures`; `pixelsIncluded:false` |
| `textures` | the P34/P47 decoded registry subset actually referenced (170 sources), with the engine chunk/item |
| `camera` | **null** with `diagnostics.extras.cameraReason=noCameraInEngineCpuPath` |
| `lights` | `[]` — no light data was recovered in this pass |
| `placedObjects` | `[]` — nothing is placed by the packet |

The two runtime-only draws (`g50-n265` primitives 241/242) keep
`materialId:null`, `materialReason:runtimeOnlyAlbedoParameter`, `texture:null`.
Their UV0 is still resolved (they are part of the 299).

Direct and instance draws keep `uv0:null` with `uv0Reason:
uv0NotResolvedForThisRecord`: P45 resolved UV0 for the six section lists only.
No UV pair is synthesised for them.

## Schema comparison (read-only)

The packet was compared structurally with
`probes/render-packet/schema/render-packet.v1.schema.json`. The schema was not
edited and **the packet is not conformant**. The verifier pins the exact
violation and note lists separately, so a silent change fails the gate.

### Violations (constraints the schema states)

| Path | Violation | Count |
| --- | --- | ---: |
| `camera` | null; the schema requires a camera object | 1 |
| `version 1.1 timeline` | `nodes`, `updates`, `tickDurationSeconds` absent: this is a static frame | 1 |
| `meshes[].storage` | `engine-buffer` is not the schema's `inline-json` enum | 35 |
| `meshes[].positions` / `indices` / `positionsSha256` / `indicesSha256` | null; geometry is referenced, not inlined | 35 each |
| `draws[].indexCount` | source strip range is not a multiple of 3 (the schema assumes triangle lists) | 346 |

### Notes (values the schema does not forbid)

| Path | Note | Count |
| --- | --- | ---: |
| `meshes[].vertexCount` / `indexCount` | referenced buffer extent, not the buffer record count | 35 / 35 |
| `draws[].source.topology` | the schema does not model topology; the strip/list distinction lives in `source` | 451 |
| `diagnostics.sequence` | absent; a static frame has no tick sequence | 1 |

Everything else the producer emits uses schema members and types: `kind`,
`version:1.1`, `tick`, `alpha`, `generator`, `lights`, `materials`, `draws`
(`id`, `meshId`, offsets/counts, `world` 16 floats, `worldKind`, `materialId`,
`materialReason`, `layer`, `bounds`, `source`), `placedObjects` and every
required `diagnostics` member. `draws[].indexCount` values are in
`3 … 4,173`, `vertexCount` in `3 … 3,527`.

The gaps are the additive members `docs/work/analysis/e1-render-packet.md`
already lists as next steps (`storage:"engine-buffer"`, camera from engine
render state), plus one the PoC did not need: **topology**. The engine ranges
are triangle strips; the v1.1 schema's `multipleOf: 3` describes triangle lists
only.

## What matched

| Check | Result |
| --- | --- |
| node packet record split | 312 = 255 + 57; 152 drawable = 95 + 57; 160 omitted |
| P30 packet hash (from the same stdout) | `7c29fb2ec7769709` |
| P38 instance totals | 57 / 26,077 triangles / 35,386 vertices |
| P44 section totals | 299 / 47,790 / 78,712; 6/6 geometry and node blocks |
| P44 section packet hash | `8b3a40324410327f` |
| P45 UV0 | 299/299, aggregate `2ed1f4b0b3c9148e`; per-draw byte range and hash copied from the printed row |
| P45/P47 bindings | 297 static / 2 runtime; aggregate `9cc08756505dd497` |
| P34/P47 textures | 96 track + 74 P34 referenced, every identity equal to the run's registry |
| per-draw UV0 range | `uvfirst == packet vertexOffset` and `uvcount == vertexCount` on 299/299 |
| per-section texture identity | printed UV0 name/hash == registry name/hash on 297/297 |
| instance world matrices | 57/57 affine, 0 invalid (P38's pinned comparison) |
| runtime-only material | exactly 2, null with reason |
| GPU objects | **0** (`webfiledraw counters ... gpuObjectsCreated=0`) |

No mismatch occurred, so there is no first mismatch index or byte offset to
report.

## Determinism and PC parity

- Two independent wasm builds per run are byte-identical; the two harness runs
  inside each run print identical stdout (`a__run1.log` == `a__run2.log`,
  2,411,650 B each, SHA-256 `f7401d14810ada03664b84ea25079ea45d4e240fa4d1ed1bce69879dac695568`).
- The packet builder runs twice in the same process and must produce identical
  bytes; both full runs write the same 2,246,207 B and the same file hash.
- The packet hash is recomputed from the file in Python and independently by
  the committed `packet-format.mjs` canonicaliser; both must equal `packet.hash`.
- The patch is untouched, so the four patched engine TUs preprocess identically
  with and without it.

## Remaining blockers

1. **No camera and no lights.** The engine CPU path used here carries no
   camera/view-projection and no light state, so both are absent rather than
   approximated. This is why the packet cannot be schema-conformant.
2. **No inline geometry and no buffer descriptors.** `meshes[]` references
   engine buffers. Vertex element formats, per-buffer strides and index element
   width are not printed per draw; the declared UV0 element stands in only for
   the UV range.
3. **Topology is outside the v1.1 schema.** All 451 draws are triangle strips
   (`topology=1`); `draws[].indexCount` is therefore not a multiple of 3 on 346
   draws. A consumer must read `source.topology`; the schema alone is not
   sufficient.
4. **No sampling.** Wrap mode, filter, anisotropy, mip selection and texture
   matrices remain unresolved; UV0 leaves `[0,1]`.
5. **Two draws have no static albedo.** `g50-n265` primitives 241/242 are
   runtime `DATA_INDEX`/`TEXTURE_PTR` values and stay null.
6. **UV0 exists for the 299 section draws only.** The 152 node-253 draws have
   no resolved UV0 row in this pass; they carry `null` with a reason.
7. **No visibility, culling, LOD selection, sorting or batching.**
   `instancesApplied:false`, LOD0 only, one static frame, no tick loop.
8. **`StreamData::ProcessLoadChunk` is still not driven**; the prerequisite
   graph is resolved sequentially, as recorded in P38.
9. **No renderer, GPU, browser, vehicle or game claim.** `C_OverlayFs` remains
   one read-only layer.

## Evidence

| Path | Content |
| --- | --- |
| `_work/engine-stream-spike/out/packet-engine.json` | the packet, 2,246,207 B |
| `_work/logs/engine-stream-spike/p54-verify-fresh-final.json` | every number above, fresh run |
| `_work/logs/engine-stream-spike/p54-verify-fresh-final.log` | fresh PASS transcript, 128.0 s |
| `_work/logs/engine-stream-spike/p54-verify-reuse-final.json` / `.log` | second full run, identical, 114.2 s |
| `_work/logs/engine-stream-spike/p54-asset-suite-final.log` | 29/29 portable suite |
| `_work/logs/engine-stream-spike/a__run1.log` / `a__run2.log` | identical harness stdout used by the producer |
| `_work/logs/engine-stream-spike/engine-textures.json` | P34 102-source registry (unchanged) |
| `_work/logs/engine-stream-spike/track-textures.json` | P47 96-source registry (unchanged) |
| `_work/engine-stream-spike/out/stream_harness_a.wasm` | module, 872,869 B |
| `docs/work/analysis/engine-level-stream.md` §20 | P54 analysis record |

File hashes at this result:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `engine/patches/t005b-stream-overlay.patch` | 77,284 | `5fa2b1b743c388030d1a0bc8b73fe951acfea92406a29cf7b71b2dbb75019b71` |
| `engine/harness/t005e/stream_harness.cpp` | 174,941 | `81d4661319520637f86c7577833962b55519bd296c67c268fa9aaf7b68edde94` |
| `engine/verify_stream.py` | 213,222 | `dd22e2880d5cd5084b4b537723e097af7f490e59e8cceda706d3181af47e7a18` |
| `_work/engine-stream-spike/out/stream_harness_a.wasm` | 872,869 | `06b80db39583c1110245387f4b2e2f5b6d8b2edf109629e61c2a9fe8ea013d36` |
| `_work/engine-stream-spike/out/packet-engine.json` | 2,246,207 | `7bbcc442a2b118becc4a7781288f064dfd057fbc7e7b9695e14e304e4d44e936` |
| `_work/logs/engine-stream-spike/a__run1.log` | 2,411,650 | `f7401d14810ada03664b84ea25079ea45d4e240fa4d1ed1bce69879dac695568` |

## Recorded result (`--fresh`, exit 0)

```text
patch           sha256=5fa2b1b743c38803
files           16 modified, 0 added
objects         56
wasm            872869 B sha256=06b80db39583c111 deterministic=True
harness         99/99 checks pass
draw list       95 bound / 160 other-block, 9343 triangles, 17782 vertices, hash=fd525c1452869aee
packet          312 records (255 direct / 57 instance), drawable=152, omitted=160, hash=7c29fb2ec7769709
track sections  6 sections, 299 draws / 47790 triangles / 78712 vertices, packet=8b3a40324410327f
track UV0       299/299 draws with a resolved UV0 stream, aggregate=2ed1f4b0b3c9148e
track bindings  297 static / 2 runtime-only, aggregate=9cc08756505dd497
engine packet   2246207 B sha256=7bbcc442a2b118be hash=sha256:0e57f1e51f539c052607171f3ee02eaaa1cc11710a2c962d7c203411582baba8
engine counts   312 node records / 152 drawable, 1355 section records / 299 drawable, 451 draws, 35 meshes, 252 materials
engine textures 297 static / 2 runtime section bindings, 170 distinct decoded sources, UV0 299/299
engine schema   8 violation(s) / 4 note(s) vs render-packet.v1.schema.json
pc parity       4 TUs preprocessed identical
verdict         PASS
```
