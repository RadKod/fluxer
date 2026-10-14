// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHash, createHmac} from 'node:crypto';
import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {upsertOne} from '@app/api/database/CassandraQueryExecution';
import {applySharedListUpdate} from '@app/api/infrastructure/activity/SharedLists';
import type {InstancePremiumMode} from '@app/api/instance/InstanceConfigRepository';
import {getCachedInstancePremiumMode, setCachedInstancePremiumMode} from '@app/api/limits/InstancePremiumModeCache';
import {getGatewayService, getKVClient, getWorkerService} from '@app/api/middleware/ServiceRegistry';
import {
	getGuildRepository,
	getInstanceConfigRepository,
	getPremiumLedgerRepository,
	getPremiumStateReconciliationQueueService,
	getUserCacheService,
	getUserRepository,
} from '@app/api/middleware/ServiceSingletons';
import type {User} from '@app/api/models/User';
import {PremiumLedgerRepository} from '@app/api/premium/ledger/PremiumLedgerRepository';
import {PremiumLedgerService} from '@app/api/premium/ledger/PremiumLedgerService';
import {PremiumTrialRepository} from '@app/api/premium/trial/PremiumTrialRepository';
import {PremiumTrialsByEmail} from '@app/api/premium/trial/PremiumTrialTables';
import {createTestStoreEntitlementService} from '@app/api/store_billing/tests/StoreBillingTestUtils';
import {DisposableEmailDomains} from '@app/api/Tables';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {CAPTCHA_TEST_HEADER, issueSolvedCaptchaToken} from '@app/api/test/CaptchaTestUtils';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {checkIsPremium} from '@app/api/user/UserHelpers';
import processPremiumExpirations from '@app/api/worker/tasks/ProcessPremiumExpirations';
import {clearWorkerDependencies, setWorkerDependenciesForTest} from '@app/api/worker/WorkerContext';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {ms} from 'itty-time';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const EMAIL_HASH_KEY = 'premium-trial-test-key-0123456789abcdef';
const SEVEN_DAYS_MS = ms('7 days');

interface Eligibility {
	eligible: boolean;
	days: number;
	reason: string | null;
}

describe('premium trial', () => {
	let harness: ApiTestHarness;
	let previous: {selfHosted: boolean; key: string; feeds: boolean; premiumMode: InstancePremiumMode};

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
		previous = {
			selfHosted: Config.instance.selfHosted,
			key: Config.premiumTrial.emailHashKey,
			feeds: Config.blocklistFeeds.enabled,
			premiumMode: getCachedInstancePremiumMode(),
		};
		Config.instance.selfHosted = true;
		Config.premiumTrial.emailHashKey = EMAIL_HASH_KEY;
		await setPolicy({premium_mode: 'mirror', premium_trial_days: 7});
		await setCaptcha(true);
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
		Config.instance.selfHosted = previous.selfHosted;
		Config.premiumTrial.emailHashKey = previous.key;
		Config.blocklistFeeds.enabled = previous.feeds;
		setCachedInstancePremiumMode(previous.premiumMode);
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	async function setPolicy(policy: {premium_mode?: InstancePremiumMode; premium_trial_days?: number}): Promise<void> {
		await getInstanceConfigRepository().setInstancePolicyConfig(policy);
		if (policy.premium_mode) setCachedInstancePremiumMode(policy.premium_mode);
	}

	async function setCaptcha(on: boolean): Promise<void> {
		await getInstanceConfigRepository().updateCaptchaConfig({enabled: on, cost: 1000, max_counter: 100});
	}

	async function createAccount(params?: Parameters<typeof createTestAccount>[1]): Promise<TestAccount> {
		await setCaptcha(false);
		const account = await createTestAccount(harness, params);
		await setCaptcha(true);
		return account;
	}

	function idOf(account: TestAccount): UserID {
		return createUserID(BigInt(account.userId));
	}

	async function readUser(account: TestAccount): Promise<User> {
		return (await getUserRepository().findUnique(idOf(account)))!;
	}

	async function paidUntilOf(account: TestAccount): Promise<number | undefined> {
		return (await getPremiumLedgerRepository().find(idOf(account)))?.paid_until?.getTime();
	}

	async function claim(account: TestAccount) {
		const builder = createBuilder(harness, account.token).post('/premium/trial').header(CAPTCHA_TEST_HEADER, 'true');
		if ((await getInstanceConfigRepository().getCaptchaConfig()).enabled) {
			builder.header('x-captcha-token', await issueSolvedCaptchaToken(harness));
		}
		return builder;
	}

	async function claimStatus(account: TestAccount, headers: Record<string, string> = {}): Promise<number> {
		const token = await issueSolvedCaptchaToken(harness);
		const response = await harness.requestJson({
			path: '/premium/trial',
			method: 'POST',
			headers: {Authorization: account.token, [CAPTCHA_TEST_HEADER]: 'true', 'x-captcha-token': token, ...headers},
		});
		return response.status;
	}

	async function eligibility(account: TestAccount): Promise<Eligibility> {
		return createBuilder<Eligibility>(harness, account.token).get('/premium/trial').execute();
	}

	it('gives an eligible user exactly seven days of premium from the moment of the claim', async () => {
		const account = await createAccount();
		expect(await eligibility(account)).toEqual({eligible: true, days: 7, reason: null});

		const before = Date.now();
		await (await claim(account)).expect(204).execute();
		const after = Date.now();

		const paidUntil = (await paidUntilOf(account))!;
		expect(paidUntil).toBeGreaterThanOrEqual(before + SEVEN_DAYS_MS);
		expect(paidUntil).toBeLessThanOrEqual(after + SEVEN_DAYS_MS);
		const user = await readUser(account);
		expect(checkIsPremium(user)).toBe(true);
		expect(user.premiumGiftExtensionEndsAt?.getTime()).toBe(paidUntil);
		expect(await eligibility(account)).toEqual({eligible: false, days: 7, reason: 'already_used'});
	});

	it('refuses a second trial on the same account', async () => {
		const account = await createAccount();
		await (await claim(account)).expect(204).execute();
		const paidUntil = await paidUntilOf(account);

		await (await claim(account)).expect(409, 'TRIAL_ALREADY_USED').execute();

		expect(await paidUntilOf(account)).toBe(paidUntil);
	});

	it('lets the ledger refuse a second trial even when the early check misses it', async () => {
		const account = await createAccount();
		await (await claim(account)).expect(204).execute();
		const paidUntil = await paidUntilOf(account);
		await getUserRepository().patchUpsert(idOf(account), {
			premium_type: null,
			premium_gift_extension_ends_at: null,
			premium_grace_ends_at: null,
		});
		vi.spyOn(PremiumLedgerRepository.prototype, 'find').mockResolvedValueOnce(null);

		await (await claim(account)).expect(409, 'TRIAL_ALREADY_USED').execute();

		expect(await paidUntilOf(account)).toBe(paidUntil);
	});

	it('refuses a second account whose address normalises to one that already had a trial', async () => {
		const first = await createAccount({email: 'aliveli@gmail.com'});
		const second = await createAccount({email: 'Ali.Veli+x@gmail.com'});
		const third = await createAccount({email: 'ali.veli@googlemail.com'});
		await (await claim(first)).expect(204).execute();

		await (await claim(second)).expect(409, 'TRIAL_ALREADY_USED').execute();
		await (await claim(third)).expect(409, 'TRIAL_ALREADY_USED').execute();

		expect(await eligibility(second)).toEqual({eligible: false, days: 7, reason: 'already_used'});
		expect(await paidUntilOf(second)).toBeUndefined();
		expect(checkIsPremium(await readUser(third))).toBe(false);
	});

	it('gives one trial when two accounts with the same address claim at once', async () => {
		const first = await createAccount({email: 'ali.veli@gmail.com'});
		const second = await createAccount({email: 'aliveli+x@googlemail.com'});

		const statuses = await Promise.all([claimStatus(first), claimStatus(second)]);

		expect(statuses.sort()).toEqual([204, 409]);
		const granted = [await paidUntilOf(first), await paidUntilOf(second)].filter((until) => until !== undefined);
		expect(granted).toHaveLength(1);
	});

	it('grants once and for seven days when one account claims five times at once', async () => {
		const account = await createAccount();
		const before = Date.now();

		const statuses = await Promise.all(Array.from({length: 5}, () => claimStatus(account)));

		expect(statuses.sort()).toEqual([204, 409, 409, 409, 409]);
		const paidUntil = (await paidUntilOf(account))!;
		expect(paidUntil - before).toBeGreaterThanOrEqual(SEVEN_DAYS_MS);
		expect(paidUntil - Date.now()).toBeLessThanOrEqual(SEVEN_DAYS_MS);
	});

	it('lets the same account retry after the address was claimed but the ledger write failed', async () => {
		const account = await createAccount();
		vi.spyOn(PremiumLedgerService.prototype, 'grant').mockRejectedValueOnce(new Error('ledger unavailable'));

		expect(await claimStatus(account)).toBe(500);
		expect(await paidUntilOf(account)).toBeUndefined();
		const before = Date.now();
		await (await claim(account)).expect(204).execute();

		const paidUntil = (await paidUntilOf(account))!;
		expect(paidUntil).toBeGreaterThanOrEqual(before + SEVEN_DAYS_MS);
		expect(paidUntil).toBeLessThanOrEqual(Date.now() + SEVEN_DAYS_MS);
	});

	it('refuses an account whose email is not verified', async () => {
		const account = await createAccount({skipEmailVerification: true});

		await (await claim(account)).expect(403, 'TRIAL_NOT_ELIGIBLE').execute();

		expect(await eligibility(account)).toEqual({eligible: false, days: 7, reason: 'not_eligible'});
	});

	it('allows a trial without CAPTCHA when the instance disables it', async () => {
		const account = await createAccount();
		await setCaptcha(false);

		expect(await eligibility(account)).toEqual({eligible: true, days: 7, reason: null});
		await (await claim(account)).expect(204).execute();
		await (await claim(account)).expect(409, 'TRIAL_ALREADY_USED').execute();
	});

	it('asks for an ALTCHA challenge when enabled', async () => {
		const account = await createAccount();
		await createBuilder(harness, account.token)
			.post('/premium/trial')
			.header(CAPTCHA_TEST_HEADER, 'true')
			.expect(400, 'CAPTCHA_REQUIRED')
			.execute();
		expect(await paidUntilOf(account)).toBeUndefined();
	});

	it('refuses invalid and already consumed CAPTCHA challenges before granting another trial', async () => {
		const first = await createAccount();
		const second = await createAccount();
		await createBuilder(harness, first.token)
			.post('/premium/trial')
			.header(CAPTCHA_TEST_HEADER, 'true')
			.header('x-captcha-token', 'invalid-challenge')
			.expect(400, 'INVALID_CAPTCHA')
			.execute();
		const token = await issueSolvedCaptchaToken(harness);
		await createBuilder(harness, first.token)
			.post('/premium/trial')
			.header(CAPTCHA_TEST_HEADER, 'true')
			.header('x-captcha-token', token)
			.expect(204)
			.execute();
		await createBuilder(harness, second.token)
			.post('/premium/trial')
			.header(CAPTCHA_TEST_HEADER, 'true')
			.header('x-captcha-token', token)
			.expect(400, 'INVALID_CAPTCHA')
			.execute();
		expect(await paidUntilOf(second)).toBeUndefined();
	});

	it('honours the upstream reviewer CAPTCHA exemption for a trial', async () => {
		const account = await createAccount();
		await getUserRepository().patchUpsert(idOf(account), {flags: UserFlags.APP_STORE_REVIEWER});
		await getUserCacheService().invalidateUserCache(idOf(account));
		await createBuilder(harness, account.token)
			.post('/premium/trial')
			.header(CAPTCHA_TEST_HEADER, 'true')
			.expect(204)
			.execute();
		expect(await paidUntilOf(account)).toBeDefined();
	});

	it('refuses a limited account with a valid CAPTCHA before granting the trial', async () => {
		const account = await createAccount();
		await getUserRepository().patchUpsert(idOf(account), {flags: UserFlags.ACCOUNT_LIMITED});
		await getUserCacheService().invalidateUserCache(idOf(account));
		await (await claim(account)).expect(403, 'ACCOUNT_LIMITED').execute();
		expect(await paidUntilOf(account)).toBeUndefined();
	});

	it('honours the upstream email-domain CAPTCHA exemption for a trial', async () => {
		const account = await createAccount({email: 'trial@captcha-exempt.example'});
		applySharedListUpdate('email_domain_exempt', 'captcha-exempt.example');
		try {
			await createBuilder(harness, account.token)
				.post('/premium/trial')
				.header(CAPTCHA_TEST_HEADER, 'true')
				.expect(204)
				.execute();
			expect(await paidUntilOf(account)).toBeDefined();
		} finally {
			applySharedListUpdate('email_domain_exempt', null);
		}
	});

	it('stays closed when the instance turned the trial off or cannot run it', async () => {
		const account = await createAccount();

		await setPolicy({premium_trial_days: 0});
		await (await claim(account)).expect(403, 'TRIAL_UNAVAILABLE').execute();
		await setPolicy({premium_trial_days: 7, premium_mode: 'everyone'});
		await (await claim(account)).expect(403, 'TRIAL_UNAVAILABLE').execute();
		await setPolicy({premium_mode: 'mirror'});
		Config.premiumTrial.emailHashKey = '';
		await (await claim(account)).expect(403, 'TRIAL_UNAVAILABLE').execute();
		Config.premiumTrial.emailHashKey = EMAIL_HASH_KEY;
		Config.instance.selfHosted = false;
		await (await claim(account)).expect(403, 'TRIAL_UNAVAILABLE').execute();

		expect(await paidUntilOf(account)).toBeUndefined();
	});

	it('clears the trial perks through the expiration job once the seven days are over', async () => {
		const account = await createAccount();
		await (await claim(account)).expect(204).execute();
		const paidUntil = (await paidUntilOf(account))!;

		vi.useFakeTimers({toFake: ['Date']});
		vi.setSystemTime(paidUntil + 1000);
		await processPremiumExpirations(
			{},
			{
				logger: new NoopLogger(),
				jobId: 1n,
				addJob: async () => 0n,
				reportProgress: async () => {},
				shouldCancel: async () => false,
				setContextLink: async () => {},
			},
		);

		const user = await readUser(account);
		expect(checkIsPremium(user)).toBe(false);
		expect(user.premiumType).toBeNull();
	});

	it('refuses an account that has paid for premium before', async () => {
		const account = await createAccount();
		await getUserRepository().patchUpsert(idOf(account), {has_ever_purchased: true});

		await (await claim(account)).expect(403, 'TRIAL_NOT_ELIGIBLE').execute();
	});

	it('refuses a disposable email domain once the blocklist feeds are on', async () => {
		const account = await createAccount({email: 'trial-user@mailinator.com'});
		Config.blocklistFeeds.enabled = true;
		await upsertOne(DisposableEmailDomains.insert({domain: 'mailinator.com'}));

		await (await claim(account)).expect(403, 'TRIAL_NOT_ELIGIBLE').execute();
	});

	it('spends no network quota on claims without a captcha or from ineligible accounts', async () => {
		const limited = {'x-fluxer-test-enable-rate-limits': 'true', [CAPTCHA_TEST_HEADER]: 'true'};
		const noCaptcha: Array<TestAccount> = [];
		const unverified: Array<TestAccount> = [];
		for (let i = 0; i < 7; i++) noCaptcha.push(await createAccount());
		for (let i = 0; i < 7; i++) unverified.push(await createAccount({skipEmailVerification: true}));
		const statuses: Array<number> = [];
		for (let i = 0; i < 21; i++) {
			const response = await harness.requestJson({
				path: '/premium/trial',
				method: 'POST',
				headers: {Authorization: noCaptcha[Math.floor(i / 3)].token, ...limited, 'x-forwarded-for': `198.51.100.${i}`},
			});
			statuses.push(response.status);
		}
		for (let i = 0; i < 21; i++) {
			statuses.push(
				await claimStatus(unverified[Math.floor(i / 3)], {...limited, 'x-forwarded-for': `198.51.100.${100 + i}`}),
			);
		}

		expect(statuses).toEqual([...Array(21).fill(400), ...Array(21).fill(403)]);
		const neighbour = await createAccount();
		expect(await claimStatus(neighbour, {...limited, 'x-forwarded-for': '198.51.100.250'})).toBe(204);
	});

	it('allows twenty trials a day from one IPv6 /48, however its /64s are spread, and refuses the twenty-first', async () => {
		const limited = {'x-fluxer-test-enable-rate-limits': 'true', [CAPTCHA_TEST_HEADER]: 'true'};
		const accounts: Array<TestAccount> = [];
		for (let i = 0; i < 22; i++) accounts.push(await createAccount());
		const statuses: Array<number> = [];
		for (let i = 0; i < 20; i++) {
			const subnet = (0xbb00 + i).toString(16);
			statuses.push(await claimStatus(accounts[i], {...limited, 'x-forwarded-for': `2001:db8:aa:${subnet}::1`}));
		}

		expect(statuses).toEqual(Array(20).fill(204));
		expect(await claimStatus(accounts[20], {...limited, 'x-forwarded-for': '2001:db8:aa:bbff::1'})).toBe(429);
		expect(await paidUntilOf(accounts[20])).toBeUndefined();
		expect(await claimStatus(accounts[21], {...limited, 'x-forwarded-for': '2001:db8:ab::1'})).toBe(204);
	});

	it('stores the address only as a keyed HMAC, never as a plain SHA-256', async () => {
		const account = await createAccount({email: 'Ali.Veli+promo@gmail.com'});
		await (await claim(account)).expect(204).execute();
		const normalised = 'aliveli@gmail.com';
		const repository = new PremiumTrialRepository();

		expect(await repository.find(createHash('sha256').update(normalised).digest('hex'))).toBeNull();
		expect(await repository.find(createHash('sha256').update(normalised).digest('base64url'))).toBeNull();
		const row = await repository.find(createHmac('sha256', EMAIL_HASH_KEY).update(normalised).digest('base64url'));
		expect(row?.user_id).toBe(idOf(account));
	});

	it('writes the address hash with a two-year TTL', async () => {
		const account = await createAccount();
		const insert = vi.spyOn(PremiumTrialsByEmail, 'insertIfNotExistsWithTtl');

		await (await claim(account)).expect(204).execute();

		expect(insert).toHaveBeenCalledTimes(1);
		expect(insert.mock.calls[0]![0].user_id).toBe(idOf(account));
		expect(insert.mock.calls[0]![1]).toBe(63_072_000);
	});
});
