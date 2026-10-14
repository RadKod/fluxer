// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, setUserACLs, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {getVisionaryService} from '@app/api/middleware/ServiceSingletons';
import {readUser, slotRows} from '@app/api/premium/visionary/tests/VisionaryTestUtils';
import {createShopAdmin, openShop, saveShopEnvironment, setPrices} from '@app/api/shop/tests/ShopTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import type {AdminVisionaryResponse} from '@fluxer/schema/src/domains/shop/ShopAdminSchemas';
import type {ShopCatalogResponse} from '@fluxer/schema/src/domains/shop/ShopResponseSchemas';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

describe('admin gives and takes back Visionary', () => {
	let harness: ApiTestHarness;
	let restoreEnvironment: () => void;
	let admin: TestAccount;

	beforeAll(async () => {
		restoreEnvironment = saveShopEnvironment();
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
		admin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.SHOP_MANAGE,
			AdminACLs.USER_UPDATE_FLAGS,
		]);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});
	afterAll(async () => {
		await harness?.shutdown();
		restoreEnvironment();
	});

	function give(
		userId: string,
		body: {slot?: number} = {},
		opts: {token?: string; status?: number; code?: string} = {},
	) {
		return createBuilder<AdminVisionaryResponse>(harness, opts.token ?? admin.token)
			.post(`/admin/users/${userId}/visionary`)
			.body(body)
			.expect(opts.status ?? HTTP_STATUS.OK, opts.code)
			.execute();
	}

	function takeBack(userId: string, opts: {token?: string; status?: number} = {}) {
		return createBuilder<AdminVisionaryResponse>(harness, opts.token ?? admin.token)
			.delete(`/admin/users/${userId}/visionary`)
			.expect(opts.status ?? HTTP_STATUS.OK)
			.execute();
	}

	async function lifetimeOf(userId: string): Promise<[number | null, number | null]> {
		const user = await readUser(createUserID(BigInt(userId)));
		return [user.premiumType, user.premiumLifetimeSequence];
	}

	it('needs both SHOP_MANAGE and USER_UPDATE_FLAGS', async () => {
		await getVisionaryService().setTotal(2);
		const member = await createTestAccount(harness);
		const shopOnly = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.SHOP_MANAGE,
		]);
		const flagsOnly = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.USER_UPDATE_FLAGS,
		]);

		for (const other of [shopOnly, flagsOnly]) {
			await give(member.userId, {}, {token: other.token, status: HTTP_STATUS.FORBIDDEN});
			await takeBack(member.userId, {token: other.token, status: HTTP_STATUS.FORBIDDEN});
		}

		expect(await lifetimeOf(member.userId)).toEqual([null, null]);
		expect((await slotRows()).map((row) => row.user_id ?? null)).toEqual([null, null]);
	});

	it('gives the lowest free number, or the one asked for', async () => {
		await getVisionaryService().setTotal(5);
		await getVisionaryService().holdForOrder(createUserID(1n), 77n);
		const first = await createTestAccount(harness);
		const second = await createTestAccount(harness);

		expect(await give(first.userId)).toEqual({user_id: first.userId, slot: 2, lifetime: true, changed: true});
		expect(await give(second.userId, {slot: 4})).toEqual({
			user_id: second.userId,
			slot: 4,
			lifetime: true,
			changed: true,
		});

		expect(await lifetimeOf(first.userId)).toEqual([UserPremiumTypes.LIFETIME, 2]);
		expect(await lifetimeOf(second.userId)).toEqual([UserPremiumTypes.LIFETIME, 4]);
		expect((await readUser(createUserID(BigInt(first.userId)))).hasEverPurchased).toBe(false);
		expect(await takeBack(second.userId)).toEqual({user_id: second.userId, slot: 4, lifetime: false, changed: true});
		expect(await lifetimeOf(second.userId)).toEqual([null, null]);
	});

	it('refuses a taken or unknown number with SHOP_ITEM_UNAVAILABLE', async () => {
		await getVisionaryService().setTotal(2);
		const first = await createTestAccount(harness);
		const second = await createTestAccount(harness);
		await give(first.userId, {slot: 1});
		const refused = {status: HTTP_STATUS.NOT_FOUND, code: APIErrorCodes.SHOP_ITEM_UNAVAILABLE};

		await give(second.userId, {slot: 1}, refused);
		await give(second.userId, {slot: 9}, refused);
		await give((await createTestAccount(harness)).userId, {slot: 2});
		await give(second.userId, {}, refused);

		expect(await lifetimeOf(second.userId)).toEqual([null, null]);
		await createBuilder(harness, admin.token)
			.post('/admin/users/1490000000000000001/visionary')
			.body({})
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_USER)
			.execute();
	});

	it('granting twice changes nothing the second time', async () => {
		await getVisionaryService().setTotal(3);
		const member = await createTestAccount(harness);

		expect(await give(member.userId)).toMatchObject({slot: 1, changed: true});
		expect(await give(member.userId, {slot: 3})).toEqual({
			user_id: member.userId,
			slot: 1,
			lifetime: true,
			changed: false,
		});

		expect((await slotRows()).map((row) => row.user_id?.toString() ?? null)).toEqual([member.userId, null, null]);
		expect(await getVisionaryService().getStock()).toMatchObject({sold: 1, remaining: 2});
	});

	it('the catalog shows Visionary stock from the numbers', async () => {
		vi.useFakeTimers({toFake: ['Date']});
		const shopAdmin = await createShopAdmin(harness);
		const viewer = await createTestAccount(harness);
		await openShop(harness, shopAdmin, {visionary_on_sale: true});
		await setPrices(harness, shopAdmin, {visionary: 29_900});
		await createBuilder(harness, shopAdmin.token).put('/admin/shop/visionary/slots').body({total: 3}).execute();
		const catalog = () => createBuilder<ShopCatalogResponse>(harness, viewer.token).get('/shop/catalog').execute();

		expect((await catalog()).visionary).toMatchObject({total: 3, remaining: 3, visible: true});

		await give((await createTestAccount(harness)).userId);
		expect((await catalog()).visionary).toMatchObject({total: 3, remaining: 3});
		vi.setSystemTime(Date.now() + 61_000);
		expect((await catalog()).visionary).toMatchObject({total: 3, remaining: 2});
	});
});
