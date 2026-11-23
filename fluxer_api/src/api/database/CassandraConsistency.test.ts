// SPDX-License-Identifier: AGPL-3.0-or-later

import {resolveAllReadConsistency} from '@app/api/database/CassandraConsistency';
import {
	type CassandraConsistencyName,
	getDefaultCassandraClient,
	initCassandra,
	parseCassandraConsistency,
	parseCassandraSerialConsistency,
	shutdownCassandra,
} from '@pkgs/cassandra/src/Client';
import cassandra from 'cassandra-driver';
import {afterEach, describe, expect, it} from 'vitest';

const {consistencies} = cassandra.types;

describe('Cassandra consistency settings', () => {
	it('defaults to local levels so requests stay in the local data centre', () => {
		expect(parseCassandraConsistency(undefined)).toBe('localQuorum');
		expect(parseCassandraConsistency('  ')).toBe('localQuorum');
		expect(parseCassandraSerialConsistency(undefined)).toBe('localSerial');
	});

	it('accepts snake case, upper case and driver names', () => {
		expect(parseCassandraConsistency('local_one')).toBe('localOne');
		expect(parseCassandraConsistency('EACH_QUORUM')).toBe('eachQuorum');
		expect(parseCassandraConsistency('localQuorum')).toBe('localQuorum');
		expect(parseCassandraSerialConsistency('SERIAL')).toBe('serial');
		expect(parseCassandraSerialConsistency('local_serial')).toBe('localSerial');
	});

	it('rejects levels that do not exist or do not fit the setting', () => {
		expect(() => parseCassandraConsistency('two')).toThrow(/Unsupported Cassandra consistency/);
		expect(() => parseCassandraConsistency('serial')).toThrow(/Unsupported Cassandra consistency/);
		expect(() => parseCassandraSerialConsistency('quorum')).toThrow(/Unsupported Cassandra serial consistency/);
	});
});

describe('resolveAllReadConsistency', () => {
	it.each([
		[undefined, 'all'],
		['localOne', 'all'],
		['one', 'all'],
		['localQuorum', 'localQuorum'],
		['quorum', 'quorum'],
	] as const)('resolves an ALL read on a %s cluster to %s', (base, expected) => {
		expect(resolveAllReadConsistency(base)).toBe(expected);
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
		return {rows: []};
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

	it('applies the configured consistency to every query the driver runs', async () => {
		const fake = await connectFakeDriver('quorum');
		expect(fake.options['queryOptions']).toEqual({
			consistency: consistencies.quorum,
			serialConsistency: consistencies.localSerial,
		});
	});

	it('passes a per-call consistency to execute and batch', async () => {
		const fake = await connectFakeDriver('localQuorum');
		const client = getDefaultCassandraClient();
		await client.execute({cql: 'SELECT a FROM t WHERE k = :k', params: {k: 1}}, {consistency: 'quorum'});
		await client.batch([{cql: 'UPDATE t SET a = :a WHERE k = :k', params: {a: 1, k: 1}}], {consistency: 'quorum'});
		expect(fake.executions[0]?.options).toEqual({prepare: true, consistency: consistencies.quorum});
		expect(fake.batches[0]).toEqual({prepare: true, consistency: consistencies.quorum});
	});
});
