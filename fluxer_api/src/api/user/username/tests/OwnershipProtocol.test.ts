// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {executeQuery, setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import {Db} from '@app/api/database/CassandraTypes';
import {Users} from '@app/api/Tables';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {UsernameOwnershipService} from '../UsernameOwnershipService';
import {FakeUsernamePolicyService} from './FakeUsernamePolicyService';
import {OwnershipInvariants} from './OwnershipInvariants';

const uid = createUserID(200n);
const ctx = {adminId: createUserID(999n), reason: 'test', note: 'test'};
let now: number;
let policy: FakeUsernamePolicyService;
let db: InMemoryCassandraQueryExecutor;
let originalBackend: 'cassandra' | 'postgres';
let invariant: OwnershipInvariants;
async function setup(options = {}) {
	const service = new UsernameOwnershipService({
		policy,
		now: () => now,
		clock: async () => ({offsetMs: 0, uncertaintyMs: 0}),
		admit: async () => true,
		propagate: async () => {},
		neutralDiscriminator: async () => 1234,
		...options,
	});
	await executeQuery(Users.patchByPk({user_id: uid}, {username: Db.set('legacy'), discriminator: Db.set(4567)}));
	await executeQuery(
		Users.patchByPk({user_id: createUserID(201n)}, {username: Db.set('legacy'), discriminator: Db.set(4568)}),
	);
	return service;
}
beforeEach(() => {
	originalBackend = Config.database.backend;
	Config.database.backend = 'cassandra';
	now = Date.parse('2099-10-09T12:00:00Z');
	policy = new FakeUsernamePolicyService();
	let checking = false;
	db = new InMemoryCassandraQueryExecutor({
		afterQuery: async () => {
			if (checking) return;
			checking = true;
			try {
				await invariant.instant();
			} finally {
				checking = false;
			}
		},
	});
	invariant = new OwnershipInvariants(db, () => now);
	setCassandraQueryExecutorForTesting(db);
});
afterEach(async () => {
	vi.restoreAllMocks();
	try {
		await invariant.instant();
		await invariant.converged();
	} finally {
		Config.database.backend = originalBackend;
		setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor());
	}
});
describe('ownership protocol', () => {
	it('retains direct admin assignment provenance and clears it before a later self claim', async () => {
		const service = await setup();
		expect(await service.adminAssign('officialname', uid, ctx)).toMatchObject({ok: true});
		expect(await service.repository.readClaim('officialname')).toMatchObject({
			state: 'assigned',
			held_by: ctx.adminId,
			from_hold: false,
		});
		await service.claimSelf(uid, 'second');
		now += 14 * 86400000;
		expect(await service.claimSelf(createUserID(201n), 'officialname')).toMatchObject({ok: true});
		expect(await service.repository.readClaim('officialname')).toMatchObject({
			state: 'assigned',
			held_by: null,
			from_hold: false,
		});
	});
	it('first selection, one immediate change, then fourteen day cooldown', async () => {
		const service = await setup();
		expect(await service.claimSelf(uid, 'first')).toEqual({ok: true, username: 'first', noop: false});
		expect(await service.claimSelf(uid, 'second')).toEqual({ok: true, username: 'second', noop: false});
		expect(await service.claimSelf(uid, 'third')).toMatchObject({ok: false, code: 'COOLDOWN'});
		expect(await service.resolveBareName('first')).toBeNull();
		expect(await service.resolveBareName('second')).toBe(uid);
		now += 14 * 86400000;
		expect(await service.claimSelf(uid, 'third')).toMatchObject({ok: true});
	});
	it('200 concurrent users racing one name have one winner', async () => {
		const service = await setup();
		const users = Array.from({length: 200}, (_, i) => createUserID(BigInt(1000 + i)));
		for (const user_id of users)
			await executeQuery(Users.patchByPk({user_id}, {username: Db.set('legacy'), discriminator: Db.set(1234)}));
		const results = await Promise.all(users.map((id) => service.claimSelf(id, 'shared')));
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		for (const id of users) await service.repair(id);
		expect(users).toContain(await service.resolveBareName('shared'));
	});
	it('selecting alone permits self and admin assignment', async () => {
		const service = await setup();
		policy.snapshot.migration.state = 'preparing';
		expect(await service.claimSelf(uid, 'first')).toMatchObject({ok: false, code: 'UNAVAILABLE'});
		expect(await service.adminAssign('a', uid, ctx)).toMatchObject({ok: false, code: 'UNAVAILABLE'});
		expect(await service.adminHold('a', ctx)).toMatchObject({ok: true});
	});
	it('admin short assignment creates entitlement and does not consume free change', async () => {
		const service = await setup();
		expect(await service.adminAssign('a', uid, ctx)).toMatchObject({ok: true});
		expect(await service.getPrivateStatus(uid)).toMatchObject({state: 'selected', freeChangeAvailable: true});
		expect(await service.claimSelf(uid, 'first')).toMatchObject({ok: true});
		expect(await service.claimSelf(uid, 'a')).toMatchObject({ok: false, code: 'REQUIRES_ENTITLEMENT'});
	});
	it('release embargo applies to admin and held reservation survives assignment release', async () => {
		const service = await setup();
		await service.adminHold('first', ctx);
		await service.adminAssign('first', uid, ctx);
		await service.claimSelf(uid, 'second');
		expect(await service.adminAssign('first', createUserID(201n), ctx)).toMatchObject({
			ok: false,
			code: 'RELEASE_EMBARGO',
		});
		now += 14 * 86400000;
		expect(await service.claimSelf(createUserID(201n), 'first')).toMatchObject({ok: false, code: 'RESERVED'});
	});
	it('moderation permits immediate reselection and deletion is terminal and idempotent', async () => {
		const service = await setup();
		await service.claimSelf(uid, 'first');
		await service.claimSelf(uid, 'second');
		await service.forceReselect(uid, true, ctx);
		expect(await service.getPrivateStatus(uid)).toMatchObject({state: 'reselect_required'});
		expect(await service.claimSelf(uid, 'third')).toMatchObject({ok: true});
		await service.deleteAccount(uid, {username: 'DeletedUser', discriminator: 0});
		await service.deleteAccount(uid, {username: 'DeletedUser', discriminator: 0});
		expect(await service.claimSelf(uid, 'fourth')).toMatchObject({ok: false});
		expect(await service.resolveBareName('third')).toBeNull();
	});
	it('policy change immediately before commit aborts ownership', async () => {
		const service = await setup();
		policy.onRead = () => {
			if (policy.reads === 2) policy.snapshot.policyRevision++;
		};
		expect(await service.claimSelf(uid, 'first')).toMatchObject({ok: false, code: 'UNAVAILABLE'});
		expect(await service.resolveBareName('first')).toBeNull();
	});
	it('missing admission and unsafe coordinator clock fail closed', async () => {
		const service = await setup({clock: async () => ({offsetMs: 1100, uncertaintyMs: 0})});
		expect(await service.claimSelf(uid, 'first')).toMatchObject({ok: false, code: 'UNAVAILABLE'});
	});
});
