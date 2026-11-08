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

## 1. Sıradaki işler (paralel, farklı dizinler)

| # | Ajan | Dizin | İş | Kapı |
|---|---|---|---|---|
| 1 | PWR7 | `probes/powerups` | Retail pickup rotasının kendi polyline'ı; Amboy/Gracia retail slotlarını ölçülen parkura taşı | `verify_runtime_placement` + E2E |
| 2 | LM2 | `probes/map-laps` | Gracia için kapalı tur araştırması (yoksa karar yaz) | `verify_*` |
| 3 | MAPBATCH1 | `probes/map-batch` | `tools/verify_batch.py` + 19 seviye determinizmi | doğrulayıcı PASS |
| 4 | HUD1 | `probes/hud-ui` | HUD'ı `e1-drive` HUD'ına bağla | E2E + ekran |
| 5 | MAT1 | `probes/car-materials` | Boya/ışık reçetesini render'a bağla | görsel + hash |
| 6 | LIGHT1 | `probes/lighting` | Işık/gölge/normal manifestini render'a bağla | görsel + hash |
| 7 | MAPC1 | `probes/map-pipeline` | Kalan 13 harita için blok/derleme kararı | `verify_maps` |

## 2. Ana ajan — entegrasyon sırası

1. Retail pickup polyline → Amboy/Gracia gerçek yerleşim.
2. HUD/materyal/ışık paritesi.
3. Kalan haritalar (MAPBATCH1/MAPC1).
4. Araç batch derleyici → 61/62.

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
