# 0001 — Baseline commit ve Git düzeni

**Tarih:** 1 Kasım 2026
**Durum:** kabul edildi

## Bağlam

Proje başlangıcından bu yana hiç commit atılmamıştı. `master` dalı boştu;
`.gitignore`, `PLAN.md`, `docs/`, `probes/` ve `tools/` tamamen untracked'dı.
Bu durumda diff, geri dönüş, görev branch'i ve hata izleme mümkün değildi.

## Karar

- İlk commit `master` üzerinde atılır:
  `04276aa chore: baseline project docs, probes, and tools`.
- Commit yalnızca proje dosyalarını içerir.
- `upstream/`, `game-data/`, `_work/`, `downloads/`, `*.iso`, `*.exe`, `*.dll`,
  `__pycache__/` ve üretilmiş WASM Git dışında kalır.
- Yerel Git kimliği `Blur Web Agent <agent@localhost>` olarak ayarlanır; bu
  yalnızca bu depo içindir ve dışarıya açılmaz.
- Sonraki görevler kısa ömürlü `task/T-XXX-...` branch'lerinde yürür; doğrulama
  sonrası `master`'a alınır.
- Push yalnızca kullanıcı açıkça isterse yapılır.

## Sonuçlar

- İlk kez geri dönüş ve diff imkânı var.
- Oyun verisi ve build çıktıları depoya girmez.
- `_work/` silinirse kanıtlar kaybolur; bu yüzden dokümanlarda yeniden üretim
  komutu ve hash tutulur.
