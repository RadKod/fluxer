// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {REFERRAL_VALID_COUNTER, type ReferralRewardRow} from '@app/api/database/types/ReferralTypes';
import {
	getInstanceConfigRepository,
	getKVCounterService,
	getReferralRepository,
	getReferralService,
} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder, createBuilderWithoutAuth} from '@app/api/test/TestRequestBuilder';
import type {ReferralMeResponse} from '@fluxer/schema/src/domains/referral/ReferralResponseSchemas';
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const CREATED_AT = '2026-10-01T00:00:00.000Z';
const GRANTED_AT = new Date('2026-10-01T12:00:00.000Z');

function tier(id: string, threshold: number, enabled: boolean) {
	return {id, threshold, reward: {type: 'premium_days' as const, days: threshold}, enabled, created_at: CREATED_AT};
}

describe('GET /users/@me/referral', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	beforeEach(async () => {
		await harness.reset();
		await getInstanceConfigRepository().updateReferralConfig(() => ({enabled: true, min_active_days: 5, tiers: []}));
	});

	afterAll(async () => {
		await harness?.shutdown();
	});

	async function getMe(token: string) {
		return createBuilder<ReferralMeResponse>(harness, token).get('/users/@me/referral').execute();
	}

	it('counts from KV with Cassandra base', async () => {
		const account = await createTestAccount(harness);
		const id = createUserID(BigInt(account.userId));
		await getReferralRepository().writeStatsField(id, 'valid_count', 4);
		await getReferralRepository().writeStatsField(id, 'pending_count', 2);
		await getKVCounterService().add(REFERRAL_VALID_COUNTER, account.userId, 1);

		const me = await getMe(account.token);
		expect(me.counts).toEqual({valid: 5, pending: 2, rejected: 0});
		expect(me.min_active_days).toBe(5);
	});

	it('only enabled tiers sorted', async () => {
		await getInstanceConfigRepository().updateReferralConfig(() => ({
			tiers: [
				tier('1490000000000000910', 10, true),
				tier('1490000000000000903', 3, true),
				tier('1490000000000000905', 5, false),
			],
		}));
		const account = await createTestAccount(harness);
		expect((await getMe(account.token)).tiers).toEqual([
			{id: '1490000000000000903', threshold: 3, reward: {type: 'premium_days', days: 3}},
			{id: '1490000000000000910', threshold: 10, reward: {type: 'premium_days', days: 10}},
		]);
	});

	it('offsite code shown only when delivered with code', async () => {
		const account = await createTestAccount(harness);
		const id = createUserID(BigInt(account.userId));
		const base: ReferralRewardRow = {
			user_id: id,
			tier_id: 1n,
			reward: JSON.stringify({type: 'offsite', description: 'Gift card'}),
			status: 'pending_admin',
			granted_at: GRANTED_AT,
			delivered_at: null,
			delivered_by: null,
			note: 'staff only',
			code: null,
		};
		await getReferralRepository().claimReward(base);
		await getReferralRepository().claimReward({
			...base,
			tier_id: 2n,
			status: 'delivered',
			delivered_at: GRANTED_AT,
			delivered_by: createUserID(9n),
			code: 'GIFT-CODE-42',
		});
		await getReferralRepository().claimReward({
			...base,
			tier_id: 3n,
			reward: JSON.stringify({type: 'premium_days', days: 7}),
			status: 'auto_delivered',
		});

		const me = await getMe(account.token);
		expect(me.rewards).toEqual([
			{
				tier_id: '1',
				reward: {type: 'offsite', description: 'Gift card'},
				status: 'pending_admin',
				granted_at: GRANTED_AT.toISOString(),
				delivered_at: null,
				code: null,
			},
			{
				tier_id: '2',
				reward: {type: 'offsite', description: 'Gift card'},
				status: 'delivered',
				granted_at: GRANTED_AT.toISOString(),
				delivered_at: GRANTED_AT.toISOString(),
				code: 'GIFT-CODE-42',
			},
			{
				tier_id: '3',
				reward: {type: 'premium_days', days: 7},
				status: 'auto_delivered',
				granted_at: GRANTED_AT.toISOString(),
				delivered_at: null,
				code: null,
			},
		]);
		expect(JSON.stringify(me)).not.toContain('staff only');
	});

	it('no reg_ip/referrer ip anywhere', async () => {
		const referrer = await createTestAccount(harness, {ipAddress: '198.51.100.23'});
		const code = (await getMe(referrer.token)).code!;
		const attach = vi.spyOn(getReferralService(), 'attachAtRegistration');
		const referee = await createTestAccount(harness, {ipAddress: '203.0.113.99'});
		// createTestAccount does not send referral_code; attach the referral the way registration does.
		await getReferralService().attachAtRegistration({
			refereeId: createUserID(BigInt(referee.userId)),
			code,
			ip: '203.0.113.99',
			riskBlocked: false,
			now: new Date(),
		});
		await Promise.allSettled(attach.mock.results.map((result) => result.value));
		attach.mockRestore();

		for (const account of [referrer, referee]) {
			const text = JSON.stringify(await getMe(account.token));
			expect(text).not.toContain('203.0.113.99');
			expect(text).not.toContain('198.51.100.23');
			expect(text).not.toMatch(/"(reg_)?ip"/);
		}
		expect((await getMe(referrer.token)).counts.pending).toBe(1);
	});

	it('closed programme still shows counts and rewards, without a code', async () => {
		await getInstanceConfigRepository().updateReferralConfig(() => ({enabled: false}));
		const account = await createTestAccount(harness);
		await getReferralRepository().writeStatsField(createUserID(BigInt(account.userId)), 'valid_count', 3);
		const me = await getMe(account.token);
		expect(me).toMatchObject({enabled: false, code: null, counts: {valid: 3, pending: 0, rejected: 0}});
		await createBuilderWithoutAuth(harness).get('/users/@me/referral').expect(401).execute();
	});
});
