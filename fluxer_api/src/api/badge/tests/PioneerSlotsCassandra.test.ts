// SPDX-License-Identifier: AGPL-3.0-or-later

import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import {createServer} from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createUserID} from '@app/api/BrandedTypes';
import {BadgeRepository} from '@app/api/badge/BadgeRepository';
import {PioneerRepository} from '@app/api/badge/PioneerRepository';
import {PioneerService} from '@app/api/badge/PioneerService';
import {setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import {startDockerContainer} from '@app/api/test/DockerTestContainer';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {MockKVProvider} from '@app/api/test/mocks/MockKVProvider';
import type {IUserRepository} from '@app/api/user/IUserRepository';
import type {WorkerTaskName} from '@app/api/worker/WorkerLaneConfig';
import {initCassandra, shutdownCassandra} from '@pkgs/cassandra/src/Client';
import type {IWorkerService} from '@pkgs/worker/src/contracts/IWorkerService';
import cassandra from 'cassandra-driver';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '../../../../..');
const CONTAINER = `fluxer-pioneer-${process.pid.toString(36)}-${Date.now().toString(36)}`;
const KEYSPACE = 'fluxer_pioneer';
const LOCAL_DC = 'datacenter1';
const TABLES = ['pioneer_by_user', 'pioneer_slots', 'pioneer_state', 'user_badges'];
const dockerAvailable = spawnSync('docker', ['version'], {stdio: 'ignore'}).status === 0;

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

// Öncü numbering on real Cassandra 5.0 Paxos: the in-memory executor applies each LWT atomically and returns no
// winning row, so only this run checks the lost-LWT answer and SERIAL reads.
describe.skipIf(!dockerAvailable)('Öncü slot claims against Cassandra 5.0', () => {
	let admin: cassandra.Client | null = null;
	const repository = new PioneerRepository();
	const service = new PioneerService({
		repository,
		badgeRepository: new BadgeRepository(),
		userRepository: {} as IUserRepository,
		kvClient: new MockKVProvider(),
		workerService: {} as IWorkerService<WorkerTaskName>,
	});

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

	it('40 claims racing eight at a time on real LWT give 1..40; duplicate jobs share one number', async () => {
		await repository.ensureState();
		await repository.setStatus('off', 'open', 777n);
		const users = Array.from({length: 40}, (_, i) => createUserID(BigInt(1000 + i)));
		// Eight at a time, as the lifecycle lane runs them; the first eight hold three duplicate pairs.
		const jobs = [users[0]!, users[0]!, users[1]!, users[1]!, users[2]!, users[2]!, ...users.slice(3)];
		const results: Array<number | null> = [];
		for (let i = 0; i < jobs.length; i += 8) {
			results.push(...(await Promise.all(jobs.slice(i, i + 8).map((user) => service.assign(user)))));
		}

		expect([results[1], results[3], results[5]]).toEqual([results[0], results[2], results[4]]);
		expect([results[0], results[2], results[4], ...results.slice(6)].sort((a, b) => a! - b!)).toEqual(
			Array.from({length: 40}, (_, i) => i + 1),
		);
	});
});
