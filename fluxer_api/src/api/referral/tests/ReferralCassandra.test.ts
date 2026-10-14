// SPDX-License-Identifier: AGPL-3.0-or-later

import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import {createServer} from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createUserID} from '@app/api/BrandedTypes';
import {setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import {referralCheckShard, referralCheckSlot} from '@app/api/database/types/ReferralTypes';
import {ReferralRepository} from '@app/api/referral/ReferralRepository';
import {startDockerContainer} from '@app/api/test/DockerTestContainer';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {initCassandra, shutdownCassandra} from '@pkgs/cassandra/src/Client';
import cassandra from 'cassandra-driver';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '../../../../..');
const CONTAINER = `fluxer-referral-${process.pid.toString(36)}-${Date.now().toString(36)}`;
const KEYSPACE = 'fluxer_referral';
const LOCAL_DC = 'datacenter1';
const TABLES = [
	'referral_codes',
	'user_referral',
	'referrals_by_referrer',
	'referral_buckets_by_referrer',
	'referral_checks',
];
const dockerAvailable = spawnSync('docker', ['version'], {stdio: 'ignore'}).status === 0;
const REFERRER = createUserID(1490000000000000100n);
const NOW = new Date('2026-10-01T12:00:00.000Z');

interface SchemaTable {
	name: string;
	columns: Array<{name: string; type: string}>;
	primary_key: string;
	options: string;
}

function tableCql(name: string): string {
	const schema = JSON.parse(
		fs.readFileSync(path.join(REPO_ROOT, 'tools/dev/cassandra_target_schema.json'), 'utf8'),
	) as {tables: Array<SchemaTable>};
	const table = schema.tables.find((entry) => entry.name === name);
	if (!table) throw new Error(`${name} table missing from the target schema`);
	const fields = [
		...table.columns.map((column) => `${column.name} ${column.type}`),
		`PRIMARY KEY ${table.primary_key}`,
	];
	return `CREATE TABLE IF NOT EXISTS ${KEYSPACE}.${name} (${fields.join(', ')})${table.options ? ` WITH ${table.options}` : ''}`;
}

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

// The in-memory executor applies writes one at a time; only real Cassandra 5.0 shows that the LWTs decide once under
// concurrency, that IF code = null holds on a mapping row, and that a check row (with its IP) goes by its TTL.
describe.skipIf(!dockerAvailable)('Referral LWTs and TTL against Cassandra 5.0', () => {
	let admin: cassandra.Client | null = null;
	const repository = new ReferralRepository();

	beforeAll(async () => {
		const port = await freePort();
		startDockerContainer([
			'run',
			'-d',
			'--name',
			CONTAINER,
			'-e',
			'MAX_HEAP_SIZE=512M',
			'-e',
			'HEAP_NEWSIZE=128M',
			'-e',
			'JVM_EXTRA_OPTS=-Dcassandra.skip_wait_for_gossip_to_settle=0',
			'-p',
			`127.0.0.1:${port}:9042`,
			'cassandra:5.0',
		]);
		for (let attempt = 0; attempt < 300 && admin === null; attempt++) {
			const client = new cassandra.Client({
				contactPoints: ['127.0.0.1'],
				localDataCenter: LOCAL_DC,
				protocolOptions: {port},
				encoding: {useBigIntAsLong: true},
			});
			try {
				await client.connect();
				admin = client;
			} catch {
				await client.shutdown().catch(() => {});
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}
		}
		if (admin === null) throw new Error('cassandra never came up');
		await admin.execute(
			`CREATE KEYSPACE IF NOT EXISTS ${KEYSPACE} WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}`,
		);
		for (const table of TABLES) await admin.execute(tableCql(table));
		setCassandraQueryExecutorForTesting(null);
		await initCassandra({hosts: ['127.0.0.1'], port, keyspace: KEYSPACE, localDc: LOCAL_DC});
	}, 900_000);

	afterAll(async () => {
		await shutdownCassandra().catch(() => {});
		await admin?.shutdown().catch(() => {});
		setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor());
		spawnSync('docker', ['rm', '-f', CONTAINER], {stdio: 'ignore'});
	});

	it('LWT pending→valid once under concurrency', async () => {
		const refereeId = createUserID(1490000000000000201n);
		await repository.recordReferral(
			{refereeId, referrerId: REFERRER, referredAt: NOW, regIp: '203.0.113.7', riskBlocked: false},
			{dueAt: NOW, ttlSeconds: 3600},
		);
		const results = await Promise.all(
			Array.from({length: 8}, (_, n) =>
				repository.transitionState(refereeId, n % 2 ? 'valid' : 'rejected', n % 2 ? null : 'same_ip', NOW),
			),
		);
		expect(results.filter(Boolean)).toHaveLength(1);
		expect((await repository.getUserReferral(refereeId))?.state).not.toBe('pending');
	});

	it('own code set once under concurrency, on a new row and on a referred mapping', async () => {
		const referred = createUserID(1490000000000000202n);
		await repository.recordReferral(
			{refereeId: referred, referrerId: REFERRER, referredAt: NOW, regIp: '203.0.113.8', riskBlocked: false},
			{dueAt: NOW, ttlSeconds: 3600},
		);
		for (const [userId, prefix] of [
			[createUserID(1490000000000000300n), 'a'],
			[referred, 'b'],
		] as const) {
			const codes = Array.from({length: 4}, (_, n) => `${prefix}${n}`.padEnd(10, 'q'));
			const won = await Promise.all(
				codes.map(async (code) => {
					expect(await repository.insertCodeIfAbsent(code, userId, NOW)).toBe(true);
					return repository.setOwnCode(userId, code);
				}),
			);
			expect(won.filter(Boolean)).toHaveLength(1);
			const winner = codes[won.indexOf(true)]!;
			expect((await repository.getUserReferral(userId))?.code).toBe(winner);
			for (const code of codes) {
				expect(await repository.getCodeOwner(code)).toBe(code === winner ? userId : null);
			}
		}
		expect((await repository.getUserReferral(referred))?.referrer_id).toBe(REFERRER);
	});

	it('check TTL row expires', async () => {
		const refereeId = createUserID(1490000000000000203n);
		await repository.recordReferral(
			{refereeId, referrerId: REFERRER, referredAt: NOW, regIp: '203.0.113.9', riskBlocked: false},
			{dueAt: NOW, ttlSeconds: 2},
		);
		const slot = referralCheckSlot(NOW);
		const shard = referralCheckShard(refereeId);
		expect((await repository.listChecks(slot, shard, 10)).map((row) => row.reg_ip)).toEqual(['203.0.113.9']);
		await new Promise((resolve) => setTimeout(resolve, 3500));
		expect(await repository.listChecks(slot, shard, 10)).toEqual([]);
	});
});
