// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {
	REFERRAL_PENDING_COUNTER,
	REFERRAL_REJECTED_COUNTER,
	REFERRAL_VALID_COUNTER,
	referralPendingMonth,
} from '@app/api/database/types/ReferralTypes';
import {counterKey} from '@app/api/infrastructure/KVCounterService';
import {getKVClient} from '@app/api/middleware/ServiceRegistry';
import {getKVCounterService, getReferralRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilderWithoutAuth} from '@app/api/test/TestRequestBuilder';
import {collectUserHarvestExtensions, runUserDeletionHook} from '@app/api/user/lifecycle/UserLifecycleHooks';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const DAY_MS = 86_400_000;
const USER = createUserID(1490000000000003002n);
const REFEREE = createUserID(1490000000000003003n);
const REFERRED_AT = new Date('2026-10-01T10:00:00Z');
const REG_IP = '198.51.100.23';
const SECRET_CODE = 'Gift-Secret-55';
const OFFSITE = {type: 'offsite', description: 'Gift card'};

describe('referral lifecycle hooks', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	// The referrer is a live account: the deletion hook looks it up before writing its list row and counters.
	let REFERRER: UserID;

	beforeEach(async () => {
		await harness.reset();
		REFERRER = createUserID(BigInt((await createTestAccount(harness)).userId));
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		await harness?.shutdown();
	});

	async function refer(refereeId: UserID, referrerId: UserID, referredAt = REFERRED_AT) {
		await getReferralRepository().recordReferral(
			{refereeId, referrerId, referredAt, regIp: REG_IP, riskBlocked: false},
			{dueAt: new Date(referredAt.getTime() + 3 * DAY_MS), ttlSeconds: 17 * 86_400},
		);
		await getKVCounterService().add(REFERRAL_PENDING_COUNTER, referrerId.toString(), 1);
	}

	// USER was referred by REFERRER, has a code, referred REFEREE and holds a delivered off-site reward with a code.
	async function seedUser() {
		const repository = getReferralRepository();
		await refer(USER, REFERRER);
		await refer(REFEREE, USER);
		await repository.insertCodeIfAbsent('lifecycle2', USER, REFERRED_AT);
		await repository.setOwnCode(USER, 'lifecycle2');
		await repository.claimReward({
			user_id: USER,
			tier_id: 77n,
			reward: JSON.stringify(OFFSITE),
			status: 'pending_admin',
			granted_at: REFERRED_AT,
			delivered_at: null,
			delivered_by: null,
			note: null,
			code: null,
		});
		await repository.insertPendingReward({
			month: referralPendingMonth(REFERRED_AT),
			created_at: REFERRED_AT,
			user_id: USER,
			tier_id: 77n,
		});
		await repository.setRewardStatus(USER, 77n, 'pending_admin', {
			status: 'delivered',
			delivered_at: REFERRED_AT,
			delivered_by: REFERRER,
			code: SECRET_CODE,
			note: null,
		});
	}

	async function counts(userId: UserID) {
		const counters = getKVCounterService();
		const id = userId.toString();
		return {
			pending: await counters.get(REFERRAL_PENDING_COUNTER, id),
			valid: await counters.get(REFERRAL_VALID_COUNTER, id),
			rejected: await counters.get(REFERRAL_REJECTED_COUNTER, id),
		};
	}

	// The raw KV counter keys (pending, valid, rejected), without the read-through to the stored base.
	function counterKeys(userId: UserID) {
		const kv = getKVClient();
		return Promise.all(
			[REFERRAL_PENDING_COUNTER, REFERRAL_VALID_COUNTER, REFERRAL_REJECTED_COUNTER].map((namespace) =>
				kv.get(counterKey(namespace, userId.toString())),
			),
		);
	}

	it('deletion hook clears all referral rows of the user', async () => {
		await seedUser();
		const repository = getReferralRepository();

		await runUserDeletionHook('referral', {userId: USER});
		await runUserDeletionHook('referral', {userId: USER});

		expect(await repository.getUserReferral(USER)).toBeNull();
		expect(await repository.getCodeOwner('lifecycle2')).toBeNull();
		expect(await repository.getRewards(USER)).toEqual([]);
		expect((await repository.listPendingRewards(referralPendingMonth(REFERRED_AT), null, 10)).items).toEqual([]);
		expect(await repository.listReferrals(USER, null, 10)).toEqual({items: [], nextCursor: null});
		// the referrer keeps the entry, now rejected as account_gone, and the counts move once.
		expect((await repository.listReferrals(REFERRER, null, 10)).items).toEqual([
			expect.objectContaining({referee_id: USER, state: 'rejected', reason: 'account_gone'}),
		]);
		expect(await counts(REFERRER)).toEqual({pending: 0, valid: 0, rejected: 1});
		// The referee's own mapping belongs to the referee.
		expect(await repository.getUserReferral(REFEREE)).toMatchObject({referrer_id: USER, state: 'pending'});
	});

	it('a deleted referrer: the referee deletion writes nothing back for it (CR3)', async () => {
		await seedUser();
		const repository = getReferralRepository();
		await createBuilderWithoutAuth(harness)
			.post(`/test/users/${REFERRER}/security-flags`)
			.body({set_flags: ['DELETED']})
			.expect(200)
			.execute();
		await runUserDeletionHook('referral', {userId: REFERRER});
		const updateEntry = vi.spyOn(repository, 'updateReferrerEntry');

		await runUserDeletionHook('referral', {userId: USER});

		expect(updateEntry).not.toHaveBeenCalled();
		expect(await repository.listReferrals(REFERRER, null, 10)).toEqual({items: [], nextCursor: null});
		expect(await repository.getStats(REFERRER)).toBeNull();
		expect(await counterKeys(REFERRER)).toEqual([null, null, null]);
	});

	it('the deletion hook also removes the KV referral counters of the user (CR3)', async () => {
		await seedUser();
		expect((await counterKeys(USER))[0]).toBe('1');

		await runUserDeletionHook('referral', {userId: USER});

		expect(await counterKeys(USER)).toEqual([null, null, null]);
		expect(await getReferralRepository().getStats(USER)).toBeNull();
	});

	it('deleting a validated referee takes nothing from the referrer', async () => {
		const repository = getReferralRepository();
		await refer(USER, REFERRER);
		await repository.transitionState(USER, 'valid', null, new Date(REFERRED_AT.getTime() + 3 * DAY_MS));
		await repository.updateReferrerEntry(REFERRER, REFERRED_AT, USER, 'valid', null);
		const counters = getKVCounterService();
		await counters.add(REFERRAL_PENDING_COUNTER, REFERRER.toString(), -1);
		await counters.add(REFERRAL_VALID_COUNTER, REFERRER.toString(), 1);

		await runUserDeletionHook('referral', {userId: USER});

		expect(await repository.getUserReferral(USER)).toBeNull();
		expect((await repository.listReferrals(REFERRER, null, 10)).items).toEqual([
			expect.objectContaining({referee_id: USER, state: 'valid', reason: null}),
		]);
		expect(await counts(REFERRER)).toEqual({pending: 0, valid: 1, rejected: 0});
	});

	it('harvest (admin archive included) has the code, referrer, counts and rewards but no off-site code text and no IP', async () => {
		await seedUser();

		const extensions = await collectUserHarvestExtensions({userId: USER});
		const data = extensions.find((extension) => extension.name === 'referral')?.data;

		expect(data).toMatchObject({
			code: 'lifecycle2',
			referrer_id: REFERRER.toString(),
			state: 'pending',
			rewards: [{tier_id: '77', reward: OFFSITE, status: 'delivered', has_code: true}],
		});
		const text = JSON.stringify(data);
		expect(text).not.toContain(SECRET_CODE);
		expect(text).not.toContain(REG_IP);
	});
});
