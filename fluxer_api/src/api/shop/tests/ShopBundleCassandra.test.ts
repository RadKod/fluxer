// SPDX-License-Identifier: AGPL-3.0-or-later

import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import {createServer} from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createUserID} from '@app/api/BrandedTypes';
import {setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import {SHOP_PRICE_CATALOG, type ShopBundleRow, type ShopOrderRow} from '@app/api/database/types/ShopTypes';
import {ShopOrderRepository} from '@app/api/shop/ShopOrderRepository';
import {ShopPriceRepository} from '@app/api/shop/ShopPriceRepository';
import {startDockerContainer} from '@app/api/test/DockerTestContainer';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {initCassandra, shutdownCassandra} from '@pkgs/cassandra/src/Client';
import cassandra from 'cassandra-driver';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '../../../../..');
const CONTAINER = `fluxer-shop-bundle-${process.pid.toString(36)}-${Date.now().toString(36)}`;
const KEYSPACE = 'fluxer_shop_bundle';
const LOCAL_DC = 'datacenter1';
const TABLES = ['shop_bundles', 'shop_prices', 'shop_orders', 'shop_orders_by_user', 'shop_order_checks'];
const dockerAvailable = spawnSync('docker', ['version'], {stdio: 'ignore'}).status === 0;
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

function bundleRow(bundleId: bigint, itemIds: Array<bigint>): ShopBundleRow {
	return {
		catalog: SHOP_PRICE_CATALOG,
		bundle_id: bundleId,
		name: 'Melek',
		description: null,
		item_ids: itemIds,
		created_at: NOW,
		updated_at: NOW,
	};
}

function orderRow(orderId: bigint, sku: string, itemIds: Array<bigint> | null): ShopOrderRow {
	return {
		order_id: orderId,
		user_id: createUserID(1490000000000000100n),
		sku,
		item_id: null,
		item_ids: itemIds,
		premium_months: null,
		base_try_minor: 900,
		campaign_percent: 0,
		premium_percent: 0,
		amount_minor: 900,
		currency: 'TRY',
		status: 'pending',
		failure_reason: null,
		provider: 'payriff',
		provider_order_id: null,
		provider_status: null,
		payment_url: null,
		callback_token_hash: 'a'.repeat(64),
		check_count: 0,
		next_check_at: null,
		created_at: NOW,
		updated_at: NOW,
		paid_at: null,
		granted_at: null,
		version: 1,
	};
}

// frozen<list<bigint>> on real Cassandra 5.0: the in-memory executor keeps JavaScript arrays as
// they are, so only this run checks that the driver writes and reads the bundle and order item lists as bigints, in
// order, and that a missing list reads back as null.
describe.skipIf(!dockerAvailable)('Shop bundle item lists against Cassandra 5.0', () => {
	let admin: cassandra.Client | null = null;
	const prices = new ShopPriceRepository();
	const orders = new ShopOrderRepository();

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

	it('writes a bundle item list whole, in order, and deletes the bundle with its price', async () => {
		const bundleId = 1490000000000000500n;
		const first = bundleRow(bundleId, [1490000000000000203n, 1490000000000000201n, 1490000000000000202n]);
		await prices.putBundle(first);
		expect(await prices.getBundle(bundleId)).toEqual(first);

		const second = bundleRow(bundleId, [1490000000000000204n, 1490000000000000201n]);
		await prices.putBundle(second);
		expect((await prices.listBundles()).map((row) => row.item_ids)).toEqual([second.item_ids]);

		await prices.putPrices([
			{
				catalog: SHOP_PRICE_CATALOG,
				sku: `bundle:${bundleId}`,
				base_try_minor: 900,
				campaign_percent: null,
				campaign_ends_at: null,
				updated_at: NOW,
			},
		]);
		await prices.deleteBundle(bundleId);
		expect(await prices.getBundle(bundleId)).toBeNull();
		expect(await prices.getPrice(`bundle:${bundleId}`)).toBeNull();
	});

	it('keeps an order item list as bigints through writes of other columns, and null on a single-item order', async () => {
		const itemIds = [1490000000000000203n, 1490000000000000201n];
		expect(await orders.create(orderRow(1490000000000000600n, 'bundle:1490000000000000500', itemIds))).toBe(true);
		expect(await orders.patch(1490000000000000600n, {status: 'paid', paid_at: NOW}, 1)).toBe(true);
		expect(await orders.create(orderRow(1490000000000000601n, 'premium:1', null))).toBe(true);

		expect((await orders.find(1490000000000000600n))?.item_ids).toEqual(itemIds);
		expect((await orders.find(1490000000000000601n))?.item_ids).toBeNull();
	});
});
