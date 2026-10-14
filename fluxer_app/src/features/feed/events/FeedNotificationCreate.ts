// SPDX-License-Identifier: AGPL-3.0-or-later

import {afterFeedNotificationReady} from '@app/features/feed/events/FeedNotificationReady';
import type {GatewayHandlerContext} from '@app/features/gateway/events/EventRouter';
import FeedNotifications from '@app/features/inbox/state/FeedNotifications';
import type {FeedNotificationCreateEvent} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';

export function handleFeedNotificationCreate(data: FeedNotificationCreateEvent, context: GatewayHandlerContext): void {
	afterFeedNotificationReady(
		() => FeedNotifications.handleNotificationCreate(data, data.unread_seq, data.unread_epoch),
		context.accountKey,
	);
}
