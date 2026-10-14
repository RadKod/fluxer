// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	createTestAccount,
	createUniqueEmail,
	createUniqueUsername,
	loginAccount,
} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {upsertOne} from '@app/api/database/CassandraQueryExecution';
import {REFERRAL_PENDING_COUNTER, referralCheckShard, referralCheckSlot} from '@app/api/database/types/ReferralTypes';
import {
	getInstanceConfigRepository,
	getKVCounterService,
	getReferralRepository,
	getReferralService,
} from '@app/api/middleware/ServiceSingletons';
import type {ReferralService} from '@app/api/referral/ReferralService';
import {DisposableEmailDomains, SuspiciousEmailDomains} from '@app/api/Tables';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder, createBuilderWithoutAuth} from '@app/api/test/TestRequestBuilder';
import type {GuildResponse} from '@fluxer/schema/src/domains/guild/GuildResponseSchemas';
import type {ReferralMeResponse} from '@fluxer/schema/src/domains/referral/ReferralResponseSchemas';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type MockInstance, vi} from 'vitest';

const DAY_MS = 86_400_000;
const REFEREE_IP = '203.0.113.44';

interface RegisterResult {
	user_id: string;
	token?: string;
	registration_pending_approval?: true;
}

function userId(id: string): UserID {
	return createUserID(BigInt(id));
}

describe('referral_code at registration', () => {
	let harness: ApiTestHarness;
	let blocklistFeedsEnabled: boolean;
	let attach: MockInstance<ReferralService['attachAtRegistration']>;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	beforeEach(async () => {
		blocklistFeedsEnabled = Config.blocklistFeeds.enabled;
		await harness.reset();
		await getInstanceConfigRepository().setRegistrationConfig({mode: 'open'});
		await getInstanceConfigRepository().updateReferralConfig(() => ({enabled: true, min_active_days: 3}));
		attach = vi.spyOn(getReferralService(), 'attachAtRegistration');
	});

	afterEach(() => {
		vi.restoreAllMocks();
		Config.blocklistFeeds.enabled = blocklistFeedsEnabled;
	});

	afterAll(async () => {
		await harness?.shutdown();
	});

	// The referral step runs beside the registration response; wait for it before looking.
	async function settled(): Promise<void> {
		await Promise.allSettled(attach.mock.results.map((result) => result.value));
	}

	async function referrerCode(): Promise<{referrerId: string; code: string}> {
		const referrer = await createTestAccount(harness);
		const me = await createBuilder<ReferralMeResponse>(harness, referrer.token).get('/users/@me/referral').execute();
		return {referrerId: referrer.userId, code: me.code!};
	}

	async function register(extra: Record<string, unknown>, status = 200): Promise<RegisterResult> {
		const result = await createBuilderWithoutAuth<RegisterResult>(harness)
			.post('/auth/register')
			.header('x-forwarded-for', REFEREE_IP)
			.body({
				email: createUniqueEmail('referral'),
				username: createUniqueUsername('referral'),
				global_name: 'Referral Test',
				password: 'a-strong-password-123',
				date_of_birth: '2000-01-01',
				consent: true,
				...extra,
			})
			.expect(status)
			.execute();
		await settled();
		return result;
	}

	it('valid code → pending mapping, check at slot(referred_at + N days), pending counter +1', async () => {
		const {referrerId, code} = await referrerCode();
		const before = Date.now();
		const {user_id} = await register({referral_code: code});

		const mapping = await getReferralRepository().getUserReferral(userId(user_id));
		expect(mapping).toMatchObject({referrer_id: userId(referrerId), state: 'pending', risk_blocked: false});
		const referredAt = mapping!.referred_at!;
		expect(referredAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
		const due = new Date(referredAt.getTime() + 3 * DAY_MS);
		expect(
			await getReferralRepository().listChecks(referralCheckSlot(due), referralCheckShard(userId(user_id)), 10),
		).toEqual([
			{
				slot: referralCheckSlot(due),
				shard: referralCheckShard(userId(user_id)),
				referee_id: userId(user_id),
				due_at: due,
				reg_ip: REFEREE_IP,
			},
		]);
		const list = await getReferralRepository().listReferrals(userId(referrerId), null, 10);
		expect(list.items.map((row) => row.referee_id)).toEqual([userId(user_id)]);
		expect(await getKVCounterService().get(REFERRAL_PENDING_COUNTER, referrerId)).toBe(1);
	});

	it('accepts the code in any case and with spaces around it', async () => {
		const {referrerId, code} = await referrerCode();
		const {user_id} = await register({referral_code: ` ${code.toUpperCase()} `});
		expect((await getReferralRepository().getUserReferral(userId(user_id)))?.referrer_id).toBe(userId(referrerId));
	});

	it('unknown/malformed code → 200, nothing written', async () => {
		const record = vi.spyOn(getReferralRepository(), 'recordReferral');
		for (const referralCode of ['zzzzzzzzzz', 'not a code!', 'abc', 'x'.repeat(64), 'y'.repeat(300), null]) {
			const {user_id} = await register({referral_code: referralCode});
			expect(await getReferralRepository().getUserReferral(userId(user_id))).toBeNull();
		}
		await register({});
		expect(record).not.toHaveBeenCalled();
	});

	it('repository failure → registration still 200', async () => {
		const {code} = await referrerCode();
		vi.spyOn(getReferralRepository(), 'recordReferral').mockRejectedValue(new Error('cassandra down'));
		const first = await register({referral_code: code});
		expect(first.token).toBeTruthy();

		attach.mockRejectedValueOnce(new Error('unexpected'));
		const second = await register({referral_code: code});
		expect(second.token).toBeTruthy();
	});

	it('invite_code auto-join unchanged with referral_code', async () => {
		const {referrerId, code} = await referrerCode();
		let owner = await createTestAccount(harness);
		await createBuilderWithoutAuth(harness)
			.post(`/test/users/${owner.userId}/acls`)
			.body({acls: ['*']})
			.execute();
		owner = await loginAccount(harness, owner);
		const guild = await createBuilder<GuildResponse>(harness, owner.token)
			.post('/guilds')
			.body({name: 'Ref'})
			.execute();
		const invite = await createBuilder<{code: string}>(harness, owner.token)
			.post(`/channels/${guild.system_channel_id}/invites`)
			.body({max_uses: 0, max_age: 0, unique: false, temporary: false})
			.execute();

		const {user_id} = await register({invite_code: invite.code, referral_code: code});
		await createBuilder(harness, owner.token).get(`/guilds/${guild.id}/members/${user_id}`).expect(200).execute();
		expect((await getReferralRepository().getUserReferral(userId(user_id)))?.referrer_id).toBe(userId(referrerId));
	});

	it('pending approval registration still records mapping', async () => {
		const {referrerId, code} = await referrerCode();
		await getInstanceConfigRepository().setRegistrationConfig({mode: 'approval'});
		const result = await register({referral_code: code});
		expect(result.registration_pending_approval).toBe(true);
		expect((await getReferralRepository().getUserReferral(userId(result.user_id)))?.referrer_id).toBe(
			userId(referrerId),
		);
	});

	it('a clean email domain is not a referral risk', async () => {
		const {code} = await referrerCode();
		const {user_id} = await register({referral_code: code});
		expect((await getReferralRepository().getUserReferral(userId(user_id)))?.risk_blocked).toBe(false);
	});

	it.each(['suspicious', 'disposable'])(
		'a registration from a %s email domain is stored as risk_blocked',
		async (kind) => {
			const {code} = await referrerCode();
			Config.blocklistFeeds.enabled = true;
			const table = kind === 'suspicious' ? SuspiciousEmailDomains : DisposableEmailDomains;
			await upsertOne(table.insert({domain: 'example.com'}));
			const {user_id} = await register({referral_code: code});
			expect((await getReferralRepository().getUserReferral(userId(user_id)))?.risk_blocked).toBe(true);
		},
	);

	it('disabled config ignores code', async () => {
		const {code} = await referrerCode();
		await getInstanceConfigRepository().updateReferralConfig(() => ({enabled: false}));
		const {user_id} = await register({referral_code: code});
		expect(await getReferralRepository().getUserReferral(userId(user_id))).toBeNull();
	});

	it('own code impossible', async () => {
		const {referrerId, code} = await referrerCode();
		const record = vi.spyOn(getReferralRepository(), 'recordReferral');
		await getReferralService().attachAtRegistration({
			refereeId: userId(referrerId),
			code,
			ip: REFEREE_IP,
			riskBlocked: false,
			now: new Date(),
		});
		expect(record).not.toHaveBeenCalled();
	});
});
