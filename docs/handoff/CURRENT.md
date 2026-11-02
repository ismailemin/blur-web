# CURRENT — buradan devam

**Güncelleme:** 2 Kasım 2026
**Aşama:** Aşama 4 sonu (gerçek asset/önizleme), Aşama 5 (tek oyunculu yarış) başlamadı.
**Baseline commit:** `04276aa chore: baseline project docs, probes, and tools`
**Son commit'ler:** T-003 Stage A `a217f33`, T-004 `6b5d31a`, T-005c `68a7b07`, T-005b `7588c6d`.

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
  **River · instance prova**, **River · 22 instance** ve
  **River · tüm desteklenen** preset'leri var.
- **T-004 çözüldü (x64 build):** P13 bayat yuvayı `(0,0,*)`, salt `0==0`,
  `epos=-1` olarak isimlendirdi ve trail slot adımının **8 bayt** olduğunu
  ölçtü. `C_Particle_E` x64'te 16 bayt; retail PC 32-bit olduğu için sabit 8
  orada doğruydu. `Manager.cpp:151 → SetElementSize(sizeof(C_Particle_E))`
  ile paired 3+3: baseline 3/3 çökme, düzeltme 3/3 exit 0 (23–24 s); ek koşu
  `Racing → AFTER_THROTTLE → quit`. Kanonik `Amax.exe` ve assert değişmedi.
  Kanıt: `docs/work/verification/T-004-slot-stride.md`. TEK-YUVA slot sözleşmesi
  web/wasm portu için açık kalıyor (wasm32'de sizeof zaten 8).
- Doğrulama: `verify_asset_probe.py --skip-build` **28/28**, CTest **14/14**.

## Sıradaki iş

**T-003 Stage A tamam:** gruplu AABB birleşimi; blok27 22, blok15 12, blok17 2
→ **36 instance / 22.924 vertex / 17.301 üçgen**. Suite 29/29, CTest 14/14;
headless Edge/WebGPU 22 ve 36 instance console temiz. **Kalan:** Stage B
(blok26/32 → 56 instance), blok31 prerequisite, materyaller, görünürlük, yüksek
LOD'lar. Kart: `docs/work/tasks/T-003-scene-traversal.md`; kanıt:
`docs/work/verification/T-003-stageA.md`.

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

**T-005c kod dilimi tamam:** `probes/scheduler-probe/` 21/21; native/wasm/
Python 0 fark; 144/30 Hz, hitch, tab gap, frame-rate bağımsızlığı geçti. Ana
suite `--skip-build` 28/28. Engine `Scheduler::` entegrasyonu yok. Kanıt:
`docs/work/verification/T-005c-scheduler.md`.

**T-005b tasarımı:** `Sys::I_FileSystem`/`I_File` + logicalfs/PAK C++'ta kalıyor;
altına `platform/file` C ABI ve OPFS/blob/http range-source registry. İlk dilim
`RangeFile` + PAK/level index parity; eksik aralık açık hata. Kurulum 7,48 GB/
5.113 dosya; River stream 244.682.752 B/359 chunk. Ayrıntı:
`docs/work/analysis/t005-streaming-design.md`.

**T-005d fizibilitesi:** Gravity + RacingPhysics ~70 kLOC; T-005a gate'lerinden
sonra her RacingPhysics simülasyon TU'su 18 hata, Gravity scheduler module
tiplerinde bloke. T-005c sert önkoşul. İlk dilim statik collision-query oracle
(`Level.levelphysics`, `queryHash` native/wasm). Ayrıntı:
`docs/work/analysis/t005-physics-feasibility.md`.

**T-006 analizi:** T-006a tamam: PC LAN auth'suz; keşif UDP 50001, oyun UDP
3074-3173; iki istemci aynı makinede çalışmaz (`SO_REUSEADDR` yok), iki fiziksel
makine gerekli. T-006b tamam: wire format struct ABI; `wchar_t` (MSVC 2/wasm32 4)
ve padding/bitfield en büyük risk; golden byte'lardan önce layout probe. T-006c
tamam: `bdSocketRouter`/`bdNet` altına WebRTC backend, reliable ordered +
unreliable DataChannel, WSS signaling/STUN/TURN; engine protokolü byte-identical.
T-006e/f gerçek yarış T-005g ve T-004 kapılarına bağlı. Kanıt:
`docs/work/analysis/t006-native-lan.md`, `t006-wire-format.md`,
`t006-transport.md`.

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
