// SPDX-License-Identifier: AGPL-3.0-or-later

import {defineContentI18nLocaleMessages} from '../ContentI18nMessages';

const CONTENT_I18N_BG_MESSAGES = defineContentI18nLocaleMessages({
	"auth.unknown_location": "Неизвестно местоположение",
	"billing.donation_description_monthly": "Месечно дарение в подкрепа на {product_name}",
	"billing.donation_description_one_time": "Еднократно дарение в подкрепа на {product_name}",
	"billing.donation_description_yearly": "Годишно дарение в подкрепа на {product_name}",
	"billing.donation_name_one_time": "Дарение за {product_name}",
	"billing.donation_name_recurring": "Периодично дарение за {product_name}",
	"billing.eu_withdrawal_waiver_checkout": "Ако съм потребител от ЕС/ЕИП, изрично се съгласявам цифровото съдържание на {product_name} {premium_tier_name} да бъде предоставено незабавно и признавам, че губя законното си право на отказ, след като достъпът бъде предоставен. Това не засяга други задължителни потребителски права. Виж [Условията за ползване]({terms_url}).",
	"bulk_message_deletion.complete": "Изтриването на съобщенията ти приключи. Премахнахме {message_count, plural, =0 {0 съобщения} one {# съобщение} other {# съобщения}} от {channel_count, plural, =0 {0 места} one {# място} other {# места}}.",
	"content.virus_detected": "Този файл беше маркиран като потенциално опасен и е премахнат.",
	"feed.comment_removed_by_moderator": "Модератор премахна един от коментарите ти в потока поради нарушаване на нашите Общи условия или Насоки на общността.",
	"feed.post_removed_by_moderator": "Модератор премахна една от публикациите ти в потока поради нарушаване на нашите Общи условия или Насоки на общността.",
	"feed.video_failed": "Видеото ви за емисията не можа да бъде обработено и не беше публикувано.",
	"feed.video_gone": "Публикацията ви в емисията беше премахната, защото видеото ѝ вече не е достъпно.",
	"feed.video_rejected": "Видеото ви не премина проверките ни за съдържание и не се показва в емисията.",
	"feed.video_too_large": "Видеото ви не беше публикувано в емисията, защото е по-голямо от 500 MB.",
	"guild.bulk_create.emoji_limit": "Достигнат е максималният брой емоджита ({limit}).",
	"guild.bulk_create.sticker_limit": "Достигнат е максималният брой стикери ({limit}).",
	"guild.bulk_create.unknown_error": "Възникна неизвестна грешка.",
	"guild.default_category_text": "Текстови канали",
	"guild.default_category_voice": "Гласови канали",
	"guild.default_channel_text": "общ",
	"guild.default_channel_voice": "Общ",
	"referral.reward_ready": "Наградата ви за препоръка е готова. Можете да я видите в Настройки → Препоръки."
});

export default CONTENT_I18N_BG_MESSAGES;
