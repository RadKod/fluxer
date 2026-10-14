// SPDX-License-Identifier: AGPL-3.0-or-later

import {spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {defineTable} from '@app/api/database/CassandraTableDsl';
import {ensurePostgresKvSchema, PostgresKvQueryExecutor} from '@app/api/database/PostgresKvQueryExecutor';
import {MAX_TOKEN, MIN_TOKEN, scanByTokenRanges, splitTokenRing} from '@app/api/database/TokenRangeScan';
import {startDockerContainer} from '@app/api/test/DockerTestContainer';
import {MockKVProvider} from '@app/api/test/mocks/MockKVProvider';
import {
	getDefaultPostgresClient,
	type IPostgresClient,
	initPostgres,
	shutdownPostgres,
} from '@pkgs/postgres/src/Client';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

interface ProbeRow {
	id: bigint;
	value: string;
}

const Probe = defineTable<ProbeRow, 'id'>({
	name: 'token_range_probe',
	columns: ['id', 'value'],
	primaryKey: ['id'],
});
const RANGE_QUERY = Probe.select({where: Probe.where.tokenRange('id', 'token_start', 'token_end')});
const PAGE_SIZE = 5;
const CONTAINER = `fluxer-kvtoken-${process.pid.toString(36)}-${Date.now().toString(36)}`;
const dockerAvailable = spawnSync('docker', ['version'], {stdio: 'ignore'}).status === 0;

// Keys spread over the whole signed range plus every range boundary of the 7 and 64 splits, on both sides.
const IDS = [
	...new Set([
		MIN_TOKEN,
		MAX_TOKEN,
		...Array.from({length: 150}, (_, i) => MIN_TOKEN + (2n ** 64n * BigInt(i)) / 150n),
		...[7, 64].flatMap((n) => splitTokenRing(n).flatMap((range) => [range.start, range.end])),
	]),
];

async function seed(executor: PostgresKvQueryExecutor): Promise<void> {
	for (const id of IDS) await executor.executeQuery(Probe.upsertAll({id, value: `v${id}`}));
}

async function servedCounts(executor: PostgresKvQueryExecutor, ranges: number): Promise<Map<bigint, number>> {
	const served = new Map<bigint, number>();
	await scanByTokenRanges<ProbeRow>({
		job: `kv-token-range-${ranges}`,
		ranges,
		concurrency: 4,
		kv: new MockKVProvider(),
		page: (range, pageState) =>
			executor.executePagedQuery<ProbeRow>(RANGE_QUERY.bind({token_start: range.start, token_end: range.end}), {
				pageSize: PAGE_SIZE,
				pageState,
			}),
		onRows: async (rows) => {
			for (const row of rows) served.set(row.id, (served.get(row.id) ?? 0) + 1);
		},
	});
	return served;
}

function expectEveryIdOnce(served: Map<bigint, number>): void {
	expect([...served.entries()].filter(([, count]) => count !== 1)).toEqual([]);
	expect(new Set(served.keys())).toEqual(new Set(IDS));
}

function numericKey(rowKey: string): bigint {
	return BigInt((JSON.parse(rowKey) as {value: string}).value);
}

// Stands in for Postgres: stores upserts and answers the bounded numeric index scan; any other read is a full scan.
function fakeKvClient(): {client: IPostgresClient; fullScans: () => number} {
	const stored = new Map<string, unknown>();
	let fullScans = 0;
	const all = () => [...stored].map(([row_key, row_data]) => ({row_key, row_data}));
	const client = {
		async query(text: string, values: Array<unknown> = []) {
			if (text.startsWith('INSERT')) {
				stored.set(values[2] as string, JSON.parse(values[3] as string));
				return {rows: [], rowCount: 1};
			}
			if (!text.includes('<= $5::numeric')) {
				fullScans += 1;
				return {rows: all(), rowCount: stored.size};
			}
			const [, after, afterKey, limit, upper] = values as [string, string, string, number, string];
			const key = (row: {row_key: string}) => numericKey(row.row_key);
			const rows = all()
				.filter((row) => key(row) <= BigInt(upper))
				.filter((row) => key(row) > BigInt(after) || (key(row) === BigInt(after) && row.row_key > afterKey))
				.sort((a, b) => (key(a) === key(b) ? 0 : key(a) < key(b) ? -1 : 1))
				.slice(0, limit);
			return {rows, rowCount: rows.length};
		},
		async connect() {},
		async shutdown() {},
		isConnected: () => true,
		async transaction(fn: (db: unknown) => Promise<unknown>) {
			return fn(client);
		},
		kvTable: () => 'kv_token_range',
	};
	return {client: client as never, fullScans: () => fullScans};
}

describe('Postgres KV token range pages', () => {
	it.each([1, 7, 64])('serves every key exactly once across %i ranges from the numeric index', async (ranges) => {
		const {client, fullScans} = fakeKvClient();
		const executor = new PostgresKvQueryExecutor(client);
		await seed(executor);
		expectEveryIdOnce(await servedCounts(executor, ranges));
		expect(fullScans()).toBe(0);
	});
});

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (typeof address === 'string' || address === null) {
				reject(new Error('no port'));
				return;
			}
			const port = address.port;
			server.close(() => resolve(port));
		});
	});
}

describe.skipIf(!dockerAvailable)('Postgres KV token range pages against postgres', () => {
	let executor: PostgresKvQueryExecutor;

	beforeAll(async () => {
		const port = await freePort();
		startDockerContainer([
			'run',
			'-d',
			'--name',
			CONTAINER,
			'-e',
			'POSTGRES_USER=fluxer',
			'-e',
			'POSTGRES_PASSWORD=fluxer',
			'-e',
			'POSTGRES_DB=fluxer',
			'-p',
			`127.0.0.1:${port}:5432`,
			'postgres:16-alpine',
			'-c',
			'fsync=off',
		]);
		let ready = false;
		for (let attempt = 0; attempt < 180 && !ready; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 500));
			const probe = spawnSync('docker', ['exec', CONTAINER, 'pg_isready', '-U', 'fluxer', '-d', 'fluxer'], {
				stdio: 'ignore',
			});
			if (probe.status !== 0) continue;
			try {
				await initPostgres({
					url: `postgres://fluxer:fluxer@127.0.0.1:${port}/fluxer`,
					maxConnections: 1,
					kvTable: 'kv_token_range',
				});
				await getDefaultPostgresClient().query('SELECT 1');
				ready = true;
			} catch {
				await shutdownPostgres().catch(() => {});
			}
		}
		if (!ready) throw new Error('postgres never came up');
		await ensurePostgresKvSchema(getDefaultPostgresClient());
		executor = new PostgresKvQueryExecutor(getDefaultPostgresClient());
		await seed(executor);
	}, 900_000);

	afterAll(async () => {
		await shutdownPostgres().catch(() => {});
		spawnSync('docker', ['rm', '-f', CONTAINER], {stdio: 'ignore'});
	});

	it.each([1, 7, 64])('serves every key exactly once across %i ranges', async (ranges) => {
		expectEveryIdOnce(await servedCounts(executor, ranges));
	});
});
