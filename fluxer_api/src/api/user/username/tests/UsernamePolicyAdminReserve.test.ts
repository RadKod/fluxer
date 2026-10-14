// SPDX-License-Identifier: AGPL-3.0-or-later

import {UserAdminController} from '@app/api/admin/controllers/UserAdminController';
import {AdminUserProfileService} from '@app/api/admin/services/AdminUserProfileService';
import {createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {executeQuery, setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import {EMPTY_USER_ROW} from '@app/api/database/types/UserTypes';
import {Users} from '@app/api/Tables';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import type {HonoEnv} from '@app/api/types/HonoEnv';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {FluxerError} from '@fluxer/errors/src/FluxerError';
import {Hono} from 'hono';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {UsernameOwnershipService} from '../UsernameOwnershipService';
import {FakeUsernamePolicyService} from './FakeUsernamePolicyService';

const migration = vi.hoisted(() => ({read: vi.fn()}));
const originalBackend = Config.database.backend;
afterEach(() => {
	Config.database.backend = originalBackend;
	setCassandraQueryExecutorForTesting(null);
});
vi.mock('@app/api/middleware/ServiceSingletons', () => ({
	getInstanceConfigRepository: () => ({readUsernameMigrationConfig: migration.read}),
}));
vi.mock('@app/api/middleware/RateLimitMiddleware', () => ({
	RateLimitMiddleware: () => async (_ctx: unknown, next: () => Promise<void>) => next(),
}));

function setup(
	acls: Array<string> = [AdminACLs.USERNAME_RESERVE, AdminACLs.USER_UPDATE_USERNAME],
	withOwnership = true,
	realOwnership?: UsernameOwnershipService,
) {
	const ownership = {
		adminHold: vi.fn().mockResolvedValue({ok: true, username: 'reserved', noop: false}),
		adminUnhold: vi.fn().mockResolvedValue(undefined),
		adminAssign: vi.fn().mockResolvedValue({ok: true, username: 'reserved', noop: false}),
		forceReselect: vi.fn().mockResolvedValue(undefined),
	};
	const auditService = {createAuditLog: vi.fn().mockResolvedValue(undefined)};
	const users = {
		findUnique: vi.fn().mockResolvedValue({id: createUserID(42n), isBot: false, flags: 0n, tempBannedUntil: null}),
		patchUpsert: vi.fn(),
	};
	const service = new AdminUserProfileService({
		apiContext: {services: {users}},
		discriminatorService: {},
		entityAssetService: {},
		auditService,
		updatePropagator: {},
		guildRepository: {},
		usernameOwnershipService: realOwnership ?? (withOwnership ? ownership : undefined),
	} as never);
	const app = new Hono<HonoEnv>();
	app.use('*', async (ctx, next) => {
		ctx.set('user', {id: createUserID(43n), acls: new Set([AdminACLs.AUTHENTICATE, ...acls])} as never);
		ctx.set('authTokenType', 'session');
		ctx.set('auditLogReason', ctx.req.header('X-Audit-Log-Reason') ?? null);
		ctx.set('adminService', {userService: {profileService: service}} as never);
		await next();
	});
	app.onError((error, ctx) =>
		error instanceof FluxerError ? error.getResponse() : ctx.json({error: error.message}, 500),
	);
	UserAdminController(app);
	const request = (path: string, body: unknown, reason: string | null = 'reserve reason', method = 'POST') =>
		app.request(path, {
			method,
			headers: {'Content-Type': 'application/json', ...(reason === null ? {} : {'X-Audit-Log-Reason': reason})},
			body: JSON.stringify(body),
		});
	return {ownership, auditService, users, service, request};
}

describe('username admin reservation API', () => {
	it.each(['/admin/usernames/assign', '/admin/users/42/username'])(
		'denies username-update-only actor before ownership assignment on %s',
		async (path) => {
			Config.database.backend = 'cassandra';
			setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor());
			const real = new UsernameOwnershipService({
				policy: new FakeUsernamePolicyService(),
				clock: async () => ({offsetMs: 0, uncertaintyMs: 0}),
				admit: async () => true,
				propagate: async () => {},
				neutralDiscriminator: async () => 1234,
			});
			await executeQuery(
				Users.upsertAll({...EMPTY_USER_ROW, user_id: createUserID(42n), username: 'legacy', discriminator: 1234}),
			);
			await real.adminHold('reserved', {adminId: createUserID(43n), reason: 'official', note: 'official'});
			const assignment = vi.spyOn(real, 'adminAssign');
			migration.read.mockResolvedValue({state: 'selecting'});
			const {request, auditService} = setup([AdminACLs.USER_UPDATE_USERNAME], true, real);
			const response = await request(
				path,
				{username: 'reserved', ...(path.endsWith('assign') ? {user_id: '42'} : {})},
				'assignment',
				path.endsWith('assign') ? 'POST' : 'PATCH',
			);
			expect(assignment).not.toHaveBeenCalled();
			expect(response.status).toBe(403);
			expect(auditService.createAuditLog).not.toHaveBeenCalled();
			expect((await real.repository.readClaim('reserved'))?.state).toBe('held');
			expect(await real.repository.readOwner(createUserID(42n))).toBeNull();
			setCassandraQueryExecutorForTesting(null);
		},
	);
	it.each(['everyone', 'here', 'EVERYONE'])(
		'prepares a reserved namespace name %s without permitting assignment',
		async (username) => {
			const {request, ownership} = setup();
			expect((await request('/admin/usernames/reserve', {username, note: 'official'})).status).toBe(200);
			expect(ownership.adminHold).toHaveBeenCalledWith(
				username.toLowerCase(),
				expect.objectContaining({adminId: createUserID(43n)}),
			);
			expect((await request('/admin/usernames/unreserve', {username})).status).toBe(204);
			expect(ownership.adminUnhold).toHaveBeenCalledWith(
				username.toLowerCase(),
				expect.objectContaining({adminId: createUserID(43n)}),
			);
			expect((await request('/admin/usernames/assign', {username, user_id: '42'})).status).toBe(400);
			expect(ownership.adminAssign).not.toHaveBeenCalled();
		},
	);
	it.each(['/admin/usernames/reserve', '/admin/usernames/unreserve'])(
		'rejects an injected target for reserved namespace names on %s',
		async (path) => {
			const {request, ownership} = setup();
			expect((await request(path, {username: 'everyone', user_id: '42'})).status).toBe(400);
			expect(ownership.adminHold).not.toHaveBeenCalled();
			expect(ownership.adminUnhold).not.toHaveBeenCalled();
		},
	);
	beforeEach(() => {
		vi.clearAllMocks();
		migration.read.mockReset().mockResolvedValue({state: 'selecting'});
	});
	it('holds through the exact ownership contract and audits the required reason', async () => {
		const {request, ownership, auditService} = setup();
		const response = await request('/admin/usernames/reserve', {username: 'reserved', note: 'official'});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ok: true, username: 'reserved', noop: false});
		expect(ownership.adminHold).toHaveBeenCalledWith('reserved', {
			adminId: createUserID(43n),
			reason: 'reserve reason',
			note: 'official',
		});
		expect(auditService.createAuditLog).toHaveBeenCalledWith(
			expect.objectContaining({action: 'reserve_username', auditLogReason: 'reserve reason', targetType: 'username'}),
		);
	});
	it('unholds through the exact ownership contract', async () => {
		const {request, ownership, auditService} = setup();
		expect((await request('/admin/usernames/unreserve', {username: 'reserved'})).status).toBe(204);
		expect(ownership.adminUnhold).toHaveBeenCalledWith('reserved', {
			adminId: createUserID(43n),
			reason: 'reserve reason',
		});
		expect(auditService.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({action: 'unreserve_username'}));
	});
	it('assigns a body target only after both ACLs and audits the target', async () => {
		const {request, ownership, auditService, users} = setup();
		expect((await request('/admin/usernames/assign', {username: 'reserved', user_id: '42'})).status).toBe(200);
		expect(ownership.adminAssign).toHaveBeenCalledWith('reserved', createUserID(42n), {
			adminId: createUserID(43n),
			reason: 'reserve reason',
		});
		expect(users.patchUpsert).not.toHaveBeenCalled();
		expect(auditService.createAuditLog).toHaveBeenCalledWith(
			expect.objectContaining({action: 'assign_username', targetId: 42n}),
		);
	});
	it.each([AdminACLs.USERNAME_RESERVE, AdminACLs.USER_UPDATE_USERNAME])(
		'rejects assign when only %s is granted',
		async (acl) => {
			const {request, ownership, auditService} = setup([acl]);
			expect((await request('/admin/usernames/assign', {username: 'reserved', user_id: '42'})).status).toBe(403);
			expect(ownership.adminAssign).not.toHaveBeenCalled();
			expect(auditService.createAuditLog).not.toHaveBeenCalled();
		},
	);
	it.each(['/admin/usernames/reserve', '/admin/usernames/unreserve'])('requires reserve ACL for %s', async (path) => {
		const {request, ownership} = setup([AdminACLs.USER_UPDATE_USERNAME]);
		expect((await request(path, {username: 'reserved'})).status).toBe(403);
		expect(ownership.adminHold).not.toHaveBeenCalled();
		expect(ownership.adminUnhold).not.toHaveBeenCalled();
	});
	it.each([
		'/admin/usernames/reserve',
		'/admin/usernames/unreserve',
		'/admin/usernames/assign',
		'/admin/users/42/username/reselect',
	])('requires a nonempty reason before mutation for %s', async (path) => {
		const {request, ownership, auditService} = setup();
		const body = path.endsWith('reselect')
			? {ban_name: true}
			: path.endsWith('assign')
				? {username: 'reserved', user_id: '42'}
				: {username: 'reserved'};
		expect((await request(path, body, '  ')).status).toBe(400);
		for (const mutation of Object.values(ownership)) expect(mutation).not.toHaveBeenCalled();
		expect(auditService.createAuditLog).not.toHaveBeenCalled();
	});
	it('forces reselect synchronously with the exact target and ban flag', async () => {
		const {request, ownership, auditService} = setup();
		expect((await request('/admin/users/42/username/reselect', {ban_name: true})).status).toBe(204);
		expect(ownership.forceReselect).toHaveBeenCalledWith(createUserID(42n), true, {
			adminId: createUserID(43n),
			reason: 'reserve reason',
		});
		expect(auditService.createAuditLog).toHaveBeenCalledWith(
			expect.objectContaining({action: 'force_username_reselect', targetId: 42n}),
		);
	});
	it('requires username update ACL for reselect', async () => {
		const {request, ownership} = setup([AdminACLs.USERNAME_RESERVE]);
		expect((await request('/admin/users/42/username/reselect', {ban_name: true})).status).toBe(403);
		expect(ownership.forceReselect).not.toHaveBeenCalled();
	});
	it('rejects synthetic body targets before calling ownership', async () => {
		const {request, ownership} = setup();
		expect((await request('/admin/usernames/assign', {username: 'reserved', user_id: '0'})).status).toBe(404);
		expect(ownership.adminAssign).not.toHaveBeenCalled();
	});
	it('preserves the ownership conflict code and retry time without success audit', async () => {
		const {request, ownership, auditService} = setup();
		ownership.adminAssign.mockResolvedValue({
			ok: false,
			code: 'RELEASE_EMBARGO',
			availableAt: new Date('2026-11-01T00:00:00Z'),
		});
		const response = await request('/admin/usernames/assign', {username: 'reserved', user_id: '42'});
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			code: 'USERNAME_RELEASE_EMBARGO',
			available_at: '2026-11-01T00:00:00.000Z',
		});
		expect(auditService.createAuditLog).not.toHaveBeenCalled();
	});
	it('does not audit a failed synchronous reselect', async () => {
		const {request, ownership, auditService} = setup();
		ownership.forceReselect.mockRejectedValue(new Error('finalize failed'));
		expect((await request('/admin/users/42/username/reselect', {ban_name: false})).status).toBe(500);
		expect(auditService.createAuditLog).not.toHaveBeenCalled();
	});
	it('rejects reselect during preparation before ownership or audit', async () => {
		const {request, ownership, auditService} = setup();
		migration.read.mockResolvedValue({state: 'preparing'});
		const response = await request('/admin/users/42/username/reselect', {ban_name: true});
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({code: 'USERNAME_UNAVAILABLE'});
		expect(migration.read).toHaveBeenCalledOnce();
		expect(ownership.forceReselect).not.toHaveBeenCalled();
		expect(auditService.createAuditLog).not.toHaveBeenCalled();
	});
	it('fails closed on an unavailable authoritative migration read before reselect', async () => {
		const {request, ownership, auditService} = setup();
		migration.read.mockRejectedValue(new Error('SERIAL read unavailable'));
		const response = await request('/admin/users/42/username/reselect', {ban_name: false});
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({code: 'USERNAME_UNAVAILABLE'});
		expect(ownership.forceReselect).not.toHaveBeenCalled();
		expect(auditService.createAuditLog).not.toHaveBeenCalled();
	});
	it('keeps reselect open during selecting', async () => {
		const {request, ownership, auditService} = setup();
		migration.read.mockResolvedValue({state: 'selecting'});
		expect((await request('/admin/users/42/username/reselect', {ban_name: true})).status).toBe(204);
		expect(ownership.forceReselect).toHaveBeenCalledOnce();
		expect(auditService.createAuditLog).toHaveBeenCalledOnce();
	});
	it.each([null, new Date(Date.now() + 86400000)])(
		'does not force a suspended account with expiry %s',
		async (tempBannedUntil) => {
			const {request, ownership, users, auditService} = setup();
			users.findUnique.mockResolvedValue({
				id: createUserID(42n),
				isBot: false,
				flags: UserFlags.DISABLED,
				tempBannedUntil,
			});
			const response = await request('/admin/users/42/username/reselect', {ban_name: true});
			expect(response.status).toBe(503);
			expect(await response.json()).toMatchObject({code: 'USERNAME_UNAVAILABLE'});
			expect(ownership.forceReselect).not.toHaveBeenCalled();
			expect(auditService.createAuditLog).not.toHaveBeenCalled();
		},
	);
	it('allows force reselect after the temporary suspension expires', async () => {
		const {request, ownership, users} = setup();
		users.findUnique.mockResolvedValue({
			id: createUserID(42n),
			isBot: false,
			flags: UserFlags.DISABLED,
			tempBannedUntil: new Date(Date.now() - 86400000),
		});
		expect((await request('/admin/users/42/username/reselect', {ban_name: true})).status).toBe(204);
		expect(ownership.forceReselect).toHaveBeenCalledOnce();
	});
	it('fails closed when no ownership adapter has been registered', async () => {
		const {request, ownership, auditService} = setup(undefined, false);
		const response = await request('/admin/usernames/reserve', {username: 'reserved'});
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({code: 'USERNAME_UNAVAILABLE'});
		expect(ownership.adminHold).not.toHaveBeenCalled();
		expect(auditService.createAuditLog).not.toHaveBeenCalled();
	});
	it.each([{isBot: true}, {isSystem: true}])('rejects nonhuman ownership targets %j', async (target) => {
		const {request, users, ownership, auditService} = setup();
		users.findUnique.mockResolvedValue({id: createUserID(42n), isBot: false, ...target});
		expect((await request('/admin/usernames/assign', {username: 'reserved', user_id: '42'})).status).toBe(
			target.isBot ? 400 : 404,
		);
		expect(ownership.adminAssign).not.toHaveBeenCalled();
		expect(auditService.createAuditLog).not.toHaveBeenCalled();
	});
	it('rejects a nonexistent assignment target before ownership is called', async () => {
		const {request, users, ownership} = setup();
		users.findUnique.mockResolvedValue(null);
		expect((await request('/admin/usernames/assign', {username: 'reserved', user_id: '42'})).status).toBe(404);
		expect(ownership.adminAssign).not.toHaveBeenCalled();
	});
});
