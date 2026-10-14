// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {SHOP_ORDER_COLUMNS} from '@app/api/database/types/ShopTypes';
import {getShopOrderRepository} from '@app/api/middleware/ServiceSingletons';
import {createCallbackToken} from '@app/api/payriff/PayriffCallbackToken';
import {createShopAdmin, openShop, saveShopEnvironment, setPrices} from '@app/api/shop/tests/ShopTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {fakePayriffServer} from '@app/api/test/Setup';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {collectUserHarvestExtensions, runUserDeletionHook} from '@app/api/user/lifecycle/UserLifecycleHooks';
import verifyShopOrder from '@app/api/worker/tasks/VerifyShopOrder';
import type {ShopOrderResponse} from '@fluxer/schema/src/domains/shop/ShopResponseSchemas';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

const HELPERS = {
	logger: new NoopLogger(),
	jobId: 1n,
	addJob: async () => 0n,
	reportProgress: async () => {},
	shouldCancel: async () => false,
	setContextLink: async () => {},
};
const EXPORTED_FIELDS = [
	'order_id',
	'sku',
	'status',
	'failure_reason',
	'base_try_minor',
	'campaign_percent',
	'premium_percent',
	'final_try_minor',
	'currency',
	'provider',
	'provider_order_id',
	'created_at',
	'paid_at',
	'granted_at',
];

describe('shop orders in the data export and account deletion', () => {
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
		admin = await createShopAdmin(harness);
		user = await createTestAccount(harness);
		userId = createUserID(BigInt(user.userId));
	});

	afterAll(async () => {
		await harness?.shutdown();
		restoreEnvironment();
	});

	async function grantedOrder(): Promise<ShopOrderResponse> {
		await openShop(harness, admin);
		await setPrices(harness, admin, {'premium:1': 500});
		const order = await createBuilder<ShopOrderResponse>(harness, user.token)
			.post('/shop/orders')
			.body({sku: 'premium:1'})
			.expect(200)
			.execute();
		fakePayriffServer.setStatus('payriff-order-1', 'APPROVED');
		await verifyShopOrder({orderId: order.id, trigger: 'callback'}, HELPERS);
		return order;
	}

	async function exported() {
		const extensions = await collectUserHarvestExtensions({userId});
		return extensions.find((extension) => extension.name === 'shop')?.data as {
			orders: Array<Record<string, unknown>>;
		};
	}

	it('exports orders without payment URL or token', async () => {
		const order = await grantedOrder();
		const row = (await getShopOrderRepository().find(BigInt(order.id)))!;

		const {orders} = await exported();

		expect(orders).toHaveLength(1);
		expect(Object.keys(orders[0]!).sort()).toEqual([...EXPORTED_FIELDS].sort());
		expect(orders[0]).toMatchObject({
			order_id: order.id,
			sku: 'premium:1',
			status: 'granted',
			failure_reason: null,
			final_try_minor: 500,
			currency: 'TRY',
			provider: 'payriff',
			provider_order_id: 'payriff-order-1',
			created_at: row.created_at.toISOString(),
			paid_at: row.paid_at!.toISOString(),
			granted_at: row.granted_at!.toISOString(),
		});
		const text = JSON.stringify(orders);
		expect(text).not.toContain(row.callback_token_hash);
		expect(text).not.toContain('pay.payriff.test');
	});

	it('exports every order of a busy account, newest first', async () => {
		const created = new Date('2026-10-15T12:00:00.000Z');
		const ids = Array.from({length: 101}, (_, i) => 1490000000000000100n + BigInt(i));
		for (const id of ids) {
			await getShopOrderRepository().create({
				order_id: id,
				user_id: userId,
				sku: 'premium:1',
				item_id: null,
				item_ids: null,
				premium_months: 1,
				base_try_minor: 500,
				campaign_percent: 0,
				premium_percent: 0,
				amount_minor: 500,
				currency: 'TRY',
				status: 'failed',
				failure_reason: 'provider_error',
				provider: 'payriff',
				provider_order_id: null,
				provider_status: null,
				payment_url: null,
				callback_token_hash: createCallbackToken().hash,
				check_count: 0,
				next_check_at: null,
				created_at: created,
				updated_at: created,
				paid_at: null,
				granted_at: null,
				version: 1,
			});
		}

		const {orders} = await exported();

		expect(orders.map((order) => order.order_id)).toEqual(ids.map(String).reverse());
	});

	it('account deletion keeps the orders and writes no personal field', async () => {
		const order = await grantedOrder();
		for (const personal of ['email', 'username', 'global_name', 'name', 'ip', 'phone', 'address']) {
			expect(SHOP_ORDER_COLUMNS as ReadonlyArray<string>).not.toContain(personal);
		}

		await expect(runUserDeletionHook('shop', {userId})).rejects.toThrow('Unknown user deletion hook shop');
		await runUserDeletionHook('cosmetics', {userId});

		expect((await getShopOrderRepository().find(BigInt(order.id)))?.status).toBe('granted');
		expect((await getShopOrderRepository().listForUser(userId, 10)).map((entry) => `${entry.order_id}`)).toEqual([
			order.id,
		]);
		expect((await exported()).orders).toHaveLength(1);
	});
});

describe('the shop data export without a usable Payriff client', () => {
	let harness: ApiTestHarness;
	let payriffBaseUrl: string;

	beforeAll(async () => {
		payriffBaseUrl = Config.payriff.baseUrl;
		// The harness builds the services afresh, so the Payriff client would be built from this URL, and refuse it.
		Config.payriff.baseUrl = 'http://payriff.invalid/api/v3';
		harness = await createApiTestHarness();
	});

	afterAll(async () => {
		await harness?.shutdown();
		Config.payriff.baseUrl = payriffBaseUrl;
	});

	it('still exports the orders', async () => {
		const userId = createUserID(BigInt((await createTestAccount(harness)).userId));
		const created = new Date('2026-10-15T12:00:00.000Z');
		await getShopOrderRepository().create({
			order_id: 1490000000000000500n,
			user_id: userId,
			sku: 'premium:1',
			item_id: null,
			item_ids: null,
			premium_months: 1,
			base_try_minor: 500,
			campaign_percent: 0,
			premium_percent: 0,
			amount_minor: 500,
			currency: 'TRY',
			status: 'granted',
			failure_reason: null,
			provider: 'payriff',
			provider_order_id: 'payriff-order-1',
			provider_status: 'APPROVED',
			payment_url: null,
			callback_token_hash: createCallbackToken().hash,
			check_count: 0,
			next_check_at: null,
			created_at: created,
			updated_at: created,
			paid_at: created,
			granted_at: created,
			version: 1,
		});

		const extensions = await collectUserHarvestExtensions({userId});

		const shop = extensions.find((extension) => extension.name === 'shop')?.data as {
			orders: Array<Record<string, unknown>>;
		};
		expect(shop.orders.map((order) => order.order_id)).toEqual(['1490000000000000500']);
	});
});
