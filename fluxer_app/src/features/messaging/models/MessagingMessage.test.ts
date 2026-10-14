// SPDX-License-Identifier: AGPL-3.0-or-later

import type {MessageActionRow} from '@fluxer/schema/src/domains/message/MessageComponentSchemas';
import {describe, expect, it, vi} from 'vitest';

// The record reads many stores; this test is only about the button rows it carries.
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {localInstanceDomain: 'micup.test'}}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {currentUserId: null}}));
vi.mock('@app/features/channel/state/Channels', () => ({default: {}}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {}}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: {}}));
vi.mock('@app/features/user/state/UserGuildSettings', () => ({default: {}}));
vi.mock('@app/features/relationship/state/Relationships', () => ({default: {isBlocked: () => false}}));
vi.mock('@app/features/user/state/Users', () => ({default: {cacheUsers: vi.fn(), getUser: () => undefined}}));
vi.mock('@app/features/messaging/state/MessageReactions', () => ({
	default: {hydrateMessageReactions: vi.fn(), replaceMessageReactions: vi.fn(), getMessageReactions: () => []},
}));
vi.mock('@app/features/messaging/utils/ReactionUtils', () => ({emojiEquals: () => false}));
vi.mock('@app/features/messaging/utils/EmbeddableCodeLinkContent', () => ({
	extractEmbeddableCodeLinkContent: (content: string) => content,
}));
vi.mock('@app/features/gift/utils/GiftCodeUtils', () => ({findGifts: () => []}));
vi.mock('@app/features/invite/utils/InviteUtils', () => ({findInvites: () => []}));
vi.mock('@app/features/theme/utils/ThemeUtils', () => ({findThemes: () => []}));
vi.mock('@app/features/user/models/User', () => ({
	User: class {
		readonly id: string;
		constructor(private readonly data: {id: string}) {
			this.id = data.id;
		}
		toJSON() {
			return this.data;
		}
		equals(other: {id: string}) {
			return other.id === this.id;
		}
	},
}));

const {Message} = await import('@app/features/messaging/models/MessagingMessage');

const BOT = {
	id: '1300000000000000001',
	username: 'roster',
	discriminator: '0000',
	global_name: null,
	avatar: null,
	avatar_color: null,
	flags: 0,
	bot: true,
};
const JOIN_ROW: MessageActionRow = {
	type: 1,
	components: [
		{
			type: 2,
			style: 3,
			label: 'Join',
			emoji: {name: '✅', id: null, animated: false},
			custom_id: 'roster:join',
			disabled: false,
		},
		{type: 2, style: 2, label: 'Leave', emoji: null, custom_id: 'roster:leave', disabled: false},
	],
};
const CLOSED_ROW: MessageActionRow = {
	type: 1,
	components: JOIN_ROW.components.map((button) => ({...button, disabled: true})),
};

const wire = (components?: ReadonlyArray<MessageActionRow>) => ({
	id: '1300000000000000002',
	channel_id: '1300000000000000003',
	author: BOT,
	type: 0,
	flags: 0,
	pinned: false,
	mention_everyone: false,
	content: '',
	timestamp: '2026-10-03T12:00:00.000Z',
	...(components ? {components} : {}),
});

describe('Message components', () => {
	it('components from the wire are kept on the record', () => {
		expect(new Message(wire([JOIN_ROW])).components).toEqual([JOIN_ROW]);
	});

	it('an update with components replaces the rows; one without keeps them', () => {
		const message = new Message(wire([JOIN_ROW]));
		const closed = message.withUpdates({components: [CLOSED_ROW]});
		expect(closed.components).toEqual([CLOSED_ROW]);
		expect(closed.equals(message)).toBe(false);
		expect(closed.withUpdates({content: 'edited'}).components).toEqual([CLOSED_ROW]);
	});

	it('toJSON round-trips components', () => {
		const message = new Message(wire([JOIN_ROW]));
		expect(message.toJSON().components).toEqual([JOIN_ROW]);
		const copy = new Message(message.toJSON());
		expect(copy.components).toEqual([JOIN_ROW]);
		expect(copy.equals(message)).toBe(true);
	});

	it('a message without components has an empty list', () => {
		expect(new Message(wire()).components).toEqual([]);
		expect(new Message({...wire(), components: null} as never).components).toEqual([]);
	});
});
