// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {executeQuery, setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import {Db} from '@app/api/database/CassandraTypes';
import {UsernameClaims, Users} from '@app/api/Tables';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {assertBotUsernameAvailable} from '@app/api/user/UniqueUsernames';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {intentDay} from '../UsernameOwnershipRepository';
import {UsernameOwnershipService} from '../UsernameOwnershipService';
import {UsernameRepairSweeper} from '../UsernameRepairSweeper';
import {FakeUsernamePolicyService} from './FakeUsernamePolicyService';

let backend: typeof Config.database.backend;
beforeEach(() => {
	backend = Config.database.backend;
	Config.database.backend = 'cassandra';
	setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor());
});
afterEach(() => {
	Config.database.backend = backend;
	setCassandraQueryExecutorForTesting(null);
});

function ownership(policy = new FakeUsernamePolicyService()) {
	return new UsernameOwnershipService({
		policy,
		clock: async () => ({offsetMs: 0, uncertaintyMs: 0}),
		admit: async () => true,
		propagate: async () => {},
		neutralDiscriminator: async () => 1234,
	});
}

describe('username audit corrections', () => {
	it('keeps bot names on upstream validation before migration and the first dictionary', async () => {
		await expect(assertBotUsernameAvailable(null, 'helperbot')).resolves.toBeUndefined();
	});

	it('refuses reservations while migration is still legacy', async () => {
		const policy = new FakeUsernamePolicyService();
		policy.snapshot = {...policy.snapshot, migration: {state: 'legacy', epoch: 0, startedAt: null, forcedAt: null}};
		const result = await ownership(policy).adminHold('reserved', {adminId: createUserID(1n), reason: 'r', note: ''});
		expect(result).toEqual({ok: false, code: 'UNAVAILABLE'});
		expect(await executeQuery(UsernameClaims.select().bind({}))).toEqual([]);
	});

	it('persists the repair cursor once per sweep instead of once per bucket', async () => {
		let state: unknown = null;
		let writes = 0;
		const config = {
			readUsernameRepairState: async () => state,
			compareAndSetUsernameRepairState: async (expected: unknown, next: unknown) => {
				writes++;
				if (JSON.stringify(state) !== JSON.stringify(expected)) return false;
				state = structuredClone(next);
				return true;
			},
		};
		const now = Date.parse('2026-10-09T12:00:00Z');
		await new UsernameRepairSweeper({ownership: ownership(), config, now: () => now}).run();
		expect(writes).toBeLessThanOrEqual(2);
		expect(state).toMatchObject({cursor_day: '2026-10-10', cursor_bucket: 0});
	});

	it('labels intents with the UTC day regardless of the process time zone', () => {
		const zone = process.env.TZ;
		process.env.TZ = 'Europe/Istanbul';
		try {
			expect(intentDay(new Date('2026-10-09T22:30:00Z')).toString()).toBe('2026-10-09');
		} finally {
			if (zone === undefined) delete process.env.TZ;
			else process.env.TZ = zone;
		}
	});

	it('counts a selection after a forced reselect as the free change for an already selected user', async () => {
		const uid = createUserID(300n);
		const service = ownership();
		await executeQuery(Users.patchByPk({user_id: uid}, {username: Db.set('legacy'), discriminator: Db.set(4567)}));
		expect(await service.claimSelf(uid, 'firstname')).toMatchObject({ok: true});
		await service.forceReselect(uid, false, {adminId: createUserID(1n), reason: 'offensive'});
		expect(await service.claimSelf(uid, 'secondname')).toMatchObject({ok: true});
		const status = await service.getPrivateStatus(uid);
		expect(status.freeChangeAvailable).toBe(false);
		expect(status.changeAvailableAt).not.toBeNull();
		expect(await service.claimSelf(uid, 'thirdname')).toMatchObject({ok: false, code: 'COOLDOWN'});
	});
	it('counts a selection after a forced reselect as the free change for a user who never selected', async () => {
		const uid = createUserID(301n);
		const service = ownership();
		await executeQuery(Users.patchByPk({user_id: uid}, {username: Db.set('legacy'), discriminator: Db.set(4568)}));
		await service.forceReselect(uid, false, {adminId: createUserID(1n), reason: 'offensive'});
		expect(await service.claimSelf(uid, 'firstpick')).toMatchObject({ok: true});
		const status = await service.getPrivateStatus(uid);
		expect(status.freeChangeAvailable).toBe(false);
		expect(await service.claimSelf(uid, 'secondpick')).toMatchObject({ok: false, code: 'COOLDOWN'});
	});
});
