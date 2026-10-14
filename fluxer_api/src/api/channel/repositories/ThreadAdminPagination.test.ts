// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createGuildID} from '@app/api/BrandedTypes';
import type {ChannelDataRepository} from '@app/api/channel/repositories/ChannelDataRepository';
import type {MessageRepository} from '@app/api/channel/repositories/MessageRepository';
import {ThreadRepository} from '@app/api/channel/repositories/ThreadRepository';
import {setCassandraQueryExecutorForTesting, upsertOne} from '@app/api/database/CassandraQueryExecution';
import type {PreparedQuery} from '@app/api/database/CassandraTypes';
import {syncChannelThreadsConfig} from '@app/api/experiment/ChannelThreadsGate';
import {GuildThreadState, ThreadsByParent} from '@app/api/Tables';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {ChannelThreadsConfigSchema} from '@fluxer/schema/src/domains/admin/ChannelThreadsSchemas';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

const guildId = createGuildID(5000n);
const parentId = createChannelID(100n);
const nextParentId = createChannelID(200n);

describe('admin guild thread index paging', () => {
	let queries: Array<PreparedQuery>;
	let repository: ThreadRepository;

	beforeEach(async () => {
		queries = [];
		const executor = new InMemoryCassandraQueryExecutor();
		setCassandraQueryExecutorForTesting({
			executeQuery: async (query) => {
				queries.push(query);
				return executor.executeQuery(query);
			},
			executeBatch: (batch, atomic) => executor.executeBatch(batch, atomic),
		});
		syncChannelThreadsConfig(JSON.stringify({enabled: false, ever_enabled: true}), (raw) =>
			ChannelThreadsConfigSchema.parse(JSON.parse(raw ?? '{}')),
		);
		await upsertOne(
			GuildThreadState.upsertAll({
				guild_id: guildId,
				first_active_at: new Date(),
				perms_seeded_at: null,
				search_backfilled_at: null,
			}),
		);
		repository = new ThreadRepository(
			{
				listGuildChannels: async () => [
					{id: nextParentId, type: ChannelTypes.GUILD_TEXT},
					{id: parentId, type: ChannelTypes.GUILD_TEXT},
				],
			} as unknown as ChannelDataRepository,
			{} as MessageRepository,
		);
	});

	afterEach(() => {
		syncChannelThreadsConfig(null, () => ChannelThreadsConfigSchema.parse({}));
		setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor());
	});

	it('reads a single bounded parent page from a large history and advances without skipping entries', async () => {
		expect(typeof repository.listGuildThreadIdsPage).toBe('function');
		for (let index = 1; index <= 2505; index++) {
			await upsertOne(
				ThreadsByParent.upsertAll({
					guild_id: guildId,
					parent_id: parentId,
					thread_id: createChannelID(BigInt(10000 + index)),
					type: ChannelTypes.PUBLIC_THREAD,
				}),
			);
		}
		await upsertOne(
			ThreadsByParent.upsertAll({
				guild_id: guildId,
				parent_id: nextParentId,
				thread_id: createChannelID(50000n),
				type: ChannelTypes.PRIVATE_THREAD,
			}),
		);
		queries.length = 0;
		let cursor: string | null = null;
		const ids: Array<bigint> = [];
		let pages = 0;
		do {
			const before = queries.length;
			const page = await repository.listGuildThreadIdsPage(guildId, {limit: 100, cursor});
			const reads = queries.slice(before).filter((query) => query.cql.includes('threads_by_parent'));
			expect(reads).toHaveLength(1);
			expect(reads[0]!.cql).toContain('LIMIT :limit_bind');
			expect(reads[0]!.params.limit_bind).toBe(100);
			expect(page.threadIds.length).toBeLessThanOrEqual(100);
			ids.push(...page.threadIds);
			cursor = page.cursor;
			pages += 1;
			expect(pages).toBeLessThan(30);
		} while (cursor !== null);
		expect(ids).toEqual([...Array.from({length: 2505}, (_, index) => BigInt(10001 + index)), 50000n]);
	});

	it('advances through an empty parent page rather than scanning later parents in the same request', async () => {
		expect(typeof repository.listGuildThreadIdsPage).toBe('function');
		await upsertOne(
			ThreadsByParent.upsertAll({
				guild_id: guildId,
				parent_id: nextParentId,
				thread_id: createChannelID(50000n),
				type: ChannelTypes.PUBLIC_THREAD,
			}),
		);
		queries.length = 0;
		const empty = await repository.listGuildThreadIdsPage(guildId, {limit: 100});
		expect(empty.threadIds).toEqual([]);
		expect(empty.cursor).not.toBeNull();
		expect(queries.filter((query) => query.cql.includes('threads_by_parent'))).toHaveLength(1);
		const next = await repository.listGuildThreadIdsPage(guildId, {limit: 100, cursor: empty.cursor});
		expect(next.threadIds).toEqual([50000n]);
		expect(next.cursor).toBeNull();
	});

	it('rejects malformed, other-guild and unowned-parent cursors before any thread partition read', async () => {
		expect(typeof repository.listGuildThreadIdsPage).toBe('function');
		const encode = (body: object) => Buffer.from(JSON.stringify(body)).toString('base64url');
		for (const cursor of [
			'invalid!',
			encode({guild_id: '9999', parent_id: '100', after: null}),
			encode({guild_id: guildId.toString(), parent_id: '9999', after: null}),
		]) {
			queries.length = 0;
			await expect(repository.listGuildThreadIdsPage(guildId, {limit: 100, cursor})).rejects.toMatchObject({
				status: 400,
			});
			expect(queries.filter((query) => query.cql.includes('threads_by_parent'))).toHaveLength(0);
		}
	});
});
