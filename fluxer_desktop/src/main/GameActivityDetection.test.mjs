// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {loadMainModule} from './WinShellTestHarness.mjs';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const sourcePath = fileURLToPath(new URL('./GameActivityDetection.ts', import.meta.url));
const probesPath = fileURLToPath(new URL('./GameActivityProbes.ts', import.meta.url));
const plain = (value) => JSON.parse(JSON.stringify(value));
const processes = (exe, pid = 10) => [{exe, pid}];
const entries = new Map([
	['alpha.exe', {id: 'alpha', name: 'Alpha'}],
	['zeta.exe', {id: 'zeta', name: 'Zeta'}],
	['ünicode.exe', {id: 'unicode', name: 'Unicode'}],
]);

function load({nativeModule, nativeError, onNativeLoad = () => {}, onChildProcess = () => {}, execFile} = {}) {
	if (!existsSync(sourcePath)) {
		return class MissingDetection {
			configure() {
				return {state: 'missing'};
			}
			getState() {
				return {state: 'missing'};
			}
			listCandidates() {
				return {state: 'missing'};
			}
			listRules() {
				return {state: 'missing'};
			}
			removeRule() {
				return {state: 'missing'};
			}
			async addRule() {
				return {state: 'missing'};
			}
			async poll() {}
			stop() {}
		};
	}
	const commonModule = {exports: {}};
	const commonSourcePath = fileURLToPath(new URL('../common/GameActivityTypes.ts', import.meta.url));
	vm.runInNewContext(
		esbuild.transformSync(readFileSync(commonSourcePath, 'utf8'), {loader: 'ts', format: 'cjs', target: 'node20'}).code,
		{module: commonModule, exports: commonModule.exports, TextEncoder},
		{filename: commonSourcePath},
	);
	const transformed = esbuild.transformSync(readFileSync(sourcePath, 'utf8'), {
		loader: 'ts',
		format: 'cjs',
		platform: 'node',
		target: 'node20',
		supported: {'dynamic-import': false},
	}).code;
	const module = {exports: {}};
	const childProcess = Object.fromEntries(
		['exec', 'execFile', 'spawn', 'fork'].map((name) => [
			name,
			() => {
				onChildProcess(name);
				throw new Error('Child process prohibited');
			},
		]),
	);
	if (execFile) childProcess.execFile = execFile;
	const probesModule = {exports: {}};
	vm.runInNewContext(
		esbuild.transformSync(readFileSync(probesPath, 'utf8'), {loader: 'ts', format: 'cjs', target: 'node20'}).code,
		{
			module: probesModule,
			exports: probesModule.exports,
			Buffer,
			TextEncoder,
			process,
			require: (specifier) => {
				if (specifier === 'node:child_process') return childProcess;
				if (specifier === 'node:fs/promises')
					return {
						readdir: async () => {
							onChildProcess('readdir');
							throw new Error('File system prohibited');
						},
						readFile: async () => {
							throw new Error('File system prohibited');
						},
					};
				if (specifier === '@electron/common/GameActivityTypes') return commonModule.exports;
				return require(specifier);
			},
		},
		{filename: probesPath},
	);
	const sharedWinShell = loadMainModule(
		'WinShell',
		{
			'node:module': {
				createRequire: () => () => {
					onNativeLoad();
					if (nativeError) throw nativeError;
					return nativeModule;
				},
			},
			'electron-log': {warn() {}},
		},
		{platform: 'win32'},
	);
	vm.runInNewContext(
		transformed,
		{
			module,
			exports: module.exports,
			Buffer,
			TextEncoder,
			process,
			setInterval,
			clearInterval,
			require: (specifier) => {
				if (specifier === '@electron/main/WinShell') return sharedWinShell;
				if (specifier === 'node:child_process') return childProcess;
				if (specifier === '@electron/main/GameActivityProbes') return probesModule.exports;
				if (specifier === '@fluxer/win-shell') {
					onNativeLoad();
					if (nativeError) throw nativeError;
					return nativeModule;
				}
				if (specifier === '@fluxer/game_catalog/src/GameCatalog') {
					return {
						matchGameByExe: (exe) => entries.get(exe),
						matchGameByProcess: (exe) => entries.get(exe) ?? entries.get(`${exe}.exe`),
						getGameById: (id) => [...entries.values()].find((e) => e.id === id),
					};
				}
				if (specifier === '@electron/common/GameActivityTypes') {
					return commonModule.exports;
				}
				return require(specifier);
			},
		},
		{filename: sourcePath},
	);
	return module.exports.GameActivityDetection;
}

const supportedPlatforms = new Set(['win32', 'darwin', 'linux']);

function harness({platform = 'win32', rules = {}, matcher, provider, nowPlaying} = {}) {
	const calls = [];
	const timers = new Map();
	const events = [];
	let clock = 1000;
	let wall = 1_700_000_000_000;
	let token = 0;
	const childProcesses = [];
	const nowPlayingCalls = [];
	const Detector = load({onChildProcess: (name) => childProcesses.push(name)});
	const detector = new Detector({
		platform,
		onState: (state) => events.push(plain(state)),
		now: () => wall,
		monotonicNow: () => clock,

		getRules: (account) => rules[account] ?? [],
		setRules: (account, value) => {
			rules[account] = plain(value);
		},
		matchGameByExe: matcher ?? ((exe) => entries.get(exe)),
		getGameById: (id) => [...entries.values()].find((entry) => entry.id === id),
		createToken: () => `opaque-token-${++token}`,
		readNowPlaying: async () => {
			nowPlayingCalls.push(clock);
			if (!nowPlaying) throw new Error('Unexpected Spotify query');
			return nowPlaying();
		},
		setInterval: (callback, delay) => {
			const id = timers.size + 1;
			timers.set(id, {callback, delay});
			return id;
		},
		clearInterval: (id) => timers.delete(id),
		listProcesses:
			provider ??
			(() =>
				new Promise((resolve, reject) => {
					calls.push({resolve, reject});
				})),
	});
	return {
		detector,
		childProcesses,
		nowPlayingCalls,
		calls,
		timers,
		events,
		rules,
		configure: (account = 'account-a', generation = 1, enabled = true, spotify = undefined) => {
			const request = {account_id: account, generation, enabled, ...(spotify === undefined ? {} : {spotify})};
			const result = detector.configure(request);
			assert.equal(result.state, supportedPlatforms.has(platform) ? 'ok' : 'unsupported');
			return result;
		},
		advance: (ms) => {
			clock += ms;
			wall += ms;
		},
		jumpWall: (ms) => {
			wall += ms;
		},
		finish: async (output, error = null) => {
			const pending = detector.poll();
			if (error) calls.at(-1)?.reject(error);
			else calls.at(-1)?.resolve(output);
			await pending;
		},
	};
}

test('disabled_never_spawns', async () => {
	const h = harness();
	assert.deepEqual(plain(h.configure(null, 1, false)), {state: 'ok'});
	await h.detector.poll();
	assert.equal(h.detector.getState().state, 'disabled');
	assert.equal(h.calls.length, 0);
	assert.equal(h.timers.size, 0);
});

test('disabled_account_never_reads_processes_and_reopen_requires_a_new_snapshot', async () => {
	const h = harness();
	h.configure('account-a', 1, false);
	assert.equal(h.calls.length, 0);
	assert.equal(h.timers.size, 0);
	await h.detector.poll();
	assert.equal(h.detector.listCandidates().state, 'unavailable');
	assert.equal((await h.detector.addRule('old-token', {manual_name: 'Game'})).state, 'unavailable');
	assert.equal(h.detector.getState().state, 'disabled');
	h.configure('account-a', 2, true);
	await h.finish(processes('alpha.exe'));
	assert.equal(h.detector.getState().activity?.game_id, 'alpha');
	assert.equal(h.calls.length, 1);
	h.configure('account-a', 3, false);
	await h.detector.poll();
	assert.equal(h.calls.length, 1);
	assert.equal(h.timers.size, 0);
	assert.equal(h.detector.getState().activity, null);
	h.configure('account-a', 4, true);
	assert.equal(h.calls.length, 2);
	assert.equal(h.detector.getState().activity, null);
	await h.finish(processes('zeta.exe'));
	assert.equal(h.detector.getState().activity?.game_id, 'zeta');
	h.detector.stop();
});

test('unknown_platform_is_unsupported', async () => {
	const h = harness({platform: 'freebsd'});
	assert.deepEqual(plain(h.configure()), {state: 'unsupported'});
	await h.detector.poll();
	assert.equal(h.detector.getState().state, 'unsupported');
	assert.equal(h.detector.listCandidates().state, 'unsupported');
	assert.equal(h.calls.length, 0);
	assert.equal(h.timers.size, 0);
});

test('one_snapshot_not_per_game', async () => {
	const h = harness();
	h.configure();
	await h.finish(processes('zeta.exe').concat(processes('alpha.exe', 11)));
	assert.equal(h.calls.length, 1);
	assert.deepEqual(h.childProcesses, []);
	assert.equal([...h.timers.values()][0].delay, 15000);
	assert.equal(h.detector.getState().activity?.game_id, 'alpha');
});

test('provider_errors_and_invalid_snapshots_are_unavailable', async () => {
	for (const [output, error] of [
		[[], new Error('Enumeration failed')],
		[Array.from({length: 20001}, () => ({exe: 'alpha.exe', pid: 1})), null],
		[null, null],
		[undefined, null],
		['csv data', null],
		[{exe: 'alpha.exe', pid: 1}, null],
		[[null], null],
		[[{exe: 1, pid: 1}], null],
		[[{exe: '', pid: 1}], null],
		[[{exe: 'a'.repeat(261), pid: 1}], null],
		...['C:/alpha.exe', 'C:\\alpha.exe', 'alpha\u0000.exe', 'alpha\u202e.exe'].map((exe) => [[{exe, pid: 1}], null]),
		...[-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1'].map((pid) => [[{exe: 'alpha.exe', pid}], null]),
	]) {
		const h = harness();
		h.configure();
		await h.finish(output, error);
		assert.equal(h.detector.getState().state, 'unavailable');
		assert.equal(h.detector.getState().fresh, false);
		assert.equal(h.detector.listCandidates().state, 'unavailable');
	}
});

test('concurrent_poll_single_inflight', async () => {
	const h = harness();
	h.configure();
	const a = h.detector.poll();
	const b = h.detector.poll();
	assert.equal(h.calls.length, 1);
	await h.finish(processes('alpha.exe'));
	await Promise.all([a, b]);
	assert.equal(h.detector.getState().state, 'playing');
});

test('native_unicode_filename_is_normalized', async () => {
	const h = harness();
	h.configure();
	await h.finish(processes('ÜNICODE.EXE', 44));
	assert.equal(h.detector.getState().activity?.game_id, 'unicode');
});

test('launcher_and_ambiguous_runtime_not_game', async () => {
	const h = harness({matcher: () => ({id: 'alpha', name: 'Alpha'})});
	h.configure();
	await h.finish(
		processes('javaw.exe').concat(
			processes('launcher.exe', 11).concat(processes('patcher.exe', 12).concat(processes('easyanticheat.exe', 13))),
		),
	);
	assert.equal(h.detector.getState().state, 'idle');
});

test('stable_selection_keeps_started_at', async () => {
	const h = harness();
	h.configure();
	await h.finish(processes('zeta.exe'));
	const original = plain(h.detector.getState().activity);
	h.advance(15000);
	h.jumpWall(8 * 86400000);
	await h.finish(processes('zeta.exe'));
	h.advance(15000);
	h.jumpWall(-2 * 86400000);
	await h.finish(processes('alpha.exe').concat(processes('zeta.exe', 11)));
	assert.deepEqual(plain(h.detector.getState().activity), original);
	assert.equal(h.detector.getState().fresh, true);
});

test('scan_failure_never_renews', async () => {
	const h = harness();
	h.configure();
	await h.finish(processes('alpha.exe'));
	h.advance(15000);
	await h.finish([], new Error('failure'));
	assert.deepEqual(plain(h.detector.getState()), {generation: 1, state: 'unavailable', activity: null, fresh: false});
	assert.equal(h.events.at(-1).activity, null);
	await h.finish(processes('alpha.exe'));
	assert.equal(h.detector.getState().activity.started_at, 1_700_000_000_000);
});

test('failure_60s_clears', async () => {
	const h = harness();
	h.configure();
	await h.finish(processes('alpha.exe'));
	h.advance(60000);
	h.jumpWall(-86400000);
	await h.finish([], new Error('failure'));
	await h.finish(processes('alpha.exe'));
	assert.notEqual(h.detector.getState().activity.started_at, 1_700_000_000_000);
});

test('real_exit_clears_immediately', async () => {
	const h = harness();
	h.configure();
	await h.finish(processes('alpha.exe'));
	await h.finish([]);
	assert.deepEqual(plain(h.detector.getState()), {generation: 1, state: 'idle', activity: null, fresh: true});
});

test('account_switch_drops_inflight', async () => {
	const h = harness();
	h.configure();
	const old = h.calls[0];
	const oldPending = h.detector.poll();
	h.configure('account-b', 2);

	const eventCount = h.events.length;
	old.resolve(processes('alpha.exe'));
	await oldPending;
	assert.equal(h.events.length, eventCount);
	await h.finish(processes('zeta.exe'));
	assert.equal(h.detector.getState().generation, 2);
	assert.equal(h.detector.getState().activity.game_id, 'zeta');
	h.detector.stop();
	assert.equal(h.timers.size, 0);
	assert.equal(h.detector.listCandidates().state, 'unavailable');
});

test('stale_process_token_and_pid_reuse_rejected', async () => {
	const h = harness();
	h.configure();
	await h.finish(processes('private-name.exe'));
	const result = plain(h.detector.listCandidates());
	assert.equal(result.state, 'ok');
	assert.deepEqual(Object.keys(result.candidates[0]).sort(), ['label', 'token']);
	assert.equal(result.candidates[0].label, 'Application 1');
	const token = result.candidates[0].token;
	assert.deepEqual(plain(await h.detector.addRule(token, {manual_name: 'My game'})), {state: 'unavailable'});
	await h.finish(processes('private-name.exe'));
	assert.equal((await h.detector.addRule(token, {game_id: 'alpha'})).state, 'unavailable');
	h.advance(30001);
	assert.equal((await h.detector.addRule(token, {game_id: 'alpha'})).state, 'unavailable');
	assert.equal(h.rules['account-a'], undefined);
});

test('local_rules_capped_and_account_scoped', async () => {
	const rules = {
		'account-a': Array.from({length: 51}, (_, i) => ({
			rule_id: `rule-${i}`,
			exe: `manual-${i}.exe`,
			manual_name: `Game ${i}`,
		})),
	};
	const h = harness({rules});
	h.configure();
	await h.finish(processes('manual-0.exe').concat(processes('alpha.exe', 11)));
	assert.equal(h.detector.getState().activity.manual_name, 'Game 0');
	const listed = plain(h.detector.listRules());
	assert.equal(listed.rules.length, 50);
	assert.deepEqual(Object.keys(listed.rules[0]).sort(), ['manual_name', 'rule_id']);
	assert.deepEqual(plain(h.detector.removeRule('rule-0')), {state: 'ok'});
	assert.equal(h.rules['account-a'].length, 49);
	await h.finish(processes('manual-0.exe').concat(processes('alpha.exe', 11)));
	h.configure('account-b', 2);
	await h.finish(processes('manual-1.exe'));
	assert.equal(h.detector.getState().state, 'idle');
	assert.equal(h.detector.listRules().rules.length, 0);
});

test('candidate_pages_are_bounded_and_opaque', async () => {
	const h = harness();
	h.configure();
	await h.finish(Array.from({length: 201}, (_, i) => ({exe: `private-${i}.exe`, pid: i + 1})));
	const first = plain(h.detector.listCandidates());
	assert.equal(first.candidates.length, 100);
	const second = plain(h.detector.listCandidates(first.next_cursor));
	assert.equal(second.candidates.length, 100);
	const last = plain(h.detector.listCandidates(second.next_cursor));
	assert.equal(last.candidates.length, 1);
	assert.equal(JSON.stringify([first, second, last]).includes('private-'), false);
	h.configure('account-b', 2);
	assert.equal(h.detector.listCandidates(first.next_cursor).state, 'unavailable');
});

test('stop_and_reconfigure_same_generation_drop_callbacks', async () => {
	const h = harness();
	h.configure();
	const old = h.calls[0];
	const pending = h.detector.poll();
	h.detector.stop();
	h.configure();
	const eventCount = h.events.length;
	old.resolve(processes('alpha.exe'));
	await pending;
	assert.equal(h.events.length, eventCount);
	await h.finish([]);
	assert.equal(h.detector.getState().state, 'idle');
});

test('reconfigure_waits_for_native_completion_before_next_snapshot', async () => {
	const h = harness();
	h.configure();
	const old = h.calls[0];
	h.configure('account-b', 2);

	assert.equal(h.calls.length, 1);
	const oldPending = h.detector.poll();
	old.reject(new Error('Enumeration failed'));
	await oldPending;
	assert.equal(h.calls.length, 2);
	await h.finish(processes('zeta.exe'));
	assert.equal(h.detector.getState().activity.game_id, 'zeta');
});

test('poll_start_expires_activity_while_callback_is_pending', async () => {
	const h = harness();
	h.configure();
	await h.finish(processes('alpha.exe'));
	h.advance(60000);
	const pending = h.detector.poll();
	assert.equal(h.events.at(-1).state, 'unavailable');
	assert.equal(h.events.at(-1).activity, null);
	h.calls.at(-1).reject(new Error('Enumeration failed'));
	await pending;
});

test('new_candidate_listing_invalidates_previous_page_cursor', async () => {
	const h = harness();
	h.configure();
	await h.finish(Array.from({length: 101}, () => ({exe: 'alpha.exe', pid: 10})));
	const previous = h.detector.listCandidates();
	const current = h.detector.listCandidates();
	assert.equal(h.detector.listCandidates(previous.next_cursor).state, 'unavailable');
	assert.equal(h.detector.listCandidates(current.next_cursor).state, 'ok');
});

test('stop_returns_native_completion_barrier_and_cleans_immediately', async () => {
	const h = harness();
	h.configure();
	await h.finish(processes('alpha.exe'));
	const work = h.detector.poll();
	const child = h.calls.at(-1);
	const stopped = h.detector.stop();
	assert.equal(typeof stopped?.then, 'function');
	let completed = false;
	stopped.then(() => {
		completed = true;
	});
	await Promise.resolve();
	assert.equal(completed, false);

	assert.equal(h.timers.size, 0);
	assert.equal(h.detector.getState().state, 'disabled');
	assert.equal(h.detector.getState().activity, null);
	assert.equal(h.detector.listCandidates().state, 'unavailable');
	const eventCount = h.events.length;
	child.resolve(processes('zeta.exe'));
	await stopped;
	await work;
	assert.equal(completed, true);
	assert.equal(h.events.length, eventCount);
});

test('stop_without_owned_work_returns_resolved_barrier', async () => {
	const h = harness();
	const stopped = h.detector.stop();
	assert.equal(typeof stopped?.then, 'function');
	await stopped;
	assert.equal(h.calls.length, 0);
	assert.equal(h.timers.size, 0);
});

test('same_generation_disable_and_reenable_waits_for_old_poll', async () => {
	const h = harness();
	h.configure();
	const old = h.calls[0];
	const oldWork = h.detector.poll();
	h.configure('account-a', 1, false);
	h.configure('account-a', 1, true);
	assert.equal(h.calls.length, 1);

	const eventCount = h.events.length;
	old.resolve(processes('alpha.exe'));
	await oldWork;
	assert.equal(h.events.length, eventCount);
	assert.equal(h.calls.length, 2);
	await h.finish(processes('zeta.exe'));
	assert.equal(h.detector.getState().activity.game_id, 'zeta');
});

test('enabled_native_detection_never_starts_a_child_process', async () => {
	const h = harness();
	h.configure();
	assert.deepEqual(h.childProcesses, []);
	assert.equal(h.calls.length, 1);
	await h.finish(processes('alpha.exe'));
	assert.equal(h.detector.getState().state, 'playing');
	assert.deepEqual(h.childProcesses, []);
});

test('synchronous_provider_failure_is_unavailable', async () => {
	const h = harness({
		provider: () => {
			throw new Error('Unavailable');
		},
	});
	h.configure();
	await h.detector.poll();
	assert.equal(h.detector.getState().state, 'unavailable');
	assert.equal(h.detector.getState().fresh, false);
});

test('maximum_snapshot_filename_and_pid_boundaries_are_accepted', async () => {
	const h = harness();
	h.configure();
	await h.finish(
		Array.from({length: 20000}, (_, index) => ({exe: 'a'.repeat(260), pid: index === 0 ? 0 : Number.MAX_SAFE_INTEGER})),
	);
	assert.equal(h.detector.getState().state, 'idle');
	assert.equal(h.detector.getState().fresh, true);
});

test('default_native_provider_loads_only_when_enabled_and_load_failure_is_unavailable', async () => {
	let loads = 0;
	const Detector = load({nativeError: new Error('Native module missing'), onNativeLoad: () => loads++});
	const detector = new Detector({platform: 'win32', setInterval: () => 1, clearInterval: () => {}});
	detector.configure({account_id: 'a', generation: 1, enabled: false});
	await detector.poll();
	assert.equal(loads, 0);
	detector.configure({account_id: 'a', generation: 2, enabled: true});
	await detector.poll();
	assert.equal(loads, 1);
	assert.equal(detector.getState().state, 'unavailable');
	assert.equal(detector.getState().fresh, false);
	await detector.stop();
});

test('default_native_provider_calls_listProcesses_without_a_child_process', async () => {
	let loads = 0;
	let queries = 0;
	const children = [];
	const Detector = load({
		nativeModule: {
			listProcesses: async () => {
				queries++;
				return processes('ALPHA.EXE');
			},
		},
		onNativeLoad: () => loads++,
		onChildProcess: (name) => children.push(name),
	});
	const detector = new Detector({platform: 'win32', setInterval: () => 1, clearInterval: () => {}});
	assert.equal(loads, 0);
	detector.configure({account_id: 'a', generation: 1, enabled: true});
	await detector.poll();
	assert.equal(loads, 1);
	assert.equal(queries, 1);
	assert.equal(detector.getState().activity.game_id, 'alpha');
	assert.deepEqual(children, []);
	await detector.stop();
});
test('disable_during_native_import_does_not_start_a_native_query', async () => {
	let detector;
	let queries = 0;
	const Detector = load({
		nativeModule: {
			listProcesses: async () => {
				queries++;
				return processes('alpha.exe');
			},
		},
		onNativeLoad: () => {
			void detector.stop();
		},
	});
	detector = new Detector({platform: 'win32', setInterval: () => 1, clearInterval: () => {}});
	detector.configure({account_id: 'a', generation: 1, enabled: true});
	await detector.poll();
	assert.equal(queries, 0);
	assert.equal(detector.getState().state, 'disabled');
});

test('reconfigure_during_native_import_queries_only_the_current_epoch', async () => {
	let detector;
	let loads = 0;
	let queries = 0;
	const Detector = load({
		nativeModule: {
			listProcesses: async () => {
				queries++;
				return processes('alpha.exe');
			},
		},
		onNativeLoad: () => {
			if (++loads === 1) detector.configure({account_id: 'b', generation: 2, enabled: true});
		},
	});
	detector = new Detector({platform: 'win32', setInterval: () => 1, clearInterval: () => {}});
	detector.configure({account_id: 'a', generation: 1, enabled: true});
	await detector.poll();
	await detector.poll();
	assert.equal(queries, 1);
	assert.equal(detector.getState().generation, 2);
	assert.equal(detector.getState().activity.game_id, 'alpha');
	await detector.stop();
});

for (const platform of ['darwin', 'linux']) {
	test(`${platform}_detects_games_with_the_same_polling`, async () => {
		const h = harness({platform, matcher: (exe) => entries.get(exe) ?? entries.get(`${exe}.exe`)});
		h.configure();
		assert.equal(h.calls.length, 1);
		assert.equal([...h.timers.values()][0].delay, 15000);
		await h.finish(processes('alpha').concat(processes('finder', 11)));
		assert.equal(h.detector.getState().activity?.game_id, 'alpha');
		await h.finish(processes('finder', 11));
		assert.deepEqual(plain(h.detector.getState()), {generation: 1, state: 'idle', activity: null, fresh: true});
		const candidates = plain(h.detector.listCandidates());
		assert.equal(candidates.state, 'ok');
		assert.deepEqual(
			candidates.candidates.map((candidate) => candidate.label),
			['Application 1'],
		);
		assert.deepEqual(plain(h.detector.listRules()), {state: 'ok', rules: []});
		h.configure('account-a', 2, false);
		assert.equal(h.timers.size, 0);
		await h.detector.poll();
		assert.equal(h.calls.length, 2);
		assert.equal(h.detector.getState().state, 'disabled');
	});
}

test('default_darwin_provider_reads_ps_only_while_enabled', async () => {
	const commands = [];
	const execFile = (file, args, _options, callback) => {
		commands.push([file, ...args]);
		const output = args.includes('pid=,comm=')
			? '  1 /sbin/launchd\n 77 /Applications/Alpha.app/Contents/MacOS/Alpha\n 78 /Applications/Wine.app/Contents/wine64-preloader\n'
			: '  1 /sbin/launchd\n 77 /Applications/Alpha.app/Contents/MacOS/Alpha -psn\n 78 C:\\Games\\Zeta\\zeta.exe -windowed\n';
		queueMicrotask(() => callback(null, output, ''));
	};
	const Detector = load({execFile});
	const detector = new Detector({platform: 'darwin', setInterval: () => 1, clearInterval: () => {}});
	detector.configure({account_id: 'a', generation: 1, enabled: false});
	await detector.poll();
	assert.equal(commands.length, 0);
	detector.configure({account_id: 'a', generation: 2, enabled: true});
	await detector.poll();
	assert.deepEqual(
		commands.map((command) => command.join(' ')),
		['/bin/ps -axww -o pid=,comm=', '/bin/ps -axww -o pid=,args='],
	);
	assert.equal(detector.getState().state, 'playing');
	assert.equal(detector.getState().activity.game_id, 'alpha');
	await detector.stop();
});

test('spotify_is_off_unless_configured', async () => {
	const h = harness({platform: 'darwin', nowPlaying: () => ({artist: 'Artist', title: 'Song'})});
	h.configure();
	await h.finish(processes('spotify'));
	assert.equal(h.detector.getState().state, 'idle');
	h.configure('account-a', 2, true, false);
	await h.finish(processes('spotify'));
	assert.equal(h.detector.getState().state, 'idle');
	h.configure('account-a', 3, false, true);
	await h.detector.poll();
	assert.equal(h.detector.getState().state, 'disabled');
	assert.deepEqual(h.nowPlayingCalls, []);
});

test('spotify_now_playing_becomes_a_prefixed_manual_name_and_publishes_only_on_track_change', async () => {
	let track = {artist: 'Barış Manço', title: 'Gülpembe'};
	const h = harness({platform: 'darwin', nowPlaying: () => track});
	h.configure('account-a', 1, true, true);
	await h.finish(processes('spotify'));
	const first = plain(h.detector.getState());
	assert.equal(first.state, 'playing');
	assert.deepEqual(first.activity, {manual_name: '\u266B Barış Manço \u2013 Gülpembe', started_at: 1_700_000_000_000});
	h.advance(15000);
	await h.finish(processes('spotify'));
	assert.deepEqual(plain(h.detector.getState().activity), first.activity);
	h.advance(15000);
	track = {artist: 'MFÖ', title: 'Ali Desidero'};
	await h.finish(processes('spotify'));
	assert.deepEqual(plain(h.detector.getState().activity), {
		manual_name: '\u266B MFÖ \u2013 Ali Desidero',
		started_at: 1_700_000_030_000,
	});
	track = null;
	await h.finish(processes('spotify'));
	assert.deepEqual(plain(h.detector.getState()), {generation: 1, state: 'idle', activity: null, fresh: true});
	assert.equal(h.nowPlayingCalls.length, 4);
});

test('spotify_is_only_asked_while_its_process_runs_and_no_game_is_detected', async () => {
	const h = harness({platform: 'win32', nowPlaying: () => ({artist: 'Artist', title: 'Song'})});
	h.configure('account-a', 1, true, true);
	await h.finish(processes('explorer.exe'));
	assert.equal(h.detector.getState().state, 'idle');
	await h.finish(processes('alpha.exe').concat(processes('spotify.exe', 11)));
	assert.equal(h.detector.getState().activity.game_id, 'alpha');
	assert.deepEqual(h.nowPlayingCalls, []);
	await h.finish(processes('spotify.exe', 11));
	assert.equal(h.detector.getState().activity.manual_name, '\u266B Artist \u2013 Song');
	assert.equal(h.nowPlayingCalls.length, 1);
});

test('spotify_probe_failures_never_break_game_detection_and_denial_backs_off', async () => {
	let failure = Object.assign(new Error('denied'), {name: 'SpotifyProbeUnavailable'});
	const h = harness({
		platform: 'darwin',
		nowPlaying: () => {
			if (failure) throw failure;
			return {artist: '', title: 'Podcast episode'};
		},
	});
	h.configure('account-a', 1, true, true);
	await h.finish(processes('spotify'));
	assert.equal(h.detector.getState().state, 'idle');
	assert.equal(h.detector.getState().fresh, true);
	h.advance(15000);
	await h.finish(processes('spotify'));
	assert.equal(h.nowPlayingCalls.length, 1);
	h.advance(10 * 60_000);
	failure = new Error('timeout');
	await h.finish(processes('spotify'));
	assert.equal(h.nowPlayingCalls.length, 2);
	assert.equal(h.detector.getState().state, 'idle');
	failure = null;
	await h.finish(processes('spotify'));
	assert.equal(h.nowPlayingCalls.length, 3);
	assert.equal(h.detector.getState().activity.manual_name, '\u266B Podcast episode');
});

test('spotify_names_are_cleaned_and_cut_to_the_manual_name_limit', async () => {
	const h = harness({
		platform: 'linux',
		nowPlaying: () => ({artist: 'A\u200bB\u0000C', title: `${'x'.repeat(80)}\ufe0f`}),
	});
	h.configure('account-a', 1, true, true);
	await h.finish(processes('spotify'));
	const name = h.detector.getState().activity.manual_name;
	assert.equal(Array.from(name).length, 64);
	assert.ok(name.startsWith('\u266B A B C \u2013 xxx'));
	assert.ok(name.endsWith('\u2026'));
});
