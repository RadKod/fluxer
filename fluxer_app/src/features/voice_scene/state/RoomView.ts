// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Channel} from '@app/features/channel/models/Channel';
import ExperimentAssignments from '@app/features/experiment/state/ExperimentAssignments';
import MobileLayout from '@app/features/ui/state/MobileLayout';
import VoiceCallFullscreen from '@app/features/voice/state/VoiceCallFullscreen';
import VoiceSceneSettings from '@app/features/voice_scene/state/VoiceSceneSettings';
import {type RoomView, resolveRoomView} from '@app/features/voice_scene/utils/RoomViewAvailability';
import {getWebglSupport} from '@app/features/voice_scene/utils/WebglSupport';
import {readVoiceRoomAssignment} from '@fluxer/schema/src/domains/experiment/ExperimentSchemas';

// Observable inputs only (assignment, theme, layout, settings): call from an observer and it re-renders on change.
export function roomViewFor(channel: Channel): RoomView {
	const assignment = readVoiceRoomAssignment(ExperimentAssignments.response);
	const view = resolveRoomView({
		channelType: channel.type,
		rooms: assignment.rooms,
		theme: channel.roomTheme,
		defaultTheme: assignment.default_room_theme,
		isMobileLayout: MobileLayout.isMobileLayout(),
		webgl: getWebglSupport(),
		preferRoom: VoiceSceneSettings.preferRoom,
		contextLost: VoiceSceneSettings.failure === 'context_lost',
		loadFailed: VoiceSceneSettings.failure === 'load_failed',
	});
	const scopeKey = `${channel.guildId ? 'guild-voice' : 'dm-call'}:${channel.id}`;
	return view.show && VoiceCallFullscreen.isCallViewRequested(scopeKey) ? {show: false, reason: 'user_flat'} : view;
}
