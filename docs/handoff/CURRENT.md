# CURRENT — buradan devam

**Güncelleme:** 6 Kasım 2026
**Aşama:** Aşama 5 (tek oyunculu E1 PoC) — 310 m sprint, **loop-01 3 tur**, **free-roam**, 5 dokulu araç, ghost, **motor sesi**, tarayıcıda test edilebilir.
**Baseline commit:** `04276aa chore: baseline project docs, probes, and tools`
**Son commit'ler:** `39bd1b6` free-roam, `ff8a336` prop colliders, `8ac0109` ghost, `c63d4a4` audio, `777748c` steering.
**KAPANMA/RESUME:** [`RESUME_2026-11-06.md`](RESUME_2026-11-06.md) — kapanış kaydı; P67 sonradan düzeltildi ve commit edildi. Sıradaki: **tam oyun / multiplayer** (`docs/plan/FULL_GAME.md`).

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

**Tam oyun / multiplayer hedefi (7 Kasım 2026):** Plan
`docs/plan/FULL_GAME.md`. İlk kapı **M1: iki tarayıcı, bir harita, mevcut 5
araç, oda → hazır → yarış → sonuç**. İçerik genişlemesi (19 harita, 62 araç,
silahlar/mayınlar/kalkanlar) M0 denetimleriyle başlıyor. Paralel akışlar:
`probes/net-mvp/`, `probes/map-pipeline/`, `probes/vehicle-pipeline/`,
`probes/powerups/`.

**P67 — loop-01 3 tur + prop collision (TAMAM, doğrulandı):**
`?course=lap` P61 `loop-01` (222,04 m) üzerinde 3 turluk yarış. 5 araç
**85,47–86,28 s**, tur süreleri ~28,4–29,2 s, **0 respawn**, replay/restart
birebir; `verify_e1_drive` **838/838**, suite **36/36**, checker 23/23. `all-visible` prop katmanı
tur modunda aktif ve inert (loop-01'de prop yok, 0 temas). Kanıt:
`docs/work/verification/T-007-lap-mode.md`. Sıradaki: `?course=free` (R04).

**P68 — free-roam prop ölçümü (veri hazır):** P66 `all-visible` collider'ları
R04'te ölçüldü: spawn **5,803 m** açık; doğu kanalı (1.321 m²) C03 boru/çit
duvarı yüzünden erişilemez; erişilebilir spawn bileşeni **7.702,25 m²**.
`_work/free-roam-prop/colliders-r04.json` (**431 collider**, %100 kapsama)
üretildi; 29/29 doğrulama, deterministik. Kanıt:
`docs/work/analysis/free-roam-props.md`.

**P69 — free-roam (TAMAM):** `?course=free` — spawn `(-88, 1050)`, **7.702 m²**
bileşen, **431 solid collider** (`colliders-r04.json`, `all-visible`), no
gate/finish/countdown, box containment + spawn reset. 5 araç 401 tick, 0 temas,
0 respawn; `verify_e1_drive` **826/826**, capture **20/20 console 0**, checker
**23/23**. Kanıt: `docs/work/verification/T-007-free-roam.md`.

**P71 — motor sesi entegre:** `e1_engine_rpm()` export'u ile `Engine().RPM()`
kare başına `setRpm`; ilk tuş/click'te AudioContext, `M` mute, `?audio=0`.
`verify_e1_drive` **826/826**, `--mode audio` **16/16** console 0, mute RMS 0.
Kanıt: `docs/work/verification/T-007-audio.md`.

**P72a — prop dokuları (fizibilite):** Görünür yapısal prop'ların tamamı
(fence/pipe/rack/wall/container) **zaten dokulu**. 97 diagnostic track draw'ın
95'i block88 (ekran kapsaması 0), 2'si runtime-only. Gerçek eksik **22 level
instance draw** (10.308 üçgen): reader UV0/material yaymıyor. `expand_instance`
uzatması **18 draw / 10.212 üçgen** için BC1 albedo açabilir (14 görünür).
Kanıt: `docs/work/analysis/prop-textures.md`.

**P73a/P73b — prop dokuları (TAMAM):** Reader 22/22 UV0 + albedo zinciri
export ediyor; **18 draw / 10.212 üçgen** gerçek BC1 albedo + UV0 ile çiziliyor,
4 BC3 draw diagnostic. Tick-120 truck karesi **%37,1** değişti.
`verify_e1_drive` **838/838**, suite 31/31, checker 23/23, `--mode props`
**25/25 console 0**. Kanıt: `docs/work/verification/T-007-prop-textures.md`.

**P74 — görünür yapı collision açığı (veri hazır):** Kullanıcı geri bildirimi
üzerine lap koridorunda **56**, free kutuda **6**, 310 bandında **79** dikey
bileşenin collider'sız olduğu bulundu. V2 manifestleri: `colliders-v2.json`
**651** (553 roadside), `colliders-r04-v2.json` **447** (371 roadside); dikey
yapılar dokusuz olsa da solid, gerçek zemin/overhead hariç. Lap 0/902, free
0/121, 310 roadside 0/1245 bloke. Entegrasyon (P74b) P75 sonrası.

**P75 — doku kalitesi (TAMAM):** Çift gamma (sRGB texel + shader pow) ve mip0
aliasing düzeltildi: `rgba8unorm-srgb`, linear-light mip zinciri, trilinear,
anisotropy 8. 4 karede değişim %91–99,6; packet/fizik hash'leri sabit.
`verify_e1_drive` **838/838**, capture console 0. Kanıt:
`docs/work/verification/T-007-texture-quality.md`.

**V1 — 62 araç denetimi:** **5 A / 42 B / 15 C**. B araçların model+Scene+
materyal+fizik verisi hazır; sürüş dilimine eklenmemiş. Sıradaki 10 araç
manifestlendi; 5 araç guard'ı 4 dosyada sert kodlu (main-agent). Doğrulama
**542/542**. Kanıt: `docs/work/analysis/vehicle-pipeline.md`.

**G1 — yarış mantığı/AI denetimi:** Upstream **481 dosya / 134.941 satır**;
**108 dosya / 26.369 satır** AI çekirdeği object-compile, 324 dosya yeniden
yazılmalı, 41 platform-bound. M1 için 5 modüllü kural katmanı tanımlandı
(RaceDirector, CourseModel, ProgressTracker, RespawnPolicy, ResultModel).
Kanıt: `docs/work/analysis/game-logic-audit.md`.

**M1 — 19 harita denetimi:** **1 A / 16 B / 2 C**. River A; sıradaki üç aday
`usa_amboy` (2.060,6 m, %97,6), `spa_barcelona_gracia` (624,9 m, %99,6),
`usa_la_longbeachdocks` (818,4 m, %47,3). 2 C harita draw kapsaması 0/6,2 m
(instance traversal gerek). Doğrulama **193/193**. Kanıt:
`docs/work/analysis/map-pipeline.md`.

**PWR1 — power-up tanımları:** 11 tip (8 MP), 7 varyant, 439 MP satırı, 86
AmaxEvent; menzil/süre/hasar/onarım/kalkan değerleri gerçek, bilinmeyenler
tipli. Kural prototipi **9/9**, doğrulama **1.783/1.783**. Kanıt:
`docs/work/analysis/powerups.md`.

**R1 — yarış kural katmanı:** `probes/race-rules/` 5 modül + `RaceSession`;
310 m ve loop-01, 2/3/4 oyuncu, **67/67** kontrol, 1.376 replay hash. M1
entegrasyonu için hazır. Kanıt: `docs/work/analysis/race-rules.md`.

**N1 — oda + transport:** `probes/net-mvp/` 22/22 selftest, 21/21 harness
(4 istemci, 30 s, loss/latency/reconnect), 2 iframe browser console 0, aynı
final hash. M1 entegrasyonu için API hazır. Kanıt:
`docs/work/analysis/net-mvp.md`.

**A2 — tyre + collision sesi:** 19 bank/269 wave; 53'ü bağlı (11 tyre loop +
42 impact); kanıtlanmış PLF eğrileri + 18 malzeme tablosu; harness console 0.
Kanıt: `docs/work/analysis/audio-tyre-collision.md`.

**MAP2 — usa_amboy dilimi:** 63.708 collision tri, 2.060,6 m draw'lı yol,
1.606 draw; fizik 61/61 tick 4/4 temas. Dokular 0/1.606, 27 section
unsupported, instance/normal yok. Doğrulama **12.367/12.367**. Kanıt:
`docs/work/analysis/map-slice-amboy.md`.

**AI1 — AI rakip:** 5 araç 310 m + loop-01, 10/10 temiz, 0 respawn; 3 destekli
profil + agresif (1/10 fail); 26/26, 133.068 tick hash; 4 AI sprint/3 AI lap
deterministik. Kanıt: `docs/work/analysis/ai-driver.md`.

**MAP3 — Amboy dokuları:** **1.201/1.606** draw gerçek albedo + UV0
bağlanabilir; reader binding'i çözüyor ama printer `albedoTexture:null` yazıyor.
405 engel: 334 Racification decal, 50 decoder boyutu, 17 BC3 alfa, 4 runtime.
27 section + 366 instance geometri engeli. Doğrulama **13.090/13.090**.
Kanıt: `docs/work/analysis/map-slice-amboy-textures.md`.

**INT1 — M1 online race (TAMAM):** `?mp=1&host=1` / `?mp=1&room=CODE`; oda,
lobby, ready, host start, 310 m River, 20 Hz snapshot, ghost hattıyla uzak araç,
host `RaceSession` otoritesi. `verify_e1_drive` **874/874**; iki tarayıcı
capture console **0/0**, ortak sonuç `0ef78fcb…` (P1 14,667 / P2 16,400 s).
Launcher oda servisini 8811'de açar. Kanıt:
`docs/work/verification/T-007-multiplayer.md`.

**AMB1 — Amboy render paketi:** 1.201 opaque draw (269.300 tri) + 179 doku
(2,65 MB), 334 additive decal ayrı, 71 diagnostic; UV 1.606/1.606 MAP3 ile
aynı; 17.813/17.813, iki build byte-identical. E1 gap: map registry/packet/
upload. Kanıt: `docs/work/analysis/map-slice-amboy-render.md`.

**PWR3 — pickup yerleşimi:** `usa_la_river` MP rotasında **54 PickupPosition**
(8 tip, 26'sı 8 shuffle grubu); 310 m ile örtüşme 0 (en yakın 72,8 m), loop-01'de
2 (1,26/1,80 m). Doğrulama **1.415/1.415**. Kanıt:
`docs/work/analysis/pickup-placement.md`.

**PWR2 — M2 power-up dilimi:** `?mp=1&powerups=1` ile **Mine/Shield/Repair**
host otoriteli; 6 geçici pickup, tek slot, HUD health/shield/feed, 18 olay;
wreck + R1 respawn. Node **68/68**, iki tarayıcı capture PASS, console **0/0**;
suite 44/44. Nitro/Shock/Shunt/Bolt/Barge tipli ertelendi. Kanıt:
`docs/work/verification/T-007-powerups.md`.

**BOOST1 — Nitro fizibilitesi:** `AddForce` `Simulate` öncesi tek güvenli yol;
Nitro hedefi **52,759 m/s** (A), 1,3 s, 55 m/s cap; Shock BRAKE **19,995 m/s**;
Shunt provisional 20 kN·s. Input-only/post-tick reddedildi; baseline shipped
modülle bit-identical. Kanıt: `docs/work/analysis/boost-feasibility.md`.

**V2 — 15 araçlık roster:** 10 B araç eklendi (Audi TT/S3, F100, FR100, Golf,
Mustang GTR, Viper ACR, Bronco, Skyline R34, SoCal HHR); her biri kendi
gövde/doku/ghost/restart ile kanıtlı. `geometry.json` **101,91 MiB** (+%135,5);
batch 2 öncesi chunking zorunlu. **2254/2254**, 60/60 sprint capture console 0,
CTest 15/15, suite 44/44, checker 23/23. Kanıt:
`docs/work/verification/T-007-vehicle-batch1.md`.

**MAP5 — Gracia haritası:** 113.270 collision tri, **88/92 section**, 550.632
tri; yol **624,91 m** (%99,6); **2.627 draw / 365.451 tri** gerçek albedo
(734 doku), 953 engelli. Render paketi 28,8 MB; 26.797 + 32.782 + 45.590
doğrulama. Modül pin politikası behavior-based (61/61 tick hash). Kanıt:
`docs/work/analysis/map-slice-gracia.md`.

**BOOST2 — Nitro + Shock:** `e1_boost_queue`/`e1_boost_state`; Nitro hedefi
52,759 (A) m/s, 1,3 s, 55 cap; Shock 19,995 m/s. Gerçek wasm +18,29 / −14,79
m/s; `?powerups=1` içinde pickup/event/HUD; capture host 10,15→48,49, guest
12,51→48,82 m/s, console 0/0. Boost 31/31, power-up 79/79, suite 48/48.
Kanıt: `docs/work/verification/T-007-powerups.md`.

**PWR4 — projectile verisi:** `PerkForceEffects` 9 satır; Blindfire/Shunt/Barge/
Shock alanları çıkarıldı; **Shock gerçek hasar 50** (minor), Barge 100.
Kural prototipi **19/19**, verifier **888/888**. Eksikler tipli. Kanıt:
`docs/work/analysis/powerup-projectiles.md`.

**P74b — V2 collision entegre:** 310 V2 roadside 553, lap V2 all-visible 651,
free R04-V2 all-visible 447; pin uyuşmazlığında hata. Free beton boru 31 m/s'de
0,001 m'de duruyor (53 temas). `verify_e1_drive` **856/856**; collision 30/30,
free/lap/props capture console 0; checker 23/23.

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

**Kamera occlusion (P36):** görünür mesh'lerden (29.475 tri / 8.191 node) BVH;
her tick `aim → eye` ışını, ilk isabetten 0,4 m öne çekme (pull-in anında,
push-out 0,08/tick). Focus/Dodge/Lotus mid karelerinde araç artık görünür;
`verify_e1_drive` **268/268**; 20 capture console 0. Near-field (<3,4 m) prop
geçişi etiketli, çözülmüyor. Kanıt:
`docs/work/verification/T-007-camera-collision.md`.

**Engine dokuları (P34):** 102/102 statik doku kaynağı decode edildi
(101 BC1 + 1 BC3); 109.808 B descriptor+texel, 628.800 B RGBA; aggregate FNV
`9c5686eed9334ca4`. Asset-reader `texture_inspect --raw` ile **102/102**
isim/hash/boyut/format/RGBA birebir; 56 nesne, 844.802 B, 76/76. Sampling/UV/
mip seçimi yok. Kanıt: `docs/work/verification/T-007-engine-textures.md`.

**Sprint kuralları (P37):** start + 2 checkpoint + finish; gate'ler kaplı yol
bandından türetildi (x −88 → −59; her kolon 61/61 draw + collision). 5 araç
süresi **2,283–3,267 s** (Audi en hızlı, Focus en yavaş); best time
`localStorage`; respawn checkpoint'ten, süre/checkpoint korunuyor.
`verify_e1_drive` **348/348**; 15 sprint capture, console 0. Kalan: tam tur
(kapalı pist gerekir). Kanıt: `docs/work/verification/T-007-sprint-rules.md`.

**Engine 57/57 (P38):** blok31 chunk96 prerequisite grafiği çözüldü
(14 chunk, 15.079.424 B, hash `116a3286acb5f6c0`); **57/57 instance / 35.386
vertex / 26.077 üçgen** tam node referansıyla birebir. 57/57 bounds-253 ve VB/IB
eşit; packet 312 kayıt / 152 drawable, hash `7c29fb2ec7769709`; 56 nesne,
849.609 B, 80/80. Kanıt: `docs/work/verification/T-007-drawlist-57.md`.

**Telemetri (P39):** 5 araç için 0–50/0–100, fren mesafesi, yanal grip ve yaw
ölçüldü. 0–100 sırası XT `torqueScale/mass` sırasıyla birebir: Audi 2,650 s →
Corvette 3,650 → Lotus 3,833 → Dodge 4,633 → Focus 5,133. `verify_e1_drive`
**423/423**; 5 telemetri capture, console 0. Sınır: 86 m bant, Vmax değil.
Kanıt: `docs/work/verification/T-007-telemetry.md`.

**Reset düzeltmesi (P40):** `C_Scene` scheduler group handle'ları hiç
oluşturulmuyordu; `Flush` stale `m_Group` ile pool'a erişiyordu. Build/release
yollarına `CreateGroup`/`DestroyGroup` eklendi (engine değişmedi). Tek
instance'ta **10+ rebuild**, 5 araç × 10 = 50 rebuild aynı state hash'i; heap
sabit 268.435.456 B; telemetri tek instance; `R` yerinde restart.
`verify_e1_drive` **488/488**; console 0. Kanıt:
`docs/work/verification/T-007-reset-fix.md`.

**P42 soak:** 18.000 tick / 5 sim-dk, iki koşu; frame p95 8,06 ms,
CPU işi p95 0,59 ms, 0 frame >16,7 ms; heap 268.435.456 B sabit; GPU buffer
208 create/200 destroy/8 live; console **0**, abort 0; 38 checkpoint iki koşuda
aynı. Kanıt: `docs/work/verification/T-007-soak.md`.

**Pist koridoru (P41) ve sınırı (P43/P46):** 539,81 m draw-coverage hattı
ölçüldü (6 section, 299 draw / 47.790 üçgen; %99,73). **Ancak bu bir parkur
değil:** ölçülen çizgi 57,82 m'de 50 m'lik collision duvarından geçiyor; şasi
52,7–53,4 m'de duruyor. Proxy lift (0,10 m) ölçüldü, varsayılan yapılmadı.
Oynanabilir sprint **29 m** kaldı; 540 m görsel `?survey=1` ile etiketli.
Kanıt: `docs/work/verification/T-007-ledge-fix.md`,
`docs/work/analysis/track-coverage.md`.

**Engine track sections (P44):** 6 section engine draw list'inde **299 draw /
47.790 üçgen / 78.712 vertex**; bounds 6/6 1e-5, primitive offset 299/299 eşit;
packet hash `8b3a40324410327f`; 2 runtime-only materyal `null` + neden; 56 nesne,
859.568 B, **88/88**, PC parity. Kanıt:
`docs/work/verification/T-007-drawlist-track.md`.

**Track UV/binding (P45):** 299/299 draw UV0 çözüldü (292 F16_4, 7 F16_2;
aggregate `2ed1f4b0b3c9148e`); asset-reader `level_mesh` UV0 ile 299/299
bit-birebir. Binding 297 statik / 2 runtime-only; 151 draw 40 P34 dokusunda,
146 draw 96 çözülmemiş blokta (blok/öğe kayıtlı); aggregate `70237f9bb7f0a20c`;
56 nesne, 870.155 B, **92/92**. Kanıt:
`docs/work/verification/T-007-uv-binding.md`.

**Track dokuları (P47):** kalan 96 blok decode edildi; registry **198**
(102 P34 + 96 track); **297/297 statik binding** çözüldü, 2 runtime-only;
track aggregate `8d91645d4ee00831`, binding `9cc08756505dd497`; 96/96
asset-reader ile birebir; 56 nesne, 872.798 B, **99/99**. Kanıt:
`docs/work/verification/T-007-track-textures.md`.

**Gerçek sürülebilir yol (P48):** collision mesh üzerinde (draw coverage değil)
**310,395 m** parkur: spawn → (103.5,1292.5), 1.245 örnek; max basamak 1,55 cm,
max 2 m eğim %3,09, duvara min 7,78 m; 621 engine trace 0 ihlal, 8/8 bağımsız
doğrulama. Bitişten 4 m sonra yüzey 2,0 m'ye daralıyor. Sıradaki: 310 m sprint
entegrasyonu; 29 m regression control. Kanıt:
`docs/work/analysis/drivable-path.md`, `probes/drivable-path/`.

**Dokulu pist (P49):** 394 draw'dan **297**'si gerçek albedo + P45 UV0 ile
sample ediliyor (136 doku / 439.360 B RGBA); block88'de 95 draw binding row
olmadığı için diagnostic, 2 runtime-only. `verify_e1_drive` **522/522**;
20 capture console 0; soak'ta texture leak yok. Kanıt:
`docs/work/verification/T-007-textured-track.md`.

**310 m görsel kapsama (P51):** parkurun **%100**'ü `g56-n289` ile çizili
(1.245/1.245; 8 draw / 939 üçgen; visual–collision −0,92…+0,93 mm; 16,1–24,2 m
genişlik). Yeni section/upload gerekmiyor. Sıradaki: 310 m sprint entegrasyonu.
Kanıt: `docs/work/analysis/drivable-path.md` §9.

**Araç materyalleri (P52):** 5 araç için 491 draw'dan **224'ü** statik albedo +
UV0 ile eşleşti; **40 doku** decode edildi (18.178.048 B RGBA); 40/40
asset-reader ile birebir; 267 draw runtime-only (45 paint, 66 light blend,
156 no-albedo). Henüz sürüş packet'ine bağlanmadı (gövde diagnostic).
Kanıt: `docs/work/analysis/car-materials.md`.

**310 m oynanabilir sprint (P50):** varsayılan parkur artık 310,395 m
collision-clean course; start + 2 checkpoint (~100/200 m) + finish ~300 m.
5 araç bitiriyor: Audi **14,15 s**, Corvette 14,65, Lotus 14,77, Dodge 14,92,
Focus 15,22. 29 m `?course=short`. `verify_e1_drive` **550/550**; sprint/short/
restart/respawn/survey capture console 0. Kanıt:
`docs/work/verification/T-007-310m-course.md`.

**Engine packet (P54):** 451 draw / 35 mesh / 252 materyal; 2.246.207 B,
hash `0e57f1e5…baba8`; UV 299/299, 297 statik doku; 83.210 üçgen / 131.880
vertex. Render-packet v1.1 şemasına karşı 8 ihlal / 4 not (timeline yok,
topology strip, engine-buffer, null geometry) — producer hazır, tüketici için
dönüşüm gerekli. Kanıt: `docs/work/verification/T-007-engine-packet.md`.

**Araç dokuları (P55/P59):** 5 araçta 491 draw'dan **224'ü** gerçek albedo + UV0
ile dokulandı (50/48/42/37/47); 40 doku / 18.178.048 B RGBA; 267 draw
diagnostic (45 paint, 66 light, 156 no-albedo). Sampling **`(1-u, v)`** (P59;
plakalar/decal'lar düz okunuyor). `verify_e1_drive` **570/570**; 20 capture
console 0; soak temiz. Kanıt:
`docs/work/verification/T-007-car-uv-orientation.md`.

**Paint/light refs (P60):** 267 runtime draw'da **424** statik `TEXTURE_INDEX`
alanı çözüldü; 24/29 doku decode (5 shared 1024² sınır dışı). Paint lookup ve
light blend runtime — renk uydurulmadı. 30/30 suite. Kanıt:
`docs/work/analysis/car-materials.md` §9.

**Kapalı tur (P61):** collision mesh üzerinde üç loop bulundu; önerilen
**loop-01 222,0 m**, min duvar 2,06 m, bant 11,75 m, seam 0,5 m; engine trace
PASS (0 ihlal). Spawn bileşeninden 1,118 m duvar boşluğu var; lap modu loop
üzerinde spawn etmeli. Kanıt: `docs/work/analysis/lap-search.md`,
`_work/lap-search/loops.png`.

**Ses fizibilitesi (P62):** `race_v8.baf` uADPCM4Bit 48 kHz; altı motor
loop'u decode edildi; RPM→gain/pitch retail `.dat` eğrileriyle birebir; harness
headless Edge'de **decoded-audio-playing-and-curves-match**, console 0.
Sıradaki: E1 motor sesi entegrasyonu. Kanıt:
`docs/work/analysis/audio-feasibility.md`.

**Ghost/rival (P63):** her araç için temiz biten koşu (veya committed reference
trace) 44 B/tick kayıt olarak saklanıyor; hayalet araç aynı mesh'ten ikinci
pipeline ile çiziliyor, çarpışma/fizik yok, ek upload yok. `G` aç/kapa,
`?ghost=1`; HUD `Δt/Δd`. `verify_e1_drive` **678/678**; 5 capture console 0.
Kanıt: `docs/work/verification/T-007-ghost.md`.

**Prop collision (P66):** görünür mesh'lerden **468 statik OBB** (373 roadside
aktif, 95 on-course hariç). Resolver: 2.98×1.68 m car OBB, SAT push-out,
μ=0.45, 7 substeps @31 m/s; head-on 0.001 m gap, glancing %96 teğetsel,
0 tunneling. **310 m hattı dört kümede prop kesiyor**; all-visible hattı
kapatıyor. Lap-01 entegrasyonu P67'de. Kanıt:
`docs/work/analysis/prop-collision.md`.

**Free-roam (P65):** spawn havzası **R04 9.689,5 m²**, %100 `g56-n289` ile
çizili; 310 m hattının ~2,3 katı, %56,6’sı hattın 12 m dışında. R01 17.618 m²
ama 3,50 m/100 m duvarla erişilemez; R03 14,98 m void. Öneri: `?course=free`,
koridor respawn'ı kapalı. Kanıt: `docs/work/analysis/free-roam.md`,
`_work/free-roam/free-roam.png`.

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

**Wire layout (P56):** native MSVC x64 vs wasm32 ölçüldü: `BaseProfile`
56 → 80 B, `StartRace` 2104 → 2584 B; `-fshort-wchar` çözüm değil (Itanium
dsize kuralı; 48 B / 1944 B). Öneri: `BaseProfile`/`StartRace` için açık
encoder, golden layout native sayıları (56 B, isim @16, 17 UTF-16LE; 2104 B,
20 slot). Kanıt: `docs/work/analysis/net-layout.md`.

**PoC kontrolü (P57):** `tools/check_e1_poc.py` 19/19 PASS: modül/glue,
geometry v6, levelphysics, spawn, 310 m + 29 m layout/runs, 5 araç, UV/doku
manifestleri, sayfa ve 8801 sunucusu. Kullanıcı checklist’i:
`docs/handoff/E1_POC_TEST.md`.

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
