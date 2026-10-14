// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createGuildID, createUserID} from '@app/api/BrandedTypes';
import type {ChannelDataRepository} from '@app/api/channel/repositories/ChannelDataRepository';
import type {MessageRepository} from '@app/api/channel/repositories/MessageRepository';
import {ThreadRepository} from '@app/api/channel/repositories/ThreadRepository';
import {
	type CassandraQueryExecutorForTesting,
	setCassandraQueryExecutorForTesting,
} from '@app/api/database/CassandraQueryExecution';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {afterEach, describe, expect, it, vi} from 'vitest';

describe('ThreadRepository joined membership cursor paging', () => {
	afterEach(() => setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor()));

	it('keeps the compound clustering query and forwards Cassandra page state without decoding it', async () => {
		const repo = new ThreadRepository({} as ChannelDataRepository, {} as MessageRepository);
		const userId = createUserID(100n);
		const guildId = createGuildID(200n);
		const ids = [createChannelID(400n), createChannelID(300n)];
		const executePagedQuery = vi.fn<NonNullable<CassandraQueryExecutorForTesting['executePagedQuery']>>();
		executePagedQuery.mockResolvedValue({
			rows: ids.map((thread_id) => ({thread_id})),
			pageState: 'opaque-next',
		});
		setCassandraQueryExecutorForTesting({
			executeQuery: async () => [],
			executeBatch: async () => {},
			executePagedQuery: executePagedQuery as unknown as NonNullable<
				CassandraQueryExecutorForTesting['executePagedQuery']
			>,
		});
		expect(typeof repo.listJoinedThreadIdsPage).toBe('function');
		const page = await repo.listJoinedThreadIdsPage(userId, guildId, {limit: 1000, cursor: 'opaque-previous'});
		expect(page).toEqual({threadIds: ids, cursor: 'opaque-next'});
		expect(executePagedQuery).toHaveBeenCalledTimes(1);
		const [query, options] = executePagedQuery.mock.calls[0];
		expect(query.params).toEqual({user_id: userId, guild_id: guildId});
		expect(options).toEqual({pageSize: 1000, pageState: 'opaque-previous'});
		expect(query.cql).toContain('thread_members_by_user');
		expect(query.cql).not.toMatch(/ALLOW FILTERING|thread_id\s*[<>]/i);
	});
});
