// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	createAuthHarness,
	createTestAccount,
	createUniqueEmail,
	createUniqueUsername,
	setUserACLs,
	type TestAccount,
} from '@app/api/auth/tests/AuthTestUtils';
import {Config} from '@app/api/Config';
import type {ApiTestHarness} from '@app/api/test/ApiTestHarness';
import {TEST_CREDENTIALS, TEST_USER_DATA} from '@app/api/test/TestConstants';
import {createBuilder, createBuilderWithoutAuth} from '@app/api/test/TestRequestBuilder';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

interface Legal {
	terms_url: string | null;
	privacy_url: string | null;
	source_url: string | null;
}

interface InstanceConfig {
	app_public: {legal: Legal};
}

const SOURCE_URL = 'https://x.test/kaynak';

describe('instance source code offer (app_public.legal.source_url)', () => {
	let harness: ApiTestHarness;
	let admin: TestAccount;

	const discoveredLegal = async () =>
		(await createBuilderWithoutAuth<InstanceConfig>(harness).get('/.well-known/fluxer').execute()).app_public.legal;
	const adminLegal = async () =>
		(await createBuilder<InstanceConfig>(harness, admin.token).get('/admin/instance/config').execute()).app_public
			.legal;
	const setLegal = (legal: Record<string, unknown>) =>
		createBuilder(harness, admin.token)
			.patch('/admin/instance/config')
			.body({app_public: {legal}})
			.expect(200)
			.execute();

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
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	it('offers no source URL until an administrator sets one', async () => {
		expect((await discoveredLegal()).source_url).toBeNull();
		expect((await adminLegal()).source_url).toBeNull();
	});

	it('advertises the source URL an administrator sets', async () => {
		await setLegal({source_url: ` ${SOURCE_URL} `});
		expect((await discoveredLegal()).source_url).toBe(SOURCE_URL);
		expect((await adminLegal()).source_url).toBe(SOURCE_URL);
	});

	it('rejects a source URL that is not http(s)', async () => {
		for (const source_url of ['javascript:alert(1)', 'ftp://x']) {
			await createBuilder(harness, admin.token)
				.patch('/admin/instance/config')
				.body({app_public: {legal: {source_url}}})
				.expect(400, 'INVALID_FORM_BODY')
				.execute();
		}
		expect((await discoveredLegal()).source_url).toBeNull();
	});

	it('accepts an http(s) source URL in any letter case', async () => {
		await setLegal({source_url: 'HTTPS://X.TEST/k'});
		expect((await discoveredLegal()).source_url).toBe('HTTPS://X.TEST/k');
		await setLegal({source_url: '   '});
		expect((await discoveredLegal()).source_url).toBeNull();
	});

	it('clears the source URL when the admin form sends it blank', async () => {
		await setLegal({source_url: SOURCE_URL});
		// The admin form sends every legal field. The request Validator turns an object whose values are all null into
		// null, so a blank source URL is sent next to the other legal URLs, as the form does.
		await setLegal({terms_url: 'https://x.test/terms', privacy_url: '', source_url: ''});
		expect(await discoveredLegal()).toEqual({terms_url: 'https://x.test/terms', privacy_url: null, source_url: null});
	});

	it('keeps the source URL when only another legal URL changes', async () => {
		await setLegal({source_url: SOURCE_URL});
		await setLegal({terms_url: 'https://x.test/terms'});
		expect(await discoveredLegal()).toEqual({
			terms_url: 'https://x.test/terms',
			privacy_url: null,
			source_url: SOURCE_URL,
		});
	});

	it('does not ask new accounts for legal consent when only the source URL is set', async () => {
		const previousSelfHosted = Config.instance.selfHosted;
		Config.instance.selfHosted = true;
		try {
			await setLegal({source_url: SOURCE_URL});
			expect(await discoveredLegal()).toEqual({terms_url: null, privacy_url: null, source_url: SOURCE_URL});
			await createBuilder(harness, '')
				.post('/auth/register')
				.body({
					email: createUniqueEmail('sourceurl'),
					username: createUniqueUsername('sourceurl'),
					global_name: TEST_USER_DATA.DEFAULT_GLOBAL_NAME,
					password: TEST_CREDENTIALS.STRONG_PASSWORD,
					date_of_birth: TEST_USER_DATA.DEFAULT_DATE_OF_BIRTH,
					consent: false,
				})
				.expect(200)
				.execute();
		} finally {
			Config.instance.selfHosted = previousSelfHosted;
		}
	});
});
