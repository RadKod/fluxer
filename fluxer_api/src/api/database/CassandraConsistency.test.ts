// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {buildAPIConfigFromMaster, Config} from '@app/api/Config';
import {loadConnectionMembership} from '@app/api/connection/ConnectionMembership';
import {resolveReadConsistency} from '@app/api/database/CassandraConsistency';
import {setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {loadConfig, resetConfig} from '@fluxer/config/src/ConfigLoader';
import {
	type CassandraConsistencyName,
	getDefaultCassandraClient,
	initCassandra,
	shutdownCassandra,
} from '@pkgs/cassandra/src/Client';
import cassandra from 'cassandra-driver';
import {afterAll, afterEach, describe, expect, it, vi} from 'vitest';

const {consistencies} = cassandra.types;

describe('resolveReadConsistency', () => {
	it.each([
		['all', undefined, 'all'],
		['all', 'local_one', 'all'],
		['all', 'one', 'all'],
		['all', 'local_quorum', 'local_quorum'],
		['all', 'quorum', 'quorum'],
		['serial', 'local_quorum', 'serial'],
	] as const)('resolves a %s read on a %s cluster to %s', (requested, base, expected) => {
		expect(resolveReadConsistency(requested, base)).toBe(expected);
	});
});

class FakeDriverClient {
	static last: FakeDriverClient | null = null;
	readonly executions: Array<{cql: string; options: unknown}> = [];
	readonly batches: Array<unknown> = [];

	constructor(readonly options: Record<string, unknown>) {
		FakeDriverClient.last = this;
	}

	async connect(): Promise<void> {}

	async shutdown(): Promise<void> {}

	async execute(cql: string, _params: unknown, options: unknown): Promise<{rows: Array<Record<string, unknown>>}> {
		this.executions.push({cql, options});
		return {rows: cql.includes(' IF NOT EXISTS') ? [{'[applied]': true}] : []};
	}

	async batch(_queries: unknown, options: unknown): Promise<void> {
		this.batches.push(options);
	}
}

const realDriverClient = cassandra.Client;

async function connectFakeDriver(consistency?: CassandraConsistencyName): Promise<FakeDriverClient> {
	Reflect.set(cassandra, 'Client', FakeDriverClient);
	await initCassandra({
		hosts: ['10.77.0.1', '10.77.0.2', '10.77.0.3'],
		keyspace: 'fluxer',
		localDc: 'fsn1',
		consistency,
	});
	const fake = FakeDriverClient.last;
	if (fake === null) throw new Error('fake driver was not constructed');
	return fake;
}

describe('Cassandra client consistency', () => {
	afterEach(async () => {
		await shutdownCassandra();
		Reflect.set(cassandra, 'Client', realDriverClient);
	});

	it('keeps the driver default consistency when none is configured', async () => {
		const fake = await connectFakeDriver();
		const client = getDefaultCassandraClient();
		await client.execute({cql: 'SELECT a FROM t WHERE k = :k', params: {k: 1}});
		await client.batch([{cql: 'UPDATE t SET a = :a WHERE k = :k', params: {a: 1, k: 1}}]);
		expect(fake.options).not.toHaveProperty('queryOptions');
		expect(fake.executions[0]?.options).toEqual({prepare: true});
		expect(fake.batches[0]).toEqual({prepare: true});
	});

	it('applies the configured consistency to every query the driver runs', async () => {
		const fake = await connectFakeDriver('local_quorum');
		expect(fake.options['queryOptions']).toEqual({consistency: consistencies.localQuorum});
	});

	it('passes a per-call consistency to execute and batch', async () => {
		const fake = await connectFakeDriver('local_quorum');
		const client = getDefaultCassandraClient();
		await client.execute({cql: 'SELECT a FROM t WHERE k = :k', params: {k: 1}}, {consistency: 'quorum'});
		await client.batch([{cql: 'UPDATE t SET a = :a WHERE k = :k', params: {a: 1, k: 1}}], {consistency: 'quorum'});
		expect(fake.executions[0]?.options).toEqual({prepare: true, consistency: consistencies.quorum});
		expect(fake.batches[0]).toEqual({prepare: true, consistency: consistencies.quorum});
	});
});

describe('connection membership bootstrap reads', () => {
	const configuredConsistency = Config.cassandra.consistency;

	afterEach(async () => {
		Config.cassandra.consistency = configuredConsistency;
		await shutdownCassandra();
		Reflect.set(cassandra, 'Client', realDriverClient);
		setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor());
	});

	async function bootstrapReadConsistencies(
		consistency: CassandraConsistencyName | undefined,
	): Promise<Array<unknown>> {
		Config.cassandra.consistency = consistency;
		setCassandraQueryExecutorForTesting(null);
		const fake = await connectFakeDriver(consistency);
		await loadConnectionMembership(createUserID(1_900_000_000_000_000_001n));
		return fake.executions.flatMap((call) => {
			const requested = (call.options as {consistency?: number}).consistency;
			return requested === undefined ? [] : [requested];
		});
	}

	it('reads the bootstrap at ALL when no consistency is configured', async () => {
		expect(await bootstrapReadConsistencies(undefined)).toEqual([consistencies.serial, consistencies.all]);
	});

	it('reads the bootstrap at LOCAL_QUORUM so one replica down on RF=3 does not break it', async () => {
		expect(await bootstrapReadConsistencies('local_quorum')).toEqual([consistencies.serial, consistencies.localQuorum]);
	});
});

describe('FLUXER_CASSANDRA_CONSISTENCY', () => {
	async function loadWithEnv(value: string | undefined) {
		vi.stubEnv('FLUXER_CASSANDRA_CONSISTENCY', value);
		resetConfig();
		return loadConfig();
	}

	afterEach(() => {
		vi.unstubAllEnvs();
		resetConfig();
	});

	afterAll(async () => {
		await loadConfig();
	});

	it('leaves the consistency unset when the variable is absent', async () => {
		const master = await loadWithEnv(undefined);
		expect(master.database.cassandra.consistency).toBeUndefined();
		expect(buildAPIConfigFromMaster(master).cassandra.consistency).toBeUndefined();
	});

	it('carries local_quorum from the environment into the API config', async () => {
		const master = await loadWithEnv('local_quorum');
		expect(buildAPIConfigFromMaster(master).cassandra.consistency).toBe('local_quorum');
	});

	it('rejects a consistency name the cluster must not run on', async () => {
		for (const value of ['all', 'LOCAL_QUORUM', '']) {
			await expect(loadWithEnv(value)).rejects.toThrow(`Invalid FLUXER_CASSANDRA_CONSISTENCY: ${value}`);
		}
	});
});
