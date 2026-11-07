# T-008 — Tarayıcı PoC (kullanıcı testi)

**Durum:** in-progress (çoklu araç ✅, pist 56 instance ✅; paketleme/kılavuz sırada)
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

- [x] Araç listesinde ≥4 gerçek araç; her biri seçilip sürülebiliyor (5 araç).
- [x] Her araçta settle + gaz/fren sürüşü çalışıyor; NaN yok, temas var.
- [x] Her araç için ayrı deterministik state hash'i; iki koşu aynı.
- [x] Headless Edge/WebGPU: 20 capture, console 0.
- [x] Tek URL/paketleme + kullanıcı kılavuzu (`docs/handoff/E1_POC.md`
  ve `tools/run_e1_poc.ps1`; `http://127.0.0.1:8801/`).
- [x] Ana suite/CTest/engine verifier'ları regresyonsuz.

## Alt görevler / agent eşlemesi

| İş | Agent | Durum |
|---|---|---|
| Gerçek araç fiziği | P19 | ✅ |
| Packet v1.1 + WebGPU tüketici | P20 | ✅ |
| Connector (WASD, chase camera, fixed step) | P21 | ✅ |
| Çoklu araç roster'ı | P23 | ✅ |
| `levelrender` engine parse | P22 | ✅ |
| Gerçek yol görseli | P31 | ✅ (144 draw / 19.167 tri) |
| Chase camera occlusion | P36 | ✅ (BVH; 268/268) |
| Sprint + checkpoint + finish | P37 | ✅ (348/348) |
| Dinamik telemetrisi | P39 | ✅ (423/423) |
| Reset/restart düzeltmesi | P40 | ✅ (10+ rebuild) |
| Uzun pist koridoru | P41 | ✅ (539,81 m ölçüm) |
| 540 m sprint | P43/P46 | ⚠️ parkur değil; 29 m oynanabilir, 540 m `?survey=1` |
| **310 m oynanabilir sprint** | P50 | ✅ varsayılan; 5 araç 14,15–15,22 s |
| Gerçek sürülebilir yol | P48 | ✅ 310,395 m (entegrasyon sırada) |
| 310 m görsel kapsama | P51 | ✅ %100 (g56-n289, 8 draw) |
| Araç materyalleri | P52 | ✅ 224/491 statik (40 doku) |
| Araç dokuları entegre | P55 | ✅ 224/491, 570/570 |
| Araç UV yönü | P59 | ✅ `(1-u,v)`, plakalar düz |
| Paint/light static refs | P60 | ✅ 424 alan, 24/29 doku |
| Engine packet export | P54 | ✅ 451 draw (8 schema gap) |
| Kapalı tur araması | P61 | ✅ loop-01 222,0 m (engine trace PASS) |
| Ses fizibilitesi | P62 | ✅ 6 motor loop'u + RPM eğrileri |
| Ghost/rival replay | P63 | ✅ 678/678, upload 0 |
| Prop collision verisi | P66 | ✅ 468 collider, 52/52 resolver |
| Free-roam alanı | P65 | ✅ R04 9.689,5 m², %100 çizili |
| 3 turluk kapalı tur | P67 | ✅ loop-01 86,1 s, 766/766 |
| PoC kontrolü (lap) | P67 | ✅ 23/23 |
| Free-roam prop manifesti | P68b | ✅ 431 collider, %100 kapsama |
| Free-roam modu | P69 | ✅ 818/818, 20/20 capture |
| Motor sesi modülü | P70 | ✅ 6 loop, 0 console |
| Motor sesi entegrasyonu | P71 | ✅ 826/826, 16/16 audio capture |
| Prop dokuları fizibilitesi | P72a | ✅ 18 draw reader ile açılabilir |
| Level-instance UV0 reader | P73a | ✅ 22/22 UV0, 18 BC1 bindable |
| Prop texture render | P73b | ✅ 18 draw/10.212 tri, 838/838 |
| Görünür yapı collision V2 | P74 | ✅ 651/447 collider, 45/45 |
| Doku kalitesi (sRGB+mip) | P75 | ✅ 838/838, %91–99 değişim |
| 62 araç denetimi | V1 | ✅ 5 A / 42 B / 15 C, 542/542 |
| Yarış mantığı/AI denetimi | G1 | ✅ 481 dosya, M1 5 modül |
| 19 harita denetimi | M1 | ✅ 1 A / 16 B / 2 C, 193/193 |
| Power-up tanımları | PWR1 | ✅ 11 tip / 8 MP, 1783/1783 |
| Yarış kural katmanı | R1 | ✅ 67/67, 2/3/4 oyuncu |
| PoC hazırlık kontrolü | P57 | ✅ 19/19 |
| Engine track sections | P44 | ✅ (299 draw / 47.790 tri) |
| UV0 + doku binding | P45 | ✅ (299/299) |
| Track dokuları | P47 | ✅ (297/297 statik) |
| Dokulu pist | P49 | ✅ (297/394 draw) |
| Soak/performans | P42 | ✅ (18.000 tick) |
| Engine CPU draw list | P27 + P30 + P32 | ✅ 56 instance; PoC'ye bağlama sırada |
| Stage B pist instance'ları | P25 | ✅ |
| Araç başına gerçek gövde | P29 | ✅ |
| Teker/kompozit görsel | P26 + P28 | ✅ (entegre) |
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
