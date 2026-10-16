// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const sourcePath = fileURLToPath(new URL('./GameActivityIpc.ts', import.meta.url));
const plain = (value) => JSON.parse(JSON.stringify(value));
const channels = [
	'get-capabilities',
	'configure',
	'get-state',
	'list-candidates',
	'add-rule',
	'list-rules',
	'remove-rule',
];
const requests = [
	undefined,
	{account_id: '123', generation: 1, enabled: true},
	{generation: 1},
	{generation: 1},
	{generation: 1, token: 'opaque', game_id: 'game'},
	{generation: 1},
	{generation: 1, rule_id: 'rule'},
];

function loadHarness({platform = 'win32'} = {}) {
	const handlers = new Map();
	const sent = [];
	const calls = [];
	const detectors = [];
	const frame = {url: 'https://trusted.test/channels/@me', detached: false, parent: null, processId: 1, routingId: 2};
	const sender = new EventEmitter();
	sender.mainFrame = frame;
	sender.isDestroyed = () => false;
	sender.send = (...args) => sent.push(plain(args));
	frame.send = (...args) => sent.push(plain(args));
	const mainWindow = {webContents: sender, isDestroyed: () => false};
	const event = {sender, senderFrame: frame};
	let detector;
	class FixtureDetector {
		constructor(options) {
			detectors.push(this);
			this.options = options;
			detector = this;
			this.generation = 0;
		}
		configure(request) {
			calls.push(['configure', plain(request)]);
			this.generation = request.generation;
			return {state: ['win32', 'darwin', 'linux'].includes(platform) ? 'ok' : 'unsupported'};
		}
		getState() {
			return {
				generation: this.generation,
				state: 'playing',
				activity: {game_id: 'game', started_at: 1, exe: 'private.exe'},
				fresh: true,
				pid: 42,
			};
		}
		listCandidates(cursor) {
			calls.push(['candidates', cursor]);
			return {state: 'ok', candidates: [{token: 'opaque', label: 'Application 1', exe: 'private.exe', pid: 42}]};
		}
		addRule(token, selection) {
			calls.push(['add', token, plain(selection)]);
			return Promise.resolve({state: 'unavailable'});
		}
		listRules() {
			return {state: 'ok', rules: [{rule_id: 'rule', game_id: 'game', exe: 'private.exe', path: 'private'}]};
		}
		removeRule(id) {
			calls.push(['remove', id]);
			return {state: 'ok'};
		}
		stop() {
			calls.push(['stop']);
		}
		emit(state) {
			this.options.onState(state);
		}
	}
	const typesPath = fileURLToPath(new URL('../common/GameActivityTypes.ts', import.meta.url));
	const typesModule = {exports: {}};
	vm.runInNewContext(esbuild.transformSync(readFileSync(typesPath, 'utf8'), {loader: 'ts', format: 'cjs'}).code, {
		module: typesModule,
		exports: typesModule.exports,
		Buffer,
		TextEncoder,
	});
	const stubs = {
		electron: {
			ipcMain: {handle: (name, handler) => handlers.set(name, handler), removeHandler: (name) => handlers.delete(name)},
		},
		'@electron/main/GameActivityDetection': {GameActivityDetection: FixtureDetector},
		'@electron/common/DesktopConfig': {getGameActivityRules: () => [], setGameActivityRules: () => {}},
		'@electron/common/GameActivityTypes': typesModule.exports,
		'@electron/main/PrivilegedRendererDocuments': {
			requirePrivilegedRendererDocumentSender: (incoming) => {
				if (
					!incoming.senderFrame ||
					incoming.senderFrame.detached ||
					incoming.senderFrame.parent ||
					!incoming.senderFrame.url.startsWith('https://trusted.test/')
				)
					throw new Error('untrusted document');
			},
		},
	};
	const module = {exports: {}};
	const code = esbuild.transformSync(readFileSync(sourcePath, 'utf8'), {
		loader: 'ts',
		format: 'cjs',
		target: 'node20',
	}).code;
	vm.runInNewContext(code, {
		module,
		exports: module.exports,
		Buffer,
		process: {platform},
		require: (name) => {
			assert.ok(name in stubs, `unexpected import: ${name}`);
			return stubs[name];
		},
	});
	module.exports.registerGameActivityIpcHandlers(() => mainWindow);
	const invoke = async (channel, request, incoming = event) => {
		const handler = handlers.get(`game-activity:${channel}`);
		assert.equal(typeof handler, 'function', `missing IPC channel: ${channel}`);
		return handler(incoming, request);
	};
	return {
		invoke,
		event,
		sender,
		frame,
		sent,
		calls,
		handlers,
		detectors,
		register: () => module.exports.registerGameActivityIpcHandlers(() => mainWindow),
		cleanup: module.exports.cleanupGameActivityIpc,
		get detector() {
			return detector;
		},
	};
}

const configure = (h, generation = 1, account_id = '123', enabled = true) =>
	h.invoke('configure', {account_id, generation, enabled});

test('untrusted_document_denied_on_every_channel', async () => {
	const h = loadHarness();
	await configure(h);
	for (const [index, channel] of channels.entries()) {
		await assert.rejects(
			h.invoke(channel, requests[index], {sender: h.sender, senderFrame: {...h.frame, url: 'https://evil.test/'}}),
			/untrusted|main renderer/,
		);
		await assert.rejects(h.invoke(channel, requests[index], {sender: {}, senderFrame: h.frame}), /main renderer/);
		await assert.rejects(
			h.invoke(channel, requests[index], {sender: h.sender, senderFrame: {...h.frame, parent: h.frame}}),
			/untrusted|main renderer/,
		);
	}
	h.frame.url = 'https://evil.test/';
	for (const [index, channel] of channels.entries()) {
		await assert.rejects(h.invoke(channel, requests[index]), /untrusted/);
	}
});

test('no_raw_process_fields_leave_main', async () => {
	const h = loadHarness();
	await configure(h);
	const state = await h.invoke('get-state', {generation: 1});
	assert.deepEqual(plain(state), {
		generation: 1,
		state: 'playing',
		activity: {game_id: 'game', started_at: 1},
		fresh: true,
	});
	assert.deepEqual(plain(await h.invoke('list-candidates', {generation: 1})), {
		state: 'ok',
		candidates: [{token: 'opaque', label: 'Application 1'}],
	});
	assert.deepEqual(plain(await h.invoke('list-rules', {generation: 1})), {
		state: 'ok',
		rules: [{rule_id: 'rule', game_id: 'game'}],
	});
	h.detector.emit(state);
	assert.deepEqual(h.sent.at(-1), ['game-activity:state', plain(state)]);
});

test('stale_generation_denied', async () => {
	const h = loadHarness();
	await configure(h, 2);
	await assert.rejects(configure(h, 1, '456'), /generation/);
	await assert.rejects(configure(h, 2, '456'), /generation/);
	for (const [index, channel] of channels.entries()) {
		if (index < 2) continue;
		await assert.rejects(h.invoke(channel, {...requests[index], generation: 1}), /generation/);
	}
	h.detector.emit({generation: 1, state: 'playing', activity: {game_id: 'old', started_at: 1}, fresh: true});
	assert.equal(h.sent.length, 0);
});

test('same_account_runtime_configuration_reuses_generation', async () => {
	const h = loadHarness();
	await configure(h, 2);
	assert.deepEqual(plain(await configure(h, 2, '123', false)), {state: 'ok'});
	await assert.rejects(h.invoke('list-candidates', {generation: 2}), /disabled/);
	assert.deepEqual(plain(await configure(h, 2, '123', true)), {state: 'ok'});
	assert.deepEqual(plain(await h.invoke('list-candidates', {generation: 2})), {
		state: 'ok',
		candidates: [{token: 'opaque', label: 'Application 1'}],
	});
});

test('logout_preserves_generation_account_binding', async () => {
	const h = loadHarness();
	await configure(h, 2);
	assert.deepEqual(plain(await configure(h, 2, null, false)), {state: 'ok'});
	await assert.rejects(h.invoke('list-candidates', {generation: 2}), /disabled/);
	await assert.rejects(configure(h, 2, '456'), /generation/);
	await configure(h, 2, '123');
	await configure(h, 3, '456');
	h.detector.emit({generation: 2, state: 'playing', activity: {game_id: 'old', started_at: 1}, fresh: true});
	assert.equal(h.sent.length, 0);
});

test('runtime_reconfigure_invalidates_pending_rule_response', async () => {
	const h = loadHarness();
	await configure(h, 2);
	let finish;
	h.detector.addRule = () =>
		new Promise((resolve) => {
			finish = resolve;
		});
	const pending = h.invoke('add-rule', {generation: 2, token: 'opaque', game_id: 'game'});
	await configure(h, 2, '123', false);
	finish({state: 'unavailable'});
	await assert.rejects(pending, /generation/);
});

test('candidates_require_explicit_request', async () => {
	const h = loadHarness();
	await configure(h);
	await h.invoke('get-state', {generation: 1});
	assert.equal(
		h.calls.some(([name]) => name === 'candidates'),
		false,
	);
	await h.invoke('list-candidates', {generation: 1});
	assert.equal(h.calls.filter(([name]) => name === 'candidates').length, 1);
	await configure(h, 2, '123', false);
	await assert.rejects(h.invoke('list-candidates', {generation: 2}), /disabled/);
});

test('expired_token_cannot_add_rule', async () => {
	const h = loadHarness();
	await configure(h);
	assert.deepEqual(plain(await h.invoke('add-rule', {generation: 1, token: 'expired', manual_name: 'Game'})), {
		state: 'unavailable',
	});
	await configure(h, 2, '456');
	await assert.rejects(h.invoke('add-rule', {generation: 1, token: 'opaque', game_id: 'game'}), /generation/);
});

test('payloads_reject_unknown_keys_and_unbounded_fields', async () => {
	const h = loadHarness();
	await configure(h);
	for (const [index, channel] of channels.entries()) {
		await assert.rejects(h.invoke(channel, {...requests[index], exe: 'private.exe'}), /payload/);
	}
	for (const request of [
		{generation: NaN},
		{generation: -1},
		{generation: 1.5},
		{generation: 1, cursor: 'x'.repeat(129)},
	]) {
		await assert.rejects(h.invoke('list-candidates', request), /payload/);
	}
	for (const request of [
		{generation: 1, token: 'opaque', game_id: 'game', manual_name: 'Game'},
		{generation: 1, token: 'opaque', manual_name: 'x'.repeat(65)},
		{generation: 1, token: 'opaque', manual_name: '\u202eGame'},
	]) {
		await assert.rejects(h.invoke('add-rule', request), /payload/);
	}
	await assert.rejects(configure(h, 2, 'not-an-account'), /payload/);
});

test('renderer_crash_stops_polling', async () => {
	const h = loadHarness();
	await configure(h);
	h.sender.emit('render-process-gone', {}, {reason: 'crashed'});
	assert.equal(h.calls.at(-1)[0], 'stop');
	h.detector.emit({generation: 1, state: 'idle', activity: null, fresh: true});
	assert.equal(h.sent.length, 0);
	await assert.rejects(h.invoke('get-state', {generation: 1}), /configured/);
});

test('navigation_and_document_replacement_clear_callbacks', async () => {
	const h = loadHarness();
	await configure(h);
	h.sender.emit('did-start-navigation', {}, 'https://trusted.test/reload', false, false);
	assert.notEqual(h.calls.at(-1)[0], 'stop');
	h.sender.emit('did-start-navigation', {}, 'https://trusted.test/reload', false, true);
	assert.equal(h.calls.at(-1)[0], 'stop');
	h.detector.emit({generation: 1, state: 'idle', activity: null, fresh: true});
	assert.equal(h.sent.length, 0);
	h.sender.mainFrame = {...h.frame, routingId: 3};
	await assert.rejects(configure(h, 1), /main renderer/);
	await h.invoke(
		'configure',
		{generation: 1, account_id: '456', enabled: true},
		{sender: h.sender, senderFrame: h.sender.mainFrame},
	);
});

test('events_require_the_same_privileged_document', async () => {
	const h = loadHarness();
	await configure(h);
	h.frame.url = 'https://evil.test/';
	h.detector.emit({generation: 1, state: 'idle', activity: null, fresh: true});
	assert.equal(h.sent.length, 0);
	assert.equal(h.calls.at(-1)[0], 'stop');
});

test('trusted_same_document_navigation_preserves_configuration', async () => {
	const h = loadHarness();
	await configure(h);
	h.frame.url = 'https://trusted.test/channels/123/456';
	h.sender.emit('did-start-navigation', {}, h.frame.url, true, true);
	h.detector.emit({generation: 1, state: 'idle', activity: null, fresh: true});
	assert.deepEqual(h.sent.at(-1), ['game-activity:state', {generation: 1, state: 'idle', activity: null, fresh: true}]);
	await h.invoke('get-state', {generation: 1});
});

test('shutdown_cleans_owned_work', async () => {
	const h = loadHarness();
	await configure(h);
	h.cleanup();
	h.cleanup();
	assert.equal(h.calls.at(-1)[0], 'stop');
	assert.equal(h.handlers.size, 0);
	assert.equal(h.sender.listenerCount('did-start-navigation'), 0);
	assert.equal(h.sender.listenerCount('render-process-gone'), 0);
	assert.equal(h.sender.listenerCount('destroyed'), 0);
	h.detector.emit({generation: 1, state: 'idle', activity: null, fresh: true});
	assert.equal(h.sent.length, 0);
});

test('unsupported_is_explicit', async () => {
	const h = loadHarness({platform: 'freebsd'});
	assert.deepEqual(plain(await h.invoke('get-capabilities')), {version: 1, supported: false, spotify: false});
	assert.deepEqual(plain(await configure(h)), {state: 'unsupported'});
});

for (const platform of ['win32', 'darwin', 'linux']) {
	test(`${platform}_reports_detection_and_spotify_support`, async () => {
		const h = loadHarness({platform});
		assert.deepEqual(plain(await h.invoke('get-capabilities')), {version: 1, supported: true, spotify: true});
		assert.deepEqual(plain(await configure(h)), {state: 'ok'});
	});
}

test('configure_forwards_the_optional_spotify_flag_and_rejects_other_values', async () => {
	const h = loadHarness({platform: 'darwin'});
	await h.invoke('configure', {account_id: '123', generation: 1, enabled: true, spotify: true});
	assert.deepEqual(h.calls.at(-1), ['configure', {account_id: '123', generation: 1, enabled: true, spotify: true}]);
	await h.invoke('configure', {account_id: '123', generation: 2, enabled: true});
	assert.deepEqual(h.calls.at(-1), ['configure', {account_id: '123', generation: 2, enabled: true}]);
	for (const spotify of ['yes', 1, null]) {
		await assert.rejects(
			h.invoke('configure', {account_id: '123', generation: 3, enabled: true, spotify}),
			/Invalid game activity payload/,
		);
	}
	await assert.rejects(
		h.invoke('configure', {account_id: '123', generation: 3, enabled: true, spotify: true, music: true}),
		/Invalid game activity payload/,
	);
});

function deferTeardown(h) {
	let finish;
	const stopped = new Promise((resolve) => {
		finish = resolve;
	});
	h.detector.stop = () => {
		h.calls.push(['stop']);
		return stopped;
	};
	h.sender.emit('did-start-navigation', {}, h.frame.url, false, true);
	return finish;
}

test('replacement_detector_waits_for_owned_job_teardown', async () => {
	const h = loadHarness();
	await configure(h);
	const finish = deferTeardown(h);
	const pending = configure(h, 1, '456');
	await Promise.resolve();
	assert.equal(h.detectors.length, 1);
	finish();
	await pending;
	assert.equal(h.detectors.length, 2);
});

for (const lifecycle of ['navigation', 'crash', 'destroyed', 'shutdown']) {
	test(`queued_configuration_cannot_resurrect_after_${lifecycle}`, async () => {
		const h = loadHarness();
		await configure(h);
		const finish = deferTeardown(h);
		const pending = configure(h, 1, '456');
		const denied = assert.rejects(pending, /document|registration/);
		if (lifecycle === 'navigation') h.sender.emit('did-start-navigation', {}, h.frame.url, false, true);
		if (lifecycle === 'crash') h.sender.emit('render-process-gone', {}, {reason: 'crashed'});
		if (lifecycle === 'destroyed') h.sender.emit('destroyed');
		if (lifecycle === 'shutdown') {
			h.cleanup();
			h.register();
		}
		finish();
		await denied;
		assert.equal(h.detectors.length, 1);
		assert.equal(h.sender.listenerCount('did-start-navigation'), 0);
		assert.equal(h.sender.listenerCount('render-process-gone'), 0);
		assert.equal(h.sender.listenerCount('destroyed'), 0);
	});
}

test('queued_configuration_revalidates_generation_after_teardown', async () => {
	const h = loadHarness();
	await configure(h);
	const finish = deferTeardown(h);
	const newer = configure(h, 2, '456');
	const older = configure(h, 1, '123');
	const denied = assert.rejects(older, /generation/);
	finish();
	await newer;
	await denied;
	assert.equal(h.detectors.length, 2);
});
