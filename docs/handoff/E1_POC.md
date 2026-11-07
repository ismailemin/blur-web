# E1 PoC — tarayıcıda sürüş testi

**Tarih:** 6 Kasım 2026
**Ne:** wasm RacingPhysics + River collision mesh + gerçek araç/pist geometrisi +
WebGPU. Sprint + **3 turluk kapalı tur** + ghost.
**Değil:** tam oyun değil. Ses, menü, rakip/AI, multiplayer ve orijinal
materyaller yok.

## Başlatma

```powershell
cd "C:\Users\ismailemin\Documents\Blur Web"
powershell -ExecutionPolicy Bypass -File tools\run_e1_poc.ps1
```

Aç: **http://127.0.0.1:8801/**

Alternatif: `node probes\e1-drive\tools\serve.mjs --port 8801`

Gereksinim: güncel Chrome/Brave + WebGPU (`chrome://gpu`).

## Modlar

| URL | Ne |
|---|---|
| `/` | Serbest sürüş + sprint kuralları (310 m parkur) |
| `/?course=lap` | **3 turluk kapalı tur** (P61 loop-01, 222,04 m) |
| `/?course=free` | **Free-roam** (P65/P68 spawn havzası 7.702 m², truck/bina solid) |
| `/?mp=1&host=1` | **M1 online race host** — oda kodu, lobby, 310 m |
| `/?mp=1&room=CODE` | M1 guest — oda koduna katıl |
| `/?mp=1&host=1&powerups=1` | **M2**: Mine/Shield/Repair/Nitro/Shock, `E` ile kullan |
| `/?map=amboy&script=sprint` | **usa_amboy** haritası (2.060,6 m, 1.201 dokulu draw) |
| `/?map=gracia&script=sprint` | **spa_barcelona_gracia** (624,9 m, 2.627 dokulu draw) |
| `/?script=drive` | Deterministik 300 tick sürüş |
| `/?script=sprint` | Deterministik sprint (5 araç) |
| `/?script=sprint&course=lap` | Deterministik 3 tur (5 araç) |
| `/?telemetry=1&car=<slug>` | 0–100, fren, yanal grip + grafikler |
| `/?survey=1` | 539,81 m River görsel koridoru (oynanabilir parkur **değil**) |
| `/?ghost=1` | hayalet/rival replay açık başlar (sprint parkurları) |

## Araçlar

Üstteki **CAR** listesi veya `?car=`:

| Araç | Slug | 310 m sprint |
|---|---|---:|
| Corvette ZR1 | `corvette-zr1-stock` | 14,65 s |
| Lotus Exige Cup260 | `lotus-exige-cup260-stock` | 14,77 s |
| Dodge Challenger | `dodge-challenger-stock` | 14,92 s |
| Ford Focus RS (FWD) | `ford-focusrs-stock` | 15,22 s |
| Audi R8 V10 (AWD) | `audi-r8v10-stock` | **14,15 s** |

**15 araç** (V2 batch 1): yukarıdakiler + `audi-tt-stock`, `audi-s3-stock`,
`ford-f100-offroad`, `ford-fr100-stock`, `volkswagen-golfw12650-stock`,
`ford-mustanggtr-stock`, `dodge-viperacr-stock`, `ford-bronco-offroad`,
`nissan-skyliner34ztune-stock`, `chevrolet-socalhhr-stock` (14,10–15,48 s).

29 m kısa parkur: `?course=short` (Corvette 2,800 s … Audi 2,283 s).

**3 tur (loop-01, 222,04 m)** — `?course=lap`:

| Araç | Tur 1 | Tur 2 | Tur 3 | Toplam |
|---|---:|---:|---:|---:|
| Corvette ZR1 | 29,00 | 28,55 | 28,55 | 86,10 s |
| Lotus Exige Cup260 | 29,12 | 28,58 | 28,58 | 86,28 s |
| Dodge Challenger | 29,05 | 28,55 | 28,52 | 86,12 s |
| Ford Focus RS (FWD) | 29,17 | 28,53 | 28,55 | 86,25 s |
| Audi R8 V10 (AWD) | 28,65 | 28,40 | 28,42 | **85,47 s** |

Tur modu loop-01 üzerinde **ayrı spawn** kullanır (eski spawn bileşeninden
1,118 m duvarla ayrık). Görünür truck/bina prop'ları tur modunda **solid**
(`all-visible`, 468 collider); loop-01 temiz olduğu için çarpışma yok.

**Free-roam** — `?course=free`:

- Spawn `(-88, 1050)`, **7.702 m²** açık havza; checkpoint/finish/countdown yok.
- **431 solid collider** (`colliders-r04.json`): truck, wreck, bina ve çitler
  geçilmez; spawn açıklığı 5,803 m.
- `R` spawn'a döner; havza kutusu dışına çıkınca veya zeminden 1 m düşünce
  otomatik spawn reset. Görünmez duvar yok.
- Doğu kanalı (1.321 m²) C03 boru/çit duvarı yüzünden **erişilemez**; oraya
  spawn/respawn yok.

## M1 online race (iki tarayıcı)

Sunucu `tools/run_e1_poc.ps1` ile açıldığında oda servisi de **8811**'de başlar.

1. Host: **http://127.0.0.1:8801/?mp=1&host=1** → oda kodu oluşur (ör. `KRP3Q`).
2. Guest: **http://127.0.0.1:8801/?mp=1&room=KRP3Q** → aynı odaya katılır.
3. İkisi de **READY**, host **START**.
4. 310 m River yarışı; diğer araç `REMOTE · 20 HZ SNAPSHOT · NO COLLISION`
   etiketiyle görünür.
5. Finish: iki sayfada da aynı **RACE RESULT** tablosu (host otoritesi).

Sınırlar: aynı araç (M1), tek harita (River 310 m), WebSocket loopback/LAN;
WebRTC/TURN/NAT, power-up, AI rakip ve host migration M2/M3'te. Aynı ağda iki
makine için 8811 portu açık olmalı.

### Aynı ağda iki makine

Host makinede:

```powershell
ipconfig | Select-String 'IPv4'        # ör. 192.168.1.20
# Yönetici PowerShell'de bir kez:
New-NetFirewallRule -DisplayName "Blur Web MP" -Direction Inbound -Protocol TCP -LocalPort 8801,8811 -Action Allow
```

Guest makinede:

```text
http://192.168.1.20:8801/?mp=1&room=<CODE>
```

Sayfa `ws://<sayfa-host>:8811/ws` adresine bağlanır; HTTPS'e geçilirse oda
servisi `wss://` arkasına alınmalı. Farklı ağlar (NAT/TURN) henüz kapsam dışı.

### M2 power-up dilimi

Host URL'sine `&powerups=1` ekle (guest de aynı odaya katılır):

```text
http://127.0.0.1:8801/?mp=1&host=1&powerups=1
```

- Pickup'a yaklaş → tek slot dolar (Mine / Shield / Repair / Nitro / Shock).
- **E** ile kullan: mine arkaya bırakılır, shield aktifleşir, repair can basar,
  Nitro hızlandırır, Shock hedefi yavaşlatır.
- HUD: health 100, shield, olay akışı; mine/shield/pickup diagnostic marker.
- Wreck olursa R1 son checkpoint'ten respawn.
- `provisional` etiketi: pickup yerleşimi geçici ölçülmüş arc; gerçek 54 nokta
  PWR3'te çıkarıldı, entegrasyonu sonraki adım.
- Shunt/Bolt/Barge ve projectile'lar bu dilimde **yok** (retail flip/tip,
  hedefleme ve hit-test verisi kanıtlanana kadar ertelendi).

### Amboy / Gracia haritaları

```text
http://127.0.0.1:8801/?map=amboy&script=sprint
http://127.0.0.1:8801/?map=gracia&script=sprint
```

- Amboy: gerçek physics + **1.201 dokulu draw / 269.300 tri / 179 doku**;
  ölçülmüş **2.060,595 m**; Corvette **222,05 s**
- Gracia: **2.627 draw / 365.451 tri / 734 doku**; **624,914 m**;
  Corvette **66,27 s**
- River varsayılan kalır; `?map=` MP/telemetry/soak/survey ile birleşmez
- Atlananlar etiketli: Amboy 334 decal + 71 diagnostic; Gracia 518 + 435;
  27/4 section, 366/2.714 instance; vertex normal yok (derivative normal)

Telemetri 0–100 sırası: Audi 2,650 → Corvette 3,650 → Lotus 3,833 →
Dodge 4,633 → Focus 5,133 s.

## Kontroller

| Tuş | İş |
|---|---|
| `W` / `↑` | gaz |
| `S` / `↓` | fren |
| `A` / `D` / `←` / `→` | direksiyon (varsayılan kullanıcı yönü; `I` ile ters) |
| `G` | ghost/rival replay aç/kapa |
| `M` | motor sesini aç/kapa (ilk tuş/click sesi başlatır) |
| `I` | direksiyon yönünü çevir (kalıcı değil, o sayfa oturumu) |
| `Space` | el freni |
| `R` | yerinde restart (sayfa yenilemez) |
| Fare sürükle | kamera orbit |
| Tekerlek | zoom |

Direksiyon varsayılanı kullanıcı testine göre ayarlandı (`D`/`→` sağa).
Ham eşleme için `?invertSteer=0`; sayfa içinde `I` ile anlık geçiş.
Scripted sprint controller bu eşlemeden geçmez.

## Sprint ve tur

- Sprint: countdown → 2 checkpoint → finish (310 m parkur)
- Tur: countdown → start/finish çizgisi 3 kez → finish (loop-01 222,04 m)
- Süre, checkpoint/tur sayısı, araç başına en iyi süre (`localStorage`)
- Off-course → son checkpoint/tur çizgisinden respawn; süre korunur
- Kamera prop’ların içine girmiyor (BVH occlusion)

## Beklenen

- Console’da **0 mesaj**
- WebGPU canvas; araç kendi gövdesi/tekerleriyle
- İlk tuş/click sonrası motor sesi RPM ile; `M` mute
- Gerçek pist draw'ları: 310 m parkur + prop'lar
- Sabit adım 1/60; deterministik hash’ler

## Bilinen sınırlar

- **Oynanabilir sprint 310 m** (collision-clean, %100 görsel kapsama);
  540 m draw koridoru `?survey=1` ile izlenir ama **parkur değil** (57,82 m'de
  50 m collision duvarı). 29 m kısa parkur `?course=short`.
- **Tur modu** loop-01 (222,04 m) üzerinde ayrı spawn ister; eski spawn
  bileşeninden 1,118 m duvarla ayrık. Tur merkez hattı %100 çizili; iç kenar
  bandında 21 örnek (~21/6307) eksik, sürüş hattı içinde.
- Tur modunda ghost yok (tur arc'ı her tur sıfırlanır; committed lap referansı
  yok), `G` nedenini yazar.
- Pist görseli gerçek River draw set'i; 394 draw'dan **297**'si gerçek albedo +
  UV0 ile dokulu. **18 level-instance draw (10.212 tri)** — truck/wreck — gerçek
  albedo + UV0 ile çiziliyor; 4 BC3 cab draw diagnostic. Araçlarda 491 draw'dan
  **224**'ü dokulu. Mip/sRGB/anisotropy, boya, gölge ve post yok.
- Teker konumu rest-pose; süspansiyon/steer/camber yok.
- Box gravity proxy; XT `physicsParameters` açık.
- Ses, rakip, multiplayer yok.

## Sorun giderme

| Belirti | Kontrol |
|---|---|
| `artifacts are missing` | `tools/run_e1_poc.ps1` çıktısındaki build komutları |
| WebGPU yok | Chrome güncel mi, donanım hızlandırma açık mı? |
| Araç görünmüyor | `?script=drive` dene; console’a bak |
| 404 | Sunucu 8801’de mi? `_work/e1-drive/` mevcut mu? |

## Kanıt

- `_work/e1-drive/browser-<car>-{start,mid,coast,end}.png`
- `_work/e1-drive/browser-<car>-sprint-*.png`
- `_work/e1-drive/browser-evidence*.json`
- `docs/work/verification/T-007-sprint-rules.md`
- `docs/work/verification/T-007-lap-mode.md`
- `docs/work/verification/T-007-per-car-meshes.md`
- `docs/work/verification/T-007-track-visual.md`
- `docs/work/verification/T-007-camera-collision.md`
- `docs/work/verification/T-007-telemetry.md`
- `docs/work/verification/T-007-reset-fix.md`
- `docs/work/verification/T-007-soak.md`
- `docs/work/verification/T-007-ledge-fix.md`
