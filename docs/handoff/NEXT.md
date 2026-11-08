# NEXT — sıradaki görevler

**Güncelleme:** 8 Kasım 2026 (akşam)
**Plan:** [`docs/plan/FULL_GAME.md`](../plan/FULL_GAME.md) (yol haritası) ve
[`docs/plan/INTEGRATION_WAVES.md`](../plan/INTEGRATION_WAVES.md) (entegrasyon
dalgaları). Sıra bağlayıcıdır: bir dalga yeşil olmadan sonraki başlamaz.
**Bu oturumun kaydı:** [`docs/work/logs/2026-11-08-mp-eight.md`](../work/logs/2026-11-08-mp-eight.md)

## 0. Tamamlanan (bu dalga)

- **SHELL1 → `e1-drive`:** boş URL menüyü açar; yarış parametreleri menüyü
  atlar; `?join=1` misafir akışı. `70374f6`.
- **NET1 → 8 oyuncu:** oda servisi 8 oyuncu + WSS deploy (`2aa9de1`); istemci
  `MP_MAX_PLAYERS=8`, 7 eş snapshot'ı, tüm eşler için uzak araç (`13cf0b1`);
  **8 oyunculu yarış bitişe kadar** (`f6b1818`).
- **Wave-1 probe verisi:** 19 analiz dokümanı (`50afc31`), tüm probe dizinleri
  (`fadabdd`).
- **V5:** 25 araç (`4157c87`).
- **Kırmızı doğrulayıcılar yeşil:** race-rules 249/249, map-pipeline 930/930,
  instances 510/510, net-prediction 357/357, robustness 171/171.
- **Entegrasyon:** Amboy 3 tur (`578d652`), Amboy/Gracia prop collider
  (`1c9c46e`), Amboy/Gracia power-up + oda bayrağı (`7341690`).
- **Dalga 3:** pickup rotası (1610/1610), Gracia no-lap kararı (83/83), ışık
  (973/973), araç materyali (3505/3505), HUD (12 test) ve 19 harita kararı
  (2466/2466); HUD `?hud=retail` ile bağlı (`cd9f33b`).

## 1. Sıradaki işler (paralel, farklı dizinler)

| # | Ajan | Dizin | İş | Kapı |
|---|---|---|---|---|
| 1 | PATH1 | `probes/map-laps` | Long Beach sürülebilir polyline (arc 226.8 m duvarı) | E2E finish |
| 2 | PWR8 | `probes/powerups` | `pickup-routes.json`'ı oyuna bağla: pickup'ları rota yayına göre yerleştir | E2E + `verify_pickup_routes` |
| 3 | LIGHT2 | `probes/lighting` | `runtime-lighting.mjs`'i render'a bağla | görsel + hash |
| 4 | MAT2 | `probes/car-materials` | `runtime-materials.mjs`'i render'a bağla | görsel + hash |
| 5 | MAPBATCH2 | `probes/map-batch` | `map-decisions.json`'daki oynanabilir haritaları `e1-drive`'a ekle | E2E |
| 6 | HUD2 | `probes/hud-ui` | HUD'ı varsayılan yap (debug HUD yerine) | E2E + ekran |
| 7 | VBATCH2 | `probes/vehicle-batch` | 25 → 61/62 araç | `verify_batch3` |

## 2. Ana ajan — entegrasyon sırası

1. Retail pickup rotası → gerçek yerleşim.
2. Işık + araç materyali → render.
3. HUD'ı varsayılan yap.
4. Kalan haritalar (map-decisions).
5. Araç batch derleyici → 61/62.

Her dalga sonunda: `verify_asset_probe --skip-build`, `check_e1_poc`,
`node probes/e2e/run.mjs --scenarios …`, konsol 0, kanıt hash'leri,
`CURRENT.md` güncellemesi.

## 3. Kullanıcıdan beklenenler (yalnız zorunlu)

- **Retail referans kareleri:** PARITY1'in tanımladığı 4 kamera pozu, Corvette
  ZR1 + River 0–100 m, HUD kapalı. 1:1 ölçüm bunsuz yapılamaz.
- **İnternet altyapısı:** erişilebilir host/VPS + domain/TLS (veya Cloudflare
  Tunnel). Kod ve deploy paketi hazır; hesap/şifre paylaşımı gerekmiyor.

## 4. Bilinen sınırlar

- 310 m hattında dört prop kümesi pass-through (tasarım gereği).
- Amboy/Gracia prop collision PM1 ile geliyor.
- Amboy/Gracia'da gerçek tur LM1'e bağlı; yoksa noktadan noktaya kalır.
- SuperShield retail MP'de yok; proje uzantısı, varsayılan kapalı.
- Retail shader/ışık/gölge parity henüz yok; LIGHT1/MAT1/DECAL1 veri üretiyor.
- WebGPU tarayıcı gereksinimi COMPAT1 ile netleşecek.
- `ctest` bu makinede kurulu değil; `gate_e1.ps1` atlandı olarak kaydediyor.
