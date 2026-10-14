// SPDX-License-Identifier: AGPL-3.0-or-later
import {createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {executeQuery, setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import {EMPTY_USER_ROW} from '@app/api/database/types/UserTypes';
import {Users} from '@app/api/Tables';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {afterEach, beforeEach, expect, test} from 'vitest';
import {UsernameOwnershipRepository} from '../UsernameOwnershipRepository';
import {UsernameOwnershipService} from '../UsernameOwnershipService';
import {FakeUsernamePolicyService} from './FakeUsernamePolicyService';

const id = createUserID(200n);
const ctx = {adminId: createUserID(999n), reason: 'moderation'};
let backend: typeof Config.database.backend;
beforeEach(() => {
	backend = Config.database.backend;
	Config.database.backend = 'cassandra';
});
afterEach(() => {
	Config.database.backend = backend;
	setCassandraQueryExecutorForTesting(null);
});
function setup() {
	const writes: Array<string> = [];
	setCassandraQueryExecutorForTesting(
		new InMemoryCassandraQueryExecutor({
			beforeQuery: (query) => {
				if (!query.cql.startsWith('SELECT')) writes.push(query.cql);
			},
		}),
	);
	const policy = new FakeUsernamePolicyService();
	const service = new UsernameOwnershipService({
		policy,
		clock: async () => ({offsetMs: 0, uncertaintyMs: 0}),
		admit: async () => true,
		propagate: async () => {},
		neutralDiscriminator: async () => 1234,
	});
	return {writes, policy, service};
}
test.each(['legacy', 'preparing'] as const)(
	'real forceReselect rejects %s before any writes and self selection stays closed',
	async (state) => {
		const {writes, policy, service} = setup();
		await executeQuery(Users.upsertAll({...EMPTY_USER_ROW, user_id: id, username: 'legacy', discriminator: 4567}));
		writes.length = 0;
		policy.snapshot.migration.state = state;
		await expect(service.forceReselect(id, true, ctx)).rejects.toThrow();
		expect(writes).toEqual([]);
		expect(await service.claimSelf(id, 'chosenname')).toEqual({ok: false, code: 'UNAVAILABLE'});
		expect(writes).toEqual([]);
		expect(await service.repository.readOwner(id)).toBeNull();
		const projection = await service.repository.readProjection(id);
		expect([projection?.username, projection?.discriminator, projection?.username_state]).toEqual([
			'legacy',
			4567,
			null,
		]);
	},
);
test('real ownership finalize writes identity and generation at the same projection timestamp', async () => {
	const {service} = setup();
	await executeQuery(Users.upsertAll({...EMPTY_USER_ROW, user_id: id, username: 'legacy', discriminator: 4567}));
	expect(await service.claimSelf(id, 'chosenname')).toMatchObject({ok: true});
	const owner = await service.repository.readOwner(id);
	const row = await new UsernameOwnershipRepository().readProjection(id);
	expect([row?.username, row?.identity_version]).toEqual(['chosenname', owner?.owned_gen]);
	expect([row?.username_time, row?.discriminator_time, row?.state_time, row?.identity_time]).toEqual(
		Array(4).fill(owner?.last_proj_ts),
	);
});
test('selecting moderation leaves a real self-selection recovery path open', async () => {
	const {service} = setup();
	await executeQuery(Users.upsertAll({...EMPTY_USER_ROW, user_id: id, username: 'legacy', discriminator: 4567}));
	expect(await service.claimSelf(id, 'chosenname')).toMatchObject({ok: true});
	await service.forceReselect(id, true, ctx);
	expect((await service.repository.readOwner(id))?.status).toBe('reselect_required');
	expect(await service.claimSelf(id, 'replacement')).toMatchObject({ok: true});
	expect((await service.repository.readProjection(id))?.username_state).toBe('selected');
});
