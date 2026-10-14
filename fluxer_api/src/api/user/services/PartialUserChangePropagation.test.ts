// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createTestGuild, getPngDataUrl} from '@app/api/emoji/tests/EmojiTestUtils';
import {getGatewayService} from '@app/api/middleware/ServiceRegistry';
import {getGuildRepository, getUserCacheService, getUserRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopGatewayService} from '@app/api/test/NoopGatewayService';
import {NoopWorkerService} from '@app/api/test/NoopWorkerService';
import {SyncTaskWorkerService} from '@app/api/test/SyncTaskWorkerService';
import {updateAvatar, updateUserProfile} from '@app/api/user/tests/UserTestUtils';
import propagatePartialUserChange from '@app/api/worker/tasks/PropagatePartialUserChange';
import {clearWorkerDependencies, setWorkerDependenciesForTest} from '@app/api/worker/WorkerContext';
import type {GuildMemberResponse} from '@fluxer/schema/src/domains/guild/GuildMemberSchemas';
import type {IWorkerService} from '@pkgs/worker/src/contracts/IWorkerService';
import type {WorkerJobPayload} from '@pkgs/worker/src/contracts/WorkerTypes';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type MockInstance, vi} from 'vitest';

const TASK = 'propagatePartialUserChange';

interface MemberUpdate {
	guildId: string;
	user: GuildMemberResponse['user'];
}

describe('partial user change propagation runs in a worker task', () => {
	let harness: ApiTestHarness;
	let dispatchGuild: MockInstance<NoopGatewayService['dispatchGuild']>;
	let queuedJobs: Array<WorkerJobPayload>;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	beforeEach(async () => {
		await harness.reset();
		queuedJobs = [];
		vi.spyOn(NoopWorkerService.prototype as IWorkerService, 'addJob').mockImplementation(async (taskType, payload) => {
			if (taskType === TASK) queuedJobs.push(payload);
			return 0n;
		});
		dispatchGuild = vi.spyOn(NoopGatewayService.prototype, 'dispatchGuild');
		setWorkerDependenciesForTest({
			kvClient: harness.kvProvider,
			userRepository: getUserRepository(),
			guildRepository: getGuildRepository(),
			userCacheService: getUserCacheService(),
			gatewayService: getGatewayService(),
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		clearWorkerDependencies();
	});

	afterAll(async () => {
		await harness?.shutdown();
	});

	function memberUpdates(): Array<MemberUpdate> {
		return dispatchGuild.mock.calls
			.map(([params]) => params)
			.filter((params) => params.event === 'GUILD_MEMBER_UPDATE')
			.map((params) => ({
				guildId: params.guildId.toString(),
				user: (params.data as GuildMemberResponse).user,
			}));
	}

	function latestPerGuild(): Map<string, MemberUpdate['user']> {
		const latest = new Map<string, MemberUpdate['user']>();
		for (const update of memberUpdates()) latest.set(update.guildId, update.user);
		return latest;
	}

	async function runQueuedJobs(): Promise<number> {
		const runner = new SyncTaskWorkerService({[TASK]: propagatePartialUserChange});
		let ran = 0;
		while (queuedJobs.length > 0) {
			await runner.addJob(TASK, queuedJobs.shift()!);
			ran++;
		}
		return ran;
	}

	async function accountInGuilds(count: number): Promise<{account: TestAccount; guildIds: Array<string>}> {
		const account = await createTestAccount(harness);
		const guildIds: Array<string> = [];
		for (let i = 0; i < count; i++) {
			guildIds.push((await createTestGuild(harness, account.token)).id);
		}
		dispatchGuild.mockClear();
		return {account, guildIds};
	}

	it('dispatches nothing on the request path and pushes the current avatar to all 50 guilds from the task', async () => {
		const {account, guildIds} = await accountInGuilds(50);

		const updated = await updateAvatar(harness, account.token, getPngDataUrl());

		expect(updated.avatar).toBeTruthy();
		expect(memberUpdates()).toHaveLength(0);
		expect(queuedJobs).toEqual([{userId: account.userId}]);

		await runQueuedJobs();

		const updates = memberUpdates();
		expect(updates).toHaveLength(50);
		expect(new Set(updates.map((update) => update.guildId))).toEqual(new Set(guildIds));
		for (const update of updates) {
			expect(update.user.id).toBe(account.userId);
			expect(update.user.avatar).toBe(updated.avatar);
		}
	});

	it('coalesces three rapid changes into at most two tasks that deliver the last value', async () => {
		const {account, guildIds} = await accountInGuilds(3);

		for (const name of ['first', 'second', 'third']) {
			await updateUserProfile(harness, account.token, {global_name: name});
		}

		expect(memberUpdates()).toHaveLength(0);
		expect(queuedJobs.length).toBeGreaterThanOrEqual(1);
		expect(queuedJobs.length).toBeLessThanOrEqual(2);
		await runQueuedJobs();
		const latest = latestPerGuild();
		expect([...latest.keys()].sort()).toEqual([...guildIds].sort());
		for (const user of latest.values()) expect(user.global_name).toBe('third');
	});

	it('still propagates a change that lands after the task read the user', async () => {
		const {account, guildIds} = await accountInGuilds(3);
		await updateUserProfile(harness, account.token, {global_name: 'before-read'});
		const userRepository = getUserRepository();
		const findUnique = userRepository.findUnique.bind(userRepository);
		vi.spyOn(userRepository, 'findUnique').mockImplementationOnce(async (userId) => {
			const snapshot = await findUnique(userId);
			await updateUserProfile(harness, account.token, {global_name: 'after-read'});
			return snapshot;
		});

		const ran = await runQueuedJobs();

		expect(ran).toBe(2);
		const latest = latestPerGuild();
		expect([...latest.keys()].sort()).toEqual([...guildIds].sort());
		for (const user of latest.values()) expect(user.global_name).toBe('after-read');
	});

	it('serializes overlapping tasks for one user so every guild ends on the newest value while the blocked task returns quietly', async () => {
		const {account, guildIds} = await accountInGuilds(3);
		await updateUserProfile(harness, account.token, {global_name: 'old'});
		const runner = new SyncTaskWorkerService({[TASK]: propagatePartialUserChange});
		const userRepository = getUserRepository();
		const findUnique = userRepository.findUnique.bind(userRepository);
		let blocked: unknown = null;
		vi.spyOn(userRepository, 'findUnique').mockImplementationOnce(async (userId) => {
			const snapshot = await findUnique(userId);
			await updateUserProfile(harness, account.token, {global_name: 'new'});
			await runner.addJob(TASK, queuedJobs.shift()!).catch((error: unknown) => {
				blocked = error;
			});
			return snapshot;
		});

		await runQueuedJobs();

		expect(blocked).toBeNull();
		const latest = latestPerGuild();
		expect([...latest.keys()].sort()).toEqual([...guildIds].sort());
		for (const user of latest.values()) expect(user.global_name).toBe('new');
	});

	it('keeps the change pending when dispatch fails midway so a retry reaches every guild', async () => {
		const {account, guildIds} = await accountInGuilds(10);
		const updated = await updateAvatar(harness, account.token, getPngDataUrl());
		const [job] = queuedJobs;
		dispatchGuild.mockImplementationOnce(async () => {}).mockRejectedValueOnce(new Error('gateway unavailable'));

		await expect(runQueuedJobs()).rejects.toThrow('gateway unavailable');
		dispatchGuild.mockClear();
		queuedJobs.push(job!);
		await runQueuedJobs();

		const latest = latestPerGuild();
		expect([...latest.keys()].sort()).toEqual([...guildIds].sort());
		for (const user of latest.values()) expect(user.avatar).toBe(updated.avatar);
	});
});
