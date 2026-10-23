// SPDX-License-Identifier: AGPL-3.0-or-later

import {BAND_ACTIVITY} from '@app/features/activities/band/BandActivity';
import type {ActivityDefinition, ActivityPresentation} from '@app/features/activities/registry/ActivityDefinition';
import type {VoiceActivityId} from '@fluxer/constants/src/VoiceActivityConstants';

// A new activity is a module under activities/<id>/, its id in VOICE_ACTIVITY_IDS and one line here.
const ACTIVITIES: Readonly<Record<VoiceActivityId, ActivityDefinition>> = {
	band: BAND_ACTIVITY,
};

export const ACTIVITY_LIST: ReadonlyArray<ActivityDefinition> = Object.values(ACTIVITIES);

// One card in the picker: an activity, or one of its entries with the mode the room opens in.
export interface ActivityPickerItem {
	readonly key: string;
	readonly activityId: VoiceActivityId;
	readonly startMode: string | null;
	readonly presentation: ActivityPresentation;
}

export const ACTIVITY_PICKER_ITEMS: ReadonlyArray<ActivityPickerItem> = ACTIVITY_LIST.flatMap((definition) => [
	{key: definition.id, activityId: definition.id, startMode: null, presentation: definition},
	...(definition.entries ?? []).map((entry) => ({
		key: `${definition.id}:${entry.startMode}`,
		activityId: definition.id,
		startMode: entry.startMode,
		presentation: entry,
	})),
]);

export function getActivityDefinition(id: VoiceActivityId): ActivityDefinition {
	return ACTIVITIES[id];
}
