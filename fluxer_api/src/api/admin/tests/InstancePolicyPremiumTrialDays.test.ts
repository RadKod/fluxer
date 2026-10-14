// SPDX-License-Identifier: AGPL-3.0-or-later

import type {TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createTestAccount, setUserACLs} from '@app/api/auth/tests/AuthTestUtils';
import {getInstanceConfigRepository} from '@app/api/middleware/ServiceSingletons';
import type {ApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

interface InstanceConfigPolicyResponse {
	policy: {premium_trial_days: number};
}

describe('instance policy premium trial days', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	beforeEach(async () => {
		await harness.reset();
	});

	afterAll(async () => {
		await harness.shutdown();
	});

	const createAdmin = async (): Promise<TestAccount> =>
		await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.INSTANCE_CONFIG_VIEW,
			AdminACLs.INSTANCE_CONFIG_UPDATE,
		]);

	const patchPolicy = (admin: TestAccount, policy: Record<string, unknown>) =>
		createBuilder<InstanceConfigPolicyResponse>(harness, admin.token).patch('/admin/instance/config').body({policy});

	const readPolicy = (admin: TestAccount) =>
		createBuilder<InstanceConfigPolicyResponse>(harness, admin.token).get('/admin/instance/config').execute();

	it('stores the trial length and reads it back', async () => {
		const admin = await createAdmin();
		expect((await readPolicy(admin)).policy.premium_trial_days).toBe(0);

		const patched = await patchPolicy(admin, {premium_trial_days: 7}).expect(HTTP_STATUS.OK).execute();

		expect(patched.policy.premium_trial_days).toBe(7);
		expect((await readPolicy(admin)).policy.premium_trial_days).toBe(7);
		expect((await getInstanceConfigRepository().getInstancePolicyConfig()).premium_trial_days).toBe(7);
	});

	it('keeps the stored trial length when a patch leaves it out', async () => {
		const admin = await createAdmin();
		await patchPolicy(admin, {premium_trial_days: 7}).execute();

		await patchPolicy(admin, {premium_mode: 'mirror'}).expect(HTTP_STATUS.OK).execute();

		expect((await readPolicy(admin)).policy.premium_trial_days).toBe(7);
	});

	it('turns the trial off with zero', async () => {
		const admin = await createAdmin();
		await patchPolicy(admin, {premium_trial_days: 7}).execute();

		await patchPolicy(admin, {premium_trial_days: 0}).expect(HTTP_STATUS.OK).execute();

		expect((await readPolicy(admin)).policy.premium_trial_days).toBe(0);
	});

	it('rejects negative, fractional and over-long trial lengths', async () => {
		const admin = await createAdmin();
		await patchPolicy(admin, {premium_trial_days: 7}).execute();

		for (const premium_trial_days of [-1, 1.5, 31]) {
			await patchPolicy(admin, {premium_trial_days})
				.expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.INVALID_FORM_BODY)
				.execute();
		}

		expect((await readPolicy(admin)).policy.premium_trial_days).toBe(7);
	});
});
