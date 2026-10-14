// SPDX-License-Identifier: AGPL-3.0-or-later

import {InstanceConfigAdminController} from '@app/api/admin/controllers/InstanceConfigAdminController';
import {UserAdminController} from '@app/api/admin/controllers/UserAdminController';
import {createUserID} from '@app/api/BrandedTypes';
import type {HonoEnv} from '@app/api/types/HonoEnv';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {FluxerError} from '@fluxer/errors/src/FluxerError';
import {UsernameMigrationInspectionResponse} from '@fluxer/schema/src/domains/admin/UsernameSchemas';
import {Hono} from 'hono';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({runtime: vi.fn(), scan: vi.fn(), migration: vi.fn(), list: vi.fn(), audit: vi.fn()}));
vi.mock('@app/api/middleware/ServiceSingletons', () => ({
	getInstanceConfigRepository: () => ({
		readUsernameMigrationScan: mocks.scan,
		readUsernameMigrationConfig: mocks.migration,
	}),
}));
vi.mock('@app/api/worker/tasks/UsernameMigrationEvidence', () => ({readUsernameMigrationStartEvidence: mocks.runtime}));
vi.mock('@app/api/middleware/RateLimitMiddleware', () => ({
	RateLimitMiddleware: () => async (_ctx: unknown, next: () => Promise<void>) => next(),
}));

function setup(
	acls: Array<string>,
	tokenType: 'session' | 'admin_api_key' | 'bearer' = 'session',
	keyAcls: Array<string> = [],
) {
	const app = new Hono<HonoEnv>();
	app.use('*', async (ctx, next) => {
		ctx.set('user', {id: createUserID(43n), acls: new Set([AdminACLs.AUTHENTICATE, ...acls])} as never);
		ctx.set('authTokenType', tokenType);
		ctx.set('adminApiKeyAcls', new Set(keyAcls));
		ctx.set('adminService', {
			auditService: {createAuditLog: mocks.audit},
			userService: {profileService: {listUsernameReservations: mocks.list}},
		} as never);
		await next();
	});
	app.onError((error, ctx) =>
		error instanceof FluxerError ? error.getResponse() : ctx.json({error: error.message}, 500),
	);
	InstanceConfigAdminController(app);
	UserAdminController(app);
	return (path: string) => app.request(path);
}

describe('username admin bounded read routes', () => {
	beforeEach(() => {
		vi.resetAllMocks();
		const migration = {
			state: 'preparing',
			epoch: 7,
			preparing_at: '2026-10-09T00:00:00Z',
			started_at: null,
			forced_at: null,
		};
		mocks.runtime.mockResolvedValue({
			migration,
			holds: {required: null, ready: false, proof: null},
			capacity: {available: false, ready: false, proof: null},
		});
		mocks.migration.mockResolvedValue(migration);
		mocks.scan.mockResolvedValue({epoch: 7, scanned: 9, found: 0, done_at: null, cursor: null});
		mocks.list.mockResolvedValue({bucket: 0, items: [], next_cursor: null});
	});
	it('reads epoch-bound scan and unavailable capacity without a reason and audits the read', async () => {
		const response = await setup([AdminACLs.USERNAME_MIGRATION_START])('/admin/instance/username-migration');
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			migration: {epoch: 7},
			scan: {epoch: 7, scanned: 9},
			holds: {required: null, ready: false},
			capacity: {available: false, ready: false, proof: null},
		});
		expect(mocks.audit).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				action: 'get_username_migration',
				targetType: 'username_migration',
				targetId: 0n,
				metadata: new Map([
					['epoch', '7'],
					['state', 'preparing'],
				]),
			}),
		);
	});
	it('hides a scan from another migration epoch', async () => {
		mocks.scan.mockResolvedValue({epoch: 6, scanned: 9, found: 0, done_at: '2026-10-09T01:00:00Z'});
		const response = await setup([AdminACLs.USERNAME_MIGRATION_START])('/admin/instance/username-migration');
		expect(UsernameMigrationInspectionResponse.parse(await response.json()).scan).toBeNull();
	});
	it('shows the start declaration while an unknown required hold count stays unready', async () => {
		const runtime = await mocks.runtime();
		const guild_capacity = {
			epoch: 7,
			admin_id: '43',
			max_guild_members: 100,
			max_guild_online: 10,
			source: 'activity report',
			observed_at: new Date().toISOString(),
		};
		mocks.runtime.mockResolvedValue({
			...runtime,
			capacity: {
				available: true,
				ready: true,
				proof: {epoch: 7, policy_revision: 9, total_accounts: 9, guild_capacity, holds: null},
			},
		});
		const response = await setup([AdminACLs.USERNAME_MIGRATION_START])('/admin/instance/username-migration');
		expect(response.status).toBe(200);
		const body = (await response.json()) as {capacity: object};
		expect(body).toMatchObject({
			holds: {required: null, ready: false},
			capacity: {available: true, ready: true, proof: {guild_capacity}},
		});
		expect(body.capacity).not.toHaveProperty('measurements_ready');
		expect(mocks.audit).toHaveBeenCalledTimes(1);
	});
	it('fails closed if the epoch changes while reading evidence', async () => {
		mocks.migration.mockResolvedValue({state: 'preparing', epoch: 8});
		expect((await setup([AdminACLs.USERNAME_MIGRATION_START])('/admin/instance/username-migration')).status).toBe(503);
		expect(mocks.audit).not.toHaveBeenCalled();
	});
	it.each([
		['/admin/instance/username-migration', AdminACLs.USERNAME_RESERVE],
		['/admin/usernames/reservations?bucket=0', AdminACLs.USERNAME_MIGRATION_START],
	])('rejects another permission before revealing %s', async (path, acl) => {
		expect((await setup([acl])(path)).status).toBe(403);
		expect(mocks.runtime).not.toHaveBeenCalled();
		expect(mocks.scan).not.toHaveBeenCalled();
		expect(mocks.list).not.toHaveBeenCalled();
	});
	it('reads one bounded reservation page and audits it without the names', async () => {
		const response = await setup([AdminACLs.USERNAME_RESERVE])('/admin/usernames/reservations?bucket=0&limit=2');
		expect(response.status).toBe(200);
		expect(mocks.list).toHaveBeenCalledWith(0, null, 2);
		expect(mocks.audit).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				action: 'list_username_reservations',
				targetType: 'username',
				targetId: 0n,
				metadata: new Map([
					['bucket', '0'],
					['result_count', '0'],
					['has_more', 'false'],
				]),
			}),
		);
	});
	it.each([
		['/admin/instance/username-migration', AdminACLs.USERNAME_MIGRATION_START],
		['/admin/usernames/reservations?bucket=0', AdminACLs.USERNAME_RESERVE],
	])('requires both the API key and its owner permission for %s', async (path, acl) => {
		expect((await setup([acl], 'admin_api_key', [])(path)).status).toBe(403);
		expect((await setup([], 'admin_api_key', [acl])(path)).status).toBe(403);
		expect(mocks.runtime).not.toHaveBeenCalled();
		expect(mocks.list).not.toHaveBeenCalled();
	});
	it('does not reveal reservations to an external OAuth bearer despite the user ACL', async () => {
		expect((await setup([AdminACLs.USERNAME_RESERVE], 'bearer')('/admin/usernames/reservations?bucket=0')).status).toBe(
			403,
		);
		expect(mocks.list).not.toHaveBeenCalled();
	});
	it.each([
		'bucket=-1',
		'bucket=1024',
		'bucket=0&limit=101',
		'bucket=0&limit=0',
		'bucket=0&cursor=UPPER',
		'bucket=0&cursor=reserved',
		'bucket=0&user_id=99',
	])('rejects malformed bounds, bucket cursor or target spoofing %s', async (query) => {
		expect((await setup([AdminACLs.USERNAME_RESERVE])(`/admin/usernames/reservations?${query}`)).status).toBe(400);
		expect(mocks.list).not.toHaveBeenCalled();
	});
});
