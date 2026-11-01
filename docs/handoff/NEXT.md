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

Tam dump + çağrı izleme doğruladı: `m_ActiveElements=93`, `m_VectorPosition=-1`;
silinen eleman aynı zamanda `m_Cache[162]` içinde. Ölümcül sıra:
`UpdateSpawn` drenajı X'i serbest bırakıyor → `SuperEffect::FreeParticle`
(AtomicFree) araya ayırma girmeden aynı X'i tekrar kuyruğa atıyor →
`UpdateSuperEmitters` drenajı ikinci kez `Free` ediyor. Yani aynı cache bir
karede iki kez boşaltılıyor ve trail elemanı bırakılmış emitter'ı tutuyor.
`iSalt=0` koruması `GetSalt()==0` olduğu için devreye girmiyor. Açık kalan:
`C_Emitter::Update`/`m_bDelete` ile `FreeParticle` arasındaki sahiplik
sözleşmesi; trail referansının neden geçersiz kılınmadığı. Sıradaki en küçük
adım: kaynakta bu sözleşmeyi belgelemek; gerekirse `FreeParticle` etiketine
`pParticle`/blok indeksi eklemek. Assert kaldırılmayacak.

## 3. T-005 — Tek oyunculu dikey dilim

**Durum:** planned

Platform/streaming, scheduler, fizik, kontroller, ses ve save; bir araç/bir pist
üzerinde tam yarış. Multiplayer bundan sonra.
