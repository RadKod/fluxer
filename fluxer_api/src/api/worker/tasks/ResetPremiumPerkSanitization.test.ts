// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createGuildID, createUserID} from '@app/api/BrandedTypes';
import {createTestGuild} from '@app/api/emoji/tests/EmojiTestUtils';
import {GuildRepository} from '@app/api/guild/repositories/GuildRepository';
import {getMember} from '@app/api/guild/tests/GuildTestUtils';
import {
	getGatewayService,
	getKVClient,
	getWorkerService,
	setInjectedWorkerService,
} from '@app/api/middleware/ServiceRegistry';
import {
	getGuildRepository,
	getPremiumLedgerService,
	getPremiumStateReconciliationQueueService,
	getUserCacheService,
	getUserRepository,
} from '@app/api/middleware/ServiceSingletons';
import {createTestStoreEntitlementService} from '@app/api/store_billing/tests/StoreBillingTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {NoopGatewayService} from '@app/api/test/NoopGatewayService';
import {NoopWorkerService} from '@app/api/test/NoopWorkerService';
import {SyncTaskWorkerService} from '@app/api/test/SyncTaskWorkerService';
import processPremiumExpirations from '@app/api/worker/tasks/ProcessPremiumExpirations';
import propagatePartialUserChange from '@app/api/worker/tasks/PropagatePartialUserChange';
import resetPremiumPerkSanitization from '@app/api/worker/tasks/ResetPremiumPerkSanitization';
import {clearWorkerDependencies, setWorkerDependenciesForTest} from '@app/api/worker/WorkerContext';
import type {GuildMemberResponse} from '@fluxer/schema/src/domains/guild/GuildMemberSchemas';
import type {IWorkerService} from '@pkgs/worker/src/contracts/IWorkerService';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import type {WorkerJobOptions, WorkerJobPayload} from '@pkgs/worker/src/contracts/WorkerTypes';
import {ms} from 'itty-time';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

class RecordingWorkerService extends NoopWorkerService implements IWorkerService {
	readonly jobs: Array<{taskType: string; payload: WorkerJobPayload; options?: WorkerJobOptions}> = [];

	override async addJob(taskType?: string, payload?: WorkerJobPayload, options?: WorkerJobOptions): Promise<bigint> {
		this.jobs.push({taskType: taskType!, payload: payload!, options});
		return 0n;
	}
}

const GUILD_AVATAR = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const HELPERS: WorkerTaskHelpers = {
	logger: new NoopLogger(),
	jobId: 1n,
	addJob: async () => 0n,
	reportProgress: async () => {},
	shouldCancel: async () => false,
	setContextLink: async () => {},
};

describe('resetPremiumPerkSanitization', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
		setWorkerDependenciesForTest({
			kvClient: getKVClient(),
			storeEntitlementService: createTestStoreEntitlementService(),
			workerService: getWorkerService(),
			userRepository: getUserRepository(),
			guildRepository: getGuildRepository(),
			userCacheService: getUserCacheService(),
			gatewayService: getGatewayService(),
			premiumStateReconciliationQueueService: getPremiumStateReconciliationQueueService(),
		});
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		clearWorkerDependencies();
		setInjectedWorkerService(new NoopWorkerService());
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	it('brings guild perks back when an expired trial user buys premium', async () => {
		// Micup: premium starting and ending queue a partial user propagation (premium badge), so those jobs run here
		// instead of being dropped with their queued marker left behind.
		setInjectedWorkerService(new SyncTaskWorkerService({propagatePartialUserChange}));
		const account = await createTestAccount(harness);
		const guild = await createTestGuild(harness, account.token);
		const userId = createUserID(BigInt(account.userId));
		const guildId = createGuildID(BigInt(guild.id));
		const member = (await getGuildRepository().getMember(guildId, userId))!;
		await getGuildRepository().upsertMember({...member.toRow(), avatar_hash: GUILD_AVATAR});
		const startedAt = Date.now();
		vi.useFakeTimers({toFake: ['Date']});
		vi.setSystemTime(startedAt);
		await getPremiumLedgerService().grant({
			userId,
			grantKey: 'trial',
			duration: {unit: 'days', quantity: 7},
			source: 'trial',
		});
		vi.setSystemTime(startedAt + ms('7 days') + 1000);
		await processPremiumExpirations({}, HELPERS);
		vi.useRealTimers();
		expect((await getMember(harness, account.token, guild.id, account.userId)).avatar).toBeNull();

		const worker = new RecordingWorkerService();
		setInjectedWorkerService(worker);
		await getPremiumLedgerService().grant({
			userId,
			grantKey: 'order-1:premium',
			duration: {unit: 'months', quantity: 1},
			source: 'payriff',
		});
		const reset = worker.jobs.find((job) => job.taskType === 'resetPremiumPerkSanitization');
		expect(reset?.payload).toEqual({userId: account.userId});
		setInjectedWorkerService(new SyncTaskWorkerService({propagatePartialUserChange}));
		// Micup: the grant's own propagation runs first (worst order on the lane), so the event checked below can only come
		// from the reset task's propagation.
		for (const job of worker.jobs.filter((queued) => queued.taskType === 'propagatePartialUserChange')) {
			await propagatePartialUserChange(job.payload, HELPERS);
		}
		const dispatchGuild = vi.spyOn(NoopGatewayService.prototype, 'dispatchGuild');
		await resetPremiumPerkSanitization(reset!.payload, HELPERS);

		expect((await getMember(harness, account.token, guild.id, account.userId)).avatar).toBe(GUILD_AVATAR);
		const updates = dispatchGuild.mock.calls
			.map(([params]) => params as unknown as {guildId: GuildIdLike; event: string; data: GuildMemberResponse})
			.filter((params) => params.event === 'GUILD_MEMBER_UPDATE' && params.guildId.toString() === guild.id);
		expect(updates.map((update) => update.data.avatar)).toEqual([GUILD_AVATAR]);
	});

	it('clears only the sanitized flag and keeps a nickname changed while it runs', async () => {
		const account = await createTestAccount(harness);
		const guild = await createTestGuild(harness, account.token);
		const userId = createUserID(BigInt(account.userId));
		const guildId = createGuildID(BigInt(guild.id));
		const member = (await getGuildRepository().getMember(guildId, userId))!;
		await getGuildRepository().upsertMember({...member.toRow(), avatar_hash: GUILD_AVATAR, is_premium_sanitized: true});
		await getPremiumLedgerService().grant({
			userId,
			grantKey: 'order-1:premium',
			duration: {unit: 'months', quantity: 1},
			source: 'payriff',
		});
		const getMemberOriginal = GuildRepository.prototype.getMember;
		vi.spyOn(GuildRepository.prototype, 'getMember').mockImplementation(async function (
			this: GuildRepository,
			...args
		) {
			const read = await getMemberOriginal.apply(this, args);
			if (read) {
				await getMemberOriginal
					.call(this, ...args)
					.then((fresh) => getGuildRepository().upsertMember({...fresh!.toRow(), nick: 'renamed meanwhile'}));
			}
			return read;
		});

		await resetPremiumPerkSanitization({userId: account.userId}, HELPERS);
		vi.restoreAllMocks();

		const stored = (await getGuildRepository().getMember(guildId, userId))!;
		expect(stored.isPremiumSanitized).toBe(false);
		expect(stored.nickname).toBe('renamed meanwhile');
		expect(stored.avatarHash).toBe(GUILD_AVATAR);
	});
});

interface GuildIdLike {
	toString(): string;
}
