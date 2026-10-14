// SPDX-License-Identifier: AGPL-3.0-or-later
import {createUserID} from '@app/api/BrandedTypes';
import {setCassandraQueryExecutorForTesting, upsertOne} from '@app/api/database/CassandraQueryExecution';
import {EMPTY_USER_ROW} from '@app/api/database/types/UserTypes';
import {UsernameOwners, Users} from '@app/api/Tables';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {emptyOwner} from '@app/api/user/username/UsernameOwnershipRepository';
import {afterEach, expect, test} from 'vitest';
import {UserDataRepository} from './UserDataRepository';

afterEach(() => setCassandraQueryExecutorForTesting(null));
// Upstream listUsers (Fluxer d65c5b436) issues exactly this one non-serial read for any batch size and nothing
// else; the identity fields added for usernames must be served from the same row.
const UPSTREAM_LIST_USERS_QUERIES = [{cql: Users.selectCql({where: Users.where.in('user_id', 'user_ids')})}];
test.each([1, 100])(
	'real listUsers for %s humans issues only the upstream single users read, without Paxos',
	async (count) => {
		const queries: Array<{cql: string; consistency?: string}> = [];
		setCassandraQueryExecutorForTesting(
			new InMemoryCassandraQueryExecutor({
				beforeQuery: (query, options) => {
					queries.push({cql: query.cql, consistency: options?.consistency});
				},
			}),
		);
		const ids = Array.from({length: count}, (_, i) => createUserID(BigInt(100 + i)));
		for (const user_id of ids) {
			await upsertOne(
				Users.upsertAll({
					...EMPTY_USER_ROW,
					user_id,
					username: `user${user_id}`,
					discriminator: 0,
					username_state: 'selected',
					identity_version: 8n,
				}),
			);
			await upsertOne(UsernameOwners.upsertAll({...emptyOwner(user_id), username: `user${user_id}`, owned_gen: 8n}));
		}
		queries.length = 0;
		const current = await new UserDataRepository().listUsers(ids);
		expect(current.map((user) => user.username).sort()).toEqual(ids.map((id) => `user${id}`).sort());
		expect(queries).toEqual(UPSTREAM_LIST_USERS_QUERIES);
		expect(current.every((user) => user.identityVersion === 8n)).toBe(true);
	},
);
