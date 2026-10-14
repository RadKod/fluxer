// SPDX-License-Identifier: AGPL-3.0-or-later

import {defineContentI18nLocaleMessages} from '../ContentI18nMessages';

const CONTENT_I18N_ES_ES_MESSAGES = defineContentI18nLocaleMessages({
	"auth.unknown_location": "Ubicación desconocida",
	"billing.donation_description_monthly": "Donación mensual para apoyar a {product_name}",
	"billing.donation_description_one_time": "Donación única para apoyar a {product_name}",
	"billing.donation_description_yearly": "Donación anual para apoyar a {product_name}",
	"billing.donation_name_one_time": "Donación a {product_name}",
	"billing.donation_name_recurring": "Donación periódica a {product_name}",
	"billing.eu_withdrawal_waiver_checkout": "Si soy un consumidor de la UE/EEE, doy mi consentimiento expreso para que el contenido digital de {product_name} {premium_tier_name} se proporcione de inmediato y reconozco que pierdo mi derecho legal de desistimiento una vez que se conceda el acceso. Esto no afecta a otros derechos de consumo obligatorios. Consulta los [Términos del servicio]({terms_url}).",
	"bulk_message_deletion.complete": "Hemos terminado de eliminar tus mensajes. Hemos eliminado {message_count, plural, =0 {0 mensajes} one {# mensaje} other {# mensajes}} de {channel_count, plural, =0 {0 sitios} one {# sitio} other {# sitios}}.",
	"content.virus_detected": "Ese archivo se ha marcado como potencialmente inseguro y se ha eliminado.",
	"feed.comment_removed_by_moderator": "Un moderador ha eliminado uno de tus comentarios del feed por infringir nuestras Condiciones del servicio o Normas de la comunidad.",
	"feed.post_removed_by_moderator": "Un moderador ha eliminado una de tus publicaciones del feed por infringir nuestras Condiciones del servicio o Normas de la comunidad.",
	"feed.video_failed": "No se ha podido procesar tu vídeo para el feed, por lo que no se ha publicado.",
	"feed.video_gone": "Tu publicación del feed se ha eliminado porque su vídeo ya no está disponible.",
	"feed.video_rejected": "Tu vídeo no ha superado nuestros controles de contenido, por lo que no se muestra en el feed.",
	"feed.video_too_large": "Tu vídeo no se ha publicado en el feed porque supera los 500 MB.",
	"guild.bulk_create.emoji_limit": "Se ha alcanzado el límite máximo de emojis ({limit}).",
	"guild.bulk_create.sticker_limit": "Se ha alcanzado el límite máximo de stickers ({limit}).",
	"guild.bulk_create.unknown_error": "Error desconocido.",
	"guild.default_category_text": "Canales de texto",
	"guild.default_category_voice": "Canales de voz",
	"guild.default_channel_text": "general",
	"guild.default_channel_voice": "General",
	"referral.reward_ready": "Tu recompensa por recomendación está lista. Puedes verla en Ajustes → Recomendaciones."
});

export default CONTENT_I18N_ES_ES_MESSAGES;
