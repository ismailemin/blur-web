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

Telemetri 0–100 sırası: Audi 2,650 → Corvette 3,650 → Lotus 3,833 →
Dodge 4,633 → Focus 5,133 s.

## Kontroller

| Tuş | İş |
|---|---|
| `W` / `↑` | gaz |
| `S` / `↓` | fren |
| `A` / `D` / `←` / `→` | direksiyon (varsayılan kullanıcı yönü; `I` ile ters) |
| `G` | ghost/rival replay aç/kapa |
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
- `docs/work/verification/T-007-lap-mode.md`
- `docs/work/verification/T-007-per-car-meshes.md`
- `docs/work/verification/T-007-track-visual.md`
- `docs/work/verification/T-007-camera-collision.md`
- `docs/work/verification/T-007-telemetry.md`
- `docs/work/verification/T-007-reset-fix.md`
- `docs/work/verification/T-007-soak.md`
- `docs/work/verification/T-007-ledge-fix.md`
