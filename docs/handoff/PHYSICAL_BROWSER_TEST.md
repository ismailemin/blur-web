# Fiziksel tarayıcı testi — mevcut sürüm

**Tarih:** 2 Kasım 2026
**Kapsam:** Asset tarayıcısı (PAK, model, doku, XT, level/instance önizlemesi).
**Kapsam dışı:** Oynanabilir yarış, fizik, ses, multiplayer. Bunlar T-005/T-006.

## Ön koşullar

- Güncel Chrome veya Brave; WebGPU açık.
- Yerel oyun verisi: `game-data/Blur` mevcut.
- Sunucu çalışıyor olmalı.

```powershell
cd "C:\Users\ismailemin\Documents\Blur Web"
& 'C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe' tools/serve_asset_probe.py
```

Adres: **http://127.0.0.1:8765/**

## Test 1 — Corvette gövdesi

1. Paket listesinden **`root.pak`** seç.
2. **Kurulu paketi aç**.
3. Beklenen: **3.601** dosya kaydı, `PAK v2 · little`, ~533,7 MiB.
4. Filtreye `corvette_c3_race.model` yaz.
5. `wheels\` dışındaki satırda **Blokları oku**.
6. Beklenen durum:
   - `30591 vertex / 36193 üçgen`
   - `26/80 çizimde özgün albedo`
   - `Orijinal doku` modu
   - Console’da error/warning yok

## Test 2 — River geniş sahne

1. **Sahne örneği** → **River · geniş alan**.
2. **Sahne parçasını aç**.
3. Beklenen: ~17.782 vertex / 9.343 üçgen, 95 doğrudan çizim; instance uygulanmaz.

## Test 3 — River 22 instance

1. **Sahne örneği** → **River · 22 instance**.
2. **Sahne parçasını aç**.
3. Beklenen:
   - `22 instance çizildi · 0 sınır uyuşmazlığı · 35 başka blok`
   - `13162 vertex / 10308 üçgen`
   - `Yüzey` modu; materyaller uygulanmadığı için doku yok.

## Test 4 — River tüm desteklenen

1. **Sahne örneği** → **River · tüm desteklenen**.
2. **Sahne parçasını aç**.
3. Beklenen:
   - `36 instance çizildi · 20 sınır uyuşmazlığı · 1 blok atlandı`
   - `17301 üçgen`
   - Blok26/32 Stage B bekliyor; bu bir hata değil.

## Test 5 — Showroom

1. **Sahne örneği** → **Showroom**.
2. **Sahne parçasını aç**.
3. Beklenen: ~11.590 vertex / 7.987 üçgen, 95 doğrudan çizim.

## Bilinen sınırlar

- Oynanabilir oyun yok; kamera dışında kontrol/fizik yok.
- Corvette’in 54 çizimi hâlâ tanılama yüzeyi; runtime boya/ışık yok.
- Level materyalleri/görünürlük yok.
- Blok26/32 chunk'lar arası (Stage B) ve blok31 prerequisite henüz yok; toplam 57
  instance'ın 36'sı çiziliyor.
- WebGPU yoksa model canvas açılmaz; `chrome://gpu` kontrol edilmeli.

## Sorun giderme

| Belirti | Kontrol |
|---|---|
| Paket açılmıyor | Sunucu 8765’te mi? `root.pak` seçili mi? |
| `corvette` sonucu yok | `root.pak` açıldı mı? Dosya kaydı 3.601 mi? |
| “0 kayıt” | `boot.pak` açık olabilir; `root.pak` seçip yeniden aç. |
| WebGPU hatası | Chrome güncel mi, donanım hızlandırma açık mı? |
| Canvas siyah | Model yüklendi mi? `Yüzey`/`Tel kafes` dene. |

## Kanıt

- `_work/verification/suite.json` — 27/27
- `_work/logs/readiness-suite.log`
- `_work/logs/readiness-ctest.log` — 14/14
- `docs/work/verification/T-001.md`, `T-003.md`

Bu sürüm bir **asset görüntüleyicidir**; “çalışan tarayıcı oyunu” olarak
değerlendirilmemelidir.
