# Oturum kaydı — 6 Kasım 2026, lap + free-roam verisi + ses modülü

**Başlangıç:** `39bd1b6` (free-roam ölçümü), P67 kırmızı ve commit edilmemiş.
**Bitiş (bu kayıt):** lap ve prop ölçümü commit'li; free-roam entegrasyonu ve
ses modülü sırada/commit'li.

## Commit'ler

| Commit | İş |
|---|---|
| `76b6028` | `feat(e1): add a three-lap race on loop-01` |
| `deb603c` | `feat(track): measure solid props on the free-roam basin` |
| `4ca5029` | `feat(audio): package the engine loops as a verified module` |

## 1. P67 lap — kırmızıdan yeşile

**Kök neden:** `LapRules` içindeki `previousSample.arc > length/2` koşulu.
Kapalı polilin ilk noktayı tekrarladığı için start/finish çizgisinin birkaç cm
öncesi arc ≈ 0'a projeksiyon yapıyordu; 5 araç da 1. turu sayıp 2./3. turu
kaçırıyordu (Audi kesişimleri: tick 1667, 3222, 4780, 6334; yalnız ilki kabul).

**Düzeltme:** yarım-tur koşulu kaldırıldı; tek ölçüt `lapDistance >= (lapIndex+1)*length - 2`.
Ayrıca biten yarışta `progress` 1'e sabitlendi (finish ekranı %99,99 okumasın).

**Sonuç:**

| Gate | Sonuç |
|---|---|
| `verify_e1_drive` | **766/766** |
| `verify_asset_probe --skip-build` | **30/30** |
| `check_e1_poc.py` | **21/21** |
| Browser capture | **20/20**, console **0**, 0 assertion |

5 araç: 85,47–86,28 s, 0 respawn, 3 sıralı kesişim, replay/restart birebir.

## 2. P68 — free-roam prop ölçümü

- Erişilebilir spawn bileşeni **7.702,25 m²**; spawn açıklığı **5,803 m**.
- Doğu kanalı **1.321,25 m²** C03 boru/çit duvarı yüzünden erişilemez.
- `_work/free-roam-prop/colliders-r04.json`: **431 collider**, kapsama %64,6 → %100.
- Head-on 0,001 m, glance %92,5, 0 tunneling; **25/25 + 29/29**, deterministik.
- Kanıt: `docs/work/analysis/free-roam-props.md`, `_work/free-roam-prop/map.png`.

## 3. P70 — motor sesi modülü

- `probes/audio/web/engine-audio.js`: 6 loop, retail RPM→gain/pitch PLF,
  gesture-only AudioContext, tipli hata durumları.
- Headless Edge **engine-audio-module-verified**, 6/6 decode, gain/rate farkı
  ≤5,9e-8, RMS 0,041–0,137, **console 0**.
- Kanıt: `docs/work/analysis/audio-engine-module.md`, `_work/audio/module-harness.png`.

## Devam eden

- **P69:** `?course=free` + 431 solid prop + containment; `probes/e1-drive/**`.
- Sonra: motor sesini E1'e bağlama, prop dokuları.

## Doğrulama komutları

```powershell
node probes/e1-drive/tools/verify_e1_drive.mjs
node probes/e1-drive/tools/capture_browser.mjs --mode lap
python tools/verify_asset_probe.py --skip-build
python tools/check_e1_poc.py
```
