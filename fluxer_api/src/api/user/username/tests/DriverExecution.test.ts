// SPDX-License-Identifier: AGPL-3.0-or-later

import {executeQuery, setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import {defineTable} from '@app/api/database/CassandraTableDsl';
import {Db, type PreparedQuery} from '@app/api/database/CassandraTypes';
import {PostgresKvQueryExecutor} from '@app/api/database/PostgresKvQueryExecutor';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import type {IPostgresClient} from '@pkgs/postgres/src/Client';
import cassandra from 'cassandra-driver';
import {afterEach, describe, expect, it, vi} from 'vitest';

const Rows = defineTable<{id: string; value: string; version: number}, 'id'>({
	name: 'driver_execution_rows',
	columns: ['id', 'value', 'version'],
	primaryKey: ['id'],
});
const select = () => Rows.select({where: Rows.where.eq('id')}).bind({id: 'u'});
afterEach(() => setCassandraQueryExecutorForTesting(null));

describe('executor read options and failures', () => {
	it('conditional deletion only removes the matched primary key', async () => {
		const db = new InMemoryCassandraQueryExecutor();
		for (const id of ['a', 'b']) await db.executeQuery(Rows.insertIfNotExists({id, value: id, version: 1}));
		await db.executeQuery(Rows.conditionalDeleteByPk({id: 'a'}, {version: 1}));
		expect(await db.executeQuery(Rows.select().bind({}))).toEqual([{id: 'b', value: 'b', version: 1}]);
	});
	it('preserves implicit all-null upsert fixture rows', async () => {
		const Nullable = defineTable<{id: string; value: string | null}, 'id'>({
			name: 'driver_execution_nullable',
			columns: ['id', 'value'],
			primaryKey: ['id'],
		});
		const db = new InMemoryCassandraQueryExecutor();
		await db.executeQuery(Nullable.upsertAll({id: 'u', value: null}));
		expect(await db.executeQuery(Nullable.select().bind({}))).toEqual([{id: 'u', value: null}]);
	});
	it('matches and deletes intent partitions using equivalent LocalDate instances', async () => {
		const Intents = defineTable<{day: cassandra.types.LocalDate; id: string; value: string}, 'day' | 'id', 'day'>({
			name: 'driver_execution_intents',
			columns: ['day', 'id', 'value'],
			primaryKey: ['day', 'id'],
			partitionKey: ['day'],
		});
		const db = new InMemoryCassandraQueryExecutor();
		await db.executeQuery(
			Intents.upsertAll({day: cassandra.types.LocalDate.fromString('2026-10-09'), id: 'u', value: 'intent'}),
		);
		const day = cassandra.types.LocalDate.fromString('2026-10-09');
		expect(await db.executeQuery(Intents.select({where: Intents.where.eq('day')}).bind({day}))).toHaveLength(1);
		await db.executeQuery(Intents.deleteByPk({day, id: 'u'}));
		expect(await db.executeQuery(Intents.select().bind({}))).toEqual([]);
	});
	it('preserves the injected executor call shape when read options are absent', async () => {
		const query = vi.fn(async () => []);
		setCassandraQueryExecutorForTesting({executeQuery: query, executeBatch: async () => {}});
		await executeQuery(select());
		expect(query).toHaveBeenCalledWith(select());
	});
	it('forwards SERIAL read consistency to the injected executor', async () => {
		const query = vi.fn(async () => []);
		setCassandraQueryExecutorForTesting({executeQuery: query, executeBatch: async () => {}});
		await executeQuery(select(), undefined, {consistency: 'serial'});
		expect(query).toHaveBeenCalledWith(select(), {consistency: 'serial'});
	});
	it.each(['apply_then_timeout', 'timeout_before_apply'] as const)(
		'resolves %s by reading the actual latest state with SERIAL',
		async (fault) => {
			let armed = false;
			const reads: Array<unknown> = [];
			const db = new InMemoryCassandraQueryExecutor({
				lwtFault: () => (armed ? fault : undefined),
				afterQuery: (query, options) => {
					if (query.kvMeta?.action === 'select') reads.push(options);
				},
			});
			setCassandraQueryExecutorForTesting(db);
			await executeQuery(Rows.insertIfNotExists({id: 'u', value: 'old', version: 1}));
			armed = true;
			await expect(
				executeQuery(Rows.conditionalPatchByPk({id: 'u'}, {value: Db.set('new'), version: Db.set(2)}, {version: 1})),
			).rejects.toBeInstanceOf(cassandra.errors.OperationTimedOutError);
			expect((await executeQuery(select(), undefined, {consistency: 'serial'}))[0]).toMatchObject({
				value: fault === 'apply_then_timeout' ? 'new' : 'old',
			});
			expect(reads).toEqual([{consistency: 'serial'}]);
		},
	);
	it.each(['beforeQuery', 'afterQuery'] as const)(
		'supports deterministic %s crashes around ordinary writes',
		async (hook) => {
			let armed = false;
			const db = new InMemoryCassandraQueryExecutor({
				[hook]: (query: PreparedQuery) => {
					if (armed && query.kvMeta?.action === 'patch') throw new Error('crash');
				},
			});
			await db.executeQuery(Rows.upsertAll({id: 'u', value: 'old', version: 1}));
			armed = true;
			await expect(db.executeQuery(Rows.patchByPk({id: 'u'}, {value: Db.set('new')}))).rejects.toThrow('crash');
			expect((await db.executeQuery(select()))[0]).toMatchObject({value: hook === 'afterQuery' ? 'new' : 'old'});
		},
	);
});

describe('Postgres explicitly rejects Cassandra timestamps', () => {
	it('permits a WHERE comparison against a column named timestamp', async () => {
		const TimestampFields = defineTable<{id: string; timestamp: bigint}, 'id'>({
			name: 'driver_execution_timestamp_fields',
			columns: ['id', 'timestamp'],
			primaryKey: ['id'],
		});
		const sql = vi.fn(async () => ({rows: []}));
		const db = new PostgresKvQueryExecutor({kvTable: () => 'kv', query: sql} as unknown as IPostgresClient);
		await expect(
			db.executeQuery(
				TimestampFields.select({where: [TimestampFields.where.eq('id'), TimestampFields.where.eq('timestamp')]}).bind({
					id: 'u',
					timestamp: 1n,
				}),
			),
		).resolves.toEqual([]);
		expect(sql).toHaveBeenCalled();
	});
	it('rejects the TIMESTAMP option after TTL before any SQL is sent', async () => {
		const sql = vi.fn();
		const db = new PostgresKvQueryExecutor({kvTable: () => 'kv', query: sql} as unknown as IPostgresClient);
		await expect(
			db.executeQuery({
				cql: 'UPDATE driver_execution_rows USING TTL :ttl AND TIMESTAMP :ts SET value = :value WHERE id = :id;',
				params: {id: 'u', value: 'a', ttl: 10, ts: 1n},
				kvMeta: Rows.patchByPk({id: 'u'}, {value: Db.set('a')}).kvMeta,
			}),
		).rejects.toMatchObject({name: 'UnsupportedWriteTimestampError'});
		expect(sql).not.toHaveBeenCalled();
	});
	it('rejects timestamp writes, raw timestamp CQL and WRITETIME before any SQL is sent', async () => {
		const sql = vi.fn();
		const db = new PostgresKvQueryExecutor({kvTable: () => 'kv', query: sql} as unknown as IPostgresClient);
		const queries = [
			Rows.upsertAll({id: 'u', value: 'a', version: 1}, {timestamp: 1n}),
			Rows.patchByPk({id: 'u'}, {value: Db.set('a')}, {timestamp: 1n}),
			Rows.deleteByPk({id: 'u'}, {timestamp: 1n}),
			{cql: 'DELETE FROM driver_execution_rows USING TIMESTAMP :ts WHERE id = :id;', params: {id: 'u', ts: 1n}},
			Rows.select({writeTime: {value: 'value_time'}}).bind({}),
		];
		for (const query of queries)
			await expect(db.executeQuery(query)).rejects.toMatchObject({name: 'UnsupportedWriteTimestampError'});
		expect(sql).not.toHaveBeenCalled();
	});
	it('preflights a batch so an unsupported later timestamp cannot leave earlier writes behind', async () => {
		const sql = vi.fn();
		const db = new PostgresKvQueryExecutor({kvTable: () => 'kv', query: sql} as unknown as IPostgresClient);
		const queries = [Rows.upsertAll({id: 'u', value: 'a', version: 1}), Rows.deleteByPk({id: 'u'}, {timestamp: 1n})];
		await expect(
			db.executeBatch(
				queries.map(({cql, params, kvMeta}) => ({query: cql, params, meta: kvMeta})),
				false,
			),
		).rejects.toMatchObject({name: 'UnsupportedWriteTimestampError'});
		expect(sql).not.toHaveBeenCalled();
	});
});
