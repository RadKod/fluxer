// SPDX-License-Identifier: AGPL-3.0-or-later

import {applyFollowChange} from '@app/features/follow/utils/FollowProfileUtils';
import type {GatewayHandlerContext} from '@app/features/gateway/events/EventRouter';

interface FollowDeletePayload {
	user_id: string;
}

// Sent to the former follower's sessions; user_id is the account no longer followed.
export function handleFollowDelete(data: FollowDeletePayload, _context: GatewayHandlerContext): void {
	applyFollowChange(data.user_id, false);
}
