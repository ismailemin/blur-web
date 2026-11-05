# T-007 — E1 oynanabilir dikey dilim

**Durum:** in-progress (E1b/E1c/E1d tamam; E1e kısmi; E1a streamer/parse bloklu; E1f sırada)
**Sahip:** ana ajan
**Başlangıç:** 4 Kasım 2026
**Bitiş:** —
**Karar:** `docs/work/analysis/e1-renderer-strategy.md`

## Amaç

River pistinde Corvette ile **sürülebilir ve bitirilebilir** tek oyunculu bir
dilim: motor simülasyonu wasm'da, WebGPU backend JS'te sürümlü bir render packet
tüketir. Görsel sadakat E1 seviyesinde; E2 kapısı ayrı.

## Alt görevler

### E1a — Level streaming (P18 + P22)  ◐
- `StreamManager` wasm'da: 359/359 chunk, 244.682.752 B, 359/359 FNV bağımsız
  Python ile aynı.
- **`Level.levelrender` artık engine serialiser'ıyla parse ediliyor (P22):**
  359 ChunkInfo / 10.784 item / 603 prerequisite, 359/359 alan eşit; cursor
  2.464.509 B = probe `parsedUntilOffset`; tablo hash `aae98142…d36`; 54 TU,
  664.137 B wasm, 30/30, PC parity.
- Kalan: resource block/render list importu (`Create*Buffer`, render states),
  `ProcessLoadChunk`, doku/chunk decompression. GPU çağrısı 0.
- Kanıt: `docs/work/analysis/engine-level-stream.md`,
  `docs/work/verification/T-007-streaming.md`.

### E1b — Render packet v1 (P20)  ✅
- Sürümlü packet: tick, alpha, kamera, ışıklar, draw'lar (mesh/aralık/matris/
  materyal+neden/layer/bounds), diagnostics, hash.
- Gerçek River ve Corvette geometrisinden üretici; WebGPU tüketici prototipi.
- Sonuç: 102 draw, 43.753 vertex / 46.501 üçgen; packet
  `sha256:7ede3abd…e0d1`, iki koşu bit-birebir; headless Edge/WebGPU 102 draw,
  console **boş**. Materyaller kimlik; tahmini renk yok.
- **v1.1 (5 Kasım):** 120 tick'lik dinamik timeline; fixed-step 10/10 senaryo
  sıfır toleransla; canlı koşu 90 tick/262 frame; geometri **bir kez** yükleniyor
  (2 upload), kare başına yalnız uniform + draw; tick 0→90 kayması 190,16 px;
  console boş.
- Kanıt: `docs/work/verification/T-007-render-packet.md`,
  `docs/work/analysis/e1-render-packet.md`, `probes/render-packet/`.

### E1c — Araç fiziği (P19)  ✅ (wasm; native parity DX SDK yüzünden bloklu)
- Gerçek RacingPhysics/Gravity TU'ları; `Car`/`ArticulatedBody`/teker ray'i.
- 186 nesne, **1.024.869 B** wasm; gerçek XT `Corvette_ZR1_Stock` (1600 kg,
  2.652 m aks, 0.356 m teker).
- 480 tick: teker teması 480/480, NaN 0; hız 0,77 → **31,09 m/s**, tepe
  35,13 m/s, **96,14 m**; tüm koşu hash `2bbc0a18…e974f5`; iki koşu bit-birebir.
- Native sayısal referans DX SDK yüzünden bloklu; 7 web-only dosyanın MSVC
  önişlenmiş çıktısı aynı.
- Kanıt: `docs/work/verification/T-007-vehicle-physics.md`,
  `docs/work/analysis/engine-vehicle-physics.md`, `engine/verify_vehicle.py`.

### E1d — Döngü, girdi, kamera  ✅
- Sabit adım sürücüsü (T-005c kuralları) → engine tick; WASD/oklar; chase camera.
- 300 tick scripted sürüş: 45,378 m, 0,002→14,986→0,448 m/s, temas 301/301,
  NaN 0; iki instance + reset+replay aynı state hash.
- Kanıt: `docs/work/verification/T-007-e1-drive.md`.

### E1e — WebGPU entegrasyonu  ✅ (E1)
- Gerçek araç durumu → packet v1.1 → WebGPU; **araç başına kendi gövdesi**,
  29–34 parça, 4 teker grubu fizik açısıyla dönüyor, kaliper sabit.
- 5 araç: 84–115 draw, ayrı gövde mesh hash'i; geometri 3 upload; console **0**.
- Eksik: `draws[]` hâlâ producer'dan (engine draw-list değil); materyaller
  diagnostic, süspansiyon/steer/camber yok, rest-pose teker konumu.
- Kanıt: `docs/work/verification/T-007-per-car-meshes.md`,
  `docs/work/verification/T-007-car-parts-integration.md`.

### E1f — İlk sürülebilir tur (kabul)
- Start → tur → finish; çarpışma, checkpoint, respawn.
- Tam tur + finish ekranı; performans ve bellek ölçümü.

### E1g — Çoklu araç (P23)  ✅
- `RP_CarDynamics` 62 kayıt, 62/62 completeness gate; 5 araç seçildi:
  Corvette ZR1, Lotus Exige Cup260, Dodge Challenger, Focus RS (FWD),
  Audi R8 V10 (AWD).
- Aynı 120/120/60 script: 5 ayrı deterministik state hash'i; Corvette
  `83f76590…008e1f` T-007 anchor'ıyla birebir.
- 20 browser capture, console **0**, geometri 3 upload; 18/20 packet hash
  birebir, 2'si kamera `atan2` bir-ulp farkı (state/matris birebir).
- **Sınır:** her araç Corvette C3 gövdesiyle çiziliyor (per-car mesh yok);
  teker çizimi yok.
- Kanıt: `docs/work/verification/T-007-multi-car.md`,
  `probes/e1-drive/cars/roster.json`.

### E1h — Engine draw list (P27 + P30)  ◐
- 95 direct draw + 57 instance; **22/22** instance matrisi ve bounds
  `level_inspect` ile 1e-5 içinde; 57/57 VB/IB ve transform satırı eşleşiyor.
- Materyaller: 243 sabit satır / 26 tip; 121 `g_tAlbedo`, 38 `g_mWorld`;
  type-8 nested yolu implement edildi (River'da 0).
- **Packet draw list:** 312 kayıt (255 direct + 57 instance), 117 drawable;
  hash `4603a94e0871461c`; 56 nesne, 814.345 B, 65/65, PC parity.
- Kalan: blok15/17/26/32 importu (56-stage geometri), dokular, visibility/
  culling/LOD, `ProcessLoadChunk`; PoC producer'ına bağlama.
- Kanıt: `docs/work/verification/T-007-drawlist-v2.md`,
  `docs/work/verification/T-007-streaming.md` §P27.

### E1i — Teker/kompozit görsel (P26)  ✅ (manifest)
- Corvette modelinden 29 parça / 80 draw: 76 kanıtlı, 4 yan-belirsiz.
- 4 teker grubu, `+X` dönüş ekseni; lastik köşe kanıtı tread+sidewall
  birleşimi (0.000343–0.000648 m); kaliper sabit (`VehicleActor.cpp:5198`).
- Headless Edge: console 0, 2 geometri upload, 0→0.9 rad arası 7.149 piksel
  farkı; ekran görüntüsü var.
- Kalan: manifest’i E1 drive packet’ine bağlamak; süspansiyon/steer/camber
  matrisleri yok.
- **Entegre (P28):** drive packet’i 29 parça/80 draw ve 9 node (1 gövde + 4 spin
  + 4 statik kaliper) kullanıyor; teker açısı fizikten entegre ediliyor (tick
  300'de 148,6 rad); `verify_e1_drive` **202/202**; console 0.
- Kanıt: `docs/work/verification/T-007-car-parts.md`,
  `docs/work/verification/T-007-car-parts-integration.md`,
  `docs/work/analysis/e1-car-parts.md`.

## Pipeline (bağımlılık sırası)

```
P22 (stream/Scene) ──► E1h engine draw list ──┐
P23 (multi-car) ──────────────────────────────┼─► E1f tam tur
P25 (Stage B track geometry) ─────────────────┘
E1i wheels ───────────────────────────────────┘
```

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
