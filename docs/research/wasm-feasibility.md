# Blur Rebuilt → tarayıcı: teknik fizibilite

28 Ekim 2026. Salt okunur inceleme; derleme veya oyun testi yapılmadı. İncelenen canlı master: `5270304b81983b9e3edbd569ba25235c17bbabd7` (26 Ekim). Aşağıdaki öneriler mühendislik çıkarımıdır; çalışır tarayıcı portu kanıtı değildir.

## Sonuç

Rebuilt kullanılabilir bir motor kodu ve referans uygulama sağlıyor; fakat tam kaynaklı, bağımsız ve platformdan soyutlanmış bir SDK değil. Port için Windows platform katmanı, renderer/shader zinciri ve ağ taşıması değişmeli. İlk yatırım tam oyun portuna değil, **yeniden üretilebilir Windows derlemesi + gerçek oyun verisini tarayıcıda okuma + tek malzeme/render deneyi** olmalı. Bu üç kapı geçilmeden süre tahmini veya tüm oyunun taşınacağı taahhüdü verilemez.

## Kanıtlananlar ve açık sorular

- [CMakeLists](https://github.com/uKER/BlurRebuilt/blob/5270304b81983b9e3edbd569ba25235c17bbabd7/CMakeLists.txt) ve [ortak CMake](https://github.com/uKER/BlurRebuilt/blob/5270304b81983b9e3edbd569ba25235c17bbabd7/cmake/blur_common.cmake): MSVC dışı derleyiciye açık hata veriyor, WIN32 tanımları ve Windows sistem kütüphaneleri seçiliyor. Emscripten toolchain eklemek yeterli değil.
- [Build notları](https://github.com/uKER/BlurRebuilt/blob/master/docs/agent-reference/build.md): yaklaşık 70 hedef, 2.449 kaynak için Jam→CMake üretimi, özel header/Lua/shader üreticileri var. Eski özel Jambase eksikliği bu araçlarla aşılmış. D3DX, JPEG ve bazı SDK girdileri `_work/vendor` altında dışarıdan geliyor; boş checkout tek başına derleme ortamı değil. Bink film desteği stub; başlangıç videolarının atlanması bilinen davranış.
- [x64 notları](https://github.com/uKER/BlurRebuilt/blob/master/docs/blur1pcdx11/x64.md): DemonWare 2.0'ın sekiz kütüphanesi için kaynaklardan x64 build yolu var; ağ kodu sadece erişilemez x86 binary'den ibaret değil. Bununla birlikte OpenSSL 0.9.8i dış girdisi gerekiyor. Derlenebilirlik, modern tarayıcı ağ uyumluluğu anlamına gelmiyor.
- Kök seviyede tüm projeye izin veren LICENSE/COPYING dosyası API ağaç listesinde görünmedi; bazı vendor alt klasörlerinde kendi lisansları var. [AGENTS.md](https://github.com/uKER/BlurRebuilt/blob/master/AGENTS.md) açıkça sızdırılmış kaynaktan söz ediyor. Bütün deponun serbest kullanımlı açık kaynak olduğunu varsayamayız; bu bir hukuki karar değildir.

## Rebuilt'in asıl faydası

64 bit exe olması WASM için otomatik avantaj değildir. Asıl kazanım derleme araçları, pointer genişliği hatalarının bulunmuş olması, renderer davranışının belgelenmesi, kare hızından bağımsız fizik/zaman düzeltmeleri ve karşılaştırılabilir Windows sürümüdür.

Önerim ilk deneyin **wasm32** olması; bunu bir hedef kararı değil ölçülecek hipotez olarak alalım. Toplam kurulum boyutu, çalışan oyunun eşzamanlı lineer bellek ihtiyacı değildir. Önce yarışın CPU/GPU belleğini ve stream çalışma kümesini ölçmeliyiz. wasm64 seçilirse `_WIN64` ve Microsoft'un LLP64 veri modeli otomatik taşınmış olmaz. x64 dalındaki 128 bit CAS kuyruğunu da doğrudan koruyamayız.

[Kuyruk kaynak kodu](https://github.com/uKER/BlurRebuilt/blob/master/code/mercury/library/common/system/include/system/scheduler/jobqueue_task_queue_lf.h), x64 pointer+sayaç için `_InterlockedCompareExchange128` kullanıyor. [Atomic.h](https://github.com/uKER/BlurRebuilt/blob/master/code/mercury/library/common/core/include/core/threads/Atomic.h) Windows intrinsics'e bağlı. Web hedefinde atomikleri standartlaştırmalı, scheduler testleriyle veri yarışını doğrulamalıyız. Tek iş parçacıklı ilk loader deneyi mümkün olabilir; motorun tamamını tek iş parçacığına zorlamanın çalışacağı kanıtlanmadı. [Emscripten pthreads](https://emscripten.org/docs/porting/pthreads.html), SharedArrayBuffer için COOP/COEP başlıkları ve ana tarayıcı iş parçacığında bloklamama gerektiriyor.

## En büyük iş: renderer ve shader varlıkları

[DX11 CMake](https://github.com/uKER/BlurRebuilt/blob/master/cmake/dx11.cmake) sadece D3D11 çağrıları değil FX11 effects runtime, Windows SDK `fxc.exe`, shader varyant manifestleri, generated sabitler ve gömülü shader blob'ları içeriyor. DXBC/FX11 dosyaları WebGPU'ya doğrudan verilemez. Yeni backend'in texture/vertex formatlarını, constant-buffer yerleşimlerini, sampler/state bağlamasını ve shader giriş-çıkışlarını aynı anlamla üretmesi gerekiyor.

Öneri: Rebuilt'in `Display`/`Display2` arayüzleri arkasında WebGPU backend; ilk örnek authored HLSL'den çevrilmiş tek shader + gerçek mesh/texture. WGSL üretiminde araç seçimi henüz yapılmadı; otomatik çevirinin tüm efektleri kapsayacağı varsayılmamalı. Önce opak gövde, alfa testli malzeme ve ışıklandırma örnekleri Windows screenshot ile karşılaştırılmalı. WebGL2 alternatifini ancak gerekli özellik ve performans matrisi çıktıktan sonra değerlendirelim.

## Asset ve dosya sistemi: olumlu mimari nokta

[Motor mimarisi](https://github.com/uKER/BlurRebuilt/blob/master/docs/agent-reference/architecture.md), dosya erişiminin overlay sanal dosya sisteminde birleştiğini gösteriyor. Bu, bir web depolama adapter'ı eklemek için iyi bir sınır. Resource manager dışından açılan UI/font/FX dosyaları da aynı overlay'den geçiyor.

Repo asset üretim zinciriyle oyunun bütün verilerini yeniden üretmiyor; kurulu PC verileri gerekiyor. Plan: kullanıcı dosyalarından pak dizini, bir XT kaydı ve bir model okumak; tüm kurulumu MEMFS'ye kopyalamak yerine yerel tarayıcı depolaması ve seçili verilerin belleğe alınmasını ölçmek. Asenkron yüklemeler loader/thread akışıyla bütünleşmeli. Save dosyaları ayrı kalıcı depolamaya yazılmalı; tarayıcı kotası ve ilk yükleme süresi ölçülmeli.

## Ses, fizik ve kontroller

[engine_pc.cpp](https://github.com/uKER/BlurRebuilt/blob/master/code/mercury/library/audio/source/core/engine_pc.cpp) DirectSound output buffer, CreateThread ve Sleep tabanlı doldurma içeriyor. Gerçek output için OpenAL kullandığını varsaymak yanlış. Mixer'i koruyup WebAudio/AudioWorklet output adapter'ı yazmak aday yaklaşım; decode kaynakları ve tüm codec ihtiyacı ayrıca envanterlenmeli.

Gravity fizik kaynakları ve SIMD/math katmanları taşınabilirlik sınavından geçmeli. [Emscripten SIMD](https://emscripten.org/docs/porting/simd.html) bazı SSE intrinsics'i desteklese de tüm x86 intrinsics/instruction davranışına garanti vermez. İlk fizik kabulü: aynı sabit girdilerle Windows ve WASM'de kısa sürüş/çarpışma izlerini toleransla karşılaştırmak. Bit düzeyinde deterministik olduğuna göre ağ mimarisi kurmayalım. XInput/DirectInput yerine browser Gamepad/klavye adapter'ı, focus kaybı ve kullanıcı hareketi sonrası ses başlatma akışı gerekir.

## Multiplayer: önce LAN mantığı, yeni taşıma

[Canlı README](https://github.com/uKER/BlurRebuilt/blob/5270304b81983b9e3edbd569ba25235c17bbabd7/README.md) v1.5'te Amax Emu online desteği bildiriyor. **Önceki araştırmada alıntılanan “yarış doğrulanmadı” paragrafı bu sürümde yok; bunu güncel kesin durum olarak tekrarlamamalıyız.** Buna karşılık recursive kaynak ağacında `AmaxClientHost` kaynağı bulamadım. Kaynaktaki [NetRouter_pc.cpp](https://github.com/uKER/BlurRebuilt/blob/master/code/amax/library/Network/Router/NetRouter_pc.cpp) hâlâ eski DemonWare/Win32 yolunu içeriyor. Release paketinin güncel online entegrasyonunun kaynakla nasıl eşleştiği açık soru; Windows helper exe tarayıcıda çalıştırılamaz.

Arkadaş grubu için aday mimari: mevcut yarış paketleme/senkronizasyonunu korumak; lobby/signaling için HTTPS/WebSocket; yarış verisi için WebRTC DataChannel + gerektiğinde TURN. Önce LAN yolunun DemonWare'den ne kadar ayrıldığı, paket boyutu/sıklığı ve host otoritesi ölçülmeli. UDP broadcast discovery yerine açık oda kodu kullanılabilir. Alternatif WebTransport datagram + relay de değerlendirilebilir. [Emscripten networking](https://emscripten.org/docs/porting/networking.html), doğrudan UDP'nin olmadığını, tam soket proxy'sinin ek maliyet taşıdığını ve daha çok debug amaçlı olduğunu belirtiyor. AMAX'a bağlanmak arkadaşlarla yarışmak için zorunlu ilk hedef yapılmamalı.

## İlk deneyler ve durdurma kapıları

1. **Yeniden üretilebilir Windows referansı:** sabit commit, eksik dış girdilerin listesi, temiz build, bir yarış, peak RAM/VRAM, frame-time, veri okuma ve paket ölçümleri. Kaynak/release eşleşmezse bunu önce çöz.
2. **Gerçek veride WASM loader:** ayrı küçük hedef; pak indeksini aç, bir XT kaydını ve model chunk'ını Windows ile eş sonuçta oku. Başarı: aynı içerik hash/alanlar, taşma ve bağımlılık hatası yok. Tüm oyun dosyasına şimdiden ihtiyaç duymayan derleme/uyumluluk envanteri bununla paralel yürüyebilir.
3. **Bir gerçek materyal çizimi:** WebGPU + çevrilmiş shader; Windows referansına yeterli görsel yakınlık ve makul bellek. Efekt kaynağı/asset formatı eksikse renderer planını yeniden değerlendir.
4. **Headless fizik:** sabit zaman adımı, kontrollü girdiler; Windows/WASM farkı ve SIMD performansı kabul edilebilir olsun.
5. **Tek pist/tek araç yarış:** ses/input, streaming, save ve uzun oturum. Önce masaüstü Chromium hedefleyelim; mobil destek ayrı kapsam.
6. **İki tarayıcı:** önce LAN benzeri yerel test, ardından farklı ağlardan TURN ile tam yarış; gecikme, kopma ve yeniden bağlanma senaryoları.
7. Sonuçlar olumluysa özel oda arayüzü, domain/CDN ve daha geniş pist/araç testleri.

En yüksek riskler sırasıyla renderer/shader kapsamı; platform/SIMD/scheduler; veri belleği ve streaming; yarış protokolü/AMAX kaynak eşleşmesi. Salt fiyatı düşük bir VPS bunları çözmez. Zaman tahmini ilk üç deneyden sonra yapılmalı.

## Alternatif

[BottleShip](https://github.com/jenissimo/bottleship), x86 Windows exe'lerini Win32/D3D uygulamasıyla tarayıcıda çalıştırmayı hedefliyor. README'de Blur uyumluluğu bulamadım. Orijinal x86 Blur için kısa bir uyumluluk deneyi olabilir; x64/DX11 Rebuilt aynı hedef değildir. Performans, eksik Windows API'leri ve multiplayer desteği kanıtlanmadan ana plan olarak alınmamalı.
