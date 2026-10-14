// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, setUserACLs, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {Config} from '@app/api/Config';
import {Logger} from '@app/api/Logger';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import type {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder, createBuilderWithoutAuth} from '@app/api/test/TestRequestBuilder';
import {UserRepository} from '@app/api/user/repositories/UserRepository';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('gift code logging', () => {
	let harness: ApiTestHarness;
	let previousSelfHosted: boolean;

	beforeAll(async () => {
		previousSelfHosted = Config.instance.selfHosted;
		Config.instance.selfHosted = true;
		harness = await createApiTestHarness();
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});
	afterAll(async () => {
		await harness?.shutdown();
		Config.instance.selfHosted = previousSelfHosted;
	});

	async function codesFrom(admin: TestAccount, path: string, body: Record<string, unknown>): Promise<Array<string>> {
		const {codes} = await createBuilder<{codes: Array<string>}>(harness, admin.token)
			.post(path)
			.body(body)
			.expect(HTTP_STATUS.OK)
			.execute();
		return codes.map((url) => url.slice(url.lastIndexOf('/') + 1));
	}

	it('never logs a code at info or above, request log included', async () => {
		await harness.reset();
		const admin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.INSTANCE_CONFIG_VIEW,
			AdminACLs.INSTANCE_CONFIG_UPDATE,
			AdminACLs.GIFT_CODES_GENERATE,
			AdminACLs.COSMETICS_MANAGE,
		]);
		await createBuilder(harness, admin.token)
			.patch('/admin/instance/config')
			.body({policy: {premium_mode: 'mirror'}})
			.execute();
		const item = await createBuilder<{id: string}>(harness, admin.token)
			.post('/admin/cosmetics/items')
			.body({type: 'nameplate', name: 'Plate', availability: 'owned', asset: PNG})
			.expect(HTTP_STATUS.OK)
			.execute();
		const premiumCodes = await codesFrom(admin, '/admin/gift-codes', {
			count: 2,
			duration_type: 'months',
			duration_quantity: 1,
		});
		const itemCodes = await codesFrom(admin, '/admin/gift-codes/cosmetic', {count: 1, item_id: item.id});
		const unknown = 'Unkn0wnC0deUnkn0wnC0deUnkn0wnC0d';
		const [premium, lostUser] = premiumCodes as [string, string];
		const [itemCode] = itemCodes as [string];
		const [first, second] = [await createTestAccount(harness), await createTestAccount(harness)];

		// NoopLogger's levels are instance fields and Logger.child({}) hands back that instance, so these spies see
		// what the app logs (a spy on NoopLogger.prototype would see nothing); harness.logger is
		// where the request log (Request completed) goes.
		const appLogger = Logger.child({}) as unknown as NoopLogger;
		const appLogs = (['info', 'warn', 'error', 'fatal'] as const).map((level) => vi.spyOn(appLogger, level));
		const requestLog = vi.spyOn(harness.logger, 'info');
		Logger.warn({probe: true}, 'probe');
		expect(appLogs[1]!.mock.calls).toEqual([[{probe: true}, 'probe']]);

		const redeem = (account: TestAccount, code: string) =>
			createBuilder(harness, account.token).post(`/gifts/${code}/redeem`);
		await createBuilderWithoutAuth(harness).get(`/gifts/${premium}`).expect(HTTP_STATUS.OK).execute();
		await createBuilderWithoutAuth(harness).get(`/shop/codes/${premium}`).expect(HTTP_STATUS.OK).execute();
		await createBuilderWithoutAuth(harness).get(`/shop/codes/${itemCode}`).expect(HTTP_STATUS.OK).execute();
		await createBuilderWithoutAuth(harness).get(`/gifts/${itemCode}`).expect(HTTP_STATUS.NOT_FOUND).execute();
		await redeem(first, premium).expect(HTTP_STATUS.NO_CONTENT).execute();
		await redeem(first, itemCode).expect(HTTP_STATUS.NO_CONTENT).execute();
		await redeem(second, premium).expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.GIFT_CODE_ALREADY_REDEEMED).execute();
		await redeem(second, itemCode).expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.GIFT_CODE_ALREADY_REDEEMED).execute();
		await redeem(second, unknown).expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_GIFT_CODE).execute();
		await createBuilderWithoutAuth(harness).get(`/gifts/${unknown}`).expect(HTTP_STATUS.NOT_FOUND).execute();
		// The redeemer vanishes between the code read and the user read: the service's own lookup answers null.
		const findGiftCode = UserRepository.prototype.findGiftCode;
		const findUnique = UserRepository.prototype.findUnique;
		let codeRead = false;
		vi.spyOn(UserRepository.prototype, 'findGiftCode').mockImplementation(async function (
			this: UserRepository,
			...args
		) {
			codeRead = true;
			return findGiftCode.apply(this, args);
		});
		vi.spyOn(UserRepository.prototype, 'findUnique').mockImplementation(async function (this: UserRepository, ...args) {
			return codeRead ? null : findUnique.apply(this, args);
		});
		await redeem(second, lostUser).expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_USER).execute();

		const errorLogs = appLogs[2]!.mock.calls as Array<Array<unknown>>;
		expect(errorLogs.some(([, message]) => message === 'Redeemer user not found during gift redemption')).toBe(true);
		const completed = (requestLog.mock.calls as Array<Array<unknown>>).filter(
			([, message]) => message === 'Request completed',
		);
		expect(completed.length).toBeGreaterThanOrEqual(11);
		const captured = [...appLogs.flatMap((spy) => spy.mock.calls), ...requestLog.mock.calls];
		const text = JSON.stringify(captured, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
		for (const code of [premium, lostUser, itemCode, unknown]) {
			expect(text).not.toContain(code);
		}
	});
});
