# NEXT — sıradaki görevler

Sıra bağlayıcıdır. Bir görev kapanmadan sonraki kod görevine geçilmez.

## 1. T-003 — Scene/level kapsamını genişletme

**Durum:** in-progress (bounds grouping kanıtlandı; Stage A sırada)
**Kart:** `docs/work/tasks/T-003-scene-traversal.md`
**Kanıt:** `docs/work/analysis/level-instance-streams.md`

İlk iki artım: blok27 **14 instance**, blok15 +4 → **18 instance**. P2 analizi
`instanceBounds` kayıtlarının draw başına değil **CullNode (yerleştirilmiş nesne)
başına** olduğunu gösterdi: 57 instance, 34 transform-sabit grubuyla 34
byte-identical kayda karşılık geliyor; grup AABB birleşimi kayıtla
`6.024437e-05` içinde. Mevcut kontrol tek draw'ı tüm nesne kaydıyla
karşılaştırdığı için 38 instance'ı yanlışlıkla reddediyor.

Sıradaki:

- **Stage A tamam (2 Kasım):** blok27 22, blok15 12, blok17 2 = **36 instance /
  22.924 vertex / 17.301 üçgen**; native/WASM eşit, suite 29/29, headless
  WebGPU görseli console temiz. Kanıt: `docs/work/verification/T-003-stageA.md`.
- **Stage B:** blok26+32 chunk'lar arası gruplar → hedef toplam 56 instance /
  34.632 vertex / 25.521 üçgen.
- Blok31 prerequisite; materyaller/görünürlük/yüksek LOD'lar ayrı.
- Kabul: native/WASM/Python grup-eşitliği, bozuk grup/byte-identity reddi,
  regresyonsuz suite. "Tam pist" iddiası yok.

## 2. T-004 — Native particle-cache çökmesi

**Durum:** çözüldü (x64 build); web/wasm slot sözleşmesi açık
**Kart:** `docs/work/tasks/T-004-native-particle-crash.md`
**Kanıt:** `docs/work/verification/T-004-slot-stride.md`,
`docs/work/analysis/emitter-slot-trace.md`

Kök neden: `Manager.cpp:151` trail slotunu sabit **8 bayt** kuruyordu; retail PC
32-bit olduğu için `sizeof(C_Particle_E)==8` idi. Bu x64 build'de sınıf 16 bayt:
`iSalt` komşu `pEmitter`'a yazıyor, copy-last 8 baytlık adımın üzerine kopyalıyor.
P13 üç koşuda bayat yuvayı `(0,0,*)`, salt `0==0`, `epos=-1` olarak isimlendirdi.

Düzeltme: `SetElementSize(sizeof(C_Particle_E))`. Paired 3+3: baseline 3/3
çökme (2 breakpoint + 1 AV), düzeltme 6/6 exit 0 (ek kanıt koşusuyla 7/7); koşu
`Racing → AFTER_THROTTLE → quit`. Kanonik `Amax.exe` ve `Atomic.h` assert'i
değişmedi. wasm32'de sizeof zaten 8 olduğu için düzeltme orada no-op.

Kalan: TEK-YUVA sahiplik sözleşmesi (`emitter-slot-ownership.md`) web portu için
uygulanmadı; 3/3 temiz koşu resmî ispat değil.

## 3. T-005 — Tek oyunculu dikey dilim

**Durum:** in-progress; T-005a/b/c/d tasarım tamam; T-005c engine scheduler ve
T-005d collision oracle kod dilimleri tamam
**Kart:** `docs/work/tasks/T-005-single-player-vertical-slice.md`
**T-005a kanıtı:** `docs/work/analysis/engine-wasm-probe.md`
**T-005b tasarımı:** `docs/work/analysis/t005-streaming-design.md`
**T-005c kanıtı:** `docs/work/analysis/t005-scheduler-design.md`,
`docs/work/analysis/engine-web-shims.md`
**T-005d kanıtı:** `docs/work/analysis/t005-physics-feasibility.md`,
`docs/work/analysis/t005-collision-oracle.md`

T-005a motor/WASM/platform fizibilitesi → T-005b streaming → T-005c scheduler →
T-005d fizik → T-005e kontroller/kamera → T-005f ses/UI/save → T-005g tam yarış
kabul testi. Multiplayer bundan sonra.

P14: `PLATFORM_WEB` kimliğiyle 30/39 TU derleniyor; `spike_sched.wasm` 59.140 B
ve node'da `ran=1 / job_result=42 / workers=0`. Kalan: policy flattening,
POSIX kalıntıları, DX11/FX11.

P14 overlay: `engine/patches/t005c-web-scheduler.patch` + apply/verify/native
araçları. Taze upstream kopyasında 64.073 B modül, A2/A3/A4 + 4/4 abort, PASS;
PC preprocessed TU yalnız log satırlarında farklı, 29/29 TU MSVC. İlk gerçek
çağırıcı `C_Deflate`/`C_Inflate` (`deferred=1`, `equal=1`). Sıradaki: sahadaki
150 çağrı yeri + streaming/layer-manager sistemi.

P15: `Level.levelphysics` kanıtlandı; native/wasm/Python `queryHash` birebir.
Kalan: fat/swept-sphere (teker yarıçapı XT), constraint'ler, engine entegrasyonu.

P17: 8 gerçek Gravity TU'su wasm32'de; 33 nesne, 134.318 B, ray 24/24
bayt-birebir; sphere/cache farkı altı raporlama alanıyla sınırlı ve pinli.
Kalan: probe formatVersion 2, level streamer bağlantısı, araç ray/wheel yolu.

P16: `engine/patches/t005b-file-overlay.patch` (4 yeni dosya + 3 web fix) scheduler
overlay'i üstünde `Sys::I_File` + `pf_*` C ABI; `verify_file_overlay.py --fresh`
PASS (530.493 B, 50/50, tam `C_PakFs` + `C_OverlayFs`, PC parity). Kalan:
yazılabilir katman/`GameHelpers`, OPFS/worker.

**Renderer:** E1 kabul edildi. Engine simülasyonu + sahne/çizim listesi wasm'da,
WebGPU backend JS'te sürümlü render packet tüketir. Packet v1 sözleşmesi, sahne
closure'ı, araç debug çizimi ve chase camera sıradaki adımlar. E2 (DX11 portu)
karar kapısına bağlı. Ayrıntı: `docs/work/analysis/e1-renderer-strategy.md`.

## 4. T-006 — Tarayıcı multiplayer

**Durum:** analiz tamam (a/b/c); uygulama T-005g/T-004'e bağlı
**Kart:** `docs/work/tasks/T-006-multiplayer.md`
**Kanıt:** `docs/work/analysis/t006-native-lan.md`, `t006-wire-format.md`, `t006-transport.md`

T-006a: PC LAN auth'suz; host/peer `CreateLanSession`/`JoinLanSession`,
keşif UDP **50001**, oyun UDP **3074-3173**, `Network.BuildVersionToJoin`
eşleşmeli. **İki istemci aynı makinede çalışmaz**: keşif `INADDR_ANY:50001`
üzerine `SO_REUSEADDR` olmadan bind ediliyor; iki fiziksel makine gerekli.
Paket payload'ı DTLS'li; pcap yalnız başlık/seq/size verir. B1 kabulü iki
makineli LAN lobisi + pcap/CSV; 10s `Racing` B1b, T-004 çökmesi nedeniyle ayrı.

T-006b: wire format aslında struct ABI (`memcpy(sizeof(struct))`); en büyük risk
`wchar_t` (MSVC 2, wasm32 4) ve padding/bitfield. Golden byte'lardan önce
native/WASM layout probe gerekli. P0 paket seti ve fixture planı hazır.

T-006c: `bdSocketRouter`/`bdNet` altına WebRTC backend; engine association
başına `RTCPeerConnection`, reliable ordered + unreliable `maxRetransmits:0`
DataChannel; `C_NetRouterBase` ve oyun protokolü byte-identical. İlk dilim
standalone adapter harness. WSS signaling/STUN/TURN gerekli. Analiz tamam;
uygulama T-005g/T-004 kapılarına bağlı.

## 5. T-007 — E1 oynanabilir dikey dilim

**Durum:** in-progress; E1a streaming, E1b render packet ve E1c araç fiziği
spike'ları paralel çalışıyor
**Kart:** `docs/work/tasks/T-007-e1-playable-slice.md`

E1 kararı: motor simülasyonu + sahne/çizim listesi wasm'da; JS/WebGPU sürümlü
render packet tüketir. E1b (packet v1.1), E1c (araç fiziği) ve E1d (fixed-step +
girdi + chase camera) tamam. E1 connector: 300 tick scripted sürüş, 45,378 m,
temas 301/301, console 0; packet 301 tick/103 draw. E1e kısmi: `draws[]` hâlâ
committed packet'ten, materyaller diagnostic, teker çizimi yok. E1a streamer
359/359 ve **engine `levelrender` parse'ı tamam (P22)**; kalan resource
block/render list importu. Sıradaki: engine draw-list + kamera + teker; sonra
E1f tam tur. E2 yalnız karar kapısı düşerse.

## 6. T-008 — Tarayıcı PoC

**Durum:** in-progress
**Kart:** `docs/work/tasks/T-008-browser-poc.md`

Hedef: tek URL, River haritası, ≥4 gerçek araç seçimi, WASD + chase camera,
sabit adım, console temiz. Çalışan agent'lar: P23 (çoklu araç), P22 (engine
draw-list), P25 (Stage B pist). Sırada: teker/kompozit görsel, PoC paketleme ve
`docs/handoff/E1_POC.md` kullanıcı kılavuzu.
