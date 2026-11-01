# NEXT — sıradaki görevler

Sıra bağlayıcıdır. Bir görev kapanmadan sonraki kod görevine geçilmez.

## 1. T-003 — Scene/level kapsamını genişletme

**Durum:** in-progress (blok27+15 toplam 18 instance; tarama tamam)
**Kart:** `docs/work/tasks/T-003-scene-traversal.md`

İlk artım: blok27'de **14 instance**, 7.308 vertex/6.106 üçgen.
İkinci artım: `requiredGeometryBlocks=[15,17,26,27,31,32]`; blok15 ek **4
instance** veriyor. Toplam **18 instance**, 8.688 vertex/7.085 üçgen. Blok17/26/
32 base stream semantiği, blok31 prerequisite nedeniyle 0/atlandı. Kalan iş:

- Base primitive11–35 ek stream/deformasyon semantiği (22+8 instance).
- Blok31 ek ChunkInfo prerequisite (1 instance).
- Level materyalleri, görünürlük, sonraki RenderList'ler, yüksek LOD'lar.
- GPU instance buffer.

Kabul:

- Sabit offset veya tahmin yok; kaynak sırası korunur.
- Desteklenmeyen durumlar sayılarıyla raporlanır.
- Native/WASM/Python eşitliği ve regresyonsuz suite.
- 18 instance kanıtı genel "tam pist" iddiasına dönüşmez.

## 2. T-004 — Native particle-cache izi

**Durum:** tam bellek dump'ı alındı ve analiz edildi; kaynak çağrı/efekt kimliği açık
**Rapor:** `docs/work/analysis/native-particle-crash.md`

Tam dump + çağrı izleme + kaynak analizi kök nedeni gösterdi:
- Emitter ile trail elemanı arasındaki bağ tek yönlü; sahiplik `iSalt` nesil sayacıyla yürüyor.
- `m_iSalt` yalnızca senkron `C_EmitterList::Free` içinde artırılıyor; ertelenmiş `C_Emitter::AtomicFree` / `AtomicActiveCache::AtomicFree` / drenaj `Free` salt'a dokunmuyor.
- `FreeParticle` X'i ertelenmiş yolla bıraktıktan sonra drenaj `Free` ediyor; salt artmadığı için aynı X'e işaret eden trail elemanı sonraki karede `iSalt == GetSalt()` (0==0) görüp X'i yeniden kuyruğa atıyor; ikinci `Free` invariant'ı tetikliyor.
Açık: düzeltme uygulanmadı; hangi iki drenaj sırasının (`UpdateSuperEmitters`/`UpdateSpawn`) sözleşmeyi ihlal ettiği ve salt artışının doğru yeri kaynakta belgelenmeli. Assert kaldırılmayacak. Sıradaki en küçük adım: `C_Emitter::AtomicFree` çağrılarını sahiplik devri/kendini bırakma olarak sınıflandırmak; gerekirse trace'e `pParticle`/trail indeksi eklemek.

## 3. T-005 — Tek oyunculu dikey dilim

**Durum:** planned

Platform/streaming, scheduler, fizik, kontroller, ses ve save; bir araç/bir pist
üzerinde tam yarış. Multiplayer bundan sonra.
