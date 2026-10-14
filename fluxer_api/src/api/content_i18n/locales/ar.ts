// SPDX-License-Identifier: AGPL-3.0-or-later

import {defineContentI18nLocaleMessages} from '../ContentI18nMessages';

const CONTENT_I18N_AR_MESSAGES = defineContentI18nLocaleMessages({
	"auth.unknown_location": "موقع غير معروف",
	"billing.donation_description_monthly": "تبرع شهري لدعم {product_name}",
	"billing.donation_description_one_time": "تبرع لمرة واحدة لدعم {product_name}",
	"billing.donation_description_yearly": "تبرع سنوي لدعم {product_name}",
	"billing.donation_name_one_time": "تبرع لـ{product_name}",
	"billing.donation_name_recurring": "تبرع متكرر لـ{product_name}",
	"billing.eu_withdrawal_waiver_checkout": "إذا كنت مستهلكًا في الاتحاد الأوروبي/المنطقة الاقتصادية الأوروبية، فإنني أوافق صراحةً على إتاحة المحتوى الرقمي لـ {product_name} {premium_tier_name} فورًا، وأقرّ بأنني أفقد حقي القانوني في العدول بمجرد إتاحة الوصول إليه. لا يؤثر هذا على حقوق المستهلك الإلزامية الأخرى. اطّلع على [شروط الخدمة]({terms_url}).",
	"bulk_message_deletion.complete": "انتهينا من حذف رسائلك. أزلنا {message_count, plural, =0 {0 رسالة} one {رسالة واحدة} two {رسالتين} few {# رسائل} many {# رسالة} other {# رسالة}} من {channel_count, plural, =0 {0 مكان} one {مكان واحد} two {مكانين} few {# أماكن} many {# مكانًا} other {# مكان}}.",
	"content.virus_detected": "تم الإبلاغ عن هذا الملف على أنه قد يكون غير آمن وتمت إزالته.",
	"feed.comment_removed_by_moderator": "أزال أحد المشرفين أحد تعليقاتك في الموجز لانتهاكه شروط الخدمة أو إرشادات المجتمع الخاصة بنا.",
	"feed.post_removed_by_moderator": "أزال أحد المشرفين أحد منشوراتك في الموجز لانتهاكه شروط الخدمة أو إرشادات المجتمع الخاصة بنا.",
	"feed.video_failed": "تعذّرت معالجة فيديو الموجز الخاص بك، لذا لم يُنشر.",
	"feed.video_gone": "أُزيل منشورك من الموجز لأن الفيديو لم يعد متاحًا.",
	"feed.video_rejected": "لم يجتز فيديو الموجز الخاص بك فحوصات المحتوى، لذا لا يظهر في الموجز.",
	"feed.video_too_large": "لم يُنشر فيديو الموجز الخاص بك لأن حجمه يتجاوز 500 MB.",
	"guild.bulk_create.emoji_limit": "تم الوصول إلى الحد الأقصى لعدد الرموز التعبيرية ({limit}).",
	"guild.bulk_create.sticker_limit": "تم الوصول إلى الحد الأقصى لعدد الملصقات ({limit}).",
	"guild.bulk_create.unknown_error": "حدث خطأ غير معروف.",
	"guild.default_category_text": "القنوات النصية",
	"guild.default_category_voice": "القنوات الصوتية",
	"guild.default_channel_text": "عام",
	"guild.default_channel_voice": "عام",
	"referral.reward_ready": "مكافأة الإحالة جاهزة. يمكنك رؤيتها في الإعدادات → الإحالة."
});

export default CONTENT_I18N_AR_MESSAGES;
