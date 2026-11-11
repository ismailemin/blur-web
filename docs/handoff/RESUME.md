# RESUME — 11 Kasım 2026, River hattı merkezlendi ve düşme düzeltildi

Bu dosya, çalışmaya kaldığı yerden devam etmek için yazıldı. Önce
[`CURRENT.md`](CURRENT.md), sonra bu dosya okunmalı. Ayrıntılı oturum kaydı:
[`docs/work/logs/2026-11-08-mp-eight.md`](../work/logs/2026-11-08-mp-eight.md)
(§25–§60).

## Bu turda (11 Kasım 2026)

| Alan | Durum |
|---|---|
| **Varsayılan harita** | **Amboy** (`DEFAULT_MAP_ID`), River değil. Shell demosu: `defaultMapId: "amboy"`, 0 konsol hatası, 44/44 test. |
| **River hattı** | Yeniden merkezlendi: **313,387 m**, 961/1245 örnek (max 5,23 m). Arc 150 aralığı **-8…+7 m** (eskiden -14…+2). |
| **Düşme** | Yeni `course.groundEdge`: respawn `min(bant, ölçülen zemin kenarı)`. River'da en kötü pay **1,75 m**; `below-ground` respawn'ı yok. |
| **Sprint** | Corvette **14,600 s / tick 966**, 0 respawn, 2/2 checkpoint; `solo-sprint` **39/39**; `race-rules` **67/67**. |
| **Kapılar** | `a/b` çizgisi teğetten yeniden kuruluyor; bitiş measuredEnd - 10 m; River'da `gateRule: "arc-progression"`. |
| **Doğrulama** | `verify_e1_map` 10/10; `ai-driver` 27/27 (eski layout satırları `staleLayout` ile atlanıyor). |
| **Haritalar** | **17/19.** hackney (639,752 m, arc 660 hairpin'inden önce), russianhill (180,253 m, covered bileşenin ilk istasyonu) ve brighton (ikinci bileşen, 191,975 m, arc 195-210'daki 3 m çıkıntıdan önce) draw-covered yolundan açıldı. `solo-hackney` 12/12, `solo-russianhill` 12/12, `solo-brighton` 12/12. |
| **Açık takip** | **bowl** (draw-covered yol yok, %0 çizim kapsaması) ve **showroom** (yarış haritası değil) — tipli veri sınırı. |

## 9 Kasım 2026 durumu (tarihsel)

| Alan | Durum |
|---|---|
| **Haritalar** | **14/19 oynanabilir**: river, amboy, gracia, longbeach, observatory, downtown, mharuna, highrise, shutoko, oval, amboy-mp, dumbo, downtown-mp, **sausalito** (222,286 m collision-raster halkası, min yarıçap 5,75 m, %100 çizim kapsaması). |
| **Araçlar** | **61/62** sürüş diliminde. Yalnızca `defaultcar` desteklenmiyor (gövde modeli yok). |
| **Lightmap** | **14/14 oynanabilir haritada render'da**. Sausalito **100 doku / 1347 draw**; Downtown 86/1279, Highrise 22/69 (kısmi set: tek tipli `unsupported` referans, o draw'lar ambient terimle). Amboy 83/1173, River 38/383, Dumbo 115/1615, Downtown MP 49/207. |
| **Işık düzeltmesi** | Lightmap'siz draw'lar artık **ambient** ile aydınlanıyor; River/Gracia/Longbeach'in `SunColour=[0,0,0]` olması onları siyah bırakıyordu, düzeltildi. |
| **Araç materyali** | Retail **boya** ve **ışık rengi** render'da. Corvette: `Canal_Blue` `[0.0252, 0.3712, 0.8228]`, 10 boya draw'ı; far/stop/sinyal kapakları retail `emissive` rengiyle. |
| **Ses** | 23 olaylı retail kataloğu sayfaya bağlı. |
| **HUD** | Hız göstergesi, vites, sıra/tur, güç yuvası, hasar/kalkan, geri sayım; 19/19 test. |
| **Menü** | **61 araç / 14 harita**, 44/44 test, başsız Edge 0 konsol hatası. |
| **Multiplayer** | 8 oyunculu oda (`mp-eight` 95/95); Amboy'da `?powerups=1` ile 82 pickup / 8 tip. |
| **AI** | 8 haritada 61 araç × 2 profil = **976 koşu**, 946 temiz, 30 bildirilmiş limit, 0 beklenmeyen; `verify-maps` **32/32**. Dumbo/Downtown MP 122/122 temiz. |
| **E2E** | **25/25 senaryo** (minimap, `mp-powerups`, `solo-sausalito`, `solo-checkpoint`, `mp-destruction` ve menüden başlatan `menu-modes` 13/13 dahil). |
| **Menü modları** | Mod listesi **5**: sprint, lap, free, checkpoint, multiplayer. Lobide maç modu **5**: **Race / Destruction / Points / Elimination / Boss Battle** (yalnız host). Destruction, Points ve Boss Battle power-up'ı zorlar; Boss Battle en az 1 host AI ister. Menü testleri **44/44**. |
| **Yarış modları** | `?mode=checkpoint` (40 s banka), `destruction` (180 s, wreck 5), `points` (committed 720 s `max_race_timer_time`, 19 etiketli puan satırı + 20..1 pozisyon puanı; 7 boş `ScoringEvent` satırı tipli `unsupported`), `elimination` (30 s periyot, son kalan kazanır; geçici), `boss-battle` (AmaxRaceModeBossBattle: 500 m/5 s minder, 150 m/0 s boss, wreckMindersToWin true, wreckBossToWin false). Boss Battle'ın iki erişim sınırı etiketli: AI power-up kullanmıyor (wreck yolu) ve 500 m > 310 m kurs (gap yolu). `race_modes_tests` **57/57**. |
| **Kapı** | **`verify_asset_probe --skip-build` 100/100 PASS** (`gate-full39.log`, exit 0). |
| **LAN** | `serve.mjs --host 0.0.0.0` (ve `run_e1_poc.ps1 -HostAddress 0.0.0.0`) hem sayfayı hem oda servisini tüm arayüzlere bağlıyor; ikinci cihaz VPS/TLS olmadan katılabiliyor. |
| **İnternet yolu** | `deploy/Caddyfile` + `deploy/nginx.conf` (TLS, `/ws` → 8811, gerisi → 8801), `tools/tls-proxy.mjs` (yerel TLS proxy), `tools/deploy_local.ps1` (tek komut), `tools/verify_proxy.ps1` (kendi kendini doğrulama). **Kanıt:** iki sayfa `https://localhost:8443/` + `wss://localhost:8443/ws` üzerinden yarışı bitirdi, `mp-two` **49/49**. Yalnız **VPS + domain + DNS + sertifika** girdileri eksik. |
| **Minimap** | `probes/e1-drive/web/minimap.js` — yalnız kurs noktalarından; 32/32 test. |
| **Güçlendirme** | **9 tip**: 8 retail + **SuperShield** (etiketli proje uzantısı; tek oyunculu PickupType, `POWERUP_DEFERRED` boş). `mp-powerups` **48/48** (River 54 retail pickup, SuperShield aktivasyonu 50 puan kapasite + HUD, guest aynı set, 0 konsol). Model testleri **112/112**. |

## Kullanıcıdan beklenen (tek engel)

İnternet üzerinden oyun için **yalnız altyapı girdileri** eksik; kod ve
doğrulama hazır (`docs/work/verification/internet-deploy.md`):

| Girdi | Örnek / not |
|---|---|
| **VPS** | 1 vCPU / 1 GB, Ubuntu 22.04+ (veya eşdeğeri) |
| **Domain** | örn. `play.example.com` |
| **DNS** | `play.example.com A <vps-ip>` |
| **Sertifika** | Caddy otomatik alır; nginx için `certbot --nginx -d play.example.com` |
| **Firewall** | yalnız TCP 443; 8801/8811 loopback'te kalır |

Bunlar gelince: `node probes/e1-drive/tools/serve.mjs --port 8801 --with-room
--room-port 8811 --host 127.0.0.1` + `caddy run --config deploy/Caddyfile`.

## Son commit'ler

```
e69ea82 chore(vehicle-batch): regenerate the spec for the 61-car roster
1b864e4 chore(powerups): re-derive the retail and physical placement against the current layouts
dbb4117 docs(handoff): record thirteen maps and the lightmap showcase
1254bdf feat(e1): make Dumbo and Downtown MP the twelfth and thirteenth playable maps
fb67ca4 feat(map-batch): prepare the Dumbo and Downtown MP aid-path packages
c6e4ee2 docs(handoff): record the lightmap showcase, 61 cars and the two new aid paths
32d8c34 fix(render): keep the scene ambient write inside its buffer and re-pin the River level chunk
```

## Devam ederken ilk komutlar

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

# 1. Kapıyı doğrula (gate-full17.log sonucuna bak)
& $py tools/verify_asset_probe.py --skip-build

# 2. Sunucuyu aç (tarayıcı testi için)
powershell -ExecutionPolicy Bypass -File tools/run_e1_poc.ps1

# 3. Tek harita doğrulaması
node probes/e1-drive/tools/verify_e1_map.mjs --map dumbo
node probes/e1-drive/tools/verify_e1_map.mjs --map downtown-mp

# 4. E2E (tek tek; toplu koşuda sunucu ölürse yeniden başlat)
node probes/e2e/run.mjs --scenarios solo-dumbo,solo-downtown-mp --base http://127.0.0.1:8801/ --room ws://127.0.0.1:8811/ws
```

## Sıradaki işler (öncelik sırası)

1. **Kapıyı doğrula** (`gate-full24.log`).
2. **Kalan 5 seviye — kapanmış tipli veri sınırı.** P48 geçiş kuralı
   (`min(0.05, 0.05*0.5) = 0.025 m`) retail hattın 0,077–0,176 m adımlarını
   reddediyor; kuralı 0,20 m'ye genişletmek **tüm ızgarayı** geçiriyor
   (2.747.539 hücre = %100), yani yol/arazi ayrımını yok ediyor. Son deneme:
   hackney retail hattı bant kontrolü olmadan layout'a çevrildi ve motor
   koşturuldu — 12.668 tick (211 s), **0 checkpoint**, `outside-corridor`.
   Ayrıntı: `docs/work/verification/raster-passability-limit.md`.
3. **Kalan 5 seviye — eski not (üstteki madde geçerli).** Retail `.aid` hattı
   collision geometrisi olmayan hücrelerden geçiyor (`base=false`, `wall=false`,
   bileşen 0): hackney `(-227.278106, -133.764788)`, brighton
   `(84.692995, -185.625677)`, sausalito `(709.746329, -1434.611018)`. Bu
   yüzden "en geniş halka" yöntemi kullanıldı (`build_raster_centreline.py`):
   - **sausalito**: 222,286 m halka, min yarıçap 5,75 m, %100 çizim → **entegre**.
   - **bowl**: 252,767 m halka, min yarıçap 6,75 m ama **%0 çizim** → görünmez.
   - **brighton**: 105,660 m halka, min yarıçap 5,48 m, **%0 çizim** → görünmez.
   - **hackney**: 348,835 m halka, min yarıçap 3,69 m < 3,79 m tam kilit dönüş
     yarıçapı → sürülemez.
   - **russianhill**: 9.582 hücreli bileşen hiçbir eşikte delik içermiyor →
     halka yok.
   Bunlar veri sınırı; uydurulmuş bir parkur eklenmedi.
3. **`.aid` hattı** ±24 m detour ve 1,68 m bantla bile araç bandına sığmıyor:
   - `uk_london_hackney`: 221 istasyon (ilk 2.890/10.012, (-227.278106, -133.764788)).
   - `uk_brighton`: ±24 m'de 24 istasyon (ilk 670/8.662, (84.516652, -185.448468)).
   - `usa_sanfran_sausalito`: 7.024 istasyon (ilk 4/18.196, (709.521209, -1434.502293)).
   - `usa_sanfran_russianhill`: en yakın hat 175,14 m; snap limiti 25 m.
   - `spa_barcelona_bowl_multiplayer`: `.aid` dosyası yok.
   `showroom` yarış haritası değil. Bunlar gerçek koridor genişliği sınırları;
   daha dar bir araç bandı (ör. gerçek araç genişliği) bir tasarım kararıdır,
   uydurma değil.
4. **`defaultcar`**: gövde modeli yok; tipli `unsupported` kalmalı.
5. **Retail pickup fiziksel yerleşimi.** `probes/powerups-aid`: Amboy 2/82,
   Gracia 2/59, River 0/54 (retail hat ölçülen parkurdan uzak). Kalanlar
   `off-course`; fiziksel iddia yok.
6. **İnternet deploy — yalnız girdiler eksik.** Yol yerelde doğrulandı
   (`docs/work/verification/internet-deploy.md`). Kullanıcıdan gerekenler:
   **host** (VPS, 1 vCPU/1 GB yeter), **domain** (`play.example.com`),
   **DNS A/AAAA kaydı**, **sertifika** (Caddy otomatik / nginx+certbot),
   **443 firewall**. Bunlar gelince iki komut: `serve.mjs --host 127.0.0.1`
   ve `caddy run --config deploy/Caddyfile`. Retail 1:1 parite için
   kullanıcıdan referans kareleri.

## Bu oturumda düzeltilen gerçek hatalar (tekrar etmemek için)

- `packet-consumer.js` sahne ambient yazımı 64 baytlık buffer'a 16 bayt
  yazıyordu (offset 52 + 16 = 68) → 4 baytlık yazıma çevrildi.
- River `mpPins.packageHash` 61 araçlı `level.geometry.json` ile yenilendi.
- `build_car_textures.py` / `build_geometry.mjs` `unsupported_uv` sınıfını
  tanımıyordu; eklendi.
- `build_manifest.py` iki yeni kararı içeriyor: `E_Brake_Caliper_*` ad
  varyantı ve `DefaultElement` altındaki tekerlek parçasının matris
  çevirisiyle köşe kanıtı.
- `build_e1_package.py` / `build_map_batch.mjs` dumbo + downtown-mp
  girdileri; `map_batch_lib.INTEGRATED`, `verify_batch`, `blocked_inventory`,
  `verify_blocked`, `verify_map_decisions` 13 haritaya güncellendi.

## Bilinen "stale pin" zinciri (üretici değişince)

`probes → map-batch → map-laps paths → E1 packages → map-registry.js →
blocked_inventory → build_map --all → build_map_decisions`. Ayrıca
`probes/powerups` (placement, arc-correspondence), `probes/textures`,
`probes/map-props`, `probes/car-materials`, `probes/ai-driver` kendi
üreticilerini pinler. Sıra: `docs/work/verification/refresh-work-artifacts.md`.
