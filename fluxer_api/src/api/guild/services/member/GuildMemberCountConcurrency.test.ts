// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createGuildID} from '@app/api/BrandedTypes';
import {GuildRepository} from '@app/api/guild/repositories/GuildRepository';
import {createChannelInvite, createGuild, leaveGuild} from '@app/api/guild/tests/GuildTestUtils';
import {COUNTER_PARTITIONS, counterPartition} from '@app/api/infrastructure/KVCounterService';
import {
	GUILD_MEMBER_COUNT_COUNTER,
	getKVCounterService,
	getLimitConfigService,
} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {NoopWorkerService} from '@app/api/test/NoopWorkerService';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import flushCounters from '@app/api/worker/tasks/FlushCounters';
import rebuildCounter from '@app/api/worker/tasks/RebuildCounter';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import type {IWorkerService} from '@pkgs/worker/src/contracts/IWorkerService';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import type {WorkerJobPayload} from '@pkgs/worker/src/contracts/WorkerTypes';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

const helpers: WorkerTaskHelpers = {
	logger: new NoopLogger(),
	jobId: 1n,
	addJob: async () => 0n,
	reportProgress: async () => {},
	shouldCancel: async () => false,
	setContextLink: async () => {},
};

async function createAccounts(harness: ApiTestHarness, count: number): Promise<Array<TestAccount>> {
	return await Promise.all(Array.from({length: count}, async () => createTestAccount(harness)));
}

async function joinGuild(harness: ApiTestHarness, account: TestAccount, inviteCode: string): Promise<Response> {
	return await harness.requestJson({
		path: `/invites/${inviteCode}`,
		method: 'POST',
		headers: {Authorization: account.token},
	});
}

async function storedCounts(guildId: string): Promise<{memberCount: number; memberRows: number}> {
	await flushCounters({}, helpers);
	const guildRepository = new GuildRepository();
	const id = createGuildID(BigInt(guildId));
	const guild = await guildRepository.findUnique(id);
	return {memberCount: guild?.memberCount ?? -1, memberRows: await guildRepository.countMembers(id)};
}

async function wipeKv(harness: ApiTestHarness): Promise<void> {
	const keys = await harness.kvProvider.scan('*', 1_000_000);
	if (keys.length > 0) {
		await harness.kvProvider.del(...keys);
	}
}

describe('Guild member_count under concurrent membership changes', () => {
	let harness: ApiTestHarness;
	let owner: TestAccount;
	let guildId: string;
	let inviteCode: string;

	beforeEach(async () => {
		harness = await createApiTestHarness();
		owner = await createTestAccount(harness);
		const guild = await createGuild(harness, owner.token, 'Member Count Guild');
		guildId = guild.id;
		inviteCode = (await createChannelInvite(harness, owner.token, guild.system_channel_id!)).code;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await harness?.shutdown();
	});

	test('counts concurrent joins, leaves and bans exactly', async () => {
		const users = await createAccounts(harness, 50);
		const joins = await Promise.all(users.map(async (user) => joinGuild(harness, user, inviteCode)));
		expect(joins.map((response) => response.status)).toEqual(users.map(() => HTTP_STATUS.OK));
		expect(await storedCounts(guildId)).toEqual({memberCount: 51, memberRows: 51});

		await Promise.all(users.slice(0, 20).map(async (user) => leaveGuild(harness, user.token, guildId)));
		expect(await storedCounts(guildId)).toEqual({memberCount: 31, memberRows: 31});

		await Promise.all(
			users
				.slice(20, 40)
				.map(async (user) =>
					createBuilder(harness, owner.token)
						.put(`/guilds/${guildId}/bans/${user.userId}`)
						.body({})
						.expect(HTTP_STATUS.NO_CONTENT)
						.execute(),
				),
		);
		expect(await storedCounts(guildId)).toEqual({memberCount: 11, memberRows: 11});
	});

	test('continues from the stored count after the KV store is wiped', async () => {
		const early = await createAccounts(harness, 9);
		await Promise.all(early.map(async (user) => joinGuild(harness, user, inviteCode)));
		expect(await storedCounts(guildId)).toEqual({memberCount: 10, memberRows: 10});

		await wipeKv(harness);
		const late = await createAccounts(harness, 50);
		const joins = await Promise.all(late.map(async (user) => joinGuild(harness, user, inviteCode)));
		expect(joins.every((response) => response.status === HTTP_STATUS.OK)).toBe(true);
		expect(await storedCounts(guildId)).toEqual({memberCount: 60, memberRows: 60});
	});

	test('counts one join when the same user accepts an invite ten times at once', async () => {
		const [user] = await createAccounts(harness, 1);
		await Promise.all(Array.from({length: 10}, async () => joinGuild(harness, user!, inviteCode)));
		expect(await storedCounts(guildId)).toEqual({memberCount: 2, memberRows: 2});
		await leaveGuild(harness, user!.token, guildId);
		expect(await storedCounts(guildId)).toEqual({memberCount: 1, memberRows: 1});
	});

	test('counts one leave when the same user leaves ten times at once', async () => {
		const users = await createAccounts(harness, 2);
		await Promise.all(users.map(async (user) => joinGuild(harness, user, inviteCode)));
		await Promise.all(
			Array.from({length: 10}, async () =>
				harness.requestJson({
					path: `/users/@me/guilds/${guildId}`,
					method: 'DELETE',
					headers: {Authorization: users[0]!.token},
				}),
			),
		);
		expect(await storedCounts(guildId)).toEqual({memberCount: 2, memberRows: 2});
	});

	test('counts one removal when a ban races a leave', async () => {
		const users = await createAccounts(harness, 2);
		await Promise.all(users.map(async (user) => joinGuild(harness, user, inviteCode)));
		await Promise.all([
			harness.requestJson({
				path: `/guilds/${guildId}/bans/${users[0]!.userId}`,
				method: 'PUT',
				body: {},
				headers: {Authorization: owner.token},
			}),
			harness.requestJson({
				path: `/users/@me/guilds/${guildId}`,
				method: 'DELETE',
				headers: {Authorization: users[0]!.token},
			}),
		]);
		expect(await storedCounts(guildId)).toEqual({memberCount: 2, memberRows: 2});
	});

	test('counts one removal when two moderators kick the same member at once', async () => {
		const users = await createAccounts(harness, 2);
		await Promise.all(users.map(async (user) => joinGuild(harness, user, inviteCode)));
		await Promise.all(
			Array.from({length: 2}, async () =>
				harness.requestJson({
					path: `/guilds/${guildId}/members/${users[0]!.userId}`,
					method: 'DELETE',
					headers: {Authorization: owner.token},
				}),
			),
		);
		expect(await storedCounts(guildId)).toEqual({memberCount: 2, memberRows: 2});
	});

	test('repairs a drifted KV count through the recount the guild load queues', async () => {
		const users = await createAccounts(harness, 2);
		await Promise.all(users.map(async (user) => joinGuild(harness, user, inviteCode)));
		expect(await storedCounts(guildId)).toEqual({memberCount: 3, memberRows: 3});
		await getKVCounterService().add(GUILD_MEMBER_COUNT_COUNTER, guildId, 5);
		const recounts: Array<WorkerJobPayload> = [];
		vi.spyOn(NoopWorkerService.prototype as IWorkerService, 'addJob').mockImplementation(async (taskType, payload) => {
			if (taskType === 'rebuildCounter') recounts.push(payload);
			return 0n;
		});
		await createBuilder(harness, '')
			.post('/test/rpc-session-init')
			.body({type: 'guild_collection', guild_id: guildId, collection: 'guild'})
			.expect(HTTP_STATUS.OK)
			.execute();
		await vi.waitFor(() => expect(recounts).toHaveLength(1));
		await rebuildCounter(recounts[0]!, helpers);
		expect(await getKVCounterService().get(GUILD_MEMBER_COUNT_COUNTER, guildId)).toBe(3);
		expect(await storedCounts(guildId)).toEqual({memberCount: 3, memberRows: 3});
	});

	test('finishes the flush task when one counter partition fails and flushes it later', async () => {
		const users = await createAccounts(harness, 2);
		await Promise.all(users.map(async (user) => joinGuild(harness, user, inviteCode)));
		const counters = getKVCounterService();
		const flushPartition = counters.flushPartition.bind(counters);
		const failingPartition = counterPartition(GUILD_MEMBER_COUNT_COUNTER, guildId);
		vi.spyOn(counters, 'flushPartition').mockImplementation(async (partition, max) => {
			if (partition === failingPartition) {
				throw new Error('KV node unavailable');
			}
			return await flushPartition(partition, max);
		});
		await expect(flushCounters({}, helpers)).resolves.toBeUndefined();
		vi.restoreAllMocks();
		expect(await storedCounts(guildId)).toEqual({memberCount: 3, memberRows: 3});
	});

	test('flushes every counter partition with bounded concurrency', async () => {
		const counters = getKVCounterService();
		const flushPartition = counters.flushPartition.bind(counters);
		const seen = new Set<number>();
		let active = 0;
		let peak = 0;
		vi.spyOn(counters, 'flushPartition').mockImplementation(async (partition, max) => {
			seen.add(partition);
			active++;
			peak = Math.max(peak, active);
			try {
				await new Promise((resolve) => setTimeout(resolve, 0));
				return await flushPartition(partition, max);
			} finally {
				active--;
			}
		});
		await flushCounters({}, helpers);
		expect(seen.size).toBe(COUNTER_PARTITIONS);
		expect(peak).toBeLessThanOrEqual(32);
	});

	test('flushes a dirty member count with one stored read and one stored write', async () => {
		const [user] = await createAccounts(harness, 1);
		await joinGuild(harness, user!, inviteCode);
		const queries = vi.spyOn(InMemoryCassandraQueryExecutor.prototype, 'executeQuery');
		await flushCounters({}, helpers);
		const guildQueries = queries.mock.calls
			.map(([query]) => query.cql)
			.filter((cql) => /\b(FROM|UPDATE) guilds\b/i.test(cql));
		vi.restoreAllMocks();
		expect(guildQueries.filter((cql) => /^SELECT/i.test(cql))).toHaveLength(1);
		expect(guildQueries.filter((cql) => /^UPDATE/i.test(cql))).toHaveLength(1);
		expect(await storedCounts(guildId)).toEqual({memberCount: 2, memberRows: 2});
	});

	test('does not recreate a deleted guild row when flushing its counter', async () => {
		const missingGuildId = '100000000000000001';
		await getKVCounterService().add(GUILD_MEMBER_COUNT_COUNTER, missingGuildId, 1);
		await flushCounters({}, helpers);
		expect(await new GuildRepository().findUnique(createGuildID(BigInt(missingGuildId)))).toBeNull();
	});

	test('never admits more members than the limit under a join storm', async () => {
		const memberLimit = 60;
		const limitConfigService = getLimitConfigService();
		const snapshot = limitConfigService.getConfigSnapshot();
		vi.spyOn(limitConfigService, 'getConfigSnapshot').mockReturnValue({
			...snapshot,
			rules: [...snapshot.rules, {id: 'test_member_cap', limits: {max_guild_members: memberLimit}}],
		});
		const users = await createAccounts(harness, 70);
		const joins = await Promise.all(users.map(async (user) => joinGuild(harness, user, inviteCode)));
		const accepted = joins.filter((response) => response.status === HTTP_STATUS.OK);
		const rejected = joins.filter((response) => response.status === HTTP_STATUS.BAD_REQUEST);
		expect(accepted).toHaveLength(memberLimit - 1);
		expect(rejected).toHaveLength(users.length - (memberLimit - 1));
		for (const response of rejected) {
			expect(((await response.json()) as {code: string}).code).toBe(APIErrorCodes.MAX_GUILD_MEMBERS);
		}
		expect(await storedCounts(guildId)).toEqual({memberCount: memberLimit, memberRows: memberLimit});
	});
});
