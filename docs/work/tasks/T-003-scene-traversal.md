# T-003 — Scene/level kapsamını genişletme

**Durum:** in-progress (Stage A uygulandı; Stage B sırada)
**Sahip:** ana ajan
**Başlangıç:** 1 Kasım 2026
**Bitiş:** —

## Amaç

Tek instance kanıtını tutarlı bir sahne parçasına genişletmek: aynı geometri
bloğuna bağlı birden çok instance, ardından diğer bloklar, level materyalleri,
görünürlük ve yüksek LOD'lar.

## İlk artım — blok27 çoklu instance (tamam)

`level_instances_all_inspect` eklendi. Aynı node253 RenderList'inde VB/IB'si
blok27'ye bağlı instance'lar sırayla işleniyor; her biri kendi sabit affine
`g_mWorld` matrisiyle CPU'da genişletiliyor. Arşivlenmiş instance sınırlarıyla
uyuşmayan instance'lar **açıkça sayılıp atlanıyor**; tahmin veya zorlama yok.

Sonuç (blok27/node253):

- 57 instance'ın **14'ü** çizildi, **8'i** sınır uyuşmazlığı nedeniyle
  desteklenmiyor, **35'i** başka geometri bloğuna bağlı.
- 7.308 vertex / 6.106 üçgen; 14 draw.
- En büyük arşiv sınır farkı **6.02444e-05**.
- Native/WASM JSON tamamen eşit; suite 27/27, CTest 14/14.
- Browser'a **River · 14 instance** preset'i eklendi.

Sınır uyuşmazlığı olan 8 instance (13–16, 18–21) base primitive7–10 kullanıyor;
bu primitive'lerin ek stream/deformasyon semantiği uygulanmadığı için sınır
karşılaştırması tutmuyor. Bunlar "çizildi" sayılmıyor.

## İkinci artım — çoklu blok taraması

`level_instances_all_inspect` metadata'sına `requiredGeometryBlocks` eklendi:
`[15,17,26,27,31,32]`. Browser **River · tüm desteklenen** preset'i bu blokların
chunk'larını sırayla okuyup sonuçları birleştiriyor; blok31 ek prerequisite
gerektirdiği için atlanıyor, sıfır desteklenen instance döndüren bloklar da
açıkça sayılıyor.

| Blok | Desteklenen | Sınır uyuşmazlığı | Not |
| ---: | ---: | ---: | --- |
| 27 | 14 | 8 | 7.308 vertex / 6.106 üçgen |
| 15 | 4 | 8 | 1.380 vertex / 979 üçgen |
| 17 | 0 | 2 | base32–33 stream semantiği yok |
| 26 | 0 | 10 | base22–31 stream semantiği yok |
| 32 | 0 | 10 | base24–30 stream semantiği yok |
| 31 | — | — | ek ChunkInfo prerequisite |

Toplam desteklenen: **18 instance**, 8.688 vertex / 7.085 üçgen. Kalan 39
instance base11–35 ek stream/deformasyon semantiği veya blok31 prerequisite
çözülmeden çizilmiyor. Native/WASM JSON ve mevcut testler regresyonsuz
(27/27, 14/14).

## Üçüncü artım — bounds grouping kanıtı

P2 kaynak analizi, `instanceBounds` kayıtlarının çizim başına değil **yerleştirilmiş
nesne (CullNode) başına** olduğunu gösterdi: `renderlistbuild.cpp:579` her draw
için aynı `CullNode::GetBounds()` değerini yazıyor; bir nesnenin birden çok
draw'ı aynı kaydı tekrarlıyor.

Node253 ölçümü: 57 instance, **34 transform-sabit grubu ↔ 34 byte-identical
arşiv kaydı**; grubun draw AABB birleşimi kayıtla `6.024437e-05` içinde
eşleşiyor. Grup boyutları 19×1, 9×2, 4×3, 2×4 ve gruplar instance sırasında
bitişik. Yani eksik olan geometri/stream değil, **grup bağlamı**; mevcut
`scene_reader.cpp:874-887` tek draw'ı tüm nesne kaydıyla karşılaştırıyor.

Beklenen düzeltme (henüz uygulanmadı):

- **Stage A:** tek-chunk grupları (blok27 22/22, blok15 12/12, blok17 2/2) →
  **36 instance / 22.924 vertex / 17.301 üçgen**.
- **Stage B:** chunk'lar arası gruplar (blok26+32) → toplam **56 instance /
  34.632 vertex / 25.521 üçgen**.
- Blok31 yalnızca prerequisite akışına bağlı.

Ayrıntı: `docs/work/analysis/level-instance-streams.md` (bölüm 8).

## Dördüncü artım — Stage A uygulaması (tamam)

`level_instances_all_inspect` artık bitişik instance'ları **aynı arşiv CullNode
bounds kaydı + aynı VB/IB blokları** anahtarıyla grupluyor; grup üyelerinin draw
AABB birleşimini ortak kayıtla `1e-4` toleransında karşılaştırıyor. Grup
reddedilirse tüm üyeler geri alınıp `unsupportedBoundsInstances`'a sayılıyor.
Metadata'ya `boundsGrouping` ve `boundsGroups` eklendi; `emittedInstanceCount`
instance sayısı (grup değil).

Sonuç:

| Blok | Emitted | Unsupported | Vertex | Üçgen | Hata |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 27 | 22 | 0 | 13.162 | 10.308 | 6,02444e-05 |
| 15 | 12 | 0 | 7.234 | 5.181 | 5,75171e-05 |
| 17 | 2 | 0 | 2.528 | 1.812 | 5,35334e-05 |
| 26 | 0 | 10 | — | — | — |
| 32 | 0 | 10 | — | — | — |

**Stage A toplamı: 36 instance / 22.924 vertex / 17.301 üçgen** (beklenenle
birebir). Blok26/32 chunk'lar arası grup birleştirmesi (Stage B) gerektiriyor;
blok31 prerequisite akışına bağlı.

Doğrulama: native/WASM JSON tamamen eşit; suite **29/29**, CTest **14/14**.
Headless Edge (WebGPU) görsel kontrolü: **22 instance**, 0 sınır uyuşmazlığı,
13.162 vertex/10.308 üçgen, console temiz. `River · tüm desteklenen`: **36
instance**, 20 sınır uyuşmazlığı, 1 blok atlandı, 17.301 üçgen, console temiz.
Kanıt: `_work/logs/t003-stageA-*.png`, `_work/logs/t003-stageA-browser-*.json`,
`_work/verification/level-instances-native-wasm.json`.

## Kalan iş

1. ~~Stage A~~ (tamam: blok27/15/17, 36 instance). Stage B: blok26/32 için
   chunk'lar arası grubu birleştir (56 instance hedefi).
2. Blok31 için ek ChunkInfo prerequisite akışı (tek instance).
3. Level materyalleri, görünürlük/culling, sonraki RenderList'ler ve yüksek
   LOD'lar.
4. GPU instance buffer optimizasyonu; şu an CPU vertex expansion.

## Kapsam dışı

- Tam pist/oyun iddiası, fizik, ses, multiplayer.
- Desteklenmeyen instance'lar için tahmini matris/stream.

## Kabul kriterleri (ilk artım)

- [x] Blok27'ye bağlı desteklenen instance'lar birlikte çiziliyor.
- [x] Desteklenmeyen/başka blok instance'ları sayılıyor.
- [x] Native/WASM/Python sınır karşılaştırması.
- [x] Suite/CTest regresyonsuz.
- [x] Diğer geometri blokları (Stage A: blok27/15/17 toplam 36 instance;
      blok26/32 Stage B, blok31 prerequisite açık).
- [ ] Base7–10 ek stream semantiği.
- [ ] Level materyalleri/görünürlük/yüksek LOD.
- [x] WebGPU mesh ekran görüntüsü.

## Browser görsel doğrulaması

Kullanıcı Chrome'da **River · 14 instance** preset'ini açtı. Görüntüde:

- `359 akış kaydı · 14 instance çizildi · 8 sınır uyuşmazlığı · 35 başka blok · 6106 üçgen`
- `WebGPU · 7308 vertex · 6106 üçgen · gerçek model geometrisi`
- `Yüzey` modu; `Doku çözülemedi` (level materyalleri uygulanmadığı için beklenen)
- Görünür WebGPU hatası yok

Bu, blok27 çoklu instance yolunun browser'da gerçekten çizildiğini doğrular.
Görüntü kullanıcı tarafından sağlanmıştır (sohbet, 2 Kasım 2026);
`_work/` altında ayrıca arşivlenmedi.


## Kanıt

- `_work/verification/level-instances-native-wasm.json`
- `_work/level-instances/cpp-all-block27.json`
- `_work/logs/t003-*.log`
- `docs/work/verification/T-003.md`
