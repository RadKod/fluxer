// SPDX-License-Identifier: AGPL-3.0-or-later

import {MICUPBOT_EMBED_COLOR} from '@app/api/guild/micupbot/MicupBotConstants';
import type {MicupBotMemberEventPayload} from '@app/api/guild/micupbot/MicupBotMemberEvents';
import {useMemberFixture} from '@app/api/guild/micupbot/tests/MicupBotMemberTestUtils';
import {Logger} from '@app/api/Logger';
import {expect, it, vi} from 'vitest';

const fixture = useMemberFixture();

it('welcome renders the template in the channel and pings only the member', async () => {
	const f = await fixture({welcome_message: 'Hello {user}, {user.name} in {server} ({user.id})'});
	await f.rejoin();
	const job = f.jobs.mock.calls.find(([name]) => name === 'handleMicupBotMemberEvent');
	expect(job).toBeDefined();
	await f.runner.run(job![1] as unknown as MicupBotMemberEventPayload);
	expect(f.send).toHaveBeenCalledWith(
		expect.objectContaining({
			user: expect.objectContaining({id: f.botId}),
			channelId: f.channelId,
			data: expect.objectContaining({
				content: expect.stringContaining(`<@${f.userId}>`),
				allowed_mentions: {parse: [], users: [f.userId]},
			}),
		}),
	);
	const {message} = await f.send.mock.results[0]!.value;
	expect(message.mentionEveryone).toBe(false);
	expect(message.mentionedUserIds).toEqual(new Set([f.userId]));
});

it('a template with @everyone in the community name pings nobody', async () => {
	const f = await fixture({welcome_message: '{server}'});
	await f.deps.guildRepository.upsertPartial(f.guildModel.id, {name: '@everyone'});
	await f.runner.run(f.payload);
	expect(f.send.mock.calls[0]![0].data.allowed_mentions?.parse).toEqual([]);
	const {message} = await f.send.mock.results[0]!.value;
	expect(message.mentionEveryone).toBe(false);
	expect(message.mentionedUserIds.size).toBe(0);
});

it('goodbye pings nobody', async () => {
	const f = await fixture({goodbye_message: 'Bye {user} @everyone'});
	await f.deps.guildRepository.deleteMember(f.guildId, f.userId);
	await f.runner.run({...f.payload, kind: 'leave'});
	expect(f.send.mock.calls[0]![0].data.allowed_mentions).toEqual({parse: []});
	const {message} = await f.send.mock.results[0]!.value;
	expect(message.mentionEveryone).toBe(false);
	expect(message.mentionedUserIds.size).toBe(0);
});

it('more than 10 joins a second skip the extra welcomes and count them', async () => {
	const f = await fixture({autorole_ids: null});
	vi.spyOn(Date, 'now').mockReturnValue(Date.now());
	const debug = vi.spyOn(Logger.child({}), 'debug');
	for (let i = 0; i < 11; i++) await f.runner.run(f.payload);
	expect(f.send).toHaveBeenCalledTimes(10);
	expect(debug).toHaveBeenCalledWith(expect.objectContaining({welcome_skipped: 1}), expect.any(String));
});

it('welcome and goodbye embeds contain the rendered text and avatar', async () => {
	const f = await fixture({
		welcome_embed: true,
		goodbye_embed: true,
		welcome_message: 'Welcome {user}',
		goodbye_message: 'Bye {user.name}',
	});
	for (const kind of ['join', 'leave'] as const) {
		await f.runner.run({...f.payload, kind});
		const data = f.send.mock.calls.at(-1)![0].data;
		expect(data.content).toBeUndefined();
		expect(data.embeds).toEqual([
			expect.objectContaining({
				description: expect.any(String),
				color: MICUPBOT_EMBED_COLOR,
				thumbnail: {url: expect.stringContaining('/avatars/')},
			}),
		]);
	}
});
