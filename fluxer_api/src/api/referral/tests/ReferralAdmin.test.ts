// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	createTestAccount,
	findLastTestEmail,
	listTestEmails,
	setUserACLs,
	type TestAccount,
} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {getContentMessage} from '@app/api/content_i18n/ContentI18n';
import {referralPendingMonth} from '@app/api/database/types/ReferralTypes';
import {getAdminRepository, getReferralRepository, getUserRepository} from '@app/api/middleware/ServiceSingletons';
import {createShopItem} from '@app/api/shop/tests/ShopTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopWorkerService} from '@app/api/test/NoopWorkerService';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import type {
	AdminReferralPendingRewardsResponse,
	AdminReferralResponse,
	AdminReferralRewardResponse,
	AdminUserReferralsResponse,
	ReferralTierResponse,
} from '@fluxer/schema/src/domains/referral/ReferralResponseSchemas';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const OFFSITE = {type: 'offsite', description: 'Gift card'} as const;
const SECRET_CODE = 'Steam-Secret-7Q2';
const REG_IP = '203.0.113.77';
const DAY_MS = 86_400_000;

// What the grant job leaves for an off-site tier (the pending row's created_at is granted_at).
async function seedPendingReward(userId: string, tierId: string, grantedAt = new Date()): Promise<void> {
	const repository = getReferralRepository();
	const user = createUserID(BigInt(userId));
	await repository.claimReward({
		user_id: user,
		tier_id: BigInt(tierId),
		reward: JSON.stringify(OFFSITE),
		status: 'pending_admin',
		granted_at: grantedAt,
		delivered_at: null,
		delivered_by: null,
		note: null,
		code: null,
	});
	await repository.insertPendingReward({
		month: referralPendingMonth(grantedAt),
		created_at: grantedAt,
		user_id: user,
		tier_id: BigInt(tierId),
	});
}

function auditText(value: unknown): string {
	return JSON.stringify(value, (_key, entry) =>
		typeof entry === 'bigint' ? entry.toString() : entry instanceof Map ? Object.fromEntries(entry) : entry,
	);
}

describe('referral admin', () => {
	let harness: ApiTestHarness;
	let admin: TestAccount;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	beforeEach(async () => {
		await harness.reset();
		admin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.REFERRAL_MANAGE,
			AdminACLs.COSMETICS_MANAGE,
		]);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		await harness?.shutdown();
	});

	function view() {
		return createBuilder<AdminReferralResponse>(harness, admin.token).get('/admin/referral').expect(200).execute();
	}

	function patchSettings(body: Record<string, unknown>, status = 200) {
		return createBuilder<AdminReferralResponse>(harness, admin.token)
			.patch('/admin/referral/settings')
			.body(body)
			.expect(status)
			.execute();
	}

	function createTier(body: Record<string, unknown>, status = 200) {
		return createBuilder<ReferralTierResponse>(harness, admin.token)
			.post('/admin/referral/tiers')
			.body(body)
			.expect(status)
			.execute();
	}

	function updateTier(id: string, body: Record<string, unknown>, status = 200) {
		return createBuilder<ReferralTierResponse>(harness, admin.token)
			.patch(`/admin/referral/tiers/${id}`)
			.body(body)
			.expect(status)
			.execute();
	}

	function spyOnJobs(task: string) {
		const addJob = vi.spyOn(NoopWorkerService.prototype, 'addJob');
		return () =>
			(addJob.mock.calls as Array<Array<unknown>>).filter(([name]) => name === task).map(([, payload]) => payload);
	}

	async function auditEntries(action: string) {
		const logs = await getAdminRepository().listAllAuditLogsPaginated(1000);
		return logs
			.filter((log) => log.action === action)
			.map((log) => ({targetId: log.targetId.toString(), metadata: Object.fromEntries(log.metadata)}));
	}

	describe('settings', () => {
		it('starts closed with the defaults and no tiers', async () => {
			expect(await view()).toEqual({
				settings: {enabled: false, min_active_days: 3, daily_valid_cap: 50, ip_registration_limit: 3},
				tiers: [],
			});
		});

		it('settings PATCH persists + audit', async () => {
			const updated = await patchSettings({enabled: true, daily_valid_cap: 20});
			expect(updated.settings).toEqual({
				enabled: true,
				min_active_days: 3,
				daily_valid_cap: 20,
				ip_registration_limit: 3,
			});
			expect((await view()).settings).toEqual(updated.settings);
			expect(await auditEntries('update_referral_settings')).toEqual([
				{
					targetId: '0',
					metadata: {enabled_old: 'false', enabled_new: 'true', daily_valid_cap_old: '50', daily_valid_cap_new: '20'},
				},
			]);
		});
	});

	describe('tiers', () => {
		it('tier POST rejects non-owned cosmetic', async () => {
			const free = await createShopItem(harness, admin, 'free');
			const premium = await createShopItem(harness, admin, 'premium');
			await createTier({threshold: 3, reward: {type: 'cosmetic', item_id: free.id}}, 400);
			await createTier({threshold: 3, reward: {type: 'cosmetic', item_id: premium.id}}, 400);
			await createTier({threshold: 3, reward: {type: 'cosmetic', item_id: '1490000000000000001'}}, 400);
			expect((await view()).tiers).toEqual([]);

			const owned = await createShopItem(harness, admin, 'owned');
			const tier = await createTier({threshold: 3, reward: {type: 'cosmetic', item_id: owned.id}});
			expect(tier).toEqual({
				id: expect.any(String),
				threshold: 3,
				reward: {type: 'cosmetic', item_id: owned.id},
				enabled: true,
			});
			expect((await view()).tiers).toEqual([tier]);
		});

		it('tier POST enqueues backfill', async () => {
			const backfills = spyOnJobs('backfillReferralTier');
			const tier = await createTier({threshold: 5, reward: OFFSITE});
			expect(backfills()).toEqual([{tier_id: tier.id, admin_user_id: admin.userId}]);
			expect(await auditEntries('create_referral_tier')).toEqual([
				{targetId: tier.id, metadata: {threshold: '5', reward_type: 'offsite', enabled: 'true'}},
			]);

			await createTier({threshold: 7, reward: {type: 'premium_days', days: 30}, enabled: false});
			expect(backfills()).toHaveLength(1);
		});

		it('tier PATCH lowering threshold enqueues backfill, raising does not', async () => {
			const tier = await createTier({threshold: 5, reward: OFFSITE});
			const backfills = spyOnJobs('backfillReferralTier');

			expect(await updateTier(tier.id, {threshold: 8})).toEqual({...tier, threshold: 8});
			expect(backfills()).toEqual([]);

			await updateTier(tier.id, {threshold: 3});
			expect(backfills()).toEqual([{tier_id: tier.id, admin_user_id: admin.userId}]);

			await updateTier(tier.id, {enabled: false});
			await updateTier(tier.id, {threshold: 1});
			expect(backfills()).toHaveLength(1);

			await updateTier(tier.id, {enabled: true});
			expect(backfills()).toHaveLength(2);

			expect((await view()).tiers).toEqual([{...tier, threshold: 1}]);
			expect((await auditEntries('update_referral_tier')).map(({metadata}) => metadata)).toEqual(
				expect.arrayContaining([
					{threshold_old: '5', threshold_new: '8'},
					{threshold_old: '8', threshold_new: '3'},
					{enabled_old: 'true', enabled_new: 'false'},
				]),
			);
		});

		it('tier PATCH cannot change the reward and 404s an unknown tier', async () => {
			const tier = await createTier({threshold: 5, reward: OFFSITE});
			await updateTier(tier.id, {reward: {type: 'premium_days', days: 1}}, 400);
			await updateTier('1490000000000000001', {threshold: 2}, 404);
		});
	});

	describe('pending rewards', () => {
		it('pending list pages within month', async () => {
			const tier = await createTier({threshold: 1, reward: OFFSITE});
			const october = new Date('2026-10-05T12:00:00Z');
			const users = [
				await createTestAccount(harness),
				await createTestAccount(harness),
				await createTestAccount(harness),
			];
			for (const [index, user] of users.entries()) {
				await seedPendingReward(user.userId, tier.id, new Date(october.getTime() + index * 1000));
			}
			await seedPendingReward(admin.userId, tier.id, new Date('2026-09-30T12:00:00Z'));

			const list = (query: string) =>
				createBuilder<AdminReferralPendingRewardsResponse>(harness, admin.token)
					.get(`/admin/referral/pending-rewards?${query}`)
					.expect(200)
					.execute();
			const first = await list('month=2026-10&limit=2');
			expect(first.month).toBe('2026-10');
			expect(first.items).toEqual(
				users.slice(0, 2).map((user, index) => ({
					user_id: user.userId,
					tier_id: tier.id,
					reward: OFFSITE,
					created_at: new Date(october.getTime() + index * 1000).toISOString(),
				})),
			);
			expect(first.next_cursor).not.toBeNull();
			const second = await list(`month=2026-10&limit=2&cursor=${encodeURIComponent(first.next_cursor!)}`);
			expect(second.items.map((item) => item.user_id)).toEqual([users[2]!.userId]);
			expect(second.next_cursor).toBeNull();
			expect((await list('month=2026-09')).items.map((item) => item.user_id)).toEqual([admin.userId]);
			expect((await list('')).month).toBe(new Date().toISOString().slice(0, 7));
			expect(await auditEntries('view_referral_pending_rewards')).toContainEqual({
				targetId: '0',
				metadata: {month: '2026-10', result_count: '2'},
			});
		});
	});

	describe('deliver and notify', () => {
		let referrer: TestAccount;
		let tierId: string;

		beforeEach(async () => {
			referrer = await createTestAccount(harness);
			tierId = (await createTier({threshold: 1, reward: OFFSITE})).id;
			await seedPendingReward(referrer.userId, tierId);
		});

		function deliver(body: Record<string, unknown>, status = 200) {
			return createBuilder<AdminReferralRewardResponse>(harness, admin.token)
				.post(`/admin/users/${referrer.userId}/referral-rewards/${tierId}/deliver`)
				.body(body)
				.expect(status)
				.execute();
		}

		function notify(content: string, status = 204) {
			return createBuilder(harness, admin.token)
				.post(`/admin/users/${referrer.userId}/referral-rewards/${tierId}/notify`)
				.body({content})
				.expect(status)
				.execute();
		}

		async function reward() {
			const rows = await getReferralRepository().getRewards(createUserID(BigInt(referrer.userId)));
			return rows.find((row) => row.tier_id === BigInt(tierId));
		}

		it('deliver with code: status delivered, pending row gone, email sent without code, DM job without code, audit has_code true and no code text', async () => {
			const dms = spyOnJobs('sendSystemDm');
			const response = await deliver({code: SECRET_CODE, note: 'sent by hand'});
			expect(response).toEqual({
				user_id: referrer.userId,
				tier_id: tierId,
				status: 'delivered',
				delivered_at: expect.any(String),
				has_code: true,
			});
			expect(JSON.stringify(response)).not.toContain(SECRET_CODE);
			expect(await reward()).toMatchObject({
				status: 'delivered',
				code: SECRET_CODE,
				note: 'sent by hand',
				delivered_by: BigInt(admin.userId),
			});
			const month = referralPendingMonth(new Date());
			expect((await getReferralRepository().listPendingRewards(month, null, 10)).items).toEqual([]);

			// CR7: Fluxer's content_i18n message in the referrer's locale, not a fixed text.
			const locale = (await getUserRepository().findUnique(createUserID(BigInt(referrer.userId))))?.locale;
			expect(dms()).toEqual([
				{content: getContentMessage('referral.reward_ready', locale), user_ids: [referrer.userId]},
			]);
			expect(JSON.stringify(dms()).toLowerCase()).not.toContain(SECRET_CODE.toLowerCase());

			const emails = await listTestEmails(harness, {recipient: referrer.email});
			expect(findLastTestEmail(emails, 'referral_reward_ready')).not.toBeNull();
			expect(JSON.stringify(emails)).not.toContain(SECRET_CODE);

			expect(await auditEntries('deliver_referral_reward')).toEqual([
				{targetId: referrer.userId, metadata: {tier_id: tierId, has_code: 'true', note: 'sent by hand'}},
			]);
			expect(auditText(await getAdminRepository().listAllAuditLogsPaginated(1000))).not.toContain(SECRET_CODE);
		});

		it('the reward ready message has tr and en text', () => {
			const en = getContentMessage('referral.reward_ready', 'en-US');
			expect(en).not.toBe('referral.reward_ready');
			expect(getContentMessage('referral.reward_ready', 'tr')).not.toBe(en);
		});

		it('deliver with a note carrying the code → 400, nothing stored (V9)', async () => {
			await deliver({code: SECRET_CODE, note: `kod: ${SECRET_CODE.toLowerCase()}`}, 400);
			expect(await reward()).toMatchObject({status: 'pending_admin', code: null, note: null});
			expect(auditText(await getAdminRepository().listAllAuditLogsPaginated(1000))).not.toContain(
				SECRET_CODE.toLowerCase(),
			);
		});

		it('deliver without a code sends nothing to the referrer', async () => {
			const dms = spyOnJobs('sendSystemDm');
			expect((await deliver({note: 'posted'})).has_code).toBe(false);
			expect(dms()).toEqual([]);
			const emails = await listTestEmails(harness, {recipient: referrer.email});
			expect(findLastTestEmail(emails, 'referral_reward_ready')).toBeNull();
		});

		it('deliver twice → conflict', async () => {
			await deliver({code: SECRET_CODE});
			await deliver({code: 'OTHER-CODE'}, 409);
			expect((await reward())?.code).toBe(SECRET_CODE);
			await createBuilder(harness, admin.token)
				.post(`/admin/users/${referrer.userId}/referral-rewards/1490000000000000001/deliver`)
				.body({})
				.expect(404)
				.execute();
		});

		it('notify containing the code → 400', async () => {
			await deliver({code: SECRET_CODE});
			const dms = spyOnJobs('sendSystemDm');
			await notify(`Kodun: ${SECRET_CODE.toUpperCase()}`, 400);
			expect(dms()).toEqual([]);
			await notify('Kodun ayarlarda.');
			expect(dms()).toEqual([{content: 'Kodun ayarlarda.', user_ids: [referrer.userId]}]);
			expect(auditText(await getAdminRepository().listAllAuditLogsPaginated(1000))).not.toContain(SECRET_CODE);
		});

		it('notify keeps pending_admin', async () => {
			const dms = spyOnJobs('sendSystemDm');
			const content = 'Referans ödülün için destek ekibimize yaz.';
			await notify(content);
			expect(dms()).toEqual([{content, user_ids: [referrer.userId]}]);
			expect((await reward())?.status).toBe('pending_admin');
			expect(await auditEntries('notify_referral_reward')).toEqual([
				{targetId: referrer.userId, metadata: {tier_id: tierId, content_length: String(content.length)}},
			]);
		});
	});

	describe('user referrals', () => {
		it('user referrals view pages referees and never returns ip or code', async () => {
			const repository = getReferralRepository();
			const referrer = createUserID(BigInt(admin.userId));
			const referredAt = new Date('2026-10-01T10:00:00Z');
			const referees = [1490000000000002001n, 1490000000000002002n, 1490000000000002003n].map((id) => createUserID(id));
			for (const [index, refereeId] of referees.entries()) {
				await repository.recordReferral(
					{
						refereeId,
						referrerId: referrer,
						referredAt: new Date(referredAt.getTime() + index * DAY_MS),
						regIp: REG_IP,
						riskBlocked: false,
					},
					{dueAt: new Date(referredAt.getTime() + 4 * DAY_MS), ttlSeconds: 20 * 86_400},
				);
			}
			await repository.insertCodeIfAbsent('abcdefghij', referrer, referredAt);
			await repository.setOwnCode(referrer, 'abcdefghij');
			const tier = await createTier({threshold: 1, reward: OFFSITE});
			await seedPendingReward(admin.userId, tier.id, referredAt);
			await createBuilder(harness, admin.token)
				.post(`/admin/users/${admin.userId}/referral-rewards/${tier.id}/deliver`)
				.body({code: SECRET_CODE, note: 'n'})
				.expect(200)
				.execute();

			const page = (cursor?: string) =>
				createBuilder<AdminUserReferralsResponse>(harness, admin.token)
					.get(`/admin/users/${admin.userId}/referrals?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
					.expect(200)
					.execute();
			const first = await page();
			expect(first).toMatchObject({
				user_id: admin.userId,
				code: 'abcdefghij',
				referrer_id: null,
				counts: {pending: 0, valid: 0, rejected: 0},
				rewards: [
					{
						tier_id: tier.id,
						reward: OFFSITE,
						status: 'delivered',
						delivered_by: admin.userId,
						note: 'n',
						has_code: true,
					},
				],
			});
			expect(first.referees).toEqual([
				{
					referee_id: '1490000000000002003',
					state: 'pending',
					reason: null,
					referred_at: new Date(referredAt.getTime() + 2 * DAY_MS).toISOString(),
				},
				{
					referee_id: '1490000000000002002',
					state: 'pending',
					reason: null,
					referred_at: new Date(referredAt.getTime() + DAY_MS).toISOString(),
				},
			]);
			const second = await page(first.next_cursor!);
			expect(second.referees.map((row) => row.referee_id)).toEqual(['1490000000000002001']);
			expect(second.next_cursor).toBeNull();

			const text = JSON.stringify([first, second]);
			expect(text).not.toContain(REG_IP);
			expect(text).not.toContain(SECRET_CODE);
			expect(text).not.toMatch(/"(reg_)?ip"/);
			expect(await auditEntries('view_user_referrals')).toContainEqual({
				targetId: admin.userId,
				metadata: {result_count: '2'},
			});
		});
	});
});
