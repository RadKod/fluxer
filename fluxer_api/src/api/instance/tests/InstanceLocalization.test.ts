// SPDX-License-Identifier: AGPL-3.0-or-later

import {createAuthHarness, createTestAccount, setUserACLs, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import type {ApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder, createBuilderWithoutAuth} from '@app/api/test/TestRequestBuilder';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';

interface Localization {
	default_locale: string | null;
	default_locale_time_zones: Array<string>;
}

interface AppPublic {
	branding: {product_name: string};
	registration: {collect_date_of_birth: boolean};
	localization?: Localization;
}

interface InstanceConfig {
	app_public: AppPublic;
}

describe('instance default locale (app_public.localization)', () => {
	let harness: ApiTestHarness;
	let admin: TestAccount;
	let original: AppPublic;

	const discovery = () => createBuilderWithoutAuth<InstanceConfig>(harness).get('/.well-known/fluxer').execute();
	const adminConfig = () => createBuilder<InstanceConfig>(harness, admin.token).get('/admin/instance/config').execute();
	const setAppPublic = (appPublic: Record<string, unknown>) =>
		createBuilder(harness, admin.token).patch('/admin/instance/config').body({app_public: appPublic});
	const setLocalization = (localization: Record<string, unknown>) => setAppPublic({localization});

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
		original = (await adminConfig()).app_public;
	});
	afterEach(async () => {
		await setAppPublic({
			branding: {product_name: original.branding.product_name},
			registration: {collect_date_of_birth: original.registration.collect_date_of_birth},
			localization: {default_locale: null, default_locale_time_zones: []},
		}).execute();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	it('advertises no default locale until an administrator sets one', async () => {
		expect((await discovery()).app_public.localization).toEqual({default_locale: null, default_locale_time_zones: []});
	});

	it('advertises the default locale and time zones an administrator sets', async () => {
		await setLocalization({default_locale: 'tr', default_locale_time_zones: [' Europe/Istanbul', 'Asia/Istanbul']})
			.expect(200)
			.execute();
		expect((await discovery()).app_public.localization).toEqual({
			default_locale: 'tr',
			default_locale_time_zones: ['Europe/Istanbul', 'Asia/Istanbul'],
		});
	});

	it('keeps the time zones when only the locale changes or is cleared', async () => {
		await setLocalization({default_locale: 'tr', default_locale_time_zones: ['Europe/Istanbul']})
			.expect(200)
			.execute();
		await setLocalization({default_locale: 'de'}).expect(200).execute();
		expect((await discovery()).app_public.localization).toEqual({
			default_locale: 'de',
			default_locale_time_zones: ['Europe/Istanbul'],
		});
		// The request Validator turns an object whose values are all null into null, so {default_locale: null} alone
		// changes nothing; clearing sends the time zones along, as the operator script does.
		await setLocalization({default_locale: null, default_locale_time_zones: ['Europe/Istanbul']})
			.expect(200)
			.execute();
		expect((await discovery()).app_public.localization).toEqual({
			default_locale: null,
			default_locale_time_zones: ['Europe/Istanbul'],
		});
	});

	it.each([
		{default_locale: 'xx'},
		{default_locale: 'turkish'},
		{default_locale_time_zones: ['Europe/Istanbul</script>']},
		{default_locale_time_zones: Array.from({length: 33}, () => 'Europe/Istanbul')},
	])('refuses %j', async (localization) => {
		await setLocalization(localization).expect(400).execute();
		expect((await discovery()).app_public.localization?.default_locale).toBeNull();
	});

	it('reads the default locale back through the admin instance config', async () => {
		await setLocalization({default_locale: 'tr', default_locale_time_zones: ['Europe/Istanbul', 'Asia/Istanbul']})
			.expect(200)
			.execute();
		expect((await adminConfig()).app_public.localization).toEqual({
			default_locale: 'tr',
			default_locale_time_zones: ['Europe/Istanbul', 'Asia/Istanbul'],
		});
	});

	it('leaves the other app_public settings untouched', async () => {
		await setAppPublic({branding: {product_name: 'Micup Test'}, registration: {collect_date_of_birth: false}})
			.expect(200)
			.execute();
		await setLocalization({default_locale: 'tr'}).expect(200).execute();
		for (const appPublic of [(await discovery()).app_public, (await adminConfig()).app_public]) {
			expect(appPublic.branding.product_name).toBe('Micup Test');
			expect(appPublic.registration.collect_date_of_birth).toBe(false);
		}
	});

	it('keeps the default locale when another app_public setting changes', async () => {
		const localization = {default_locale: 'tr', default_locale_time_zones: ['Europe/Istanbul']};
		await setLocalization(localization).expect(200).execute();
		// The admin panel's app_public form sends branding without localization.
		await setAppPublic({branding: {product_name: 'X'}})
			.expect(200)
			.execute();
		expect((await discovery()).app_public.localization).toEqual(localization);
		expect((await adminConfig()).app_public.localization).toEqual(localization);
	});
});
