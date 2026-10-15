// SPDX-License-Identifier: AGPL-3.0-or-later

import GameActivitySettings from '@app/features/game_activity/state/GameActivitySettings';
import GameActivityStore from '@app/features/game_activity/state/GameActivityStore';
import DesktopGameActivityBridge from '@app/features/game_activity/utils/DesktopGameActivityBridge';
import type {GameActivity} from '@app/features/gateway/types/GatewayPresenceTypes';
import Users from '@app/features/user/state/Users';
import {reaction} from 'mobx';
import {useCallback, useSyncExternalStore} from 'react';

interface UseGameActivityOptions {
	userId: string;
	enabled?: boolean;
}

function getSharedLocalActivity(): GameActivity | null {
	return GameActivityStore.enabled && GameActivitySettings.getEffectiveSharing()
		? DesktopGameActivityBridge.activity
		: null;
}

function subscribeSharedLocalActivity(listener: () => void): () => void {
	return reaction(getSharedLocalActivity, listener);
}

export function useGameActivity({userId, enabled = true}: UseGameActivityOptions): GameActivity | null {
	const active = enabled && GameActivityStore.enabled;
	const self = userId === Users.currentUser?.id;
	const subscribe = useCallback(
		(listener: () => void) => {
			if (!active) return () => {};
			return self ? subscribeSharedLocalActivity(listener) : GameActivityStore.subscribe(userId, listener);
		},
		[userId, active, self],
	);
	const getSnapshot = useCallback(() => {
		if (!active) return null;
		return self ? getSharedLocalActivity() : GameActivityStore.get(userId);
	}, [userId, active, self]);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
