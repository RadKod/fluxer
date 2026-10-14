// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, setUserACLs, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createGuildID, createUserID, type UserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {createTestGuild} from '@app/api/emoji/tests/EmojiTestUtils';
import {getMember} from '@app/api/guild/tests/GuildTestUtils';
import {
	getGatewayService,
	getKVClient,
	getWorkerService,
	setInjectedWorkerService,
} from '@app/api/middleware/ServiceRegistry';
import {
	getCacheService,
	getGuildRepository,
	getPremiumLedgerRepository,
	getPremiumLedgerService,
	getPremiumStateReconciliationQueueService,
	getUserCacheService,
	getUserRepository,
} from '@app/api/middleware/ServiceSingletons';
import {PremiumLedgerRepository} from '@app/api/premium/ledger/PremiumLedgerRepository';
import {premiumExpirationDay, premiumExpirationShard} from '@app/api/premium/ledger/PremiumLedgerService';
import {createTestStoreEntitlementService} from '@app/api/store_billing/tests/StoreBillingTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {NoopGatewayService} from '@app/api/test/NoopGatewayService';
import {NoopWorkerService} from '@app/api/test/NoopWorkerService';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {UserRepository} from '@app/api/user/repositories/UserRepository';
import {
	checkIsPremium,
	createPremiumClearPatch,
	getEffectivePremiumUntil,
	PREMIUM_GRACE_PERIOD_MS,
} from '@app/api/user/UserHelpers';
import ensureUserPremium from '@app/api/worker/tasks/EnsureUserPremium';
import processPremiumExpirations from '@app/api/worker/tasks/ProcessPremiumExpirations';
import resetPremiumPerkSanitization from '@app/api/worker/tasks/ResetPremiumPerkSanitization';
import {clearWorkerDependencies, setWorkerDependenciesForTest} from '@app/api/worker/WorkerContext';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {PremiumFlags} from '@fluxer/constants/src/UserConstants';
import type {IWorkerService} from '@pkgs/worker/src/contracts/IWorkerService';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import type {WorkerJobOptions, WorkerJobPayload} from '@pkgs/worker/src/contracts/WorkerTypes';
import {ms} from 'itty-time';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

class RecordingWorkerService extends NoopWorkerService implements IWorkerService {
	readonly jobs: Array<{taskType: string; payload: WorkerJobPayload}> = [];

	override async addJob(taskType?: string, payload?: WorkerJobPayload, _options?: WorkerJobOptions): Promise<bigint> {
		this.jobs.push({taskType: taskType!, payload: payload!});
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

describe('gift codes on a self-hosted instance', () => {
	let harness: ApiTestHarness;
	let previousSelfHosted: boolean;

	beforeAll(async () => {
		previousSelfHosted = Config.instance.selfHosted;
		Config.instance.selfHosted = true;
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
		Config.instance.selfHosted = previousSelfHosted;
	});

	async function createAdmin(): Promise<TestAccount> {
		return setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.INSTANCE_CONFIG_VIEW,
			AdminACLs.INSTANCE_CONFIG_UPDATE,
			AdminACLs.GIFT_CODES_GENERATE,
		]);
	}

	async function setPremiumMode(admin: TestAccount, premiumMode: 'mirror' | 'everyone'): Promise<void> {
		await createBuilder(harness, admin.token)
			.patch('/admin/instance/config')
			.body({policy: {premium_mode: premiumMode}})
			.execute();
	}

	async function generateCodes(admin: TestAccount, count: number): Promise<Array<string>> {
		const {codes} = await createBuilder<{codes: Array<string>}>(harness, admin.token)
			.post('/admin/gift-codes')
			.body({count, duration_type: 'months', duration_quantity: 1})
			.execute();
		return codes.map((url) => url.slice(url.lastIndexOf('/') + 1));
	}

	function redeem(account: TestAccount, code: string) {
		return createBuilder(harness, account.token).post(`/gifts/${code}/redeem`);
	}

	async function readUser(userId: UserID) {
		return (await getUserRepository().findUnique(userId))!;
	}

	async function runQueuedPremiumTasks(worker: RecordingWorkerService): Promise<void> {
		const handlers = {ensureUserPremium, resetPremiumPerkSanitization};
		for (let job = worker.jobs.shift(); job; job = worker.jobs.shift()) {
			if (Object.hasOwn(handlers, job.taskType)) {
				await handlers[job.taskType as keyof typeof handlers](job.payload, HELPERS);
			}
		}
	}

	async function lapsePremium(userId: UserID): Promise<void> {
		const lapsedAt = new Date(Date.now() - PREMIUM_GRACE_PERIOD_MS - ms('1 day'));
		await getUserRepository().patchUpsert(
			userId,
			{premium_type: 1, premium_since: lapsedAt, premium_gift_extension_ends_at: lapsedAt, premium_grace_ends_at: null},
			(await readUser(userId)).toRow(),
		);
		await getPremiumLedgerService().trackExpiration(userId, lapsedAt);
	}

	// Runs the redemption just before the first user write that matches, the way a concurrent request would land.
	function redeemBeforeWrite(
		account: TestAccount,
		code: string,
		matches: (patch: Record<string, unknown>) => boolean,
	): {status: () => number | null} {
		const patchUpsert = UserRepository.prototype.patchUpsert;
		let status: number | null = null;
		vi.spyOn(UserRepository.prototype, 'patchUpsert').mockImplementation(async function (
			this: UserRepository,
			...args
		) {
			if (status === null && matches(args[1])) {
				status = 0;
				status = (await redeem(account, code).executeRaw()).response.status;
			}
			return patchUpsert.apply(this, args);
		});
		return {status: () => status};
	}

	function disableRedeemLockAndSentinels(): void {
		const cache = getCacheService();
		const get = cache.get.bind(cache);
		vi.spyOn(cache, 'acquireLock').mockImplementation(async (key) => `lock:${key}:${Math.random()}`);
		vi.spyOn(cache, 'releaseLock').mockResolvedValue(true);
		vi.spyOn(cache, 'get').mockImplementation(async (key: string) =>
			key.startsWith('gift_redeem_applied:') || key.startsWith('redeemed_gift_codes:') ? null : get(key),
		);
	}

	it('issues a batch of keys and grants a month of premium on redemption in mirror mode', async () => {
		const admin = await createAdmin();
		await setPremiumMode(admin, 'mirror');
		const codes = await generateCodes(admin, 100);
		expect(codes).toHaveLength(100);
		expect(new Set(codes).size).toBe(100);
		for (const code of codes) {
			expect(code).toMatch(/^[A-Za-z0-9]{32}$/);
		}
		const account = await createTestAccount(harness);
		const userId = createUserID(BigInt(account.userId));
		const gift = await createBuilder<{code: string; redeemed: boolean}>(harness, account.token)
			.get(`/gifts/${codes[0]}`)
			.execute();
		expect(gift).toMatchObject({code: codes[0], redeemed: false});
		const dispatchPresence = vi.spyOn(NoopGatewayService.prototype, 'dispatchPresence');
		const before = Date.now();

		await redeem(account, codes[0]!).expect(HTTP_STATUS.NO_CONTENT).execute();

		const user = await readUser(userId);
		expect(checkIsPremium(user)).toBe(true);
		const until = getEffectivePremiumUntil(user)!.getTime();
		expect(until).toBeGreaterThanOrEqual(before + ms('28 days'));
		expect(until).toBeLessThanOrEqual(Date.now() + ms('31 days'));
		const updates = dispatchPresence.mock.calls
			.map(([params]) => params as unknown as {userId: UserID; event: string})
			.filter((params) => params.event === 'USER_UPDATE' && params.userId === userId);
		expect(updates.length).toBeGreaterThan(0);
	});

	it('keeps key generation and redemption closed while premium is open to everyone', async () => {
		const admin = await createAdmin();
		await setPremiumMode(admin, 'mirror');
		const [code] = await generateCodes(admin, 1);
		await setPremiumMode(admin, 'everyone');
		const account = await createTestAccount(harness);

		await createBuilder(harness, admin.token)
			.post('/admin/gift-codes')
			.body({count: 1, duration_type: 'months', duration_quantity: 1})
			.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.FEATURE_NOT_AVAILABLE_SELF_HOSTED)
			.execute();
		await createBuilder(harness, account.token)
			.get(`/gifts/${code}`)
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.NOT_FOUND)
			.execute();
		await redeem(account, code!).expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.NOT_FOUND).execute();
		expect((await getUserRepository().findGiftCode(code!))?.redeemedByUserId).toBeNull();
	});

	it('lets exactly one of two users redeem the same key when the KV lock is gone', async () => {
		const admin = await createAdmin();
		await setPremiumMode(admin, 'mirror');
		const [code] = await generateCodes(admin, 1);
		const first = await createTestAccount(harness);
		const second = await createTestAccount(harness);
		disableRedeemLockAndSentinels();

		const results = await Promise.all([redeem(first, code!).executeRaw(), redeem(second, code!).executeRaw()]);

		const statuses = results.map(({response}) => response.status).sort();
		expect(statuses).toEqual([HTTP_STATUS.NO_CONTENT, HTTP_STATUS.BAD_REQUEST]);
		const loser = results.find(({response}) => response.status === HTTP_STATUS.BAD_REQUEST)!;
		expect((loser.json as {code: string}).code).toBe(APIErrorCodes.GIFT_CODE_ALREADY_REDEEMED);
		const premium = await Promise.all(
			[first, second].map(async (account) => checkIsPremium(await readUser(createUserID(BigInt(account.userId))))),
		);
		expect(premium.filter(Boolean)).toHaveLength(1);
		const redeemerIndexRows = await Promise.all(
			[first, second].map((account) =>
				getUserRepository().findGiftCodesByRedeemer(createUserID(BigInt(account.userId))),
			),
		);
		expect(redeemerIndexRows.flat().map((gift) => gift.code)).toEqual([code]);
	});

	it('grants the same key once when the same user redeems it again without the KV sentinels', async () => {
		const admin = await createAdmin();
		await setPremiumMode(admin, 'mirror');
		const [code] = await generateCodes(admin, 1);
		const account = await createTestAccount(harness);
		disableRedeemLockAndSentinels();

		await redeem(account, code!).expect(HTTP_STATUS.NO_CONTENT).execute();
		const untilAfterFirst = getEffectivePremiumUntil(await readUser(createUserID(BigInt(account.userId))));
		await redeem(account, code!).expect(HTTP_STATUS.NO_CONTENT).execute();

		expect(getEffectivePremiumUntil(await readUser(createUserID(BigInt(account.userId))))).toEqual(untilAfterFirst);
	});

	it('refuses to redeem a code row that carries no version instead of writing it unguarded', async () => {
		const code = 'Nov3rsionRowNov3rsionRowNov3rsio';
		await getUserRepository().createGiftCode({
			code,
			duration_months: 1,
			duration_type: 'months',
			duration_quantity: 1,
			created_at: new Date(),
			created_by_user_id: createUserID(0n),
			redeemed_at: null,
			redeemed_by_user_id: null,
			stripe_payment_intent_id: null,
			visionary_sequence_number: null,
			checkout_session_id: null,
			version: null as unknown as number,
		});
		const account = await createTestAccount(harness);

		await expect(getUserRepository().redeemGiftCode(code, createUserID(BigInt(account.userId)))).rejects.toThrow(
			'non-null expected value',
		);
		expect((await getUserRepository().findGiftCode(code))?.redeemedByUserId).toBeNull();
	});

	it('brings guild perks back when a user whose premium ended redeems a key', async () => {
		const admin = await createAdmin();
		await setPremiumMode(admin, 'mirror');
		const [code] = await generateCodes(admin, 1);
		const account = await createTestAccount(harness);
		const guild = await createTestGuild(harness, account.token);
		const userId = createUserID(BigInt(account.userId));
		const guildId = createGuildID(BigInt(guild.id));
		const member = (await getGuildRepository().getMember(guildId, userId))!;
		await getGuildRepository().upsertMember({...member.toRow(), avatar_hash: GUILD_AVATAR, is_premium_sanitized: true});
		const user = await readUser(userId);
		await getUserRepository().patchUpsert(
			userId,
			{premium_flags: user.premiumFlags | PremiumFlags.PERKS_SANITIZED},
			user.toRow(),
		);
		const worker = new RecordingWorkerService();
		setInjectedWorkerService(worker);

		await redeem(account, code!).expect(HTTP_STATUS.NO_CONTENT).execute();

		expect((await readUser(userId)).premiumFlags & PremiumFlags.PERKS_SANITIZED).toBe(0);
		const reset = worker.jobs.find((job) => job.taskType === 'resetPremiumPerkSanitization');
		expect(reset?.payload).toEqual({userId: account.userId});
		await resetPremiumPerkSanitization(reset!.payload, HELPERS);
		expect((await getMember(harness, account.token, guild.id, account.userId)).avatar).toBe(GUILD_AVATAR);
	});

	it('clears premium and guild perks once the key runs out, without a full user scan', async () => {
		const admin = await createAdmin();
		await setPremiumMode(admin, 'mirror');
		const [code] = await generateCodes(admin, 1);
		const account = await createTestAccount(harness);
		const guild = await createTestGuild(harness, account.token);
		const userId = createUserID(BigInt(account.userId));
		const guildId = createGuildID(BigInt(guild.id));
		const member = (await getGuildRepository().getMember(guildId, userId))!;
		await getGuildRepository().upsertMember({...member.toRow(), avatar_hash: GUILD_AVATAR});

		await redeem(account, code!).expect(HTTP_STATUS.NO_CONTENT).execute();

		const until = getEffectivePremiumUntil(await readUser(userId))!;
		expect(
			await getPremiumLedgerRepository().listExpirations(
				premiumExpirationDay(until),
				premiumExpirationShard(userId),
				10,
			),
		).toEqual([{day: premiumExpirationDay(until), shard: premiumExpirationShard(userId), user_id: userId}]);
		vi.useFakeTimers({toFake: ['Date']});
		vi.setSystemTime(until.getTime() + PREMIUM_GRACE_PERIOD_MS + 1000);
		await processPremiumExpirations({}, HELPERS);

		const expired = await readUser(userId);
		expect(checkIsPremium(expired)).toBe(false);
		expect(expired.premiumType).toBeNull();
		expect((await getGuildRepository().getMember(guildId, userId))!.isPremiumSanitized).toBe(true);
	});
	it('keeps the time of a key redeemed while the expiration cleanup strips the lapsed premium', async () => {
		const admin = await createAdmin();
		await setPremiumMode(admin, 'mirror');
		const [code] = await generateCodes(admin, 1);
		const account = await createTestAccount(harness);
		const userId = createUserID(BigInt(account.userId));
		await lapsePremium(userId);
		const worker = new RecordingWorkerService();
		setInjectedWorkerService(worker);
		const race = redeemBeforeWrite(account, code!, (patch) => patch['premium_type'] === null);

		await processPremiumExpirations({}, HELPERS);
		vi.restoreAllMocks();
		await runQueuedPremiumTasks(worker);

		expect(race.status()).toBe(HTTP_STATUS.NO_CONTENT);
		const user = await readUser(userId);
		expect(checkIsPremium(user)).toBe(true);
		expect(getEffectivePremiumUntil(user)!.getTime()).toBeGreaterThanOrEqual(Date.now() + ms('28 days'));
	});

	it('keeps the time of a key redeemed over a lapsed premium that a profile view strips mid-write', async () => {
		const admin = await createAdmin();
		await setPremiumMode(admin, 'mirror');
		const [code] = await generateCodes(admin, 1);
		const account = await createTestAccount(harness);
		const userId = createUserID(BigInt(account.userId));
		await lapsePremium(userId);
		const worker = new RecordingWorkerService();
		setInjectedWorkerService(worker);
		const patchUpsert = UserRepository.prototype.patchUpsert;
		let stripped = false;
		vi.spyOn(UserRepository.prototype, 'patchUpsert').mockImplementation(async function (
			this: UserRepository,
			...args
		) {
			if (!stripped && args[1].premium_grace_ends_at instanceof Date) {
				stripped = true;
				await patchUpsert.call(this, userId, createPremiumClearPatch(), (await readUser(userId)).toRow());
			}
			return patchUpsert.apply(this, args);
		});

		await redeem(account, code!).expect(HTTP_STATUS.NO_CONTENT).execute();
		vi.restoreAllMocks();
		await runQueuedPremiumTasks(worker);

		expect(stripped).toBe(true);
		const user = await readUser(userId);
		expect(checkIsPremium(user)).toBe(true);
		expect(user.premiumType).toBe(1);
		expect(getEffectivePremiumUntil(user)!.getTime()).toBeGreaterThanOrEqual(Date.now() + ms('28 days'));
	});

	it('keeps both a trial and a key redeemed while the trial is being written', async () => {
		const admin = await createAdmin();
		await setPremiumMode(admin, 'mirror');
		const [code] = await generateCodes(admin, 1);
		const account = await createTestAccount(harness);
		const userId = createUserID(BigInt(account.userId));
		const worker = new RecordingWorkerService();
		setInjectedWorkerService(worker);
		const race = redeemBeforeWrite(account, code!, (patch) => patch['premium_grace_ends_at'] instanceof Date);

		const trial = await getPremiumLedgerService().grant({
			userId,
			grantKey: 'trial',
			duration: {unit: 'days', quantity: 7},
			source: 'trial',
		});
		vi.restoreAllMocks();
		await runQueuedPremiumTasks(worker);

		expect(trial.newlyApplied).toBe(true);
		expect(race.status()).toBe(HTTP_STATUS.NO_CONTENT);
		const until = getEffectivePremiumUntil(await readUser(userId))!.getTime();
		expect(until).toBeGreaterThanOrEqual(Date.now() + ms('7 days') + ms('28 days'));
	});

	it('keeps a key redeemed and does not hand it back when announcing its granted time fails', async () => {
		const admin = await createAdmin();
		await setPremiumMode(admin, 'mirror');
		const [code] = await generateCodes(admin, 1);
		const first = await createTestAccount(harness);
		const second = await createTestAccount(harness);
		const firstId = createUserID(BigInt(first.userId));
		vi.spyOn(NoopGatewayService.prototype, 'dispatchPresence').mockRejectedValueOnce(new Error('gateway down'));

		await redeem(first, code!).expect(HTTP_STATUS.NO_CONTENT).execute();

		const until = getEffectivePremiumUntil(await readUser(firstId));
		expect(checkIsPremium(await readUser(firstId))).toBe(true);
		await redeem(second, code!).expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.GIFT_CODE_ALREADY_REDEEMED).execute();
		expect(checkIsPremium(await readUser(createUserID(BigInt(second.userId))))).toBe(false);
		await redeem(first, code!).expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.GIFT_CODE_ALREADY_REDEEMED).execute();
		expect(getEffectivePremiumUntil(await readUser(firstId))).toEqual(until);
	});

	it('finishes a claimed key on the same user retry when the first grant failed', async () => {
		const admin = await createAdmin();
		await setPremiumMode(admin, 'mirror');
		const [code] = await generateCodes(admin, 1);
		const account = await createTestAccount(harness);
		const userId = createUserID(BigInt(account.userId));
		vi.spyOn(PremiumLedgerRepository.prototype, 'find').mockRejectedValueOnce(new Error('ledger down'));

		await redeem(account, code!).expect(HTTP_STATUS.INTERNAL_SERVER_ERROR).execute();
		expect(checkIsPremium(await readUser(userId))).toBe(false);
		await redeem(account, code!).expect(HTTP_STATUS.NO_CONTENT).execute();

		const until = getEffectivePremiumUntil(await readUser(userId))!;
		expect(until.getTime()).toBeLessThanOrEqual(Date.now() + ms('31 days'));
		disableRedeemLockAndSentinels();
		await redeem(account, code!).expect(HTTP_STATUS.NO_CONTENT).execute();
		expect(getEffectivePremiumUntil(await readUser(userId))).toEqual(until);
	});

	it('answers the owner retry with success once its lost reply had already granted the key', async () => {
		const admin = await createAdmin();
		await setPremiumMode(admin, 'mirror');
		const [code] = await generateCodes(admin, 1);
		const account = await createTestAccount(harness);
		const second = await createTestAccount(harness);
		const userId = createUserID(BigInt(account.userId));
		const create = PremiumLedgerRepository.prototype.create;
		vi.spyOn(PremiumLedgerRepository.prototype, 'create').mockImplementationOnce(async function (
			this: PremiumLedgerRepository,
			row,
		) {
			await create.call(this, row);
			throw new Error('connection reset after write');
		});

		await redeem(account, code!).expect(HTTP_STATUS.INTERNAL_SERVER_ERROR).execute();
		await redeem(account, code!).expect(HTTP_STATUS.NO_CONTENT).execute();

		const user = await readUser(userId);
		expect(checkIsPremium(user)).toBe(true);
		expect(getEffectivePremiumUntil(user)!.getTime()).toBeLessThanOrEqual(Date.now() + ms('31 days'));
		await redeem(second, code!).expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.GIFT_CODE_ALREADY_REDEEMED).execute();
	});
});
