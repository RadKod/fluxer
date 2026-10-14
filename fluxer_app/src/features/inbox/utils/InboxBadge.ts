// SPDX-License-Identifier: AGPL-3.0-or-later

import {isFeedEnabled} from '@app/features/feed/utils/FeedUtils';
import GuildReadState from '@app/features/guild/state/GuildReadState';
import FeedNotifications from '@app/features/inbox/state/FeedNotifications';
import {FEED_NOTIFICATION_UNREAD_CAP} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';

const INBOX_BADGE_MAX = 99;

interface InboxBadge {
	mentionCount: number;
	count: number;
	max: number;
}

// The inbox button's badge on every page (channel, DM, feed): unread mentions plus the unread activity of the inbox's
// Activity tab. The server counts activity only up to its cap (a count kept on the device can pass it), so from the cap
// on the total shows as "N+".
export function getInboxBadge(): InboxBadge {
	const mentionCount = GuildReadState.mentionCountAcrossGuilds();
	const unreadActivity = FeedNotifications.unreadCount;
	const activityCount = unreadActivity > 0 && isFeedEnabled() ? unreadActivity : 0;
	const max =
		activityCount >= FEED_NOTIFICATION_UNREAD_CAP
			? Math.min(INBOX_BADGE_MAX, mentionCount + FEED_NOTIFICATION_UNREAD_CAP - 1)
			: INBOX_BADGE_MAX;
	return {mentionCount, count: mentionCount + activityCount, max};
}
