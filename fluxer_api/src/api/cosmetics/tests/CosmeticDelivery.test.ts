// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, setUserACLs, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {CosmeticRepository} from '@app/api/cosmetics/CosmeticRepository';
import {CosmeticService} from '@app/api/cosmetics/CosmeticService';
import {getCosmeticService, getUserRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopGatewayService} from '@app/api/test/NoopGatewayService';
import {NoopWorkerService} from '@app/api/test/NoopWorkerService';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {UnknownUserError} from '@fluxer/errors/src/domains/user/UnknownUserError';
import type {CosmeticItemResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('cosmetic delivery', () => {
	let harness: ApiTestHarness;
	let admin: TestAccount;
	let user: TestAccount;
	let userId: UserID;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	beforeEach(async () => {
		admin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.COSMETICS_MANAGE,
		]);
		user = await createTestAccount(harness);
		userId = createUserID(BigInt(user.userId));
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		await harness?.shutdown();
	});

	async function createItem(body: Record<string, unknown>): Promise<CosmeticItemResponse> {
		return createBuilder<CosmeticItemResponse>(harness, admin.token)
			.post('/admin/cosmetics/items')
			.body({asset: PNG, ...body})
			.expect(200)
			.execute();
	}

	function deliver(item: CosmeticItemResponse, grantKey: string, source = 'payriff') {
		return getCosmeticService().deliverOwned(userId, BigInt(item.id), grantKey, source);
	}

	function spyOnPresence() {
		return vi.spyOn(NoopGatewayService.prototype, 'dispatchPresence');
	}

	function userUpdates(dispatchPresence: ReturnType<typeof spyOnPresence>) {
		return dispatchPresence.mock.calls.filter(
			([params]) => params.event === 'USER_UPDATE' && params.userId.toString() === user.userId,
		);
	}

	function spyOnPropagationJobs() {
		const addJob = vi.spyOn(NoopWorkerService.prototype, 'addJob');
		return () => (addJob.mock.calls as Array<Array<unknown>>).filter(([task]) => task === 'propagatePartialUserChange');
	}

	it('delivers once per grant key and never again after a take-back', async () => {
		const item = await createItem({type: 'avatar_ultra', name: 'Yitik Melek', availability: 'owned'});
		const itemId = BigInt(item.id);

		expect(await getCosmeticService().deliverOwned(userId, itemId, 'payriff:1', 'payriff')).toBe('delivered');
		expect(await getCosmeticService().deliverOwned(userId, itemId, 'payriff:1', 'payriff')).toBe('already_delivered');
		await createBuilder(harness, admin.token)
			.delete(`/admin/users/${user.userId}/cosmetics/${item.id}`)
			.expect(200)
			.execute();

		expect(await getCosmeticService().deliverOwned(userId, itemId, 'payriff:1', 'payriff')).toBe('already_delivered');
		expect(await getCosmeticService().isOwned(userId, itemId)).toBe(false);
	});

	it('wears the delivered item in its slot and announces it once', async () => {
		const item = await createItem({type: 'avatar_ultra', name: 'Kuzgun', availability: 'owned'});
		const dispatchPresence = spyOnPresence();
		const propagationJobs = spyOnPropagationJobs();

		expect(await deliver(item, 'payriff:2')).toBe('delivered');

		const row = await getUserRepository().findUnique(userId);
		expect([row?.avatarUltraId, row?.avatarUltraAsset]).toEqual([BigInt(item.id), item.asset]);
		expect(userUpdates(dispatchPresence)).toHaveLength(1);
		expect(propagationJobs()).toHaveLength(1);
		expect((await getCosmeticService().deps.repository.getGrant(userId, 'payriff:2'))?.state).toBe('delivered');
	});

	it('with wear: false owns the item and leaves the slot as it was', async () => {
		const worn = await createItem({type: 'avatar_decoration', name: 'First', availability: 'owned'});
		const extra = await createItem({type: 'avatar_decoration', name: 'Second', availability: 'owned'});
		expect(await deliver(worn, 'payriff:14:1')).toBe('delivered');
		const dispatchPresence = spyOnPresence();

		expect(
			await getCosmeticService().deliverOwned(userId, BigInt(extra.id), 'payriff:14:2', 'payriff', {wear: false}),
		).toBe('delivered');

		expect(await getCosmeticService().isOwned(userId, BigInt(extra.id))).toBe(true);
		expect((await getUserRepository().findUnique(userId))?.avatarDecorationId).toBe(BigInt(worn.id));
		expect(userUpdates(dispatchPresence)).toHaveLength(0);
		expect((await getCosmeticService().deps.repository.getGrant(userId, 'payriff:14:2'))?.state).toBe('delivered');
	});

	it('a second grant key for the same item answers already_owned and wears nothing new', async () => {
		const item = await createItem({type: 'nameplate', name: 'Plate', availability: 'owned'});
		expect(await deliver(item, 'payriff:3')).toBe('delivered');
		await createBuilder(harness, user.token)
			.put('/users/@me/cosmetics/equipped')
			.body({nameplate_id: null})
			.expect(200)
			.execute();
		const dispatchPresence = spyOnPresence();

		expect(await deliver(item, 'gift:SECOND', 'gift')).toBe('already_owned');

		expect(userUpdates(dispatchPresence)).toHaveLength(0);
		expect((await getUserRepository().findUnique(userId))?.nameplateId).toBeNull();
		expect((await getCosmeticService().deps.repository.getGrant(userId, 'gift:SECOND'))?.state).toBe('delivered');
		expect(await getCosmeticService().deps.repository.listOwned(userId)).toHaveLength(1);
	});

	it('a delivery that crashed after owning the item finishes as delivered and wears it', async () => {
		const item = await createItem({type: 'avatar_decoration', name: 'Crown', availability: 'owned'});
		vi.spyOn(CosmeticRepository.prototype, 'markGrantDelivered').mockRejectedValueOnce(new Error('crashed'));

		await expect(deliver(item, 'payriff:4')).rejects.toThrow('crashed');
		expect(await deliver(item, 'payriff:4')).toBe('delivered');

		expect(await getCosmeticService().deps.repository.listOwned(userId)).toHaveLength(1);
		expect((await getUserRepository().findUnique(userId))?.avatarDecorationId).toBe(BigInt(item.id));
		expect((await getCosmeticService().deps.repository.getGrant(userId, 'payriff:4'))?.state).toBe('delivered');
	});

	it('refuses a deleted account', async () => {
		const item = await createItem({type: 'nameplate', name: 'Plate', availability: 'owned'});
		const row = (await getUserRepository().findUnique(userId))!;
		await getUserRepository().patchUpsert(userId, {flags: row.flags | UserFlags.DELETED}, row.toRow());

		await expect(deliver(item, 'payriff:5')).rejects.toBeInstanceOf(UnknownUserError);

		expect(await getCosmeticService().isOwned(userId, BigInt(item.id))).toBe(false);
		expect(await getCosmeticService().deps.repository.getGrant(userId, 'payriff:5')).toBeNull();
	});

	it('concurrent deliveries of one key own the item once', async () => {
		const item = await createItem({type: 'profile_effect', name: 'Sparkle', availability: 'owned'});

		const results = await Promise.all(Array.from({length: 5}, () => deliver(item, 'payriff:6')));

		expect(results).toContain('delivered');
		expect(results).not.toContain('already_owned');
		expect(await getCosmeticService().deps.repository.listOwned(userId)).toHaveLength(1);
		expect((await getCosmeticService().deps.repository.getGrant(userId, 'payriff:6'))?.state).toBe('delivered');
	});

	it('two paid orders for one item delivered at once: one delivers, the other answers already_owned', async () => {
		const item = await createItem({type: 'nameplate', name: 'Twin', availability: 'owned'});

		const results = await Promise.all([deliver(item, 'payriff:10'), deliver(item, 'payriff:11')]);

		expect(results.sort()).toEqual(['already_owned', 'delivered']);
		expect(await getCosmeticService().deps.repository.listOwned(userId)).toHaveLength(1);
	});

	it('a take-back while the delivery runs wins: the item is not given back', async () => {
		const item = await createItem({type: 'avatar_decoration', name: 'Raced', availability: 'owned'});
		const itemId = BigInt(item.id);
		const grantOwned = CosmeticService.prototype.grantOwned;
		vi.spyOn(CosmeticService.prototype, 'grantOwned').mockImplementationOnce(async function (
			this: CosmeticService,
			...args: Parameters<CosmeticService['grantOwned']>
		) {
			await this.adminRevoke(userId, itemId);
			return grantOwned.apply(this, args);
		});

		expect(await deliver(item, 'payriff:12')).toBe('already_delivered');

		expect(await getCosmeticService().isOwned(userId, itemId)).toBe(false);
		expect((await getUserRepository().findUnique(userId))?.avatarDecorationId).toBeNull();
		expect((await getCosmeticService().deps.repository.getGrant(userId, 'payriff:12'))?.state).toBe('revoked');
	});

	it('a retry of the same key that finds its row already delivered keeps the item', async () => {
		const item = await createItem({type: 'avatar_decoration', name: 'Twice', availability: 'owned'});
		const itemId = BigInt(item.id);
		const markGrantDelivered = CosmeticRepository.prototype.markGrantDelivered;
		vi.spyOn(CosmeticRepository.prototype, 'markGrantDelivered').mockImplementationOnce(async function (
			this: CosmeticRepository,
			...args: Parameters<CosmeticRepository['markGrantDelivered']>
		) {
			// The first delivery, whose locks ran out while it wrote, marks the row first.
			await markGrantDelivered.apply(this, args);
			return markGrantDelivered.apply(this, args);
		});

		expect(await deliver(item, 'payriff:13')).toBe('already_delivered');

		expect(await getCosmeticService().isOwned(userId, itemId)).toBe(true);
		expect((await getUserRepository().findUnique(userId))?.avatarDecorationId).toBe(itemId);
		expect((await getCosmeticService().deps.repository.getGrant(userId, 'payriff:13'))?.state).toBe('delivered');
	});
});
