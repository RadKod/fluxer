// SPDX-License-Identifier: AGPL-3.0-or-later

import {bornYearsAgo, createTestAccount, disableSso, enableSso, setUserACLs} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {getUserRepository} from '@app/api/middleware/ServiceSingletons';
import {UserSettings} from '@app/api/models/UserSettings';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder, createBuilderWithoutAuth} from '@app/api/test/TestRequestBuilder';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

interface SettingsBody {
	game_activity_visibility: string;
	game_activity_eligible: boolean;
	game_activity_default_pending: boolean;
}

describe('new account game activity default', () => {
	let harness: ApiTestHarness;
	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	it('default_settings_row_starts_from_the_default_source', () => {
		const row = UserSettings.getDefaultUserSettings({userId: createUserID(1n), locale: 'en-US', isAdult: false});
		expect(row.game_activity_visibility).toBeNull();
		expect(row.game_activity_visibility_source).toBe('default');
		expect(new UserSettings(row).toRow().game_activity_visibility).toBeNull();
		expect(new UserSettings(row).gameActivityVisibilitySource).toBe('default');
	});

	it('registration_at_fifteen_shares_with_everyone_without_a_pending_notice', async () => {
		const account = await createTestAccount(harness, {dateOfBirth: bornYearsAgo(15)});
		const stored = await getUserRepository().findSettings(createUserID(BigInt(account.userId)), {authoritative: true});
		expect(stored?.gameActivityVisibilitySource).toBe('default');
		expect(stored?.toRow().game_activity_visibility).toBeNull();
		const settings = await createBuilder<SettingsBody>(harness, account.token).get('/users/@me/settings').execute();
		expect(settings).toMatchObject({
			game_activity_visibility: 'everyone',
			game_activity_eligible: true,
			game_activity_default_pending: false,
		});
	});

	it('sso_account_without_birth_date_keeps_the_default_source_but_does_not_share', async () => {
		let admin = await createTestAccount(harness);
		admin = await setUserACLs(harness, admin, ['admin:authenticate', 'instance:config:update', 'instance:config:view']);
		await enableSso(harness, admin.token, {enforced: false});
		try {
			const start = await createBuilderWithoutAuth<{state: string}>(harness)
				.post('/auth/sso/start')
				.body({redirect_to: '/me'})
				.execute();
			const complete = await createBuilderWithoutAuth<{token: string; user_id: string}>(harness)
				.post('/auth/sso/complete')
				.body({code: `sso-game-${Date.now()}@example.com`, state: start.state})
				.execute();
			const stored = await getUserRepository().findSettings(createUserID(BigInt(complete.user_id)), {
				authoritative: true,
			});
			expect(stored?.gameActivityVisibilitySource).toBe('default');
			expect(stored?.toRow().game_activity_visibility).toBeNull();
			const settings = await createBuilder<SettingsBody>(harness, complete.token).get('/users/@me/settings').execute();
			expect(settings).toMatchObject({
				game_activity_visibility: 'off',
				game_activity_eligible: false,
				game_activity_default_pending: false,
			});
		} finally {
			await disableSso(harness, admin.token);
		}
	});

	it('existing_account_sees_the_notice_then_acknowledges_into_everyone', async () => {
		const account = await createTestAccount(harness, {dateOfBirth: '2000-01-01'});
		const userId = createUserID(BigInt(account.userId));
		await getUserRepository().patchSettings(userId, {game_activity_visibility_source: null});
		const before = await createBuilder<SettingsBody>(harness, account.token).get('/users/@me/settings').execute();
		expect(before).toMatchObject({
			game_activity_visibility: 'off',
			game_activity_eligible: true,
			game_activity_default_pending: true,
		});
		const after = await createBuilder<SettingsBody>(harness, account.token)
			.patch('/users/@me/settings')
			.body({game_activity_default_acknowledged: true})
			.execute();
		expect(after).toMatchObject({
			game_activity_visibility: 'everyone',
			game_activity_eligible: true,
			game_activity_default_pending: false,
		});
		const stored = await getUserRepository().findSettings(userId, {authoritative: true});
		expect(stored?.toRow()).toMatchObject({
			game_activity_visibility: null,
			game_activity_visibility_source: 'default',
		});
	});
});
