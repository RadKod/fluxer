// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHash} from 'node:crypto';
import {createUserID} from '@app/api/BrandedTypes';
import {createDefaultLimitConfig} from '@app/api/constants/LimitConfig';
import {EMPTY_USER_ROW} from '@app/api/database/types/UserTypes';
import * as AccountIdentityModeCache from '@app/api/instance/AccountIdentityModeCache';
import * as LimitConfig from '@app/api/limits/LimitConfigService';
import * as ServiceRegistry from '@app/api/middleware/ServiceRegistry';
import {getKVClient, setInjectedUsernameOwnershipService} from '@app/api/middleware/ServiceRegistry';
import {getCacheService, getInstanceConfigRepository} from '@app/api/middleware/ServiceSingletons';
import {User} from '@app/api/models/User';
import {UserAccountLookupService} from '@app/api/user/services/UserAccountLookupService';
import {UserAccountRequestService} from '@app/api/user/services/UserAccountRequestService';
import * as UniqueUsernames from '@app/api/user/UniqueUsernames';
import {UsernameOwnershipUnavailableError} from '@app/api/user/username/UsernameOwnershipService';
import {compileUsernameDictionary, UsernamePolicyService} from '@app/api/user/username/UsernamePolicyService';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const id = createUserID(1174109840998400001n);
const otherId = createUserID(1174109840998400002n);
const snapshot = {
	policyRevision: 1,
	tiers: {1: 'locked', 2: 'locked', 3: 'locked'} as const,
	migration: {
		state: 'selecting' as const,
		epoch: 1,
		startedAt: new Date('2026-01-01'),
		forcedAt: new Date('2026-01-08'),
	},
	admission: {globalPerSecond: 10, paused: false},
	dictionary: compileUsernameDictionary(1, {uname_exact: [], uname_contains: [], uname_allow: []}),
};
function setupClaim(state: string, ownerId: bigint | null = otherId, blockedUntil: Date | null = null) {
	const ownership = {
		readClaimForAvailability: vi.fn().mockResolvedValue({state, user_id: ownerId, blocked_until: blockedUntil}),
		resolveBareName: vi.fn().mockResolvedValue(otherId),
		repository: {readEntitlement: vi.fn().mockResolvedValue(null)},
		getPrivateStatus: vi
			.fn()
			.mockResolvedValue({state: 'selected', changeAvailableAt: null, freeChangeAvailable: true}),
	};
	setInjectedUsernameOwnershipService(ownership as never);
	return ownership;
}
beforeEach(() => {
	vi.spyOn(LimitConfig, 'getGlobalLimitConfigSnapshot').mockReturnValue(
		createDefaultLimitConfig({selfHosted: true, premiumMode: 'everyone'}),
	);
	vi.spyOn(UsernamePolicyService.prototype, 'readAuthoritative').mockResolvedValue(snapshot);
	vi.spyOn(UsernamePolicyService.prototype, 'readCached').mockResolvedValue(snapshot);
	vi.spyOn(getCacheService(), 'get').mockResolvedValue(null);
	vi.spyOn(getCacheService(), 'set').mockResolvedValue();
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	setInjectedUsernameOwnershipService(undefined);
});

describe('username availability and lookup boundaries', () => {
	it('legacy pending deleted humans retain their nonzero username until actual deletion', async () => {
		const pending = new User({
			...EMPTY_USER_ROW,
			user_id: otherId,
			username: 'held_name',
			discriminator: 1234,
			flags: UserFlags.DELETED,
			pending_deletion_at: new Date(Date.now() + 30 * 86400000),
		});
		expect(
			await UniqueUsernames.isUsernameTaken({findUsersByUsername: vi.fn().mockResolvedValue([pending])}, 'HELD_NAME'),
		).toBe(true);
	});
	it.each(['preparing', 'selecting'] as const)(
		'active %s login resolves an assigned bare owner without a legacy index scan',
		async (state) => {
			vi.spyOn(getInstanceConfigRepository(), 'getUsernameMigrationConfig').mockResolvedValue({
				state,
				epoch: 1,
				started_at: null,
				forced_at: null,
			});
			const ownership = setupClaim('assigned');
			const selected = new User({
				...EMPTY_USER_ROW,
				user_id: otherId,
				username: 'selected_name',
				discriminator: 0,
				username_state: 'selected',
			});
			const users = {
				findUsersByUsername: vi.fn().mockResolvedValue([]),
				findUnique: vi.fn().mockResolvedValue(selected),
				findByUsernameDiscriminator: vi.fn().mockResolvedValue(selected),
			};
			expect(
				await UniqueUsernames.findPersonByLoginHandle(users, {username: 'SELECTED_NAME', discriminator: null}),
			).toBe(selected);
			expect(ownership.resolveBareName).toHaveBeenCalledWith('selected_name');
			expect(users.findUsersByUsername).not.toHaveBeenCalled();
		},
	);
	it('active login refuses a selected account through its tagged index entry', async () => {
		vi.spyOn(getInstanceConfigRepository(), 'getUsernameMigrationConfig').mockResolvedValue({
			state: 'selecting',
			epoch: 1,
			started_at: null,
			forced_at: null,
		});
		const selected = new User({
			...EMPTY_USER_ROW,
			user_id: otherId,
			username: 'selected_name',
			discriminator: 0,
			username_state: 'selected',
		});
		const users = {
			findUsersByUsername: vi.fn().mockResolvedValue([selected]),
			findUnique: vi.fn(),
			findByUsernameDiscriminator: vi.fn().mockResolvedValue(selected),
		};
		expect(
			await UniqueUsernames.findPersonByLoginHandle(users, {username: 'selected_name', discriminator: 0}),
		).toBeNull();
	});
	it('legacy login retains indexed tagged lookup and rejects an ambiguous bare handle', async () => {
		vi.spyOn(getInstanceConfigRepository(), 'getUsernameMigrationConfig').mockResolvedValue({
			state: 'legacy',
			epoch: 0,
			started_at: null,
			forced_at: null,
		});
		const first = new User({...EMPTY_USER_ROW, user_id: id, username: 'legacy_name', discriminator: 1234});
		const second = new User({...first.toRow(), user_id: otherId, discriminator: 4321});
		const users = {
			findUsersByUsername: vi.fn().mockResolvedValue([first, second]),
			findUnique: vi.fn(),
			findByUsernameDiscriminator: vi.fn(),
		};
		expect(
			await UniqueUsernames.findPersonByLoginHandle(users, {username: 'legacy_name', discriminator: null}),
		).toBeNull();
		expect(await UniqueUsernames.findPersonByLoginHandle(users, {username: 'legacy_name', discriminator: 4321})).toBe(
			second,
		);
		expect(users.findUnique).not.toHaveBeenCalled();
	});
	it('unreadable migration state fails closed for availability and prompt', async () => {
		vi.spyOn(getInstanceConfigRepository(), 'getUsernameMigrationConfig').mockRejectedValue(new Error('offline'));
		const user = new User({...EMPTY_USER_ROW, user_id: id, username: 'legacy_name', discriminator: 1234});
		await expect(
			new UserAccountLookupService({} as never).checkUsernameDiscriminatorAvailability({
				username: 'testname',
				currentUser: user,
			}),
		).rejects.toMatchObject({status: 503, code: 'USERNAME_UNAVAILABLE'});
		await expect(
			new UserAccountRequestService({} as never, {} as never, {} as never, {} as never, {} as never).getUsernamePrompt(
				user,
			),
		).rejects.toMatchObject({status: 503, code: 'USERNAME_UNAVAILABLE'});
	});
	it('caches an absent shared claim for five seconds without caching personal rights', async () => {
		const ownership = setupClaim('released', null);
		ownership.readClaimForAvailability.mockResolvedValue(null as never);
		await UniqueUsernames.checkUsernameClaimAvailability('empty_name', id);
		expect(getCacheService().set).toHaveBeenCalledWith(
			'username-availability:empty_name',
			{state: 'absent', userId: null, blockedUntil: null},
			5,
		);
		expect(ownership.getPrivateStatus).toHaveBeenCalledWith(id);
	});
	it('bare and @ lookup use assigned ownership and tagged selected identity never falls back', async () => {
		const ownership = setupClaim('assigned');
		vi.spyOn(getInstanceConfigRepository(), 'getUsernameMigrationConfig').mockResolvedValue({
			state: 'selecting',
			epoch: 1,
			started_at: null,
			forced_at: null,
		});
		const user = new User({
			...EMPTY_USER_ROW,
			user_id: otherId,
			username: 'selected_name',
			discriminator: 0,
			username_state: 'selected',
		});
		const users = {
			findUnique: vi.fn().mockResolvedValue(user),
			findByUsernameDiscriminator: vi.fn().mockResolvedValue(user),
		};
		expect(await UniqueUsernames.resolveUsernameHandle(users, '@Selected_Name')).toBe(user);
		expect(ownership.resolveBareName).toHaveBeenCalledWith('selected_name');
		expect(await UniqueUsernames.resolveUsernameHandle(users, 'legacy#1234')).toBeNull();
		expect(ownership.resolveBareName).toHaveBeenCalledTimes(1);
	});
	it.each([
		['held', 'RESERVED'],
		['banned', 'BLOCKED'],
		['pending', 'BUSY'],
		['assigned', 'TAKEN'],
	])('%s reports reason without owner identity', async (state, reason) => {
		setupClaim(state);
		expect(await UniqueUsernames.checkUsernameClaimAvailability('example_name', null)).toEqual({
			taken: true,
			reason,
			available_at: null,
		});
	});
	it('uses orphan-aware availability helper and caches only claim fields for five seconds', async () => {
		const ownership = setupClaim('released', null);
		expect(await UniqueUsernames.checkUsernameClaimAvailability('example_name', id)).toEqual({
			taken: false,
			reason: null,
			available_at: null,
		});
		expect(ownership.readClaimForAvailability).toHaveBeenCalledWith('example_name');
		expect(getCacheService().set).toHaveBeenCalledWith(
			'username-availability:example_name',
			{state: 'released', userId: null, blockedUntil: null},
			5,
		);
	});
	it('embargo carries available_at and never discloses owner', async () => {
		const date = new Date(Date.now() + 86400000);
		setupClaim('released', null, date);
		expect(await UniqueUsernames.checkUsernameClaimAvailability('example_name', null)).toEqual({
			taken: true,
			reason: 'RELEASE_EMBARGO',
			available_at: date.toISOString(),
		});
	});
	it('reads personal cooldown each time without caching it; current name remains a noop', async () => {
		const ownership = setupClaim('released', null);
		const date = new Date(Date.now() + 86400000);
		ownership.getPrivateStatus.mockResolvedValue({
			state: 'selected',
			freeChangeAvailable: false,
			changeAvailableAt: date,
		} as never);
		expect(await UniqueUsernames.checkUsernameClaimAvailability('example_name', id)).toEqual({
			taken: true,
			reason: 'COOLDOWN',
			available_at: date.toISOString(),
		});
		ownership.readClaimForAvailability.mockResolvedValue({
			state: 'assigned',
			user_id: id,
			blocked_until: null,
		} as never);
		expect(await UniqueUsernames.checkUsernameClaimAvailability('owned_name', id)).toEqual({
			taken: false,
			reason: null,
			available_at: null,
		});
	});
	it.each([null, id])(
		'selecting with a published dictionary fails closed when ownership is unavailable (user=%s)',
		async (userId) => {
			setInjectedUsernameOwnershipService(undefined);
			const unavailable = vi.spyOn(ServiceRegistry, 'getUsernameOwnershipService').mockImplementation(() => {
				throw new UsernameOwnershipUnavailableError();
			});
			expect(await UniqueUsernames.checkUsernameClaimAvailability('example_name', userId)).toEqual({
				taken: true,
				reason: 'UNAVAILABLE',
				available_at: null,
			});
			expect(unavailable).toHaveBeenCalledOnce();
			expect(UsernamePolicyService.prototype.readCached).toHaveBeenCalledOnce();
		},
	);
	it('active account lookup fails closed when the ownership service is unavailable', async () => {
		vi.spyOn(getInstanceConfigRepository(), 'getUsernameMigrationConfig').mockResolvedValue({
			state: 'selecting',
			epoch: 1,
			started_at: '2026-01-01T00:00:00Z',
			forced_at: '2026-01-08T00:00:00Z',
		});
		vi.spyOn(ServiceRegistry, 'getUsernameOwnershipService').mockImplementation(() => {
			throw new UsernameOwnershipUnavailableError();
		});
		const currentUser = new User({...EMPTY_USER_ROW, user_id: id, username: 'legacy_name', discriminator: 1234});
		expect(
			await new UserAccountLookupService({} as never).checkUsernameDiscriminatorAvailability({
				username: 'example_name',
				currentUser,
			}),
		).toEqual({taken: true, reason: 'UNAVAILABLE', available_at: null});
	});
	it('legacy generation zero retains tagged availability without an ownership service', async () => {
		vi.spyOn(getInstanceConfigRepository(), 'getUsernameMigrationConfig').mockResolvedValue({
			state: 'legacy',
			epoch: 0,
			started_at: null,
			forced_at: null,
		});
		vi.spyOn(AccountIdentityModeCache, 'usesUniqueUsernames').mockReturnValue(false);
		vi.mocked(UsernamePolicyService.prototype.readAuthoritative).mockResolvedValue({
			...snapshot,
			migration: {state: 'legacy', epoch: 0, startedAt: null, forcedAt: null},
			dictionary: compileUsernameDictionary(0, {uname_exact: [], uname_contains: [], uname_allow: []}),
		});
		const unavailable = vi.spyOn(ServiceRegistry, 'getUsernameOwnershipService').mockImplementation(() => {
			throw new UsernameOwnershipUnavailableError();
		});
		const isAvailable = vi.fn().mockResolvedValue(true);
		const currentUser = new User({...EMPTY_USER_ROW, user_id: id, username: 'legacy_name', discriminator: 1234});
		const lookup = new UserAccountLookupService({
			discriminatorService: {isDiscriminatorAvailableForUsername: isAvailable},
		} as never);
		expect(
			await lookup.checkUsernameDiscriminatorAvailability({username: 'example_name', discriminator: 4321, currentUser}),
		).toEqual({taken: false});
		expect(isAvailable).toHaveBeenCalledWith('example_name', 4321);
		expect(unavailable).not.toHaveBeenCalled();
		expect(UsernamePolicyService.prototype.readAuthoritative).not.toHaveBeenCalled();
	});
	it('provides one shared bot-name check for creation and bot-token rename', () => {
		expect(UniqueUsernames).toHaveProperty('assertBotUsernameAvailable', expect.any(Function));
	});
	it('provides private status and daily prompt methods', () => {
		const service = new UserAccountRequestService({} as never, {} as never, {} as never, {} as never, {} as never);
		expect(service).toHaveProperty('getUsernameStatus', expect.any(Function));
		expect(service).toHaveProperty('getUsernamePrompt', expect.any(Function));
	});
	it('OAuth identify cannot receive the private username state through /users/@me', () => {
		const service = new UserAccountRequestService({} as never, {} as never, {} as never, {} as never, {} as never);
		const user = new User({
			...EMPTY_USER_ROW,
			user_id: id,
			username: 'selected_name',
			discriminator: 0,
			username_state: 'selected',
		});
		const response = service.getCurrentUserResponse({
			authTokenType: 'bearer',
			oauthBearerScopes: new Set(['identify']),
			user,
		});
		expect(response).not.toHaveProperty('username_state');
	});
	it('private status serializes dates without exposing an owner row', async () => {
		const ownership = setupClaim('released', null);
		const date = new Date('2026-01-20T12:00:00Z');
		ownership.getPrivateStatus.mockResolvedValue({
			state: 'selected',
			freeChangeAvailable: false,
			changeAvailableAt: date,
		} as never);
		const service = new UserAccountRequestService({} as never, {} as never, {} as never, {} as never, {} as never);
		expect(await service.getUsernameStatus(id)).toEqual({
			state: 'selected',
			freeChangeAvailable: false,
			changeAvailableAt: date.toISOString(),
		});
	});
	it('daily prompt uses atomic NX and Istanbul day with a two-day TTL; absent Valkey hides it', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-04T04:00:00Z'));
		const migration = {
			state: 'selecting' as const,
			epoch: 1,
			started_at: '2026-01-01T00:00:00Z',
			forced_at: '2026-01-08T00:00:00Z',
		};
		vi.spyOn(getInstanceConfigRepository(), 'getUsernameMigrationConfig').mockResolvedValue(migration);
		const kvSet = vi
			.spyOn(getKVClient(), 'set')
			.mockResolvedValueOnce('OK')
			.mockResolvedValueOnce(null)
			.mockRejectedValueOnce(new Error('absent'));
		const service = new UserAccountRequestService({} as never, {} as never, {} as never, {} as never, {} as never);
		const user = new User({...EMPTY_USER_ROW, user_id: id, username: 'legacy_name', discriminator: 1234});
		expect(await service.getUsernamePrompt(user)).toEqual({show: true});
		expect(await service.getUsernamePrompt(user)).toEqual({show: false});
		expect(await service.getUsernamePrompt(user)).toEqual({show: false});
		expect(kvSet).toHaveBeenCalledWith(`uprompt:${id}:2026-01-04`, '1', 'EX', 172800, 'NX');
		vi.useRealTimers();
	});
	it('initial per-user jitter prevents simultaneous prompts and forced periods use the blocking picker', async () => {
		vi.useFakeTimers();
		const start = new Date('2026-01-01T00:00:00Z');
		const jitter = createHash('sha256').update(`${id}:1`).digest().readUInt32BE(0) % (6 * 3600000 + 1);
		vi.spyOn(getInstanceConfigRepository(), 'getUsernameMigrationConfig').mockResolvedValue({
			state: 'selecting',
			epoch: 1,
			started_at: start.toISOString(),
			forced_at: '2026-01-08T00:00:00Z',
		});
		const kvSet = vi.spyOn(getKVClient(), 'set').mockResolvedValue('OK');
		const service = new UserAccountRequestService({} as never, {} as never, {} as never, {} as never, {} as never);
		const user = new User({...EMPTY_USER_ROW, user_id: id, username: 'legacy_name', discriminator: 1234});
		vi.setSystemTime(start.getTime() + jitter - 1);
		expect(await service.getUsernamePrompt(user)).toEqual({show: false, retry_after_ms: 1});
		expect(kvSet).not.toHaveBeenCalled();
		vi.setSystemTime(start.getTime() + jitter);
		expect(await service.getUsernamePrompt(user)).toEqual({show: true});
		vi.setSystemTime(new Date('2026-01-08T00:00:00Z'));
		expect(await service.getUsernamePrompt(user)).toEqual({show: false});
		vi.useRealTimers();
	});
	it.each(['held', 'banned', 'assigned', 'pending'])('bot %s claims reject without owner writes', async (state) => {
		const ownership = setupClaim(state);
		await expect(UniqueUsernames.assertBotUsernameAvailable(id, 'example_name')).rejects.toMatchObject({status: 409});
		expect(ownership.readClaimForAvailability).toHaveBeenCalledWith('example_name');
	});
});
