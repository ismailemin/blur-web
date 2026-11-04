# T-007 — E1 oynanabilir dikey dilim

**Durum:** in-progress (E1b tamam; E1a streamer çalışıyor/parse bloklu; E1c sürüyor)
**Sahip:** ana ajan
**Başlangıç:** 4 Kasım 2026
**Bitiş:** —
**Karar:** `docs/work/analysis/e1-renderer-strategy.md`

## Amaç

River pistinde Corvette ile **sürülebilir ve bitirilebilir** tek oyunculu bir
dilim: motor simülasyonu wasm'da, WebGPU backend JS'te sürümlü bir render packet
tüketir. Görsel sadakat E1 seviyesinde; E2 kapısı ayrı.

## Alt görevler

### E1a — Level streaming (P18)  ◐ (streamer çalışıyor; levelrender parse bloklu)
- `StreamManager` wasm'da: 359/359 chunk, 244.682.752 B, 359/359 FNV bağımsız
  Python ile aynı; `levelrender`/`levelphysics` hash'leri de aynı.
- `Level.levelrender` Scene parse'ı DX11 `Display2` bağımlılığı yüzünden bloklu
  (`archive.cpp` 456 hata); chunk tablosu şimdilik probe'lardan geliyor.
- `StreamData` prerequisite/queue mantığı derlenmedi; `OpenStreamFile` buffer
  hint 0 uyuşmazlığı var.
- Kanıt: `docs/work/analysis/engine-level-stream.md`, `engine/verify_stream.py`,
  `docs/work/verification/T-007-streaming.md`.

### E1b — Render packet v1 (P20)  ✅
- Sürümlü packet: tick, alpha, kamera, ışıklar, draw'lar (mesh/aralık/matris/
  materyal+neden/layer/bounds), diagnostics, hash.
- Gerçek River ve Corvette geometrisinden üretici; WebGPU tüketici prototipi.
- Sonuç: 102 draw, 43.753 vertex / 46.501 üçgen; packet
  `sha256:7ede3abd…e0d1`, iki koşu bit-birebir; headless Edge/WebGPU 102 draw,
  console **boş**. Materyaller kimlik; tahmini renk yok.
- Kanıt: `docs/work/verification/T-007-render-packet.md`,
  `docs/work/analysis/e1-render-packet.md`, `probes/render-packet/`.

### E1c — Araç fiziği (P19)
- Gerçek RacingPhysics/Gravity TU'ları; `Car`/`ArticulatedBody`/teker ray'i.
- Sabit adım: dinlenme + gaz/direksiyon; durum hash'i; native/wasm parity.
- Kanıt: `docs/work/analysis/engine-vehicle-physics.md`, `engine/verify_vehicle.py`.

### E1d — Döngü, girdi, kamera
- Sabit adım sürücüsü (T-005c probe) → engine tick.
- Klavye/gamepad → motor girdi semantiği.
- Chase camera, HUD/debug overlay, pause/hitch politikası.

### E1e — WebGPU entegrasyonu
- Packet v1 tüketicisi gerçek oyun durumunu çizer: pist + araç + tekerler.
- Eksik materyal/doku açıkça raporlanır; tahmini renk yok.
- Console temiz; 60 Hz hedefi.

### E1f — İlk sürülebilir tur (kabul)
- Start → tur → finish; çarpışma, checkpoint, respawn.
- Tam tur + finish ekranı; performans ve bellek ölçümü.

## Kabul kriterleri

- [ ] River'da araç sabit adımla hareket ediyor; NaN/çökme yok.
- [ ] Çarpışma ve pist sınırları görsel olarak net.
- [ ] Tam tur sürülüp bitirilebiliyor.
- [ ] 60 Hz simülasyon, stabil kare hızı, console temiz.
- [ ] Kalan sadakat farkları listeli ve oyun hatasını gizlemiyor.
- [ ] Native/wasm fizik parity (mümkün olan yerde) kanıtlı.

## Bağımlılıklar / engeller

- E1a olmadan E1d/E1e gerçek level ile çalışmaz.
- E1c olmadan E1f mümkün değil.
- E1b sözleşmesi E1e'nin girdisi; E2 aynı sözleşmenin arkasında.
- E2 kapısı: `docs/work/analysis/e1-renderer-strategy.md` §Decision gate.

## Kapsam dışı

- DX11/FX11 birebir portu (E2).
- Parçacık/iz efektleri, post-process, özgün shader sadakati.
- Ses, UI menüleri, save, multiplayer (T-006).
- İkinci pist/araç.

## Kanıt

- `docs/work/analysis/e1-renderer-strategy.md`
- Alt görev belgeleri yukarıda.
