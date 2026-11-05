# E1 PoC — tarayıcıda sürüş testi

**Tarih:** 5 Kasım 2026
**Ne:** wasm RacingPhysics + River collision mesh + WebGPU render.
**Değil:** tam oyun değil. Yarış kuralları, ses, menü, teker çizimi ve orijinal
materyaller yok.

## Başlatma

```powershell
cd "C:\Users\ismailemin\Documents\Blur Web"
powershell -ExecutionPolicy Bypass -File tools\run_e1_poc.ps1
```

Aç: **http://127.0.0.1:8801/**

Alternatif (doğrudan):

```powershell
node probes\e1-drive\tools\serve.mjs --port 8801
```

Durdurmak için `Ctrl+C`.

Gereksinim: güncel Chrome/Brave + WebGPU (`chrome://gpu`).

## Araçlar

Üstteki **CAR** listesinden seçilir. URL ile de seçilebilir:
`http://127.0.0.1:8801/?car=audi-r8v10-stock`

| Araç | Slug | Beklenen mesafe / tepe hız |
|---|---|---:|
| Corvette ZR1 | `corvette-zr1-stock` | 45,378 m / 15,44 m/s |
| Lotus Exige Cup260 | `lotus-exige-cup260-stock` | 40,641 m / 15,08 m/s |
| Dodge Challenger | `dodge-challenger-stock` | 41,041 m / 13,85 m/s |
| Ford Focus RS (FWD) | `ford-focusrs-stock` | 30,664 m / 12,36 m/s |
| Audi R8 V10 (AWD) | `audi-r8v10-stock` | 69,447 m / 21,54 m/s |

## Kontroller

| Tuş | İş |
|---|---|
| `W` / `↑` | gaz |
| `S` / `↓` | fren |
| `A` / `D` / `←` / `→` | direksiyon |
| `Space` | el freni |
| `R` | reset (yeni settle) |
| Fare sürükle | kamera orbit |
| Tekerlek | zoom |

## Deterministik scripted mod

Aynı girdi dizisiyle (120 gaz / 120 coast / 60 fren) tekrar üretilebilir:

```text
http://127.0.0.1:8801/?script=drive
http://127.0.0.1:8801/?script=drive&car=audi-r8v10-stock
```

HUD'da araç, tick, hız, temas, packet/tick hash ve state hash görünür. Node
doğrulayıcısıyla aynı hash'i vermelidir.

## Beklenen

- Console'da **0 mesaj** (error/warning/log yok).
- WebGPU canvas; araç + diagnostic pist yüzeyi.
- 60 Hz hedef; sabit adım 1/60.
- Her araç için ayrı state hash'i; iki koşu aynı.

## Bilinen sınırlar (beklenen)

- **Her araç kendi `.model` gövdesi ve tekerleriyle çiziliyor** (5 ayrı mesh).
- Tekerler fizik açısıyla dönüyor; kaliper sabit. Teker **konumu** rest-pose
  (süspansiyon/steer/camber yok). Simetrik teker draw'larının bir kısmı AABB ile
  köşeye atanamıyor; `unclassified` olarak çiziliyor, isim uydurulmuyor.
- Materyaller diagnostic; doku/boya/gölge/post yok.
- Pist yüzeyi collision geometrisi; gerçek yol draw set’i değil.
- Box gravity proxy, nötr yüzey skalarları, XT `physicsParameters` açık.
- Yarış kuralları/checkpoint/finish, ses, multiplayer yok.

## Sorun giderme

| Belirti | Kontrol |
|---|---|
| `artifacts are missing` | `tools/run_e1_poc.ps1` çıktısındaki build komutlarını çalıştır |
| WebGPU yok | Chrome güncel mi, donanım hızlandırma açık mı? |
| Araç görünmüyor | `?script=drive` ile dene; console'a bak |
| 404 | Sunucu 8801'de mi? `_work/e1-drive/` mevcut mu? |

## Kanıt

- `_work/e1-drive/browser-<car>-{start,mid,coast,end}.png`
- `_work/e1-drive/browser-evidence.json`
- `docs/work/verification/T-007-e1-drive.md`
- `docs/work/verification/T-007-multi-car.md`
- `docs/work/verification/T-003-stageB.md`
