# NEXT — sıradaki görevler

**Güncelleme:** 8 Kasım 2026
**Plan:** [`docs/plan/FULL_GAME.md`](../plan/FULL_GAME.md) (yol haritası) ve
[`docs/plan/INTEGRATION_WAVES.md`](../plan/INTEGRATION_WAVES.md) (entegrasyon
dalgaları). Sıra bağlayıcıdır: bir dalga yeşil olmadan sonraki başlamaz.

## 0. Bu dalga (paralel, farklı dizinler)

| Ajan | Dizin | İş |
|---|---|---|
| V5 | `probes/e1-drive` | batch 2 → 25 araç, ghost, pin |
| PM1 | `probes/map-props` | Amboy/Gracia prop collider |
| LM1 | `probes/map-laps` | Amboy/Gracia kapalı tur |
| PARITY1 | `probes/retail-parity` | 1:1 denetim + retail çekim protokolü |
| NET1 | `probes/net-mvp` | WSS/TLS, 8 oyuncu, deploy |
| PWR6 | `probes/powerups` | Amboy/Gracia pickup yerleşimi |
| MAPC1 | `probes/map-pipeline` | bloklu harita kanıtı, 19 harita sıralaması |
| MAT1 | `probes/car-materials` | boya/ışık malzeme reçetesi |
| AUDIO1 | `probes/audio` | tam ses kataloğu |
| HUD1 | `probes/hud` | retail HUD verisi |
| SHELL1 | `probes/game-shell` | menü/lobi/seçim modülü |
| AI4 | `probes/ai-driver` | AI silah politikası |
| MODE1 | `probes/race-rules` | retail mod kataloğu |
| CAM1 | `probes/camera` | retail kamera parametreleri |
| DMG1 | `probes/damage` | hasar/wreck modeli |
| STREAM1 | `probes/map-stream` | harita sektör chunk'ları |
| MAPBATCH1 | `probes/map-batch` | 19 harita toplu derleyici |
| DECAL1 | `probes/instances` | instance + decal üreticisi |
| LIGHT1 | `probes/lighting` | ışık/gölge/normal |
| VFX1 | `probes/vfx` | partikül/efekt verisi |
| COMPAT1 | `probes/compat` | tarayıcı uyumluluk matrisi |
| PHYS1 | `probes/physics` | araç başına fizik zarfı |
| E2E1 | `probes/e2e` | uçtan uca tarayıcı testi |
| INPUT1 | `probes/input` | kontrol/gamepad katmanı |
| ENV1 | `probes/environment` | gökyüzü/uzak çevre |

## 1. Ana ajan — entegrasyon sırası

1. **Wave 0:** V5 biter → pinleri güncelle → tam kapı → 25 araç commit.
2. **Wave 1:** SHELL1 → `e1-drive` menü/harita/araç seçimi.
3. **Wave 2:** NET1 → 8 oyuncu, WSS, lobi.
4. **Wave 3:** PM1 → harita prop collider'ları.
5. **Wave 4:** PWR6 → tüm haritalarda power-up.
6. **Wave 5:** LM1 + MODE1 → tur ve modlar.
7. **Wave 6:** MAT1 + CAM1 + HUD1 + LIGHT1 → görsel parity.
8. **Wave 7:** DMG1 + AI4 + AUDIO1 → hasar, AI silahları, ses.
9. **Wave 8:** STREAM1 + MAPBATCH1 + DECAL1 + ENV1 → harita ölçeği.
10. **Wave 9:** araç batch derleyici → 61/62.

Her dalga sonunda: `verify_asset_probe --skip-build`, CTest, `check_e1_poc`,
`verify_e1_drive`, capture console 0, kanıt hash'leri, `CURRENT.md` güncellemesi.

## 2. Kullanıcıdan beklenenler (yalnız zorunlu)

- **Retail referans kareleri:** PARITY1'in tanımlayacağı 4 kamera pozu, Corvette
  ZR1 + River 0–100 m, HUD kapalı. 1:1 ölçümü bunsuz yapılamaz.
- **İnternet altyapısı:** erişilebilir host/VPS + domain/TLS (veya Cloudflare
  Tunnel). Kod ve deploy paketi hazır olacak; hesap/şifre paylaşımı gerekmiyor.

## 3. Bilinen sınırlar (değişmedi)

- 310 m hattında dört prop kümesi pass-through (tasarım gereği).
- Amboy/Gracia prop collision PM1 ile geliyor.
- Amboy/Gracia'da gerçek tur LM1'e bağlı; yoksa noktadan noktaya kalır.
- SuperShield retail MP'de yok; proje uzantısı, varsayılan kapalı.
- Retail shader/ışık/gölge parity henüz yok; LIGHT1/MAT1/DECAL1 veri üretiyor.
- WebGPU tarayıcı gereksinimi COMPAT1 ile netleşecek.
