// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, setUserACLs, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {Config} from '@app/api/Config';
import {getAdminRepository} from '@app/api/middleware/ServiceSingletons';
import {createShopAdmin, openShop, saveShopEnvironment, setPrices} from '@app/api/shop/tests/ShopTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {fakePayriffServer} from '@app/api/test/Setup';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import type {ShopAdminOrderResponse} from '@fluxer/schema/src/domains/shop/ShopAdminSchemas';
import type {ShopOrderResponse} from '@fluxer/schema/src/domains/shop/ShopResponseSchemas';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

describe('admin shop order view', () => {
	let harness: ApiTestHarness;
	let restoreEnvironment: () => void;
	let admin: TestAccount;
	let user: TestAccount;

	beforeAll(async () => {
		restoreEnvironment = saveShopEnvironment();
		Config.instance.selfHosted = true;
		harness = await createApiTestHarness();
	});

	beforeEach(async () => {
		await harness.reset();
		admin = await createShopAdmin(harness);
		user = await createTestAccount(harness);
	});

	afterAll(async () => {
		await harness?.shutdown();
		restoreEnvironment();
	});

	async function openOrder(): Promise<ShopOrderResponse> {
		await openShop(harness, admin);
		await setPrices(harness, admin, {'premium:1': 500});
		return createBuilder<ShopOrderResponse>(harness, user.token)
			.post('/shop/orders')
			.body({sku: 'premium:1'})
			.expect(200)
			.execute();
	}

	it('shows an order to SHOP_MANAGE with its Payriff reference and records the read', async () => {
		const created = await openOrder();
		fakePayriffServer.reset();

		const view = await createBuilder<ShopAdminOrderResponse>(harness, admin.token)
			.get(`/admin/shop/orders/${created.id}`)
			.execute();

		const {payment_url: _paymentUrl, ...shared} = created;
		expect(view).toEqual({
			...shared,
			user_id: user.userId,
			provider_order_id: 'payriff-order-1',
			provider_status: null,
			paid_at: null,
			granted_at: null,
			check_count: 0,
		});
		expect(view).not.toHaveProperty('payment_url');
		expect(fakePayriffServer.calls()).toEqual([]);
		const logs = await getAdminRepository().listAllAuditLogsPaginated(100);
		const read = logs.find((log) => log.action === 'view_shop_order');
		expect(read?.targetType).toBe('shop_order');
		expect(read?.targetId.toString()).toBe(created.id);
		expect(Object.fromEntries(read?.metadata ?? [])).toEqual({order_id: created.id});
	});

	it('refuses COSMETICS_MANAGE alone', async () => {
		const created = await openOrder();
		const cosmeticsAdmin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.COSMETICS_MANAGE,
		]);

		await createBuilder(harness, cosmeticsAdmin.token)
			.get(`/admin/shop/orders/${created.id}`)
			.expect(403, APIErrorCodes.MISSING_ACL)
			.execute();
	});

	it('answers 404 for an unknown order and 400 for an ID above int64', async () => {
		await createBuilder(harness, admin.token)
			.get('/admin/shop/orders/1490000000000000001')
			.expect(404, APIErrorCodes.NOT_FOUND)
			.execute();
		await createBuilder(harness, admin.token).get('/admin/shop/orders/9223372036854775808').expect(400).execute();
	});
});
