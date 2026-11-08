# NEXT — sıradaki görevler

**Güncelleme:** 8 Kasım 2026 (akşam)
**Plan:** [`docs/plan/FULL_GAME.md`](../plan/FULL_GAME.md) (yol haritası) ve
[`docs/plan/INTEGRATION_WAVES.md`](../plan/INTEGRATION_WAVES.md) (entegrasyon
dalgaları). Sıra bağlayıcıdır: bir dalga yeşil olmadan sonraki başlamaz.
**Bu oturumun kaydı:** [`docs/work/logs/2026-11-08-mp-eight.md`](../work/logs/2026-11-08-mp-eight.md)

## 0. Tamamlanan (bu dalga)

- **SHELL1 → `e1-drive`:** boş URL menüyü açar; yarış parametreleri menüyü
  atlar. `70374f6`.
- **NET1 → 8 oyuncu:** oda servisi 8 oyuncu + WSS deploy (`2aa9de1`); istemci
  `MP_MAX_PLAYERS=8`, 7 eş snapshot'ı, tüm eşler için uzak araç (`13cf0b1`).
- **Wave-1 probe verisi:** 19 analiz dokümanı (`50afc31`), tüm probe dizinleri
  (`fadabdd`).
- **V5:** 25 araç (`4157c87`).

## 1. Sıradaki işler (paralel, farklı dizinler)

| # | Ajan | Dizin | İş | Kapı |
|---|---|---|---|---|
| 1 | MODE1 | `probes/race-rules` | 14 kırmızıyı kapat: C06 sidecar hash, C24/C49/C92, E04/E06, D205/D405/D805, D-T01/T02, P205/P405/P805 | `verify-modes.mjs` 249/249 |
| 2 | MAPC1 | `probes/map-pipeline` | `verify_blocked.py` şeması (`newOnlyCoverageFraction`); 19 harita sıralaması | `verify_blocked.py` PASS |
| 3 | MAPBATCH1 | `probes/map-batch` | eksik `tools/verify_batch.py`; 19 seviye determinizmi | doğrulayıcı PASS |
| 4 | DECAL1 | `probes/instances` | determinizm (river/amboy), doku RGBA, decal UV hash, toplamlar | `verify_instances_decals.py` PASS |
| 5 | NET2 | `probes/net-prediction` | C211/C228/C245/C262 sınırlı snapshot | `verify.mjs` PASS |
| 6 | ROBUST1 | `probes/robustness` | 135/168 → envanter/docs güncel | `verify.mjs` PASS |
| 7 | PM1 | `probes/map-props` | Amboy/Gracia prop collider'larını `e1-drive`'a bağla | E2E collider sayısı |
| 8 | LM1 | `probes/map-laps` | Amboy loop-01 (284.4524 m) 3 turluk gerçek layout | E2E lap |
| 9 | PWR6 | `probes/powerups` | Amboy/Gracia pickup yerleşimi (`?powerups=1`) | E2E pickup |
| 10 | HUD1/MAT1/LIGHT1 | `probes/hud-ui`, `car-materials`, `lighting` | HUD/materyal/ışık paritesi | görsel + hash |

## 2. Ana ajan — entegrasyon sırası

1. Kırmızı doğrulayıcılar (1–6) yeşil.
2. PM1 → `e1-drive` prop collider (hash pinleri + tipli eksik-manifest hatası).
3. LM1 → Amboy gerçek tur; Gracia noktadan noktaya kalır.
4. PWR6 → Amboy/Gracia pickup'ları `?powerups=1` arkasında.
5. HUD/materyal/ışık paritesi.
6. Araç batch derleyici → 61/62.

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
