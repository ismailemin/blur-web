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
| **Lightmap** | **11 haritada render'da** (river hariç). Amboy: **83 doku, 1173/1301 draw**. Dumbo 115 doku/1615 draw, Downtown MP 49 doku/207 draw. |
| **Araç materyali** | Retail **boya** ve **ışık rengi** render'da. Corvette: `Canal_Blue` `[0.0252, 0.3712, 0.8228]`, 10 boya draw'ı; far/stop/sinyal kapakları retail `emissive` rengiyle. |
| **Ses** | 23 olaylı retail kataloğu sayfaya bağlı. |
| **HUD** | Hız göstergesi, vites, sıra/tur, güç yuvası, hasar/kalkan, geri sayım; 19/19 test. |
| **Menü** | **61 araç / 13 harita**, 42/42 test, başsız Edge 0 konsol hatası. |
| **Multiplayer** | 8 oyunculu oda (`mp-eight` 95/95); Amboy'da `?powerups=1` ile 82 pickup / 8 tip. |
| **AI** | 8 haritada 61 araç × 2 profil = **976 koşu**, 946 temiz, 30 bildirilmiş limit, 0 beklenmeyen; `verify-maps` **32/32**. Dumbo/Downtown MP 122/122 temiz. |
| **E2E** | **17/17 senaryo, 479/479 assertion** (dumbo ve downtown-mp dahil). |
| **Kapı** | **`verify_asset_probe --skip-build` 98/98 PASS** (`gate-full20.log`, exit 0). |

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

1. **Kapıyı doğrula** (`gate-full18.log`). Yeni eklenen `map-laps-aid`,
   `powerups-aid` ve `lighting-lightmap-runtime` adımları dahil.
2. **River lightmap'i.** River `kind: 'single-map'` ve `build_geometry.mjs`
   yolunu kullanıyor; track görseli `_work/level-candidates/.../reference.json`
   üzerinden geliyor ve orada `lightmapUv` yok. `mesh.lightmapUv` +
   `draw.lightmapUrl` bu yola eklenmeli.
3. **Kalan 5 harita (tipli blocker).** `.aid` hattı ±24 m detour ile bile
   araç bandına (2,276 m) sığmıyor:
   - `uk_london_hackney`: 221 istasyon (ilk 2.890/10.012, (-227.278106, -133.764788)).
   - `uk_brighton`: ±24 m'de 24 istasyon (ilk 670/8.662, (84.516652, -185.448468)).
   - `usa_sanfran_sausalito`: 7.024 istasyon (ilk 4/18.196, (709.521209, -1434.502293)).
   - `usa_sanfran_russianhill`: en yakın hat 175,14 m; snap limiti 25 m.
   - `spa_barcelona_bowl_multiplayer`: `.aid` dosyası yok.
   `showroom` yarış haritası değil. Bunlar gerçek koridor genişliği sınırları;
   daha dar bir araç bandı (ör. gerçek araç genişliği) bir tasarım kararıdır,
   uydurma değil.
4. **`defaultcar`**: gövde modeli yok; tipli `unsupported` kalmalı.
5. **Retail pickup fiziksel yerleşimi.** `probes/powerups-aid`: Amboy 2/82,
   Gracia 2/59, River 0/54 (retail hat ölçülen parkurdan uzak). Kalanlar
   `off-course`; fiziksel iddia yok.
6. **İnternet deploy.** Deploy paketi hazır; kullanıcıdan VPS/domain/TLS
   bekliyor. Retail 1:1 parite için kullanıcıdan referans kareleri.

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
