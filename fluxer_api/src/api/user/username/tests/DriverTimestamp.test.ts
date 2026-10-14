// SPDX-License-Identifier: AGPL-3.0-or-later

import {defineTable} from '@app/api/database/CassandraTableDsl';
import {Db} from '@app/api/database/CassandraTypes';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {describe, expect, it} from 'vitest';

interface IdentityRow {
	id: string;
	username: string | null;
	discriminator: number | null;
}
const Identities = defineTable<IdentityRow, 'id'>({
	name: 'driver_timestamp_identities',
	columns: ['id', 'username', 'discriminator'],
	primaryKey: ['id'],
});
const Index = defineTable<{username: string}, 'username'>({
	name: 'driver_timestamp_index',
	columns: ['username'],
	primaryKey: ['username'],
});
const read = () =>
	Identities.select({where: Identities.where.eq('id'), writeTime: {username: 'username_writetime'}}).bind({id: 'u'});

describe('projection timestamps', () => {
	it('conditional batch patches preserve timestamps of untouched cells', async () => {
		const db = new InMemoryCassandraQueryExecutor();
		await db.executeQuery(Identities.upsertAll({id: 'u', username: 'old', discriminator: 1}));
		const readTimes = () =>
			Identities.select({writeTime: {username: 'username_time', discriminator: 'discriminator_time'}}).bind({});
		const before = (await db.executeQuery(readTimes()))[0]!;
		await db.executeQuery(
			Identities.conditionalBatch([
				{action: 'patch', pk: {id: 'u'}, patch: {username: Db.set('new')}, expected: {username: 'old'}},
			]),
		);
		const after = (await db.executeQuery(readTimes()))[0]!;
		expect(after.discriminator_time).toBe(before.discriminator_time);
		expect(after.username_time).not.toBe(before.username_time);
	});
	it.each(['id', 'missing'] as const)('rejects WRITETIME for %s independently', (column) => {
		expect(() => Identities.select({writeTime: {[column]: 'cell_time'}})).toThrow();
	});
	it.each(['bad;alias', 'username', 'ID'])('rejects unsafe or colliding alias %s independently', (alias) => {
		expect(() => Identities.select({writeTime: {username: alias}})).toThrow();
	});
	it('rejects duplicate WRITETIME aliases', () => {
		expect(() => Identities.select({writeTime: {username: 'cell_time', discriminator: 'cell_time'}})).toThrow();
	});
	it('cell tombstones win an equal timestamp regardless of arrival order', async () => {
		for (const patches of [
			[Db.clear<string>(), Db.set('z')],
			[Db.set('z'), Db.clear<string>()],
		]) {
			const db = new InMemoryCassandraQueryExecutor();
			await db.executeQuery(Identities.upsertAll({id: 'u', username: 'first', discriminator: 1}, {timestamp: 10n}));
			for (const patch of patches)
				await db.executeQuery(Identities.patchByPk({id: 'u'}, {username: patch}, {timestamp: 20n}));
			expect((await db.executeQuery(read()))[0]).toMatchObject({username: null, username_writetime: null});
		}
	});
	it('compares equal timestamp buffers as unsigned bytes and retains an isolated copy', async () => {
		const Blobs = defineTable<{id: string; value: Buffer}, 'id'>({
			name: 'driver_timestamp_blobs',
			columns: ['id', 'value'],
			primaryKey: ['id'],
		});
		for (const values of [
			[Buffer.from([255]), Buffer.from([127])],
			[Buffer.from([127]), Buffer.from([255])],
		]) {
			const db = new InMemoryCassandraQueryExecutor();
			for (const value of values) await db.executeQuery(Blobs.upsertAll({id: 'u', value}, {timestamp: 1n}));
			values[1]![0] = 0;
			expect((await db.executeQuery(Blobs.select().bind({})))[0]?.value).toEqual(Buffer.from([255]));
		}
	});
	it('binds normal update, patch and delete timestamps without changing their query shape', () => {
		for (const timestamp of [1n, 9007199254740993n]) {
			for (const query of [
				Identities.upsertAll({id: 'u', username: 'a', discriminator: 1}, {timestamp}),
				Identities.patchByPk({id: 'u'}, {username: Db.set('a')}, {timestamp}),
				Identities.deleteByPk({id: 'u'}, {timestamp}),
				Index.upsertAll({username: 'a'}, {timestamp}),
			]) {
				expect(query.cql).toContain('USING TIMESTAMP :write_timestamp_bind');
				expect(query.params.write_timestamp_bind).toBe(timestamp);
				expect(query.kvMeta?.timestampParamName).toBe('write_timestamp_bind');
			}
		}
	});
	it('rejects invalid timestamps and WRITETIME primary keys or unsafe aliases', () => {
		for (const timestamp of [1, -(1n << 63n), 1n << 63n]) {
			expect(() => Identities.deleteByPk({id: 'u'}, {timestamp: timestamp as bigint})).toThrow();
		}
		expect(() => Identities.select({writeTime: {id: 'id_time'}})).toThrow();
		expect(() => Identities.select({writeTime: {username: 'bad;alias'}})).toThrow();
		expect(() => Identities.select({writeTime: {username: 'username'}})).toThrow();
	});
	it('includes validated WRITETIME selections in both CQL and metadata', () => {
		expect(read().cql).toContain('WRITETIME(username) AS username_writetime');
		expect(read().kvMeta?.writeTime).toEqual({username: 'username_writetime'});
		expect(Identities.selectCql({writeTime: {username: 'username_writetime'}})).toContain(
			'WRITETIME(username) AS username_writetime',
		);
	});
	it('keeps newer cells and reports their individual timestamps after a delayed full projection', async () => {
		const db = new InMemoryCassandraQueryExecutor();
		await db.executeQuery(Identities.upsertAll({id: 'u', username: 'new', discriminator: 9}, {timestamp: 20n}));
		await db.executeQuery(Identities.patchByPk({id: 'u'}, {discriminator: Db.set(7)}, {timestamp: 30n}));
		await db.executeQuery(Identities.upsertAll({id: 'u', username: 'old', discriminator: 1}, {timestamp: 10n}));
		expect(await db.executeQuery(read())).toEqual([
			{id: 'u', username: 'new', discriminator: 7, username_writetime: 20n},
		]);
	});
	it('keeps row tombstones even if delete arrives before insert and accepts only a strictly newer write', async () => {
		const db = new InMemoryCassandraQueryExecutor();
		await db.executeQuery(Index.deleteByPk({username: 'a'}, {timestamp: 20n}));
		await db.executeQuery(Index.upsertAll({username: 'a'}, {timestamp: 10n}));
		await db.executeQuery(Index.upsertAll({username: 'a'}, {timestamp: 20n}));
		expect(await db.executeQuery(Index.select().bind({}))).toEqual([]);
		await db.executeQuery(Index.upsertAll({username: 'a'}, {timestamp: 21n}));
		expect(await db.executeQuery(Index.select().bind({}))).toEqual([{username: 'a'}]);
	});
	it('resolves equal timestamps independently of arrival order: tombstones then unsigned value bytes', async () => {
		for (const values of [
			['z', 'a'],
			['a', 'z'],
		]) {
			const db = new InMemoryCassandraQueryExecutor();
			for (const value of values)
				await db.executeQuery(Identities.patchByPk({id: 'u'}, {username: Db.set(value)}, {timestamp: 20n}));
			expect((await db.executeQuery(read()))[0]).toMatchObject({username: 'z', username_writetime: 20n});
		}
		for (const patches of [
			[Db.clear<string>(), Db.set('z')],
			[Db.set('z'), Db.clear<string>()],
		]) {
			const db = new InMemoryCassandraQueryExecutor();
			await db.executeQuery(Identities.upsertAll({id: 'u', username: 'first', discriminator: 1}, {timestamp: 10n}));
			for (const patch of patches)
				await db.executeQuery(Identities.patchByPk({id: 'u'}, {username: patch}, {timestamp: 20n}));
			expect((await db.executeQuery(read()))[0]).toMatchObject({username: null, username_writetime: null});
		}
	});
	it('row deletion preserves cells newer than its timestamp', async () => {
		const db = new InMemoryCassandraQueryExecutor();
		await db.executeQuery(Identities.upsertAll({id: 'u', username: 'old', discriminator: 1}, {timestamp: 10n}));
		await db.executeQuery(Identities.patchByPk({id: 'u'}, {username: Db.set('new')}, {timestamp: 30n}));
		await db.executeQuery(Identities.deleteByPk({id: 'u'}, {timestamp: 20n}));
		expect(await db.executeQuery(read())).toEqual([
			{id: 'u', username: 'new', discriminator: null, username_writetime: 30n},
		]);
	});
});
