// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ChannelID, GuildID, MessageID, RoleID, UserID} from '@app/api/BrandedTypes';
import {actionRow, button} from '@app/api/channel/services/message/MessageComponentRules';
import type {GuildRosterEventRow} from '@app/api/database/types/GuildRosterTypes';
import type {MessageActionRowData} from '@app/api/database/types/MessageTypes';
import {
	ROSTER_BUTTON_IDS,
	ROSTER_EMBED_COLOR_CLOSED,
	ROSTER_EMBED_COLOR_OPEN,
	ROSTER_JOIN_EMOJI,
	ROSTER_TEXT,
} from '@app/api/guild/roster/GuildRosterConstants';
import type {GuildRosterFinal} from '@app/api/guild/roster/GuildRosterService';
import {ButtonStyles} from '@fluxer/constants/src/MessageComponentConstants';
import type {MessageRequestSchemaType} from '@fluxer/schema/src/domains/message/MessageRequestSchemas';

export interface GuildRosterEmbedInput extends GuildRosterFinal {
	name: string;
	startSeconds: number;
	announcedAt: number;
	mainSize: number;
	subSize: number;
	closed: boolean;
}

export function splitRoster(members: Array<UserID>, mainSize: number, subSize: number): GuildRosterFinal {
	return {main: members.slice(0, mainSize), subs: members.slice(mainSize, mainSize + subSize)};
}

export function buildRosterEmbed(
	input: GuildRosterEmbedInput,
): NonNullable<MessageRequestSchemaType['embeds']>[number] {
	const {name, startSeconds, announcedAt, main, subs, mainSize, subSize, closed} = input;
	const lines = closed
		? [ROSTER_TEXT.closed, ROSTER_TEXT.closedAt(startSeconds)]
		: [ROSTER_TEXT.startsAt(startSeconds), ROSTER_TEXT.howTo];
	lines.push('', ROSTER_TEXT.mainHeader(main.length, mainSize));
	for (let i = 0; i < mainSize; i++) lines.push(ROSTER_TEXT.slot(i + 1, main[i]?.toString() ?? null));
	if (subSize > 0) {
		lines.push('', ROSTER_TEXT.subHeader(subs.length, subSize));
		for (let i = 0; i < subSize; i++) lines.push(ROSTER_TEXT.slot(i + 1, subs[i]?.toString() ?? null));
	}
	return {
		title: ROSTER_TEXT.title(name),
		description: lines.join('\n'),
		color: closed ? ROSTER_EMBED_COLOR_CLOSED : ROSTER_EMBED_COLOR_OPEN,
		timestamp: new Date(announcedAt),
	};
}

// The card is edited on every render, so it carries no mention (an edit with one reaches passive sessions); the role
// ping is a separate reply to it (buildRolePing).
export function buildAnnouncement(
	event: GuildRosterEventRow,
	startSeconds: number,
	announcedAt: number,
): Pick<MessageRequestSchemaType, 'embeds' | 'allowed_mentions'> {
	return {
		embeds: [
			buildRosterEmbed({
				name: event.name,
				startSeconds,
				announcedAt,
				main: [],
				subs: [],
				mainSize: event.main_size,
				subSize: event.sub_size,
				closed: false,
			}),
		],
		allowed_mentions: {parse: []},
	};
}

export function buildRolePing(
	roleId: RoleID,
	card: {messageId: MessageID; channelId: ChannelID; guildId: GuildID},
): Pick<MessageRequestSchemaType, 'content' | 'allowed_mentions' | 'message_reference'> {
	return {
		content: `<@&${roleId}>`,
		allowed_mentions: {parse: [], roles: [roleId]},
		message_reference: {message_id: card.messageId, channel_id: card.channelId, guild_id: card.guildId},
	};
}

export function rosterComponents(closed: boolean): Array<MessageActionRowData> {
	return [
		actionRow([
			button({
				customId: ROSTER_BUTTON_IDS.join,
				label: ROSTER_TEXT.joinButton,
				style: ButtonStyles.SUCCESS,
				emoji: ROSTER_JOIN_EMOJI,
				disabled: closed,
			}),
			button({
				customId: ROSTER_BUTTON_IDS.leave,
				label: ROSTER_TEXT.leaveButton,
				style: ButtonStyles.SECONDARY,
				disabled: closed,
			}),
		]),
	];
}

export function buildMoveWarning(
	name: string,
	count: number,
	{targetPermissions = 0, roomDeleted = 0}: {targetPermissions?: number; roomDeleted?: number} = {},
): {content: string; allowed_mentions: {parse: []}} {
	const escapedName = name.replace(/[\\*_~|`>@<]/g, '\\$&');
	const lines: Array<string> = [];
	const other = count - targetPermissions - roomDeleted;
	if (other > 0) lines.push(ROSTER_TEXT.moveWarning(escapedName, other));
	if (targetPermissions > 0) lines.push(ROSTER_TEXT.targetPermissionsWarning(escapedName, targetPermissions));
	if (roomDeleted > 0) lines.push(ROSTER_TEXT.roomDeletedWarning(escapedName, roomDeleted));
	return {
		content: lines.join('\n'),
		allowed_mentions: {parse: []},
	};
}
