// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, setUserACLs, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {CosmeticRepository} from '@app/api/cosmetics/CosmeticRepository';
import {getAdminRepository, getCosmeticService, getUserRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopGatewayService} from '@app/api/test/NoopGatewayService';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import type {
	AdminUserCosmeticResponse,
	CosmeticItemResponse,
} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('admin cosmetic grant and take back', () => {
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

	function grant(item: CosmeticItemResponse, token = admin.token) {
		return createBuilder<AdminUserCosmeticResponse>(harness, token).post(
			`/admin/users/${user.userId}/cosmetics/${item.id}`,
		);
	}

	function takeBack(item: CosmeticItemResponse) {
		return createBuilder<AdminUserCosmeticResponse>(harness, admin.token)
			.delete(`/admin/users/${user.userId}/cosmetics/${item.id}`)
			.expect(200)
			.execute();
	}

	function wear(body: Record<string, unknown>) {
		return createBuilder(harness, user.token).put('/users/@me/cosmetics/equipped').body(body).expect(200).execute();
	}

	function userUpdates(dispatchPresence: ReturnType<typeof spyOnPresence>) {
		return dispatchPresence.mock.calls.filter(
			([params]) => params.event === 'USER_UPDATE' && params.userId.toString() === user.userId,
		);
	}

	function spyOnPresence() {
		return vi.spyOn(NoopGatewayService.prototype, 'dispatchPresence');
	}

	it('gives an item with COSMETICS_MANAGE and records the reason', async () => {
		const item = await createItem({type: 'nameplate', name: 'Plate', availability: 'owned'});

		const response = await grant(item).header('X-Audit-Log-Reason', 'Support ticket 77').expect(200).execute();

		expect(response).toEqual({item_id: item.id, owned: true, equipped: false, changed: true, unequipped: false});
		expect(await getCosmeticService().isOwned(userId, BigInt(item.id))).toBe(true);
		expect((await getUserRepository().findUnique(userId))?.nameplateId).toBeNull();
		const logs = (await getAdminRepository().listAllAuditLogsPaginated(100)).filter(
			(log) => log.action === 'grant_cosmetic_item',
		);
		expect(logs).toHaveLength(1);
		expect(logs[0]!.auditLogReason).toBe('Support ticket 77');
		expect(logs[0]!.targetType).toBe('user');
		expect(logs[0]!.targetId.toString()).toBe(user.userId);
		expect(Object.fromEntries(logs[0]!.metadata)).toEqual({item_id: item.id, changed: 'true'});
	});

	it('refuses SHOP_MANAGE alone', async () => {
		const item = await createItem({type: 'nameplate', name: 'Plate', availability: 'owned'});
		const shopAdmin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.SHOP_MANAGE,
		]);

		await grant(item, shopAdmin.token).expect(403, APIErrorCodes.MISSING_ACL).execute();
		await createBuilder(harness, shopAdmin.token)
			.delete(`/admin/users/${user.userId}/cosmetics/${item.id}`)
			.expect(403, APIErrorCodes.MISSING_ACL)
			.execute();
		expect(await getCosmeticService().isOwned(userId, BigInt(item.id))).toBe(false);
	});

	it('a second grant reports changed false', async () => {
		const item = await createItem({type: 'nameplate', name: 'Plate', availability: 'owned'});
		await grant(item).expect(200).execute();

		const again = await grant(item).expect(200).execute();

		expect(again).toEqual({item_id: item.id, owned: true, equipped: false, changed: false, unequipped: false});
		expect(await getCosmeticService().deps.repository.listOwned(userId)).toHaveLength(1);
	});

	it('answers 404 for an unknown account or item', async () => {
		const item = await createItem({type: 'nameplate', name: 'Plate', availability: 'owned'});
		await createBuilder(harness, admin.token)
			.post(`/admin/users/123/cosmetics/${item.id}`)
			.expect(404, APIErrorCodes.UNKNOWN_USER)
			.execute();
		await createBuilder(harness, admin.token)
			.post(`/admin/users/${user.userId}/cosmetics/123`)
			.expect(404, APIErrorCodes.NOT_FOUND)
			.execute();
		await createBuilder(harness, admin.token)
			.delete(`/admin/users/123/cosmetics/${item.id}`)
			.expect(404, APIErrorCodes.UNKNOWN_USER)
			.execute();
	});

	it('take back removes a worn item and takes it off', async () => {
		const item = await createItem({type: 'avatar_ultra', name: 'Kuzgun', availability: 'owned'});
		await grant(item).expect(200).execute();
		await wear({avatar_ultra_id: item.id});
		const dispatchPresence = spyOnPresence();

		const response = await takeBack(item);

		expect(response).toEqual({item_id: item.id, owned: false, equipped: false, changed: true, unequipped: true});
		const row = await getUserRepository().findUnique(userId);
		expect([row?.avatarUltraId, row?.avatarUltraAsset]).toEqual([null, null]);
		expect(await getCosmeticService().isOwned(userId, BigInt(item.id))).toBe(false);
		expect(userUpdates(dispatchPresence)).toHaveLength(1);
	});

	it('take back takes it off again if an equip raced in', async () => {
		const item = await createItem({type: 'nameplate', name: 'Plate', availability: 'owned'});
		await grant(item).expect(200).execute();
		const deleteOwned = CosmeticRepository.prototype.deleteOwned;
		// An equip that passed the ownership check just before the item was deleted lands after the first take-off.
		vi.spyOn(CosmeticRepository.prototype, 'deleteOwned').mockImplementation(async function (
			this: CosmeticRepository,
			ownerId,
			itemId,
		) {
			const racer = (await getUserRepository().findUnique(ownerId))!;
			await getCosmeticService().equip(racer, {nameplate_id: itemId});
			return deleteOwned.call(this, ownerId, itemId);
		});
		const dispatchPresence = spyOnPresence();

		const response = await takeBack(item);

		expect(response).toMatchObject({owned: false, equipped: false, unequipped: true});
		const row = await getUserRepository().findUnique(userId);
		expect([row?.nameplateId, row?.nameplateAsset]).toEqual([null, null]);
		expect(userUpdates(dispatchPresence).length).toBeGreaterThanOrEqual(2);
	});

	it('take back of a free item leaves it worn', async () => {
		const item = await createItem({type: 'nameplate', name: 'Free plate', availability: 'free'});
		await grant(item).expect(200).execute();
		await wear({nameplate_id: item.id});

		const response = await takeBack(item);

		expect(response).toEqual({item_id: item.id, owned: false, equipped: true, changed: true, unequipped: false});
		expect((await getUserRepository().findUnique(userId))?.nameplateId).toBe(BigInt(item.id));
	});

	it('take back revokes a pending delivery of the item', async () => {
		const item = await createItem({type: 'avatar_decoration', name: 'Crown', availability: 'owned'});
		const repository = getCosmeticService().deps.repository;
		await repository.claimGrant({
			user_id: userId,
			grant_key: 'payriff:9',
			item_id: BigInt(item.id),
			source: 'payriff',
			state: 'pending',
			created_at: new Date(),
			delivered_at: null,
		});

		const response = await takeBack(item);

		expect(response).toMatchObject({owned: false, changed: false, unequipped: false});
		expect((await repository.getGrant(userId, 'payriff:9'))?.state).toBe('revoked');
		expect(await getCosmeticService().deliverOwned(userId, BigInt(item.id), 'payriff:9', 'payriff')).toBe(
			'already_delivered',
		);
		expect(await getCosmeticService().isOwned(userId, BigInt(item.id))).toBe(false);
	});
});
