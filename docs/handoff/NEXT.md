# NEXT — sıradaki görevler

Sıra bağlayıcıdır. Bir görev kapanmadan sonraki kod görevine geçilmez.

## 1. T-002 — Level instance dönüşümleri

**Durum:** planned (T-001 kapandı)
**Kart:** `docs/work/tasks/T-002-level-instances.md`

Amaç: `level_instances_inspect` ile River block27/node253 ilk instance'ını,
ardından node253'teki 57 instance'ı dönüşümleriyle çizmek.

Kabul:

- İlk instance: 805 vertex / 726 üçgen; dünya sınırları arşivle ≤ `1e-4`.
- Constant-affine olmayan, dinamik veya eksik matrisler açıkça reddedilir.
- Native/WASM/Python karşılaştırması; `instancesApplied:true` yalnız desteklenen
  kapsam için.
- Browser'da dönüşüm uygulanmış gerçek sahne parçası; tam pist iddiası yok.

## 2. T-003 — Scene/level kapsamını genişletme

**Durum:** planned (T-002'ye bağımlı)

Amaç: `TextureSource` sonrası ChunkData, sonraki node'lar, ek RenderList'ler,
resource LOD'ları, level materyalleri ve görünürlük. Hedef: geometri + instance +
doku ile tutarlı bir pist parçası.

Kabul:

- Sabit offset veya tahmin yok; kaynak sırası korunur.
- Desteklenmeyen durumlar sayılarıyla raporlanır.
- Native/WASM/Python eşitliği ve regresyonsuz suite.

## 3. T-004 — Native particle-cache izi

**Durum:** ilk analiz tamamlandı; tam bellek izi açık
**Rapor:** `docs/work/analysis/native-particle-crash.md`

İlk bulgu: `m_ActiveElements=14`, `m_VectorPosition=-1`; aynı emitter ikinci kez
serbest bırakılmış. Tam `m_Cache`/`m_Active` dizileri ve tüm thread context'leri
dump'ta yok. Sıradaki: tam bellek dump'ı, sınırlı Free/AtomicFree izi ve girişsiz
A/B koşu. Assert kaldırılmayacak.
