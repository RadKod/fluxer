// SPDX-License-Identifier: AGPL-3.0-or-later

import {defineContentI18nLocaleMessages} from '../ContentI18nMessages';

const CONTENT_I18N_HI_MESSAGES = defineContentI18nLocaleMessages({
	"auth.unknown_location": "अज्ञात लोकेशन",
	"billing.donation_description_monthly": "{product_name} को सपोर्ट करने के लिए मासिक डोनेशन",
	"billing.donation_description_one_time": "{product_name} को सपोर्ट करने के लिए वन-टाइम डोनेशन",
	"billing.donation_description_yearly": "{product_name} को सपोर्ट करने के लिए सालाना डोनेशन",
	"billing.donation_name_one_time": "{product_name} डोनेशन",
	"billing.donation_name_recurring": "रिकरिंग {product_name} डोनेशन",
	"billing.eu_withdrawal_waiver_checkout": "अगर मैं EU/EEA का उपभोक्ता हूँ, तो मैं {product_name} {premium_tier_name} का डिजिटल कंटेंट तुरंत उपलब्ध कराए जाने के लिए स्पष्ट रूप से सहमति देता हूँ और स्वीकार करता हूँ कि एक्सेस मिलने के बाद मेरा वैधानिक वापसी का अधिकार समाप्त हो जाता है। इससे अन्य अनिवार्य उपभोक्ता अधिकार प्रभावित नहीं होते। [सेवा की शर्तें]({terms_url}) देखें।",
	"bulk_message_deletion.complete": "हमने आपके संदेश हटाने का काम पूरा कर लिया है। हमने {channel_count, plural, =0 {0 जगहों से} one {# जगह से} other {# जगहों से}} {message_count, plural, =0 {0 संदेश} one {# संदेश} other {# संदेश}} हटा दिए।",
	"content.virus_detected": "वह फाइल संभावित रूप से असुरक्षित पाई गई और उसे हटा दिया गया है।",
	"feed.comment_removed_by_moderator": "एक मॉडरेटर ने हमारी सेवा की शर्तों या कम्युनिटी गाइडलाइंस का उल्लंघन करने के कारण फ़ीड में आपकी एक टिप्पणी हटा दी है।",
	"feed.post_removed_by_moderator": "एक मॉडरेटर ने हमारी सेवा की शर्तों या कम्युनिटी गाइडलाइंस का उल्लंघन करने के कारण फ़ीड में आपकी एक पोस्ट हटा दी है।",
	"feed.video_failed": "आपके फ़ीड वीडियो को प्रोसेस नहीं किया जा सका, इसलिए वह पोस्ट नहीं हुआ।",
	"feed.video_gone": "आपकी फ़ीड पोस्ट हटा दी गई क्योंकि उसका वीडियो अब उपलब्ध नहीं है।",
	"feed.video_rejected": "आपका फ़ीड वीडियो हमारी सामग्री जाँच में पास नहीं हुआ, इसलिए वह फ़ीड में नहीं दिखाया जाता।",
	"feed.video_too_large": "आपका फ़ीड वीडियो पोस्ट नहीं हुआ क्योंकि उसका आकार 500 MB से अधिक है।",
	"guild.bulk_create.emoji_limit": "इमोजी की अधिकतम सीमा तक पहुँच गए हैं ({limit})।",
	"guild.bulk_create.sticker_limit": "स्टिकर की अधिकतम सीमा तक पहुँच गए हैं ({limit})।",
	"guild.bulk_create.unknown_error": "अज्ञात त्रुटि।",
	"guild.default_category_text": "टेक्स्ट चैनल",
	"guild.default_category_voice": "वॉइस चैनल",
	"guild.default_channel_text": "जनरल",
	"guild.default_channel_voice": "जनरल",
	"referral.reward_ready": "आपका रेफ़रल इनाम तैयार है। आप इसे सेटिंग्स → रेफ़रल में देख सकते हैं।"
});

export default CONTENT_I18N_HI_MESSAGES;
