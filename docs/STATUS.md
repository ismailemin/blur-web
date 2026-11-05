# Blur Web — çalışma kaydı

## 28 Ekim 2026 — ilk hazırlık

- Hedef: Orijinal Blur'un oyun mantığı ve verilerini kullanarak masaüstü tarayıcıda arkadaş grubuyla yarışmak. İlk hedef masaüstü Chromium; mobil ayrı değerlendirilir.
- Hedef açıklığı: motor/oyun mantığı her oyuncunun kendi tarayıcısında WASM olarak çalışır. Windows build yalnız geliştirme referansıdır; nihai oyuncunun Windows exe kurması hedeflenmez. PLAN.md bu ayrımı açıkça belirtir.
- Kaynak: `upstream/BlurRebuilt`, uzak depo `https://github.com/uKER/BlurRebuilt.git`.
- Başlangıç commit: `5270304b81983b9e3edbd569ba25235c17bbabd7`. Kaynak checkout'u değiştirilmedi.
- Üç ajan: Windows araç/SDK envanteri; gerçek veriyle ilk tarayıcı deneyi; LAN/multiplayer kod yolu.
- Paket indirmesi kullanıcıda devam ediyor. Oyun verisi henüz kurulmadı veya çalıştırılmadı.
- Bundled Python ile Jam açıklaması çıkarımı çalıştırıldı. Çıkış 0; 70 hedef, desteklenen hedeflerde 2.260 kaynak, 76 Jam dosyası. Bu C++ derleme veya çalışma başarısı değildir.
- Çıktı: `_work/preflight/targets_pc_speed.json`. Bir eksik kaynak, 18 eksik include dizini, iki uyarı raporlandı. Bunların bazıları eski build tanımı/harici SDK kaynaklı olabilir; ayrıntılar Windows raporunda değerlendirilir.
- `tools/inspect_game.py`: oyun klasörünü değiştirmeden dosya boyutu, isteğe bağlı SHA-256 ve PE mimarisi kaydı. Hiçbir oyun exe'sini çalıştırmaz.
- Araç, sentetik iki dosyalı fixture üzerinde doğrulandı: dosya sayısı/boyutu, SHA-256, x64 PE tanıma, mevcut manifest üzerine yazmayı ve oyun klasörüne çıktı yazmayı reddetme kontrolleri geçti. Bu oyun uyumluluğu testi değildir.
- Üç rapor tamamlandı: `docs/setup/windows-build.md`, `docs/plan/browser-probe.md`, `docs/plan/multiplayer.md`. Tam plan `PLAN.md`.
- Kaynak sürümü `docs/source-lock.json`, build çıkarımının eksik/uyarı özeti `docs/setup/source-preflight.json` içinde.
- İlk yerel C++ engeli: standart konumlarda MSVC/Visual Studio, Windows SDK ve CMake bulunamadı. Küçük ilk derleme hedefi `dx11_hdr_reference`; eski `tools/build.sh` yerine x64 release workflow referans alınacak.
- GitHub hesabı, domain, VPS ve cloud GPU bu aşamanın ön koşulu değil. Public kaynak okunabiliyor. Kalıcı özel uzak depo yedekleme aşamasında seçilir.
- Derlenmiş oyun, çalışan WASM, render veya multiplayer teslim edilmedi.

## Sıradaki işler

1. Windows C++ derleyicisi/SDK eksiklerini rapora göre tamamla; oyun indirmesi ile büyük araç indirmelerini aynı anda zorlamadan sırala.
2. Dış kütüphane sürüm ve kökenlerini sabitle; x64 build komutunu geliştiricinin sabit yerel yollarından bağımsızlaştır.
3. Oyun verileri geldiğinde manifest çıkar, kontrollü Rebuilt referans testi yap.
4. Kaynaktan Windows derlemesi ile release'in eşleşmesini doğrula; ardından WASM paket-okuma ve render deneyine geç.

## 28 Ekim 2026 — Visual Studio Build Tools kurulumu başlatıldı

- Kullanıcı kurulumu açıkça istedi. Winget resmi kaynağından `Microsoft.VisualStudio.2022.BuildTools` 17.14.42 seçildi; bootstrapper SHA-256 kontrolü winget tarafından geçti.
- İstenen bileşenler: `Microsoft.VisualStudio.Workload.VCTools`, önerilen bileşenler ve `Microsoft.VisualStudio.Component.VC.CMake.Project`. Parametreler `--quiet --wait --norestart`.
- Kurulum arka planda başlatıldı; bootstrapper logu installer paketinin indirilmesi ve imza kontrolünün başarılı olduğunu gösteriyor. Tam kurulumun tamamlandığı henüz doğrulanmadı.
- Winget logu: `_work/setup/winget-vs-buildtools.log`. Aktif komut oturumu: 18885. Sonraki kontrolde oturum sonucu, `vswhere` bileşenleri ve gerçek `cl`/CMake/SDK yolları doğrulanmalı.
- Yeniden başlatma otomatik yapılmayacak.

## 28 Ekim 2026 — oyun ISO'su ulaştı

- Yol: `C:/Users/ismailemin/Downloads/Blur-ViTALiTY/vty-0308.iso`.
- Boyut: 5.588.510.720 bayt, torrent metadatasındaki ISO boyutuyla eşleşiyor.
- SHA-256: `57AD5483DB8832D1D9C93AC3E4A1844059197E0601DBCE2B70FA4B672BB9B1F7`. Kendi hesapladığımız kayıt; güvenilir DVD hash'iyle karşılaştırma yapılmadı, güvenlik/orijinallik kanıtı değil.
- Windows tar ile içerik listesi okunabildi; çok dilli Docs, Setup/Data, Setup/rsrc, Activision(R).msi ve ViTALiTY klasörleri mevcut. Hiçbir kurulum exe'si çalıştırılmadı.

## 28 Ekim 2026 — kullanıcı temel oyunu kurdu

- Windows uninstall kaydı: `Blur(TM)`, sürüm `1.00.0000`, tarih `20261028`.
- Kurulum yeri: `C:/Program Files (x86)/Activision/Blur(TM)/`.
- `Blur.exe`, `binkw32.dll`, `english.txt`, `cache`, `levels`, `UI`, `Docs` mevcut. Ana cache paketleri listelendi.
- Yerel dosya manifesti: `_work/game-manifests/retail-installed-20261028.json` (hash hesaplanmadan envanter).
- Oyunun açılışı veya yarış henüz test edilmedi. Bu kayıt yalnız kurulumun ve veri dosyalarının varlığını doğrular.

## 28 Ekim 2026 — Rebuilt v1.5 açılış testi geçti

- GitHub release v1.5 paketi indirildi; SHA-256 `5e705dae16df1a7a9cba84a36b05a2b6dc609bf6c8fa29e8e5ad09f13117d062`, GitHub asset digest'iyle eşleşti.
- Program Files yazma izni reddedildiği için orijinal kuruluma dokunulmadan çalışma kopyası `game-data/Blur/` altına alındı. `BlurRebuilt.exe` ve `fx11/` buraya eklendi.
- Paket yalnız exe + fx11 + README içeriyor; güncel master README'de sözü edilen `AmaxClientHost.exe` v1.5 zip'inde yok. Offline açılışı engellemedi; online entegrasyon ayrıca çözülmeli.
- x64 VC++ runtime mevcut (`v14.51.36247.00`). Rebuilt süreç PID 28888 ile açıldı; Computer Use ile başlangıç ekranı ve single player/multiplayer ana menüsü görüldü.
- Kanıt: `_work/verification/rebuilt-v1.5-main-menu.png`. Görüntüde overlay 144 FPS gösteriyor; bu yalnız menü anlık değeri, yarış performans ölçümü değil.
- Kullanıcı oyun penceresinde giriş yaptı; başka input gönderilmeden mevcut menü durumu doğrulandı. Süreli test launcher'ı ayrıştırıldı, oyun açık bırakıldı. Yarış/fizik/ses/multiplayer henüz doğrulanmadı.
- Visual Studio Build Tools 2022 17.14.42 için `vswhere`: `isComplete=true`, `isLaunchable=true`, `isRebootRequired=false`. C++ probe henüz derlenmedi.

## 28 Ekim 2026 — ilk gerçek tarayıcı modülü

- Kullanıcı Rebuilt Career yarışını oynayıp çalıştığını bildirdi. Bu kullanıcı gözlemidir; otomatik yarış/fizik performans ölçümü değildir.
- MSVC x64 + SDK 10.0.26100 ile upstream'in `dx11_hdr_reference` hedefi başarıyla derlendi. Tam motor derlemesi henüz yapılmadı.
- Resmi emsdk 6.0.13 kuruldu/yerel olarak etkinleştirildi; global PATH değişmedi. Emscripten sürümü build metadata'sında sabit.
- Sıfırlama sonrası iki ajan yeniden başlatıldı: PAK C++ uygulaması/bağımsız karşılaştırma, gerçek model envanteri/model C++ uygulaması. Root CMake, toolchain, browser UI/server ve entegrasyon testlerini yaptı.
- `probes/asset-reader/`: bağımsız C++17 PAK indeksi ve model blok okuyucusu. Native x64 ve wasm32 derlemeleri başarılı. CTest iki test hedefi de geçti (PAK geçerli/bozuk/sınır örnekleri; model başlık/parent/depth/count sınırları).
- Kurulu yedi cache PAK dosyasının native/WASM JSON sonuçları eşleşti; V1 ve V2 dahil. Altı V2 pak için bağımsız Python diagnostic ile 5.519 kayıt/33.114 alan eşleşti.
- Gerçek root.pak (559.652.864 bayt) içindeki 3.601 kayıt, tarayıcıda 319.488 baytlık son prefix kullanılarak okundu. Bu 533,73 MiB dosyada312 KiB indeks okumasıdır; kademeli okumanın toplam transferi319.552 bayt.
- Gerçek trafficcylinder.model tek packet-zlib paketi 3.424 bayttan8.015 bayta tarayıcıda açıldı. Native/JS-Python byte karşılaştırması ve native/WASM model JSON karşılaştırması geçti. SHA-256 fixture kimliği `57f28fb4026a638c2a93469148b8597ebf93ac79c22acd3c836d58e32fc1565b`.
- Browser arayüzünde dosya filtreleme, boş arama, kurulu paket seçimi, model bloklarını açma test edildi; console error yok. Yerel range endpoint sınır reddi ve WASM MIME/magic kontrolleri geçti.
- Yerel sunucu: `http://127.0.0.1:8765/`, komut oturumu85389. Yalnız loopback ve web klasörü + whitelist oyun paketi aralıkları. Sekme kullanıcıya açık bırakıldı.
- Kanıt: `_work/verification/browser-pak-model.jpg`; test JSON'ları aynı klasörde. Çalıştırma/derleme adımları `probes/asset-reader/README.md`.
- Yerel root Git deposu başlatıldı; commit veya push yapılmadı. Oyun verileri, SDK, upstream checkout ve generated WASM Git dışında.
- Sınır: yalnız metadata ve seçili <=64KiB tek paketli model blokları; geometri çizimi, genel extraction, XT import, imza/hash doğrulaması, fizik ve web multiplayer yok. Orijinal oyun/veri/source checkout değiştirilmedi.

## 30 Ekim 2026 — gerçek geometri ve özgün doku tarayıcıda

- `scene_reader` artık sabit offset/SHA seçimi yerine gerçek ARCH serializer sırasını izliyor. Kapsam: ilk resource block, ilk RenderList, LOD0 temel geometrisi; instance/dünya dönüşümleri ve sonraki düğümler uygulanmıyor. JSON bu sınırı açıkça bildiriyor.
- 28 gerçek modelin native/WASM sonuçları eşleşti;24 geometri başarılı,4 açık unsupported. 21 modelin74 çiziminde özgün albedo ilişkisi çözüldü. Vertex/index buffer referansları Node source-list üzerinden doğrulanır; byte tabanlı stream offseti doğru uygulanır.
- İlk gerçek trafficcylinder100vertex/114üçgen/342index. Bağımsız Python konum/index bayt hashleri C++/WASM ile eşleşti. Geçerli vertex değiştirilince yeni geometri okunuyor; genel okuyucu fixture kimliğine bağlı değil. Eski SHA korumalı fixture okuyucusu bağımsız kontrol olarak tutuldu.
- PC `.texture` ve gömülü TextureDesc+texeller için BC1/2/3 ve seçili ham formatlar RGBA'ya çevriliyor. 2D,<=512×512. `.xt` doku değildir; derlenmiş oyun/UI verisidir.
- Özgün trafficcylinder materyali iki draw için stream material ->g_tAlbedo ->TextureSource ->sharedtexture0 ilişkisiyle çözüldü. Gömülü trafficcylinder_diff16×128BC1,1444bayt; özgün F16_2UV0 korunur, V-flip yok. 8192RGBA baytı Pillow ile tamamen eşleşir. Özgün shader yerine tanılama aydınlatması kullanılır; en büyük mip seviyesi çiziliyor.
- Gerçek geometri, özgün albedo dokusuyla WebGPU'da çizildi. Ayrıca gerçek coneb146vertex/152üçgen tanılama yüzeyi, tel kafes ve bağımsız arrow.texture önizlemesi görsel doğrulandı. GPU console error/warning yok.
- Kanıtlar: `_work/verification/browser-original-material.jpg`, `browser-first-mesh-wire.jpg`, `browser-general-cone.jpg`, `browser-first-texture.jpg`. Genel okuyucu/doku/packet testleri aynı klasörde JSON olarak kayıtlı.
- Packet-zlib okuyucu<=16MiB çok paketli varlıklara genişletildi. Gerçek2/4/30paketli modellerin tamamı Python ve JS arasında bayt bayt eşleşti. Ham blok, son kısmi ham blok, sınırdaki boş son DEFLATE paketi, bozuk uzunluklar, çıktı limiti ve iptal kontrolleri geçer.
- `tools/verify_asset_probe.py`16aşamayı geçti. Son BitVector düzeltmesinden sonra9/9nativeCTest ve28model native/WASM +4gerçek doku karşılaştırması yeniden geçti. BitVector Vector<U8> olarak okunur;512bit/64bayt ve fazla rezerve bayt testleri eklendi.
- Sunucu yeniden açıldı: `http://127.0.0.1:8765/`, execoturumu75719. Kaynak/oyun dosyaları değişmedi, commit/push yok.

## 30 Ekim 2026 — sonraki aşamaların somut durumu / limit sonrası devam noktası

- Kullanım limiti nedeniyle üç ajan da aynı turda durdu. Yeniden başlatmadan önce diskteki çıktıları esas al; tamamlanmamış XT/native/car işleri başarılı diye raporlanmayacak.
- Ayrı native kaynak worktree: `_work/native-source/Blur1PCDX11`. Managed worktree aracı nested kaynak root'unu kabul etmedi; Git worktree kullanıldı. Orijinal `upstream/BlurRebuilt` hâlâ temiz. Isolated worktree tutulacak.
- Ayrı kopyada19üretilmişcpheader,70targetunity,139Lua script bundle ve693SM3shader varyantı üretildi. Resmi/pinlenmiş bağımlılıklar `_work/vendor/` altına alındı; global PATH değiştirilmedi. OpenSSL0.9.8i x64 no-asm derlemesi geçti; x64CMake configure/generate başarılı. Win32blur_shims hedefi geçti.
- Tam x64Amax derlemesi **başarılı değil**: `_work/native-source/Blur1PCDX11/_work/build/amax-x64.log:11039`, framework/ApplicationPC.cpp için `atlbase.h` eksik C1083. Sonraki adım VS2022MSVC ATL bileşeni. Agent'ın son notu: SM3shadergen sonrası gen_cmake yeniden çalıştırılmalı; aksi halde14üretilmişshaderCPP listede eksik kalabilir. Sonra configure/build ve errsum, exe/PDB doğrulaması. Oyun başlatılmadı.
- Gerçek araç adayı: root.pak içindeki `corvette_c3_race.model`,3.169.212açılmışbayt/49paket. Fixture `_work/car-level-assets/77840511e5ca416ff9e7cbdc9ee9fc960fce0205f83c9be77e0803607c32cb9d.decoded`. BitVector düzeltmesinden sonra kalan engel `Unsupported position vertex format` byte2042579. Konum formatı ve özgün shader decompression dönüşümünü kaynakla çözmeden değer tahmini yapılmayacak.
- `tools/inspect_car_level_assets.py`19level.levelrender başlığını/stream tablosunu okuyup companion.levelstream aralıklarını doğruladı. Showroom145block31chunk; küçük spa_barcelona_bowl_multiplayer382block84chunk. `_work/car-level-assets/inventory.json`36MB; tamamını bağlama yükleme, seçilmiş alanları oku. root_streaming.pak66BAFses varlığı içerir, araç modelleri değildir.
- XT ajanı yalnız kaynak incelemesi yaptı; native/WASM modülü henüz yok. Format schemaheader72;Type12/Base4/Field8/Ref8/Record16/Component6bayt;XtIdU32; PCetiketi KSLF. Yararlı aday: gamedata.pak codec2zlib `\gamedata\levels\vehicletestscene\actorpack.xt`1228açılmışbayt. Sonraki adım bounded XTmetadata C ABI +fixture/native/WASM karşılaştırması; genelreflectionimport ayrı.

### Sıradaki uygulama sırası

1. ATL bileşeni/native referans derlemesi ve generator sırası; derleme logundan devam.
2. Gerçek Corvette vertex position formatı; ardından tarayıcıda araç gövdesi. Mevcut Scene okuyucu ilk düğümle sınırlı, tüm aracı çizdiğini iddia etme.
3. Level Scene/stream kaynakları, ek düğümler/instance dönüşümleri ve XT metadata; sonra gerçek showroom/küçük pist.
4. Fizik, sürüş, ses ve multiplayer hâlâ açık; mevcut başarı bir oyun motorunun bütünüyle taşındığı anlamına gelmez.

## 30 Ekim 2026 — devam: Corvette gövdesi, XT ve tam x64 derleme

- Corvette'in POSITION0 verisi F16_4 (tip9), method0; özgün `vehicle_common.h` MainVS, W alanını1 yapıyor. XYZ için ek ölçek/bias yok. İlk10 global VB bu biçimde; kaynakta isteğe bağlı hasar/deformasyon bu görüntüleme deneyinde uygulanmıyor.
- Scene okuyucu POSITION0'ın bildirimindeki stream'i seçiyor; ilk stream'i varsaymıyor. Kaynak listelerindeki gerçek VB eşlemesi ve byte offset/stride korunuyor. Sadece konum stream'inin kullandığı global VB'ler birleştiriliyor; teğet/hasar akışları uygulanmıyor. F16_4 UV0'ın ilk iki bileşeni tanınıyor. Frekanslı instancing hâlâ açık unsupported.
- Corvette: **30.591 vertex,36.193 üçgen,80 draw**. Native/WASM JSON ve bağımsız Python konum/index verisi tamamen eşleşti. Konum F32LE hash `318260f08a06754c191df26b4275a715f8d545a2e251d1800682a30c67697ff8`; index U32LE hash `dcf9852110002000edfe482676fc3ed4c8de450a7feb7a3db8e71404994cdd1d`.
- Gerçek Corvette gövdesi WebGPU'da tanılama yüzeyiyle görüldü; console error/warning yok. Kanıt `_work/verification/browser-corvette-body.jpg`. Özgün araç boyası/materiali, tekerlek modeli yerleşimi, hasar ve sürüş henüz uygulanmadı. Genel küçük model corpus sonucu26/28'e yükseldi.
- Kamera, gerçek geometriyi ekranın en-boy oranına göre çerçeveliyor; uzun araç ile ince direk aynı sabit uzaklığa zorlanmıyor. Dar/geniş ekranlarda bütün sınır noktalarının görünmesi matematik testinde doğrulandı.
- XT metadata C++/WASM modülü eklendi: PC FLSK v1/v2 tablo/şema/record sınırları. Üç gerçek actorpack dosyası native/WASM/bağımsız Python arasında eşleşti;11 bozuk XT örneği reddedildi. Aktör nesneleri, pointer fixup ve runtime reflection **oluşturulmaz**.
- Tarayıcı gerçek gamedata.pak zlib/secure-FAT indeksinden vehicletestscene actorpack'i açtı:19tip/31alan/1LevelActorList kaydı. Veri bütünlüğü/imzalar doğrulanmış sayılmıyor. Ham/zlib/packet-zlib için bounded JS decoder yolu var; CRC/çıktı boyutu/bozuk paket testleri geçti.
- Asset-reader native CTest11/11 geçti. Yeni testler `verify_car_wasm.mjs`, `verify_xt_wasm.mjs`; kanıtlar `_work/verification/car-native-wasm.json`, `xt-native-wasm.json`.
- **Tam Amax x64 Release derlemesi başarılı:** exit0/errsum0, AMD64PE32+. 1.254FX11 efekt ve693DX11 shader üretimi geçti. ATL, resmi Microsoft paketlerinden hash karşılaştırmasıyla `_work/vendor/atl-v143-14.44` altına çıkarıldı; UAC/global kurulum gerekmedi.
- İzole kaynakta mevcut inline gövdeler için gerekli iki `.inl` include ve cross-TU fonksiyonun `inline` niteliği düzeltildi; algoritma gövdeleri değişmedi. Kaynak üretim sırası düzeltildi ve14shaderCPP hedefe dahil. Orijinal upstream temiz. Patch ve bütün build kanıtları `_work/build/engine-reference/` altında; ayrıntılar `docs/setup/native-source-build.md`.
- EXE SHA256 `46f7214440d619db80301b948f8cd55a293aa6bb5ab3b0b68c44eadc43bc8d59`; PDB SHA256 `e69c9e8170831c66d6d84692960ce2ac0b50482d93106d5115104b4c84f07067`. Native kaynak build'in açılış testi ayrı özel runtime ile hazırlanıyor; henüz geçti diye raporlanmadı.
- Pist için ilk doğru ilişki bulundu: river geometri block252/chunk157, node bilgisi block253/chunk53. Bağımsız Python gerçek5direct primitive'den344vertex/208üçgen çıkardı. Instance'lar henüz çizilmez; yalnız geometri chunk'ındaki bütün indexleri tek topoloji sanmak yanlış. `level_mesh_inspect` C++ entegrasyonu texture_reader ajanında devam ediyor; model Scene dosyası o ajana devredildi, root eşzamanlı düzenlemeyecek.

Güncel sonraki adım: gerçek pist parçasını header + geometri chunk + node chunk üzerinden C++/WASM ve WebGPU'ya bağla; native kaynak build smoke testini doğrula. Sonra araç materyalleri/tekerlek yerleşimi ve pist instance dönüşümleri. Fizik ve oynanabilir yarış hâlâ açık.

## Son devam doğrulaması — ilk gerçek levelstream geometrisi

- Önceki limitte yarım kalan `level_index_inspect` ve `level_mesh_inspect` C ABI'leri tamamlanmış kaynak ve testlerle denetlendi; `/W4 /O2` temiz. Root, WASM export'larını, native CLI/CTest'i ve tarayıcı bağlantısını tamamladı.
- River Scene indeksinde359akış kaydı var. Kaynak ChunkInfo'dan türetilen byte aralıklarıyla geometri block252/chunk157 (10.240bayt) ve node block253/chunk53 (26.624bayt) okunuyor. Sabit dosya offseti veya sahte model wrapper'ı kullanılmıyor; demo için seçili block ID'leri açıkça sabit.
- Üç özgün girdi (levelrender + iki levelstream aralığı) **344vertex,208üçgen,5doğrudan çizim** üretiyor. Native/WASM JSON ve bağımsız Python konum/index dizileri ve hashleri tamamen eşleşti. Kaynak dosyalardaki gerçek aralıklar da fixture baytlarıyla karşılaştırıldı.
- Ayrı Reader/origin kullanımı, Header EffectVariation'ın gerçek C_String biçimi, byte tabanlı BitVector ve node source-list bağları denetlendi. Yanlış bloklar, takas edilmiş chunk'lar, kesilmiş girdiler, item sayısı, NaN konum, index sınırı ve source-vector bozulmaları reddediliyor. İlk LOD0 öğesi seçimi JS/native sözleşmesinde eşleşiyor.
- Kapsam: seçili düğümün doğrudan çizimleri.57instance,36instance base primitive, diğer resource/LOD öğeleri, materyaller ve görünürlük uygulanmıyor; JSON bunu sayılarıyla bildiriyor. Görüntü ilk sahne nesneleridir, tam yol/pist görüntüsü veya sürüş değildir.
- Brave üzerinde gerçek WebGPU yüzey çizimi görüldü; console error/warning yok. In-app browser bağlantısı mevcut olmadığı için kullanılabilir Brave bağlantısına geçildi. Kanıtlar: `_work/verification/browser-river-first-piece.jpg`, `browser-river-piece-detail.jpg`. Canlı sekme localhost8765'te çıktı olarak açık bırakıldı.
- `tools/verify_asset_probe.py`: **23aşamanın tamamı geçti**. Native CTest: **12/12**. Kurulu19pistin indeksleri bağımsız Python ile,28model corpus ve Corvette önceki native sonuçlarla eşleşiyor. Veri, shader/runtime ve oyun verisi Git'e eklenmedi; commit/push yok; orijinal upstream temiz.
- Sunucu yeniden başlatıldı, execoturumu55526. Yalnız loopback; üç whitelist level için sınırlandırılmış info/range endpoint'leri eklendi. Geçerli gerçek byte aralığı ve yedi hatalı/path/sınır sorgusu HTTP testinde doğrulandı.
- Native runtime audit'i tamamlandı: startup ve debug-menu testleri8s/exit0/timeout yok. Test edilen client-only developer-listener ayarlı EXE hash'i `e9727929768d1e8e2b41ec6abfa836c413d4cd397e571c8b9ba1129c91a5a254`; ilk derleme hash'inden farklıdır ve bu ayrım `native-runtime-evidence.json` içinde kayıtlıdır.5.113oyun dosyasının yol/boyut/mtime kayıtları ve önceden kaydedilmiş iki kullanıcı settings/save hash'i değişmemiş. Yeni audit sırasında oyun çalıştırılmadı. Yarış/fizik/ses çıkışı/multiplayer hâlâ doğrulanmadı.

### Yeni somut devam noktası

1. Corvette materyal eşlemesi: gövde shader'ındaki `_a` varyantı NO_ALBEDO'dur; gövdeyi rastgele gömülü diffuse dokuya bağlama. Özgün boya `g_sPaintMaterialTexture` runtime lookup'undan gelir. Statik dokulu araç çizimleri `g_MeshTexture` kullanır; mevcut `g_tAlbedo` yolu yeterli değildir. `car_materials_resume` ajanı yalnız bağımsız `tools/inspect_car_materials.py` ve `docs/plan/car-materials.md` üzerinde çalışıyor; C++/web entegrasyonu henüz yok.
2. Tek VB'de UV0 eksik diye tüm modelin UV dizisini silen mevcut sınırlamayı çizim bazında ele al; eksik UV'li çizimleri dokusuz tut. Stream materyallerinin gerçek uygulama sırasını ve placeholder vertex buffer'ın materyal etkisini koru. Boya renklerini/UV'leri tahmin etme.
3. Pistte daha fazla resource/instance ve dönüşüm, doku bağımlılıkları ve showroom/küçük pist bütünü; ardından özgün fizik/sürüş/ses ve iki oyunculu yarış. İlk levelstream geometri bağlantısı artık tamamlandı.

## 1 Kasım 2026 — geniş sahne parçaları ve statik araç dokuları

- Önceki devam noktasındaki C++ materyal değişiklikleri native ve WASM için yeniden derlendi. `g_MeshTexture`, sıralı instance/base/aktif-stream materyalleri, recursive constant MATERIAL_INDEX ve runtime override belirsizliği korunuyor. Sıfır boyutlu yardımcı stream materyali uygulanır; bilinmeyen runtime değer eski statik görüntüye geri düşmez.
- Corvette'in80çiziminin14'üne dört özgün shared albedo bağlandı: breakdisc, spain01, tyretred, tyrewall.17.955vertex özgün UV0 taşır;12.636vertex için sıfır çiftler yalnız yer tutucudur ve o çizimler doku bağlayamaz.12statik external resource texture çizimi ile runtime boya/ışık hâlâ desteklenmiyor. Bağımsız Python UV değerleri, buffer hashleri, tüm80çizim UV bayrakları ve14exact texture kaynağı native/WASM ile eşleşti.
- Corvette WebGPU önizlemesinde `14/80 çizimde özgün albedo` doğrulandı; plaka görünüyor. Bu tanılama görüntüsündeki mavi gövde özgün araç boyası değildir. Trafficcylinder özgün dokusu `2/2` çizimde çalışmaya devam ediyor. Console error/warning yok. Kanıt: `_work/verification/browser-corvette-static-materials.jpg`.
- Kaynak ChunkInfo/source-block eşlemesiyle17sınırlı native aday denendi;9desteklenen parça bulundu. River88/283:17.782vertex/9.343üçgen/95draw. Showroom3/10:11.590vertex/7.987üçgen/95draw. Top3River ve showroom için native/WASM JSON ile bağımsız Python konum/index dizileri ve F32LE/U32LE hashleri eşleşti. Geniş alan seçimi yatay üçgen alanından türetilen bir geometri sıralamasıdır; yol semantiği veya fizik kanıtı sayılmaz.
- Tarayıcıya River geniş/küçük ve Showroom seçimi eklendi. Byte aralıkları hâlâ WASM indeksinden gelir; geliştirme block presetleri açıkça sabittir. Her iki yeni sahne WebGPU'da gerçek sayılarıyla görüldü; tüm pist, materyal veya oyun davranışı iddia edilmez. Kanıtlar: `_work/verification/browser-river-wide.jpg`, `browser-showroom.jpg`. Canlı Brave sekmesi427257481 çıktı olarak işaretlendi. Loopback sunucu execoturumu68544.
- Derleme kontrolü sonrası `verify_asset_probe.py --skip-build` **25/25** geçti. Yeni bağımsız car-material/candidate fixture adımları ve candidate WASM eşitliği standart suite'e eklendi. Gerçek Corvette materyal modu CTest'e bağlandı; **13/13** native test geçti. Tam suite derleme dahil çalıştırıldığında26aşamadır. Kanıtlar: `_work/verification/suite.json`, `resume-build.log`, `resume-native-tests.log`, `car-native-wasm.json`, `level-candidates-native-wasm.json`.
- Native audit: önceki özel Brighton yarışında gerçek pist/araç/HUD ve Racing durumu doğrulanmış; sabit araç12s/exit0. Gaz girişli ayrı deneme17s'de `0x80000003` ile DynamicEffect AtomicActiveCache::Free kontrolünde durmuş. `m_ActiveElements <= 0 || pElement->m_VectorPosition == -1` koşulunun hangi tarafının bozulduğu ve W ile neden ilişkisi henüz bilinmiyor. Assert kaldırılmadı; bu tur oyun çalıştırılmadı. Eşleşen EXE/PDB/dump ile değer incelemesi sıradaki native adımdır. Kanıt: `_work/build/engine-reference/native-race-audit.json`, `docs/setup/native-source-build.md`.
- Tüm5.113oyun dosyası path/size/mtime kayıtları ve iki kullanıcı dosyasının hash'i baseline ile aynı; upstream temiz. Commit/push yok.

### Aktif devam noktası

1. `material_verify` bağımsız kanıtı tamamladı: kalan12statik çizim iki özgün texture kullanıyor (block2 dials, block6 interior). `tools/inspect_car_resource_textures.py`10özgün descriptor/mip zincirini birleştirip native decoder ve Pillow ile karşılaştırıyor;26hatalı assembly reddedildi, root yeniden çalıştırması geçti. BC1 birebir; BC3 yalnız belgelenmiş alpha yuvarlamasında<=1fark. Sıradaki C ABI gerçek(block,index) ile descriptor/payload spanlarını döndürmeli; en küçük doğru yol özgün complete LOD0'ı mevcut raw decoder'a vermek. Daha yüksek LOD yalnız yeni top mip içerir; önceki tail korunmadan açılmamalı. `docs/plan/car-resource-textures.md`. C++/web henüz bu12çizimi desteklemiyor.
2. `instance_next`: River88/283 ve showroom3/10 ilk RenderList'lerinde instance/base primitive yok. Eski River252/253'ün instance0'ı base0 -> VB/IBblock27/index0 kullanıyor;805referenced vertex/726üçgen. Özgün g_mWorld row-vector dönüşümü arşivlenmiş instance dünya sınırlarıyla3.8652e-5içinde eşleşti. Block27 chunk88'in sekizinci item'ıdır; mevcut API ilk-item-only olduğu için bunu desteklemez. Sıradaki uygulama tüm önceki kaynak öğelerini özgün chunk-origin alignment ile sırayla geçmeli; fixture byte offseti hardcode edilmez. `docs/plan/level-instances.md`, `tools/inspect_level_instances.py`; bu dönüşüm henüz C++/WASM/WebGPU'ya taşınmadı.
3. Bu iki bağımsız kanıttan sonra bounded C++/WASM genişletmesi; kaynak sürüş çökmesinin dump/PDB incelemesi paralel ayrı iş. Sonraki ana hedef hâlâ bir gerçek pist/araç ve özgün fizikle tek oyunculu yarış; multiplayer bundan sonra.

Bağımsız instance aracı da tamamlandı/donduruldu; root tekrar çalıştırması geçti. Tekrarlanabilir çıktı ve6hatalı dönüşüm/bağlama örneği kontrol edildi; `_work/level-instances/verification.json`. Önerilen ek API `level_instances_inspect(level,len,geometryChunk,len,nodeChunk,len,geometryBlock,nodeBlock)` mevcut direct API'yi değiştirmeden27/253örneğiyle başlayabilir. Aynı chunk'ın bütün item'larını origin0'dan sıralı geçer, yalnız seçili geometri bloğuna bağlı constant-affine instance'ları döndürür ve diğer bağımlılıkları eksik kapsam olarak sayar. İlk C++ karşılaştırmasında Python binary64→F32 hash'ini shader FMA bit eşitliği sanma; index/count ve arşivlenmiş sınırlar ile açık tolerans kullan. Bu turdaki üç ajanın işleri tamamlandı; kalıcı devam belgeleri güncel.

## 1 Kasım 2026 — T-001: kalan 12 statik Corvette dokusu

- `scene_resource_textures_inspect(model,len)` eklendi. Yedi resource bloğu Scene sınırına kadar kaynak sırasıyla geçiliyor; her texture için özgün ad/hash/sampler, LOD numarası, 28 baytlık descriptor aralığı, tam payload aralığı, DXT1/3/5 tam mip zinciri bayt sayısı ve payload'daki top mip sayısı dönüyor. Geçiş `parsedUntilOffset=3125977` ile Scene sonunda bitiyor; sabit offset yok.
- `scene_inspect` draw çıktısı artık resource-block kimliğini koruyor: `resourceBlock`, `resourceIndex`. 14 shared çizim yanında 12 resource çizim `albedoTexture:null` ve özgün `(block,index)` ile raporlanıyor; tahmini shared index üretilmiyor.
- Browser `resource-textures.js` yalnız tam LOD0 zincirini kabul ediyor; descriptor+payload geçici buffer'da birleştirilip mevcut `texture_raw_inspect`'e veriliyor. 12 çizim `dials` (block2) ve `interior` (block6) ile bağlandı; toplam 26/80 statik çizim dokulu (14 shared + 12 resource). Daha yüksek LOD'lar, runtime boya/ışık, hasar ve tekerlek hâlâ kapsam dışı.
- Bağımsız doğrulama: LOD0 descriptor offset/payload offset ve baytları `_work/car-resource-textures/report.json` ile birebir; dials BC3 RGBA `617d17...`, interior BC1 RGBA `ec0f5d...`; native/WASM resource JSON tamamen eşit. Yeni `verify_resource_binding.mjs` 12 draw bağını ve 26/80 sayısını kontrol ediyor.
- `verify_asset_probe.py --skip-build` **26/26** geçti; CTest **13/13**. Kanıtlar: `_work/verification/car-native-wasm.json`, `resource-binding.json`, `_work/logs/t001-*.log`. Browser WebGPU görsel kontrolü ayrı adım.
- Sıradaki: T-002 level instance dönüşümleri. `level_instances_inspect` ilk proof olarak block27/node253 instance0'ını (805 vertex/726 üçgen) üretmeli; ardından node253'teki 57 instance.

## 2 Kasım 2026 — T-001 browser görsel doğrulaması

- Kullanıcı Chrome'da `corvette_c3_race.model` gövdesini açtı; WebGPU önizlemesi `30591 vertex / 36193 üçgen` ve **26/80 çizimde özgün albedo** gösterdi. `Orijinal doku` modu etkindi; görünür hata bildirilmedi.
- Bu, 14 shared + 12 resource-block dokunun browser yolunda birlikte kullanıldığını görsel olarak doğrular. Ekran görüntüsü sohbet yoluyla sağlandı; `_work/` altında ayrıca arşivlenmedi. T-001 browser görsel kontrolü kapandı.

## 1 Kasım 2026 — T-002: ilk gerçek instance dönüşümü

- `level_instances_inspect(level,len,geometryChunk,len,nodeChunk,len,geometryBlock,nodeBlock)` eklendi; mevcut `level_mesh_inspect` değişmedi. Geometri bloğu ChunkInfo içinde **herhangi bir item** olarak bulunuyor; önceki item'lar origin0'dan sıralı geçiliyor. Node bloğu ilk-item sözleşmesini koruyor.
- İlk RenderList'in instance0'ı ve base primitive'i çözülüyor. Instance materyali, aktif instance stream materyalleri, base materyal ve aktif base stream materyalleri kaynak sırasıyla uygulanıyor; yalnız sabit affine `g_mWorld` kabul ediliyor. Dinamik/recursive/eksik/non-affine matrisler reddediliyor. Dünya konumu row-vector formülüyle hesaplanıyor.
- Gerçek River block27/node253 instance0: **805 vertex / 726 üçgen**; arşivlenmiş instance sınırlarıyla maksimum fark **3.86511e-05**. Native/WASM JSON tamamen eşit; F32 konum hash'i `5125314b04f46b997d4575478b11377ea72304aa9f2ee62d82f5bd7b1c1aa116`, U32 index hash'i `886e28559f186137e3ef5225768f61c4eccebf76ed4292ef5298c6ce887009fa`; bağımsız Python ile birebir.
- `verify_instances_wasm.mjs` eklendi; suite **27/27**, CTest **14/14**. Kanıt: `_work/verification/level-instances-native-wasm.json`, `_work/logs/t002-*.log`.
- Browser'a **River · instance prova** preset'i eklendi (block27/node253). Headless browser WASM yolunda `805 vertex / 726 üçgen / 57 instance / hata 3.87e-05` durumu görüldü; WebGPU mesh görüntüsü bu turda alınmadı. Diğer56instance, materyaller, görünürlük ve yüksek LOD'lar açık.
- Sıradaki: T-003 scene/level kapsamını genişletme; ardından fizik/kontrol/ses ile tek oyunculu dikey dilim.

## 1 Kasım 2026 — T-003 ilk artım: blok27 çoklu instance

- `level_instances_all_inspect` eklendi; tek-instance API korunuyor. Aynı node253 RenderList'inde VB/IB'si blok27'ye bağlı instance'lar sırayla işleniyor; her biri kendi sabit affine `g_mWorld` matrisiyle CPU'da genişletiliyor.
- Arşivlenmiş instance sınırlarıyla uyuşmayan instance'lar sessizce çizilmiyor; `unsupportedBoundsInstances` olarak sayılıyor. Blok27/node253 sonucu: **14 çizildi, 8 sınır uyuşmazlığı, 35 başka blok**; **7.308 vertex / 6.106 üçgen**, 14 draw; en büyük sınır farkı **6.02444e-05**.
- 8 desteklenmeyen instance base primitive7–10 kullanıyor; ek stream/deformasyon semantiği uygulanmadığı için sınırlar tutmuyor. Bu durum açıkça raporlanıyor, tahmini dönüşüm üretilmiyor.
- Native/WASM JSON tamamen eşit; `verify_instances_wasm.mjs` hem tek hem çoklu yolu kontrol ediyor. Suite **27/27**, CTest **14/14**.
- Browser'a **River · 14 instance** preset'i eklendi; `River · instance prova` tek instance olarak kalıyor. Görsel doğrulama 2 Kasım'da kullanıcı ekran görüntüsüyle tamamlandı.
- Sıradaki: diğer geometri blokları (15/17/26/31/32), base7–10 ek stream semantiği, level materyalleri/görünürlük/yüksek LOD'lar; ardından tek oyunculu dikey dilim.

## 2 Kasım 2026 — T-003 browser görsel doğrulaması

- Kullanıcı Chrome'da **River · 14 instance** preset'ini açtı. Görüntüde `359 akış kaydı · 14 instance çizildi · 8 sınır uyuşmazlığı · 35 başka blok · 6106 üçgen` ve `WebGPU · 7308 vertex · 6106 üçgen` görüldü; `Yüzey` modu etkindi, materyaller uygulanmadığı için `Doku çözülemedi` beklenen durum.
- Görünür WebGPU hatası bildirilmedi. Bu, blok27 çoklu instance yolunun browser'da gerçekten çizildiğini doğrular; T-003'ün kalan işi diğer geometri blokları, base7–10 stream semantiği, materyaller/görünürlük/yüksek LOD'lar.
- Ekran görüntüsü sohbet yoluyla sağlandı (2 Kasım 2026); `_work/` altında ayrıca arşivlenmedi.

## 2 Kasım 2026 — native tam bellek exit dump'ı

- W basılı tutulan Brighton senaryosu debugger altında tekrarlandı; süreç ~14s'de `0x80000003` ile çıktı. Debugger breakpoint olayı görmedi; `EXIT_PROCESS_DEBUG_EVENT` anında 1.458.887.110 baytlık tam bellek dump'ı alındı: `_work/native-source/Blur1PCDX11/_work/run/scripts/race-native-crash/dumps/full-exit.dmp` (SHA-256 `abd9befe...`).
- Analiz: `m_ActiveElements=93`, `m_VectorPosition=-1`; `m_Deleted[0]` elemanı aynı zamanda `m_Cache[162]` içinde. Bu, çift serbest bırakmayı doğrudan kanıtlar. Triyaj dump'ında serbest/aktif dizileri yoktu; tam dump bu boşluğu kapattı.
- Hangi iki `Free`/`AtomicFree` çağrısının çakıştığı, efekt kimliği ve thread çakışması hâlâ açık. Sıradaki en küçük adım dump içinde sahip tanım işaretçisini ve komşu partikül kayıtlarını çözmek. Assert kaldırılmadı; düzeltme iddiası yok.
- Rapor: `docs/work/analysis/native-particle-crash.md` ("Tam bellek (exit) dump'ı" bölümü).

## 2 Kasım 2026 — T-003 çoklu blok taraması

- `level_instances_all_inspect` çıktısına `requiredGeometryBlocks` ve instance VB/IB kaynakları eklendi: `[15,17,26,27,31,32]`.
- Blok15 chunk'ı çıkarılıp test edildi: **4 desteklenen instance** (22,31,32,56), 8 sınır uyuşmazlığı; 1.380 vertex/979 üçgen. Blok27 ile toplam **18 instance**, 8.688 vertex/7.085 üçgen.
- Blok17/26/32'de 0 desteklenen instance (sırasıyla 2/10/10 sınır uyuşmazlığı); base17/26/32 stream semantiği uygulanmadığı için çizilmiyor. Blok31 ek ChunkInfo prerequisite istiyor ve atlanıyor.
- Browser'a **River · tüm desteklenen** preset'i eklendi; blokları sırayla okuyup sonuçları birleştiriyor, sıfır/hatalı blokları sayıyor.
- Suite **27/27**, CTest **14/14**. Kanıt: `_work/level-instances/cpp-block*.json`, `_work/logs/t003-multiblock-*.log`.
- Sıradaki: base primitive11–35 stream/deformasyon semantiği, blok31 prerequisite, materyaller/görünürlük/yüksek LOD'lar.

## 2 Kasım 2026 — native dump sahip/efekt kimliği

- Tam dump'ta `0x2b21ebdbe20` nesnesi RTTI ile `DynamicEffect::Particle::Shape2DSimple` olarak çözüldü; bu efekt sahibi değil, partikül doğuran şekil. A–D emitter'larının A'sında `m_pEmitterList = 0x2b21b832850` = `m_SuperEffectEmitters`; `m_pEventInstance = NULL`.
- Komşu 16 baytlık kayıtlar `C_Particle_E` (`{C_Emitter*, U32 iSalt}`) trail elemanları; `iSalt=0`. `GetSalt()`/`SetDefaults()` aynı 0 değerini kullandığından salt koruması bayat trail referansını engellemiyor; bu H5'i güçlendiriyor ama hangi çağrının ikinci kez serbest bıraktığını kanıtlamıyor.
- Efekt adı dump'ta yok (SuperEffect RTTI yok, tanımlar vtable'sız, log'da ad yok). Sıradaki: sınırlı Free/AtomicFree çağıran izlemesi veya effect definition hash→ad eşlemesi. Rapor: `docs/work/analysis/native-particle-crash.md` ("Sahip/efekt kimliği").

## 2 Kasım 2026 — native Free/AtomicFree çağrı izlemesi

- İzole Speed kaynağına env-gated `AtomicFreeTrace`/`AtomicSiteTrace` eklendi; ayrı `Amax-trace.exe` üretildi. Kanonik `Amax.exe` değişmedi; instrumentation patch'i `_work/build/engine-reference/native-free-trace.patch`, trace `_work/.../race-native-crash/free-trace.log` (SHA-256 `874191c1...`).
- Trace ölümcül sırayı gösterdi: `UpdateSpawn` drenajı X'i serbest bırakıyor → `SuperEffect::FreeParticle` (AtomicFree) araya ayırma girmeden aynı X'i tekrar kuyruğa atıyor → `UpdateSuperEmitters` drenajı ikinci kez `Free` ediyor. Yani aynı cache bir karede iki kez boşaltılıyor; trail elemanı bırakılmış emitter'ı tutuyor.
- `iSalt=0` koruması `GetSalt()==0` olduğu için devreye girmiyor. Açık kalan: `C_Emitter::Update`/`m_bDelete` ile `FreeParticle` arasındaki sahiplik sözleşmesi ve trail referansının neden geçersiz kılınmadığı. Assert kaldırılmadı.
- Not: instrumentation zamanlamayı değiştirdi; çökme W'den ~0.1s sonra geldi, süre karşılaştırması yapılmamalı. Önceki full dump/trace dosyaları üzerine yazıldı; eski hash'ler raporda tarihsel. Sıradaki en küçük adım: kaynakta sahiplik sözleşmesini belgelemek; gerekirse FreeParticle etiketine pParticle/blok indeksi eklemek.

## 2 Kasım 2026 — native sahiplik sözleşmesi / kök neden

- Kaynak analizi: emitter ile trail elemanı arasındaki bağ tek yönlü; sahiplik `C_Particle_E::iSalt` nesil sayacıyla yürüyor. `m_iSalt` yalnızca senkron `C_EmitterList::Free` içinde artırılıyor (`emitterlist.cpp:24`); ertelenmiş `C_Emitter::AtomicFree` → `AtomicActiveCache::AtomicFree` ve drenaj `Free(m_Deleted[i])` salt'a dokunmuyor.
- Bu yüzden `FreeParticle` X'i ertelenmiş yolla bıraktıktan sonra drenaj `Free` ediyor; salt artmadığı için aynı X'e işaret eden trail elemanı sonraki karede `iSalt == GetSalt()` (0==0) görüp X'i yeniden kuyruğa atıyor; ikinci `Free` invariant'ı tetikliyor. Event instance/particle block yollarında nesil artışı doğru kurulmuş; emitter'ın ertelenmiş yolunda eksik.
- Düzeltme uygulanmadı; assert kaldırılmadı. Trace instrumentation patch'i `_work/build/engine-reference/native-free-trace.patch`; trace `free-trace.log` SHA-256 `874191c1...`; trace build `Amax-trace.exe`. Kanonik `Amax.exe` değişmedi; izole kaynak instrumentation'dan temizlendi.
- Rapor: `docs/work/analysis/native-particle-crash.md` ("Sahiplik sözleşmesi"). Sıradaki: `C_Emitter::AtomicFree` çağrılarını sahiplik devri/kendini bırakma olarak sınıflandırmak; trace'e `pParticle`/trail indeksi eklemek.

## 2 Kasım 2026 — native düzeltme denemeleri (reddedildi)

- Deneme 1: `C_Emitter::AtomicFree` içine `m_iSalt += 1`. `Amax-saltfix.exe` ile 3 koşu: 1× exit0, 2× `0xC0000005` (18/19s). Kabul edilmedi.
- Deneme 2: `C_EmitterList::Update()` drenajı `C_EmitterList::Free` (salt artıran) üzerinden. `Amax-drainfix.exe` ile 3 koşu: 3× `0xC0000005` (16/18/19s). Kabul edilmedi.
- Her iki deneme geri alındı; kanonik `Amax.exe` değişmedi. Patch'ler `_work/build/engine-reference/native-saltfix-attempt.patch`, `native-drainfix-attempt.patch`; loglar `_work/logs/saltfix-runs.log`, `drainfix-runs.log`.
- Bulgu: hata salt artışının yerine bağlı değil; asıl açık trail elemanının `pEmitter` alanını kimin geçersiz kıldığı. Sıradaki: sahiplik kuralını kaynakla sözleşmeye dönüştürmek; AV için düzeltmesiz build'de tam dump almak.

## 2 Kasım 2026 — üçüncü düzeltme denemesi (reddedildi)

- `DeleteTrailBlock` içinde serbest bırakılan `C_Particle_E` için `pEmitter = NULL` ve `m_Element.Clear()` eklendi; `Amax-trailfix.exe` ile 3 koşu: 1× `0x80000003`, 2× `0xC0000005` (18s). Kabul edilmedi; kaynak geri alındı.
- Patch `_work/build/engine-reference/native-trailfix-attempt.patch`, log `_work/logs/trailfix-runs.log`. Gözlenen çift-free `FreeParticle`/`Emitter::Update` yolundan geliyor; `DeleteTrailBlock` bu yolu kapsamıyor. Sıradaki: Aday 2 (trail-owned bayrağı) ancak tam dump'lı koşuyla; assert kaldırılmadı.

## 2 Kasım 2026 — Aday 2 (object-level trail sahipliği) analizi

- P3 kaynak analizi: object-level `m_bTrailOwned` bayrağı çökme için kanıtlanabilir şekilde **no-op** (2a) veya **sızıntı** (2b). Trail tanımları `SuperEffect.cpp:30-38` içinde `bRepeating=true` ve çok uzun süreli; self-free yolları (`Emitter.cpp:478-499`) trail-owned emitter'da hiç ateşlenmiyor. Asıl üretici `FreeParticle → AtomicFree` (`SuperEffect.cpp:229`) etkilenmiyor.
- Bu yüzden object-level bayrak uygulanmadı. Doğru yön **slot-level** sahiplik: `FreeParticle`/`UpdateTrail` sırasında aynı emitter'a işaret eden trail slotunu geçersiz kılan yolu bulmak. Rapor: `docs/work/analysis/emitter-ownership-next.md`.
- Test kuralı: tek/üç exit 0 kabul için yeterli değil; baseline sayaçları, tam dump ve patch/EXE hash'leri gerekli. Assert kaldırılmadı.

## 2 Kasım 2026 — T-005a wasm32 engine probe

- `_work/wasm-engine-probe` altında 48 gerçek TU ve beş bağımsız probe çalıştırıldı. Vendored zlib (11 dosya) wasm32'de linkleniyor ve node'da çalışıyor: 58.598 B @ `-O2`, 50.222 B @ `-Os`; `crc32/adler32/compress/inflate/roundtrip` geçti.
- Motorun geri kalanı: `core/Maths.h` 7 hata (5 `Float3` dönüşümü, 2 `__fsel`), `tl_defs.h`/`tl_thread.h` platform `#error`, Windows PCH (`winsock2.h`/`windows.h`), MSVC CRT (`_isnan` 137×), Display/DX11 442 referans. `PLATFORM_PC` kaldırılınca Windows PCH gidiyor ama taşınabilir maths yardımcıları da kapanıyor.
- İlk port sırası: maths gate → CRT compat → `PLATFORM_WEB`/`tl_*` → file/time → ilk link slice → fizik → input/audio/HUD. Motor çalışıyor iddiası yok. Rapor: `docs/work/analysis/engine-wasm-probe.md`; eski `engine-wasm-feasibility.md` superseded.

## 2 Kasım 2026 — T-003 bounds grouping kanıtı

- P2 kaynak analizi: `instanceBounds` çizim başına değil **CullNode (yerleştirilmiş nesne) başına**. `renderlistbuild.cpp:579` her draw için aynı `CullNode::GetBounds()` değerini yazıyor; çok draw'lı nesne aynı kaydı tekrarlıyor. Kayıt `RenderingData::Bounds` (AABB + distanceMin/Max, 32 bayt).
- Node253 ölçümü: 57 instance → **34 transform-sabit grubu ↔ 34 byte-identical kayıt**; grup draw AABB birleşimi kayıtla `6.024437e-05` içinde; 34/34 grup instance sırasında bitişik. Mevcut `scene_reader.cpp:874-887` tek draw'ı tüm nesne kaydıyla karşılaştırdığı için 38 instance'ı yanlış reddediyor.
- Beklenen: Stage A (blok27 22/22, 15 12/12, 17 2/2) = **36 instance / 22.924 vertex / 17.301 üçgen**; Stage B (blok26+32 chunk'lar arası) = **56 / 34.632 / 25.521**. Blok31 prerequisite. Henüz kod değişmedi; rapor `docs/work/analysis/level-instance-streams.md`.

## 2 Kasım 2026 — T-005c scheduler tasarımı

- İlk dilim için **tek iş parçacıklı kooperatif wasm** önerildi: mevcut `Scheduler::` API'si korunuyor, `jobqueue_web.cpp` backend'i ekleniyor; `Flush` kendi kuyruğunu boşaltıyor. Web Worker/SharedArrayBuffer ilk dilim için reddedildi (determinism/COOP-CC).
- `MT::Thread::Join`, `Mutex::Wait`, `Event::Wait` tek context'te beklemek yerine assert etmeli; aksi halde ana thread kilitlenir. `SchedulerConfig.cpp:49` column-0 streamer policy'si tek context'te düşüyor; policy flattening gerekli. İki audio `Flush(group,false)` çağrısı belgelenmiş sapma (her zaman drain) gerektiriyor.
- İlk kod dilimi: `PLATFORM_WEB` + `platform/{thread,atomic,sync,time}` + `jobqueue_web.cpp` + `probes/scheduler-probe/`; 1/60 fixed step, 4-tick cap, interpolasyon; 144/30 Hz/hitch/tab gap hash-eşitliği. Henüz kod yok. Rapor: `docs/work/analysis/t005-scheduler-design.md`.

## 2 Kasım 2026 — T-005b streaming tasarımı

- Öneri: `Sys::I_FileSystem`/`I_File`, logicalfs/PAK ve `ChunkInfo` mantığı C++'ta kalıyor; altına dar `platform/file` C ABI (`pf_open/size/read_at/write_at/close` + async `pf_enqueue_read`) ve JS `opfs:`/`blob:`/`http:` range-source registry. Senkron okuma yalnız OPFS `FileSystemSyncAccessHandle` veya hazır blok; eksik aralık açık hata, sıfır-doldurma yok.
- Ölçüm: kurulum 7,48 GB/5.113 dosya; `cache/` 1,16 GB, `levels/` 4,83 GB; River stream 244.682.752 B, 359 chunk (min 2.048, max 2.045.952 B, 222/359 prerequisite). 19 levelde max chunk 2.623.488 B; levelrender index cursor 7.021.820 B'ye ulaşıyor.
- İlk dilim: motor header'ı olmadan `RangeFile` + `pak_index_range`/`level_index_range`; 7 PAK ve 19 level index native/wasm parity + bir gerçek chunk hash'i. Riskler: HEAPU8 growth, blocking Read'i event-loop ile çözme, OPFS/COOP-CC, cache invalidation. Rapor: `docs/work/analysis/t005-streaming-design.md`.

## 2 Kasım 2026 — T-005d fizik fizibilitesi

- En küçük sadık alt küme: Gravity 127 cpp/58.759 satır + RacingPhysics 11.436 satır (~70 kLOC). Araç yolu `C_Scene::Simulate → Car::Integrate → ArticulatedBody::Integrate` (1/60'te 4× Euler <2 m/s, üstünde 1× RK4) → teker başına Gravity statik üçgen-mesh ray + yay/lastik.
- T-005a gate'lerinden sonra her RacingPhysics simülasyon TU'su **18 hata** (5 `HVec3→Float3`, 2 `__fsel`, 11 `tl_*`/`Mutex`); Gravity'nin kalanı scheduler module tipleri. Bu yüzden **T-005c sert önkoşul**.
- İlk dilim D1: `Level.levelphysics` (5,6 MB) statik collision-query oracle; sabit probe tablosu, `queryHash` native/wasm birebir; car/XT/solver yok. Native sayısal referans yok; önce aynı probe'un native build'i. Ayrıntı: `docs/work/analysis/t005-physics-feasibility.md`.
- Düzeltme notu: `engine-wasm-probe.md` §3.3'teki 19/62 hata sayıları kendi `final_posix.json`'una göre eski; gerçek 92–95 racing, 203–215 gravity. `g_maxPhysicsUpdates` Speed/Release'te 4.

## 2 Kasım 2026 — T-006a native LAN envanteri

- PC LAN auth'suz: `PlatformConnect(false)` offline `bdNet` dalı; `CreateLanSession`/`JoinLanSession` yalnız machine id + yerel adres; `CheckEntryRequirements(false)` kimlik kontrolü yapmıyor. Taşıma yine `bdNet`/`bdSocketRouter` + DTLS.
- Sabitler: keşif UDP **50001** (PC), oyun UDP **3074** (doluysa 3074–3173), `Network.BuildVersionToJoin` iki tarafta eşleşmeli; firewall izni gerekli.
- **İki istemci aynı makinede çalışmaz:** keşif `INADDR_ANY:50001` üzerine `SO_REUSEADDR` olmadan bind ediliyor; `C_NetRace::Initialise` hatayı yutuyor. İki fiziksel makine gerekli. `Global\Blur2PC.GameSlot` mutex'i de aynı makineyi engelliyor.
- Eksik kanıt: iki istemcili senaryo, LAN discovery/join logu, pcap, `SystemLink` automation, firewall/port kaydı. Payload DTLS'li; pcap yalnız başlık/seq/size verir. B1 kabulü iki makineli LAN lobisi + pcap/CSV; 10s `Racing` B1b ve T-004 çökmesi nedeniyle ayrı. Rapor: `docs/work/analysis/t006-native-lan.md`.

## 2 Kasım 2026 — T-006b wire format tasarımı

- Wire format açık serializer değil, **struct ABI**: `memcpy(sizeof(struct))`; tek dönüşüm 2 baytlık little-endian size. En büyük risk `SysProfile::BaseProfile` içindeki `wchar_t` (MSVC 2, wasm32 4) ve padding/bitfield yerleşimi; Join/StartRace alanları kayabilir.
- Golden byte'lardan önce native/WASM `sizeof`/`alignof`/`offsetof` + bit pattern layout probe gerekli. P0 paket seti: KeepAlive, ACK, JoinRequest/Reply/Data, InitialData, PlayerStates, VehicleData, StartRace, BasicVehicleData, VehicleFinished; PostRace/Leaving hemen sonra.
- Fixture formatı, padding-poison/truncation corpus, 1024-byte MTU, 0.5s retry, 1.5s join resend, 4/6s dropout planı hazır. Henüz packet capture/uygulama yok. Rapor: `docs/work/analysis/t006-wire-format.md`; kart: `docs/work/tasks/T-006-multiplayer.md`.

## 2 Kasım 2026 — T-006c WebRTC transport tasarımı

- Öneri: engine association başına bir `RTCPeerConnection` (`bdEndpoint` = common address + security ID). İki negotiated DataChannel: **reliable ordered** (join/start/vehicle setup) ve **unreliable** `ordered:false,maxRetransmits:0` (keepalive/ACK/vehicle state). Engine'in mevcut app-level reliable/unreliable katmanları ilk dilimde korunuyor.
- Sadece `bdSocketRouter`/`bdNet` backend'i değişiyor; `C_NetRouterBase` ve oyun protokolü byte-identical kalıyor. IPv4 yerine opak 25-byte web peer record; WSS signaling/STUN/TURN; sınırlı kuyruk/`bufferedAmount`; blocking wait yok.
- İlk dilim: standalone browser adapter harness; 10.000×1 KiB reliable exact/ordered, unreliable loss/reorder, queue caps, reconnect/ICE restart. Riskler: T-005a wasm gate, IP tabanlı `bdCommonAddr`, blocking `StartConnect`/`GetAdaptersInfo`, DTLS/NAT seam yokluğu, signaling/TURN altyapısı yok. Rapor: `docs/work/analysis/t006-transport.md`.

## 2 Kasım 2026 — T-004 slot-level sahiplik tasarımı

- TEK-YUVA değişmezi: canlı her `C_Particle_E` yuvası için `pEmitter` tek bir yuvaya geri işaret etmeli; bırakma önce yuvayı temizlemeli. Salt karşılaştırması yedek kontrol olur.
- Yeni bulgular: `DeleteTrailBlock` canlı emitter için **ölü yol** (S3; ana blok boşken çağrılıyor), `UpdateMemory` end blok NULL iken `blocks[b]` eski bloğu bırakıyor (S6). `FreeParticle` canlı aralıkta bayat yuva bırakmıyor; bayatlık `Size()==1` self-copy veya blok desync'ten.
- Minimal tasarım 16 nokta: `C_Particle_E::Clear`, `C_Emitter::m_pTrailSlot` (sınıf sonu, +8 B), spawn'da kayıt (`SuperSpawn.cpp:25/46`), copy-last sonrası retarget (`SuperEffect.cpp:236`), üç trail yolunda ve iki self-free noktasında clear-then-release. `Atomic.h`/`Manager.cpp` değişmiyor; assert kalıyor. Tahmini maliyet 18.432 B.
- Sıradaki en küçük adım: trace'e `pParticle`, blok `m_VectorPosition`, `i`, `iSalt` ekleyip bayat `(t,b,i)`'yi isimlendirmek; sonra 1–14 uygulaması ve 3+3 paired test (tam dump). Rapor: `docs/work/analysis/emitter-slot-ownership.md`.

## 2 Kasım 2026 — T-005c sabit adım probe'u

- `probes/scheduler-probe/`: 1/60 sabit adım, accumulator, 4 tick cap, pause/hitch, alpha. Native MSVC `/W4` temiz, CTest 2/2, 2130 assertion; wasm32 Emscripten 6.0.13 53.263 B.
- Native/wasm/Python üçlü karşılaştırma 0 fark: 144 Hz×600 = 249 tick, 30 Hz×300 = 600 tick, 250 ms hitch 15 istek → 4 çalıştı/11 clamp, 5 s tab gap 1 pause. 600/150/100 frame → tek hash `0x7e04f9a197e01d8a`.
- Ana suite'e `scheduler-probe` adımı eklendi; `--skip-build` 28/28. Engine `Scheduler::` entegrasyonu yok. Bulgu: cap sonrası accumulator sıfırlama (`ApplicationPC.cpp:518-522`) tasarım §4.2'ye işlenmeli. Kanıt: `docs/work/verification/T-005c-scheduler.md`.

## 2 Kasım 2026 — T-003 Stage A

- `level_instances_all_inspect` bitişik instance'ları aynı arşiv CullNode bounds kaydı + aynı VB/IB bloğu anahtarıyla grupluyor; draw AABB birleşimi ortak kayıtla `1e-4` içinde karşılaştırılıyor. Reddedilen grup bütün olarak geri alınıyor.
- Sonuç beklenenle birebir: blok27 **22**, blok15 **12**, blok17 **2** → **36 instance / 22.924 vertex / 17.301 üçgen**. Blok26/32 Stage B, blok31 prerequisite bekliyor.
- Suite **29/29**, CTest **14/14**, native/WASM JSON eşit. Headless Edge/WebGPU: 22 ve 36 instance presetleri, console temiz; `favicon.ico` 404'ü `data:` ikonuyla kapatıldı. Kanıt: `docs/work/verification/T-003-stageA.md`.

## 2 Kasım 2026 — T-004 slot stride çözümü

- P13 üç koşuda bayat yuvayı `(0,0,0)`, `(0,0,0)`, `(0,0,2)`; `iSalt/GetSalt = 0/0`; `epos=-1`; yuva canlı aralıkta olarak isimlendirdi. Yeni ölçüm: trail slot adımı **8 bayt**, `C_Particle_E` x64'te **16 bayt**.
- Kök neden: retail PC 32-bit olduğu için `Manager.cpp:151` sabit `8` doğruydu; x64 rebuild'de `iSalt` komşu `pEmitter`'a yazıyor ve copy-last 8 baytlık adımın üzerine kopyalıyor.
- Düzeltme: `SetElementSize(sizeof(C_Particle_E))`. Paired 3+3: baseline **3/3 çökme** (2×`0x80000003`, 1×`0xC0000005`, 16/23/17 s), düzeltme **6/6 exit 0** (23–24 s); ek kanıt koşusuyla **7/7**. Koşu `Racing` (10,2 s) → `AFTER_THROTTLE` (20,2 s) → `quit` (22,2 s).
- Kanonik `Amax.exe` ve assert değişmedi; patch `_work/build/engine-reference/native-slotstride-fix.patch`. wasm32'de sizeof 8 olduğu için düzeltme no-op. TEK-YUVA slot sözleşmesi web portu için açık. Kanıt: `docs/work/verification/T-004-slot-stride.md`.

## 2 Kasım 2026 — T-005c engine scheduler dilimi

- `PLATFORM_WEB`/`TL_PLAT_WEB` kimliği kopya kaynakta 5 düzenleme + 2 tip başlığı (`tl_thread_web.h`, `jobqueue_web.h`) ile eklendi; `upstream/` temiz.
- 39 ölçülen TU'dan 30'u derleniyor; `jobqueue.cpp`/`jobqueue_kernel.cpp` 11→0, `Inflate` ve `serialiser` 0. `Core.h:181`'de `PLATFORM_LINUX`'u düşürmek `IoFile.cpp`'yi 1→41 hataya çıkardığı için "web + POSIX alias" yapılandırması korundu.
- `spike_sched.wasm` **59.140 B**, node'da gerçek iş: `ran=1`, `job_result=42`, `queued=0`, `workers=0`; iki koşu bit-birebir.
- `Atomic.h`'nin platform zincirinde wasm dalı yoktu; 17 fonksiyon `__atomic_*` ile dolduruldu. `DebugBreak()` PPC trap'i wasm'da `__builtin_trap()`.
- Kalan: policy flattening (`piStreamer` column 0), 5 POSIX kalıntısı, `_vsnprintf_s`, DX11/FX11. Ayrıntı: `docs/work/analysis/engine-web-shims.md`.

## 2 Kasım 2026 — T-005c wasm overlay yeniden üretilebilir

- `engine/patches/t005c-web-scheduler.patch` (20 dosya, +681/−35, SHA-256 `DBD4AC27…2E8B`) + `engine/apply_overlay.py`, `verify_overlay.py`, `native_parity.py`; `upstream/` yazılmıyor ve kirliyse araç reddediyor.
- Taze upstream kopyasına uygulanıp yeniden derlendi: scheduler wasm **60.797 B**, A3 4/4, 3/3 fail-loud abort, deterministik, **PASS**; manifest eşleşiyor.
- PC parity: önişlenmiş `jobqueue.cpp` yalnız iki log satır numarasında farklı (statement farkı yok); 29/29 TU MSVC'de derleniyor. Runtime PC probe, scheduler dışı logging zinciri (`IoStream.cpp`) nedeniyle bloke.
- İlk gerçek engine çağırıcısı: `C_Deflate`/`C_Inflate` kuyruk üzerinden `deferred=1`, `equal=1`. Kalan: A2 grup bağımlılıkları, native runtime parity, DX11/FX11.

## 2 Kasım 2026 — T-005c A2 grup bağımlılıkları

- A2 kapanışı: B önce kuyruğa girse de yalnız `Flush(A)` sırası `A` (B kuyrukta), `Flush(B)` → `AB`; ikinci çiftte yalnız `Flush(D)` → `ABCD`. Sıra iş gövdelerinde kayıtlı; sayaçtan çıkarılmıyor.
- `JQ_GROUP_LABEL` ve `JQ_GROUP_SPURWLOCK` temsil edilemiyor: açık mesajla abort (4/4 fail-loud). Abort-label mesajı hangi API'nin neden desteklenmediğini yazıyor.
- `verify_overlay.py --fresh` **PASS**: scheduler wasm 64.073 B, A2/A3/A4, 4/4 abort, caller yeşil, deterministik. `native_parity.py`: PC TU yalnız iki log satırında farklı, 29/29 TU MSVC; runtime PC probe hâlâ scheduler dışı logging zincirinde bloke.
- Patch `B939B39C…FDEF2` (20 dosya, +691/−35), manifest `57e7fc62bf67ab26`. Kalan: 150 gerçek çağrı yeri, streaming/layer-manager, DX11/FX11.

## 2 Kasım 2026 — T-005b engine dosya katmanı

- `engine/patches/t005b-file-overlay.patch` (4 yeni dosya + 3 web-only düzeltme) scheduler overlay'inin üstüne `Sys::C_WebFile`/`C_WebFileSystem` + `pf_*` C ABI ekliyor; tümü `PLATFORM_WEB` altında.
- `verify_file_overlay.py --fresh` **PASS** (116,6 s): 61 nesne, 530.493 B wasm, iki build bit-birebir, 50/50 kontrol, 7 açık ret.
- Tam `C_PakFs` ve `C_OverlayFs` yolları çalışıyor; 3.601 FAT kaydı referansla aynı; iki dosya (209 B, 131.200 B) ve bir dizin (35 çocuk) doğrulandı; hash'ler bağımsız Python decoder ile aynı.
- Gerçek `cache/root.pak` (559.652.864 B): 3.601 giriş `probes/range-file` ile alan alan aynı; 3.609 istek/314.522 B; tam dosya FNV-1a 64 `2f291abb5648e078` iki buffer yolunda da aynı.
- PC parity: mevcut dosya değişmiyor; `C_FileSystem.cpp`/`C_File.cpp` önişlenmiş çıktıları aynı; yeni TU `/W4` temiz.
- Harness `engine/harness/t005b/`, scheduler probe/shims `engine/harness/t005c/` altında commit edildi; doğrulayıcılar temiz checkout'tan çalışıyor. Kalan: OPFS/worker, `C_PakFs::OpenPak` tüketicisi.

## 2 Kasım 2026 — T-005d collision oracle

- `Level.levelphysics` formatı kanıtlandı: `Physic` blokları, Gravity import v10, `OptimisedAABBTree`, yaprak sıralı üçgen akışı, `S16<14>` kuantizasyon, U8 indeks, little-endian. Ayrıştırma `Main` sınırında sıfır artık baytla bitiyor.
- `probes/collision-oracle/`: 44.244 üçgen; thin ray + 4 girişli line-cache + statik küre (24+24+8). Native/wasm/Python `queryHash f87365b7…9b5d6e`, 7.768 kanonik bayt; 13/13 bozuk girdi reddi.
- Ana suite'e `collision-oracle` adımı eklendi: `--skip-build` **29/29**. Fat/swept-sphere yok (teker yarıçapı XT), constraint yalnız boş liste; motor entegrasyonu/oyun iddiası yok. Kanıt: `docs/work/verification/T-005d-collision-oracle.md`.

## 2 Kasım 2026 — T-005d Gravity wasm portu

- 8 gerçek Gravity TU'su (`OptimisedAABBTree`, `LineCollisionCache`, `Shapes`, `Primitive*Test`, `AABB`, `SPU_Memory`, `GravityConstants`) upstream hâliyle wasm32'de derlendi: 33 nesne, **134.318 B**, `t005d-gravity-overlay.patch` **0 B** (engine kaynağı değişmedi; 350/350 Gravity dosyası upstream ile aynı).
- Aynı 24+24+8 sorgu tablosu: **ray 24/24 bayt-birebir**; sphere 8/24, cache 1/8. Fark yalnız altı raporlama alanında: materyal paketleme, patch normal, `engineTriangleIndex`, atanmayan `trace.collisionFlags`, normalize edilmemiş trace normal'i. İlk fark sorgu 24 `point-vertex-0`, bayt 48.
- Tam `queryHash` eşitliği iddia edilmiyor (`77a53355…f94c` vs `f87365b7…5d6e`); `verify_gravity.py` izin verilen farkı birebir pinliyor (ray 24/0, sphere 8/16, cache 1/7 + alan çoklukları), başka farkta düşüyor. Build/run deterministik, mesh yapısı doğru. Kanıt: `docs/work/verification/T-005d-gravity-wasm.md`.

## 4 Kasım 2026 — fiziksel Chrome testi

- Kullanıcı Chrome'da dört testi çalıştırdı ve ekran görüntülerini paylaştı; **4/4 beklenen değerlerle eşleşti**.
- Corvette: 30.591 vertex / 36.193 üçgen, 26/80 albedo, 3.601 dosya.
- River · 22 instance: 22 çizildi, 0 uyuşmazlık, 13.162 / 10.308.
- River · tüm desteklenen: 36 çizildi, 20 uyuşmazlık, 1 blok atlandı, 22.924 / 17.301.
- Showroom: 11.590 / 7.987. Console/WebGPU hatası yok.
- Bu bir **asset görüntüleyici** doğrulamasıdır; oynanabilir oyun değildir. Görüntüler sohbet yoluyla sağlandı, `_work/` altında arşivlenmedi.

## 4 Kasım 2026 — E1 renderer kararı

- **E1 kabul edildi:** dünya yükleme, sahne/çizim listesi, fizik, yarış durumu ve girdi semantiği wasm'da; JS/WebGPU sürümlü bir render packet tüketir. Mevcut WebGPU görüntüleyici başlangıç rasterizer'ı.
- E1, engine renderer'ı atlamak değil: DX11 backend + state/shader katmanı değişir, sahne/çizim ön yüzü korunur. Böylece E2 aynı packet arkasında backend/sadakat yükseltmesi olarak kalır.
- Karar kapısı: tam tur oynanabilir, çarpışma/sınırlar görsel olarak net, 60 Hz stabil, kalan sadakat farkları listeli ve oyun hatasını gizlemiyor. Aksi hâlde E2.
- Ayrıntı: `docs/work/analysis/e1-renderer-strategy.md`.

## 4 Kasım 2026 — T-007 E1 dilimi başladı

- `T-007` kartı açıldı: E1a level streaming, E1b render packet v1, E1c araç fiziği, E1d döngü/girdi/kamera, E1e WebGPU entegrasyonu, E1f ilk sürülebilir tur.
- Üç spike paralel: P18 `StreamManager`/`C_Scene` ile River yükleme, P19 gerçek RacingPhysics araç adımı, P20 render packet v1 + WebGPU tüketici prototipi.
- Her spike kendi dosya alanında; `upstream/` yazılmıyor, PC yolu korunuyor. Sonuçlar geldikçe doğrulanıp commit edilecek.

## 4 Kasım 2026 — E1b render packet v1

- `probes/render-packet/`: JSON Schema 2020-12 + kanonik hash + doğrulayıcı; üretici gerçek River block27 (22 instance) ve Corvette gövdesinden packet üretiyor.
- Packet: **102 draw**, 43.753 vertex / 46.501 üçgen, 2.906.496 B, `sha256:7ede3abd…e0d1`; iki koşu bit-birebir.
- WebGPU tüketici prototipi headless Edge'de 102 draw çizdi; **console boş**; ekran görüntüsü `_work/render-packet/browser-car-focus.png`.
- Materyaller kimlik; doku/boya/gölge/post yok, `materialsApplied:false`. Packet spike fixture (`tick:0`, inline JSON), engine sahnesi değil.
- Kanıt: `docs/work/verification/T-007-render-packet.md`, `docs/work/analysis/e1-render-packet.md`.

## 4 Kasım 2026 — E1a engine streaming

- `StreamManager` wasm32'de: **359/359 chunk**, **244.682.752 B**, en büyük chunk 2.045.952 B (4 MiB allocator içinde); 37 nesne, **246.726 B** wasm, iki build bit-birebir, 20/20 kontrol.
- **359/359 chunk FNV** bağımsız Python okumasıyla aynı; chunk tablosu 359 kayıt / 1227 blok / initial 1; `levelrender` FNV `0x0ef5c027f0924307`, `levelphysics` FNV `0xb9594f7ce52caa2e`; geometry chunk 157 FNV `0x74dd025de4430925`.
- EOF/past-EOF/oversize istekleri yüksek sesle düşüyor; sıfır-doldurma yok; PC `streammanager.cpp` önişlenmiş çıktısı aynı.
- **Blok:** `Level.levelrender` Scene parse'ı DX11 `Display2` tipleri yüzünden derlenmiyor (`archive.cpp` 456 hata, `streamdata.cpp` 33, `RenderLevel.cpp` 71). Chunk tablosu şimdilik iki probe'dan geliyor; `StreamData` prerequisite/queue mantığı derlenmedi.
- Kanıt: `docs/work/verification/T-007-streaming.md`, `docs/work/analysis/engine-level-stream.md`.

## 5 Kasım 2026 — E1c araç fiziği wasm

- Gerçek RacingPhysics + Gravity: **186 nesne**, **1.024.869 B** wasm; link `-sERROR_ON_UNDEFINED_SYMBOLS=1` ile kapanıyor.
- Araç verisi gerçek XT: `RP_CarDynamics` kayıt 37 `Corvette_ZR1_Stock`; 1600 kg, 2.652 m aks, 0.356 m teker, 6 vites RWD. Uydurma değer yok; yüzey eşlemesi/fizik handle'ı açıkça eksik etiketli.
- 180 dinlenme + 300 gaz tick: temas **480/480**, NaN **0**, hız 0,77 → **31,09 m/s** (tepe 35,13), **96,14 m**; tüm koşu hash `2bbc0a18…e974f5`; iki koşu bit-birebir.
- Native sayısal referans DX SDK yüzünden bloklu; 7 web-only dosyanın MSVC önişlenmiş çıktısı aynı, 2 grammar fix `/W4` temiz. Patch `6fd6f2d1…86bd`.
- Kanıt: `docs/work/verification/T-007-vehicle-physics.md`, `docs/work/analysis/engine-vehicle-physics.md`.

## 5 Kasım 2026 — E1b packet v1.1

- Şema 1.0/1.1: `nodes[]` + tick başına `updates[]`; 1.1 timeline'sız reddediliyor, 1.0 timeline'lı reddediliyor.
- 120 tick packet, 3.099.828 B, `sha256:c31ddb3f…f84c`; 120/120 benzersiz tick hash'i, iki koşu aynı.
- `fixed-step.js` T-005c probe'unun portu; native probe deltalarıyla **10/10 senaryo sıfır tolerans**.
- Canlı: **90 tick / 262 frame**, 127 frame sıfır tick; geometri **2 upload** (mesh başına bir kez), kare başına tek 26.112 B uniform + 102 draw. Tick 0→90 kayması **190,16 px**; console **0 mesaj**.
- Hareket `motion:"synthetic"`; fizik değil. Kanıt: `docs/work/verification/T-007-render-packet.md`.

## 5 Kasım 2026 — collision probe formatVersion 2

- v2 kayıtları engine değerleri ile probe raporlamasını ayırıyor: `body/triangle/engineMaterial`, `patchNormal`/`contactNormalDerived`, `engineTriangleStreamValue`/`perTriangleOrdinal`, `engineNormalStored`, `collisionFlagsAssignedByEngine`.
- Native/wasm/Python **byte-identical** (24 ray + 24 sphere + 8 cache); `queryHash 620eceea…063f`, 9.816 B; 24/24 kontrol. v1 üretimi emekli, düzeni belgeli.
- Gravity v1 dokümanıyla **840 atanmış alan grubu** eşleşiyor; yalnız engine'in hiç atamadığı `trace.collisionFlags` hariç. `verify_gravity.py` v2'ye bağlandı: **PASS (v2 field-level)**.
- Kanıt: `docs/work/verification/T-005d-collision-v2.md`, `probes/collision-oracle/README.md`.

## 5 Kasım 2026 — E1 drive connector

- `probes/e1-drive/` gerçek araç fiziğini render packet v1.1 ve WebGPU'ya bağladı; 186 nesnelik closure, modül 1.003.249 B.
- 300 tick scripted sürüş (120 gaz/120 coast/60 fren): **45,378 m**, hız 0,002→14,986→0,448 m/s, temas **301/301**, NaN **0**; state hash `83f76590…08e1f` iki ayrı instance ve reset+replay'de aynı.
- Packet 301 tick, 103 draw, 3.396.616 B, `fa7e660b…d769c1`; her tick hash'i Node tanımıyla yeniden hesaplanıp doğrulandı.
- Headless Edge/WebGPU: 742 frame/299 tick, geometri **3 upload**, 0 console mesajı; tick 0/150/300 ekran görüntüleri.
- Sınırlar: diagnostic materyaller, yol collision geometrisi, teker çizimi yok, box gravity proxy, XT handle açık. Kanıt: `docs/work/verification/T-007-e1-drive.md`.

## 5 Kasım 2026 — T-008 PoC hedefi

- Kullanıcı testi için PoC tanımı: tek URL, River, **≥4 gerçek araç**, seçilebilir, WASD + chase camera, sabit adım, console 0. Kart: `docs/work/tasks/T-008-browser-poc.md`.
- Paralel agent'lar: P23 çoklu araç roster'ı, P22 `levelrender` engine parse, P25 Stage B pist geometrisi. Sırada teker/kompozit ve PoC paketleme.

## 5 Kasım 2026 — P22 engine levelrender parse

- `StreamData`/`Target::Scene` yolu wasm'da derlendi: 54 TU, **664.137 B** wasm, iki build aynı, 30/30 kontrol, PC parity (`streammanager`/`streamdata`/`archive` önişlenmiş satırlar aynı).
- `Level.levelrender` engine serialiser'ıyla parse edildi: **359 ChunkInfo / 10.784 item / 603 prerequisite**, 359/359 alan `range_probe` ve `level_inspect` ile aynı; cursor 2.464.509 B = probe `parsedUntilOffset`; tablo hash `aae98142…d36`; GPU çağrısı **0**.
- `OpenStreamFile` buffer hint sentinel (16 KiB) olarak düzeltildi; prerequisite'lı chunk okunmadan reddediliyor.
- Kalan: resource block/render list importu, `ProcessLoadChunk`, doku/decompression. Kanıt: `docs/work/verification/T-007-streaming.md`.

## 5 Kasım 2026 — T-003 Stage B (cross-chunk)

- `level_instances_bundle_inspect` eklendi: node bir kez, 1–16 geometry chunk bundle'ı; her instance'ın VB/IB bloğu bağımsız çözülüyor. Eski API'ler korunuyor.
- Grup anahtarı: bayt-özdeş arşiv CullNode kaydı + sabit transform satırı; blok kimliği yalnız üye çözümü için. Eksik üyeli grup bütün olarak tutuluyor (`incompleteBoundsGroupInstances`), kısmi emit yok.
- Sonuç: blok26+32 **20** instance / 11.708 / 8.220; blok15/17/26/27/32 toplam **56 instance / 34.632 vertex / 25.521 üçgen**; blok31 1 instance prerequisite bekliyor. Blok27 regresyonu 22/13.162/10.308.
- Üç native bundle koşusu byte-identical; JSON SHA `647ee7d3…148d`; CTest **15/15**, tam suite **30/30**, `--skip-build` 29/29, MSVC `/W4` 0 uyarı; native/wasm/Python eşit.
- Negatif testler: duplicate/truncated/swapped chunk, bozuk ARCH, bilinmeyen blok, tek-ULP kayıt değişimi → grup bölünüp 3 üye reddediliyor; kısmi blok26 bundle 10 instance'ı 6 incomplete grupta tutuyor.
- Headless Edge: 20/8.220, 56/34.632/25.521 ve 22/13.162/10.308 presetleri console temiz. Kanıt: `docs/work/verification/T-003-stageB.md`.

## 5 Kasım 2026 — çoklu araç roster'ı

- `RP_CarDynamics` 62 kayıt, 62/62 completeness gate; 5 araç seçildi: Corvette ZR1 (RWD), Lotus Exige Cup260 (RWD), Dodge Challenger (RWD), Focus RS (FWD), Audi R8 V10 (AWD).
- Aynı 120/120/60 script: 5 ayrı deterministik state sequence; Corvette `83f76590…008e1f` T-007 anchor'ıyla birebir; `verify_e1_drive.mjs` **164/164**.
- Browser: 20 capture (4 tick × 5 araç), console **0**, geometri 3 upload/1.090.380 B. 18/20 packet hash birebir; 2'si kamera `atan2` bir-ulp (state/matris birebir). Araç seçici + `?car=` + `--car` çalışıyor.
- Sınır: her araç Corvette C3 gövdesiyle çiziliyor (per-car mesh yok), teker yok. Kanıt: `docs/work/verification/T-007-multi-car.md`.

## 5 Kasım 2026 — araç parça/teker manifesti

- Corvette modelinden **29 parça / 80 draw**: 76 kanıtlı, 4 yan-belirsiz (ön disk/kaliper). 32 shell draw grup-kanıtlı, leaf isim uydurulmadı.
- **4 teker grubu** (`+X` dönüş ekseni); lastik köşe kanıtı tread+sidewall birleşimi 0.000343–0.000648 m; kaliper `VehicleActor.cpp:5198` gereği sabit.
- Headless Edge: console 0, 2 geometri upload, 0→0.9 rad arası **7.149 piksel** farkı; ekran görüntüsü `_work/car-parts/browser-parts-angle090.png`.
- Sınır: ilk RenderList LOD0, çeviri-only rest poz, süspansiyon/steer/camber yok; henüz drive packet'ine bağlanmadı. Kanıt: `docs/work/verification/T-007-car-parts.md`.

## 5 Kasım 2026 — parça/teker entegrasyonu

- E1 drive packet'i **29 parça / 80 draw**, **9 node** (1 gövde + 4 spin + 4 statik kaliper) kullanıyor; teker açısı `e1_get_state().wheels[].angular` integraliyle (tick 0/150/240/300: 0/84,637/138,223/148,603 rad).
- `verify_e1_drive.mjs` **202/202** (164 + 38 yeni); 5 araçta 301/301 temas, 0 NaN; Corvette anchor `83f76590…008e1f` değişmedi.
- Browser 20 capture, console **0**, geometri 3 upload/1.090.380 B; 17/20 packet hash birebir, 3'ü kamera `atan2` bir-ulp (state/matris birebir). Packet 103 draw.
- Sınır: parçalar Corvette-only (5 araç aynı gövde), rest-pose teker konumu, diagnostic renkler. Kanıt: `docs/work/verification/T-007-car-parts-integration.md`.

## 5 Kasım 2026 — engine CPU draw list

- `Target::Scene` resource block + render list importu (GPU objesi 0): River block88/chunk136 (5 VB, 1 IB, 587.228 B) ve node283/chunk68 (1 render list, 255 primitive).
- **95 bound draw**, 160 other-block (nedenli, çizilmedi); **9.343 üçgen / 17.782 vertex**, 0 index hatası; draw-list hash `fd525c1452869aee`.
- `level_inspect 88/283` ile **95/95 firstIndex+indexCount span eşit**; 57 instance / 36 base primitive eşit.
- 55 nesne, **794.845 B** wasm, 46/46, PC parity (4 TU). Kalan: `g_mWorld`, materyaller (`g_tAlbedo`/`g_MeshTexture`), dokular, `ProcessLoadChunk`; packet v1.1'e bağlama. Kanıt: `docs/work/verification/T-007-streaming.md` §P27.

## 5 Kasım 2026 — araç başına gerçek gövde

- 5 aracın tamamı `root.pak` içindeki kendi `.model` dosyasına kanıtla eşlendi: Corvette ZR1, Lotus Exige Cup260, Dodge Challenger, Focus RS, Audi R8 V10; model hash'leri ayrı.
- Araç başına 84–115 draw, 23–34 parça, 20 teker draw'ı (tyre/rim/disc/caliper), ayrı gövde mesh hash'i. Eşleme kanıtsızsa Corvette fallback + neden; hiçbir araç fallback'e düşmedi.
- `verify_e1_drive` **214/214**; 301/301 temas, 0 NaN, iki koşu aynı; console 0; 3 geometri upload. Teker köşe kimliği AABB kanıtı; simetrik setlerde 10–20 draw `unclassified` (uydurma yok). Audi lastik eşleşmesi `containment` katmanı, preview-only.
- Kanıt: `docs/work/verification/T-007-per-car-meshes.md`.

## 5 Kasım 2026 — engine materyal + instance transform

- 243 sabit materyal satırı / 26 tip: 121 `g_tAlbedo`, 38 `g_mWorld`; type-8 nested yol implement edildi (River'da 0); runtime-only değerler yok.
- 57/57 instance sabit affine `g_mWorld`; 22/22 matris ve bounds `level_inspect` ile 1e-5 içinde; 57/57 VB/IB ve transform satırı Stage A+B referansıyla aynı.
- Packet draw list: **312 kayıt** (255 direct + 57 instance), **117 drawable**, hash `4603a94e0871461c`; 56 nesne, 814.345 B, 65/65, PC parity.
- Kalan: blok15/17/26/32 importu, dokular, culling/LOD, `ProcessLoadChunk`; PoC producer'ına bağlama. Kanıt: `docs/work/verification/T-007-drawlist-v2.md`.

## 5 Kasım 2026 — engine 56-instance draw list

- Blok15/17/26/27/32 CPU deserialiser ile import edildi: 3 chunk / 15 item / 22 VB / 15 IB; blok31 prerequisite nedeniyle dışarıda.
- **56/57 instance**, **34.632 vertex / 25.521 üçgen** — Stage A+B referansıyla birebir. 56/56 matris ve bounds 1e-5 içinde, 57/57 VB/IB eşit.
- Packet 312 kayıt / **151 drawable** / 161 omitted; hash `96b24f076495aea5`; 56 nesne, 823.931 B, **70/70**, PC parity.
- Kalan: dokular (yalnız indeks), `ProcessLoadChunk`, culling/LOD, blok31; PoC producer'ına bağlama. Kanıt: `docs/work/verification/T-007-drawlist-56.md`.

## 5 Kasım 2026 — gerçek yol görseli

- geometry v4: **144 direct draw / 19.167 üçgen** (block88/node283 + sürüş bölgesini kaplayan block56/node289); 32.290 vertex. Collision mesh `visible:false`, `physicsOnly:true`, upload/draw edilmiyor.
- 5 araçta 250–281 draw; 3 geometri upload; 20 capture, console **0**; `verify_e1_drive` **231/231**; state hash'ler değişmedi.
- Drive box'ta 67/314 collision üçgeni gerçek draw ile kaplı; track sonu/off-road boş. Diagnostic materyaller. Kanıt: `docs/work/verification/T-007-track-visual.md`.

## 5 Kasım 2026 — chase camera occlusion

- Görünür mesh'lerden (block27 10.308 + track 19.167 = **29.475 tri / 8.191 node**) deterministik median-split BVH; her tick `aim → eye` Möller–Trumbore.
- İlk isabetten 0,4 m öne çekme; pull-in anında, push-out 0,08/tick; near-field (<3,4 m) etiketli, araç içine çökmüyor. Parametreler (`?camdist` vb.) korundu.
- Focus/Dodge/Lotus mid karelerinde araç görünür; `verify_e1_drive` **268/268**; 301/301 temas, 0 NaN; 20 capture console 0.
- Kamera aralıkları 3.02–9.31 m; sınır: tek cast, continuous collision yok. Kanıt: `docs/work/verification/T-007-camera-collision.md`.

## 5 Kasım 2026 — engine statik dokular

- Packet materyallerinden **102 farklı statik doku** kaynağı; **102/102 decode** (101 BC1 + 1 BC3), 0 unsupported; 109.808 B descriptor+texel, 628.800 B RGBA; aggregate FNV `9c5686eed9334ca4`.
- Asset-reader `texture_inspect --raw` ile **102/102** isim/hash/boyut/seviye/format/RGBA birebir; ilk byte farkı yok.
- 56 nesne, **844.802 B**, **76/76**, PC parity, 0 GPU objesi. Kalan: sampling/UV/wrap/filter/anisotropy, mip seçimi, sRGB, shared (-1) dokular. Kanıt: `docs/work/verification/T-007-engine-textures.md`.

## 5 Kasım 2026 — sprint kuralları

- Start + 2 checkpoint + finish; gate'ler kaplı yol bandından türetildi (x −88 → −59; her kolon 61/61 draw + 61/61 collision). `sprint.json` layout hash `9e5b7bef…`.
- 5 araç süresi: Audi **2,283 s**, Corvette 2,800, Lotus 2,850, Dodge 3,000, Focus **3,267 s**; 2/2 checkpoint, 0 NaN, best time yerel.
- Respawn: off-course → checkpoint-1, süre/checkpoint korunuyor; `R` restart. `verify_e1_drive` **348/348**; 15 sprint capture, console **0**.
- Kalan: tam tur (kapalı pist), gate mesh'i yok (HUD/banner). Kanıt: `docs/work/verification/T-007-sprint-rules.md`.

## 5 Kasım 2026 — engine 57/57 tam node

- Blok31 chunk96 prerequisite grafiği: doğrudan `[82,90,91,87,94,95]`, toplam **14 chunk**, 15.079.424 B, hash `116a3286acb5f6c0`; eksik/döngüsel/desteklenmeyen yok.
- **57/57 instance**, **35.386 vertex / 26.077 üçgen**; blok31 katkısı 754 vertex / 556 üçgen; 57/57 bounds-253 ve VB/IB eşit; 56/56 Stage B matrisi 1e-5.
- Packet 312 kayıt / **152 drawable** / 160 omitted, hash `7c29fb2ec7769709`; 56 nesne, 849.609 B, **80/80**, PC parity, patch değişmedi. Kanıt: `docs/work/verification/T-007-drawlist-57.md`.

## 5 Kasım 2026 — araç dinamiği telemetrisi

- 5 araç, 3 manevra (0–100, 80–0 fren, yanal sweep), 60 Hz, tick-only input; 0–100 sırası XT `torqueScale/mass` ile birebir (Audi 2,650 / Corvette 3,650 / Lotus 3,833 / Dodge 4,633 / Focus 5,133 s).
- Fren: Audi 13,34 m; Lotus en yüksek brake-to-mass olmasına rağmen 17,00 m (anomali kayıtlı). Yanal tepe: Audi 1,52 g, Focus 1,32 g.
- `verify_e1_drive` **423/423**; browser serisi node ile birebir; 5 capture, console 0; fizik state hash'leri P36/P37 anchor'larıyla aynı.
- Bilinen sınır: bu build 3. `e1_reset`/4. `e1_create` sonrası abort ediyor; telemetri her manevra için yeni instance kullanıyor, `R` sayfayı yeniliyor. Kanıt: `docs/work/verification/T-007-telemetry.md`.

## 5 Kasım 2026 — reset/restart düzeltmesi

- Kök neden: `Gravity::C_Scene` scheduler group handle'larını hiç oluşturmuyordu (`Scene.cpp:133-136` yorumlu); `Flush` stale `m_Group` ile pool'a erişiyordu. Önce 1–2 rebuild'de group=0 sessiz, 3.'de group=10, 4.'de trap.
- Düzeltme `e1_drive_lib.cpp` içinde: build'de iki `CreateGroup` + retail `Set…GroupHandle`, release'te `DestroyGroup`. Engine overlay değişmedi.
- Tek instance'ta **10+ rebuild** (5 araç × 10 = 50) aynı 30-tick hash; heap sabit 268.435.456 B; pool head 5, queued 2. Telemetri tek instance; `R` yerinde restart (sprint süreleri aynı).
- `verify_e1_drive` **488/488**; 5/5 restart capture console 0. Kanıt: `docs/work/verification/T-007-reset-fix.md`.

## 5 Kasım 2026 — uzun pist koridoru

- Spawn (-88, 1050) → (268, 1301): **539,81 m** kesintisiz sürülebilir koridor; 2.257 örnek, %99,73 kapsama, 3 boşluk toplam 1,413 m, max basamak 0,078 m (4,47°).
- 6 section kullanıldı: g56-n289, g58-n265, g50-n265, g71-n209, g64-n209, g59-n265; 299 draw / 47.790 üçgen / 78.712 vertex.
- Daha uzun 748,05 m rota var ama g64→g59 dikişinde 1,406 m dikey basamak. Kapalı tur committed veriyle yok (en yakın bileşen 109 m uzakta). Kanıt: `docs/work/analysis/track-coverage.md`, `probes/track-coverage/`.

## 5 Kasım 2026 — PoC soak/performans

- `?soak=1`: **5 sim-dk / 18.000 tick**, iki bağımsız koşu; 13 drive + 13 sprint + 12 telemetri segmenti, 26 packet-timeline yüklemesi.
- Frame interval p50/p95/p99: **7,63–7,97 / 8,06 / 8,52–8,535 ms**; CPU işi p95 0,59 ms; **0** frame >16,7 ms (headless proxy).
- Heap **268.435.456 B sabit**; scheduler pool head 5/queued 2; GPU buffer 208 create / 200 destroy / 8 live; JS heap GC sonrası 39,87→38,05 MB (sızıntı yok).
- Console **0**, abort 0, NaN 0; 38 checkpoint iki koşuda aynı. `verify_e1_drive` **488/488**, soak gate PASS. Kanıt: `docs/work/verification/T-007-soak.md`.

## 5 Kasım 2026 — 540 m parkur denemesi ve fallback

- P43 540 m sprint'i kurdu (394 draw / 57.133 tri görsel; 2 checkpoint + finish; %99,73 kaplama) ama 5 araç **~53 m'de durdu**: g58→g50 ekleminde 7,16 cm collision yükseltisi.
- P46 engine ray probe ile asıl nedeni buldu: ölçülen çizgi **57,82 m'de 50 m'lik collision duvarından** geçiyor; 55,7–59,7 m'de 0,05–1,8 m pinch var. Proxy lift (0,10 m) sadece 55,96 m'ye taşıyor; duvar çözülmüyor.
- **Fallback:** oynanabilir sprint **29 m** (P37/P42, 488→514/514) olarak kaldı; 540 m görsel `?survey=1` ile etiketli (394 draw / 57.133 tri / 3 upload). Proxy lift varsayılan değil.
- `verify_e1_drive` **514/514**, 5 araç drive hash'leri P36 anchor'larıyla aynı; sprint capture 15/15 console 0; survey capture console 0. Kanıt: `docs/work/verification/T-007-ledge-fix.md`.

## 5 Kasım 2026 — engine geniş pist section'ları

- 6 section (g56-n289, g58-n265, g50-n265, g71-n209, g64-n209, g59-n265) engine CPU draw list'ine alındı.
- **299 draw / 47.790 üçgen / 78.712 vertex** — track-coverage referansıyla birebir; bounds 6/6 1e-5, primitive offset 299/299; packet hash `8b3a40324410327f`.
- 2 `g50-n265` draw'ı runtime-only materyal: `materialId=null` + neden. 56 nesne, 859.568 B, **88/88**, PC parity. Kanıt: `docs/work/verification/T-007-drawlist-track.md`.

## 5 Kasım 2026 — track UV0 ve doku binding

- 299/299 draw için UV0 çözüldü (292 F16_4, 7 F16_2; offset 16, stream 0, 5 stride); aggregate `2ed1f4b0b3c9148e`; asset-reader `level_mesh` UV0 ile 299/299 bit-birebir (143.370 indeks).
- Binding: **297 statik / 2 runtime-only**; 151 draw 40 P34 dokusunda, 146 draw 96 çözülmemiş blokta (blok/öğe kayıtlı); aggregate `70237f9bb7f0a20c`.
- 56 nesne, 870.155 B, **92/92**, PC parity. Kalan: sampling/wrap/filter, 96 blok doku, UV1+. Kanıt: `docs/work/verification/T-007-uv-binding.md`.

## 5 Kasım 2026 — track dokularının tamamı

- Kalan 96 blok decode edildi (96/96 DXT1); registry **198** (102 P34 + 96 track), 51.536 B descriptor+texel, 281.600 B RGBA; track aggregate `8d91645d4ee00831`.
- **297/297 statik binding** çözüldü (151 P34 + 146 track), 2 runtime-only `null` + neden; binding aggregate `9cc08756505dd497`; UV0 değişmedi.
- 96/96 asset-reader ile isim/hash/boyut/format/RGBA birebir; 56 nesne, 872.798 B, **99/99**, PC parity. Kalan: sampling/wrap/filter/mip, shared -1, `ProcessLoadChunk`. Kanıt: `docs/work/verification/T-007-track-textures.md`.

## 5 Kasım 2026 — gerçek sürülebilir yol (310 m)

- Collision mesh üzerinde A*: **310,395 m** kesintisiz parkur, spawn (-88,1050) → (103.5,1292.5); 1.245 örnek.
- Max basamak **1,55 cm**, max 2 m eğim **%3,09**, duvara min **7,78 m**; 621 engine trace **0 ihlal**; bağımsız oracle 8/8 PASS.
- Bitişten 4 m sonra yüzey 2,0 m'ye daralıyor (2,276 m araç zarfı); engel duvar değil, daralma. 539,81 m draw koridoru ve 555 m height route reddedildi (50 m fink).
- Sıradaki: 310 m sprint entegrasyonu; 29 m regression control. Kanıt: `docs/work/analysis/drivable-path.md`, `_work/drivable-path/path-map.png`.

## 5 Kasım 2026 — dokulu pist

- 394 draw'dan **297**'si gerçek albedo + UV0 ile sample ediliyor: 136 doku / 439.360 B RGBA; 192.988 float UV / 771.952 B; sampler repeat/linear/mip0/rgba8unorm, sRGB yok (PoC seçimi).
- block88 95 draw binding row olmadığı için diagnostic (`noBindingRowForSection`); 2 runtime-only. Textured coverage: block56 49/49, altı koridor section 297/299.
- `verify_e1_drive` **522/522**; 20 capture console 0; 1 dk soak texture leak yok (136 live). geometry v5 18.791.525 B. Kanıt: `docs/work/verification/T-007-textured-track.md`.

## 5 Kasım 2026 — 310 m parkurun görsel kapsaması

- Collision-only 310,395 m parkurun **%100**'ü gerçek draw ile kaplı: 1.245/1.245 merkez, 1.676 m zarf ve +0,30 m marj.
- Tek section: **g56-n289** (chunk 121/71); 8 draw / 2.817 index / 939 üçgen; genişlik 16,1–24,2 m; visual–collision −0,000921…+0,000929 m.
- 8.715 istasyon testi: 0 eksik collision, 0 eksik draw, 0 tolerans dışı; bağımsız native reader ile 24/24 PASS. Yeni upload gerekmiyor. Kanıt: `_work/drivable-path/visual-coverage.png`, `docs/work/analysis/drivable-path.md` §9.

## 5 Kasım 2026 — araç materyalleri

- 5 araç için 491 draw'dan **224'ü** statik albedo + UV0 ile eşleşti; 40 doku decode edildi (18.178.048 B RGBA); 267 runtime-only (45 paint, 66 light blend, 156 no-albedo).
- 40/40 doku `texture_inspect --raw` ile birebir; 491/491 draw C++ parser ile uyumlu; 3 build × 126 dosya byte-identical.
- Gövde henüz diagnostic renkli; doku entegrasyonu sıradaki. Kanıt: `docs/work/analysis/car-materials.md`, `_work/car-materials/roster/`.

## 5 Kasım 2026 — 310 m oynanabilir sprint

- Varsayılan parkur **310,395 m** (collision-clean); start + 2 checkpoint (arc ~100/200) + finish arc ~300. 29 m `?course=short`.
- 5 araç bitiriyor: Audi **14,15 s**, Corvette 14,65, Lotus 14,77, Dodge 14,92, Focus 15,22; 2/2 checkpoint, 0 respawn, 0 NaN.
- `verify_e1_drive` **550/550**; sprint/short/restart/respawn/survey capture console **0**; 310 m paket 500 draw / 1.060 update. Kanıt: `docs/work/verification/T-007-310m-course.md`.

## 5 Kasım 2026 — engine packet v1.1 export

- `_work/engine-stream-spike/out/packet-engine.json`: **451 draw / 35 mesh / 252 materyal**, 2.246.207 B, hash `0e57f1e5…baba8`; 83.210 üçgen / 131.880 vertex; UV 299/299; 297 statik + 2 runtime doku.
- Render-packet v1.1 şemasına karşı **8 ihlal / 4 not**: timeline yok, topology strip (346 range 3'ün katı değil), `engine-buffer` enum dışı, geometry alanları null. Producer kanıtı; tüketici dönüşümü gerekli.
- 56 nesne, 872.869 B, **99/99**, PC parity. Kanıt: `docs/work/verification/T-007-engine-packet.md`.

## 6 Kasım 2026 — manuel sürüş aspect hatası

- Kullanıcı PoC'de araç hareket etmiyordu. Kök neden: `app.js` canvas aspect'i (2,07) packet kamera aspect'ine (1,78) eşit değilse **hard throw** ediyordu; sayfa `consumer=error`, tick 1'de kalıyordu.
- Düzeltme: `applyCanvasAspect()` canvas oranını `consumer.cameraShape.aspect` ve `session.packet.camera.aspect`'e uygular; resize dinlenir; throw kaldırıldı.
- CDP manuel W testi: tick 93→274, hız **31,36 m/s**, console 0. `verify_e1_drive` **570/570**.

## 6 Kasım 2026 — soak 310 m regresyonu

- 310 m varsayılanı sonrası soak'ın drive/telemetry segmentleri node anchor'larıyla uyuşmuyordu: ortak dünya kurs tangentinde (0,767 rad) kuruluyordu.
- Düzeltme: soak drive/telemetry fazları **legacy spawn heading** (1,5708), sprint fazı kurs tangent'i ile dünya kuruyor.
- `soak_browser --minutes 1 --runs 2`: **PASS**, 0 failure, 145 canlı doku sabit. `verify_e1_drive` **570/570**.

## 6 Kasım 2026 — araç UV yönü

- P55'in `(u, 1−v)` yönü yanlıştı; plakalar 180° dönüktü. Kanıt: Audi `350L EMO`, ZR1 `DQF 9760`, Dodge `California 2SBI653`.
- Doğru kural: **224 statik-albedo car draw** için **`(1−u, v)`**; track ham UV. UV/piksel/sayı değişmedi.
- `verify_e1_drive` **570/570**; 20 capture console 0; fizik hash'leri aynı. Kanıt: `docs/work/verification/T-007-car-uv-orientation.md`.

## 6 Kasım 2026 — direksiyon yönü

- Kullanıcı testi: `D`/sağ ok araçta sola dönüyor. UI eşlemesi kullanıcı yönüne göre ters çevrildi (`steerSign = -1` varsayılan); ham eşleme `?invertSteer=0`, anlık geçiş `I`.
- Scripted sprint controller etkilenmez. CDP: D artık `str=-1` gönderiyor; `verify_e1_drive` **570/570**.

## 6 Kasım 2026 — araç dokuları entegre

- 5 araçta 491 draw'dan **224'ü** gerçek albedo + UV0 ile dokulandı: Corvette 50, Lotus 48, Dodge 42, Focus 37, Audi 47; 40 doku / 18.178.048 B RGBA.
- 267 draw diagnostic (45 paint, 66 light, 156 no-albedo); sampler repeat/linear/mip0; sRGB/paint/mip yok.
- `verify_e1_drive` **570/570**; 20 capture console 0; 1 dk 2-run soak temiz; fizik hash'leri değişmedi. Geometry v6 45.180.725 B. Kanıt: `docs/work/verification/T-007-textured-cars.md`.

## 6 Kasım 2026 — paint/light statik referansları

- 267 runtime draw'da **424** `TEXTURE_INDEX` alanı statik dokuya çözüldü (0 unsupported): paint dent/scratch/bump 45, light off/on/damage 66, other no-albedo 50/156.
- 24/29 doku decode; 5 shared 1024² `smashedglass_nrm` decoder sınırı dışında (uydurulmadı). Paint lookup ve light blend runtime; renk/light state iddiası yok.
- `verify_runtime_textures.py` **PASS**, 24/24 texture_inspect eşleşmesi, 78 dosya deterministic; suite **30/30**. Kanıt: `docs/work/analysis/car-materials.md` §9.

## 6 Kasım 2026 — kapalı tur bulundu

- Collision mesh üzerinde üç kapalı loop: **loop-01 222,0 m** (önerilen), loop-02 224,2 m, loop-03 91,1 m.
- loop-01: min duvar 2,06 m, bant 11,75 m, seam 0,5 m, max basamak 0,40 cm, max eğim %1,49; engine trace **PASS**, 0 ihlal.
- Spawn bileşeninden **1,138 m** duvar boşluğu var; lap modu loop-01 üzerinde spawn etmeli. Kanıt: `docs/work/analysis/lap-search.md`, `_work/lap-search/loops.png`.

## 5 Kasım 2026 — wire layout probe (T-006b)

- Native MSVC x64 vs wasm32: `Datagram*`/`NetRaceSettings`/`NetVehicleData` aynı; `SysProfile::BaseProfile` 56→80 B, `NetStartRacePacket` 2104→2584 B (`wchar_t` 2→4, +480 B).
- **`-fshort-wchar` mitigation değil:** `BaseProfile` 48 B (MSVC base-size vs Itanium dsize), Join 125→117, StartRace 2104→1944 — yanlış yöne. `#pragma pack(1)` reddedildi.
- Öneri: `BaseProfile`/`NetStartRacePacketPlayer`/`StartRace` için açık encoder; golden layout native (56 B, isim @16 17 UTF-16LE; 2104 B / 20 slot).
- Probe ana suite'e eklendi: **30/30**. Kanıt: `docs/work/analysis/net-layout.md`, `probes/net-layout/`.

## 5 Kasım 2026 — PoC hazırlık kontrolü

- `tools/check_e1_poc.py`: 19/19 PASS, 0 FAIL, ~0,32 s; modül/glue, geometry v6, levelphysics, spawn, 310 m + 29 m layout/per-car runs, 5 araç, UV/doku manifestleri, sayfa kaynakları ve 8801 sunucusu.
- `--json`/`--hash` modları; eksik artifact exit 2, check failure exit 1. Sunucu başlatmıyor/durdurmuyor.
- `docs/handoff/E1_POC_TEST.md`: başlatma, URL, 5 araç süreleri, kontroller, modlar, console 0 kontrolü, sınırlar, hata bildirme. Kanıt: `_work/logs/e1-poc-check.log`.

## 5 Kasım 2026 — PoC çalıştırılabilir

- `tools/run_e1_poc.ps1` + `docs/handoff/E1_POC.md`: eksik artifact kontrolü, tek komut, `http://127.0.0.1:8801/`.
- Sunucu doğrulandı: `/` HTTP 200, `e1_drive.wasm` 1.003.249 B HTTP 200.
- 5 araç seçici ve `?car=` URL'i; scripted mod `?script=drive&car=...`.
- Kullanıcı testi için hazır; görsel sadakat/teker/engine draw-list işleri devam ediyor.


