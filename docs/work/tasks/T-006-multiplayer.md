# T-006 — Tarayıcı multiplayer

**Durum:** analiz tamam (T-006a/b/c); uygulama T-005g/T-004'e bağlı
**Sahip:** ana ajan
**Başlangıç:** 2 Kasım 2026
**Bitiş:** —

## Amaç

Mevcut LAN yarış mantığını iki tarayıcı arasında korumak: oda kodu, WebRTC
DataChannel, host/peer oturumu; iki oyuncu farklı ağlardan aynı yarışı
bitirecek. AMAX online auth ilk kapsam değil.

## Alt görevler

### T-006a — Native LAN temeli / envanter  ✅
- PC LAN auth'suz; keşif UDP **50001**, oyun UDP **3074–3173**.
- İki istemci aynı makinede çalışmaz (`SO_REUSEADDR` yok); iki fiziksel makine.
- B1: iki makineli LAN lobisi + pcap/CSV; 10s `Racing` B1b (T-004 çökmesi ayrı).
- Kanıt: `docs/work/analysis/t006-native-lan.md`.

### T-006b — Wire format / golden packets  ✅ (layout probe)
- Wire format = `memcpy(sizeof(struct))`; açık serializer yok.
- **P56 layout probe:** native MSVC x64 vs wasm32 ölçüldü. `BaseProfile`
  56 → 80 B, `StartRace` 2104 → 2584 B (`wchar_t` 2→4; +480 B).
- **`-fshort-wchar` çözüm değil:** isim 34 B'ye insede `BaseProfile` 48 B
  (MSVC base-size 16 vs Itanium dsize 10 kuralı); Join 125→117, StartRace
  2104→1944 — yani yanlış yöne kayıyor.
- Öneri: `BaseProfile`, `NetStartRacePacketPlayer`, `NetStartRacePacket` için
  **açık encoder**; golden layout native sayıları (56 B, isim @16, 17 UTF-16LE;
  StartRace 2104 B, 20 slot). `#pragma pack(1)` reddedildi.
- Kanıt: `docs/work/analysis/net-layout.md`, `probes/net-layout/`; ana suite
  **30/30**.

### T-006c — WebRTC transport  ✅ (tasarım)
- Öneri: engine association başına bir `RTCPeerConnection`; `bdEndpoint` =
  common address + security ID. İki negotiated DataChannel: reliable ordered
  (join/start/vehicle setup) ve unreliable `ordered:false,maxRetransmits:0`
  (keepalive/ACK/vehicle state).
- `bdSocketRouter`/`bdNet` backend değişiyor; `C_NetRouterBase` ve oyun protokolü
  byte-identical kalıyor. IPv4 yerine opak 25-byte web peer record; WSS signaling;
  STUN/TURN; sınırlı kuyruk/`bufferedAmount`; blocking wait yok.
- İlk dilim: standalone browser adapter harness; 10.000×1 KiB reliable exact/
  ordered, unreliable loss/reorder, queue caps, reconnect/ICE restart.
- Riskler: T-005a wasm gate, IP tabanlı `bdCommonAddr`, blocking `StartConnect`/
  `GetAdaptersInfo`, DTLS/NAT seam yokluğu, signaling/TURN altyapısı yok.
- Kanıt: `docs/work/analysis/t006-transport.md`.

### T-006d — Oda/signaling servisi  (planned)
- HTTPS/WebSocket oda oluştur/katıl, kısa kod, sürüm uyumu; oyun dosyası yükleme yok.

### T-006e — İki tarayıcı aynı makine/ağ  (planned)
- Önce aynı makine, sonra aynı LAN; join/start/state/finish.

### T-006f — Farklı ağlar / TURN / hata  (planned)
- Farklı NAT'lar, TURN, kayıp/gecikme, reconnect, host/peer çıkışı, sürüm uyumsuzluğu.

## Kabul kriterleri

- İki tarayıcı farklı ağlardan aynı yarışı bitiriyor.
- Start, konum, pickup, silah, hasar, respawn, finish ve sonuçlar eşleşiyor.
- RTT, kayıp, kuyruk/backpressure ve kopma senaryoları ölçülü.
- Wire byte eşitliği native/WASM; ABI farkı açık serializer veya sabit layout ile
  kapatılmış.
- Oda kodu/sürüm uyumu; TURN gerektiğinde test edilmiş.
- Assert/çökme yok; T-004 durumu ayrıca raporlanır.

## Bağımlılıklar / engeller

- **T-005g** tek oyunculu tam yarış (T-006e/f için).
- **T-004** particle-cache çökmesi veya güvenli sürüş referansı.
- T-006b layout probe + golden packet byte eşitliği.
- T-006c transport kararı (reliable/unreliable, MTU, TURN).
- Oda/signaling servisi (T-006d).

## Kapsam dışı

- AMAX online hesap/matchmaking/leaderboard.
- Dedicated authoritative server varsayımı.
- Mobil ve tüm tarayıcılar.
