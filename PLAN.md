# Blur Web — uygulama planı

28 Ekim 2026. Bu belge yaşayan çalışma planıdır; süre ve başarı taahhüdü değildir.

**Güncel ilerleme:** Gerçek PAK/model/doku ve XT metadata okuyucuları native/WASM olarak çalışıyor. Kısmi Scene okuyucusu28 küçük modelin26'sından geometri çıkarıyor. Corvette'in30.591vertex/36.193üçgeni, özgün UV'leri ve26statik dokulu çizimi (14 shared +12 resource-block LOD0) bağımsız okuyucuyla eşleşti; WebGPU'da 14 shared çizim görsel doğrulandı. `scene_resource_textures_inspect` yedi resource bloğunu Scene sınırına kadar okuyup descriptor/payload aralıklarını döndürüyor. River block27/node253 instance0'ı sabit affine g_mWorld ile805vertex/726üçgen olarak çözüldü; arşiv sınırı farkı3.86511e-05. Çoklu instance yolu blok27'de14instance/7.308vertex/6.106üçgen, blok15 ile birlikte18instance/8.688vertex/7.085üçgen üretiyor;8sınır uyuşmazlığı ve diğer blok stream semantiği açıkça sayılıyor; browser'da `River · 14 instance` ve `River · tüm desteklenen` görselleri var. River'ın9.343üçgenli geniş parçası ve showroomun7.987üçgenli parçası tarayıcıda çizildi. Yeniden derleme ardından27kontrol ve14nativeCTest geçti. Tam Amax x64Release kaynak derlemesi ve özel profille sabit araçlı yarış açılışı başarılı; particle-cache çökmesinin tam bellek dump'ı alındı; silinen elemanın aynı zamanda `m_Cache[162]` içinde olması çift serbest bırakmayı doğrudan kanıtladı, hangi çağrı/efekt olduğu açık. Runtime araç boyası, yüksek resource LOD'ları, diğer geometri blokları, tekerlek yerleşimi, pist bütünü, fizik ve multiplayer açık. Test adımları: `probes/asset-reader/README.md`; kesin devam noktaları: `docs/STATUS.md`.

## Hedef ve ilk kapsam

Arkadaşların siteyi açarak kendi masaüstü tarayıcılarından aynı özel odada orijinal Blur oynayabilmesi. Oyun mantığı ve motorun tarayıcıya uyarlanan bölümleri WebAssembly olarak her oyuncunun tarayıcısında çalışacak; grafikler WebGPU üzerinden çizilecek. Mevcut kodun taşınabilir bölümleri uyarlanacak, Windows'a bağlı grafik, ses, dosya, iş parçacığı ve ağ katmanlarının gerekli bölümleri web için yeniden yazılacak. Sunucu web dosyalarının sunumu, oda ve bağlantı yönetimini sağlayacak; yarış trafiğindeki kesin rolü ağ deneyleriyle belirlenecek. İlk hedef masaüstü Chromium, klavye ve gamepad; mobil ve bütün tarayıcılar sonraki değerlendirme.

Nihai oyuncu deneyimi tarayıcı üzerindedir; oyuncuların Windows Blur veya Rebuilt exe'sini kurması/çalıştırması hedeflenmez. Plandaki Windows derlemesi yalnız bizim geliştirme, doğruluk karşılaştırması ve hata ayıklama referansımızdır. İlk deneylerde yerel oyun verisini seçerek yükleme, geliştirme yöntemidir; nihai oyuncu akışı için zorunlu dosya yükleme kararı değildir.

İlk oynanabilir sürüm: bir pist, bir araç, temel güçlendirmeler ve iki oyuncunun farklı internet bağlantılarından yarışı bitirmesi. Daha geniş araç/pist kapsamı ve daha çok oyuncu ancak bu doğrulandıktan sonra açılır. Bu sınır orijinal davranışın korunması hedefini değiştirmez.

## Kaynaklar ve çalışma düzeni

- Rebuilt başlangıç kaynağı: `upstream/BlurRebuilt`, commit `5270304b81983b9e3edbd569ba25235c17bbabd7`.
- Kaynak checkout'u referans olarak temiz tutulur; uygulama aşamasında uygun phase adıyla ayrı geliştirme worktree'si açılır. Upstream'in Windows/renderer düzeltmeleri ve serializer'ları referans alınır.
- Root proje altında plan, yerel araçlar ve doğrulama kayıtları tutulur. `_work/` geçici çıktılar; `game-data/` oyun verisi için yerel ve Git dışında bir alan.
- Oyun ISO'su kaynak kod değildir. Depo geliştirme kodunu, kurulu oyun da modeller/pistler/dokular/sesler gibi çalışma verilerini sağlar.
- Kök proje lisansı ve kod kullanım koşulları upstream'de net değil. İnceleme notları bu durumu kaydeder; ileride yayın/dağıtım planı buna göre ayrıca değerlendirilir. Public depo adı altında bütün oyun verileri yüklenmez.
- Günlük kayıt: `docs/STATUS.md`. Kaynak ve deney bazında belirsizlikler kapatılır; çalışmayan aşama başarılı diye raporlanmaz.

## Aşamalar ve geçiş ölçütleri

| Aşama | Yapılacak iş | Bitmiş sayılma koşulu | Bağımlılık |
|---|---|---|---|
| 0 — hazırlık | Kaynağı sabitle, araç ve SDK envanteri, upstream release build yolunu incele | Commit kaydı, eksiklerin listesi, build tanımı çıkarımı | Tamamlanan ilk inceleme |
| 1 — native araç zinciri | MSVC x64, Windows SDK/FXC, CMake ve gerekli yardımcılar; küçük DX11 hedefini derle | `dx11_hdr_reference` derlenip linklenir; log saklanır | Araç kurulumu |
| 2 — Windows referansı | Tam oyun verisini envanterle; Rebuilt release menü/yarış testi; bağımlılıkları sabitle ve kaynaktan x64 build üret | Aynı veriyle bir yarış, kaynak build sonucu, sürüm ve hash kaydı, RAM/VRAM/frame-time ölçümü | Oyun verisi + aşama 1 |
| 3 — ilk WASM | Küçük pak indeks/çıkarma modülü, sonra XT ve chunk metadata | Native referansla aynı gerçek pak kayıtları ve seçili dosyanın aynı baytları; bozuk girdi reddi | Taşınabilir derleyici/Emscripten ve gerçek veri |
| 4 — ilk gerçek görüntü | Bir gerçek mesh, texture ve materyal; shader/texture dönüşüm yolunu dene | Gerçek model tarayıcıda çizilir; Windows referansı, bellek ve frame-time karşılaştırılır | Aşama 3 |
| 5 — tek oyunculu yarış | Platform katmanı, scheduler, fizik, ses, kontrol, dosya streaming ve save uyarlaması | Bir pistte sürüş/çarpışma/güçlendirme ve tam yarış; kararlı uzun oturum | Aşama 4 + fizik karşılaştırması |
| 6 — multiplayer | Mevcut yarış paketlerini incele; oturum/oda ve web veri taşıması; iki istemci | Farklı ağlarda iki oyuncu tam yarış; gecikme, kopma ve bağlantı senaryoları ölçülür | Tek oyuncu + protokol testi |
| 7 — arkadaş grubu sürümü | Oda arayüzü, domain/HTTPS, gerekirse TURN, içerik yükleme/depolama ve sürümleme | Seçilmiş arkadaş grubuyla tekrarlanabilir oturum; ihtiyaç kadar oyuncu ve kapsam testi | İki oyunculu yarış |

## Oyun indirilirken yapılacak işler

1. **Yapıldı:** Rebuilt kaynağını indir ve commit'i sabitle.
2. **Yapıldı:** Üç bağımsız inceleme: derleme ortamı; ilk gerçek veri deneyi; ağ sistemi.
3. **Yapıldı:** Bundled Python ile Jam build açıklamasını çıkar. Bu C++ derlemesi değildir.
4. **Yapıldı:** Kurulu oyun için yalnız okuyan manifest aracı hazırla; sentetik küçük dosyalarda doğrula.
5. **Yapıldı:** C++ x64 Build Tools, Windows SDK, CMake ve yerel Emscripten kuruldu; oyun verisi envanterlendi.
6. **Yapıldı:** Kaynak derlemesi ayrı phase worktree'sinde üretildi; görev kayıtları ve özgün temiz checkout korundu.
7. **Yapıldı:** Küçük DX11 hedefi, tam native derleme ve gerçek oyun verisiyle WASM/WebGPU okuyucu deneyleri çalışıyor. Aktif işler aşağıdaki sırayla ve `docs/STATUS.md` devam kaydıyla yürütülür.

## Aktif uygulama sırası

1. **T-001 yapıldı:** Kalan iki kaynak-blok dokusu (`dials`, `interior`) özgün LOD0 descriptor+texel dilimiyle bağlandı; 26 statik çizim dokulu. Yüksek LOD streaming, çalışma anında üretilen boya ve ışık verileri açık.
2. **T-002 yapıldı; T-003 sürüyor:** Tek instance805vertex/726üçgen ve blok27'de14instance/7.308vertex/6.106üçgen çözüldü. Sıradaki: diğer geometri blokları (15/17/26/31/32), base7–10 ek stream semantiği (8instance), level materyalleri, görünürlük ve yüksek LOD'lar.
3. Native particle-cache çökmesi için tam bellek dump'ı ve sınırlı Free/AtomicFree izi al; Windows sürüş/fizik karşılaştırması için kararlı referans oluştur.
4. Bir araç/bir pist üzerinde platform, özgün fizik, kontroller, streaming ve sesi taşı; tam tek oyunculu yarışı doğrula. Ardından iki tarayıcı için özel oda/ağ aşamasına geç.

## Teknik seçimler

- **Windows x64 referansı:** Rebuilt'in yüksek FPS, pointer ve render düzeltmeleri kullanılacak aday temel. Hangi parçaların web'e taşındığı deneylerle kaydedilir.
- **WASM:** İlk küçük deney için wasm32 aday; tam motor için bellek ölçümü sonrası karar. x64 dosya/struct varsayımları otomatik taşınmaz.
- **Görsel katman:** WebGPU aday. DX11 efektleri doğrudan web'de kullanılamaz; önce sınırlı materyal dönüşümü ölçülür. Shader aracına henüz karar verilmedi.
- **Depolama:** İlk geliştirme deneyinde yerel test dosyalarından dilim okuyarak çalışma; bütün 5 GB'ı tek seferde WASM belleğine kopyalamama. Nihai web sürümünün içerik sunumu, kalıcı tarayıcı depolaması ve streaming yolu gerçek çalışma kümesi ve dağıtım koşullarıyla seçilir.
- **Ağ:** Mevcut yarış senkronizasyonunu mümkünse koru; WinSock/UDP yerine web taşıma adapter'ı. WebRTC DataChannel + signaling/TURN aday, kesin karar paket ve güvenilirlik ölçümünden sonra.
- **Hizmetler:** İlk deneylerde domain, ücretli sunucu, veritabanı ve hesap sistemi gerekmez. Özel oda gereksinimi doğduğunda minimum servis seçilir.

## İlk kritik riskler ve yön değiştirme koşulları

1. Kaynaktan Windows release eşleşmesi sağlanamazsa önce eksik kaynak/SDK/üretim girdisini bul; web motoruna geçerek problemi gizleme.
2. Gerçek pak verisinde desteklenmeyen codec veya eksik format çıkarsa küçük reader sınırında çöz; veri bozulmasını sessizce kabul etme.
3. Shader/vertex/material dönüşümü kabul edilebilir değilse renderer seçimini ve kapsamını yeniden değerlendir.
4. Fizik WASM'de yeterince hızlı veya kararlı değilse SIMD/scheduler ve zaman adımı ölçümüne dön; deterministik olduğu varsayımına dayanarak multiplayer tasarlama.
5. AMAX helper'ın kaynak-release eşleşmesi açık soru; arkadaşlarla özel yarış için AMAX entegrasyonunu zorunlu ilk hedef yapma.

## Kullanıcıdan gerekenler

- Şimdilik GitHub hesabı bağlaman gerekmiyor. Public kaynak kopyalandı, yerel çalışma başlayabiliyor. Özel uzaktan yedek/depo aşamasında GitHub bağlantısı isteğe göre kurulacak.
- Oyun kurulumu ve veri envanteri tamamlandı; bu aşamada yeni dosya veya hesap bilgisi gerekmiyor.
- Mac bağlantısı kurulumunda Mac'in yanında olman ve kendi hesabında eşleştirmeyi tamamlaman gerekir. İşlemden sonra farklı ağdan gerçek talimat testi yapılır.
- Gereken yerel derleme araçları hazır. İleride kullanıcı etkileşimi gerektiren bir hesap veya yönetici ekranı çıkarsa somut adım açıklanır.

## Ayrıntılı dayanaklar

- `docs/setup/windows-build.md`
- `docs/plan/browser-probe.md`
- `docs/plan/multiplayer.md`
- `docs/research/wasm-feasibility.md`
- `docs/research/remote-codex.md`
