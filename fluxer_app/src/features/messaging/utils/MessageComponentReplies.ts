// SPDX-License-Identifier: AGPL-3.0-or-later

import type {MessageComponentReplyCode} from '@fluxer/constants/src/MessageComponentConstants';
import type {MessageDescriptor} from '@lingui/core';
import {msg} from '@lingui/core/macro';

// The server answers a button click with a code from a closed set; the bot never sends free text here.
const REPLIES: Record<MessageComponentReplyCode, MessageDescriptor> = {
	component_unavailable: msg({
		message: 'This button is no longer available.',
		comment: 'Bot reply only the clicker sees after pressing a message button whose bot or action is no longer active.',
	}),
	roster_joined: msg({
		message: 'You joined the roster.',
		comment: 'Event bot reply only the clicker sees after pressing Join on an event roster card.',
	}),
	roster_already_joined: msg({
		message: 'You are already on the roster.',
		comment: 'Event bot reply only the clicker sees after pressing Join while already signed up for the event.',
	}),
	roster_left: msg({
		message: 'You left the roster.',
		comment: 'Event bot reply only the clicker sees after pressing Leave on an event roster card.',
	}),
	roster_not_joined: msg({
		message: 'You are not on the roster.',
		comment: 'Event bot reply only the clicker sees after pressing Leave without being signed up for the event.',
	}),
	roster_full: msg({
		message: 'The roster is full.',
		comment: 'Event bot reply only the clicker sees when the main roster, substitutes and waiting list are all full.',
	}),
	roster_closed: msg({
		message: 'Sign-ups for this event are closed.',
		comment: 'Event bot reply only the clicker sees after pressing Join once the event has started or closed.',
	}),
	roster_busy: msg({
		message: 'You are already on the roster of another event at the same time.',
		comment: 'Event bot reply only the clicker sees when they are signed up for a different event in the same hour.',
	}),
};

export function replyDescriptor(code: string): MessageDescriptor | undefined {
	return Object.hasOwn(REPLIES, code) ? REPLIES[code as MessageComponentReplyCode] : undefined;
}
