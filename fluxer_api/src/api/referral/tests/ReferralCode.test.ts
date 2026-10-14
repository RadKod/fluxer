// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {getInstanceConfigRepository, getReferralRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder, createBuilderWithoutAuth} from '@app/api/test/TestRequestBuilder';
import type {ReferralMeResponse} from '@fluxer/schema/src/domains/referral/ReferralResponseSchemas';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

async function getMe(harness: ApiTestHarness, token: string) {
	return createBuilder<ReferralMeResponse>(harness, token).get('/users/@me/referral').execute();
}

describe('GET /users/@me/referral code', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	beforeEach(async () => {
		await harness.reset();
		await getInstanceConfigRepository().updateReferralConfig(() => ({enabled: true}));
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		await harness?.shutdown();
	});

	it('GET creates one code, second GET returns same', async () => {
		const account = await createTestAccount(harness);
		const first = await getMe(harness, account.token);
		const second = await getMe(harness, account.token);

		expect(first.enabled).toBe(true);
		expect(first.code).not.toBeNull();
		expect(second.code).toBe(first.code);
		expect(await getReferralRepository().getCodeOwner(first.code!)).toBe(createUserID(BigInt(account.userId)));
	});

	it('code matches ^[a-z2-7]{10}$', async () => {
		for (let n = 0; n < 3; n++) {
			const account = await createTestAccount(harness);
			expect((await getMe(harness, account.token)).code).toMatch(/^[a-z2-7]{10}$/);
		}
	});

	it('two first reads at once agree on one code', async () => {
		const account = await createTestAccount(harness);
		const [a, b] = await Promise.all([getMe(harness, account.token), getMe(harness, account.token)]);
		expect(a.code).toBe(b.code);
		expect((await getReferralRepository().getUserReferral(createUserID(BigInt(account.userId))))?.code).toBe(a.code);
	});

	it('retries on collision', async () => {
		const account = await createTestAccount(harness);
		const claim = vi
			.spyOn(getReferralRepository(), 'insertCodeIfAbsent')
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(false);
		const me = await getMe(harness, account.token);
		expect(claim).toHaveBeenCalledTimes(3);
		expect(me.code).toBe(claim.mock.calls[2]![0]);
		expect(claim.mock.calls[0]![0]).not.toBe(claim.mock.calls[1]![0]);
	});

	it('disabled → enabled false, code null, nothing written', async () => {
		await getInstanceConfigRepository().updateReferralConfig(() => ({enabled: false}));
		const account = await createTestAccount(harness);
		const claim = vi.spyOn(getReferralRepository(), 'insertCodeIfAbsent');
		const me = await getMe(harness, account.token);

		expect(me).toMatchObject({enabled: false, code: null});
		expect(claim).not.toHaveBeenCalled();
		expect(await getReferralRepository().getUserReferral(createUserID(BigInt(account.userId)))).toBeNull();
	});

	it('a code made while open is hidden while closed', async () => {
		const account = await createTestAccount(harness);
		const open = await getMe(harness, account.token);
		await getInstanceConfigRepository().updateReferralConfig(() => ({enabled: false}));
		expect((await getMe(harness, account.token)).code).toBeNull();
		await getInstanceConfigRepository().updateReferralConfig(() => ({enabled: true}));
		expect((await getMe(harness, account.token)).code).toBe(open.code);
	});

	it('OAuth2 bearer rejected', async () => {
		const account = await createTestAccount(harness);
		const oauth = await createBuilder<{token: string}>(harness, '')
			.post('/test/oauth2/access-token')
			.body({user_id: account.userId, scopes: ['identify']})
			.execute();
		await createBuilder(harness, `Bearer ${oauth.token}`).get('/users/@me/referral').expect(403).execute();
	});

	it('unauthenticated 401', async () => {
		await createBuilderWithoutAuth(harness).get('/users/@me/referral').expect(401).execute();
	});
});
