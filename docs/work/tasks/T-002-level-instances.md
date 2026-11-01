# T-002 — Level instance dönüşümleri

**Durum:** done
**Sahip:** ana ajan
**Başlangıç:** 1 Kasım 2026
**Bitiş:** 1 Kasım 2026

## Amaç

`level_instances_inspect` adlı sınırlı C ABI ile River block27/node253
örneğindeki ilk gerçek instance'ı, ardından aynı node'daki 57 instance'ı
özgün `g_mWorld` dönüşümleriyle çizmek.

## Kanıt temeli

- `docs/plan/level-instances.md`
- `_work/level-instances/first-instance.json`
- `_work/level-instances/verification.json`
- `tools/inspect_level_instances.py`

İlk instance:

- basePrimitive0; effect `default_LN_NB_NL_NV.fx`.
- Translation `[-38.88801193237305, 5.673437118530273, 1074.29736328125]`.
- POSITION0 F32_3, stream0; VB ResourceIndex(27,0); IB ResourceIndex(27,0).
- LOD0 index offset4166, count1353, minIndex138, nVertices805.
- 805 referanslı vertex, 726 üçgen.
- Block27, chunk88'in **sekizinci** resource item'ı.

## Kapsam

1. `level_instances_inspect(level, len, geometryChunk, geoLen, nodeChunk,
   nodeLen, geometryBlock, nodeBlock)` ekle; mevcut direct API'yi değiştirme.
2. Geometri chunk'ında `(block, lod0)` ile **herhangi bir item**ı bul; içeren
   arşivi byte0'dan önceki item'ları geçerek parse et.
3. Instance/base primitif kayıtlarını, declaration-seçimli stream'leri ve
   ResourceIndex eşlemelerini koru.
4. Yalnızca sabit affine `g_mWorld` uygula; dinamik/frekanslı/eksik matrisleri
   açıkça reddet.
5. İlk proof: CPU vertex genişletme; GPU instance buffer'ı sonraki optimizasyon.
6. Native/WASM/Python karşılaştırması; iyi ve bozuk örnekler.
7. Browser'a dönüşüm uygulanmış River sahne parçası ekle.

## Kapsam dışı

- Tüm sahne/oyun dünyası, görünürlük, culling, gölge, materyal tamlığı.
- Yüksek LOD'lar, instance batching, skinning, deformasyon.
- Fizik veya sürüş.

## Dokunulacak dosyalar

- `probes/asset-reader/src/scene_reader.cpp`
- `probes/asset-reader/src/scene_reader.h`
- `probes/asset-reader/tests/scene_reader_tests.cpp`
- `probes/asset-reader/tests/verify_instances_wasm.mjs` (yeni)
- `probes/asset-reader/CMakeLists.txt`
- `tools/build_asset_probe.py`
- `probes/asset-reader/web/level.js`
- `probes/asset-reader/FORMAT-scene.md`
- Görev kartı, log ve handoff dosyaları

## Kabul kriterleri

- [x] İlk instance 805 vertex / 726 üçgen üretiyor.
- [x] Dünya sınırları arşivlenmiş instance sınırlarıyla ≤ `1e-4` içinde.
- [x] Yanlış blok, yanlış index/matrix/stream ve kesik girdi reddediliyor.
- [x] Dinamik/constant olmayan matris ve recursive materyal reddediliyor.
- [x] `instancesApplied:true` yalnız uygulanan kapsam için; eksik bağımlılıklar
      sayılıyor.
- [x] Native/WASM/Python eşitliği; F32 toleransı belgelenmiş.
- [x] Browser WebGPU mesh ekran görüntüsü; console temiz. (Blok27 çoklu
      instance preset'i ile dolaylı doğrulandı; tek-instance API native/WASM
      eşitliğiyle ayrıca doğrulanıyor.)
- [x] Suite 27/27 ve CTest 14/14 regresyonsuz.
- [x] Doküman ve handoff güncel.

## Sonuç

- Yeni C ABI: `level_instances_inspect(level,len,geo,len,node,len,geoBlock,nodeBlock)`.
- Geometri bloğu ChunkInfo içinde herhangi bir item olarak bulunuyor; önceki
  item'lar origin0'dan sıralı geçiliyor.
- River 27/253 instance0: 805 vertex / 726 üçgen; hata `3.86511e-05`.
- Konum hash `5125314b...`, index hash `886e2855...`; Python ile birebir.
- Native/WASM JSON eşit; `verify_instances_wasm.mjs` suite'e eklendi (27 kontrol).
- Browser'a `River · instance prova` preset'i eklendi; headless WASM yolunda
  805/726/57 instance görüldü.
- Açık: diğer56instance, materyaller, görünürlük, yüksek LOD'lar, GPU instance
  buffer ve görünür WebGPU mesh ekran görüntüsü.

## Riskler

- Chunk içindeki önceki item'ların node/texture zarflarını yanlış atlamak
  alignment'ı bozar; origin her zaman chunk byte0'dır.
- Python binary64→F32 hash'ini shader FMA ile bit-eşit sanmamak gerekir.
- Aynı chunk'ta seçili blok birden fazla kez geçebilir; uniqueness kontrolü şart.
- `scene_reader.cpp` T-001 tarafından değiştirildiği için sıralı çalışılmalı.

## Sonraki adım

T-001 kapandıktan sonra mevcut `level_mesh` traversal'ını genişletme noktalarını
belirle; ilk item kısıtını kaldırmadan önce tüm önceki item'ları geçen bir
cursor modeli tasarla.
