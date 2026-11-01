# Native particle-cache çökmesi — analiz raporu

**Durum:** tamamlandı (salt okunur inceleme; hiçbir kaynak/derleme/oyun dosyası değiştirilmedi)
**Sahip:** native-analysis sub-agent (salt okunur)
**Tarih:** 1 Kasım 2026 (inceleme), çökme kaydı 1 Kasım 2026 01:25

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
   **Cevaplandı:** `m_VectorPosition == -1` (K4); `m_ActiveElements` = 14.
2. ~~Silinen liste elemanı hangi emitter'a ait?~~
   **Kısmen cevaplandı:** `m_SuperEffectEmitters` cache'inde `0x11883a48900`
   adresli `C_Emitter`. Efekt tanımı/adı ve sahibi (event instance / super
   effect) dump'tan çıkarılamıyor.
3. Aynı girdi olmadan yapılan koşuda çökme oluyor mu? — **Açık.** Mevcut
   stationary koşu gaz penceresine girmeden bitti ve dump'ı yok.
4. W girişi gerçekten nedensel mi, yoksa zamanlama mı? — **Açık.** ~1 s
   yakınlık dışında kanıt yok (H3).
5. Minidump gerekli bellek/optimize local'ları içeriyor mu? — **Kısmen**
   (K10): hedefli sayfalar var, serbest/aktif dizileri ve diğer thread
   context'leri yok.
6. Çift serbest bırakma hangi iki çağrı yolundan geldi (senkron `Free` +
   ertelenmiş `AtomicFree` mi, iki `AtomicFree` mi, aliasing mi)? — **Açık**
   (H1/H2).

## Sonraki adımlar

1. **Tam bellek dump'ı** (`MiniDumpWithFullMemory`, aynı EXE/PDB) ile aynı
   breakpoint'te tekrar et; sonra:
   - `m_Cache[0..m_CachedElements-1]` içinde `0x11883a48900` var mı? (varsa
     çift serbest bırakma doğrudan kanıtlanır),
   - işaretçinin tüm kopyalarını tara (trail blok partikülü, event instance,
     `m_Active`) ve sahibini belirle,
   - 74 thread'in context'ini de al (`MiniDumpWithThreadInfo`), breakpoint
     anında başka bir thread `AtomicFree`/emitter update içinde mi bak.
2. **Sınırlı tanılama** (yalnızca izole Speed worktree'sinde, assert
   kaldırılmadan): `AtomicFree` ve `Free` girişlerine (a) eleman işaretçisi,
   (b) çağıran dönüş adresi, (c) üç sayaç, (d) kare numarası yazan halka
   tamponu ekle; breakpoint'te bu tamponu boşalt. Böylece "ikinci kez kim
   serbest bıraktı" sorusu doğrudan yanıtlanır.
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
