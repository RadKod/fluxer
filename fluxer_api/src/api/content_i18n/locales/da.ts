// SPDX-License-Identifier: AGPL-3.0-or-later

import {defineContentI18nLocaleMessages} from '../ContentI18nMessages';

const CONTENT_I18N_DA_MESSAGES = defineContentI18nLocaleMessages({
	"auth.unknown_location": "Ukendt sted",
	"billing.donation_description_monthly": "Månedlig donation til støtte for {product_name}",
	"billing.donation_description_one_time": "Engangsdonation til støtte for {product_name}",
	"billing.donation_description_yearly": "Årlig donation til støtte for {product_name}",
	"billing.donation_name_one_time": "Donation til {product_name}",
	"billing.donation_name_recurring": "Tilbagevendende donation til {product_name}",
	"billing.eu_withdrawal_waiver_checkout": "Hvis jeg er forbruger i EU/EØS, giver jeg udtrykkeligt samtykke til, at det digitale indhold i {product_name} {premium_tier_name} leveres med det samme, og jeg anerkender, at jeg mister min lovbestemte fortrydelsesret, når jeg får adgang. Dette påvirker ikke andre ufravigelige forbrugerrettigheder. Se [servicevilkårene]({terms_url}).",
	"bulk_message_deletion.complete": "Vi er færdige med at slette dine beskeder. Vi fjernede {message_count, plural, =0 {0 beskeder} one {# besked} other {# beskeder}} fra {channel_count, plural, =0 {0 steder} one {# sted} other {# steder}}.",
	"content.virus_detected": "Den fil blev markeret som potentielt usikker og er blevet fjernet.",
	"feed.comment_removed_by_moderator": "En moderator har fjernet en af dine kommentarer i feedet på grund af overtrædelse af vores servicevilkår eller retningslinjer for fællesskabet.",
	"feed.post_removed_by_moderator": "En moderator har fjernet et af dine opslag i feedet på grund af overtrædelse af vores servicevilkår eller retningslinjer for fællesskabet.",
	"feed.video_failed": "Din video til feedet kunne ikke behandles og blev derfor ikke offentliggjort.",
	"feed.video_gone": "Dit opslag i feedet blev fjernet, fordi videoen ikke længere er tilgængelig.",
	"feed.video_rejected": "Din video bestod ikke vores indholdskontrol og vises derfor ikke i feedet.",
	"feed.video_too_large": "Din video blev ikke offentliggjort i feedet, fordi den er større end 500 MB.",
	"guild.bulk_create.emoji_limit": "Maksimalt antal emoji nået ({limit}).",
	"guild.bulk_create.sticker_limit": "Maksimalt antal klistermærker nået ({limit}).",
	"guild.bulk_create.unknown_error": "Ukendt fejl.",
	"guild.default_category_text": "Tekstkanaler",
	"guild.default_category_voice": "Talekanaler",
	"guild.default_channel_text": "generelt",
	"guild.default_channel_voice": "Generelt",
	"referral.reward_ready": "Din henvisningsbelønning er klar. Du kan se den under Indstillinger → Henvisning."
});

export default CONTENT_I18N_DA_MESSAGES;
