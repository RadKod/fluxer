// SPDX-License-Identifier: AGPL-3.0-or-later

import {getKvMeta} from '@app/api/database/CassandraMetaRegistry';
import type {CassandraQueryExecutorForTesting, CassandraReadOptions} from '@app/api/database/CassandraQueryExecution';
import type {
	CassandraParams,
	KvQueryCondition,
	KvQueryMeta,
	PreparedQuery,
	WhereExpr,
} from '@app/api/database/CassandraTypes';
import {isConditionalQuery} from '@app/api/database/CassandraTypes';
import {normalizeCql, rowComparator, valuesEqual} from '@app/api/database/PostgresKvQueryExecutor';
import {MAX_TOKEN, MIN_TOKEN} from '@app/api/database/TokenRangeScan';
import cassandra from 'cassandra-driver';

type Row = Record<string, unknown>;

interface Cell {
	value: unknown;
	timestamp: bigint;
}

interface TimestampedRow {
	pk: Row;
	cells: Map<string, Cell>;
	deletedAt?: bigint;
	liveAt?: bigint;
}

export interface InMemoryCassandraOptions {
	lwtFault?: (
		query: PreparedQuery,
		options?: CassandraReadOptions,
	) => 'apply_then_timeout' | 'timeout_before_apply' | undefined;
	beforeQuery?: (query: PreparedQuery, options?: CassandraReadOptions) => void | Promise<void>;
	afterQuery?: (query: PreparedQuery, options?: CassandraReadOptions) => void | Promise<void>;
}

function cellBytes(value: unknown): Buffer {
	if (typeof value === 'string') return Buffer.from(value, 'utf8');
	if (Buffer.isBuffer(value)) return value;
	if (typeof value === 'boolean') return Buffer.from([value ? 1 : 0]);
	if (typeof value === 'number' && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) {
		// Micup: Timestamped numeric fixtures represent CQL int; other wire types need explicit type metadata.
		const bytes = Buffer.alloc(4);
		bytes.writeInt32BE(value);
		return bytes;
	}
	if (typeof value === 'bigint' || value instanceof Date) {
		const bytes = Buffer.alloc(8);
		bytes.writeBigInt64BE(value instanceof Date ? BigInt(value.getTime()) : value);
		return bytes;
	}
	throw new Error('In-memory equal-timestamp comparison requires text, int32, bigint, boolean, Date or Buffer');
}

function compareValues(a: unknown, b: unknown): number {
	if (typeof a === 'bigint' || typeof b === 'bigint') {
		const av = typeof a === 'bigint' ? a : BigInt(a as number | string);
		const bv = typeof b === 'bigint' ? b : BigInt(b as number | string);
		if (av === bv) return 0;
		return av < bv ? -1 : 1;
	}
	const av = a instanceof Date ? a.getTime() : typeof a === 'bigint' ? Number(a) : a;
	const bv = b instanceof Date ? b.getTime() : typeof b === 'bigint' ? Number(b) : b;
	if (av === bv) return 0;
	return (av as number | string) < (bv as number | string) ? -1 : 1;
}

const MURMUR3_C1 = 0x87c37b91114253d5n;
const MURMUR3_C2 = 0x4cf5ad432745937fn;

function rotl64(value: bigint, bits: bigint): bigint {
	return BigInt.asUintN(64, (value << bits) | (value >> (64n - bits)));
}

function fmix64(value: bigint): bigint {
	let k = value ^ (value >> 33n);
	k = BigInt.asUintN(64, k * 0xff51afd7ed558ccdn);
	k ^= k >> 33n;
	k = BigInt.asUintN(64, k * 0xc4ceb9fe1a85ec53n);
	return k ^ (k >> 33n);
}

// Cassandra's Murmur3Partitioner token: MurmurHash3 x64_128 (seed 0) of the serialised partition key, first
// 64 bits, with Cassandra's sign-extended tail bytes and Long.MIN_VALUE folded onto Long.MAX_VALUE.
// TEMPORARY: bigint keys only (8 bytes, no 16-byte body blocks); other key types throw until a table needs them.
function murmur3Token(key: unknown): bigint {
	if (typeof key !== 'bigint') {
		throw new Error(`In-memory Cassandra computes TOKEN() for bigint partition keys only, got ${typeof key}`);
	}
	const bytes = Buffer.alloc(8);
	bytes.writeBigInt64BE(key);
	let k1 = 0n;
	for (let i = 0; i < 8; i++) k1 ^= BigInt.asUintN(64, BigInt(bytes.readInt8(i)) << BigInt(i * 8));
	k1 = BigInt.asUintN(64, rotl64(BigInt.asUintN(64, k1 * MURMUR3_C1), 31n) * MURMUR3_C2);
	const length = BigInt(bytes.length);
	let h1 = k1 ^ length;
	let h2 = length;
	h1 = BigInt.asUintN(64, h1 + h2);
	h2 = BigInt.asUintN(64, h2 + h1);
	const token = BigInt.asIntN(64, fmix64(h1) + fmix64(h2));
	return token === MIN_TOKEN ? MAX_TOKEN : token;
}

function matchesConditions(
	row: Row | undefined,
	conditions: ReadonlyArray<KvQueryCondition<Row>> | undefined,
	params: CassandraParams,
): row is Row {
	if (!conditions?.length) {
		throw new Error('Conditional mutations require at least one condition');
	}
	return row !== undefined && conditions.every(({col, expectedParam}) => valuesEqual(row[col], params[expectedParam]));
}

function cloneValue<T>(value: T): T {
	if (Buffer.isBuffer(value)) return Buffer.from(value) as T;
	if (value instanceof Date) return new Date(value.getTime()) as T;
	if (value instanceof Set) return new Set([...value].map((entry) => cloneValue(entry))) as T;
	if (value instanceof Map) {
		return new Map([...value.entries()].map(([key, entry]) => [cloneValue(key), cloneValue(entry)])) as T;
	}
	if (Array.isArray(value)) return value.map((entry) => cloneValue(entry)) as T;
	if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
		return {...(value as object)} as T;
	}
	return value;
}

function cloneRow(row: Row): Row {
	const cloned: Row = {};
	for (const [key, value] of Object.entries(row)) {
		cloned[key] = cloneValue(value);
	}
	return cloned;
}

function pkKey(meta: KvQueryMeta, row: Row): string {
	return meta.table.primaryKey.map((column) => valueKey(row[column])).join('\u0000');
}

function valueKey(value: unknown): string {
	if (Buffer.isBuffer(value)) return `buffer:${value.toString('base64')}`;
	if (value instanceof Date) return `date:${value.toISOString()}`;
	if (typeof value === 'bigint') return `bigint:${value.toString()}`;
	return `${typeof value}:${String(value)}`;
}

function getParam(params: CassandraParams, param: string): unknown {
	return params[param];
}

function matchesWhere(row: Row, where: ReadonlyArray<WhereExpr<Row>> | undefined, params: CassandraParams): boolean {
	for (const clause of where ?? []) {
		switch (clause.kind) {
			case 'eq':
				if (!valuesEqual(row[clause.col], getParam(params, clause.param))) return false;
				break;
			case 'in': {
				const values = getParam(params, clause.param) as ReadonlyArray<unknown> | Set<unknown> | undefined;
				const haystack = values instanceof Set ? [...values] : (values ?? []);
				if (!haystack.some((value) => valuesEqual(row[clause.col], value))) return false;
				break;
			}
			case 'lt':
				if (compareValues(row[clause.col], getParam(params, clause.param)) >= 0) return false;
				break;
			case 'lte':
				if (compareValues(row[clause.col], getParam(params, clause.param)) > 0) return false;
				break;
			case 'gt':
				if (compareValues(row[clause.col], getParam(params, clause.param)) <= 0) return false;
				break;
			case 'gte':
				if (compareValues(row[clause.col], getParam(params, clause.param)) < 0) return false;
				break;
			case 'tokenGt':
				break;
			case 'tokenRange': {
				const token = murmur3Token(row[clause.col]);
				if (compareValues(token, getParam(params, clause.startParam)) < 0) return false;
				if (compareValues(token, getParam(params, clause.endParam)) > 0) return false;
				break;
			}
			case 'tupleGt': {
				const left = clause.cols.map((column) => row[column]);
				const right = clause.params.map((param) => getParam(params, param));
				let greater = false;
				for (let i = 0; i < left.length; i += 1) {
					const cmp = compareValues(left[i], right[i]);
					if (cmp > 0) {
						greater = true;
						break;
					}
					if (cmp < 0) break;
				}
				if (!greater) return false;
				break;
			}
		}
	}
	return true;
}

function projectRow(row: Row, columns: ReadonlyArray<string> | undefined): Row {
	if (!columns) return cloneRow(row);
	const projected: Row = {};
	for (const column of columns) {
		// Cassandra returns null for selected columns that have never been written.
		projected[column] = cloneValue(row[column] ?? null);
	}
	return projected;
}

function parseRawMeta(cql: string): KvQueryMeta<Row> | null {
	const normalized = normalizeCql(cql).replace(/;$/, '');
	const update = /^UPDATE\s+([a-zA-Z0-9_]+)\s+SET\s+(.+?)\s+WHERE\s+(.+)$/i.exec(normalized);
	if (update) {
		const table = update[1]!;
		const patchKeys = update[2]!
			.split(',')
			.map((part) => part.trim().split(/\s*=\s*/)[0])
			.filter(Boolean);
		const where = update[3]!
			.split(/\s+AND\s+/i)
			.map((part) => part.trim().split(/\s*=\s*/)[0])
			.filter(Boolean);
		return {
			action: 'patch',
			table: {name: table, columns: [...new Set([...where, ...patchKeys])], primaryKey: where, partitionKey: where},
			where: where.map((col) => ({kind: 'eq', col, param: col})),
			patchKeys,
			pkColumns: where,
		};
	}
	const insert = /^INSERT\s+INTO\s+([a-zA-Z0-9_]+)\s*\((.+?)\)\s+VALUES/i.exec(normalized);
	if (insert) {
		const columns = insert[2]!.split(',').map((part) => part.trim());
		const pk = columns.includes('event_id') ? ['event_id'] : [columns[0]!];
		return {
			action: 'upsert',
			table: {name: insert[1]!, columns, primaryKey: pk, partitionKey: pk},
		};
	}
	return null;
}

export class InMemoryCassandraQueryExecutor implements CassandraQueryExecutorForTesting {
	private readonly tables = new Map<string, Map<string, Row>>();
	private readonly timestampedTables = new Map<string, Map<string, TimestampedRow>>();
	private clock = 0n;

	constructor(private readonly options: InMemoryCassandraOptions = {}) {}
	readonly executed: Array<KvQueryMeta> = [];
	readonly batchAtomicity: Array<boolean> = [];
	countStatements(statement: string): number {
		return this.executed.filter((meta) => `${meta.action}:${meta.table.name}` === statement).length;
	}

	reset(): void {
		this.tables.clear();
		this.timestampedTables.clear();
		this.clock = 0n;
		this.executed.length = 0;
		this.batchAtomicity.length = 0;
	}

	private table(meta: KvQueryMeta): Map<string, Row> {
		let table = this.tables.get(meta.table.name);
		if (!table) {
			table = new Map();
			this.tables.set(meta.table.name, table);
		}
		return table;
	}

	private meta(query: PreparedQuery): KvQueryMeta<Row> {
		const meta = (query.kvMeta ?? getKvMeta(query.cql) ?? parseRawMeta(query.cql)) as KvQueryMeta<Row> | null;
		if (!meta) {
			throw new Error(`In-memory Cassandra does not understand query: ${query.cql}`);
		}
		return meta;
	}

	async executeQuery<T = Row>(query: PreparedQuery, readOptions?: CassandraReadOptions): Promise<Array<T>> {
		await this.options.beforeQuery?.(query, readOptions);
		const fault = isConditionalQuery(query) ? this.options.lwtFault?.(query, readOptions) : undefined;
		if (fault === 'timeout_before_apply')
			throw new cassandra.errors.OperationTimedOutError('In-memory LWT timeout before apply');
		const result = this.runQuery<T>(query);
		if (fault === 'apply_then_timeout')
			throw new cassandra.errors.OperationTimedOutError('In-memory LWT timeout after apply');
		await this.options.afterQuery?.(query, readOptions);
		return result;
	}

	private runQuery<T>(query: PreparedQuery): Array<T> {
		if (query.cql === 'SELECT toTimestamp(now()) AS coordinator_time FROM system.local') {
			return [{coordinator_time: new Date()}] as Array<T>;
		}
		const meta = this.meta(query);
		const recordedMeta = query.kvMeta ?? getKvMeta(query.cql);
		if (recordedMeta) this.executed.push(recordedMeta);
		switch (meta.action) {
			case 'select':
				return this.select(meta, query.params) as Array<T>;
			case 'count':
				return [{count: this.select(meta, query.params).length}] as Array<T>;
			case 'upsert':
				if (meta.ifNotExists) {
					return [{'[applied]': this.upsert(meta, query.params, true, /^INSERT\b/i.test(query.cql))}] as Array<T>;
				}
				this.upsert(meta, query.params, false, /^INSERT\b/i.test(query.cql));
				return [];
			case 'patch':
			case 'delete':
				if (meta.conditions) {
					return [{'[applied]': this.mutateConditionally(meta, query.params)}] as Array<T>;
				}
				if (meta.action === 'patch') {
					this.patch(meta, query.params);
				} else {
					this.delete(meta, query.params);
				}
				return [];
			case 'batch':
				if (meta.batchEntries) {
					return [{'[applied]': this.mutateBatchConditionally(meta, query.params)}] as Array<T>;
				}
				return [];
		}
		return [];
	}

	async executeBatch(
		queries: Array<{query: string; params: object; meta?: KvQueryMeta}>,
		atomic?: boolean,
	): Promise<void> {
		this.batchAtomicity.push(atomic ?? true);

		for (const query of queries) {
			if (isConditionalQuery({cql: query.query, params: query.params as CassandraParams, kvMeta: query.meta})) {
				throw new Error('Conditional writes must use executeConditional to preserve their result');
			}
		}
		for (const query of queries) {
			await this.executeQuery({
				cql: query.query,
				params: query.params as CassandraParams,
				kvMeta: query.meta,
			});
		}
	}

	private rowFromParams(meta: KvQueryMeta, params: CassandraParams): Row {
		const row: Row = {};
		for (const column of meta.table.columns) {
			if (column in params) {
				row[column] = cloneValue(params[column]);
			}
		}
		if (meta.nowColumn) {
			row[meta.nowColumn] = new Date();
		}
		return row;
	}

	private keyFromParams(meta: KvQueryMeta, params: CassandraParams): string {
		const row: Row = {};
		for (const column of meta.pkColumns ?? meta.table.primaryKey) {
			row[column] = params[column];
		}
		return pkKey(meta, row);
	}

	private timestamp(meta: KvQueryMeta, params: CassandraParams): bigint {
		if (meta.timestampParamName) {
			const timestamp = params[meta.timestampParamName];
			if (typeof timestamp !== 'bigint') throw new Error('In-memory Cassandra timestamp must be bigint');
			return timestamp;
		}
		const now = BigInt(Date.now()) * 1000n;
		this.clock = now > this.clock ? now : this.clock + 1n;
		return this.clock;
	}

	private timestampedTable(meta: KvQueryMeta): Map<string, TimestampedRow> {
		let table = this.timestampedTables.get(meta.table.name);
		if (!table) {
			table = new Map();
			this.timestampedTables.set(meta.table.name, table);
		}
		return table;
	}

	private writeCells(meta: KvQueryMeta, values: Row, timestamp: bigint, insert = false): void {
		const key = pkKey(meta, values);
		const table = this.timestampedTable(meta);
		const stored = table.get(key) ?? {
			pk: Object.fromEntries(meta.table.primaryKey.map((column) => [column, cloneValue(values[column])])),
			cells: new Map<string, Cell>(),
		};
		if (insert && (stored.liveAt === undefined || timestamp > stored.liveAt)) stored.liveAt = timestamp;
		for (const column of meta.table.columns) {
			if (meta.table.primaryKey.includes(column) || !(column in values)) continue;
			const value = values[column] ?? null;
			const previous = stored.cells.get(column);
			if (previous && timestamp < previous.timestamp) continue;
			if (previous && timestamp === previous.timestamp) {
				if (previous.value === null) continue;
				if (value !== null && Buffer.compare(cellBytes(value), cellBytes(previous.value)) <= 0) continue;
			}
			stored.cells.set(column, {value: cloneValue(value), timestamp});
		}
		table.set(key, stored);
		this.materialize(meta, key, stored);
	}

	private materialize(meta: KvQueryMeta, key: string, stored: TimestampedRow): void {
		const row = cloneRow(stored.pk);
		let live = stored.liveAt !== undefined && (stored.deletedAt === undefined || stored.liveAt > stored.deletedAt);
		for (const [column, cell] of stored.cells) {
			const visible = stored.deletedAt === undefined || cell.timestamp > stored.deletedAt;
			row[column] = visible ? cloneValue(cell.value) : null;
			if (visible && cell.value !== null) live = true;
		}
		if (live) this.table(meta).set(key, row);
		else this.table(meta).delete(key);
	}

	private upsert(meta: KvQueryMeta, params: CassandraParams, ifNotExists = false, insert = false): boolean {
		const table = this.table(meta);
		const next = this.rowFromParams(meta, params);
		const key = pkKey(meta, next);
		if (ifNotExists && table.has(key)) {
			return false;
		}
		// Micup: Limitation: implicit upserts retain legacy fixture rows; explicit timestamps use Cassandra liveness.
		this.writeCells(meta, next, this.timestamp(meta, params), insert || meta.timestampParamName === undefined);
		return true;
	}

	private mutateConditionally(meta: KvQueryMeta, params: CassandraParams): boolean {
		const table = this.table(meta);
		const key = this.keyFromParams(meta, params);
		const row = table.get(key);
		if (!matchesConditions(row, meta.conditions, params)) {
			return false;
		}
		if (meta.action === 'patch') {
			this.patch(meta, params);
		} else {
			this.delete({...meta, where: meta.table.primaryKey.map((col) => ({kind: 'eq', col, param: col}))}, params);
		}
		return true;
	}

	private mutateBatchConditionally(meta: KvQueryMeta, params: CassandraParams): boolean {
		const entries = meta.batchEntries;
		if (!entries?.length) {
			throw new Error('Conditional batches require at least one entry');
		}
		const table = this.table(meta);
		const updates = new Map<string, {row: Row; insert: boolean} | null>();
		for (const entry of entries) {
			const pk = Object.fromEntries(entry.pk.map(({col, param}) => [col, params[param]]));
			const key = pkKey(meta, pk);
			if (updates.has(key)) throw new Error('Conditional batches cannot repeat a row');
			const row = table.get(key);
			if (entry.action === 'insert') {
				if (row) return false;
			} else {
				if (!matchesConditions(row, entry.conditions, params)) return false;
				if (entry.action === 'delete') {
					updates.set(key, null);
					continue;
				}
			}
			const updated = {...pk};
			for (const {col, param} of entry.action === 'insert' ? entry.values : entry.patch) {
				updated[col] = cloneValue(params[param]);
			}
			updates.set(key, {row: updated, insert: entry.action === 'insert'});
		}
		const timestamp = this.timestamp(meta, params);
		for (const [key, update] of updates) {
			if (update === null) {
				const stored = this.timestampedTable(meta).get(key)!;
				stored.deletedAt = timestamp;
				this.materialize(meta, key, stored);
			} else this.writeCells(meta, update.row, timestamp, update.insert);
		}
		return true;
	}

	private patch(meta: KvQueryMeta, params: CassandraParams): void {
		const row = this.rowFromParams({...meta, table: {...meta.table, columns: meta.table.primaryKey}}, params);
		for (const column of meta.patchKeys ?? []) {
			row[column] = column in params ? cloneValue(params[column]) : null;
		}
		this.writeCells(meta, row, this.timestamp(meta, params));
	}

	private delete(meta: KvQueryMeta, params: CassandraParams): void {
		const table = this.timestampedTable(meta);
		const timestamp = this.timestamp(meta, params);
		if (meta.table.primaryKey.every((column) => column in params)) {
			const pk = Object.fromEntries(meta.table.primaryKey.map((column) => [column, cloneValue(params[column])]));
			const key = pkKey(meta, pk);
			if (!table.has(key)) table.set(key, {pk, cells: new Map()});
		}
		for (const [key, stored] of table) {
			if (matchesWhere(stored.pk, meta.where, params)) {
				if (stored.deletedAt === undefined || timestamp > stored.deletedAt) stored.deletedAt = timestamp;
				this.materialize(meta, key, stored);
			}
		}
	}

	private select(meta: KvQueryMeta, params: CassandraParams): Array<Row> {
		let rows = [...this.table(meta).values()]
			.filter((row) => matchesWhere(row, meta.where, params))
			.sort(rowComparator(meta));
		if (typeof meta.limit === 'number') {
			rows = rows.slice(0, meta.limit);
		}
		return rows.map((row) => {
			const projected = projectRow(row, meta.columns);
			const stored = this.timestampedTable(meta).get(pkKey(meta, row));
			for (const [column, alias] of Object.entries(meta.writeTime ?? {})) {
				if (typeof alias !== 'string') throw new Error('In-memory WRITETIME requires an alias');
				const cell = stored?.cells.get(column);
				projected[alias] = row[column] == null ? null : (cell?.timestamp ?? null);
			}
			return projected;
		});
	}
}
