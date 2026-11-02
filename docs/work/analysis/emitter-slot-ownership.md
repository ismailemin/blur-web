# Emitter yuva (slot) sahipliği — çift serbest bırakma için en küçük düzeltme tasarımı

**Durum:** salt okunur kaynak analizi. Hiçbir kaynak/derleme/oyun dosyası değiştirilmedi,
oyun çalıştırılmadı. Bu belge bir **düzeltme iddiası taşımaz** ve
`Atomic.h:315-316` kontrolünün (`DebugBreak`) kaldırılmasını/zayıflatılmasını önermez.
**Tarih:** 2 Kasım 2026 (P12)
**Kaynak:** `_work/native-source/Blur1PCDX11/code/mercury/library/graphics/dynamic`
(temel çizgi), `docs/work/analysis/native-particle-crash.md` (K/T/C/SC/M/D/E serisi),
`docs/work/analysis/emitter-ownership-next.md` (aday 2'nin reddi).
**Önceki üç deneme reddedildi:** nesil artışı kuyrukta (D1-D4), nesil artışı drenajda
(E1-E5), trail bloğu temizliği (sekizinci tur). Bu belge **dördüncü** bir deneme
önermez; **yuva düzeyinde** bir sahiplik değişmezi tanımlar ve neden diğerlerinden
farklı bir hata sınıfı üretmesi beklendiğini yazar.

---

## 0. Kısa hüküm

1. Çift bırakmanın üreticisi **nesil (salt) sayacının eksikliği değil**, emitter ile onu
   gösteren yuva arasında **hiçbir bağ olmamasıdır** (SC1: bağ tek yönlü). Emitter öldüğünde
   yuvayı geçersiz kılacak bir yol yok; yuva bunu ancak *bir sonraki dokunuşta* ve yalnız
   salt karşılaştırmasıyla fark edebiliyor (M2).
2. Bu yüzden doğru düzeltme noktası **sayacın ne zaman artacağı** değil, **yuvanın kim
   tarafından ve ne zaman NULL'lanacağı**dır. En küçük bunu yapan mekanizma, emitter'da
   tek bir **yuva geri-referansı** (`C_Particle_E*`) tutmak ve **bırakma anında yuvayı
   emitter'ın kendisinin temizlemesi**dir (O(1), arama yok, sayaç yok, zamanlama değişikliği yok).
3. Üç eski denemenin AV üretmesinin en güçlü açıklaması şudur (kanıt değil, H17/H21/H22):
   hepsi **canlı** referansların görünürlüğünü değiştirdi (salt ilerledi → canlı yuvlar
   NULL'landı; drenaj yeniden yönlendirildi → iki havuz + `C_EmitterList::Free` içindeki
   `DebugBreak` devreye girdi). Bu tasarım **hiçbir canlı referansı geçersiz kılmaz**;
   yalnız **zaten bırakılmak üzere olan** emitter'ı gösteren yuvayı NULL'lar.
4. Yeni kaynak okumasıyla bulunan iki yuva düzeyi kusur (S3, S5) bu tasarımın
   gerekçesini güçlendiriyor: `DeleteTrailBlock` canlı emitter için **ölü yoldur**
   (blok ancak boşken kuyruğa giriyor), ve `UpdateMemory`'de trail blok eşlemesi
   `NULL` durumunda **bayat pointer bırakıyor**.

---

## 1. Yuva modeli: hangi bellek hücresi hangi partikülün

`C_Particle_E` yalnızca `{C_Emitter* pEmitter; U32 iSalt;}` (16 bayt,
`include/dynamic/particle/Particle.h:226-231`).

Yuva kimliği **üçlüdür**: `(t, b, i)`

| bileşen | anlamı | kaynak |
| --- | --- | --- |
| `t` | trail efekti indeksi, `0..trailEffects.Size()-1`, **en fazla 4** | `Super.h:40` (`VectorParameters_Static<4>`) |
| `b` | ana partikül bloğunun `m_VectorPosition`'ı; trail bloğu aynı indekste | `SuperSpawn.cpp:145-147`, `SuperEffect.cpp:148-152` |
| `i` | partikül indeksi; `0 <= i < m_Element.Size()` | `SuperEffect.cpp:66,86,223` |

**Otorite:** canlı kayıt `trailEffects[t].blocks[b]->m_Element[i]`, `i < Size()`.
`[Size(), Capacity())` aralığı **yuva değildir**; `ElementVector::Clear()`/`PopBack()`
yalnız `m_Size`'ı değiştirir (`include/dynamic/Block.h:66,87`), dolayısıyla bu baytlar
bayat `C_Particle_E` kayıtları olarak blokla birlikte geri dönüşüme girer (SC10).
Emitter tarafındaki `iSalt` bir **ipucudur**, sahiplik kanıtı değildir (S5/C5).

### 1.1 `pEmitter`'ı yazan/temizleyen tüm yerler (tam liste)

| # | yer | işlem | koruma | yuva kimliği |
| --- | --- | --- | --- | --- |
| W1 | `SuperSpawn.cpp:22-26` (`NewParticle`) | yazar + `iSalt` kopyalar | `if(AtomicAllocate())` | yeni `PushBack` indeksi |
| W2 | `SuperSpawn.cpp:43-47` (`NewParticles`) | aynı | aynı | aynı |
| C1 | `SuperEffect.cpp:219` (`memcpy`) | ana partikülü taşır (yuva değil) | — | `i` ← `Size()-1` |
| C2 | `SuperEffect.cpp:236` (`*pDest = *pSrc`) | **yuvayı taşır** (`pEmitter`+`iSalt`) | — | `i` ← `Size()-1` |
| W3 | `SuperEffect.cpp:76` (`Free`, efekt yıkımı) | salt uyuşmazsa `NULL` | `if(pEmitter)` | tüm canlı yuvlar |
| W4 | `SuperEffect.cpp:191` (`DeleteTrailBlock`) | aynı | aynı | blok yuvları |
| W5 | `SuperEffect.cpp:227` (`FreeParticle`) | aynı | aynı | `i` |
| W6 | `SuperEffect.cpp:255` / `:278` (XM `UpdateTrails`, PC'de derlenmez) | aynı | aynı | `iIndex` |
| W7 | `SuperEffect.cpp:415` / `:436` (**PC'de derlenen** `UpdateTrails`) | aynı | aynı | `iIndex` |
| R1 | `SuperSpawn.cpp:189-195` (`CreateTrails`) | yalnız **okur**, salt kontrolü yok | `if(pEmitter)` | `Size()-1` |

**Sonuç (S1):** `pEmitter`'ı geçersiz kılan tek mekanizma **salt karşılaştırmasıdır**
(W3-W7). Emitter ölümü, drenaj, blok geri dönüşümü hiçbiri yuvayı **temizlemez**;
hepsi "bir sonraki dokunuşa" erteler. Bu, `emitter-ownership-next.md` §0'ı doğrular ve
**yuva düzeyi** düzeltmenin neden gerekli olduğunu gösterir: ertelenen karar, karar
verilene kadar yuvayı **potansiyel olarak serbest bırakılmış bir işaretçi** tutar hâle getirir.

---

## 2. `FreeParticle` (`SuperEffect.cpp:214-243`): bayat yuva kalabilir mi?

Sıra:

```
217-219  pSrc = &main[Size()-1]; pDest = &main[i]; memcpy(pDest, pSrc)
221-230  her t için: slot = &trail[t][i]
           pEmitter ? (iSalt != GetSalt() ? slot.pEmitter = NULL : AtomicFree(pEmitter))
233-237  her t için: *slot[i] = *slot[Size()-1]      // kopyala-son
239      her t için: trail[t].PopBack()
242      main.PopBack()
```

**Bulunan (S2): canlı aralıkta bayat yuva kalmaz — *eğer* diziler hizalıysa.**
Kopyala-son, son partikülün yuvasını `i`'ye taşır, `PopBack` canlı aralığı bir küçültür;
her emitter işaretçisi canlı aralıkta **en fazla bir** yuvada bulunur. Dolayısıyla
`i`'deki yuva `AtomicFree`'den sonra ya `NULL`'dır ya da **başka bir canlı partikülün**
emitter'ını taşır. Sorun iki yerden doğar:

**(a) `Size()==1` durumu (S2a).** `pSrc == pDest` olur: slot kendi emitter'ını
`AtomicFree` eder, sonra kendini kendine kopyalar, `PopBack` ile canlı aralık 0'a iner.
Baytlar yerinde kalır (16 baytlık serbest emitter işaretçisi), `Clear()` çağrılmadığı
için blok havuza **bayat kayıtla** döner. Bu kayıt canlı yuva değildir ama bir sonraki
`PushBack` **her zaman** üzerine yazar (W1/W2: atama koşulsuz), dolayısıyla tek başına
çift bırakma üretmez; yine de blok geri dönüşümü hijyeninin parçasıdır (S3 ile birlikte).

**(b) Diziler hizasızsa (S2b).** Hiza varsayımı `SuperSpawn.cpp:20,41,87` assert'lerine
dayanır ve bu assert'ler **derlenmiyor** (M0/SC9). Hiza bozulursa `FreeParticle`, `i`
indeksindeki yuvada **başka bir canlı partikülün** emitter'ını bırakır: yani "slot
otoritesi" ile "partikül `i`" ayrışır. Bu, trace'teki 231-232 satırının (bir yuvanın
*serbest listedeki* emitter'ı tekrar kuyruğa atması) en doğal açıklamasıdır ve
`H13` (aliasing) için kanıt gerektirmeyen bir mekanizma sunar.

**Hangi yuva otorite?** `(t, b, i)` üçlüsü, `b = mainBlock->m_VectorPosition`,
`i < Size()`. `iSalt` otorite değildir (0 == 0, C5/S5).

---

## 3. `UpdateTrails` / `DeleteTrailBlock` / `I_ParticleSuperEffect::Free`

| yol | yuvaları temizler mi | emitter'ı bırakır mı | sıra |
| --- | --- | --- | --- |
| `UpdateTrails` (`:407-425`, `:428-445`; XM `:249-291`) | yalnız salt uyuşmazsa `NULL` | hayır | dokunma anında |
| `FreeParticle` (`:214-243`) | `AtomicFree`'den **sonra** kopya ile üzerine yazar; `NULL` yalnız salt uyuşmazsa | **evet** (`:229`) | önce bırak, sonra kopyala |
| `DeleteTrailBlock` (`:180-207`) | `NULL` **etmez** (yalnız salt uyuşmazsa) | **koşullu** (`:193`) | silmeden önce |
| `I_ParticleSuperEffect::Free` (`:61-103`) | emitter bırakır, sonra `m_Element.Clear()` (`:82`) — ama `pEmitter` **NULL'lanmaz** | **evet** (`:78`) | bırak → Clear |

**Bulunan (S3): `DeleteTrailBlock` canlı emitter için ölü yoldur.** Bu fonksiyon
`Manager.cpp:1344-1355` içinden, yalnız `m_DeletedSuperBlocks` kayıtları için çağrılır;
kayıt ise **yalnız ana blok boşken** kuyruğa girer (`Shape2DSimpleSuper.cpp:75-91`,
`Shape3DSimpleSuper.cpp:73`, `Shape2DCollisionSuper.cpp:104`, `Shape3DCollisionSuper.cpp:93`,
`SpriteRotatingSuper.cpp:77`). Trail dizileri ana blokla paralel olduğu için
`DeleteTrailBlock` çağrıldığında `m_Element.Size() == 0`'dır ⇒ `:185-195` döngüsü
**hiç dönmez** ve hiçbir emitter bırakılmaz; `:206` `FreeBlock` ise bayat baytları
havuza taşır. Bu, **Aday 1 / üçüncü denemenin (trail cleanup) neden etkisiz kaldığını
birebir açıklar**: eklenen `pEmitter = NULL` döngüsü sıfır eleman üzerinde çalıştı ve
`m_Element.Clear()` zaten 0 olan `m_Size`'ı sıfırladı. (Aynı bulgu, kural B'nin
"blok sahibi bırakır" ayağının **canlı yuvlar için hiç uygulanmadığını** da gösterir.)
Tek istisna hiza bozulmasıdır (S2b) — o zaman blok boş sanılırken trail dizisi dolu olur.

**Bulunan (S4): `Free` (efekt yıkımı) `Clear()`'dan önce `pEmitter`'ı NULL'lamıyor**
(`:73-80` `Free(...)` çağırır, `:82` `Clear()`). Emitter senkron `Free` ile bırakıldığı
için salt artar (`emitterlist.cpp:24`) ve aynı blok yeniden kullanılırsa bayat kayıt
zaten `Size()==0` aralığındadır; yani bu yol **tek başına** çift bırakma üretmez, ama
`pEmitter`'ı da temizlemediği için S2a/S3 ile aynı hijyen eksiğini paylaşır.

---

## 4. `C_Emitter::Update` / `m_bDelete` / `AtomicFree`

İki kendini bırakma noktası (`Emitter.cpp:250-500`):

| # | yer | koşul | biçim |
| --- | --- | --- | --- |
| R3 | `:256-261` | `m_bDelete` | `AtomicFree(pEmitterEA)` (ertelenmiş) |
| R4 | `:490-496` | `m_fCycle > m_fDuration && !bRepeating && !(eventInstance && Repeating())` ve `m_nNumEmit == 0` | `AtomicFree(...)`, değilse `m_bDelete = true` (`:495`) |

**Cevap: evet, emitter yuva hâlâ onu gösterirken kendini bırakabilir.** Kanıt:
`AtomicFree` yuvaya hiç dokunmaz (`Atomic.h:305-309`), `Emitter.cpp:170-180` de
dokunmaz; yuvayı geçersiz kılacak tek yer `UpdateTrails`'in salt karşılaştırmasıdır ve
o da *bir sonraki karede* çalışır (SC4/SC8). Trace'teki 225. satır tam olarak budur
(`Emitter::Update-259` → `AtomicFree-179`).

**Ancak (S5, önemli ayrım):** trail tanımları `bRepeating = true` **zorlanarak**
üretildiği için (`SuperEffect.cpp:35`), *hiç geri dönüştürülmemiş* bir trail emitter'ı
R3/R4'e **ulaşamaz** (`:481-484` her zaman `Reset(random)` dalına girer). Yani 225.
satırdaki kendini bırakma, **trail görevinden başka bir göreve geri dönüştürülmüş**
bir emitter'a aittir; o emitter'ı gösteren yuva ise **önceki trail hayatından kalmadır**.
Bu, `emitter-ownership-next.md` §0'daki "aday 2 no-op" sonucunun tamamlayıcısıdır:
nesne düzeyi bayrak bu durumu **göremez** (bayrak `SetDefinition`'da sıfırlanınca
ateşlenmez, sıfırlanmazsa sızar), çünkü sorun **emitter'ın kendi durumunda değil, yuvada**dır.

**Bulunan (S6): `I_ParticleSuperEffect::UpdateMemory` (`:136-158`) trail blok eşlemesini
bayat bırakabilir.** Ana blok `b` boşsa son blok `end`'den `b`'ye taşınır; trail tarafında
`if(ParticleTrailBlock* pTrailBlock = blocks[end])` varsa `blocks[b] = pTrailBlock` yapılır,
**`else` yoktur** ⇒ `end` trail bloğu `NULL` ise `blocks[b]` **eski (yanlış) pointer** olarak
kalır. `blocks.Size(m_nBlocks)` küçültmesi `end` gözünü düşürür ama `b` gözü artık başka
bir partikül bloğunun emitter'larını tutar. Sonuç: `(t, b, i)` otoritesi ile gerçek
partikül `i` ayrışır — S2b'nin kaynak düzeyi üreticisi. (Hipotez: gözlenen "aynı işaretçi
iki komşu yuvada" durumunun bir açıklaması budur; runtime kanıtı yok.)

---

## 5. Tasarım: TEK-YUVA değişmezi (slot authority)

### 5.1 Değişmez (yazılı sözleşme)

> **S1 (TEK-YUVA):** Canlı her `C_Particle_E` yuvası için
> `slot.pEmitter != NULL` ⇒
> **(a)** `slot.pEmitter->m_VectorPosition >= 0` (emitter şu anda tahsis edilmiş), ve
> **(b)** `slot.pEmitter`'ın yuva geri-referansı **bu yuvayı** gösterir.
>
> **S2 (bırakma = yuva temizliği):** Bir emitter'ı bırakan **her** yol, bırakmadan
> **önce** onu gösteren yuvayı `NULL`'lar. Yani "bırakılmış emitter'ı gösteren canlı yuva"
> durumu hiçbir zaman oluşmaz; salt karşılaştırması artık **yedek** kontroldür, birincil
> mekanizma değil.

(b) için gereken tek yeni alan: `C_Emitter::C_Particle_E* m_pTrailSlot` (8 bayt).

### 5.2 Neden bu, üç reddedilen denemeden farklı

| deneme | neyi değiştirdi | neden aynı sınıf hatayı üretmesi beklenmez |
| --- | --- | --- |
| 1 (kuyrukta `m_iSalt += 1`) | **canlı** emitter'ın neslini ilerletti | bu tasarımda salt'a **hiç yazılmaz**; canlı yuvalar NULL'lanmaz |
| 2 (drenajda `C_EmitterList::Free`) | drenaj içeriğini + iki havuzu + `Free` içindeki `DebugBreak`'i devreye aldı | drenaj ve `Atomic.h` **değişmez**; yalnız süper-liste yuvaları ele alınır |
| 3 (`DeleteTrailBlock` temizliği) | boş blokta çalıştı (S3), canlı yuvaya hiç dokunmadı | temizlik **bırakma anında ve canlı yuvada** yapılır |
| **bu tasarım** | yuva ↔ emitter bağını kurar, bırakmadan önce yuvayı NULL'lar | bırakma sayısı **azalır** (ikinci kuyruğa giriş engellenir), artmaz; yeni geçersizleştirme icat edilmez |

Ek olarak: assert (`Atomic.h:315-316`) yerinde kalır ve **bariyer işlevi korunur**;
tasarım hatayı gizlemez, fazladan `Free`'i kaldırır. `Atomic.h` ve `Manager.cpp` diff'te
görünmez.

### 5.3 Geri-referans maliyeti vs arama maliyeti

**Geri-referans (önerilen):**
- Bellek: 2.304 canlı emitter × 8 B = **18.432 B** (S6: havuz sabit 2048+256).
- İşlem: spawn'da 1 store, kopyala-sonda 1 store, bırakmada 1 load + 1 store. **O(1)**.
- Bakım noktaları **tek**: `PushBack` (spawn) ve kopyala-son (`SuperEffect.cpp:236`);
  `UpdateMemory` blok taşır, yuva adresi değişmez; `DeleteTrailBlock` blok taşır, aynı.

**Arama (alternatif, önerilmez):**
- Emitter'dan trail bloklarına **güvenilir bir yol yok**: `m_pDefinition->pEffect`
  death/collision tanımlarında *çocuk* efekti gösterir, trail bloklarını tutan süper
  efekti değil. Yani arama "hangi efekti tarayacağım" sorusunu bile cevaplayamaz.
- Zorlanırsa üst sınır: efekt başına 4 trail × 16 blok (`SuperEffect.cpp:37`) × blok
  boyu; blok boyu 256 varsayımıyla **≈ 16.400 karşılaştırma** ve ~64 ayrık cache satırı
  *her bırakmada*, üstelik **worker thread'den**, başka bir job'ın yazdığı belleğe karşı
  (R3 `0x1CB674` scheduler worker'da çalışıyor). Bu bir veri yarışı + cache thrash riskidir.

**Ters kayıt listesi (aliasing'i de kapsar):** emitter başına `Btl::Vector<C_Particle_E*>`
→ ~24-32 B + worker job içinde **allocator trafiği** + her kopyala-son'da push/remove.
Kazanç yalnız `H13` (aliasing) durumu; o da kanıtlanmadı (S2b/S6 zaten hiza bozulmasıyla
açıklıyor). Bu yüzden **en küçük değil**.

**Sonuç:** tek pointer geri-referans, aynı kapsamı O(1) ile sağlar.

---

## 6. Değişiklik listesi (tam, file:line)

> Uygulanmadı. Aşağısı yalnız tanımdır. Hiçbir imza değişmez, `Atomic.h` ve
> `Manager.cpp` dokunulmaz, assert kaldırılmaz.

| # | dosya:satır | değişiklik |
| --- | --- | --- |
| 1 | `include/dynamic/particle/Particle.h:226-231` | `C_Particle_E::Clear()`: `pEmitter = NULL; iSalt = 0;` |
| 2 | `include/dynamic/particle/Emitter.h:306-307` (**sınıf sonu**, `m_CreateNode`'dan sonra) | `C_Particle_E* m_pTrailSlot;` + inline `SetTrailSlot/GetTrailSlot` (`:144` civarı, `SetActive` yanına) |
| 3 | `source/particle/Emitter.cpp:89` (`SetDefaults`) | `m_pTrailSlot = NULL;` |
| 4 | `source/particle/Emitter.cpp:112` (`SetDefinition`) | `m_pTrailSlot = NULL;` — geri dönüştürülen emitter bayat yuva taşımaz (S5) |
| 5 | `source/particle/Emitter.cpp:256-261` (`m_bDelete` → `AtomicFree`) | bırakmadan **önce**: `if(C_Particle_E* p = m_pTrailSlot) { p->Clear(); m_pTrailSlot = NULL; }` |
| 6 | `source/particle/Emitter.cpp:492-493` (süre bitti, emit yok → `AtomicFree`) | aynı temizlik, `AtomicFree`'den önce |
| 7 | `source/particle/SuperSpawn.cpp:25` ve `:46` (`SetDefinition` **sonrası**) | `pTrailParticle->pEmitter->SetTrailSlot(pTrailParticle);` + zaten doluysa **aliasing sayacı** (assert değil, LOGERROR) |
| 8 | `source/particle/SuperEffect.cpp:73-79` (`Free`) | `C_Emitter* pE = p->pEmitter; p->Clear(); pE->SetTrailSlot(NULL); ...->Free(pE);` |
| 9 | `source/particle/SuperEffect.cpp:188-194` (`DeleteTrailBlock`) | aynı "önce temizle, sonra bırak" (S3: canlı yuvada pratikte ölü, hiza bozulursa korur) |
| 10 | `source/particle/SuperEffect.cpp:224-230` (`FreeParticle`) | aynı "önce temizle, sonra `AtomicFree`" |
| 11 | `source/particle/SuperEffect.cpp:236` (kopyala-son, `*pDest = *pSrc` **sonrası**) | `if(pDest->pEmitter) pDest->pEmitter->SetTrailSlot(pDest);` |
| 12 | `source/particle/SuperEffect.cpp:239` (`PopBack` **önce**) | son yuvanın baytlarını temizle: `pSrc->Clear();` → S2a/S10 hijyeni |
| 13 | `source/particle/SuperEffect.cpp:413-415` ve `:434-436` (**PC'de derlenen** `UpdateTrails`) | `if (!pEmitter \|\| pEmitter->m_VectorPosition == -1) pParticle->Clear(); else if (salt != GetSalt()) pParticle->Clear();` — S1(a) yedeği + üçüncü sayaç ("stale slot hit") |
| 14 | XM varyantı `:253-255`, `:276-278` (PC'de derlenmez) | 13 ile aynı (tutarlılık) |
| 15 | `source/particle/SuperEffect.cpp:148-153` (`UpdateMemory`) | **ayrı, ikinci adım:** `else blocks[b] = NULL;` (S6 hiza onarımı) — tek başına denenmemeli |
| 16 | `source/particle/Emitter.cpp:37` yanı | üç tanılama sayacı: `g_slotCleared`, `g_slotAlias`, `g_slotStale` (LOGERROR, ≤5 kez) |

**Yerleşim uyarısı (kanıta dayalı):** yeni alan **sınıfın sonuna** konur; `m_pManager`
(`+0x188`), `m_pEventInstance` (`+0x190`), `m_pEmitterList` (`+0x198`) ve
`m_VectorPosition` (`+0xB0`, taban sınıf) **kaymaz** (S2/K7). Ancak emitter **stride'ı**
gözlenen `0x400`'den `0x408`'e çıkar (K7/S6); `_work/analysis/full-exit-dump/*` ve
`native-particle-crash.md` içindeki `0x400` varsayımı yeni build için geçersizdir —
raporda bu açıkça not edilmelidir. `static_assert(sizeof(C_Emitter) % 16 == 0)` ve
`offsetof` kontrolleri `#ifndef CFG_GOLD` altında eklenmeli.

---

## 7. Test planı

**Adım 0 — eşleştirilmiş temel çizgi (zorunlu).** Aynı oturum, aynı harness, kanonik
`_work/run/Amax.exe` (`e9727929…a254`) ile **3 koşu**. Gerekçe: temel çizgide de
"1/3 `0x80000003` + 2/3 AV" deseni görülebildi (D1/E2); tek tarihsel koşu referans alınırsa
fark yanlış atfedilir.

**Adım 1 — build.** İzole worktree `_work/native-source/Blur1PCDX11`, `tools/build.sh`
Release, `/W4` uyarısız; çıktı **`Amax-slotown.exe`** olarak `_work/run/`'a kopyalanır.
Kanonik `Amax.exe` SHA-256'sı önce/sonra doğrulanır (değişmemeli). `git status` temiz
(diff dışında `Emitter.h/.cpp`, `SuperSpawn.cpp`, `SuperEffect.cpp`, `Particle.h` yok).

**Adım 2 — koşu.** `tools/game_slot.ps1` üzerinden sıraya girilir; harness
`_work/native_crash_dump_attach.ps1` kopyası (`MiniDumpWriteDump` tipi `0x1026` = tam
bellek), `BLUR2PC_FRAMELIMIT=60`, minimized pencere, **`BLUR2PC_FREE_TRACE` kapalı**
(izleme zamanlamayı kaydırıyor, H10). Senaryo: `race-native/smoke.txt`
(666 B, `9c764308…b5ff`), `prepare_race.lua` aynı. **3 koşu**, aralarında ayar/kayıt
değişikliği yok.

**Adım 3 — başarısızlıkta tam dump (zorunlu).** `0x80000003` anında `full-0x80000003.dmp`;
`0xC0000005` için `EXIT_PROCESS_DEBUG_EVENT`'te `full-exit.dmp`. Her koşu için: ExitCode,
süre, dump adı+bayt+SHA-256, `debug-events.log`, `automation.log` son satırı,
`dump-result.json`.

**Adım 4 — yanlışlama ölçümü (bu tasarımın asıl testi).** Dump'tan ve sayaçlardan:
- `m_SuperEffectEmitters` için `cached + active == total`, `deletedN`, `m_Deleted[0]`
  ve `m_Deleted[0]->m_VectorPosition` (C4/T5 ile aynı okuma).
- Tanılama sayaçları: `g_slotCleared` (**> 0 olmalı**: mekanizma gerçekten ateşlendi),
  `g_slotAlias` (0 beklenir; > 0 ise H13 doğrulandı), `g_slotStale` (> 0 ise S1(a)
  yedeği devreye girdi = hiza bozulması var).
- Çökme yoksa bile `g_slotCleared == 0` ise sonuç **"mekanizma test edilmedi"** sayılır.

**Kabul ölçütleri**

- **A1 (ret):** 3 koşudan herhangi biri `0x80000003` **veya** `0xC0000005` ile biterse
  tasarım reddedilir.
- **A2 (tek başına "belirti yok" yetmez):** 3/3 exit 0 + `g_slotCleared > 0` +
  cache muhasebesi tutarlı + `deletedN` drenaj sonrası 0 **birlikte** aranır.
- **A3 (kanıt bütünlüğü):** başarısızlıkta tam dump yoksa koşu "sonuçsuz" sayılır,
  "geçti" sayılmaz (D2/E4).
- **A4 (geri alınabilirlik):** patch + EXE + log SHA-256'ları kaydedilir; çalışma sonunda
  izole kaynak `git status` temiz, kanonik `Amax.exe` hash'i değişmemiş olmalı.
- **A5 (kapsam):** diff yalnız §6'daki dosyalar; `Atomic.h`, `Manager.cpp` **yok**;
  `Atomic.h:315-316` assert'i **aynen** duruyor.
- **A6 (iddia sınırı):** 3 temiz koşu "düzeltildi" demek için **yeterli değildir**;
  girişsiz eşleştirilmiş koşu (H7) ve havuz baskısı ölçümü olmadan yalnız
  "belirti gözlenmedi" yazılabilir.

---

## 8. Riskler

| # | risk | olasılık | etki | azaltma |
| --- | --- | --- | --- | --- |
| R1 | Emitter **stride**'ı `0x400 → 0x408`; dump araçları/offset varsayımları bozulur | **yüksek** (kesin) | tanılama kaybı | alan sınıf sonunda + `static_assert`/`offsetof`; dump araçları yeni stride'a göre güncellenir |
| R2 | Yuvanın worker thread'den yazılması (R3 `0x1CB674`) ile ana thread'in `FreeParticle`/`UpdateTrails`'i arasında yarış | orta | yarış, tekrar üretilemeyen hata | hizalı 8 B store (x64'te atomik); temizleme **bırakmadan önce** ve **idempotent** (`NULL` yazmak zararsız); yeni kilit **yok** |
| R3 | **Aliasing** (iki yuva → bir emitter): geri-referans yalnız son kaydı tutar | düşük-orta | kalan bayat yuva S1(a) yedeğiyle yakalanır | `g_slotAlias` sayacı; S6 onarımı (madde 15) |
| R4 | `C_EmitterList::Free` (R8-R12, R14) yuvayı temizlemez | düşük | salt artar, sonraki dokunuşta `NULL` | mevcut davranış korunur; bu yollar süper-liste trail emitter'larında kullanılmıyor (M1) |
| R5 | `SetDefinition`'ın geri-referansı sıfırlaması canlı bir yuvayı koparır | düşük | trail görsel kaybı (AV değil) | `SetDefinition` yalnız spawn/geri-dönüşümde çağrılır; spawn'da yuva henüz yok (S1b) |
| R6 | Ölçüm gürültüsü: temel çizgi de AV üretiyor (E2) | orta | yanlış atıf | Adım 0 eşleştirilmiş baseline zorunlu |

---

## 9. Kapanan / kapanmayan

**Kapanan (kaynak okumasıyla):**
- `pEmitter`'ı geçersiz kılan **tek** mekanizmanın salt karşılaştırması olduğu (S1);
  yuvayı proaktif temizleyen hiçbir yol bulunmadığı.
- `FreeParticle`'ın canlı aralıkta bayat yuva **bırakmadığı**, bayatlığın hiza
  bozulmasından veya yuvanın hiç temizlenmemesinden geldiği (S2).
- `DeleteTrailBlock`'un canlı emitter için **ölü yol** olduğu ve üçüncü denemenin bu
  yüzden etkisiz kaldığı (S3).
- `C_Emitter::Update`'in, yuvayı geçersiz kılmadan emitter'ı bırakabildiği; ancak
  `bRepeating` zorlaması yüzünden bunun yalnız **geri dönüştürülmüş** emitter'da
  olabileceği (S5) — yani sorunun nesnede değil yuvada olduğu.
- `UpdateMemory`'nin `NULL` trail bloğunda bayat pointer bırakabildiği (S6, hipotez).

**Kapanmayan:**
- 231-232'deki bayat yuvanın hangi `(t, b, i)` olduğu (H11) — trace `pParticle`
  adresi + blok indeksi loglamıyor.
- S6'nın runtime'da gerçekten oluşup oluşmadığı; aliasing'in varlığı (H13).
- Üç reddedilen denemenin AV nedeninin konumu (dump yok, D2/E4).
- Bu tasarımın `0x80000003`'ü kaldırıp kaldırmayacağı — **test edilmedi**.

---

## 10. Sıradaki en küçük adım

1. **Ölçüm önce (kod değişikliği yok):** `FreeParticle` etiketine `pParticle` adresi,
   `pBlock->m_VectorPosition`, `i` ve `iSalt` ekleyip (env-gated, assert'e dokunmadan)
   3 koşu almak. H11 kapanır; 231'deki yuvanın `(t, b, i)` kimliği ve o yuvanın
   S6/hiza bozulmasıyla mı yoksa "hiç temizlenmemiş yuva" ile mi bayat kaldığı ayrılır.
   Bu, §6'daki 15 numaralı maddenin (S6 onarımı) önkoşuludur.
2. **Sonra** §6'daki 1-14 uygulanır ve §7 planı çalıştırılır; 15 ancak 1'den sonra.
3. Assert kaldırılmaz; 3 temiz koşu "düzeltildi" sayılmaz (A6).

> Bu belge bir düzeltme iddiası taşımaz; hiçbir kod değişmedi, hiçbir derleme/koşu
> yapılmadı. §6 yalnızca uygulanabilir bir değişiklik **tanımı**dır.
