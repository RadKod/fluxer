// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Message} from '@app/features/messaging/models/MessagingMessage';
import {HttpError} from '@app/features/platform/types/EndpointError';
import {MessageTypes} from '@fluxer/constants/src/ChannelConstants';
import {setupI18n} from '@lingui/core';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const http = vi.hoisted(() => ({post: vi.fn()}));
const messageCommands = vi.hoisted(() => ({createOptimistic: vi.fn()}));
const toast = vi.hoisted(() => ({error: vi.fn()}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({http}));
vi.mock('@app/features/messaging/commands/MessageCommands', () => messageCommands);
vi.mock('@app/features/ui/commands/ToastCommands', () => toast);
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		debug = vi.fn();
		warn = vi.fn();
		error = vi.fn();
	},
}));
// The real createSystemMessage runs; the stores and models it reaches are reduced to plain data.
const {PlainRecord} = vi.hoisted(() => ({
	PlainRecord: class {
		constructor(private readonly data: Record<string, unknown>) {}
		toJSON() {
			return this.data;
		}
	},
}));
vi.mock('@app/features/messaging/models/MessagingMessage', () => ({Message: PlainRecord}));
vi.mock('@app/features/user/models/User', () => ({User: PlainRecord}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {}}));
vi.mock('@app/features/channel/commands/PrivateChannelCommands', () => ({}));
vi.mock('@app/features/guild/commands/GuildCommands', () => ({}));
vi.mock('@app/features/member/commands/GuildMemberCommands', () => ({}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: {}}));
vi.mock('@app/features/user/state/Users', () => ({default: {}}));
vi.mock('@app/features/user/utils/NicknameUtils', () => ({}));

const {clickMessageComponent} = await import('@app/features/messaging/commands/MessageComponentCommands');

const i18n = setupI18n({locale: 'en', messages: {en: {}}});
const BOT = {id: '1300000000000000001', username: 'roster', discriminator: '0000', global_name: null, avatar: null};
const clicked = {
	id: '1300000000000000002',
	channelId: '1300000000000000003',
	author: {toJSON: () => BOT},
} as unknown as Message;

describe('MessageComponentCommands', () => {
	beforeEach(() => {
		for (const mock of [http.post, messageCommands.createOptimistic, toast.error]) mock.mockReset();
	});

	it('a click posts the custom_id to the components endpoint', async () => {
		http.post.mockResolvedValueOnce({body: {reply: null}});

		await clickMessageComponent(i18n, clicked, 'roster:join');

		expect(http.post).toHaveBeenCalledWith('/channels/1300000000000000003/messages/1300000000000000002/components', {
			body: {custom_id: 'roster:join'},
		});
	});

	it('a reply becomes a local message authored by the bot that only the clicker sees', async () => {
		http.post.mockResolvedValueOnce({body: {reply: {code: 'roster_joined'}}});

		await clickMessageComponent(i18n, clicked, 'roster:join');

		expect(messageCommands.createOptimistic).toHaveBeenCalledTimes(1);
		const [channelId, local] = messageCommands.createOptimistic.mock.calls[0];
		expect(channelId).toBe(clicked.channelId);
		expect(local).toMatchObject({
			channel_id: clicked.channelId,
			author: BOT,
			type: MessageTypes.CLIENT_SYSTEM,
			content: 'You joined the roster.',
		});
		expect(local.id).not.toBe(clicked.id);
		expect(http.post).toHaveBeenCalledTimes(1);
	});

	it('an unknown reply code shows no local message', async () => {
		http.post.mockResolvedValueOnce({body: {reply: {code: 'giveaway_from_the_future'}}});
		await clickMessageComponent(i18n, clicked, 'roster:join');
		http.post.mockResolvedValueOnce({body: {reply: null}});
		await clickMessageComponent(i18n, clicked, 'roster:join');

		expect(messageCommands.createOptimistic).not.toHaveBeenCalled();
		expect(toast.error).not.toHaveBeenCalled();
	});

	it('an HTTP error shows the API message and adds no local message', async () => {
		http.post.mockRejectedValueOnce(
			new HttpError({
				method: 'POST',
				path: '/',
				status: 403,
				body: {code: 'MISSING_ACCESS', message: 'Missing access'},
			}),
		);

		await clickMessageComponent(i18n, clicked, 'roster:join');

		expect(toast.error).toHaveBeenCalledWith('Missing access');
		expect(messageCommands.createOptimistic).not.toHaveBeenCalled();
	});
});
