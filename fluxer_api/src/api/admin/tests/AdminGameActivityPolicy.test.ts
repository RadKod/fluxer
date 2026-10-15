// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ApiContext} from '@app/api/ApiContext';
import {AdminUserProfileService} from '@app/api/admin/services/AdminUserProfileService';
import {AdminUserRelationshipService} from '@app/api/admin/services/AdminUserRelationshipService';
import {createUserID} from '@app/api/BrandedTypes';
import * as CassandraQueries from '@app/api/database/CassandraQueryExecution';
import {getUserRepository} from '@app/api/middleware/ServiceSingletons';
import {User} from '@app/api/models/User';
import {UserSettings} from '@app/api/models/UserSettings';
import {NoopGatewayService} from '@app/api/test/NoopGatewayService';
import {resolveProfileAudience} from '@app/api/user/profile/ProfilePrivacy';
import {GameActivityPolicyService} from '@app/api/user/services/GameActivityPolicyService';
import * as PartialUserChangePropagation from '@app/api/user/services/PartialUserChangePropagation';
import {UserAccountSettingsService} from '@app/api/user/services/UserAccountSettingsService';
import {ProfilePrivacyLevels, RelationshipTypes} from '@fluxer/constants/src/UserConstants';
import {ServiceUnavailableError} from '@fluxer/errors/src/domains/core/ServiceUnavailableError';
import type {GameActivityPolicyRequest} from '@fluxer/schema/src/domains/rpc/RpcSchemas';
import {types} from 'cassandra-driver';
import {afterEach, describe, expect, it, vi} from 'vitest';

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function fixture(privacy: number = ProfilePrivacyLevels.FRIENDS_ONLY) {
	const userId = createUserID(801n);
	const viewerId = createUserID(802n);
	const users = getUserRepository();
	for (const id of [userId, viewerId]) {
		await users.upsert(
			new User({
				user_id: id,
				username: 'fixture',
				discriminator: 1,
				date_of_birth: types.LocalDate.fromString('2000-01-01'),
				version: 1,
			} as never).toRow(),
		);
	}
	await users.upsertSettings({
		...UserSettings.getDefaultUserSettings({userId, locale: 'en-US', isAdult: true}),
		profile_privacy: privacy,
		game_activity_visibility: 'friends',
		game_activity_visibility_source: 'user',
		game_activity_policy_revision: 0n,
	});
	for (const [source, target] of [
		[userId, viewerId],
		[viewerId, userId],
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
	const gateway = new NoopGatewayService();
	const calls: Array<string> = [];
	const policyRequests: Array<GameActivityPolicyRequest> = [];
	const policyRpc = vi.spyOn(gateway, 'gameActivityPolicy').mockImplementation(async (request) => {
		calls.push(request.phase);
		policyRequests.push(request);
		return {
			owner_epoch: 'owner',
			request_id: request.request_id,
			phase: request.phase,
			policy_revision: request.policy_revision,
			revoked_sessions: 1,
		};
	});
	const pairRpc = vi.spyOn(gateway, 'gameActivityPairPolicy').mockImplementation(async (request) => {
		calls.push(`pair-${request.phase}`);
		return {
			owner_epoch: 'owner',
			request_id: request.request_id,
			phase: request.phase,
			pair_generation: request.phase === 'apply' ? request.pair_generation : '1',
		};
	});
	// Ordinary relationship notifications can be silently dropped; they do not acknowledge revocation.
	vi.spyOn(gateway, 'dispatchPresence').mockImplementation(async () => {
		calls.push('notification-dropped');
	});
	const write = users.patchUpsert.bind(users);
	vi.spyOn(users, 'patchUpsert').mockImplementation(async (...args) => {
		calls.push('persist-dob');
		return write(...args);
	});
	const remove = users.deleteRelationship.bind(users);
	vi.spyOn(users, 'deleteRelationship').mockImplementation(async (...args) => {
		calls.push('persist-relationship');
		return remove(...args);
	});
	const auditService = {
		createAuditLog: vi.fn(async () => {
			calls.push('audit');
		}),
	};
	vi.spyOn(PartialUserChangePropagation, 'propagateUserUpdate').mockImplementation(async () => {
		calls.push('user-update');
	});
	const apiContext = {services: {users, gateway}} as unknown as ApiContext;
	const profile = new AdminUserProfileService({
		apiContext,
		auditService: auditService as never,
		userUpdateDeps: {} as never,
		discriminatorService: {} as never,
		enforcement: {} as never,
		entityAssetService: {} as never,
		guildRepository: {} as never,
	});
	const relationships = new AdminUserRelationshipService({apiContext, auditService: auditService as never});
	const grants = new GameActivityPolicyService({users, gateway});
	const accountSettings = new UserAccountSettingsService({
		userAccountRepository: users,
		updatePropagator: {dispatchUserSettingsUpdate: async () => {}} as never,
		gatewayService: gateway,
		userCacheService: {} as never,
		guildRepository: {} as never,
		limitConfigService: {} as never,
		gameActivityPolicyService: grants,
	});
	return {
		userId,
		viewerId,
		users,
		gateway,
		calls,
		policyRequests,
		policyRpc,
		pairRpc,
		profile,
		relationships,
		grants,
		auditService,
		accountSettings,
	};
}

describe('admin game activity policy revocation', () => {
	it.each(['adult DOB', 'sixteenth birthday'] as const)(
		'a concurrent settings off during DOB audit cannot reopen the profile on a later %s',
		async (later) => {
			vi.useFakeTimers({now: new Date(2026, 9, 8, 12), toFake: ['Date']});
			const f = await fixture(ProfilePrivacyLevels.EVERYONE);
			f.auditService.createAuditLog.mockImplementationOnce(async () => {
				await f.accountSettings.updateSettings({userId: f.userId, data: {game_activity_visibility: 'off'}});
			});
			const error = await f.profile
				.changeDob({user_id: f.userId, date_of_birth: '2010-10-09'}, f.viewerId, null, new Set())
				.then(
					() => null,
					(error: unknown) => error,
				);
			const narrowed = await f.users.findSettings(f.userId, {authoritative: true});
			if (later === 'adult DOB') {
				await f.profile.changeDob({user_id: f.userId, date_of_birth: '2000-01-01'}, f.viewerId, null, new Set());
			} else {
				vi.setSystemTime(new Date(2026, 9, 9, 12));
			}
			const user = (await f.users.findUnique(f.userId))!;
			const settings = (await f.users.findSettings(f.userId, {authoritative: true}))!;
			expect(narrowed?.profilePrivacy).toBe(ProfilePrivacyLevels.ALL_GUILDS);
			expect(narrowed?.gameActivityPolicyRevision).toBe(2n);
			expect(error).toBeNull();
			expect(settings.gameActivityVisibility).toBe('off');
			expect(resolveProfileAudience(settings.profilePrivacy, user.dateOfBirth)).toBe('guilds');
		},
	);

	it.each([ProfilePrivacyLevels.FRIENDS_ONLY, ProfilePrivacyLevels.ONLY_ME])(
		'DOB reconciliation recomputes a raced downgrade instead of replaying it over profile level %i',
		async (privacy) => {
			const f = await fixture(ProfilePrivacyLevels.EVERYONE);
			const patchSettings = f.users.patchSettings.bind(f.users);
			let interleaving = false;
			let raced = false;
			f.auditService.createAuditLog.mockImplementationOnce(async () => {
				await f.accountSettings.updateSettings({userId: f.userId, data: {game_activity_visibility: 'off'}});
				vi.spyOn(f.users, 'patchSettings').mockImplementation(async (...args) => {
					if (!interleaving && args[2]?.expectedPolicyRevision === 1n && !raced) {
						raced = true;
						interleaving = true;
						await f.accountSettings.updateSettings({userId: f.userId, data: {profile_privacy: privacy}});
						interleaving = false;
					}
					return patchSettings(...args);
				});
			});
			await f.profile.changeDob({user_id: f.userId, date_of_birth: '2015-01-01'}, f.viewerId, null, new Set());
			const settings = await f.users.findSettings(f.userId, {authoritative: true});
			expect(raced).toBe(true);
			expect(settings?.profilePrivacy).toBe(privacy);
			expect(settings?.gameActivityVisibility).toBe('off');
			expect(settings?.gameActivityPolicyRevision).toBe(3n);
			expect(f.policyRequests.at(-1)).toMatchObject({
				phase: 'apply',
				request_id: f.policyRequests[0].request_id,
				policy_revision: '3',
				effective_profile_audience: privacy === ProfilePrivacyLevels.ONLY_ME ? 'only_me' : 'close',
			});
		},
	);

	it.each([false, true])(
		'DOB reconciliation bounds revision conflicts and preserves audit failure %s',
		async (auditFails) => {
			const f = await fixture(ProfilePrivacyLevels.EVERYONE);
			const patchSettings = f.users.patchSettings.bind(f.users);
			const auditError = new Error('audit unavailable');
			let interleaving = false;
			let attempts = 0;
			let stopInterleaving!: () => void;
			f.auditService.createAuditLog.mockImplementationOnce(async () => {
				await f.accountSettings.updateSettings({userId: f.userId, data: {game_activity_visibility: 'off'}});
				const patch = vi.spyOn(f.users, 'patchSettings').mockImplementation(async (...args) => {
					if (!interleaving) {
						attempts++;
						interleaving = true;
						await f.accountSettings.updateSettings({userId: f.userId, data: {game_activity_visibility: 'off'}});
						interleaving = false;
					}
					return patchSettings(...args);
				});
				stopInterleaving = () => patch.mockRestore();
				if (auditFails) throw auditError;
			});
			const changeDob = () =>
				f.profile.changeDob({user_id: f.userId, date_of_birth: '2015-01-01'}, f.viewerId, null, new Set());
			const error = await changeDob().then(
				() => null,
				(error: unknown) => error,
			);
			expect(error).toBeInstanceOf(auditFails ? Error : ServiceUnavailableError);
			if (auditFails) expect(error).toBe(auditError);
			expect(attempts).toBe(5);
			expect((await f.users.findUnique(f.userId))?.dateOfBirth).toBe('2015-01-01');
			const settings = await f.users.findSettings(f.userId, {authoritative: true});
			expect(settings?.profilePrivacy).toBe(ProfilePrivacyLevels.EVERYONE);
			expect(settings?.gameActivityVisibility).toBe('off');
			expect(settings?.gameActivityPolicyRevision).toBe(6n);
			expect(
				f.policyRequests.some(
					(request) => request.phase === 'apply' && request.request_id === f.policyRequests[0].request_id,
				),
			).toBe(false);
			expect(f.calls).not.toContain('user-update');
			stopInterleaving();
			await changeDob();
			if (auditFails) {
				vi.useFakeTimers({now: new Date(2031, 0, 1, 12), toFake: ['Date']});
			} else {
				await f.profile.changeDob({user_id: f.userId, date_of_birth: '2000-01-01'}, f.viewerId, null, new Set());
			}
			const reconciled = (await f.users.findSettings(f.userId, {authoritative: true}))!;
			const user = (await f.users.findUnique(f.userId))!;
			expect(reconciled.profilePrivacy).toBe(ProfilePrivacyLevels.ALL_GUILDS);
			expect(resolveProfileAudience(reconciled.profilePrivacy, user.dateOfBirth)).toBe('guilds');
		},
	);

	it('DOB finalization propagates a database error without retrying or releasing the protected fence', async () => {
		const f = await fixture(ProfilePrivacyLevels.EVERYONE);
		const databaseError = new Error('database unavailable');
		let writes = 0;
		f.auditService.createAuditLog.mockImplementationOnce(async () => {
			vi.spyOn(CassandraQueries, 'executeConditional').mockImplementation(async () => {
				writes++;
				throw databaseError;
			});
		});
		await expect(
			f.profile.changeDob({user_id: f.userId, date_of_birth: '2015-01-01'}, f.viewerId, null, new Set()),
		).rejects.toBe(databaseError);
		expect(writes).toBe(1);
		expect(f.calls).not.toContain('apply');
		expect(f.calls).not.toContain('user-update');
		expect((await f.users.findUnique(f.userId))?.dateOfBirth).toBe('2015-01-01');
	});

	it('DOB preserves Only me committed between the settings snapshot and fence snapshot', async () => {
		const f = await fixture(ProfilePrivacyLevels.EVERYONE);
		const findSettings = f.users.findSettings.bind(f.users);
		vi.spyOn(f.users, 'findSettings').mockImplementationOnce(async (...args) => {
			const snapshot = await findSettings(...args);
			await f.users.patchSettings(f.userId, {profile_privacy: ProfilePrivacyLevels.ONLY_ME});
			return snapshot;
		});
		await expect(
			f.profile.changeDob({user_id: f.userId, date_of_birth: '2015-01-01'}, f.viewerId, null, new Set()),
		).rejects.toThrow();
		const settings = await findSettings(f.userId, {authoritative: true});
		expect(settings?.profilePrivacy).toBe(ProfilePrivacyLevels.ONLY_ME);
		expect(settings?.gameActivityPolicyRevision).toBe(1n);
		expect((await f.users.findUnique(f.userId))?.dateOfBirth).toBe('2000-01-01');
		expect(f.calls).toEqual([]);
	});

	it.each(['incoming_request', 'outgoing_request'] as const)(
		'%s audit failure leaves both pending relationship rows deleted',
		async (category) => {
			const f = await fixture();
			const sourceType =
				category === 'incoming_request' ? RelationshipTypes.INCOMING_REQUEST : RelationshipTypes.OUTGOING_REQUEST;
			const targetType =
				category === 'incoming_request' ? RelationshipTypes.OUTGOING_REQUEST : RelationshipTypes.INCOMING_REQUEST;
			for (const [source, target, type] of [
				[f.userId, f.viewerId, sourceType],
				[f.viewerId, f.userId, targetType],
			] as const) {
				await f.users.upsertRelationship({
					source_user_id: source,
					target_user_id: target,
					type,
					nickname: null,
					since: new Date(),
					share_voice_activity: true,
					version: 1,
				});
			}
			const auditError = new Error('audit unavailable');
			f.auditService.createAuditLog.mockRejectedValue(auditError);
			const remove = () =>
				f.relationships.removeRelationship({user_id: f.userId, target_user_id: f.viewerId, category}, f.viewerId, null);
			await expect(remove()).rejects.toBe(auditError);
			expect(await f.users.getRelationship(f.userId, f.viewerId, sourceType)).toBeNull();
			expect(await f.users.getRelationship(f.viewerId, f.userId, targetType)).toBeNull();
			await expect(remove()).rejects.toThrow();
			expect(f.auditService.createAuditLog).toHaveBeenCalledTimes(1);
		},
	);

	it.each(['2001-01-01', '2015-01-01'])(
		'DOB audit failure finalizes persisted %s eligibility and preserves the audit error',
		async (dateOfBirth) => {
			const f = await fixture(ProfilePrivacyLevels.EVERYONE);
			const auditError = new Error('audit unavailable');
			f.auditService.createAuditLog.mockRejectedValue(auditError);
			await expect(
				f.profile.changeDob({user_id: f.userId, date_of_birth: dateOfBirth}, f.viewerId, null, new Set()),
			).rejects.toBe(auditError);
			expect((await f.users.findUnique(f.userId))?.dateOfBirth).toBe(dateOfBirth);
			const settings = await f.users.findSettings(f.userId, {authoritative: true});
			expect(settings?.gameActivityPolicyRevision).toBe(1n);
			expect(settings?.profilePrivacy).toBe(
				dateOfBirth === '2015-01-01' ? ProfilePrivacyLevels.ALL_GUILDS : ProfilePrivacyLevels.EVERYONE,
			);
			expect(f.policyRequests.at(-1)).toMatchObject({phase: 'apply', policy_revision: '1'});
			expect(f.calls).toContain('user-update');
		},
	);

	it('friendship audit failure finalizes both persisted pair fences and preserves the audit error', async () => {
		const f = await fixture();
		const auditError = new Error('audit unavailable');
		f.auditService.createAuditLog.mockRejectedValue(auditError);
		await expect(
			f.relationships.removeRelationship(
				{user_id: f.userId, target_user_id: f.viewerId, category: 'friend'},
				f.viewerId,
				null,
			),
		).rejects.toBe(auditError);
		expect(await f.users.getRelationship(f.userId, f.viewerId, RelationshipTypes.FRIEND)).toBeNull();
		expect(await f.users.getRelationship(f.viewerId, f.userId, RelationshipTypes.FRIEND)).toBeNull();
		expect(f.calls.filter((call) => call === 'pair-apply')).toHaveLength(2);
		expect(f.calls.filter((call) => call === 'notification-dropped')).toHaveLength(2);
	});

	it.each(['dob', 'friend'] as const)('%s audit and apply failures retain the protected fence', async (kind) => {
		const f = await fixture();
		const auditError = new Error('audit unavailable');
		f.auditService.createAuditLog.mockRejectedValue(auditError);
		const pending = new Set<string>();
		const finalize = async (request: {phase: string; request_id: string}) => {
			if (request.phase === 'apply') throw new Error('receiver acknowledgement timeout');
			pending.add(request.request_id);
		};
		if (kind === 'dob') {
			const rpc = f.policyRpc.getMockImplementation()!;
			f.policyRpc.mockImplementation(async (request) => {
				await finalize(request);
				return rpc(request);
			});
			await expect(
				f.profile.changeDob({user_id: f.userId, date_of_birth: '2001-01-01'}, f.viewerId, null, new Set()),
			).rejects.toBe(auditError);
			expect((await f.users.findSettings(f.userId, {authoritative: true}))?.gameActivityPolicyRevision).toBe(1n);
			expect(f.policyRpc.mock.calls.some(([request]) => request.phase === 'apply')).toBe(true);
		} else {
			const rpc = f.pairRpc.getMockImplementation()!;
			f.pairRpc.mockImplementation(async (request) => {
				await finalize(request);
				return rpc(request);
			});
			await expect(
				f.relationships.removeRelationship(
					{user_id: f.userId, target_user_id: f.viewerId, category: 'friend'},
					f.viewerId,
					null,
				),
			).rejects.toBe(auditError);
			expect(await f.users.getRelationship(f.userId, f.viewerId, RelationshipTypes.FRIEND)).toBeNull();
			expect(f.pairRpc.mock.calls.some(([request]) => request.phase === 'apply')).toBe(true);
		}
		expect(pending.size).toBe(kind === 'dob' ? 1 : 2);
		expect(f.calls).not.toContain('user-update');
		expect(f.calls).not.toContain('notification-dropped');
	});

	it.each([ProfilePrivacyLevels.FRIENDS_ONLY, ProfilePrivacyLevels.EVERYONE])(
		'DOB correction persists and revokes a sharing account with profile level %i',
		async (privacy) => {
			const f = await fixture(privacy);
			expect((await f.grants.getGrants(f.viewerId, [f.userId], 'before')).grants[0].allowed).toBe(true);
			await f.profile.changeDob({user_id: f.userId, date_of_birth: '2015-01-01'}, f.viewerId, null, new Set());
			expect((await f.users.findUnique(f.userId))?.dateOfBirth).toBe('2015-01-01');
			const settings = await f.users.findSettings(f.userId, {authoritative: true});
			expect(settings?.gameActivityPolicyRevision).toBe(1n);
			expect(settings?.profilePrivacy).toBe(
				privacy === ProfilePrivacyLevels.EVERYONE ? ProfilePrivacyLevels.ALL_GUILDS : privacy,
			);
			expect(f.calls).toEqual(['fence', 'persist-dob', 'audit', 'apply', 'user-update']);
			expect(f.policyRequests[1]).toMatchObject({
				eligible_16_plus: false,
				effective_profile_audience: privacy === ProfilePrivacyLevels.EVERYONE ? 'guilds' : 'close',
				policy_revision: '1',
			});
			expect(f.policyRequests[0]).toMatchObject({phase: 'fence', recoverable: false});
			expect((await f.grants.getGrants(f.viewerId, [f.userId], 'after')).grants[0].allowed).toBe(false);
		},
	);

	it('DOB fence failure prevents the authoritative age write', async () => {
		const f = await fixture();
		f.policyRpc.mockRejectedValue(new Error('receiver acknowledgement timeout'));
		await expect(
			f.profile.changeDob({user_id: f.userId, date_of_birth: '2015-01-01'}, f.viewerId, null, new Set()),
		).rejects.toThrow();
		expect((await f.users.findUnique(f.userId))?.dateOfBirth).toBe('2000-01-01');
		expect(f.calls).not.toContain('persist-dob');
	});

	it('DOB apply failure reports failure after persisting the restrictive age', async () => {
		const f = await fixture();
		f.policyRpc.mockImplementation(async (request) => {
			if (request.phase === 'apply') throw new Error('receiver acknowledgement timeout');
			return {
				owner_epoch: 'owner',
				request_id: request.request_id,
				phase: request.phase,
				policy_revision: request.policy_revision,
				revoked_sessions: 1,
			};
		});
		await expect(
			f.profile.changeDob({user_id: f.userId, date_of_birth: '2015-01-01'}, f.viewerId, null, new Set()),
		).rejects.toThrow();
		expect((await f.users.findUnique(f.userId))?.dateOfBirth).toBe('2015-01-01');
		expect(f.calls).not.toContain('user-update');
		expect(f.calls).toContain('audit');
	});

	it('DOB correction cannot widen a newer concurrent Only me preference', async () => {
		const f = await fixture(ProfilePrivacyLevels.EVERYONE);
		let reached!: () => void;
		let resume!: () => void;
		const started = new Promise<void>((resolve) => {
			reached = resolve;
		});
		const barrier = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const write = vi.mocked(f.users.patchUpsert).getMockImplementation()!;
		vi.mocked(f.users.patchUpsert).mockImplementationOnce(async (...args) => {
			reached();
			await barrier;
			return write(...args);
		});
		const update = f.profile
			.changeDob({user_id: f.userId, date_of_birth: '2015-01-01'}, f.viewerId, null, new Set())
			.then(
				() => null,
				(error: unknown) => error,
			);
		await started;
		await f.users.patchSettings(f.userId, {profile_privacy: ProfilePrivacyLevels.ONLY_ME});
		resume();
		const error = await update;
		expect((await f.users.findSettings(f.userId, {authoritative: true}))?.profilePrivacy).toBe(
			ProfilePrivacyLevels.ONLY_ME,
		);
		expect(error).toBeNull();
		expect((await f.users.findUnique(f.userId))?.dateOfBirth).toBe('2015-01-01');
		expect(f.calls).toContain('audit');
		expect(f.policyRequests.at(-1)).toMatchObject({
			phase: 'apply',
			policy_revision: '2',
			effective_profile_audience: 'only_me',
		});
	});

	it.each(['single', 'bulk'] as const)(
		'admin %s friendship removal uses pair ACK despite dropped notifications',
		async (mode) => {
			const f = await fixture();
			const data = {user_id: f.userId, category: 'friend' as const};
			if (mode === 'single')
				await f.relationships.removeRelationship({...data, target_user_id: f.viewerId}, f.viewerId, null);
			else
				expect(await f.relationships.removeRelationshipsByCategory(data, f.viewerId, null)).toEqual({removed_count: 1});
			expect(f.calls.slice(0, 4)).toEqual(['pair-fence', 'pair-fence', 'persist-relationship', 'persist-relationship']);
			expect(f.calls.filter((call) => call === 'pair-apply')).toHaveLength(2);
			if (mode === 'single') expect(f.calls.indexOf('audit')).toBeLessThan(f.calls.indexOf('pair-apply'));
			else expect(f.calls.indexOf('pair-apply')).toBeLessThan(f.calls.indexOf('audit'));
			expect((await f.grants.getGrants(f.viewerId, [f.userId], 'after')).grants[0].allowed).toBe(false);
		},
	);

	it.each(['single', 'bulk'] as const)(
		'admin %s removal audits persistence despite missing receiver ACK',
		async (mode) => {
			const f = await fixture();
			const second = createUserID(803n);
			if (mode === 'bulk')
				await f.users.upsertRelationship({
					source_user_id: f.userId,
					target_user_id: second,
					type: RelationshipTypes.FRIEND,
					nickname: null,
					since: new Date(),
					share_voice_activity: true,
					version: 1,
				});
			f.pairRpc.mockImplementation(async (request) => {
				if (request.phase === 'apply') throw new Error('receiver acknowledgement timeout');
				return {owner_epoch: 'owner', request_id: request.request_id, phase: request.phase, pair_generation: '1'};
			});
			const data = {user_id: f.userId, category: 'friend' as const};
			await expect(
				mode === 'single'
					? f.relationships.removeRelationship({...data, target_user_id: f.viewerId}, f.viewerId, null)
					: f.relationships.removeRelationshipsByCategory(data, f.viewerId, null),
			).rejects.toThrow();
			expect(await f.users.getRelationship(f.userId, f.viewerId, RelationshipTypes.FRIEND)).toBeNull();
			expect(f.calls.filter((call) => call === 'audit')).toHaveLength(1);
			if (mode === 'bulk') {
				expect(await f.users.getRelationship(f.userId, second, RelationshipTypes.FRIEND)).not.toBeNull();
				expect(f.auditService.createAuditLog).toHaveBeenCalledWith(
					expect.objectContaining({
						metadata: new Map([
							['category', 'friend'],
							['removed_count', '1'],
						]),
					}),
				);
			}
		},
	);

	it('admin friendship fence failure prevents either friendship row from being deleted', async () => {
		const f = await fixture();
		f.pairRpc.mockRejectedValue(new Error('receiver acknowledgement timeout'));
		await expect(
			f.relationships.removeRelationship(
				{user_id: f.userId, target_user_id: f.viewerId, category: 'friend'},
				f.viewerId,
				null,
			),
		).rejects.toThrow();
		expect(await f.users.getRelationship(f.userId, f.viewerId, RelationshipTypes.FRIEND)).not.toBeNull();
		expect(f.calls).not.toContain('persist-relationship');
	});

	it('bulk removal waits for the current pair receiver ACK before writing the next pair', async () => {
		const f = await fixture();
		const second = createUserID(803n);
		await f.users.upsertRelationship({
			source_user_id: f.userId,
			target_user_id: second,
			type: RelationshipTypes.FRIEND,
			nickname: null,
			since: new Date(),
			share_voice_activity: true,
			version: 1,
		});
		let reached!: () => void;
		let resume!: () => void;
		const started = new Promise<void>((resolve) => {
			reached = resolve;
		});
		const barrier = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const rpc = f.pairRpc.getMockImplementation()!;
		f.pairRpc.mockImplementation(async (request) => {
			if (request.phase === 'apply' && request.viewer_id === f.viewerId.toString()) {
				reached();
				await barrier;
			}
			return rpc(request);
		});
		let succeeded = false;
		const removal = f.relationships
			.removeRelationshipsByCategory({user_id: f.userId, category: 'friend'}, f.viewerId, null)
			.then((result) => {
				succeeded = true;
				return result;
			});
		await Promise.race([started, removal]);
		expect(succeeded).toBe(false);
		expect(await f.users.getRelationship(f.userId, second, RelationshipTypes.FRIEND)).not.toBeNull();
		resume();
		expect(await removal).toEqual({removed_count: 2});
	});

	it('generic full-row writes still cannot narrow a sharing profile without a fence', async () => {
		const f = await fixture(ProfilePrivacyLevels.EVERYONE);
		const settings = (await f.users.findSettings(f.userId, {authoritative: true}))!;
		await expect(
			f.users.upsertSettings({...settings.toRow(), profile_privacy: ProfilePrivacyLevels.ALL_GUILDS}),
		).rejects.toThrow();
	});
});
