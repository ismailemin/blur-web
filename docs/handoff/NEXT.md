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

- **Stage A:** tek-chunk grupları → blok27 22/22, blok15 12/12, blok17 2/2 =
  36 instance / 22.924 vertex / 17.301 üçgen.
- **Stage B:** blok26+32 chunk'lar arası gruplar → toplam 56 instance /
  34.632 vertex / 25.521 üçgen.
- Blok31 prerequisite; materyaller/görünürlük/yüksek LOD'lar ayrı.
- Kabul: native/WASM/Python grup-eşitliği, bozuk grup/byte-identity reddi,
  regresyonsuz suite. "Tam pist" iddiası yok.

## 2. T-004 — Native particle-cache izi

**Durum:** tam bellek dump'ı alındı ve analiz edildi; kaynak çağrı/efekt kimliği açık
**Rapor:** `docs/work/analysis/native-particle-crash.md`

Tam dump + çağrı izleme + kaynak analizi kök nedeni gösterdi:
- Emitter ile trail elemanı arasındaki bağ tek yönlü; sahiplik `iSalt` nesil sayacıyla yürüyor.
- `m_iSalt` yalnızca senkron `C_EmitterList::Free` içinde artırılıyor; ertelenmiş `C_Emitter::AtomicFree` / `AtomicActiveCache::AtomicFree` / drenaj `Free` salt'a dokunmuyor.
- `FreeParticle` X'i ertelenmiş yolla bıraktıktan sonra drenaj `Free` ediyor; salt artmadığı için aynı X'e işaret eden trail elemanı sonraki karede `iSalt == GetSalt()` (0==0) görüp X'i yeniden kuyruğa atıyor; ikinci `Free` invariant'ı tetikliyor.
Açık: düzeltme uygulanmadı; iki deneme reddedildi. (1) `C_Emitter::AtomicFree` kuyruk girişinde salt artışı: 1/3 exit0, 2/3 `0xC0000005`. (2) drenajı `C_EmitterList::Free` üzerinden yapmak: 3/3 `0xC0000005`. Her iki deneme de geri alındı; patch'ler `native-saltfix-attempt.patch` ve `native-drainfix-attempt.patch`. Üçüncü deneme (`DeleteTrailBlock` temizliği, `native-trailfix-attempt.patch`) 1/3 orijinal breakpoint, 2/3 `0xC0000005` verdi; o da geri alındı. Bulgu: gözlenen çift-free `FreeParticle`/`Emitter::Update` yolundan geliyor; `DeleteTrailBlock` bu yolu kapsamıyor. Asıl açık trail elemanının `pEmitter` alanını kimin geçersiz kıldığı. Sıradaki: (a) sahiplik kuralını kaynakla yazılı sözleşmeye dönüştürmek, (b) Aday 2 trail-owned bayrağını tam dump'lı koşuyla denemek. Assert kaldırılmayacak.

**P3 Aday 2 sonucu:** object-level “trail-owned” bayrağı çökme için kanıtlanabilir şekilde no-op (2a) veya sızıntı (2b): trail tanımları `bRepeating=true` olduğu için self-free yolları trail-owned emitter'da hiç ateşlenmiyor; asıl üretici `FreeParticle → AtomicFree` etkilenmiyor. Bu yüzden object flag bırakıldı; sıradaki doğru yön **slot-level** sahiplik/temizlik: `FreeParticle`/`UpdateTrail` sırasında aynı emitter'a işaret eden trail slotunu geçersiz kılan yolu bulmak. Ayrıntı: `docs/work/analysis/emitter-ownership-next.md`.

## 3. T-005 — Tek oyunculu dikey dilim

**Durum:** in-progress; T-005a/b/c/d tasarım tamam, uygulama sırada
**Kart:** `docs/work/tasks/T-005-single-player-vertical-slice.md`
**T-005a kanıtı:** `docs/work/analysis/engine-wasm-probe.md`
**T-005b tasarımı:** `docs/work/analysis/t005-streaming-design.md`
**T-005c tasarımı:** `docs/work/analysis/t005-scheduler-design.md`
**T-005d fizibilitesi:** `docs/work/analysis/t005-physics-feasibility.md`

T-005a motor/WASM/platform fizibilitesi → T-005b streaming → T-005c scheduler →
T-005d fizik → T-005e kontroller/kamera → T-005f ses/UI/save → T-005g tam yarış
kabul testi. Multiplayer bundan sonra. İlk adım: en küçük motor alt kümesini
wasm32'ye derleyip gerçek bağımlılık/engel listesini çıkarmak.

## 4. T-006 — Tarayıcı multiplayer

**Durum:** analiz; T-006a/b tamam, T-006c sürüyor
**Kart:** `docs/work/tasks/T-006-multiplayer.md`
**Kanıt:** `docs/work/analysis/t006-native-lan.md`, `docs/work/analysis/t006-wire-format.md`

T-006a: PC LAN auth'suz; host/peer `CreateLanSession`/`JoinLanSession`,
keşif UDP **50001**, oyun UDP **3074-3173**, `Network.BuildVersionToJoin`
eşleşmeli. **İki istemci aynı makinede çalışmaz**: keşif `INADDR_ANY:50001`
üzerine `SO_REUSEADDR` olmadan bind ediliyor; iki fiziksel makine gerekli.
Paket payload'ı DTLS'li; pcap yalnız başlık/seq/size verir. B1 kabulü iki
makineli LAN lobisi + pcap/CSV; 10s `Racing` B1b, T-004 çökmesi nedeniyle ayrı.

T-006b: wire format aslında struct ABI (`memcpy(sizeof(struct))`); en büyük risk
`wchar_t` (MSVC 2, wasm32 4) ve padding/bitfield. Golden byte'lardan önce
native/WASM layout probe gerekli. P0 paket seti ve fixture planı hazır.

T-006c tamamlanınca transport kararı netleşecek. T-006e/f gerçek iki tarayıcı
yarışı T-005g ve T-004 kapılarına bağlı.
