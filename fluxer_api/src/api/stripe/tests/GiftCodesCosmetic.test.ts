// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, setUserACLs, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {SYSTEM_USER_ID} from '@app/api/constants/Core';
import {CosmeticService} from '@app/api/cosmetics/CosmeticService';
import {upsertOne} from '@app/api/database/CassandraQueryExecution';
import {
	getCacheService,
	getCosmeticService,
	getPremiumLedgerRepository,
	getUserRepository,
} from '@app/api/middleware/ServiceSingletons';
import {GiftCodes} from '@app/api/Tables';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder, createBuilderWithoutAuth} from '@app/api/test/TestRequestBuilder';
import {checkIsPremium} from '@app/api/user/UserHelpers';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import type {CosmeticItemResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const ADMIN_ACLS = [
	AdminACLs.AUTHENTICATE,
	AdminACLs.INSTANCE_CONFIG_VIEW,
	AdminACLs.INSTANCE_CONFIG_UPDATE,
	AdminACLs.GIFT_CODES_GENERATE,
	AdminACLs.COSMETICS_MANAGE,
];

describe('gift codes that carry a cosmetic item', () => {
	let harness: ApiTestHarness;
	let admin: TestAccount;
	let previousSelfHosted: boolean;

	beforeAll(async () => {
		previousSelfHosted = Config.instance.selfHosted;
		Config.instance.selfHosted = true;
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
		admin = await setUserACLs(harness, await createTestAccount(harness), ADMIN_ACLS);
		await createBuilder(harness, admin.token)
			.patch('/admin/instance/config')
			.body({policy: {premium_mode: 'mirror'}})
			.execute();
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});
	afterAll(async () => {
		await harness?.shutdown();
		Config.instance.selfHosted = previousSelfHosted;
	});

	function createItem(type: string, availability: string): Promise<CosmeticItemResponse> {
		return createBuilder<CosmeticItemResponse>(harness, admin.token)
			.post('/admin/cosmetics/items')
			.body({type, name: `Item ${type}`, availability, asset: PNG})
			.expect(HTTP_STATUS.OK)
			.execute();
	}

	function generateItemCodes(itemId: string, count: number, token = admin.token) {
		return createBuilder<{codes: Array<string>}>(harness, token)
			.post('/admin/gift-codes/cosmetic')
			.body({count, item_id: itemId});
	}

	async function itemCodes(item: CosmeticItemResponse, count: number): Promise<Array<string>> {
		const {codes} = await generateItemCodes(item.id, count).expect(HTTP_STATUS.OK).execute();
		return codes.map((url) => url.slice(url.lastIndexOf('/') + 1));
	}

	async function premiumCode(): Promise<string> {
		const {codes} = await createBuilder<{codes: Array<string>}>(harness, admin.token)
			.post('/admin/gift-codes')
			.body({count: 1, duration_type: 'months', duration_quantity: 1})
			.execute();
		return codes[0]!.slice(codes[0]!.lastIndexOf('/') + 1);
	}

	function redeem(account: TestAccount, code: string) {
		return createBuilder(harness, account.token).post(`/gifts/${code}/redeem`);
	}

	function idOf(account: TestAccount): UserID {
		return createUserID(BigInt(account.userId));
	}

	function owns(account: TestAccount, item: CosmeticItemResponse): Promise<boolean> {
		return getCosmeticService().isOwned(idOf(account), BigInt(item.id));
	}

	async function redeemer(code: string) {
		return (await getUserRepository().findGiftCode(code))?.redeemedByUserId ?? null;
	}

	async function expectNoPremium(account: TestAccount): Promise<void> {
		const user = (await getUserRepository().findUnique(idOf(account)))!;
		expect(checkIsPremium(user)).toBe(false);
		expect(user.premiumType ?? 0).toBe(0);
		expect(await getPremiumLedgerRepository().find(idOf(account))).toBeNull();
	}

	it('redeems an item code: owns and wears the item, premium untouched', async () => {
		const item = await createItem('avatar_ultra', 'owned');
		const [code] = await itemCodes(item, 1);
		const account = await createTestAccount(harness);

		await redeem(account, code!).expect(HTTP_STATUS.NO_CONTENT).execute();

		expect(await owns(account, item)).toBe(true);
		const user = (await getUserRepository().findUnique(idOf(account)))!;
		expect(user.avatarUltraId).toBe(BigInt(item.id));
		await expectNoPremium(account);
		expect(await redeemer(code!)).toBe(idOf(account));
	});

	it('a row that also carries a zero duration still gives only the item', async () => {
		const item = await createItem('nameplate', 'owned');
		const code = 'ZeroDurationItemCodeZeroDuration';
		await upsertOne(
			GiftCodes.insert({
				code,
				duration_months: 0,
				duration_type: 'months',
				duration_quantity: 0,
				created_at: new Date(),
				created_by_user_id: SYSTEM_USER_ID,
				redeemed_at: null,
				redeemed_by_user_id: null,
				stripe_payment_intent_id: null,
				visionary_sequence_number: null,
				checkout_session_id: null,
				revoked_at: null,
				premium_reversed_seconds: null,
				cosmetic_item_id: BigInt(item.id),
				version: 1,
			}),
		);
		const account = await createTestAccount(harness);

		await redeem(account, code).expect(HTTP_STATUS.NO_CONTENT).execute();

		expect(await owns(account, item)).toBe(true);
		await expectNoPremium(account);
	});

	it('an item the account owns answers COSMETIC_ALREADY_OWNED and leaves the code unused', async () => {
		const item = await createItem('nameplate', 'owned');
		const [first, second] = await itemCodes(item, 2);
		const account = await createTestAccount(harness);
		await redeem(account, first!).expect(HTTP_STATUS.NO_CONTENT).execute();

		await redeem(account, second!).expect(HTTP_STATUS.CONFLICT, APIErrorCodes.COSMETIC_ALREADY_OWNED).execute();

		expect(await redeemer(second!)).toBeNull();
		const other = await createTestAccount(harness);
		await redeem(other, second!).expect(HTTP_STATUS.NO_CONTENT).execute();
		expect(await owns(other, item)).toBe(true);
	});

	it('two codes for the same item at once spend only one', async () => {
		const item = await createItem('nameplate', 'owned');
		const [first, second] = await itemCodes(item, 2);
		const account = await createTestAccount(harness);
		// The second code lands while the first one is delivering the item, before the account owns it.
		const deliverOwned = CosmeticService.prototype.deliverOwned;
		let secondResponse: Promise<{response: Response; json: unknown}> | null = null;
		vi.spyOn(CosmeticService.prototype, 'deliverOwned').mockImplementation(async function (
			this: CosmeticService,
			...args
		) {
			if (secondResponse === null) {
				secondResponse = redeem(account, second!).executeRaw();
				await secondResponse;
			}
			return deliverOwned.apply(this, args);
		});

		const firstResponse = await redeem(account, first!).executeRaw();
		const secondResult = await secondResponse!;

		expect(firstResponse.response.status).toBe(HTTP_STATUS.NO_CONTENT);
		expect([APIErrorCodes.COSMETIC_ALREADY_OWNED, APIErrorCodes.STRIPE_GIFT_REDEMPTION_IN_PROGRESS]).toContain(
			(secondResult.json as {code: string}).code,
		);
		expect(await redeemer(first!)).toBe(idOf(account));
		expect(await redeemer(second!)).toBeNull();
		expect(await owns(account, item)).toBe(true);
	});

	it('a code goes to one account only', async () => {
		const item = await createItem('nameplate', 'owned');
		const [code] = await itemCodes(item, 1);
		const [first, second] = [await createTestAccount(harness), await createTestAccount(harness)];
		await redeem(first, code!).expect(HTTP_STATUS.NO_CONTENT).execute();

		await redeem(second, code!).expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.GIFT_CODE_ALREADY_REDEEMED).execute();

		expect(await owns(second, item)).toBe(false);
		expect(await redeemer(code!)).toBe(idOf(first));
	});

	it('a resubmitted own code does not give back a taken-back item', async () => {
		const item = await createItem('nameplate', 'owned');
		const [code] = await itemCodes(item, 1);
		const account = await createTestAccount(harness);
		await redeem(account, code!).expect(HTTP_STATUS.NO_CONTENT).execute();
		await createBuilder(harness, admin.token)
			.delete(`/admin/users/${account.userId}/cosmetics/${item.id}`)
			.expect(HTTP_STATUS.OK)
			.execute();

		await redeem(account, code!).expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.GIFT_CODE_ALREADY_REDEEMED).execute();
		// Without the KV sentinels the owner's retry resumes its own claim; the delivery row still refuses it.
		const cache = getCacheService();
		const get = cache.get.bind(cache);
		vi.spyOn(cache, 'get').mockImplementation(async (key: string) =>
			key.startsWith('gift_redeem_applied:') || key.startsWith('redeemed_gift_codes:') ? null : get(key),
		);
		await redeem(account, code!).expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.GIFT_CODE_ALREADY_REDEEMED).execute();

		expect(await owns(account, item)).toBe(false);
	});

	it('GET /gifts/:code answers an item code as unknown', async () => {
		const item = await createItem('nameplate', 'owned');
		const [code] = await itemCodes(item, 1);
		const premium = await premiumCode();

		await createBuilderWithoutAuth(harness)
			.get(`/gifts/${code}`)
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_GIFT_CODE)
			.execute();

		const gift = await createBuilderWithoutAuth<Record<string, unknown>>(harness)
			.get(`/gifts/${premium}`)
			.expect(HTTP_STATUS.OK)
			.execute();
		expect(Object.keys(gift).sort()).toEqual(['code', 'created_by', 'duration_quantity', 'duration_type', 'redeemed']);
		expect(gift).toMatchObject({code: premium, duration_type: 'months', duration_quantity: 1, redeemed: false});
	});

	it('GET /shop/codes/:code previews an item code and a premium code', async () => {
		const item = await createItem('avatar_ultra', 'owned');
		const [code] = await itemCodes(item, 1);
		const premium = await premiumCode();
		const preview = (value: string) => createBuilderWithoutAuth(harness).get(`/shop/codes/${value}`);

		expect(await preview(code!).expect(HTTP_STATUS.OK).execute()).toEqual({
			code,
			redeemed: false,
			grant: {type: 'cosmetic', item},
		});
		expect(await preview(premium).expect(HTTP_STATUS.OK).execute()).toEqual({
			code: premium,
			redeemed: false,
			grant: {type: 'premium', duration_type: 'months', duration_quantity: 1},
		});
		await redeem(await createTestAccount(harness), code!)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		expect(await preview(code!).expect(HTTP_STATUS.OK).execute()).toMatchObject({redeemed: true});
		await preview('Unkn0wnC0deUnkn0wnC0deUnkn0wnC0d')
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_GIFT_CODE)
			.execute();
	});

	it('item codes need both GIFT_CODES_GENERATE and COSMETICS_MANAGE', async () => {
		const item = await createItem('nameplate', 'owned');
		for (const acl of [AdminACLs.GIFT_CODES_GENERATE, AdminACLs.COSMETICS_MANAGE]) {
			const partial = await setUserACLs(harness, await createTestAccount(harness), [AdminACLs.AUTHENTICATE, acl]);
			await generateItemCodes(item.id, 1, partial.token).expect(HTTP_STATUS.FORBIDDEN).execute();
		}
	});

	it('item codes take an owned-availability item only', async () => {
		for (const availability of ['premium', 'free']) {
			const item = await createItem('nameplate', availability);
			await generateItemCodes(item.id, 1).expect(HTTP_STATUS.BAD_REQUEST).execute();
		}
		await generateItemCodes('123456789012345678', 1).expect(HTTP_STATUS.BAD_REQUEST).execute();
	});

	it('an item code batch returns links and writes no creator index', async () => {
		const item = await createItem('nameplate', 'owned');
		const {codes: links} = await generateItemCodes(item.id, 3).expect(HTTP_STATUS.OK).execute();

		expect(links).toHaveLength(3);
		for (const link of links) {
			expect(link.startsWith(`${Config.endpoints.gift.replace(/\/$/, '')}/`)).toBe(true);
			const code = link.slice(link.lastIndexOf('/') + 1);
			expect(code).toMatch(/^[A-Za-z0-9]{32}$/);
			const row = (await getUserRepository().findGiftCode(code))!;
			expect([row.cosmeticItemId, row.durationType, row.durationQuantity]).toEqual([BigInt(item.id), null, null]);
		}
		expect(await getUserRepository().findGiftCodesByCreator(SYSTEM_USER_ID)).toEqual([]);
	});
});
