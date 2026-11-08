# T-009 — Tam oyun: arkadaşlarla test edilebilir multiplayer

**Durum:** in-progress (dalga 1)
**Sahip:** ana ajan (entegrasyon), 40 paralel veri/analiz ajanı (dalga 1)
**Plan:** [`docs/plan/FULL_GAME.md`](../../plan/FULL_GAME.md),
[`docs/plan/INTEGRATION_WAVES.md`](../../plan/INTEGRATION_WAVES.md)
**Kabul listesi:** [`docs/work/verification/mp-release-checklist.md`](../verification/mp-release-checklist.md)
**Oturum kaydı:** [`docs/work/logs/2026-11-08-full-game-wave1.md`](../logs/2026-11-08-full-game-wave1.md)

## Amaç

PoC'den çıkıp, farklı makinelerdeki tarayıcıların aynı odada yarışabildiği bir
sürüm: menü, araç/harita seçimi, 8 oyuncu, güçlendirmeler, hasar, tur, HUD,
ses. Tüm arabalar (62), tüm haritalar (19) ve tüm özellikler kapsanır; decode
edilemeyen her öğe tipli `unsupported` olarak raporlanır.

## Kapsam

- **Araçlar:** 25 araç (V5) → 61/62 (VBATCH1) → kalan 1 tipli.
- **Haritalar:** River/Amboy/Gracia oynanabilir; Longbeach paket; kalan 13 için
  MAPBATCH1 + MAPC1 kararı; bloklu olanlar byte kanıtıyla raporlanır.
- **Özellikler:** 8 MP power-up + SuperShield uzantısı, hasar/wreck/respawn,
  modlar, AI silah kullanımı, HUD, ses, kamera, VFX, UI art, yerelleştirme.
- **Ağ:** 8 oyuncu, WSS/TLS, deploy paketi, reconnect.
- **Görsel parity:** Corvette ZR1 + River 0–100 m, 4 sabit kamera, retail
  referans kareleriyle karşılaştırma.
- **Dağıtım:** paketlenmiş sürüm, bütünlük kontrolü, tarayıcı uyumluluk matrisi.

## Kapsam dışı

- Retail ikili kod iddiası; retail shader/parity tam eşleşme iddiası.
- Hesap sistemi, maç eşleştirme servisi, anti-cheat servisi.
- Oyun verisinin repoya commit edilmesi.

## Kabul kapıları

1. `docs/work/verification/mp-release-checklist.md` A–G maddelerinin tamamı
   kanıtla işaretli.
2. `verify_asset_probe --skip-build`, CTest, `check_e1_poc`, `verify_e1_drive`
   yeşil; E2E senaryoları console 0.
3. 2 insan + 2 AI, en az 3 haritada, paylaşılan sonuçla bitiyor.
4. Görünür yapıların içinden geçme yok (River 310 m dahil).
5. Paketlenmiş sürüm temiz klasörden çalışıyor; hash doğrulaması geçiyor.
6. Her kanıt: komut, çıktı, hash, ekran görüntüsü.

## Dalga 1 ajanları (dizin sahipliği)

| Ajan | Dizin | Çıktı |
|---|---|---|
| V5 | `probes/e1-drive` | 25 araç |
| PM1 | `probes/map-props` | harita prop collider |
| LM1 | `probes/map-laps` | kapalı tur |
| PARITY1 | `probes/retail-parity` | 1:1 denetim + çekim protokolü |
| NET1 | `probes/net-mvp` | WSS/TLS, 8 oyuncu, deploy |
| PWR6 | `probes/powerups` | tüm haritalarda pickup |
| MAPC1 | `probes/map-pipeline` | bloklu harita kanıtı |
| MAT1 | `probes/car-materials` | boya/ışık reçetesi |
| AUDIO1 | `probes/audio` | ses kataloğu |
| HUD1 | `probes/hud` | retail HUD |
| SHELL1 | `probes/game-shell` | menü/lobi modülü |
| AI4 | `probes/ai-driver` | AI silah politikası |
| MODE1 | `probes/race-rules` | mod kataloğu |
| CAM1 | `probes/camera` | kamera parametreleri |
| DMG1 | `probes/damage` | hasar modeli |
| STREAM1 | `probes/map-stream` | sektör chunk'ları |
| MAPBATCH1 | `probes/map-batch` | 19 harita derleyici |
| DECAL1 | `probes/instances` | instance/decal |
| LIGHT1 | `probes/lighting` | ışık/gölge/normal |
| VFX1 | `probes/vfx` | partiküller |
| COMPAT1 | `probes/compat` | tarayıcı matrisi |
| PHYS1 | `probes/physics` | araç zarfı |
| E2E1 | `probes/e2e` | uçtan uca test |
| INPUT1 | `probes/input` | gamepad/kontrol |
| ENV1 | `probes/environment` | gökyüzü/uzak çevre |
| TEX1 | `probes/textures` | doku kapsamı |
| PACK1 | `probes/pack` | dağıtım paketi |
| ART1 | `probes/art` | pickup modelleri |
| VBATCH1 | `probes/vehicle-batch` | araç derleyici |
| RIVP1 | `probes/river-path` | 310 m koridor denetimi |
| COURSE1 | `probes/course` | retail parkur verisi |
| PERF1 | `probes/perf` | performans bütçesi |
| SAVE1 | `probes/profile` | ayar/kayıt deposu |
| ROBUST1 | `probes/robustness` | bozuk girdi testleri |
| UIART1 | `probes/ui-art` | menü sanatı/font |
| WHEEL1 | `probes/wheels` | teker köşe kanıtı |
| MAPMAT1 | `probes/map-materials` | harita materyalleri |
| CAREER1 | `probes/career` | kariyer verisi |
| REPLAY1 | `probes/replay` | yarış tekrarı |
| CARCOL1 | `probes/car-collision` | araba-araba çarpışma |
| NET2 | `probes/net-webrtc` | WebRTC transport |
| AI5 | `probes/ai-driver` | yarış çizgisi/hız profili |
| SPLIT1 | `probes/split-screen` | split-screen tasarımı |
| DVIS1 | `probes/damage-visuals` | hasar görselleri |
| COCKPIT1 | `probes/cockpit` | kokpit görünümü |
| LAMP1 | `probes/lights` | araç ışıkları/emissive |
| MINIMAP1 | `probes/minimap` | minimap geometrisi |
| STAND1 | `probes/standings` | canlı sıralama |
| SUSP1 | `probes/suspension` | süspansiyon/teker görseli |
| LIVERY1 | `probes/liveries` | boya/livery presetleri |

## Durum

- Dalga 1 çalışıyor; hiçbir ajan commit etmiyor.
- Wave 0 (25 araç) ana ajanda; ardından Wave 1 (oyun kabuğu).
- Kırmızı: `prop-collision-v2` pin, `check_e1_poc` 15→25 araç pinleri.
