# Level-instance UV0 and albedo binding (P73a)

**Date:** 7 November 2026
**Owner:** P73a (sub-agent)
**Scope:** `probes/asset-reader/**`, `_work/asset-reader/**`,
`_work/logs/asset-reader/**` and this document. Read-only inputs:
`game-data/Blur/levels/usa_la_river/{level.levelrender,level.levelstream}`,
`_work/level-instances/{instance-geometry,instance-node}.chunk`, and the
committed P34/P47 texture registry
`_work/logs/engine-stream-spike/engine-textures.json`. No renderer, e1-drive,
engine, tool, other probe, `upstream/` or `game-data/` file was modified.
**Data/reader stage only: no browser check, no GPU claim, no full-game claim.**

---

## 0. Summary

| | |
| --- | --- |
| level-instance draws | **22** (13,162 vertices / 10,308 triangles) |
| UV0 stream | **26,324 float32 values / 105,296 B**, SHA-256 `158a3ac81b4cf7a5b1b92d327d8dfcd97ab29100387eb72d3b84f1f333962c83` |
| UV0 aggregate (FNV-1a 64 over the exported float32 bits) | `0xb07310e198de4c19` |
| declaration | UV0 `usage 5`, `usageIndex 0`, `type 8` (F16_2), byte offset **16**, stride **20** |
| material path | instance row (`g_mWorld`) → base/stream row `default_LN_NB_NL_NV.fx` → `g_tAlbedo` slot → `sources.texture` → resource block/index |
| static albedo sources | **5** (`1073:0`, `1112:0`, `1118:0`, `1074:0`, `1205:0`) |
| bindable with the proven BC1 path | **18 draws / 10,212 triangles** |
| blocked | **4 draws / 96 triangles**, reason **`bc3-alpha-rule-missing`** |
| per-draw UV0 hash | 22/22 present (`uvHash`) |
| independent reference | `probes/asset-reader/tests/verify_instance_textures_reference.py` |
| export artifact | `_work/asset-reader/level-instance-textures.json` (SHA-256 `1a33893026887f0e022eeec782791cbedf9153146d389b7c076f9d0b84f47fb4`) |
| verifier | `probes/asset-reader/tools/verify_level_instance_textures.py`, **558 checks / 0 failures** |
| reader gate | native `/W4` clean, CTest **15/15**, full `verify_asset_probe.py` **31/31** |

The reader now exports real UV0 and the resolved static albedo identity for all
22 block27 instance draws. It still does not apply a texture: it emits no pixel,
no sampler, no alpha rule and no blend state. The export artifact joins the
resolved resource identity to the committed P34/P47 registry to separate the
**18 BC1 draws** from the **4 BC3-alpha draws**, which stay explicitly blocked.

---

## 1. Source contract

`River block27/node253` uses declaration 0 for every base primitive:

| element | usage | type | method | offset | stream |
| --- | ---: | ---: | ---: | ---: | ---: |
| POSITION | 0 | 6 (F32_3) | 0 | 0 | 0 |
| NORMAL | 3 | 11 | 0 | 12 | 0 |
| UV0 | 5 | **8 (F16_2)** | 0 | **16** | 0 |

The referenced block27 vertex buffers have stride **20** and the same three
elements. `type 8` is the committed `F16_2` format: the existing reader decodes
it as two IEEE-754 half values (4 bytes), not two float32 values. P72a §7.1
described the two components as “float32 values”; that wording is corrected
here. The exported stream is float32 after the half decode, which is why the
consumer still receives 2 × float32 per vertex.

The source declaration alone does not carry a stride; stride 20 comes from the
bound vertex buffer and is validated, never assumed.

---

## 2. Reader change

`probes/asset-reader/src/scene_reader.cpp`, `level_instances_core()` /
`expand_instance()`:

1. **UV0 declaration.** The instance base primitive's declaration is searched
   for `usage 5 / usageIndex 0`. The reader requires `method 0` and `type 8`,
   requires the UV0 declaration to use the same stream as POSITION0, then
   requires the bound vertex buffer to contain exactly one matching UV0
   element (`type`, `method`, `offset`) and `offset + 4 <= stride`.
2. **UV0 data.** For every emitted (compacted) instance vertex, the two half
   values are read at `vb.data + vertex * stride + 16`, decoded to float32 and
   appended to a `uv0` array parallel to `positions`. Half NaN/Inf is rejected
   as `Nonfinite instance UV0`; no value is substituted.
3. **Material stack.** `transform_material_data()` now also builds
   `MaterialRow` actions for the constant rows it already parses, so the
   existing `apply_material()` implementation is reused unchanged in order:
   base primitive instance material → base material → every active stream
   material, following nested `MATERIAL_INDEX` rows. The last `g_tAlbedo`
   assignment wins and drives `sources.texture[slot]`.
4. **Binding output.** A resolved static `g_tAlbedo` produces
   `resourceBlock`, `resourceIndex`, `albedoTextureId`
   (`level.albedo.<block>.<index>`), `albedoParameter` and the source material
   row/name. `albedoTexture` stays `null` because the node chunk has no shared
   texture list; the resource identity is the binding, exactly as on the direct
   draw path.
5. **UV0 hash.** Each draw receives a P45/P47-style FNV-1a 64 hash over the
   little-endian float32 UV bits in index order, including repeated indices.
6. **Fail-safe.** A draw without a usable declaration/element, or without a
   resolvable static albedo, keeps `uv0Available:false` or
   `bindingStatus:"blocked"` with an exact `uvReason` / `bindingReason`.
   Nothing is guessed or silently bound.

The reader deliberately does **not** classify BC1 vs BC3: the node chunk does
not contain the texture descriptor. It reports the source identity
(`resourceBlock` / `resourceIndex`). The export stage joins that identity to
the committed P34/P47 registry, whose descriptors and BC decoder are the
already-proven source of format truth.

### 2.1 Additive JSON fields

Per draw, existing fields are unchanged; new fields are appended:

| field | value for the 22 draws |
| --- | --- |
| `material` | `default_LN_NB_NL_NV.fx` |
| `materialRow` | stream material row (`9`, `12`, `19`, `24` or `27`) |
| `albedoTexture` | still `null` (resource identity below) |
| `albedoTextureId` | `level.albedo.<block>.0` |
| `bindingStatus` | `static-resource-albedo-resolved` |
| `bindingReason` | `null` for the 22; exact reason for any blocked draw |
| `uvHash` | `0x` + 16 hex digits, FNV-1a 64 |
| `uvReason` | `null`; exact reason if UV0 is unavailable |
| `uvType` / `uvOffset` / `uvStride` | `8` / `16` / `20` |

Metadata adds `uv0Exported`, `uv0Values`, `uv0Bytes`, `uv0AvailableDraws`,
`uv0HashedDraws`, `uv0ValidVertices`, `uv0PlaceholderVertices`,
`uv0Aggregate`, `uv0PlaceholderPolicy`, `materialAlbedoResolved`,
`materialColourApplied`, `blendStateApplied`, `alphaRuleApplied`,
`shaderStagesApplied` and `samplerStateApplied`. The previous
`material:"diagnostic-only"` becomes
`material:"static-albedo-identity-only"`; the scope string now states that
texture format, alpha, blend, shader, sampler and higher LODs are not applied.

---

## 3. Result

### 3.1 Per-draw UV0 and binding

P45-style hash over the draw's referenced index range. `Tri` is the emitted
triangle count.

| instance | tri | UV0 hash | resource | material row | status |
| ---: | ---: | --- | --- | ---: | --- |
| 0 | 726 | `0xefa29d38b989ce85` | `1073:0` | 9 | bindable-bc1 |
| 1 | 269 | `0xe084faf3172bad17` | `1073:0` | 9 | bindable-bc1 |
| 2 | 726 | `0xefa29d38b989ce85` | `1112:0` | 12 | bindable-bc1 |
| 3 | 269 | `0xe084faf3172bad17` | `1112:0` | 12 | bindable-bc1 |
| 4 | 726 | `0xefa29d38b989ce85` | `1112:0` | 12 | bindable-bc1 |
| 5 | 269 | `0xe084faf3172bad17` | `1112:0` | 12 | bindable-bc1 |
| 6 | 726 | `0xefa29d38b989ce85` | `1112:0` | 12 | bindable-bc1 |
| 7 | 269 | `0xe084faf3172bad17` | `1112:0` | 12 | bindable-bc1 |
| 8 | 726 | `0xefa29d38b989ce85` | `1118:0` | 19 | bindable-bc1 |
| 9 | 269 | `0xe084faf3172bad17` | `1118:0` | 19 | bindable-bc1 |
| 10 | 726 | `0xefa29d38b989ce85` | `1118:0` | 19 | bindable-bc1 |
| 11 | 269 | `0xe084faf3172bad17` | `1118:0` | 19 | bindable-bc1 |
| 12 | 68 | `0xd30ff3db7523d9ac` | `1074:0` | 24 | bindable-bc1 |
| 13 | 1,307 | `0x44e32b8cef9392d0` | `1074:0` | 24 | bindable-bc1 |
| 14 | 24 | `0xdd685574c32fa6ad` | `1205:0` | 27 | **blocked `bc3-alpha-rule-missing`** |
| 15 | 24 | `0xc6d16d604e22504a` | `1205:0` | 27 | **blocked `bc3-alpha-rule-missing`** |
| 16 | 746 | `0xfb603a02151d5258` | `1074:0` | 24 | bindable-bc1 |
| 17 | 68 | `0xd30ff3db7523d9ac` | `1074:0` | 24 | bindable-bc1 |
| 18 | 1,307 | `0x44e32b8cef9392d0` | `1074:0` | 24 | bindable-bc1 |
| 19 | 24 | `0xdd685574c32fa6ad` | `1205:0` | 27 | **blocked `bc3-alpha-rule-missing`** |
| 20 | 24 | `0xc6d16d604e22504a` | `1205:0` | 27 | **blocked `bc3-alpha-rule-missing`** |
| 21 | 746 | `0xfb603a02151d5258` | `1074:0` | 24 | bindable-bc1 |

The hash is geometry-only: instances that share the same base primitive have the
same UV0 hash even when their world transform differs. This is correct for a UV
stream, which is object-local.

### 3.2 The five static albedo sources

| resource | name | size | format | draws | tri | RGBA FNV-1a 64 | RGBA bytes |
| --- | --- | --- | --- | ---: | ---: | --- | ---: |
| `1073:0` | `car01_lic_diff` | 32×16 | DXT1/BC1 | 2 | 995 | `9c50f12ab558e917` | 2,048 |
| `1112:0` | `car02_lic_diff` | 32×16 | DXT1/BC1 | 6 | 2,985 | `b37a10d8ace3c11d` | 2,048 |
| `1118:0` | `car03_lic_diff` | 32×16 | DXT1/BC1 | 4 | 1,990 | `aa5f8e12e7a29982` | 2,048 |
| `1074:0` | `bigtruck02_diff` | 32×16 | DXT1/BC1 | 6 | 4,242 | `b9d41044917e09ae` | 2,048 |
| `1205:0` | `cab01alphas_diff` | 16×16 | **DXT5/BC3** | 4 | 96 | `c306991adc8f7d13` | 1,024 |

**9,216 RGBA bytes total.** The committed registry stores the RGBA FNV-1a 64
for each source and the artifact copies it; the full RGBA SHA-256 values remain
in P72a's `_work/prop-textures/level-props.json` evidence. None of the five is in
the 136-texture track pack.

### 3.3 Split

| status | draws | triangles | rule |
| --- | ---: | ---: | --- |
| `bindable-bc1` | **18** | **10,212** | static `g_tAlbedo` resolves to a DXT1/BC1 image and UV0 is exported |
| `blocked` | **4** | **96** | `cab01alphas_diff` is DXT5/BC3; `bc3-alpha-rule-missing` |

Blocked instances: **14, 15, 19, 20**. All other 18 instance draws are
`bindable-bc1`. The 4 draws remain in the artifact with their real UV0 hash and
resource identity so a later alpha-rule task can bind them without re-deriving
the source.

---

## 4. Export artifact schema

`probes/asset-reader/tools/build_level_instance_textures.py` writes:

| path | content |
| --- | --- |
| `_work/asset-reader/level-instance-textures.json` | deterministic artifact (22 draws, 18/4 split, 5 textures, input hashes) |
| `_work/asset-reader/level-instance-uv.bin` | 26,324 float32 LE values (2 per vertex, 105,296 B) |
| `_work/asset-reader/level-instances-all.json` | canonical native reader output; UV stream is parallel to its `positions` |
| `_work/asset-reader/level-instance-textures-summary.json` | counts, hashes, 18/4 split, deterministic flag |
| `_work/asset-reader/repeat-level-instance-textures.json` | second build, byte-identical to the artifact |
| `_work/asset-reader/repeat-level-instance-uv.bin` | second UV build, byte-identical |

Top-level schema (`kind:"asset-reader.level-instance-textures"`, `version:1`):

| key | meaning |
| --- | --- |
| `level`, `nodeBlock`, `geometryBlock` | `usa_la_river`, `253`, `27` |
| `scope` | static UV0 + `g_tAlbedo` identity only |
| `mesh` | reader output path/SHA-256, 13,162 vertices, 10,308 triangles, float32 positions SHA-256, uint32 indices SHA-256 |
| `uv0` | file, `float32le`, 2 components, 26,324 values / 105,296 B, SHA-256, FNV aggregate, declaration (usage 5 / type 8 / offset 16 / stride 20) |
| `draws[]` | 22 records: `instanceIndex`, `basePrimitiveIndex`, `firstIndex`, `indexCount`, `triangleCount`, `uv0Available`, `uvHash`, `uvType`, `uvOffset`, `uvStride`, `material`, `materialRow`, `albedoParameter`, `albedoTexture` (registry name), `albedoTextureId`, `resourceBlock`, `resourceIndex`, full `texture` record, `bindingStatus`, `bindable`, `blockedReason` |
| `bindable` | status `bindable-bc1`, 18 draws / 10,212 tri, instance list, rule |
| `blocked` | status `blocked`, 4 draws / 96 tri, instances `[14,15,19,20]`, reason `bc3-alpha-rule-missing`, rule |
| `textures[]` | five source records with name/format/size/levels/RGBA hashes/draw list/triangles/bindable count |
| `inputs` | SHA-256 of levelrender, levelstream, geometry chunk, node chunk and registry |
| `limits` | no renderer/GPU/browser claim, static albedo only, BC3 blocked, low source resolution |

The `draws[]` order is the reader emission order (instances 0–21), and
`firstIndex` / `indexCount` refer to the `indices` array in
`level-instances-all.json`. This keeps the UV stream auditable exactly like the
P45 track stream.

---

## 5. Verification

### 5.1 Commands

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

# independent source-only reference (22 draws, UV stream, material chain)
& $py probes/asset-reader/tests/verify_instance_textures_reference.py --json

# deterministic export + repeat build
& $py probes/asset-reader/tools/build_level_instance_textures.py

# independent artifact verifier
& $py probes/asset-reader/tools/verify_level_instance_textures.py

# native/WASM/Python agreement, 22 draws + bundle regression
node probes/asset-reader/tests/verify_instances_wasm.mjs

# full native + WASM rebuild and suite
& $py tools/verify_asset_probe.py

# native CTest
ctest --test-dir _work/build/asset-reader-native -C Release --output-on-failure
```

### 5.2 Results

- **Native/WASM/Python agreement:** `verify_instances_wasm.mjs` compares the
  complete native and WASM JSON (`isDeepStrictEqual`), then checks all 22 draws
  against the independent Python reference: 22/22 UV0 hashes, 22/22 spans,
  material rows, material names, resource blocks/indices and texture identities
  agree. The WASM UV0 stream SHA-256
  `158a3ac81b4cf7a5b1b92d327d8dfcd97ab29100387eb72d3b84f1f333962c83`
  and aggregate `0xb07310e198de4c19` equal the Python values.
- **UV stream size:** 26,324 float32 values / 105,296 B, exactly the P72a
  expectation. All 22 draws are `uv0Available:true`; placeholder vertices are 0.
- **Determinism:** two artifact builds produce byte-identical
  `level-instance-textures.json` (SHA-256
  `1a33893026887f0e022eeec782791cbedf9153146d389b7c076f9d0b84f47fb4`)
  and byte-identical UV files.
- **Split:** 18/10,212 BC1-bindable; 4/96 blocked with
  `bc3-alpha-rule-missing`; 5 source textures; 10,308 total triangles.
- **Artifact verifier:** **558 checks, 0 failures**.
- **Native CTest:** **15/15 PASS.**
- **Full `verify_asset_probe.py`:** **31/31 PASS** (native + WASM rebuild,
  all existing readers, instance and bundle regressions).
- **`/W4`:** the native MSVC build is warning-free.

Evidence paths: `_work/verification/level-instances-native-wasm.json`,
`_work/asset-reader/*`, `_work/logs/asset-reader/*`.

---

## 6. Limits

1. **Reader/data only.** No texture was sampled, uploaded or rendered; no GPU
   or browser result is claimed. A later renderer task must still verify a
   screenshot and a clean console.
2. **Static albedo identity only.** `g_tMaterial`, material colour, blend state,
   shader stages, sampler wrap/filter, anisotropy, mips and sRGB remain
   unapplied, exactly as in the P49/P55/P59 paths.
3. **BC3 stays blocked.** The four cab draws have a real UV0 stream and a real
   `cab01alphas_diff` identity, but no alpha-test/blend rule is declared. They
   are retained and labelled; they are not silently dropped or bound.
4. **Reader cannot name textures.** The node chunk has no texture descriptor;
   the reader reports `resourceBlock`/`resourceIndex`. Names, formats and RGBA
   hashes come from the committed P34/P47 registry at the export stage.
5. **One level, one node.** River block27/node253 only. The bundle reader now
   also exports UV0 for its 56 supplied instances (69,264 float values), but
   that is a regression-safe by-product, not a separate texture claim.
6. **Low source resolution.** The five images are 32×16 / 16×16 at mip0; no
   upscale, mip chain or invented detail is used.
7. **No game-data modification.** The retail level render/stream, `upstream/`,
   e1-drive and every texture remain read-only; all new data is under `_work/`.

---

## 7. READ1 addendum: shared export contract (7 November 2026)

READ1 extended the **direct level** path (`level_mesh_inspect`) to print the same
identity fields that P73a already exported for instances:
`albedoTexture`, `albedoParameter`, `material`, `materialRow`, `resourceBlock`,
`resourceIndex`, `uv0Available`, `uvHash`, `bindingStatus` and `bindingReason`,
plus the level Scene `sharedTextures` list. The instance path was not modified.

- **P73a artifact unchanged.** `_work/asset-reader/level-instance-textures.json`
  is still 25,724 B / SHA-256
  `1a33893026887f0e022eeec782791cbedf9153146d389b7c076f9d0b84f47fb4`;
  the UV stream is still 105,296 B / SHA-256
  `158a3ac81b4cf7a5b1b92d327d8dfcd97ab29100387eb72d3b84f1f333962c83`;
  native `--instances-all` is byte-identical
  (`2543128a5a299e454e34980b4e2f465022788a27849267cfdadd08d9cfd1acbb`).
  The artifact verifier still passes **558 checks / 0 failures**.
- **River direct draws** now print `1073:0`, `1112:0`, `1118:0`, `936:0`,
  `829:0` with material rows `2, 3, 4, 6, 8`; positions/indices/UV0 are
  byte-identical to the pre-change output.
- **Amboy** is covered by
  `probes/asset-reader/tests/verify_amboy_direct_bindings.py`
  (14,294 checks / 0 failures) and `verify_amboy_wasm.mjs`. Full evidence and
  the remaining decoder/alpha/effect/runtime blockers are in
  `docs/work/analysis/map-slice-amboy-textures.md` §11.
- **Gates:** native `/W4` clean, CTest **15/15**, P73a verifier PASS, Amboy
  native/WASM/Python agreement PASS. The full suite has one cached-package
  failure: `_work/map-slice/amboy/slice.json` records the pre-fix
  `level_inspect.exe` bytes/hash; a copy re-verified with that one record
  refreshed passes 12,367 checks. READ1 did not edit map-slice files.
- **Limits unchanged:** static `g_tAlbedo` identity and UV0 only; BC3 alpha,
  >512 px decode, runtime albedo and effect layers remain blocked, and no
  renderer/GPU/browser claim is made.
