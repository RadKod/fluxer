// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {SHOP_PRICE_CATALOG} from '@app/api/database/types/ShopTypes';
import {
	getCosmeticService,
	getPremiumLedgerService,
	getShopCatalogService,
	getShopPriceRepository,
	getUserRepository,
} from '@app/api/middleware/ServiceSingletons';
import {
	createShopAdmin,
	createShopItem,
	openShop,
	saveShopEnvironment,
	setPrices,
} from '@app/api/shop/tests/ShopTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder, createBuilderWithoutAuth} from '@app/api/test/TestRequestBuilder';
import {grantPremium} from '@app/api/user/tests/UserTestUtils';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import {PurchaseEmailVerificationRequiredError} from '@fluxer/errors/src/domains/auth/EmailVerificationRequiredError';
import {UnclaimedAccountCannotMakePurchasesError} from '@fluxer/errors/src/domains/user/UnclaimedAccountCannotMakePurchasesError';
import type {ShopCatalogResponse, ShopQuoteResponse} from '@fluxer/schema/src/domains/shop/ShopResponseSchemas';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

describe('shop quote and checkout checks', () => {
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

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		await harness?.shutdown();
		restoreEnvironment();
	});

	function quote(sku: string, account = user) {
		return createBuilder<ShopQuoteResponse>(harness, account.token).get(`/shop/quote?sku=${sku}`).execute();
	}

	function refuse(sku: string, status: number, code: string, account = user) {
		return createBuilder(harness, account.token).get(`/shop/quote?sku=${sku}`).expect(status, code).execute();
	}

	function catalog(account = user) {
		return createBuilder<ShopCatalogResponse>(harness, account.token).get('/shop/catalog').execute();
	}

	async function loadUser(account = user) {
		return (await getUserRepository().findUnique(createUserID(BigInt(account.userId))))!;
	}

	async function putStoredPrice(sku: string, base: number, campaignPercent: number | null = null) {
		await getShopPriceRepository().putPrices([
			{
				catalog: SHOP_PRICE_CATALOG,
				sku,
				base_try_minor: base,
				campaign_percent: campaignPercent,
				campaign_ends_at: null,
				updated_at: new Date(),
			},
		]);
	}

	it('quotes the list price and the amount charged, both in Turkish lira', async () => {
		await openShop(harness, admin);
		await setPrices(harness, admin, {'premium:3': 1300});

		expect(await quote('premium:3')).toEqual({
			sku: 'premium:3',
			base_try_minor: 1300,
			campaign_percent: 0,
			premium_percent: 0,
			final_try_minor: 1300,
			currency: 'TRY',
		});
	});

	it('a quote follows an admin price change within five seconds', async () => {
		vi.useFakeTimers({toFake: ['Date']});
		await openShop(harness, admin);
		await setPrices(harness, admin, {'premium:1': 500});
		expect((await quote('premium:1')).final_try_minor).toBe(500);
		expect((await catalog()).packages[0]!.price.base_try_minor).toBe(500);

		await setPrices(harness, admin, {'premium:1': 700});
		vi.setSystemTime(Date.now() + 4_000);
		expect((await quote('premium:1')).final_try_minor).toBe(500);
		vi.setSystemTime(Date.now() + 2_000);
		expect((await quote('premium:1')).final_try_minor).toBe(700);
		expect((await catalog()).packages[0]!.price.base_try_minor).toBe(500);
		vi.setSystemTime(Date.now() + 55_000);
		expect((await catalog()).packages[0]!.price.base_try_minor).toBe(700);
	});

	it('prepareCheckout with direct reads sees a price change at once', async () => {
		await openShop(harness, admin);
		await setPrices(harness, admin, {'premium:1': 500});
		const service = getShopCatalogService();
		const buyer = await loadUser();
		expect((await service.quote(buyer, 'premium:1')).price.finalTryMinor).toBe(500);

		await setPrices(harness, admin, {'premium:1': 700});

		const direct = await service.prepareCheckout(buyer, 'premium:1', 'direct');
		expect(direct).toMatchObject({sku: 'premium:1', kind: 'premium', item: null, months: 1});
		expect(direct.price).toMatchObject({baseTryMinor: 700, finalTryMinor: 700});
		expect((await service.quote(buyer, 'premium:1')).price.finalTryMinor).toBe(500);
	});

	it('applies the premium discount only for paid premium accounts and only to items', async () => {
		await openShop(harness, admin, {premium_discount_percent: 30});
		const item = await createShopItem(harness, admin, 'owned');
		await setPrices(harness, admin, {[`cosmetic:${item.id}`]: 500, 'premium:1': 500});
		const paid = await createTestAccount(harness);
		const trial = await createTestAccount(harness);
		await grantPremium(harness, paid.userId, UserPremiumTypes.SUBSCRIPTION);
		await getPremiumLedgerService().grant({
			userId: createUserID(BigInt(trial.userId)),
			grantKey: 'trial',
			duration: {unit: 'days', quantity: 7},
			source: 'trial',
		});

		expect(await quote(`cosmetic:${item.id}`, paid)).toMatchObject({premium_percent: 30, final_try_minor: 350});
		expect(await quote('premium:1', paid)).toMatchObject({premium_percent: 0, final_try_minor: 500});
		expect(await quote(`cosmetic:${item.id}`, trial)).toMatchObject({premium_percent: 0, final_try_minor: 500});
		expect(await quote(`cosmetic:${item.id}`, user)).toMatchObject({premium_percent: 0, final_try_minor: 500});
		expect((await catalog(paid)).viewer.premium_discount).toBe(true);
		expect((await catalog(trial)).viewer.premium_discount).toBe(false);
		expect((await catalog(user)).viewer.premium_discount).toBe(false);
	});

	it('refuses closed sales, unpriced, off-sale and premium-only items', async () => {
		await openShop(harness, admin, {item_sales_open: false, premium_sales_open: false});
		const priced = await createShopItem(harness, admin, 'owned', 'Priced');
		const unpriced = await createShopItem(harness, admin, 'owned', 'Unpriced');
		const offSale = await createShopItem(harness, admin, 'owned', 'Off sale');
		const premiumOnly = await createShopItem(harness, admin, 'premium', 'Premium only');
		await setPrices(harness, admin, {
			[`cosmetic:${priced.id}`]: 500,
			[`cosmetic:${offSale.id}`]: 500,
			'premium:1': 500,
		});
		await createBuilder(harness, admin.token).delete(`/admin/cosmetics/items/${offSale.id}`).expect(204).execute();
		await putStoredPrice(`cosmetic:${premiumOnly.id}`, 500);
		await putStoredPrice('cosmetic:1490000000000000001', 500);

		await refuse(`cosmetic:${priced.id}`, 403, APIErrorCodes.SHOP_SALES_CLOSED);
		await refuse('premium:1', 403, APIErrorCodes.SHOP_SALES_CLOSED);

		await createBuilder(harness, admin.token)
			.patch('/admin/shop/settings')
			.body({item_sales_open: true, premium_sales_open: true})
			.execute();
		const service = getShopCatalogService();
		const buyer = await loadUser();
		expect((await service.prepareCheckout(buyer, `cosmetic:${priced.id}`, 'direct')).item?.item_id).toBe(
			BigInt(priced.id),
		);
		for (const sku of [
			`cosmetic:${unpriced.id}`,
			`cosmetic:${offSale.id}`,
			`cosmetic:${premiumOnly.id}`,
			'cosmetic:1490000000000000001',
			'premium:3',
		]) {
			await expect(service.prepareCheckout(buyer, sku, 'direct'), sku).rejects.toMatchObject({
				code: APIErrorCodes.SHOP_ITEM_UNAVAILABLE,
			});
		}
	});

	it('refuses an item the account owns', async () => {
		await openShop(harness, admin);
		const item = await createShopItem(harness, admin, 'owned');
		await setPrices(harness, admin, {[`cosmetic:${item.id}`]: 500});
		await getCosmeticService().grantOwned(createUserID(BigInt(user.userId)), BigInt(item.id), 'admin');

		await refuse(`cosmetic:${item.id}`, 409, APIErrorCodes.COSMETIC_ALREADY_OWNED);
	});

	it('refuses a stored price that ends below ₺1', async () => {
		await openShop(harness, admin);
		await putStoredPrice('premium:1', 99);

		await refuse('premium:1', 404, APIErrorCodes.SHOP_ITEM_UNAVAILABLE);
	});

	it('prepareCheckout refuses unverified email and unclaimed accounts', async () => {
		await openShop(harness, admin);
		await setPrices(harness, admin, {'premium:1': 500});
		const service = getShopCatalogService();
		const unverified = await createTestAccount(harness);
		const unclaimed = await createTestAccount(harness);
		await createBuilderWithoutAuth(harness)
			.post(`/test/users/${unverified.userId}/security-flags`)
			.body({email_verified: false})
			.execute();
		await createBuilderWithoutAuth(harness).post(`/test/users/${unclaimed.userId}/unclaim`).execute();

		await expect(service.prepareCheckout(await loadUser(unverified), 'premium:1', 'direct')).rejects.toBeInstanceOf(
			PurchaseEmailVerificationRequiredError,
		);
		await expect(service.prepareCheckout(await loadUser(unclaimed), 'premium:1', 'direct')).rejects.toBeInstanceOf(
			UnclaimedAccountCannotMakePurchasesError,
		);
		expect((await service.quote(await loadUser(unverified), 'premium:1')).price.finalTryMinor).toBe(500);
	});

	describe('Visionary', () => {
		it('visionary takes a campaign but never the member discount', async () => {
			await openShop(harness, admin, {visionary_on_sale: true, premium_discount_percent: 30});
			await setPrices(harness, admin, {visionary: 29_900});
			await createBuilder(harness, admin.token)
				.post('/admin/shop/campaigns')
				.body({skus: ['visionary'], percent: 20, ends_at: null})
				.execute();
			const paid = await createTestAccount(harness);
			await grantPremium(harness, paid.userId, UserPremiumTypes.SUBSCRIPTION);

			expect(await quote('visionary', paid)).toEqual({
				sku: 'visionary',
				base_try_minor: 29_900,
				campaign_percent: 20,
				premium_percent: 0,
				final_try_minor: 23_920,
				currency: 'TRY',
			});
			const prepared = await getShopCatalogService().prepareCheckout(await loadUser(paid), 'visionary', 'direct');
			expect(prepared).toMatchObject({sku: 'visionary', kind: 'visionary', item: null, months: null});
			expect(prepared.price).toMatchObject({campaignPercent: 20, premiumPercent: 0, finalTryMinor: 23_920});
		});

		it('sells Visionary only while it is on sale and premium sales are open', async () => {
			await openShop(harness, admin, {visionary_on_sale: false});
			await setPrices(harness, admin, {visionary: 29_900});
			await refuse('visionary', 404, APIErrorCodes.SHOP_ITEM_UNAVAILABLE);

			await createBuilder(harness, admin.token)
				.patch('/admin/shop/settings')
				.body({visionary_on_sale: true, premium_sales_open: false})
				.execute();
			await expect(
				getShopCatalogService().prepareCheckout(await loadUser(), 'visionary', 'direct'),
			).rejects.toMatchObject({code: APIErrorCodes.SHOP_SALES_CLOSED});

			await createBuilder(harness, admin.token)
				.patch('/admin/shop/settings')
				.body({premium_sales_open: true})
				.execute();
			expect(
				(await getShopCatalogService().prepareCheckout(await loadUser(), 'visionary', 'direct')).price.finalTryMinor,
			).toBe(29_900);
		});

		it('refuses Visionary and packages to a lifetime account', async () => {
			await openShop(harness, admin, {visionary_on_sale: true});
			const item = await createShopItem(harness, admin, 'owned');
			await setPrices(harness, admin, {visionary: 29_900, 'premium:1': 500, [`cosmetic:${item.id}`]: 500});
			await grantPremium(harness, user.userId, UserPremiumTypes.LIFETIME);

			await refuse('visionary', 404, APIErrorCodes.SHOP_ITEM_UNAVAILABLE);
			await refuse('premium:1', 404, APIErrorCodes.SHOP_ITEM_UNAVAILABLE);
			expect((await quote(`cosmetic:${item.id}`)).final_try_minor).toBe(500);
		});
	});
});
