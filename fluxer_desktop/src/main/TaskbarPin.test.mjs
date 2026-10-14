// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import vm from 'node:vm';
import {loadMainModule} from './WinShellTestHarness.mjs';

const require = createRequire(import.meta.url);

function harness({platform = 'win32', trusted = true, focused = true, nativeRequest} = {}) {
	const handlers = new Map();
	const calls = [];
	const window = {
		webContents: {},
		isDestroyed: () => false,
		isFocused: () => focused,
		isMinimized: () => false,
		getNativeWindowHandle: () => Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]),
	};
	const native = {
		getTaskbarPinState: async () => ({supported: true, pinned: false, lafRequired: false}),
		requestTaskbarPin: (handle) => {
			calls.push(handle);
			return nativeRequest ? nativeRequest() : Promise.resolve(true);
		},
	};
	const module = {exports: {}};
	const stubs = {
		'node:module': {createRequire: () => () => native},
		'electron-log': {warn() {}},
		'@electron/main/PrivilegedRendererDocuments': {
			requirePrivilegedRendererDocumentSender: () => {
				if (!trusted) throw new Error('untrusted document');
			},
		},
		electron: {ipcMain: {handle: (channel, callback) => handlers.set(channel, callback)}},
	};
	stubs['@electron/main/WinShell'] = loadMainModule('WinShell', stubs, {platform});
	const source = readFileSync(new URL('./TaskbarPin.ts', import.meta.url), 'utf8');
	const transformed = require('esbuild').transformSync(source, {loader: 'ts', format: 'cjs'}).code;
	vm.runInNewContext(transformed, {
		module,
		exports: module.exports,
		process: {platform},
		require: (name) => {
			assert.ok(name in stubs, name);
			return stubs[name];
		},
	});
	module.exports.registerTaskbarPinIpcHandlers(() => window);
	return {
		calls,
		handlers,
		state: () => handlers.get('taskbar-pin:get-state')({sender: window.webContents}),
		request: (sender = window.webContents) => handlers.get('taskbar-pin:request')({sender}),
	};
}

test('registers taskbar API only on Windows', () => {
	assert.equal(harness({platform: 'darwin'}).handlers.size, 0);
	assert.equal(harness({platform: 'linux'}).handlers.size, 0);
});

test('queries state without requesting a pin', async () => {
	const h = harness();
	assert.deepEqual(await h.state(), {supported: true, pinned: false, lafRequired: false});
	assert.equal(h.calls.length, 0);
});

test('requires trusted renderer for state and request', async () => {
	const h = harness({trusted: false});
	await assert.rejects(async () => h.state(), /untrusted/);
	await assert.rejects(async () => h.request(), /untrusted/);
	assert.equal(h.calls.length, 0);
});

test('rejects other windows and an unfocused main window', async () => {
	const h = harness();
	await assert.rejects(async () => h.request({}), /main window/);
	const background = harness({focused: false});
	await assert.rejects(async () => background.request(), /foreground/);
	assert.equal(background.calls.length, 0);
});

test('passes main window HWND to native synchronously on user request', async () => {
	const h = harness();
	const pending = h.request();
	assert.equal(h.calls.length, 1);
	assert.deepEqual(h.calls[0], Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]));
	assert.equal(await pending, true);
});

test('prevents concurrent prompts and permits retry after native errors', async () => {
	let reject;
	const h = harness({
		nativeRequest: () =>
			reject
				? Promise.resolve(false)
				: new Promise((_resolve, fail) => {
						reject = fail;
					}),
	});
	const pending = h.request();
	await assert.rejects(async () => h.request(), /already/);
	reject(new Error('Windows rejected request'));
	await assert.rejects(pending, /Windows rejected/);
	assert.equal(await h.request(), false);
	await assert.rejects(async () => h.request(), /already requested/);
	assert.equal(h.calls.length, 2);
});

test('permits at most one native request per session after acceptance or denial', async () => {
	for (const result of [true, false]) {
		const h = harness({nativeRequest: async () => result});
		assert.equal(await h.request(), result);
		await assert.rejects(async () => h.request(), /already requested/);
		assert.equal(h.calls.length, 1);
	}
});
