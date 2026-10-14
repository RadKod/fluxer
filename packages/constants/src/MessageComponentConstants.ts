// SPDX-License-Identifier: AGPL-3.0-or-later

// Discord-compatible numbers. v1 has only action rows of buttons; link buttons and other kinds come later.
export const MessageComponentTypes = {ACTION_ROW: 1, BUTTON: 2} as const;
export const ButtonStyles = {PRIMARY: 1, SECONDARY: 2, SUCCESS: 3, DANGER: 4} as const;
export const MESSAGE_COMPONENT_LIMITS = {rows: 5, buttonsPerRow: 5, labelMax: 80, customIdMax: 100} as const;

// A closed set: the server never sends free text in a click reply, the client shows a translated message for each code.
export const MESSAGE_COMPONENT_REPLY_CODES = [
	'component_unavailable',
	'roster_joined',
	'roster_already_joined',
	'roster_left',
	'roster_not_joined',
	'roster_full',
	'roster_closed',
	'roster_busy',
] as const;
export type MessageComponentReplyCode = (typeof MESSAGE_COMPONENT_REPLY_CODES)[number];
