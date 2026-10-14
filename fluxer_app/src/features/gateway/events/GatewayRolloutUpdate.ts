// SPDX-License-Identifier: AGPL-3.0-or-later

import GameActivityStore from '@app/features/game_activity/state/GameActivityStore';
import DesktopGameActivityBridge from '@app/features/game_activity/utils/DesktopGameActivityBridge';
import type {GatewayRolloutPayload} from '@app/features/gateway/types/GatewayRolloutTypes';

export function handleGatewayRolloutUpdate(data: GatewayRolloutPayload): void {
	GameActivityStore.handleRollout(data);
	void DesktopGameActivityBridge.syncPolicy();
}
