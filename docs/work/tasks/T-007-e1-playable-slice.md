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
- **Track visual (P31):** 144 gerçek direct draw / 19.167 üçgen
  (block88/node283 + block56/node289); collision mesh `visible:false`,
  physics-only. 5 araç: 250–281 draw.
- 3 geometri upload; console **0**; `verify_e1_drive` **231/231**.
- Kalan: track kapsamı (drive box 67/314 collision üçgeni çizili), engine
  draw list / materyaller, süspansiyon/steer/camber.
- Kanıt: `docs/work/verification/T-007-track-visual.md`,
  `docs/work/verification/T-007-per-car-meshes.md`.

### E1f — 310 m sprint (kabul)  ◐
- **Varsayılan 310,395 m collision-clean parkur** (P48/P51); start + 2
  checkpoint (arc ~100/200) + finish arc ~300. 5 araç bitiriyor:
  Audi **14,15 s**, Corvette 14,65, Lotus 14,77, Dodge 14,92, Focus 15,22.
- 29 m parkur `?course=short` regression olarak korunuyor.
- `verify_e1_drive` **550/550**; sprint/short/restart/respawn/survey capture
  console **0**; 310 m paket 500 draw / 1.060 update.
- **P61 kapalı tur bulundu:** collision mesh üzerinde üç loop (222,0 m / 224,2 m
  / 91,1 m); önerilen loop-01 222,0 m, min duvar 2,06 m, bant 11,75 m, seam
  0,5 m; engine trace PASS. Spawn bileşeninden 1,118 m duvar boşluğu var —
  tur modu loop üzerinde spawn etmeli. **Sıradaki: loop-01 lap modu.**
- **P63 ghost/rival:** her araç için en iyi temiz koşu kaydı (veya committed
  reference trace) hayalet araç olarak oynatılıyor; `G` aç/kapa, HUD `Δt/Δd`,
  çarpışma/fizik yok, ek geometri upload'ı yok. `verify_e1_drive` **678/678**.
- Kalan: kapalı tur entegrasyonu; AI rakip yok.
- Kanıt: `docs/work/verification/T-007-310m-course.md`,
  `T-007-sprint-rules.md`, `T-007-ledge-fix.md`.

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

### E1h — Engine draw list (P27 + P30 + P32 + P38)  ✅ (57/57)
- **57/57 instance**, **35.386 vertex / 26.077 üçgen** — tam node referansıyla
  birebir; blok31 chunk96 prerequisite grafiği (14 chunk, 15.079.424 B, hash
  `116a3286acb5f6c0`).
- 56/56 matris Stage B, 57/57 bounds-253 referansıyla 1e-5 içinde; 57/57 VB/IB.
- **Packet:** 312 kayıt (255 direct + 57 instance), **152 drawable**;
  hash `7c29fb2ec7769709`; 56 nesne, 849.609 B, 80/80, PC parity.
- Dokular: 102/102 decode (P34); materyaller 243 satır / 26 tip.
- **Track sections (P44):** 6 section (g56-n289, g58-n265, g50-n265,
  g71-n209, g64-n209, g59-n265) engine draw list'inde **299 draw / 47.790
  üçgen / 78.712 vertex**; bounds 6/6 1e-5, 299/299 primitive offset eşit;
  packet hash `8b3a40324410327f`; 2 runtime-only materyal `null` + neden.
- **Track UV/binding (P45):** 299/299 draw UV0 çözüldü (292 F16_4, 7 F16_2;
  aggregate `2ed1f4b0b3c9148e`); asset-reader `level_mesh` UV0 ile 299/299
  bit-birebir.
- **Track dokuları (P47):** 96 yeni blok decode edildi; registry **198**
  (102 P34 + 96 track); **297/297 statik binding** çözüldü (2 runtime-only);
  track aggregate `8d91645d4ee00831`, binding `9cc08756505dd497`; 96/96
  asset-reader ile birebir.
- **Dokulu pist (P49):** 394 draw'dan **297**'si gerçek albedo + UV0 ile
  sample ediliyor; 136 doku / 439.360 B RGBA; block88 95 draw diagnostic
  (`noBindingRowForSection`), 2 runtime-only. `verify_e1_drive` **522/522**;
  console 0; soak texture leak yok.
- **Engine packet (P54):** 451 draw / 35 mesh / 252 materyal; 2.246.207 B,
  hash `0e57f1e5…baba8`; UV 299/299, 297 statik doku; 83.210 üçgen /
  131.880 vertex. Render-packet v1.1 şemasına karşı **8 ihlal / 4 not**
  (timeline yok, topology strip, engine-buffer, null geometry) — producer
  hazır, PoC tüketicisi için dönüşüm gerekli.
- Kalan: mip/sRGB/anisotropy, materyal renk/blend, culling/LOD; PoC producer'ına
  bağlama.
- Kanıt: `docs/work/verification/T-007-drawlist-57.md`,
  `T-007-drawlist-56.md`, `T-007-engine-textures.md`.

### E1i — Araç parçaları/görselleri (P26/P28/P29/P52)  ✅
- Gövde/teker manifoldları 5 araç için kanıtlı; P28/P29 ile gerçek gövde ve
  dönen tekerler çiziliyor (9 node: 1 gövde + 4 spin + 4 statik kaliper).
- Corvette parça manifesti: 29 parça / 80 draw, 76 kanıtlı, 4 yan-belirsiz;
  4 teker grubu `+X` ekseni, kaliper sabit (`VehicleActor.cpp:5198`).
- **Araç materyalleri (P52/P55/P59):** 491 draw'dan **224'ü** gerçek albedo + UV0
  ile dokulandı (50 Corvette, 48 Lotus, 42 Dodge, 37 Focus, 47 Audi); 40 doku /
  18.178.048 B RGBA. Sampling **`(1-u, v)`** (P59; plakalar/decal'lar düz).
  **267 draw** diagnostic: 45 paint, 66 light, 156 no-albedo. sRGB/mip/paint yok.
- `verify_e1_drive` **570/570**; 20 capture console 0; 1 dk soak temiz.
- **Paint/light static refs (P60):** 267 runtime draw'da **424** `TEXTURE_INDEX`
  alanı çözüldü (0 unsupported); 24/29 doku decode (5 shared 1024²
  `smashedglass_nrm` sınır dışı). Paint lookup ve light blend **runtime**,
  renk uydurulmadı. Kanıt: `docs/work/analysis/car-materials.md` §9.
- Kanıt: `docs/work/verification/T-007-textured-cars.md`,
  `docs/work/analysis/car-materials.md`.

### E1j — Ses (P62)  ✅ (fizibilite)
- `race_v8.baf`: `BANK/WAVE/DATA` v4, uADPCM4Bit, 48 kHz; altı motor loop'u
  decode edildi (720/1500/1995/3015/4005/4995/6000 + decel).
- RPM→gain/pitch eğrileri retail `.dat`'ten birebir; harness headless Edge'de
  **decoded-audio-playing-and-curves-match**, console 0.
- Sıradaki: E1'e motor sesi entegrasyonu (RPM sürüşüyle), sonra tyre/collision.
- Kanıt: `docs/work/analysis/audio-feasibility.md`, `probes/audio/`.

### E1k — Prop collision (P66)  ✅ (veri + resolver)
- 468 statik OBB collider (8 instance + 460 track-visual component); roadside
  profili 373 aktif; 95 on-course bileşen `active:false` (310 m hattı dört
  kümede kesiyor: 52–61, 114–122, 125–128, 181–207 m).
- Resolver: 2.98×1.68 m car OBB, SAT push-out, Coulomb μ=0.45, 7 substeps
  @31 m/s; head-on 0.001 m gap, glancing %96 teğetsel, 0 tunneling.
- **Önemli:** all-visible 310 m hattını kesiyor; lap-01 için ayrı ölçüm gerek.
  Entegrasyon P67 lap modunda yapılacak.
- Kanıt: `docs/work/analysis/prop-collision.md`, `probes/prop-collision/`.

### E1l — Free-roam alanı (P65)  ✅
- Spawn havzası **R04: 9.689,5 m²** (310 m koridorunun ~2,3 katı), **%100
  çizili** (`g56-n289`); yeni geometri/upload gerekmiyor.
- Alanın %56,6’sı 310 m hattının 12 m dışında; 366 m çap, 11,5 m medyan
  genişlik, spawn bowl 95 m’ye kadar.
- **R01 (17.618 m²) erişilemez** (3,50 m / 100 m duvar); R03 14,98 m void.
  Sadece R04 spawn-connected.
- Öneri: `?course=free` (no corridor respawn), 310 m sprint ayrı kalır.
- Kanıt: `docs/work/analysis/free-roam.md`, `_work/free-roam/free-roam.png`.

### E1m — 3 turluk kapalı tur (P67)  ✅
- `?course=lap`: P61 `loop-01` üzerinde **222,04 m, 3 tur**; 902 örnek, ayrı
  spawn `(115.5, 1164.0)`, start/finish 4 m çizgi.
- 5 araç deterministik: **85,47–86,28 s**, tur süreleri ~28,4–29,2 s, 0 respawn,
  replay/restart birebir; max lateral ≤0,984 m, min steep-face 1,949 m.
- `all-visible` prop katmanı tur modunda **aktif ve inert** (loop-01'de prop yok,
  0 temas); resolver P66'dan read-only tüketiliyor.
- Verifier **766/766**; suite 30/30; checker 21/21. Kanıt:
  `docs/work/verification/T-007-lap-mode.md`.
- Not: ilk uygulamada seam projeksiyonu lap 2/3'ü düşürüyordu; yarım-tur
  koşulu kaldırıldı (ayrıntı verification doc §2).

### E1n — Free-roam + solid prop'lar (P68/P69)  ⏳ veri hazır
- `?course=free`: committed spawn `(-88, 1050)`, **7.415 m²** erişilebilir spawn
  bileşeni (P68a/P68b ölçümü); checkpoint/finish yok, koridor respawn'ı yok.
- **P68b manifesti:** `_work/free-roam-prop/colliders-r04.json` — **431 collider**
  (8 instance + 423 track component), `all-visible`; kapsama %64,6 → **%100**
  (7.702,25 m² referans bileşen). Spawn açıklığı **5,803 m**, head-on 0,001 m,
  0 tunneling, 29/29 PASS.
- `all-visible` doğu kanalını (1.321 m²) C03 boru/çit duvarı yüzünden kesiyor;
  bu cep **erişilemez** ve oraya spawn/respawn yok. Bu, uydurma değil ölçüm.
- Uygulama: `prop-layer.js` free modda bu manifesti + kendi SHA pinlerini
  kullanmalı; 310 m/lap mevcut `colliders.json` pinlerinde kalmalı.
- HUD: free-roam etiketi, hız, konum; `R` spawn'a döner; bölge dışı/zeminden
  düşme reseti.
- Kanıt: `verify_e1_drive` free-roam blokları + 5 araç capture, console 0.

### E1o — Motor sesi (P70)  ✅ modül hazır
- `probes/audio/web/engine-audio.js`: 6 `RaceV8_Engine_*` loop'u, retail
  RPM→gain/pitch PLF eğrileri, gesture-only AudioContext, `setRpm`/`mute`/`dispose`.
- Headless Edge: **engine-audio-module-verified**, 6/6 decode, gain/rate farkı
  ≤5,9e-8, RMS 0,041–0,137, **console 0**; fetch/decode hata yolları tipli.
- Sıradaki: E1 sayfasında `Engine().RPM()` ile tek `setRpm` çağrısı + gesture.
- Kanıt: `docs/work/analysis/audio-engine-module.md`, `_work/audio/module-harness.png`.

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
- [x] Tam tur sürülüp bitirilebiliyor (loop-01 3 tur, 5 araç, 0 respawn).
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
