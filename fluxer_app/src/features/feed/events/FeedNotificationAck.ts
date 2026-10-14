// SPDX-License-Identifier: AGPL-3.0-or-later

import {afterFeedNotificationReady} from '@app/features/feed/events/FeedNotificationReady';
import type {GatewayHandlerContext} from '@app/features/gateway/events/EventRouter';
import FeedNotifications from '@app/features/inbox/state/FeedNotifications';
import type {FeedNotificationAckResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';

// A session of the account (this one included) marked feed notifications read.
export function handleFeedNotificationAck(data: FeedNotificationAckResponse, context: GatewayHandlerContext): void {
	afterFeedNotificationReady(() => FeedNotifications.handleAck(data), context.accountKey);
}
