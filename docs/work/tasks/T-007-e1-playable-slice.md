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

### E1f — Sprint + ilk tur (kabul)  ◐
- **P37 sprint (noktadan noktaya):** start + 2 checkpoint + finish; süre,
  best time, respawn. 5 araç: **2,283–3,267 s** (Audi en hızlı, Focus en yavaş);
  `verify_e1_drive` **348/348**; console 0.
- Gate'ler kaplı yol bandından türetildi (x = −88 → −59; her kolon 61/61 draw +
  61/61 collision).
- **P40 reset fix:** `C_Scene` group handle'ları oluşturuluyor/yok ediliyor;
  tek instance'ta **10+ rebuild**, telemetri tek instance, `R` yerinde restart
  (sayfa yenilemesi yok); 50 rebuild aynı hash, heap sabit.
- **P41/P46 koridor:** 539,81 m draw-coverage hattı **parkur değil**; ölçülen
  çizgi 57,82 m'de 50 m'lik collision duvarından geçiyor, şasi 52,7–53,4 m'de
  duruyor. Proxy lift (0,10 m) denenip ölçüldü, varsayılan yapılmadı.
  Oynanabilir sprint **29 m** olarak kaldı; 540 m görsel `?survey=1` ile
  etiketli sunuluyor (394 draw / 57.133 tri).
- **P48 gerçek sürülebilir yol:** collision mesh üzerinde **310,395 m**
  kesintisiz parkur bulundu (spawn → (103.5,1292.5)); max basamak 1,55 cm,
  max 2 m eğim %3,09, duvara min 7,78 m. 621 engine trace, 0 ihlal; 8/8
  bağımsız doğrulama. Bitişte yüzey 4 m sonra 2,0 m'ye daralıyor.
- **P51 görsel kapsama:** parkurun **%100**'ü `g56-n289` ile çizili
  (1.245/1.245; 8 draw / 939 üçgen; visual–collision −0,92…+0,93 mm; 16,1–24,2 m
  genişlik). Yeni section gerekmiyor.
- **Sıradaki: 310 m sprint entegrasyonu**; 29 m regression control kalacak.
- Kanıt: `docs/work/verification/T-007-sprint-rules.md`.

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
- Kalan: mip/sRGB/anisotropy, materyal renk/blend, culling/LOD; PoC producer'ına
  bağlama.
- Kanıt: `docs/work/verification/T-007-drawlist-57.md`,
  `T-007-drawlist-56.md`, `T-007-engine-textures.md`.

### E1i — Araç parçaları/görselleri (P26/P28/P29/P52)  ✅
- Gövde/teker manifoldları 5 araç için kanıtlı; P28/P29 ile gerçek gövde ve
  dönen tekerler çiziliyor (9 node: 1 gövde + 4 spin + 4 statik kaliper).
- Corvette parça manifesti: 29 parça / 80 draw, 76 kanıtlı, 4 yan-belirsiz;
  4 teker grubu `+X` ekseni, kaliper sabit (`VehicleActor.cpp:5198`).
- **Araç materyalleri (P52):** 491 draw'dan 224'ü statik albedo + UV0 ile
  eşleşti; 40 doku decode edildi (18,2 MB RGBA); 40/40 asset-reader ile
  birebir. 267 draw runtime-only (45 paint, 66 light blend, 156 no-albedo) —
  açıkça etiketli.
- Gövde henüz diagnostic renkli; doku entegrasyonu sıradaki.
- Kanıt: `docs/work/verification/T-007-car-parts.md`,
  `T-007-car-parts-integration.md`, `T-007-per-car-meshes.md`,
  `docs/work/analysis/car-materials.md`.

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
