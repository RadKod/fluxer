// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import * as CassandraQueries from '@app/api/database/CassandraQueryExecution';
import type {User} from '@app/api/models/User';
import {UserSettings} from '@app/api/models/UserSettings';
import {NoopGatewayService} from '@app/api/test/NoopGatewayService';
import {UserSettingsRepository} from '@app/api/user/repositories/UserSettingsRepository';
import {GameActivityPolicyService} from '@app/api/user/services/GameActivityPolicyService';
import {UserAccountSettingsService} from '@app/api/user/services/UserAccountSettingsService';
import {ProfilePrivacyLevels} from '@fluxer/constants/src/UserConstants';
import {afterEach, describe, expect, it, vi} from 'vitest';

afterEach(() => vi.restoreAllMocks());

async function fixture() {
	const userId = createUserID(991n);
	const repository = new UserSettingsRepository();
	await repository.upsertSettings({
		...UserSettings.getDefaultUserSettings({userId, locale: 'en-US', isAdult: true}),
		game_activity_visibility: 'friends',
		game_activity_policy_revision: 0n,
	});
	const account = {id: userId, isBot: false, isSystem: false, dateOfBirth: '2000-01-01'} as User;
	const gateway = new NoopGatewayService();
	const requests = vi.spyOn(gateway, 'gameActivityPolicy');
	const policy = new GameActivityPolicyService({
		users: {findUnique: async () => account, findSettings: repository.findSettings.bind(repository)} as never,
		gateway,
	});
	const service = new UserAccountSettingsService({
		userSettingsRepository: repository,
		userAccountRepository: {findUnique: async () => account} as never,
		userRelationshipRepository: {} as never,
		updatePropagator: {dispatchUserSettingsUpdate: async () => {}} as never,
		gatewayService: gateway,
		userCacheService: {} as never,
		guildRepository: {} as never,
		limitConfigService: {} as never,
		gameActivityPolicyService: policy,
	});
	return {userId, repository, requests, service};
}

describe('revision-pinned game activity settings recovery', () => {
	it.each(['profile', 'visibility'] as const)(
		'a stale %s settings intent cannot widen a narrower write before the fence snapshot',
		async (kind) => {
			const f = await fixture();
			const findSettings = f.repository.findSettings.bind(f.repository);
			vi.spyOn(f.repository, 'findSettings').mockImplementationOnce(async (...args) => {
				const snapshot = await findSettings(...args);
				await f.repository.patchSettings(
					f.userId,
					kind === 'profile' ? {profile_privacy: ProfilePrivacyLevels.ONLY_ME} : {game_activity_visibility: 'off'},
				);
				return snapshot;
			});
			await expect(
				f.service.updateSettings({
					userId: f.userId,
					data:
						kind === 'profile'
							? {profile_privacy: ProfilePrivacyLevels.EVERYONE}
							: {game_activity_visibility: 'friends'},
				}),
			).rejects.toThrow();
			const settings = await findSettings(f.userId, {authoritative: true});
			expect(settings?.gameActivityPolicyRevision).toBe(1n);
			if (kind === 'profile') expect(settings?.profilePrivacy).toBe(ProfilePrivacyLevels.ONLY_ME);
			else expect(settings?.gameActivityVisibility).toBe('off');
			expect(f.requests).not.toHaveBeenCalled();
		},
	);

	it('a successful same-value retry advances revision after a failed database write', async () => {
		const f = await fixture();
		const execute = CassandraQueries.executeConditional;
		const write = vi.spyOn(CassandraQueries, 'executeConditional').mockRejectedValueOnce(new Error('database failure'));
		await expect(
			f.service.updateSettings({userId: f.userId, data: {game_activity_visibility: 'friends'}}),
		).rejects.toThrow('database failure');
		write.mockImplementation(execute);
		const retry = await f.service.updateSettings({userId: f.userId, data: {game_activity_visibility: 'friends'}});
		expect(retry.gameActivityPolicyRevision).toBe(1n);
		const fences = f.requests.mock.calls.map(([request]) => request).filter((request) => request.phase === 'fence');
		expect(fences).toHaveLength(2);
		expect(fences.every((request) => 'recoverable' in request && request.recoverable === true)).toBe(true);
	});

	it('an API-lost fence can be superseded by a newly persisted revision', async () => {
		const f = await fixture();
		f.requests.mockImplementationOnce(async () => {
			throw new Error('API lost response after gateway fenced');
		});
		await expect(
			f.service.updateSettings({userId: f.userId, data: {game_activity_visibility: 'friends'}}),
		).rejects.toThrow();
		const retry = await f.service.updateSettings({userId: f.userId, data: {game_activity_visibility: 'friends'}});
		expect(retry.gameActivityPolicyRevision).toBe(1n);
		expect(f.requests.mock.calls.at(-1)?.[0]).toMatchObject({phase: 'apply', policy_revision: '1'});
	});

	it('a still-running old CAS cannot rebase after the retry has applied', async () => {
		const f = await fixture();
		const execute = CassandraQueries.executeConditional;
		let resume!: () => void;
		let reached!: () => void;
		const paused = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const started = new Promise<void>((resolve) => {
			reached = resolve;
		});
		vi.spyOn(CassandraQueries, 'executeConditional').mockImplementationOnce(async (...args) => {
			reached();
			await paused;
			return execute(...args);
		});
		const old = f.service.updateSettings({userId: f.userId, data: {game_activity_visibility: 'off'}});
		const rejected = expect(old).rejects.toThrow();
		await started;
		await f.service.updateSettings({userId: f.userId, data: {game_activity_visibility: 'friends'}});
		resume();
		await rejected;
		expect((await f.repository.findSettings(f.userId, {authoritative: true}))?.gameActivityVisibility).toBe('friends');
		expect((await f.repository.findSettings(f.userId, {authoritative: true}))?.gameActivityPolicyRevision).toBe(1n);
	});
});
