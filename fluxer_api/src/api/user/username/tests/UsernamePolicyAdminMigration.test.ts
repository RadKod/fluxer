// SPDX-License-Identifier: AGPL-3.0-or-later

import {InstanceConfigAdminController} from '@app/api/admin/controllers/InstanceConfigAdminController';
import {createUserID} from '@app/api/BrandedTypes';
import type {HonoEnv} from '@app/api/types/HonoEnv';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {FluxerError} from '@fluxer/errors/src/FluxerError';
import {Hono} from 'hono';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
	prepare: vi.fn(),
	start: vi.fn(),
	rollback: vi.fn(),
	readiness: vi.fn(),
	policy: vi.fn(),
	declaration: vi.fn(),
	audit: vi.fn(),
}));
vi.mock('@app/api/middleware/ServiceSingletons', () => ({
	getInstanceConfigRepository: () => ({
		prepareUsernameMigration: mocks.prepare,
		startUsernameMigration: mocks.start,
		rollbackUsernameMigration: mocks.rollback,
		setUsernameMigrationGuildCapacity: mocks.declaration,
	}),
}));
vi.mock('@app/api/middleware/ServiceRegistry', () => ({readUsernameMigrationPreconditions: mocks.readiness}));
vi.mock('@app/api/user/username/UsernamePolicyService', () => ({
	UsernamePolicyService: class {
		readAuthoritative = mocks.policy;
	},
}));
vi.mock('@app/api/middleware/RateLimitMiddleware', () => ({
	RateLimitMiddleware: () => async (_ctx: unknown, next: () => Promise<void>) => next(),
}));

function setup(acls = [AdminACLs.USERNAME_MIGRATION_START] as Array<string>) {
	const app = new Hono<HonoEnv>();
	app.use('*', async (ctx, next) => {
		ctx.set('user', {id: createUserID(43n), acls: new Set([AdminACLs.AUTHENTICATE, ...acls])} as never);
		ctx.set('authTokenType', 'session');
		ctx.set('auditLogReason', ctx.req.header('X-Audit-Log-Reason') ?? null);
		ctx.set('adminService', {auditService: {createAuditLog: mocks.audit}} as never);
		await next();
	});
	app.onError((error, ctx) =>
		error instanceof FluxerError ? error.getResponse() : ctx.json({error: error.message}, 500),
	);
	InstanceConfigAdminController(app);
	return (action: string, body: unknown, reason: string | null = 'migration reason') =>
		app.request(`/admin/instance/username-migration/${action}`, {
			method: 'POST',
			headers: {'Content-Type': 'application/json', ...(reason === null ? {} : {'X-Audit-Log-Reason': reason})},
			body: JSON.stringify(body),
		});
}

describe('username migration admin API', () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.prepare.mockResolvedValue({
			state: 'preparing',
			epoch: 1,
			preparing_at: '2026-10-09T00:00:00.000Z',
			started_at: null,
			forced_at: null,
		});
		mocks.start.mockResolvedValue({
			state: 'selecting',
			epoch: 1,
			preparing_at: '2026-10-09T00:00:00.000Z',
			started_at: '2026-10-09T01:00:00.000Z',
			forced_at: '2026-10-16T01:00:00.000Z',
		});
		mocks.rollback.mockResolvedValue({
			state: 'legacy',
			epoch: 1,
			preparing_at: null,
			started_at: null,
			forced_at: null,
		});
		mocks.readiness.mockResolvedValue({holdsReady: true, capacityReady: true, reserveVersion: 3});
		mocks.policy.mockResolvedValue({dictionary: {gen: 2, manifest: {hash: 'a'.repeat(64)}}});
		mocks.audit.mockResolvedValue(undefined);
		mocks.declaration.mockResolvedValue(undefined);
	});
	const start = () => ({
		epoch: 1,
		mobile_published: true,
		mobile_version: '1.2.3',
		guild_capacity: {
			max_guild_members: 100,
			max_guild_online: 10,
			source: 'activity report',
			observed_at: new Date().toISOString(),
		},
	});
	it.each([
		{max_guild_online: 101},
		{max_guild_members: -1},
		{source: ' '},
		{observed_at: new Date(Date.now() - 3_600_000).toISOString()},
		{observed_at: new Date(Date.now() + 3_600_000).toISOString()},
	])('rejects stale or impossible guild declaration %j before persistence', async (patch) => {
		const body = start();
		expect((await setup()('start', {...body, guild_capacity: {...body.guild_capacity, ...patch}})).status).toBe(400);
		expect(mocks.declaration).not.toHaveBeenCalled();
		expect(mocks.start).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});
	it('prepares only with the required process acknowledgement and audits it', async () => {
		const response = await setup()('prepare', {processes_ready: true});
		expect(response.status).toBe(200);
		expect(mocks.prepare).toHaveBeenCalledWith({processesReady: true});
		expect(mocks.audit).toHaveBeenCalledWith(
			expect.objectContaining({
				action: 'prepare_username_migration',
				auditLogReason: 'migration reason',
				metadata: expect.any(Map),
			}),
		);
		expect(mocks.audit.mock.calls[0][0].metadata.get('processes_ready')).toBe('true');
	});
	it('starts with server proofs and records the both-store mobile version acknowledgement', async () => {
		expect((await setup()('start', start())).status).toBe(200);
		expect(mocks.start).toHaveBeenCalledWith(1, {
			dictionaryGen: 2,
			dictionaryHash: 'a'.repeat(64),
			holdsReady: true,
			capacityReady: true,
			reserveVersion: 3,
			mobilePublished: true,
		});
		expect(mocks.audit.mock.calls[1][0]).toMatchObject({
			action: 'start_username_migration',
			auditLogReason: 'migration reason',
		});
		expect(mocks.audit.mock.calls[1][0].metadata.get('mobile_version')).toBe('1.2.3');
		expect(mocks.audit.mock.calls[1][0].metadata.get('mobile_published')).toBe('true');
		expect(mocks.audit.mock.calls[0][0].metadata.get('source')).toBe('activity report');
	});
	it('rolls back only through the repository epoch CAS and audits success', async () => {
		expect((await setup()('rollback', {epoch: 1})).status).toBe(200);
		expect(mocks.rollback).toHaveBeenCalledWith(1);
		expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({action: 'rollback_username_migration'}));
	});
	it.each(['prepare', 'start', 'rollback'])('requires the specific ACL for %s', async (action) => {
		expect(
			(
				await setup([AdminACLs.INSTANCE_CONFIG_UPDATE])(
					action,
					action === 'prepare' ? {processes_ready: true} : start(),
				)
			).status,
		).toBe(403);
		expect(mocks.prepare).not.toHaveBeenCalled();
		expect(mocks.start).not.toHaveBeenCalled();
		expect(mocks.rollback).not.toHaveBeenCalled();
	});
	it.each(['prepare', 'start', 'rollback'])('requires a reason before any mutation for %s', async (action) => {
		expect(
			(
				await setup()(
					action,
					action === 'prepare' ? {processes_ready: true} : action === 'rollback' ? {epoch: 1} : start(),
					' ',
				)
			).status,
		).toBe(400);
		expect(mocks.prepare).not.toHaveBeenCalled();
		expect(mocks.start).not.toHaveBeenCalled();
		expect(mocks.rollback).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});
	it.each([
		{mobile_published: false},
		{mobile_version: ' '},
		{holds_ready: true},
		{capacity_ready: true},
		{min_client_version: '1'},
	])('rejects missing acknowledgement or spoofed proof %j', async (patch) => {
		expect((await setup()('start', {...start(), ...patch})).status).toBe(400);
		expect(mocks.start).not.toHaveBeenCalled();
		expect(mocks.readiness).not.toHaveBeenCalled();
	});
	it('fails closed without a server prerequisite provider', async () => {
		mocks.readiness.mockRejectedValue(new Error('No provider'));
		expect((await setup()('start', start())).status).toBe(503);
		expect(mocks.start).not.toHaveBeenCalled();
		expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({action: 'declare_username_migration_capacity'}));
	});
	it('fails closed when the dictionary generation cannot be verified', async () => {
		mocks.policy.mockRejectedValue(new Error('hash mismatch'));
		expect((await setup()('start', start())).status).toBe(503);
		expect(mocks.start).not.toHaveBeenCalled();
		expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({action: 'declare_username_migration_capacity'}));
	});
	it('does not audit a rejected irreversible transition', async () => {
		mocks.start.mockRejectedValue(new Error('scan incomplete'));
		expect((await setup()('start', start())).status).toBe(500);
		expect(mocks.audit.mock.calls.map(([entry]) => entry.action)).toEqual(['declare_username_migration_capacity']);
	});
});
