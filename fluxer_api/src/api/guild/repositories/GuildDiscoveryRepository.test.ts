// SPDX-License-Identifier: AGPL-3.0-or-later

import {createGuildID} from '@app/api/BrandedTypes';
import {setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import type {CassandraParams, KvQueryMeta, PreparedQuery} from '@app/api/database/CassandraTypes';
import type {GuildDiscoveryRow} from '@app/api/database/types/GuildDiscoveryTypes';
import {GuildDiscoveryRepository} from '@app/api/guild/repositories/GuildDiscoveryRepository';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {DiscoveryApplicationStatus} from '@fluxer/constants/src/DiscoveryConstants';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

// Cassandra stamps every mutation in a batch with one timestamp, and a tombstone wins a timestamp tie,
// so a delete and an insert of the same key in one batch leave the key deleted. Applying the batch's
// deletes last reproduces that outcome on the in-memory store.
class CassandraBatchTieExecutor {
	private readonly inner = new InMemoryCassandraQueryExecutor();

	async executeQuery<T = Record<string, unknown>, P extends CassandraParams = CassandraParams>(
		query: PreparedQuery<P>,
	): Promise<Array<T>> {
		return this.inner.executeQuery<T>(query);
	}

	async executeBatch(queries: Array<{query: string; params: object; meta?: KvQueryMeta}>): Promise<void> {
		const isDelete = (entry: {meta?: KvQueryMeta}) => entry.meta?.action === 'delete';
		await this.inner.executeBatch([...queries.filter((q) => !isDelete(q)), ...queries.filter(isDelete)]);
	}
}

function makeRow(status: string): GuildDiscoveryRow {
	return {
		guild_id: createGuildID(1920000000000000001n),
		status,
		category_type: 2,
		description: 'before edit',
		primary_language: 'tr',
		custom_tags: [],
		applied_at: new Date('2026-09-26T22:24:08.129Z'),
		reviewed_at: null,
		reviewed_by: null,
		review_reason: null,
		removed_at: null,
		removed_by: null,
		removal_reason: null,
	};
}

describe('GuildDiscoveryRepository.updateStatus under Cassandra batch semantics', () => {
	beforeEach(() => {
		setCassandraQueryExecutorForTesting(new CassandraBatchTieExecutor());
	});
	afterEach(() => {
		setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor());
	});

	for (const status of [DiscoveryApplicationStatus.PENDING, DiscoveryApplicationStatus.APPROVED]) {
		it(`keeps a ${status} application in the status index when only its listing fields change`, async () => {
			const repository = new GuildDiscoveryRepository();
			const row = makeRow(status);
			await repository.upsert(row);

			await repository.updateStatus(row.guild_id, row.status, row.applied_at, {...row, description: 'after edit'});

			const listed = await repository.listFullByStatus(status);
			expect(listed.map((entry) => entry.guild_id)).toEqual([row.guild_id]);
			expect(listed[0]?.description).toBe('after edit');
		});
	}

	it('moves the index entry when the status changes', async () => {
		const repository = new GuildDiscoveryRepository();
		const row = makeRow(DiscoveryApplicationStatus.PENDING);
		await repository.upsert(row);

		await repository.updateStatus(row.guild_id, row.status, row.applied_at, {
			...row,
			status: DiscoveryApplicationStatus.APPROVED,
		});

		expect(await repository.listByStatus(DiscoveryApplicationStatus.PENDING)).toEqual([]);
		expect((await repository.listByStatus(DiscoveryApplicationStatus.APPROVED)).map((entry) => entry.guild_id)).toEqual(
			[row.guild_id],
		);
	});
});
