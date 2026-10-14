// SPDX-License-Identifier: AGPL-3.0-or-later

import {defineContentI18nLocaleMessages} from '../ContentI18nMessages';

const CONTENT_I18N_FI_MESSAGES = defineContentI18nLocaleMessages({
	"auth.unknown_location": "Tuntematon sijainti",
	"billing.donation_description_monthly": "Kuukausittainen lahjoitus {product_name}-palvelun tukemiseen",
	"billing.donation_description_one_time": "Kertalahjoitus {product_name}-palvelun tukemiseen",
	"billing.donation_description_yearly": "Vuosittainen lahjoitus {product_name}-palvelun tukemiseen",
	"billing.donation_name_one_time": "{product_name}-lahjoitus",
	"billing.donation_name_recurring": "Toistuva {product_name}-lahjoitus",
	"billing.eu_withdrawal_waiver_checkout": "Jos olen EU/ETA-kuluttaja, annan nimenomaisen suostumukseni sille, että {product_name} {premium_tier_name} -palvelun digitaalinen sisältö toimitetaan välittömästi, ja hyväksyn, että menetän lakisääteisen peruuttamisoikeuteni, kun saan pääsyn sisältöön. Tämä ei vaikuta muihin pakottaviin kuluttajaoikeuksiin. Katso [käyttöehdot]({terms_url}).",
	"bulk_message_deletion.complete": "Olemme poistaneet viestisi. Poistimme {message_count, plural, =0 {0 viestiä} one {# viestin} other {# viestiä}} {channel_count, plural, =0 {0 paikasta} one {# paikasta} other {# paikasta}}.",
	"content.virus_detected": "Tiedosto merkittiin mahdollisesti vaaralliseksi ja se on poistettu.",
	"feed.comment_removed_by_moderator": "Moderaattori poisti yhden syötekommentistasi käyttöehtojemme tai yhteisösääntöjemme rikkomisen vuoksi.",
	"feed.post_removed_by_moderator": "Moderaattori poisti yhden syötejulkaisustasi käyttöehtojemme tai yhteisösääntöjemme rikkomisen vuoksi.",
	"feed.video_failed": "Syötevideoasi ei voitu käsitellä, joten sitä ei julkaistu.",
	"feed.video_gone": "Syötejulkaisusi poistettiin, koska sen video ei ole enää saatavilla.",
	"feed.video_rejected": "Videosi ei läpäissyt sisältötarkistuksiamme, joten sitä ei näytetä syötteessä.",
	"feed.video_too_large": "Videotasi ei julkaistu syötteessä, koska se on yli 500 MB.",
	"guild.bulk_create.emoji_limit": "Emojien enimmäismäärä on saavutettu ({limit}).",
	"guild.bulk_create.sticker_limit": "Tarrojen enimmäismäärä on saavutettu ({limit}).",
	"guild.bulk_create.unknown_error": "Tuntematon virhe.",
	"guild.default_category_text": "Tekstikanavat",
	"guild.default_category_voice": "Äänikanavat",
	"guild.default_channel_text": "yleinen",
	"guild.default_channel_voice": "Yleinen",
	"referral.reward_ready": "Suosittelupalkkiosi on valmis. Näet sen kohdassa Asetukset → Suosittelu."
});

export default CONTENT_I18N_FI_MESSAGES;
