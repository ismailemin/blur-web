# CURRENT — buradan devam

**Güncelleme:** 2 Kasım 2026
**Aşama:** Aşama 4 sonu (gerçek asset/önizleme), Aşama 5 (tek oyunculu yarış) başlamadı.
**Baseline commit:** `04276aa chore: baseline project docs, probes, and tools`
**Son commit'ler:** T-001 `19abead`/`b4e8cbe`, T-002 `2bc7253`/`1b8cb76`; T-003 ilk artım commit bekliyor.

## Şu an neredeyiz?

- Portatif okuyucular (PAK, model, Scene, level, texture, XT) native x64 ve
  wasm32 olarak çalışıyor.
- Corvette gövdesi WebGPU'da çiziliyor: 30.591 vertex, 36.193 üçgen, 80 draw.
  **26 statik çizim özgün dokuyla bağlı:** 14 shared albedo + 12 resource-block
  LOD0 (`corvetterace_dials`, `corvetterace_interior`).
- `scene_resource_textures_inspect` yedi resource bloğunu Scene sınırına kadar
  okuyup descriptor/payload aralıklarını döndürüyor.
- `level_instances_inspect` River block27/node253 instance0:
  **805 vertex / 726 üçgen**, arşiv sınır farkı **3.86511e-05**.
- `level_instances_all_inspect` aynı blokta **14 instance** çiziyor:
  **7.308 vertex / 6.106 üçgen**, 14 draw, en büyük sınır farkı
  **6.02444e-05**. 8 instance sınır uyuşmazlığı, 35 instance başka blok.
- Çoklu blok taraması: `requiredGeometryBlocks=[15,17,26,27,31,32]`; blok27+15
  toplam **18 instance**, **8.688 vertex / 7.085 üçgen**. Blok17/26/32 stream
  semantiği, blok31 prerequisite nedeniyle 0/atlandı. Browser'da
  **River · tüm desteklenen** preset'i var.
- River geniş sahne parçası (17.782 vertex / 9.343 üçgen) ve Showroom
  (11.590 / 7.987) doğrudan çizimlerle görüntüleniyor. Browser'da
  **River · instance prova** ve **River · 14 instance** preset'leri var.
- Native x64 Amax Release derlemesi başarılı. Tam bellek exit dump'ı alındı:
  `m_ActiveElements=93`, `m_VectorPosition=-1`; silinen eleman aynı zamanda
  `m_Cache[162]` içinde — çift serbest bırakma doğrudan kanıtlandı. Hangi iki
  `Free`/`AtomicFree` çağrısının çakıştığı, efekt kimliği ve thread çakışması
  açık.
- Doğrulama: `verify_asset_probe.py --skip-build` **27/27**, CTest **14/14**.

## Sıradaki iş

**T-003 kalan iş:** base primitive11–35 ek stream/deformasyon semantiği
(blok17/26/32'deki 22 instance + blok15'teki 8 instance), blok31 prerequisite,
level materyalleri, görünürlük, sonraki RenderList'ler ve yüksek LOD'lar. Kart:
`docs/work/tasks/T-003-scene-traversal.md`.

## Bilinen engeller / riskler

- 18 instance destekli; 22 instance base17/26/32 stream semantiği, 8 instance
  base7–10, 1 instance blok31 prerequisite nedeniyle çizilmiyor.
- CPU vertex expansion; GPU instance buffer yok.
- Native sürüş referansı particle-cache çökmesi nedeniyle kararlı değil.
- Fizik, kontroller, ses, save/streaming, tek oyunculu yarış ve multiplayer
  başlamadı.
- Browser görsel doğrulaması: T-001 Corvette **26/80 albedo** ve T-003
  **14 instance / 7.308 vertex / 6.106 üçgen** kullanıcı ekran görüntüleriyle
  doğrulandı. Kalan: diğer geometri blokları, base7–10 stream semantiği, level
  materyalleri/görünürlük/yüksek LOD'lar.
- Oyun verisi ve `_work/` Git dışında; kanıtlar yeniden üretim komutuyla birlikte
  dokümanda tutulmalı.

## Okuma sırası

1. `PLAN.md`
2. Bu dosya
3. `docs/handoff/NEXT.md`
4. `probes/asset-reader/README.md`
5. `docs/setup/native-source-build.md`
6. İlgili görev kartı ve `docs/work/README.md`
