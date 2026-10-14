// SPDX-License-Identifier: AGPL-3.0-or-later

import {useHoverPreload} from '@app/features/app/hooks/useHoverPreload';
import * as UserProfileCommands from '@app/features/user/commands/UserProfileCommands';
import {useCallback} from 'react';

const USER_PROFILE_HOVER_PRELOAD_DELAY_MS = 220;

interface UseUserProfileHoverPreloadOptions {
	userId: string;
	guildId?: string;
	enabled?: boolean;
}

export function useUserProfileHoverPreload({userId, guildId, enabled = true}: UseUserProfileHoverPreloadOptions): {
	scheduleProfilePreload: () => void;
	cancelProfilePreload: () => void;
	preloadProfileNow: () => void;
} {
	const preload = useCallback(() => {
		if (!enabled || !UserProfileCommands.canOpenUserProfileSurface()) {
			return;
		}
		void UserProfileCommands.fetch(userId, guildId).catch(() => {});
	}, [enabled, guildId, userId]);
	const {schedule, cancel, preloadNow} = useHoverPreload(
		'profile',
		preload,
		USER_PROFILE_HOVER_PRELOAD_DELAY_MS,
		enabled,
	);
	return {scheduleProfilePreload: schedule, cancelProfilePreload: cancel, preloadProfileNow: preloadNow};
}
