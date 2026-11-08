# RESUME — 9 Kasım 2026, bilgisayar kapanmadan önceki durum

Bu dosya, çalışmaya kaldığı yerden devam etmek için yazıldı. Önce
[`CURRENT.md`](CURRENT.md), sonra bu dosya okunmalı. Ayrıntılı oturum kaydı:
[`docs/work/logs/2026-11-08-mp-eight.md`](../work/logs/2026-11-08-mp-eight.md)
(§25–§32).

## Nerede kaldık (özet)

| Alan | Durum |
|---|---|
| **Haritalar** | **13/19 oynanabilir**: river, amboy, gracia, longbeach, observatory, downtown, mharuna, highrise, shutoko, oval, amboy-mp, **dumbo**, **downtown-mp**. |
| **Araçlar** | **61/62** sürüş diliminde. Yalnızca `defaultcar` desteklenmiyor (gövde modeli yok). |
| **Lightmap** | **9 haritada render'da** (river, amboy, gracia, longbeach, observatory, mharuna, shutoko, oval, amboy-mp). Amboy vitrini: **83 doku, 1173/1301 draw lightmap'li, 0 hata/uyarı**. |
| **Ses** | 23 olaylı retail kataloğu sayfaya bağlı. |
| **HUD** | Hız göstergesi, vites, sıra/tur, güç yuvası, hasar/kalkan, geri sayım; 19/19 test. |
| **Multiplayer** | 8 oyunculu oda (`mp-eight` 95/95); Amboy'da `?powerups=1` ile 82 pickup / 8 tip. |
| **E2E** | 17 senaryo; her biri tek başına yeşil. Son toplu koşuda `solo-dumbo`/`solo-downtown-mp` sunucu ölünce `ERR_CONNECTION_REFUSED` aldı; sunucu açıkken **12/12** geçti. |
| **Kapı** | **`verify_asset_probe --skip-build` 95/95 PASS** (`gate-full17.log`, exit 0). `vehicle-batch-roster` 61/61. |

## Son commit'ler

```
e69ea82 chore(vehicle-batch): regenerate the spec for the 61-car roster
1b864e4 chore(powerups): re-derive the retail and physical placement against the current layouts
dbb4117 docs(handoff): record thirteen maps and the lightmap showcase
1254bdf feat(e1): make Dumbo and Downtown MP the twelfth and thirteenth playable maps
fb67ca4 feat(map-batch): prepare the Dumbo and Downtown MP aid-path packages
c6e4ee2 docs(handoff): record the lightmap showcase, 61 cars and the two new aid paths
32d8c34 fix(render): keep the scene ambient write inside its buffer and re-pin the River level chunk
```

## Devam ederken ilk komutlar

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

# 1. Kapıyı doğrula (gate-full17.log sonucuna bak)
& $py tools/verify_asset_probe.py --skip-build

# 2. Sunucuyu aç (tarayıcı testi için)
powershell -ExecutionPolicy Bypass -File tools/run_e1_poc.ps1

# 3. Tek harita doğrulaması
node probes/e1-drive/tools/verify_e1_map.mjs --map dumbo
node probes/e1-drive/tools/verify_e1_map.mjs --map downtown-mp

# 4. E2E (tek tek; toplu koşuda sunucu ölürse yeniden başlat)
node probes/e2e/run.mjs --scenarios solo-dumbo,solo-downtown-mp --base http://127.0.0.1:8801/ --room ws://127.0.0.1:8811/ws
```

## Sıradaki işler (öncelik sırası)

1. **Kapı yeşil** (`gate-full17.log`, 95/95). Yeni bir değişiklikten sonra
   yeniden koş; kırmızı çıkarsa büyük olasılıkla "stale pin"dir; ilgili
   üreticiyi çalıştır (`docs/work/verification/refresh-work-artifacts.md`).
2. **Menüyü 61 araç / 13 haritaya çek.** `probes/game-shell` hâlâ 59/11
   verisiyle; `car-classes.json` ve `course-measurements.json` güncellenmeli,
   `capture-shell.mjs` beklentileri 61/13 olmalı.
3. **River lightmap'i.** River `kind: 'single-map'` ve `build_geometry.mjs`
   yolunu kullanıyor; `mesh.lightmapUv` + `draw.lightmapUrl` oraya eklenmeli.
4. **Dumbo / Downtown MP lightmap'i.** `probes/lighting` 9 haritayı çözüyor;
   bu iki seviye `LIGHTMAP_MAPS` dışında. `lighting_data.py` `SPAWN_TABLE`'a
   eklenip manifest + export yenilenmeli, sonra `build_e1_package.py`
   `LIGHTMAP_MAPS`'e eklenmeli.
5. **Kalan 6 harita (tipli blocker).**
   - `uk_london_hackney`: `.aid` hattı 222/10.012 istasyonda bant dışı.
   - `uk_brighton`: 952/8.662.
   - `usa_sanfran_sausalito`: 7.909/18.196.
   - `usa_sanfran_russianhill`: spawn'a 25 m içinde `.aid` hattı yok.
   - `spa_barcelona_bowl_multiplayer`: `.aid` dosyası yok.
   - `showroom`: yarış haritası değil.
   Bunlar gerçek veri sınırları; spawn/finish yeniden seçimi veya daha geniş
   koridor bir tasarım kararıdır, uydurma değil.
6. **`defaultcar`**: gövde modeli yok; tipli `unsupported` kalmalı.
7. **Retail pickup fiziksel yerleşimi.** `probes/powerups-aid`: Amboy 2/82,
   Gracia 2/59, River 0/54 (retail hat ölçülen parkurdan uzak). Kalanlar
   `off-course`; fiziksel iddia yok.
8. **İnternet deploy.** `docs/` altındaki deploy paketi hazır; kullanıcıdan
   VPS/domain/TLS bekliyor.

## Bu oturumda düzeltilen gerçek hatalar (tekrar etmemek için)

- `packet-consumer.js` sahne ambient yazımı 64 baytlık buffer'a 16 bayt
  yazıyordu (offset 52 + 16 = 68) → 4 baytlık yazıma çevrildi.
- River `mpPins.packageHash` 61 araçlı `level.geometry.json` ile yenilendi.
- `build_car_textures.py` / `build_geometry.mjs` `unsupported_uv` sınıfını
  tanımıyordu; eklendi.
- `build_manifest.py` iki yeni kararı içeriyor: `E_Brake_Caliper_*` ad
  varyantı ve `DefaultElement` altındaki tekerlek parçasının matris
  çevirisiyle köşe kanıtı.
- `build_e1_package.py` / `build_map_batch.mjs` dumbo + downtown-mp
  girdileri; `map_batch_lib.INTEGRATED`, `verify_batch`, `blocked_inventory`,
  `verify_blocked`, `verify_map_decisions` 13 haritaya güncellendi.

## Bilinen "stale pin" zinciri (üretici değişince)

`probes → map-batch → map-laps paths → E1 packages → map-registry.js →
blocked_inventory → build_map --all → build_map_decisions`. Ayrıca
`probes/powerups` (placement, arc-correspondence), `probes/textures`,
`probes/map-props`, `probes/car-materials`, `probes/ai-driver` kendi
üreticilerini pinler. Sıra: `docs/work/verification/refresh-work-artifacts.md`.
