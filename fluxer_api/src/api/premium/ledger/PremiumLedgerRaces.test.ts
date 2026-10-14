// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createGuildID, createUserID, type GuildID, type UserID} from '@app/api/BrandedTypes';
import type {UserRow} from '@app/api/database/types/UserTypes';
import {createTestGuild} from '@app/api/emoji/tests/EmojiTestUtils';
import {createRequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import {
	getGatewayService,
	getKVClient,
	getWorkerService,
	setInjectedWorkerService,
} from '@app/api/middleware/ServiceRegistry';
import {
	getCosmeticRepository,
	getCosmeticService,
	getDiscriminatorService,
	getGuildRepository,
	getInstanceConfigRepository,
	getPremiumLedgerService,
	getPremiumStateReconciliationQueueService,
	getUserCacheService,
	getUserRepository,
	getVisionaryRepository,
} from '@app/api/middleware/ServiceSingletons';
import {addGiftCodeDuration} from '@app/api/models/GiftCode';
import type {User} from '@app/api/models/User';
import type {PremiumGrant, PremiumLedgerService} from '@app/api/premium/ledger/PremiumLedgerService';
import {VisionaryService} from '@app/api/premium/visionary/VisionaryService';
import {RpcSessionStartService} from '@app/api/rpc/RpcSessionStartService';
import {createTestStoreEntitlementService} from '@app/api/store_billing/tests/StoreBillingTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {NoopWorkerService} from '@app/api/test/NoopWorkerService';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {UserRepository} from '@app/api/user/repositories/UserRepository';
import {checkIsPremium, createPremiumClearPatch} from '@app/api/user/UserHelpers';
import ensureUserPremium from '@app/api/worker/tasks/EnsureUserPremium';
import {processUser} from '@app/api/worker/tasks/ProcessExpiredPremiumSweep';
import processPremiumExpirations from '@app/api/worker/tasks/ProcessPremiumExpirations';
import resetPremiumPerkSanitization from '@app/api/worker/tasks/ResetPremiumPerkSanitization';
import {
	clearWorkerDependencies,
	getWorkerDependencies,
	setWorkerDependenciesForTest,
} from '@app/api/worker/WorkerContext';
import {UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import type {UserProfileFullResponse} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
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

const NOW = new Date('2026-10-15T12:00:00.000Z');
const HELPERS: WorkerTaskHelpers = {
	logger: new NoopLogger(),
	jobId: 1n,
	addJob: async () => 0n,
	reportProgress: async () => {},
	shouldCancel: async () => false,
	setContextLink: async () => {},
};

describe('Premium ledger races with premium cleanup', () => {
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

	async function createUser(): Promise<UserID> {
		const account = await createTestAccount(harness);
		vi.useFakeTimers({toFake: ['Date']});
		vi.setSystemTime(NOW);
		return createUserID(BigInt(account.userId));
	}

	async function readUser(userId: UserID): Promise<User> {
		return (await getUserRepository().findUnique(userId))!;
	}

	// The getVisionaryService() singleton keeps the worker service of whichever test built it first (isolate: false);
	// this one queues into this test's recording worker.
	function visionary(): VisionaryService {
		return new VisionaryService({
			repository: getVisionaryRepository(),
			userRepository: getUserRepository(),
			userCacheService: getUserCacheService(),
			gatewayService: getGatewayService(),
			kvClient: getKVClient(),
			premiumLedgerService: getPremiumLedgerService(),
			cosmeticService: getCosmeticService(),
			cosmeticRepository: getCosmeticRepository(),
			instanceConfigRepository: getInstanceConfigRepository(),
		});
	}

	function grant(userId: UserID, grantKey: string, duration: PremiumGrant['duration']): PremiumGrant {
		return {userId, grantKey, duration, source: 'payriff'};
	}

	async function runQueuedRepairs(): Promise<void> {
		for (const job of worker.jobs.splice(0).filter((queued) => queued.taskType === 'ensureUserPremium')) {
			await ensureUserPremium(job.payload, HELPERS);
		}
	}

	async function runQueuedPremiumTasks(): Promise<void> {
		const handlers = {ensureUserPremium, resetPremiumPerkSanitization};
		for (let job = worker.jobs.shift(); job; job = worker.jobs.shift()) {
			if (Object.hasOwn(handlers, job.taskType)) {
				await handlers[job.taskType as keyof typeof handlers](job.payload, HELPERS);
			}
		}
	}

	// Runs the strip just before the ledger repair (or the given premium write) writes the user row it read, the way an
	// unlocked cleanup would land.
	function stripBeforeRepairWrite(
		strip: () => Promise<unknown>,
		isPremiumWrite = (patch: Partial<UserRow>) => patch.premium_grace_ends_at instanceof Date,
	): {stripped: () => boolean} {
		const patchUpsert = UserRepository.prototype.patchUpsert;
		let stripped = false;
		vi.spyOn(UserRepository.prototype, 'patchUpsert').mockImplementation(async function (
			this: UserRepository,
			...args
		) {
			if (!stripped && isPremiumWrite(args[1])) {
				stripped = true;
				await strip();
			}
			return patchUpsert.apply(this, args);
		});
		return {stripped: () => stripped};
	}

	function createSessionStart(premiumLedgerService: Pick<PremiumLedgerService, 'isActive' | 'ensureUserPremium'>) {
		return new RpcSessionStartService({
			userRepository: getUserRepository(),
			guildRepository: getGuildRepository(),
			userCacheService: getUserCacheService(),
			gatewayService: getGatewayService(),
			discriminatorService: getDiscriminatorService(),
			premiumLedgerService,
		});
	}

	async function startSession(service: RpcSessionStartService, user: User): Promise<User> {
		const result = await service.processSessionStart({
			userData: {
				user,
				settings: null,
				guildSettings: [],
				notes: new Map(),
				readStates: [],
				guildIds: [],
				privateChannels: [],
				relationships: [],
				favoriteMemes: [],
				pinnedDMs: [],
				webAuthnCredentials: [],
			},
			requestCache: createRequestCache(),
			geoipCountryIso: null,
			clientIp: null,
		});
		return result.user;
	}

	it('keeps premium when a renewal lands after the expiration job read its bucket', async () => {
		const userId = await createUser();
		const ledger = getPremiumLedgerService();
		await ledger.grant(grant(userId, 'order-1:premium', {unit: 'days', quantity: 1}));
		vi.setSystemTime(NOW.getTime() + ms('1 day') + 1000);
		const kv = getKVClient();
		const acquireLock = kv.acquireLock.bind(kv);
		let renewed = false;
		vi.spyOn(kv, 'acquireLock').mockImplementation(async (key, token, ttlSeconds) => {
			if (!renewed && key === `premium:grant:${userId}`) {
				renewed = true;
				await ledger.grant(grant(userId, 'order-2:premium', {unit: 'months', quantity: 1}));
			}
			return acquireLock(key, token, ttlSeconds);
		});

		await processPremiumExpirations({}, HELPERS);

		expect(renewed).toBe(true);
		const user = await readUser(userId);
		expect(checkIsPremium(user)).toBe(true);
		expect(user.premiumGiftExtensionEndsAt).toEqual(addGiftCodeDuration(new Date(Date.now()), 'months', 1));
	});

	it('ends with guild perks shown when a renewal lands during the expiration cleanup', async () => {
		const account = await createTestAccount(harness);
		const guild = await createTestGuild(harness, account.token);
		const userId = createUserID(BigInt(account.userId));
		const guildId = createGuildID(BigInt(guild.id));
		const member = (await getGuildRepository().getMember(guildId, userId))!;
		await getGuildRepository().upsertMember({...member.toRow(), avatar_hash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90'});
		vi.useFakeTimers({toFake: ['Date']});
		vi.setSystemTime(NOW);
		const ledger = getPremiumLedgerService();
		await ledger.grant(grant(userId, 'order-1:premium', {unit: 'days', quantity: 1}));
		vi.setSystemTime(NOW.getTime() + ms('1 day') + 1000);
		worker.jobs.splice(0);
		const patchUpsert = UserRepository.prototype.patchUpsert;
		let renewal: Promise<unknown> | null = null;
		vi.spyOn(UserRepository.prototype, 'patchUpsert').mockImplementation(async function (
			this: UserRepository,
			...args
		) {
			const updated = await patchUpsert.apply(this, args);
			if (!renewal && args[1].premium_type === null) {
				renewal = ledger.grant(grant(userId, 'order-2:premium', {unit: 'months', quantity: 1})).catch((error) => error);
				await renewal;
			}
			return updated;
		});

		await processPremiumExpirations({}, HELPERS);
		vi.restoreAllMocks();
		await runQueuedPremiumTasks();

		expect(renewal).not.toBeNull();
		expect(checkIsPremium(await readUser(userId))).toBe(true);
		expect((await getGuildRepository().getMember(guildId, userId))!.isPremiumSanitized).toBe(false);
	});

	it('restores premium with the delayed repair when a session start strip raced a renewal', async () => {
		const userId = await createUser();
		const ledger = getPremiumLedgerService();
		await ledger.grant(grant(userId, 'order-1:premium', {unit: 'days', quantity: 1}));
		vi.setSystemTime(NOW.getTime() + ms('1 day') + 1000);
		worker.jobs.splice(0);
		const staleLedger = {
			async isActive(id: UserID) {
				const active = await ledger.isActive(id);
				await ledger.grant(grant(userId, 'order-2:premium', {unit: 'months', quantity: 1}));
				return active;
			},
			ensureUserPremium: (id: UserID) => ledger.ensureUserPremium(id),
		};

		await startSession(createSessionStart(staleLedger), await readUser(userId));
		expect(checkIsPremium(await readUser(userId))).toBe(false);
		await runQueuedRepairs();

		expect(checkIsPremium(await readUser(userId))).toBe(true);
	});

	it('repairs wiped premium fields with the delayed task while the ledger is paid', async () => {
		const userId = await createUser();
		await getPremiumLedgerService().grant(grant(userId, 'order-1:premium', {unit: 'months', quantity: 1}));
		const repair = worker.jobs.find((job) => job.taskType === 'ensureUserPremium');
		expect(repair?.options?.runAt).toEqual(new Date(NOW.getTime() + ms('2 minutes')));
		await getUserRepository().patchUpsert(userId, createPremiumClearPatch(), (await readUser(userId)).toRow());
		expect(checkIsPremium(await readUser(userId))).toBe(false);

		vi.setSystemTime(NOW.getTime() + ms('2 minutes'));
		await runQueuedRepairs();

		expect(checkIsPremium(await readUser(userId))).toBe(true);
	});

	it('does not strip on session start while the ledger is paid and returns the repaired user', async () => {
		const userId = await createUser();
		const ledger = getPremiumLedgerService();
		const {paidUntil} = await ledger.grant(grant(userId, 'order-1:premium', {unit: 'months', quantity: 1}));
		const lapsedAt = new Date(NOW.getTime() - ms('10 days'));
		await getUserRepository().patchUpsert(userId, {
			premium_gift_extension_ends_at: lapsedAt,
			premium_grace_ends_at: lapsedAt,
		});

		const sessionUser = await startSession(createSessionStart(ledger), await readUser(userId));

		expect(checkIsPremium(sessionUser)).toBe(true);
		const stored = await readUser(userId);
		expect(stored.premiumGiftExtensionEndsAt).toEqual(paidUntil);
		expect(stored.premiumType).toBe(1);
	});

	it('keeps a renewal when a lapsed premium strip lands between the repair read and its write', async () => {
		const userId = await createUser();
		const ledger = getPremiumLedgerService();
		await ledger.grant(grant(userId, 'order-1:premium', {unit: 'days', quantity: 1}));
		vi.setSystemTime(NOW.getTime() + ms('1 day') + 1000);
		worker.jobs.splice(0);
		const race = stripBeforeRepairWrite(async () =>
			getUserRepository().patchUpsert(userId, createPremiumClearPatch(), (await readUser(userId)).toRow()),
		);

		const {paidUntil} = await ledger.grant(grant(userId, 'order-2:premium', {unit: 'months', quantity: 1}));
		vi.restoreAllMocks();
		await runQueuedRepairs();

		expect(race.stripped()).toBe(true);
		const user = await readUser(userId);
		expect(checkIsPremium(user)).toBe(true);
		expect(user.premiumType).toBe(1);
		expect(user.premiumSince).not.toBeNull();
		expect(user.premiumGiftExtensionEndsAt).toEqual(paidUntil);
	});

	it('keeps a renewal when a session start strip lands between the repair read and its write', async () => {
		const userId = await createUser();
		const ledger = getPremiumLedgerService();
		await ledger.grant(grant(userId, 'order-1:premium', {unit: 'days', quantity: 1}));
		vi.setSystemTime(NOW.getTime() + ms('1 day') + 1000);
		worker.jobs.splice(0);
		const lapsedUser = await readUser(userId);
		const ledgerReadBeforeRenewal = {
			isActive: async () => false,
			ensureUserPremium: (id: UserID) => ledger.ensureUserPremium(id),
		};
		const race = stripBeforeRepairWrite(() => startSession(createSessionStart(ledgerReadBeforeRenewal), lapsedUser));

		await ledger.grant(grant(userId, 'order-2:premium', {unit: 'months', quantity: 1}));
		vi.restoreAllMocks();
		await runQueuedRepairs();
		const sessionUser = await startSession(createSessionStart(ledger), await readUser(userId));

		expect(race.stripped()).toBe(true);
		expect(checkIsPremium(sessionUser)).toBe(true);
		expect(checkIsPremium(await readUser(userId))).toBe(true);
	});

	it('does not strip a profile while the ledger is paid and returns the repaired user', async () => {
		const account = await createTestAccount(harness);
		vi.useFakeTimers({toFake: ['Date']});
		vi.setSystemTime(NOW);
		const userId = createUserID(BigInt(account.userId));
		const {paidUntil} = await getPremiumLedgerService().grant(
			grant(userId, 'order-1:premium', {unit: 'months', quantity: 1}),
		);
		const lapsedAt = new Date(NOW.getTime() - ms('10 days'));
		await getUserRepository().patchUpsert(userId, {
			premium_gift_extension_ends_at: lapsedAt,
			premium_grace_ends_at: lapsedAt,
		});

		const profile = await createBuilder<UserProfileFullResponse>(harness, account.token)
			.get(`/users/${account.userId}/profile`)
			.execute();

		expect(profile.premium_type).toBe(1);
		const stored = await readUser(userId);
		expect(checkIsPremium(stored)).toBe(true);
		expect(stored.premiumGiftExtensionEndsAt).toEqual(paidUntil);
	});

	it('never fails a session start when the ledger check fails', async () => {
		const userId = await createUser();
		await getPremiumLedgerService().grant(grant(userId, 'order-1:premium', {unit: 'days', quantity: 1}));
		vi.setSystemTime(NOW.getTime() + ms('1 day') + 1000);
		const brokenLedger = {
			isActive: async () => {
				throw new Error('ledger unavailable');
			},
			ensureUserPremium: async () => {
				throw new Error('ledger unavailable');
			},
		};

		await expect(startSession(createSessionStart(brokenLedger), await readUser(userId))).resolves.toBeDefined();
		expect((await readUser(userId)).premiumType).toBe(1);
	});

	describe('Visionary', () => {
		// The account's premium lapsed and nobody stripped it yet; returns the row an unlocked strip reads now.
		async function lapsedUser(userId: UserID): Promise<User> {
			await getPremiumLedgerService().grant(grant(userId, 'order-1:premium', {unit: 'days', quantity: 1}));
			vi.setSystemTime(NOW.getTime() + ms('1 day') + 1000);
			await visionary().setTotal(1);
			worker.jobs.splice(0);
			return readUser(userId);
		}

		async function strip(lapsed: User): Promise<void> {
			await getUserRepository().patchUpsert(lapsed.id, createPremiumClearPatch(), lapsed.toRow());
		}

		it('writes the number back when a strip that read the lapsed account lands after the grant', async () => {
			const userId = await createUser();
			const lapsed = await lapsedUser(userId);

			await visionary().adminGrant(userId);
			await strip(lapsed);
			expect((await readUser(userId)).premiumType).toBeNull();
			const repair = worker.jobs.find((job) => job.taskType === 'ensureUserPremium');
			expect(repair?.options?.runAt).toEqual(new Date(Date.now() + ms('2 minutes')));
			await runQueuedRepairs();

			const user = await readUser(userId);
			expect([user.premiumType, user.premiumLifetimeSequence]).toEqual([UserPremiumTypes.LIFETIME, 1]);
			expect(checkIsPremium(user)).toBe(true);
		});

		it('does not write back a number that was taken back', async () => {
			const userId = await createUser();
			const lapsed = await lapsedUser(userId);
			await visionary().adminGrant(userId);
			// The take-back marks the number before it writes the account.
			const [slot] = await getVisionaryRepository().listSlots();
			expect(await getVisionaryRepository().claim(slot!, {held_until: new Date()})).toBe(true);

			await strip(lapsed);
			await runQueuedRepairs();

			expect((await readUser(userId)).premiumType).toBeNull();
		});

		it('does not write back a number another account holds', async () => {
			const userId = await createUser();
			const other = createUserID(BigInt((await createTestAccount(harness)).userId));
			await visionary().setTotal(1);
			await visionary().adminGrant(other);
			await getUserRepository().patchUpsert(userId, {premium_lifetime_sequence: 1}, (await readUser(userId)).toRow());

			await getPremiumLedgerService().ensureUserPremium(userId);

			expect((await readUser(userId)).premiumType).toBeNull();
		});
	});

	describe('guild perks a strip hid between a premium write read and the write', () => {
		async function lapsedGuildMember(): Promise<{userId: UserID; guildId: GuildID; lapsed: User}> {
			const account = await createTestAccount(harness);
			const guild = await createTestGuild(harness, account.token);
			const userId = createUserID(BigInt(account.userId));
			const guildId = createGuildID(BigInt(guild.id));
			const member = (await getGuildRepository().getMember(guildId, userId))!;
			await getGuildRepository().upsertMember({...member.toRow(), avatar_hash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90'});
			vi.useFakeTimers({toFake: ['Date']});
			vi.setSystemTime(NOW);
			await getPremiumLedgerService().grant(grant(userId, 'order-1:premium', {unit: 'days', quantity: 1}));
			vi.setSystemTime(NOW.getTime() + ms('1 day') + 1000);
			await visionary().setTotal(1);
			worker.jobs.splice(0);
			return {userId, guildId, lapsed: await readUser(userId)};
		}

		// The expiration sweep: clears premium from its read, hides the guild perks and sets PERKS_SANITIZED.
		function sweep(lapsed: User): () => Promise<void> {
			const result = {
				processed: 0,
				stripped: 0,
				sanitized: 0,
				reconcileEnqueued: 0,
				storeRefreshEnqueued: 0,
				skipped: 0,
				failed: 0,
			};
			return () => processUser(lapsed, getWorkerDependencies(), result);
		}

		async function isSanitized(guildId: GuildID, userId: UserID): Promise<boolean> {
			return (await getGuildRepository().getMember(guildId, userId))!.isPremiumSanitized;
		}

		it('a ledger repair queues the perk reset', async () => {
			const {userId, guildId, lapsed} = await lapsedGuildMember();
			const race = stripBeforeRepairWrite(sweep(lapsed));

			await getPremiumLedgerService().grant(grant(userId, 'order-2:premium', {unit: 'months', quantity: 1}));
			vi.restoreAllMocks();
			expect(race.stripped()).toBe(true);
			expect(await isSanitized(guildId, userId)).toBe(true);
			await runQueuedPremiumTasks();

			expect(checkIsPremium(await readUser(userId))).toBe(true);
			expect(await isSanitized(guildId, userId)).toBe(false);
		});

		it('a Visionary grant queues the perk reset', async () => {
			const {userId, guildId, lapsed} = await lapsedGuildMember();
			const race = stripBeforeRepairWrite(sweep(lapsed), (patch) => patch.premium_type === UserPremiumTypes.LIFETIME);

			await visionary().adminGrant(userId);
			vi.restoreAllMocks();
			expect(race.stripped()).toBe(true);
			expect(await isSanitized(guildId, userId)).toBe(true);
			await runQueuedPremiumTasks();

			expect((await readUser(userId)).premiumType).toBe(UserPremiumTypes.LIFETIME);
			expect(await isSanitized(guildId, userId)).toBe(false);
		});

		it('a perk reset that cannot be queued never drops the premium write', async () => {
			const {userId} = await lapsedGuildMember();
			const addJob = worker.addJob.bind(worker);
			vi.spyOn(worker, 'addJob').mockImplementation(async (taskType, payload, options) => {
				if (taskType === 'resetPremiumPerkSanitization') {
					throw new Error('worker queue is full');
				}
				return addJob(taskType, payload, options);
			});

			await visionary().adminGrant(userId);

			expect((await readUser(userId)).premiumType).toBe(UserPremiumTypes.LIFETIME);
		});
	});
});
