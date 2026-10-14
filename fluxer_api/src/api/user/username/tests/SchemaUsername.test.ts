// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {getTableMetadata} from '@app/api/database/CassandraMetaRegistry';
import {EMPTY_USER_ROW, USER_COLUMNS} from '@app/api/database/types/UserTypes';
import '@app/api/Tables';
import {describe, expect, it} from 'vitest';

const schema = JSON.parse(
	fs.readFileSync(
		fileURLToPath(new URL('../../../../../../tools/dev/cassandra_target_schema.json', import.meta.url)),
		'utf8',
	),
) as {
	tables: Array<{name: string; columns: Array<{name: string; type: string}>; primary_key: string; options: string}>;
};
const keys = {
	username_owners: ['user_id'],
	username_claims: ['username'],
	username_entitlements: ['user_id'],
	username_op_intents: ['bucket', 'day', 'user_id', 'op_id'],
	username_holds_by_bucket: ['bucket', 'username'],
};
const partitions = {
	username_owners: ['user_id'],
	username_claims: ['username'],
	username_entitlements: ['user_id'],
	username_op_intents: ['bucket', 'day'],
	username_holds_by_bucket: ['bucket'],
};
const cqlKeys = {
	username_owners: '((user_id))',
	username_claims: '((username))',
	username_entitlements: '((user_id))',
	username_op_intents: '((bucket, day), user_id, op_id)',
	username_holds_by_bucket: '((bucket), username)',
};

describe('username schema contract', () => {
	it.each(Object.entries(keys))('%s has matching DSL columns, primary key and durable rows', (name, key) => {
		const table = schema.tables.find((table) => table.name === name);
		expect(table).toBeDefined();
		expect(getTableMetadata(name)?.primaryKey).toEqual(key);
		expect(getTableMetadata(name)?.partitionKey).toEqual(partitions[name as keyof typeof partitions]);
		expect(table!.primary_key).toBe(cqlKeys[name as keyof typeof cqlKeys]);
		expect(getTableMetadata(name)?.columns.toSorted()).toEqual(table!.columns.map((column) => column.name).toSorted());
		expect(table!.options).not.toContain('default_time_to_live');
		expect(getTableMetadata(name)?.defaultTtlSeconds).toBeUndefined();
	});
	it('adds private user projection and monotonic hold timestamp', () => {
		expect(USER_COLUMNS).toContain('username_state');
		expect(EMPTY_USER_ROW.username_state).toBeNull();
		expect(schema.tables.find((table) => table.name === 'users')!.columns).toContainEqual({
			name: 'username_state',
			type: 'text',
		});
		expect(schema.tables.find((table) => table.name === 'username_claims')?.columns).toContainEqual({
			name: 'index_ts',
			type: 'bigint',
		});
	});
	it('persists old index keys and abort repair state with the owner operation', () => {
		const columns = schema.tables.find((table) => table.name === 'username_owners')?.columns;
		expect(columns).toBeDefined();
		expect(columns).toContainEqual({name: 'op_old_index_username', type: 'text'});
		expect(columns).toContainEqual({name: 'op_old_index_disc', type: 'int'});
		expect(columns).toContainEqual({name: 'op_phase', type: 'text'});
	});
	it('uses bigint fences and durable scalar operation references', () => {
		const owner = schema.tables.find((table) => table.name === 'username_owners')?.columns;
		for (const name of ['seq', 'owned_gen', 'last_proj_ts', 'op_seq', 'op_old_gen', 'op_proj_ts']) {
			expect(owner).toContainEqual({name, type: 'bigint'});
		}
		for (const name of ['op_id', 'op_grant_ref', 'op_old_grant_ref', 'op_anon_identity']) {
			expect(owner).toContainEqual({name, type: 'text'});
		}
		expect(schema.tables.find((table) => table.name === 'username_op_intents')?.columns).toContainEqual({
			name: 'day',
			type: 'date',
		});
	});
});
