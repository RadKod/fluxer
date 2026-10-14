// SPDX-License-Identifier: AGPL-3.0-or-later

import {readUsernameMigrationStartEvidence} from '@app/api/worker/tasks/UsernameMigrationEvidence';
import {
	UsernameMigrationStartRequest,
	UsernamePolicyResponse,
	UsernamePolicyUpdateRequest,
} from '@fluxer/schema/src/domains/admin/UsernameSchemas';
import {describe, expect, it, vi} from 'vitest';
import {z} from 'zod';

const declaration = () => ({
	epoch: 2,
	admin_id: '43',
	max_guild_members: 100,
	max_guild_online: 10,
	source: 'activity report',
	observed_at: new Date().toISOString(),
});

function setup() {
	const policy = {revision: 7, held_manifest: ['admin', 'micup'], admission: {global_per_second: 100}};
	const config = {
		readUsernameMigrationConfig: vi.fn().mockResolvedValue({state: 'preparing', epoch: 2}),
		readUsernamePolicyConfig: vi.fn().mockImplementation(async () => policy),
		readUsernameMigrationScan: vi
			.fn()
			.mockResolvedValue({epoch: 2, scanned: 200, found: 0, done_at: new Date().toISOString()}),
		readUsernameMigrationGuildCapacity: vi.fn().mockImplementation(async () => declaration()),
		readUsernameReserveFence: vi.fn().mockResolvedValue({version: 0, pending: false}),
	};
	const claims = {
		readClaim: vi.fn().mockImplementation(async (name) => ({username: name, state: 'held', version: 1})),
		readOwner: vi.fn(),
		readEntitlement: vi.fn(),
	};
	return {config, policy, claims, read: () => readUsernameMigrationStartEvidence(config as never, claims as never)};
}

describe('C19 start-only migration prerequisites', () => {
	it('accepts an admin-uploaded manifest and exports the policy response as JSON Schema', () => {
		const held_manifest = Array.from({length: 1000}, (_, index) => `reserved${index}`);
		expect(
			UsernamePolicyUpdateRequest.parse({tiers: {'1': 'locked', '2': 'locked', '3': 'locked'}, held_manifest})
				.held_manifest,
		).toEqual(held_manifest);
		expect(() => z.toJSONSchema(UsernamePolicyResponse)).not.toThrow();
	});
	it('derives totals from the same epoch scan and maxima from a fresh admin declaration', async () => {
		const {read} = setup();
		expect(await read()).toMatchObject({
			capacity: {
				available: true,
				ready: true,
				proof: {total_accounts: 200, guild_capacity: {max_guild_members: 100, max_guild_online: 10}},
			},
			holds: {required: 2, ready: true, proof: {held: 2, assigned: 0, missing: []}},
		});
	});
	it.each([
		{max_guild_members: 40_000, max_guild_online: 10},
		{max_guild_members: 5_000, max_guild_online: 4_000},
	])('keeps start closed at eighty percent of a T6 trigger without measured evidence (%o)', async (maxima) => {
		const {read, config} = setup();
		config.readUsernameMigrationGuildCapacity.mockResolvedValue({...declaration(), ...maxima});
		expect((await read()).capacity).toMatchObject({available: true, ready: false});
		config.readUsernameMigrationScan.mockResolvedValue({
			epoch: 2,
			scanned: 80_000,
			found: 0,
			done_at: new Date().toISOString(),
		});
		config.readUsernameMigrationGuildCapacity.mockResolvedValue(declaration());
		expect((await read()).capacity.ready).toBe(false);
	});
	it('cannot redeem stale, missing or mismatched guild declarations', async () => {
		const {read, config} = setup();
		for (const value of [
			null,
			{...declaration(), epoch: 1},
			{...declaration(), source: ''},
			{...declaration(), observed_at: new Date(Date.now() - 3_600_000).toISOString()},
			{...declaration(), observed_at: new Date(Date.now() + 1_000).toISOString()},
		]) {
			config.readUsernameMigrationGuildCapacity.mockResolvedValue(value);
			expect((await read()).capacity.ready).toBe(false);
		}
	});
	it('fails closed on missing manifest, unheld names and claim read failures', async () => {
		const {read, policy, claims} = setup();
		(policy as {held_manifest: unknown}).held_manifest = null;
		expect((await read()).holds).toMatchObject({required: null, ready: false, proof: null});
		policy.held_manifest = ['admin'];
		claims.readClaim.mockResolvedValue({state: 'assigned', from_hold: false, user_id: 10n});
		expect((await read()).holds).toMatchObject({required: 1, ready: false, proof: {missing: ['admin']}});
		claims.readClaim.mockRejectedValue(new Error('serial unavailable'));
		await expect(read()).rejects.toThrow('serial unavailable');
	});
	it('accepts a held name assigned by admin only with a matching active owner generation', async () => {
		const {read, policy, claims} = setup();
		policy.held_manifest = ['admin'];
		claims.readClaim.mockResolvedValue({state: 'assigned', from_hold: true, user_id: 10n, owned_gen: 4n});
		claims.readOwner.mockResolvedValue({status: 'active', username: 'admin', owned_gen: 4n, op_id: null});
		expect((await read()).holds).toMatchObject({ready: true, proof: {assigned: 1}});
		claims.readOwner.mockResolvedValue({status: 'active', username: 'admin', owned_gen: 5n});
		expect((await read()).holds.ready).toBe(false);
	});
	it('rejects invalid manifests and requires the start declaration', () => {
		const tiers = {'1': 'locked', '2': 'locked', '3': 'locked'};
		for (const held_manifest of [['admin', 'admin'], Array(1001).fill('admin'), ['bad!']])
			expect(UsernamePolicyUpdateRequest.safeParse({tiers, held_manifest}).success).toBe(false);
		expect(UsernamePolicyUpdateRequest.safeParse({tiers, held_manifest: ['admin']}).success).toBe(true);
		expect(
			UsernameMigrationStartRequest.safeParse({epoch: 2, mobile_published: true, mobile_version: '1'}).success,
		).toBe(false);
	});
});
