# NEXT — sıradaki görevler

Sıra bağlayıcıdır. Bir görev kapanmadan sonraki kod görevine geçilmez.

## 1. T-003 — Scene/level kapsamını genişletme

**Durum:** planned (T-002 kapandı)
**Kart:** henüz açılmadı

Amaç: kalan56instance, sonraki RenderList'ler, level materyalleri, görünürlük
ve yüksek LOD'lar; ardından geometri + instance + doku ile tutarlı bir pist
parçası.

Kabul:

- Sabit offset veya tahmin yok; kaynak sırası korunur.
- Desteklenmeyen durumlar sayılarıyla raporlanır.
- Native/WASM/Python eşitliği ve regresyonsuz suite.
- Tek instance kanıtı genel "tam pist" iddiasına dönüşmez.

## 2. T-004 — Native particle-cache izi

**Durum:** ilk analiz tamamlandı; tam bellek izi açık
**Rapor:** `docs/work/analysis/native-particle-crash.md`

İlk bulgu: `m_ActiveElements=14`, `m_VectorPosition=-1`; aynı emitter ikinci kez
serbest bırakılmış. Tam `m_Cache`/`m_Active` dizileri ve tüm thread context'leri
dump'ta yok. Sıradaki: tam bellek dump'ı, sınırlı Free/AtomicFree izi ve girişsiz
A/B koşu. Assert kaldırılmayacak.

## 3. T-005 — Tek oyunculu dikey dilim

**Durum:** planned

Platform/streaming, scheduler, fizik, kontroller, ses ve save; bir araç/bir pist
üzerinde tam yarış. Multiplayer bundan sonra.
