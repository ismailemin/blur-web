# Oturum kaydı — 7 Kasım 2026, multiplayer + içerik denetimleri

**Hedef:** tam oyunun multiplayer-test edilebilir sürümü; tüm arabalar,
özellikler (silah/mayın/kalkan), haritalar. Plan: `docs/plan/FULL_GAME.md`.

## Commit'ler

| Commit | İş |
|---|---|
| `902071a` | Tam oyun/multiplayer yol haritası |
| `f16229d` | M1 online race tasarımı |
| `1d9c58e` | Doku kalitesi: sRGB + mip zinciri |
| `369844e` | 62 araç sınıflandırması |
| `a5f986c` | Yarış mantığı/AI denetimi |
| `19fb5f2` | 19 harita sınıflandırması |
| `c00baae` | Power-up tanımları + kurallar |
| `811bac3` | Ana suite 36 kontrol (içerik + power-up + V2) |
| `faf73a2` | Araç genişleme partileri planı |

## Denetim sonuçları

- **Araçlar:** 5 A / 42 B / 15 C; 542/542. B araçlarda model+Scene+materyal+fizik
  hazır; 4 guard 5 araca sabit. Sıradaki 10 araç manifestli.
- **Haritalar:** 1 A / 16 B / 2 C; 193/193. Sıradaki: usa_amboy (2.060,6 m,
  %97,6), gracia (624,9 m, %99,6), longbeachdocks (818,4 m, %47,3).
- **Yarış mantığı:** 481 dosya/134.941 satır; 108 dosya AI object-compile;
  M1 için 5 modüllü kural katmanı.
- **Power-up:** 11 tip (8 MP), 7 varyant, 439 MP satırı, 86 AmaxEvent;
  1.783/1.783; kurallar 9/9.

## Doku kalitesi

- Çift gamma + mip0 aliasing düzeltildi: sRGB upload, linear-light mip zinciri,
  trilinear, anisotropy. 4 karede %91–99,6 değişim; fizik/packet hash sabit.

## Ana kapı

`python tools/verify_asset_probe.py` → **36/36** (tam), `--skip-build` 35/35.
Yeni kontroller: power-up tanımları/kuralları, araç matrisi, harita matrisi,
V2 collider.

## Devam eden akışlar (bu kayıt anında)

- **N1:** oda servisi + 2 istemci transport (`probes/net-mvp/`).
- **P74b:** V2 collider entegrasyonu (lap/free solid).
- **R1:** çok oyunculu yarış kural katmanı (`probes/race-rules/`).
- **A2:** tyre + collision sesi.
- **MAP2:** usa_amboy oynanabilir dilim paketi.

## Sıradaki

1. N1 + R1 → M1 online race entegrasyonu (2 tarayıcı, River).
2. P74b → boru/duvar solid; yeni capture.
3. MAP2 → ikinci harita paketi.
4. Araç Parti 1 (10 B araç).

## Kullanıcıdan gereken

- Şu an hiçbir şey. Yerel iki-istemci testi ağ ayarı istemiyor. Yalnızca farklı
  ağlardan gerçek test (NAT/TURN) aşamasında erişilebilir host gerekebilir.
