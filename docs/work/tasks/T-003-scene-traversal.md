# T-003 — Scene/level kapsamını genişletme

**Durum:** in-progress (blok27 çoklu instance tamam; diğer bloklar/materyaller açık)
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

## Kalan iş

1. Base primitive11–35'in ek stream/deformasyon semantiği; blok17/26/32'deki 22
   instance'ı ve blok15'teki 8 instance'ı doğru sınırlarla çizmek.
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
- [ ] Diğer geometri blokları (tarama yapıldı; blok15 ek 4 instance destekliyor,
      blok17/26/32 stream semantiği, blok31 prerequisite açık).
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
