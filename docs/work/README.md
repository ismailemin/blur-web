# Çalışma kayıtları

Bu dizin, `docs/STATUS.md`'nin kronolojik anlatısını tamamlayan görev bazlı
kayıtları tutar. Amaç: her oturumun nerede kaldığını, neyi neden yaptığını ve
hangi kanıtla kapattığını kaybetmemek.

## Görev panosu

| Görev | Durum | Öncelik | Bağımlılık | Kart |
|---|---|---|---|---|
| T-001 — Corvette kalan 12 statik doku | done | P0 | — | `tasks/T-001-corvette-resource-textures.md` |
| T-002 — Level instance dönüşümleri | done | P0 | T-001 | `tasks/T-002-level-instances.md` |
| T-003 — Scene/level kapsamını genişletme | in-progress (Stage A tamam: 36 instance; Stage B sırada) | P1 | T-002 | `tasks/T-003-scene-traversal.md` |
| T-004 — Native particle-cache çökmesi | done (x64 stride fix, 3/3 vs 3/3; web slot sözleşmesi açık) | P1 | — | `tasks/T-004-native-particle-crash.md` |
| T-005 — Tek oyunculu dikey dilim | in-progress (T-005b file + T-005c sched + T-005d collision/Gravity wasm tamam; T-005e/f/g sırada) | P1 | T-003/T-004 | `tasks/T-005-single-player-vertical-slice.md` |
| T-006 — Tarayıcı multiplayer | analiz tamam (a/b/c); uygulama T-005g/T-004'e bağlı | P2 | T-005g/T-004 | `tasks/T-006-multiplayer.md` |
| T-007 — E1 oynanabilir dikey dilim | in-progress (E1b tamam; E1a streaming + E1c araç fiziği sürüyor) | P0 | T-005b/c/d | `tasks/T-007-e1-playable-slice.md` |

Durumlar: `planned`, `in-progress`, `blocked`, `done`, `superseded`.

## Kayıt türleri

- `tasks/T-XXX-*.md` — tek görevin amacı, kapsamı, kabul kriterleri, kanıtı.
- `logs/YYYY-MM-DD-*.md` — oturum günlüğü: ne denendi, ne öğrenildi.
- `decisions/NNNN-*.md` — geri dönüşü olan mimari/süreç kararları.
- `analysis/*.md` — salt okunur inceleme raporları (ör. native dump).
- `verification/*.md` — komut, çıktı özeti, hash ve kanıt yolları.

## Görev yaşam döngüsü

1. Kartı `planned` → `in-progress` yap; sahip ve başlangıç tarihini yaz.
2. Yalnızca kartta listelenen dosyalara dokun.
3. Geliştirme sırasında en küçük ilgili testi çalıştır.
4. Kapanışta tam doğrulama kapısını çalıştır.
5. Kanıtı `verification/` altına, oturum özetini `logs/` altına yaz.
6. Kartı `done` yap; `docs/handoff/CURRENT.md` ve gerekirse `STATUS.md` güncelle.
7. Ana ajan diff'i inceler ve commit atar.

## Görev kartı şablonu

```text
Durum:
Sahip:
Başlangıç / bitiş:
Amaç:
Kapsam:
Kapsam dışı:
Dokunulacak dosyalar:
Kabul kriterleri:
Doğrulama komutları:
Kanıt:
Bağımlılıklar:
Riskler:
Sonraki adım:
```

## Dil kuralı

- Handoff, görev kartı, oturum logu ve kararlar: Türkçe.
- Format sözleşmeleri, mimari ve teknik doğrulama raporları: İngilizce.
