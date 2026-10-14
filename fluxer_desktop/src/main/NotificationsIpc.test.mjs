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

const sourcePath = fileURLToPath(new URL('./NotificationsIpc.ts', import.meta.url));
const source = readFileSync(sourcePath, 'utf8');
const transformedSource = esbuild.transformSync(source, {
	loader: 'ts',
	format: 'cjs',
	platform: 'node',
	target: 'node20',
}).code;

function loadNotificationsIpc() {
	const handlers = new Map();
	const listeners = new Map();
	const shown = [];
	let activationHandler = null;

	class FakeNotification extends EventEmitter {
		static isSupported() {
			return true;
		}
		static handleActivation(callback) {
			activationHandler = callback;
		}
		constructor(options) {
			super();
			this.options = options;
			this.closed = false;
			shown.push(this);
		}
		show() {}
		close() {
			this.closed = true;
		}
	}

	const windowCalls = [];
	const mainWindow = {
		isMinimized: () => false,
		restore: () => windowCalls.push('restore'),
		show: () => windowCalls.push('show'),
		focus: () => windowCalls.push('focus'),
		webContents: {send: (...args) => windowCalls.push(['send', ...args])},
	};

	const stubs = {
		'node:module': {createRequire: () => () => ({})},
		'@electron/common/DesktopIdentity': {DESKTOP_APP_NAME: 'Micup', LINUX_DESKTOP_ENTRY_ID: 'fluxer'},
		'@electron/common/Logger': {createChildLogger: () => ({warn() {}, info() {}, debug() {}})},
		'@electron/main/LinuxSandbox': {isFlatpakRuntime: () => false},
		'@electron/main/LaunchOptions': {getNativeNotificationsMode: () => 'auto'},
		'@electron/main/MainI18n': {t: (key) => key},
		'@electron/main/NotificationIcon': {resolveNotificationIcon: async () => null},
		'@electron/main/NotificationState': {shouldPlayNotificationSound: async () => true},
		'@electron/main/PrivilegedRendererDocuments': {requirePrivilegedRendererDocumentSender: () => {}},
		electron: {
			Notification: FakeNotification,
			nativeImage: {},
			ipcMain: {
				handle: (channel, handler) => handlers.set(channel, handler),
				on: (channel, listener) => listeners.set(channel, listener),
			},
		},
	};

	const module = {exports: {}};
	const context = vm.createContext({
		module,
		exports: module.exports,
		console,
		Buffer,
		process: {platform: 'win32', argv: []},
		require: (specifier) => {
			if (specifier in stubs) return stubs[specifier];
			throw new Error(`unexpected require ${specifier}`);
		},
	});
	vm.runInContext(transformedSource, context, {filename: sourcePath});
	module.exports.registerNotificationIpcHandlers(() => mainWindow);

	return {
		shown,
		windowCalls,
		getActivationHandler: () => activationHandler,
		showNotification: (options) => handlers.get('show-notification')({sender: {}}, options),
		closeNotification: (id) => listeners.get('close-notification')({}, id),
	};
}

describe('Windows notification clicks from Action Center', () => {
	test('keeps a timed-out toast tracked so it stays clickable and closable in Action Center', async () => {
		const harness = loadNotificationsIpc();
		await harness.showNotification({id: 'm1', title: 'Ayse (#genel)', body: 'selam', url: '/channels/1/2/3'});
		const [toast] = harness.shown;

		toast.emit('close', {reason: 'timedOut'});
		harness.closeNotification('m1');

		assert.equal(toast.closed, true);
	});

	test('releases the oldest Action Center handles beyond the per-app limit', async () => {
		const harness = loadNotificationsIpc();
		for (let i = 0; i <= 20; i++) {
			await harness.showNotification({id: `m${i}`, title: 't', body: 'b'});
			harness.shown[i].emit('close', {reason: 'timedOut'});
		}

		harness.closeNotification('m0');
		harness.closeNotification('m20');

		assert.equal(harness.shown[0].closed, false);
		assert.equal(harness.shown[20].closed, true);
	});

	test('still forgets a toast the user dismissed', async () => {
		const harness = loadNotificationsIpc();
		await harness.showNotification({id: 'm1', title: 't', body: 'b'});
		const [toast] = harness.shown;

		toast.emit('close', {reason: 'userCanceled'});
		harness.closeNotification('m1');

		assert.equal(toast.closed, false);
	});

	test('shows and focuses the main window for activations without a live Notification object', () => {
		const harness = loadNotificationsIpc();
		const onActivation = harness.getActivationHandler();

		assert.equal(typeof onActivation, 'function');
		onActivation({type: 'click', arguments: ''});

		assert.deepEqual(harness.windowCalls, ['show', 'focus']);
	});
});
