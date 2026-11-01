# Windows derleme hazırlığı

28 Ekim 2026. İncelenen kaynak: `upstream/BlurRebuilt`, commit `5270304b81983b9e3edbd569ba25235c17bbabd7`. Bu çalışma yalnız ortam ve derleme zinciri incelemesidir; oyun çalıştırılmadı, derleme veya yazılım kurulumu yapılmadı, upstream kaynakları değiştirilmedi.

## Karar

Önce yerel Windows x64 derlemesini yeniden üretmeliyiz. Oyun indirmesinin bitmesi derleyici ve SDK hazırlığı için şart değil. Projenin `.github/workflows/release.yml` dosyası, geliştiricinin kişisel makine yollarını içeren eski `tools/build.sh` dosyasından daha uygun bir yeniden üretim örneği sunuyor. Workflow hem Visual Studio 17 2022 hem 18 2026 jeneratörünü tanıyor ve `-A x64` kullanıyor. Yerel test için Release (Speed), oyuncu paketi için MinSizeRel (Master) ayrımı korunmalı.

## Bu bilgisayarda doğrulananlar

| Bileşen | Durum / etkisi |
|---|---|
| Git | Codex bundled Git 2.53.0.windows.3 mevcut; kaynak indirildi. GitHub oturumu açık public repo okumak ve yerel derleme için gerekli değil. |
| Python | PATH'teki `python.exe` Windows Store alias'ı. Çalışan gerçek Python: `C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe`, sürüm 3.12.14. |
| Node | Codex bundled runtime mevcut; native build için temel gereksinim değil. |
| Visual Studio / MSVC | Standart Program Files yollarında VS Installer/vswhere veya VS kurulumu bulunmadı. `cl`, `msbuild` PATH'te yok. Native build şu an bu noktada engelli. |
| Windows SDK | Standart `C:/Program Files (x86)/Windows Kits` yolu bulunmadı. `fxc.exe`, SDK header ve import library girdileri hazır kabul edilemez. |
| CMake / Ninja | PATH'te yok; standart CMake kurulum yolu bulunmadı. Ninja şart değil: upstream VS/MSBuild generator kullanıyor. |
| Perl / Bash | PATH'te yok. Bundled Git'te `usr/bin/sh.exe` var, fakat kontrol edilen yolda `perl.exe` ve `bash.exe` yok. Eski OpenSSL build'i Perl istiyor. PowerShell release workflow, Bash zorunluluğunu kaldırıyor. |
| Emscripten / Clang | PATH'te yok. Native referans tamamlanmadan tam motor WASM derlemesine geçilmeyecek. |
| Depolama | C diskinde yaklaşık 1,15 TB boş alan bulundu; kurulum alanı şu an ana engel değil. |
| GPU | NVIDIA GeForce RTX 5080 görülüyor (sürücü 32.0.16.1692). DX11 probe çalıştırılmadı; GPU adından gerçek oyun uyumluluğu kanıtı çıkarmıyoruz. |

Bu sonuçlar `Get-Command`, standart kurulum yolu sorguları, bundled Python `--version`, `git --version`, `Get-CimInstance Win32_VideoController` ve `Get-PSDrive` ile alındı. Gizli dosyalar veya hesap bilgileri okunmadı. PATH'te bulunmamak, standart dışı bir klasörde kurulum olmadığının kesin kanıtı değildir.

## Kaynaktan çıkan gerçek girdiler

- CMake en az 3.25. `cmake/blur_common.cmake` MSVC dışı derleyiciyi reddediyor; C++14 ve Microsoft uzantıları kullanılıyor. FX11/DX11 hedefleri C++17 istiyor.
- Visual Studio Build Tools veya Community: MSVC x86/x64 araçları, MSBuild, C++ CMake tools ve Windows SDK. VS IDE zorunlu değil; ancak Build Tools seçilirse CMake'nin gerçekten kurulduğunu ayrıca kontrol etmeliyiz. Sadece VC++ Redistributable kurmak derleyici sağlamaz.
- Windows SDK `fxc.exe`: `cmake/dx11.cmake` standart SDK `bin/*/x86` altından arıyor. Runtime DX11 zaten Windows'ta bulunabilir, fakat runtime ile SDK/FXC aynı şey değil.
- Microsoft.DXSDK.D3DX **9.29.952.8** NuGet paketi: upstream build include düzeni için gerekli. x64 notlarına göre modern exe D3DX9/D3D9 DLL'lerine link etmiyor; yine de header ve eski enum bağımlılıkları var.
- OpenAL Soft **1.24.3** binary dağıtımı: build'de header/import library yolları var. Gerçek oyun ses çıkışı DirectSound; OpenAL runtime kullanımı varsayılmamalı.
- IJG libjpeg **6b** kaynakları: CMake bunları derliyor. Eksik olursa warning ile devam edebilir ama `JpegHelper` linklenemez; çalışır tam oyun build'i için hazır olmalı.
- OpenSSL **0.9.8i** kaynakları ve bunlardan x64 statik `libeay32.lib` / `ssleay32.lib`: CMake bulunmazsa fatal error veriyor. Upstream helper `tools/demonware_cmake/build_openssl_x64.cmd` Perl + vcvars64 + nmake istiyor. Bu eski sürüm mevcut DemonWare entegrasyonuyla eşleşme içindir; yeni web servislerinde kullanılacak TLS altyapısı olarak seçilmemeli.
- DemonWare x64 kütüphaneleri `cmake/demonware.cmake` ile repo içindeki kaynaklardan üretiliyor. Eski x86 `.lib` dosyalarının x64 hedefte kullanılması yeterli değil.
- Bink video ve bazı eski SDK parçaları için repo shim/stub içeriyor. Kaybolmuş bütün eski proprietary SDK'ları edinmek gerektiği sonucu çıkmıyor.

Paket kaynakları ve beklenen SHA1 değerleri `.github/workflows/release.yml` içinde mevcut. İndirilen her paketin hash'i kontrol edilmeli; ayrıca yerel SHA-256 manifest tutulmalı. Upstream SHA1 sabitlemesi provenance/imza yerine geçmez.

## Önerilen ilk derleme kapıları

1. **Araç kapısı:** VS/MSVC + SDK + CMake ve Perl hazırla; gerçek exe yollarını kaydet. `cl`, `cmake --version`, `fxc /?` ve `nmake` çalışsın. Çok GB'lık VS kurulumu bu inceleme sırasında başlatılmadı.
2. **Küçük native probe:** `BLUR_DX11_ONLY=ON` ile ayrı `_work/build/dx11-only` build klasörü yapılandır. `dx11_hdr_reference` hedefini önce derlemek, tam oyun/OpenSSL/libjpeg bağımlılıklarına girmeden temel derleyici + Windows SDK + FX11 bağlantısını test eder. `dx11_probe` hedefi shader ve effect derlemelerine de bağlıdır; o daha geniş ikinci testtir. Başarılı link yalnız araç zincirini doğrular; oyun uyumluluğunu kanıtlamaz.
3. **Vendor kapısı:** belirtilen paketleri kontrollü `_work/vendor` ve `_work/vendor_x64` klasörlerine hazırla; OpenSSL x64 derlemesini yap. Cache değişkenlerini açık yollarla ver.
4. **Generator kapısı:** release workflow sırasıyla `jamextract.py`, `cpgen.py`, `shadergen.py`, `luabundle.py`, `gen_cmake.py` çalıştır. Üretilen `cmake/targets.cmake` upstream ile karşılaştırılsın; varsayılan checkout'u değiştirmeden ayrı geliştirme worktree'sinde yapılmalı.
5. **Tam native kapısı:** `-A x64`, önce Release/Speed `Amax` hedefi; log ve `errsum.py` sonucu kaydedilsin. Sonra retail veri setiyle menü ve tek yarış. MinSizeRel dağıtım build'i bu doğrulamadan sonra.

Örnek küçük yapılandırma (gerçek CMake yolu ve generator kurulumdan sonra çözülecek):

```powershell
cmake -S . -B _work/build/dx11-only -G "Visual Studio 18 2026" -A x64 -DBLUR_DX11_ONLY=ON -DPython3_EXECUTABLE="C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
cmake --build _work/build/dx11-only --config Release --target dx11_hdr_reference
```

Bunlar henüz çalıştırılmış komutlar değildir. VS 2022 kurulursa generator `Visual Studio 17 2022` olmalı. Standard `tools/build.sh` içindeki developer-specific `C:/Program Files/Microsoft Visual Studio/18/Community/...` yolu ve `-A Win32` bu x64 hedefe aynen uygulanmamalı.

## Upstream iş akışıyla ilgili yerel fark

AGENTS.md okundu. İstenen `tools/agent_context.py context` bundled Python ile çalıştırıldı, ancak `--root must name a Blur phase worktree` hatası verdi: helper klasör adını `Blur1PC`, `Blur1Multi`, `BlurX` veya `Blur1PCDX11` listesiyle sınırlandırıyor; checkout adı `BlurRebuilt`. Kaynakta değişiklik yapılmadı. Geliştirme worktree'sinin adı/phase düzeni kurulurken bu sınır çözülecek. Salt okunur keşif için helper'ı değiştirmek gerekmedi.

## Kaynaklar

- [Release workflow](https://github.com/uKER/BlurRebuilt/blob/5270304b81983b9e3edbd569ba25235c17bbabd7/.github/workflows/release.yml)
- [Ortak CMake](https://github.com/uKER/BlurRebuilt/blob/5270304b81983b9e3edbd569ba25235c17bbabd7/cmake/blur_common.cmake)
- [DX11 CMake](https://github.com/uKER/BlurRebuilt/blob/5270304b81983b9e3edbd569ba25235c17bbabd7/cmake/dx11.cmake)
- [x64 build notları](https://github.com/uKER/BlurRebuilt/blob/5270304b81983b9e3edbd569ba25235c17bbabd7/docs/blur1pcdx11/x64.md)
- [Build referansı](https://github.com/uKER/BlurRebuilt/blob/5270304b81983b9e3edbd569ba25235c17bbabd7/docs/agent-reference/build.md)
