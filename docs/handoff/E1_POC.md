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
| `/` | Serbest sürüş + sprint kuralları (310 m parkur) |
| `/?script=drive` | Deterministik 300 tick sürüş |
| `/?script=sprint` | Deterministik sprint (5 araç) |
| `/?telemetry=1&car=<slug>` | 0–100, fren, yanal grip + grafikler |
| `/?survey=1` | 539,81 m River görsel koridoru (oynanabilir parkur **değil**) |

## Araçlar

Üstteki **CAR** listesi veya `?car=`:

| Araç | Slug | 310 m sprint |
|---|---|---:|
| Corvette ZR1 | `corvette-zr1-stock` | 14,65 s |
| Lotus Exige Cup260 | `lotus-exige-cup260-stock` | 14,77 s |
| Dodge Challenger | `dodge-challenger-stock` | 14,92 s |
| Ford Focus RS (FWD) | `ford-focusrs-stock` | 15,22 s |
| Audi R8 V10 (AWD) | `audi-r8v10-stock` | **14,15 s** |

29 m kısa parkur: `?course=short` (Corvette 2,800 s … Audi 2,283 s).

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

- Countdown → 2 checkpoint → finish (310 m parkur)
- Süre, checkpoint sayısı, araç başına en iyi süre (`localStorage`)
- Off-course → checkpoint’ten respawn; süre/checkpoint korunur
- Kamera prop’ların içine girmiyor (BVH occlusion)

## Beklenen

- Console’da **0 mesaj**
- WebGPU canvas; araç kendi gövdesi/tekerleriyle
- Gerçek pist draw'ları: 310 m parkur + prop'lar
- Sabit adım 1/60; deterministik hash’ler

## Bilinen sınırlar

- **Oynanabilir parkur 310 m** (collision-clean, %100 görsel kapsama);
  540 m draw koridoru `?survey=1` ile izlenir ama **parkur değil** (57,82 m'de
  50 m collision duvarı). 29 m kısa parkur `?course=short`.
- Kapalı tur yok (committed veriyle mümkün değil).
- Pist görseli gerçek River draw set'i; 394 draw'dan **297**'si gerçek albedo +
  UV0 ile dokulu, 95'i diagnostic. Araçlarda 491 draw'dan **224**'ü dokulu,
  267'si diagnostic. Mip/sRGB/anisotropy, boya, gölge ve post yok.
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
