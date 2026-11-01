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
  toplam **18 instance**, **8.688 vertex / 7.085 üçgen**. Browser'da
  **River · tüm desteklenen** preset'i var.
- P2 analizi: arşiv `instanceBounds` kayıtları draw başına değil **CullNode
  (yerleştirilmiş nesne) başına**; 57 instance 34 transform-sabit grubuna ve 34
  byte-identical kayda karşılık geliyor. Mevcut tek-draw kontrolü 38 instance'ı
  yanlış reddediyor. Stage A hedefi 36 instance, Stage B toplam 56; kanıt:
  `docs/work/analysis/level-instance-streams.md`.
- River geniş sahne parçası (17.782 vertex / 9.343 üçgen) ve Showroom
  (11.590 / 7.987) doğrudan çizimlerle görüntüleniyor. Browser'da
  **River · instance prova** ve **River · 14 instance** preset'leri var.
- Native x64 Amax Release derlemesi başarılı. Particle-cache kök nedeni ve üç
  düzeltme denemesi belgelendi: kuyruk girişinde salt artışı 1/3 exit0 + 2/3
  `0xC0000005`; drenajı senkron `Free`'ye taşımak 3/3 `0xC0000005`;
  `DeleteTrailBlock` temizliği 1/3 orijinal breakpoint + 2/3 `0xC0000005`.
  Üçü de geri alındı; kanonik `Amax.exe` değişmedi. Gözlenen çift-free
  `FreeParticle`/`Emitter::Update` yolundan geliyor; trail sahipliği açık.
  Aday 2 (object-level trail-owned bayrağı) kaynak analizinde reddedildi:
  trail tanımları `bRepeating=true` olduğu için self-free yolları hiç
  ateşlenmiyor; 2a no-op, 2b sızıntı. Sıradaki yön slot-level temizlik.
- Doğrulama: `verify_asset_probe.py --skip-build` **27/27**, CTest **14/14**.

## Sıradaki iş

**T-003 kalan iş:** Stage A/B bounds grouping (36, sonra 56 instance), blok31
prerequisite, level materyalleri, görünürlük, sonraki RenderList'ler ve yüksek
LOD'lar. Kart: `docs/work/tasks/T-003-scene-traversal.md`.

**T-005 tek oyunculu dikey dilim** alt görevlere bölündü:
`T-005a` motor/WASM/platform fizibilitesi, `T-005b` streaming, `T-005c`
scheduler, `T-005d` fizik, `T-005e` kontroller/kamera, `T-005f` ses/UI/save,
`T-005g` tam yarış kabulü. Kart:
`docs/work/tasks/T-005-single-player-vertical-slice.md`.

**T-005a tamam:** vendored zlib wasm32'de linkleniyor/çalışıyor (58.598 B
@ `-O2`); motor `core/Maths.h` (7 hata), `tl_*` platform kimliği ve Windows PCH
kapılarında bloke. Ayrıntı: `docs/work/analysis/engine-wasm-probe.md`.

**T-005c tasarımı:** tek iş parçacıklı kooperatif wasm scheduler; mevcut
`Scheduler::` API'si + `jobqueue_web.cpp`; `Flush` self-drain, blocking
`MT::` wait'ler assert; policy flattening ve audio `Flush(group,false)` sapması
gerekli. Ayrıntı: `docs/work/analysis/t005-scheduler-design.md`.

## Bilinen engeller / riskler

- 18 instance destekli; P2'ye göre bounds grouping düzeltilince Stage A 36,
  Stage B 56 instance'a çıkmalı. Blok31 prerequisite; CPU vertex expansion var.
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
