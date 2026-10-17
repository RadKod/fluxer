// SPDX-License-Identifier: AGPL-3.0-or-later

import {voiceActivitiesEnabled} from '@app/features/activities/utils/VoiceActivityAvailability';
import ExperimentAssignments from '@app/features/experiment/state/ExperimentAssignments';
import Guilds from '@app/features/guild/state/Guilds';
import {getFluxerDebugObject} from '@app/features/platform/utils/FluxerDebugGlobal';
import MediaEngine from '@app/features/voice/engine/MediaEngineFacade';
import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';
import {readVoiceRoomAssignment} from '@fluxer/schema/src/domains/experiment/ExperimentSchemas';

// Console helper: __FLUXER_DEBUG__.voiceActivities() shows each input of the activities gate for the current call.
export function installVoiceActivitiesDebugApi(): void {
	const debugObject = getFluxerDebugObject();
	if (!debugObject) return;
	debugObject.voiceActivities = () => {
		const guildId = MediaEngine.guildId;
		const guild = guildId ? Guilds.getGuild(guildId) : undefined;
		return {
			channelId: MediaEngine.channelId,
			guildId,
			games: readVoiceRoomAssignment(ExperimentAssignments.response).games,
			guildLoaded: guild !== undefined,
			voiceActivitiesFeature: guild?.features.has(GuildFeatures.VOICE_ACTIVITIES) ?? null,
			features: guild ? [...guild.features] : null,
			enabled: voiceActivitiesEnabled(guildId),
		};
	};
}
