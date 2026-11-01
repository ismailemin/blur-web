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

## Kalan iş

1. Blok15/17/26/31/32'ye bağlı diğer instance'lar için çoklu geometri chunk
   akışı (API tek chunk alıyor; browser hangi chunk'ları okuyacağını bilmeli).
2. Base primitive7–10'un ek stream/deformasyon semantiği; 8 instance'ı doğru
   sınırlarla çizmek.
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
- [ ] Diğer geometri blokları.
- [ ] Base7–10 ek stream semantiği.
- [ ] Level materyalleri/görünürlük/yüksek LOD.
- [ ] WebGPU mesh ekran görüntüsü.

## Kanıt

- `_work/verification/level-instances-native-wasm.json`
- `_work/level-instances/cpp-all-block27.json`
- `_work/logs/t003-*.log`
- `docs/work/verification/T-003.md`
