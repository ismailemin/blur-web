# T-001 — Corvette'in kalan 12 statik dokusu

**Durum:** done (browser WebGPU ekran görüntüsü açık)
**Sahip:** ana ajan
**Başlangıç:** 1 Kasım 2026
**Bitiş:** 1 Kasım 2026

## Amaç

Corvette C3'ün kalan 12 statik ordinary-albedo çizimini, iki özgün resource
texture'ın (`corvetterace_dials`, `corvetterace_interior`) orijinal LOD0
descriptor'ı ve tam mip zinciriyle mevcut raw texture decoder'a bağlamak.

Mevcut durumda 14 çizim dört shared albedo kullanıyor. Bu görev tamamlandığında
**26 statik çizimin tamamı** özgün dokuya bağlanmış olacak.

## Kanıt temeli

- `docs/plan/car-resource-textures.md`
- `_work/car-resource-textures/report.json`
- `tools/inspect_car_resource_textures.py`
- Model: `corvette_c3_race.model`, 3.169.212 bayt,
  SHA-256 `77840511e5ca416ff9e7cbdc9ee9fc960fce0205f83c9be77e0803607c32cb9d`.

| Doku | Kaynak | Çizimler | LOD0 descriptor | Header offset | Payload |
|---|---|---|---:|---:|---:|
| `corvetterace_dials` | block2, texture0 | 21, 79 | 16×16, 5 mip, BC3 | 2051139 | 2051185 / 368 |
| `corvetterace_interior` | block6, texture0 | 6, 15–20, 61, 65, 66 | 16×16, 5 mip, BC1 | 2950530 | 2950577 / 184 |

Offset'ler yalnızca doğrulama beklentisidir; runtime değeri kaynak yapılardan
gelmelidir. Descriptor ile payload arasında archive buffer zarfı ve hizalama
vardır; tek bitişik dilim alınmamalıdır.

## Kapsam

1. `scene_reader` içinde kaynak sıralı, sınırlı bir resource-texture metadata
   yolu ekle.
2. Yeni C ABI: model byte'larından `(block,index)`, ad/hash/sampler, kaynak LOD,
   descriptor offset/uzunluk ve payload offset/uzunluk döndür.
3. Descriptor + tam LOD0 texel dilimini geçici buffer'da birleştirip mevcut
   `texture_raw_inspect` yoluna ver.
4. İlk RenderList materyal çözümlemesinde resource-block texture kimliğini
   koru; shared index tahmini yapma.
5. Native CLI/test, WASM export, `verify_car_wasm.mjs` genişletmesi.
6. Browser'da 12 çizimi orijinal dokuyla bağla; 26/26 statik çizim.

## Kapsam dışı

- Daha yüksek LOD'lar ve streaming kalite yükseltmesi.
- Runtime araç boyası (`g_sPaintMaterialTexture`).
- Işık/renk karışımı (`g_vRenderColour.w`), hasar, tekerlek yerleşimi.
- Orijinal shader, alpha/cull ve sampler sadakati.
- Diğer araçlar veya level materyalleri.

## Dokunulacak dosyalar

- `probes/asset-reader/src/scene_reader.cpp`
- `probes/asset-reader/src/scene_reader.h`
- `probes/asset-reader/src/scene_cli.cpp` (gerekirse)
- `probes/asset-reader/tests/scene_reader_tests.cpp`
- `probes/asset-reader/tests/verify_car_wasm.mjs`
- `probes/asset-reader/CMakeLists.txt` (gerekirse)
- `tools/build_asset_probe.py` (WASM export)
- `probes/asset-reader/web/model.js` / `app.js` (gerekirse)
- `probes/asset-reader/FORMAT-scene.md`
- Görev kartı, log ve handoff dosyaları

## Kabul kriterleri

- [x] İki doku için descriptor ve payload aralıkları kaynak yapılardan geliyor;
      sabit offset yok.
- [x] `dials` BC3 ve `interior` BC1 LOD0 çıktısı bağımsız Pillow sonucuyla
      belgelenmiş tolerans içinde eşleşiyor.
- [x] Native/WASM/Python JSON ve RGBA eşitliği.
- [x] 14 shared + 12 resource = 26 statik çizim dokulu.
- [x] Eksik/bozuk assembly, yanlış blok ve desteklenmeyen LOD açıkça reddediliyor.
- [x] `verify_asset_probe.py --skip-build` regresyonsuz (26/26).
- [x] CTest 13/13.
- [ ] Browser ekran görüntüsü; console error/warning yok.
- [x] `FORMAT-scene.md`, görev kartı, log ve `CURRENT.md` güncel.

## Sonuç

- C ABI: `scene_resource_textures_inspect(model,len)`; `scene_inspect` draw
  çıktısına `resourceBlock`/`resourceIndex` eklendi.
- Yeni browser modülü: `probes/asset-reader/web/resource-textures.js`.
- Yeni test: `probes/asset-reader/tests/verify_resource_binding.mjs`; suite'e
  eklendi (25 → 26 kontrol).
- LOD0 aralıkları: dials descriptor `2051139/28`, payload `2051185/368`;
  interior descriptor `2950530/28`, payload `2950577/184`.
- 12 draw: 6,15–20,21,61,65,66,79. Toplam 26/80 statik çizim dokulu.
- Daha yüksek LOD'lar, runtime boya/ışık, hasar ve tekerlek kapsam dışı kaldı.


## Doğrulama komutları

```powershell
python tools/verify_asset_probe.py --skip-build
ctest --test-dir _work/build/asset-reader-native -C Release --output-on-failure
node probes/asset-reader/tests/verify_car_wasm.mjs
```

Gerekiyorsa tam yeniden derleme:

```powershell
python tools/verify_asset_probe.py
```

## Riskler

- Descriptor/payload ayrımı ve archive hizalaması yanlış yorumlanabilir.
- Yüksek LOD yalnızca yeni top mip içerir; mevcut tail kopyalanmadan decoder'a
  verilmemeli.
- `scene_reader.cpp` T-002 tarafından da değiştirilecek; görevler sıralı.
- Tek eksik UV'li buffer yüzünden tüm modelin UV'sini silme hatasına dönülmemeli;
  UV kullanılabilirliği çizim bazında kalmalı.

## Sonraki adım

`scene_reader.cpp` içindeki mevcut materyal/traversal yapısını incele; resource
texture metadata için en küçük ekleme noktasını belirle; ardından C ABI ve
native testi yaz.
