// SPDX-License-Identifier: AGPL-3.0-or-later

import {BAND_ACTIVITY} from '@app/features/activities/band/BandActivity';
import type {
	ActivityDefinition,
	UpcomingActivityDefinition,
} from '@app/features/activities/registry/ActivityDefinition';
import {JamCover} from '@app/features/activities/registry/JamCover';
import type {VoiceActivityId} from '@fluxer/constants/src/VoiceActivityConstants';
import {msg} from '@lingui/core/macro';

// A new activity is a module under activities/<id>/, its id in VOICE_ACTIVITY_IDS and one line here.
const ACTIVITIES: Readonly<Record<VoiceActivityId, ActivityDefinition>> = {
	band: BAND_ACTIVITY,
};

export const ACTIVITY_LIST: ReadonlyArray<ActivityDefinition> = Object.values(ACTIVITIES);

// Announced in the picker before they exist; an entry moves to ACTIVITIES when it ships.
export const UPCOMING_ACTIVITIES: ReadonlyArray<UpcomingActivityDefinition> = [
	{
		key: 'jam',
		name: msg({
			message: 'Jam',
			context: 'voice-activity',
			comment:
				'Voice activities: name of a coming activity where the people in the channel play freely together, without a song.',
		}),
		tagline: msg({
			message: 'Pick a key and play freely together',
			comment: 'Voice activities: one-line description of the coming jam activity in the activity picker.',
		}),
		Cover: JamCover,
	},
];

export function getActivityDefinition(id: VoiceActivityId): ActivityDefinition {
	return ACTIVITIES[id];
}
