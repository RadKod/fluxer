// SPDX-License-Identifier: AGPL-3.0-or-later

import {setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {UsernameOwnershipRepository} from '@app/api/user/username/UsernameOwnershipRepository';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const cql = 'SELECT toTimestamp(now()) AS coordinator_time FROM system.local';
let executor: InMemoryCassandraQueryExecutor;
beforeEach(() => {
	executor = new InMemoryCassandraQueryExecutor();
	setCassandraQueryExecutorForTesting(executor);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor());
});

describe('username coordinator time query', () => {
	it('passes an empty parameter object through the real Cassandra query boundary', async () => {
		const clock = new Date('2026-10-09T00:00:00.000Z');
		const execute = vi.spyOn(executor, 'executeQuery').mockResolvedValue([{coordinator_time: clock}]);
		expect(await new UsernameOwnershipRepository().coordinatorTime()).toEqual(clock);
		expect(execute).toHaveBeenCalledWith({cql, params: {}, kvMeta: undefined});
	});
	it('models the native coordinator timestamp in the in-memory Cassandra fixture', async () => {
		vi.useFakeTimers();
		const clock = new Date('2026-10-09T12:34:56.000Z');
		vi.setSystemTime(clock);
		expect(await new UsernameOwnershipRepository().coordinatorTime()).toEqual(clock);
	});
});
