# CURRENT — buradan devam

**Güncelleme:** 2 Kasım 2026
**Aşama:** Aşama 4 sonu (gerçek asset/önizleme), Aşama 5 (tek oyunculu yarış) başlamadı.
**Baseline commit:** `04276aa chore: baseline project docs, probes, and tools`
**Son commit'ler:** Gravity wasm `3965a7c`, C_OverlayFs `e13f54b`, PAK consumer `c1f58eb`, T-005c A2 `194d0c4`, engine overlay `a80cfbe`, T-005d oracle `a881257`.

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
- `level_instances_all_inspect` aynı blokta **22 instance** çiziyor:
  **13.162 vertex / 10.308 üçgen**, 0 sınır uyuşmazlığı, 35 instance başka blok
  (en büyük sınır farkı **6.02444e-05**).
- Çoklu blok bundle taraması: `requiredGeometryBlocks=[15,17,26,27,31,32]`;
  blok27+15+17+26+32 toplam **56 instance**, **34.632 vertex / 25.521 üçgen**.
  Browser'da **River · tüm desteklenen** preset'i var.
- P2 analizi: arşiv `instanceBounds` kayıtları draw başına değil **CullNode
  (yerleştirilmiş nesne) başına**; 57 instance 34 transform-sabit grubuna ve 34
  byte-identical kayda karşılık geliyor. Eski tek-draw kontrolü 21 instance'ı
  yanlış reddediyordu. Stage A uygulandı; Stage B toplam 56; kanıt:
  `docs/work/analysis/level-instance-streams.md`.
- River geniş sahne parçası (17.782 vertex / 9.343 üçgen) ve Showroom
  (11.590 / 7.987) doğrudan çizimlerle görüntüleniyor. Browser'da
  **River · instance prova**, **River · 22 instance** ve
  **River · tüm desteklenen** preset'leri var.
- **T-004 çözüldü (x64 build):** P13 bayat yuvayı `(0,0,*)`, salt `0==0`,
  `epos=-1` olarak isimlendirdi ve trail slot adımının **8 bayt** olduğunu
  ölçtü. `C_Particle_E` x64'te 16 bayt; retail PC 32-bit olduğu için sabit 8
  orada doğruydu. `Manager.cpp:151 → SetElementSize(sizeof(C_Particle_E))`
  ile paired 3+3: baseline 3/3 çökme, düzeltme 6/6 exit 0 (23–24 s); ek koşu
  `Racing → AFTER_THROTTLE → quit` (toplam 7/7). Kanonik `Amax.exe` ve assert değişmedi.
  Kanıt: `docs/work/verification/T-004-slot-stride.md`. TEK-YUVA slot sözleşmesi
  web/wasm portu için açık kalıyor (wasm32'de sizeof zaten 8).
- Doğrulama: `verify_asset_probe.py --skip-build` **28/28**, CTest **14/14**.

## Sıradaki iş

**T-003 Stage A+B tamam:** gruplu AABB birleşimi + cross-chunk bundle;
blok27 22, blok15 12, blok17 2, blok26+32 20 → **56 instance / 34.632 vertex /
25.521 üçgen**. Suite 30/30, CTest 15/15; headless Edge/WebGPU 22/36/56
presetleri console temiz. **Kalan:** blok31 prerequisite, materyaller,
görünürlük, yüksek LOD'lar. Kart:
`docs/work/tasks/T-003-scene-traversal.md`; kanıt:
`docs/work/verification/T-003-stageB.md`.

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
suite `--skip-build` 29/29. Kanıt: `docs/work/verification/T-005c-scheduler.md`.

**T-005c engine dilimi (P14):** `PLATFORM_WEB`/`TL_PLAT_WEB` kimliği kopya
kaynakta 5 düzenleme + 2 tip başlığı; 39 TU'dan 30'u derleniyor
(`jobqueue*` 11→0, `Inflate`, `serialiser` 0). `spike_sched.wasm` 59.140 B;
node'da gerçek iş: `ran=1`, `job_result=42`, `workers=0`, iki koşu bit-birebir.
`Atomic.h` wasm dalı yoktu; 17 fonksiyon `__atomic_*` ile dolduruldu. Kalan:
policy flattening, 5 POSIX kalıntısı, `_vsnprintf_s`, DX11/FX11. Ayrıntı:
`docs/work/analysis/engine-web-shims.md`.

**Overlay yeniden üretilebilir (P14):** `engine/patches/t005c-web-scheduler.patch`
(20 dosya, +681/−35) + `engine/apply_overlay.py`, `verify_overlay.py`,
`native_parity.py`. Taze upstream kopyasında: wasm 60.797 B, A3 4/4, 3/3 abort,
deterministik, **PASS**; PC önişlenmiş TU yalnız log satır numaralarında farklı,
29/29 TU MSVC'de derleniyor. İlk gerçek engine çağırıcısı `C_Deflate`/`C_Inflate`
kuyruk üzerinden çalıştı (`deferred=1`, `equal=1`). A2 grup bağımlılıkları
kapandı (`A` → `AB` → `ABCD`, yalnız hedef grup flush edilerek); `JQ_GROUP_LABEL`
ve `JQ_GROUP_SPURWLOCK` yüksek sesle abort (4/4). Kalan: sahadaki 150 çağrı yeri,
native runtime parity (PC logging zinciri), DX11/FX11. `upstream/` değişmedi.

**T-005b tasarımı:** `Sys::I_FileSystem`/`I_File` + logicalfs/PAK C++'ta kalıyor;
altına `platform/file` C ABI ve OPFS/blob/http range-source registry. İlk dilim
`RangeFile` + PAK/level index parity; eksik aralık açık hata. Kurulum 7,48 GB/
5.113 dosya; River stream 244.682.752 B/359 chunk. Ayrıntı:
`docs/work/analysis/t005-streaming-design.md`.

**T-005b engine dosya katmanı (P16):** `engine/patches/t005b-file-overlay.patch`
scheduler overlay'inin üstüne 4 yeni dosya + 3 web-only düzeltme ekliyor.
`verify_file_overlay.py --fresh` **PASS**: 530.493 B, 61 nesne, 50/50; tam
`C_PakFs` ve `C_OverlayFs` yolları çalışıyor; 3.601 FAT kaydı referansla aynı;
iki dosya (209 B, 131.200 B) + bir dizin (35 çocuk); FNV-1a 64
`2f291abb5648e078`; PC parity. Kalan: yazılabilir katman/`GameHelpers`,
OPFS/worker. Kanıt: `docs/work/verification/T-005b-engine-file-layer.md`.

**T-005d fizibilitesi:** Gravity + RacingPhysics ~70 kLOC; T-005a gate'lerinden
sonra her RacingPhysics simülasyon TU'su 18 hata, Gravity scheduler module
tiplerinde bloke. T-005c sert önkoşul. İlk dilim statik collision-query oracle
(`Level.levelphysics`, `queryHash` native/wasm). Ayrıntı:
`docs/work/analysis/t005-physics-feasibility.md`.

**T-005d D1 tamam (P15):** `Level.levelphysics` formatı kanıtlandı; 44.244
üçgen, thin ray + line-cache + statik küre sorguları (24+24+8). Native/wasm/
Python `queryHash f87365b7…9b5d6e` birebir; 13/13 bozuk girdi reddi; ana suite
29/29. Fat/swept-sphere yok (teker yarıçapı XT), constraint yalnız boş liste.
Kanıt: `docs/work/verification/T-005d-collision-oracle.md`.

**T-005d Gravity wasm (P17):** 8 gerçek Gravity TU'su upstream hâliyle wasm32'de
derlendi (33 nesne, 134.318 B); engine kaynağı değişmedi (patch 0 B). Aynı
sorgularda **ray 24/24 bayt-birebir**; sphere 8/24, cache 1/8 yalnız altı
raporlama alanında farklı. Tam `queryHash` eşitliği yok; verifier izin verilen
farkı pinliyor. Kanıt: `docs/work/verification/T-005d-gravity-wasm.md`.

**T-005d probe v2 (5 Kasım):** `formatVersion 2` engine değerleri ile probe
raporlamasını ayırıyor; native/wasm/Python byte-identical, `queryHash
620eceea…063f` (9.816 B). Gravity v1 dokümanıyla **840 atanmış alan grubu**
eşleşiyor; yalnız engine'in atamadığı `trace.collisionFlags` hariç.
`verify_gravity.py` v2'ye bağlandı: **PASS (v2 field-level)**. Kanıt:
`docs/work/verification/T-005d-collision-v2.md`.

**Renderer stratejisi (4 Kasım):** **E1** kabul edildi — dünya/sahne/çizim
listesi/fizik/yarış durumu wasm'da; WebGPU backend JS'te sürümlü bir render
packet tüketir. E1 "engine renderer'ı atla" değil; DX11 backend + state/shader
katmanını değiştirip sahne/çizim ön yüzünü korur. E2 (DX11 portu) yalnız karar
kapısı düşerse devreye girer. Ayrıntı:
`docs/work/analysis/e1-renderer-strategy.md`.

**E1b tamam (4 Kasım):** packet v1 (`probes/render-packet/`) 102 draw /
43.753 vertex / 46.501 üçgen; River block27 + Corvette; iki koşu bit-birebir;
headless Edge/WebGPU console **boş**; materyaller kimlik, tahmini renk yok.
Kanıt: `docs/work/verification/T-007-render-packet.md`.

**E1a streamer (4–5 Kasım):** `StreamManager` 359/359 chunk, 244.682.752 B,
359/359 FNV bağımsız Python ile aynı. **P22:** `Level.levelrender` artık engine
serialiser'ıyla parse ediliyor — 359 ChunkInfo / 10.784 item / 603 prerequisite,
359/359 alan eşit, cursor 2.464.509 B, tablo hash `aae98142…d36`; 54 TU,
664.137 B, 30/30, PC parity. Kalan: resource block/render list importu
(`Create*Buffer`, render states), `ProcessLoadChunk`, doku/decompression.
Kanıt: `docs/work/verification/T-007-streaming.md`.

**E1c araç fiziği (5 Kasım):** 186 nesne, **1.024.869 B** wasm; gerçek XT
`Corvette_ZR1_Stock` (1600 kg, 2.652 m aks, 0.356 m teker). 480 tick: temas
480/480, NaN 0; hız 0,77 → **31,09 m/s** (tepe 35,13), **96,14 m**; tüm koşu
hash `2bbc0a18…e974f5`; iki koşu bit-birebir. Native sayısal referans DX SDK
yüzünden bloklu; 7 web-only dosyanın MSVC önişlenmiş çıktısı aynı. Kanıt:
`docs/work/verification/T-007-vehicle-physics.md`.

**E1b v1.1 (5 Kasım):** 120 tick dinamik timeline; fixed-step 10/10 senaryo
sıfır toleransla; canlı koşu 90 tick/262 frame; geometri bir kez yükleniyor,
kare başına yalnız uniform + draw; tick 0→90 kayması 190,16 px; console boş.

**E1d/E1e connector (5 Kasım):** `probes/e1-drive/` gerçek araç fiziğini packet
v1.1 ve WebGPU'ya bağladı. 300 tick scripted sürüş: **45,378 m**, hız
0,002→14,986→0,448 m/s, temas 301/301, NaN 0; state hash `83f76590…08e1f` iki
instance'ta aynı; packet 301 tick/103 draw/3.396.616 B. Headless Edge: 742
frame/299 tick, geometri 3 upload, console **0 mesaj**. Sınır: materyaller
diagnostic, yol collision geometrisi, teker çizimi yok. Kanıt:
`docs/work/verification/T-007-e1-drive.md`.

**Çoklu araç (P23):** 5 gerçek araç seçildi (Corvette ZR1, Lotus Exige Cup260,
Dodge Challenger, Focus RS FWD, Audi R8 V10 AWD); 62 XT kaydı 62/62 gate'ten
geçti. Aynı 120/120/60 scriptte 5 ayrı deterministik state hash'i; Corvette
`83f76590…008e1f` T-007 anchor'ıyla birebir. 20 browser capture, console **0**,
geometri 3 upload; 18/20 packet hash birebir, 2'si kamera `atan2` bir-ulp farkı
(state/matris birebir). Sınır: her araç Corvette C3 gövdesiyle çiziliyor, teker
yok. Kanıt: `docs/work/verification/T-007-multi-car.md`.

**Araç parçaları (P26):** Corvette modelinden 29 parça / 80 draw; 76 kanıtlı,
4 yan-belirsiz. 4 teker grubu `+X` ekseninde; lastik tread+sidewall birleşimi
0.000343–0.000648 m; kaliper sabit. Headless Edge console 0, 0→0.9 rad arası
7.149 piksel farkı. Henüz E1 drive packet'ine bağlanmadı. Kanıt:
`docs/work/verification/T-007-car-parts.md`.

**Parça/teker entegrasyonu (P28):** drive packet'i 29 parça / 80 draw ve 9 node
(1 gövde + 4 spin + 4 statik kaliper) kullanıyor; teker açısı fizikten entegre
(tick 300: 148,6 rad). `verify_e1_drive` **202/202**, 5 araçta 301/301 temas,
0 NaN; 20 capture, console 0, geometri 3 upload. Packet 103 draw. Kalan: per-car
mesh, süspansiyon/steer/camber, diagnostic materyaller. Kanıt:
`docs/work/verification/T-007-car-parts-integration.md`.

**Engine draw list (P27):** `Target::Scene` 95 bound draw / 160 other-block
çıkarıyor; 9.343 üçgen / 17.782 vertex; `level_inspect 88/283` ile 95/95 span
eşit; hash `fd525c1452869aee`; 55 nesne, 794.845 B, 46/46, GPU objesi 0.
Instance transformları (`g_mWorld`), materyaller ve dokular henüz yok; packet
v1.1'e bağlanmadı. Kanıt: `docs/work/verification/T-007-streaming.md` §P27.

**Araç başına gövde (P29):** 5 aracın tamamı `root.pak` içindeki kendi
`.model` dosyasına kanıtla eşlendi (Corvette ZR1, Lotus Exige, Dodge Challenger,
Focus RS, Audi R8 V10). Araç başına 84–115 draw, 23–34 parça, 20 teker draw'ı
(8/4/4/4), ayrı gövde mesh hash'i. `verify_e1_drive` **214/214**; 5 araçta
301/301 temas, 0 NaN, console 0; geometri 3 upload. Teker köşe kimliği AABB
kanıtı; simetrik setlerde 10–20 draw `unclassified` (uydurma yok). Kanıt:
`docs/work/verification/T-007-per-car-meshes.md`.

**Engine materyal + transform (P30):** 243 sabit materyal satırı / 26 tip
(121 `g_tAlbedo`, 38 `g_mWorld`); 57/57 instance matrisi, 22/22 bounds
`level_inspect` ile 1e-5 içinde, 57/57 VB/IB ve transform satırı eşleşiyor.
**Packet draw list:** 312 kayıt (255 direct + 57 instance), 117 drawable,
hash `4603a94e0871461c`; 56 nesne, 814.345 B, 65/65, PC parity. Kalan:
blok15/17/26/32 importu, dokular, culling, PoC producer'ına bağlama. Kanıt:
`docs/work/verification/T-007-drawlist-v2.md`.

**Engine 56-instance draw list (P32):** blok15/17/26/27/32 import edildi
(3 chunk, 15 item, 22 VB, 15 IB). **56/57 instance**, **34.632 vertex / 25.521
üçgen**; 56/56 matris ve bounds Stage B okuyucusuyla 1e-5, 57/57 VB/IB.
Packet 312 kayıt / **151 drawable**, hash `96b24f076495aea5`; 56 nesne,
823.931 B, 70/70. Blok31 prerequisite; dokular/culling yok. Kanıt:
`docs/work/verification/T-007-drawlist-56.md`.

**Gerçek yol görseli (P31):** geometry v4, **144 direct draw / 19.167 üçgen**
(block88/node283 + block56/node289 sürüş bölgesi); collision mesh
`visible:false` physics-only. 5 araçta 250–281 draw; 3 geometri upload; console
0; `verify_e1_drive` **231/231**. Drive box'ta 67/314 collision üçgeni gerçek
draw ile kaplı; track sonu/off-road çizilmiyor. Kanıt:
`docs/work/verification/T-007-track-visual.md`.

**T-008 PoC (5 Kasım):** kullanıcı testi hedefi: tek harita (River), **≥4 gerçek
araç**, seçilebilir, WASD + chase camera, sabit adım, console temiz. Kart:
`docs/work/tasks/T-008-browser-poc.md`. Çoklu araç (P23), engine draw-list
(P22) ve Stage B pist (P25) agent'ları çalışıyor; teker/kompozit ve paketleme
sırada.

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

- **56 instance** destekli (Stage A+B); blok31 (1 instance) prerequisite
  bekliyor. CPU vertex expansion var.
- Native sürüş referansı T-004 düzeltmesiyle kararlı (7/7 temiz koşu).
- Araç fiziği wasm'da çalışıyor (gerçek XT, 4 teker teması); renderer ve yarış
  kuralları henüz yok.
- **Fiziksel Chrome testi (4 Kasım): 4/4 geçti** — Corvette 30.591/36.193,
  River 22 instance 13.162/10.308, tüm desteklenen 36 instance 22.924/17.301,
  Showroom 11.590/7.987; console temiz. Stage B sonrası headless: **56 instance /
  34.632 / 25.521**, console temiz. Kalan: blok31, base7–10 stream semantiği,
  level materyalleri/görünürlük/yüksek LOD'lar.
- Oyun verisi ve `_work/` Git dışında; kanıtlar yeniden üretim komutuyla birlikte
  dokümanda tutulmalı.

## Okuma sırası

1. `PLAN.md`
2. Bu dosya
3. `docs/handoff/NEXT.md`
4. `probes/asset-reader/README.md`
5. `docs/setup/native-source-build.md`
6. İlgili görev kartı ve `docs/work/README.md`
