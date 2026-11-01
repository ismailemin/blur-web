# İlk gerçek model ve XT deneyi — veri kanıtları

28 Ekim 2026. Kaynak commit'i: `5270304b81983b9e3edbd569ba25235c17bbabd7`.
Kaynak checkout'u değiştirilmedi. Kullanıcı Rebuilt Career yarışının çalıştığını bildirdi; bu rapordaki araç oyunu çalıştırmaz.

## Yapılan iş

`tools/inspect_asset_layout.py` eklendi ve kurulu çalışma kopyası üzerinde çalıştırıldı:

```powershell
& 'C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe' tools/inspect_asset_layout.py --game-dir game-data/Blur --out _work/asset-layout/retail-layout.json
```

Araç PAK V2 indekslerini salt okunur açar; string tablosundaki kaynakta tanımlı XOR format dönüşümünü uygular. Dosya aralıklarını sınırlar ve en fazla 64 MiB metadata kabul eder. Bir küçük model ve iki küçük XT dosyası yalnız bellekte açılarak başlıkları incelenir; içerik dosyaları dışarı çıkartılmaz ve oyun/kurulum exe'si çalıştırılmaz. İmza ve hash doğrulaması **yapılmadı**. Secure FAT bulunduğunu raporlamak doğrulama yapıldığı anlamına gelmez. Bu çıktı format teşhisidir; doğrulanmış oyun yükleyicisi veya güvenlik denetimi değildir.

## Gerçek paket envanteri

| Paket | Codec | FAT kayıt sayısı | İlk payload öncesi metadata sonu |
|---|---|---:|---:|
| `cache/boot.pak` | 4 / packet-zlib | 931 | 81.920 |
| `cache/root.pak` | 4 / packet-zlib | 3.601 | 319.488 |
| `cache/gamedata.pak` | 2 / zlib | 621 | 65.536 |
| `cache/gamedata_boot.pak` | 2 / zlib | 80 | 12.288 |
| `cache/lut_rampak.pak` | 4 / packet-zlib | 218 | 20.480 |
| `cache/root_streaming.pak` | 1 / raw | 68 | 8.192 |

`shaders-speed.pak` V1; bu tanılama aracı V1'i açıkça unsupported olarak raporlar. `models.pak` bu kurulumda yok. `root.pak` içinde 1.543 model ve 301 `.texture` girdisi; `boot.pak` içinde 201 model var. Kayıt sayıları dizinleri de içerir, uzantı sayıları yalnız dosyalardır.

Bu durum, ilk browser adımında bütün 559.652.864 baytlık `root.pak` dosyasını WASM belleğine kopyalamak yerine ilk **319.488 baytı** okumamızın indeks için yeterli olduğunu gösteriyor. Bu sayılar yalnız bu retail veri sürümü için ölçümdür; format parser'ı bunları sabit değer olarak kullanmamalı.

## İlk mesh için seçilen küçük prop

En küçük `.model` girdisi `\models\specialfx\spiralfirework.model` (1.682 mantıksal bayt); özel efekt modeli olduğu için ilk statik geometri deneyi açısından en açıklayıcı seçim olmayabilir.

Önerilen ilk aday: **`\models\objects\usa_la_river\misc\trafficcylinder.model`**.

| Alan | Ölçülen değer |
|---|---:|
| Paket | `cache/root.pak` |
| FAT index | 636 |
| Yol CRC32 alanı | `2de1741b` |
| Fiziksel dosya başlangıcı | 261.296.128 |
| Fiziksel uzunluk | 3.424 |
| Fiziksel bitiş (exclusive) | 261.299.552 |
| Mantıksal uzunluk | 8.015 |

Dolayısıyla indeks alındıktan sonra browser yalnız bu **3.424 baytlık dilimi** isteyebilir. Codec4 veri başında `U32 packetSize=65536`, ardından `U32 compressedSize=3416` ve 3.416 bayt raw-DEFLATE var. Kaynaktaki `PakCompressPacketZLib.cpp` paket düzeniyle örtüşüyor. Python zlib raw-DEFLATE çözümü 8.015 bayt verdi; beklenen mantıksal uzunluk, stream sonu ve artan girdi kontrolü geçti. Bu tek paketli küçük örnektir; büyük modelin çok paketli yolunu doğrulamaz.

Çözülmüş verinin ilk 4 baytı platform işareti `20 20 43 50` (`  CP`). Ardından `Model` container var. Kaynaktaki `C_FileBlock` düzeniyle okunan çocuklar:

| Chunk | Çözülmüş model içindeki offset | Header dahil bayt |
|---|---:|---:|
| `Header` | 20 | 20 |
| `MdlDat` | 40 | 610 |
| `Render` | 650 | 6.510 |
| `Coll` | 7.160 | 520 |

`Model` chunk'ı offset4'ten itibaren 7.676 bayt; dosyanın sonundaki kalan 335 bayt bu tanılamada yorumlanmadı. Render chunk'ının `count=0`, type=`0x41` olması içinin boş olduğu anlamına gelmez: bunlar reader'a özel veri bloklarıdır. Genel chunk recursion ile vertex/index çıkarmaya çalışmak hatalı olur.

## İlk XT/FLSK için gerçek örnekler

`gamedata.pak` secure FAT + zlib içeriyor. Küçük iki girdi yalnız bellekte zlib ile açıldı:

| Yol | Fiziksel offset | Saklanan bayt | Açılmış bayt |
|---|---:|---:|---:|
| `\gamedata\levels\vehicletestscene\actorpack.xt` | 20.985.856 | 931 | 1.228 |
| `\gamedata\xt\vehicles.bin` | 22.839.296 | 15.225 | 43.640 |

İkisinin ilk dört baytı `4b 53 4c 46` (`KSLF`) ve sürüm alanı 2. Bu, little-endian bellekte kaynak `kXtFlaskTag='FLSK'` değerine karşılık geliyor. Dosya adı `.xt` olan örneği XML saymak yanlış; gerçek Flask binary'si.

`actorpack.xt` header başlangıcında types offset72/count19, bases offset300/count3, fields offset312/count31. `vehicles.bin` types offset72/count17, bases offset276/count5, fields offset296/count87. Bunlar ilk header alanlarıdır; bütün tabloların/şemanın geçerliliği henüz doğrulanmadı. FLSK reader için küçük örnek olarak 1.228 baytlık actorpack; araç şemasına geçiş için vehicles.bin kullanılabilir.

## Showroom verisi neden ilk hedef değil?

- Loose `levels/showroom/level.level` 611 bayt. `Level` container'ı 236 bayt; `Header`, `MdlDat`, `NavDat`, `Advert` çocukları okunabildi.
- `levels/showroom/level.levelrender` 978.033 bayt; platform işaretinden sonra 978.029 baytlık `Render` veri chunk'ı var. `count=0` ve type `0x41` ile reader'a özel payload; içinde ayrıca `Header`/`Scene` akışı bulunması serializer'a göre okunmalı.
- Showroom sahnesi, sahne kaynakları/materyaller ve daha geniş resource closure gerektirebilir. Bir küçük prop geometri parser'ı tamamlanmadan showroom'u açmak işi gereksiz genişletir.

## Sonraki somut uygulama

1. C++ PAK index modülünün metadata sonuçlarını bu bağımsız Python envanteriyle karşılaştır: kayıt sayısı, yol, offset ve boyut.
2. Codec4 packet-zlib için sınır kontrollü bir `decode entry` yolu uygula; ilk gerçek fixture trafficcylinder. `packetSize`, `compressedSize`, mantıksal toplam, stream sonu, input aralıkları ve çok paketli davranış test edilmeli. Secure varlıklarda hash/imza doğrulamasının durumu açık tutulmalı.
3. `C_FileBlock` header okuyucusu ile `Model` ve Render aralığını göster. `Coll` veya Gravity nesnesini oluşturma. `ModelResource::LoadModelData` bu iki sistemi birleştirdiği için minimal WASM hedefi olarak doğrudan linklenmemeli.
4. `RenderModel.cpp::Load` ve `ReadScene`/renderingdata okuyucularını izleyip seçili modelin bir vertex/index stream'ini çıkar. Layout/stride/endian ve normalizasyonu gerçek serializer'la kanıtla; ikili arama/guess ile görünür üçgen üretmek yeterli değil.
5. İlk WebGPU çiziminde tanılama materyaliyle gerçek geometriyi göster; sonra orijinal doku/material binding ekle. Bu prop'un çizilmesi araç modelinin veya shader zincirinin tamamının taşındığı anlamına gelmez.

## Kaynak otoriteleri

- `code/mercury/library/util/logicalFs/include/pakfs/impl/{PakHeader,PakFatEntry,PakDefinitions}.h`
- `code/mercury/library/util/logicalFs/source/pakfs/impl/{PakRead,PakUtil,PakCompressPacketZLib,PakCompressZLib}.cpp`
- `code/mercury/library/common/system/include/system/serialise/C_FileBlock.h`
- `code/mercury/library/common/xt2/source/common/XtFlask.h`
- `code/mercury/library/gamesys/game_resource/source/ModelResource.cpp`
- `code/mercury/library/graphics/world_render/source/RenderModel.cpp`

Tüm yollar sabit commit altındaki `upstream/BlurRebuilt` checkout'una göre verilmiştir. Tam diagnostic çıktısı `_work/asset-layout/retail-layout.json`.
