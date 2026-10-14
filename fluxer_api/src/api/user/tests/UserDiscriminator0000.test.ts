// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {getConfig} from '@app/api/Config';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {grantPremium} from '@app/api/user/tests/UserTestUtils';
import {UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {afterEach, beforeEach, describe, expect, test} from 'vitest';

async function withSelfHostedInstance(callback: () => Promise<void>): Promise<void> {
	const config = getConfig();
	const originalSelfHosted = config.instance.selfHosted;
	try {
		config.instance.selfHosted = true;
		await callback();
	} finally {
		config.instance.selfHosted = originalSelfHosted;
	}
}

describe('User discriminator #0000', () => {
	let harness: ApiTestHarness;
	beforeEach(async () => {
		harness = await createApiTestHarness();
	});
	afterEach(async () => {
		await harness?.shutdown();
	});
	test('blocks legacy human #0000 on the main instance', async () => {
		const account = await createTestAccount(harness);
		await grantPremium(harness, account.userId, UserPremiumTypes.SUBSCRIPTION);
		const {response, text} = await createBuilder(harness, account.token)
			.patch('/users/@me')
			.body({discriminator: '0000', password: account.password})
			.executeRaw();
		expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
		expect(text).toContain(ValidationErrorCodes.DISCRIMINATOR_NOT_SUPPORTED_ON_INSTANCE);
	});
	test('blocks legacy human #0000 on self-hosted instances', async () => {
		const account = await createTestAccount(harness);
		await grantPremium(harness, account.userId, UserPremiumTypes.SUBSCRIPTION);
		await withSelfHostedInstance(async () => {
			const {response, text} = await createBuilder(harness, account.token)
				.patch('/users/@me')
				.body({discriminator: '0000', password: account.password})
				.executeRaw();
			expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
			expect(text).toContain(ValidationErrorCodes.DISCRIMINATOR_NOT_SUPPORTED_ON_INSTANCE);
		});
	});
});
