// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import * as CassandraQueries from '@app/api/database/CassandraQueryExecution';
import {getUserRepository} from '@app/api/middleware/ServiceSingletons';
import {UserSettings} from '@app/api/models/UserSettings';
import {createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {UserSettingsRepository} from '@app/api/user/repositories/UserSettingsRepository';
import type {GameActivityPolicyFence} from '@app/api/user/services/GameActivityPolicyService';
import {UserAccountSettingsService} from '@app/api/user/services/UserAccountSettingsService';
import {ProfilePrivacyLevels} from '@fluxer/constants/src/UserConstants';
import {describe, expect, it, vi} from 'vitest';

async function settingsFixture(visibility: 'off' | 'friends' = 'off') {
	const userId = createUserID(901n);
	const repository = new UserSettingsRepository();
	await repository.upsertSettings({
		...UserSettings.getDefaultUserSettings({userId, locale: 'en-US', isAdult: true}),
		game_activity_visibility: visibility,
		game_activity_visibility_source: 'user',
		game_activity_policy_revision: null,
	});
	const policy = {
		fenceUserPolicy: vi.fn(async () => ({
			request_id: 'fence',
			owner_epoch: '1',
			policy_revision: (await repository.findSettings(userId, {
				authoritative: true,
			}))!.gameActivityPolicyRevision.toString(),
		})),
		applyUserPolicy: vi.fn(
			async (_userId: UserID, _fence: GameActivityPolicyFence, _settings: UserSettings | null) => {},
		),
	};
	const account = {id: userId, isBot: false, isSystem: false, dateOfBirth: '2000-01-01'};
	const dispatch = vi.fn(async () => {});
	const service = new UserAccountSettingsService({
		// The account is a stub; settings reads and writes reach the real settings table.
		userAccountRepository: Object.assign(Object.create(repository), {findUnique: vi.fn(async () => account)}) as never,
		updatePropagator: {dispatchUserSettingsUpdate: dispatch} as never,
		gatewayService: {} as never,
		userCacheService: {} as never,
		guildRepository: {} as never,
		limitConfigService: {} as never,
		gameActivityPolicyService: policy,
	});
	return {userId, repository, service, policy, account, dispatch};
}

describe('game activity settings persistence', () => {
	it('reject_invalid_visibility', async () => {
		const {userId, service, repository} = await settingsFixture();
		await expect(
			service.updateSettings({userId, data: {game_activity_visibility: 'public'} as never}),
		).rejects.toThrow();
		expect((await repository.findSettings(userId))?.gameActivityVisibility).toBe('off');
	});

	it('cannot_update_other_account', async () => {
		const harness = await createApiTestHarness();
		try {
			const owner = await createTestAccount(harness);
			const other = await createTestAccount(harness);
			const repository = getUserRepository();
			const otherId = createUserID(BigInt(other.userId));
			await repository.patchSettings(otherId, {game_activity_visibility: 'friends'});
			await createBuilder(harness, owner.token)
				.patch('/users/@me/settings')
				.body({user_id: other.userId, game_activity_visibility: 'off'})
				.execute();
			expect((await repository.findSettings(otherId))?.gameActivityVisibility).toBe('friends');
			await createBuilder(harness, owner.token)
				.patch(`/users/${other.userId}/settings`)
				.body({game_activity_visibility: 'off'})
				.expect(404)
				.execute();
		} finally {
			await harness.shutdown();
		}
	});

	it('concurrent_policy_conflict_requires_fresh_fence_before_retry', async () => {
		const {userId, service, repository} = await settingsFixture();
		const updates = [
			{game_activity_visibility: 'friends' as const},
			{profile_privacy: ProfilePrivacyLevels.ONLY_ME},
			{theme: 'light' as const},
		];
		const outcomes = await Promise.allSettled(updates.map((data) => service.updateSettings({userId, data})));
		expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
		for (let index = 0; index < outcomes.length; index++) {
			if (outcomes[index].status === 'rejected') await service.updateSettings({userId, data: updates[index]});
		}
		const settings = await repository.findSettings(userId);
		expect(settings?.gameActivityPolicyRevision).toBe(2n);
		expect(settings?.gameActivityVisibility).toBe('friends');
		expect(settings?.profilePrivacy).toBe(ProfilePrivacyLevels.ONLY_ME);
		expect(settings?.theme).toBe('light');
	});

	it('unrelated_settings_do_not_restore_old_policy', async () => {
		const {userId, service, repository} = await settingsFixture('friends');
		const old = (await repository.findSettings(userId))!.toRow();
		await service.updateSettings({
			userId,
			data: {game_activity_visibility: 'off', profile_privacy: ProfilePrivacyLevels.ONLY_ME},
		});
		await repository.upsertSettings({...old, theme: 'light'});
		const settings = await repository.findSettings(userId);
		expect(settings?.gameActivityVisibility).toBe('off');
		expect(settings?.profilePrivacy).toBe(ProfilePrivacyLevels.ONLY_ME);
		expect(settings?.gameActivityPolicyRevision).toBe(1n);
		expect(settings?.theme).toBe('light');
	});

	it('friends_uses_authoritative_age', async () => {
		const {userId, service, account, policy} = await settingsFixture();
		account.dateOfBirth = '2015-01-01';
		await expect(
			service.updateSettings({userId, dateOfBirth: '2000-01-01', data: {game_activity_visibility: 'friends'}}),
		).rejects.toThrow();
		expect(policy.fenceUserPolicy).not.toHaveBeenCalled();
	});

	it('public_profile_uses_authoritative_age_instead_of_the_request_snapshot', async () => {
		const {userId, service, account, policy, repository} = await settingsFixture();
		account.dateOfBirth = '2015-01-01';
		await expect(
			service.updateSettings({
				userId,
				dateOfBirth: '2000-01-01',
				data: {profile_privacy: ProfilePrivacyLevels.EVERYONE},
			}),
		).rejects.toThrow();
		expect(policy.fenceUserPolicy).not.toHaveBeenCalled();
		expect((await repository.findSettings(userId))?.profilePrivacy).toBe(ProfilePrivacyLevels.ALL_GUILDS);
	});

	it('fresh_off_profile_write_preserves_existing_repository_behavior', async () => {
		const {userId, repository} = await settingsFixture();
		const settings = (await repository.findSettings(userId))!;
		await repository.upsertSettings({...settings.toRow(), profile_privacy: ProfilePrivacyLevels.ONLY_ME});
		expect((await repository.findSettings(userId))?.profilePrivacy).toBe(ProfilePrivacyLevels.ONLY_ME);
		expect((await repository.findSettings(userId))?.gameActivityPolicyRevision).toBe(1n);
	});

	it('generic_profile_write_requires_a_fence_when_sharing', async () => {
		const {userId, repository} = await settingsFixture('friends');
		const settings = (await repository.findSettings(userId))!;
		await expect(
			repository.upsertSettings({...settings.toRow(), profile_privacy: ProfilePrivacyLevels.ONLY_ME}),
		).rejects.toThrow();
		expect((await repository.findSettings(userId))?.profilePrivacy).toBe(ProfilePrivacyLevels.ALL_GUILDS);
	});

	it('stale_ordinary_read_cannot_restore_applied_policy', async () => {
		const {userId, repository, service, policy} = await settingsFixture('friends');
		const realRead = repository.findSettings.bind(repository);
		const stale = await realRead(userId);
		const modes: Array<boolean> = [];
		const read = vi
			.spyOn(repository, 'findSettings')
			.mockImplementation(async (id, options?: {authoritative?: boolean}) => {
				modes.push(options?.authoritative === true);
				return options?.authoritative ? realRead(id, options) : stale;
			});
		try {
			let applied: UserSettings | null = null;
			policy.applyUserPolicy.mockImplementation(async (_id, _fence, settings) => {
				applied = settings;
			});
			const updated = await service.updateSettings({userId, data: {game_activity_visibility: 'off'}});
			expect(updated.gameActivityVisibility).toBe('off');
			expect(updated.gameActivityPolicyRevision).toBe(1n);
			expect(applied).toBe(updated);
			expect(modes.length).toBeGreaterThanOrEqual(4);
			expect(modes.every(Boolean)).toBe(true);
			expect((await repository.findSettings(userId))?.gameActivityVisibility).toBe('friends');
		} finally {
			read.mockRestore();
		}
	});

	it('authoritative_settings_read_requests_serial_consistency', async () => {
		const {userId, repository} = await settingsFixture();
		const fetch = vi.spyOn(CassandraQueries, 'fetchMany');
		try {
			await repository.findSettings(userId, {authoritative: true});
			expect(fetch).toHaveBeenCalledWith(
				expect.stringContaining('user_settings'),
				{user_id: userId},
				{consistency: 'serial'},
			);
			fetch.mockClear();
			await repository.findSettings(userId);
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
		}
	});
});
