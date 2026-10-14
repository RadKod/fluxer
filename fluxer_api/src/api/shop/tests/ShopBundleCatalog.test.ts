// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {
	getCosmeticRepository,
	getCosmeticService,
	getShopCatalogService,
	getUserRepository,
} from '@app/api/middleware/ServiceSingletons';
import {
	createBundle,
	createShopAdmin,
	createShopItem,
	openShop,
	saveShopEnvironment,
	setPrices,
} from '@app/api/shop/tests/ShopTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {grantPremium} from '@app/api/user/tests/UserTestUtils';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import type {ShopAdminBundle} from '@fluxer/schema/src/domains/shop/ShopAdminSchemas';
import type {ShopCatalogResponse, ShopQuoteResponse} from '@fluxer/schema/src/domains/shop/ShopResponseSchemas';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

describe('shop bundles in the catalog and at checkout', () => {
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

	// An open shop with a $9.00 bundle of three owned items: one priced alone, two sold only in the bundle.
	async function pricedBundle(settings: Parameters<typeof openShop>[2] = {}): Promise<ShopAdminBundle> {
		await openShop(harness, admin, settings);
		const items = await Promise.all(
			['Kanat', 'Hale', 'Plaka'].map((name) => createShopItem(harness, admin, 'owned', name)),
		);
		const bundle = await createBundle(
			harness,
			admin,
			items.map((item) => item.id),
			'Melek',
		);
		await setPrices(harness, admin, {[bundle.sku]: 900, [`cosmetic:${items[0]!.id}`]: 500});
		return bundle;
	}

	describe('quote and order checks', () => {
		it('opens with the item switch, not the premium one', async () => {
			const bundle = await pricedBundle({premium_sales_open: false, item_sales_open: true});

			expect(await quote(bundle.sku)).toMatchObject({sku: bundle.sku, final_try_minor: 900, currency: 'TRY'});

			await createBuilder(harness, admin.token)
				.patch('/admin/shop/settings')
				.body({item_sales_open: false, premium_sales_open: true})
				.execute();
			await refuse(bundle.sku, 403, APIErrorCodes.SHOP_SALES_CLOSED);
		});

		it('sells to a lifetime account and gives paid premium the member discount', async () => {
			const bundle = await pricedBundle({premium_discount_percent: 30});
			const paid = await createTestAccount(harness);
			await grantPremium(harness, paid.userId, UserPremiumTypes.SUBSCRIPTION);
			await grantPremium(harness, user.userId, UserPremiumTypes.LIFETIME);

			expect(await quote(bundle.sku, paid)).toMatchObject({premium_percent: 30, final_try_minor: 630});
			expect(await quote(bundle.sku)).toMatchObject({premium_percent: 30, final_try_minor: 630});
		});

		it('refuses an account that owns any one item of the bundle', async () => {
			const bundle = await pricedBundle();
			await getCosmeticService().grantOwned(createUserID(BigInt(user.userId)), BigInt(bundle.item_ids[2]!), 'admin');

			await refuse(bundle.sku, 409, APIErrorCodes.COSMETIC_ALREADY_OWNED);
			await expect(
				getShopCatalogService().prepareCheckout(await loadUser(), bundle.sku, 'direct'),
			).rejects.toMatchObject({
				code: APIErrorCodes.COSMETIC_ALREADY_OWNED,
			});
		});

		it('refuses a bundle with an item taken off sale, an unpriced bundle and an unknown one', async () => {
			const bundle = await pricedBundle();
			const unpriced = await createBundle(harness, admin, bundle.item_ids.slice(0, 2));
			await createBuilder(harness, admin.token)
				.delete(`/admin/cosmetics/items/${bundle.item_ids[1]}`)
				.expect(204)
				.execute();

			await refuse(bundle.sku, 404, APIErrorCodes.SHOP_ITEM_UNAVAILABLE);
			await refuse(unpriced.sku, 404, APIErrorCodes.SHOP_ITEM_UNAVAILABLE);
			await refuse('bundle:1490000000000000001', 404, APIErrorCodes.SHOP_ITEM_UNAVAILABLE);
			await expect(
				getShopCatalogService().prepareCheckout(await loadUser(), bundle.sku, 'direct'),
			).rejects.toMatchObject({
				code: APIErrorCodes.SHOP_ITEM_UNAVAILABLE,
			});
		});

		it('prepares a bundle order with the bundle name and its items in bundle order', async () => {
			const bundle = await pricedBundle();

			const prepared = await getShopCatalogService().prepareCheckout(await loadUser(), bundle.sku, 'direct');

			expect(prepared).toMatchObject({
				sku: bundle.sku,
				kind: 'bundle',
				item: null,
				months: null,
				bundle: {name: 'Melek', itemIds: bundle.item_ids.map(BigInt)},
			});
			expect(prepared.price.finalTryMinor).toBe(900);
		});

		it('a cached quote reads ownership of each bundle item only and reuses the shop tab catalog', async () => {
			const bundle = await pricedBundle();
			await quote(bundle.sku);
			const repository = getCosmeticRepository();
			const reads = {
				getItem: vi.spyOn(repository, 'getItem'),
				getItems: vi.spyOn(repository, 'getItems'),
				getOwned: vi.spyOn(repository, 'getOwned'),
				isOnSale: vi.spyOn(repository, 'isOnSale'),
				listOwned: vi.spyOn(repository, 'listOwned'),
				listCatalog: vi.spyOn(getCosmeticService(), 'listCatalog'),
			};

			await quote(bundle.sku);

			expect(reads.getItem).not.toHaveBeenCalled();
			expect(reads.getItems).not.toHaveBeenCalled();
			expect(reads.getOwned).toHaveBeenCalledTimes(bundle.item_ids.length);
			expect(reads.isOnSale).not.toHaveBeenCalled();
			expect(reads.listOwned).not.toHaveBeenCalled();
			expect(reads.listCatalog).not.toHaveBeenCalled();
		});
	});
	describe('catalog', () => {
		it('lists a priced bundle with its items embedded in bundle order; its bundle-only items stay out of items', async () => {
			const bundle = await pricedBundle();

			const shown = await catalog();

			expect(shown.bundles).toEqual([
				{
					sku: bundle.sku,
					id: bundle.id,
					name: 'Melek',
					description: null,
					items: bundle.item_ids.map((id) => expect.objectContaining({id, availability: 'owned'})),
					price: {
						base_try_minor: 900,
						campaign_percent: null,
						campaign_ends_at: null,
						sale_try_minor: 900,
						premium_try_minor: null,
					},
				},
			]);
			expect(shown.items.map((entry) => entry.item.id)).toEqual([bundle.item_ids[0]]);
		});

		it('leaves out an unpriced bundle and one with an item taken off sale', async () => {
			const bundle = await pricedBundle();
			await createBundle(harness, admin, bundle.item_ids.slice(1));
			const broken = await createBundle(harness, admin, bundle.item_ids.slice(0, 2));
			const offSale = await createShopItem(harness, admin, 'owned', 'Gidecek');
			await createBuilder(harness, admin.token)
				.patch(`/admin/shop/bundles/${broken.id}`)
				.body({item_ids: [bundle.item_ids[0], offSale.id]})
				.execute();
			await setPrices(harness, admin, {[broken.sku]: 700});
			await createBuilder(harness, admin.token).delete(`/admin/cosmetics/items/${offSale.id}`).expect(204).execute();

			expect((await catalog()).bundles?.map((shown) => shown.sku)).toEqual([bundle.sku]);
		});

		it('shows the member price and a campaign on a bundle', async () => {
			const bundle = await pricedBundle({premium_discount_percent: 30});
			await createBuilder(harness, admin.token)
				.post('/admin/shop/campaigns')
				.body({skus: [bundle.sku], percent: 20, ends_at: null})
				.execute();

			expect((await catalog()).bundles?.[0]?.price).toEqual({
				base_try_minor: 900,
				campaign_percent: 20,
				campaign_ends_at: null,
				sale_try_minor: 720,
				premium_try_minor: 504,
			});
		});
	});
});
