// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ActivitySession} from '@app/features/activities/session/ActivitySessionTypes';
import VoiceActivities from '@app/features/activities/state/VoiceActivities';
import {voiceActivitiesEnabled} from '@app/features/activities/utils/VoiceActivityAvailability';
import MobileLayout from '@app/features/ui/state/MobileLayout';
import MediaEngine from '@app/features/voice/engine/MediaEngineFacade';

function liveJoinedSession(): ActivitySession | null {
	const channelId = MediaEngine.channelId;
	if (!channelId || !voiceActivitiesEnabled(MediaEngine.guildId)) return null;
	if (!VoiceActivities.isJoined(channelId)) return null;
	return VoiceActivities.getLive(channelId);
}

// Observable inputs only: the live session of my call that I take part in, where this client can run the game
// (desktop layout, activities on). The places that show its View (tile, stage, mini window) exist only while this
// returns it.
export function joinedActivitySession(): ActivitySession | null {
	return MobileLayout.isMobileLayout() ? null : liveJoinedSession();
}

// The session whose View stays mounted, given the one mounted now. A View already running carries on, parked out of
// sight, when the window turns narrow enough for the mobile layout: a song in progress plays on and is back where it
// was once the window is wide again, instead of ending my part early. The mobile layout never mounts a View itself.
export function mountedActivitySession(mounted: ActivitySession | null): ActivitySession | null {
	const session = liveJoinedSession();
	if (!MobileLayout.isMobileLayout()) return session;
	return session !== null && session === mounted ? session : null;
}
