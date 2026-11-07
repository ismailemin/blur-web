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

### E1n — Free-roam + solid prop'lar (P68/P69)  ✅
- `?course=free`: committed spawn `(-88, 1050)`, **7.702 m²** erişilebilir spawn
  bileşeni; checkpoint/finish yok, koridor respawn'ı yok, countdown yok.
- **431 collider** `all-visible` (`colliders-r04.json`, %100 kapsama); truck,
  wreck ve binalar solid; spawn açıklığı 5,803 m; 0 temas.
- Containment: `x −108.5…5.0, z 1027.5…1164.0` + 2 m marj, zeminden 1 m düşme,
  30 havada tick; reset her zaman spawn. Görünmez duvar yok.
- 5 araç 401 tick: 22,7–29,2 m, 0 temas, 0 respawn, replay birebir.
- Doğu kanalı (1.321 m²) C03 prop duvarı yüzünden erişilemez ve oraya spawn yok.
- **P74 V2 manifestleri:** `colliders-v2.json` **651** (553 roadside) ve
  `colliders-r04-v2.json` **447** (371 roadside); lap'te 56 duvar/garaj/kapı,
  free'de 6 boru/duvar, 310 bandında 79 dikey bileşen artık solid.
- Kanıt: `docs/work/verification/T-007-free-roam.md`,
  `_work/e1-drive/browser-<slug>-free-*.png`.
- Sıradaki (P74b): V2 manifestlerini sayfaya bağlamak (yeni pinler).

### E1q — Görünür yapı collision açığı (P74/P74b)  ✅ entegre
- Lap koridorunda **56 dikey bileşen**, free kutuda 6, 310 bandında 79
  collider'sızdı; V2 kuralı dikey yapıyı materyalden bağımsız solid yapıyor.
- Sayfada: 310 **V2 roadside 553**, lap **V2 all-visible 651**, free
  **R04-V2 all-visible 447**. Eski V1'e sessiz dönüş yok; pin uyuşmazsa hata.
- Lap 0/902, free 0/121, 310 roadside 0/1245 bloke; free beton boru 31 m/s'de
  0,001 m'de duruyor, 53 temas/53 bloke tick.
- `verify_e1_drive` **856/856**; collision capture **30/30**, free 20/20,
  lap 20/20, props 25/25, console 0.
- Kanıt: `docs/work/analysis/prop-collision.md` §P74,
  `_work/e1-drive/browser-*-collision-free-pipe-stopped.png`.

### E1r — Doku kalitesi (P75)  ✅
- Kök neden: BC1 texelleri sRGB iken `rgba8unorm` + shader'da `pow(1/2.2)` →
  **çift gamma** (soluk görünüm); tek mip + nearest minification → aliasing.
- Düzeltme: `rgba8unorm-srgb` yükleme, **linear-light 2×2 box mip zinciri**,
  trilinear + anisotropy 8 (adapter 1'e sınırlı), doğru sRGB output.
- Kanıt: sRGB 16/16 resource-block sampler kaydı + `trafficcylinder_diff` +
  asset-viewer; uydurma renk yok.
- 4 before/after karede değişim **%91–99,6**; packet hash'leri/fizik değişmedi.
- `verify_e1_drive` **838/838**, suite 31/31, checker 23/23, capture console 0.
- Kanıt: `docs/work/verification/T-007-texture-quality.md`,
  `_work/e1-drive/quality-crops/*-before-after.png`.
- Sınır: kaynak 16×16/32×16; upscale yok. Malzeme rengi/gölge/post yok.

### E1o — Motor sesi (P70/P71)  ✅ entegre
- `e1_engine_rpm()` native export (`Engine().RPM()`), wasm A/B deterministik.
- `probes/audio/web/engine-audio.js` sayfada: ilk tuş/click'te AudioContext,
  kare başına `setRpm`, `M` mute, `?audio=0`, `pagehide` dispose.
- Headless: **826/826** verify, `--mode audio` **16/16**, console **0**;
  1500/3015/6000 RPM gain/rate farkı ≤6e-8, mute RMS 0.
- Sınır: tek V8 graph, RPM-only; decel/throttle/induction/mixer yok.
- Kanıt: `docs/work/verification/T-007-audio.md`, `_work/e1-drive/browser-audio-running.png`.

### E1p — Prop dokuları (P72a/P73a/P73b)  ✅
- Görünür yapısal prop'lar zaten dokulu (460 P66 / 423 P68 bileşen).
- **22 level-instance draw** reader'da açıldı: **18 draw / 10.212 üçgen** BC1
  static albedo + gerçek UV0 ile çiziliyor; **4 draw / 96 üçgen** BC3
  `bc3-alpha-rule-missing` olarak diagnostic.
- 4 texture (32×16 BC1, 8.192 B) + UV stream (105.296 B) geometry/packet'a
  additive; committed layout/ghost pinleri değişmedi.
- Before/after: tick 120 truck karesi **%37,1** değişti; free prop **%5,6**.
- `verify_e1_drive` **838/838**, suite **31/31**, checker **23/23**,
  `--mode props` **25/25 console 0**.
- Kanıt: `docs/work/verification/T-007-prop-textures.md`,
  `_work/e1-drive/browser-*-prop-truck.png`.
- Sınır: `g_tMaterial`, renk/blend/alpha/mip/sRGB yok; 4 BC3 draw kapalı.

### E1s — 62 araç denetimi (V1)  ✅
- **5 A / 42 B / 15 C.** A = mevcut kanıtlı 5 araç; B = model+Scene+materyal+fizik
  hazır ama sürüş dilimine eklenmemiş; C = tam model yolu yok (15).
- 42 B aracın tamamı 4 tekerlek grubu, 6–10 doku ve geçerli fizik alanlarına
  sahip; sıradaki 10 araç manifestlendi (Audi TT, F100, FR100, Golf, Mustang GTR,
  Viper ACR, S3, Bronco, Skyline, HHR).
- 5 araç guard'ı 4 dosyada sert kodlu; genişletme main-agent sahipliğinde.
- Doğrulama **542/542**. Kanıt: `docs/work/analysis/vehicle-pipeline.md`.

### E1t — Yarış mantığı/AI denetimi (G1)  ✅
- Upstream oyun mantığı: **481 dosya / 134.941 satır / 1.178 sınıf**.
- **108 dosya / 26.369 satır** AI çekirdeği object-compile ediyor (link/run yok);
  **324 dosya / 88.749 satır** yeniden yazılmalı; 41 dosya platform-bound.
- M1 için minimum kural katmanı 5 modül: RaceDirector, CourseModel,
  ProgressTracker, RespawnPolicy, ResultModel — `sprint-rules.js`'ten evrilebilir.
- En büyük engel: oyun PCH/DirectX, actor/runtime coupling, .aid AI verisi,
  DemonWare MP modu, hasar/pickup/scoring verisi.
- Kanıt: `docs/work/analysis/game-logic-audit.md`; envanter hash
  `8e431241…3c0a`.

### E1u — 19 harita denetimi (M1)  ✅
- 19 level dizininin tamamı Gravity shape stream'iyle parse ediliyor; collision
  oracle tek başına 15/19'da takılıyor (shape tipleri).
- **1 A / 16 B / 2 C.** A = `usa_la_river` (mevcut). C = bowl/highrise
  multiplayer (draw kapsaması 0 / 6,2 m; instance traversal gerek).
- Sıradaki 3 aday: **usa_amboy** (2.060,6 m, %97,6), **spa_barcelona_gracia**
  (624,9 m, %99,6), **usa_la_longbeachdocks** (818,4 m, %47,3; 74/76 section).
- Aday layout hand-off'ları `_work/map-pipeline/candidates/` altında.
- Doğrulama **193/193**. Kanıt: `docs/work/analysis/map-pipeline.md`.

### E1v — Power-up tanımları (PWR1)  ✅
- `gamedata.pak` pickups/multiplayer/ui/audio/dynamiceffects XT'lerinden **11
  power-up** (8'i MP bayraklı): Nitrous, Shock, Shunt, Blindfire/Bolt, Barge,
  Bomb/Mine, Repair, Shield + SP Fan, Stopwatch, SuperShield.
- 7 varyant (Normal, DoubleTap, Reversed, Mini, Modified…), 439 MP race satırı,
  86 AmaxEvent, 51 olasılık listesi, 18 audio entity.
- Alanlar: menzil/süre/hasar/onarım/kalkan ömrü gerçek değerlerle; charge/ammo,
  hedefleme, hit-test, HUD icon binding **unknown** olarak tipli (uydurulmadı).
- Kurallar prototipi: mine hit/miss, shield absorb/break, Nitrous/Shock expiry,
  pickup respawn, capacity, event sırası — **9/9**.
- Doğrulama **1.783/1.783**, native XT schema agreement, iki build byte-identical.
- Kanıt: `docs/work/analysis/powerups.md`, `_work/powerups/powerups.json`.

### E1w — Çok oyunculu yarış kural katmanı (R1)  ✅
- `probes/race-rules/`: RaceDirector, CourseModel, ProgressTracker, RespawnPolicy,
  ResultModel, RaceSession — motor/render/ağ bağımlılığı yok.
- 310 m ve loop-01, 2/3/4 oyuncu; sıralı checkpoint, yanlış yol, off-course,
  respawn, tur, finish sırası, beraberlik, DNF/disconnect, restart, host otoritesi.
- **67/67** kontrol, 1.376 per-tick replay hash, iki koşu byte-identical.
- Kanıt: `docs/work/analysis/race-rules.md`; ana suite'e eklendi.

### E1x — Oda servisi + transport (N1)  ✅
- `probes/net-mvp/`: dependency-free HTTP + RFC6455 WS oda servisi; kısa kod,
  host, ready/start, 60 Hz input / 20 Hz state, ack/sıra, 30 s resume.
- Node harness: 4 istemci, 30 s, 1800 tick; **21/21**; 1% loss + 80 ms gecikme,
  reconnect; final hash iki koşuda aynı.
- Browser: 2 iframe, console **0**, 600/600 state, 0 ihlal, aynı final hash.
- Selftest **22/22**; ana suite'e eklendi. API M1 entegrasyonuna hazır.
- Kanıt: `docs/work/analysis/net-mvp.md`, `_work/net-mvp/browser-two-clients-finish.png`.

### E1y — Tyre + collision sesi (A2)  ✅ modül hazır
- 19 bank / **269 wave** decode; **53'ü bağlandı** (11 tyre loop + 42 collision
  one-shot). `wheel_dry/offroad/common`, `car_collisions`, `do_*`.
- Kanıtlanmış PLF eğrileri (dry/offroad speed/skid/pitch) ve 18 malzeme→çarpma
  tablosu; desteklenmeyen malzeme `unsupported-material` (ses uydurulmaz).
- Harness: dry/offroad/gravel/grass/sand/foliage RMS 0,01–0,145; impact 0,293;
  mute 0; console **0**. Parser düzeltmeleri: `VectorIn::Data` 16 B, ADPCM son blok.
- Kanıt: `docs/work/analysis/audio-tyre-collision.md`,
  `_work/audio/tyre-collision-harness.png`.
- Sıradaki: E1'de `setSurface`/`setSlip`/`triggerImpact` bağlantısı.

### E1z — İkinci harita dilimi: usa_amboy (MAP2)  ✅ veri
- 63.708 collision üçgeni, 48/75 draw section, 1.606 draw / 348.948 üçgen.
- **2.060,595 m** draw'lı yol (%97,62), 8.673 nokta; spawn `(230, 1128)`,
  checkpoint 686,86 / 1.373,67 m.
- Fizik Amboy collision'da: 61/61 tick 4/4 temas, sequence hash
  `d25c4592…`; paket **17,62 MB**.
- Eksik: **0/1.606 draw dokulu**, 27 section unsupported, 366 instance atlandı,
  normal yok, basit Box/Cylinder collision pakette değil. E1 hâlâ River-only.
- Doğrulama **12.367/12.367**. Kanıt: `docs/work/analysis/map-slice-amboy.md`.

### E1aa — AI rakip sürücüsü (AI1)  ✅
- `probes/ai-driver/`: deterministik Stanley (sprint) / pure pursuit (loop) sürücü,
  3 destekli skill profili (cautious/standard/reference) + agresif (1/10 fail).
- Gerçek wasm ile 5 araç 310 m ve loop-01: 10/10 temiz, 0 respawn, 0 NaN;
  committed follower ile 9/10 süre birebir (Lotus loop +1 tick).
- **26/26**; 133.068 tick hash; 4 AI sprint + 3 AI lap deterministik sıra.
- Kanıt: `docs/work/analysis/ai-driver.md`, `_work/ai-driver/results.json`.

### E1ab — Amboy doku binding (MAP3)  ✅ veri
- **1.201 / 1.606** Amboy draw gerçek albedo + UV0 bağlayabilir (%74,8;
  269.300 / 348.948 tri).
- Kök neden: reader binding'i çözüyor ama JSON printer `albedoTexture:null`
  yazıyor; MAP2'nin "path yok" ifadesi düzeltildi.
- 405 draw engelli: 334 `Racification*` (additive decal, `g_tTexture`),
  50 decoder 512 px sınırı, 17 BC3 alfa, 4 runtime albedo.
- 27 section + 366 instance **geometri** engeli (doku 27/27 ve 366/366 çözülüyor).
- Doğrulama **13.090/13.090**. Kanıt:
  `docs/work/analysis/map-slice-amboy-textures.md`.
- Sıradaki: reader printer düzeltmesi + Amboy render binding.

### E1ac — M1 online race (INT1)  ✅
- `?mp=1&host=1` / `?mp=1&room=CODE`: oda kodu, lobby, ready, host start,
  310 m River; host `RaceSession` otoritesi, 20 Hz snapshot, uzak araç ghost
  hattıyla interpolasyon, 0,5 m/0,25 rad düzeltme eşiği.
- `verify_e1_drive` **874/874** (856 + 18 MP); MP Node raporu **18/18**;
  iki tarayıcı capture **PASS**, console **0/0**, ortak sonuç
  `0ef78fcb…`; P1 Host 14,667 s / P2 Guest 16,400 s.
- Launcher: `tools/run_e1_poc.ps1` artık oda servisini 8811'de açar.
- Sınır: WebSocket loopback/LAN, tek harita, aynı araç, tek remote slot,
  power-up/AI/host migration yok, WebRTC/TURN yok.
- Kanıt: `docs/work/verification/T-007-multiplayer.md`,
  `_work/e1-drive/browser-mp-{lobby,mid,finish}-{host,guest}.png`.

### E1ad — Amboy render paketi (AMB1)  ✅ veri
- `_work/map-slice/amboy-render/` 19,13 MB: 1.201 opaque draw (269.300 tri)
  gerçek albedo + UV0, 179 RGBA8 doku (2,65 MB), 334 additive-decal ayrı,
  71 diagnostic.
- 3 geometry buffer'ı MAP2 ile byte-identical; 1.606/1.606 UV hash MAP3 ile aynı.
- Upload kontratı: 2 vertex buffer + 1 index + 179 bind group; sRGB/mip hint.
- Doğrulama **17.813/17.813**, iki build byte-identical.
- E1 entegrasyon gap'i: `?map=amboy`, packet producer, WebGPU upload, decal pass.
- Kanıt: `docs/work/analysis/map-slice-amboy-render.md`.

### E1ae — Gerçek pickup yerleşimi (PWR3)  ✅ veri
- `usa_la_river` MP rotasında **54 PickupPosition** actor: Blindfire 12,
  Shunt 9, Barge 7, Nitrous 7, Repair 6, Shield 6, Bomb 4, Shock 3.
- 26'sı 8 shuffle grubunda (her grupta bir tip), 28'i sabit; min aralık 7,809 m.
- Kaynak zinciri: `multiplayer.bin Route` → `amax.bin` → `actorpack.xt`
  `LevelActorList` → `PickupPosition`; hepsi hash'li.
- 310 m parkurla örtüşme **0** (en yakın 72,8 m); loop-01'de **2** (1,26/1,80 m);
  retail 20 slotluk start grid loop-01'de.
- Doğrulama **1.415/1.415**. Kanıt: `docs/work/analysis/pickup-placement.md`.
- Not: PWR2'nin geçici 310 m arc yerleşimi gerçek veriyle örtüşmüyor; M2 için
  loop-01/retail rota tercih edilmeli.

### E1af — M2 power-up ilk dilimi (PWR2)  ✅
- `?mp=1&powerups=1`: **Bomb/Mine, Shield, Repair** host otoriteli; 6 geçici
  pickup (310 m arc 40/90/140/190/240/280), tek slot, HUD health/shield/feed.
- 18 olay (pickup-spawned, mine-placed/armed/detonated, shield-absorbed/broken,
  repaired, damage, wrecked, respawn…); istemci yalnız use intent gönderir.
- Değerler PWR1'den: Bomb r1.0/outer3.5/dmg100/life60/prime0.3; Shield 50/6 s;
  Repair 400; pickup radius 2.0. Nitro/Shock/Shunt/Bolt/Barge tipli ertelendi.
- Node **68/68**; iki tarayıcı `--mode mp-powerups` **PASS**, console **0/0**;
  host/guest olay sayıları aynı; 20 teslim, 0 drop.
- `verify_e1_drive` **874/874**, suite 44/44, checker 23/23.
- Kanıt: `docs/work/verification/T-007-powerups.md`,
  `_work/e1-drive/browser-mp-powerups-*.png`.
- Sınır: 100 HP / 1 s wreck / tek slot proje kuralı; mine falloff yok;
  pickup respawn süresi unresolved; placement geçici (PWR3 54 gerçek nokta).

### E1ag — Nitro boost hook (BOOST1)  ✅ fizibilite
- Mevcut boost hook yok; `CarPerformanceModifiers` ve `C_Body::AddForce`/
  `AddImpulse` mevcut. Input-only ve post-tick yazımlar reddedildi (zayıf /
  solver dışı / wheel spin −%30).
- **Önerilen:** `AddForce` `Simulate` öncesi, 300 m/s² × mass, 0.5 s; Nitro
  hedefi 55,32 mph'de **52,759 m/s** (A sınıfı), süre 1,3 s; 55 m/s cap.
- Shock: BRAKE hedefi **19,995 m/s**, 10 mph taban; Shunt: geçici 20 kN·s
  impulse (provisional).
- Tüm adaylar deterministik; baseline shipped modülle bit-identical.
- Kod listesi: `e1_drive_lib.cpp` (`e1_boost_queue`/`e1_boost_state`),
  `build_module.mjs`, `powerups.js`/`mp-client.js`.
- Kanıt: `docs/work/analysis/boost-feasibility.md`.

### E1ah — 15 araçlık roster (V2)  ✅
- 5 mevcut + **10 B araç**: Audi TT, Audi S3, Ford F100 OffRoad, Ford FR100,
  VW Golf W12, Ford Mustang GTR, Dodge Viper ACR, Ford Bronco, Nissan Skyline
  R34, Chevrolet SoCal HHR.
- Her araç kendi `.model` gövdesi/tekerleri, doku paketi (veya P52 runtime
  gerekçesi), 310 m + 29 m koşusu, lap/free, ghost ve restart ile kanıtlı.
- `geometry.json` **106.864.802 B** (101,91 MiB; +%135,5) — batch-1 128 MiB
  bütçesi içinde. Batch 2 öncesi chunking zorunlu (kayıtlı).
- **2254/2254** verify; 60/60 browser sprint capture console 0; CTest 15/15;
  suite 44/44; checker 23/23. İlk 5 aracın state anchor'ları değişmedi.
- Kanıt: `docs/work/verification/T-007-vehicle-batch1.md`,
  `_work/e1-drive/browser-audi-tt-stock-sprint-finish.png`.

### E1ai — İkinci harita: spa_barcelona_gracia (MAP5)  ✅ veri
- 113.270 collision tri, **88/92 section**, 550.632 tri / 3.580 draw; UV
  3.580/3.580. 4 section POSITION type-7, 2.714 instance prerequisite.
- Yol **624,91378 m** (%99,60), spawn `(336, −23)`, checkpoint 208,34/416,65 m;
  fizik 61/61 tick 4/4 temas, sequence `4fd8ae0c…`.
- **2.627 draw / 365.451 tri** gerçek albedo (734 doku, 3,25 MB); 953 draw
  engelli (518 Racification, 426 BC3 alfa, 5 boyut, 4 runtime).
- Render paketi **28,8 MB**; doğrulama 26.797 + 32.782 + 45.590.
- Modül pin politikası behavior-based: binary drift kabul, 61/61 tick hash şart.
- Kanıt: `docs/work/analysis/map-slice-gracia.md`,
  `docs/work/analysis/map-slice-module-pin-policy.md`.

### E1aj — Nitro + Shock (BOOST2)  ✅
- `e1_boost_queue`/`e1_boost_state` export'ları; force `Simulate` öncesi,
  reset'te temiz. wasm 1.012.634 B, A/B deterministic.
- Nitro hedefleri: 24,73 m/s'de A **52,758963** / B 50,121 / C 47,483 / D 44,845
  m/s; 1,3 s, 55 m/s cap. Shock: **19,995236 m/s**, 10 mph floor, r7/14, 1,5 s,
  damage 100.
- Gerçek wasm: Nitro +18,29 m/s (1,3 s), peak +25,53; Shock −14,79 m/s.
- `?mp=1&powerups=1`: Nitro/Shock pickup + host event + HUD; capture host
  10,15→48,49 / guest 12,51→48,82 m/s, console **0/0**.
- Boost **31/31**, power-up **79/79**, verify **2254/2254**, suite **48/48**,
  checker 23/23, CTest 15/15.
- Sınır: class A proje varsayımı (4 hedef de taşınıyor); wall testi yok, cap
  aritmetik; Shock hit-test proje-planar. Shunt/Bolt/Barge/projectile ertelendi.
- Kanıt: `docs/work/verification/T-007-powerups.md`,
  `_work/e1-drive/browser-mp-powerups-nitro-*.png`.

### E1ak — Projectile/Shunt/Barge verisi (PWR4)  ✅ veri
- Yeni `PerkForceEffects` tablosu (9 satır, MaxForce/radius/time) `pickups.bin`
  record 821; rldatabase System 40 referansı.
- Blindfire: speed 300, radius 0.2, dmg 50, 10 s, 3 charge; Shunt: radius 0.75,
  dmg 100, 40 s, homing; Barge: radius 7, dmg 100, 0.4 s; Shock: r7/14, 1,5 s,
  **gerçek hasar 50** (minor kuralı), 3 dome.
- Kural prototipi **19/19**; verifier **888/888**; mevcut 1.783 değişmedi.
- Eksikler tipli: charges/lifetime/homing runtime, fake-physics magnitude,
  hedef radius/extents, E_PICKUP_TYPE, icon binding.
- Kanıt: `docs/work/analysis/powerup-projectiles.md`.

### E1al — Amboy oynanabilir harita (MAP6)  ✅
- `?map=amboy&script=sprint`: gerçek `usa_amboy` physics + **1.201 opaque draw /
  269.300 tri / 179 doku** (2,65 MB), 2.060,595 m ölçülmüş yol.
- Corvette scripted finish **222,050 s / tick 13.413**, checkpoint 68,617 /
  131,617 s, 0 respawn, 4/4 temas, 0 NaN; replay birebir.
- 334 additive decal + 71 diagnostic atlandı (etiketli); 27 section + 366
  instance yok; vertex normal yok (derivative normal); collision 63.708 tri.
- Map verifier **23/23**; River regression **2254/2254**; capture console 0;
  suite **51/51**; checker 23/23.
- Kanıt: `docs/work/verification/T-007-map-amboy.md`,
  `_work/e1-drive/browser-corvette-zr1-stock-map-amboy-mid.png`.

### E1am — Gracia oynanabilir harita (MAP7)  ✅
- `?map=gracia&script=sprint`: **2.627 opaque draw / 365.451 tri / 734 doku**
  (3,25 MB), **624,913781 m** ölçülmüş yol.
- Corvette finish **66,267 s / tick 4.066**, checkpoint 26,783 / 47,917 s,
  0 respawn, 4/4 temas, replay birebir; state `cf089202…`.
- 953 draw engelli (518 Racification, 426 BC3, 5 boyut, 4 runtime); 4 section
  + 2.714 instance yok; derivative normal.
- Map verifier **23/23**; Amboy 23/23; River 2254/2254; capture console 0;
  suite **52/52**; checker 23/23.
- Kanıt: `docs/work/verification/T-007-map-gracia.md`,
  `_work/e1-drive/browser-*-map-gracia-mid.png`.

### E1an — MP harita seçimi (MP8/PWR2)  ✅
- Oda `map` alanı: host lobby'de **river/amboy/gracia** seçer; guest salt-okunur.
- Her istemci paket/layout/physics hash'ini ölçer; uyuşmazsa
  `MAP_PACKAGE_MISMATCH` (sessiz River fallback yok). READY = map-ready.
- Finish kontratı: host otoritesi, guest kendi raporunu verir; geç rapor açık
  odada kabul, kapalı odada `MP_ROOM_CLOSED`; 1 tick yuvarlama toleransı.
- **3 harita 2 oyunculu:** River 14,667/16,400 s; Amboy 222,000/237,567 s;
  Gracia 66,317/69,183 s; üçü de console **0/0**, sonuçlar birebir.
- `verify_e1_drive` **2265/2265**; suite **51/51**; checker 23/23; harita
  23/23 + 23/23.
- Kanıt: `docs/work/verification/T-007-mp-maps.md`,
  `_work/e1-drive/browser-mp-*-{amboy,gracia}.png`.
- **Gracia grid fix:** lateral slot tick 91'de airborne oluyordu; 140-tick
  wasm probe ile doğrulanan **spawn + tangent × 2.2 m** longitudinal grid
  kullanılıyor. Gracia host **0 respawn**, 66,250 s; guest 69,383 s; console 0/0.
- Kalan: Amboy/Gracia'da power-up/AI yok; grid probe sabit 140 tick.

### E1ao — AI sürücü Amboy/Gracia (AI3)  ✅
- Amboy **30/30 temiz** (minSpeed 3,5 m/s; 6,06 m hairpin için); Gracia
  **26/30 temiz**. Committed-control anchor iki haritada da birebir.
- Gracia Dodge Challenger: spawn-pose limiti (ön aks yüksüz) → 7 respawn/DNF;
  **dışlandı**. F100 bir respawn ile bitiriyor. Bu, harita/spawn/collision işi.
- 550.777 tick + 71.644 race hash eşleşti; 2 proses byte-identical.
- 4 AI Amboy 220,23–234,98 s; Gracia 64,12–68,70 s; deterministik sıra.
- Doğrulama **25/25**; River 26/26. Kanıt: `docs/work/analysis/ai-driver.md` §13.

### E1ap — Amboy/Gracia pickup yerleşimi (PWR5)  ✅ veri
- Amboy primary rotada **83** placement (8 tip; +52 yedek rota), Gracia **59**
  (8 tip; +45/+40). Tümü statik, ground var.
- Ölçülmüş alt-parkura yakın: Amboy **2** (min 0,452 m), Gracia **1** (0,834 m);
  çoğu retail rotada, 6 m bandı dışında.
- Provisional 310 m arc'larla **0/6** örtüşme (en yakın 156,56 / 94,67 m).
- Doğrulama **3.670/3.670** + **4.060/4.060**; River 1.415/1.415.
- Kanıt: `docs/work/analysis/pickup-placement.md` §11–16.
- Not: M2'yi Amboy/Gracia'ya taşımak için retail rota veya araç offset'i gerek.

### E1aq — Longbeach harita paketi (MAP8)  ✅ veri
- `usa_la_longbeachdocks`: 25.183 collision tri, **74/76 section**, 1.141 draw /
  537.294 tri; **1.039 bindable / 511.782 tri**, 164 doku (1,24 MB), 102 engelli.
- Yol **818,371716 m** (%47,29 collision çapı), spawn `(−519,111)`; fizik 61/61
  tick 4/4 temas, sequence `bb4d7efc…`.
- Paketler: slice 25,4 MB, textures 21,4 MB, render 26,1 MB.
- Doğrulama **9.480 + 9.967 + 13.534**; Amboy/Gracia değişmedi; suite **57/57**.
- Sınır: draw kapsaması yalnız %47,3 (195 component), 2 section, 7.476 instance,
  fluid mesh hariç, 93 alfa + 2 boyut + 1 no-albedo engelli.
- Kanıt: `docs/work/analysis/map-slice-longbeach.md`.

### E1ar — Online AI rakipler (AI2)  ✅
- Host 2 insan + **0–3 AI**: `?mp=1&host=1&ai=2&aiCars=…&aiProfiles=…` veya
  lobby `setAi`; guest salt-okunur, `?ai=` reddedilir.
- Profiller: cautious 0.85 / standard 0.95 / reference 1.0; her AI ayrı wasm
  instance, 60 Hz host tick, R1 participant `ai-1…`.
- River/Amboy/Gracia: AI finish 14,38–17,30 / 221,07–258,78 / 63,67–76,65 s,
  **0 respawn**; Gracia Dodge `ai-spawn-unsupported` (dürüst ret).
- Uzak araçlar ghost hattıyla N slot (cyan insan, amber AI), 20 Hz relay,
  interpolation; console **0/0**; reconnect'te AI devam ediyor.
- `verify_e1_drive` **2281/2281** (16 MP-AI); suite 57/57; checker 23/23.
- Kanıt: `docs/work/verification/T-007-mp-ai.md`,
  `_work/e1-drive/browser-mp-ai-mid-guest-amboy.png`.

### E1as — Blindfire/Shunt/Barge (WPN1)  ✅
- Power-up dilimi: **Bomb, Shield, Repair, Nitrous, Shock, Blindfire, Shunt,
  Barge** (8 tip); yalnız SuperShield ertelendi.
- Blindfire 300 m/s/r0.2/dmg50/10 s/3 charge; Shunt 0.75/100-50/40 s/homing +
  20 kN·s provisional impulse; Barge 7 m (+0.5/2.0 band) 100 dmg 0.4 s;
  JINK `not-serialized`.
- Tek hasar modeli: PWR4 projectile + PWR1 health/shield; hit başına bir kez.
- Node **107/107** (39 yeni); verify **2281/2281**; suite 57/57; checker 23/23;
  iki tarayıcı capture **console 0/0**, projectile 5/hit 4/shunt 2/barge 2.
- Kanıt: `docs/work/verification/T-007-powerups.md` WPN1,
  `_work/e1-drive/browser-mp-powerups-{blindfire,shunt,barge}-*.png`.
- Sınır: retail fake-physics magnitude, camera-LOS/ground ray, dynamic object,
  damage-mode modifiers yok; target envelope proje.

### E1at — 14 C aracın model kanıtı (V3)  ✅
- `AmaxVehicle.dynamics` FlaskHandle → XT refs → `RP_CarDynamics` id → engine
  `models/vehicles/%s.model` kuralı; 47/47 mevcut kayıtta doğrulandı.
- **14/15 C provable**; yalnız `DefaultCar` desteklenmez. 14/14 staging load:
  1.409 body draw, 412 part, 280 wheel draw, 289.239 UV vertex, 113 doku.
- 7 yüksek güven (wheel draw proven), 7 orta (preview-paired). Toplam
  **61/62 kayıt** oynanabilir hale getirilebilir.
- Doğrulama **438/438**; suite 58/58. Kanıt:
  `docs/work/analysis/vehicle-c-aliases.md`.
- Sıradaki: batch 2'ye 7 yüksek güvenli C ile başla.

### E1au — Hummer H2 parça katmanı (V4)  ✅
- `Hummer_H2_OffRoad` modelinde **brake caliper yok** (80 elementte 0
  `e_brakecaliper_*`); `cali_01` aslında plaka dokusu. Uydurulmadı.
- Builder tipli `caliper:"absent"` kabul ediyor; 4 wheel grubu 3 üyeli,
  `absentMembers`/diagnostic kayıtlı. Staged manifest
  `7f4166c5…`, 98 draw, 4/4 wheel.
- Verifier PASS; Audi R8 present-caliper regression byte-identical.
- Batch 2'ye medium-confidence girebilir (16 wheel draw preview-only).

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
