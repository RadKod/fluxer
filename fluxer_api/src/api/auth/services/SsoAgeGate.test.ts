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
import type {ApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder, createBuilderWithoutAuth} from '@app/api/test/TestRequestBuilder';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';

interface SsoCompleteResponse {
	token: string;
	user_id: string;
}

describe('SSO age gate', () => {
	let harness: ApiTestHarness;
	let admin: TestAccount;
	let member: TestAccount;

	const setCollectDateOfBirth = (collect: boolean) =>
		createBuilder(harness, admin.token)
			.patch('/admin/instance/config')
			.body({app_public: {registration: {collect_date_of_birth: collect}}})
			.execute();

	const completeSso = async <T>(email: string, expectedStatus = 200) => {
		const start = await createBuilderWithoutAuth<{state: string; client_binding: string}>(harness)
			.post('/auth/sso/start')
			.body({})
			.execute();
		const builder = createBuilderWithoutAuth<T>(harness)
			.post('/auth/sso/complete')
			.body({code: email, state: start.state, client_binding: start.client_binding});
		return expectedStatus === 200 ? builder.execute() : builder.expect(expectedStatus, 'INVALID_FORM_BODY').execute();
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
		member = await createTestAccount(harness);
		await enableSso(harness, admin.token);
	});
	afterEach(async () => {
		await disableSso(harness, admin.token);
		await setCollectDateOfBirth(true);
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	// Upstream now creates the account and asks for the date of birth before it can be used (the deferred
	// date-of-birth step), where Micup refused the sign-up outright.
	it('asks an account auto-provisioned while the instance collects a date of birth for it before use', async () => {
		await setCollectDateOfBirth(true);
		const completed = await completeSso<SsoCompleteResponse>(createUniqueEmail('sso-age-gate'));
		await createBuilder(harness, completed.token)
			.get('/users/@me/guilds')
			.expect(403, 'DATE_OF_BIRTH_REQUIRED')
			.execute();
		await createBuilder(harness, completed.token)
			.put('/users/@me/date-of-birth')
			.body({date_of_birth: '1990-01-01'})
			.execute();
	});

	it('still signs existing accounts in through SSO while the instance collects a date of birth', async () => {
		await setCollectDateOfBirth(true);
		const completed = await completeSso<SsoCompleteResponse>(member.email);
		expect(completed.user_id).toBe(member.userId);
	});

	it('auto-provisions SSO accounts as before when the instance does not collect a date of birth', async () => {
		await setCollectDateOfBirth(false);
		const completed = await completeSso<SsoCompleteResponse>(createUniqueEmail('sso-age-gate-off'));
		expect(completed.token).toBeTruthy();
	});
});
