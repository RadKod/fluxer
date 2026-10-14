// SPDX-License-Identifier: AGPL-3.0-or-later

import {defineContentI18nLocaleMessages} from '../ContentI18nMessages';

const CONTENT_I18N_VI_MESSAGES = defineContentI18nLocaleMessages({
	"auth.unknown_location": "Vị trí không xác định",
	"billing.donation_description_monthly": "Khoản ủng hộ hàng tháng dành cho {product_name}",
	"billing.donation_description_one_time": "Khoản ủng hộ một lần dành cho {product_name}",
	"billing.donation_description_yearly": "Khoản ủng hộ hàng năm dành cho {product_name}",
	"billing.donation_name_one_time": "Ủng hộ {product_name}",
	"billing.donation_name_recurring": "Ủng hộ {product_name} định kỳ",
	"billing.eu_withdrawal_waiver_checkout": "Nếu tôi là người tiêu dùng EU/EEA, tôi đồng ý rõ ràng rằng nội dung kỹ thuật số {product_name} {premium_tier_name} được cung cấp ngay lập tức và thừa nhận rằng tôi mất quyền hủy bỏ theo luật định sau khi có quyền truy cập. Điều này không ảnh hưởng đến các quyền lợi người tiêu dùng bắt buộc khác. Xem [Điều khoản dịch vụ]({terms_url}).",
	"bulk_message_deletion.complete": "Chúng tôi đã xóa xong tin nhắn của bạn. Đã xóa {message_count, plural, =0 {0 tin nhắn} other {# tin nhắn}} khỏi {channel_count, plural, =0 {0 nơi} other {# nơi}}.",
	"content.virus_detected": "Tệp đó bị gắn cờ là có khả năng không an toàn và đã bị xóa.",
	"feed.comment_removed_by_moderator": "Một người kiểm duyệt đã gỡ một bình luận trên bảng tin của bạn do vi phạm Điều khoản dịch vụ hoặc Nguyên tắc cộng đồng của chúng tôi.",
	"feed.post_removed_by_moderator": "Một người kiểm duyệt đã gỡ một bài đăng trên bảng tin của bạn do vi phạm Điều khoản dịch vụ hoặc Nguyên tắc cộng đồng của chúng tôi.",
	"feed.video_failed": "Không thể xử lý video của bạn cho bảng tin nên video chưa được đăng.",
	"feed.video_gone": "Bài đăng của bạn đã bị xóa khỏi bảng tin vì video không còn khả dụng.",
	"feed.video_rejected": "Video của bạn không vượt qua quy trình kiểm tra nội dung nên không hiển thị trên bảng tin.",
	"feed.video_too_large": "Video của bạn chưa được đăng lên bảng tin vì dung lượng vượt quá 500 MB.",
	"guild.bulk_create.emoji_limit": "Đã đạt đến số lượng biểu tượng cảm xúc tối đa ({limit}).",
	"guild.bulk_create.sticker_limit": "Đã đạt đến số lượng tối đa nhãn dán ({limit}).",
	"guild.bulk_create.unknown_error": "Đã xảy ra lỗi không xác định.",
	"guild.default_category_text": "Kênh văn bản",
	"guild.default_category_voice": "Kênh thoại",
	"guild.default_channel_text": "chung",
	"guild.default_channel_voice": "Chung",
	"referral.reward_ready": "Phần thưởng giới thiệu của bạn đã sẵn sàng. Bạn có thể xem trong Cài đặt → Giới thiệu."
});

export default CONTENT_I18N_VI_MESSAGES;
