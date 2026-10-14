// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, setUserACLs, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {getCosmeticService, getUserRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopGatewayService} from '@app/api/test/NoopGatewayService';
import {NoopWorkerService} from '@app/api/test/NoopWorkerService';
import {TestMediaService} from '@app/api/test/TestMediaService';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {collectUserHarvestExtensions, runUserDeletionHook} from '@app/api/user/lifecycle/UserLifecycleHooks';
import {applyProfileExtensions} from '@app/api/user/profile/ProfileExtensionProviders';
import {UserRepository} from '@app/api/user/repositories/UserRepository';
import {fetchUserMe, grantPremium} from '@app/api/user/tests/UserTestUtils';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import type {
	CosmeticItemResponse,
	EquippedCosmeticsResponse,
	UserCosmeticsResponse,
} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import type {UserProfileFullResponse} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const GIF = 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"></svg>').toString('base64');
const RATE_LIMIT_TEST_HEADER = 'x-fluxer-test-enable-rate-limits';
const TOO_MANY_REQUESTS = 429;
const PNG_OVER_512_KB = Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.alloc(512 * 1024)]).toString('base64');

describe('cosmetics', () => {
	let harness: ApiTestHarness;
	let admin: TestAccount;
	let user: TestAccount;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	// The test setup wipes the store after every test, so each test needs its own accounts.
	beforeEach(async () => {
		admin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.COSMETICS_MANAGE,
		]);
		user = await createTestAccount(harness);
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

	function equip(token: string, body: Record<string, unknown>) {
		return createBuilder<EquippedCosmeticsResponse>(harness, token).put('/users/@me/cosmetics/equipped').body(body);
	}

	function listCatalog(query = '') {
		return createBuilder<Array<CosmeticItemResponse>>(harness, user.token)
			.get(`/cosmetics/catalog${query}`)
			.expect(200)
			.execute();
	}

	function listMine(token: string) {
		return createBuilder<UserCosmeticsResponse>(harness, token).get('/users/@me/cosmetics').expect(200).execute();
	}

	function userUpdatesFor(dispatchPresence: ReturnType<typeof spyOnPresence>, userId: string) {
		return dispatchPresence.mock.calls
			.map(([params]) => params)
			.filter((params) => params.event === 'USER_UPDATE' && params.userId.toString() === userId);
	}

	function spyOnPresence() {
		return vi.spyOn(NoopGatewayService.prototype, 'dispatchPresence');
	}

	function spyOnPropagationJobs() {
		const addJob = vi.spyOn(NoopWorkerService.prototype, 'addJob');
		return () => (addJob.mock.calls as Array<Array<unknown>>).filter(([task]) => task === 'propagatePartialUserChange');
	}

	describe('admin catalog', () => {
		it('stores the image as a branding asset under cosmetic-<type>-<item_id> and lists it in the catalog', async () => {
			const item = await createItem({type: 'avatar_decoration', name: 'Gold ring', availability: 'free'});

			expect(item).toMatchObject({
				type: 'avatar_decoration',
				name: 'Gold ring',
				description: null,
				availability: 'free',
			});
			expect(item.asset).toMatch(/^[0-9a-f]{8}$/);
			const stored = await harness.storageService.getObjectMetadata(
				Config.s3.buckets.cdn,
				`branding/cosmetic-avatar_decoration-${item.id}/${item.asset}`,
			);
			expect(stored).not.toBeNull();
			expect(await listCatalog('?type=avatar_decoration')).toEqual([item]);
			expect(await listCatalog('?type=nameplate')).toEqual([]);
			expect(await listCatalog()).toEqual([item]);
		});

		it.each([
			['SVG', SVG],
			['GIF', GIF],
		])('refuses a %s image', async (_label, asset) => {
			await createBuilder(harness, admin.token)
				.post('/admin/cosmetics/items')
				.body({type: 'nameplate', name: 'Bad', availability: 'free', asset})
				.expect(400, APIErrorCodes.INVALID_FORM_BODY)
				.execute();
		});

		it('refuses an image above 512 KB', async () => {
			await createBuilder(harness, admin.token)
				.post('/admin/cosmetics/items')
				.body({type: 'nameplate', name: 'Big', availability: 'free', asset: PNG_OVER_512_KB})
				.expect(400, APIErrorCodes.INVALID_FORM_BODY)
				.execute();
		});

		it.each([95, 481])('refuses an image %i px wide', async (width) => {
			const getMetadata = TestMediaService.prototype.getMetadata;
			vi.spyOn(TestMediaService.prototype, 'getMetadata').mockImplementation(async function (
				this: TestMediaService,
				request,
			) {
				const metadata = await getMetadata.call(this, request);
				return metadata ? {...metadata, width} : metadata;
			});
			await createBuilder(harness, admin.token)
				.post('/admin/cosmetics/items')
				.body({type: 'nameplate', name: 'Odd', availability: 'free', asset: PNG})
				.expect(400, APIErrorCodes.INVALID_FORM_BODY)
				.execute();
		});

		it('refuses catalog writes to an admin without COSMETICS_MANAGE', async () => {
			const otherAdmin = await setUserACLs(harness, await createTestAccount(harness), [AdminACLs.AUTHENTICATE]);
			await createBuilder(harness, otherAdmin.token)
				.post('/admin/cosmetics/items')
				.body({type: 'nameplate', name: 'Gold', availability: 'free', asset: PNG})
				.expect(403, APIErrorCodes.MISSING_ACL)
				.execute();
		});

		it('updates an item; wearers keep the image they put on', async () => {
			const item = await createItem({type: 'nameplate', name: 'Gold', availability: 'free'});
			await equip(user.token, {nameplate_id: item.id}).expect(200).execute();
			const newImage = Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.from([0])]).toString('base64');

			const updated = await createBuilder<CosmeticItemResponse>(harness, admin.token)
				.patch(`/admin/cosmetics/items/${item.id}`)
				.body({name: 'Silver', description: 'Shiny', availability: 'premium', asset: newImage})
				.expect(200)
				.execute();

			expect(updated).toMatchObject({id: item.id, name: 'Silver', description: 'Shiny', availability: 'premium'});
			expect(updated.asset).not.toBe(item.asset);
			expect(await listCatalog('?type=nameplate')).toEqual([updated]);
			const {json: me} = await fetchUserMe(harness, user.token);
			expect(me.nameplate_data).toEqual({asset: item.asset, item_id: item.id});
		});

		it('answers 404 for an unknown item', async () => {
			await createBuilder(harness, admin.token)
				.patch('/admin/cosmetics/items/123')
				.body({name: 'Nope'})
				.expect(404, APIErrorCodes.NOT_FOUND)
				.execute();
			await createBuilder(harness, admin.token)
				.delete('/admin/cosmetics/items/123')
				.expect(404, APIErrorCodes.NOT_FOUND)
				.execute();
		});

		it('takes a deleted item off sale without taking it off the accounts that wear or own it', async () => {
			const worn = await createItem({type: 'avatar_decoration', name: 'Worn', availability: 'free'});
			const owned = await createItem({type: 'avatar_decoration', name: 'Owned', availability: 'owned'});
			const other = await createTestAccount(harness);
			await equip(user.token, {avatar_decoration_id: worn.id}).expect(200).execute();
			await getCosmeticService().grantOwned(createUserID(BigInt(other.userId)), BigInt(owned.id), 'test');

			for (const item of [worn, owned]) {
				await createBuilder(harness, admin.token).delete(`/admin/cosmetics/items/${item.id}`).expect(204).execute();
			}

			expect(await listCatalog('?type=avatar_decoration')).toEqual([]);
			const {json: me} = await fetchUserMe(harness, user.token);
			expect(me.avatar_decoration_data).toEqual({asset: worn.asset, item_id: worn.id});
			await equip(other.token, {avatar_decoration_id: worn.id}).expect(403, APIErrorCodes.COSMETIC_NOT_OWNED).execute();
			await equip(other.token, {avatar_decoration_id: owned.id}).expect(200).execute();
		});

		it('lists every item to admins, items taken off sale included', async () => {
			const onSale = await createItem({type: 'nameplate', name: 'On sale', availability: 'free'});
			const retired = await createItem({type: 'avatar_decoration', name: 'Retired', availability: 'premium'});
			await createBuilder(harness, admin.token).delete(`/admin/cosmetics/items/${retired.id}`).expect(204).execute();

			const items = await createBuilder<Array<CosmeticItemResponse>>(harness, admin.token)
				.get('/admin/cosmetics/items')
				.expect(200)
				.execute();

			expect(items).toEqual([onSale, {...retired, availability: 'owned'}]);
			const otherAdmin = await setUserACLs(harness, await createTestAccount(harness), [AdminACLs.AUTHENTICATE]);
			await createBuilder(harness, otherAdmin.token)
				.get('/admin/cosmetics/items')
				.expect(403, APIErrorCodes.MISSING_ACL)
				.execute();
		});
	});

	describe('wearing', () => {
		it('refuses an item the account does not own', async () => {
			const item = await createItem({type: 'avatar_decoration', name: 'Store only', availability: 'owned'});
			await equip(user.token, {avatar_decoration_id: item.id}).expect(403, APIErrorCodes.COSMETIC_NOT_OWNED).execute();
		});

		it('refuses an unknown item and an item of another type', async () => {
			const nameplate = await createItem({type: 'nameplate', name: 'Plate', availability: 'free'});
			await equip(user.token, {avatar_decoration_id: '123'}).expect(403, APIErrorCodes.COSMETIC_NOT_OWNED).execute();
			await equip(user.token, {avatar_decoration_id: nameplate.id})
				.expect(403, APIErrorCodes.COSMETIC_NOT_OWNED)
				.execute();
		});

		it('lets only premium accounts wear a premium item', async () => {
			const item = await createItem({type: 'profile_effect', name: 'Sparkles', availability: 'premium'});
			await equip(user.token, {profile_effect_id: item.id}).expect(403, APIErrorCodes.COSMETIC_NOT_OWNED).execute();

			await grantPremium(harness, user.userId, UserPremiumTypes.SUBSCRIPTION);

			await equip(user.token, {profile_effect_id: item.id}).expect(200).execute();
		});

		it('wears an owned item, sends the private USER_UPDATE once and queues one propagation', async () => {
			const item = await createItem({type: 'avatar_decoration', name: 'Crown', availability: 'owned'});
			await getCosmeticService().grantOwned(createUserID(BigInt(user.userId)), BigInt(item.id), 'test');
			const dispatchPresence = spyOnPresence();
			const propagationJobs = spyOnPropagationJobs();

			const equipped = await equip(user.token, {avatar_decoration_id: item.id}).expect(200).execute();

			expect(equipped).toEqual({
				avatar_decoration_id: item.id,
				avatar_ultra_id: null,
				profile_effect_id: null,
				nameplate_id: null,
			});
			const updates = userUpdatesFor(dispatchPresence, user.userId);
			expect(updates).toHaveLength(1);
			expect(updates[0]!.data).toMatchObject({
				email: user.email,
				avatar_decoration_data: {asset: item.asset, item_id: item.id},
				nameplate_data: null,
			});
			expect(propagationJobs()).toHaveLength(1);
			const {json: me} = await fetchUserMe(harness, user.token);
			expect(me.avatar_decoration_data).toEqual({asset: item.asset, item_id: item.id});
			expect(await listMine(user.token)).toEqual({
				owned: [item],
				equipped: {avatar_decoration_id: item.id, avatar_ultra_id: null, profile_effect_id: null, nameplate_id: null},
			});
		});

		it('writes nothing when the request changes nothing', async () => {
			const item = await createItem({type: 'nameplate', name: 'Plate', availability: 'free'});
			await equip(user.token, {nameplate_id: item.id}).expect(200).execute();
			const dispatchPresence = spyOnPresence();
			const propagationJobs = spyOnPropagationJobs();

			await equip(user.token, {nameplate_id: item.id}).expect(200).execute();

			expect(userUpdatesFor(dispatchPresence, user.userId)).toHaveLength(0);
			expect(propagationJobs()).toHaveLength(0);
		});

		it('takes an item off with null and leaves omitted slots alone', async () => {
			const decoration = await createItem({type: 'avatar_decoration', name: 'Ring', availability: 'free'});
			const nameplate = await createItem({type: 'nameplate', name: 'Plate', availability: 'free'});
			await equip(user.token, {avatar_decoration_id: decoration.id, nameplate_id: nameplate.id}).expect(200).execute();

			const equipped = await equip(user.token, {avatar_decoration_id: null}).expect(200).execute();

			expect(equipped).toEqual({
				avatar_decoration_id: null,
				avatar_ultra_id: null,
				profile_effect_id: null,
				nameplate_id: nameplate.id,
			});
			const {json: me} = await fetchUserMe(harness, user.token);
			expect(me).toHaveProperty('avatar_decoration_data', null);
			expect(me.nameplate_data).toEqual({asset: nameplate.asset, item_id: nameplate.id});
		});

		it('reads the profile effect from the loaded profile user without reading the users table again', async () => {
			const effect = await createItem({type: 'profile_effect', name: 'Sparkle', availability: 'free'});
			await equip(user.token, {profile_effect_id: effect.id}).expect(200).execute();
			const profileUser = (await getUserRepository().findUnique(createUserID(BigInt(user.userId))))!;
			const userReads = vi.spyOn(UserRepository.prototype, 'findUnique');

			const extended = await applyProfileExtensions({} as UserProfileFullResponse, {
				userId: profileUser.id,
				viewerId: createUserID(BigInt(admin.userId)),
				restrictProfile: false,
				user: profileUser,
			});

			expect(extended.profile_effect_data).toEqual({asset: effect.asset, item_id: effect.id});
			expect(userReads).not.toHaveBeenCalled();
		});

		it('puts the worn profile effect on the profile, and null when none is worn', async () => {
			const profilePath = `/users/${user.userId}/profile`;
			const before = await createBuilder<UserProfileFullResponse>(harness, user.token)
				.get(profilePath)
				.expect(200)
				.execute();
			expect(before).toHaveProperty('profile_effect_data', null);
			const effect = await createItem({type: 'profile_effect', name: 'Snow', availability: 'free'});
			await equip(user.token, {profile_effect_id: effect.id}).expect(200).execute();

			const after = await createBuilder<UserProfileFullResponse>(harness, user.token)
				.get(profilePath)
				.expect(200)
				.execute();

			expect(after.profile_effect_data).toEqual({asset: effect.asset, item_id: effect.id});
		});

		it('limits wearing to 5 changes per 10 minutes for each account', async () => {
			const halo = await createItem({type: 'avatar_decoration', name: 'Halo', availability: 'free'});
			const change = (account: TestAccount, itemId: string | null) =>
				equip(account.token, {avatar_decoration_id: itemId}).header(RATE_LIMIT_TEST_HEADER, 'true');
			for (let index = 0; index < 5; index++) {
				await change(user, index % 2 === 0 ? halo.id : null)
					.expect(200)
					.execute();
			}
			await change(user, halo.id).expect(TOO_MANY_REQUESTS, APIErrorCodes.RATE_LIMITED).execute();
			await change(await createTestAccount(harness), halo.id)
				.expect(200)
				.execute();
		});
	});

	describe('account lifecycle', () => {
		it('deletion drops owned items and worn fields, and running it twice is harmless', async () => {
			const worn = await createItem({type: 'nameplate', name: 'Plate', availability: 'owned'});
			const userId = createUserID(BigInt(user.userId));
			await getCosmeticService().grantOwned(userId, BigInt(worn.id), 'test');
			await equip(user.token, {nameplate_id: worn.id}).expect(200).execute();

			await runUserDeletionHook('cosmetics', {userId});
			await runUserDeletionHook('cosmetics', {userId});

			const row = await getUserRepository().findUnique(userId);
			expect([row?.nameplateId, row?.nameplateAsset, row?.avatarDecorationId, row?.profileEffectId]).toEqual([
				null,
				null,
				null,
				null,
			]);
			expect((await listMine(user.token)).owned).toEqual([]);
		});

		it('exports the owned and worn items', async () => {
			const item = await createItem({type: 'avatar_decoration', name: 'Crown', availability: 'owned'});
			const userId = createUserID(BigInt(user.userId));
			await getCosmeticService().grantOwned(userId, BigInt(item.id), 'store');
			await equip(user.token, {avatar_decoration_id: item.id}).expect(200).execute();

			const extensions = await collectUserHarvestExtensions({userId});

			expect(extensions.find((extension) => extension.name === 'cosmetics')?.data).toEqual({
				owned: [
					{
						item_id: item.id,
						type: 'avatar_decoration',
						name: 'Crown',
						source: 'store',
						acquired_at: expect.any(String),
					},
				],
				equipped: {avatar_decoration_id: item.id, avatar_ultra_id: null, profile_effect_id: null, nameplate_id: null},
			});
		});
	});

	describe('ultra decorations', () => {
		it('wears only an ultra decoration and queues one propagation, so the change reaches every community', async () => {
			const ultra = await createItem({type: 'avatar_ultra', name: 'Yitik Melek', availability: 'free'});
			const propagationJobs = spyOnPropagationJobs();
			await equip(user.token, {avatar_ultra_id: ultra.id}).expect(200).execute();
			expect(propagationJobs()).toHaveLength(1);
		});

		it('wears an ultra decoration next to a frame: both columns, one USER_UPDATE, one propagation', async () => {
			const frame = await createItem({type: 'avatar_decoration', name: 'Ring', availability: 'free'});
			const ultra = await createItem({type: 'avatar_ultra', name: 'Yitik Melek', availability: 'free'});
			const dispatchPresence = spyOnPresence();
			const propagationJobs = spyOnPropagationJobs();
			const equipped = await equip(user.token, {avatar_decoration_id: frame.id, avatar_ultra_id: ultra.id})
				.expect(200)
				.execute();
			expect(equipped).toEqual({
				avatar_decoration_id: frame.id,
				avatar_ultra_id: ultra.id,
				profile_effect_id: null,
				nameplate_id: null,
			});
			const row = await getUserRepository().findUnique(createUserID(BigInt(user.userId)));
			expect([row?.avatarUltraId, row?.avatarUltraAsset]).toEqual([BigInt(ultra.id), ultra.asset]);
			const updates = userUpdatesFor(dispatchPresence, user.userId);
			expect(updates).toHaveLength(1);
			expect(updates[0]!.data).toMatchObject({
				avatar_decoration_data: {asset: frame.asset, item_id: frame.id},
				avatar_ultra_data: {asset: ultra.asset, item_id: ultra.id},
			});
			expect(propagationJobs()).toHaveLength(1);
		});

		it('takes the ultra decoration off with null and leaves the frame on', async () => {
			const frame = await createItem({type: 'avatar_decoration', name: 'Ring', availability: 'free'});
			const ultra = await createItem({type: 'avatar_ultra', name: 'Kuzgun', availability: 'free'});
			await equip(user.token, {avatar_decoration_id: frame.id, avatar_ultra_id: ultra.id}).expect(200).execute();
			await equip(user.token, {avatar_ultra_id: null}).expect(200).execute();
			const {json: me} = await fetchUserMe(harness, user.token);
			expect(me).toHaveProperty('avatar_ultra_data', null);
			expect(me.avatar_decoration_data).toEqual({asset: frame.asset, item_id: frame.id});
		});

		it('keeps ultra decorations out of the frame slot and frames out of the ultra slot', async () => {
			const frame = await createItem({type: 'avatar_decoration', name: 'Ring', availability: 'free'});
			const ultra = await createItem({type: 'avatar_ultra', name: 'Kuzgun', availability: 'free'});
			await equip(user.token, {avatar_decoration_id: ultra.id}).expect(403, APIErrorCodes.COSMETIC_NOT_OWNED).execute();
			await equip(user.token, {avatar_ultra_id: frame.id}).expect(403, APIErrorCodes.COSMETIC_NOT_OWNED).execute();
		});

		it('lets only premium accounts wear a premium ultra decoration', async () => {
			const ultra = await createItem({type: 'avatar_ultra', name: 'Yitik Melek', availability: 'premium'});
			await equip(user.token, {avatar_ultra_id: ultra.id}).expect(403, APIErrorCodes.COSMETIC_NOT_OWNED).execute();
			await grantPremium(harness, user.userId, UserPremiumTypes.SUBSCRIPTION);
			await equip(user.token, {avatar_ultra_id: ultra.id}).expect(200).execute();
		});

		it('takes a premium ultra decoration off an account without premium', async () => {
			const ultra = await createItem({type: 'avatar_ultra', name: 'Kuzgun', availability: 'premium'});
			const userId = createUserID(BigInt(user.userId));
			const row = await getUserRepository().findUnique(userId);
			await getUserRepository().patchUpsert(
				userId,
				{avatar_ultra_id: BigInt(ultra.id), avatar_ultra_asset: ultra.asset},
				row!.toRow(),
			);
			await getCosmeticService().removePremiumOnlyCosmetics(userId);
			const after = await getUserRepository().findUnique(userId);
			expect([after?.avatarUltraId, after?.avatarUltraAsset]).toEqual([null, null]);
		});

		it('clears the ultra decoration when the account is deleted', async () => {
			const ultra = await createItem({type: 'avatar_ultra', name: 'Kuzgun', availability: 'free'});
			const userId = createUserID(BigInt(user.userId));
			await equip(user.token, {avatar_ultra_id: ultra.id}).expect(200).execute();
			await runUserDeletionHook('cosmetics', {userId});
			const after = await getUserRepository().findUnique(userId);
			expect([after?.avatarUltraId, after?.avatarUltraAsset]).toEqual([null, null]);
		});

		it('exports the worn ultra decoration', async () => {
			const ultra = await createItem({type: 'avatar_ultra', name: 'Kuzgun', availability: 'free'});
			await equip(user.token, {avatar_ultra_id: ultra.id}).expect(200).execute();
			const extensions = await collectUserHarvestExtensions({userId: createUserID(BigInt(user.userId))});
			expect(extensions.find((extension) => extension.name === 'cosmetics')?.data).toMatchObject({
				equipped: {avatar_ultra_id: ultra.id},
			});
		});
	});

	describe('image limits by type', () => {
		const PNG_BYTES = Buffer.from(PNG, 'base64');
		const pngOf = (bytes: number) =>
			Buffer.concat([PNG_BYTES, Buffer.alloc(bytes - PNG_BYTES.length)]).toString('base64');

		it('takes an ultra decoration up to 1,228,800 bytes and refuses one byte more', async () => {
			await createBuilder(harness, admin.token)
				.post('/admin/cosmetics/items')
				.body({type: 'avatar_ultra', name: 'Big', availability: 'free', asset: pngOf(1_228_800)})
				.expect(200)
				.execute();
			await createBuilder(harness, admin.token)
				.post('/admin/cosmetics/items')
				.body({type: 'avatar_ultra', name: 'Bigger', availability: 'free', asset: pngOf(1_228_801)})
				.expect(400, APIErrorCodes.INVALID_FORM_BODY)
				.execute();
		});

		it('still holds a frame to 524,288 bytes', async () => {
			await createBuilder(harness, admin.token)
				.post('/admin/cosmetics/items')
				.body({type: 'avatar_decoration', name: 'Ring', availability: 'free', asset: pngOf(524_288)})
				.expect(200)
				.execute();
			await createBuilder(harness, admin.token)
				.post('/admin/cosmetics/items')
				.body({type: 'avatar_decoration', name: 'Ring+', availability: 'free', asset: pngOf(524_289)})
				.expect(400, APIErrorCodes.INVALID_FORM_BODY)
				.execute();
		});

		it("holds a new image to the limit of the item's own type", async () => {
			const frame = await createItem({type: 'avatar_decoration', name: 'Ring', availability: 'free'});
			const ultra = await createItem({type: 'avatar_ultra', name: 'Kuzgun', availability: 'free'});
			await createBuilder(harness, admin.token)
				.patch(`/admin/cosmetics/items/${frame.id}`)
				.body({asset: pngOf(524_289)})
				.expect(400, APIErrorCodes.INVALID_FORM_BODY)
				.execute();
			await createBuilder(harness, admin.token)
				.patch(`/admin/cosmetics/items/${ultra.id}`)
				.body({asset: pngOf(1_228_800)})
				.expect(200)
				.execute();
		});
	});
});
