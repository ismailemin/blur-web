# T-004 — Native particle-cache çökmesi

**Durum:** kök neden bulundu ve x64 build'de düzeltildi (3/3 vs 3/3 paired);
slot sahipliği sözleşmesi web portu için açık
**Sahip:** ana ajan
**Başlangıç:** 1 Kasım 2026
**Bitiş:** —

## Amaç

W basılı yarış senaryosunda `Atomic.h:315-316` assert'i / `0xC0000005` ile
çöken particle trail cache'ini, assert'i zayıflatmadan düzeltmek.

## Kök neden

`C_Manager` trail slot yöneticisini `SetElementSize(8)` ile kuruyordu. Retail PC
build'i 32-bittir; orada `sizeof(C_Particle_E) == 8`. Bu x64 build'de sınıf
16 bayttır: `iSalt` komşu yuvanın `pEmitter`'ına yazılıyor, copy-last 16 baytı
8 baytlık adımın üzerine kopyalıyor. Trace'te yuva adımları 8 bayt, `iSalt`
değerleri işaretçi parçası ve bayat yuvada `0 == 0` ölçüldü.

## Düzeltme

`Manager.cpp:151` → `SetElementSize(sizeof(C_Particle_E))`.
Patch: `_work/build/engine-reference/native-slotstride-fix.patch`.
`Amax-slotstride.exe` üretildi; kanonik `Amax.exe` değişmedi.

## Sonuç

| Build | 3 koşu |
| --- | --- |
| baseline | 2× `0x80000003`, 1× `0xC0000005` |
| stride fix | 3× exit 0 (23–24 s) |

Ek kanıt koşusu `Racing` → `AFTER_THROTTLE` → `quit` akışını tamamladı.
Ayrıntı: `docs/work/verification/T-004-slot-stride.md`.

## Kalan iş / riskler

- 3/3 temiz koşu resmî ispat değil; daha uzun/otomatik tekrar koşuları eklenebilir.
- `emitter-slot-ownership.md` TEK-YUVA sözleşmesi uygulanmadı; web/wasm portu
  için önerilen sahiplik kuralı olarak duruyor. wasm32'de `sizeof` 8 olduğu için
  stride düzeltmesi orada no-op'tur.
- Assert kaldırılmadı.

## Kanıt

- `docs/work/analysis/emitter-slot-trace.md`
- `docs/work/analysis/emitter-slot-ownership.md`
- `docs/work/analysis/native-particle-crash.md`
- `_work/logs/slotstride-*.log`, `_work/logs/slotstride-evidence/`
