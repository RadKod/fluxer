// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {createDefaultLimitConfig} from '@app/api/constants/LimitConfig';
import {EMPTY_USER_ROW} from '@app/api/database/types/UserTypes';
import {invalidateCachedAccountIdentity, setCachedAccountIdentity} from '@app/api/instance/AccountIdentityModeCache';
import * as LimitConfig from '@app/api/limits/LimitConfigService';
import {getUsernameSelectionGate, setInjectedUsernameOwnershipService} from '@app/api/middleware/ServiceRegistry';
import {getInstanceConfigRepository} from '@app/api/middleware/ServiceSingletons';
import {User} from '@app/api/models/User';
import {UserAccountSecurityService} from '@app/api/user/services/UserAccountSecurityService';
import {UserAccountService} from '@app/api/user/services/UserAccountService';
import {UserChannelService} from '@app/api/user/services/UserChannelService';
import {UserRelationshipService} from '@app/api/user/services/UserRelationshipService';
import * as UniqueUsernames from '@app/api/user/UniqueUsernames';
import {AccountIdentityModes, TagStyles} from '@fluxer/constants/src/AccountIdentityConstants';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const id = createUserID(1174109840998400001n);
function person(state: 'selected' | 'reselect_required' | null = null) {
	return new User({
		...EMPTY_USER_ROW,
		user_id: id,
		username: 'legacy_name',
		discriminator: 1234,
		email: 'owner@example.com',
		email_verified: true,
		password_hash: 'hash',
		username_state: state,
	});
}
function security(holders: Array<User> = [], premiumMode: 'mirror' | 'everyone' = 'everyone') {
	return new UserAccountSecurityService({
		apiContext: {
			services: {
				users: {findUsersByUsername: vi.fn().mockResolvedValue(holders)},
				cache: {acquireLock: vi.fn().mockResolvedValue('token'), releaseLock: vi.fn()},
			},
		},
		userAccountRepository: {},
		discriminatorService: {generateDiscriminator: vi.fn().mockResolvedValue({available: true, discriminator: 4321})},
		rateLimitService: {checkLimit: vi.fn().mockResolvedValue({allowed: true})},
		limitConfigService: {
			getConfigSnapshot: () =>
				premiumMode === 'mirror'
					? {traitDefinitions: [], rules: [{id: 'no_custom_tag', limits: {feature_custom_discriminator: 0}}]}
					: createDefaultLimitConfig({selfHosted: true, premiumMode}),
		},
	} as never);
}
function migration(state: 'legacy' | 'preparing' | 'selecting') {
	const config = {state, epoch: 1, started_at: '2026-01-01T00:00:00Z', forced_at: '2026-01-08T00:00:00Z'};
	setCachedAccountIdentity({mode: AccountIdentityModes.EMAIL, tagStyle: TagStyles.NONE, usernameMigration: config});
	vi.spyOn(getInstanceConfigRepository(), 'getAccountIdentity').mockResolvedValue({
		mode: AccountIdentityModes.EMAIL,
		tagStyle: TagStyles.NONE,
		usernameMigration: config,
	});
	vi.spyOn(getInstanceConfigRepository(), 'getUsernameMigrationConfig').mockResolvedValue(config);
}
let selfHosted: boolean;
beforeEach(() => {
	selfHosted = Config.instance.selfHosted;
	Config.instance.selfHosted = true;
	vi.spyOn(LimitConfig, 'getGlobalLimitConfigSnapshot').mockReturnValue(
		createDefaultLimitConfig({selfHosted: true, premiumMode: 'everyone'}),
	);
});
afterEach(() => {
	vi.restoreAllMocks();
	setCachedAccountIdentity(null);
	Config.instance.selfHosted = selfHosted;
	setInjectedUsernameOwnershipService(undefined);
});

function accountService(
	usernameClaim?: string,
	changeDisplayName = false,
	identityChanged = false,
	usernameReservation?: {release: () => Promise<void>},
) {
	const user = person();
	const updated = identityChanged
		? new User({
				...user.toRow(),
				username: 'chosen_name',
				discriminator: 0,
				username_state: 'selected',
				identity_version: 1n,
			})
		: changeDisplayName
			? new User({...user.toRow(), global_name: 'New name'})
			: user;
	const worker = {addJob: vi.fn().mockResolvedValue(1n)};
	const repository = {
		patchUpsert: vi.fn().mockResolvedValue(updated),
		findUniqueAssert: vi.fn().mockResolvedValue(updated),
		getUserGuildIds: vi.fn().mockResolvedValue([]),
	};
	const service: UserAccountService = Object.assign(Object.create(UserAccountService.prototype), {
		apiContext: {services: {worker}},
		userAccountRepository: repository,
		guildRepository: {},
		profileService: {processProfileUpdates: vi.fn().mockResolvedValue({updates: {}}), commitAssetChanges: vi.fn()},
		securityService: {
			processSecurityUpdates: vi.fn().mockResolvedValue({updates: {}, metadata: {usernameClaim, usernameReservation}}),
		},
		contactChangeLogService: {recordDiff: vi.fn()},
		updatePropagator: {dispatchUserUpdate: vi.fn(), propagatePartialUserChange: vi.fn()},
		searchIndexService: {updateUserMembers: vi.fn()},
	});
	return {user, worker, repository, service};
}

describe('username account writer and action boundaries', () => {
	it.each([AccountIdentityModes.USERNAME, AccountIdentityModes.EMAIL])(
		'legacy unique mode %s rejects another human name',
		async (mode) => {
			migration('legacy');
			vi.spyOn(getInstanceConfigRepository(), 'getAccountIdentity').mockResolvedValue({mode, tagStyle: TagStyles.NONE});
			const holder = new User({...person().toRow(), user_id: createUserID(2n), username: 'occupied'});
			await expect(
				security([holder]).processSecurityUpdates({
					user: person(),
					data: {username: 'OCCUPIED'},
					sudoContext: {method: 'mfa'} as never,
				}),
			).rejects.toMatchObject({
				status: 400,
				data: {errors: expect.arrayContaining([expect.objectContaining({code: 'USERNAME_ALREADY_TAKEN'})])},
			});
		},
	);
	it('legacy tagStyle none rejects an explicit different nonzero discriminator', async () => {
		migration('legacy');
		await expect(
			security().processSecurityUpdates({
				user: person(),
				data: {discriminator: 4321},
				sudoContext: {method: 'mfa'} as never,
			}),
		).rejects.toMatchObject({
			status: 400,
			data: {
				errors: expect.arrayContaining([expect.objectContaining({code: 'DISCRIMINATOR_NOT_SUPPORTED_ON_INSTANCE'})]),
			},
		});
	});
	it('legacy tagStyle none renames keep a nonzero tag and reserve the chosen name', async () => {
		migration('legacy');
		const user = person();
		const result = await security().processSecurityUpdates({
			user,
			data: {username: 'fresh_name'},
			sudoContext: {method: 'mfa'} as never,
		});
		expect(result.updates.discriminator).toBe(user.discriminator);
		expect(result.metadata).toHaveProperty('usernameReservation');
	});
	it('a legacy rename is refused when the identity snapshot is older than the write window', async () => {
		migration('legacy');
		vi.spyOn(getInstanceConfigRepository(), 'getConfig').mockResolvedValue(null);
		setCachedAccountIdentity({mode: AccountIdentityModes.EMAIL, tagStyle: TagStyles.NONE}, Date.now() - 60_000);
		await expect(
			security().processSecurityUpdates({
				user: person(),
				data: {username: 'fresh_name'},
				sudoContext: {method: 'mfa'} as never,
			}),
		).rejects.toMatchObject({status: 503, code: 'USERNAME_UNAVAILABLE'});
	});
	it('legacy tagStyle none allows the unchanged nonzero tag without a custom tag perk', async () => {
		migration('legacy');
		const user = person();
		await expect(
			security([], 'mirror').processSecurityUpdates({user, data: {discriminator: user.discriminator}}),
		).resolves.toMatchObject({updates: {discriminator: user.discriminator}});
	});
	it.each([false, true])('releases a legacy username reservation after a profile writer (fails=%s)', async (fails) => {
		const release = vi.fn().mockResolvedValue(undefined);
		const {user, repository, service} = accountService(undefined, false, false, {release});
		if (fails) repository.patchUpsert.mockRejectedValue(new Error('write failed'));
		const update = service.update({
			user,
			oldAuthSession: {} as never,
			data: {},
			request: new Request('http://localhost/'),
		});
		if (fails) await expect(update).rejects.toThrow('write failed');
		else await update;
		expect(release).toHaveBeenCalledOnce();
	});
	it('self claim uses the authenticated user id and a generic identity-free patch', async () => {
		const {user, repository, service} = accountService('chosen_name');
		const claimSelf = vi.fn().mockResolvedValue({ok: true, username: 'chosen_name', noop: false});
		setInjectedUsernameOwnershipService({claimSelf} as never);
		await service.update({
			user,
			oldAuthSession: {} as never,
			data: {username: 'chosen_name'},
			request: new Request('http://localhost/'),
		});
		expect(claimSelf).toHaveBeenCalledWith(user.id, 'chosen_name');
		expect(repository.patchUpsert).toHaveBeenCalledWith(user.id, {}, user.toRow(), undefined);
	});
	it('missing self ownership fails closed before a profile write', async () => {
		const {user, repository, service} = accountService('chosen_name');
		await expect(
			service.update({
				user,
				oldAuthSession: {} as never,
				data: {username: 'chosen_name'},
				request: new Request('http://localhost/'),
			}),
		).rejects.toMatchObject({status: 503, code: 'USERNAME_UNAVAILABLE'});
		expect(repository.patchUpsert).not.toHaveBeenCalled();
	});
	it('identity generation changes enqueue the durable guild reindex task', async () => {
		const {user, worker, service} = accountService('chosen_name', false, true);
		setInjectedUsernameOwnershipService({
			claimSelf: vi.fn().mockResolvedValue({ok: true, username: 'chosen_name', noop: false}),
		} as never);
		await service.update({
			user,
			oldAuthSession: {} as never,
			data: {global_name: 'New name'},
			request: new Request('http://localhost/'),
		});
		expect(worker.addJob).toHaveBeenCalledWith(
			'reindexUserGuildMembers',
			{user_id: id.toString(), enqueued_at_ms: expect.any(Number)},
			expect.objectContaining({requireLedger: true}),
		);
	});
	it('global name only changes retain the native reindex path without sharing an identity-generation job key', async () => {
		const {user, worker, repository, service} = accountService(undefined, true);
		await service.update({
			user,
			oldAuthSession: {} as never,
			data: {global_name: 'New name'},
			request: new Request('http://localhost/'),
		});
		expect(worker.addJob).not.toHaveBeenCalled();
		expect(repository.getUserGuildIds).toHaveBeenCalledWith(user.id);
	});
	it('an identity generation change queues reindex even when the displayed name is unchanged', async () => {
		const {user, worker, repository, service} = accountService();
		repository.patchUpsert.mockResolvedValue(
			new User({...user.toRow(), username_state: 'selected', identity_version: 1n}),
		);
		await service.update({user, oldAuthSession: {} as never, data: {}, request: new Request('http://localhost/')});
		expect(worker.addJob).toHaveBeenCalledWith(
			'reindexUserGuildMembers',
			expect.any(Object),
			expect.objectContaining({jobKey: `username-reindex:${id}:1`}),
		);
	});
	it('account and OAuth callers share the registry action gate', () => {
		expect(UniqueUsernames).not.toHaveProperty('getUsernameSelectionGate');
		expect(UniqueUsernames).not.toHaveProperty('assertUsernameMayAct');
		expect(getUsernameSelectionGate()).toBe(getUsernameSelectionGate());
	});
	it('provides authoritative claim availability without owner disclosure', () => {
		expect(UniqueUsernames).toHaveProperty('checkUsernameClaimAvailability', expect.any(Function));
	});
	it('provides bare and tagged lookup without falling through to legacy bare indexes', () => {
		expect(UniqueUsernames).toHaveProperty('resolveUsernameHandle', expect.any(Function));
	});
	it.each(['legacy', 'preparing', 'selecting'] as const)(
		'generic profile patch is identity-free in %s',
		async (state) => {
			migration(state);
			const result = await security().processSecurityUpdates({user: person(), data: {global_name: 'New display'}});
			expect(result.updates).not.toHaveProperty('username');
			expect(result.updates).not.toHaveProperty('discriminator');
			expect(result.updates).not.toHaveProperty('username_state');
			expect(result.updates.global_name).toBe('New display');
		},
	);
	it.each(['preparing', 'selecting'] as const)('human identity request routes to ownership in %s', async (state) => {
		migration(state);
		const result = await security().processSecurityUpdates({user: person(), data: {username: 'legacy_name'}});
		expect(result.metadata).toHaveProperty('usernameClaim', 'legacy_name');
		expect(result.updates).not.toHaveProperty('username');
		expect(result.updates).not.toHaveProperty('discriminator');
	});
	it('legacy humans cannot explicitly request zero', async () => {
		migration('legacy');
		await expect(
			security().processSecurityUpdates({
				user: person(),
				data: {discriminator: 0},
				sudoContext: {method: 'mfa'} as never,
			}),
		).rejects.toMatchObject({status: 400});
	});
	it('bot-token identity noops cannot preserve a zero discriminator', async () => {
		migration('legacy');
		const bot = new User({...person().toRow(), bot: true, discriminator: 0});
		await expect(security().processSecurityUpdates({user: bot, data: {username: bot.username}})).rejects.toMatchObject({
			status: 400,
		});
	});
	it('unreadable authoritative migration rejects identity changes with 503', async () => {
		migration('legacy');
		vi.spyOn(getInstanceConfigRepository(), 'getUsernameMigrationConfig').mockRejectedValue(new Error('offline'));
		await expect(
			security().processSecurityUpdates({user: person(), data: {username: 'legacy_name'}}),
		).rejects.toMatchObject({status: 503, code: 'USERNAME_UNAVAILABLE'});
	});
	it.each(['sendFriendRequest', 'acceptFriendRequest'] as const)(
		'gates relationship %s before any mutation',
		async (method) => {
			migration('selecting');
			const users = {
				findUnique: vi.fn().mockResolvedValue(person()),
				getRelationship: vi.fn(),
				deleteRelationship: vi.fn(),
				upsertRelationship: vi.fn(),
			};
			vi.spyOn(getInstanceConfigRepository(), 'getInstancePolicyConfig').mockResolvedValue({
				direct_messages_disabled: false,
			} as never);
			const service = new UserRelationshipService({services: {users, gateway: {}}} as never, {} as never, {} as never);
			await expect(
				service[method]({
					userId: id,
					targetId: createUserID(2n),
					userCacheService: {} as never,
					requestCache: {} as never,
				}),
			).rejects.toMatchObject({code: 'USERNAME_SELECTION_REQUIRED'});
			expect(users.upsertRelationship).not.toHaveBeenCalled();
			expect(users.deleteRelationship).not.toHaveBeenCalled();
		},
	);
	it('hosted-false cannot bypass the forced period', async () => {
		migration('selecting');
		Config.instance.selfHosted = false;
		expect(() => getUsernameSelectionGate().assertMayAct(person(), 'relationship_create')).toThrowError(
			'USERNAME_SELECTION_REQUIRED',
		);
	});
	it('selected users and immune bots never consult migration state; reselect still blocks', () => {
		invalidateCachedAccountIdentity(new Error('offline'));
		const gate = getUsernameSelectionGate();
		expect(() => gate.assertMayAct(person('selected'), 'dm_open')).not.toThrow();
		expect(() => gate.assertMayAct(new User({...person().toRow(), bot: true}), 'dm_open')).not.toThrow();
		expect(() => gate.assertMayAct(person('reselect_required'), 'dm_open')).toThrowError('USERNAME_SELECTION_REQUIRED');
		let failure: unknown;
		try {
			gate.assertMayAct(person(), 'dm_open');
		} catch (error) {
			failure = error;
		}
		expect(failure).toMatchObject({status: 503});
	});
	it.each([
		'createOrOpenDMChannel',
		'ensureDmOpenForBothUsers',
		'reopenDmForBothUsers',
		'createNewDmForBothUsers',
	] as const)('gates alternate DM path %s', async (method) => {
		migration('selecting');
		const users = {findUnique: vi.fn().mockResolvedValue(person()), findExistingDmState: vi.fn()};
		const service = new UserChannelService(
			{services: {users, gateway: {}, snowflake: {}}} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
		);
		await expect(
			service[method]({
				userId: id,
				recipientId: createUserID(2n),
				data: {recipient_id: 2n},
				existingChannel: {},
				userCacheService: {},
				requestCache: {},
			} as never),
		).rejects.toMatchObject({code: 'USERNAME_SELECTION_REQUIRED'});
		expect(users.findExistingDmState).not.toHaveBeenCalled();
	});
});
