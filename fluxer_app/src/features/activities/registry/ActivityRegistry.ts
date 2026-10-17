// SPDX-License-Identifier: AGPL-3.0-or-later

import {BAND_ACTIVITY} from '@app/features/activities/band/BandActivity';
import type {ActivityDefinition} from '@app/features/activities/registry/ActivityDefinition';
import type {VoiceActivityId} from '@fluxer/constants/src/VoiceActivityConstants';

// A new activity is a module under activities/<id>/, its id in VOICE_ACTIVITY_IDS and one line here.
const ACTIVITIES: Readonly<Record<VoiceActivityId, ActivityDefinition>> = {
	band: BAND_ACTIVITY,
};

export const ACTIVITY_LIST: ReadonlyArray<ActivityDefinition> = Object.values(ACTIVITIES);

export function getActivityDefinition(id: VoiceActivityId): ActivityDefinition {
	return ACTIVITIES[id];
}
