// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	createAuthHarness,
	createTestAccount,
	createUniqueEmail,
	createUniqueUsername,
	setUserACLs,
} from '@app/api/auth/tests/AuthTestUtils';
import {getConfig} from '@app/api/Config';
import {getInstanceConfigRepository} from '@app/api/middleware/ServiceSingletons';
import type {ApiTestHarness} from '@app/api/test/ApiTestHarness';
import {CAPTCHA_TEST_HEADER, useCheapCaptcha} from '@app/api/test/CaptchaTestUtils';
import {server} from '@app/api/test/msw/server';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder, createBuilderWithoutAuth} from '@app/api/test/TestRequestBuilder';
import {AccountIdentityModes} from '@fluxer/constants/src/AccountIdentityConstants';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {TURNSTILE_VERIFY_URL} from '@pkgs/captcha/src/providers/TurnstileProvider';
import {HttpResponse, http} from 'msw';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

const SITE_KEY = '0x4AAAAAAA-turnstile-site';
const SECRET_KEY = '0x4AAAAAAA-turnstile-secret';
const VALID_TOKEN = 'turnstile-token-that-cloudflare-accepts';

interface CaptchaReply {
	code?: string;
	captcha_provider?: string;
	turnstile_site_key?: string;
	altcha_challenge?: unknown;
}

let verifications: Array<URLSearchParams> = [];

function mockSiteverify(): void {
	verifications = [];
	server.use(
		http.post(TURNSTILE_VERIFY_URL, async ({request}) => {
			const form = new URLSearchParams(await request.text());
			verifications.push(form);
			const accepted = form.get('secret') === SECRET_KEY && form.get('response') === VALID_TOKEN;
			return HttpResponse.json(
				accepted ? {success: true} : {success: false, 'error-codes': ['invalid-input-response']},
			);
		}),
	);
}

async function useTurnstile(keys: {site?: string | null; secret?: string | null} = {}): Promise<void> {
	await getInstanceConfigRepository().setInstanceIntegrationsConfig({
		captcha: {
			provider: 'turnstile',
			turnstile_site_key: keys.site === undefined ? SITE_KEY : keys.site,
			turnstile_secret_key: keys.secret === undefined ? SECRET_KEY : keys.secret,
		},
	});
}

async function readDiscoveryCaptcha(harness: ApiTestHarness): Promise<{captcha: unknown; text: string}> {
	const {text, json} = await createBuilderWithoutAuth<{captcha: unknown}>(harness)
		.get('/.well-known/fluxer')
		.executeRaw();
	return {captcha: json.captcha, text};
}

describe('Turnstile captcha', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createAuthHarness();
	});

	beforeEach(async () => {
		await harness.reset();
		await useCheapCaptcha();
		await useTurnstile();
		mockSiteverify();
	});

	afterAll(async () => {
		await harness.shutdown();
	});

	it('advertises Turnstile and its site key in /.well-known/fluxer for the released mobile apps', async () => {
		const {captcha, text} = await readDiscoveryCaptcha(harness);
		expect(captcha).toEqual({provider: 'turnstile', turnstile_site_key: SITE_KEY});
		expect(text).not.toContain(SECRET_KEY);
	});

	it('asks for a Turnstile token on sign-up and accepts one Cloudflare verifies', async () => {
		const body = {
			email: createUniqueEmail('turnstile-register'),
			username: createUniqueUsername('turnstile'),
			global_name: 'Turnstile User',
			password: 'a-strong-password',
			date_of_birth: '2000-01-01',
			consent: true,
		};
		const required = await createBuilderWithoutAuth<CaptchaReply>(harness)
			.post('/auth/register')
			.header(CAPTCHA_TEST_HEADER, 'true')
			.body(body)
			.expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.CAPTCHA_REQUIRED)
			.execute();
		expect(required).toMatchObject({captcha_provider: 'turnstile', turnstile_site_key: SITE_KEY});
		expect(required.altcha_challenge).toBeUndefined();

		const registered = await createBuilderWithoutAuth<{token?: string}>(harness)
			.post('/auth/register')
			.header(CAPTCHA_TEST_HEADER, 'true')
			.header('X-Captcha-Token', VALID_TOKEN)
			.header('X-Captcha-Type', 'turnstile')
			.body(body)
			.execute();
		expect(registered.token).toBeTruthy();
		expect(verifications).toHaveLength(1);
		expect(verifications[0].get('secret')).toBe(SECRET_KEY);
		expect(verifications[0].get('response')).toBe(VALID_TOKEN);
		expect(verifications[0].get('remoteip')).toBeTruthy();
	});

	it('signs in with a verified Turnstile token and rejects one Cloudflare refuses', async () => {
		const account = await createTestAccount(harness);
		const login = () =>
			createBuilderWithoutAuth<{token?: string} & CaptchaReply>(harness)
				.post('/auth/login')
				.header(CAPTCHA_TEST_HEADER, 'true')
				.body({email: account.email, password: account.password});

		await login().expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.CAPTCHA_REQUIRED).execute();
		const rejected = await login()
			.header('X-Captcha-Token', 'forged-token')
			.expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.INVALID_CAPTCHA)
			.execute();
		expect(rejected).toMatchObject({captcha_provider: 'turnstile', turnstile_site_key: SITE_KEY});

		const signedIn = await login().header('X-Captcha-Token', VALID_TOKEN).execute();
		expect(signedIn.token).toBeTruthy();
	});

	it('guards the password reset request with Turnstile', async () => {
		const forgot = () =>
			createBuilderWithoutAuth<CaptchaReply>(harness)
				.post('/auth/forgot')
				.header(CAPTCHA_TEST_HEADER, 'true')
				.body({email: 'turnstile-nobody@example.com'});

		await forgot().expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.CAPTCHA_REQUIRED).execute();
		await forgot()
			.header('X-Captcha-Token', 'forged-token')
			.expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.INVALID_CAPTCHA)
			.execute();
		await forgot().header('X-Captcha-Token', VALID_TOKEN).expect(HTTP_STATUS.NO_CONTENT).execute();
	});

	it('guards account recovery with Turnstile on a username instance', async () => {
		const config = getConfig();
		const originalSelfHosted = config.instance.selfHosted;
		config.instance.selfHosted = true;
		try {
			await getInstanceConfigRepository().setAccountIdentityMode(AccountIdentityModes.USERNAME, 'setup');
			const recover = () =>
				createBuilderWithoutAuth<CaptchaReply>(harness)
					.post('/auth/recover')
					.header(CAPTCHA_TEST_HEADER, 'true')
					.body({login: 'nobody', recovery_key: 'not-a-real-key', password: 'a-strong-new-password'});

			await recover().expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.CAPTCHA_REQUIRED).execute();
			await recover()
				.header('X-Captcha-Token', 'forged-token')
				.expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.INVALID_CAPTCHA)
				.execute();
			const passed = await recover().header('X-Captcha-Token', VALID_TOKEN).executeRaw();
			expect([APIErrorCodes.CAPTCHA_REQUIRED, APIErrorCodes.INVALID_CAPTCHA]).not.toContain(passed.json?.code);
		} finally {
			config.instance.selfHosted = originalSelfHosted;
		}
	});

	it('sends an ALTCHA payload to Cloudflare instead of accepting it while Turnstile is the provider', async () => {
		const altchaShaped = Buffer.from(JSON.stringify({challenge: {}, solution: {}}), 'utf8').toString('base64');
		await createBuilderWithoutAuth(harness)
			.post('/auth/forgot')
			.header(CAPTCHA_TEST_HEADER, 'true')
			.header('X-Captcha-Token', altchaShaped)
			.header('X-Captcha-Type', 'altcha')
			.body({email: 'turnstile-nobody@example.com'})
			.expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.INVALID_CAPTCHA)
			.execute();
		expect(verifications).toHaveLength(1);
	});

	it('falls back to ALTCHA while the Turnstile secret is missing', async () => {
		await useTurnstile({secret: null});

		expect((await readDiscoveryCaptcha(harness)).captcha).toEqual({provider: 'altcha'});
		const required = await createBuilderWithoutAuth<CaptchaReply>(harness)
			.post('/auth/forgot')
			.header(CAPTCHA_TEST_HEADER, 'true')
			.body({email: 'turnstile-nobody@example.com'})
			.expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.CAPTCHA_REQUIRED)
			.execute();
		expect(required.captcha_provider).toBe('altcha');
		expect(verifications).toHaveLength(0);
	});

	it('turns Turnstile off with the admin captcha switch', async () => {
		await getInstanceConfigRepository().updateCaptchaConfig({enabled: false});

		expect((await readDiscoveryCaptcha(harness)).captcha).toEqual({provider: 'none'});
		await createBuilderWithoutAuth(harness)
			.post('/auth/forgot')
			.header(CAPTCHA_TEST_HEADER, 'true')
			.body({email: 'turnstile-nobody@example.com'})
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
	});

	it('lets an admin pick Turnstile and go back to ALTCHA without echoing the secret', async () => {
		await getInstanceConfigRepository().setInstanceIntegrationsConfig({
			captcha: {provider: null, turnstile_site_key: null, turnstile_secret_key: null},
		});
		const admin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.INSTANCE_CONFIG_VIEW,
			AdminACLs.INSTANCE_CONFIG_UPDATE,
		]);
		const patch = (captcha: Record<string, unknown>) =>
			createBuilder(harness, admin.token).patch('/admin/instance/config').body({integrations: {captcha}}).executeRaw();

		const picked = await patch({provider: 'turnstile', turnstile_site_key: SITE_KEY, turnstile_secret_key: SECRET_KEY});
		expect(picked.response.status).toBe(HTTP_STATUS.OK);
		expect(picked.text).not.toContain(SECRET_KEY);
		expect((picked.json as {integrations: {captcha: unknown}}).integrations.captcha).toEqual({
			provider: 'turnstile',
			effective_provider: 'turnstile',
			turnstile_site_key: SITE_KEY,
			turnstile_secret_key_set: true,
			effective_enabled: true,
		});
		expect((await readDiscoveryCaptcha(harness)).captcha).toEqual({
			provider: 'turnstile',
			turnstile_site_key: SITE_KEY,
		});

		const back = await patch({provider: 'altcha'});
		expect((back.json as {integrations: {captcha: unknown}}).integrations.captcha).toEqual({
			provider: 'altcha',
			effective_provider: 'altcha',
			turnstile_site_key: SITE_KEY,
			turnstile_secret_key_set: true,
			effective_enabled: true,
		});
		expect((await readDiscoveryCaptcha(harness)).captcha).toEqual({provider: 'altcha'});
	});
});
