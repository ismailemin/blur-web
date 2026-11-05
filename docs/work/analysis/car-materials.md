# Per-car material/albedo texture bindings and decoded textures (five roster cars)

**Date:** 5 November 2026
**Owner:** P52 (sub-agent)
**Scope:** new `probes/car-materials/`, generated output under
`_work/car-materials/`, logs under `_work/logs/car-materials/`, and this
document. No change to `probes/e1-drive`, `probes/car-parts`,
`probes/track-coverage`, `probes/drivable-path`, `probes/asset-reader`,
`probes/render-packet`, the engine, `tools/`, `upstream/` or `game-data/`.
Data extraction only; no renderer, shader or game claim.

**Result:** all **491** draws of the five E1 roster cars were resolved to their
committed material binding. **224** draws bind a static ordinary albedo image
through `g_MeshTexture`; they reference **40 unique source textures**, all
**40 decoded** to mip0 RGBA. The other **267** draws are runtime-only and are
reported with the committed reader's exact reason: 45 paint lookups,
66 light off/on blends and 156 `_NO_ALBEDO` shaders. Every decoded texture was
re-decoded by the committed `texture_inspect.exe --raw` with **0 mismatches**
(`firstMismatch:null`), and three independent builds produced **126
byte-identical files**.

---

## 0. Summary

| | |
| --- | --- |
| cars | **5 of 5** mapped by the committed car index |
| draws | **491** |
| static albedo draws | **224** (`g_MeshTexture`; all with original UV0) |
| shared-image draws / resource-block draws | **75 / 149** |
| runtime-only draws | **267** = paint **45** + light blend **66** + no-albedo **156** |
| unique referenced textures | **40** (21 shared records, 19 resource-block records) |
| decoded textures | **40 / 40** mip0 RGBA8 |
| decoded pixels | 4,544,512 RGBA pixels = **18,178,048 bytes** |
| stored original raw slices | **3,927,712 bytes** (descriptor + complete mip chain) |
| native re-decodes | **40 / 40**, **0** byte mismatches |
| independent Pillow cross-check | 28 BC1/BC2 exact; 12 BC3 differ only in alpha by 1/255 (50,666 channels) |
| unsupported source LODs | 2 (`1024x1024`, outside the decoder's 512 bound); recorded, not decoded |
| determinism | 3 builds, **126** files each, byte-identical |
| verification | `_work/car-materials/roster/verify.json` — **PASS**, 0 failures |

No image is claimed to reproduce retail car appearance: sampling state, UV
transforms, sRGB, alpha blend, shader code, paint lookup and light blend are not
applied.

This record does not replace earlier material evidence: the Corvette-only
material and resource-texture notes remain in `docs/plan/car-materials.md` and
`docs/plan/car-resource-textures.md`, and the track-wide `g_tAlbedo` extraction
is `docs/work/verification/T-007-textured-track.md`. Here the same
descriptor/chain and committed-decoder rules are applied to every draw of the
five roster cars. The E1 drive slice is unchanged; no car is textured yet.

---

## 1. Method

### 1.1 Authority and inputs

The builder reads only committed artifacts and re-runs the committed readers:

| role | authority |
| --- | --- |
| car mapping, model/manifest hashes | `_work/car-parts/cars/index.json` |
| draw ownership | `_work/car-parts/cars/<slug>/manifest.json` (`blur.car-part-manifest` v1) |
| draw binding, shared texture identity | `scene_inspect.exe <model>` (committed C++ material reader) |
| resource texture name/hash/LOD metadata | `scene_inspect.exe <model> --resources` |
| independent material-row traversal | `tools/inspect_car_materials.py` (imported read-only, not modified) |
| PC texture decode | `texture_inspect.exe --raw` (committed decoder, `FORMAT-texture.md`) |

For every car the re-run `scene_inspect.exe` output is byte-identical to the
committed `scene-report.json` (`reproducedByteIdentical:true`). The independent
Python traversal and the C++ reader agree on the classification of every one of
the 491 draws and on every original UV0 availability flag; a disagreement aborts
the build.

### 1.2 Draw → material row → texture identity

Draws are evaluated in the source application order: primitive instance
material, base material, then every active stream material in serialized order,
recursively following constant `MATERIAL_INDEX` references. A material row is
recorded as `list0-material<N>` with its serialized index, type name, archive
offset, field offset and the winning call stage. Runtime-rebuilt lists
(`listIndex != 0`) are kept as calls but can never supply a static texture.

The albedo parameter is **`g_MeshTexture`** for every static vehicle draw in this
roster (no `g_tAlbedo` occurs). Its scalar `TEXTURE_INDEX` is resolved through
the render-list texture source list:

- `block == -1` → shared texture `(index)` in the Scene header;
- `block >= 0` → resource-block texture `(block, index)` in the seven-to-ten
  loaded resource blocks.

Texture identity (`name`, `hash`, `block/index` or `shared index`) comes from the
committed `scene_inspect.exe --resources` metadata, cross-checked against the
independent traversal. No filename or hash is guessed.

Example (Corvette ZR1 draw 0, `body.shell`, `veh_Paint_b_c.fx`):

```json
{
  "index": 0,
  "partId": "body.shell",
  "effect": "veh_Paint_b_c.fx",
  "albedoParameter": "g_MeshTexture",
  "material": {
    "id": "list0-material1",
    "stage": "stream[0]/slot0",
    "listIndex": 0, "index": 1,
    "typeName": "veh_Paint_b_c.fx",
    "archiveOffset": 2205501,
    "fieldSerializedOffset": 2205509,
    "nodeTextureIndex": 1
  },
  "textureIds": ["block:6:0:corvette_zr1_interior"],
  "uv0Available": true
}
```

### 1.3 Texture decoding and mip-chain assembly

- **Shared textures** are stored as an embedded 28-byte PC `Display::TextureDesc`
  followed by a complete mip chain. The exact slice is copied byte-for-byte and
  verified against the descriptor's mip-byte arithmetic.
- **Resource-block LOD0** contains a complete chain. Later populated LODs supply
  only new largest mip levels; the existing lower tail is copied behind them
  using the source `CopyTextureData2D` alignment rule (same descriptor,
  dimensions shifted by the level difference, exact prefix/tail boundaries).
  No descriptor is invented and no top-mip-only payload is relabelled.
- The **selected decoded image** is the highest assembled complete chain whose
  dimensions are within the committed decoder's bound (512×512). Mip0 of that
  chain is decoded to RGBA8, stored as `.rgba` and `.png`, and hashed.
- The committed decoder is authoritative. An independent Pillow DDS decode is
  the cross-check: exact for BC1/BC2; for BC3 the RGB channels are exact and
  alpha differs by at most 1/255 because the source decoder rounds interpolation
  while Pillow floors it.

All decoded `.rawtexture` files are original descriptor + original/copied chain
bytes; they contain no archive envelope or modified descriptor.

### 1.4 Verification

`verify_roster_materials.py` re-runs `texture_inspect.exe --raw` on every
decoded texture and compares the full RGBA byte string with both the stored
`.rgba` file and the manifest hash. On a mismatch it records the first byte
offset. It also recomputes the Pillow reference and enforces the BC3 policy over
every channel, re-checks draw/part/texture coverage and roles, and compares two
fresh builds plus the final tree by relative path and SHA-256.

---

## 2. Coverage

| car | draws | parts | static albedo | shared | block | paint | light | no-albedo | textures | decoded | RGBA bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Corvette ZR1 | 100 | 34 | 50 | 14 | 36 | 10 | 17 | 23 | 9 | 9 | 4,538,368 |
| Lotus Exige Cup260 | 88 | 23 | 48 | 14 | 34 | 0 | 14 | 26 | 9 | 9 | 4,997,120 |
| Dodge Challenger | 104 | 31 | 42 | 14 | 28 | 11 | 13 | 38 | 7 | 7 | 2,637,824 |
| Ford Focus RS | 115 | 31 | 37 | 14 | 23 | 15 | 13 | 50 | 7 | 7 | 3,424,256 |
| Audi R8 V10 | 84 | 29 | 47 | 19 | 28 | 9 | 9 | 19 | 8 | 8 | 2,580,480 |
| **total** | **491** | **148** | **224** | **75** | **149** | **45** | **66** | **156** | **40** | **40** | **18,178,048** |

`static + paint + light + no-albedo = 491` for every car. Every static draw has
original UV0 (`staticAlbedoDrawsWithUv0 == staticAlbedoDrawCount`).

Parts that receive at least one static image (proven draws only; ambiguous wheel
draws stay in the explicit `partId:null` group):

| car | textured parts / proven parts | textured parts |
| --- | ---: | --- |
| Corvette ZR1 | 9 / 34 | license plate, mirror, body shell, steering wheel, interior shell, 4 wheels |
| Lotus Exige Cup260 | 8 / 23 | license plates, body shell, interior shell, 4 wheels |
| Dodge Challenger | 10 / 31 | plates, mirror, body shell, steering wheel, interior shell, 4 wheels |
| Ford Focus RS | 10 / 31 | plates, mirror, body shell, 4 glass parts, steering wheel, interior shell |
| Audi R8 V10 | 8 / 29 | license plate, body shell, steering wheel, interior shell, 4 wheels |

The wheel textures are the tyre and brake-disc images; the rim draw has no
ordinary albedo (`veh_Alloy_a_b_f.fx` is `_NO_ALBEDO`). Glass is usually a
no-albedo shader; the Focus is the exception, where four glass draws bind
`focusrs-alpha`.

---

## 3. Per-car bindings and decoded textures

`hash` is the serialized `u32` texture hash from the committed reader.
`role` distinguishes ordinary albedo use from the light off/on inputs (the same
image can serve both). `albedo draws` counts only static `g_MeshTexture` draws.

### 3.1 Corvette ZR1 (`corvette-zr1-stock`)

| texture | source | hash | role | albedo draws | selected LOD | decoded size | RGBA SHA-256 |
| --- | --- | ---: | --- | ---: | ---: | --- | --- |
| `gt500_2` | block 2 / 0 | 401266031 | albedo | 3 | 8 | 512×512 | `8e06d26d378212c0c94a92044b1282b7390e2ebf88a1fd35ec5438f08e90f4cf` |
| `corvette_zr1_weaving_livery` | block 4 / 0 | 1623445882 | albedo | 8 | 9 | 128×128 | `fd57bf680056325f14f90dd5d7ee8193f97b8267456660ecd1634488787cb8e5` |
| `corvette_zr1_interior` | block 6 / 0 | 1267361649 | albedo | 10 | 7 | 512×512 | `b71a8ceea87dc091f1825ba44069943ff9e4347de1ac8aa2fa683033b36152c5` |
| `corvette_zr1_decals` | block 8 / 0 | 2961335064 | albedo | 13 | 9 | 512×512 | `87ed844838987b2609c269ebe08a57eac5f662ebf49db4f02edbcb7635f64dfa` |
| `corvette_zr1_lights` | block 9 / 0 | 1709224491 | albedo, light input | 2 (+17 light) | 9 | 512×512 | `7b94de1063042841ab739dcf19893f4543cdcecc4f06cc10a92c401cb2dd2629` |
| `tyrewall` | shared 2 | 4165024792 | albedo | 4 | embedded | 512×32 | `8f3a1fe2fec328a044a063bf4440fe4ae050dc35a05c1d8238853b6b33fefa5b` |
| `tyretred` | shared 3 | 1579957242 | albedo | 4 | embedded | 128×32 | `cf96db4ead5bcde336b320949cea6657e163c4ce1bcb651bb35b8e54a7dd5ca3` |
| `breakdisc` | shared 5 | 1486518972 | albedo | 4 | embedded | 128×128 | `10149ac4b79124b5e2240b906c379a2659ca684947c17828faa4a8a15577a648` |
| `nyc_10` | shared 6 | 1951146064 | albedo | 2 | embedded | 256×128 | `6109b56c67d3b69529ba9e84ad784359c5f9102255b327adc6866c39d29b4e63` |

### 3.2 Lotus Exige Cup260 (`lotus-exige-cup260-stock`)

| texture | source | hash | role | albedo draws | selected LOD | decoded size | RGBA SHA-256 |
| --- | --- | ---: | --- | ---: | ---: | --- | --- |
| `underside` | block 1 / 0 | 2200076873 | albedo | 1 | 8 | 512×256 | `09d3fc5d20ab40d5ea105e561b830324e620a9cdf4cd8559c8d8abe9be399fea` |
| `lotus_260_decals` | block 3 / 0 | 3693057517 | albedo | 5 | 8 | 512×512 | `39f841d8e2a59d788429ce0d2e5ccaeba4abecb68c88b19c18d8c785a3c33292` |
| `lotus_stock_livery` | block 5 / 0 | 998861044 | albedo | 9 | 6 | 512×512 | `e6a5184ee423033c8b55028ed7bee70a27f79f6129b65452374aa385b5420d32` |
| `lotus_260_interior` | block 6 / 0 | 3396856362 | albedo | 13 | 8 | 512×512 | `86209e3b6091cc41b250191ea415c30b331635040333c2314977a3fe97753b70` |
| `lotus_260_lights` | block 7 / 0 | 1902064106 | albedo, light input | 6 (+14 light) | 9 | 512×512 | `092318cd2ffd8acca26c1657207fa5c846ed09e178cccb3cf441f87edf42fdc5` |
| `nyc_02` | shared 2 | 2692964145 | albedo | 2 | embedded | 256×128 | `a84ff69fe482f15e9ffcd82ef8180782c36308cdeb7954f10bea376be3e531f8` |
| `tyrewall` | shared 3 | 4165024792 | albedo | 4 | embedded | 512×32 | `8f3a1fe2fec328a044a063bf4440fe4ae050dc35a05c1d8238853b6b33fefa5b` |
| `tyretred` | shared 4 | 1579957242 | albedo | 4 | embedded | 128×32 | `cf96db4ead5bcde336b320949cea6657e163c4ce1bcb651bb35b8e54a7dd5ca3` |
| `breakdisc` | shared 6 | 1486518972 | albedo | 4 | embedded | 128×128 | `10149ac4b79124b5e2240b906c379a2659ca684947c17828faa4a8a15577a648` |

`lotus_stock_livery` also has a populated **LOD 7 at 1024×1024**; its complete
chain was assembled, but the committed decoder's 512×512 bound rejects it, so
LOD 6 (512×512) is the decoded image and the rejection is recorded with the
descriptor offset 3,552,477 and payload offset 3,552,533.

### 3.3 Dodge Challenger (`dodge-challenger-stock`)

| texture | source | hash | role | albedo draws | selected LOD | decoded size | RGBA SHA-256 |
| --- | --- | ---: | --- | ---: | ---: | --- | --- |
| `dodge_decals` | block 7 / 0 | 190900845 | albedo | 11 | 9 | 256×256 | `f1248fc6a58dd8e069cc5a6a06d2e8129bcb8113ac977f51db6916ad2f71c547` |
| `dodge_interior` | block 8 / 0 | 1156858781 | albedo | 12 | 7 | 512×512 | `76762e816c3447b463ea67b5bb2f9a7387d6b29837584a04c1e3bebc855ae98f` |
| `dodge_lights` | block 9 / 0 | 4288409057 | albedo, light input | 5 (+13 light) | 8 | 512×512 | `34ac86e89e71eaa830e31dd0417a6e18d8077b39b7664f22bc0f0b9d129758ae` |
| `cali_09` | shared 2 | 1716673094 | albedo | 2 | embedded | 256×128 | `19dd523285a754e14570ac5a853759fcd989c68a34837d90805bf21d16e52ad1` |
| `tyretred` | shared 3 | 1579957242 | albedo | 4 | embedded | 128×32 | `cf96db4ead5bcde336b320949cea6657e163c4ce1bcb651bb35b8e54a7dd5ca3` |
| `tyrewall` | shared 5 | 4165024792 | albedo | 4 | embedded | 512×32 | `8f3a1fe2fec328a044a063bf4440fe4ae050dc35a05c1d8238853b6b33fefa5b` |
| `breakdisc` | shared 6 | 1486518972 | albedo | 4 | embedded | 128×128 | `10149ac4b79124b5e2240b906c379a2659ca684947c17828faa4a8a15577a648` |

### 3.4 Ford Focus RS (`ford-focusrs-stock`)

| texture | source | hash | role | albedo draws | selected LOD | decoded size | RGBA SHA-256 |
| --- | --- | ---: | --- | ---: | ---: | --- | --- |
| `focusrs-alpha` | block 5 / 0 | 287077062 | albedo | 5 | 7 | 512×512 | `a8432bdec74566a1c00a561572de940e65b13fccc2cd28a7f7ffd28e1a030216` |
| `focusrs-text02` | block 8 / 0 | 3479685 | albedo, light input | 2 (+13 light) | 8 | 512×512 | `e3cc5b6f66739f4785f2f2a25ec09f765c4052b51d1341b18291d4a878a31cb5` |
| `focusrs-text01` | block 9 / 0 | 1162449062 | albedo | 16 | 6 | 512×512 | `deff592661d03938ef0b8d166e9db6cb12e8a8c2a470d5b067d89ff3bb97604b` |
| `tyrewall` | shared 1 | 4165024792 | albedo | 4 | embedded | 512×32 | `8f3a1fe2fec328a044a063bf4440fe4ae050dc35a05c1d8238853b6b33fefa5b` |
| `tyretred` | shared 2 | 1579957242 | albedo | 4 | embedded | 128×32 | `cf96db4ead5bcde336b320949cea6657e163c4ce1bcb651bb35b8e54a7dd5ca3` |
| `breakdisc` | shared 4 | 1486518972 | albedo | 4 | embedded | 128×128 | `10149ac4b79124b5e2240b906c379a2659ca684947c17828faa4a8a15577a648` |
| `cali_12` | shared 6 | 1723150919 | albedo | 2 | embedded | 256×128 | `1cb1c48e50c42b17d69f91992dada61edf75f6030b3e9de687aaaef1fe0f178d` |

`focusrs-text01` also has a populated **LOD 7 at 1024×1024** (descriptor offset
4,956,905, payload offset 4,956,961); the decoder bound rejects it, so LOD 6 is
decoded and the rejection is recorded.

### 3.5 Audi R8 V10 (`audi-r8v10-stock`)

| texture | source | hash | role | albedo draws | selected LOD | decoded size | RGBA SHA-256 |
| --- | --- | ---: | --- | ---: | ---: | --- | --- |
| `audir8_alpha` | block 3 / 0 | 68182736 | albedo | 3 | 9 | 256×256 | `548e3e963ca23ab4fc2e57f3117198071fbff4655e007351742331f0aa3cf479` |
| `audir8_2` | block 5 / 0 | 4001193167 | albedo | 8 | 6 | 512×512 | `769506ae525837b181aa583b17082d8e37e5bc854ebc49b9a32c87c73c94a797` |
| `audir8_1` | block 8 / 0 | 2513717467 | albedo, light input | 17 (+9 light) | 6 | 512×512 | `3575f11d152b04b376689ac69b932271456e8e265dc368bd24a199daf840d189` |
| `carbonfibre` | shared 1 | 1717934923 | albedo | 1 | embedded | 64×32 | `694c8a32dace140cd3709dec06a5868f4ee2753f120326199796073600f16aee` |
| `tyrewall` | shared 2 | 4165024792 | albedo | 4 | embedded | 512×32 | `8f3a1fe2fec328a044a063bf4440fe4ae050dc35a05c1d8238853b6b33fefa5b` |
| `tyretred` | shared 3 | 1579957242 | albedo | 4 | embedded | 128×32 | `cf96db4ead5bcde336b320949cea6657e163c4ce1bcb651bb35b8e54a7dd5ca3` |
| `breakdisc` | shared 5 | 1486518972 | albedo | 8 | embedded | 128×128 | `10149ac4b79124b5e2240b906c379a2659ca684947c17828faa4a8a15577a648` |
| `spain10` | shared 7 | 4009170985 | albedo | 2 | embedded | 256×64 | `70c5df827e04414dce943863b46230dd36f06c42684ca3699f1cbfb65feda638` |

`tyrewall`, `tyretred` and `breakdisc` decode to the same RGBA SHA-256 on every
car that references them, which is the expected result of identical shared
source images; the probe does not assume this and hashes each occurrence.

---

## 4. Runtime-only and unsupported references

No image is bound for these draws. Both the committed C++ binding text and the
independent reason are stored per draw (`binding`, `runtimeReason`).

| car | paint lookup | light blend | `_NO_ALBEDO` no image |
| --- | ---: | ---: | ---: |
| Corvette ZR1 | 10 | 17 | 23 (default 11, glass 8, alloy 4) |
| Lotus Exige Cup260 | 0 | 14 | 26 (default 15, glass 6, alloy 5) |
| Dodge Challenger | 11 | 13 | 38 (default 25, glass 9, alloy 4) |
| Ford Focus RS | 15 | 13 | 50 (default 42, glass 4, alloy 4) |
| Audi R8 V10 | 9 | 9 | 19 (default 4, glass 11, alloy 4) |

Exact reasons (source-shaped):

- **paint** — “The `_a` variant defines `_NO_ALBEDO`; this draw does not sample an
  albedo image; paint appearance comes from runtime `g_sPaintMaterialTexture`.”
  The committed C++ text is “Vehicle `_NO_ALBEDO` paint uses a runtime paint
  lookup texture.” The lookup is built from the user's paint job, not the model.
- **light** — “Off/On texture blend depends on runtime `g_vRenderColour.w`, and
  uses both UV0.xy/zw.” Both off/on inputs resolve to the recorded light atlas
  (for example ZR1 `block 9`), but their blend is runtime.
- **no ordinary albedo** — “The `_a` variant defines `_NO_ALBEDO`; this draw does
  not sample an albedo image.” The committed C++ text is “Vehicle `_NO_ALBEDO`
  shader does not sample an albedo image.”

All 491 draws use vehicle `veh_*` effects; no prop `g_tAlbedo` reference occurs in
this roster. The only unsupported source LODs are the two 1024×1024 chains in
§3.2 and §3.4; every other populated LOD assembled and every selected texture
decoded.

---

## 5. Verification

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py probes/car-materials/tools/build_roster_materials.py
& $py probes/car-materials/tools/verify_roster_materials.py
& $py tools/verify_asset_probe.py --skip-build
```

| check | result |
| --- | --- |
| C++ vs independent parser | 491/491 draws agree; UV0 flags agree; build aborts on any difference |
| committed scene report | reproduced byte-identically for 5/5 cars |
| descriptor/chain arithmetic | 40/40 selected textures exact; all populated LODs cross-checked against `--resources` `completeMipBytes`/`topMipLevels` |
| native re-decode | **40/40**, `firstMismatch: null`, 0 mismatches |
| independent Pillow | 28 BC1/BC2 exact; 12 BC3, 50,666 alpha channels differ by 1/255, RGB exact |
| coverage invariants | static+paint+light+no-albedo = draws; every draw owned once; every static draw has UV0 and a decoded texture |
| determinism | 3 builds (final, `verify-a`, `verify-b`), 126 files each, byte-identical |
| portable asset suite | `verify_asset_probe.py --skip-build` — **29/29 PASS** |

No C++ was modified, so no native rebuild was required. `ctest` is not on PATH
in this environment; the 29-check suite (including `car-native-wasm` and
`resource-binding`) passed against the existing binaries.

`_work/car-materials/roster/verify.json` — **PASS**, 0 failures,
`firstMismatch: null`, `treeEqual: true`, `finalEqual: true`.

---

## 6. Hashes

| artifact | bytes | SHA-256 |
| --- | ---: | --- |
| `_work/car-materials/roster/index.json` | 23,415 | `77e73bfff8e324459d337f9ec1817f717e39aabfe0134433ca886c2a1774cd76` |
| `_work/car-materials/roster/verify.json` | 2,428 | `a62a6fe51fbcd6b5fc89bb84caea573fb61095c56336e06218d43535faa6f03a` |
| `cars/corvette-zr1-stock/materials.json` | 263,687 | `c658a587a7e6b3d0a0ea89ac47257e0c175d0323f19c0e4173ba5cdcb140a512` |
| `cars/lotus-exige-cup260-stock/materials.json` | 239,303 | `0d1dc5af17f214ebe5500b4104c7354d14cf5c53c0ca75f4eb9f044351a404ee` |
| `cars/dodge-challenger-stock/materials.json` | 245,075 | `cf9f6480b7443b4fa64d9f439974a886e9934857121dc979585f22f66f0b7d26` |
| `cars/ford-focusrs-stock/materials.json` | 264,342 | `2ca91ffd8b3ceb746f26e31aef6a3795757b6c99260f9a92ba00b7bbd8bacb0c` |
| `cars/audi-r8v10-stock/materials.json` | 215,129 | `4ee7b76184049293a320825719ed039f49cd16cd238f0b39ea4a6166834ab2e4` |

Per-texture RGBA hashes are in §3; per-texture raw-slice, `.rgba`, `.png` and
native JSON hashes are in each `materials.json` (`textures[].decoded`).

Input identities are the committed ones: ZR1 `c55cdc1e…e2313453`, Lotus
`1b6af978…2e0ab786`, Dodge `6195243f…dc487c5`, Focus `0668854b…c9fbe4`,
Audi `2e71aaa7…426120`. The part manifests are those recorded in
`_work/car-parts/cars/index.json`.

---

## 7. Limits

- **First RenderList base primitives, LOD0 only.** Later render lists, higher
  LODs, damage states, paint variants and runtime light states are not imported.
- **Source images, not appearance.** Decoded RGBA is mip0 of the selected
  chain. No sampler, wrap/filter, UV transform, sRGB/colour space, alpha blend,
  shader code, decal compositing, paint lookup, light blend, reflection, dirt or
  damage is applied. `materialsApplied`, `shaderExecuted`, `samplerApplied`,
  `paintLookupRecovered`, `lightBlendRecovered` and `rendererClaim` are all
  `false`.
- **Runtime-only draws stay unresolved by design.** 45 paint, 66 light and 156
  `_NO_ALBEDO` draws carry the exact reason and no image.
- **Decoder bound 512×512.** Two 1024×1024 source LODs are assembled and
  recorded but not decoded. The 512×512 lower chain is used instead and is
  labelled with its source LOD.
- **Draw→part identity is inherited.** It is the committed part manifest's AABB
  evidence. Ambiguous wheel draws keep `partId:null` and appear only in the
  explicit unclassified group; the original preview pairing stays in the part
  manifest and is not turned into a material ownership claim.
- **Resource LOD assembly is source-rule based.** A later LOD is accepted only
  when its new top mip prefix and the previous complete tail align exactly by
  format, dimensions and level difference; anything else is recorded as
  unsupported rather than patched.
- **No renderer or game claim.** This is a data manifest for later texturing
  work, not a retail material reproduction.

---

## 8. Evidence and reproduction

| path | content |
| --- | --- |
| `probes/car-materials/tools/build_roster_materials.py` | builder |
| `probes/car-materials/tools/verify_roster_materials.py` | gate |
| `_work/car-materials/roster/index.json` | per-car coverage and texture table |
| `_work/car-materials/roster/cars/<slug>/materials.json` | draw/part/material/texture manifest |
| `_work/car-materials/roster/cars/<slug>/textures/` | `.rawtexture`, `.rgba`, `.png` |
| `_work/car-materials/roster/verify.json` | PASS, 40 native re-decodes, determinism |
| `_work/car-materials/verify-a/`, `verify-b/` | two independent build trees |
| `_work/logs/car-materials/build.log` | builder stdout |
| `_work/logs/car-materials/verify.log` | gate stdout |
| `_work/logs/car-materials/asset-probe-skip-build.log` | 29/29 suite |

Re-running the two commands above reproduces the same 126 files; the verifier
requires the two comparison directories to be absent so it cannot reuse stale
output.

---

## 9. P60 — static texture references on the 267 runtime-only draws

**Date:** 6 November 2026
**Owner:** P60 (sub-agent)
**Scope:** new tools in `probes/car-materials/tools/`, output under
`_work/car-materials/runtime/`, logs under `_work/logs/car-materials/`, and this
appended section. No change to `probes/e1-drive`, `probes/car-parts`,
`probes/drivable-path`, `probes/asset-reader`, the engine, `tools/`, `upstream/`
or `game-data/`. Data extraction only; no renderer or game claim.

**Result:** the **267** runtime-only draws of §4 were re-examined field by field
and split exactly as before: **45** paint-lookup draws, **66** light off/on blend
draws and **156** other `_NO_ALBEDO` draws. **161** of the 267 carry at least one
serialized static `TEXTURE_INDEX` reference: all **45** paint draws (dent/scratch,
plus one Ford bump), all **66** light draws (off/on/damage masks) and **50** of
the 156 other `_NO_ALBEDO` draws (glass scratch/dent, bump and one default
colour). The remaining **106** have no static texture reference at all. **29**
per-car texture records were produced, **24 decoded** to mip0 RGBA8 and **5**
recorded as undecoded with an exact reason (the same shared 1024×1024
`smashedglass_nrm` in each car). The committed decoder re-decoded **24/24** with
**0 mismatches** (`firstMismatch:null`), and two fresh builds of **78 files**
each were byte-identical to the final tree.

Crucially, the paint lookup and the light blend themselves are **not** recovered:
`paintLookup.resolution` and `lightBlend.resolution` are `"unsupported"` on every
paint and light draw, with the serialized field and source lines recorded. No
paint colour is invented.

### 9.1 Classification and per-draw evidence

The classification is taken from the committed P52 roster
(`_work/car-materials/roster/cars/<slug>/materials.json`, draw
`albedoParameter:null`) and re-checked against the independent parser
(`tools/inspect_car_materials.py`). A draw is:

| class | rule | committed field / line |
| --- | --- | --- |
| paint | `shaderFamily in {paint, paintm}` and the effect token list contains `a` (`_NO_ALBEDO`) | `shaders.jam:29` (`<_a>` → `_NO_ALBEDO`); `vehicle_common.h:508,583,1250`; `tools/inspect_car_materials.py:314-315` |
| light | `shaderFamily == light` | `vehicle_common.h:447-450,1212-1214`; `tools/inspect_car_materials.py:312` |
| other `_NO_ALBEDO` | any other effect whose token list contains `a` | `shaders.jam:29`; `tools/inspect_car_materials.py:313-314` |

The field sets actually present on each class, counted over all five cars:

| class | `TEXTURE_INDEX` field | bindings | resolved to |
| --- | --- | ---: | --- |
| paint | `g_DentTexture` | 45 | shared `paintdent` |
| paint | `g_ScratchTexture` | 45 | car paint-scratch texture |
| paint | `g_BumpTexture` | 1 | Ford `bump` (block 1 / 0) |
| light | `g_sOffTexture` | 66 | car light atlas |
| light | `g_sOnTexture` | 66 | car light atlas |
| light | `g_sOffTextureDamage` | 66 | car light atlas |
| light | `g_sOnTextureDamage` | 66 | car light atlas |
| other `_NO_ALBEDO` | `g_ScratchTexture` | 48 | glass `smashedglass` / car scratch |
| other `_NO_ALBEDO` | `g_DentTexture` | 19 | shared `smashedglass_nrm` |
| other `_NO_ALBEDO` | `g_BumpTexture` | 2 | car bump / `focusrs-text01` |

`TEXTURE_INDEX` is `MATERIAL_ELEMENT_TYPE_TEXTURE_INDEX` (type 7) per
`renderingdata/include/renderingdata/datatypes.h:54`; the value is the node
texture-source index resolved by
`renderingdata/source/noninterface/target/context.cpp:715-730`. Each per-draw
manifest record stores the winning material stage, material index, serialized
field offset, node texture index, texture id/name/hash and decoded status.

Per-car classification:

| car | runtime | paint | light | other `_NO_ALBEDO` | paint families | light families | no-albedo families |
| --- | ---: | ---: | ---: | ---: | --- | --- | --- |
| Audi R8 V10 | 37 | 9 | 9 | 19 | paint 9 | light 9 | alloy 4, default 4, glass 11 |
| Corvette ZR1 | 50 | 10 | 17 | 23 | paint 10 | light 17 | alloy 4, default 11, glass 8 |
| Dodge Challenger | 62 | 11 | 13 | 38 | paint 11 | light 13 | alloy 4, default 25, glass 9 |
| Ford Focus RS | 78 | 15 | 13 | 50 | paint 15 | light 13 | alloy 4, default 42, glass 4 |
| Lotus Exige Cup260 | 40 | 0 | 14 | 26 | — | light 14 | alloy 5, default 15, glass 6 |
| **total** | **267** | **45** | **66** | **156** | | | |

### 9.2 Paint draws — auxiliary textures resolved, lookup not

Every one of the 45 paint draws resolves two static fields: `g_DentTexture` →
shared `paintdent` and `g_ScratchTexture` → the car's paint-scratch image. Ford
draw 0 additionally has `g_BumpTexture` → block 1 / 0 `bump`. These are the
material's dent/scratch/bump inputs, **not paint colour**, and the manifests label
them `paint-dent-texture`, `paint-scratch-texture` and `paint-bump-texture`.

The paint lookup itself is genuinely runtime:

- `g_sPaintMaterialTexture` is a shared `texture` in `vehicle_common.h:508`,
  sampled as `tex2Dlod(PaintTextureSampler, (NdotV,0))` at line 1250.
- It is exposed as `MATERIAL_ELEMENT_TYPE_TEXTURE_PTR` in
  `VehicleModelManager.cpp:372`, supplied from the runtime paint job in
  `VehicleModel.cpp:1759` / `customisation/PaintEditor.cpp`, not serialized in the
  model.
- A scan of every constant material row of all five cars found **no**
  `g_sPaintMaterialTexture` field; the only paint-family texture fields are
  dent/scratch/bump. The paint base material is list index 1, a dynamic recipe
  rebuilt by `C_Model` at runtime. The parsed dynamic material lists (7 types and
  48-67 rows per car) contain no type-7 `TEXTURE_INDEX` field and no paint-named
  parameter either, so there is no static paint palette to decode.

Per-draw record:
`"paintLookup": {"field":"g_sPaintMaterialTexture","resolution":"unsupported",
"resolved":false,"presentInSerializedMaterial":false,
"paintColourRecovered":false,"paintTextureRecovered":false,"reason":...}`.
The committed reader text is *“Vehicle `_NO_ALBEDO` paint uses a runtime paint
lookup texture.”* No paint palette exists in the model, so none is decoded and no
colour is invented.

### 9.3 Light draws — masks resolved, blend not

All 66 light draws resolve four static fields — `g_sOffTexture`,
`g_sOnTexture`, `g_sOffTextureDamage`, `g_sOnTextureDamage` — and in every car all
four point at the same light atlas node texture (for example ZR1 block 9 / 0
`corvette_zr1_lights`). The committed source samples off with `UV0.xy` and on with
`UV0.zw`, then blends with runtime `g_vRenderColour.w`
(`vehicle_common.h:1212-1214`); `g_vRenderColour` is exposed as a runtime F32
parameter (`VehicleModelManager.cpp:411,418,427,477`). The masks are therefore
static images; the blend state is not.

Per-draw record:
`"lightBlend": {"field":"g_vRenderColour.w","resolution":"unsupported",
"resolved":false,"blendWeightRecovered":false,
"staticMaskTextureIds":[...],"uvInputs":["UV0.xy","UV0.zw"],"reason":...}`.
The committed reader text is *“Vehicle light Off/On blend depends on runtime
colour and UV0.xy/zw.”* No blended image is produced.

### 9.4 The other 156 `_NO_ALBEDO` draws

50 of the 156 have at least one static reference: 48 `g_ScratchTexture`
(`smashedglass` or a car scratch image), 19 `g_DentTexture` (shared
`smashedglass_nrm`) and 2 `g_BumpTexture` (`audir8_1`, `focusrs-text01`). A draw
can have both dent and scratch, so the field counts exceed the draw count. The
remaining 106 have no serialized `TEXTURE_INDEX` field at all (alloy/rim and
plain default draws); they stay texture-less by evidence, not by guess.

### 9.5 Per-car coverage

`static + runtime = draws`; `paint + light + other = runtime`. “with refs” counts
runtime draws with at least one resolved static `TEXTURE_INDEX`; “no-albedo
with/without” splits the 156. Resolved/unsupported is stated separately because a
static mask does not make the paint or light parameter static.

| car | draws | static albedo | runtime | paint | light | other `_NO_ALBEDO` | with refs | without refs | no-albedo with | no-albedo without | textures | decoded | undecoded | RGBA bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Audi R8 V10 | 84 | 47 | 37 | 9 | 9 | 19 | 30 | 7 | 12 | 7 | 6 | 5 | 1 | 5,242,880 |
| Corvette ZR1 | 100 | 50 | 50 | 10 | 17 | 23 | 35 | 15 | 8 | 15 | 5 | 4 | 1 | 4,194,304 |
| Dodge Challenger | 104 | 42 | 62 | 11 | 13 | 38 | 33 | 29 | 9 | 29 | 6 | 5 | 1 | 4,194,368 |
| Ford Focus RS | 115 | 37 | 78 | 15 | 13 | 50 | 34 | 44 | 6 | 44 | 8 | 7 | 1 | 5,570,560 |
| Lotus Exige Cup260 | 88 | 48 | 40 | 0 | 14 | 26 | 29 | 11 | 15 | 11 | 4 | 3 | 1 | 3,145,728 |
| **total** | **491** | **224** | **267** | **45** | **66** | **156** | **161** | **106** | **50** | **106** | **29** | **24** | **5** | **22,347,840** |

Direct answer to the static/runtime question:

| class | draws | resolved from static data | truly runtime |
| --- | ---: | --- | --- |
| paint | 45 | 45 auxiliary dent/scratch/bump textures | 45 paint lookups (`g_sPaintMaterialTexture`), 0 recovered |
| light | 66 | 66 light off/on/damage masks | 66 blend weights (`g_vRenderColour.w`), 0 recovered |
| other `_NO_ALBEDO` | 156 | 50 draws with static auxiliary textures | 106 draws with no static texture field |

### 9.6 Decoded textures

`hash` is the serialized `u32` texture hash from the committed reader. `role`
comes from the material parameter that references the image; it is a reference
label, not a claim about pixel semantics. Same name/hash does not imply same
pixels: Audi has two `audir8_1` records (block 2 / 0 used as a bump input and
block 8 / 0 used as the light atlas) with different decoded RGBA.

**Audi R8 V10 (`audi-r8v10-stock`)**

| texture | source | hash | roles | selected LOD | size | RGBA SHA-256 |
| --- | --- | ---: | --- | ---: | --- | --- |
| `audir8_1` | block 2 / 0 | 2513717467 | bump | 9 | 512×512 | `2373459fa552f05d1cd1557157616072ed09d693dc31b9a0e10c2fe3c31e811d` |
| `audir8_scratch` | block 6 / 0 | 1893762288 | paint scratch | 6 | 512×512 | `66475d668bd59c06b1ccc835af1ccd1f5a19da416253a3ce2d5686b8dcd75db7` |
| `smashedglass` | block 7 / 0 | 4227605626 | glass scratch | 9 | 512×512 | `02290446124e9a05d3f2dd38203d0616c699d4f1e8499682affa87915eb6c75e` |
| `audir8_1` | block 8 / 0 | 2513717467 | light off/on/damage | 6 | 512×512 | `3575f11d152b04b376689ac69b932271456e8e265dc368bd24a199daf840d189` |
| `paintdent` | shared 0 | 572709367 | paint dent | 0 | 512×512 | `6be75ff4212f1c6fd7089ee834b0e912870aec0a014de0961b139e181dfab59c` |
| `smashedglass_nrm` | shared 6 | 959484646 | glass dent normal | — | 1024×1024 | undecoded (decoder bound) |

**Corvette ZR1 (`corvette-zr1-stock`)**

| texture | source | hash | roles | selected LOD | size | RGBA SHA-256 |
| --- | --- | ---: | --- | ---: | --- | --- |
| `smashedglass` | block 5 / 0 | 4227605626 | glass scratch | 7 | 512×512 | `02290446124e9a05d3f2dd38203d0616c699d4f1e8499682affa87915eb6c75e` |
| `corvette_zr1_scratch` | block 7 / 0 | 1545607592 | paint scratch | 6 | 512×512 | `e7bc94c07c327635882159700a8233c36b5306c70c4544892dd17aba38758ea4` |
| `corvette_zr1_lights` | block 9 / 0 | 1709224491 | light off/on/damage | 9 | 512×512 | `7b94de1063042841ab739dcf19893f4543cdcecc4f06cc10a92c401cb2dd2629` |
| `paintdent` | shared 0 | 572709367 | paint dent | 0 | 512×512 | `6be75ff4212f1c6fd7089ee834b0e912870aec0a014de0961b139e181dfab59c` |
| `smashedglass_nrm` | shared 1 | 959484646 | glass dent normal | — | 1024×1024 | undecoded (decoder bound) |

**Dodge Challenger (`dodge-challenger-stock`)**

| texture | source | hash | roles | selected LOD | size | RGBA SHA-256 |
| --- | --- | ---: | --- | ---: | --- | --- |
| `DefaultColour` | block 2 / 0 | 4294967295 | glass scratch | 0 | 4×4 | `8667e718294e9e0df1d30600ba3eeb201f764aad2dad72748643e4a285e1d1f7` |
| `smashedglass` | block 5 / 0 | 4227605626 | glass scratch | 7 | 512×512 | `02290446124e9a05d3f2dd38203d0616c699d4f1e8499682affa87915eb6c75e` |
| `dodge_scratch` | block 6 / 0 | 1185410477 | paint scratch | 6 | 512×512 | `7c69cb9da081470c72b76e6c561d422da7268c4ad373dce698bf2823f3a57222` |
| `dodge_lights` | block 9 / 0 | 4288409057 | light off/on/damage | 8 | 512×512 | `34ac86e89e71eaa830e31dd0417a6e18d8077b39b7664f22bc0f0b9d129758ae` |
| `paintdent` | shared 0 | 572709367 | paint dent | 0 | 512×512 | `6be75ff4212f1c6fd7089ee834b0e912870aec0a014de0961b139e181dfab59c` |
| `smashedglass_nrm` | shared 1 | 959484646 | glass dent normal | — | 1024×1024 | undecoded (decoder bound) |

**Ford Focus RS (`ford-focusrs-stock`)**

| texture | source | hash | roles | selected LOD | size | RGBA SHA-256 |
| --- | --- | ---: | --- | ---: | --- | --- |
| `bump` | block 1 / 0 | 491315504 | paint bump | 9 | 256×256 | `3db10ba5a045fbe8590c58beb1653c21461b93c353c449fe1078578c1f6fb07d` |
| `focusrs-text01` | block 2 / 0 | 1162449062 | bump | 8 | 512×512 | `4e960038bbe77691688cc7ba21a708ad1ff2baf54f4f4b1b27e812b15fc99a26` |
| *(empty name)* | block 4 / 0 | 1935282598 | paint scratch | 6 | 128×128 | `963cb81674ff0fe5d9a51df3d284fb6889b85612ac58e2c861cd0f8ab73b6e72` |
| `smashedglass` | block 6 / 0 | 4227605626 | glass scratch | 8 | 512×512 | `02290446124e9a05d3f2dd38203d0616c699d4f1e8499682affa87915eb6c75e` |
| `focusrs_scratch` | block 7 / 0 | 2464477189 | paint/ordinary scratch | 6 | 512×512 | `34d7919e307112be5a88b6e5d171b8f070caa8198a0581855422161c6f771b81` |
| `focusrs-text02` | block 8 / 0 | 3479685 | light off/on/damage | 8 | 512×512 | `e3cc5b6f66739f4785f2f2a25ec09f765c4052b51d1341b18291d4a878a31cb5` |
| `paintdent` | shared 0 | 572709367 | paint dent | 0 | 512×512 | `6be75ff4212f1c6fd7089ee834b0e912870aec0a014de0961b139e181dfab59c` |
| `smashedglass_nrm` | shared 5 | 959484646 | glass dent normal | — | 1024×1024 | undecoded (decoder bound) |

The block 4 / 0 texture has an **empty serialized name** and is kept as
`block:4:0:unnamed` with `nameEmpty:true`; its hash and bytes are the evidence.
It is referenced by five Ford paint draws, so it is not dropped.

**Lotus Exige Cup260 (`lotus-exige-cup260-stock`)**

| texture | source | hash | roles | selected LOD | size | RGBA SHA-256 |
| --- | --- | ---: | --- | ---: | --- | --- |
| `smashedglass` | block 4 / 0 | 4227605626 | glass scratch | 8 | 512×512 | `02290446124e9a05d3f2dd38203d0616c699d4f1e8499682affa87915eb6c75e` |
| `lotus_260_lights` | block 7 / 0 | 1902064106 | light off/on/damage | 9 | 512×512 | `092318cd2ffd8acca26c1657207fa5c846ed09e178cccb3cf441f87edf42fdc5` |
| `lotus_260_scratch` | block 8 / 0 | 1636170828 | scratch | 8 | 512×512 | `9f37dd5dedc82063b13ec5aff1f1ae4a0daa42dec6853a478adadd7a9d13eda8` |
| `smashedglass_nrm` | shared 1 | 959484646 | glass dent normal | — | 1024×1024 | undecoded (decoder bound) |

`DefaultColour` is a 4×4 DXT1 image with serialized hash `0xFFFFFFFF`; it is
reported as found, not interpreted as a sentinel or a colour.

### 9.7 Undecoded source images

The only undecoded static reference is shared `smashedglass_nrm` (hash
959484646), mip0 **1024×1024 DXT1/BC1**, one occurrence per car. It is a shared
texture with a single embedded descriptor, so no lower source LOD exists to fall
back to. Under the committed decoder bound of 512×512 (`FORMAT-texture.md`) it is
recorded with `undecodedReason`; it is not downscaled, re-labelled or replaced by
the block `smashedglass` image. Every draw that references it also references a
decodable `g_ScratchTexture`, so those draws still have a decoded static image.

### 9.8 Verification and determinism

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py probes/car-materials/tools/build_runtime_textures.py
& $py probes/car-materials/tools/verify_runtime_textures.py
& $py tools/verify_asset_probe.py --skip-build
```

| check | result |
| --- | --- |
| runtime split | 45 paint + 66 light + 156 other `_NO_ALBEDO` = 267; per-car counts equal the roster |
| static-reference coverage | 161 with refs (45 paint + 66 light + 50 no-albedo), 106 without |
| paint guard | 45/45 `paintLookup.resolved:false`, `resolution:"unsupported"`, `presentInSerializedMaterial:false`, no paint colour |
| light guard | 66/66 `lightBlend.resolved:false`, `resolution:"unsupported"`, `blendWeightRecovered:false` |
| C++ identity | every shared/block texture name, hash, data offset/bytes, descriptor, payload span and complete mip bytes agrees with `scene_inspect.exe` / `--resources` |
| native re-decode | **24/24**, `firstMismatch:null`, 0 mismatches |
| independent Pillow | 22 exact; 2 BC3 light atlases (ZR1, Lotus) differ only in alpha by ≤1/255 (23,223 channels) |
| determinism | 2 fresh builds + final tree, **78 files** each, `treeEqual:true`, `finalEqual:true` |
| portable suite | `verify_asset_probe.py --skip-build` — **30/30 PASS** |

The P52 roster verifier was also re-run. Its 40 native re-decodes still report
0 mismatches and its two fresh builds are byte-identical (`treeEqual:true`), but
its `finalEqual` check now reports a difference in the recorded
`independentPillow.pillowVersion` (`12.3.0` in the P52 output vs `13.0.0` in this
environment). The decoded RGBA hashes are unchanged; the difference is the
recorded Pillow version string only, so the P52 pixel evidence still stands.
Re-running that gate rewrote `_work/car-materials/roster/verify.json` with the
current environment's result, so the §6 hash of that scratch file no longer
matches the re-run file; the roster manifests and textures themselves were not
modified.

`_work/car-materials/runtime/verify.json` — **PASS**, 0 failures,
`firstMismatch:null`, `treeEqual:true`, `finalEqual:true`.

### 9.9 Hashes

| artifact | bytes | SHA-256 |
| --- | ---: | --- |
| `_work/car-materials/runtime/index.json` | 26,605 | `c5f964065d0f5fc33981f550deba7b449ba483b81a2594a495afcdc2c98405db` |
| `_work/car-materials/runtime/verify.json` | 3,211 | `6d6372cc132ff340b5ba3d0f3c02960e2051afb0c5698dff38f28fa0d85d0a74` |
| `cars/audi-r8v10-stock/materials.json` | 167,475 | `c20f4567ad3fd2bc57d89088b0489457e17503ab29685d7d3f19de7f7da16360` |
| `cars/corvette-zr1-stock/materials.json` | 209,106 | `0b65fc3ea3b3c0c118131a4d0e3e1c2525800000cffed139b40c219661af6108` |
| `cars/dodge-challenger-stock/materials.json` | 210,464 | `442c6ea3096e3d67f48400ae70fa28034804da515819a924b01729a223f27226` |
| `cars/ford-focusrs-stock/materials.json` | 263,154 | `7d30c666e20a5ba2681ed9c5fc65caffada5e772d1e26a5747373e91307da80f` |
| `cars/lotus-exige-cup260-stock/materials.json` | 157,015 | `cf4ed68a03f187f74ad7cee4a13410edaff84eaa66bc87e34e7fd999951dfb0d` |

Per-texture raw-slice, `.rgba`, `.png` and native JSON hashes are in each
`materials.json` (`textures[].decoded`).

### 9.10 Limits

- **Data only.** No renderer, shader, sampler, paint-lookup or light-blend
  behaviour is executed or claimed; `materialsApplied`, `shaderExecuted`,
  `samplerApplied`, `paintLookupRecovered`, `lightBlendRecovered` and
  `rendererClaim` remain `false`.
- **Paint colour is not recovered.** No `g_sPaintMaterialTexture` field is
  serialized in these models; only dent/scratch/bump references are decoded.
  Those images must not be read as paint colour.
- **Light blend is not recovered.** Off/on/damage masks are decoded, but the
  active state and weight (`g_vRenderColour.w`) and the UV0.xy/zw blend are
  runtime.
- **Static refs do not upgrade a draw.** A paint or light draw with decoded
  auxiliary masks still has no static paint lookup or blend. The per-draw
  `staticReferenceResolved` flag means only that its serialized `TEXTURE_INDEX`
  fields were resolved.
- **Same name/hash is not content identity.** Each occurrence is decoded and
  hashed independently; Audi's two `audir8_1` records prove the point.
- **Decoder bound 512×512.** Shared `smashedglass_nrm` (1024×1024) is recorded
  undecoded; its exact descriptor and reason are preserved.
- **Only the first RenderList LOD0.** Later render lists, higher LODs, damage
  states, paint variants and runtime light states are not imported.
- **Scope boundary.** This stage scans the **267 runtime-only draws**. The 224
  static `g_MeshTexture` draws keep P52's albedo-only scope; their auxiliary
  bump/dent/scratch fields are not re-scanned here, so no claim is made about
  them.
