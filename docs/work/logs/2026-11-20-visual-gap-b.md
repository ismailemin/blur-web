# 20 Kasım 2026 — görsel fark: retail lightmap kuralı, iki çizim hatası, HDR post-process

Oturum kaydı. Ayrıntılı doğrulama: `docs/work/verification/visual-gap.md`
(İkinci geçiş bölümü). Değişen dosyalar:
`probes/e1-drive/web/packet-consumer.js`, `probes/e1-drive/web/app.js`,
`probes/e1-drive/tools/verify_e1_drive.mjs` (yalnız çökme düzeltmesi).

## Yapılanlar

1. **Commit edilmiş ışık kuralı düzeltildi.** Oyunun derlediği efektler
   `_LN` varyasyonuyla (`AmaxWorldLayer.cpp:603`,
   `amax/game/Shaders/shaders.jam:23`) `-D NIGHT_LIGHTING` alır;
   `Lighting/NightLighting.h` g_tLightmap'i `RGBLightmapNormalisedGamma`
   (`(rgb*a)^2`) ile çözer ve güneş/gökyüzü occlusion terimlerini hiç kullanmaz.
   Renderer artık **her haritada mod 2**. Önceden canlı güneş rengi olan haritalar
   (Amboy/MHaruna/Shutoko) yanlışlıkla `SunSkyLightmap` yolundaydı.
   `bakedColour` çarpanı korundu; `NightLighting.h` bu terimi kullanmıyor —
   açık sapma olarak kaydedildi, sessizce kaldırılmadı.
2. **Zemin siyahı.** `cullMode:'none'` + türev normali: WebGPU framebuffer Y'si
   aşağı olduğu için yatay zeminde normal `-Y` çıkabiliyordu; `dot(n,sun)` ve
   `saturate(n.y*0.5+0.5)` sıfırlanıyordu. `face.y < 0` → `-face` ile düzeltildi.
3. **Havada beyaz dörtgenler.** `textureBinding.status === 'blocked-bc3-alpha'`
   (River `cab01alphas_diff`, 4 çizim) artık fragment'ta `discard`. Çizim çağrısı,
   packet ve hash'ler değişmedi; `stats.suppressedDraws = 4` (River).
4. **Opak cam.** `partKind === 'glass'` araç çizimleri (araç başına 4) ayrı
   alfa-karışımlı geçişte koyu cam tonu + alfa 0.55 ile çiziliyor. Malzeme blend
   durumu kurtarılmadığı için sunum amaçlı yedek olarak etiketli.
5. **Veri odaklı HDR pozlama / tone map.** `app.js` `table.postProcess`'i
   `consumer.setPostProcess()`'e geçiriyor ve her `consumer.load()`
   sonrasında yeniden uyguluyor. Sahne lineer radiance'ı `rgba16float` hedefe
   yazıyor, 16x16 ızgara 1x1 parlaklığa indiriliyor, tone map commit edilmiş
   kuralı uyguluyor:
   `exposure = clamp(middleGrey/(lum+0.001), min, max)`;
   `tone = radiance*exposure*(middleGrey/(lum*exposure+0.001))`;
   `encoded = pow(tone, 1/gamma)`. Bloom `bloomThreshold/bloomScale` ile tek
   geçişli 5 örnekli kutu; retail bright-pass/bloom-curve zinciri çözülmediği
   için yaklaşım etiketli. `setPostProcess` çağrılmazsa eski doğrudan swap-chain
   yolu korunuyor.

## Kapılar

- `tools/verify_asset_probe.py --skip-build`: **104/104 PASS** (exit 0).
- Tarayıcı (başsız Edge, 1280x800): Amboy, Hackney, Brighton, River —
  **0 konsol hatası, 0 uyarı**; `lightingApplied.status = applied`;
  `postProcessFrames == renders`; `drawsIssued == renders * draws`.
- `compare_visual.mjs` (aynı kareler, aynı ölçüm): ortalama parlaklık
  Amboy 0.374 → **0.280**, Hackney 0.127 → **0.297**, Brighton 0.106 → **0.260**;
  retail oyun içi bant 0.278-0.369. Kontrast 0.128-0.168 (retail 0.179-0.249);
  Amboy/Hackney doygunluğu 0.230 (kompozisyon eksiği, pozlama değil).
  Ekran görüntüleri: `_work/menu-shots/showcase-{amboy,hackney,brighton,river}.png`.
- `node probes/e1-drive/tools/verify_e1_drive.mjs`: **FAIL (8402/8759)** —
  bu değişikliklerden bağımsız, mevcut çalışma ağacındaki sapmalar (araç
  sabitleri/telemetri çıpaları, `ai-driver-browser.js`'in commit'li kopyadan
  farklı olması, `_work/e1-drive/<harita>/layout.json` dosyalarının registry
  pin'leriyle uyuşmaması: amboy, gracia, sausalito). Aynı betik HEAD'de
  17 haritalı registry ile **çöküyordu** (`mapFiles` 3 harita); çökme, eksik
  dosya setini atlayan bir koruma ile giderildi, yeni bir başarısızlık
  eklenmedi.

## Kalanlar

Sky dome, blob gölge, light flare, partikül, araç yansıması yok. Araçlar hâlâ
retail `RGBSH` yerine etiketli ambient+güneş vekilini kullanıyor. Bloom'un tam
retail zinciri uygulanmadı.
