# E1 PoC — tarayıcıda sürüş testi

**Tarih:** 5 Kasım 2026
**Ne:** wasm RacingPhysics + River collision mesh + gerçek araç/pist geometrisi +
WebGPU.
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
| `/` | Serbest sürüş + sprint kuralları (29 m parkur) |
| `/?script=drive` | Deterministik 300 tick sürüş |
| `/?script=sprint` | Deterministik sprint (5 araç) |
| `/?telemetry=1&car=<slug>` | 0–100, fren, yanal grip + grafikler |
| `/?survey=1` | 539,81 m River görsel koridoru (oynanabilir parkur **değil**) |

## Araçlar

Üstteki **CAR** listesi veya `?car=`:

| Araç | Slug | Sprint (29 m) |
|---|---|---:|
| Corvette ZR1 | `corvette-zr1-stock` | 2,800 s |
| Lotus Exige Cup260 | `lotus-exige-cup260-stock` | 2,850 s |
| Dodge Challenger | `dodge-challenger-stock` | 3,000 s |
| Ford Focus RS (FWD) | `ford-focusrs-stock` | 3,267 s |
| Audi R8 V10 (AWD) | `audi-r8v10-stock` | 2,283 s |

Telemetri 0–100 sırası: Audi 2,650 → Corvette 3,650 → Lotus 3,833 →
Dodge 4,633 → Focus 5,133 s.

## Kontroller

| Tuş | İş |
|---|---|
| `W` / `↑` | gaz |
| `S` / `↓` | fren |
| `A` / `D` / `←` / `→` | direksiyon |
| `Space` | el freni |
| `R` | yerinde restart (sayfa yenilemez) |
| Fare sürükle | kamera orbit |
| Tekerlek | zoom |

## Sprint

- Countdown → 2 checkpoint → finish (29 m düz parkur)
- Süre, checkpoint sayısı, araç başına en iyi süre (`localStorage`)
- Off-course → checkpoint’ten respawn; süre/checkpoint korunur
- Kamera prop’ların içine girmiyor (BVH occlusion)

## Beklenen

- Console’da **0 mesaj**
- WebGPU canvas; araç kendi gövdesi/tekerleriyle
- Gerçek pist draw’ları: 29 m sprint bölgesi + prop’lar
- Sabit adım 1/60; deterministik hash’ler

## Bilinen sınırlar

- **Oynanabilir parkur 29 m**; 540 m görsel koridor `?survey=1` ile izlenir ama
  **parkur değildir**: ölçülen çizgi 57,82 m’de 50 m’lik collision duvarından
  geçiyor; şasi 52,7–53,4 m’de duruyor. Uydurma çözüm yok.
- Kapalı tur yok (committed veriyle mümkün değil).
- Materyaller diagnostic; doku/boya/gölge/post yok.
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
- `docs/work/verification/T-007-per-car-meshes.md`
- `docs/work/verification/T-007-track-visual.md`
- `docs/work/verification/T-007-camera-collision.md`
- `docs/work/verification/T-007-telemetry.md`
- `docs/work/verification/T-007-reset-fix.md`
- `docs/work/verification/T-007-soak.md`
- `docs/work/verification/T-007-ledge-fix.md`
