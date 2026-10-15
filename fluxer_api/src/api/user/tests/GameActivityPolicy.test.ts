// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID, type UserID} from '@app/api/BrandedTypes';
import type {User} from '@app/api/models/User';
import type {UserSettings} from '@app/api/models/UserSettings';
import {NoopGatewayService} from '@app/api/test/NoopGatewayService';
import {GameActivityPolicyService, isGameActivityEligible} from '@app/api/user/services/GameActivityPolicyService';
import {RelationshipTypes} from '@fluxer/constants/src/UserConstants';
import {describe, expect, it, vi} from 'vitest';

const viewerId = createUserID(1n);
const ownerId = createUserID(2n);

function fixture() {
	const users = {
		findUnique: vi.fn(async (id) => ({id, isBot: false, isSystem: false, dateOfBirth: '2000-01-01'}) as User),
		findSettings: vi.fn(
			async (_id: UserID, _options?: {authoritative?: boolean}) =>
				({gameActivityVisibility: 'friends', gameActivityPolicyRevision: 3n, profilePrivacy: 2}) as UserSettings,
		),
		getRelationship: vi.fn(async (_source, _target, type) => (type === RelationshipTypes.FRIEND ? {} : null)),
		getIncomingRelationship: vi.fn(async () => null),
	};
	return {users, service: new GameActivityPolicyService({users: users as never, gateway: new NoopGatewayService()})};
}

describe('GameActivityPolicy', () => {
	it('persisted_policy_apply_accepts_the_current_owner_epoch', async () => {
		const gateway = new NoopGatewayService();
		vi.spyOn(gateway, 'gameActivityPolicy').mockImplementation(async (request) => ({
			owner_epoch: 'replacement-owner',
			request_id: request.request_id,
			phase: request.phase,
			policy_revision: request.policy_revision,
			revoked_sessions: 0,
		}));
		const {users} = fixture();
		const service = new GameActivityPolicyService({users: users as never, gateway});
		await expect(
			service.applyUserPolicy(
				ownerId,
				{owner_epoch: 'previous-owner', request_id: 'persisted-close', policy_revision: '0'},
				{gameActivityVisibility: 'off', gameActivityPolicyRevision: 1n, profilePrivacy: 2} as UserSettings,
			),
		).resolves.toBeUndefined();
	});

	it.each([{request_id: 'unrelated-request'}, {phase: 'fence' as const}, {policy_revision: '0'}])(
		'persisted_policy_apply_rejects_mismatched_acknowledgements_%j',
		async (mismatch) => {
			const gateway = new NoopGatewayService();
			vi.spyOn(gateway, 'gameActivityPolicy').mockImplementation(async (request) => ({
				owner_epoch: 'replacement-owner',
				request_id: request.request_id,
				phase: request.phase,
				policy_revision: request.policy_revision,
				revoked_sessions: 0,
				...mismatch,
			}));
			const {users} = fixture();
			const service = new GameActivityPolicyService({users: users as never, gateway});
			await expect(
				service.applyUserPolicy(
					ownerId,
					{owner_epoch: 'previous-owner', request_id: 'persisted-close', policy_revision: '0'},
					{gameActivityVisibility: 'off', gameActivityPolicyRevision: 1n, profilePrivacy: 2} as UserSettings,
				),
			).rejects.toThrow('acknowledgement mismatch');
		},
	);

	it('grants_use_authoritative_settings_instead_of_stale_snapshots', async () => {
		const {users, service} = fixture();
		const stale = {
			gameActivityVisibility: 'friends',
			gameActivityPolicyRevision: 1n,
			profilePrivacy: 2,
		} as UserSettings;
		const fresh = {gameActivityVisibility: 'off', gameActivityPolicyRevision: 2n, profilePrivacy: 101} as UserSettings;
		users.findSettings.mockImplementation(async (_id, options) => (options?.authoritative ? fresh : stale));
		const grant = (await service.getGrants(viewerId, [ownerId], 'fresh')).grants[0];
		expect(grant).toMatchObject({allowed: false, policy_revision: '2', effective_profile_audience: 'only_me'});
		expect(users.findSettings).toHaveBeenCalledWith(ownerId, {authoritative: true});
	});
	it('fence_uses_authoritative_settings_instead_of_caller_snapshot', async () => {
		const {users, service} = fixture();
		const stale = {
			gameActivityVisibility: 'friends',
			gameActivityPolicyRevision: 1n,
			profilePrivacy: 2,
		} as UserSettings;
		const fresh = {gameActivityVisibility: 'off', gameActivityPolicyRevision: 2n, profilePrivacy: 101} as UserSettings;
		users.findSettings.mockImplementation(async (_id, options) => (options?.authoritative ? fresh : stale));
		const fence = await service.fenceUserPolicy(ownerId, stale);
		expect(fence.policy_revision).toBe('2');
		expect(users.findSettings).toHaveBeenCalledWith(ownerId, {authoritative: true});
	});
	it('friend_only_me_is_denied', async () => {
		const {users, service} = fixture();
		expect((await service.getGrants(viewerId, [ownerId], 'fresh')).grants[0].allowed).toBe(true);
		users.findSettings.mockResolvedValue({
			gameActivityVisibility: 'friends',
			gameActivityPolicyRevision: 3n,
			profilePrivacy: 101,
		} as UserSettings);
		expect((await service.getGrants(viewerId, [ownerId], 'fresh')).grants[0].allowed).toBe(false);
	});
	it('age_14_unknown_denied_15_allowed', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-10-06T12:00:00Z'));
		for (const dateOfBirth of [null, 'invalid', '2010-02-30', '2011-10-07']) {
			expect(isGameActivityEligible({isBot: false, isSystem: false, dateOfBirth})).toBe(false);
		}
		expect(isGameActivityEligible({isBot: false, isSystem: false, dateOfBirth: '2011-10-06'})).toBe(true);
		vi.useRealTimers();
	});
	it('block_both_directions_and_nonfriend_gdm_denied', async () => {
		const {users, service} = fixture();
		expect((await service.getGrants(viewerId, [ownerId], 'fresh')).grants[0].allowed).toBe(true);
		users.getIncomingRelationship.mockResolvedValue({} as never);
		expect((await service.getGrants(viewerId, [ownerId], 'fresh')).grants[0].allowed).toBe(false);
		users.getIncomingRelationship.mockResolvedValue(null);
		users.getRelationship.mockImplementation(async (_source, _target, type) =>
			type === RelationshipTypes.BLOCKED ? {} : null,
		);
		expect((await service.getGrants(viewerId, [ownerId], 'fresh')).grants[0].allowed).toBe(false);
		users.getRelationship.mockResolvedValue(null);
		expect((await service.getGrants(viewerId, [ownerId], 'fresh')).grants[0].allowed).toBe(false);
		users.getRelationship.mockImplementation(async (source, _target, type) =>
			source === viewerId && type === RelationshipTypes.FRIEND ? {} : null,
		);
		expect((await service.getGrants(viewerId, [ownerId], 'fresh')).grants[0].allowed).toBe(false);
	});
	it('bots_and_system_accounts_are_denied_on_both_sides', async () => {
		const {users, service} = fixture();
		for (const actor of [viewerId, ownerId]) {
			for (const field of ['isBot', 'isSystem']) {
				users.findUnique.mockImplementation(
					async (id) =>
						({
							id,
							isBot: false,
							isSystem: false,
							dateOfBirth: '2000-01-01',
							...(id === actor && {[field]: true}),
						}) as User,
				);
				expect((await service.getGrants(viewerId, [ownerId], 'fresh')).grants[0].allowed).toBe(false);
			}
		}
	});
	it('grant_batch_not_per_game_event', async () => {
		const {users, service} = fixture();
		expect((await service.getGrants(viewerId, [ownerId], 'fresh')).grants[0].allowed).toBe(true);
		expect(users.findSettings).toHaveBeenCalledTimes(1);
		await expect(
			service.getGrants(
				viewerId,
				Array.from({length: 101}, () => ownerId),
				'fresh',
			),
		).rejects.toThrow();
		expect(users.findSettings).toHaveBeenCalledTimes(1);
	});
	it('bounded_hundred_target_batch_reads_only_authoritative_policy_inputs', async () => {
		const {users, service} = fixture();
		const targets = Array.from({length: 100}, (_, index) => createUserID(BigInt(index + 2)));
		const result = await service.getGrants(viewerId, targets, 'batch');
		expect(result.grants).toHaveLength(100);
		expect(result.grants.every((grant) => grant.allowed)).toBe(true);
		expect(users.findSettings).toHaveBeenCalledTimes(100);
		expect(users.findUnique).toHaveBeenCalledTimes(101);
		expect(users.getRelationship).toHaveBeenCalledTimes(300);
		expect(users.getIncomingRelationship).toHaveBeenCalledTimes(100);
	});
});
