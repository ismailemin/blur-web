# CURRENT — buradan devam

**Güncelleme:** 1 Kasım 2026
**Aşama:** Aşama 4 sonu (gerçek asset/önizleme), Aşama 5 (tek oyunculu yarış) başlamadı.
**Baseline commit:** `04276aa chore: baseline project docs, probes, and tools`

## Şu an neredeyiz?

- Portatif okuyucular (PAK, model, Scene, level, texture, XT) native x64 ve
  wasm32 olarak çalışıyor.
- Corvette gövdesi WebGPU'da çiziliyor: 30.591 vertex, 36.193 üçgen, 80 draw.
  **26 statik çizim özgün dokuyla bağlı:** 14 shared albedo + 12 resource-block
  LOD0 (`corvetterace_dials`, `corvetterace_interior`).
- `scene_resource_textures_inspect` yedi resource bloğunu Scene sınırına kadar
  okuyup descriptor/payload aralıklarını döndürüyor. Yüksek LOD'lar metadata
  olarak var; tam zincir olmayan payload'lar decoder'a verilmiyor.
- River geniş sahne parçası (17.782 vertex / 9.343 üçgen) ve Showroom
  (11.590 / 7.987) doğrudan çizimlerle görüntüleniyor. Instance dönüşümleri
  henüz uygulanmıyor.
- Native x64 Amax Release derlemesi başarılı. Sabit Brighton yarışı açılıyor.
  Particle-cache çökmesinin ilk dump analizi aynı emitter'ın ikinci kez serbest
  bırakıldığını gösterdi; tam bellek izi ve nedensellik açık.
- Doğrulama: `verify_asset_probe.py --skip-build` **26/26**, CTest **13/13**.

## Sıradaki iş

**T-002 — level instance dönüşümleri.** `level_instances_inspect` ile önce
block27/node253 instance0 (805 vertex/726 üçgen), sonra node253'teki 57
instance. Ayrıntı: `docs/work/tasks/T-002-level-instances.md`.

T-001'in browser/WebGPU ekran görüntüsü henüz alınmadı; kod ve Node/WASM
bağlama testi geçti. Bu doğrulama T-002 öncesi veya sırasında tamamlanmalı.

## Bilinen engeller / riskler

- `scene_reader.cpp` T-002 tarafından değiştirilecek; T-001 kapandı, sıra T-002'de.
- Level önizlemelerindeki ilk RenderList'lerde instance yok; geniş kapsam için
  ek resource/node blokları gerekiyor.
- Native sürüş referansı particle-cache çökmesi nedeniyle kararlı değil.
- Fizik, kontroller, ses, save/streaming, tek oyunculu yarış ve multiplayer
  başlamadı.
- Oyun verisi ve `_work/` Git dışında; kanıtlar yeniden üretim komutuyla birlikte
  dokümanda tutulmalı.

## Okuma sırası

1. `PLAN.md`
2. Bu dosya
3. `docs/handoff/NEXT.md`
4. `probes/asset-reader/README.md`
5. `docs/setup/native-source-build.md`
6. İlgili görev kartı ve `docs/work/README.md`
