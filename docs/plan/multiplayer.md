# Tarayıcı multiplayer çalışma planı

28 Ekim 2026. İncelenen checkout: `upstream/BlurRebuilt`, commit `5270304b81983b9e3edbd569ba25235c17bbabd7`. Kaynaklar değiştirilmedi, servisle bağlantı/hesap/oyun testi yapılmadı. Bu belge proje önerisidir; çalışan tarayıcı multiplayer iddiası değildir.

## Karar

İlk hedef mevcut LAN yarış mantığını iki kontrollü istemci arasında koruyabilmek. Özel oda keşfi ve bağlantı taşımasını tarayıcıya uyarlamak gerekir. AMAX üyelik, profil, leaderboard ve internet matchmaking entegrasyonunu ilk aşamaya bağlamayalım. LAN yolu bile DemonWare taşımasından bağımsız değil; yalnızca online kimlik doğrulamasını atlıyor. Bu nedenle yalnız birkaç socket çağrısını değiştirmenin yeteceği henüz söylenemez.

## Koddan doğrulananlar

Tüm yollar upstream checkout köküne göre; GitHub kaynakları aşağıdaki sabit commit ile açılabilir: `https://github.com/uKER/BlurRebuilt/blob/5270304b81983b9e3edbd569ba25235c17bbabd7/<yol>`.

| Kaynak | Bulgu | Sonuç |
|---|---|---|
| `code/amax/library/Network/Lan/NetLanDiscovery.cpp:47` | `bdSocket` oluşturup keşif portuna bind ediyor; 146-147'de broadcast gönderiyor, 195 sonrası receive/poll ve cevap işliyor. | Tarayıcıda aynı LAN broadcast yolunu koruyamayız; oda kodu/listesi bu işi üstlenmeli. |
| `code/amax/library/Network/Lan/NetLanDiscoveryDefines.h:29` | PC keşif portu 50001; istek/cevap yapıları profil, nonce, session/security ve ortak adres verilerini taşıyor. | Keşif paketiyle yarış trafiğini ayır; portu açmak tarayıcı uyumu sağlamaz. |
| `code/amax/library/Network/Router/NetRouter_pc.cpp:348` | `bdNetImpl` online/offline modda başlatılıyor. 453 sonrası offline yol online servise bağlanmadan tamamlanıyor; 514 sonrası online yol DemonWare DNS/auth/lobby akışına geçiyor. | Özel arkadaş odası için offline/LAN başlangıcı aday; buna rağmen alttaki `bdNet` taşıması değişmeli. |
| `code/amax/library/Network/Router/NetRouterBase.cpp:149` | Poll/receive `bdSocketRouter` ve `bdAddrHandleRef` kullanıyor. 503/558 gönderme yolları router durumunun `BD_SOCKET_CONNECTED` olmasını kontrol edip `sendTo` çağırıyor. | Bir transport adapter yalnız gönderme/alma değil peer kimliği, bağlantı durumu ve hata semantiğini de karşılamalı. |
| `code/amax/library/Network/Message/NetMessageReliableOutBox.cpp:239` | Paket bölme, party/race ayrı sequence sayaçları, ACK ve tekrar gönderme var (169/290). | Mevcut reliable/unreliable ayrımını ilk deneyde korumak uygun; WebRTC güvenilirliğiyle üst üste binmenin maliyeti ölçülmeli. |
| `code/amax/library/Network/Misc/NetDatagramHeader.h` | Datagram başlığı C++ bitfield/struct düzeniyle tanımlanmış; reliable başlık sequence/size alanları ekliyor. | MSVC ile Clang/WASM wire-layout eşitliğini varsayma; boyut/offset ve altın paket byte testleri gerekir. |
| `code/amax/library/Network/Core/NetRace.cpp:329` | Ayrı `JoinLanSession` ve `JoinOnlineSession` yolları var; reliable/unreliable mesajlar yarış/game mode'larına dağıtılıyor. 965 sonrası host yeni oyuncuya bağlanacağı diğer peer listesini gönderiyor. | Kaynakta peer bağlantılı oturum ve host koordinasyonu var; tamamen otoriter dedicated server olduğunu varsayamayız. |
| `code/amax/game/Game/GameActors/Components/VehicleLogic/VLC_Network_Abilities.cpp` ve `.../Multiplayer/VLC_Network_Damage.cpp`, `VLC_MP_Network_Pickups.cpp` | Araç yetenekleri, hasar ve pickup olayları için ayrı network bileşenleri mevcut. | Yalnız araç konumu eşitlemek tam Blur multiplayer değildir; bu olayların da kabul testleri gerekir. |

Mevcut serializer, join durum makineleri, oyuncu/oturum yönetimi, reliable mesaj kutuları ve yarış olayları korunabilecek adaylar. Aday olmaları WASM'de derlendikleri veya doğru çalıştıkları anlamına gelmez. Native tipler, callback/queue modeli, saat kaynakları ve DemonWare adres/security türleri için bağımlılık envanteri gerekir.

## Kaynak ve yayınlanan sürüm eşleşmesi

README, v1.5 için AMAX online desteğini ve `BlurRebuilt.exe`, `AmaxClientHost.exe`, `fx11` kurulumunu bildiriyor. `rg --files` ile tüm checkout'ta `AmaxClientHost`, `amax_client` veya `.asi` adlı kaynak/dosya bulunmadı; README dışındaki uygulama kodunda bu yeni helper adına rastlanmadı. PC router hâlâ eski DemonWare auth/lobby adreslerini içeriyor.

Bu bulgu online entegrasyonun nasıl üretildiğini belirsiz bırakıyor; bütün oyun kaynağı eksik demek değildir. İlk Windows build kapısında yayınlanan exe/helper ile checkout'un derleme çıktısı karşılaştırılmalı. Güncel helper kaynağı başka dal/commit/araçta mı, yayın paketi ayrı mı, bilinmiyor. Kullanıcı hesabı veya AMAX parolası bu araştırma için gerekmez.

## Önerilen tarayıcı mimarisi

- Küçük HTTPS/WebSocket servisi: oda oluşturma/katılma, kısa oda kodu, sürüm uyumu ve WebRTC signaling. Oyun dosyalarını bu servise yüklemek gerekmez.
- WebRTC DataChannel: peer'ler arasında yarış paketleri. Bağlantı `bdAddrHandleRef` yerine kararlı uygulama peer kimliğine eşlenir. Callback'ler ana oyun güncellemesinde tüketilen sınırlı bir receive kuyruğuna aktarılır; motorun döngüsünü bloklayan bekleme yapılmaz.
- STUN/TURN: farklı ev/ofis/NAT ağlarında bağlantı testi. TURN gerektiğinde yarış trafiğini aktarır; oyunun grafiklerini sunucuda üretmez. Topoloji ve oyuncu sayısı belirlendikten sonra bant genişliği hesabı yapılır.
- İlk prototipte mevcut uygulama ACK/retry mantığını koruyup paketleri uygun DataChannel üzerinden taşımayı sınarız. Reliable/unreliable kanal politikası ölçüm sonrası seçilir; iki ayrı güvenilirlik katmanını körlemesine üst üste eklemeyiz. İptal/kopma, kuyruk sınırı ve `bufferedAmount` backpressure ele alınır.
- Eski LAN broadcast yerine oda kodu peer/session bilgilerini sağlar. Eski DemonWare security/address nesnelerinin hangilerinin yalnız veri taşıyıcı, hangilerinin gerçek taşıma/şifreleme davranışı olduğu ayrıştırılmalıdır. Protokol alanları rastgele sıfırlanmaz.

Bu, kaynak incelemesinden çıkan öneridir. Emscripten ağ belgeleri tarayıcıdan doğrudan TCP/UDP socket erişiminin olmadığını açıklar: https://emscripten.org/docs/porting/networking.html . WebRTC DataChannel çift yönlü peer veri aktarımı ve kuyruk ölçümünü sağlar: https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel . Tam POSIX socket proxy'si bir teşhis alternatifi olabilir; ana mimari kabul edilmeden gecikme ve destek sınırları ölçülmeli.

## Ölçülebilir test kapıları

1. **Native temel:** aynı build/veriyle iki Windows istemcisi bir LAN yarışı bitirsin. Mesaj tipleri, paket boyut/sıklığı, RTT, kuyruk büyümesi ve host/peer bağları kayıt altına alınsın. Bu aşamada hangi makinenin hangi veri üzerinde otoritesi olduğu çıkarılsın.
2. **Wire biçimi:** mevcut C++ serializer/header'larından join ve seçilmiş araç/olay paketleri için altın byte örnekleri oluşturulsun; Windows ve WASM çıktıları eşleşsin. Struct bitfield ABI farkı varsa açık serializer yazılsın ve eski sonuçla doğrulansın.
3. **Transport deneyi:** oyun olmadan iki tarayıcı adapter'ı sıra numaralı aynı paketleri taşısın; reliable sırayı/kayıpsızlığı, unreliable eskimeyi, ayrılma/yeniden bağlanma ve kuyruk sınırlarını test etsin. Bu, oynanabilir yarışın yerine geçmez.
4. **LAN oturumu uyarlaması:** oda kodu üzerinden create/join, araç/pist seçimi, hazır durumu ve yükleme başlangıcı iki istemcide eşleşsin. Eski broadcast ve online auth çağrılarının çalışmadığı doğrulansın.
5. **Tam yarış:** iki tarayıcı önce aynı makine/ağ, sonra ayrı ağlarda bir yarışı bitirsin. Start, konum, pickup, silah, hasar, respawn, finiş ve sonuçlar karşılaştırılsın. TURN kullanılan bağlantı ayrıca test edilsin.
6. **Hata ve genişleme:** host çıkışı, peer çıkışı, yapay kayıp/gecikme ve sürüm/veri uyumsuzluğu ele alınsın. Sonra gerçek arkadaş sayısı kadar istemciyle CPU/bant genişliği ve bağlantı sayısı ölçülsün. İlk hedef için host migration zorunlu mu karar verilsin; eski kodu var diye çalışıyor kabul edilmesin.

İlk renderer/tek oyuncu kapıları geçilmeden online hesap/veritabanı/istatistik sistemi yazmak gerekmiyor. Oyun indirilirken yapılabilecek somut iş, mesaj/transport bağımlılık envanteri ve serializer test tasarımıdır; gerçek oyun trafiği ölçümü indirme ve native kurulum sonrasına bağlıdır.

## Bu tur doğrulama

Checkout commit'i `git rev-parse HEAD` ile doğrulandı. Scoped `rg` ve ilgili satır okumaları yapıldı. Repo başlangıç yardımcısı bundled Python ile çalıştırıldı ancak `agent_context: --root must name a Blur phase worktree` döndürdü; upstream kaynağında görev tahtası veya dosya değiştirilmedi. Çıktı yalnız bu dış plan dosyasıdır. Derleme, paket yakalama ve bağlantı testleri henüz yapılmadı.
