// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {CosmeticRepository} from '@app/api/cosmetics/CosmeticRepository';
import {CosmeticService} from '@app/api/cosmetics/CosmeticService';
import {CosmeticItems} from '@app/api/cosmetics/CosmeticTables';
import {deleteOneOrMany} from '@app/api/database/CassandraQueryExecution';
import type {ShopOrderRow} from '@app/api/database/types/ShopTypes';
import {Logger} from '@app/api/Logger';
import {
	getCosmeticRepository,
	getShopCatalogService,
	getShopOrderRepository,
	getShopOrderService,
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
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {NoopGatewayService} from '@app/api/test/NoopGatewayService';
import {fakePayriffServer} from '@app/api/test/Setup';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {collectUserHarvestExtensions} from '@app/api/user/lifecycle/UserLifecycleHooks';
import verifyShopOrder from '@app/api/worker/tasks/VerifyShopOrder';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {ResourceLockedError} from '@fluxer/errors/src/domains/core/ResourceLockedError';
import type {
	CosmeticItemResponse,
	CosmeticItemType,
} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import type {ShopAdminBundle, ShopAdminOrderResponse} from '@fluxer/schema/src/domains/shop/ShopAdminSchemas';
import type {ShopOrderResponse} from '@fluxer/schema/src/domains/shop/ShopResponseSchemas';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

function userUpdateCount(dispatch: {mock: {calls: Array<Array<{event: string}>>}}): number {
	return dispatch.mock.calls.filter(([params]) => params?.event === 'USER_UPDATE').length;
}

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const HELPERS: WorkerTaskHelpers = {
	logger: new NoopLogger(),
	jobId: 1n,
	addJob: async () => 0n,
	reportProgress: async () => {},
	shouldCancel: async () => false,
	setContextLink: async () => {},
};
const GONE = 'Bundle item is gone; skipped, refund it by hand';
const ALREADY_OWNED = 'Bundle item already owned; refund the whole order by hand and take its items back';

describe('bundle orders: delivery, frozen item list and visibility', () => {
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

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		await harness?.shutdown();
		restoreEnvironment();
	});

	function createItem(type: CosmeticItemType, name: string): Promise<CosmeticItemResponse> {
		return createBuilder<CosmeticItemResponse>(harness, admin.token)
			.post('/admin/cosmetics/items')
			.body({type, name, availability: 'owned', asset: PNG})
			.expect(200)
			.execute();
	}

	// An open shop with a $9.00 bundle, in this order: two avatar decorations and a nameplate, none priced alone.
	async function pricedBundle(): Promise<{bundle: ShopAdminBundle; items: Array<CosmeticItemResponse>}> {
		await openShop(harness, admin);
		const items = [
			await createItem('avatar_decoration', 'Hale'),
			await createItem('avatar_decoration', 'Taç'),
			await createItem('nameplate', 'Plaka'),
		];
		const bundle = await createBundle(
			harness,
			admin,
			items.map((item) => item.id),
			'Melek',
		);
		await setPrices(harness, admin, {[bundle.sku]: 900});
		return {bundle, items};
	}

	function createOrder(sku: string): Promise<ShopOrderResponse> {
		return createBuilder<ShopOrderResponse>(harness, user.token).post('/shop/orders').body({sku}).expect(200).execute();
	}

	function changeBundle(bundle: ShopAdminBundle, itemIds: Array<string>): Promise<ShopAdminBundle> {
		return createBuilder<ShopAdminBundle>(harness, admin.token)
			.patch(`/admin/shop/bundles/${bundle.id}`)
			.body({item_ids: itemIds})
			.expect(200)
			.execute();
	}

	async function stored(id: string): Promise<ShopOrderRow> {
		return (await getShopOrderRepository().find(BigInt(id)))!;
	}

	async function pay(id: string): Promise<void> {
		fakePayriffServer.setStatus((await stored(id)).provider_order_id!, 'APPROVED');
	}

	function verify(id: string, trigger: 'callback' | 'reconcile' = 'callback') {
		return verifyShopOrder({orderId: id, trigger, budgeted: trigger === 'reconcile'}, HELPERS);
	}

	async function ownedIds(): Promise<Array<string>> {
		return (await getCosmeticRepository().listOwned(userId)).map((row) => `${row.item_id}`).sort();
	}

	function idsOf(items: Array<CosmeticItemResponse>): Array<string> {
		return items.map((item) => item.id).sort();
	}

	function grantState(orderId: string, item: CosmeticItemResponse) {
		return getCosmeticRepository()
			.getGrant(userId, `payriff:${orderId}:${item.id}`)
			.then((grant) => grant?.state ?? null);
	}

	function warnings() {
		return vi.spyOn(Logger.child({}) as unknown as NoopLogger, 'warn');
	}

	it('delivers every item under its own grant key and grants the order', async () => {
		const {bundle, items} = await pricedBundle();
		const order = await createOrder(bundle.sku);
		await pay(order.id);

		await verify(order.id);

		expect((await stored(order.id)).status).toBe('granted');
		expect(await ownedIds()).toEqual(idsOf(items));
		for (const item of items) expect(await grantState(order.id, item)).toBe('delivered');
		expect(await getCosmeticRepository().getGrant(userId, `payriff:${order.id}`)).toBeNull();
	});

	it('wears the first item of each type in one user write and one user update', async () => {
		const {bundle, items} = await pricedBundle();
		const order = await createOrder(bundle.sku);
		await pay(order.id);
		const userWrites = vi.spyOn(getUserRepository(), 'patchUpsert');
		const userUpdates = vi.spyOn(NoopGatewayService.prototype, 'dispatchPresence');

		await verify(order.id);

		const buyer = (await getUserRepository().findUnique(userId))!;
		expect(buyer.avatarDecorationId).toBe(BigInt(items[0]!.id));
		expect(buyer.nameplateId).toBe(BigInt(items[2]!.id));
		expect(userWrites).toHaveBeenCalledTimes(1);
		expect(userUpdateCount(userUpdates)).toBe(1);
	});

	it('an item the account already owned leaves its slot to the next item of its type', async () => {
		await openShop(harness, admin);
		const plateA = await createItem('nameplate', 'Plaka A');
		const plateB = await createItem('nameplate', 'Plaka B');
		const effect = await createItem('profile_effect', 'Efekt');
		const bundle = await createBundle(harness, admin, [plateA.id, plateB.id, effect.id], 'Karışık');
		await setPrices(harness, admin, {[bundle.sku]: 900});
		const order = await createOrder(bundle.sku);
		await createBuilder(harness, admin.token)
			.post(`/admin/users/${user.userId}/cosmetics/${plateA.id}`)
			.expect(200)
			.execute();
		await pay(order.id);

		await verify(order.id);

		const buyer = (await getUserRepository().findUnique(userId))!;
		expect(buyer.nameplateId).toBe(BigInt(plateB.id));
		expect(buyer.profileEffectId).toBe(BigInt(effect.id));
	});

	// Each item may wait 5 s for its own delivery lock and then writes a few rows: 10 s per item on top of the 30 s a
	// single item order holds, so a second worker cannot take the order half way through a 10 item bundle.
	it('holds the order lock 10 s longer per item', async () => {
		const {bundle, items} = await pricedBundle();
		const order = await createOrder(bundle.sku);
		await pay(order.id);
		const acquireLock = vi.spyOn(getShopOrderService().deps.kvClient, 'acquireLock');

		await verify(order.id);

		expect(acquireLock).toHaveBeenCalledWith(
			`shop:order:deliver:${order.id}`,
			expect.any(String),
			30 + items.length * 10,
		);
	});

	it('delivers the list frozen at order time after the admin changes the bundle', async () => {
		const {bundle, items} = await pricedBundle();
		const order = await createOrder(bundle.sku);
		const later = await createItem('profile_effect', 'Later');
		await changeBundle(bundle, [items[0]!.id, later.id]);
		await pay(order.id);

		await verify(order.id);

		expect((await stored(order.id)).status).toBe('granted');
		expect(await ownedIds()).toEqual(idsOf(items));
	});

	it('delivers the list frozen at order time after the admin deletes the bundle', async () => {
		const {bundle, items} = await pricedBundle();
		const order = await createOrder(bundle.sku);
		await createBuilder(harness, admin.token).delete(`/admin/shop/bundles/${bundle.id}`).expect(204).execute();
		await pay(order.id);

		await verify(order.id);

		expect((await stored(order.id)).status).toBe('granted');
		expect(await ownedIds()).toEqual(idsOf(items));
	});

	it('reuses an open order only for the same item list at the same price', async () => {
		const {bundle, items} = await pricedBundle();
		const first = await createOrder(bundle.sku);
		expect((await createOrder(bundle.sku)).id).toBe(first.id);

		const swapped = await createItem('profile_effect', 'Swap');
		await changeBundle(bundle, [items[0]!.id, items[1]!.id, swapped.id]);
		getShopCatalogService().clearCachesForTesting();
		const second = await createOrder(bundle.sku);

		expect(second.id).not.toBe(first.id);
		expect(second.final_try_minor).toBe(first.final_try_minor);
		expect(first.item_ids).toEqual(items.map((item) => item.id));
		expect(second.item_ids).toEqual([items[0]!.id, items[1]!.id, swapped.id]);
	});

	it('callback and reconcile jobs delivering at once give each item once and grant once', async () => {
		const {bundle, items} = await pricedBundle();
		const order = await createOrder(bundle.sku);
		await pay(order.id);
		const grantOwned = vi.spyOn(CosmeticService.prototype, 'grantOwned');

		await Promise.allSettled([
			verify(order.id),
			verify(order.id, 'reconcile'),
			verify(order.id),
			verify(order.id, 'reconcile'),
		]);

		expect(grantOwned).toHaveBeenCalledTimes(3);
		expect(await ownedIds()).toEqual(idsOf(items));
		expect((await stored(order.id)).status).toBe('granted');
	});

	it('a lock on the second item defers the order; the retry delivers the rest and never the first twice', async () => {
		const {bundle, items} = await pricedBundle();
		const order = await createOrder(bundle.sku);
		await pay(order.id);
		const deliverOwned = CosmeticService.prototype.deliverOwned;
		vi.spyOn(CosmeticService.prototype, 'deliverOwned')
			.mockImplementationOnce(function (this: CosmeticService, ...args: Parameters<CosmeticService['deliverOwned']>) {
				return deliverOwned.apply(this, args);
			})
			.mockRejectedValueOnce(new ResourceLockedError());
		const grantOwned = vi.spyOn(CosmeticService.prototype, 'grantOwned');

		await verify(order.id);
		expect((await stored(order.id)).status).toBe('paid');
		expect(await ownedIds()).toEqual([items[0]!.id]);

		await verify(order.id);

		expect((await stored(order.id)).status).toBe('granted');
		expect(await ownedIds()).toEqual(idsOf(items));
		expect(grantOwned).toHaveBeenCalledTimes(3);
	});

	it('an item deleted since the order opened is skipped and logged; the rest is delivered and the order granted', async () => {
		const {bundle, items} = await pricedBundle();
		const [gone, ...rest] = items;
		const order = await createOrder(bundle.sku);
		await deleteOneOrMany(CosmeticItems.deleteByPk({item_id: BigInt(gone!.id)}));
		await pay(order.id);
		const warn = warnings();

		await verify(order.id);

		expect((await stored(order.id)).status).toBe('granted');
		expect(await ownedIds()).toEqual(idsOf(rest));
		expect(warn).toHaveBeenCalledWith({orderId: order.id, itemId: gone!.id}, GONE);
	});

	it('an item the account got meanwhile is logged for a full refund; the order is granted', async () => {
		const {bundle, items} = await pricedBundle();
		const order = await createOrder(bundle.sku);
		await createBuilder(harness, admin.token)
			.post(`/admin/users/${user.userId}/cosmetics/${items[1]!.id}`)
			.expect(200)
			.execute();
		await pay(order.id);
		const warn = warnings();

		await verify(order.id);

		expect((await stored(order.id)).status).toBe('granted');
		expect(await ownedIds()).toEqual(idsOf(items));
		expect(warn).toHaveBeenCalledWith({orderId: order.id, itemId: items[1]!.id}, ALREADY_OWNED);
	});

	it('a paid bundle order of a deleted account fails without delivery', async () => {
		const {bundle} = await pricedBundle();
		const order = await createOrder(bundle.sku);
		await pay(order.id);
		const account = (await getUserRepository().findUnique(userId))!;
		await getUserRepository().patchUpsert(userId, {flags: account.flags | UserFlags.DELETED}, account.toRow());

		await verify(order.id);

		expect(await stored(order.id)).toMatchObject({status: 'failed', failure_reason: 'account_deleted'});
		expect(await ownedIds()).toEqual([]);
	});

	it('an amount one kuruş off fails the bundle order without delivery', async () => {
		const {bundle} = await pricedBundle();
		const order = await createOrder(bundle.sku);
		const row = await stored(order.id);
		fakePayriffServer.setAmount(row.provider_order_id!, (row.amount_minor - 1) / 100);
		await pay(order.id);

		await verify(order.id);

		expect(await stored(order.id)).toMatchObject({status: 'failed', failure_reason: 'amount_mismatch'});
		expect(await ownedIds()).toEqual([]);
	});

	it('a take-back of an item whose delivery crashed half way is not undone by the retry', async () => {
		const {bundle, items} = await pricedBundle();
		const order = await createOrder(bundle.sku);
		await pay(order.id);
		vi.spyOn(CosmeticRepository.prototype, 'markGrantDelivered').mockRejectedValueOnce(new Error('worker died'));

		await expect(verify(order.id)).rejects.toThrow('worker died');
		expect(await grantState(order.id, items[0]!)).toBe('pending');
		await createBuilder(harness, admin.token)
			.delete(`/admin/users/${user.userId}/cosmetics/${items[0]!.id}`)
			.expect(200)
			.execute();
		await verify(order.id);

		expect((await stored(order.id)).status).toBe('granted');
		expect(await ownedIds()).toEqual(idsOf(items.slice(1)));
		expect(await grantState(order.id, items[0]!)).toBe('revoked');
	});

	it('shows the frozen items on the order, to the admin and in the data export; single item orders carry none', async () => {
		const {bundle, items} = await pricedBundle();
		const itemIds = items.map((item) => item.id);
		const single = await createShopItem(harness, admin, 'owned', 'Alone');
		await setPrices(harness, admin, {[`cosmetic:${single.id}`]: 300});
		const order = await createOrder(bundle.sku);
		const singleOrder = await createOrder(`cosmetic:${single.id}`);

		const view = await createBuilder<ShopOrderResponse>(harness, user.token).get(`/shop/orders/${order.id}`).execute();
		const adminView = await createBuilder<ShopAdminOrderResponse>(harness, admin.token)
			.get(`/admin/shop/orders/${order.id}`)
			.execute();
		const extension = (await collectUserHarvestExtensions({userId})).find((entry) => entry.name === 'shop');
		const exported = (extension!.data as {orders: Array<Record<string, unknown>>}).orders;

		expect([order.item_ids, view.item_ids, adminView.item_ids]).toEqual([itemIds, itemIds, itemIds]);
		expect(exported.find((entry) => entry.order_id === order.id)?.item_ids).toEqual(itemIds);
		expect(singleOrder).not.toHaveProperty('item_ids');
		expect(exported.find((entry) => entry.order_id === singleOrder.id)).not.toHaveProperty('item_ids');
	});
});
