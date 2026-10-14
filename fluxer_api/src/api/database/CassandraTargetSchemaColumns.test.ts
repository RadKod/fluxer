// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {getTableMetadata} from '@app/api/database/CassandraMetaRegistry';
import {beforeAll, describe, expect, it} from 'vitest';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(THIS_DIR, '../..');
const REPO_ROOT = path.resolve(SRC_ROOT, '../..');

const SCHEMA = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'tools/dev/cassandra_target_schema.json'), 'utf8')) as {
	tables: Array<{name: string; columns: Array<{name: string}>}>;
};
const SCHEMA_COLUMNS = new Map(SCHEMA.tables.map((table) => [table.name, new Set(table.columns.map((c) => c.name))]));

const DEFINE_TABLE_CALL = /\bdefineTable\s*[<(]/g;
const DEFINE_TABLE_NAME = /\bdefineTable\s*(?:<[^()]*>)?\s*\(\s*\{\s*name:\s*'([a-z0-9_]+)'/g;
const TEST_SOURCE = /(\.test\.ts$|(^|[\\/])(tests|__tests__)[\\/])/;

// Every non-test module that defines a table, with the table names it defines. fluxer-dev only adds what the target
// schema lists, so a column the code reads but the schema lacks fails every query on that table on Cassandra; the
// in-memory and Postgres KV executors accept any column, so no other unit test notices.
// TEMPORARY: columns come from the shared registry (isolate: false); a test that redefines a real table name with
// other columns would show up here, so tests reuse the row column constants (read_states does).
const TABLE_MODULES = fs
	.readdirSync(path.join(SRC_ROOT, 'api'), {recursive: true, encoding: 'utf8'})
	.filter((file) => file.endsWith('.ts') && !TEST_SOURCE.test(file) && !file.endsWith('CassandraTableDsl.ts'))
	.map((file) => {
		const source = fs.readFileSync(path.join(SRC_ROOT, 'api', file), 'utf8');
		return {
			file,
			calls: source.match(DEFINE_TABLE_CALL)?.length ?? 0,
			names: [...source.matchAll(DEFINE_TABLE_NAME)].map((match) => match[1]!),
		};
	})
	.filter(({calls}) => calls > 0);

describe('Cassandra target schema columns', () => {
	beforeAll(async () => {
		for (const {file} of TABLE_MODULES) {
			await import(`@app/api/${file.replace(/\\/g, '/').replace(/\.ts$/, '')}`);
		}
	});

	it('finds every table definition by a literal name', () => {
		const unnamed = TABLE_MODULES.filter(({calls, names}) => calls !== names.length).map(({file}) => file);
		expect(unnamed).toEqual([]);
		expect(TABLE_MODULES.flatMap(({names}) => names)).toContain('gift_codes');
	});

	it('lists every column the API reads or writes in the target schema', () => {
		const missing = TABLE_MODULES.flatMap(({names}) => names).flatMap((name) => {
			const target = SCHEMA_COLUMNS.get(name);
			if (!target) return [`${name}: table missing`];
			const columns = getTableMetadata(name)?.columns;
			if (!columns) return [`${name}: not registered`];
			return columns.filter((column) => !target.has(column)).map((column) => `${name}.${column}`);
		});
		expect([...new Set(missing)].sort()).toEqual([]);
	});
});
