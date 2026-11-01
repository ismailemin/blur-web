# 0002 — Test ve kanıt stratejisi

**Tarih:** 1 Kasım 2026
**Durum:** kabul edildi

## Bağlam

Okuyucular gerçek oyun verisiyle çalışıyor; yanlış bir offset veya sessiz bir
fallback fark edilmeden "başarılı" görünebilir. Önceki çalışma, native/WASM ve
bağımsız Python karşılaştırmalarıyla bu riski azaltmıştı. Bu disiplin korunacak.

## Karar

Her değişiklik şu kapılardan geçer:

1. **Native derleme:** MSVC `/W4`, uyarısız.
2. **CTest:** `_work/build/asset-reader-native` altındaki 13 test.
3. **Suite:** `python tools/verify_asset_probe.py --skip-build` — baseline'da 25,
   T-001 sonrası 26, T-002 sonrası 27 kontrol.
4. **Native/WASM eşitliği:** ilgili `verify_*.mjs` dosyası.
5. **Bağımsız Python referansı:** fixture ve gerçek veri karşılaştırması.
6. **Determinizm:** aynı komut iki kez aynı hash/JSON üretir.
7. **Browser/GPU:** ekran görüntüsü + console'da error/warning yok.

Tam yeniden derleme gereken değişikliklerde `python tools/verify_asset_probe.py`
(26 kontrol) çalıştırılır.

## Kanıt saklama

- Makine çıktıları `_work/verification/`, `_work/logs/` ve ilgili `_work/*`
  dizinlerinde tutulur; bunlar Git dışındadır.
- Doküman, çıktının yolunu, komutu, tarihini ve varsa SHA-256'sını kaydeder.
- Bir fixture yalnızca `_work/` içinde varsa, onu yeniden üreten `tools/`
  komutu da dokümanda bulunmalıdır.
- Eski audit JSON'ları güncel kodun hash'ini taşımayabilir; en güncel suite
  sonucu esastır.

## Baseline sonucu

- Suite: 25/25 PASS (`_work/logs/baseline-suite.log`).
- CTest: 13/13 PASS (`_work/logs/baseline-ctest.log`).
- Ayrıntı: `docs/work/verification/baseline.md`.
