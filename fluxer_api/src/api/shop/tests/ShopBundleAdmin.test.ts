// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, setUserACLs, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {Config} from '@app/api/Config';
import {SHOP_PRICE_CATALOG} from '@app/api/database/types/ShopTypes';
import {getAdminRepository, getShopPriceRepository} from '@app/api/middleware/ServiceSingletons';
import {createBundle, createShopAdmin, createShopItem, saveShopEnvironment} from '@app/api/shop/tests/ShopTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import type {
	ShopAdminBundle,
	ShopAdminResponse,
	ShopAdminSettingsResponse,
} from '@fluxer/schema/src/domains/shop/ShopAdminSchemas';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

const UNKNOWN_ID = '1490000000000000001';

describe('shop bundle admin', () => {
	let harness: ApiTestHarness;
	let restoreEnvironment: () => void;
	let admin: TestAccount;

	beforeAll(async () => {
		restoreEnvironment = saveShopEnvironment();
		Config.instance.selfHosted = true;
		harness = await createApiTestHarness();
	});

	beforeEach(async () => {
		await harness.reset();
		admin = await createShopAdmin(harness);
	});

	afterAll(async () => {
		await harness?.shutdown();
		restoreEnvironment();
	});

	function view() {
		return createBuilder<ShopAdminResponse>(harness, admin.token).get('/admin/shop').execute();
	}

	function create(body: Record<string, unknown>, status = 200) {
		return createBuilder<ShopAdminBundle>(harness, admin.token)
			.post('/admin/shop/bundles')
			.body(body)
			.expect(status)
			.execute();
	}

	function update(id: string, body: Record<string, unknown>, status = 200) {
		return createBuilder<ShopAdminBundle>(harness, admin.token)
			.patch(`/admin/shop/bundles/${id}`)
			.body(body)
			.expect(status)
			.execute();
	}

	function remove(id: string, status = 204) {
		return createBuilder(harness, admin.token).delete(`/admin/shop/bundles/${id}`).expect(status).execute();
	}

	function putPrices(prices: Array<{sku: string; base_try_minor: number | null}>, status = 200) {
		return createBuilder<ShopAdminResponse>(harness, admin.token)
			.put('/admin/shop/prices')
			.body({prices})
			.expect(status)
			.execute();
	}

	function patchSettings(body: Record<string, unknown>, status = 200) {
		return createBuilder<ShopAdminSettingsResponse>(harness, admin.token)
			.patch('/admin/shop/settings')
			.body(body)
			.expect(status)
			.execute();
	}

	async function items(count: number) {
		return Promise.all(Array.from({length: count}, (_, i) => createShopItem(harness, admin, 'owned', `Item ${i}`)));
	}

	async function auditMetadata(action: string): Promise<Array<Record<string, string>>> {
		const logs = await getAdminRepository().listAllAuditLogsPaginated(1000);
		return logs.filter((log) => log.action === action).map((log) => Object.fromEntries(log.metadata));
	}

	it('creates, edits and deletes a bundle, and deleting it takes its price away too', async () => {
		const [a, b, c] = await items(3);

		const created = await create({name: 'Melek', item_ids: [a!.id, b!.id]});
		expect(created).toEqual({
			id: expect.any(String),
			sku: `bundle:${created.id}`,
			name: 'Melek',
			description: null,
			item_ids: [a!.id, b!.id],
		});
		expect((await view()).bundles).toEqual([created]);
		await putPrices([{sku: created.sku, base_try_minor: 900}]);

		const updated = await update(created.id, {
			name: 'Melek Seti',
			description: 'Kanat ve plaka',
			item_ids: [c!.id, a!.id],
		});
		expect(updated).toEqual({...created, name: 'Melek Seti', description: 'Kanat ve plaka', item_ids: [c!.id, a!.id]});
		expect((await update(created.id, {description: null})).description).toBeNull();

		await remove(created.id);
		const after = await view();
		expect(after.bundles).toEqual([]);
		expect(after.prices.map((row) => row.sku)).not.toContain(created.sku);
		await remove(created.id, 404);
		await update(created.id, {name: 'x'}, 404);
	});

	it('records every write with its changes', async () => {
		const [a, b, c] = await items(3);
		const created = await createBundle(harness, admin, [a!.id, b!.id], 'Melek');
		await update(created.id, {name: 'Melek Seti', item_ids: [a!.id, c!.id]});
		await remove(created.id);

		expect(await auditMetadata('create_shop_bundle')).toEqual([{name: 'Melek', item_ids: `${a!.id},${b!.id}`}]);
		expect(await auditMetadata('update_shop_bundle')).toEqual([
			{
				name_old: 'Melek',
				name_new: 'Melek Seti',
				item_ids_old: `${a!.id},${b!.id}`,
				item_ids_new: `${a!.id},${c!.id}`,
			},
		]);
		expect(await auditMetadata('delete_shop_bundle')).toEqual([{name: 'Melek Seti'}]);
	});

	it('needs SHOP_MANAGE; COSMETICS_MANAGE alone is refused', async () => {
		const [a, b] = await items(2);
		const bundle = await createBundle(harness, admin, [a!.id, b!.id]);
		const cosmeticsAdmin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.COSMETICS_MANAGE,
		]);
		const requests = [
			createBuilder(harness, cosmeticsAdmin.token)
				.post('/admin/shop/bundles')
				.body({name: 'x', item_ids: [a!.id, b!.id]}),
			createBuilder(harness, cosmeticsAdmin.token).patch(`/admin/shop/bundles/${bundle.id}`).body({name: 'x'}),
			createBuilder(harness, cosmeticsAdmin.token).delete(`/admin/shop/bundles/${bundle.id}`),
		];
		for (const request of requests) {
			await request.expect(403, APIErrorCodes.MISSING_ACL).execute();
		}
		expect((await view()).bundles).toEqual([bundle]);
	});

	it('drops repeated items in order and then holds the bundle to 2–10 items', async () => {
		const many = await items(11);
		const [a, b] = many;

		expect((await create({name: 'x', item_ids: [a!.id, b!.id, a!.id]})).item_ids).toEqual([a!.id, b!.id]);
		await create({name: 'x', item_ids: [a!.id, a!.id]}, 400);
		await create({name: 'x', item_ids: many.map((item) => item.id)}, 400);
		const bundle = await create({name: 'x', item_ids: many.slice(0, 10).map((item) => item.id)});
		await update(bundle.id, {item_ids: [b!.id, b!.id]}, 400);
	});

	it('takes owned items on sale, priced or not, and refuses premium, free, off-sale and unknown items', async () => {
		const [priced, bundleOnly, offSale] = await items(3);
		const premium = await createShopItem(harness, admin, 'premium', 'Premium');
		const free = await createShopItem(harness, admin, 'free', 'Free');
		await putPrices([{sku: `cosmetic:${priced!.id}`, base_try_minor: 500}]);
		await createBuilder(harness, admin.token).delete(`/admin/cosmetics/items/${offSale!.id}`).expect(204).execute();

		expect((await create({name: 'x', item_ids: [priced!.id, bundleOnly!.id]})).item_ids).toEqual([
			priced!.id,
			bundleOnly!.id,
		]);
		for (const refused of [premium.id, free.id, offSale!.id, UNKNOWN_ID]) {
			await create({name: 'x', item_ids: [priced!.id, refused]}, 400);
		}
	});

	it('keeps Visionary rewards and bundle items apart, both ways', async () => {
		const [a, b, reward] = await items(3);
		await patchSettings({visionary_reward_item_ids: [reward!.id]});
		await create({name: 'x', item_ids: [a!.id, reward!.id]}, 400);

		const bundle = await createBundle(harness, admin, [a!.id, b!.id]);
		await patchSettings({visionary_reward_item_ids: [a!.id]}, 400);
		await update(bundle.id, {item_ids: [b!.id, reward!.id]}, 400);
	});

	it('prices only a bundle that exists; a null price for any bundle sku is taken', async () => {
		const [a, b] = await items(2);
		const bundle = await createBundle(harness, admin, [a!.id, b!.id]);

		await putPrices([{sku: `bundle:${UNKNOWN_ID}`, base_try_minor: 500}], 400);
		await putPrices([{sku: `bundle:${UNKNOWN_ID}`, base_try_minor: null}]);
		expect((await putPrices([{sku: bundle.sku, base_try_minor: 500}])).prices.map((row) => row.sku)).toEqual([
			bundle.sku,
		]);
	});

	it('refuses a 201st bundle', async () => {
		const [a, b] = await items(2);
		const now = new Date();
		for (let i = 0; i < 200; i++) {
			await getShopPriceRepository().putBundle({
				catalog: SHOP_PRICE_CATALOG,
				bundle_id: 1490000000000001000n + BigInt(i),
				name: `Bundle ${i}`,
				description: null,
				item_ids: [BigInt(a!.id), BigInt(b!.id)],
				created_at: now,
				updated_at: now,
			});
		}

		await create({name: 'x', item_ids: [a!.id, b!.id]}, 400);
		await getShopPriceRepository().deleteBundle(1490000000000001000n);
		await create({name: 'x', item_ids: [a!.id, b!.id]});
	});
});
