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

interface Me {
	username: string;
	global_name: string | null;
}

describe('SSO display name', () => {
	let harness: ApiTestHarness;
	let admin: TestAccount;

	const setCollectDateOfBirth = (collect: boolean) =>
		createBuilder(harness, admin.token)
			.patch('/admin/instance/config')
			.body({app_public: {registration: {collect_date_of_birth: collect}}})
			.execute();

	const provisionWithName = async (name: string) => {
		const start = await createBuilderWithoutAuth<{state: string}>(harness).post('/auth/sso/start').body({}).execute();
		const {token} = await createBuilderWithoutAuth<{token: string}>(harness)
			.post('/auth/sso/complete')
			.body({code: JSON.stringify({email: createUniqueEmail('sso-name'), name}), state: start.state})
			.execute();
		return createBuilder<Me>(harness, token).get('/users/@me').execute();
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

	it.each(['sanalyer Destek', 'ᴍɪᴄᴜᴘ Yetkili'])(
		'drops the provider name %s, which passes for sanalyer, and shows the username instead',
		async (name) => {
			const me = await provisionWithName(name);
			expect(me.global_name).toBeNull();
			expect(me.username).not.toMatch(/micup/i);
		},
	);

	it('keeps an ordinary provider name', async () => {
		expect((await provisionWithName('Ayşe Yılmaz')).global_name).toBe('Ayşe Yılmaz');
	});
});
