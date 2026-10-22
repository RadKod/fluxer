// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ActivitySession} from '@app/features/activities/session/ActivitySessionTypes';
import VoiceActivities from '@app/features/activities/state/VoiceActivities';
import {voiceActivitiesEnabled} from '@app/features/activities/utils/VoiceActivityAvailability';
import MobileLayout from '@app/features/ui/state/MobileLayout';
import MediaEngine from '@app/features/voice/engine/MediaEngineFacade';

// Observable inputs only: the live session of my call that I take part in, where this client can run the game
// (desktop layout, activities on). Its View is mounted for exactly as long as this returns it.
export function joinedActivitySession(): ActivitySession | null {
	const channelId = MediaEngine.channelId;
	if (!channelId || MobileLayout.isMobileLayout() || !voiceActivitiesEnabled(MediaEngine.guildId)) return null;
	if (!VoiceActivities.isJoined(channelId)) return null;
	return VoiceActivities.getLive(channelId);
}
