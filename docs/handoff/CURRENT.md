# CURRENT — buradan devam

**Güncelleme:** 1 Kasım 2026
**Aşama:** Aşama 4 sonu (gerçek asset/önizleme), Aşama 5 (tek oyunculu yarış) başlamadı.
**Baseline commit:** `04276aa chore: baseline project docs, probes, and tools`
**Son commit'ler:** `19abead` T-001 kodu, `b4e8cbe` onboarding/T-001 kayıtları, T-002 commit'i bekliyor.

## Şu an neredeyiz?

- Portatif okuyucular (PAK, model, Scene, level, texture, XT) native x64 ve
  wasm32 olarak çalışıyor.
- Corvette gövdesi WebGPU'da çiziliyor: 30.591 vertex, 36.193 üçgen, 80 draw.
  **26 statik çizim özgün dokuyla bağlı:** 14 shared albedo + 12 resource-block
  LOD0 (`corvetterace_dials`, `corvetterace_interior`).
- `scene_resource_textures_inspect` yedi resource bloğunu Scene sınırına kadar
  okuyup descriptor/payload aralıklarını döndürüyor.
- `level_instances_inspect` eklendi. River block27/node253 instance0:
  **805 vertex / 726 üçgen**, arşivlenmiş sınır farkı **3.86511e-05**.
  Native/WASM/Python F32 konum ve U32 index hash'leri birebir.
- River geniş sahne parçası (17.782 vertex / 9.343 üçgen) ve Showroom
  (11.590 / 7.987) doğrudan çizimlerle görüntüleniyor. Browser'da
  **River · instance prova** preset'i instance0'ı dönüşümüyle açar.
- Native x64 Amax Release derlemesi başarılı. Particle-cache çökmesinin ilk dump
  analizi aynı emitter'ın ikinci kez serbest bırakıldığını gösterdi; tam bellek
  izi ve nedensellik açık.
- Doğrulama: `verify_asset_probe.py --skip-build` **27/27**, CTest **14/14**.

## Sıradaki iş

**T-003 — Scene/level kapsamını genişletme.** Kalan56instance, sonraki
RenderList'ler, level materyalleri, görünürlük ve yüksek LOD'lar; ardından
tutarlı bir pist parçası. Kart henüz açılmadı; `docs/handoff/NEXT.md` sırayı
tutuyor.

## Bilinen engeller / riskler

- Tek instance CPU-expanded; GPU instance buffer, diğer56instance ve level
  materyalleri yok.
- Native sürüş referansı particle-cache çökmesi nedeniyle kararlı değil.
- Fizik, kontroller, ses, save/streaming, tek oyunculu yarış ve multiplayer
  başlamadı.
- Browser WebGPU mesh ekran görüntüsü T-001/T-002 için alınmadı; WASM/veri yolu
  ve native/WASM eşitliği doğrulandı, görünür GPU çizimi ayrı adım.
- Oyun verisi ve `_work/` Git dışında; kanıtlar yeniden üretim komutuyla birlikte
  dokümanda tutulmalı.

## Okuma sırası

1. `PLAN.md`
2. Bu dosya
3. `docs/handoff/NEXT.md`
4. `probes/asset-reader/README.md`
5. `docs/setup/native-source-build.md`
6. İlgili görev kartı ve `docs/work/README.md`
