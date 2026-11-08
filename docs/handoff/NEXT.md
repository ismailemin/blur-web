# NEXT — sıradaki görevler

**Güncelleme:** 8 Kasım 2026 (gece, geç)
**Plan:** [`docs/plan/FULL_GAME.md`](../plan/FULL_GAME.md) (yol haritası) ve
[`docs/plan/INTEGRATION_WAVES.md`](../plan/INTEGRATION_WAVES.md) (entegrasyon
dalgaları). Sıra bağlayıcıdır: bir dalga yeşil olmadan sonraki başlamaz.
**Bu oturumun kaydı:** [`docs/work/logs/2026-11-08-mp-eight.md`](../work/logs/2026-11-08-mp-eight.md)

## 0. Tamamlanan (bu dalga)

- **Araçlar 61/62:** hummer-h2-rat ve ford-supervan-stock sürüş diliminde;
  yalnızca `defaultcar` (gövde modeli yok) desteklenmiyor.
- **Lightmap render'da:** 9 haritada çözüldü ve bağlandı; Amboy vitrini
  **83 doku, 1173/1301 draw lightmap'li, 0 hata/uyarı**. River tek-harita
  yolunda; downtown/highrise tipli `unsupported`.
- **Retail yarış çizgisi:** `probes/map-laps-aid` `.aid` çizgisini collision'a
  iz düşürüyor; **Dumbo 362 m** path, diğer altı seviye tipli blocker.
- **Fiziksel pickup:** `probes/powerups-aid` gerçek dünya konumundan
  yerleştiriyor; Amboy 2/82, Gracia 2/59, River 0/54 (retail hat ölçülen
  parkurdan uzak), kalanlar `off-course`.
- **AI:** altı haritada 684 koşu, `verify-maps` 30/30.
- **Menü:** 61 araç / 11 harita (menü verisi sıradaki ajanla 61'e çekilecek).
- **Entegrasyon:** Amboy 3 tur (`578d652`), Amboy/Gracia prop collider
  (`1c9c46e`), Amboy/Gracia power-up + oda bayrağı (`7341690`).
- **Dalga 3:** pickup rotası (1610/1610), Gracia no-lap kararı (83/83), ışık
  (973/973), araç materyali (3505/3505), HUD (12 test) ve 19 harita kararı
  (2062/2062); HUD varsayılan (`3e70b3d`).
- **Haritalar 4→11:** Long Beach, Hollywood Hills, LA Downtown, Mount Haruna,
  Highrise, Tokyo Shutoko, Barcelona Oval, Amboy MP. Motor zemin sondası
  `e1_set_ground_hint` ile yükseltilmiş seviyeleri destekliyor; geniş parkurlar
  `course.gateRule: "arc-progression"` kullanıyor.
- **Araçlar 57→59:** ratrod ve supra staged (`8ec7352`).
- **Lightmap decode:** 455 retail doku (9292/9292). Ses kataloğu 23 olay
  (6567/6567). AI altı haritada 684 koşu (30/30).

## 1. Paralel dalga (bu gece, ayrık dizinler)

| # | Ajan | Dizin | İş | Kapı |
|---|---|---|---|---|
| 1 | MAPS2 | `probes/map-laps` | kalan 12 seviyenin collision yolu veya tipli blocker | `verify_remaining_paths` |
| 2 | LIGHT3 | `probes/lighting` | lightmap decode → gerçek ışık terimi | `verify_lightmap` |
| 3 | PWR9 | `probes/powerups` | fiziksel pickup iz düşümü (arc-korrespondans) | `verify_physical_placement` |
| 4 | VBATCH3 | `probes/vehicle-batch` | kalan 5 aracı çöz | `verify_batch_roster` |
| 5 | HUD3 | `probes/hud-ui` | hız göstergesi, vites, sıra, tur, sayaç | `node --test` |
| 6 | AUDIO2 | `probes/audio` | tam ses kataloğu (silah, pickup, UI) | `verify_runtime_audio` |
| 7 | AI5 | `probes/ai-driver` | yeni haritalarda AI | `verify-maps` |
| 8 | SHELL2 | `probes/game-shell` | menü 57 araç / 7 harita | `node --test` |

## 2. Ana ajan — entegrasyon sırası

1. MAPS2 çıktısı → her yeni harita için E1 paketi, registry pinleri, e2e.
2. LIGHT3 → render'a ışık; MAT2 → araç materyali.
3. PWR9 → fiziksel pickup yerleşimi.
4. VBATCH3 → kalan araçlar; SHELL2 → menü.
5. HUD3/AUDIO2/AI5 bağlantıları.
6. Retail 1:1 parite (kullanıcıdan referans kare), internet deploy
   (kullanıcıdan VPS/domain/TLS).

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
