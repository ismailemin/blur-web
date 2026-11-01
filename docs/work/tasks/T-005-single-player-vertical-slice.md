# T-005 — Tek oyunculu dikey dilim

**Durum:** in-progress (T-005a tamam; T-005b sırada)
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

### T-005c — Scheduler ve zaman adımı
- Windows thread/job queue yerine Web Worker/Atomics veya tek iş parçacığı
  politikası; sabit simülasyon adımı, render'dan bağımsız.
- Frame-rate bağımsız davranış kuralı korunur.

### T-005d — Fizik ve çarpışma
- Gravity/physics alt kümesini WASM'e taşı; native referansla ölç.
- T-004'teki particle-cache çökmesi sürüş referansını bloke ediyorsa önce
  güvenli bir no-input/stationary referans kullan.

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
