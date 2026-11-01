# Blur PC kopyası ve Rebuilt uyumluluğu araştırması

Araştırma tarihi: 28 Ekim 2026. Hiçbir oyun dosyası indirilmedi veya çalıştırılmadı. Kanıt düzeyleri: geliştiricinin kendi açıklaması / tekil kullanıcı deneyimi / araştırmacı çıkarımı.

## Sonuç

Rebuilt için gerekli olan tam PC oyun verileri. En güçlü topluluk kanıtı, geliştiricinin kendi duyurusundaki bir kullanıcının **retail ISO kurulumu üzerine Rebuilt dosyalarını koyarak çalıştırdığını** bildirmesi. Ancak belirli bir arşivin SHA-256 değeriyle tanımlanmış, Windows üzerinde yeniden üretilmiş Rebuilt başarı testi bulamadım. Bu nedenle belirli bir repack'i “Rebuilt ile doğrulandı” diye önermek doğru olmaz.

## Geliştirici ve doğrudan Rebuilt deneyimi

[uKER'in Rebuilt duyurusu](https://www.reddit.com/r/BlurGame/comments/1xa2w6p/blur_rebuilt_64bit_directx_11_hdr_unlocked/?sort=new) geliştiricinin kendi GitHub bağlantısını içeriyor; kimliği ve proje bağlantısı bu şekilde doğrulanıyor.

- DagNastyFieldDay, retail ISO ile kurduğu oyunun üzerine yeni exe ve klasörü ekleyerek Steam Machine'de çalıştırdığını söylüyor. Aynı temel kurulumu Steam Deck'te de kullandığını belirtiyor. Orijinal kurulumu değiştirilmiş no-CD exe içeriyormuş; bu bilgi çalıştırma talimatı veya önerisi değildir. Kaynak tam olarak hangi ISO dağıtımı, sürümü, dili veya hash'i olduğunu söylemiyor. **Kanıt: tekil doğrudan Rebuilt başarı raporu.** [Doğrudan yorum](https://www.reddit.com/r/BlurGame/comments/1xa2w6p/comment/phy63yh/)
- Broka1979 oyunun iyi oynandığını ancak ultrawide HUD sorunu yaşadığını bildiriyor; video da paylaşıyor. Sonraki yorumunda v1.5 ses sorununu bildiriyor; geliştirici düzeltme yaptığını ancak henüz yayınlamadığını söylüyor. Bu, yalnızca “çalıştı” yorumlarının sürüm ve hata ayrıntılarıyla okunması gerektiğini gösteriyor.
- Aynı başlıkta başka kullanıcı normal oyun çalışırken Rebuilt'in Linux/Proton'da açılmadığını bildiriyor. Steam Machine başarısı bütün Proton kurulumlarının uyumlu olduğunu kanıtlamıyor.
- Browser portuyla ilgilenen başka bir kullanıcı da var; geliştiricinin yanıtı kaynak kod bağlantısına yönlendirmekle sınırlı. Çalışan browser portu kanıtı değil.

Reddit'in önbelleklenmiş görünümleri göreli tarihlerde tutarsızlık gösterdiği için yorumların kesin takvim günlerini tahmin etmedim; yukarıdaki yorumlar araştırma tarihinde okunabildi.

[Rebuilt README, kontrol edilen commit 5270304b81983b9e3edbd569ba25235c17bbabd7](https://github.com/uKER/BlurRebuilt/blob/5270304b81983b9e3edbd569ba25235c17bbabd7/README.md): kurulu Blur PC kopyası, Windows 10/11 x64, DX11 GPU ve VC++ x64 runtime gerekiyor. BlurRebuilt.exe, AmaxClientHost.exe ve fx11 klasörü oyun dizinine ekleniyor; AMAX istemcisi ayrıca amax_client_files klasörüne açılıyor. Güncel README online multiplayer desteğini açıkça beyan ediyor. **Kanıt: geliştirici belgesi.** Önceki arama önbelleğinde görülen “yarış henüz doğrulanmadı” paragrafı bu canlı sürümde yok; geliştiriciye böyle bir güncel iddia atfedilmemeli. Bizim araştırmamızda ise bağımsız bir kullanıcının Rebuilt ile çok oyunculu yarışı baştan sona tamamladığına dair yeterli kanıt bulunamadı; bu, desteğin çalışmadığı anlamına gelmez.

## Tam kopyalar için somut topluluk karşılaştırması

[My Abandonware Blur sayfası](https://www.myabandonware.com/game/blur-gls) 5,2 GB orijinal DVD ISO, İngilizce v1.2 ön kurulu Full-Rip ve 3,9 GB ElAmigos/R.G.Mechanics paketleri listeliyor. Sayfada SHA-256 manifesti bulamadım. 18 Mayıs 2023 tarihli SolidFreedom yorumu R.G.Mechanics paketinin kurulup çalıştığını; 7 Kasım 2023 yorumu ise aynı pakette Rusça dil sorununu bildiriyor. 10 Ocak 2023 ISO kullanıcısı disk istemi yaşamış. Bunlar Rebuilt öncesindeki normal oyunun deneyimleri. **Kanıt: arşiv listesi ve tekil kullanıcı yorumları; Rebuilt uyumluluğu değil.**

[r/abandonware — Blur Download Link](https://www.reddit.com/r/abandonware/comments/13yvsc1/blur_download_link/) 3 Haziran 2023'te ön kurulu Google Drive paketi paylaşmış. Yorumlarda:

- 19 Nisan 2026: bir kullanıcı Drive kopyasında siyah ekran yaşadığını, My Abandonware'deki R.G.Mechanics kurulumuyla oyunun çalıştığını söylüyor.
- 2 Temmuz 2026: kullanıcı Drive kopyasında kontrolcü ikonları ve AMAX modlarını etkinleştiremediğini belirtiyor. 10 Temmuz yanıtı disk sürümlerini öneriyor. Bu önemli ama AMAX başarısızlığının dosya/sürüm nedenini kanıtlamıyor.
- 16 Mart 2025: LAN partisinde yalnızca iki kişinin birlikte bağlanabildiği bildiriliyor. Dolayısıyla oyunun açılması arkadaşlarla multiplayer için yeterli doğrulama değil.
- DirectX DLL eksikliği, siyah ekran ve indirme kotası raporları da var.

**Kanıt: kullanıcı deneyimleri.** Başarı yorumları dosya güvenliğini, dağıtım yetkisini veya hash bütünlüğünü doğrulamaz. Belirli Windows sürümü/donanım/build ile eşleşmedikleri sürece kesin öneri sayılmazlar.

## Proje için önerilen seçim yöntemi

**Araştırmacı çıkarımı:** Geliştirme referansı için, tam dosya yapısı korunmuş ve kökeni belgelenebilen retail PC veri seti en anlaşılır başlangıç. Rastgele ön kurulu, farklı modlar içeren paketlerin karşılaştırma maliyeti daha yüksek. ISO da yalnızca paket biçimi; tek başına orijinallik veya güvenlik kanıtı değil. R.G.Mechanics normal oyun için belirli başarı raporuna sahip, fakat Rebuilt için özel doğrulaması yok.

Bir kopya elde edildiğinde ilk iş çalıştırmak yerine dosya envanteri, boyutlar ve SHA-256 manifesti çıkarmak; varsa güvenilir referans hash'lerle karşılaştırmak. Kendi hesapladığımız hash tek başına güvenlik veya orijinallik kanıtı olmaz, yalnızca sonraki denemelerin aynı veriyle yapılmasını sağlar. Ardından temiz çalışma kopyasında Rebuilt menü → tek yarış → LAN/AMAX testleri ayrı kaydedilir. Eski 32 bit oyun modlarının x64 Rebuilt'e otomatik uyacağını varsaymayız.

## Açık kalanlar

- Geliştiricinin kullandığı tam oyun veri sürümü ve hash manifesti.
- Ön kurulu v1.2 ile DVD kurulumunun Rebuilt açısından dosya farkları.
- Windows'ta bu belirli arşivlerden biriyle bağımsız doğrulanmış Rebuilt testi.
- İki veya daha fazla oyuncuyla tamamlanan Rebuilt yarışı.
- Arşivlerin dağıtım yetkisi ve ikili dosyaların güvenliği doğrulanmış değil.
