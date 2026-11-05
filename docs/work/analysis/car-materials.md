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
