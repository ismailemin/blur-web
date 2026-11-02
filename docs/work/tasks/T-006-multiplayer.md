# T-006 — Tarayıcı multiplayer

**Durum:** analiz (T-006a/b tamam; T-006c sürüyor; uygulama T-005g/T-004'e bağlı)
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

### T-006b — Wire format / golden packets  ✅ (tasarım)
- Wire format = `memcpy(sizeof(struct))`; açık serializer yok.
- En büyük risk: `SysProfile::BaseProfile` içindeki `wchar_t` (MSVC 2, wasm32 4)
  Join/StartRace alanlarını kaydırır.
- İlk test: native/WASM `sizeof`/`alignof`/`offsetof` layout probe; sonra golden
  byte fixtures. P0 paketler: KeepAlive, ACK, JoinRequest/Reply/Data, InitialData,
  PlayerStates, VehicleData, StartRace, BasicVehicleData, VehicleFinished.
- Kanıt: `docs/work/analysis/t006-wire-format.md`.

### T-006c — WebRTC transport  (sürüyor)
- `bdSocket`/`bdSocketRouter` yerine DataChannel adapter; peer kimliği, bağlantı
  durumu, reliable/unreliable, MTU/backpressure, signaling/STUN/TURN.
- Kanıt: `docs/work/analysis/t006-transport.md` (hazır olunca).

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
