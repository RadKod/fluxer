// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createGuildID} from '@app/api/BrandedTypes';
import {GuildRepository} from '@app/api/guild/repositories/GuildRepository';
import {createGuild} from '@app/api/guild/tests/GuildTestUtils';
import {GUILD_MEMBER_COUNT_COUNTER} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {NoopWorkerService} from '@app/api/test/NoopWorkerService';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import flushCounters from '@app/api/worker/tasks/FlushCounters';
import rebuildCounter from '@app/api/worker/tasks/RebuildCounter';
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

interface RpcGuildCollectionResponse {
	type: 'guild_collection';
	data: {
		collection: 'guild';
		guild: {
			id: string;
		};
	};
}

async function loadGuildOverRpc(harness: ApiTestHarness, guildId: string): Promise<RpcGuildCollectionResponse> {
	return await createBuilder<RpcGuildCollectionResponse>(harness, '')
		.post('/test/rpc-session-init')
		.body({type: 'guild_collection', guild_id: guildId, collection: 'guild'})
		.expect(HTTP_STATUS.OK)
		.execute();
}

async function setGuildMemberCount(harness: ApiTestHarness, guildId: string, memberCount: number): Promise<void> {
	await createBuilder(harness, '')
		.post(`/test/guilds/${guildId}/member-count`)
		.body({member_count: memberCount})
		.expect(HTTP_STATUS.OK)
		.execute();
}

interface QueuedJob {
	taskType: string;
	payload: WorkerJobPayload;
}

function captureQueuedJobs(): Array<QueuedJob> {
	const jobs: Array<QueuedJob> = [];
	vi.spyOn(NoopWorkerService.prototype as IWorkerService, 'addJob').mockImplementation(async (taskType, payload) => {
		jobs.push({taskType, payload});
		return 0n;
	});
	return jobs;
}

async function runQueuedRecounts(jobs: Array<QueuedJob>): Promise<void> {
	for (const job of jobs.filter(({taskType}) => taskType === 'rebuildCounter')) {
		await rebuildCounter(job.payload, helpers);
	}
}

describe('RpcService guild member count repair', () => {
	let harness: ApiTestHarness;
	beforeEach(async () => {
		harness = await createApiTestHarness();
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await harness?.shutdown();
	});
	test('repairs guild member_count from guild_members count when fetching guild data', async () => {
		const jobs = captureQueuedJobs();
		const owner = await createTestAccount(harness);
		const guild = await createGuild(harness, owner.token, 'RPC Guild Member Count Repair');
		const guildId = createGuildID(BigInt(guild.id));
		const guildRepository = new GuildRepository();
		await setGuildMemberCount(harness, guild.id, 999);
		const staleGuild = await guildRepository.findUnique(guildId);
		expect(staleGuild).toBeTruthy();
		if (!staleGuild) {
			throw new Error('Expected guild to exist before RPC member_count repair');
		}
		expect(staleGuild.memberCount).toBe(999);
		const rpcResponse = await createBuilder<RpcGuildCollectionResponse>(harness, '')
			.post('/test/rpc-session-init')
			.body({
				type: 'guild_collection',
				guild_id: guild.id,
				collection: 'guild',
			})
			.expect(HTTP_STATUS.OK)
			.execute();
		expect(rpcResponse.type).toBe('guild_collection');
		expect(rpcResponse.data.collection).toBe('guild');
		expect(rpcResponse.data.guild.id).toBe(guild.id);
		// Micup: the guild load only queues the recount (a full member partition read has no place on the request
		// path); the recount repairs through the KV counter and the counter flush carries it to Cassandra.
		await vi.waitFor(() => expect(jobs.some(({taskType}) => taskType === 'rebuildCounter')).toBe(true));
		await runQueuedRecounts(jobs);
		await flushCounters({}, helpers);
		const repairedGuild = await guildRepository.findUnique(guildId);
		expect(repairedGuild).toBeTruthy();
		if (!repairedGuild) {
			throw new Error('Expected guild to exist after RPC member_count repair');
		}
		const actualMemberCount = await guildRepository.countMembers(guildId);
		expect(actualMemberCount).toBe(1);
		expect(repairedGuild.memberCount).toBe(actualMemberCount);
	});

	test('leaves the stored count to the counter flush instead of writing it on the guild load', async () => {
		captureQueuedJobs();
		const owner = await createTestAccount(harness);
		const guild = await createGuild(harness, owner.token, 'RPC Guild Member Count Load Write');
		await setGuildMemberCount(harness, guild.id, 999);

		await loadGuildOverRpc(harness, guild.id);

		const stored = await new GuildRepository().findUnique(createGuildID(BigInt(guild.id)));
		expect(stored?.memberCount).toBe(999);
	});

	test('loads the guild without counting its members and queues one recount per guild per day', async () => {
		const jobs = captureQueuedJobs();
		const owner = await createTestAccount(harness);
		const guild = await createGuild(harness, owner.token, 'RPC Guild Member Count Recount Queue');
		const countMembers = vi.spyOn(GuildRepository.prototype, 'countMembers');

		await loadGuildOverRpc(harness, guild.id);
		await loadGuildOverRpc(harness, guild.id);

		expect(countMembers).not.toHaveBeenCalled();
		const recount = {taskType: 'rebuildCounter', payload: {namespace: GUILD_MEMBER_COUNT_COUNTER, id: guild.id}};
		await vi.waitFor(() => expect(jobs).toContainEqual(recount));
		await loadGuildOverRpc(harness, guild.id);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(jobs.filter(({taskType}) => taskType === 'rebuildCounter')).toEqual([recount]);
	});
});
