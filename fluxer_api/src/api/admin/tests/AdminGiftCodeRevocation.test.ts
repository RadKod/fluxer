// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, setUserACLs, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {getAdminRepository, getUserRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {UserRepository} from '@app/api/user/repositories/UserRepository';
import {checkIsPremium} from '@app/api/user/UserHelpers';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

interface RevokeResponse {
	revoked: Array<string>;
	already_redeemed: Array<string>;
	not_found: Array<string>;
}

const UNKNOWN_CODE = 'Unkn0wnC0deUnkn0wnC0deUnkn0wnC0d';

describe('admin gift code revocation on a self-hosted instance', () => {
	let harness: ApiTestHarness;
	let previousSelfHosted: boolean;

	beforeAll(async () => {
		previousSelfHosted = Config.instance.selfHosted;
		Config.instance.selfHosted = true;
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});
	afterAll(async () => {
		await harness?.shutdown();
		Config.instance.selfHosted = previousSelfHosted;
	});

	async function createAdmin(acls: Array<string> = [AdminACLs.GIFT_CODES_REVOKE]): Promise<TestAccount> {
		return setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.INSTANCE_CONFIG_VIEW,
			AdminACLs.INSTANCE_CONFIG_UPDATE,
			AdminACLs.GIFT_CODES_GENERATE,
			...acls,
		]);
	}

	async function setPremiumMode(admin: TestAccount, premiumMode: 'mirror' | 'everyone'): Promise<void> {
		await createBuilder(harness, admin.token)
			.patch('/admin/instance/config')
			.body({policy: {premium_mode: premiumMode}})
			.execute();
	}

	async function generateCodes(admin: TestAccount, count: number): Promise<Array<string>> {
		const {codes} = await createBuilder<{codes: Array<string>}>(harness, admin.token)
			.post('/admin/gift-codes')
			.body({count, duration_type: 'months', duration_quantity: 1})
			.execute();
		return codes.map((url) => url.slice(url.lastIndexOf('/') + 1));
	}

	function revoke(admin: TestAccount, codes: Array<string>) {
		return createBuilder<RevokeResponse>(harness, admin.token).post('/admin/gift-codes/revoke').body({codes});
	}

	function redeem(account: TestAccount, code: string) {
		return createBuilder(harness, account.token).post(`/gifts/${code}/redeem`);
	}

	async function isPremium(account: TestAccount): Promise<boolean> {
		return checkIsPremium((await getUserRepository().findUnique(createUserID(BigInt(account.userId))))!);
	}

	it('revokes an unused key so it can no longer be read or redeemed', async () => {
		const admin = await createAdmin();
		await setPremiumMode(admin, 'mirror');
		const [code] = await generateCodes(admin, 1);
		const account = await createTestAccount(harness);

		const result = await revoke(admin, [code!]).expect(HTTP_STATUS.OK).execute();

		expect(result).toEqual({revoked: [code], already_redeemed: [], not_found: []});
		expect((await getUserRepository().findGiftCode(code!))?.revokedAt).toBeInstanceOf(Date);
		await createBuilder(harness, account.token)
			.get(`/gifts/${code}`)
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_GIFT_CODE)
			.execute();
		await redeem(account, code!).expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_GIFT_CODE).execute();
		expect(await isPremium(account)).toBe(false);
	});

	it('leaves a redeemed key alone and lists it apart from the revoked and unknown ones', async () => {
		const admin = await createAdmin();
		await setPremiumMode(admin, 'mirror');
		const [used, unused] = await generateCodes(admin, 2);
		const account = await createTestAccount(harness);
		await redeem(account, used!).expect(HTTP_STATUS.NO_CONTENT).execute();

		const result = await revoke(admin, [used!, unused!, UNKNOWN_CODE, unused!]).expect(HTTP_STATUS.OK).execute();

		expect(result).toEqual({revoked: [unused], already_redeemed: [used], not_found: [UNKNOWN_CODE]});
		expect((await getUserRepository().findGiftCode(used!))?.revokedAt).toBeNull();
		expect(await isPremium(account)).toBe(true);
	});

	it('counts an already revoked key as revoked when the request is repeated', async () => {
		const admin = await createAdmin();
		await setPremiumMode(admin, 'mirror');
		const [code] = await generateCodes(admin, 1);
		await revoke(admin, [code!]).expect(HTTP_STATUS.OK).execute();
		const revokedAt = (await getUserRepository().findGiftCode(code!))?.revokedAt;

		const result = await revoke(admin, [code!]).expect(HTTP_STATUS.OK).execute();

		expect(result).toEqual({revoked: [code], already_redeemed: [], not_found: []});
		expect((await getUserRepository().findGiftCode(code!))?.revokedAt).toEqual(revokedAt);
	});

	it('does not revoke a key that is redeemed after the admin looked it up', async () => {
		const admin = await createAdmin();
		await setPremiumMode(admin, 'mirror');
		const [code] = await generateCodes(admin, 1);
		const account = await createTestAccount(harness);
		const revokeGiftCode = UserRepository.prototype.revokeGiftCode;
		vi.spyOn(UserRepository.prototype, 'revokeGiftCode').mockImplementation(async function (
			this: UserRepository,
			...args
		) {
			await redeem(account, code!).expect(HTTP_STATUS.NO_CONTENT).execute();
			return revokeGiftCode.apply(this, args);
		});

		const result = await revoke(admin, [code!]).expect(HTTP_STATUS.OK).execute();

		expect(result).toEqual({revoked: [], already_redeemed: [code], not_found: []});
		expect((await getUserRepository().findGiftCode(code!))?.revokedAt).toBeNull();
		expect(await isPremium(account)).toBe(true);
	});

	it('refuses a key revoked after the redemption checked it', async () => {
		const admin = await createAdmin();
		await setPremiumMode(admin, 'mirror');
		const [code] = await generateCodes(admin, 1);
		const account = await createTestAccount(harness);
		const redeemGiftCode = UserRepository.prototype.redeemGiftCode;
		vi.spyOn(UserRepository.prototype, 'redeemGiftCode').mockImplementation(async function (
			this: UserRepository,
			...args
		) {
			await revoke(admin, [code!]).expect(HTTP_STATUS.OK).execute();
			return redeemGiftCode.apply(this, args);
		});

		await redeem(account, code!).expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_GIFT_CODE).execute();

		const gift = await getUserRepository().findGiftCode(code!);
		expect(gift?.revokedAt).toBeInstanceOf(Date);
		expect(gift?.redeemedByUserId).toBeNull();
		expect(await isPremium(account)).toBe(false);
	});

	it('records one audit entry with the outcome counts and no codes', async () => {
		const admin = await createAdmin();
		await setPremiumMode(admin, 'mirror');
		const [used, unused] = await generateCodes(admin, 2);
		await redeem(await createTestAccount(harness), used!)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();

		await revoke(admin, [used!, unused!, UNKNOWN_CODE])
			.header('X-Audit-Log-Reason', 'Leaked key batch')
			.expect(HTTP_STATUS.OK)
			.execute();

		const logs = (await getAdminRepository().listAllAuditLogsPaginated(100)).filter(
			(log) => log.action === 'revoke_gift_codes',
		);
		expect(logs).toHaveLength(1);
		expect(logs[0]!.adminUserId.toString()).toBe(admin.userId);
		expect(logs[0]!.targetType).toBe('gift_code');
		expect(logs[0]!.targetId).toBe(0n);
		expect(logs[0]!.auditLogReason).toBe('Leaked key batch');
		expect(Object.fromEntries(logs[0]!.metadata)).toEqual({
			count: '3',
			revoked: '1',
			already_redeemed: '1',
			not_found: '1',
		});
	});

	it('requires the revoke ACL', async () => {
		const admin = await createAdmin([]);
		await setPremiumMode(admin, 'mirror');
		const [code] = await generateCodes(admin, 1);

		await revoke(admin, [code!]).expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACL).execute();

		expect((await getUserRepository().findGiftCode(code!))?.revokedAt).toBeNull();
	});

	it('stays closed while premium is open to everyone', async () => {
		const admin = await createAdmin();
		await setPremiumMode(admin, 'mirror');
		const [code] = await generateCodes(admin, 1);
		await setPremiumMode(admin, 'everyone');

		await revoke(admin, [code!])
			.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.FEATURE_NOT_AVAILABLE_SELF_HOSTED)
			.execute();

		expect((await getUserRepository().findGiftCode(code!))?.revokedAt).toBeNull();
	});

	it('takes at most 100 codes per request', async () => {
		const admin = await createAdmin();
		await setPremiumMode(admin, 'mirror');
		const codes = Array.from({length: 101}, (_, i) => `${UNKNOWN_CODE.slice(0, 29)}${String(i).padStart(3, '0')}`);

		await revoke(admin, codes).expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.INVALID_FORM_BODY).execute();
		await revoke(admin, []).expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.INVALID_FORM_BODY).execute();
	});
});
