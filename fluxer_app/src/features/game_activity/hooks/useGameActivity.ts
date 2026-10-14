// SPDX-License-Identifier: AGPL-3.0-or-later

import GameActivityStore from '@app/features/game_activity/state/GameActivityStore';
import type {GameActivity} from '@app/features/gateway/types/GatewayPresenceTypes';
import {useCallback, useSyncExternalStore} from 'react';

interface UseGameActivityOptions {
	userId: string;
	enabled?: boolean;
}

export function useGameActivity({userId, enabled = true}: UseGameActivityOptions): GameActivity | null {
	const active = enabled && GameActivityStore.enabled;
	const subscribe = useCallback(
		(listener: () => void) => (active ? GameActivityStore.subscribe(userId, listener) : () => {}),
		[userId, active],
	);
	const getSnapshot = useCallback(() => (active ? GameActivityStore.get(userId) : null), [userId, active]);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
