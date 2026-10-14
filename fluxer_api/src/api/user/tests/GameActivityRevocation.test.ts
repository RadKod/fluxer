// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createUserID} from '@app/api/BrandedTypes';
import {UserSettings} from '@app/api/models/UserSettings';
import {NoopGatewayService} from '@app/api/test/NoopGatewayService';
import {UserRepository} from '@app/api/user/repositories/UserRepository';
import {UserSettingsRepository} from '@app/api/user/repositories/UserSettingsRepository';
import {GameActivityPolicyService} from '@app/api/user/services/GameActivityPolicyService';
import {UserAccountSettingsService} from '@app/api/user/services/UserAccountSettingsService';
import {UserRelationshipService} from '@app/api/user/services/UserRelationshipService';
import {ProfilePrivacyLevels, RelationshipTypes} from '@fluxer/constants/src/UserConstants';
import {describe, expect, it, vi} from 'vitest';

async function settingsFixture(visibility: 'off' | 'friends' = 'off') {
	const userId = createUserID(901n);
	const repository = new UserSettingsRepository();
	await repository.upsertSettings({
		...UserSettings.getDefaultUserSettings({userId, locale: 'en-US', isAdult: true}),
		game_activity_visibility: visibility,
		game_activity_policy_revision: null,
	});
	const policy = {
		fenceUserPolicy: vi.fn(async () => ({request_id: 'fence', owner_epoch: '1', policy_revision: '0'})),
		applyUserPolicy: vi.fn(async () => {}),
	};
	const account = {id: userId, isBot: false, isSystem: false, dateOfBirth: '2000-01-01'};
	const dispatch = vi.fn(async () => {});
	const service = new UserAccountSettingsService({
		userSettingsRepository: repository,
		userAccountRepository: {findUnique: vi.fn(async () => account)} as never,
		userRelationshipRepository: {} as never,
		updatePropagator: {dispatchUserSettingsUpdate: dispatch} as never,
		gatewayService: {} as never,
		userCacheService: {} as never,
		guildRepository: {} as never,
		limitConfigService: {} as never,
		gameActivityPolicyService: policy,
	});
	return {userId, repository, service, policy, account, dispatch};
}

async function relationshipFixture() {
	const userId = createUserID(951n);
	const targetId = createUserID(952n);
	const users = new UserRepository();
	const gateway = new NoopGatewayService();
	for (const [source, target] of [
		[userId, targetId],
		[targetId, userId],
	]) {
		await users.upsertRelationship({
			source_user_id: source,
			target_user_id: target,
			type: RelationshipTypes.FRIEND,
			nickname: null,
			since: new Date(),
			share_voice_activity: true,
			version: 1,
		});
	}
	const service = new UserRelationshipService(
		{services: {users, gateway}, request: {clientIp: null}} as never,
		{} as never,
		{} as never,
	);
	return {userId, targetId, users, gateway, service};
}

describe('game activity settings revocation', () => {
	it('persisted_block_retry_waits_for_receiver_barrier_without_rewriting', async () => {
		const {userId, targetId, users, gateway, service} = await relationshipFixture();
		vi.spyOn(users, 'findUnique').mockResolvedValue({id: targetId, isSystem: false} as never);
		await users.upsertRelationship({
			source_user_id: userId,
			target_user_id: targetId,
			type: RelationshipTypes.BLOCKED,
			nickname: null,
			since: new Date(),
			share_voice_activity: true,
			version: 1,
		});
		const write = vi.spyOn(users, 'upsertRelationship');
		const remove = vi.spyOn(users, 'deleteRelationship');
		const dispatch = vi.spyOn(gateway, 'dispatchPresence');
		let entered!: () => void;
		let release!: () => void;
		const barrierEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		const control = vi.spyOn(gateway, 'gameActivityPairPolicy').mockImplementation(async (request) => {
			if (request.phase === 'apply') {
				entered();
				await barrier;
			}
			return {owner_epoch: 'owner', pair_generation: '1', request_id: request.request_id, phase: request.phase};
		});
		let succeeded = false;
		const update = service
			.blockUser({userId, targetId, userCacheService: {} as never, requestCache: {} as never})
			.then(() => {
				succeeded = true;
			});
		await Promise.race([barrierEntered, update]);
		expect(succeeded).toBe(false);
		expect(control.mock.calls.filter(([request]) => request.phase === 'fence')).toHaveLength(2);
		expect(write).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
		expect(dispatch).not.toHaveBeenCalled();
		release();
		await update;
		expect(succeeded).toBe(true);
	});

	it('persisted_block_retry_ack_timeout_is_not_success', async () => {
		const {userId, targetId, users, gateway, service} = await relationshipFixture();
		vi.spyOn(users, 'findUnique').mockResolvedValue({id: targetId, isSystem: false} as never);
		await users.upsertRelationship({
			source_user_id: userId,
			target_user_id: targetId,
			type: RelationshipTypes.BLOCKED,
			nickname: null,
			since: new Date(),
			share_voice_activity: true,
			version: 1,
		});
		vi.spyOn(gateway, 'gameActivityPairPolicy').mockImplementation(async (request) => {
			if (request.phase === 'apply') throw new Error('receiver ACK timeout');
			return {owner_epoch: 'owner', pair_generation: '1', request_id: request.request_id, phase: request.phase};
		});
		await expect(
			service.blockUser({userId, targetId, userCacheService: {} as never, requestCache: {} as never}),
		).rejects.toMatchObject({
			status: 503,
			data: {relationship_persisted: true, game_activity_revocation_pending: true},
		});
		expect(await users.getRelationship(userId, targetId, RelationshipTypes.BLOCKED)).not.toBeNull();
	});
	it('off_waits_for_receiver_barrier', async () => {
		const {userId, service, repository, policy, dispatch} = await settingsFixture('friends');
		let release!: () => void;
		let entered!: () => void;
		const barrierEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		policy.applyUserPolicy.mockImplementationOnce(async () => {
			expect((await repository.findSettings(userId))?.gameActivityVisibility).toBe('off');
			entered();
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		});
		let succeeded = false;
		const update = service.updateSettings({userId, data: {game_activity_visibility: 'off'}}).then(() => {
			succeeded = true;
		});
		await Promise.race([barrierEntered, update]);
		expect(succeeded).toBe(false);
		expect(policy.fenceUserPolicy).toHaveBeenCalledTimes(1);
		expect(dispatch).not.toHaveBeenCalled();
		release();
		await update;
		expect(succeeded).toBe(true);
		expect(dispatch).toHaveBeenCalledTimes(1);
	});

	it('persisted_off_ack_timeout_is_not_success', async () => {
		const {userId, service, repository, policy, dispatch} = await settingsFixture('friends');
		policy.applyUserPolicy.mockRejectedValueOnce(new Error('receiver ACK timeout'));
		await expect(service.updateSettings({userId, data: {game_activity_visibility: 'off'}})).rejects.toThrow(
			'receiver ACK timeout',
		);
		expect((await repository.findSettings(userId))?.gameActivityVisibility).toBe('off');
		expect(dispatch).not.toHaveBeenCalled();
	});

	it('profile_narrowing_uses_the_same_barrier', async () => {
		const {userId, service, policy} = await settingsFixture('friends');
		policy.applyUserPolicy.mockRejectedValueOnce(new Error('receiver ACK timeout'));
		await expect(
			service.updateSettings({userId, data: {profile_privacy: ProfilePrivacyLevels.ONLY_ME}}),
		).rejects.toThrow('receiver ACK timeout');
		expect(policy.fenceUserPolicy).toHaveBeenCalledTimes(1);
	});

	it('fence_failure_prevents_the_write', async () => {
		const {userId, service, repository, policy} = await settingsFixture('friends');
		policy.fenceUserPolicy.mockRejectedValueOnce(new Error('owner unavailable'));
		await expect(service.updateSettings({userId, data: {game_activity_visibility: 'off'}})).rejects.toThrow(
			'owner unavailable',
		);
		expect((await repository.findSettings(userId))?.gameActivityVisibility).toBe('friends');
		expect(policy.applyUserPolicy).not.toHaveBeenCalled();
	});

	it('late_apply_cannot_reopen_new_fence', async () => {
		const {userId, account, repository} = await settingsFixture('friends');
		const gateway = new NoopGatewayService();
		let latestRequest = '';
		vi.spyOn(gateway, 'gameActivityPolicy').mockImplementation(async (request) => {
			if (request.phase === 'fence') latestRequest = request.request_id;
			return {
				owner_epoch: 'owner',
				request_id: latestRequest,
				phase: request.phase,
				policy_revision: request.policy_revision,
				revoked_sessions: 0,
			};
		});
		const policy = new GameActivityPolicyService({
			users: {
				findUnique: async () => account,
				findSettings: repository.findSettings.bind(repository),
				getRelationship: async () => null,
				getIncomingRelationship: async () => null,
			} as never,
			gateway,
		});
		const settings = await repository.findSettings(userId);
		const old = await policy.fenceUserPolicy(userId, settings);
		const fresh = await policy.fenceUserPolicy(userId, settings);
		await expect(policy.applyUserPolicy(userId, old, settings)).rejects.toThrow('acknowledgement mismatch');
		await expect(policy.applyUserPolicy(userId, fresh, settings)).resolves.toBeUndefined();
	});

	it('unfriend_with_gdm_revokes', async () => {
		const {userId, targetId, users, gateway, service} = await relationshipFixture();
		const channelId = createChannelID(953n);
		await users.openDmForUser(userId, channelId, true);
		await users.openDmForUser(targetId, channelId, true);
		const calls: Array<string> = [];
		vi.spyOn(gateway, 'gameActivityPairPolicy').mockImplementation(async (request) => {
			calls.push(`${request.owner_id}:${request.phase}`);
			if (request.phase === 'fence')
				expect(await users.getRelationship(userId, targetId, RelationshipTypes.FRIEND)).not.toBeNull();
			else expect(await users.getRelationship(userId, targetId, RelationshipTypes.FRIEND)).toBeNull();
			return {owner_epoch: 'owner', pair_generation: '1', request_id: request.request_id, phase: request.phase};
		});
		await service.removeRelationship({userId, targetId});
		expect(calls).toEqual([`${userId}:fence`, `${targetId}:fence`, `${userId}:apply`, `${targetId}:apply`]);
		expect(await users.isDmChannelOpen(userId, channelId)).toBe(true);
		expect(await users.isDmChannelOpen(targetId, channelId)).toBe(true);
	});

	it('overlapping_relationship_writes_cannot_regrant', async () => {
		const {userId, targetId, users, gateway, service} = await relationshipFixture();
		const latest = new Map<string, {requestId: string; generation: number}>();
		vi.spyOn(gateway, 'gameActivityPairPolicy').mockImplementation(async (request) => {
			const key = `${request.owner_id}:${request.viewer_id}`;
			if (request.phase === 'fence')
				latest.set(key, {requestId: request.request_id, generation: (latest.get(key)?.generation ?? 0) + 1});
			const current = latest.get(key)!;
			return {
				owner_epoch: 'owner',
				pair_generation: current.generation.toString(),
				request_id: current.requestId,
				phase: request.phase,
			};
		});
		let release!: () => void;
		let entered!: () => void;
		const paused = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const originalDelete = users.deleteRelationship.bind(users);
		vi.spyOn(users, 'deleteRelationship').mockImplementationOnce(async (...args) => {
			entered();
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			await originalDelete(...args);
		});
		const oldWrite = service.removeRelationship({userId, targetId});
		const oldOutcome = oldWrite.then(
			() => null,
			(error: unknown) => error,
		);
		await paused;
		await service.removeRelationship({userId, targetId});
		release();
		expect(await oldOutcome).toBeInstanceOf(Error);
		expect(await users.getRelationship(userId, targetId, RelationshipTypes.FRIEND)).toBeNull();
		expect(await users.getRelationship(targetId, userId, RelationshipTypes.FRIEND)).toBeNull();
	});
});
