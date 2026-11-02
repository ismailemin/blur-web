# T-006a — Native LAN başlangıç envanteri

**Tarih:** 2 Kasım 2026
**Tür:** Ön inceleme (analiz). Kaynak/oyun verisi/task kartı değiştirilmedi.
**Metot:** Yalnız `upstream/BlurRebuilt` (commit `5270304b`) ve repo içi kanıt
dosyalarının okunması. **Oyun çalıştırılmadı, derleme ve paket yakalama
yapılmadı.** Aşağıdaki "yapılabilir/gerekir" ifadeleri koddan çıkarımdır; test
sonucu değildir.

Bu belge T-006'nın ilk dilimi içindir: iki istemcili **native** LAN yarışı için
envanter, kanıt boşlukları ve paket yakalama planı.

## 1. Mevcut LAN/online kod yolları

Yollar `upstream/BlurRebuilt` köküne görelidir.

| Kaynak | Bulgu |
|---|---|
| `code/amax/library/Network/Lan/NetLanDiscoveryDefines.h:29-35` | PC keşif portu **50001**, PS3 **50000**. Sabit; yapılandırılabilir değil. |
| `.../NetLanDiscoveryDefines.h:44-68` | `LanDiscoveryHeader` = `U32 version + U32 titleId + enum type(4) + Nonce(8)` = **20 B**. `Request` +`U32` = 24 B. `Reply` = 20 + `U64` consoleId + `BaseProfile` + `SessionSecurity`(8+8+16=32) + `BD_COMMON_ADDR_SERIALIZED_SIZE`(25) + `U8` maxSlots + `U8` slotsTaken + `NetRaceSettingsQos`. |
| `.../Lan/NetLanDiscovery.cpp:47-69` | `m_Socket.create(false,true)` = non-blocking + SO_BROADCAST; `bind(Any(), 50001)`. Bind başarısızsa `Initialise` false döner. |
| `.../NetLanDiscovery.cpp:119-152` | `Enumerate`: yeni nonce, `Broadcast():50001` adresine **tek** istek datagramı. |
| `.../NetLanDiscovery.cpp:195-283` | `Poll`: döngüde `receiveFrom`; `m_TitleId` eşleşmesi, **tam boyut** kontrolü (`received == sizeof(...)`, 227/258), nonce eko kontrolü (261), reply listesine ekleme. Pencere **2.0 s** (277). |
| `.../Lan/NetLanDiscovery.cpp:229-249` | Host yalnız `m_Advertising` ise ve boş slot varsa reply gönderir; reply unicast, kaynak port yine 50001. |
| `.../Misc/NetDatagramPacketTypes.h:27-75` | Mesaj tipi numaraları (enum sırası): Ack=1, KeepAlive=2, JoinRequest=3, JoinReply=4, JoinData=5, JoinFailure=6, InitialData=7, NewRaceData=8, Leaving=9, DisconnectConsoles=10, Migrate=11, PlayerStates=14, VehicleData=15, StartRace=16, AwardsData=17, BasicVoice=21, BasicVehicleData=23, VehicleFinished=24, PostRace=28, ForceRaceTimeout=32. |
| `.../Misc/NetDatagramHeader.h:24-64` | Ortak başlık **4 B**: `U16 m_EncryptedBytes` (big-endian, `NetEncrypted.h:25-28`) + 16 bit alan: `Reliable:1`, `PartyChannel:1`, `SenderReference:6`, `PacketType:8`. Reliable başlık **+6 B** (`InitialConnection:1`, `FirstPacketInStream:1`, `PacketSize:14`, `TotalMessageSize`, `PacketSequence`) = **10 B**. Ack başlığı **6 B**. Boyutlar `static_assert` ile sabitlenmemiş; MSVC bitfield düzeni tek doğruluk kaynağı. |
| `.../Router/NetRouter_pc.cpp:115-162` | `PlatformConnect(onlineMode, user, pass)`: kullanıcı/parola **yalnız** `onlineMode==true` iken zorunlu (146-155). |
| `.../Router/NetRouter_pc.cpp:348-484` | `StartConnect`: adaptör IP'lerini toplar; `bdNetStartParams.m_onlineGame = m_OnlineMode` (355). |
| `.../Router/NetRouter_pc.cpp:452-465` | **Offline yol**: `net->start()` beklenir, `BD_NET_DONE` ise `eConnectionStateComplete`; hiçbir online servise bağlanılmaz. |
| `.../Router/NetRouter_pc.cpp:486-519` | Online yol: `DW_AUTH_ADDRESS` / LSG DNS → auth → lobby (DemonWare). LAN bu yolu kullanmaz. |
| `code/vendor/demonware/2.0/bdNet/bdNet.cpp:94-149` | `m_onlineGame==false` iken NAT/UPnP hiç başlamaz; `bdCommonAddr` "geçersiz public adres" ile kurulur, `bdSocketRouter` init edilir. |
| `code/vendor/demonware/2.0/bdNet/bdNetStartParams.h:16-20`, `.cpp:11-29` | Oyun soketi varsayılan **UDP 3074**, `m_useAnyIP=true`. |
| `code/vendor/demonware/2.0/bdNet/bdNet.cpp:731-786` | `findFreePort`: 3074'ten başlayıp **100** port dener (3074–3173). |
| `.../Router/NetRouterBase.cpp:212-271` | Receive: plaintext başlık okunur; reliable / ack / unreliable ayrımı; unreliable'da şifreli bayt sayısı başlıktan hesaplanır (253-263). |
| `.../Router/NetRouterBase.cpp:503-556` | Unreliable gönderim: `router->getStatus(addr) == BD_SOCKET_CONNECTED` değilse **sessizce** `false` (518-520); aksi halde `sendTo` (545). |
| `.../Network/Core/NetRace.cpp:259-292` | `CreateLanSession`: `m_OnlineMode=false`, `bdSecurityKeyMap::initKey` + `registerKey`, `JoinSetState(Complete)`, `AdvertiseLanGame()`. |
| `.../Core/NetRace.cpp:329-364` | `JoinLanSession`: `m_OnlineMode=false`, keşif reply'ından gelen `SessionSecurity` ile `registerKey`, `JoinStart`. |
| `.../Core/NetRace.cpp:2265-2295` | Host yalnız yerel host oyuncu ve `consoleId != 0` ise reklam verir. |
| `.../Core/NetJoinHelper.cpp:222-269` | `JoinStart`: host `bdCommonAddr` deserialize + `getAddrHandle(host, security.m_Id)` + **DTLS `connect`**. Anahtar eşleşmezse adres null kalır. |
| `.../Core/NetJoinHelper.cpp:302-321` | Join timeout / `BD_SOCKET_IDLE`/`LOST` → join iptal. |
| `.../Core/NetRace.cpp:2432-2466` | `JoinRequest` **unreliable**: `NET_PACKET_VERSION`, hedef joinId, host consoleId, kendi consoleId, common address (25 B), up/down kbps, DLC mask, yerel oyuncu sayısı. |
| `.../Core/NetRace.cpp:886-1020` | Host `JoinReply` (reliable, `InitialConnection=true`) ve `JoinData` (reliable) ile diğer peer listesini gönderir. |
| `.../Core/NetRace.cpp:460-565` | Reliable/unreliable mesajların yarış ve game-mode katmanlarına dağıtımı. |
| `.../Core/NetRace.cpp:3285-3288` | `PollMatchingServer` `!m_OnlineMode` iken hiç çalışmaz → LAN'de matching server'a trafik yok. |
| `.../Message/NetMessageReliableOutBox.cpp:67,153-185,187-288,290-321` | Reliable kuyruk: **0.5 s** yeniden gönderim, paket başına **1024 B** veri, party/race ayrı sequence, tek seferde **yalnız kuyruk başındaki** paket gönderilir; ACK yalnız baş paketle eşleşirse kuyruktan düşer. |
| `.../Misc/NetDefines.h:96-102` | Inbox **6 KiB**, outbox **12 KiB** (peer başına; `NetPlayerManager.cpp:53-57`), araç güncelleme aralığı **100 ms**, `NET_MAX_DATAGRAM_SIZE=1024`. |
| `.../Misc/NetDefines.h:70-90` | Join timeout 15 s, host dropout 4 s, peer dropout 6 s, keepalive **0.5 s**, voice 0.1 s. |
| `code/vendor/.../bdSocketConfig.h:28` | `BD_MAX_DATAGRAM_SIZE=1288` (uygulama sınırı 1024). |
| `.../Router/NetRouterBase.cpp:104-120,276-283,637` | Zaten var olan telemetri: `m_UsageIn/Out` (KiB/s), PIX sayaçları `NetRB - NumReceiveFrom/TotalBytes/TotalTimeInMs/LongestInMs/LongestSize`. |
| `code/amax/library/Ui/UiManager.cpp:260,2531-2542` | Debug anahtarı **`Network.Core.ShowBandwidthUsage`** ekranda In/Out kbps çizer. |
| `.../Network/Core/NetServices.cpp:112-117` | Non-GOLD build'de yalnız `warn`/`err` kanalları açılır → ağ `LOGINFO` satırları varsayılan kapalı. |
| `.../Network/Misc/NetVersion.h:21-43` | Non-GOLD'da paket sürümü `Debug::Enum` (`Network.BuildVersionToJoin`, varsayılan `eNetBuildVersion_Master`); GOLD'da sabit `0x0F000001`. |
| `.../Network/Misc/NetDefines.h:153-159` | LAN filtresi başlığı: PC `AMAX_LAN_ID=0x2C`. |

LAN'a giriş (UI/Lua) yolu:

- `.../Ui/game/lua_scripts/screens/Multiplayer/MpMain.lua:281-295`: LAN seçimi →
  `NetServices.NetworkConnectionActive()` ve `CheckEntryRequirements(false)` →
  `net_MpEnter(SystemLink)` → `net_StartServiceConnection(false, ...)`.
- `.../GameLogic/Lua/lua_NetServices.cpp:936-942`: `NetworkConnectionActive`
  yalnız `NetPlay::C_Core::ValidLocalAddress()`.
- `.../lua_NetServices.cpp:560-568`: PC'de `CheckEntryRequirements(false)`
  DemonWare kullanıcı/parola **istemez**; kontrol yalnız `online==true` dalında.
- `.../lua_NetRace.cpp:302-405`: `CreateLanServer` / `JoinLanServer` /
  `EnumerateLanGames` Lua'dan çağrılabilir; `GenerateMachineIdentifier`
  (`consoleId != 0`) ve `BuildLocalPlayersForLan(10 Mbps/10 Mbps)` gerekir.
- `.../screens/Multiplayer/Shared/MpModeSelect.lua:78-84` ve
  `MpPlaylists.lua:110`: host akışı `NetRace.CreateLanServer(...)` → `MpLobby`.
- `.../screens/Multiplayer/MpLan.lua:55`: liste ekranı `EnumerateLanGames(true)`.

**Özet:** LAN yolu online kimlik doğrulamasına girmiyor, ama taşıma yine
`bdNet`/`bdSocketRouter` + **DTLS** üzerinden. Yani "birkaç socket çağrısını
değiştirmek yeter" iddiası bu envanterle desteklenmiyor; offline başlangıç
gerçekten auth'suz, fakat DTLS anahtar eşleşmesi ve common-address serileştirmesi
şart.

## 2. İki istemcili native LAN yarışı ne gerektirir?

**Build**
- Aynı `Amax.exe` (SHA-256 kayıtlı) ve aynı build config. Release =
  `BUILD_CONFIG_SPEED` → **CFG_GOLD yok** → `NET_PACKET_VERSION` runtime debug
  değeri. İki istemcide `Network.BuildVersionToJoin` **aynı** olmalı
  (`NetLanDiscovery.cpp:31`, `NetVersion.h:21-43`). Keşif filtresi yalnız
  `m_TitleId`'ye bakar; sürüm ancak join sırasında
  (`lua_NetRace.cpp:387`, `MpLan.lua:81`) ve `JoinRequest` içinde
  (`NetRace.cpp:2449`) karşılaştırılır. Eşit değilse `JoinLanServer` false döner.
- Aynı oyun verisi. `JoinRequest` DLC mask + içerik bilgisi taşır
  (`NetRace.cpp:2446-2465`); içerik uyuşmazlığı `eJoinErrorContentMismatch`
  üretir.

**Veri / ayarlar**
- Her istemcide ayrı `BLUR2PC_SAVE_ROOT` ve `BLUR2PC_SETTINGS` (mevcut
  `_work/native-source/Blur1PCDX11/_work/run/run_script.ps1:15-20` deseni).
- Yerel profil + makine kimliği (`GenerateMachineIdentifier`) gerekir; AMAX
  hesabı gerekmez.
- `Debug::Bool` anahtarı `Network.Core.ShowBandwidthUsage` ilk baseline'da açık
  olmalı ki In/Out kbps ekrandan kayda geçsin. `Debug::Persist()` ile
  tanımlanmadığı (`UiManager.cpp:260`) için dosyadan kalıcı yüklenmesi
  doğrulanmadı; runtime'da açılması gerekebilir.

**Ağ / portlar**
- İki ayrı makine (aynı subnet, broadcast serbest). Aynı makinede iki istemci
  **çalışmaz**: keşif soketi `INADDR_ANY:50001`'e bind ediliyor ve
  `bdPlatformSocket-win32.cpp:49-98` `SO_REUSEADDR` kurmuyor → ikinci bind
  başarısız. Üstelik `C_NetRace::Initialise` bu sonucu kontrol etmiyor
  (`NetRace.cpp:104-110`), yani keşif sessizce ölü kalır.
- Ek olarak `tools/game_slot.ps1:8-13` makine-genelinde `Global\Blur2PC.GameSlot`
  mutex'i ve mevcut `Amax/Blur` süreçlerinin bitmesini bekliyor; ikinci eşzamanlı
  istemci bu launcher'la da mümkün değil.
- Windows Güvenlik Duvarı: gelen UDP **50001** (keşif) ve UDP **3074–3173**
  (oyun soketi, `findFreePort`). Giden UDP serbest olmalı.
- İlk denemede 3074'ün boş olduğu doğrulanmalı; doluysa port 3075'e kayar ve
  yakalama filtresi 3074'ü kaçırır.

**Auth'suz yapılabilenler**
- Offline `PlatformConnect(false, ...)`, `CreateLanSession`, `JoinLanSession`,
  lobi, yarış: kod yolu DemonWare'e girmiyor (`NetRouter_pc.cpp:452-465`,
  `NetRace.cpp:3287`). Yani **AMAX online auth olmadan iki makineli LAN
  başlangıcı kod açısından mümkün görünüyor**; ancak bu henüz denenmedi.

**Açık kalan**
- Non-GOLD build'de LAN menüsünün gerçekten açık olduğu ve
  `CreateLanServer`'ın lobby'ye geçtiği doğrulanmadı.
- İki makinede aynı anda automation script çalıştırma akışı yok; `game_slot`
  kilidi makine genelinde olduğu için iki istemci ancak iki ayrı makinede
  launcher çalıştırılarak koşturulabilir.

## 3. Repo'daki mevcut kanıtlar ve eksikler

**Var**
- Native race harness: `_work/native-source/Blur1PCDX11/_work/run/run_script.ps1`
  + `scripts/race-native/smoke.txt` + `prepare_race.lua` (gerçek GameData'dan
  UK_Brighton_1 / BMW 1 Series seçimi, tek araç, debug menü `Amax.SetupRace`).
- Stationary race: `scripts/race-stationary/smoke.txt` (gaz yok, `Racing`
  durumu + screenshot + `quit`).
- Crash kanıtı: `scripts/race-native*/crash.dmp`, `crash.txt`, tam bellek dump'ı
  ve `docs/work/analysis/native-particle-crash.md`.
- Nitelikli denetim: `_work/build/engine-reference/native-race-audit.json`
  (EXE hash'leri, senaryo çıktıları, artifact hash'leri).
- Derleme/çalıştırma altyapısı: `tools/game_slot.ps1`,
  `docs/setup/native-source-build.md`, `_work/vendor/atl-v143-14.44`.

**Yok (LAN baseline için gerekli)**
- Hiçbir iki istemcili senaryo, LAN keşif/join logu veya pcap yok.
- `SystemLink` moduna girişi süren automation script'i yok; mevcut script
  tek oyunculu debug-menü yarışı.
- Per-peer outbox/inbox doluluk sayacı, mesaj tipi sayımı ve RTT ölçümü için
  hiçbir enstrümantasyon yok; mevcut telemetri yalnız toplam In/Out kbps.
- Keşif/oyun portları için firewall kuralı ve iki makine kurulum kaydı yok.
- Non-GOLD'da `Network.BuildVersionToJoin` değerinin iki tarafta eşitlendiğine
  dair kayıt yok.

## 4. Paket yakalama planı (şimdi oyun çalıştırmadan)

**Neden pcap tek başına yetmez:** yükün tamamı DTLS ile şifreli; yalnız ilk
4–10 baytlık başlık plaintext (`NetDatagramHeader.h:24-64`,
`NetRouterBase.cpp:212-271`). Başlık yine de mesaj tipi, güvenilirlik, gönderen,
boyut ve sequence verdiği için tip histogramı/RTT çıkarılabilir; **oyun durumu
ve içerik pcap'ten okunamaz.** Bu yüzden plan "pcap + oyun içi sayaç" olmalı.

**Yakalama noktaları ve roller**
- Host makinesi ve peer makinesi ayrı ayrı, her iki yönde.
- Filtre: `udp and (port 50001 or portrange 3074-3173)`.
- Her iki uçta saat senkronu (NTP veya aynı saat kaynağı) ve yakalama başlangıç
  damgası kaydedilmeli; RTT için tek yönlü gecikme değil, sequence↔ACK çifti
  kullanılacak.

**Kaydedilecek alanlar (başlıktan türetilebilir)**
| Alan | Kaynak |
|---|---|
| zaman, kaynak/hedef IP:port | pcap |
| `Reliable`, `PartyChannel`, `SenderReference`, `PacketType` | 4 B ortak başlık |
| `PacketSize` / gerçek UDP uzunluğu | reliable başlık / pcap |
| `PacketSequence`, `TotalMessageSize`, `FirstPacketInStream`, `InitialConnection` | reliable başlık |
| ACK edilen sequence ve ACK gecikmesi | `DatagramAcknowledgementHeader` + eşleşen reliable paket |
| yeniden gönderim (aynı sequence'un tekrarı) | aynı sequence + 0.5 s aralık |

**Beklenen frekanslar (koddan)**
- Keşif: 1 istek (broadcast) + N reply; 2 s toplama penceresi.
- Yarış içi araç kontrolü: **10 Hz** (`NET_VEHICLE_UPDATE_TIME=100` ms,
  `RaceModeMultiplayer.cpp:166-174`), boyut ≤ 1024 B ve voice payı düşülerek
  (`RaceModeMultiplayer.cpp:854-871`).
- Keepalive: **2 Hz** (`NET_KEEPALIVE_NORMAL_FREQUENCY=0.5`);
  `NetPlayerManager.cpp:413` son gönderimden bu yana geçen süreye bakar, yani
  araç trafiği varsa ayrı keepalive çıkmayabilir.
- Reliable: olay tabanlı (join, player states, race data); kayıp yoksa ACK
  sonrası kuyruk boşalır, varsa **0.5 s** arayla tekrar.
- Lobi/oyuncu durumu: olay tabanlı; `PostRace` yarış sonunda.

**Kuyruk büyümesi**
- Doğrudan okunabilir alan yok; `m_BytesInOutbox` private
  (`NetMessageReliableOutBox.h:98-106`). Bu yüzden kuyruk büyümesi **pcap
  türevi** ölçülecek: gönderilen reliable paket sayısı − ACK sayısı, ve aynı
  sequence'un tekrar oranı.
- Reliable kuyruk head-of-line: ACK gelmeden sonraki mesaj gönderilmiyor
  (`NetMessageReliableOutBox.cpp:153-185`). Kayıp senaryosunda bunun ölçülebilir
  olması beklenir; ölçüm tasarımı bunu ayrı senaryo olarak içermeli.
- Inbox 6 KiB taşarsa ne olduğu bu incelemede çıkarılmadı; açık soru.

**Host/peer rolleri**
- Host = `HostPlayer(false)` + `consoleId != 0`; keşifte reklam veren taraf.
- Peer = keşif reply'ındaki `SessionSecurity` + `HostCommonAddress` ile DTLS
  bağlantısı kuran taraf (`NetJoinHelper.cpp:222-269`).
- Host, yeni peer'e diğer peer'lerin bilgisini `JoinData` ile yayar
  (`NetRace.cpp:886-1020`); yani 3+ istemcide trafik simetrik değil.

**Şimdi oyun çalıştırmadan yapılabilecek kayıt işi**
1. Bu belgedeki port/mesaj/frekans tablosunu "beklenen değerler" olarak dondur.
2. `NetDatagramHeader.h` boyutlarını bağımsız bir hesap/derleme ile doğrula
   (static_assert veya tek TU'luk probe); bitfield düzeni MSVC'ye bağlı.
3. Yakalama komut şablonunu ve çıktı şemasını (CSV kolonları) yaz; pcap →
   CSV dönüştürücüyü sentetik baytlarla test et.
4. `Network.Core.ShowBandwidthUsage` ve `Debug::` anahtar listesini kaydet;
   enstrümantasyon gerektirmeyen telemetri bu kadardır.

## 5. Sonraki somut adım ve kabul kriterleri

**Önerilen ilk adım (T-006b): "LAN keşif + join + lobi" baseline'ı, yarış yok.**
Yarışı ilk adıma koymamak bilinçli: native sürüş referansı particle-cache
çökmesi yüzünden kararsız (`docs/handoff/CURRENT.md:81`,
`native-particle-crash.md`). Önce taşıma ve oturum kurulumu kanıtlanmalı.

Adım:
1. İki Windows makinesi, aynı `Amax.exe` + aynı veri; firewall kuralları
   (UDP 50001, 3074–3173) eklenir; 3074 boş doğrulanır.
2. Host: Multiplayer → LAN → Custom Race → 2 slot → lobby.
3. Peer: Multiplayer → LAN → listeyi gör → join → lobby.
4. İki makinede de yakalama + `Network.Core.ShowBandwidthUsage` açık;
   automation logu ve tek ekran görüntüsü alınır; lobide 10 s beklenir.
5. **B1b (opsiyonel, B1 geçtikten sonra):** yarış başlatılıp 10 s `Racing`
   durumunda kalınır, sonra çıkılır. Bu adım T-004 çökmesi nedeniyle ayrı
   değerlendirilir.

**Kabul kriterleri (B1)**
- [ ] İki makinede de aynı EXE SHA-256 ve aynı `Network.BuildVersionToJoin`
      değeri kayıtlı.
- [ ] Host pcap'inde broadcast `Request` (port 50001) ve unicast `Reply`
      görülüyor; reply `titleId=0x2C` ve istek nonce'unu taşıyor.
- [ ] Peer pcap'inde `JoinRequest` (unreliable) → `JoinReply`
      (`InitialConnection=1`) → `JoinData` sırası ve ACK'ler görülüyor.
- [ ] Reliable sequence'ler party/race ayrı ve monoton; açıklanamayan boşluk
      veya ACK'siz tekrar yok.
- [ ] Her iki tarafta lobi 2/2 oyuncu gösteriyor; hiçbir tarafta
      `eJoinError*` / dropout yok.
- [ ] In/Out kbps ve paket/sayı özeti CSV olarak kaydedildi; ham pcap +
      SHA-256 + komut satırı belgede.
- [ ] Konsol/log'da açıklanamayan hata yok; varsa hangi taraf olduğu yazıldı.

**B1b ek kriteri:** her iki tarafta yarış 10 s `Racing` kalıyor, çökme yok
(exit kodu kayıtlı) ve reliable kuyruk ACK'lerle boşalıyor.

**Kapsam dışı (bu baseline'da iddia edilmeyecek):** tam tur, finish, hasar,
pickup, host migration, 3+ oyuncu, internet/TURN, WASM.

## 6. Riskler / açık sorular

- Non-GOLD build'de LAN'ın UI'dan gerçekten çalıştığı **doğrulanmadı**; ilk
  deneme bu yüzden "keşif görünür mü" sorusuna kilitlenebilir.
- DTLS anahtar eşleşmesi (`registerKey` + `getAddrHandle`) LAN'de sorunsuz mu,
  yoksa auth'tan gelen bir alan mı gerekiyor — kod offline yolu destekliyor
  görünüyor ama kanıt yok.
- `NetRace.cpp:104-110` keşif init hatasını yutuyor; sessiz başarısızlık riski.
- Reliable ACK yalnız kuyruk başı paketiyle eşleşiyor; yüksek kayıpta lobi
  trafiği tıkanabilir, ölçülmedi.
- pcap'ten oyun durumu okunamaz; enstrümantasyon (mesaj tipi sayacı, outbox
  doluluğu, RTT) ayrı ve dosya sahipliği gerektiren bir iştir.
