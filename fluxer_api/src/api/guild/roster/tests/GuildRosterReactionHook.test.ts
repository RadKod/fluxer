// SPDX-License-Identifier: AGPL-3.0-or-later

import {createEmojiID, createMessageID, createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import type {GuildRosterReactionChange} from '@app/api/guild/roster/GuildRosterService';
import {
	ANNOUNCE_AT,
	createRosterFixture,
	HOUR,
	OPEN_STATE,
	REF,
	type RosterFixture,
	USER_A,
} from '@app/api/guild/roster/tests/GuildRosterTestUtils';
import * as Registry from '@app/api/middleware/ServiceRegistry';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {createSnowflake} from '@fluxer/snowflake/src/Snowflake';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const botId = createUserID(999n);
const change: GuildRosterReactionChange = {
	kind: 'add',
	guildId: REF.guildId,
	channelId: OPEN_STATE.channelId,
	messageId: OPEN_STATE.messageId,
	authorId: botId,
	userId: USER_A,
	emojiName: '✅',
	emojiId: undefined,
	atMs: ANNOUNCE_AT,
};
const notify = async (input: GuildRosterReactionChange) =>
	(await import('@app/api/guild/roster/GuildRosterReactionHook')).notifyGuildRosterReaction(input);

describe('GuildRosterReactionHook guards', () => {
	const originalBotId = Config.instance.rosterBotApplicationId;
	beforeEach(() => {
		Config.instance.rosterBotApplicationId = '999';
		vi.spyOn(Date, 'now').mockReturnValue(ANNOUNCE_AT);
	});
	afterEach(() => {
		Config.instance.rosterBotApplicationId = originalBotId;
		vi.restoreAllMocks();
	});
	it('a reaction on a message not written by the roster bot queues nothing and reads nothing', async () => {
		const queue = vi.spyOn(Registry, 'getWorkerService');
		const kv = vi.spyOn(Registry, 'getKVClient');
		await notify({...change, authorId: USER_A});
		expect(queue).not.toHaveBeenCalled();
		expect(kv).not.toHaveBeenCalled();
	});
	it("the bot's own ✅ is ignored", async () => {
		const queue = vi.spyOn(Registry, 'getWorkerService');
		await notify({...change, userId: botId});
		expect(queue).not.toHaveBeenCalled();
	});
	it('another emoji is ignored', async () => {
		const queue = vi.spyOn(Registry, 'getWorkerService');
		await notify({...change, emojiName: '❌'});
		await notify({...change, emojiId: createEmojiID(1n)});
		expect(queue).not.toHaveBeenCalled();
	});
	it('no bot configured → nothing queued', async () => {
		Config.instance.rosterBotApplicationId = undefined;
		const queue = vi.spyOn(Registry, 'getWorkerService');
		await notify(change);
		expect(queue).not.toHaveBeenCalled();
	});
	it('a ✅ on a roster message older than 2 h queues nothing', async () => {
		const queue = vi.spyOn(Registry, 'getWorkerService');
		const kv = vi.spyOn(Registry, 'getKVClient');
		await notify({...change, messageId: createMessageID(createSnowflake({timestamp: ANNOUNCE_AT - 7_200_001}))});
		expect(queue).not.toHaveBeenCalled();
		expect(kv).not.toHaveBeenCalled();
	});
});

describe('GuildRosterReactionHook routes', () => {
	let harness: ApiTestHarness;
	let f: RosterFixture;
	let messageId: string;
	const originalBotId = Config.instance.rosterBotApplicationId;
	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
		f = await createRosterFixture(harness);
		await f.runtime.runSlots('announce', HOUR, f.slotStart);
		messageId = (await f.roster.readState(f.ref))!.messageId.toString();
		f.jobs.mockClear();
	});
	afterEach(() => {
		Config.instance.rosterBotApplicationId = originalBotId;
		vi.restoreAllMocks();
	});
	afterAll(async () => {
		await harness.shutdown();
	});
	const route = () => `/channels/${f.systemChannel.id}/messages/${messageId}/reactions/${encodeURIComponent('✅')}`;
	it('✅ on the bot message queues one sync job with the reaction time', async () => {
		await createBuilder(harness, f.members[0]!.token).put(`${route()}/@me`).expect(204).execute();
		expect(f.jobs).toHaveBeenCalledWith(
			'syncGuildRosterReaction',
			{
				kind: 'add',
				guild_id: f.guild.id,
				channel_id: f.systemChannel.id,
				message_id: messageId,
				user_id: f.members[0]!.userId,
				at: ANNOUNCE_AT,
			},
			{jobKey: `${messageId}:${f.members[0]!.userId}:add:${ANNOUNCE_AT}`, skipLedger: true},
		);
	});
	it('add and remove in the same millisecond have distinct job keys', async () => {
		await createBuilder(harness, f.members[0]!.token).put(`${route()}/@me`).expect(204).execute();
		await createBuilder(harness, f.members[0]!.token).delete(`${route()}/@me`).expect(204).execute();
		const keys = f.jobs.mock.calls.map(([, , options]) => options?.jobKey);
		expect(keys).toHaveLength(2);
		expect(new Set(keys).size).toBe(2);
	});
	it('a check mark with a variation selector queues a sync job', async () => {
		await notify({
			...change,
			messageId: createMessageID(BigInt(messageId)),
			authorId: f.botId,
			emojiName: '✅\uFE0F',
		});
		expect(f.jobs).toHaveBeenCalledWith(
			'syncGuildRosterReaction',
			expect.objectContaining({kind: 'add', message_id: messageId}),
			expect.anything(),
		);
	});
	it('a failing queue never fails the reaction route (204)', async () => {
		f.jobs.mockRejectedValueOnce(new Error('queue unavailable'));
		await createBuilder(harness, f.members[0]!.token).put(`${route()}/@me`).expect(204).execute();
		expect(f.jobs).toHaveBeenCalledTimes(1);
		f.jobs.mockImplementationOnce(() => {
			throw new Error('synchronous queue failure');
		});
		await createBuilder(harness, f.members[0]!.token).delete(`${route()}/@me`).expect(204).execute();
	});
	it('removing all reactions queues a clear', async () => {
		await createBuilder(harness, f.owner.token)
			.delete(`/channels/${f.systemChannel.id}/messages/${messageId}/reactions`)
			.expect(204)
			.execute();
		expect(f.jobs).toHaveBeenCalledWith(
			'syncGuildRosterReaction',
			expect.objectContaining({kind: 'clear', message_id: messageId}),
			expect.anything(),
		);
	});
	it('removing an emoji queues clear and removing another user passes the target ID', async () => {
		await createBuilder(harness, f.members[0]!.token).put(`${route()}/@me`).expect(204).execute();
		f.jobs.mockClear();
		await createBuilder(harness, f.owner.token).delete(`${route()}/${f.members[0]!.userId}`).expect(204).execute();
		expect(f.jobs).toHaveBeenCalledWith(
			'syncGuildRosterReaction',
			expect.objectContaining({kind: 'remove', user_id: f.members[0]!.userId}),
			expect.anything(),
		);
		f.jobs.mockClear();
		await createBuilder(harness, f.owner.token).delete(route()).expect(204).execute();
		expect(f.jobs).toHaveBeenCalledWith(
			'syncGuildRosterReaction',
			expect.objectContaining({kind: 'clear'}),
			expect.anything(),
		);
	});
});
