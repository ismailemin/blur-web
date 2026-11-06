# Oturum kaydı — 7 Kasım 2026, ses + level-instance reader

**Başlangıç:** `8a0b5d1` (free-roam), ses modülü commit'li ama sayfada değil.
**Bitiş (bu kayıt):** ses entegre ve commit'li; level-instance UV0 reader
commit'li; prop texture render entegrasyonu (P73b) devam ediyor.

## Commit'ler

| Commit | İş |
|---|---|
| `ce52212` | `feat(e1): drive the engine audio from the simulation RPM` |
| `0f25fc6` | `feat(textures): scope the remaining prop albedo work` |
| `28f67a1` | `feat(asset-reader): export level-instance UV0 and albedo` |

## 1. P71 — motor sesi entegrasyonu

- `e1_engine_rpm()` native export; wasm A/B deterministik.
- Sayfa: ilk tuş/click'te AudioContext; kare başına `setRpm`; `M` mute;
  `?audio=0`; `pagehide` dispose.
- `verify_e1_drive` **826/826**; `--mode audio` **16/16**, console **0**;
  1500/3015/6000 RPM gain/rate farkı ≤6e-8; mute RMS 0, unmute 0,134.
- Kanıt: `docs/work/verification/T-007-audio.md`,
  `_work/e1-drive/browser-audio-running.png`.

## 2. P72a — prop doku fizibilitesi (varsayım düzeltmesi)

- Görünür yapısal prop'lar **zaten dokulu** (460 P66 / 423 P68 bileşen).
- 97 diagnostic track draw: 95 block88 (ekran 0), 2 runtime-only.
- Gerçek eksik **22 level-instance draw** (10.308 üçgen, 6 wreck + 2 truck);
  reader UV0/material yaymıyordu.
- Adaylar 49/49 doğrulandı. Kanıt: `docs/work/analysis/prop-textures.md`.

## 3. P73a — reader UV0 + albedo

- `scene_reader.cpp`: **22/22** UV0 (F16_2, usage5 @16), material/albedo zinciri.
- UV stream **26.324 float / 105.296 B**, hash `158a3ac8…`.
- **18 draw / 10.212 tri** BC1 bindable; **4 draw / 96 tri**
  `bc3-alpha-rule-missing`.
- Native MSVC `/W4` temiz, **CTest 15/15**, suite **31/31**, artifact
  **558/558**, iki build byte-identical.
- Kanıt: `docs/work/analysis/level-instance-textures.md`,
  `_work/asset-reader/level-instance-textures.json`.

## 4. Devam eden — P73b

18 BC1 draw'ı E1'de gerçek albedo + UV0 ile çizmek; 4 BC3 draw diagnostic
kalacak. `packet-consumer.js` per-draw texture yolu kullanılacak; before/after
screenshot, console 0, tam suite.

## Doğrulama komutları

```powershell
node probes/e1-drive/tools/verify_e1_drive.mjs
node probes/e1-drive/tools/capture_browser.mjs --mode audio
python tools/verify_asset_probe.py
python tools/check_e1_poc.py
ctest --test-dir _work/build/asset-reader-native -C Release --output-on-failure
```
