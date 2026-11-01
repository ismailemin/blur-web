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

**Durum:** tam bellek dump'ı alındı ve analiz edildi; kaynak çağrı/efekt kimliği açık
**Rapor:** `docs/work/analysis/native-particle-crash.md`

Tam dump doğruladı: `m_ActiveElements=93`, `m_VectorPosition=-1`; silinen
`m_Deleted[0]` aynı zamanda `m_Cache[162]` içinde — çift serbest bırakma
doğrudan kanıt. Hangi iki `Free`/`AtomicFree` çağrısının çakıştığı, efekt kimliği
ve thread çakışması hâlâ açık. Sıradaki en küçük adım: dump içinde sahip
tanım işaretçisini ve komşu partikül kayıtlarını çözerek bayat referans
hipotezini test etmek. Assert kaldırılmayacak.

## 3. T-005 — Tek oyunculu dikey dilim

**Durum:** planned

Platform/streaming, scheduler, fizik, kontroller, ses ve save; bir araç/bir pist
üzerinde tam yarış. Multiplayer bundan sonra.
