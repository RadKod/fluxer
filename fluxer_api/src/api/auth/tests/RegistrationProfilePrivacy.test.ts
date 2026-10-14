// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	bornYearsAgo,
	createAuthHarness,
	createTestAccount,
	createUniqueEmail,
	createUniqueUsername,
	disableSso,
	enableSso,
	setUserACLs,
	type TestAccount,
} from '@app/api/auth/tests/AuthTestUtils';
import type {ApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder, createBuilderWithoutAuth} from '@app/api/test/TestRequestBuilder';
import * as IpUtils from '@app/api/utils/IpUtils';
import {ProfilePrivacyLevels} from '@fluxer/constants/src/UserConstants';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

// a new account of 16 or older starts with the public profile; a younger one, an
// account without a date of birth and an SSO account start with shared communities.
describe('the profile visibility a new account starts with', () => {
	let harness: ApiTestHarness;
	let admin: TestAccount;

	const startOf = async (token: string) => {
		const settings = await createBuilder<{profile_privacy: number}>(harness, token)
			.get('/users/@me/settings')
			.execute();
		const me = await createBuilder<{public_profile_allowed?: boolean}>(harness, token).get('/users/@me').execute();
		return {level: settings.profile_privacy, allowed: me.public_profile_allowed};
	};
	const resolveCountry = (countryCode: string | null) =>
		vi.spyOn(IpUtils, 'lookupGeoip').mockResolvedValue({
			countryCode,
			normalizedIp: '127.0.0.1',
			city: null,
			region: null,
			countryName: null,
		});
	const dateOfBirthErrorFor = async (age: number) => {
		const refused = await createBuilderWithoutAuth<{errors: Array<{path: string; code: string; message: string}>}>(
			harness,
		)
			.post('/auth/register')
			.body({
				email: createUniqueEmail(`age${age}`),
				username: createUniqueUsername(`age${age}`),
				password: 'a-strong-password',
				date_of_birth: bornYearsAgo(age),
				consent: true,
			})
			.expect(400, 'INVALID_FORM_BODY')
			.execute();
		return refused.errors.find((entry) => entry.path === 'date_of_birth');
	};
	const setCollectDateOfBirth = (collect: boolean) =>
		createBuilder(harness, admin.token)
			.patch('/admin/instance/config')
			.body({app_public: {registration: {collect_date_of_birth: collect}}})
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
	afterEach(() => vi.restoreAllMocks());

	it('16 or older: public, and the account may choose the public profile', async () => {
		const account = await createTestAccount(harness, {dateOfBirth: bornYearsAgo(16)});
		expect(await startOf(account.token)).toEqual({level: ProfilePrivacyLevels.EVERYONE, allowed: true});
	});

	it('15: shared communities, and no public profile', async () => {
		const account = await createTestAccount(harness, {dateOfBirth: bornYearsAgo(15)});
		expect(await startOf(account.token)).toEqual({level: ProfilePrivacyLevels.ALL_GUILDS, allowed: false});
	});

	it('still rejects registration below 13', async () => {
		const error = await createBuilderWithoutAuth<{errors: Array<{path: string; code: string}>}>(harness)
			.post('/auth/register')
			.body({
				email: createUniqueEmail('below13'),
				username: createUniqueUsername('below13'),
				password: 'a-strong-password',
				date_of_birth: bornYearsAgo(12),
				consent: true,
			})
			.expect(400, 'INVALID_FORM_BODY')
			.execute();
		expect(error.errors).toContainEqual(expect.objectContaining({path: 'date_of_birth', code: 'MUST_BE_MINIMUM_AGE'}));
	});

	it('rejects registration below 15 in Turkey and keeps a 15-year-old profile private', async () => {
		vi.spyOn(IpUtils, 'lookupGeoip').mockResolvedValue({
			countryCode: 'TR',
			normalizedIp: '127.0.0.1',
			city: null,
			region: null,
			countryName: null,
		});
		const error = await createBuilderWithoutAuth<{errors: Array<{path: string; code: string}>}>(harness)
			.post('/auth/register')
			.body({
				email: createUniqueEmail('below15'),
				username: createUniqueUsername('below15'),
				password: 'a-strong-password',
				date_of_birth: bornYearsAgo(14),
				consent: true,
			})
			.expect(400, 'INVALID_FORM_BODY')
			.execute();
		expect(error.errors).toContainEqual(expect.objectContaining({path: 'date_of_birth', code: 'MUST_BE_MINIMUM_AGE'}));
		const account = await createTestAccount(harness, {dateOfBirth: bornYearsAgo(15)});
		expect(await startOf(account.token)).toEqual({level: ProfilePrivacyLevels.ALL_GUILDS, allowed: false});
	});

	it('requires 15 when GeoIP resolves no country', async () => {
		resolveCountry(null);
		const error = await dateOfBirthErrorFor(14);
		expect(error?.code).toBe('MUST_BE_MINIMUM_AGE');
		expect(error?.message).toContain('15');
		const account = await createTestAccount(harness, {dateOfBirth: bornYearsAgo(15)});
		expect(account.token).toBeTruthy();
	});

	it.each(['US', 'AT'])('requires 15 in %s, whose own minimum is lower', async (country) => {
		resolveCountry(country);
		const error = await dateOfBirthErrorFor(14);
		expect(error?.code).toBe('MUST_BE_MINIMUM_AGE');
		expect(error?.message).toContain('15');
	});

	it('keeps the stricter minimum of a resolved country', async () => {
		resolveCountry('DE');
		const error = await dateOfBirthErrorFor(15);
		expect(error?.code).toBe('MUST_BE_MINIMUM_AGE');
		expect(error?.message).toContain('16');
		const sixteen = await createTestAccount(harness, {dateOfBirth: bornYearsAgo(16)});
		expect(sixteen.token).toBeTruthy();
	});

	it('an instance that collects no date of birth: shared communities', async () => {
		await setCollectDateOfBirth(false);
		try {
			const account = await createTestAccount(harness);
			expect(await startOf(account.token)).toEqual({level: ProfilePrivacyLevels.ALL_GUILDS, allowed: false});
		} finally {
			await setCollectDateOfBirth(true);
		}
	});

	it('SSO (no date of birth): shared communities', async () => {
		await enableSso(harness, admin.token);
		try {
			const start = await createBuilderWithoutAuth<{state: string}>(harness).post('/auth/sso/start').body({}).execute();
			const identity = {email: createUniqueEmail('sso-privacy'), sub: `itest-sso-privacy-${Date.now()}`};
			const signedIn = await createBuilderWithoutAuth<{token: string}>(harness)
				.post('/auth/sso/complete')
				.body({code: JSON.stringify({...identity, email_verified: true}), state: start.state})
				.execute();
			expect(await startOf(signedIn.token)).toEqual({level: ProfilePrivacyLevels.ALL_GUILDS, allowed: false});
		} finally {
			await disableSso(harness, admin.token);
			await setCollectDateOfBirth(true);
		}
	});
});
