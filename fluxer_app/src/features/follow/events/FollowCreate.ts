// SPDX-License-Identifier: AGPL-3.0-or-later

import {applyFollowChange} from '@app/features/follow/utils/FollowProfileUtils';
import type {GatewayHandlerContext} from '@app/features/gateway/events/EventRouter';
import type {FollowResponse} from '@fluxer/schema/src/domains/follow/FollowResponseSchemas';

// Sent to the follower's sessions; data.user is the followed account.
export function handleFollowCreate(data: FollowResponse, _context: GatewayHandlerContext): void {
	applyFollowChange(data.user.id, true);
}
