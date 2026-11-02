# T-005 — Tek oyunculu dikey dilim

**Durum:** in-progress (T-005a/b/c/d tasarım tamam; uygulama sırada)
**Sahip:** ana ajan
**Başlangıç:** 2 Kasım 2026
**Bitiş:** —

## Amaç

Bir gerçek pist ve bir araçla, özgün fizik/kontroller üzerinden tam bir
tek oyunculu yarışı tarayıcıda bitirmek. Bu, asset önizlemesinden oyun motoruna
geçiştir; tek oturumda bitmez, aşağıdaki dilimlerle yürür.

## Alt görevler

### T-005a — Motor/WASM/platform fizibilitesi
- Windows'a bağlı katmanları envanterle: dosya sistemi, thread/scheduler,
  DX11/WebGPU, ses, input, UI, save.
- En küçük motor alt kümesini wasm32'ye derlemeyi dene; bellek, boyut ve
  bağımlılık ölç.
- Çıktı: derlenen/derlenmeyen modül listesi ve ilk port sınırı.

**Sonuç (2 Kasım):** `_work/wasm-engine-probe` içinde 48 gerçek TU denendi.
Vendored zlib (11 dosya) wasm32'de linkleniyor ve node'da çalışıyor
(58.598 B @ `-O2`); motorun geri kalanı `core/Maths.h` (7 hata), platform
kimliği (`tl_*`) ve Windows PCH (`winsock2.h`/`windows.h`) kapılarında bloke.
Ayrıntı/komutlar: `docs/work/analysis/engine-wasm-probe.md`. Motor çalışıyor
iddiası yok.

### T-005b — Dosya/streaming adaptörü
- Pak/level okumayı motorun sanal dosya sistemine bağla.
- Büyük veriyi tek bellek bloğuna kopyalamadan aralık okuma.
- Save ve ayarlar için ayrı kalıcı depolama.

**Tasarım sonucu (2 Kasım):** `Sys::I_FileSystem`/`I_File`, logicalfs/PAK ve
`ChunkInfo` mantığı C++'ta kalıyor; altına dar bir `platform/file` C ABI
(`pf_open/size/read_at/write_at/close` + async `pf_enqueue_read`) ve JS
`opfs:`/`blob:`/`http:` range-source registry ekleniyor. Senkron okuma yalnız
OPFS `FileSystemSyncAccessHandle` veya hazır blok için; eksik aralık açık hata,
sıfır-doldurma yok. İlk dilim motor header'ı olmadan `RangeFile` +
`pak_index_range`/`level_index_range`; 7 PAK ve 19 level index native/wasm
parity + bir gerçek chunk hash'i. Ölçüm: kurulum 7,48 GB/5.113 dosya; River
stream 244.682.752 B, 359 chunk (max 2.045.952 B, 222/359 prerequisite).
Ayrıntı: `docs/work/analysis/t005-streaming-design.md`.

### T-005c — Scheduler ve zaman adımı
- Windows thread/job queue yerine Web Worker/Atomics veya tek iş parçacığı
  politikası; sabit simülasyon adımı, render'dan bağımsız.
- Frame-rate bağımsız davranış kuralı korunur.

**Tasarım sonucu (2 Kasım):** İlk dilim için **tek iş parçacıklı kooperatif
wasm** önerildi; mevcut `Scheduler::` API'si korunuyor, `jobqueue_web.cpp`
backend'i ekleniyor. `Flush` kendi kuyruğunu boşaltıyor; `MT::Thread::Join`/
`Mutex::Wait`/`Event::Wait` beklemek yerine assert ediyor. `SchedulerConfig.cpp`
column-0 streamer policy'si tek context'te düşüyor; policy'lerin flatten
edilmesi gerekiyor. İki audio `Flush(group,false)` çağrısı için belgelenmiş
sapma (her zaman drain) gerekiyor. İlk kod dilimi `probes/scheduler-probe/` ve
1/60 sabit adım + 4 tick cap + interpolasyon; 144/30 Hz, hitch ve tab gap
testleri hash-eşit olmalı. Ayrıntı: `docs/work/analysis/t005-scheduler-design.md`.

**Kod dilimi sonucu (2 Kasım):** `probes/scheduler-probe/` 21/21 geçti:
native MSVC `/W4` 0 uyarı, wasm32 53.263 B, native/wasm/Python 0 fark.
144 Hz×600 = 249 tick; 30 Hz×300 = 600 tick; 250 ms hitch 15 istek → 4 çalıştı,
11 clamp; 5 s tab gap 1 pause. 5 s'de 600/150/100 frame → tek hash
`0x7e04f9a197e01d8a`. Ana suite `--skip-build` 28/28. Bulgu: cap sonrası
accumulator sıfırlama (`ApplicationPC.cpp:518-522`) tasarım §4.2'ye işlenmeli.
Kanıt: `docs/work/verification/T-005c-scheduler.md`. Engine entegrasyonu yok.

### T-005d — Fizik ve çarpışma
- Gravity/physics alt kümesini WASM'e taşı; native referansla ölç.
- T-004'teki particle-cache çökmesi sürüş referansını bloke ediyorsa önce
  güvenli bir no-input/stationary referans kullan.

**Tasarım sonucu (2 Kasım):** En küçük sadık alt küme Gravity 127 cpp/58.759
satır + RacingPhysics 11.436 satır (~70 kLOC). Araç yolu:
`C_Scene::Simulate` → `Car::Integrate` → `ArticulatedBody::Integrate` (1/60'te
4× Euler <2 m/s, üstünde 1× RK4) → teker başına Gravity statik üçgen-mesh ray
+ yay/lastik. T-005a gate'lerinden sonra her RacingPhysics simülasyon TU'su
**18 hata** (5 `HVec3→Float3`, 2 `__fsel`, 11 `tl_*`/`Mutex`); Gravity'nin
kalanı scheduler module tipleri. Bu yüzden **T-005c sert önkoşul**. İlk dilim D1:
`Level.levelphysics`'ten statik collision-query oracle; sabit probe tablosu,
`queryHash` native/wasm birebir. Car/XT/solver yok. Native sayısal referans
henüz yok; önce aynı probe'un native build'i. Ayrıntı:
`docs/work/analysis/t005-physics-feasibility.md`.

### T-005e — Kontroller ve kamera
- Klavye/gamepad; özgün araç girdi semantiği.
- Kamera, HUD ve yarış durumu.

### T-005f — Ses, UI, save
- Ses çıkışı, menü/HUD, save yükleme; tarayıcı kotası ve ilk yükleme ölçümü.

### T-005g — Yarış kabul testi
- Tek pist/tek araç, tam tur, çarpışma, güçlendirme, finish.
- Uzun oturum stabilitesi; performans ölçümü.

## Kabul kriterleri

- Bir gerçek pist ve araçla yarış başlatılıp bitirilebiliyor.
- Özgün fizik/kontrol davranışı native referansla karşılaştırılmış.
- Frame-rate bağımsız sabit adım.
- Ses ve HUD çalışıyor.
- Uzun oturumda çökme/veri bozulması yok.
- Multiplayer kapsam dışı; iki oyunculu aşama T-006.

## Riskler

- Tüm Amax kaynağının WASM kapanışı büyük; Windows API'leri ve DX11/FX11
  doğrudan taşınamaz.
- Thread/Atomics ve ses backend'i tarayıcı kısıtları.
- T-004 particle-cache hatası sürüş referansını kararsız kılıyor.
- Kapsam büyüdükçe asset doğruluğu ile oynanabilirlik arasında öncelik
  çatışabilir; her dilim ayrı kanıtla kapanmalı.

## İlk adım

T-005a: `cmake/blur_common.cmake`, platform katmanı ve DX11 hedeflerini okuyup
wasm32'ye derlenebilecek en küçük alt kümeyi belirle; tahminle değil, gerçek
derleme denemesiyle.
