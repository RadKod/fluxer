// SPDX-License-Identifier: AGPL-3.0-or-later

import {defineContentI18nLocaleMessages} from '../ContentI18nMessages';

const CONTENT_I18N_KO_MESSAGES = defineContentI18nLocaleMessages({
	"auth.unknown_location": "알 수 없는 위치",
	"billing.donation_description_monthly": "{product_name} 후원을 위한 월간 기부",
	"billing.donation_description_one_time": "{product_name} 후원을 위한 일회성 기부",
	"billing.donation_description_yearly": "{product_name} 후원을 위한 연간 기부",
	"billing.donation_name_one_time": "{product_name} 기부",
	"billing.donation_name_recurring": "{product_name} 정기 기부",
	"billing.eu_withdrawal_waiver_checkout": "제가 EU/EEA 소비자인 경우, {product_name} {premium_tier_name} 디지털 콘텐츠를 즉시 제공받는 데 명시적으로 동의하며, 이용 권한이 제공된 후에는 법정 철회권을 상실함을 인정합니다. 이는 다른 법률상 보장되는 소비자 권리에 영향을 미치지 않습니다. [서비스 약관]({terms_url})을 확인하세요.",
	"bulk_message_deletion.complete": "메시지 삭제를 완료했습니다. {channel_count, plural, =0 {0곳에서} other {#곳에서}} {message_count, plural, =0 {메시지 0개를 삭제했습니다} other {메시지 #개를 삭제했습니다}}.",
	"content.virus_detected": "해당 파일은 잠재적으로 안전하지 않은 것으로 확인되어 삭제되었어요.",
	"feed.comment_removed_by_moderator": "서비스 약관 또는 커뮤니티 가이드라인 위반으로 인해 모더레이터가 피드 댓글 1개를 삭제했어요.",
	"feed.post_removed_by_moderator": "서비스 약관 또는 커뮤니티 가이드라인 위반으로 인해 모더레이터가 피드 게시물 1개를 삭제했어요.",
	"feed.video_failed": "피드 동영상을 처리하지 못해 게시되지 않았습니다.",
	"feed.video_gone": "동영상을 더 이상 사용할 수 없어 피드 게시물이 삭제되었습니다.",
	"feed.video_rejected": "동영상이 콘텐츠 검사를 통과하지 못해 피드에 표시되지 않습니다.",
	"feed.video_too_large": "동영상 크기가 500 MB를 초과하여 피드에 게시되지 않았습니다.",
	"guild.bulk_create.emoji_limit": "이모지 최대 개수에 도달했습니다({limit}).",
	"guild.bulk_create.sticker_limit": "최대 스티커 개수에 도달했습니다({limit}).",
	"guild.bulk_create.unknown_error": "알 수 없는 오류가 발생했습니다.",
	"guild.default_category_text": "텍스트 채널",
	"guild.default_category_voice": "음성 채널",
	"guild.default_channel_text": "일반",
	"guild.default_channel_voice": "일반",
	"referral.reward_ready": "추천 보상이 준비되었습니다. 설정 → 추천에서 확인할 수 있습니다."
});

export default CONTENT_I18N_KO_MESSAGES;
