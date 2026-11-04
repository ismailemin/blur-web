# T-008 — Tarayıcı PoC (kullanıcı testi)

**Durum:** in-progress (çoklu araç ve pist geometrisi agent'ları çalışıyor)
**Sahip:** ana ajan
**Başlangıç:** 5 Kasım 2026
**Hedef:** kullanıcının tarayıcıda açıp **tek haritada birden çok gerçek araçla**
sürüşü deneyebileceği PoC.

## PoC tanımı

- Tek URL (yerel sunucu), tek harita: **USA LA River**.
- **En az 4 gerçek araç** (`RP_CarDynamics` kayıtlarından), açılır listeden seçilir.
- WASD/ok tuşları: gaz, fren, direksiyon, el freni; `R` reset.
- Chase camera; HUD'da hız, tick, temas, state hash, packet hash.
- Sabit adım 1/60, 4 tick cap; render interpolasyonu.
- Console **0 mesaj**; deterministik scripted mod (`?script=drive`).
- Diagnostic materyaller kabul; “gerçek oyun görünümü” iddiası yok.

## Kabul kriterleri

- [ ] Sunucu tek komutla açılıyor; URL kullanıcıya veriliyor.
- [ ] Araç listesinde ≥4 gerçek araç; her biri seçilip sürülebiliyor.
- [ ] Her araçta settle + gaz/fren sürüşü çalışıyor; NaN yok, temas var.
- [ ] Her araç için ayrı deterministik state hash'i; iki koşu aynı.
- [ ] Headless Edge/WebGPU: ekran görüntüsü + console 0.
- [ ] Ana suite/CTest/engine verifier'ları regresyonsuz.
- [ ] Kullanıcı test adımları `docs/handoff/E1_POC.md` içinde.

## Alt görevler / agent eşlemesi

| İş | Agent | Durum |
|---|---|---|
| Gerçek araç fiziği | P19 | ✅ |
| Packet v1.1 + WebGPU tüketici | P20 | ✅ |
| Connector (WASD, chase camera, fixed step) | P21 | ✅ |
| Çoklu araç roster'ı | P23 | 🔄 |
| `levelrender` engine parse (draw list) | P22 | 🔄 |
| Stage B pist instance'ları | P25 | 🔄 |
| Teker/kompozit görsel | P26 | sırada |
| PoC paketleme + kullanıcı kılavuzu | ana ajan | sırada |

## Çalıştırma (mevcut tek araç)

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $node probes/render-packet/tools/build_packet.mjs
& $py   engine/verify_vehicle.py --skip-build
& $node probes/e1-drive/tools/build_module.mjs --force-objects
& $node probes/e1-drive/tools/build_geometry.mjs
& $node probes/e1-drive/tools/verify_e1_drive.mjs
& $node probes/e1-drive/tools/serve.mjs          # http://127.0.0.1:8801/
```

Çoklu araç geldiğinde bu komutlar `serve.mjs` + araç seçici olarak güncellenecek.

## Kapsam dışı

- Tam yarış kuralları, checkpoint/finish (E1f).
- Ses, menüler, save.
- Multiplayer (T-006).
- DX11 birebir görsel sadakat (E2).
