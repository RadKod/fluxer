// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

function scripts(relativePath) {
	return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8')).scripts;
}

test('desktop main tests include the Windows Store manifest contract', () => {
	const desktop = scripts('../../fluxer_desktop/package.json');
	assert.match(desktop['test:main'], /node --test/);
	assert.ok(desktop['test:main'].includes('src/main/*.test.mjs'));
	assert.ok(desktop['test:main'].includes('packaging/windows/store/*.test.mjs'));
});

test('root tests run the CI contracts through a separately runnable CI test command', () => {
	const root = scripts('../../package.json');
	assert.match(root.test, /^pnpm test:ci && /);
	assert.equal(root['test:ci'], 'node --test "tools/ci/*.test.mjs"');
});
