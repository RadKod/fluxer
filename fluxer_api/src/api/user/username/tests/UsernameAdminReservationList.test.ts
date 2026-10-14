// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {
	executeQuery,
	resetCassandraQueryExecutorForTesting,
	setCassandraQueryExecutorForTesting,
} from '@app/api/database/CassandraQueryExecution';
import {Db} from '@app/api/database/CassandraTypes';
import {UsernameClaims} from '@app/api/Tables';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {holdBucket} from '../UsernameOwnershipRepository';
import {UsernameOwnershipService} from '../UsernameOwnershipService';
import {FakeUsernamePolicyService} from './FakeUsernamePolicyService';

const ctx = {adminId: createUserID(99n), reason: 'hold', note: 'official'};
let service: UsernameOwnershipService;
let backend: 'cassandra' | 'postgres';
let now: number;
beforeEach(() => {
	backend = Config.database.backend;
	Config.database.backend = 'cassandra';
	setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor());
	now = Date.now();
	service = new UsernameOwnershipService({
		now: () => now,
		policy: new FakeUsernamePolicyService(),
		clock: async () => ({offsetMs: 0, uncertaintyMs: 0}),
		propagate: async () => {},
		neutralDiscriminator: async () => 1234,
	});
});
afterEach(() => {
	Config.database.backend = backend;
	resetCassandraQueryExecutorForTesting();
});

describe('authoritative bounded reservation listing', () => {
	it('returns claim notes and holder from the claim rather than the index', async () => {
		await service.adminHold('reserved', ctx);
		const result = await service.listReservations(holdBucket('reserved'), null, 2);
		expect(result.items).toEqual([
			expect.objectContaining({
				username: 'reserved',
				state: 'held',
				held_by: '99',
				note: 'official',
				user_id: null,
				index_ts: expect.any(String),
			}),
		]);
	});
	it('resolves an orphan pending held claim on the listing touch', async () => {
		await service.adminHold('reserved', ctx);
		await executeQuery(
			UsernameClaims.patchByPk(
				{username: 'reserved'},
				{
					state: Db.set('pending'),
					prev_state: Db.set('held'),
					op_id: Db.set('dead'),
					user_id: Db.set(createUserID(12n)),
				},
			),
		);
		const result = await service.listReservations(holdBucket('reserved'), null, 2);
		expect(result.items[0]).toMatchObject({username: 'reserved', state: 'held', note: 'official'});
		expect((await service.repository.readClaim('reserved'))?.state).toBe('held');
	});
	it('drops stale index entries using the authoritative claim timestamp', async () => {
		await service.adminHold('reserved', ctx);
		const held = (await service.repository.readClaim('reserved'))!;
		const released = (await service.repository.casClaim(held, {state: 'released', index_ts: held.index_ts + 1n}))!;
		now += 300001;
		const remove = vi.spyOn(service.repository, 'deleteHoldIndex');
		expect((await service.listReservations(holdBucket('reserved'), null, 2)).items).toEqual([]);
		expect(remove).toHaveBeenCalledWith(expect.objectContaining({index_ts: released.index_ts, state: 'released'}));
	});
	it('bounds raw work and advances the cursor to the last scanned row', async () => {
		const bucket = 0;
		const names = Array.from({length: 10000}, (_, i) => `name${i}`)
			.filter((name) => holdBucket(name) === bucket)
			.sort()
			.slice(0, 3);
		for (const name of names) await service.adminHold(name, ctx);
		const list = vi.spyOn(service.repository, 'listHoldIndex');
		const page = await service.listReservations(bucket, null, 2);
		expect(page.items.map((row) => row.username)).toEqual(names.slice(0, 2));
		expect(page.next_cursor).toBe(names[1]);
		expect(list).toHaveBeenCalledOnce();
		expect(list).toHaveBeenCalledWith(bucket, null, 3);
		const last = await service.listReservations(bucket, page.next_cursor, 2);
		expect(last.items.map((row) => row.username)).toEqual(names.slice(2));
		expect(last.next_cursor).toBeNull();
	});
	it('a delayed cleanup cannot erase a later hold', async () => {
		await service.adminHold('reserved', ctx);
		const held = (await service.repository.readClaim('reserved'))!;
		await service.repository.casClaim(held, {state: 'released', index_ts: held.index_ts + 1n});
		now += 300001;
		const remove = service.repository.deleteHoldIndex.bind(service.repository);
		vi.spyOn(service.repository, 'deleteHoldIndex').mockImplementationOnce(async (row) => {
			await service.adminHold('reserved', {...ctx, note: 'later'});
			await remove(row);
		});
		await service.listReservations(holdBucket('reserved'), null, 2);
		expect((await service.listReservations(holdBucket('reserved'), null, 2)).items[0]).toMatchObject({
			username: 'reserved',
			note: 'later',
		});
	});
	it('advances beyond stale rows without extending the bounded scan', async () => {
		const bucket = 0;
		const names = Array.from({length: 10000}, (_, i) => `name${i}`)
			.filter((name) => holdBucket(name) === bucket)
			.sort()
			.slice(0, 3);
		for (const name of names) {
			await service.adminHold(name, ctx);
			const claim = (await service.repository.readClaim(name))!;
			await service.repository.casClaim(claim, {state: 'released', index_ts: claim.index_ts + 1n});
		}
		now += 300001;
		const page = await service.listReservations(bucket, null, 2);
		expect(page).toMatchObject({items: [], next_cursor: names[1]});
		expect(await service.listReservations(bucket, page.next_cursor, 2)).toMatchObject({items: [], next_cursor: null});
	});
	it('does not clean a nonheld index at or before the five-minute age fence', async () => {
		await service.adminHold('reserved', ctx);
		const held = (await service.repository.readClaim('reserved'))!;
		await service.repository.casClaim(held, {state: 'released', index_ts: held.index_ts + 1n});
		const remove = vi.spyOn(service.repository, 'deleteHoldIndex');
		await service.listReservations(holdBucket('reserved'), null, 2);
		now += 300000;
		await service.listReservations(holdBucket('reserved'), null, 2);
		expect(remove).not.toHaveBeenCalled();
		now++;
		await service.listReservations(holdBucket('reserved'), null, 2);
		expect(remove).toHaveBeenCalledOnce();
	});
});
