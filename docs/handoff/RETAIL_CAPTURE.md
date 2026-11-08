# Retail referans kareleri — çekim kılavuzu

Bu dosya **isteğe bağlıdır**: 1:1 karşılaştırmayı ölçmek için gerekir, oyunu
geliştirmeyi engellemez. Senin tarafında yapılacak tek iş bu; gerisini ben
hallediyorum.

Hazır olduğunda 4 (istersen 16) kare yeterli. Kareler gelmeden de bizim
taraftaki kareler hazır: `_work/retail-parity/screenshots/pose-{A,B,C,D}-*.png`.

## Ne çekilecek

- **Oyun:** retail Blur (PC)
- **Araba:** Corvette ZR1 **stock** (boya adını/numarasını not et)
- **Harita:** River
- **Bölge:** start + 0–100 m
- **Çözünürlük:** 1600×900, %100 render scale, grafik ayarları en yüksek
- **HUD:** kapatılabiliyorsa kapalı; kapanmıyorsa HUD'u kırpıp yine gönder
- **Anti-aliasing / motion blur / DOF / grain / bloom:** hangisi açıksa not et

## Araba konumları

| Nokta | Konum (x, y, z) | Yaw |
|---|---|---|
| Start | `-88.0, 1050.0` (yüzey y ≈ 5.78) | `0.767411` rad |
| 100 m | `-18.498, 5.779, 1122.049` | `0.76742` rad |

İşaretler:

- **Start:** ilk kapı; 9–36 m ileride üç prop (varil/engel) var.
- **100 m:** hemen önünde beton borular + ahşap panel bariyer; arkanda park
  etmiş/hurda araçlar.

## Kamera pozları

Serbest kamera / replay kamerası varsa aşağıdaki değerler; yoksa oyun içi chase
kamerasıyla sadece A ve C'yi çek, B/D'yi "eşleşmedi" olarak işaretle.

| Poz | Bakış | Tick | Göz | Hedef | Yaw / pitch / mesafe |
|---|---|---|---|---|---|
| A | start, chase | 0 | `-94.2444, 9.5646, 1043.5224` | `-87.9967, 7.1646, 1050.0005` | `-2.374299 / 0.260602 / 9.314505` |
| B | start, harita | 0 | `-103.2707, 19.9646, 1034.1668` | `-87.9967, 6.9646, 1050.0005` | `-2.374184 / 0.533708 / 25.553865` |
| C | 100 m, chase | 432 | `-24.7066, 9.1790, 1115.9284` | `-18.4215, 6.7790, 1122.3702` | `-2.368511 / 0.260602 / 9.314505` |
| D | 100 m, harita | 432 | `-36.5506, 19.3790, 1103.3378` | `-18.4982, 6.3790, 1122.0490` | `-2.374112 / 0.463648 / 29.068884` |

FOV: bizim tarafta dikey 45° (yatay 72.734°). Retail'de FOV değiştirilebiliyorsa
45° yap; yapılamıyorsa mevcut FOV'u yaz, biz kalibre ederiz.

## Nasıl gönderilecek

1. Kareleri `retail-<poz>-<sıra>.png` olarak kaydet (ör. `retail-A-0.png`).
2. Yanına `probes/retail-parity/retail-capture-template.json` dosyasını doldur
   (ayarlar, boya, FOV, AA).
3. Dosyaları bana ver; ben `_work/retail-parity/retail/` altına koyup
   karşılaştırma tablosunu üretirim.

Her poz için tek kare yeterli; istersen `t0, +0.5, +1.0, +2.0 s` olmak üzere
4 kare (toplam 16) daha iyi bir örneklem olur.

## Karşılaştırmada ne ölçülecek

| Öğe | "Eşleşti" sayılma ölçütü |
|---|---|
| Geometri | Özellik kenarları ≤ 2 px sapma |
| Doku | Aynı görsel, doğru yönde; desen kayması yok |
| Renk | Yol/çim/gökyüzü/lastik için ΔE2000 ≤ 3 |
| Gölge | Varlık ve yön ≤ 15° |
| Prop | Projektif konum ≤ 0,5 m |
| Decal | Aynı decal kümesi görünür |
| FOV | ≤ %3 fark |
| HUD | Yerleşim (yalnız kıyas; HUD kapalıysa atlanır) |

## Not

Bu kareler olmadan "1:1 mi?" sorusu **ölçülemez**; ama materyal, ışık, normal,
instance ve decal işleri bu kareler olmadan da ilerliyor. Yani bu, bekleyen tek
manuel adım; zorunlu değil.
