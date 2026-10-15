// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, setUserACLs, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {BadgeRepository} from '@app/api/badge/BadgeRepository';
import {Config} from '@app/api/Config';
import type {ShopOrderRow} from '@app/api/database/types/ShopTypes';
import {getWorkerService} from '@app/api/middleware/ServiceRegistry';
import {
	getBadgeRepository,
	getEarlyPlusBadgeService,
	getPremiumLedgerService,
	getShopOrderRepository,
	getUserRepository,
	getVisionaryService,
} from '@app/api/middleware/ServiceSingletons';
import {clearVisionarySlots} from '@app/api/premium/visionary/tests/VisionaryTestUtils';
import {createShopItem, openShop, saveShopEnvironment, setPrices} from '@app/api/shop/tests/ShopTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {fakePayriffServer} from '@app/api/test/Setup';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import backfillEarlyPlusBadges from '@app/api/worker/tasks/BackfillEarlyPlusBadges';
import verifyShopOrder from '@app/api/worker/tasks/VerifyShopOrder';
import {findLaneForTask, validateLaneCompleteness} from '@app/api/worker/WorkerLaneConfig';
import {workerTasks} from '@app/api/worker/WorkerTaskRegistry';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {PremiumFlags, UserFlags, UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import type {ShopAdminSettingsResponse} from '@fluxer/schema/src/domains/shop/ShopAdminSchemas';
import type {ShopOrderResponse} from '@fluxer/schema/src/domains/shop/ShopResponseSchemas';
import {JobCancelledError, type WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const HELPERS: WorkerTaskHelpers = {
	logger: new NoopLogger(),
	jobId: 1n,
	addJob: async () => 0n,
	reportProgress: async () => {},
	shouldCancel: async () => false,
	setContextLink: async () => {},
};

let nextBadgeId = 9_100_000_000_000_000_000n;
let nextOrderId = 9_200_000_000_000_000_000n;

describe('Early Plus badge', () => {
	let harness: ApiTestHarness;
	let restoreEnvironment: () => void;
	let admin: TestAccount;
	let user: TestAccount;
	let userId: UserID;

	beforeAll(async () => {
		restoreEnvironment = saveShopEnvironment();
		Config.instance.selfHosted = true;
		harness = await createApiTestHarness();
	});

	beforeEach(async () => {
		await harness.reset();
		admin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.SHOP_MANAGE,
			AdminACLs.BADGES_MANAGE,
			AdminACLs.COSMETICS_MANAGE,
			AdminACLs.INSTANCE_CONFIG_VIEW,
			AdminACLs.INSTANCE_CONFIG_UPDATE,
			AdminACLs.USER_UPDATE_FLAGS,
		]);
		user = await createTestAccount(harness);
		userId = createUserID(BigInt(user.userId));
	});

	afterEach(() => vi.restoreAllMocks());

	afterAll(async () => {
		await harness?.shutdown();
		restoreEnvironment();
	});

	async function createBadge(description: string): Promise<string> {
		const badgeId = nextBadgeId++;
		await getBadgeRepository().upsertBadge({
			badge_id: badgeId,
			icon_hash: 'abcd1234',
			description,
			created_at: new Date(),
			version: 1,
		});
		return badgeId.toString();
	}

	function patchSettings(body: Record<string, unknown>, status = 200, token = admin.token) {
		return createBuilder<ShopAdminSettingsResponse>(harness, token)
			.patch('/admin/shop/settings')
			.body(body)
			.expect(status)
			.execute();
	}

	async function openEarlyPlus(): Promise<string> {
		const badgeId = await createBadge('Early Plus');
		await patchSettings({early_plus_badge_id: badgeId, early_plus_open: true});
		return badgeId;
	}

	async function badgesOf(id: UserID = userId): Promise<Array<string>> {
		return (await getBadgeRepository().listUserBadges(id)).map((row) => row.badge_id.toString());
	}

	function createOrder(sku: string, account = user) {
		return createBuilder<ShopOrderResponse>(harness, account.token)
			.post('/shop/orders')
			.body({sku})
			.expect(200)
			.execute();
	}

	async function payAndVerify(orderId: string): Promise<void> {
		const row = (await getShopOrderRepository().find(BigInt(orderId)))!;
		fakePayriffServer.setStatus(row.provider_order_id!, 'APPROVED');
		await verifyShopOrder({orderId, trigger: 'callback'}, HELPERS);
	}

	async function buyPremium(account = user): Promise<string> {
		await openShop(harness, admin);
		await setPrices(harness, admin, {'premium:1': 500});
		const order = await createOrder('premium:1', account);
		await payAndVerify(order.id);
		return order.id;
	}

	async function buyVisionary(account = user): Promise<string> {
		await openShop(harness, admin, {visionary_on_sale: true});
		await setPrices(harness, admin, {visionary: 5000});
		await clearVisionarySlots();
		await getVisionaryService().setTotal(3);
		const order = await createOrder('visionary', account);
		await payAndVerify(order.id);
		return order.id;
	}

	async function orderStatus(orderId: string) {
		return (await getShopOrderRepository().find(BigInt(orderId)))?.status;
	}

	// A stored order as delivery would leave it, without going through Payriff.
	async function storeOrder(owner: UserID, sku: string, status: ShopOrderRow['status']): Promise<void> {
		const now = new Date();
		const created = await getShopOrderRepository().create({
			order_id: nextOrderId++,
			user_id: owner,
			sku,
			item_id: null,
			item_ids: null,
			premium_months: sku.startsWith('premium:') ? 1 : null,
			base_try_minor: 500,
			campaign_percent: 0,
			premium_percent: 0,
			amount_minor: 500,
			currency: 'TRY',
			status,
			failure_reason: status === 'failed' ? 'amount_mismatch' : null,
			provider: 'payriff',
			provider_order_id: null,
			provider_status: null,
			payment_url: null,
			callback_token_hash: 'hash',
			check_count: 0,
			next_check_at: null,
			created_at: now,
			updated_at: now,
			paid_at: status === 'granted' ? now : null,
			granted_at: status === 'granted' ? now : null,
			version: 1,
		});
		expect(created).toBe(true);
	}

	async function newUser(): Promise<UserID> {
		return createUserID(BigInt((await createTestAccount(harness)).userId));
	}

	async function makeVisionary(id: UserID): Promise<void> {
		const account = (await getUserRepository().findUnique(id))!;
		await getUserRepository().patchUpsert(id, {premium_type: UserPremiumTypes.LIFETIME}, account.toRow());
	}

	async function refundMarked(id: UserID = userId): Promise<boolean> {
		const account = (await getUserRepository().findUnique(id))!;
		return (account.premiumFlags & PremiumFlags.EARLY_PLUS_REFUNDED) !== 0;
	}

	function endPremium(id: UserID, status = 200) {
		return createBuilder(harness, admin.token).post(`/admin/users/${id}/premium/end`).expect(status).execute();
	}

	function backfillJobs(addJob: {mock: {calls: Array<Array<unknown>>}}) {
		return addJob.mock.calls.filter(([task]) => task === 'backfillEarlyPlusBadges');
	}

	it('runs the backfill on the lifecycle lane', () => {
		expect(findLaneForTask('backfillEarlyPlusBadges')).toBe('lifecycle');
		expect(() => validateLaneCompleteness(workerTasks)).not.toThrow();
	});

	describe('settings', () => {
		it('starts closed with no badge and stores both fields under the shop settings', async () => {
			const badgeId = await createBadge('Early Plus');

			expect(await patchSettings({item_sales_open: false})).toMatchObject({
				early_plus_badge_id: null,
				early_plus_open: false,
				early_plus_opened_once: false,
			});
			expect(await patchSettings({early_plus_badge_id: badgeId, early_plus_open: true})).toMatchObject({
				early_plus_badge_id: badgeId,
				early_plus_open: true,
				early_plus_opened_once: true,
			});
			expect(await patchSettings({early_plus_open: false})).toMatchObject({
				early_plus_open: false,
				early_plus_opened_once: true,
			});
		});

		it('choosing the badge and opening need BADGES_MANAGE; closing needs SHOP_MANAGE only', async () => {
			const badgeId = await createBadge('Early Plus');
			const shopOnly = await setUserACLs(harness, await createTestAccount(harness), [
				AdminACLs.AUTHENTICATE,
				AdminACLs.SHOP_MANAGE,
			]);

			for (const body of [{early_plus_badge_id: badgeId}, {early_plus_badge_id: null}, {early_plus_open: true}]) {
				await createBuilder(harness, shopOnly.token)
					.patch('/admin/shop/settings')
					.body(body)
					.expect(403, APIErrorCodes.MISSING_ACL)
					.execute();
			}
			await patchSettings({early_plus_badge_id: badgeId, early_plus_open: true});

			expect(await patchSettings({early_plus_open: false}, 200, shopOnly.token)).toMatchObject({
				early_plus_open: false,
			});
			expect(await patchSettings({item_sales_open: true}, 200, shopOnly.token)).toMatchObject({item_sales_open: true});
		});

		it('needs SHOP_MANAGE', async () => {
			const badgeId = await createBadge('Early Plus');
			const outsider = await setUserACLs(harness, await createTestAccount(harness), [
				AdminACLs.AUTHENTICATE,
				AdminACLs.BADGES_MANAGE,
			]);

			await createBuilder(harness, outsider.token)
				.patch('/admin/shop/settings')
				.body({early_plus_badge_id: badgeId, early_plus_open: true})
				.expect(403, APIErrorCodes.MISSING_ACL)
				.execute();
		});

		it('refuses a numbered badge, an unknown badge and opening without a badge', async () => {
			const numbered = await createBadge('Öncü #{n}');

			await patchSettings({early_plus_badge_id: numbered}, 400);
			await patchSettings({early_plus_badge_id: '1490000000000000001'}, 400);
			await patchSettings({early_plus_open: true}, 400);
		});

		it('changes the badge freely before the first opening and never after it', async () => {
			const draft = await createBadge('Draft');
			await patchSettings({early_plus_badge_id: draft});
			const first = await openEarlyPlus();
			const second = await createBadge('Erken Plus');

			await patchSettings({early_plus_badge_id: second}, 400);
			await patchSettings({early_plus_badge_id: null}, 400);
			await patchSettings({early_plus_open: false});
			await patchSettings({early_plus_badge_id: second}, 400);
			await patchSettings({early_plus_badge_id: null}, 400);

			expect(await patchSettings({early_plus_badge_id: first})).toMatchObject({early_plus_badge_id: first});
		});

		it('queues the backfill on every open request, one job per minute key', async () => {
			const addJob = vi.spyOn(getWorkerService(), 'addJob');
			const badgeId = await createBadge('Early Plus');

			await patchSettings({early_plus_badge_id: badgeId});
			expect(backfillJobs(addJob)).toEqual([]);

			await patchSettings({early_plus_open: true});
			await patchSettings({early_plus_open: true});
			await patchSettings({item_sales_open: true});
			await patchSettings({early_plus_open: false});

			const queued = expect.objectContaining({
				jobKey: expect.stringMatching(/^backfillEarlyPlusBadges_\d+$/),
				requireLedger: true,
			});
			expect(backfillJobs(addJob)).toEqual([
				['backfillEarlyPlusBadges', {}, queued],
				['backfillEarlyPlusBadges', {}, queued],
			]);
		});
	});

	describe('delivery', () => {
		it('a paid premium order gives the badge while open', async () => {
			const badgeId = await openEarlyPlus();

			const orderId = await buyPremium();

			expect(await orderStatus(orderId)).toBe('granted');
			expect(await badgesOf()).toEqual([badgeId]);
		});

		it('a paid Visionary order gives the badge while open', async () => {
			const badgeId = await openEarlyPlus();

			const orderId = await buyVisionary();

			expect(await orderStatus(orderId)).toBe('granted');
			expect(await badgesOf()).toEqual([badgeId]);
		});

		it('gives nothing while closed, even with a badge chosen', async () => {
			await patchSettings({early_plus_badge_id: await createBadge('Early Plus')});

			await buyPremium();

			expect(await badgesOf()).toEqual([]);
		});

		it('gives nothing after closing; badges already given stay', async () => {
			const badgeId = await openEarlyPlus();
			await buyPremium();
			await patchSettings({early_plus_open: false});
			const later = await createTestAccount(harness);

			await buyPremium(later);

			expect(await badgesOf()).toEqual([badgeId]);
			expect(await badgesOf(createUserID(BigInt(later.userId)))).toEqual([]);
		});

		it('two paid orders of one account leave one badge row', async () => {
			const badgeId = await openEarlyPlus();

			await buyPremium();
			await buyPremium();

			expect(await badgesOf()).toEqual([badgeId]);
		});

		it('a cosmetic order gives no badge', async () => {
			await openEarlyPlus();
			await openShop(harness, admin);
			const item = await createShopItem(harness, admin, 'owned', 'Crown');
			await setPrices(harness, admin, {[`cosmetic:${item.id}`]: 300});

			const order = await createOrder(`cosmetic:${item.id}`);
			await payAndVerify(order.id);

			expect(await orderStatus(order.id)).toBe('granted');
			expect(await badgesOf()).toEqual([]);
		});

		it.each(['gift', 'admin', 'trial', 'referral'] as const)('a %s premium grant gives no badge', async (source) => {
			await openEarlyPlus();

			await getPremiumLedgerService().grant({
				userId,
				grantKey: `${source}-1`,
				duration: {unit: 'months', quantity: 1},
				source,
			});

			expect(await badgesOf()).toEqual([]);
		});

		it('an admin Visionary grant gives no badge', async () => {
			await openEarlyPlus();
			await clearVisionarySlots();
			await getVisionaryService().setTotal(3);

			await getVisionaryService().adminGrant(userId);

			expect(await badgesOf()).toEqual([]);
		});

		it('a premium order paid by an account that became a Visionary meanwhile gives no badge', async () => {
			await openEarlyPlus();
			await openShop(harness, admin);
			await setPrices(harness, admin, {'premium:1': 500});
			const order = await createOrder('premium:1');
			await clearVisionarySlots();
			await getVisionaryService().setTotal(3);
			await getVisionaryService().adminGrant(userId);

			await payAndVerify(order.id);

			expect(await orderStatus(order.id)).toBe('granted');
			expect(await badgesOf()).toEqual([]);
		});

		it('a Visionary order paid by an account that already is a Visionary gives no badge', async () => {
			await openEarlyPlus();
			await openShop(harness, admin, {visionary_on_sale: true});
			await setPrices(harness, admin, {visionary: 5000});
			await clearVisionarySlots();
			await getVisionaryService().setTotal(3);
			const order = await createOrder('visionary');
			await getVisionaryService().adminGrant(userId);

			await payAndVerify(order.id);

			expect(await orderStatus(order.id)).toBe('granted');
			expect(await badgesOf()).toEqual([]);
		});

		it('a failed badge write leaves the order paid for the retry, never failed', async () => {
			const badgeId = await openEarlyPlus();
			await openShop(harness, admin);
			await setPrices(harness, admin, {'premium:1': 500});
			const order = await createOrder('premium:1');
			vi.spyOn(BadgeRepository.prototype, 'grantUserBadge').mockRejectedValueOnce(new Error('timeout'));

			await expect(payAndVerify(order.id)).rejects.toThrow('timeout');
			expect(await orderStatus(order.id)).toBe('paid');

			await verifyShopOrder({orderId: order.id, trigger: 'callback'}, HELPERS);

			expect(await orderStatus(order.id)).toBe('granted');
			expect(await badgesOf()).toEqual([badgeId]);
		});
	});

	describe('refund', () => {
		it('ending paid premium takes the badge back; a later paid order while open gives it again', async () => {
			const badgeId = await openEarlyPlus();
			await buyPremium();

			await endPremium(userId);
			expect(await badgesOf()).toEqual([]);

			await buyPremium();
			expect(await badgesOf()).toEqual([badgeId]);
		});

		it('takes the badge back while closed too, and leaves other badges alone', async () => {
			const other = await createBadge('Supporter');
			await getBadgeRepository().grantUserBadge({user_id: userId, badge_id: BigInt(other), granted_at: new Date()});
			await openEarlyPlus();
			await buyPremium();
			await patchSettings({early_plus_open: false});

			await endPremium(userId);

			expect(await badgesOf()).toEqual([other]);
		});

		it('taking Visionary back takes the badge back', async () => {
			await openEarlyPlus();
			await buyVisionary();

			await createBuilder(harness, admin.token).delete(`/admin/users/${userId}/visionary`).expect(200).execute();

			expect(await badgesOf()).toEqual([]);
			expect(await refundMarked()).toBe(true);
		});

		it('a refunded buyer gets nothing from the backfill until a new paid order', async () => {
			await patchSettings({early_plus_badge_id: await createBadge('Early Plus')});
			await buyPremium();
			await endPremium(userId);
			expect(await refundMarked()).toBe(true);
			await patchSettings({early_plus_open: true});

			await backfillEarlyPlusBadges({}, HELPERS);
			expect(await badgesOf()).toEqual([]);

			await buyPremium();
			expect(await refundMarked()).toBe(false);
			expect(await badgesOf()).toHaveLength(1);
		});

		it('a paid order while closed clears the refund mark, so the backfill counts it', async () => {
			const badgeId = await createBadge('Early Plus');
			await patchSettings({early_plus_badge_id: badgeId});
			await buyPremium();
			await endPremium(userId);
			await buyPremium();
			await patchSettings({early_plus_open: true});

			await backfillEarlyPlusBadges({}, HELPERS);

			expect(await badgesOf()).toEqual([badgeId]);
		});

		it('a refund that lands while the backfill gives the badge leaves no badge', async () => {
			const buyer = await newUser();
			await storeOrder(buyer, 'premium:1', 'granted');
			await openEarlyPlus();
			const grant = BadgeRepository.prototype.grantUserBadge;
			vi.spyOn(BadgeRepository.prototype, 'grantUserBadge').mockImplementationOnce(async function (
				this: BadgeRepository,
				row,
			) {
				await getEarlyPlusBadgeService().revoke(row.user_id);
				return grant.call(this, row);
			});

			await backfillEarlyPlusBadges({}, HELPERS);

			expect(await badgesOf(buyer)).toEqual([]);
		});
	});

	describe('backfill', () => {
		it('gives the badge to owners of delivered premium and Visionary orders only, once', async () => {
			const [premium, visionary, exVisionary, failed, pending, cosmetic, bundle, deleted] = await Promise.all(
				Array.from({length: 8}, () => newUser()),
			);
			await storeOrder(premium!, 'premium:3', 'granted');
			await storeOrder(premium!, 'premium:1', 'granted');
			await storeOrder(visionary!, 'visionary', 'granted');
			await makeVisionary(visionary!);
			await storeOrder(exVisionary!, 'visionary', 'granted');
			await storeOrder(failed!, 'premium:1', 'failed');
			await storeOrder(pending!, 'premium:12', 'pending');
			await storeOrder(cosmetic!, 'cosmetic:1490000000000000001', 'granted');
			await storeOrder(bundle!, 'bundle:1490000000000000002', 'granted');
			await storeOrder(deleted!, 'premium:1', 'granted');
			const account = (await getUserRepository().findUnique(deleted!))!;
			await getUserRepository().patchUpsert(deleted!, {flags: account.flags | UserFlags.DELETED}, account.toRow());
			const badgeId = await openEarlyPlus();

			await backfillEarlyPlusBadges({}, HELPERS);
			await backfillEarlyPlusBadges({}, HELPERS);

			expect(await badgesOf(premium)).toEqual([badgeId]);
			expect(await badgesOf(visionary)).toEqual([badgeId]);
			for (const none of [exVisionary, failed, pending, cosmetic, bundle, deleted]) {
				expect(await badgesOf(none)).toEqual([]);
			}
		});

		it('reports its progress and counts, and stops on a cancel', async () => {
			const buyer = await newUser();
			await storeOrder(buyer, 'premium:1', 'granted');
			await openEarlyPlus();
			const reportProgress = vi.fn(async () => {});

			await expect(
				backfillEarlyPlusBadges({}, {...HELPERS, reportProgress, shouldCancel: async () => true}),
			).rejects.toBeInstanceOf(JobCancelledError);
			expect(await badgesOf(buyer)).toEqual([]);

			const result = await backfillEarlyPlusBadges({}, {...HELPERS, reportProgress});

			expect(result).toEqual({granted: 1, scanned: 1, duration_ms: expect.any(Number)});
			expect(reportProgress).toHaveBeenCalledWith(1, null, expect.any(String));
		});

		it('gives nothing once the period is closed', async () => {
			const buyer = await newUser();
			await storeOrder(buyer, 'premium:1', 'granted');
			await openEarlyPlus();
			await patchSettings({early_plus_open: false});

			await backfillEarlyPlusBadges({}, HELPERS);

			expect(await badgesOf(buyer)).toEqual([]);
		});
	});
});
