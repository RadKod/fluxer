// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	createAuthHarness,
	createTestAccount,
	createUniqueEmail,
	disableSso,
	enableSso,
	setUserACLs,
	type TestAccount,
} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {getUserRepository} from '@app/api/middleware/ServiceSingletons';
import type {ApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder, createBuilderWithoutAuth} from '@app/api/test/TestRequestBuilder';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';

interface Identity {
	email: string;
	sub: string;
}

interface SignedIn {
	token: string;
	user_id: string;
}

describe('SSO sign-up language', () => {
	let harness: ApiTestHarness;
	let admin: TestAccount;

	const setCollectDateOfBirth = (collect: boolean) =>
		createBuilder(harness, admin.token)
			.patch('/admin/instance/config')
			.body({app_public: {registration: {collect_date_of_birth: collect}}})
			.execute();

	const newIdentity = (label: string): Identity => ({
		email: createUniqueEmail(`sso-locale-${label}`),
		sub: `itest-sso-locale-${label}-${Date.now()}`,
	});

	const signInWithSso = async (identity: Identity, acceptLanguage?: string): Promise<SignedIn> => {
		const start = await createBuilderWithoutAuth<{state: string}>(harness).post('/auth/sso/start').body({}).execute();
		const complete = createBuilderWithoutAuth<SignedIn>(harness).post('/auth/sso/complete');
		if (acceptLanguage) {
			complete.header('accept-language', acceptLanguage);
		}
		return complete.body({code: JSON.stringify({...identity, email_verified: true}), state: start.state}).execute();
	};

	const languagesOf = async ({token, user_id}: SignedIn) => {
		const settings = await createBuilder<{locale: string}>(harness, token).get('/users/@me/settings').execute();
		const account = await getUserRepository().findUnique(createUserID(BigInt(user_id)));
		return {settings: settings.locale, account: account?.locale ?? null};
	};

	beforeAll(async () => {
		harness = await createAuthHarness();
	});
	beforeEach(async () => {
		await harness.reset();
		admin = await setUserACLs(harness, await createTestAccount(harness), [
			'admin:authenticate',
			'instance:config:update',
			'instance:config:view',
		]);
		await enableSso(harness, admin.token);
		await setCollectDateOfBirth(false);
	});
	afterEach(async () => {
		await disableSso(harness, admin.token);
		await setCollectDateOfBirth(true);
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	it('gives a new SSO account the language its request carries', async () => {
		const signedIn = await signInWithSso(newIdentity('tr'), 'tr-TR,tr;q=0.9,en;q=0.8');
		expect(await languagesOf(signedIn)).toEqual({settings: 'tr', account: 'tr'});
	});

	it("keeps upstream's en-US settings and empty account locale for a request that carries no language", async () => {
		expect(await languagesOf(await signInWithSso(newIdentity('none')))).toEqual({settings: 'en-US', account: null});
	});

	it('never rewrites the language of an account that signs in again', async () => {
		const identity = newIdentity('again');
		await signInWithSso(identity, 'de');
		expect(await languagesOf(await signInWithSso(identity, 'tr'))).toEqual({settings: 'de', account: 'de'});
	});
});
