# NEXT — sıradaki görevler

Sıra bağlayıcıdır. Bir görev kapanmadan sonraki kod görevine geçilmez.

## 1. T-003 — Scene/level kapsamını genişletme

**Durum:** in-progress (blok27 çoklu instance tamam)
**Kart:** `docs/work/tasks/T-003-scene-traversal.md`

İlk artım: `level_instances_all_inspect` blok27'ye bağlı **14 instance**'ı
çiziyor (8 sınır uyuşmazlığı, 35 başka blok); 7.308 vertex/6.106 üçgen.
Kalan iş:

- Blok15/17/26/31/32 için çoklu geometri chunk akışı.
- Base primitive7–10 ek stream/deformasyon semantiği (8 instance).
- Level materyalleri, görünürlük, sonraki RenderList'ler, yüksek LOD'lar.
- GPU instance buffer.

Kabul:

- Sabit offset veya tahmin yok; kaynak sırası korunur.
- Desteklenmeyen durumlar sayılarıyla raporlanır.
- Native/WASM/Python eşitliği ve regresyonsuz suite.
- Tek/14 instance kanıtı genel "tam pist" iddiasına dönüşmez.

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
