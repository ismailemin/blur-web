# İlk tarayıcı deneyi: oyun verisini okuma ve tek model

Tarih: 28 Ekim 2026. İncelenen kaynak: `upstream/BlurRebuilt`, commit `5270304b81983b9e3edbd569ba25235c17bbabd7`. Kaynaklar değiştirilmedi, oyun dosyası indirilmedi, derleme yapılmadı. Bu bir deney tasarımıdır; çalışan port beyanı değildir.

## Karar

İlk WASM hedefi bütün motor veya tam `C_ModelResource` olmayacak. Önce gerçek PC `.pak` dosyasının indeksini güvenli biçimde okuyup bir dosyayı aynı baytlarla çıkartan küçük bir C++ modül; sonra chunk/XT metadata okuma; sonrasında bir mesh ve materyalin WebGPU çizimi. Böylece Windows scheduler, fizik ve renderer bağımlılıkları ilk deneye taşınmaz. Tüm kaynak closure henüz derleyiciyle doğrulanmış değil; aşağıdaki listeler incelenecek sınırı tarif ediyor.

## Gerçek kaynak sınırları

Repo içindeki yollar:

| İş | Kaynak | Doğrudan çıkarım |
|---|---|---|
| Pak başlığı/FAT | `code/mercury/library/util/logicalFs/include/pakfs/impl/PakHeader.h`, `PakFatEntry.h` | V1 ve V2 biçimleri farklı. V2 başlık 32 bayt; FAT normal kaydı 40 bayt, secure kaydı ek hash taşıyor. Bellekteki C++ struct boyutunu dosya biçimi olarak kabul etmeyelim. |
| Pak indeks okuma | `code/mercury/library/util/logicalFs/source/pakfs/impl/PakRead.cpp` | Preheader endian kontrolü, string table, FAT ve v2 stride dönüşümü var; yalnız basit ZIP okuyucusu değil. |
| Sıkıştırma | Aynı dizinde `PakCompressRaw.cpp`, `PakCompressZLib.cpp`, `PakCompressPacketZLib.cpp`, `PakCompressXMem.cpp`, `PakCompressPacketXMem.cpp` | ZLib ve XMem yolları ayrı. XMem kaynakları `xcompress.h` / LZX kullanıyor. PC verisinin codec alanı ölçülmeden LZX gerekli ya da gereksiz diyemeyiz. |
| Mantıksal dosya sistemi | `code/mercury/library/util/logicalFs/LogicalFsPch.h`, `source/pakfs/impl/PakIoMediator.cpp`, `source/overlayfs` | Orijinal okuyucu allocator, debug/log, sistem dosyası, şifreleme/hash ve PCH bağımlılıklarıyla geliyor. Hepsini ilk modüle bağlamak yerine açık taşınabilir byte-reader sınırı araştırılmalı. |
| Chunk sözleşmesi | `code/mercury/library/common/system/include/system/serialise/C_FileBlock.h`, karşılık gelen `.cpp` | Kimlik 8 bayt; boyut U32; count U16; type S8; compression S8. Önceki genel mimari açıklamasında son iki alanı atlamak parser için hata olurdu. |
| XT şeması | `code/mercury/library/common/xt2/source/common/XtFlask.h` | `FLSK` etiketi ve tablo tanımları format otoritesi. |
| XT import | `code/mercury/library/common/xt2/source/game/XtFlaskImport.cpp` (`XtPackOpen`) | Tüm reflection/schema importer'ı daha geniş closure gerektiriyor. İlk deney yalnız header/table metadata; kayıt çözme bir sonraki kapı. |
| Model yükleme | `code/mercury/library/gamesys/game_resource/source/ModelResource.cpp:195` (`LoadModelData`) | Platform doğrulaması, `Model` → `Header` / `MdlDat` / `Coll` / `Render`. Aynı fonksiyon Gravity SDK ve gerçek renderer'ı oluşturuyor; minimal loader olarak doğrudan derlenmesi uygun değil. |
| Render chunk | `code/mercury/library/graphics/world_render/source/RenderModel.cpp` | `Render` → `Header` / `Scene` → `ReadScene`; gerçek vertex/material formatını `renderingdata` reader zincirinde ayrıca çözmek gerek. |

`docs/agent-reference/architecture.md` uyarınca PC oyun katmanı `cache/root.pak`, `cache/models.pak`, `cache/shaders-speed.pak`, `cache/gamedata.pak` bağlar. Fizik, çizim ve level streaming ayrı veri yolları; tek model göstermek tam pist yüklemenin kanıtı değildir.

## İlk modülün sınırı

Önerilen bağımsız `probes/asset-reader` hedefi (henüz oluşturulmadı):

- Girdi: sınırları belirtilmiş byte blokları ve okuma isteği; uygulamaya ait allocator. İlk aşamada path erişimi, ağ, threading, GPU ve Gravity yok.
- Çıktı: pak sürümü/codec, dosya sayısı, yol/CRC/offset/uzunluk kaydı; seçilen girdinin baytları veya açık unsupported-codec hatası.
- Temel bağımlılıklar: C++ sabit genişlikli sayılar, bounds-check reader, gerektiğinde zlib. Orijinal parser'ı kaynak otoritesi alıp hangi parçaların yeniden kullanılabileceğini kullanım koşulları ve derleyici hatalarıyla doğrula; farkları belgele.
- JS arayüzü: tarayıcının kullanıcı tarafından seçilen dosyadan `File.slice()` ile okuduğu parçaları WASM'a verir. Bütün 5 GB kurulumu tek ArrayBuffer/MEMFS'ye almayız. Offsetler JS tarafında güvenli sayı sınırında doğrulanır; dosyada U64 alanlar vardır.
- İlk doğrulama native reference reader ile aynı veri üzerinde eşleşme. Tek JS/C++ yeni uygulamanın kendi kendisiyle uyuşması doğruluk kanıtı değildir.
- Pak bütünlük/hash kontrolleri korunur; imzalı içerik için doğrulama atlaması bu deneyin parçası değildir.

## Ölçülebilir kapılar

1. **Oyun gelmeden:** format/bağımlılık manifesti; taşınabilir parser sınırı; native/WASM hedef konfigürasyonu. Testler yalnız sentetik, bize ait küçük dosyalarla bounds, hatalı boyutlar, endian ve bilinmeyen sürüm reddini doğrular. Bu testler gerçek oyun uyumluluğunu kanıtlamaz.
2. **Pak gelince:** dosya manifesti ve SHA-256; küçük pak indeksini native ve WASM ile oku; dosya sayısı/path/offset eşleşsin; seçilen dosyanın çıkarılmış bayt hash'i eşleşsin. Codec bilinmiyorsa geliştirmeyi bu noktada durdurup kaynak reader'la çözümle; sessiz fallback yok.
3. **XT/chunk:** gerçek bir FLSK dosyasında tablo sınırlarını ve bir kaydı native ile eşleştir. Gerçek bir modelin chunk ağacını boyut taşması olmadan çıkar; compression ve vertex layout belirsizliklerini raporla.
4. **Mesh:** tek render scene'den bir geometriyi GPU'dan bağımsız normalize edilmiş vertex/index verisine al. Sayı/indeks sınırları ve native dump karşılaştırması geçsin. `Coll` bloğunu instantiate etmeden atlamak yalnız bu görsel probe kapsamıdır.
5. **WebGPU:** önce basit tanılama materyaliyle gerçek geometriyi çiz; ardından bir gerçek texture ve materyali uygula. Basit shader başarısını orijinal shader zinciri dönüşümü diye sunma. Windows referans görüntüsüyle benzerlik ve bellek/frame-time ölç.

İlk hedef masaüstü Chromium. WebGPU backend, Emscripten sürümü, shader çeviri aracı ve texture transcoding kütüphanesi henüz seçilmedi; güncel resmi belgeler ve cihaz desteği ölçülmeden kilitlenmeyecek.

## Oyun gelmeden yapılabilen somut işler

Kaynağı sabitlemek, build girdilerini envanterlemek, parser formatını çıkarmak, mevcut compiler/Emscripten erişimini kontrol etmek ve küçük modülün derleme closure'ını denemek mümkündür. Gerçek veri üzerinden pak/codec/model başarısı ve performans ölçümü için indirme gerekir. Gerçek mesh olmadan genel WebGPU üçgen demosu bu projedeki en büyük belirsizlikleri çözmez.

## Repo çalışma protokolü

AGENTS.md ve architecture referansı okundu. İlk context komutu PATH Python Store alias'ı nedeniyle çalışmadı; bundled Python ile tekrar denendiğinde `--root must name a Blur phase worktree` sonucu alındı. Bu checkout geliştiricinin özgün phase/worktree adlarına sahip değil. Kaynak üzerinde stage/task board değişikliği yapılmadı; üst proje altındaki bu rapor ayrı tutuldu. Ana ajan, uygulama başlamadan önce bunun için yerel phase eşlemesini belirlemeli.

## Kaynak bağlantıları

- [Pak okuyucu](https://github.com/uKER/BlurRebuilt/blob/5270304b81983b9e3edbd569ba25235c17bbabd7/code/mercury/library/util/logicalFs/source/pakfs/impl/PakRead.cpp)
- [Chunk formatı](https://github.com/uKER/BlurRebuilt/blob/5270304b81983b9e3edbd569ba25235c17bbabd7/code/mercury/library/common/system/include/system/serialise/C_FileBlock.h)
- [XT import](https://github.com/uKER/BlurRebuilt/blob/5270304b81983b9e3edbd569ba25235c17bbabd7/code/mercury/library/common/xt2/source/game/XtFlaskImport.cpp)
- [Model yükleme](https://github.com/uKER/BlurRebuilt/blob/5270304b81983b9e3edbd569ba25235c17bbabd7/code/mercury/library/gamesys/game_resource/source/ModelResource.cpp)
