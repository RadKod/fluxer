// SPDX-License-Identifier: AGPL-3.0-or-later

// Words the call uses around any activity: on its tile, on the expanded stage, in the mini window and the menu.

import {msg} from '@lingui/core/macro';

export const ACTIVITIES_DESCRIPTOR = msg({
	message: 'Activities',
	context: 'voice-activities',
	comment: 'Voice control bar: button that opens the list of activities (games played together in the voice channel).',
});
export const JOIN_ACTIVITY_DESCRIPTOR = msg({
	message: 'Join',
	context: 'voice-activity',
	comment:
		'Voice activities: button on the activity tile in a call. Joining plays the activity and hears its sound; without it the call goes on as before.',
});
export const LEAVE_ACTIVITY_DESCRIPTOR = msg({
	message: 'Leave activity',
	comment: 'Voice activities: menu item and button that stop taking part in the running activity; the call goes on.',
});
export const END_ACTIVITY_DESCRIPTOR = msg({
	message: 'End activity',
	comment: 'Voice activities: button in the activity panel that ends the activity for everyone in the channel.',
});
export const EXPAND_ACTIVITY_DESCRIPTOR = msg({
	message: 'Expand',
	context: 'voice-activity',
	comment: 'Voice activities: button on the activity tile in a call that makes the activity fill the call area.',
});
export const COLLAPSE_ACTIVITY_DESCRIPTOR = msg({
	message: 'Back to the grid',
	context: 'voice-activity',
	comment:
		'Voice activities: button on the expanded activity that shrinks it back to a tile among the people in the call.',
});
export const ACTIVITY_OPTIONS_DESCRIPTOR = msg({
	message: 'Activity options',
	comment: 'Voice activities: accessible label of the "more" button on the activity tile, which opens a small menu.',
});
export const ACTIVITY_TILE_LABEL_DESCRIPTOR = msg({
	message: '{activity} activity',
	comment: 'Voice activities: accessible name of the activity tile in a call. {activity} is the activity name.',
});
export const PEOPLE_JOINED_DESCRIPTOR = msg({
	message: '{count, plural, =0 {Nobody has joined yet} one {# person joined} other {# people joined}}',
	comment: 'Voice activities: on the activity tile in a call, how many people in the channel take part.',
});
