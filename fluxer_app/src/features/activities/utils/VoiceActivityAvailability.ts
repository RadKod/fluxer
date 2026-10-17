// SPDX-License-Identifier: AGPL-3.0-or-later

import ExperimentAssignments from '@app/features/experiment/state/ExperimentAssignments';
import Guilds from '@app/features/guild/state/Guilds';
import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';
import {readVoiceRoomAssignment} from '@fluxer/schema/src/domains/experiment/ExperimentSchemas';

// Activities need the instance's games switch and the community's own feature; DM calls have neither. Observable
// inputs only: call it from an observer and the button comes and goes with either switch.
export function voiceActivitiesEnabled(guildId: string | null): boolean {
	if (!guildId || !readVoiceRoomAssignment(ExperimentAssignments.response).games) return false;
	return Guilds.getGuild(guildId)?.features.has(GuildFeatures.VOICE_ACTIVITIES) ?? false;
}
