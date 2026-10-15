// SPDX-License-Identifier: AGPL-3.0-or-later

import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import {createServer} from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {UserID} from '@app/api/BrandedTypes';
import {setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import {scanByTokenRanges} from '@app/api/database/TokenRangeScan';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import type {KVAccountDeletionQueueService} from '@app/api/infrastructure/KVAccountDeletionQueueService';
import type {KVActivityTracker} from '@app/api/infrastructure/KVActivityTracker';
import {startDockerContainer} from '@app/api/test/DockerTestContainer';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {UserRepository} from '@app/api/user/repositories/UserRepository';
import type {UserDeletionEligibilityService} from '@app/api/user/services/UserDeletionEligibilityService';
import {processInactivityDeletionsCore} from '@app/api/worker/tasks/ProcessInactivityDeletions';
import {initCassandra, shutdownCassandra} from '@pkgs/cassandra/src/Client';
import {TestEmailService} from '@pkgs/email/src/TestEmailService';
import {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import cassandra from 'cassandra-driver';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '../../../../..');
const CONTAINER = `fluxer-tokenscan-${process.pid.toString(36)}-${Date.now().toString(36)}`;
const KEYSPACE = 'fluxer_token_scan';
const LOCAL_DC = 'datacenter1';
const USER_COUNT = 5000;
const dockerAvailable = spawnSync('docker', ['version'], {stdio: 'ignore'}).status === 0;

interface SchemaTable {
	name: string;
	columns: Array<{name: string; type: string}>;
	primary_key: string;
	options: string;
}

function usersTableCql(): string {
	const schema = JSON.parse(
		fs.readFileSync(path.join(REPO_ROOT, 'tools/dev/cassandra_target_schema.json'), 'utf8'),
	) as {tables: Array<SchemaTable>};
	const users = schema.tables.find((table) => table.name === 'users');
	if (!users) throw new Error('users table missing from the target schema');
	const fields = [
		...users.columns.map((column) => `${column.name} ${column.type}`),
		`PRIMARY KEY ${users.primary_key}`,
	];
	return `CREATE TABLE IF NOT EXISTS ${KEYSPACE}.users (${fields.join(', ')})${users.options ? ` WITH ${users.options}` : ''}`;
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

describe.skipIf(!dockerAvailable)('token range user scans against Cassandra 5.0', () => {
	let admin: cassandra.Client | null = null;
	const userIds: Array<bigint> = Array.from({length: USER_COUNT}, (_, i) => 1_300_000_000_000_000_000n + BigInt(i));

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
		await admin.execute(usersTableCql());
		await cassandra.concurrent.executeConcurrent(
			admin,
			`INSERT INTO ${KEYSPACE}.users (user_id, username, discriminator) VALUES (?, ?, ?)`,
			userIds.map((id, i) => [id, `scan${i}`, i % 10_000]),
			{concurrencyLevel: 64},
		);
		setCassandraQueryExecutorForTesting(null);
		await initCassandra({hosts: ['127.0.0.1'], port, keyspace: KEYSPACE, localDc: LOCAL_DC});
	}, 900_000);

	afterAll(async () => {
		await shutdownCassandra().catch(() => {});
		await admin?.shutdown().catch(() => {});
		setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor());
		spawnSync('docker', ['rm', '-f', CONTAINER], {stdio: 'ignore'});
	});

	it('pages through token ranges and returns every user exactly once', async () => {
		const repository = new UserRepository(new MockKVProvider());
		const seen = new Map<string, number>();
		await scanByTokenRanges({
			job: 'integration-paging',
			ranges: 3,
			concurrency: 3,
			kv: new MockKVProvider(),
			page: async (range, pageState) => {
				const page = await repository.scanUsersTokenRangePage(range, 50, pageState);
				return {rows: page.users, pageState: page.pageState};
			},
			onRows: async (users) => {
				for (const user of users) seen.set(String(user.id), (seen.get(String(user.id)) ?? 0) + 1);
			},
		});
		expect(seen.size).toBe(USER_COUNT);
		expect([...seen.values()].filter((count) => count !== 1)).toEqual([]);
	});

	it('processes every user exactly once in the inactivity deletion job', async () => {
		const checked = new Map<string, number>();
		const activityTracker = {
			needsRebuild: async () => false,
			getActivities: async (ids: Array<UserID>) => {
				for (const id of ids) checked.set(String(id), (checked.get(String(id)) ?? 0) + 1);
				return new Map(ids.map((id) => [id, new Date()]));
			},
		} as unknown as KVActivityTracker;
		const kvClient = new MockKVProvider();
		const result = await processInactivityDeletionsCore({
			kvClient,
			userRepository: new UserRepository(kvClient),
			deletionQueueService: {} as KVAccountDeletionQueueService,
			gatewayService: {} as IGatewayService,
			emailService: new TestEmailService(),
			userUpdateDeps: {} as never,
			isEmailEnabled: async () => false,
			activityTracker,
			deletionEligibilityService: {} as UserDeletionEligibilityService,
		});
		expect(checked.size).toBe(USER_COUNT);
		expect([...checked.values()].filter((count) => count !== 1)).toEqual([]);
		expect(result).toEqual({warningsSent: 0, deletionsScheduled: 0, errors: 0});
		expect(await kvClient.get('job:processInactivityDeletions')).toBeNull();
	});
});
