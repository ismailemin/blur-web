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

**Engine dosya katmanı (2 Kasım, P16):** `engine/patches/t005b-file-overlay.patch`
(3 yeni dosya, 0 değişiklik) scheduler overlay'inin üstüne uygulanıyor.
`Sys::C_WebFile`/`C_WebFileSystem` + `pf_*` C ABI, `PLATFORM_WEB` altında.
`verify_file_overlay.py --fresh` **PASS**: 530.493 B wasm, 61 nesne, 50/50
kontrol; tam `C_PakFs` ve `C_OverlayFs` yolları (`OpenPak`/`Open`/`FileExists`/
`FileInfo`/`DirectoryInfo`) çalışıyor; 3.601 FAT kaydı referansla aynı; iki dosya
(209 B, 131.200 B) ve bir dizin (35 çocuk) doğrulandı; tam dosya FNV-1a 64
`2f291abb5648e078`; PC TU parity. Kalan: yazılabilir katman/`GameHelpers`,
OPFS/worker. Kanıt: `docs/work/verification/T-005b-engine-file-layer.md`.

**Engine streaming (4 Kasım, P18):** `StreamManager` wasm'da: 359/359 chunk,
244.682.752 B, 359/359 FNV bağımsız Python ile aynı; `levelrender` 9.873.988 B
ve `levelphysics` 1.945.409 B hash'leri de aynı; 37 nesne, 246.726 B wasm,
20/20 kontrol, PC parity. `Level.levelrender` Scene parse'ı DX11 `Display2`
bağımlılığı yüzünden bloklu (456 hata); chunk tablosu şimdilik probe'lardan.
Kanıt: `docs/work/verification/T-007-streaming.md`.

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

**Engine scheduler dilimi (2 Kasım, P14):** `PLATFORM_WEB`/`TL_PLAT_WEB` kimliği
kopya kaynakta 5 düzenleme + 2 tip başlığıyla eklendi. 39 ölçülen TU'dan 30'u
derleniyor; `jobqueue.cpp` ve `jobqueue_kernel.cpp` 11 → **0** hata, `Inflate` ve
`serialiser` de 0. `spike_sched.wasm` **59.140 B** ve node'da gerçek bir iş
çalıştırıyor: `ran=1`, `job_result=42`, `workers=0`, iki koşu bit-birebir.
`Atomic.h`'nin `PLATFORM_PC` zincirinde wasm dalı yoktu; 17 fonksiyon
`__atomic_*` ile dolduruldu. Kalan: policy flattening (`piStreamer` column 0),
5 POSIX kalıntısı, `_vsnprintf_s`, DX11/FX11. Ayrıntı:
`docs/work/analysis/engine-web-shims.md`. Oyun/motor iddiası yok.

**Overlay (2 Kasım, P14):** `engine/patches/t005c-web-scheduler.patch` (20 dosya,
+681/−35) + `engine/apply_overlay.py`/`verify_overlay.py`/`native_parity.py`.
Taze upstream kopyasına uygulanıp yeniden derlendi: wasm 60.797 B, A3 4/4,
3/3 abort, deterministik, **verdict PASS**. PC `jobqueue.cpp` önişlenmiş çıktısı
yalnız iki log satır numarası dışında aynı; 29/29 TU MSVC'de derleniyor.
İlk gerçek engine çağırıcısı `C_Deflate`/`C_Inflate` kuyruk üzerinden çalıştı
(`deferred=1`, `equal=1`). A2 grup bağımlılıkları kapandı: yalnız `Flush(A)`
sırası `A`, B kuyrukta; `Flush(B)` → `AB`; yalnız `Flush(D)` → `ABCD`
(bağımlılık kendi kendine çözülüyor). `JQ_GROUP_LABEL`/`JQ_GROUP_SPURWLOCK`
desteklenmiyor ve yüksek sesle abort ediyor (4/4). Patch `B939B39C…FDEF2`.

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

**D1 kod dilimi (2 Kasım, P15):** `Level.levelphysics` formatı kanıtlandı
(`Physic` blokları, Gravity import v10, `OptimisedAABBTree`, yaprak sıralı üçgen
akışı, `S16<14>`, U8 indeks). `probes/collision-oracle/` thin ray + 4 girişli
line-cache + statik küre sorguları: 24+24+8; 44.244 üçgen. Native/wasm/Python
`queryHash` birebir `f87365b7…9b5d6e`; 13/13 bozuk girdi reddi; ana suite
`--skip-build` 29/29. Fat/swept-sphere yok (teker yarıçapı XT'den), constraint
yalnız boş liste. Kanıt: `docs/work/verification/T-005d-collision-oracle.md`.

**Gravity wasm portu (2 Kasım, P17):** 8 gerçek Gravity TU'su upstream hâliyle
wasm32'de derlendi (33 nesne, 134.318 B); `t005d-gravity-overlay.patch` boş,
engine kaynağı değişmedi. Aynı 24+24+8 sorguda **ray 24/24 bayt-birebir**;
sphere 8/24 ve cache 1/8 yalnız altı raporlama alanında farklı (materyal
paketleme, patch normal, `engineTriangleIndex`, atanmayan trace flag'leri,
normalize edilmemiş normal). Tam `queryHash` eşitliği iddia edilmiyor; verifier
izin verilen farkı pinliyor ve başka farkta düşüyor. Kanıt:
`docs/work/verification/T-005d-gravity-wasm.md`.

**Araç fiziği wasm (5 Kasım, P19):** 186 nesne, **1.024.869 B** wasm; gerçek XT
`Corvette_ZR1_Stock` (1600 kg, 2.652 m aks, 0.356 m teker, 6 vites RWD).
180 dinlenme + 300 gaz tick: temas 480/480, NaN 0, hız 0,77 → **31,09 m/s**
(tepe 35,13), **96,14 m**; tüm koşu hash `2bbc0a18…e974f5`; iki koşu
bit-birebir. Native sayısal referans DX SDK yüzünden bloklu; 7 web-only dosyanın
MSVC önişlenmiş çıktısı aynı. Kanıt:
`docs/work/verification/T-007-vehicle-physics.md`.

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
