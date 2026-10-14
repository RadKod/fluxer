// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {getKVClient, setInjectedWorkerService} from '@app/api/middleware/ServiceRegistry';
import {
	getPremiumLedgerRepository,
	getPremiumLedgerService,
	getUserCacheService,
	getUserRepository,
} from '@app/api/middleware/ServiceSingletons';
import {addGiftCodeDuration} from '@app/api/models/GiftCode';
import type {User} from '@app/api/models/User';
import {PremiumLedgerRepository} from '@app/api/premium/ledger/PremiumLedgerRepository';
import {
	type PremiumGrant,
	premiumExpirationDay,
	premiumExpirationShard,
} from '@app/api/premium/ledger/PremiumLedgerService';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {NoopWorkerService} from '@app/api/test/NoopWorkerService';
import {UserRepository} from '@app/api/user/repositories/UserRepository';
import {checkIsPremium} from '@app/api/user/UserHelpers';
import ensureUserPremium from '@app/api/worker/tasks/EnsureUserPremium';
import {clearWorkerDependencies, setWorkerDependenciesForTest} from '@app/api/worker/WorkerContext';
import {ResourceLockedError} from '@fluxer/errors/src/domains/core/ResourceLockedError';
import type {IWorkerService} from '@pkgs/worker/src/contracts/IWorkerService';
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

const NOW = new Date('2026-10-15T12:00:00.000Z');

describe('PremiumLedgerService', () => {
	let harness: ApiTestHarness;
	let worker: RecordingWorkerService;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
		worker = new RecordingWorkerService();
		setInjectedWorkerService(worker);
		setWorkerDependenciesForTest({
			kvClient: getKVClient(),
			userRepository: getUserRepository(),
			userCacheService: getUserCacheService(),
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

	async function createUser(): Promise<UserID> {
		const account = await createTestAccount(harness);
		vi.useFakeTimers({toFake: ['Date']});
		vi.setSystemTime(NOW);
		return createUserID(BigInt(account.userId));
	}

	async function readUser(userId: UserID): Promise<User> {
		return (await getUserRepository().findUnique(userId))!;
	}

	function months(
		userId: UserID,
		grantKey: string,
		quantity = 1,
		source: PremiumGrant['source'] = 'payriff',
	): PremiumGrant {
		return {userId, grantKey, duration: {unit: 'months', quantity}, source};
	}

	function trial(userId: UserID): PremiumGrant {
		return {userId, grantKey: 'trial', duration: {unit: 'days', quantity: 7}, source: 'trial'};
	}

	async function runQueued(taskType: string): Promise<void> {
		for (const job of worker.jobs.splice(0).filter((queued) => queued.taskType === taskType)) {
			await ensureUserPremium(job.payload, {
				logger: new NoopLogger(),
				jobId: 1n,
				addJob: async () => 0n,
				reportProgress: async () => {},
				shouldCancel: async () => false,
				setContextLink: async () => {},
			});
		}
	}

	it('applies a repeated grant key once', async () => {
		const userId = await createUser();
		const ledger = getPremiumLedgerService();
		const oneMonth = addGiftCodeDuration(NOW, 'months', 1)!;

		const first = await ledger.grant(months(userId, 'order-1:premium'));
		const second = await ledger.grant(months(userId, 'order-1:premium'));

		expect(first).toEqual({paidUntil: oneMonth, newlyApplied: true});
		expect(second).toEqual({paidUntil: oneMonth, newlyApplied: false});
		const user = await readUser(userId);
		expect(user.premiumGiftExtensionEndsAt).toEqual(oneMonth);
		expect(checkIsPremium(user)).toBe(true);
	});

	it('adds up two different grant keys applied concurrently', async () => {
		const userId = await createUser();
		const ledger = getPremiumLedgerService();
		const twoMonths = addGiftCodeDuration(addGiftCodeDuration(NOW, 'months', 1)!, 'months', 1)!;

		await Promise.allSettled([
			ledger.grant(months(userId, 'order-1:premium')),
			ledger.grant(months(userId, 'order-2:premium')),
		]);
		await runQueued('ensureUserPremium');

		const row = await getPremiumLedgerRepository().find(userId);
		expect(row?.paid_until).toEqual(twoMonths);
		expect([...(row?.applied_grants?.keys() ?? [])].sort()).toEqual([
			'payriff:order-1:premium',
			'payriff:order-2:premium',
		]);
		expect((await readUser(userId)).premiumGiftExtensionEndsAt).toEqual(twoMonths);
	});

	it('answers a grant whose user write failed after its ledger write and repairs it', async () => {
		const userId = await createUser();
		const ledger = getPremiumLedgerService();
		const oneMonth = addGiftCodeDuration(NOW, 'months', 1)!;
		vi.spyOn(UserRepository.prototype, 'patchUpsert').mockRejectedValueOnce(new Error('user write lost'));

		await expect(ledger.grant(months(userId, 'order-1:premium'))).resolves.toEqual({
			paidUntil: oneMonth,
			newlyApplied: true,
		});
		expect(checkIsPremium(await readUser(userId))).toBe(false);
		expect(
			await getPremiumLedgerRepository().listExpirations(
				premiumExpirationDay(oneMonth),
				premiumExpirationShard(userId),
				10,
			),
		).toEqual([{day: premiumExpirationDay(oneMonth), shard: premiumExpirationShard(userId), user_id: userId}]);
		await runQueued('ensureUserPremium');
		expect((await readUser(userId)).premiumGiftExtensionEndsAt).toEqual(oneMonth);
		const retry = await ledger.grant(months(userId, 'order-1:premium'));

		expect(retry).toEqual({paidUntil: oneMonth, newlyApplied: false});
		expect((await getPremiumLedgerRepository().find(userId))?.paid_until).toEqual(oneMonth);
		expect((await readUser(userId)).premiumGiftExtensionEndsAt).toEqual(oneMonth);
	});

	it('answers a grant whose user lock is held and leaves the user write to the queued repair', async () => {
		const userId = await createUser();
		const ledger = getPremiumLedgerService();
		const oneMonth = addGiftCodeDuration(NOW, 'months', 1)!;
		const lockKey = `premium:grant:${userId}`;
		await getKVClient().acquireLock(lockKey, 'other-holder', 30);

		await expect(ledger.ensureUserPremium(userId)).rejects.toBeInstanceOf(ResourceLockedError);
		await expect(ledger.grant(months(userId, 'order-1:premium'))).resolves.toEqual({
			paidUntil: oneMonth,
			newlyApplied: true,
		});
		expect(checkIsPremium(await readUser(userId))).toBe(false);
		await getKVClient().releaseLock(lockKey, 'other-holder');
		await runQueued('ensureUserPremium');

		expect((await readUser(userId)).premiumGiftExtensionEndsAt).toEqual(oneMonth);
	});

	it('repairs a grant whose ledger write landed but whose reply was lost', async () => {
		const userId = await createUser();
		const ledger = getPremiumLedgerService();
		const oneMonth = addGiftCodeDuration(NOW, 'months', 1)!;
		const create = PremiumLedgerRepository.prototype.create;
		vi.spyOn(PremiumLedgerRepository.prototype, 'create').mockImplementationOnce(async function (
			this: PremiumLedgerRepository,
			row,
		) {
			await create.call(this, row);
			throw new Error('connection reset after write');
		});

		await expect(ledger.grant(months(userId, 'order-1:premium'))).rejects.toThrow('connection reset after write');
		expect(checkIsPremium(await readUser(userId))).toBe(false);
		await runQueued('ensureUserPremium');

		expect((await readUser(userId)).premiumGiftExtensionEndsAt).toEqual(oneMonth);
		expect(
			await getPremiumLedgerRepository().listExpirations(
				premiumExpirationDay(oneMonth),
				premiumExpirationShard(userId),
				10,
			),
		).toHaveLength(1);
	});

	it('treats only a trial-sourced grant as the trial', async () => {
		const userId = await createUser();
		const ledger = getPremiumLedgerService();

		await ledger.grant({userId, grantKey: 'trial', duration: {unit: 'months', quantity: 1}, source: 'gift'});

		const row = (await getPremiumLedgerRepository().find(userId))!;
		expect(row.trial_used_at).toBeNull();
		expect(row.applied_grants?.has('gift:trial')).toBe(true);
		expect((await ledger.grant(trial(userId))).newlyApplied).toBe(true);
	});

	it('writes nothing to the ledger when indexing the expiration fails, so the retry applies the grant', async () => {
		const userId = await createUser();
		const ledger = getPremiumLedgerService();
		const oneMonth = addGiftCodeDuration(NOW, 'months', 1)!;
		vi.spyOn(PremiumLedgerRepository.prototype, 'addExpiration').mockRejectedValueOnce(new Error('index write lost'));

		await expect(ledger.grant(months(userId, 'order-1:premium'))).rejects.toThrow('index write lost');
		expect(checkIsPremium(await readUser(userId))).toBe(false);
		expect(await getPremiumLedgerRepository().find(userId)).toBeNull();
		const retry = await ledger.grant(months(userId, 'order-1:premium'));

		expect(retry).toEqual({paidUntil: oneMonth, newlyApplied: true});
		expect((await readUser(userId)).premiumGiftExtensionEndsAt).toEqual(oneMonth);
		expect(
			await getPremiumLedgerRepository().listExpirations(
				premiumExpirationDay(oneMonth),
				premiumExpirationShard(userId),
				10,
			),
		).toHaveLength(1);
	});

	it('stacks a grant on top of a gift extension that ends after the ledger', async () => {
		const userId = await createUser();
		const ledger = getPremiumLedgerService();
		await ledger.grant(months(userId, 'order-1:premium'));
		const giftEnd = new Date(NOW.getTime() + ms('60 days'));
		await getUserRepository().patchUpsert(userId, {
			premium_gift_extension_ends_at: giftEnd,
			premium_grace_ends_at: null,
		});

		const {paidUntil} = await ledger.grant(months(userId, 'order-2:premium'));

		expect(paidUntil).toEqual(addGiftCodeDuration(giftEnd, 'months', 1));
		expect((await readUser(userId)).premiumGiftExtensionEndsAt).toEqual(paidUntil);
	});

	it('keeps the newest 200 grant keys and never forgets the trial', async () => {
		const userId = await createUser();
		const ledger = getPremiumLedgerService();
		await ledger.grant(trial(userId));
		for (let i = 0; i < 250; i++) {
			vi.setSystemTime(NOW.getTime() + i + 1);
			await ledger.grant({
				userId,
				grantKey: `order-${i}:premium`,
				duration: {unit: 'days', quantity: 1},
				source: 'admin',
			});
		}

		const row = (await getPremiumLedgerRepository().find(userId))!;
		expect(row.applied_grants?.size).toBe(200);
		expect(row.applied_grants?.has('admin:order-49:premium')).toBe(false);
		expect(row.applied_grants?.has('admin:order-50:premium')).toBe(true);
		expect(row.applied_grants?.has('admin:order-249:premium')).toBe(true);
		expect(row.trial_used_at).toEqual(NOW);
		const again = await ledger.grant(trial(userId));
		expect(again).toEqual({paidUntil: row.paid_until, newlyApplied: false});
	});

	it('marks only paid grants as a purchase', async () => {
		const buyerId = await createUser();
		const giftedId = await createUser();
		const ledger = getPremiumLedgerService();

		await ledger.grant(months(buyerId, 'order-1:premium', 1, 'payriff'));
		await ledger.grant(months(giftedId, 'support-1', 1, 'admin'));

		expect((await readUser(buyerId)).hasEverPurchased).toBe(true);
		expect((await readUser(giftedId)).hasEverPurchased).toBeFalsy();
	});

	it('ends a trial exactly seven days later without a grace period', async () => {
		const userId = await createUser();
		await getPremiumLedgerService().grant(trial(userId));

		vi.setSystemTime(NOW.getTime() + ms('7 days') - 1000);
		expect(checkIsPremium(await readUser(userId))).toBe(true);
		vi.setSystemTime(NOW.getTime() + ms('7 days') + 1000);
		expect(checkIsPremium(await readUser(userId))).toBe(false);
	});
});
