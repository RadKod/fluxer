# sanalyer

[sanalyer.com](https://sanalyer.com)'un web uygulaması, sunucusu ve masaüstü uygulaması. Bir arkadaş grubunun kendi
sohbet ve ses sunucusu; davetle girilen, reklamı yapılmayan bir yer.

Kod [Fluxer](https://github.com/fluxerapp/fluxer)'ın fork'u. Fluxer açık kaynak, Discord'a benzer bir uygulama;
biz üstüne kendi markamızı, birkaç özelliği ve [Micup](./NOTICE-MICUP.md)'tan taşınan parçaları ekledik. Bu repo
public, çünkü AGPL değiştirilmiş sürümün kaynağını kullanıcılarına açmayı şart koşuyor.

- **Uygulama:** [sanalyer.com](https://sanalyer.com) (tarayıcıdan), masaüstü için [sanalyer.com/indir](https://sanalyer.com/indir)
- **Mobil:** ayrı repo, [RadKod/sanalyer.com-mobile](https://github.com/RadKod/sanalyer.com-mobile). iOS şimdilik TestFlight'ta, davetle.
- **Altyapı, marka ve araçlar:** [RadKod/sanalyer.com](https://github.com/RadKod/sanalyer.com)
- **Geliştirici belgeleri:** [sanalyer.com/docs](https://sanalyer.com/docs/)

## Branch'ler

| Branch | Ne |
| --- | --- |
| `sanalyer` | Canlıdaki kod. Image'lar ve masaüstü sürümleri buradan çıkar. |
| `main` | Upstream'in (fluxerapp/fluxer) kopyası, bizim değişikliğimiz yok. |
| `upstream-merge` | Upstream'i almak için geçici branch; merge kontrolleri geçince `sanalyer`'e girer. |

Upstream'i `upstream` remote'u olarak tutup düzenli merge ediyoruz:

```bash
git remote add upstream https://github.com/fluxerapp/fluxer.git
git fetch upstream
git checkout -B upstream-merge sanalyer
git merge upstream/main
```

Çevirilerde ve JSON dosyalarında çıkan conflict'ler için yardımcı script'ler sanalyer.com reposunda,
`scripts/merge/` altında. Her merge'den sonra kullanıcıya görünen metinlerde "Fluxer" taraması yapılır; belgeler için
`node tools/brand/docs-marka.mjs --check`.

## Upstream'den farkımız

- **Marka:** kullanıcının gördüğü her ad, link ve simge sanalyer. Fluxer adı yalnız kod içinde, env adlarında ve iç
  tanımlayıcılarda kalıyor.
- **Micup'tan taşınanlar:** profil kartı, soundboard, isim stilleri, odalar ve masaüstü kabuğunun bir kısmı. Ayrıntısı ve
  lisans bildirimi [NOTICE-MICUP.md](./NOTICE-MICUP.md)'de.
- **Kozmetikler:** avatar dekorasyonları, profil efektleri ve nameplate'ler seri seri gruplanıyor; mağaza ve admin
  kataloğu buna göre.
- **Keşfet > Temalar:** hazır renk paletleri (`fluxer_app/src/features/discovery/themes/`).
- **Mobil bildirim kuralı:** masaüstü açıkken de telefona bildirim gidiyor. Masaüstü uzaktaysa hemen, kullanılıyorsa
  mesaj 2 dakika okunmazsa (`push_unread_grace_ms`, gateway).
- **Masaüstü:** `fluxer_desktop`, `com.sanalyer.desktop` kimliğiyle; güncellemeler dl.sanalyer.com'dan geliyor.

## Image ve sürüm

Sunucu `ghcr.io/radkod/` altındaki image'ları çalıştırıyor, tag commit sha'sı.

```bash
# Sunucu image'ları (15-20 dk)
gh workflow run sanalyer-imaj.yml -R RadKod/fluxer --ref sanalyer -f ref=sanalyer

# Masaüstü (macOS imzalı ve notarize, Windows, Linux); publish_release=true paketleri dl.sanalyer.com'a yükler
gh workflow run sanalyer-masaustu.yml -R RadKod/fluxer --ref sanalyer -f channel=stable -f publish_release=false
```

Deploy, yedek ve sunucu düzeni sanalyer.com reposunun README'sinde ve `docs/durum.md`'sinde anlatılıyor.

## Yerelde çalıştırmak

Geliştirme ortamı upstream'inkiyle aynı; yol `fluxer_docs/` içindeki belgelerde. Bu Mac'e özgü tuzaklar (pnpm sürümü,
Rust toolchain) sanalyer.com reposunun `docs/durum.md` dosyasında, "Tuzaklar" altında.

## Lisans

Kod [AGPL-3.0-or-later](./LICENSE). Fluxer'ın görselleri (logo, ikonlar, rozetler, varsayılan avatarlar)
[CC BY-SA 4.0](./fluxer_static/LICENSE); üçüncü taraf malzeme kendi koşullarını taşıyor,
[fluxer_static/THIRD_PARTY_LICENSES.md](./fluxer_static/THIRD_PARTY_LICENSES.md).

"Fluxer" ve "Micup" adları ve logoları lisansın kapsamında değil ([name and marks](./.github/GOVERNANCE.md#name-and-marks)).
Upstream'in marka kuralı gereği bu fork kendi adını ve logosunu kullanıyor.
