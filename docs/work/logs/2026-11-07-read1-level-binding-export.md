# Oturum kaydı — 7 Kasım 2026, READ1 level binding export

**Görev:** `probes/asset-reader` doğrudan level çizim ihracatının, materyal
çözümlemesinin zaten ürettiği albedo kimliğini yazdırmasını sağlamak; River ve
Amboy üzerinde kanıtlamak. Yeni bağlama algoritması yok, yalnızca ihracat.

**Kapsam:** `probes/asset-reader/**`, `_work/asset-reader/**`,
`_work/logs/asset-reader/**`, `docs/work/analysis/{map-slice-amboy-textures,
level-instance-textures}.md`. `probes/e1-drive`, `probes/map-slice`,
`probes/map-pipeline`, `tools/`, `upstream/` ve `game-data/` değiştirilmedi.

## Değişiklik

- `scene_reader.cpp` `level_mesh()` artık `albedoTexture`, `albedoParameter`,
  `material`, `materialRow`, `resourceBlock`, `resourceIndex`, `uv0Available`,
  `uvHash`, `bindingStatus`, `bindingReason` alanlarını yazıyor.
- Level Scene `sharedTextures` listesi (ad/hash/dataOffset/dataBytes) export
  ediliyor; `resource_blocks` sayısı bağlama kontrolüne veriliyor.
- `uvHash`: P73a/P45/P47 FNV-1a 64; `bindingStatus`: resource/shared resolved
  veya blocked. Engelli çizim `bindingReason` taşıyor; uydurma doku yok.
- Instance yolu (P73a) değişmedi. Model `scene_inspect` alan seti, araç
  pipeline hash'lerini korumak için bilinçli olarak değiştirilmedi.

## Sonuçlar

| Ölçüm | Önce | Sonra |
|---|---:|---:|
| Amboy doğrudan çizim | 1.606 | 1.606 |
| Yazdırılan kimlik | 0 | **1.268** (1.163 resource + 105 shared) |
| Reader blocked | — | **338** |
| MAP3 birleşimi | — | **1.201 bindable / 405 blocked** |
| UV0 hash eşleşmesi | 0 | **1.606 / 1.606** |

- 5 bölümlük sınırlı örnek: 135 çizim, 108 bindable / 27 blocked; reader
  kimliği 114 resolved / 21 blocked.
- 27 billboard bölümü hâlâ `Unsupported position vertex format` (type 7);
  doku tarafı 27/27 çözülü. 366 instance açıklaması 262/40/64, 0 emitted,
  366 other-block; statik albedo ve UV0 beyanı 366/366.
- River doğrudan: 5/5 çizim `1073:0`, `1112:0`, `1118:0`, `936:0`, `829:0`;
  material satırları 2/3/4/6/8; pozisyon/index/UV0 hash'leri değişmedi.
  Paylaşılan doku listesi 0 → 10.
- P73a artifact değişmedi: `level-instance-textures.json` 25.724 B,
  SHA-256 `1a33893026887f0e022eeec782791cbedf9153146d389b7c076f9d0b84f47fb4`;
  UV 105.296 B, `158a3ac8…`; native `--instances-all` `2543128a…`.

## Kapılar

- Native MSVC `/W4`: temiz. CTest **15/15**.
- Amboy export verifier: **14.294 kontrol / 0 hata**.
- Amboy native/WASM örnek: 135 çizim + 366 instance deep-equal, PASS.
- P73a verifier: **558 / 0**.
- Tam suite: 38 PASS, sonra `map-slice-amboy` FAIL; `ai-driver` ve
  `amboy-textures` elle PASS. Tek neden, `_work/map-slice/amboy/slice.json`
  içindeki eski `level_inspect.exe` kaydı (247.808 B / `63ee2801…`; yeni
  249.856 B / `a633a030…`). Bu kayıt + content hash yenilenmiş kopya
  **12.367 kontrol / 0 hata** veriyor. map-slice dosyaları değiştirilmedi;
  kaydı sahibi yenilemeli. `extract_slice.py` ayrıca "her doğrudan çizimde
  albedo null" varsayımını taşıyor; paket yeniden üretilmeden önce bu kontrol
  güncellenmeli.

## Kanıt

- `_work/asset-reader/amboy-direct-bindings.json`
  (SHA-256 `a4b58c7f3a0d3461f8593e5e5f14750776bf74d5a16bf484e2a84f1e94817444`)
- `_work/verification/amboy-reader-native-wasm.json`
  (`6ea446f298f5b7b43ad75a294fb2d1fe4b16af7ac51d2eedcce4673d3750301f`)
- `_work/logs/asset-reader/{verify-asset-probe,amboy-direct-bindings,
  amboy-native-wasm,level-native-wasm,verify-instance-textures}.log`
- `probes/asset-reader/tests/verify_amboy_direct_bindings.py`,
  `verify_amboy_wasm.mjs`

## Sınırlar

Doku çözülmedi/örneklenmedi/çizilmedi; GPU/tarayıcı/tam oyun iddiası yok.
512 px decoder sınırı (50 çizim), BC3 alpha (17), Racification `g_tTexture`
(334) ve runtime albedo (4) açık. 27 bölüm + 366 instance geometri engeli.
