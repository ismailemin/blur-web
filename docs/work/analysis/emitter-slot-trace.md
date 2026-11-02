# Trail yuvası izlemesi — bayat `(t,b,i)` kimliği

**Durum:** tanılama tamamlandı; **hiçbir düzeltme uygulanmadı ve önerilmiyor**.
`Atomic.h:315-316` (`DebugBreak`) değiştirilmedi; assert aynen duruyor. Tanılama
kaynağı geri alındı (izole worktree `git status` temiz, kanonik `Amax.exe`
`e9727929…a254` değişmedi).
**Tarih:** 2 Kasım 2026 (P13)
**Kapsam:** yalnızca `_work/native-source/Blur1PCDX11` içinde geçici, env-gated
izleme + 3 koşu + tam bellek dump'ı. Proje kaynağı, `upstream/`, oyun verisi ve
mevcut analiz belgeleri değiştirilmedi.
**Önceki belgeler:** `docs/work/analysis/emitter-slot-ownership.md` (§10 adım 1),
`docs/work/analysis/native-particle-crash.md` (H11), `docs/work/analysis/emitter-ownership-next.md`.

---

## 0. Kısa hüküm

1. **Bayat yuva kimliği bulundu.** Kilitlenen ikinci serbest bırakma her üç koşuda
   da `t = 0` yuvasında; `b` ve `i` koşuya göre değişiyor:
   `(0,0,0)`, `(0,0,0)`, `(0,0,2)`. Yuvanın `iSalt` değeri **0**, emitter'ın
   `GetSalt()` değeri **0** — yani `SuperEffect.cpp:226` karşılaştırması eşit
   çıkıyor ve `else` dalındaki `AtomicFree` çalışıyor (salt korumasının bu yolda
   neden etkisiz olduğu doğrulandı).
2. `pEmitter->m_VectorPosition` değeri ikinci bırakma anında **-1**: emitter
   **daha önce serbest bırakılmış** ve arada yeniden dağıtılmamış. Dump'ta aynı
   işaretçi hem `m_Deleted[0]` hem de `m_Cache` içinde (run1 `[216]`, run2
   `[225]`, run3 `[205]`) — yani serbest liste ile silinen kuyruğu aynı nesneyi
   taşıyor (T5'in bu build'deki tekrarı).
3. Yuva **canlı aralıkta**: `i < Size()` (üç koşuda da). Yani fatal yuva
   `[Size(), Capacity())` kuyruk artığı **değil**. (Dump, `FreeParticle`
   tamamlandıktan sonra alındığı için `Size()` orada bir küçük görünüyor.)
4. Aynı yuva, fatal olaydan **300–1400 ms önce** `UpdateTrails` tarafından
   `epos = -1` olarak *görülmüş*, ama temizlenmemiş: `UpdateTrails` yalnızca salt
   uyuşmazlığında `pEmitter = NULL` yapıyor (SC4); salt eşitken (-1 durumu dahil)
   dokunmuyor.
5. **Yeni ve daha temel bulgu:** trail eleman vektörünün adımı **8 bayt**, oysa
   `C_Particle_E` x64'te **16 bayt**. Kanıt: `Manager.cpp:151`
   `SetElementSize(8)` (+ upstream `:151` aynı), çalışma zamanında ardışık yuva
   adresleri arasındaki fark 8, dump'ta `m_Element.ElementSize() == 8`. Sonuç:
   `iSalt` yazımı komşu elemanın `pEmitter`'ının alt 4 baytına düşer ve
   `*pDest = *pSrc` (16 baytlık kopya) 8 baytlık adımın üzerine yazar. Bu, C5'teki
   "salt hep 0" gözleminin de mekanik nedenidir.

Bu belge bir düzeltme iddiası taşımaz; 3 temiz koşu da "düzeltildi" demek için
yeterli değildir (A6).

---

## 1. Yöntem

**Tanılama (yalnızca izole worktree, env-gated).** Patch:
`_work/build/engine-reference/native-slot-trace.patch` (18.522 B). `BLUR2PC_SLOT_TRACE`
bir dosya yolu gösterdiğinde satır başına `fflush` ile yazar; değişken yoksa her
çağrı no-op. Ölçülen alanlar: `pParticle` (yuva adresi), `t`, `b`
(`pBlock->m_VectorPosition`), `bTrail` (`trailPtrs[t]->m_VectorPosition`), `i`,
`slotSize`/`slotCap` (`m_Element.Size()/Capacity()`), `pEmitter`, `iSalt`,
`pEmitter->GetSalt()`, `pEmitter->m_VectorPosition` (`epos`, `+0xB0`),
`pEmitter->GetDefinition()`, ve `cached/active` sayaçları. Olay etiketleri:
`spawn`, `freeParticle`, `updateStale`, `effectFree`, `deleteTrail`, `release`
(`Emitter::Free/AtomicFree/Update-259/Update-493`), `enqueue` (`AtomicFree`),
`drain` (`Free`, assert'ten **önce**). Hiçbir dallanma, sayaç veya sıra değişmedi;
yuva `res` alanı yalnızca mevcut `if/else` dalını önceden etiketler.

**Build.** Ayrı çıktı: `_work/run/Amax-slot-trace.exe`; kanonik `Amax.exe`'nin
üzerine yazılmadı. Derleme exit 0, 58,6 s; değişen dosyalarda `/W4` uyarısı yok
(logdaki C4091/C4312/C4172 uyarıları bu değişikliklerden bağımsız, mevcut
`Amax`/network kaynaklarında). Koşularda kullanılan binary `74ab3444…`; patch
yayımlandıktan sonra aynı kaynaktan yeniden derlenen binary `fb2b2ed8…` oldu ama
**`.text` bölümü bit-birebir aynı** (`1a1944…`), yani patch izlenen kodu üretiyor.

**Koşu.** `tools/game_slot.ps1` üzerinden kuyruğa girildi (mutex
`Global\Blur2PC.GameSlot`), pencere minimize, `BLUR2PC_FRAMELIMIT=60`, mevcut
private ayar/kayıt. Senaryo: `scripts/race-native/smoke.txt`
(`9c764308…b5ff`): gaz (W) ~12 s'de basılıyor, 16.07 s'de bırakılıyor; süreç
14,7–17,3 s'de çöktü (run2/run3'te `key up` satırı yazılmadan). 3 koşu,
aralarında ayar/kayıt değişikliği yok. Her koşuda `0x80000003` anında
`MiniDumpWriteDump(0x1026)` ile **tam bellek** dump'ı alındı (1,45–1,47 GB), sonra
süreç sonlandırıldı.

**Dump eşlemesi.** `mdmp2.py` (salt okunur, mmap) ile: cache sayaçları,
`m_Deleted[0]`, emitter `+0xB0`, yuva içeriği ve trail bloğun `m_Element`
tanımlayıcısı okundu. Script'ler `_work/analysis/slot-trace/` altında (commit
edilmedi).

---

## 2. Sonuçlar

### 2.1 Üç koşu (hepsi `0x80000003`, dump alındı)

| | run1 | run2 | run3 |
| --- | --- | --- | --- |
| Çökme (debug-event) | 17.332 s | 14.726 s | 16.491 s |
| ExitCode | `0x80000003` | `0x80000003` | `0x80000003` |
| Dump | 1.459.031.811 B | 1.466.517.795 B | 1.454.870.131 B |
| **Bayat yuva `(t,b,i)`** | **(0,0,0)** | **(0,0,0)** | **(0,0,2)** |
| Yuva adresi | `0x1dd8a094e00` | `0x1c578305200` | `0x1bf2c895210` |
| Trail blok | `0x1dd82d6d080` | `0x1c5815f2280` | `0x1bf20fc7250` |
| `slotSize` / `slotCap` (fatal okuma) | 1 / 32 | 1 / 32 | 4 / 32 |
| `i < Size()` (canlı mı?) | **evet** | **evet** | **evet** |
| `b == bTrail` | evet | evet | evet |
| `mainSize` | 1 | 1 | 4 |
| `pEmitter` | `0x1dd849d3380` | `0x1c58488cd90` | `0x1bf2b5d3790` |
| `iSalt` / `GetSalt()` | **0 / 0** | **0 / 0** | **0 / 0** |
| `epos` (ikinci bırakma) | **-1** | **-1** | **-1** |
| sayaçlar (cached/active) | 220 / 36 | 230 / 26 | 208 / 48 |

### 2.2 Aynı emitter'ın yaşam çizgisi (trace)

Üçünde de aynı desen: emitter trail yuvasında doğuyor → **ilk** bırakma yine
`FreeParticle` → `enqueue` → `drain` ile (meşru) oluyor → `epos = -1` kalıyor →
kayıt başka bir indekste **canlı** yuvada görünmeye devam ediyor → o yuvada
ikinci kez `AtomicFree` → aynı karede drenaj `-1` görüp `DebugBreak`.

| | run1 | run2 | run3 |
| --- | --- | --- | --- |
| spawn `(t,b,i)` | (0,3,4) | (0,1,5) | (0,2,6) |
| ilk bırakma `(t,b,i)` | (0,1,2) | (0,1,1) | (0,2,6) |
| ilk bırakma → fatal | 700 ms | 1.434 ms | 733 ms |
| `epos=-1` ilk görülme → fatal | 634 ms | 1.417 ms | 300 ms |
| fatal `(t,b,i)` | (0,0,0) | (0,0,0) | (0,0,2) |

İlk bırakma ile fatal arasında `b` 1→0 (run1/run2) ve 2→0 (run3) değişiyor; bu
`UpdateMemory` blok sıkıştırmasıdır, yuva adresi değişmez.

### 2.3 Dump ile eşleme (üçü de tutarlı)

- Cache sayaçları trace ile birebir: `cached/active` = 220/36, 230/26, 208/48;
  `m_DeletedElements = 1`.
- `m_Deleted[0]` = trace'teki `pEmitter` (üçünde de **True**); aynı işaretçi
  `m_Cache` içinde de var (sırasıyla `[216]`, `[225]`, `[205]`), yani nesne hem
  serbest listede hem silinen kuyruğunda.
- `pEmitter + 0xB0` = **-1** (serbest listede).
- Trail blok: `m_EffectIndex = 0` (=`t`), `m_VectorPosition = 0` (=`b`),
  `Capacity = 32`, `ElementSize = 8`, `m_pData + i*8 = yuva adresi` (kimlik
  doğrulandı).
- run1/run2 dump'ında `Size() = 0`, `pEmitter` hâlâ `m_Deleted[0]`, `iSalt = 0`:
  `Size()==1` iken `pSrc == pDest` olduğu için `FreeParticle` kendi üzerine
  kopyalamış (S2a), `PopBack` canlı aralığı 0'a indirmiş.
- run3 dump'ında yuvadaki ikinci alan `0x2B5D3790` = `0x1BF2B5D3790`'ın **alt 32
  biti**: "salt" alanında bir işaretçi parçası duruyor (bkz. §3/P5).

---

## 3. Kanıtlanan

**P1 — Bayat yuva ve salt'ı.** İkinci serbest bırakmayı yapan yuva
`(t,b,i)` = (0,0,0), (0,0,0), (0,0,2); `iSalt = 0`, `GetSalt() = 0`. Yani H11
kapanır: hangi yuva olduğu biliniyor ve salt korumasının neden ateşlenmediği
(C5) üç bağımsız koşuda doğrulandı.

**P2 — `pEmitter` zaten serbestti.** İkinci bırakma anında `epos = -1`; ilk
bırakma aynı emitter için `FreeParticle → enqueue → drain` olarak trace'te
duruyor; `enqueue` ile `drain` sayaçları aynı (araya ayırma girmemiş); dump'ta
`m_Deleted[0]` = aynı işaretçi, `+0xB0 = -1` ve işaretçi `m_Cache` içinde
(run1 `[216]`, run2 `[225]`, run3 `[205]`). Yani "zaten bırakılmış emitter'ı
yeniden bırakma" doğrudan kanıt; nesne aynı anda serbest listede ve silinen
kuyruğunda.

**P3 — Yuva canlı aralıkta.** Fatal okumada `i < Size()` (1/1, 1/1, 4/4);
`b == bTrail`. Yani ne `[Size(), Capacity())` kuyruk artığı ne de blok indeksi
kayması (S6) bu olayın nedeni. (S2a artefaktı yalnızca *sonrasında* oluşuyor.)

**P4 — `UpdateTrails` bayatlığı görüp temizlemiyor.** Aynı yuva 300–1400 ms
boyunca her karede `why=eposMinusOne` ile loglandı; kod yalnızca salt
uyuşmazlığında `NULL` yazdığı için (SC4) `epos=-1` durumu ele alınmıyor ve
emitter ölü hâlde kullanılmaya devam ediyor.

**P5 — Trail eleman adımı 8 bayt, `C_Particle_E` 16 bayt (x64).** Üç bağımsız
kanıt: (a) `Manager.cpp:151` `m_ParticleTrailBlockManager.SetElementSize(8)`
(upstream `:151` aynı); (b) trace'te aynı blok içinde `i` ve `i+1` yuva adresleri
8 bayt arayla; (c) dump'ta `m_Element.ElementSize() == 8`. `Particle.h:226-231`
sınıfı işaretçi + `U32` taşıdığı için x64'te 16 bayttır. Sonuçları:
`iSalt` yazımı `slot+8`'e, yani **komşu elemanın `pEmitter`'ına** düşer;
`*pDest = *pSrc` (`SuperEffect.cpp:236`) 16 bayt yazar, 8 baytlık adımın üstünden
geçer ve komşu yuvanın işaretçisini de kopyalar/sıfırlar; `iSalt` okuması komşu
işaretçinin alt 32 bitini verir. Trace'te `iSalt` alanında görülen
`2522365216`, `727529360` gibi değerler bu yüzden işaretçi parçalarıdır.

**P6 — Tekrarlanabilirlik.** Üç koşunun üçünde de aynı sınıf (`0x80000003`), üç
tam dump, aynı yuva deseni. Bu, izlemenin zamanlamayı kaydırdığı (H10) bir
build'de geçerlidir; temel çizgiyle oran karşılaştırması **yapılmadı** (§4).

---

## 4. Kanıtlanmayan / sınırlar

1. **Kaydı kimin çoğalttığı tek tek izlenmedi.** `FreeParticle`'ın kopyala-son
   adımı (`:234-237`) loglanmadı; bu yüzden "bayat kaydı canlı aralığa sokan
   tam kopya" P5 ile tutarlı ama tek tek kanıtlanmadı. Kimlik (§3/P1) bundan
   bağımsız olarak kesindir.
2. **8 baytlık adımın tek başına düzeltilmesi test edilmedi.** Adım 16'ya
   çıkarılırsa yuva adresleri ve `iSalt`/`pEmitter` semantiği tümüyle değişir;
   çift bırakmanın biteceği **iddia edilmiyor**.
3. **`sizeof(C_Particle_E)` derleme zamanı sabitlenmedi**; 16 bayt, x64 ABI'de
   sınıfın boyutudur (8 bayt işaretçi + 4 bayt `U32` + 4 bayt dolgu). Adımın
   kendisi (8) ise doğrudan ölçüldü (§3/P5).
4. **Trace zamanlamayı kaydırıyor** (H10): bu build'de 3/3 breakpoint görüldü;
   aynı oturumda kanonik `Amax.exe` ile eşleştirilmiş koşu yapılmadı, dolayısıyla
   "oran değişti" denemez.
5. **Dump'ta ExceptionStream yok** (`exception stream=None`), yalnız tam bellek
   var. Bu nedenle register/thread çakışması okunamıyor; kimlik zaten trace'ten
   geliyor. `0x80000003` anında alınan dump önceki turlardan farklı olarak
   breakpoint anını yakalıyor (dump boyu 1,45 GB, `Memory64List`).
6. Debug-event tarafında `DEBUG_EVENT` birleşiminin ofseti bu platformda **16**;
   ofset 12 dolgu baytıdır (koşular arasında değişen `0x1C5`, `0x1922F492`
   değerleri). Bu, dump yakalamanın neden ilk denemede tetiklenmediğini açıklar;
   `0x80000003`/`0xC0000005` tespiti iki ofseti de denetleyecek şekilde
   düzeltildi.
7. **Önceki dump okumaları (S4/T9) 16 baytlık kayıt varsayıyordu.** Ölçülen adım
   8 olduğu için o yorumların yeniden değerlendirilmesi gerekir; bu belge onları
   düzeltmiyor, yalnızca çelişkiyi kaydediyor.

---

## 5. Yuva tasarımıyla ilişki ve sıradaki en küçük adım

`emitter-slot-ownership.md` §5'teki TEK-YUVA değişmezi ve §6'daki 1-14 maddeleri,
**her yuvanın 16 baytlık bir `C_Particle_E` olduğu** varsayımına dayanır
(`§1` tablosu, `slot.pEmitter`/`slot.iSalt`). Ölçüm bu varsayımı çürütüyor:
gerçek adım 8 bayt. Bu durumda:

- Madde 1 (`C_Particle_E::Clear()`), 12 (`pSrc->Clear()`) ve 13
  (`pParticle->Clear()`) `pEmitter` **ve** `iSalt` yazar; madde 11 ise `pDest`'e
  geri-referans bağlar. 8 baytlık adımda `iSalt` komşu yuvaya düştüğü için bu
  maddeler **komşu yuvanın `pEmitter`'ını** bozar; yani 1-14'ü bu hâliyle
  uygulamak yeni bir hata sınıfı üretir.
- Kimlik artık bilindiği için 1-14 "Tanımlanabilir" hâle geldi, ancak
  **önkoşulları sağlanmıyor**.

**Sıradaki en küçük adım (uygulanmadı, iddia değil):** `m_ParticleTrailBlockManager`
eleman boyu kararını ölçmek — (a) `sizeof(C_Particle_E)`'yi bu x64 build'de
derleme zamanı `static_assert`/log ile sabitlemek, (b) `SetElementSize(8)`'in
32-bit kalıntısı mı yoksa kasıtlı mı olduğunu retail binary ile karşılaştırmak,
(c) ancak bundan sonra 1-14'ün hangi maddelerinin 16 baytlık varsayımla
yazıldığını gözden geçirmek. Bu adım tamamlanmadan ne 1-14 ne de §6/15
uygulanmalıdır. Assert kaldırılmaz; bu belge bir düzeltme iddiası taşımaz.

---

## 6. Kanıt yerleri

Klasör: `_work/native-source/Blur1PCDX11/_work/run/scripts/race-native-slot-trace/`

| Dosya | Bayt | SHA-256 |
| --- | ---: | --- |
| `run1/slot-trace.log` | 104.492 | `5ac59242a29288f5c92498ccf9620a66a57a76a290f9d5688e0b96c304bc266d` |
| `run1/dumps/full-0x80000003.dmp` | 1.459.031.811 | `88f6895aab4815b4deae8ddad81c2eb3a551c813255733f6cc73ef87e6c6d02e` |
| `run2/slot-trace.log` | 70.219 | `a5549ef78f7e8f3c4b10c2a302ce4a367506f06917c18fc3f5b1e1c3cb021011` |
| `run2/dumps/full-0x80000003.dmp` | 1.466.517.795 | `c0abb845417cafb5dc1820846b05e020fb533415286ed8d394d010869c6287f1` |
| `run3/slot-trace.log` | 90.459 | `dd096e784f2e2cdff5ebe5c39e66a423bab73b7a7b3f544155aab122a134c8a2` |
| `run3/dumps/full-0x80000003.dmp` | 1.454.870.131 | `5c45c3f15f747cd076e0bc76609608a38edf657425587f0be59deebc0cadbe70` |

Her koşuda ayrıca `run-result.json`, `debug-events.log`, `automation.log`.
Toplu kayıt: `_work/analysis/slot-trace/evidence.json`.

| Artefakt | Yol | SHA-256 |
| --- | --- | --- |
| Patch | `_work/build/engine-reference/native-slot-trace.patch` (18.522 B) | `4f7f585c3112879ea4580adca4e6d87e7aaec92778e6523c4cc59f03f3906d77` |
| Build log | `_work/logs/amax-slottrace-build.log` | `cc58e57adab3acb5f523c64761a3570a85ac4e3fa58b33179b8b643211eaae3c` |
| Build sonucu | `_work/build/engine-reference/amax-x64-slottrace-result.json` | — (exit 0, 58,6 s) |
| İzleme EXE (koşularda) | `_work/run/Amax-slot-trace.exe` | `74ab34440557d350101696c1b60160d3d0e13297fb17131ae0ae0d41e01b0e09` (24.351.744 B) |
| İzleme EXE (yeniden derleme) | aynı yol | `fb2b2ed8408733bbf720614abf918e2133d9fef3954bf10c093640a356f0ce56`; `.text` = `1a19445652903b975c892f97c244ed2af5d080c637db1dda5070251a1eb776c4` (koşulardaki ile aynı) |
| Kanonik EXE | `_work/run/Amax.exe` | `e9727929768d1e8e2b41ec6abfa836c4134cd397e571c8b9ba1129c91a5a254` (değişmedi) |

Yardımcı (commit edilmedi): `_work/analysis/slot-trace/{correlate.py,verify_dump.py,cache_membership.py,evidence.py,pe_sections.py,analysis-output.log}`,
`_work/run_slot_trace.ps1`, `_work/slot_trace_launcher.ps1`.

> Bu belge bir düzeltme iddiası taşımaz. `Atomic.h:315-316` assert'i aynen
> duruyor; uygulanmış hiçbir davranış değişikliği yok; izole kaynak geri alındı.
