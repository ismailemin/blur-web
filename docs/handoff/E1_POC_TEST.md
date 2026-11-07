# E1 PoC — tarayıcı test listesi

**Tarih:** 5 Kasım 2026
**Kapsam:** `probes/e1-drive/` wasm araç fiziği + River collision mesh + gerçek
araç/pist geometrisi + WebGPU. **Tam oyun değil.**
**Durum notu (5 Kasım 2026):** Bu not yazıldığında P55 araç dokuları
değişimdeydi (`geometry.json` v6, 45.180.725 B). Bu yüzden `sprint.json` /
`geometry.json` dosya hash'leri `docs/work/verification/T-007-310m-course.md`
içindeki eski değerlerden farklı olabilir. `tools/check_e1_poc.py` belge hash'ine
değil, **artefaktların kendi içindeki pinlere** bakar. P55 commit edildikten
sonra belge hash'leri ayrıca güncellenmelidir.

## 1. Tek komut hazırlık kontrolü

```powershell
cd "C:\Users\ismailemin\Documents\Blur Web"
python tools\check_e1_poc.py
```

Bundled Python:

```powershell
C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe tools\check_e1_poc.py
```

- Her satır bir kontrol: `PASS` / `FAIL` / `INFO` + tam dosya yolu.
- Çıkış kodu: **0** hepsi geçti, **1** kontrol hatası, **2** zorunlu artefakt yok.
- Sunucu zaten 8801'de çalışıyorsa index + 8 artefaktın servis edildiğini de
  doğrular; **sunucuyu başlatmaz/durdurmaz**.
- `--json` makine okunur rapor, `--hash` artefakt SHA-256 listesi verir.
  Çalışma süresi ~0,3 s.

FAIL varsa önce `tools\run_e1_poc.ps1` çıktısındaki build komutlarını çalıştırın;
checker eksik dosyanın veya uyuşmayan pinin yolunu satırında yazar.

## 2. Başlatma ve URL

```powershell
powershell -ExecutionPolicy Bypass -File tools\run_e1_poc.ps1
```

Aç: **http://127.0.0.1:8801/**

Gereksinim: güncel Chrome/Brave + WebGPU (`chrome://gpu` → WebGPU: Hardware
accelerated). Konsolu F12 ile açın; test boyunca **0 mesaj** beklenir.

## 3. Araçlar ve beklenen 310 m süreleri

| Araç | `?car=` | 310 m (scripted) | 29 m `?course=short` | 3 tur `?course=lap` |
|---|---|---|---:|---:|
| Audi R8 V10 (AWD) | `audi-r8v10-stock` | **14,150 s** | 2,283 s | **85,467 s** |
| Corvette ZR1 (RWD) | `corvette-zr1-stock` | 14,650 s | 2,800 s | 86,100 s |
| Lotus Exige Cup260 (RWD) | `lotus-exige-cup260-stock` | 14,767 s | 2,850 s | 86,283 s |
| Dodge Challenger (RWD) | `dodge-challenger-stock` | 14,917 s | 3,000 s | 86,117 s |
| Ford Focus RS (FWD) | `ford-focusrs-stock` | 15,217 s | 3,267 s | 86,250 s |

Sıralama sabittir: AWD en hızlı, FWD en yavaş. Klavyeyle sürüşte süre daha
uzun olabilir; scripted modda tablodan ±0,01 s sapma kabul edilir.

## 4. Kontroller

| Tuş | İş |
|---|---|
| `W` / `↑` | gaz |
| `S` / `↓` | fren |
| `A` / `D` / `←` / `→` | direksiyon |
| `Space` | el freni |
| `M` | motor sesini aç/kapa |
| `R` | yerinde restart (sayfa yenilenmez) |
| Fare sürükle | kamera orbit |
| Tekerlek | zoom |

## 5. Modlar

| URL | Ne |
|---|---|
| `/` | Serbest sürüş + 310 m sprint (countdown, 2 checkpoint, finish) |
| `/?car=audi-r8v10-stock` | Araç seçimi (üstteki CAR listesi de çalışır) |
| `/?course=short` | 29 m regresyon parkuru |
| `/?course=lap` | **3 turluk kapalı tur** (loop-01 222,04 m, ayrı spawn) |
| `/?course=free` | **Free-roam** (7.702 m², 431 solid prop, finish yok) |
| `/?script=sprint` | Deterministik sprint (aynı Stanley sürücü, araç başına ayrı girdi) |
| `/?script=sprint&course=lap` | Deterministik 3 tur |
| `/?script=drive` | Kuralsız 300 tick sürüş (eski kanıt modu) |
| `/?telemetry=1&car=<slug>` | 0–100, 80–0 fren, yanal grip tablosu + 3 grafik |
| `/?survey=1` | 539,81 m River koridoru etiketi — **parkur değil** |

## 6. Geçti sayılır

- [ ] `python tools\check_e1_poc.py` → `0 FAIL`, çıkış kodu 0.
- [ ] Sayfa WebGPU canvas ile açıldı; hata kutusu yok, 404 yok.
- [ ] **Console 0 mesaj** (log/warn/error).
- [ ] 3-2-1 countdown → timer → 2/2 checkpoint → finish; sonuç ekranı süre + araç.
- [ ] `?course=lap`: 3 tur → start/finish çizgisi 3 kez → finish; tur süreleri ve en iyi tur görünür.
- [ ] Tur modunda truck/bina prop'ları solid; loop-01'de temas yok (HUD: 468 colliders).
- [ ] `?course=free`: 431 collider solid; truck/bina içinden geçilmiyor; HUD `free roam`; `R` spawn'a dönüyor.
- [ ] İlk tuş/click sonrası motor sesi geliyor; RPM yükselince pitch yükseliyor; `M` sessize alıyor; `?audio=0` tamamen sessiz.
- [ ] Truck/wreck'ler gerçek albedo ile dokulu (4 BC3 cab draw hariç); HUD'da diagnostic sayısı düşük.
- [ ] M1: host `?mp=1&host=1` oda kodu veriyor; guest `?mp=1&room=CODE` katılıyor; ikisi READY → host START → iki sayfada aynı sonuç; console 0.
- [ ] M2: `&powerups=1` ile pickup toplanıyor, `E` ile mine/shield/repair kullanılıyor; HUD health/shield/feed güncelleniyor; wreck → respawn; console 0.
- [ ] Süre tablodaki değere ±0,01 s (scripted) veya makul (klavye).
- [ ] `R`: aynı sayfada yeniden countdown; süre sıfırlanır, en iyi süre korunur.
- [ ] Beş araç seçilebilir; her biri kendi gövdesi/tekerleriyle görünür.
- [ ] Yol gerçek albedo ile dokulu (HUD: `394 real draws · 57133 tri ·
      297 textured (136 tex, 439360 B)`), collision slab görünmüyor.
- [ ] Kamera prop içine girmiyor; araç görünür kalıyor.
- [ ] `?telemetry=1` tablo + üç 60 Hz eğri çiziyor.
- [ ] `?survey=1` "parkur değil / ölçülen sınır 57,82 m" etiketini gösteriyor.

## 7. Bilinen sınırlar

- **Noktadan noktaya.** Parkur 310,395 m; finish 300,160 m'de (10,24 m
  run-off). Tur/sector/loop yok; kapalı tur committed veriyle mümkün değil.
- **540 m koridor parkur değil.** `?survey=1` yalnız görsel etiket; ölçülen
  çizgi 57,82 m'de 50 m'lik collision duvarından geçiyor, araç 52,7–53,4 m'de
  duruyor.
- **Materyaller büyük ölçüde diagnostic.** 394 pist draw'ının 297'si gerçek
  albedo + UV0; 97'si diagnostic. Araçlarda 491 draw'ın 224'ü textured.
  Mip/sRGB/anisotropy, boya, blend, gölge ve post yok. Tek directional light.
- **Tek araç.** AI, trafik, rakip, ses, multiplayer, culling/streaming yok.
- **Teker rest-pose**, süspansiyon/steer/camber yok; spin fizikten entegre.
- **Box gravity proxy**; mesh→şasi hizalama offseti kanıtlanmadı.
- **Restart/respawn tam rebuild** (180 tick settle) → tek karelik takılma.
- **Süreler bu PoC'nin kendi bookkeeping'i**; retail BPR/XP/skor iddiası yok.
  Headless ölçümler kullanıcının GPU/fps iddiası değildir.

## 8. Hata nasıl bildirilir

1. Hatanın **tam ekran görüntüsü** (HUD, sonuç ekranı ve konsol görünsün).
   `Win+Shift+S` ile alın, PNG olarak kaydedin.
2. **Konsolun tamamı**: F12 → Console → sağ tık → *Save as…* (veya *Copy all*).
   Log/warn/error ayrımı yapmadan gönderin.
3. Şu bilgiler: URL (query dahil), araç slug'ı, mod, süre/tick, beklenen ve
   görülen değer, tarayıcı sürümü, `chrome://gpu` WebGPU satırı.
4. Checker çıktısı: `python tools\check_e1_poc.py --json` (veya `--hash`).
5. Bunları yeni bir görev kartı/log altında toplayın; `upstream/`, `game-data/`
   ve `_work/` dışındaki hiçbir şeyi değiştirmeyin. Kanıt dosyaları commit
   edilmez.
