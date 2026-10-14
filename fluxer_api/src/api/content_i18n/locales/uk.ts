// SPDX-License-Identifier: AGPL-3.0-or-later

import {defineContentI18nLocaleMessages} from '../ContentI18nMessages';

const CONTENT_I18N_UK_MESSAGES = defineContentI18nLocaleMessages({
	"auth.unknown_location": "Невідоме розташування",
	"billing.donation_description_monthly": "Щомісячний внесок на підтримку {product_name}",
	"billing.donation_description_one_time": "Разовий внесок на підтримку {product_name}",
	"billing.donation_description_yearly": "Річний внесок на підтримку {product_name}",
	"billing.donation_name_one_time": "Внесок на підтримку {product_name}",
	"billing.donation_name_recurring": "Регулярний внесок на підтримку {product_name}",
	"billing.eu_withdrawal_waiver_checkout": "Якщо я є споживачем з ЄС/ЄЕЗ, я надаю явну згоду на негайне надання цифрового контенту {product_name} {premium_tier_name} і визнаю, що втрачаю своє законне право на відмову після отримання доступу. Це не впливає на інші обов'язкові права споживача. Див. [Умови надання послуг]({terms_url}).",
	"bulk_message_deletion.complete": "Ми завершили видалення твоїх повідомлень. Видалено {message_count, plural, =0 {0 повідомлень} one {# повідомлення} few {# повідомлення} many {# повідомлень} other {# повідомлень}} з {channel_count, plural, =0 {0 місць} one {# місця} few {# місць} many {# місць} other {# місць}}.",
	"content.virus_detected": "Цей файл позначено як потенційно небезпечний, і його вилучено.",
	"feed.comment_removed_by_moderator": "Модератор видалив один із твоїх коментарів у стрічці за порушення наших Умов використання або Правил спільноти.",
	"feed.post_removed_by_moderator": "Модератор видалив одну з твоїх публікацій у стрічці за порушення наших Умов використання або Правил спільноти.",
	"feed.video_failed": "Не вдалося обробити ваше відео для стрічки, тому його не опубліковано.",
	"feed.video_gone": "Ваш допис видалено зі стрічки, оскільки його відео більше недоступне.",
	"feed.video_rejected": "Ваше відео не пройшло наші перевірки вмісту, тому не відображається у стрічці.",
	"feed.video_too_large": "Ваше відео не опубліковано у стрічці, оскільки його розмір перевищує 500 MB.",
	"guild.bulk_create.emoji_limit": "Досягнуто максимальної кількості емодзі ({limit}).",
	"guild.bulk_create.sticker_limit": "Досягнуто максимальної кількості наліпок ({limit}).",
	"guild.bulk_create.unknown_error": "Невідома помилка.",
	"guild.default_category_text": "Текстові канали",
	"guild.default_category_voice": "Голосові канали",
	"guild.default_channel_text": "загальний",
	"guild.default_channel_voice": "Загальний",
	"referral.reward_ready": "Ваша винагорода за запрошення готова. Її можна переглянути в розділі Налаштування → Запрошення."
});

export default CONTENT_I18N_UK_MESSAGES;
