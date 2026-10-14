// SPDX-License-Identifier: AGPL-3.0-or-later

import {AdminUserProfileService} from '@app/api/admin/services/AdminUserProfileService';
import {createUserID} from '@app/api/BrandedTypes';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({
	migration: 'preparing' as 'legacy' | 'preparing' | 'selecting',
	unique: false,
	policy: vi.fn(),
	cached: vi.fn(),
	check: vi.fn(),
	reserve: vi.fn(),
	claim: vi.fn(),
	entitlement: vi.fn(),
}));
vi.mock('@app/api/middleware/ServiceRegistry', () => ({
	getUsernameOwnershipService: () => ({
		repository: {readEntitlement: state.entitlement},
		readClaimForAvailability: state.claim,
	}),
}));
vi.mock('@app/api/user/username/UsernamePolicyService', () => ({
	UsernamePolicyService: class {
		readAuthoritative = state.policy;
		readCached = state.cached;
		check = state.check;
	},
}));
vi.mock('@app/api/user/UniqueUsernames', async (importOriginal) => ({
	...(await importOriginal<object>()),
	reserveUsername: state.reserve,
}));
vi.mock('@app/api/middleware/ServiceSingletons', () => ({
	getInstanceConfigRepository: () => ({
		readUsernameMigrationConfig: async () => ({state: state.migration, epoch: 1, started_at: null, forced_at: null}),
		usesUniqueUsernames: async () => state.unique,
	}),
}));
vi.mock('@app/api/user/services/PartialUserChangePropagation', () => ({propagateUserUpdate: vi.fn()}));
vi.mock('@app/api/admin/models/UserTypes', () => ({mapUserToAdminResponse: async (user: unknown) => user}));

function setup(isBot = false, ownership?: {adminAssign: ReturnType<typeof vi.fn>}) {
	const user = {id: createUserID(1n), username: 'before', discriminator: 1234, isBot, toRow: () => ({})};
	const updated = {...user, username: 'after'};
	const users = {
		findUnique: vi.fn().mockResolvedValue(user),
		patchUpsert: vi.fn().mockResolvedValue(updated),
		getUserGuildIds: vi.fn().mockResolvedValue([]),
	};
	const auditService = {createAuditLog: vi.fn().mockResolvedValue(undefined)};
	const discriminatorService = {
		generateDiscriminator: vi.fn().mockResolvedValue({discriminator: 1234, available: true}),
	};
	const recordDiff = vi.fn().mockResolvedValue(undefined);
	const service = new AdminUserProfileService({
		apiContext: {services: {users, cache: {}, contactChangeLog: {recordDiff}}},
		discriminatorService,
		auditService,
		userUpdateDeps: {},
		entityAssetService: {},
		guildRepository: {},
		usernameOwnershipService: ownership,
	} as never);
	return {service, users, discriminatorService, auditService, recordDiff, user};
}

describe('admin username migration writer guard', () => {
	beforeEach(() => {
		state.migration = 'preparing';
		state.unique = false;
		state.policy.mockReset().mockResolvedValue({dictionary: {gen: 0}});
		state.cached
			.mockReset()
			.mockImplementation(async () => ({migration: {state: state.migration}, dictionary: {gen: 0}}));
		state.check.mockReset().mockReturnValue(null);
		state.reserve.mockReset().mockResolvedValue({release: vi.fn()});
		state.claim.mockReset().mockResolvedValue(null);
		state.entitlement.mockReset().mockResolvedValue(null);
	});
	it.each([
		['held', 'USERNAME_RESERVED'],
		['banned', 'USERNAME_BLOCKED'],
		['assigned', 'USERNAME_TAKEN'],
	] as const)('rejects a bot admin rename conflicting with a %s claim', async (claimState, code) => {
		const {service, users, discriminatorService, auditService} = setup(true);
		state.claim.mockResolvedValue({state: claimState});
		await expect(
			service.changeUsername({user_id: 1n, username: 'after'}, createUserID(2n), 'rename', new Set()),
		).rejects.toMatchObject({code});
		expect(state.claim).toHaveBeenCalledWith('after');
		expect(users.patchUpsert).not.toHaveBeenCalled();
		expect(discriminatorService.generateDiscriminator).not.toHaveBeenCalled();
		expect(auditService.createAuditLog).not.toHaveBeenCalled();
	});
	it('keeps the short-name entitlement requirement for admin-renamed bots', async () => {
		const actual = await vi.importActual<typeof import('@app/api/user/username/UsernamePolicyService')>(
			'@app/api/user/username/UsernamePolicyService',
		);
		state.policy.mockResolvedValue({
			dictionary: actual.compileUsernameDictionary(1, {uname_exact: [], uname_contains: [], uname_allow: []}),
			tiers: {1: 'locked', 2: 'locked', 3: 'locked'},
		});
		state.check.mockImplementation(actual.UsernamePolicyService.prototype.check);
		const {service, users} = setup(true);
		await expect(
			service.changeUsername({user_id: 1n, username: 'abc'}, createUserID(2n), 'rename', new Set()),
		).rejects.toMatchObject({code: 'USERNAME_REQUIRES_ENTITLEMENT'});
		expect(users.patchUpsert).not.toHaveBeenCalled();
		state.entitlement.mockResolvedValue({username: 'abc', revoked_at: null});
		await service.changeUsername({user_id: 1n, username: 'abc'}, createUserID(2n), 'rename', new Set());
		expect(state.claim).toHaveBeenCalledWith('abc');
		expect(users.patchUpsert).toHaveBeenCalledOnce();
	});
	it('retains a nonzero legacy discriminator on a tagless instance', async () => {
		state.migration = 'legacy';
		state.unique = true;
		const {service, users, user, discriminatorService} = setup();
		await service.changeUsername({user_id: 1n, username: 'after'}, createUserID(2n), 'rename', new Set());
		expect(users.patchUpsert).toHaveBeenCalledWith(
			user.id,
			{username: 'after', discriminator: 1234},
			user.toRow(),
			expect.any(Number),
		);
		expect(discriminatorService.generateDiscriminator).not.toHaveBeenCalled();
	});
	it('passes the original deadline after a slow lookup rather than extending it', async () => {
		state.migration = 'legacy';
		const {service, users, user} = setup();
		let now = 100000;
		const time = vi.spyOn(Date, 'now').mockImplementation(() => now);
		users.findUnique.mockImplementation(async () => {
			now += 31000;
			return user;
		});
		users.patchUpsert.mockImplementation(async (_id, _patch, _old, deadlineAt) => {
			if (deadlineAt <= now) throw new Error('deadline expired');
			return user;
		});
		try {
			await expect(
				service.changeUsername({user_id: 1n, username: 'after'}, createUserID(2n), 'rename', new Set()),
			).rejects.toThrow('deadline expired');
			expect(users.patchUpsert.mock.calls[0][3]).toBe(130000);
		} finally {
			time.mockRestore();
		}
	});
	it.each([false, true])('rejects a published blocked name before any legacy writer (bot=%s)', async (bot) => {
		state.migration = 'legacy';
		state.check.mockReturnValue('BLOCKED');
		const {service, users} = setup(bot);
		await expect(
			service.changeUsername({user_id: 1n, username: 'after'}, createUserID(2n), 'rename', new Set()),
		).rejects.toMatchObject({code: 'USERNAME_BLOCKED'});
		expect(users.patchUpsert).not.toHaveBeenCalled();
	});
	it('writes human legacy identity with a fixed deadline established before lookup', async () => {
		state.migration = 'legacy';
		const {service, users, user} = setup();
		const now = Date.now();
		await service.changeUsername({user_id: 1n, username: 'after'}, createUserID(2n), 'rename', new Set());
		expect(users.patchUpsert).toHaveBeenCalledWith(
			user.id,
			{username: 'after', discriminator: 1234},
			user.toRow(),
			expect.any(Number),
		);
		expect(users.patchUpsert.mock.calls[0][3]).toBeGreaterThanOrEqual(now);
		expect(users.patchUpsert.mock.calls[0][3]).toBeLessThanOrEqual(now + 30000);
	});
	it.each(['preparing', 'selecting'] as const)(
		'blocks legacy human identity writes in %s without an ownership service',
		async (migration) => {
			state.migration = migration;
			const {service, users, discriminatorService} = setup();
			await expect(
				service.changeUsername({user_id: 1n, username: 'after'}, createUserID(2n), 'rename', new Set()),
			).rejects.toThrow();
			expect(users.patchUpsert).not.toHaveBeenCalled();
			expect(discriminatorService.generateDiscriminator).not.toHaveBeenCalled();
		},
	);
	it('routes selecting assignment through the exact owner protocol and preserves audit', async () => {
		state.migration = 'selecting';
		const adminAssign = vi.fn().mockResolvedValue({ok: true, username: 'after', noop: false});
		const {service, users, auditService} = setup(false, {adminAssign});
		await service.changeUsername(
			{user_id: 1n, username: 'after'},
			createUserID(2n),
			'rename',
			new Set([AdminACLs.USERNAME_RESERVE, AdminACLs.USER_UPDATE_USERNAME]),
		);
		expect(adminAssign).toHaveBeenCalledWith('after', createUserID(1n), {adminId: createUserID(2n), reason: 'rename'});
		expect(users.patchUpsert).not.toHaveBeenCalled();
		expect(auditService.createAuditLog).toHaveBeenCalledWith(
			expect.objectContaining({action: 'change_username', auditLogReason: 'rename'}),
		);
	});
	it('keeps the tagged bot rename path', async () => {
		const {service, users, discriminatorService} = setup(true);
		await service.changeUsername({user_id: 1n, username: 'after'}, createUserID(2n), 'bot rename', new Set());
		expect(users.patchUpsert).toHaveBeenCalled();
		expect(discriminatorService.generateDiscriminator).toHaveBeenCalled();
	});
	it('does not fall back to a legacy write when ownership rejects preparing allocation', async () => {
		const adminAssign = vi.fn().mockResolvedValue({ok: false, code: 'UNAVAILABLE'});
		const {service, users} = setup(false, {adminAssign});
		await expect(
			service.changeUsername(
				{user_id: 1n, username: 'after'},
				createUserID(2n),
				'rename',
				new Set([AdminACLs.USERNAME_RESERVE, AdminACLs.USER_UPDATE_USERNAME]),
			),
		).rejects.toThrow();
		expect(adminAssign).toHaveBeenCalledOnce();
		expect(users.patchUpsert).not.toHaveBeenCalled();
	});
});
