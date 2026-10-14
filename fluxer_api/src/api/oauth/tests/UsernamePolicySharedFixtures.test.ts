// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	CassandraUsernameDictionaryStorage,
	UsernameDictionaryPublisher,
} from '@app/api/admin/services/AdminBanManagementService';
import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {createTestBotAccount} from '@app/api/bot/tests/BotTestUtils';
import {Config} from '@app/api/Config';
import {getInstanceConfigRepository} from '@app/api/middleware/ServiceSingletons';
import {createOAuth2Application} from '@app/api/oauth/tests/OAuth2TestUtils';
import {createOAuth2Application as createOAuthApplication} from '@app/api/oauth/tests/OAuthTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {UsernameOwnershipRepository} from '@app/api/user/username/UsernameOwnershipRepository';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

describe('shared bot and OAuth fixtures with username policy', () => {
	let harness: ApiTestHarness;
	let backend: typeof Config.database.backend;
	beforeAll(async () => {
		backend = Config.database.backend;
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
		expect(Config.database.backend).toBe('cassandra');
	});
	afterAll(async () => {
		await harness?.shutdown();
		expect(Config.database.backend).toBe(backend);
	});

	it.each([false, true])('creates tagged bots through all shared fixtures (published=%s)', async (published) => {
		if (published) {
			await new UsernameDictionaryPublisher(
				new CassandraUsernameDictionaryStorage(getInstanceConfigRepository()),
			).change({
				scope: 'uname_exact',
				add: ['blockedbot'],
				remove: [],
			});
		}
		const policy = await getInstanceConfigRepository().readUsernamePolicyConfig();
		expect(policy.dictionary_gen).toBe(published ? 1 : 0);
		if (published) expect(policy.dictionary_hash).toMatch(/^[a-f0-9]{64}$/);
		const bot = await createTestBotAccount(harness, {appName: 'fixturebot'});
		const owner = await createTestAccount(harness);
		const oauth = await createOAuthApplication(harness, owner, {name: 'fixtureoauth', redirect_uris: []});
		const oauth2 = await createOAuth2Application(harness, owner.token, {name: 'fixtureoauthsecond'});
		const repository = new UsernameOwnershipRepository();
		for (const botId of [bot.botUserId, oauth.bot.id, oauth2.botUserId]) {
			const user = await createBuilder<{discriminator: string}>(harness, owner.token).get(`/users/${botId}`).execute();
			expect(user.discriminator).toMatch(/^(?!0000)\d{4}$/);
			expect(await repository.readOwner(createUserID(BigInt(botId)))).toBeNull();
		}
	});

	it('enforces the published dictionary before a shared OAuth fixture can create a bot', async () => {
		await new UsernameDictionaryPublisher(new CassandraUsernameDictionaryStorage(getInstanceConfigRepository())).change(
			{
				scope: 'uname_exact',
				add: ['blockedbot'],
				remove: [],
			},
		);
		const owner = await createTestAccount(harness);
		await expect(createOAuth2Application(harness, owner.token, {name: 'blockedbot'})).rejects.toThrow(
			'USERNAME_BLOCKED',
		);
		expect(await new UsernameOwnershipRepository().readClaim('blockedbot')).toBeNull();
	});
});
