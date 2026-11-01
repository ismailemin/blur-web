# Native particle-cache çökmesi — analiz raporu

**Durum:** tamamlandı (salt okunur inceleme; hiçbir kaynak/derleme/oyun dosyası değiştirilmedi)
**Sahip:** native-analysis sub-agent (salt okunur)
**Tarih:** 1 Kasım 2026 (triyaj dump'ı incelemesi), 2 Kasım 2026 (tam bellek exit dump'ı incelemesi)
**Kapsam notu:** "Bilinenler/Bulunanlar" bölümleri 1 Kasım triyaj dump'ına dayanır
ve tarihsel kayıt olarak korunmuştur. 2 Kasım tam bellek dump'ı incelemesi
raporun sonundaki "Tam bellek (exit) dump'ı" bölümündedir; oradaki sonuçlar
aşağıdaki "Açık sorular" maddelerinin 1, 2, 5 ve 6'sını günceller.

## Bilinenler

- Native x64 Amax Release build başarılı; sabit Brighton yarışı açılıyor ve
  `Racing` durumuna ulaşıyor.
- Gaz (W) girişinden sonra süreç `0x80000003` ile duruyor.
- Sembolleştirilmiş yığın:

```text
DebugBreak
DynamicEffect::AtomicActiveCache<DynamicEffect::Particle::C_Emitter>::Update
DynamicEffect::Particle::C_ParticleManager::UpdateSuperEmitters
Game::C_GameWorld::Update
```

- `Atomic.h` içindeki `Free()` şu kontrolü yapıyor:

```cpp
if (m_ActiveElements <= 0 || pElement->m_VectorPosition == -1)
    DebugBreak();
```

- Kaynak bu kontrolü issue 29790 incelemesi olarak işaretliyor.
- `dump-context.json` ham CPU register'ları içeriyor; optimize edilmiş C++
  üyelerinin değerlerini kanıtlamıyor.

## Bulunanlar

İnceleme yöntemi (hepsi salt okunur):

1. `crash.dmp` saf Python ile (harici araç kurulmadan) ayrıştırıldı: başlık,
   stream dizini, ThreadList, ModuleList, ExceptionStream, MemoryList ve ham
   `CONTEXT` blokları.
2. Çökme anındaki **aynı** EXE (`_work/run/Amax.exe`,
   SHA-256 `e9727929768d1e8e2b41ec6abfa836c4134cd397e571c8b9ba1129c91a5a254`)
   üzerinde `dumpbin /disasm` ile ilgili aralıklar söküldü. Kaynak kod
   `upstream/BlurRebuilt` içinden okundu (değiştirilmedi).

### Kanıtlanan

**K1 — Çökme noktası, `Update()` içindeki drenaj döngüsüne inlined edilmiş
`Free()` çağrısıdır.**
`crash.txt:5` dönüş adresi `0x7FF6C7C8C90D`, modül tabanı `0x7ff6c7990000`
(`dump-context.json`) → RVA `0x2FC90D`. Sökümde:

```text
1402FC8C0  ?Update@?$AtomicActiveCache@VC_Emitter@Particle@DynamicEffect@@@DynamicEffect@@QEAAXXZ:
1402FC8C0  mov   [rsp+20h],rbp
1402FC8C5  push  rdi
1402FC8C6  sub   rsp,20h
1402FC8CA  xor   ebp,ebp
1402FC8CC  mov   rdi,rcx                ; rdi = this (cache)
1402FC8CF  cmp   dword ptr [rcx+60h],ebp   ; m_DeletedElements
1402FC8D2  jle   1402FC98A              ; <= 0 ise çık
...
1402FC8F0  cmp   dword ptr [rdi+34h],0    ; m_ActiveElements
1402FC8F4  mov   rax,[rdi+48h]            ; m_Deleted.m_elements
1402FC8F8  mov   rsi,[r14+rax]            ; pElement = m_Deleted[i]
1402FC8FC  jle   1402FC907                ; 1. koşul -> DebugBreak
1402FC8FE  cmp   dword ptr [rsi+0B0h],0FFFFFFFFh  ; pElement->m_VectorPosition
1402FC905  jne   1402FC90D                ; -1 değilse devam
1402FC907  call  qword ptr [__imp_DebugBreak]
1402FC90D  ...                            ; <-- çökme dönüş adresi
```

Dönüş adresi `Atomic.h:224` (`Free(m_Deleted[i]);`) satırına düşüyor ve
`Update()+0x4D` = `0x2FC90D` ile birebir uyuşuyor. İki koşul **aynı** `call`
adresine düştüğü için dönüş adresi tek başına hangi operandın tetiklediğini
ayırmaz; ayrımı bellek sağlıyor (K4, K5).

**K2 — Çökme anındaki cache nesnesi ve elemanı register'lardan kesin.**
Ham `CONTEXT` bloğu dump içinde dosya ofseti `0x936C`'de bulundu ve
`dump-context.json` ile birebir doğrulandı: `rip=0x7fffae0d3122`,
`rsp=0x58c11f0e8`, `rdi=0x11887bef830`, `rsi=0x11883a48900`,
`r14=0`, `rbp=0`, `rax=0x1189c6f8850`. `rdi`, `0x2FC8CC`'deki `mov rdi,rcx`
ile atanır ve döngüde bozulmaz → `rdi` = cache `this`. `rsi`, `0x2FC8F8`'deki
yükleme ile elemandır.

**K3 — Bu cache `m_SuperEffectEmitters`'tır.**
Çağıran `C_ParticleManager::UpdateSuperEmitters` (`crash.txt:6`,
`Manager.cpp:1340`) sökümü:

```text
1402FE390  ?UpdateSuperEmitters@C_ParticleManager@Particle@DynamicEffect@@QEAAXXZ:
1402FE398  mov   rsi,rcx
1402FE3A0  mov   ecx,dword ptr [rcx+5070h]
1402FE3AB  call  Scheduler::Flush
1402FE3B0  lea   rcx,[rsi+800h]        ; this = manager + 0x800
1402FE3B7  call  AtomicActiveCache<C_Emitter>::Update
```

`Manager.h:290-292` sırası `m_Emitters`, `m_SuperEffectEmitters`,
`m_EventInstanceList`; aynı tipte ardışık cache'ler 0x78 bayt aralıkla
duruyor. `rdi = 0x11887bef830` → `C_ParticleManager* = 0x11887bef030`;
`manager+0x788` = `m_Emitters`, `manager+0x800` = `m_SuperEffectEmitters`,
`manager+0x878` = `m_EventInstanceList`. Üçünün de sayaçları tutarlı okunuyor
(K8), yani nesne hizalaması doğru.

**K4 — Tetikleyen operand: `pElement->m_VectorPosition == -1`.**
`m_ActiveElements <= 0` **yanlış**: `cmp [rdi+34h],0` anındaki değer
`0x0E` = **14** (dump belleği `0x11887bef864`). Eleman koşulu **doğru**:
`pElement+0xB0` = `0xFFFFFFFF` = **-1** (`0x11883a489b0`). Yani invariant'ın
ikinci yarısı ateşledi. (Not: -1, `Atomic.h:322` dışında hiçbir yerde
yazılmıyor; `Cache`/`Allocate`/`AtomicAllocate` negatif olmayan indeks yazar.
Dolayısıyla -1 ⇔ bu eleman için `AtomicActiveCache<C_Emitter>::Free` **daha
önce** çalışmış.)

**K5 — Silinen listenin elemanı: `0x11883a48900`.**
`m_DeletedElements` (`this+0x60`) = **1**, döngü indeksi `r14` = 0, yani ilk
(ve tek) kayıt işleniyordu. `m_Deleted.elements` = `0x1189c6f8850`
(`rax`) ve dump'taki `m_Deleted[0]` hücresi de `0x11883a48900` — `rsi` ile
aynı. Yani silinen-listeye konmuş eleman, `m_VectorPosition` değeri zaten -1
olan bir `C_Emitter`.

**K6 — Durum "çift serbest bırakma" (duplicate free) ile tutarlı, sayaç
tutarsızlığı ile değil.**
Çökme anında: `m_CachedElements` = 242, `m_ActiveElements` = 14,
`m_TotalElements` = 256 → 242 + 14 = 256 (tam). `m_DeletedElements` = 1.
Yani tüm elemanlar tam olarak bir kez cache/active listelerinde muhasebe
edilmiş; eleman aynı zamanda silinen-listede duruyor ⇒ **aynı eleman iki kez
serbest bırakılmış**. Aynı emitter'ın `m_Active`/`m_Cache` dizilerinde olup
olmadığı dump'tan doğrulanamaz (o diziler yakalanmamış).

**K7 — Silinen dizi eski işaretçileri koruyor; aynı eleman daha önceki bir
partide de kuyruğa girmiş.**
Dizi boşaltılmıyor, sadece sayaç sıfırlanıyor (`Atomic.h:225`). Dump'ta
`m_Deleted[1]` = `0x11883a48900` (aynı eleman), `m_Deleted[2]` =
`0x11883a48d00` (= eleman + 0x400), geri kalanı 0. Sayaç 1 iken dolu olan
1. ve 2. gözler önceki bir partiden kalmadır ⇒ aynı emitter (ve 0x400 bayt
yanındaki komşusu) daha önceki bir karede de silinen listeye yazılmıştı.
0x400 fark, emitter'ların blok halinde bitişik tahsis edildiğini de gösteriyor.

**K8 — Diğer cache'lerin durumu (aynı an, aynı manager).**

| Cache | adres | cached | active | total | deletedN |
| --- | --- | ---: | ---: | ---: | ---: |
| `m_Emitters` | `0x11887bef7b8` | 2016 | 32 | 2048 | 0 |
| `m_SuperEffectEmitters` | `0x11887bef830` | 242 | 14 | 256 | **1** |
| `m_EventInstanceList` | `0x11887bef8a8` | 755 | 13 | 768 | 0 |

**K9 — Çöken thread ana/oyun thread'idir (TID 9428).**
`ExceptionStream.ThreadId` = 9428, `crash.txt` son kareleri `AmaxApplicationMain`
→ `WinMain` → `BaseThreadInitThunk`. Aynı TID `amax.log` içinde kaynak
yükleme thread'i olarak geçiyor (`TID 9428 Resource Manager ...`,
`TID 9428 C_Manager::WaitForAllResourceData`).

**K10 — Dump'ın içeriği (ne var / ne yok).**
Başlık: `MDMP`, stream'ler 3/4/5/6/7/13/15/21/22; **92 modül, 76 thread,
510 bellek aralığı, toplam 38.658.728 bayt bellek**; `Flags = 0x200041`
(`MiniDumpNormal | WithUnloadedModules | FilterTriage`). Bellek, çökme
bağlamındaki işaretçilerin çevresinden hedefli olarak alınmış:
`0x11887bef6b8` (1144 B, cache'i içeriyor), `0x11883a48900` (256 B, eleman),
`0x1189c6f8850` (768 B, silinen dizi başı), ana thread yığını 19.720 B.
Buna karşılık `m_Cache.elements` (`0x1189c6f7740`) ve `m_Active.elements`
(`0x1189c6f6630`) **dump'ta yok**; 76 thread'den yalnızca **2**'sinde geçerli
`CONTEXT` var (diğer 74'ü sıfır) — yani eşzamanlı thread durumu okunamıyor.
`.data` (3.3 MB) var, `.rdata` yok.

### Hipotez

**H1 (güçlü) — Mekanizma çift serbest bırakma; yarış (race) olup olmadığı
kanıtlanmadı.** Silinen listede tek kayıt var ve eleman zaten -1. İki ayrı
serbest bırakma yolunun aynı işaretçiye uygulanması bu durumu birebir üretir.
Aday yollar (kaynak, satır numaraları upstream'e ait):

- Doğrudan (senkron) `Free()`: `SuperEffect.cpp:78`
  (`I_ParticleSuperEffect::Free`, trail partiküllerinin emitter'ları) ve
  `SuperEffect.cpp:193` (`I_ParticleSuperEffect::DeleteTrailBlock`).
  Ayrıca `Emitter.cpp:167` (`C_Emitter::Free` → `m_pEmitterList->Free(this)`).
- Ertelenmiş `AtomicFree()`: `SuperEffect.cpp:229` (`FreeParticle`,
  scheduler job'ları içinde çalışır) ve `Emitter.cpp:493`
  (`C_Emitter::AtomicFree`, "we aren't managed so free ourselves").

`UpdateSuperEmitters` sırası gereği (`Manager.cpp:1339` drenaj, ardından
`1344-1355` silinmiş super block'lar ve `DeleteTrailBlock`), bir emitter önce
`AtomicFree` ile kuyruğa girip sonra `Free` ile senkron serbest bırakılırsa
tam olarak gözlenen durum oluşur. Hangi iki çağrının çakıştığı dump'tan
çıkarılamaz.

**H2 (orta) — Aynı işaretçinin iki farklı partikül yuvasında görünmesi
(aliasing) çift kaydı açıklayabilir.** `FreeParticle` (`SuperEffect.cpp:214-243`)
son partikülü `memcpy` ile boşluğa kopyalayıp trail dizilerini `PopBack` ediyor;
salt kontrolü (`iSalt != pEmitter->GetSalt()`) yalnızca ehliyet kontrolü.
Salt yeniden kullanımı veya kopyalama sırası aynı emitter'ı iki kez kuyruğa
sokabilir. Kanıt yok, kaynak okumasına dayalı aday.

**H3 (zayıf) — Girdi nedenselliği kurulmadı.** `automation.log:2176`
"12.28 key down 0x11" (0x11 = W tarama kodu; Enter 0x1C, Right Ctrl 0x9D
olarak loglanıyor), son log satırı `2181` "13.18". Yani çökme W basıldıktan
~0.9-1.0 s sonra, ~1 s'lik bir sürüş penceresinin içinde oldu. Bu yalnızca
zamanlama yakınlığıdır; W'nin bu emitter'ı ürettiğine dair kanıt yok.

**H4 (zayıf) — Eleman belleği henüz geri dönüştürülmemiş.** 256 baytlık
kopyada `+0x00` ve `+0x50`/`+0x80`'de `.rdata` işaretçileri (RVA
`0x12114B8`, `0xD67290`), `+0x40`/`+0x60`'ta makul F32'ler, `+0xC0`'ta
`0x3C888889` (= 1/60) var; yani nesne "çöp"e dönmemiş. Sınıf yerleşimi
(offset→üye) bu incelemede çözülmediği için bu alanların hangi üye olduğu
**iddia edilmiyor**; efekt/kimlik tespiti yapılamaz.

### Girişsiz (stationary) koşuyla karşılaştırma

- Aynı EXE/PDB (`e9727929…`), aynı ayarlar, aynı kayıt (`UK_Brighton_1`,
  `vehicleLoc=1728551317`, `style=0`), aynı script öneki.
- `race-stationary/automation.log:2164-2165` "10.28 … Racing",
  `:2177` "11.10 quit"; süreç exit 0, 12 s, timeout yok.
- İki log yalnızca adresler ve W bloğu (`down W` … `shot`) ile ayrışıyor;
  stationary koşu **11.10 s'de bittiği için** gaz penceresine hiç girmedi.
- Stationary koşu için dump/bellek yok; dolayısıyla "girdi olmadan da aynı
  cache durumu oluşur muydu" sorusu **cevaplanamaz**. Bu koşu, çökmenin
  girdiden bağımsız olduğunu da kanıtlamaz.

### Dump yeterli mi?

- "Hangi operand tetikledi" ve "silinen eleman hangisi" soruları için
  **yeterli** (K4, K5).
- "Eleman `m_Cache` içinde de mi duruyor", "hangi efekte/partiküle ait",
  "hangi thread hangi anda serbest bıraktı" soruları için **yetersiz**:
  serbest/aktif dizileri, elemanın 256 bayt dışındaki kısmı ve 74 thread'in
  context'i dump'ta yok.

## Açık sorular

1. ~~`m_ActiveElements <= 0` mi, yoksa `m_VectorPosition == -1` mi tetikledi?~~
   **Cevaplandı (iki bağımsız dump ile):** `m_VectorPosition == -1` (K4;
   tam bellek dump'ında T4). `m_ActiveElements` triyajda 14, exit dump'ında
   93 — ikisinde de > 0.
2. ~~Silinen liste elemanı hangi emitter'a ait?~~
   **Cevaplandı:** `m_SuperEffectEmitters` cache'inde, triyajda
   `0x11883a48900`, exit dump'ında `0x2b20c365db0` adresli `C_Emitter`
   (vtable RVA `0x11214B8`) ve exit dump'ında bu elemanın **serbest listesinde
   de** durduğu görüldü (T5). Efekt tanımının/adının kimliği hâlâ açık.
3. Aynı girdi olmadan yapılan koşuda çökme oluyor mu? — **Açık.** Mevcut
   stationary koşu gaz penceresine girmeden bitti ve dump'ı yok.
4. W girişi gerçekten nedensel mi, yoksa zamanlama mı? — **Açık.** Triyajda
   ~1 s, exit dump'ında ~13 s gecikme var; sabit bir gecikme yok (H3, H7).
5. ~~Minidump gerekli bellek/optimize local'ları içeriyor mu?~~
   **Cevaplandı (T1, T3):** tam bellek dump'ı serbest/aktif dizilerini,
   cache ve eleman gövdelerini ve breakpoint CONTEXT'ini içeriyor. Eksik
   kalan: exception stream yok, yalnızca 1 thread kaydı (register'ları sıfır),
   dolayısıyla thread çakışması okunamıyor.
6. Çift serbest bırakma hangi iki çağrı yolundan geldi (senkron `Free` +
   ertelenmiş `AtomicFree` mi, iki `AtomicFree` mi, aliasing mi)? —
   **Kısmen:** çift bırakma artık doğrudan kanıt (T5), ancak ikinci çağrıyı
   yapan kod yolu hâlâ **açık** (H1/H2/H5).

## Sonraki adımlar

1. ~~**Tam bellek dump'ı** ile aynı breakpoint'te tekrar et~~ → **yapıldı**
   (2 Kasım, `race-native-crash/dumps/full-exit.dmp`):
   - `m_Cache[0..m_CachedElements-1]` içinde bekleyen eleman **var** →
     çift serbest bırakma doğrudan kanıtlandı (T5),
   - elemanın diğer kopyaları tarandı (T9),
   - thread context'i alınamadı: exit dump'ında tek thread kaydı var ve
     register'ları sıfır (kısıt, yeni tanılama için geçerli).
2. **Sınırlı tanılama** (yalnızca izole Speed worktree'sinde, assert
   kaldırılmadan): `AtomicFree` ve `Free` girişlerine (a) eleman işaretçisi,
   (b) çağıran dönüş adresi, (c) üç sayaç, (d) kare numarası yazan halka
   tamponu ekle; breakpoint'te bu tamponu boşalt. Böylece "ikinci kez kim
   serbest bıraktı" sorusu doğrudan yanıtlanır. (Tam bellek dump'ı bunu
   kapatmadı; ikinci çağrının izini yalnızca bu verir.)
3. **A/B tanılaması (kod değişikliği olmadan):** debug ayarı
   `Graphics.Dynamic.Particle.MultiThreadedEmittterUpdate` (`Manager.cpp:100`,
   `Debug::Bool`) kapatılıp aynı senaryo tekrarlanmalı. Tekrarlamazsa yarış
   hipotezi güçlenir; tekrarlarsa mantıksal (aliasing/çift `Free`) yol öne
   çıkar. Bu bir düzeltme değil, yalnızca ayırt edici tanıdır.
4. **Eşleşmiş girişsiz koşu:** aynı süre (≥ 15-20 s) gaz verilmeden; ayrıca
   yalnızca gaz verilen uzun koşu. İkisinde de aynı emitter adresi/deseni
   aranmalı. Nedensellik iddiası bu karşılaştırmadan önce kurulmamalı.
5. Sonuç ne olursa olsun invariant **kaldırılmamalı/zayıflatılmamalı**;
   Master/`CFG_GOLD` derlemesi bu kontrolü dışlıyor ama cache hatasını
   düzeltmiyor (yalnızca gizliyor).
6. Bu inceleme bir düzeltme önermiyor ve "düzeltildi" iddiası taşımıyor.

## Kanıt yerleri

Çökme klasörü (hepsi değiştirilmedi):
`_work/native-source/Blur1PCDX11/_work/run/scripts/race-native/attempt-throttle/`

| Dosya | Bayt | SHA-256 |
| --- | ---: | --- |
| `crash.dmp` | 38.957.961 | `638d802e21c44206fc7ed928caa054456d4ba7a678d326df1d526b9c3f39f6ab` |
| `crash.txt` | 3.028 | `090d126ca1ef372a4f25e501fa2637ee7be3d16c451e1c206da7ea3c51be140d` |
| `dump-context.json` | 1.170 | `c1eb2caa7d3d78b7245fd45e7e66161ed21fc353592f400a7b9dca5787e772f5` |
| `automation.log` | 164.220 | `f8c51a8da45eeee84a83f53be676dc87c7d1d4e801a3c8332a9f4f232e86f88a` |
| `amax.log` | 22.149 | `e557e212b1fa4ac3e90d24586f248ccd9c6a1975433fdf626dccb97be3f8e369` |
| `run-result.json` | 925 | `b569235cdbb94054125086e60bb5b3615d274e0895186db6c9059f7cef3b4106` |

Karşılaştırma koşusu: `_work/native-source/Blur1PCDX11/_work/run/scripts/race-stationary/`
(`automation.log` `46ff0af3…`, `run-result.json` `930d0a41…`, `race.jpg` `9278ef76…`).

Tam bellek (exit) dump'ı koşusu (2 Kasım, ayrıntı ve tablo son bölümde):
`_work/native-source/Blur1PCDX11/_work/run/scripts/race-native-crash/` —
`dumps/full-exit.dmp`, `debug-events.log`, `dump-result.json`, `automation.log`,
`smoke-crash.txt`, `prepare_race.lua`.

- Çalıştırılan EXE: `_work/native-source/Blur1PCDX11/_work/run/Amax.exe`,
  SHA-256 `e9727929768d1e8e2b41ec6abfa836c4134cd397e571c8b9ba1129c91a5a254`
  (`run-result.json:3`); PDB `983032962babd0366d1de4ec4fa8b304b7206d20951387e9375ce96f32719ee6`.
- Lojik/decoding kanıtı: `upstream/BlurRebuilt/code/mercury/library/Graphics/Dynamic/include/Dynamic/Atomic.h`
  (`Update` 221-226, invariant 311-331),
  `.../source/particle/Manager.cpp` (`UpdateSuperEmitters` 1334-1373,
  `UpdateEmitters` 1277-1308), `.../include/dynamic/particle/Manager.h:75-292`,
  `.../source/particle/SuperEffect.cpp` (61-103, 172-243),
  `.../source/particle/Emitter.cpp` (158-180, 470-500).
- Konsolide kayıt (bu inceleme öncesi hâli): `_work/build/engine-reference/native-race-audit.json`
  (`crash.whichOperandFailed` alanı hâlâ "Unknown" diyor; bu belge onu
  K4 ile günceller), üretici script `_work/build/engine-reference/audit-native-race.py`.
- Anlatı/anamnez: `docs/setup/native-source-build.md` "Native race handoff"
  bölümü (satır 252-320).

---

## Tam bellek (exit) dump'ı — 2 Kasım 2026

**Yakalama:** `dumped-exit`, PID 8604, ExitCode `-2147483645` (`0x80000003`).
Dump `EXIT_PROCESS_DEBUG_EVENT` anında alınmış; `debug-events.log` içinde
`0x80000003` için bir `EXCEPTION_DEBUG_EVENT` kaydı **yok** (satır 2-255:
CREATE_PROCESS tid 10460, dört adet `code=1 ... ex=0x000001AC` olayı satır
94/158/178/179, satır 255 EXIT_PROCESS). Bu yüzden stack/invariant anının
birebir aynı olmayabileceği uyarısı baştan not edildi; aşağıdaki T1 bunun
tersini gösteriyor.

Dosyalar (hepsi değiştirilmedi):

| Dosya | Bayt | SHA-256 |
| --- | ---: | --- |
| `dumps/full-exit.dmp` | 1.458.887.110 | `abd9befeab2730d0e7d0c51c30cc2e2a2c10cc2003a95248704f55998cae7a93` |
| `debug-events.log` | 10.468 | `dd83844dcf8bb27e8b2dd920b02749fa9d511de8387eec1bde9158f914d4c4d8` |
| `dump-result.json` | 603 | `99fb409ec23ade3a8d5c015cb3289b5b99a25b41e8d0e57cd174cd51d600196b` |
| `automation.log` | 195.445 | `84fc2b1dd0a5526052b43430d93bb4800b8f89fba79f4d34d8f63bf1b5aa248e` |
| `smoke-crash.txt` | 524 | `9ea9b191f32b33ab6935dad7b6a421857cfbfab825c7babe211852180e07a8a0` |
| `prepare_race.lua` | 2.058 | `072c94cf4381b4c8b3d64491028e7c9af810be5fe93d0b7572643cc80a585b6d` |

Klasör: `_work/native-source/Blur1PCDX11/_work/run/scripts/race-native-crash/`.
Çalıştırılan EXE yine `_work/run/Amax.exe`, SHA-256
`e9727929768d1e8e2b41ec6abfa836c4134cd397e571c8b9ba1129c91a5a254`
(2 Kasım'da disk üzerinde yeniden hesaplandı).

### Dump'ın yapısı ve sınırları

- `MDMP`; stream'ler 3/4/7/**9**/12/13/14/15/17/21/22. **9 = Memory64List**
  (2.916 tanımlayıcı) → tam bellek var. **ExceptionStream yok** (exit anı).
  ThreadList yalnızca **1 thread** (tid 16056) ve o kaydın register'ları sıfır.
- 91 modül; Amax tabanı bu koşuda `0x7ff66cdd0000` (boyut `0x19b3000`).
- Bellek: birleştirilmiş **1.669 aralık, 1.458.798.592 bayt** (dosya boyutunun
  ~%99,99'u).
- `Flags = 0x221026` (WithDataSegs | WithFullMemory | ScanMemory |
  WithFullMemoryInfo | WithPrivateWriteCopyMemory | FilterTriage).
- `automation.log`: satır 2170 `11.88 ... NATIVE_CRASH_RACING`,
  satır 2176 `12.88 key down 0x11` (W tarama kodu), son satır 2686
  `25.94 ...`. Yani süreç W'den **~13 s sonra** öldü (triyaj koşusunda ~1 s).

### Kanıtlanan

**T1 — Breakpoint anı bu dump'ta hâlâ okunuyor: CONTEXT ana thread
yığınında korunmuş.**
`0xc91ecfe630` adresinde standart x64 GPR yerleşiminde bir blok var:
`rdi = 0x2b21b832850` (cache), `rsi = 0x2b20c365db0` (pElement),
`rax = 0x2b224b2b7b0` (m_Deleted.elements), `r14 = 0`, `rbp = 0`,
`rip = 0x7fffae0d3122` (`DebugBreak+0x2`, triyaj dump'ıyla **aynı**),
`r15 = Amax+0xD5F5B0` (triyajdaki RVA'nın aynısı), `r8 = 0x83`,
`r9 = 0x7ffe6000`, `r10 = 1`, `r12 = 4`, `r13 = 0`, `rsp = 0xc91ecff398`.
Bu değerler triyaj `dump-context.json` ile aynı desende. Aynı yığın
bölgesindeki dönüş adresleri:

```text
[Rsp+0x00] 0x7ff66d0cc90d  = Amax+0x2FC90D  Update() içinde DebugBreak sonrası
[Rsp+0x30] 0x7ff66d0ce3bc  = Amax+0x2FE3BC  C_ParticleManager::UpdateSuperEmitters
[Rsp+0x40] 0x2b21b832050                     C_ParticleManager*
[Rsp+0x70] 0x7ff66ce7d038  = Amax+0xAD038   C_GameWorld::Update+0x6E8
                                            (triyaj crash.txt:7 ile aynı komut)
```

Not: aynı bloğun `ContextFlags` alanı geçerli bir CONTEXT maskesi değil; blok
kısmi bir çekirdek/dispatcher kopyası olarak değerlendirildi. GPR kısmı ise
10'dan fazla bağımsız değerle (cache ve eleman işaretçileri dahil) doğrulandı.
Bu yığın, ThreadList'te kaydı olmayan çökme thread'ine aittir; tam bellek
dump'ı onun yığın baytlarını yine de saklamış.

**T2 — Fail eden cache yine `m_SuperEffectEmitters`; sayaçlar:**

| Cache | adres | cached | active | total | deletedN |
| --- | --- | ---: | ---: | ---: | ---: |
| `m_Emitters` | `0x2b21b8327d8` | 2016 | 32 | 2048 | 0 |
| `m_SuperEffectEmitters` | `0x2b21b832850` | 163 | 93 | 256 | **1** |
| `m_EventInstanceList` | `0x2b21b8328c8` | 755 | 13 | 768 | 0 |

`C_ParticleManager* = 0x2b21b832050`; üç cache `+0x788 / +0x800 / +0x878`
adreslerinde (Manager.h:290-292 sırası) ve kendi kendini gösteren
`m_pCachedElements/m_pActiveElements/m_pDeletedElements` işaretçileriyle
doğrulandı. 163 + 93 = 256 (tam).

**T3 — Triyaj dump'ında olmayan diziler artık okunabiliyor.**
`m_Cache.elements = 0x2b224b24040`, `m_Active.elements = 0x2b224b2a6a0`,
`m_Deleted.elements = 0x2b224b2b7b0` (üçü de kapasite 511).

**T4 — Hangi operandın tetiklediği exit anında da okunuyor.**
`m_ActiveElements = 93` (> 0) → birinci yarı **yanlış**.
Bekleyen eleman `m_Deleted[0] = 0x2b20c365db0` ve
`m_VectorPosition (pElement+0xB0) = -1` → ikinci yarı **doğru**.
T1'deki `rsi` bu eleman, `rdi` bu cache: triyajdaki rol dağılımı birebir
tekrarlandı. Yani sonuç "exit anında okunamıyor" değil; **okunuyor**.

**T5 — Çift serbest bırakma artık doğrudan kanıt: bekleyen eleman zaten
serbest listesinde.**
`m_Deleted[0] = A = 0x2b20c365db0` **ve** `m_Cache[162] = A`
(`m_CachedElements = 163` → serbest yığınının tepesi) ve
`A.m_VectorPosition = -1`. Yani silinen kuyruğu, serbest listeye geri
dönmüş bir elemanı taşıyor; invariant'ın yakaladığı durum tam olarak budur.
Triyaj dump'ında bu kontrol yapılamıyordu (dizi yoktu).

**T6 — Son dört serbest bırakma, silinen dizisinin dört gözüyle aynı
elemanlar.**
`m_Deleted[0..3]` = A, B (`0x2b20c36bfb0`), C (`0x2b20c36b1b0`),
D (`0x2b20c3683b0`) (sayaç 1 → yalnızca [0] güncel, [1..3] önceki
partilerden kalma). Bu dört eleman `m_Cache[162], [161], [159], [160]`
gözlerinde; yani serbest yığınının en üstündeki dört kayıt bunlar. Dördü de
aynı ikinci değerle eşleşiyor: `0x2b21ebdbe20`. **Düzeltme (2 Kasım, ikinci
tur):** RTTI ile bu nesnenin `DynamicEffect::Particle::Shape2DSimple`
olduğu belirlendi; yani bu bir efekt/sahip değil, **doğuran şekildir**
(ayrıntı: "Sahip/efekt kimliği" bölümü, S1).

**T7 — Cache muhasebesi tutarlı.**
`m_Active[0..92]` içinde 93 kayıt, hepsinde `position == index`
(0 uyuşmazlık). `m_Cache[0..162]`: 157 giriş `position == index`
(hiç kullanılmamış rezerv), 5 giriş `-1`, 1 giriş `96` (C).
`m_Active[93..98]` aktif sayının üstündeki bayat kuyruk yuvaları
(Free'nin swap-remove'unun beklenen artığı).

**T8 — "position 96" durumu: `Free()`'nin son-aktif-eleman swap'i.**
C = `0x2b20c36b1b0` aynı anda hem `m_Cache[159]` içinde, hem `m_Active[96]`
bayat yuvasında ve `m_VectorPosition = 96` (aktif sayı 93 iken). Söküm
(`Amax.exe`, RVA):

```text
1402FC927  mov   dword ptr [rsi+0B0h],0FFFFFFFFh  ; pElement->m_VectorPosition = -1
1402FC93E  mov   qword ptr [rax+rcx*8],rsi        ; m_Cache[cached++] = pElement
1402FC942  movsxd rcx,dword ptr [rdi+34h]         ; m_ActiveElements
1402FC946  lea    eax,[rcx-1]
1402FC949  mov    dword ptr [rdi+34h],eax         ; --m_ActiveElements
1402FC950  mov    rdx,qword ptr [rax+rcx*8-8]     ; pEnd = m_Active[eski-1]
1402FC955  mov    dword ptr [rdx+0B0h],r8d        ; pEnd->m_VectorPosition = freePosition
1402FC960  mov    qword ptr [rax+r8*8],rdx        ; m_Active[freePosition] = pEnd
```

`freePosition == eski-1` iken `pEnd == pElement` olur: eleman hem serbest
listeye itilir hem de `position` değeri -1'den geri yazılır. Gözlenen C
durumu (aynı anda cache'te + aynı indekste bayat aktif yuvada + pozitif
`position`) bu kodla açıklanan tek durumdur; bu yüzden T8 "kanıtlanan"
sayıldı. Sonucu: aynı çift-bırakma, eleman aktif listenin **son** elemanı
iken oluşursa invariant **tetiklenmez** ve kontrol bu varyantı kaçırır
(bu, C'nin durumundan çıkan bir sonuç; C için ikinci bir bırakma
kanıtlanmadı).

**T9 — A hâlâ birden çok yerde referans ediliyor.**
Tam bellekte `A` 9 kez geçiyor: `m_Cache[162]` ve `m_Deleted[0]` dışında
`0x2b21148dac0`, `0x2b211a65010`, `0x2b211a65020` (16 bayt arayla iki
komşu kayıt; her ikisinde de ikinci dword 0), `0x2b226684d30` ve
`0x2b226c53d70` (16 baytlık `{emitter*, 0x2b21ebdbe20}` çiftleri), ayrıca
`0xc91ecfe628` ve `0xc91ecfe6e8` (çökme yığını; ikincisi T1'deki `rsi`).

### Hipotez

**H5 — İkinci `AtomicFree` eski bir partikül/trail referansından geliyor
(aday, kanıtlanmadı).** `I_ParticleSuperEffect::DeleteTrailBlock`
(`SuperEffect.cpp:185-195`) emitter'ı `Free()` ile bırakırken
`pParticle->pEmitter` alanını **NULL'lamıyor**; `FreeParticle`
(`SuperEffect.cpp:222-230`) ise aynı alanı `AtomicFree()` ile kuyruğa atıyor
ve tek koruma `iSalt != pEmitter->GetSalt()` karşılaştırması. Serbest
bırakılmış bir emitter'ın salt'ı yeniden kullanılana kadar değişmediği için
bayat işaretçi kontrolü geçip ikinci kez kuyruğa girebilir. T9'daki komşu
iki 16 baytlık kayıt bu tür bir bayat referansa işaret eder, ancak yapı
kimliği (partikül mü, başka bir liste mi) **kanıtlanmadı**.

**H6 — Çökme, aynı emitter'ın ikinci kez bırakılmasıdır; ilk bırakma
meşru bir drenajdı.** T6'ya göre A, B, C, D son dört `Free()` çağrısının
ürünü ve aynı anda silinen dizisinde duruyorlar; A ayrıca yeni bir parti
olarak yeniden kuyruğa girmiş (sayaç 1). Yani ilk bırakma bir drenajda
gerçekleşmiş, ikinci kuyruğa giriş ise daha sonraki bir bayat referanstan
gelmiş olmalı. Sıra/parti geçmişi dizinin üzerine yazılması nedeniyle
kesin olarak kurulamıyor.

**H7 — Girdi ilişkisi hâlâ kurulmadı.**
W 12.88 s'de basıldı, süreç ~25.94-26 s'de öldü (~13 s sürüş). Triyaj
koşusunda bu süre ~1 s ve aktif emitter sayısı 14 idi; burada 93. Yani
arıza sabit bir "girişten X saniye sonra" davranışı göstermiyor ve farklı
emitter yüklerinde de oluşuyor. Girişsiz eşleşmiş bir koşunun dump'ı
olmadığı için nedensellik iddiası kurulamaz.

### Triyaj dump'ı ile karşılaştırma

| Öğe | Triyaj (`crash.dmp`) | Tam bellek (`full-exit.dmp`) |
| --- | --- | --- |
| EXE / PDB | `e9727929…` / `98303296…` | aynı |
| Kod noktası | `Atomic.h:224` (`Update+0x4D`) | aynı (T1) |
| Çağrı zinciri | Update → UpdateSuperEmitters → GameWorld::Update | aynı RVA'lar (T1) |
| Tetikleyen operand | `m_VectorPosition == -1` | aynı (T4) |
| `m_ActiveElements` | 14 | 93 |
| `m_CachedElements` | 242 | 163 |
| `m_DeletedElements` | 1 | 1 |
| Toplam eleman | 256 | 256 |
| Silinen eleman | `0x11883a48900` | `0x2b20c365db0` |
| Eleman serbest listede mi? | **bilinmiyor** (dizi yok) | **evet**, `m_Cache[162]` (T5) |
| W sonrası geçen süre | ~1 s | ~13 s |

Aynı olan: kod yolu, operand, cache kimliği, muhasebe kuralı
(cached + active = total). Değişen: aktif emitter sayısı, silinen elemanın
adresi ve çökmeye kadar geçen süre. Bu, arızanın belirli bir kareye/süreye
bağlı olmadığını, tekrar eden bir "zaten bırakılmış emitter'ı yeniden
bırakma" örüntüsü olduğunu gösterir.

### Kapanan ve kapanmayan sorular

Kapanan: hangi operand (iki dump ile), elemanın serbest listede olup
olmadığı (T5), serbest/aktif dizilerinin okunması (T3), exit anı ile
breakpoint anının aynı olması (T1), "son aktif eleman" varyantının varlığı
(T8).

Kapanmayan: ikinci `AtomicFree`'yi yapan **çağıran** (hâlâ yok — dönüş
adresi kaydı yok), thread çakışması (dump'ta tek thread kaydı ve sıfır
register), efekt tanımının adı/kimliği (`0x2b21ebdbe20` sahibi
isimlendirilemedi), girişsiz koşuyla nedensellik (H7).

### Sıradaki en küçük adım

**Kod çalıştırmadan, elimizdeki dump üzerinde:** `0x2b21ebdbe20` sahip
nesnesinin tanım işaretçisini (definition/effect) çözüp A-D emitter'larının
hangi efektin trail emitter'ları olduğunu ve T9'daki iki komşu 16 baytlık
kaydın hangi yapıya (partikül dizisi mi) ait olduğunu belirlemek. Bu,
"bayat referans" hipotezini (H5) ya güçlendirir ya çürütür ve tek bir
okuma turuyla yapılabilir. Ardından, hâlâ gerekiyorsa, çağıranı kesin
saptamak için `AtomicFree`/`Free` girişlerine sınırlı (assert'e dokunmayan)
izleme eklenir. Hiçbir aşamada assert kaldırılmaz ve bu rapor bir düzeltme
iddiası taşımaz.

> **Durum (2 Kasım, ikinci tur):** bu adım yapıldı. Sonuç: sahip nesne bir
> efekt değil `Shape2DSimple` doğuran şekli; komşu 16 baytlık kayıtlar
> `C_Particle_E` (trail elemanı) dizisine ait; H5 güçlendirildi ama
> kanıtlanmadı. Ayrıntı ve yeni sıradaki adım: aşağıdaki
> "Sahip/efekt kimliği" bölümü.

---

## Sahip/efekt kimliği — 2 Kasım 2026 (ikinci tur)

Amaç: önceki bölümün "Sıradaki en küçük adım" maddesi. Yöntem tamamen salt
okunur: `full-exit.dmp` içindeki vtable→RTTI zinciri
(`[vtable-8] → RTTICompleteObjectLocator → TypeDescriptor`) çözülerek 2.883
vtable ve bunların canlı örnekleri çıkarıldı; ardından nesne alanları
izlendi. Oyun çalıştırılmadı, hiçbir dosya değiştirilmedi (geçici script'ler
`_work/analysis/full-exit-dump/` altında).

### Kanıtlanan

**S1 — "Sahip" sandığımız nesne aslında doğuran şekil: `Shape2DSimple`.**
`0x2b21ebdbe20` → vtable RVA `0x1120798`, COL `0x7ff66e0d7df0`, tip adı
`.?AVShape2DSimple@Particle@DynamicEffect@@`. Yani T6'daki "aynı sahip
nesnesi" ifadesi yanlıştı: bu bir efekt/sahip değil, partikül doğuran
şekildir (Block.h'de `m_pInfo` = "pointer to a structure containing extra
info, type is situation dependant"). Göründüğü yerler:
- A'nın `ParticleBlock`'unun `m_pInfo` alanı (`0x2b20c76ff60 + 0x10`);
- `0x2b226684ce0` ve `0x2b226c53d30` dizilerindeki `{C_Emitter*, X}` çiftleri
  → bunlar "emitter + sahip efekt" değil, **emitter + doğuran şekil**
  çiftleridir (muhtemelen spawn bekleyen emitter listesi).
Şeklin kendi alanları: `+0x10` = `C_Renderer` (paylaşılan; 299 referans),
`+0x18` = `C_ParticleManager`, `+0x60` self-pointer. Şekil üzerinden efekt
adına giden bir alan yok.

**S2 — A–D gerçekten `C_Emitter` ve `m_pEmitterList` = çöken cache.**
Dördü de vtable RVA `0x11214B8` → `.?AVC_Emitter@Particle@DynamicEffect@@`.
A (`0x2b20c365db0`) üzerinden doğrudan okunan alanlar:

| ofset | alan | değer |
| --- | --- | --- |
| `+0x188` | `m_pManager` | `0x2b21b832050` (`C_ParticleManager`) |
| `+0x190` | `m_pEventInstance` | **NULL** |
| `+0x198` | `m_pEmitterList` | **`0x2b21b832850`** = assertion'a giren `m_SuperEffectEmitters` |

Bu, emitter nesnesinin kendisinden okunan kanıttır (register/yığın
çıkarımına dayanmaz): emitter, event-instance sahipliğinde değil; süper
efekt emitter listesine bağlı.

**S3 — A'nın bloğu ve şekli.**
`A+0x10` ve `A+0x18` = `0x2b20c76ff60`, RTTI `ParticleBlock` (vtable RVA
`0x10F4C18`); bloğun `m_pInfo` = S1'deki `Shape2DSimple`.

**S4 — Komşu 16 baytlık kayıtlar `C_Particle_E` (trail elemanı).**
`Particle.h:226-231`:

```cpp
// particle class just contains a pointer to an emitter and salt, used to manage traileffects etc
class C_Particle_E
{
public:
    C_Emitter*  pEmitter;
    U32         iSalt;
};
```

Bu tip kaynakta yalnızca trail eleman vektörleriyle kullanılıyor
(`SuperEffect.cpp:72,187,223,234,251,274,411,432`;
`SuperSpawn.cpp:21,42,189`). Dump'ta kayıtlar tam 16 bayt aralıkla:
`0x2b211a65010` ve `0x2b211a65020` → ilk qword `A` (RTTI `C_Emitter`),
ikinci dword `0` (= salt). Dizi, `0x2b20c76e720`'deki tanımlayıcıyla
eşleşiyor: `elements = 0x2b211a65000`, `shape = Shape2DSimpleSuper`,
yanında `8 / 0x20 / 2` gibi alanlar. Aynı desen B için de var:
`0x2b211a65100` dizisinde iki slot B'yi gösteriyor.

**S5 — Tuz (salt) koruması bu yolu engelleyemez.**
`C_Emitter::GetSalt() const { return m_iSalt; }` (`Emitter.h:44`);
`SetDefaults()` içinde `m_iSalt = 0` (`Emitter.cpp:89`) ve başka bir atama
yok. Trail spawn'da `pTrailParticle->iSalt = pEmitter->GetSalt()`
(`SuperSpawn.cpp:22,45`) → elemanda da 0. Dolayısıyla
`if(pParticle->iSalt != pEmitter->GetSalt())` **false** olur ve `else`
dalındaki `AtomicFree(...)` çalışır (`SuperEffect.cpp:226`). Yani serbest
bırakılmış bir emitter'ın bayat işaretçisi tekrar kuyruğa girebilir; mevcut
koruma bunu ayırt edemez.

**S6 — Havuz büyüklüğü ile canlı nesne sayısı birebir uyuşuyor.**
Dump'ta **2.304** canlı `C_Emitter` nesnesi var; `m_Emitters` (2048) +
`m_SuperEffectEmitters` (256) = **2.304**. Yani tüm emitter nesneleri
önceden ayrılmış; `-1` işareti "nesne yok" değil, "serbest listeye döndü"
anlamına geliyor.

**S7 — Bu trail efektleri 2B "super" şekille üretilmiş.**
İncelenen blok bölgesindeki trail tanımlayıcılarının tamamı
`Shape2DSimpleSuper` gösteriyor (`0x2b21eb9ddb0`, `0x2b21b12a5e0`).
Dump'ta 10 adet `Shape2DSimpleSuper` ve 35 adet `Shape2DSimple` var.
Ayrıca A'nın `+0x160` alanı da bir `Shape2DSimpleSuper` içine düşüyor.

### Hipotez

**H5 (güçlendirildi, hâlâ kanıtlanmadı) — bayat trail referansı.**
Zincir şu: A zaten serbest listesinde (T5) → bellekte A'yı gösteren trail
elemanları duruyor (S4) → tuz koruması `0 == 0` olduğu için engellemiyor
(S5) → o slot işlendiğinde `AtomicFree(A)` yeniden çağrılıp kuyruğa giriyor
→ sonraki drenajda `position == -1` → assert. Gözlenen tek elemanlı kuyruk
ve `-1` durumuyla birebir uyuşuyor. Eksik halka: hangi çağrının o bayat
slotu işlediği (çağıran izi dump'ta yok).

**H5-varyantı (ne kanıtlandı ne çürütüldü) — iki komşu slotta aynı
işaretçi.** A, aynı trail dizisinde iki komşu 16 baytlık slotta görünüyor.
Ancak `FreeParticle` (`SuperEffect.cpp:216-242`) son elemanı boşluğa
kopyalayıp `PopBack` ettiği için bu, "canlı eleman + kuyruk artığı" da
olabilir, gerçek aliasing de. Tanımlayıcıdaki hangi alanın **canlı sayaç**
olduğu belirlenemedi (aday `+0x20` değerleri dizideki dolu slot sayısıyla
uyuşmuyor), bu yüzden bu ayrım kanıtlanamadı.

**H8 (yeni, zayıf) — efekt kimliği yalnızca tür düzeyinde.** Dump'taki
verilerle efektin adına değil, türüne ulaşılabiliyor: 2B "super" şekille
üretilen, event-instance sahipliği olmayan süper-efekt trail emitter'ları.

### Bulunamayan: efektin adı / kaynak kimliği

Efektin insan-okur adı veya kaynak ID'si bu dump'tan **çıkarılamadı**.
Nedenleri, kanıtla:

1. Dump'ta hiçbir `...SuperEffect...` RTTI sınıfı yok. Envanterde yalnızca
   25 `I_DynamicEffect` örneği var; MSVC ICF (özdeş COMDAT katlama) aynı
   vtable'ları birleştirdiği için bu 25 kayıt gerçek türetilmiş türü ayırt
   etmiyor.
2. Efekt tanımları vtable'sız. 25 efekt nesnesinden ve A'nın bloğundan 2
   seviye işaretçi taraması **tek bir yazdırılabilir ad** döndürmedi; yani
   tanım nesneleri C-string adı taşımıyor (Blur'da efektler hash ile
   anılıyor).
3. `automation.log` partikül efekt adı loglamıyor; çapraz kontrol edilecek
   bir ad yok.
4. Şekil üzerinden (`Shape2DSimple` → `C_Renderer`) ve blok üzerinden
   (`ParticleBlock`) efekt tanımına giden doğrudan bir alan bulunamadı.

Bu nedenle addan söz etmek **uydurma** olur; rapor yalnızca tür düzeyinde
kimlik veriyor.

### Sıradaki en küçük adım

İki seçenek, ikisi de kod çalıştırmadan:

1. **Çağıranı kesinleştir:** `AtomicFree`/`Free` girişlerine assert'e
   dokunmayan sınırlı izleme (çağıran dönüş adresi + eleman + kare) ekleyip
   aynı senaryoyu tekrarlamak. Bu, "hangi bayat slot" sorusunu kapatır.
   **→ Yapıldı (2 Kasım, üçüncü tur):** `native-free-trace.patch` ile
   env-gated izleme eklendi ve trace alındı; sonuç aşağıdaki
   "Çağrı izleme (Free/AtomicFree)" bölümünde.
2. **Ad hash'ini çıkar:** aynı dump'ta `SuperEffects.trailEffects[j].definition`
   zincirini izleyip efekt tanımının 32/64-bit ad hash'ini almak ve bunu
   `game-data` efekt kaynaklarıyla (yalnızca okuyarak) eşleştirmek. Hash→ad
   eşlemesi manifestten doğrulanmalı; tahmin edilmemeli. — **Hâlâ açık.**

Bu rapor bir düzeltme iddiası taşımaz ve assert'in kaldırılmasını önermez.

---

## Çağrı izleme (Free/AtomicFree) — 2 Kasım 2026 (üçüncü tur)

**Veri.** İzole Speed kaynağına env-gated (`BLUR2PC_FREE_TRACE`) bir tanılama
eklendi; assert'e ve hiçbir durum değişkenine dokunulmadı
(`_work/build/engine-reference/native-free-trace.patch`). Trace build'i
`Amax-trace.exe` ile iki koşu alındı.

| Artefakt | Bayt | SHA-256 |
| --- | ---: | --- |
| `free-trace.log` (ana trace, site etiketli) | 19.344 | `874191c14bb4beccd18cc87b62e334d3d185a129e8c4fa60273c96abaac35b50` |
| `free-trace-1.log` (ilk trace, site etiketsiz) | 11.942 | `7e62f962038d93ae6fcbf5c774fd7013403adc7b7391be091d82f25e5cd7b47e` |
| `dumps/full-exit.dmp` (aynı koşunun tam belleği) | 1.478.354.258 | `c0966df1d2bdc461323202e8d313c1871a2a6067c61f301da6106e9c04b39cf2` |
| `Amax-trace.exe` / `.pdb` | 24.348.160 / 140.103.680 | `4c8e7043c46f9e921b2eb2e07558495728e23cf79daa5083a3f9585fcc4185ca` / `198b1d3013ee848d59b895ed7ae0781255d7f1b3e456663324e27e110055a52b` |
| `native-free-trace.patch` | 8.431 | `466f632e9ae3bb6f650154a387f00b31b0066b582d3ed0a3a95aadb515926d98` |

**Artefakt yenilemesi (kayıt düzeltmesi).** Bu koşu aynı klasörü kullandığı
için önceki bölümlerdeki bazı dosyaların **üzerine yazıldı**:
`dumps/full-exit.dmp` artık 1.478.354.258 bayt / `c0966df1…` (önceki
1.458.887.110 / `abd9befe…`), `automation.log` artık 164.062 bayt /
`ec505c89…` (önceki 195.445 / `84fc2b1d…`), `dump-result.json` artık 929 bayt /
`da7a442f…`. Önceki hash'ler o koşunun tarihsel kaydıdır; dosyaların bugünkü
içeriğini tarif etmez.

**Yöntem.** `AtomicFreeTrace` her `AtomicFree`/`Free` girişinde, **işlemden
önce** üç sayacı ve `_ReturnAddress()` değerini yazıyor; `AtomicSiteTrace`
belirli çağrı yerlerine etiket bırakıyor (patch, satır 66-81 ve 90-235).
Bu şablonlar çağıranlara inline edildiği için `_ReturnAddress()` pratikte
"çağrıyı yapan dış fonksiyonun dönüş adresi"ni veriyor (ör. `FreeParticle`
çağrısının dönüşü, `C_Emitter::Update` çağrısının dönüşü). Sembol eşlemesi
ICF'e bırakılmadı: `Amax-trace.exe` üzerinde `dumpbin /disasm` ile
doğrulandı.

### Kanıtlanan

**C1 — Aynı cache bir karede iki ayrı yerden boşaltılıyor.**
Trace'te `Free` satırlarının iki farklı dönüş adresi var ve ikisi de
`AtomicActiveCache<C_Emitter>::Update()` çağrısının dönüşü:

| dönüş adresi | sökümle doğrulanan yer | kaynak |
| --- | --- | --- |
| `0x2FE97C` | `?UpdateSuperEmitters@C_ParticleManager…` (fonksiyon `0x2FE950`), `lea rcx,[rsi+800h]; call Update` | `Manager.cpp:1339` |
| `0x2FE2D8` | `?UpdateSpawn@C_ParticleManager…` (fonksiyon `0x2FE270`), `lea rcx,[rbx+800h]; call Update` | `Manager.cpp:1385` |

Kare sırası `Update()` içinde: `UpdateEmitters()` → **`UpdateSuperEmitters()`**
→ **`UpdateSpawn()`** (`Manager.cpp:1195-1197`).
**Düzeltme:** özet bilgide `0x2FE2D8 → C_ParticleManager::UpdateSuperEffect`
yazıyordu; söküm bunun **`UpdateSpawn`** olduğunu gösteriyor (ICF kaynaklı
sembol karışması). Site etiketleri etkilenmiyor.

**C2 — Çağrı yolları ve site etiketleri.**

| dönüş adresi | çağrılan dış fonksiyon | trace etiketi | ertelenmiş mi? |
| --- | --- | --- | --- |
| `0x31503D` | `FreeParticle(...)` (çağrı `0x315038`, hemen sonrası) | `SuperEffect::FreeParticle-229` | `AtomicFree` (ertelenmiş) |
| `0x31D8D7` | `C_Emitter::Update(...)` (ana thread) | `Emitter::Update-259` → `AtomicFree-179` | `AtomicFree` |
| `0x1CB674` | `C_Emitter::Update(...)` (scheduler worker, `ParticleEmitterUpdateModule`) | `Emitter::Update-259` → `AtomicFree-179` | `AtomicFree` |
| `0x2FE97C` | `UpdateSuperEmitters` drenajı | — (`Free`) | senkron |
| `0x2FE2D8` | `UpdateSpawn` drenajı | — (`Free`) | senkron |

Yani **üç üretici** aynı kuyruğa yazıyor (`FreeParticle`, `Emitter::Update-259`
→ `Emitter::AtomicFree-179`) ve **iki tüketici** (iki drenaj) onu boşaltıyor.

**C3 — Ölümcül sıra (satır 220-233, X = `0x264FD0F77B0`).**

```text
220  Site SuperEffect::FreeParticle-229   X
221  AtomicFree X  a=14 c=242 d=0  caller=0x31503D
222  Free       X  a=14 c=242 d=1  caller=0x2FE97C   -> X serbest listeye döndü (pos=-1)
223  Site Emitter::Update-259              X
224  Site Emitter::AtomicFree-179          X
225  AtomicFree X  a=15 c=241 d=0  caller=0x31D8D7   -> arada 2 ayırma var (X yeniden dağıtıldı)
226  Site Emitter::Update-259            f61b0
228  AtomicFree f61b0 a=15 c=241 d=1  caller=0x1CB674
229  Free       X  a=15 c=241 d=2  caller=0x2FE2D8   -> X tekrar serbest (pos=-1)
230  Free     f61b0 a=14 c=242 d=2  caller=0x2FE2D8   -> f61b0 da serbest
231  Site SuperEffect::FreeParticle-229   X
232  AtomicFree X  a=13 c=243 d=0  caller=0x31503D   -> 230 ile sayaçlar AYNI: araya ayırma yok
233  Free       X  a=13 c=243 d=1  caller=0x2FE97C   -> pos=-1 => DebugBreak
```

Satır 232 ile 230'un sayaçları birebir aynı (`a=13 c=243`). `AtomicAllocate`
`m_ActiveElements`'i artırıp `m_CachedElements`'i azalttığı için (`Atomic.h:286-303`)
sayaçların değişmemesi **X'in yeniden dağıtılmadığının** kanıtıdır: 231'de
`FreeParticle` bayat işaretçiyi kuyruğa attı, 233'teki drenaj da -1 gördü.
Trace 233. satırda bitiyor (DebugBreak bu `Free`'in içinde).

**C4 — Aynı koşunun tam bellek dump'ı bu sırayı birebir doğruluyor.**
`dumps/full-exit.dmp` (modül tabanı `0x7FF621D90000`, `Amax-trace.exe`)
içinde `m_SuperEffectEmitters` cache'i `0x265043d08b0`:
`cached=243`, `active=13`, `deletedElements=1`, `m_Deleted[0]=0x264FD0F77B0`,
`X.m_VectorPosition=-1`, X `m_Cache[241]`, `f61b0` `m_Cache[242]`.
Bu, 233. satırın **işlem öncesi** durumunun aynısıdır (a=13 c=243 d=1);
X'in 241'de, f61b0'ın 242'de olması 229-230 sırasını da doğruluyor.

**C5 — Tuz (salt) koruması neden yetmiyor.**
`SuperEffect.cpp:226`: `if(pParticle->iSalt != pParticle->pEmitter->GetSalt())`
→ eşitse `NULL`'lama, değilse `AtomicFree`. Trail spawn'da
`iSalt = pEmitter->GetSalt()` (`SuperSpawn.cpp:22,45`).
`C_Emitter::GetSalt()` = `m_iSalt` (`Emitter.h:44`); `m_iSalt` yalnızca
`SetDefaults()` içinde `0` atanıyor (`Emitter.cpp:89`) ve dinamik kütüphane
genelinde başka atama yok (`SetSalt` diye bir API de yok).
Event-instance sahipliği olmayan süper-efekt emitter'larında (A için
`m_pEventInstance == NULL`, S2) tuz **hep 0** kalıyor → karşılaştırma
`0 != 0` hiçbir zaman doğru olmuyor → bayat işaretçi `NULL`'lanmıyor,
`AtomicFree`'ye gidiyor. Trace'te `AtomicFree` satırının görünmesi de
`else` dalının çalıştığının kanıtıdır.

**C6 — Üç serbest bırakma yolu, tek nesne.**
X için trace'te üçü de görülüyor:
(a) `C_Emitter::Update` → `m_bDelete` → `AtomicFree` (`Emitter.cpp:258-262`);
(b) `FreeParticle` → `AtomicFree` (`SuperEffect.cpp:226-230`);
(c) drenaj → `Free` (`Atomic.h:311-331`), iki ayrı çağrı yerinden (C1).
X, 222 ve 229'da (c) ile, 225 ve 232'de (a)/(b) ile aynı kuyruğa
girdi/çıktı.

### Hipotez

**H5 — "bayat trail referansı": mekanizma artık kanıtlandı, sahiplik
sözleşmesi hâlâ hipotez.**
Kanıtlanan: 231'de `FreeParticle`, X **serbest listedeyken** (232'de araya
ayırma girmemiş) onu yeniden kuyruğa attı; yani trail elemanı, sahibi
olduğu iddia edilen emitter'ı çoktan bırakılmışken tutuyordu.
Hipotez olan: X'i (a) yoluyla bırakan tarafın trail elemanını neden
geçersiz kılmadığı — kaynakta `C_Emitter::Update`/`m_bDelete` ile
`FreeParticle` arasında bir "sahiplik iptali" bağı görünmüyor; emitter
kendi kendini bıraktığında trail elemanındaki `pEmitter` alanı yerinde
kalıyor ve tuz 0 olduğu için ayrım yapılamıyor (C5). Bu bağın yokluğu
kod okumasıyla **gösterildi**, ancak hangi trail bloğunun hangi karede
bayat kaldığı izlenmedi.

**H9 (yeni, orta) — iki drenaj noktası hatanın zamanlamasını genişletiyor.**
Aynı cache `UpdateSuperEmitters` (1339) ve `UpdateSpawn` (1385) içinde iki
kez boşaltıldığı için, kuyruğa girişin hangi faza denk geldiğine göre
drenaj aynı karede veya sonraki karede oluyor (C1/C3). Bu, hatanın
*oluşma sıklığını* etkiler; kök nedeni değiştirmez (kök neden: bayat
referans + etkisiz tuz koruması).

**H10 (zayıf) — izleme koşusunda çökme çok daha erken.** Bu koşuda W
12.87 s'de basıldı ve `automation.log` 12.99'da bitti (önceki koşularda
~1 s ve ~13 s). Enstrümantasyonun ek yükü/`fflush` çağrıları zamanlamayı
değiştirdiği için bu süre **karşılaştırma için kullanılmamalı**; nedensellik
iddiası (H7) etkilenmez.

### Kapanan ve kapanmayanlar

Kapanan: "hangi iki çağrı yolu çakışıyor" (C3: `FreeParticle` ↔ drenaj;
ayrıca `Emitter::Update-259` aynı kuyruğa üçüncü üretici), drenaj
noktalarının kimliği (C1, `UpdateSpawn` düzeltmesi dahil), tuz korumasının
neden etkisiz olduğu (C5), X'in yeniden dağıtılmadığının kanıtı (C3 sayaç
eşitliği + C4 dump eşleşmesi).

Kapanmayan: bayat trail elemanının hangi blok/partikül olduğu ve
`m_bDelete` yolunun onu neden temizlemediği (H5'in ikinci yarısı), efektin
adı/kaynak ID'si (önceki bölüm), girişsiz koşuyla nedensellik (H7).

**İzlemenin sınırları (dürüstlük notu):** `active/cached/deleted` atomik
okunmuyor; dosya `fopen(...,"a")` ile iki ayrı `static FILE*` üzerinden ve
çok thread'li yazılıyor, dolayısıyla farklı thread'lerin satırları arasında
sıra kayması olabilir. Bu raporda kullanılan sıra, ana thread'in kendi
zinciri ve sayaç sürekliliğiyle (C3) doğrulandı; yine de tek başına bu
trace bir "kesin toplam sıra" iddiası taşımaz.

### Sıradaki en küçük adım

1. **Kod okumasıyla (oyun çalıştırmadan):** `C_Emitter::Update`'in
   `m_bDelete` dalı ile `FreeParticle` arasındaki sahiplik sözleşmesini
   çıkar: emitter kendi kendini bırakırken onu gösteren trail elemanlarının
   geçersiz kılınıp kılınmadığını (ve tuz mekanizmasının süper-efekt
   emitter'ları için neden hiç devreye girmediğini) kaynakta belgele.
   **→ Yapıldı (2 Kasım, dördüncü tur):** sonuç aşağıdaki
   "Sahiplik sözleşmesi" bölümünde; eksik halka bulundu (ertelenmiş
   bırakma yolunda nesil/salt artırımı yok).
2. **İzlemeyi bir adım derinleştir (yalnızca gerekirse, yeni koşu):**
   `FreeParticle` etiketine `pParticle` (trail eleman adresi) ve blok
   indeksini ekle; bayat kalan tek bir elemanı isimlendir. Bu, H5'in ikinci
   yarısını kapatır.
3. Efekt adı için önceki bölümdeki (2) numaralı ad-hash yolu hâlâ açık.

Bu bölüm de bir düzeltme iddiası taşımaz; assert'in kaldırılması veya
zayıflatılması önerilmez.

---

## Sahiplik sözleşmesi (C_Emitter ↔ trail elemanı) — 2 Kasım 2026 (dördüncü tur)

Kapsam: yalnızca kaynak okuması (`upstream/BlurRebuilt`), oyun çalıştırılmadı,
hiçbir dosya değiştirilmedi. Amaç: `C_Emitter::Update`/`m_bDelete` ile
`I_ParticleSuperEffect::FreeParticle` arasındaki sahiplik sözleşmesini ve
eksik kod yolunu belirlemek.

### Kanıtlanan

**SC1 — Bağ tek yönlü: trail elemanı emitter'ı gösterir, emitter trail
elemanını göstermez.**
`C_Particle_E` yalnızca `{C_Emitter* pEmitter; U32 iSalt;}` taşır
(`Particle.h:225-231`, yorum: "used to manage traileffects etc").
`C_Emitter`'ın sahiplik alanları: `m_pEmitterList` (havuz), `m_pEventInstance`
(süper-efekt emitter'larında **NULL** — S2), `m_pBlockEA`/`m_iBlockSalt`
(sadece **ana** partikül bloğu; `SetBlock` ile atanır, `Emitter.h:102-115`;
PC'de yalnızca SPU fetch'te okunur, `Emitter.cpp:659-660`). Hiçbir alan trail
bloğunu/e elemanını göstermiyor. Dolayısıyla emitter kendi ölümünü trail
tarafına **bildiremez**.

**SC2 — İki bağımsız yaşam süresi kuralı (çakışmanın kaynağı).**
- *Emitter tarafı:* `C_Emitter::Update`, tanım süresi dolduğunda ve
  `m_pDefinition->bRepeating` değilse kendini bırakır: emit edecek bir şey
  yoksa doğrudan `AtomicFree(pEmitterEA)` (`Emitter.cpp:492-493`), varsa
  `m_bDelete = true` (`:495`) → bir sonraki karede `if(m_bDelete) AtomicFree`
  (`:256-262`). Bu kural partikülün yaşam süresinden **bağımsızdır**.
- *Trail tarafı:* eleman yalnızca (a) partikül ölünce `FreeParticle`
  (`SuperEffect.cpp:214-243`), (b) trail blok silinince `DeleteTrailBlock`
  (`:180-207`), (c) efekt yıkılırken `I_ParticleSuperEffect::Free`
  (`:61-103`) ele alınır.
İki kural arasında senkron yok → aynı emitter iki kez bırakılabilir.

**SC3 — Sahiplik (blok, indeks) düzeni.**
Spawn: her trail partikülü için **yeni** emitter ayrılır
(`SuperSpawn.cpp:21-27` ve `:42-47`: `AtomicAllocate()` →
`iSalt = GetSalt()` → `SetDefinition(&trailEffects[j].definition)`).
İndeks eşlemesi: `trailPtrs[j] = (*pTrailBlocksEA)[j][blockIndex]`
(`Shape2DSimpleSuper.cpp:49`); spawn assert'i
`trailPtrs[j]->m_Element.Size() == pBlock->m_Element.Size() - 1`
(`SuperSpawn.cpp:20,41`). Yani *trail elemanı i ↔ ana partikül i ↔ blok
indeksi*. `FreeParticle` yalnızca **aynı indeksteki** elemanı ele alır: son
elemanı i'ye kopyalar, kuyruğu `PopBack` eder (`SuperEffect.cpp:216-242`);
başka blokta/indekste aynı işaretçiyi **aramaz**.

**SC4 — Trail elemanı yalnızca dört yerde ve yalnızca salt kontrolüyle
geçersiz kılınıyor.**
`UpdateTrails` (her karede canlı partiküller için; `SuperEffect.cpp:251-259`,
`:274-286`, `:411+`, `:432+`), `FreeParticle` (`:226-230`),
`DeleteTrailBlock` (`:190-194`), `I_ParticleSuperEffect::Free` (`:75-79`).
Dördü de `if(iSalt != pEmitter->GetSalt()) pEmitter = NULL;` kalıbını
kullanıyor. **Proaktif geçersiz kılma yok**: emitter bırakıldığı anda eleman
temizlenmiyor; karar bir sonraki "dokunma" anında salt ile veriliyor.

**SC5 — Nesil (salt) sayacı sözleşmesi ve asimetrisi.**
- `C_EmitterList::Free` (`emitterlist.cpp:20-28`):
  `pEmitter->m_iSalt += 1;` **sonra** taban `Free`. Bu, emitter salt'ını
  artıran **tek** yerdir; `SetSalt` diye bir API yok.
- `AtomicActiveCache::AtomicFree` (`Atomic.h:352-360`) ve drenajdaki taban
  `Free` (`Atomic.h:311-331`) salt'a **dokunmuyor**.
- `C_Emitter::AtomicFree` (`Emitter.cpp:179`) ve `FreeParticle`
  (`SuperEffect.cpp:229`) doğrudan `AtomicFree` çağırıyor → salt artmıyor.
- Drenaj `Free(m_Deleted[i])` (`Atomic.h:224`) taban sınıfın `Free`'i;
  `C_EmitterList::Free` sanal değil (statik bağlama) → drenaj da salt
  artırmıyor.
- *Aynı desen başka yerlerde doğru kurulmuş:* event instance her iki yolda
  `m_iSalt += 2` (`Manager.cpp:1659-1668`); `ParticleBlock` serbest
  bırakılırken `++pDelete->m_iSalt` (`EffectInterface.cpp:236`) ve emitter
  `m_iBlockSalt` ile karşılaştırıyor (`SuperSpawn.h:53`).
Yani "bırakınca nesli ilerlet" kuralı projede var; **emitter'ın ertelenmiş
bırakma yolunda uygulanmamış**.

**SC6 — `iSalt` neden 0: tek yazıcı atlanıyor.**
`m_iSalt` `SetDefaults()` içinde 0'a ayarlanıyor (`Emitter.cpp:89`);
`AtomicAllocate`/`Allocate` salt'ı değiştirmiyor (`Atomic.h:268-303`), yani
geri dönen emitter eski neslini korur. Trail spawn'da `iSalt = GetSalt()`
kopyalanıyor (`SuperSpawn.cpp:24,45`) → yeni eleman da 0 alıyor.
Süper-efekt emitter'ları bu koşuda yalnızca `AtomicFree`/drenaj yoluyla
bırakıldığı için salt hiç artmadı; **eski ve yeni sahipler ayırt edilemez**
hale geldi.

**SC7 — Trace ile çelişki kanıtı: drenaj nesli ilerletmiyor.**
Drenaj X'i 222. satırda bıraktı; 231. satırda `FreeParticle`
`iSalt(0) != GetSalt()` karşılaştırmasını **eşit** buldu ve `else` dalına
gidip `AtomicFree` yaptı (232). Drenaj salt'ı artırsaydı karşılaştırma eşit
olmaz, `pEmitter = NULL` olur ve 232/233 hiç yaşanmazdı. Dolayısıyla
drenajın bırakması nesli ilerletmiyor (SC5'in trace kanıtı).

**SC8 — Kare içi sıra ve pencerenin kaçınılmazlığı.**
`C_ParticleManager::Update` (`Manager.cpp:1188-1197`):
`UpdateEmitters()` → `UpdateSuperEmitters()` (drenaj #1 `:1339`, ardından
`:1340`'ta süper emitter'ların güncellenmesi) → `UpdateSpawn()`
(`m_Emitters.Update()` `:1382`, drenaj #2 `:1385`, sonra spawn `:1387+`).
Süper blok güncellemesi (`Shape2DSimpleSuperUpdate`) `FreeParticle`'ı
çağırır (trace'te dönüş `0x31503D`). Kare N'in sonunda drenaj #2 ile
bırakılan X, kare N+1'in blok güncellemesinde — drenaj #1'den **önce** —
bayat haliyle kullanılıyor: trace 229 → 231 → 233 tam olarak budur.
Sözleşme ihlali burada somutlaşıyor: **bırakma ile bayat referansın
kullanımı arasında nesli ilerleten hiçbir işlem yok**; iki drenajın sırası
bu pencerenin her karede açılmasını sağlıyor.

### Hipotez

**H11 — Bayat kalan trail elemanının kimliği (hangi blok/indeks) hâlâ
bilinmiyor.** Trace `pParticle` adresini loglamıyor; `FreeParticle`
yalnızca `element=` (emitter) yazıyor. (Kapanması için izlemeye alan
adresi eklenmeli — yeni koşu gerektirir.)

**H12 — Nesil artırımının nereye ait olduğu bir tasarım kararı.**
Kanıtlanan: ertelenmiş yolda artırım yok. Kanıtlanmayan: niyetin "kuyruğa
girişte mi" yoksa "drenajda mı" artırmak olduğu. Blok ve event-instance
örnekleri (SC5) "bırakma anında artır" desenini destekliyor; bu bir
*çıkarımdır*, kodda yazılı bir sözleşme metni yok.

**H13 — Aynı emitter'ın iki trail elemanına atanması (aliasing) bu açıkla
birleşince birden fazla bayat referans üretebilir.** Önceki turda iki komşu
16 baytlık kayıtta aynı işaretçi görülmüştü; bunun "canlı + kopyala/pop
artığı" mı yoksa gerçek aliasing mi olduğu hâlâ ayırt edilemedi. SC5'teki
asimetri, aliasing olsa da olmasa da çift bırakmayı açıklamaya yeter;
aliasing **ek** bir yol olur.

### Kapanan ve kapanmayanlar

Kapanan: "hangi kod yolu eksik" → ertelenmiş bırakma yolunda **nesil (salt)
artırımı yok** (SC5, SC6, SC7); trail elemanının geçersiz kılınma yollarının tam
listesi (SC4); sahiplik düzeni ve indeks eşlemesi (SC1, SC3); iki drenajın
kare içi sırası ve pencerenin nedeni (SC8).

Kapanmayan: bayat elemanın kimliği (H11), nesil artırımının tasarım niyeti
(H12), aliasing'in varlığı (H13), efektin adı (önceki bölüm), girişsiz
koşuyla nedensellik (H7).

### Sıradaki en küçük adım

1. **Kod okuması (oyun çalıştırmadan):** `C_Emitter::AtomicFree` çağrılarının
   tam listesini "sahiplik devri" / "kendini bırakma" olarak sınıflandırıp,
   `C_EmitterList::Free`'deki `m_iSalt += 1`'in neden yalnızca senkron yolda
   bulunduğunu (blok salt'ının aksine) kaynakta belgelemek. Bu, H12'yi
   netleştirir ve olası bir düzeltme noktasını *tarif* eder (uygulamaz).
2. **İzleme (yalnızca gerekirse, yeni koşu):** `FreeParticle` etiketine
   `pParticle` adresi + trail efekt indeksi + eleman indeksi eklemek →
   H11 kapanır, bayat eleman isimlendirilir.
3. Efekt adı için ad-hash yolu (önceki bölüm) hâlâ açık.

Bu bölüm bir düzeltme iddiası taşımaz; assert'in kaldırılması veya
zayıflatılması önerilmez. SC5'teki asimetri bir *gözlem*dir; nasıl
kapatılacağı bu incelemenin kapsamı dışındadır.
