// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {describe, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

function transform(fileName) {
	const path = fileURLToPath(new URL(fileName, import.meta.url));
	const code = esbuild.transformSync(readFileSync(path, 'utf8'), {
		loader: 'ts',
		format: 'cjs',
		platform: 'node',
		target: 'node20',
	}).code;
	return {path, code};
}

const overlay = transform('./GameOverlay.ts');
const layout = transform('./GameOverlayLayout.ts');

function runModule({path, code}, globals = {}) {
	const module = {exports: {}};
	vm.runInContext(code, vm.createContext({module, exports: module.exports, ...globals}), {filename: path});
	return module.exports;
}

class FakeWindow extends EventEmitter {
	constructor() {
		super();
		this.calls = [];
		this.visible = false;
		this.destroyed = false;
		this.webContents = new EventEmitter();
		this.webContents.setWindowOpenHandler = () => {};
	}
	setIgnoreMouseEvents(...args) {
		this.ignoreMouseEventsArgs = args;
	}
	setContentProtection() {}
	setAlwaysOnTop() {}
	setBounds(bounds) {
		this.calls.push(['setBounds', {...bounds}]);
	}
	hide() {
		this.visible = false;
		this.calls.push(['hide']);
	}
	showInactive() {
		this.visible = true;
		this.calls.push(['showInactive']);
	}
	isVisible() {
		return this.visible;
	}
	isDestroyed() {
		return this.destroyed;
	}
	destroy() {
		this.destroyed = true;
		this.emit('closed');
	}
}

function loadGameOverlay(platform = 'win32') {
	let listener = null;
	let senderAllowed = true;
	let opener = null;
	const timers = [];
	const stubs = {
		'@electron/main/GameOverlayLayout': runModule(layout),
		'@electron/main/LocalAppURL': {isLocalAppRendererDocumentURL: (url) => url === 'fluxer-app://app/'},
		'@electron/main/PrivilegedRendererDocuments': {
			requirePrivilegedRendererDocumentSender: () => {
				if (!senderAllowed) throw new Error('untrusted sender');
			},
		},
		electron: {
			ipcMain: {on: (_channel, callback) => (listener = callback)},
			screen: Object.assign(new EventEmitter(), {
				getPrimaryDisplay: () => ({bounds: {x: 0, y: 0, width: 1920, height: 1080}}),
			}),
		},
	};
	const exports = runModule(overlay, {
		process: {platform},
		require: (specifier) => {
			if (specifier in stubs) return stubs[specifier];
			throw new Error(`unexpected require ${specifier}`);
		},
		setTimeout: (callback, ms) => {
			const timer = {callback, ms, cleared: false};
			timers.push(timer);
			return timer;
		},
		clearTimeout: (timer) => {
			if (timer) timer.cleared = true;
		},
	});
	exports.registerGameOverlayIpcHandlers();
	return {
		exports,
		timers,
		hasLayoutListener: () => listener !== null,
		rejectSender: () => {
			senderAllowed = false;
		},
		send: (value, event = {sender: opener, senderFrame: opener?.mainFrame}) => listener(event, value),
		flush: () => {
			for (const timer of timers.splice(0)) {
				if (!timer.cleared) timer.callback();
			}
		},
		attach: (url = 'fluxer-app://app/') => {
			const window = new FakeWindow();
			opener = Object.assign(new EventEmitter(), {isDestroyed: () => false, getURL: () => url, mainFrame: {}});
			exports.attachGameOverlayWindow(window, opener);
			return window;
		},
		opener: () => opener,
	};
}

const visibleLayout = (height) => ({visible: true, corner: 'top-left', width: 56, height});

describe('GameOverlay window', () => {
	test('rejects an external opener', () => {
		assert.equal(loadGameOverlay().attach('https://example.com').isDestroyed(), true);
	});
	for (const event of ['destroyed', 'did-navigate', 'render-process-gone']) {
		test(`closes the overlay when the opener emits ${event}`, () => {
			const harness = loadGameOverlay();
			const window = harness.attach();
			harness.opener().emit(event);
			assert.equal(window.isDestroyed(), true);
		});
	}
	test('lets clicks through without forwarding mouse moves, so Windows installs no global mouse hook', () => {
		const window = loadGameOverlay().attach();

		assert.deepEqual(window.ignoreMouseEventsArgs, [true]);
	});
});

describe('GameOverlay IPC', () => {
	test('rejects IPC from a child frame of the opener', () => {
		const harness = loadGameOverlay();
		const window = harness.attach();
		harness.send(visibleLayout(100), {sender: harness.opener(), senderFrame: {}});
		harness.flush();
		assert.deepEqual(window.calls, []);
	});
	test('rejects IPC from a different renderer', () => {
		const harness = loadGameOverlay();
		const window = harness.attach();
		harness.send(visibleLayout(100), {sender: {}, senderFrame: harness.opener().mainFrame});
		harness.flush();
		assert.deepEqual(window.calls, []);
	});
	for (const platform of ['darwin', 'linux']) {
		test(`does not register Windows overlay IPC on ${platform}`, () => {
			assert.equal(loadGameOverlay(platform).hasLayoutListener(), false);
		});
	}

	test('ignores layouts from an untrusted sender', () => {
		const harness = loadGameOverlay();
		const window = harness.attach();
		harness.rejectSender();

		harness.send(visibleLayout(100));
		harness.flush();

		assert.deepEqual(window.calls, []);
	});

	test('coalesces layouts within 150 ms and applies only the last one once', () => {
		const harness = loadGameOverlay();
		const window = harness.attach();

		harness.send(visibleLayout(100));
		harness.send(visibleLayout(150));
		harness.send(visibleLayout(200));
		assert.equal(harness.timers.length, 1);
		assert.equal(harness.timers[0].ms, 150);
		harness.flush();

		assert.deepEqual(window.calls, [['setBounds', {x: 16, y: 16, width: 56, height: 200}], ['showInactive']]);
	});

	test('does not show a new overlay window with the layout of a closed one', () => {
		const harness = loadGameOverlay();
		const first = harness.attach();
		harness.send(visibleLayout(100));
		harness.flush();
		harness.send(visibleLayout(200));
		first.destroy();
		harness.flush();

		const second = harness.attach();
		harness.flush();

		assert.deepEqual(second.calls, []);
		assert.equal(second.visible, false);
	});
});
