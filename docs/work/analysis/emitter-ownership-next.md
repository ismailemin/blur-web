# Emitter sahipliği — aday 2 ("trail sahipli" işareti) tasarımı

**Durum:** salt okunur kaynak analizi; hiçbir kaynak derlenmedi/değiştirilmedi, oyun
çalıştırılmadı. Bu belge bir **düzeltme iddiası taşımaz** ve `Atomic.h:315-316`
assert'inin kaldırılmasını/zayıflatılmasını önermez.
**Tarih:** 2 Kasım 2026
**Kaynak:** `_work/native-source/Blur1PCDX11` (temel çizgi; `git status` bu ağaçta
temiz), `docs/work/analysis/native-particle-crash.md` (SC1-SC10, M1-M8, D/E serisi).

## 0. Kısa hüküm (önce okunmalı)

Aday 2, **sözleşme olarak tutarlı** (kural B: "trail elemanı emitter'ı sahiplenir"),
**ama gözlenen çökme için kanıtlanabilir biçimde etkisizdir.** Gerekçe tek bir
kaynak zincirine dayanır:

1. Trail tanımları yalnızca `SuperEffect.cpp:30-38` içinde üretilir ve orada
   `bRepeating = true` **zorlanır** (`SuperEffect.cpp:35`), süre de
   `fDuration = 2.139e9` yapılır (`:36`).
2. Spawn tam bu nesneyi bağlar: `SuperSpawn.cpp:25` ve `:46` →
   `SetDefinition(&trailEffects[..].definition)`; `SetDefinition`
   (`Emitter.cpp:93-116`) yalnızca işaretçiyi saklar (`:100`), `bRepeating`'e dokunmaz.
3. `C_Emitter::Update` içinde kendini bırakma **yalnızca** `bRepeating == false`
   dalındadır (`Emitter.cpp:478-499`; bırakma `:492-493`, `m_bDelete = true` `:495`).
4. `m_bDelete` yazan tek "true" noktası `:495`'tir (diğer ikisi `:74` ve `:112`,
   ikisi de `false`). `:257-261`'deki self-free bu bayrağa bağlıdır.

⇒ **Trail sahipli bir emitter, sahipli olduğu sürece `:492-493` ve `:495`'e
ulaşamaz.** Dolayısıyla "trail-owned ise self-free'yi atla" koruması, bayrak
`true` iken hiç ateşlenmez. Bayrak `false` olduğunda (emitter trail dışı bir
kullanıma geri döndüğünde) ise koruma devre dışıdır.

Trace'teki self-free (C3, satır 225) bu yüzden **trail sahipli bir emitter'a ait
olamaz**: o anda tanımı yinelenmeyen (death/collision) bir tanımdır, yani emitter
trail görevinden geri dönüştürülmüştür ve onu tutan trail yuvası **bayattır**.
Kalan üretici `FreeParticle` (`SuperEffect.cpp:229`) aday 2'nin dokunmadığı yoldur.

Sonuç: aday 2'nin iki tutarlı biçimi vardır ve ikisi de işe yaramaz —
**2a** (bayrağı `SetDefinition`'da sıfırla) kanıtlanabilir **no-op**;
**2b** (hiç sıfırlama) **sızıntı** üretir. Aşağıdaki tasarım yine de tam olarak
verilmiştir, çünkü (i) sözleşmeyi yazılı hâle getirir, (ii) ölçülebilir bir
yanlışlama testi tanımlar, (iii) ileride trail tarafı düzeltildiğinde
kullanılabilecek tek noktayı belirler.

## 1. Kural B ve aday 2

- **Kural B:** emitter'ı yalnızca onu tutan trail elemanı/bloğu bırakır
  (`FreeParticle`, `DeleteTrailBlock`, `I_ParticleSuperEffect::Free`).
- **Aday 2:** `C_Emitter` üzerinde "bu ayırım trail sahipli" bayrağı; bayrak
  setliyken emitter **kendi kendini bırakmaz**, bırakma yalnızca trail
  yollarından gelir.

Bugünkü çelişki: `UpdateEmitters(m_SuperEffectEmitters, ...)`
(`Manager.cpp:1340`) süper emitter'ları da günceller ve `C_Emitter::Update`
kendini bırakabilir (R3/R4). Aday 2 bu ikinci sahibi devre dışı bırakmayı amaçlar.

## 2. Alan ve başlatma noktaları (tam)

| # | Yer | Değişiklik |
| --- | --- | --- |
| F1 | `include/dynamic/particle/Emitter.h` — sınıfın **sonuna**, `m_CreateNode` (`:306`) sonrası | `bool m_bTrailOwned;` |
| F2 | `source/particle/Emitter.cpp:68-90` (`SetDefaults`) — `m_bDelete = false;` (`:74`) yanına | `m_bTrailOwned = false;` |
| F3 | `source/particle/Emitter.cpp:93-116` (`SetDefinition`) — `m_bDelete = false;` (`:112`) yanına | `m_bTrailOwned = false;` (yalnız 2a) |
| F4 | `source/particle/SuperSpawn.cpp:22-27` (`NewParticle`) — `SetDefinition` (`:25`) **sonrası** | `pTrailParticle->pEmitter->SetTrailOwned(true);` |
| F5 | `source/particle/SuperSpawn.cpp:43-48` (`NewParticles`) — `SetDefinition` (`:46`) sonrası | aynı |
| F6 | `include/dynamic/particle/Emitter.h` — `SetTrailOwned/IsTrailOwned` erişimcileri (`:144` civarı, `SetActive` yanına) | inline setter/getter |

**Yerleşim uyarısı (kanıta dayalı):** bayrak `m_bDelete` (`Emitter.h:279`) yanına
konursa `m_iIndex` (`:280`) 4 bayt kayar ve `m_pManager`/`m_pEventInstance`/
`m_pEmitterList` ofsetleri (`+0x188/+0x190/+0x198`, rapor S2) değişir; bu, dump
araçlarının (`_work/analysis/full-exit-dump/*`) okuduğu ofsetleri bozar. Bu yüzden
F1 **sınıf sonuna** taşınmıştır ve `sizeof(C_Emitter)` ile `offsetof` üzerinde
derleme zamanı kontrolü (`static_assert`) ile doğrulanmalıdır. Not: `m_VectorPosition`
(`+0xB0`) taban sınıfta olduğu için her iki durumda da etkilenmez.

**Neden `SetDefaults`:** iki havuz kurucusu da (`Manager.cpp:296`, `:308`) önce
`SetDefaults()` çağırır (`Emitter.cpp:45`, `:55`); ayrıca `SetDefinition` her yeni
kullanımda çağrılır (`Event.cpp:94`, `SuperSpawn.cpp:25,46`, `SuperEffect.cpp:300,
319,359,389,453,472,508,538`). Sıfırlama `SetDefinition`'da **olmak zorundadır**:
aksi hâlde trail'den geri dönüştürülen bir emitter (death/collision) sonsuza kadar
"trail sahipli" kalır (bkz. §5, 2b).

## 3. Atlanması gereken self-free yolları

| # | Yer | Bugünkü davranış | Aday 2 |
| --- | --- | --- | --- |
| S1 | `Emitter.cpp:257-261` (`if(m_bDelete) AtomicFree`) | ertelenmiş self-free | bayrak setliyse **atlanır**; `m_bDelete` de temizlenir |
| S2 | `Emitter.cpp:492-493` (`m_nNumEmit == 0` → `AtomicFree`) | ertelenmiş self-free | bayrak setliyse **atlanır** |
| S3 | `Emitter.cpp:495` (`m_bDelete = true`) | sonraki karede S1'e girer | bayrak setliyse **yazılmaz** |
| S4 | `Manager.cpp:772-779` (`CleanEmitterDefinition`, süper liste) | senkron `Free` | **atlanmaz** (self-free değil; tanım sahibi temizliyor). Salt artar (`emitterlist.cpp:24`) → trail yuvası bir sonraki dokunuşta NULL'lanır |
| S5 | `Emitter.cpp:158-168` (`C_Emitter::Free`) | senkron `Free` | **değişmez**; çağıranları yalnız `m_Emitters` üzerinde çalışır (`Manager.cpp:785-792, 810-815, 1102-1106`; `EventInstance.cpp:301-305`) |
| S6 | `EventInstance.cpp:310-319` (`C_EventInstance::Free` → `:315 AtomicFree`) | ertelenmiş, event sahipli | **dokunulmaz**; süper emitter'larda `m_pEventInstance == NULL` (`SuperSpawn.cpp:25` varsayılan argüman → `Emitter.cpp:95`), yol hiç uygulanmaz |
| S7 | `Emitter.cpp:170-180` (`C_Emitter::AtomicFree`) | sarmalayıcı | **kapı konmaz**. Buraya kapı koymak S4/S6'yı da sessizce devre dışı bırakır; ayrıca 1. denemenin (D3) kapsam hatasını tekrarlar |

Kısaca: yalnızca **S1-S3** kapılanır, ve bunlar §0 gereği trail sahipli bir
emitter için **zaten erişilemez**.

## 4. Trail yolunun emitter'ı bırakması

| Yol | Yer | Biçim | Salt |
| --- | --- | --- | --- |
| Partikül ölümü | `SuperEffect.cpp:214-243` (`FreeParticle`), bırakma `:229` | `pEmitterList->AtomicFree` → drenaj `Atomic.h:221-226` | artmaz |
| Trail bloğu silinmesi | `SuperEffect.cpp:180-207` (`DeleteTrailBlock`), bırakma `:193` | `GetSuperEffectEmitterList()->Free` → `emitterlist.cpp:24` | **+1** |
| Efekt yıkımı | `SuperEffect.cpp:61-103` (`I_ParticleSuperEffect::Free`), bırakma `:78` | aynı senkron yol | **+1** |

Çağrı yerleri: `FreeParticle` → süper şekil güncellemeleri
(`Generic/Shape2DSimpleSuper.cpp:66`, `Shape2DCollisionSuper.cpp:84,92`,
`Shape3DSimpleSuper.cpp:64`, `Shape3DCollisionSuper.cpp:80`,
`SpriteRotatingSuper.cpp:68`); `DeleteTrailBlock` → `Manager.cpp:1351-1353`
(`m_DeletedSuperBlocks`, blok boşalınca `Shape2DSimpleSuper.cpp:75-89` ile
kuyruğa girer); `Free` → `I_ParticleSuperEffect::Reset()` (`SuperEffect.h:46-51`)
ve `T_ParticleSuperEffect::~T_ParticleSuperEffect` (`SuperEffect.h:82`).

Yani aday 2 sonrası **bırakma yolu hâlâ üç tanedir ve hepsi trail tarafındadır**;
kural B fiilen korunur.

## 5. Hiçbir trail bloğu bırakmazsa ne olur

- **2a (bayrak `SetDefinition`'da sıfırlanır):** davranış bugünküyle **aynı**;
  trail sahipli emitter zaten kendini bırakamıyor (§0), dolayısıyla sızıntı
  profili değişmez. Bu, 2a'nın no-op olduğunun ikinci kanıtıdır.
- **2b (sıfırlama yok):** trail'den geri dönüştürülen emitter death/collision
  olarak kullanıldığında bayrak `true` kalır; tanım yinelenmediği için
  `Emitter.cpp:478-499`'a girer, S1-S3 atlanır ve **hiçbir yol onu bırakmaz**
  (FreeParticle yalnız trail yuvasındaki işaretçiyi bırakır; bu emitter artık bir
  yuvada değildir). Sonuç: `m_SuperEffectEmitters` aktif sayısı tek yönlü artar →
  `AtomicAllocate` (`Atomic.h:286-303`) `NULL` döner → `SuperSpawn.cpp:22/43`
  `if(...)` koruması sayesinde çökme değil, **trail'in sessizce kaybolması**;
  death/collision efektleri görünmez olur. Bu, "sessiz geri düşüş yasak" kuralına
  aykırı olduğu için 2b kabul edilemez.
- **Genel sızıntı yolları (2a'da da mevcut):** (i) `Clean(pNode)`
  (`EffectInterface.cpp:199-206`) `DeleteBlockDeferred` çağırır ve bu yalnız
  `m_Element.Clear()` yapar (`EffectInterface.h:130-133`); trail blokları
  ancak blok bir sonraki güncellemede boş görülüp `m_DeletedSuperBlocks`'a
  girerse serbest kalır. (ii) `m_DeletedSuperBlocks` kapasitesi dolarsa
  (`Manager.cpp:1230-1234`, `Shape2DSimpleSuper.cpp:79-81` sınır kontrolü)
  trail blokları `DeleteTrailBlock` görmeden havuzda kalır. Bunlar aday 2'nin
  ürettiği değil, **devraldığı** risklerdir.

## 6. Neden AV'yi önlemez, nerede çökebilir

1. **Üretici kaldırılmıyor.** Ölümcül sıra (C3) `FreeParticle` (231-232) →
   drenaj #1 (233). `FreeParticle` `SuperEffect.cpp:226-229` içinde salt
   karşılaştırması eşit olduğu için `AtomicFree` yapar; bayrak bu kodda okunmaz.
   Aday 2 bu satıra dokunmadığı için 232/233 aynen kalır.
2. **Bariyer korunur, neden değişmez.** Assert yerinde kaldığı için aday 2 tek
   başına "assert → AV" dönüşümü üretmez (1. ve 2. denemenin tersine). Ama
   belirtiyi de kaldırmaz; 3 koşunun dağılımı temel çizgiyle aynı kalması beklenir.
3. **Aliasing (H13) kapsam dışı.** Aynı emitter iki trail yuvasında duruyorsa
   `FreeParticle` iki kez bırakır; bayrak bunu görmez (bayrak nesne başına, yuva
   başına değil).
4. **En olası yeni hata türü: sızıntı** (§5, 2b) veya **no-op + aynı çökme** (2a).
   Beklenmeyen AV senaryosu: bayrak `SetDefinition`'da sıfırlanmazsa (2b) ve
   sızan emitter daha sonra `CleanEmitterDefinition` ile senkron `Free` edilirse
   trail yuvası salt artışı sayesinde NULL'lanır — bu güvenli; ancak havuz
   tükenmesi `SuperSpawn.cpp:22` NULL'ı sessizce yuttuğu için hata gizlenir.
5. **`m_pDefinition` yaşam süresi:** bayrak `m_pDefinition->bRepeating`'e
   dayanmaz (yalnız S1-S3'ü kapılar), bu yüzden dangling tanım riski eklemez.
   Sızıntı ölçümü yine de zorunludur.

## 7. Minimal değişiklik listesi

1. `Emitter.h` — sınıf sonunda `bool m_bTrailOwned;` + `SetTrailOwned/IsTrailOwned`.
2. `Emitter.cpp:74` yanına `m_bTrailOwned = false;` (`SetDefaults`).
3. `Emitter.cpp:112` yanına `m_bTrailOwned = false;` (`SetDefinition`, **yalnız 2a**).
4. `Emitter.cpp:257-261` — `if(m_bDelete && !m_bTrailOwned)`; `else if(m_bDelete) m_bDelete = false;`.
5. `Emitter.cpp:492-496` — `if(!m_bTrailOwned) { if(m_nNumEmit == 0) AtomicFree(...); else m_bDelete = true; }`.
6. `SuperSpawn.cpp:25` ve `:46` sonrası — `SetTrailOwned(true)`.
7. `Emitter.h` sonuna `static_assert` (ofset koruması) — tanılama amaçlı, `#ifndef CFG_GOLD` altında.

Toplam 6 kod noktası + 1 assert; hiçbir imza değişmez, `Atomic.h`'ye dokunulmaz,
assert (`Atomic.h:315-316`) aynen kalır. Derleme çıktısı ayrı EXE adıyla
(`Amax-trailowner.exe`) üretilmeli; kanonik `_work/run/Amax.exe` değişmemeli.

## 8. 3 koşuluk test planı (tam dump'lı)

**Adım 0 — eşleştirilmiş temel çizgi (zorunlu).** Aynı oturumda, aynı harness ile
kanonik `Amax.exe` 3 kez koşulur. Gerekçe: önceki turlarda "1/3 breakpoint +
2/3 AV" deseni hem düzeltme denemesinde hem temel çizgide görülebiliyor; tek bir
tarihsel koşu referans alınırsa farklar yanlış atfedilir (D1/E2).

**Adım 1 — build.** İzole worktree'de (`_work/native-source/Blur1PCDX11`)
`tools/build.sh` Release; çıktı `Amax-trailowner.exe` olarak `_work/run/`'a
kopyalanır, kanonik `Amax.exe` SHA-256'sı (`e9727929…a254`) önce/sonra doğrulanır.
`/W4` uyarısız olmalı.

**Adım 2 — koşu.** `tools/game_slot.ps1` üzerinden sıraya girilir; harness
`_work/native_crash_dump_attach.ps1`'in kopyasıdır (yalnız `FileName`,
`scriptDir`, çıktı adları değişir): `BLUR2PC_FRAMELIMIT=60`, minimized pencere,
`BLUR2PC_FREE_TRACE` **kapalı** (izleme zamanlamayı kaydırıyor, H10),
`MiniDumpWriteDump` tipi `0x1026` (tam bellek). Senaryo: mevcut
`race-native/smoke.txt` (666 bayt, `9c764308…b5ff`), `prepare_race.lua` aynı.
3 koşu, aralarında ayar/kayıt değişikliği yok.

**Adım 3 — başarısızlıkta tam dump.** `0x80000003` anında script dump alıp
süreci sonlandırır (`full-0x80000003.dmp`); `0xC0000005` için süreç ölürken
`EXIT_PROCESS_DEBUG_EVENT`'te `full-exit.dmp` alınır. Her koşu için kaydet:
ExitCode, süre, dump adı+bayt+SHA-256, `debug-events.log`, `automation.log`
son satırı, `dump-result.json`.

**Adım 4 — yanlışlama ölçümü.** İzole kaynağa env-gated tek Sayaç eklenir:
koruma S1/S2'yi gerçekten atladığında artan bir sayaç; çıkışta değeri loglanır.
Aday 2a'nın öngörüsü: **sayaç 0**. Sayaç > 0 ise §0'daki `bRepeating` çıkarımı
yanlıştır ve tasarım yeniden değerlendirilir (bu, tasarımı kurtaracak tek bulgu).

**Kabul ölçütleri**

- **A1 (ret):** 3 koşudan herhangi biri `0x80000003` veya `0xC0000005` ile
  biterse aday reddedilir (önceki iki denemenin ölçütü).
- **A2 (yalnız "belirti yok"):** 3/3 exit 0 **tek başına kabul değildir**;
  `m_SuperEffectEmitters` sayaçları (cached+active=total, `deletedN`) dump'tan
  okunup temel çizgiyle karşılaştırılmalı ve **sayaç 0** (Adım 4) olmalıdır.
  Aksi hâlde sonuç "etkisiz" olarak kaydedilir.
- **A3 (kanıt bütünlüğü):** herhangi bir başarısızlıkta tam dump **varsa** koşu
  değerlendirilir; dump yoksa koşu "sonuçsuz" sayılır, "geçti" sayılmaz (D2/E4).
- **A4 (geri alınabilirlik):** patch + EXE + log SHA-256'ları kaydedilir;
  çalışma sonunda izole kaynak `git status` temiz, kanonik `Amax.exe` hash'i
  değişmemiş olmalıdır.
- **A5 (kapsam):** `Atomic.h:315-316` ve `Manager.cpp`/`Atomic.h` diff'te
  görünmemelidir; assert kaldırılmamış olmalıdır.
- **A6 (iddia sınırı):** 3 temiz koşu bile "düzeltildi" demek için yeterli
  değildir; girişsiz eşleştirilmiş koşu (H7) ve havuz baskısı ölçümü olmadan
  yalnız "belirti gözlenmedi" yazılabilir.

## 9. Risk tablosu

| Risk | Olasılık | Etki | Not |
| --- | --- | --- | --- |
| Hiçbir şey değişmez (no-op) | **yüksek** (§0) | 3/3 aynı çökme | En olası sonuç; "başarısız deneme" olarak kaydedilmeli |
| Sessiz sızıntı (2b) | orta | aktif emitter tek yönlü artar, trail kaybolur | Kabul edilemez (sessiz geri düşüş) |
| Havuz tükenmesi → eksik efekt | orta (2b) | görsel kayıp, çökme yok | `SuperSpawn.cpp:22` NULL'ı yutar |
| Aliasing çift bırakma | düşük-orta | aynı AV sınıfı | Bayrak yuva başına değil nesne başına |
| Ofset kayması → dump araçları bozulur | orta (F1 yanlış yere konursa) | tanılama kaybı | F1 sınıf sonunda + `static_assert` |
| AV (bariyer kalkması) | düşük | önceki denemelerle aynı sınıf | Assert yerinde olduğu için beklenmez |

## 10. Sonuç

- Aday 2 **tanımlanabilir ve minimal** (6 nokta), kural B ile tutarlıdır.
- Ancak **gözlenen çift bırakmanın üreticisini kaldırmaz**; `bRepeating`
  zorlaması (`SuperEffect.cpp:35`) nedeniyle kapı hiç ateşlenmez. Bu nedenle
  düzeltme olarak **önerilmez**; en fazla sözleşme + tanılama olarak değeri vardır.
- Gerçek üretici hâlâ `FreeParticle` (`SuperEffect.cpp:226-229`) → bayat trail
  yuvasıdır; onu kapatmak için ya (a) drenajda/senkron bırakmada nesil ilerletme
  (1./2. denemelerin kapsamı genişletilmiş hâli), ya (b) bırakılan emitter'ı
  tutan **tüm** trail yuvalarının aynı anda geçersiz kılınması gerekir — ikisi de
  bu belgenin kapsamı dışındadır ve assert'e dokunmaz.
- Assert kaldırılmadı; hiçbir kod değişmedi; "düzeltildi" iddiası yok.
