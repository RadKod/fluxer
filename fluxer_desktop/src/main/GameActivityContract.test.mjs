// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {existsSync, readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, resolve} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {loadTsModule} from './fixtures/TsModuleLoader.mjs';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const plain = (value) => JSON.parse(JSON.stringify(value));

function loadCommon() {
	const path = new URL('../common/GameActivityTypes.ts', import.meta.url);
	if (!existsSync(path)) return {};
	const module = {exports: {}};
	vm.runInNewContext(esbuild.transformSync(readFileSync(path, 'utf8'), {loader: 'ts', format: 'cjs'}).code, {
		module,
		exports: module.exports,
		Buffer,
		TextEncoder,
	});
	return module.exports;
}

let preloadSource;
function bundledPreload() {
	preloadSource ??= esbuild.buildSync({
		entryPoints: [fileURLToPath(new URL('../preload/index.ts', import.meta.url))],
		bundle: true,
		write: false,
		external: ['electron'],
		format: 'cjs',
		platform: 'node',
		target: 'node20',
	}).outputFiles[0].text;
	return preloadSource;
}

export function loadPreload(invoke = async () => undefined) {
	let api;
	const listeners = new Map();
	const calls = [];
	const ipcRenderer = {
		invoke: (channel, ...args) => {
			calls.push([channel, ...args]);
			return invoke(channel, ...args);
		},
		on: (channel, handler) => listeners.set(channel, handler),
		removeListener: (channel, handler) => {
			if (listeners.get(channel) === handler) listeners.delete(channel);
		},
		send() {},
		sendSync: (channel) =>
			channel === 'desktop-capability-manifest:get'
				? Object.assign(Object.create(null), {appStore: false, gatewaySocket: false})
				: null,
	};
	const module = {exports: {}};
	vm.runInNewContext(bundledPreload(), {
		module,
		exports: module.exports,
		console,
		URL,
		TextEncoder,
		TextDecoder,
		setTimeout,
		clearTimeout,
		process: {platform: 'win32', argv: ['--fluxer-active-use-native-titlebar=1'], env: {}},
		window: {
			localStorage: {getItem: () => null, setItem() {}},
			location: {pathname: '/'},
			matchMedia: () => ({matches: false}),
			addEventListener() {},
		},
		document: {
			documentElement: {classList: {add() {}, remove() {}, toggle() {}}, style: {setProperty() {}}},
			body: null,
			addEventListener() {},
		},
		HTMLTextAreaElement: class {},
		require: (specifier) => {
			if (specifier === 'electron')
				return {
					ipcRenderer,
					contextBridge: {
						exposeInMainWorld: (_key, value) => {
							api = value;
						},
					},
					webFrame: {},
				};
			if (specifier === '@electron/common/BuildChannel') return {BUILD_CHANNEL: 'stable'};
			if (specifier === '@electron/common/GameActivityTypes') return loadCommon();
			if (specifier === '@fluxer/voice_engine_v2/bridge')
				return {VOICE_ENGINE_V2_HARDWARE_ENCODER_IPC_CHANNEL: 'voice:encoder'};
			throw new Error(`Unexpected import: ${specifier}`);
		},
	});
	return {api, calls, listeners};
}

const fixtures = [
	['gameActivityGetCapabilities', 'game-activity:get-capabilities', undefined],
	['gameActivityConfigure', 'game-activity:configure', {account_id: '123', generation: 1, enabled: true}],
	['gameActivityGetState', 'game-activity:get-state', {generation: 1}],
	['gameActivityListCandidates', 'game-activity:list-candidates', {generation: 1, cursor: 'opaque'}],
	['gameActivityAddRule', 'game-activity:add-rule', {generation: 1, token: 'opaque', game_id: 'test-game'}],
	['gameActivityListRules', 'game-activity:list-rules', {generation: 1}],
	['gameActivityRemoveRule', 'game-activity:remove-rule', {generation: 1, rule_id: 'opaque'}],
];

test('preload_v1_names_and_payloads_match_plan', async () => {
	const {api, calls} = loadPreload();
	for (const [method, channel, payload] of fixtures) {
		assert.equal(typeof api[method], 'function', method);
		await (payload === undefined ? api[method]() : api[method](payload));
		assert.deepEqual(plain(calls.at(-1)), payload === undefined ? [channel] : [channel, payload]);
	}
});

test('unsupported_is_explicit', async () => {
	const {api} = loadPreload(async (channel) =>
		channel.endsWith('capabilities') ? {version: 1, supported: false} : {state: 'unsupported'},
	);
	assert.equal(typeof api.gameActivityGetCapabilities, 'function');
	assert.deepEqual(plain(await api.gameActivityGetCapabilities()), {version: 1, supported: false});
	assert.deepEqual(plain(await api.gameActivityConfigure({account_id: '123', generation: 1, enabled: true})), {
		state: 'unsupported',
	});
});

test('on_state_unsubscribes', () => {
	const {api, listeners} = loadPreload();
	assert.equal(typeof api.onGameActivityState, 'function');
	const received = [];
	const unsubscribe = api.onGameActivityState((state) => received.push(state));
	const state = {generation: 1, state: 'playing', activity: {game_id: 'test-game', started_at: 123}, fresh: true};
	listeners.get('game-activity:state')({}, state);
	assert.deepEqual(plain(received), [state]);
	unsubscribe();
	assert.equal(listeners.has('game-activity:state'), false);
});

test('fresh_flag_required_for_renew', () => {
	const common = loadCommon();
	assert.equal(typeof common.isGameActivityState, 'function');
	const state = {generation: 1, state: 'playing', activity: {game_id: 'test-game', started_at: 123}};
	assert.equal(common.isGameActivityState(state), false);
	assert.equal(common.isGameActivityState({...state, fresh: true}), true);
	assert.equal(common.isGameActivityState({...state, fresh: false}), false);
	assert.equal(common.isGameActivityState({...state, fresh: true, pid: 123}), false);
});

test('logout_configure_clears_before_new_account', async () => {
	const {api, calls} = loadPreload();
	assert.equal(typeof api.gameActivityConfigure, 'function');
	await api.gameActivityConfigure({account_id: null, generation: 2, enabled: false});
	await api.gameActivityConfigure({account_id: '456', generation: 3, enabled: true});
	assert.deepEqual(plain(calls), [
		['game-activity:configure', {account_id: null, generation: 2, enabled: false}],
		['game-activity:configure', {account_id: '456', generation: 3, enabled: true}],
	]);
});

test('rules_list_and_remove_reveal_no_exe_path', () => {
	const common = loadCommon();
	assert.equal(typeof common.isGameActivityIdentity, 'function');
	assert.equal(common.isGameActivityIdentity({game_id: 'test-game'}), true);
	assert.equal(common.isGameActivityIdentity({manual_name: 'Türkçe 🎮'}), true);
	for (const value of [
		{game_id: 'test-game', exe: 'game.exe'},
		{manual_name: 'test', path: 'C:/game'},
		{game_id: 'test-game', manual_name: 'test'},
		{manual_name: '\u202etest'},
		{manual_name: 'x'.repeat(65)},
		{game_id: '../game'},
	])
		assert.equal(common.isGameActivityIdentity(value), false);
});

test('local_rule_storage_accepts_only_bounded_mapping_fields', () => {
	const common = loadCommon();
	assert.equal(typeof common.isGameActivityLocalRule, 'function');
	const rule = {rule_id: 'opaque-id', exe: 'game.exe', manual_name: 'Game'};
	assert.equal(common.isGameActivityLocalRule(rule), true);
	for (const value of [
		{...rule, pid: 123},
		{...rule, started_at: 123},
		{...rule, exe: 'C:/game.exe'},
		{...rule, exe: 'javaw.exe'},
	]) {
		assert.equal(common.isGameActivityLocalRule(value), false);
	}
});

test('desktop_config_rules_are_account_scoped_bounded_and_runtime_free', () => {
	let persisted;
	const module = {exports: {}};
	const contents = JSON.stringify({
		game_activity_rules: {123: [{rule_id: 'old', exe: 'game.exe', game_id: 'test-game', started_at: 1}]},
	});
	vm.runInNewContext(
		esbuild.transformSync(readFileSync(new URL('../common/DesktopConfig.ts', import.meta.url), 'utf8'), {
			loader: 'ts',
			format: 'cjs',
		}).code,
		{
			module,
			exports: module.exports,
			process: {pid: 1},
			require: (specifier) => {
				if (specifier === 'node:fs')
					return {
						existsSync: () => true,
						readFileSync: () => contents,
						writeFileSync: (_path, data) => {
							persisted = JSON.parse(data);
						},
						renameSync() {},
						rmSync() {},
					};
				if (specifier === '@electron/common/GameActivityTypes') return loadCommon();
				if (specifier === '@electron/common/BuildChannel') return {BUILD_CHANNEL: 'stable'};
				if (specifier === '@electron/common/Constants') return {};
				if (specifier === '@electron/common/GlobalShortcutActions') return loadTsModule(specifier);
				if (specifier === '@fluxer/instance_bootstrap/src/EndpointNormalization') {
					return {InstanceEndpointKind: {API: 'api'}, normalizeInstanceEndpoint: () => null};
				}
				if (specifier === 'electron-log') return {warn() {}, info() {}, error() {}, debug() {}};
				return require(specifier);
			},
		},
	);
	const config = module.exports;
	assert.equal(typeof config.getGameActivityRules, 'function');
	assert.equal(typeof config.setGameActivityRules, 'function');
	config.loadDesktopConfig('fixture-only');
	assert.deepEqual(plain(config.getGameActivityRules('123')), []);
	const rules = Array.from({length: 51}, (_, n) => ({rule_id: `id-${n}`, exe: 'game.exe', manual_name: 'Game'}));
	config.setGameActivityRules('123', rules);
	assert.equal(config.getGameActivityRules('123').length, 50);
	assert.deepEqual(plain(config.getGameActivityRules('456')), []);
	const detached = config.getGameActivityRules('123');
	detached[0].exe = 'changed.exe';
	assert.equal(config.getGameActivityRules('123')[0].exe, 'game.exe');
	assert.deepEqual(Object.keys(persisted), ['game_activity_rules']);
	assert.equal(JSON.stringify(persisted).includes('started_at'), false);
	assert.throws(() => config.setGameActivityRules('__proto__', rules));
});

export function loadIntegration({platform = 'win32'} = {}) {
	const root = fileURLToPath(new URL('../', import.meta.url));
	const handlers = new Map();
	const modules = new Map();
	const timers = new Map();
	const scans = [];
	const childProcesses = [];
	const sent = [];
	let monotonic = 0;
	let wallClock = 1_800_000_000_000;
	let persisted = {game_activity_rules: {}};
	let event;
	let renderer;
	const sender = new EventEmitter();
	sender.isDestroyed = () => false;
	const mainWindow = {webContents: sender, isDestroyed: () => false};
	const fakeFs = {
		existsSync: () => true,
		readFileSync: () => JSON.stringify(persisted),
		writeFileSync: (_path, contents) => {
			persisted = JSON.parse(contents);
		},
		renameSync() {},
		rmSync() {},
		realpathSync: (path) => path,
		statSync: () => ({isFile: () => true}),
	};
	const stubs = {
		electron: {
			ipcMain: {
				handle: (channel, callback) => handlers.set(channel, callback),
				removeHandler: (channel) => handlers.delete(channel),
			},
		},
		'@electron/main/Window': {isTrustedOrigin: (url) => new URL(url).origin === 'https://trusted.test'},
		'@electron/common/BuildChannel': {BUILD_CHANNEL: 'stable'},
		'@electron/common/Constants': {DESKTOP_APP_ORIGIN: 'sanalyer-app://app'},
		'electron-log': {warn() {}, info() {}, error() {}, debug() {}, transports: {file: {}, console: {}}},
		'node:fs': fakeFs,
		'node:perf_hooks': {performance: {now: () => monotonic}},
		'node:child_process': Object.fromEntries(
			['exec', 'execFile', 'spawn', 'fork'].map((name) => [
				name,
				() => {
					childProcesses.push(name);
					throw new Error('Child process prohibited');
				},
			]),
		),
		'@fluxer/win-shell': {
			listProcesses: () => new Promise((resolve, reject) => scans.push({resolve, reject})),
		},
	};
	stubs['node:module'] = {
		createRequire: () => (name) => {
			if (name in stubs) return stubs[name];
			throw new Error(`Unexpected native module: ${name}`);
		},
	};
	function load(path) {
		if (path.endsWith('.json')) return JSON.parse(readFileSync(path, 'utf8'));
		if (modules.has(path)) return modules.get(path).exports;
		const module = {exports: {}};
		modules.set(path, module);
		vm.runInNewContext(
			esbuild.transformSync(readFileSync(path, 'utf8'), {
				loader: 'ts',
				format: 'cjs',
				target: 'node20',
				supported: {'dynamic-import': false},
			}).code,
			{
				module,
				exports: module.exports,
				Buffer,
				TextEncoder,
				process: {platform, pid: 1},
				Date: class extends Date {
					static now() {
						return wallClock;
					}
				},
				setInterval: (callback, delay) => {
					const timer = {unref() {}};
					timers.set(timer, {callback, delay});
					return timer;
				},
				clearInterval: (timer) => timers.delete(timer),
				require: (name) => {
					if (Object.hasOwn(stubs, name)) return stubs[name];
					if (name.startsWith('@electron/')) return load(resolve(root, `${name.slice('@electron/'.length)}.ts`));
					if (name.startsWith('@fluxer/')) return load(require.resolve(`${name}.ts`));
					if (name.startsWith('.')) return load(resolve(dirname(path), name.endsWith('.json') ? name : `${name}.ts`));
					return require(name);
				},
			},
			{filename: path},
		);
		return module.exports;
	}
	const config = load(resolve(root, 'common/DesktopConfig.ts'));
	config.loadDesktopConfig('fixture-only');
	const ipc = load(resolve(root, 'main/GameActivityIpc.ts'));
	ipc.registerGameActivityIpcHandlers(() => mainWindow);
	function newRenderer(routingId = 2) {
		const frame = {url: 'https://trusted.test/channels/@me', detached: false, parent: null, processId: 1, routingId};
		const incoming = {sender, senderFrame: frame};
		const next = loadPreload((channel, ...args) => handlers.get(channel)(incoming, ...args));
		frame.send = (channel, state) => {
			sent.push(plain(state));
			next.listeners.get(channel)?.({}, state);
		};
		sender.mainFrame = frame;
		event = incoming;
		renderer = next;
		return next;
	}
	newRenderer();
	return {
		get api() {
			return renderer.api;
		},
		get frame() {
			return event.senderFrame;
		},
		config,
		sender,
		sent,
		scans,
		childProcesses,
		timers,
		newRenderer,
		catalog: load(require.resolve('@fluxer/game_catalog/src/GameCatalog.ts')),
		advance: (milliseconds) => {
			monotonic += milliseconds;
			wallClock += milliseconds;
		},
		finish: async (index, processes = [], error = null) => {
			await new Promise(setImmediate);
			if (error) scans[index].reject(error);
			else scans[index].resolve(processes);
			await new Promise(setImmediate);
		},
		tick: async () => {
			for (const timer of timers.values()) timer.callback();
			await new Promise(setImmediate);
		},
		cleanup: ipc.cleanupGameActivityIpc,
	};
}

const processRow = (exe, pid = 42) => [{exe, pid}];
const configureIntegration = async (h, generation = 1, account_id = '123', enabled = true) => {
	const result = await h.api.gameActivityConfigure({account_id, generation, enabled});
	await new Promise(setImmediate);
	return result;
};

test('real_catalog_detection_ipc_preload_preserve_fresh_tuple_and_reject_failed_renew', async () => {
	const h = loadIntegration();
	try {
		const game = h.catalog.getGameById('counter-strike-2');
		assert.ok(game);
		assert.equal(h.catalog.matchGameByExe(game.exe[0].toUpperCase()).id, game.id);
		const received = [];
		const unsubscribe = h.api.onGameActivityState((state) => received.push(plain(state)));
		assert.deepEqual(plain(await h.api.gameActivityGetCapabilities()), {version: 1, supported: true});
		await configureIntegration(h);
		assert.equal(h.scans.length, 1);
		assert.equal(h.timers.size, 1);
		assert.equal([...h.timers.values()][0].delay, 15_000);

		assert.deepEqual(h.childProcesses, []);
		await h.finish(0, processRow(game.exe[0].toUpperCase()));
		const first = plain(await h.api.gameActivityGetState({generation: 1}));
		assert.equal(first.fresh, true);
		assert.equal(first.activity.game_id, game.id);
		assert.deepEqual(received.at(-1), first);
		h.advance(15_000);
		await h.tick();
		await h.finish(1, processRow(game.exe[0]));
		assert.deepEqual(plain(await h.api.gameActivityGetState({generation: 1})), first);
		assert.equal(received.filter((state) => state.fresh && state.state === 'playing').length, 2);
		h.advance(15_000);
		await h.tick();
		await h.finish(2, [], new Error('Fixture query failure'));
		assert.deepEqual(received.at(-1), {generation: 1, state: 'unavailable', activity: null, fresh: false});
		h.advance(15_000);
		await h.tick();
		await h.finish(3, processRow(game.exe[0]));
		assert.deepEqual(received.at(-1), first);
		h.advance(15_000);
		await h.tick();
		await h.finish(4);
		assert.deepEqual(received.at(-1), {generation: 1, state: 'idle', activity: null, fresh: true});
		unsubscribe();
		await h.tick();
		await h.finish(5, processRow(game.exe[0]));
		assert.equal(received.at(-1).state, 'idle');
	} finally {
		h.cleanup();
	}
});

test('real_pipeline_same_generation_disable_and_account_switch_fence_old_scans', async () => {
	const h = loadIntegration();
	try {
		await configureIntegration(h, 2);
		await configureIntegration(h, 2, '123', false);
		assert.equal(h.timers.size, 0);

		const disabledCount = h.sent.length;
		await h.finish(0, processRow('cs2.exe'));
		assert.equal(h.sent.length, disabledCount);
		assert.deepEqual(plain(await h.api.gameActivityGetState({generation: 2})), {
			generation: 2,
			state: 'disabled',
			activity: null,
			fresh: false,
		});
		await configureIntegration(h, 2);
		await h.finish(1, processRow('cs2.exe'));
		assert.equal(h.sent.at(-1).state, 'playing');
		await assert.rejects(configureIntegration(h, 1), /generation/);
		await assert.rejects(configureIntegration(h, 2, '456'), /generation/);
		await h.tick();
		await configureIntegration(h, 2, null, false);
		await assert.rejects(configureIntegration(h, 2, '456'), /generation/);
		await configureIntegration(h, 3, '456');
		const newAccountCount = h.sent.length;
		await h.finish(2, processRow('cs2.exe'));
		assert.equal(h.sent.length, newAccountCount);
		assert.equal(h.scans.length, 4);
		await h.finish(3, processRow('valorant-win64-shipping.exe'));
		assert.equal(h.sent.at(-1).generation, 3);
		assert.equal(h.sent.at(-1).activity.game_id, 'valorant');
		await assert.rejects(h.api.gameActivityGetState({generation: 2}), /generation/);
	} finally {
		h.cleanup();
	}
});

test('real_privileged_guard_denies_untrusted_renderer_on_every_preload_channel', async () => {
	const h = loadIntegration();
	try {
		await configureIntegration(h);
		for (const invalid of [{url: 'https://evil.test/'}, {parent: {}}, {detached: true}]) {
			const original = {...h.frame};
			Object.assign(h.frame, invalid);
			for (const [method, , payload] of fixtures) {
				await assert.rejects(payload === undefined ? h.api[method]() : h.api[method](payload), /trusted top-level/);
			}
			Object.assign(h.frame, original);
		}
		h.frame.url = 'https://evil.test/';
		const count = h.sent.length;
		await h.finish(0, processRow('cs2.exe'));
		assert.equal(h.sent.length, count);
		assert.equal(h.timers.size, 0);
	} finally {
		h.cleanup();
	}
});

test('real_pipeline_renderer_replacement_drops_old_callbacks_and_opaque_tokens', async () => {
	const h = loadIntegration();
	try {
		await configureIntegration(h);
		await h.finish(0, processRow('cs2.exe').concat(processRow('private-fixture.exe', 43)));
		const candidates = plain(await h.api.gameActivityListCandidates({generation: 1}));
		assert.equal(candidates.state, 'ok');
		assert.deepEqual(
			candidates.candidates.map(({label}) => label),
			['Counter-Strike 2', 'Application 2'],
		);
		assert.equal(JSON.stringify(candidates).includes('private-fixture'), false);
		assert.deepEqual(
			plain(
				await h.api.gameActivityAddRule({generation: 1, token: candidates.candidates[0].token, manual_name: 'Game'}),
			),
			{state: 'unavailable'},
		);
		await h.tick();
		const oldStates = [];
		const oldApi = h.api;
		h.api.onGameActivityState((state) => oldStates.push(plain(state)));
		h.sender.emit('did-start-navigation', {}, 'https://trusted.test/reload', false, true);
		h.newRenderer(3);
		await assert.rejects(oldApi.gameActivityGetState({generation: 1}), /main renderer/);
		const currentStates = [];
		h.api.onGameActivityState((state) => currentStates.push(plain(state)));
		const configuring = configureIntegration(h, 1, '456');
		await Promise.resolve();
		assert.equal(h.scans.length, 2, 'Replacement renderer must wait for the old native query completion');
		await h.finish(1, processRow('cs2.exe'));
		assert.equal(oldStates.length, 0);
		assert.equal(
			currentStates.every((state) => state.activity === null && state.fresh === false),
			true,
		);
		await configuring;
		assert.equal(h.scans.length, 3);
		await h.finish(2, processRow('valorant-win64-shipping.exe'));
		assert.equal(currentStates.at(-1).activity.game_id, 'valorant');
		assert.deepEqual(
			plain(
				await h.api.gameActivityAddRule({generation: 1, token: candidates.candidates[1].token, manual_name: 'Game'}),
			),
			{state: 'unavailable'},
		);
		h.sender.emit('render-process-gone', {}, {reason: 'crashed'});
		assert.equal(h.timers.size, 0);
	} finally {
		h.cleanup();
	}
});

test('real_pipeline_crash_restart_waits_for_old_scan_before_new_native_query', async () => {
	const h = loadIntegration();
	try {
		await configureIntegration(h);
		const oldStates = [];
		h.api.onGameActivityState((state) => oldStates.push(plain(state)));
		h.sender.emit('render-process-gone', {}, {reason: 'crashed'});

		assert.equal(h.timers.size, 0);
		h.newRenderer(3);
		const currentStates = [];
		h.api.onGameActivityState((state) => currentStates.push(plain(state)));
		const configuring = configureIntegration(h, 1, '456');
		await Promise.resolve();
		assert.equal(h.scans.length, 1, 'Crash restart must wait for the old native query completion');
		await h.finish(0, processRow('cs2.exe'));
		assert.equal(oldStates.length, 0);
		assert.equal(
			currentStates.every((state) => state.activity === null && state.fresh === false),
			true,
		);
		await configuring;
		assert.equal(h.scans.length, 2);
		await h.finish(1, processRow('valorant-win64-shipping.exe'));
		assert.equal(currentStates.at(-1).activity.game_id, 'valorant');
		assert.equal(
			currentStates.some((state) => state.activity?.game_id === 'counter-strike-2'),
			false,
		);
	} finally {
		h.cleanup();
	}
});

test('real_pipeline_queued_configuration_cannot_restart_after_shutdown_or_crash', async () => {
	for (const shutdown of [false, true]) {
		const h = loadIntegration();
		try {
			await configureIntegration(h);
			h.sender.emit('did-start-navigation', {}, 'https://trusted.test/reload', false, true);
			h.newRenderer(3);
			const configuring = configureIntegration(h, 1, '456');
			await Promise.resolve();
			assert.equal(h.scans.length, 1);
			const denied = assert.rejects(configuring, /renderer|document|configured|shutdown|generation/);
			if (shutdown) h.cleanup();
			else h.sender.emit('render-process-gone', {}, {reason: 'crashed'});
			await h.finish(0, processRow('cs2.exe'));
			await denied;
			assert.equal(h.scans.length, 1);
			assert.equal(h.timers.size, 0);
		} finally {
			h.cleanup();
		}
	}
});

test('real_pipeline_local_rules_are_redacted_account_scoped_and_runtime_free', async () => {
	const h = loadIntegration();
	try {
		h.config.setGameActivityRules('123', [
			{rule_id: 'fixture-rule', exe: 'private-fixture.exe', manual_name: 'My game'},
		]);
		await configureIntegration(h);
		await h.finish(0, processRow('private-fixture.exe'));
		assert.equal(h.sent.at(-1).activity.manual_name, 'My game');
		assert.deepEqual(plain(await h.api.gameActivityListRules({generation: 1})), {
			state: 'ok',
			rules: [{rule_id: 'fixture-rule', manual_name: 'My game'}],
		});
		await h.api.gameActivityRemoveRule({generation: 1, rule_id: 'fixture-rule'});
		assert.deepEqual(plain(h.config.getGameActivityRules('123')), []);
		await h.finish(1, processRow('private-fixture.exe'));
		assert.equal(h.sent.at(-1).state, 'idle');
		await configureIntegration(h, 2, '456');
		assert.deepEqual(plain(await h.api.gameActivityListRules({generation: 2})), {state: 'ok', rules: []});
	} finally {
		h.cleanup();
	}
});

test('real_pipeline_unsupported_never_starts_process_or_timer', async () => {
	const h = loadIntegration({platform: 'linux'});
	try {
		assert.deepEqual(plain(await h.api.gameActivityGetCapabilities()), {version: 1, supported: false});
		assert.deepEqual(plain(await configureIntegration(h)), {state: 'unsupported'});
		assert.deepEqual(plain(await h.api.gameActivityGetState({generation: 1})), {
			generation: 1,
			state: 'unsupported',
			activity: null,
			fresh: false,
		});
		assert.deepEqual(h.childProcesses, []);
		assert.equal(h.scans.length, 0);
		assert.equal(h.timers.size, 0);
	} finally {
		h.cleanup();
	}
});
