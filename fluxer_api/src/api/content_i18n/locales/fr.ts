// SPDX-License-Identifier: AGPL-3.0-or-later

import {defineContentI18nLocaleMessages} from '../ContentI18nMessages';

const CONTENT_I18N_FR_MESSAGES = defineContentI18nLocaleMessages({
	"auth.unknown_location": "Lieu inconnu",
	"billing.donation_description_monthly": "Don mensuel pour soutenir {product_name}",
	"billing.donation_description_one_time": "Don ponctuel pour soutenir {product_name}",
	"billing.donation_description_yearly": "Don annuel pour soutenir {product_name}",
	"billing.donation_name_one_time": "Don à {product_name}",
	"billing.donation_name_recurring": "Don récurrent à {product_name}",
	"billing.eu_withdrawal_waiver_checkout": "Si je suis un consommateur de l'UE/EEE, je consens expressément à ce que le contenu numérique de {product_name} {premium_tier_name} soit fourni immédiatement et reconnais que je perds mon droit légal de rétractation dès que l'accès est fourni. Cela n'affecte pas les autres droits impératifs des consommateurs. Voir les [Conditions d'utilisation]({terms_url}).",
	"bulk_message_deletion.complete": "Nous avons terminé de supprimer vos messages. Nous avons supprimé {message_count, plural, =0 {0 message} one {# message} other {# messages}} dans {channel_count, plural, =0 {0 endroit} one {# endroit} other {# endroits}}.",
	"content.virus_detected": "Ce fichier a été signalé comme potentiellement dangereux et a été supprimé.",
	"feed.comment_removed_by_moderator": "Un modérateur a supprimé l’un de vos commentaires du fil pour violation de nos conditions d’utilisation ou des règles de la communauté.",
	"feed.post_removed_by_moderator": "Un modérateur a supprimé l’une de vos publications du fil pour violation de nos conditions d’utilisation ou des règles de la communauté.",
	"feed.video_failed": "Votre vidéo destinée au fil n'a pas pu être traitée et n'a donc pas été publiée.",
	"feed.video_gone": "Votre publication a été retirée du fil car sa vidéo n'est plus disponible.",
	"feed.video_rejected": "Votre vidéo n'a pas passé nos contrôles de contenu et n'apparaît donc pas dans le fil.",
	"feed.video_too_large": "Votre vidéo n'a pas été publiée dans le fil car elle dépasse 500 MB.",
	"guild.bulk_create.emoji_limit": "Nombre maximal d’émojis atteint ({limit}).",
	"guild.bulk_create.sticker_limit": "Nombre maximal d’autocollants atteint ({limit}).",
	"guild.bulk_create.unknown_error": "Erreur inconnue.",
	"guild.default_category_text": "Salons textuels",
	"guild.default_category_voice": "Salons vocaux",
	"guild.default_channel_text": "général",
	"guild.default_channel_voice": "Général",
	"referral.reward_ready": "Votre récompense de parrainage est prête. Vous pouvez la consulter dans Paramètres → Parrainage."
});

export default CONTENT_I18N_FR_MESSAGES;
