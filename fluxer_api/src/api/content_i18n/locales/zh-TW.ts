// SPDX-License-Identifier: AGPL-3.0-or-later

import {defineContentI18nLocaleMessages} from '../ContentI18nMessages';

const CONTENT_I18N_ZH_TW_MESSAGES = defineContentI18nLocaleMessages({
	"auth.unknown_location": "不明位置",
	"billing.donation_description_monthly": "支持 {product_name} 的每月捐款",
	"billing.donation_description_one_time": "支持 {product_name} 的單次捐款",
	"billing.donation_description_yearly": "支持 {product_name} 的每年捐款",
	"billing.donation_name_one_time": "{product_name} 捐款",
	"billing.donation_name_recurring": "{product_name} 定期捐款",
	"billing.eu_withdrawal_waiver_checkout": "若我是歐盟/歐洲經濟區消費者，我明確同意立即提供 {product_name} {premium_tier_name} 數位內容，並了解一旦取得存取權，即喪失法定撤回權。這不影響其他強制性消費者權益。請參閱[服務條款]({terms_url})。",
	"bulk_message_deletion.complete": "我們已刪除你的訊息。從 {channel_count, plural, =0 {0 個位置} other {# 個位置}} 中移除了 {message_count, plural, =0 {0 則訊息} other {# 則訊息}}。",
	"content.virus_detected": "該檔案已被標記為可能不安全，並已移除。",
	"feed.comment_removed_by_moderator": "由於違反我們的服務條款或社群準則，一名管理員已移除你在動態中的一則留言。",
	"feed.post_removed_by_moderator": "由於違反我們的服務條款或社群準則，一名管理員已移除你的一則動態貼文。",
	"feed.video_failed": "無法處理您的動態影片，因此未發布。",
	"feed.video_gone": "您的動態已被移除，因為其中的影片已無法使用。",
	"feed.video_rejected": "您的影片未通過內容審查，因此不會顯示在動態中。",
	"feed.video_too_large": "您的影片超過 500 MB，因此未發布到動態中。",
	"guild.bulk_create.emoji_limit": "已達最大表情符號數量限制 ({limit})。",
	"guild.bulk_create.sticker_limit": "已達最大貼圖數量 ({limit})。",
	"guild.bulk_create.unknown_error": "發生了未知的錯誤。",
	"guild.default_category_text": "文字頻道",
	"guild.default_category_voice": "語音頻道",
	"guild.default_channel_text": "一般",
	"guild.default_channel_voice": "一般",
	"referral.reward_ready": "您的邀請獎勵已準備好，可在「設定 → 邀請」中查看。"
});

export default CONTENT_I18N_ZH_TW_MESSAGES;
