// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const source = require('esbuild').transformSync(
	readFileSync(new URL('./WindowsCaptureBorder.ts', import.meta.url), 'utf8'),
	{
		loader: 'ts',
		format: 'cjs',
		platform: 'node',
		target: 'node20',
	},
).code;

function load({
	platform = 'win32',
	store = true,
	release = '10.0.26100',
	marked = false,
	fail = false,
	writeFails = false,
} = {}) {
	const calls = {requests: 0, writes: 0, warnings: 0};
	const addon = {
		requestBorderlessAccess: async () => {
			calls.requests++;
			if (fail) throw new Error('access denied');
			return false;
		},
	};
	const module = {exports: {}};
	vm.runInNewContext(source, {
		module,
		exports: module.exports,
		process: {platform, windowsStore: store},
		require: (name) => {
			if (name === 'node:fs/promises')
				return {
					access: async () => {
						if (!marked) throw Object.assign(new Error('ENOENT'), {code: 'ENOENT'});
					},
					writeFile: async () => {
						calls.writes++;
						if (writeFails) throw new Error('EACCES');
						marked = true;
					},
				};
			if (name === 'node:os') return {release: () => release};
			if (name === 'node:path') return {join: (...parts) => parts.join('/')};
			if (name === 'node:module') return {createRequire: () => () => addon};
			if (name === 'electron') return {app: {getPath: () => 'test-user-data'}};
			if (name === 'electron-log') return {warn: () => calls.warnings++};
			throw new Error(`Unexpected import ${name}`);
		},
	});
	return {calls, request: module.exports.ensureWindowsCaptureBorderAccess};
}

test('first Windows 11 share requests once across simultaneous native and Chromium starts', async () => {
	const {calls, request} = load();
	await Promise.all([request(), request()]);
	await request();
	assert.equal(calls.requests, 1);
	assert.equal(calls.writes, 1);
});

test('prior attempt, Windows 10, unpackaged identity, and other platforms do not prompt', async () => {
	for (const options of [
		{marked: true},
		{release: '10.0.19045'},
		{release: 'unknown'},
		{store: false},
		{platform: 'linux'},
	]) {
		const {calls, request} = load(options);
		await request();
		assert.equal(calls.requests, 0);
		assert.equal(calls.writes, 0);
	}
});

test('API rejection does not reject sharing or request again', async () => {
	const {calls, request} = load({fail: true});
	await request();
	await request();
	assert.equal(calls.requests, 1);
	assert.equal(calls.warnings, 1);
});

test('marker failure skips prompt and leaves sharing usable', async () => {
	const {calls, request} = load({writeFails: true});
	await request();
	assert.equal(calls.requests, 0);
	assert.equal(calls.warnings, 1);
});
