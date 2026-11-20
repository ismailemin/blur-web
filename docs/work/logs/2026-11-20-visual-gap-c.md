# 20 Kasım 2026 — görsel fark: sky dome + blob gölge (üçüncü geçiş)

Oturum kaydı. Ayrıntılı doğrulama: `docs/work/verification/visual-gap.md`
(Üçüncü geçiş). Yeni dosyalar:
`probes/lighting/tools/export_sky_dome.py`, `_work/check_sky_shadow.mjs`
(gitignore). Değişenler: `probes/e1-drive/web/packet-consumer.js`,
`probes/e1-drive/web/app.js`, `docs/*`.

## Sky dome (plan maddesi 1)

- **Kaynak:** oyunun gökyüzü `Effect::Sky::C_TexturedSkyDome`
  (`effect/source/sky/TexturedSkyDome.cpp`, `vsTexturedSkyDome.vsh`,
  `psTexturedSkyDome.psh`); 25x25 `BuildSphere()`.
  Kural: `v = 2*acos(ray.y)/pi`, `u = atan2(x,z)/2pi + rotation`,
  `sky = tex(u,v).rgb * tex.a * tex.a * intensity`,
  `fog = saturate((v+fogTop-1)/fogTop)^fogCurve`,
  `black = saturate((blackHeight-v)*blackSize)`,
  `colour = lerp(sky, fogColour, fog) * black`. `.texture` yolu `SetSRGB`
  çağırmıyor → doku **lineer rgba8unorm**; alfa parlaklık terimi.
- **Exporter:** `probes/lighting/tools/export_sky_dome.py` 17 haritanın 14 farklı
  dome dokusunu `root.pak`'tan çıkarıp `_work/lighting/skies/<ad>.rgba`
  (2048x512) + `skies/index.json` + harita başına `_work/lighting/<map>/sky.json`
  yazıyor. Hepsi 2048x512 DXT5/BC3 tek mip; başka format **tipli hata** ile
  durur (byte offset + format kodu), tahmin yok.
- **Decoder kanıtı:** native `texture_inspect.exe` >512 px dokuları bilerek
  reddediyor; bu yüzden DXT5 blok çözümü `texture_reader.cpp` `pixels()`
  fonksiyonunun birebir portu. Exporter aynı paketteki 256x256 DXT5
  `dontship/textures/debugback.texture` örneğini hem portla hem native ile
  çözüp **byte-eşit** olmasını şart koşuyor (`decoderSelfCheck.match = true`).
- **Renderer:** `consumer.setSkyDome(...)`; tam ekran ışın eşlemesi (dome
  geometrisi yok, kamera merkezde olduğu için eşdeğer), opak geometriden önce,
  derinlik yazmadan. `app.js` harita `sky.json` + RGBA'yı çekiyor, her
  `consumer.load()` sonrası yeniden uyguluyor.

## Blob gölge (plan maddesi 4)

- `_work/lighting/<map>.json shadow`: ShadowSize 6, ShadowHeight 0.5/1,
  DropShadowIntensity 0.75, DropShadowHeight 30/50, MaxShadows 6;
  doku `graphics/textures/shadows/impostershadow.texture` = **32x32 A8**
  (dolu kare, 1-2 px kenar). Retail zinciri per-kanal render + gaussian blur +
  ekran kompoziti; bu zincir **uygulanmadı**.
- `consumer.setShadow(...)` committed dokuyu arabanın (ve aktif remote/ghost
  araçların) altında zemine izdüşümlü kuşakta çiziyor: yaw hizalı, araç
  ayak izinden boyutlanmış, `ShadowSize` ile sınırlı; alfa = doku alfa ×
  `DropShadowIntensity` × radyal smoothstep (retail blur yerine etiketli
  yaklaşım). Packet/hash/fizik değişmiyor.

## Kapılar

- `probes/lighting/tools/export_sky_dome.py`: **ok**, 17 harita, 14 doku,
  self-check `true`, 58.720.256 B RGBA.
- `tools/verify_asset_probe.py --skip-build`: **104/104 PASS** (exit 0).
- Tarayıcı (başsız Edge): Amboy, Hackney, Brighton, River — **0 hata, 0 uyarı**;
  `skyFrames == renders`, `shadowDraws == renders`, `lightingApplied.applied`;
  ekran görüntüleri `_work/menu-shots/showcase-*.png`.
- `compare_visual.mjs` (aynı kareler):
  Amboy 0.280→**0.262** lüm / 0.128→**0.148** kontrast / 0.230→0.164 doygunluk,
  Hackney 0.297→**0.281** / 0.141→**0.150** / 0.230→0.204,
  Brighton 0.260→**0.273** / 0.168→**0.174** / 0.430→0.230.
  Retail oyun içi: 0.278-0.369 / 0.179-0.249 / 0.280-0.484.
  Doygunluk düştü çünkü gökyüzü artık karenin büyük kısmı; Brighton gece
  göğü olduğu için near-black payı 0.234 (retail referans kareleri gündüz).

## Kalanlar

Light flare, partikül, araç yansıması; retail deferred blob zinciri; tam bloom
zinciri; araçlar için `RGBSH` terimi.
