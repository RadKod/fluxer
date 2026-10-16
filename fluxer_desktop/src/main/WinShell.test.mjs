// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {test} from 'node:test';
import vm from 'node:vm';
import {loadMainModule} from './WinShellTestHarness.mjs';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const plain = (value) => JSON.parse(JSON.stringify(value));
const secret = 'C:\\Users\\private-account\\binding.node SECRET_STACK';

function harness({
	platform = 'win32',
	failure,
	requiredFailure,
	requiredInconclusive = false,
	marker = new Map(),
	native = {loadError: null},
} = {}) {
	const warnings = [];
	const probes = [];
	const nativeCalls = [];
	let nativeLoads = 0;
	const processStub = {
		platform,
		arch: 'x64',
		execPath: 'C:\\sanalyer\\current\\sanalyer.exe',
		env: {APPDATA: 'C:\\AppData', USERPROFILE: 'C:\\User'},
		argv: [],
		windowsStore: true,
	};
	let shortcutChecks = 0;
	const nativeRequire = () => {
		nativeLoads++;
		if (failure === 'require') throw new Error(secret);
		return failure === 'load-error' ? {...native, loadError: new Error(secret)} : native;
	};
	nativeRequire.resolve = (name) => {
		if (
			(name === '@fluxer/win-shell' && failure === 'resolve') ||
			(name === requiredFailure && failure === 'resolve')
		) {
			throw new Error(secret);
		}
		return name;
	};
	const stubs = {
		'node:module': {createRequire: () => nativeRequire},
		'node:path': {default: path.win32, ...path.win32},
		'node:fs': {
			existsSync: (name) => {
				if (name.endsWith('Update.exe')) {
					shortcutChecks++;
					return true;
				}
				return marker.has(name);
			},
			mkdirSync() {},
			readFileSync: (name) => {
				if (!marker.has(name)) throw new Error('missing');
				return marker.get(name);
			},
			writeFileSync: (name, value) => marker.set(name, value),
		},
		'node:child_process': {
			execFile() {
				throw new Error('OS commands prohibited');
			},
			spawnSync: (_file, args) => {
				const modules = args.slice(2);
				probes.push(modules);
				if (modules.includes('@fluxer/win-shell') && failure === 'inconclusive') {
					return {error: new Error(secret), stdout: '', stderr: secret, status: null};
				}
				if (!modules.includes('@fluxer/win-shell') && requiredInconclusive) {
					return {error: new Error('probe unavailable'), stdout: '', stderr: '', status: null};
				}
				if (modules.includes('@fluxer/win-shell') && failure === 'crash') {
					return {
						stdout: JSON.stringify({i: modules.indexOf('@fluxer/win-shell'), phase: 'start'}),
						stderr: secret,
						status: null,
						signal: 'SIGSEGV',
					};
				}
				let stdout = '';
				vm.runInNewContext(args[1], {
					process: {
						argv: ['probe', ...modules],
						stdout: {
							write: (line) => {
								stdout += line;
							},
						},
					},
					require: (name) => {
						if (name === requiredFailure || (name === '@fluxer/win-shell' && failure === 'require'))
							throw new Error(secret);
						return {loadError: name === '@fluxer/win-shell' && failure === 'load-error' ? new Error(secret) : null};
					},
				});
				return {stdout, stderr: '', status: 0};
			},
		},
		'@electron/common/DesktopIdentity': {
			DESKTOP_APP_NAME: 'sanalyer',
			WINDOWS_APP_USER_MODEL_ID: 'com.sanalyer.desktop',
			WINDOWS_LEGACY_APP_USER_MODEL_IDS: [],
			LINUX_DESKTOP_ENTRY_ID: 'sanalyer',
			WINDOWS_SHORTCUT_AUTHOR: 'sanalyer',
			WINDOWS_TOAST_ACTIVATOR_CLSID: '{test}',
		},
		'@electron/common/BuildChannel': {BUILD_CHANNEL: 'stable'},
		'@electron/common/UserDataPath': {isPortableMode: () => false},
		'@electron/main/AutostartLaunch': {AUTOSTART_LAUNCH_ARG: '--autostart'},
		'@electron/main/LaunchOptions': {getLinuxPortalsMode: () => 'auto'},
		'@electron/main/LinuxDesktopEntry': {GENERATED_MARKER: '# X-Generated-By=fluxer-desktop'},
		'@electron/main/AppStoreNativeBoundary': {APP_STORE_ADDON_PACKAGE: '@fluxer/app-store'},
		'@electron/main/GatewaySocketNativeBoundary': {GATEWAY_SOCKET_ADDON_PACKAGE: '@fluxer/gateway-socket'},
		'@electron/common/Logger': {createChildLogger: () => ({warn: (...args) => warnings.push(args)})},
		'@electron/common/GameActivityTypes': loadMainModule('../common/GameActivityTypes', {}, processStub),
		'@fluxer/game_catalog/src/GameCatalog': {getGameById() {}, matchGameByExe() {}, matchGameByProcess() {}},
		'@electron/main/GameActivityProbes': {
			listDarwinProcesses: () => Promise.reject(new Error('Unexpected process listing')),
			listLinuxProcesses: () => Promise.reject(new Error('Unexpected process listing')),
		},
		'@electron/main/LinuxLaunchPath': {getStableLinuxLaunchPath: () => processStub.execPath},
		'@electron/main/LinuxSandbox': {isFlatpakRuntime: () => false},
		'@electron/main/MainI18n': {t: (key) => key},
		'@electron/main/PrivilegedRendererDocuments': {
			requirePrivilegedRendererDocumentSender: (event) => {
				if (event.trusted === false) throw new Error('untrusted document');
			},
		},
		'electron-log': {warn: (...args) => warnings.push(args), info() {}, error() {}},
		electron: {
			app: {
				isPackaged: true,
				getPath: () => 'C:\\userdata',
				getVersion: () => '1.0',
				getLoginItemSettings: () => ({openAtLogin: false}),
				setLoginItemSettings: (...args) => nativeCalls.push(['login', ...args]),
			},
			ipcMain: {handle: (name, fn) => handlers.set(name, fn)},
			shell: {openExternal: (...args) => nativeCalls.push(['settings', ...args])},
		},
	};
	const handlers = new Map();
	const cache = new Map();
	const load = (name) =>
		loadMainModule(
			name,
			stubs,
			processStub,
			{
				console: {warn: (...args) => warnings.push(args), error: (...args) => warnings.push(args)},
			},
			cache,
		);
	return {
		load,
		warnings,
		probes,
		marker,
		stubs,
		processStub,
		handlers,
		nativeCalls,
		nativeLoads: () => nativeLoads,
		shortcutChecks: () => shortcutChecks,
	};
}

function runStartup(preflight, repairWindowsShortcuts = () => {}) {
	const index = readFileSync(new URL('./index.ts', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
	const start = index.indexOf("\ttry {\n\t\tnativeModulePreflight = runStartupPhase('native-module-preflight'");
	const end = index.indexOf('\n\tconst degradedNativeModules', start);
	assert.ok(start !== -1 && end > start);
	const exits = [];
	const dialogs = [];
	vm.runInNewContext(esbuild.transformSync(index.slice(start, end), {loader: 'ts'}).code, {
		runNativeModulePreflight: preflight,
		repairWindowsShortcuts,
		runStartupPhase: (_phase, fn) => fn(),
		log: {error() {}},
		console: {error() {}},
		t: (key) => key,
		dialog: {showErrorBox: (...args) => dialogs.push(args)},
		app: {exit: (code) => exits.push(['app', code])},
		process: {exit: (code) => exits.push(['process', code])},
	});
	return {exits, dialogs};
}

for (const failure of ['resolve', 'require', 'load-error', 'crash', 'inconclusive']) {
	test(`startup continues with one sanitized warning after win-shell ${failure}`, () => {
		const h = harness({failure});
		const result = runStartup(h.load('NativeModulePreflight').runNativeModulePreflight);
		assert.deepEqual(result.exits, []);
		assert.deepEqual(result.dialogs, []);
		assert.equal(h.warnings.length, 1);
		assert.match(JSON.stringify(h.warnings), /@fluxer\/win-shell/);
		assert.doesNotMatch(JSON.stringify(h.warnings), /private-account|SECRET_STACK/);
		assert.match(h.warnings[0][1], /^preflight-(failed|inconclusive)$/);
		assert.ok(![...h.marker.values()].some(Boolean));
		assert.equal(h.load('WinShell').loadWinShell(), null);
		assert.equal(h.nativeLoads(), 0);
		assert.ok(h.probes.flat().includes('@fluxer/windows-input-hook'));
	});
}

test('required failures remain fatal even when the optional child crashes', () => {
	const h = harness({failure: 'crash', requiredFailure: '@fluxer/windows-input-hook'});
	const result = runStartup(h.load('NativeModulePreflight').runNativeModulePreflight);
	assert.deepEqual(result.exits, [
		['app', 1],
		['process', 1],
	]);
	assert.equal(result.dialogs.length, 1);
	assert.match(result.dialogs[0][1], /@fluxer\/windows-input-hook/);
	assert.equal(h.warnings.length, 1);
});

for (const failure of [undefined, 'resolve']) {
	test(`required module ${failure ?? 'require'} failure stays fatal with healthy win-shell`, () => {
		const h = harness({requiredFailure: '@fluxer/windows-input-hook'});
		if (failure === 'resolve') {
			const resolve = h.stubs['node:module'].createRequire().resolve;
			h.stubs['node:module'].createRequire().resolve = (name) => {
				if (name === '@fluxer/windows-input-hook') throw new Error(secret);
				return resolve(name);
			};
		}
		const result = runStartup(h.load('NativeModulePreflight').runNativeModulePreflight);
		assert.deepEqual(result.exits, [
			['app', 1],
			['process', 1],
		]);
		assert.equal(result.dialogs.length, 1);
		assert.match(result.dialogs[0][1], /@fluxer\/windows-input-hook/);
		assert.equal(h.warnings.length, 0);
		assert.ok(![...h.marker.values()].some(Boolean));
	});
}

test('required probe inconclusive policy stays unchanged without a success marker', () => {
	const h = harness({requiredInconclusive: true});
	assert.deepEqual(runStartup(h.load('NativeModulePreflight').runNativeModulePreflight).exits, []);
	assert.equal(h.warnings.length, 1);
	assert.match(h.warnings[0][0], /preflight could not be completed/);
	assert.ok(![...h.marker.values()].some(Boolean));
	assert.ok(h.load('WinShell').loadWinShell());
});

test('a matching success marker skips every probe and lazy failure invalidates it for recovery', () => {
	const first = harness();
	first.load('NativeModulePreflight').runNativeModulePreflight();
	assert.ok([...first.marker.values()].some(Boolean));
	assert.equal(first.nativeLoads(), 0);
	const degraded = harness({failure: 'load-error', marker: first.marker});
	assert.deepEqual(runStartup(degraded.load('NativeModulePreflight').runNativeModulePreflight).exits, []);
	assert.equal(degraded.probes.length, 0);
	assert.equal(degraded.load('WinShell').loadWinShell(), null);
	assert.ok(![...first.marker.values()].some(Boolean));
	const recovered = harness({marker: first.marker});
	assert.deepEqual(runStartup(recovered.load('NativeModulePreflight').runNativeModulePreflight).exits, []);
	assert.ok([...first.marker.values()].some(Boolean));
	assert.ok(recovered.load('WinShell').loadWinShell());
	assert.equal(recovered.nativeLoads(), 1);
});

test('a healthy matching marker has zero spawns and no eager native load', () => {
	const first = harness();
	first.load('NativeModulePreflight').runNativeModulePreflight();
	const next = harness({marker: first.marker});
	next.load('NativeModulePreflight').runNativeModulePreflight();
	assert.equal(next.probes.length, 0);
	assert.equal(next.nativeLoads(), 0);
	assert.equal(next.warnings.length, 0);
});

for (const invalid of ['invalid JSON', JSON.stringify({version: 1, fingerprint: 'different'}), '']) {
	test(`an invalid marker (${invalid || 'empty'}) still runs isolated optional and required probes`, () => {
		const first = harness();
		first.load('NativeModulePreflight').runNativeModulePreflight();
		for (const key of first.marker.keys()) first.marker.set(key, invalid);
		const next = harness({marker: first.marker});
		next.load('NativeModulePreflight').runNativeModulePreflight();
		assert.equal(next.probes.length, 2);
		assert.deepEqual(plain(next.probes[0]), ['@fluxer/win-shell']);
		assert.ok(next.probes[1].includes('@fluxer/windows-input-hook'));
	});
}

test('an already disabled capability clears a success marker and cannot write a new one', () => {
	const first = harness();
	first.load('NativeModulePreflight').runNativeModulePreflight();
	const next = harness({marker: first.marker});
	next.load('WinShell').disableWinShell('require-failed');
	next.load('NativeModulePreflight').runNativeModulePreflight();
	assert.ok(![...next.marker.values()].some(Boolean));
	assert.ok(next.probes.flat().includes('@fluxer/windows-input-hook'));
	assert.equal(next.load('WinShell').loadWinShell(), null);
});

test('late invalidator registration clears a marker after another cache warned and required probe is inconclusive', () => {
	const first = harness();
	first.load('NativeModulePreflight').runNativeModulePreflight();
	const next = harness({marker: first.marker, requiredInconclusive: true});
	const earlyStubs = {
		...next.stubs,
		'node:module': {
			createRequire: () => () => {
				throw new Error(secret);
			},
		},
	};
	const early = loadMainModule('WinShell', earlyStubs, next.processStub, {}, new Map());
	assert.equal(early.loadWinShell(), null);
	assert.equal(next.warnings.length, 1);
	let markerAtFirstProbe;
	const spawn = next.stubs['node:child_process'].spawnSync;
	next.stubs['node:child_process'].spawnSync = (...args) => {
		markerAtFirstProbe ??= [...next.marker.values()].some(Boolean);
		return spawn(...args);
	};
	next.load('NativeModulePreflight').runNativeModulePreflight();
	assert.equal(markerAtFirstProbe, false, 'Late registration invalidates the marker before any probe');
	assert.ok(![...next.marker.values()].some(Boolean));
	assert.equal(next.load('WinShell').loadWinShell(), null);
	assert.equal(next.nativeLoads(), 0);
	assert.equal(next.warnings.length, 2, 'Only the separate required-inconclusive policy adds a warning');
});

test('independently bundled entry points share one warning and disabled binding in one process', () => {
	const h = harness({failure: 'require'});
	const bundle = () => {
		const result = esbuild.buildSync({
			stdin: {
				contents: "export {loadWinShell, disableWinShell} from './WinShell';",
				resolveDir: new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'),
				sourcefile: 'entry.ts',
				loader: 'ts',
			},
			bundle: true,
			write: false,
			platform: 'node',
			format: 'cjs',
			external: ['electron-log'],
			define: {'import.meta.url': JSON.stringify(import.meta.url)},
		});
		const module = {exports: {}};
		vm.runInNewContext(result.outputFiles[0].text, {
			module,
			exports: module.exports,
			process: h.processStub,
			require: (name) => h.stubs[name] ?? require(name),
		});
		return module.exports;
	};
	const first = bundle();
	const second = bundle();
	assert.notEqual(first, second);
	assert.equal(first.loadWinShell(), null);
	second.disableWinShell('preflight-failed');
	assert.equal(second.loadWinShell(), null);
	assert.equal(h.nativeLoads(), 1);
	assert.equal(h.warnings.length, 1);
	assert.doesNotMatch(JSON.stringify(h.warnings), /private-account|SECRET_STACK/);
});

for (const fast of [false, true]) {
	test(`Bootstrap keeps native shortcut repair after MainApp preflight (${fast ? 'fast callback' : 'normal launch'})`, () => {
		const h = harness({failure: 'crash'});
		h.processStub.windowsStore = false;
		const events = [];
		const callbacks = [];
		const velopack = {
			run() {
				events.push('velopack-run');
				if (fast) {
					for (const callback of callbacks) callback();
					throw new Error('fast-exit');
				}
				return this;
			},
		};
		for (const name of ['onAfterInstallFastCallback', 'onAfterUpdateFastCallback', 'onFirstRun', 'onRestarted']) {
			velopack[name] = (callback) => {
				callbacks.push(callback);
				return velopack;
			};
		}
		const source = readFileSync(new URL('./Bootstrap.ts', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
		assert.ok(source.includes('await import(MAIN_PROCESS_ENTRY_URL);'));
		assert.doesNotMatch(source, /WindowsShortcuts|repairWindowsShortcuts/);
		const start = source.indexOf("if (process.platform === 'win32') {");
		const end = source.indexOf('\narmOpenUrlForwarding();', start);
		assert.ok(start !== -1 && end > start);
		const code = esbuild.transformSync(`${source.slice(start, end)}\nmainStart();`, {loader: 'ts'}).code;
		const repair = () => {
			events.push('shortcut-repair');
			loadMainModule('WindowsShortcuts', h.stubs, h.processStub, {}, new Map()).repairWindowsShortcuts();
		};
		const run = () =>
			vm.runInNewContext(code, {
				process: h.processStub,
				mainStart: () => {
					events.push('preflight');
					runStartup(h.load('NativeModulePreflight').runNativeModulePreflight, repair);
				},
				requireModule: (name) => {
					assert.equal(name, 'velopack');
					return {VelopackApp: {build: () => velopack}};
				},
				electronApp: {setAppUserModelId() {}, setToastActivatorCLSID() {}},
				WINDOWS_APP_USER_MODEL_ID: 'com.sanalyer.desktop',
				WINDOWS_TOAST_ACTIVATOR_CLSID: '{test}',
			});
		if (fast) assert.throws(run, /fast-exit/);
		else run();
		assert.equal(h.nativeLoads(), 0, 'Native binding must not be loaded before an isolated probe');
		assert.deepEqual(events, fast ? ['velopack-run'] : ['velopack-run', 'preflight', 'shortcut-repair']);
		assert.equal(h.warnings.length, fast ? 0 : 1);
		if (fast) return;
		events.length = 0;
		h.processStub.windowsStore = true;
		run();
		assert.deepEqual(events, ['preflight', 'shortcut-repair'], 'A Store package never runs the Velopack updater');
	});
}

test('all consumers share unavailable capability without native calls or a Store settings prompt', async () => {
	const native = Object.fromEntries(
		[
			'listProcesses',
			'createShortcut',
			'getStartupTaskState',
			'setStartupTaskEnabled',
			'getTaskbarPinState',
			'requestTaskbarPin',
			'getUserNotificationState',
		].map((name) => [
			name,
			() => {
				throw new Error(`native ${name} called`);
			},
		]),
	);
	const h = harness({failure: 'load-error', native});
	h.load('NativeModulePreflight').runNativeModulePreflight();
	const window = {
		webContents: {},
		isDestroyed: () => false,
		isFocused: () => true,
		isMinimized: () => false,
		getNativeWindowHandle: () => Buffer.alloc(8),
	};
	h.load('TaskbarPin').registerTaskbarPinIpcHandlers(() => window);
	const event = {sender: window.webContents, trusted: true};
	assert.deepEqual(plain(await h.handlers.get('taskbar-pin:get-state')(event)), {
		supported: false,
		pinned: false,
		lafRequired: false,
	});
	assert.equal(await h.handlers.get('taskbar-pin:request')(event), false);
	assert.equal(await h.handlers.get('taskbar-pin:request')(event), false);
	await assert.rejects(async () => h.handlers.get('taskbar-pin:request')({...event, trusted: false}), /untrusted/);
	await assert.rejects(async () => h.handlers.get('taskbar-pin:get-state')({...event, sender: {}}), /main window/);
	window.isFocused = () => false;
	await assert.rejects(async () => h.handlers.get('taskbar-pin:request')(event), /foreground/);
	window.isFocused = () => true;
	h.load('Autostart').registerAutostartHandlers();
	assert.equal(await h.handlers.get('autostart-is-enabled')(), false);
	assert.equal(await h.handlers.get('autostart-claim-store-prompt')(), false);
	await h.handlers.get('autostart-enable')();
	await h.handlers.get('autostart-disable')();
	h.load('WindowsShortcuts').repairWindowsShortcuts();
	assert.equal(h.shortcutChecks(), 1);
	assert.deepEqual(plain(await h.load('NotificationState').getNotificationSoundPolicy()), {
		shouldPlaySound: true,
		reason: null,
	});
	const detector = new (h.load('GameActivityDetection').GameActivityDetection)({
		setInterval: () => ({unref() {}}),
		clearInterval() {},
	});
	detector.configure({account_id: 'account', generation: 1, enabled: true});
	await detector.poll();
	assert.equal(detector.getState().state, 'unavailable');
	detector.stop();
	assert.equal(h.nativeLoads(), 0);
	assert.equal(h.nativeCalls.length, 0);
	assert.equal(h.warnings.length, 1);
	assert.ok([...h.marker.keys()].every((name) => name.endsWith('native-module-preflight-v1.json')));
});

test('Windows shortcut repair does nothing on Linux', () => {
	const h = harness({platform: 'linux'});
	h.load('WindowsShortcuts').repairWindowsShortcuts();
	assert.equal(h.shortcutChecks(), 0);
	assert.equal(h.nativeLoads(), 0);
});

test('missing binding remains unavailable through game activity IPC and rejects untrusted senders', async () => {
	const h = harness({failure: 'require'});
	h.load('NativeModulePreflight').runNativeModulePreflight();
	h.stubs['@electron/main/GameActivityDetection'] = h.load('GameActivityDetection');
	h.stubs['@electron/common/DesktopConfig'] = {getGameActivityRules: () => [], setGameActivityRules() {}};
	h.stubs.electron.ipcMain.removeHandler = (name) => h.handlers.delete(name);
	const sent = [];
	const frame = {processId: 1, routingId: 2, send: (_channel, state) => sent.push(plain(state))};
	const sender = Object.assign(new EventEmitter(), {mainFrame: frame, isDestroyed: () => false});
	const ipc = h.load('GameActivityIpc');
	ipc.registerGameActivityIpcHandlers(() => ({webContents: sender, isDestroyed: () => false}));
	const event = {sender, senderFrame: frame, trusted: true};
	const invoke = (name, payload) => h.handlers.get(`game-activity:${name}`)(event, payload);
	await invoke('configure', {account_id: '123', generation: 1, enabled: true});
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal((await invoke('get-state', {generation: 1})).state, 'unavailable');
	assert.deepEqual(plain(await invoke('list-candidates', {generation: 1})), {state: 'unavailable'});
	await assert.rejects(
		async () => h.handlers.get('game-activity:get-state')({...event, trusted: false}, {generation: 1}),
		/untrusted/,
	);
	assert.ok(sent.every((state) => state.activity === null));
	await ipc.cleanupGameActivityIpc();
	assert.equal(h.nativeLoads(), 0);
	assert.equal(h.warnings.length, 1);
});

test('direct Windows install keeps Electron autostart when native binding is unavailable', async () => {
	const h = harness({failure: 'require'});
	h.processStub.windowsStore = false;
	h.load('Autostart').registerAutostartHandlers();
	await h.handlers.get('autostart-enable')();
	await h.handlers.get('autostart-disable')();
	assert.ok(h.nativeCalls.some(([name, value]) => name === 'login' && value.openAtLogin));
	assert.ok(h.nativeCalls.some(([name, value]) => name === 'login' && !value.openAtLogin));
	assert.equal(h.warnings.length, 1);
});

for (const platform of ['linux', 'darwin']) {
	test(`shared loader is lazy and closed on ${platform}`, () => {
		const h = harness({platform});
		assert.equal(h.load('WinShell').loadWinShell(), null);
		assert.equal(h.nativeLoads(), 0);
		assert.equal(h.warnings.length, 0);
	});
}

for (const failure of ['require', 'load-error']) {
	test(`lazy loader caches ${failure} and suppresses raw diagnostics`, () => {
		const h = harness({failure});
		const shell = h.load('WinShell');
		assert.equal(shell.loadWinShell(), null);
		assert.equal(shell.loadWinShell(), null);
		shell.disableWinShell('preflight-failed');
		assert.equal(h.nativeLoads(), 1);
		assert.equal(h.warnings.length, 1);
		assert.doesNotMatch(JSON.stringify(h.warnings), /private-account|SECRET_STACK/);
	});
}

test('successful shared loading is lazy and cached', () => {
	const native = {loadError: null};
	const h = harness({native});
	const shell = h.load('WinShell');
	assert.equal(h.nativeLoads(), 0);
	assert.equal(shell.loadWinShell(), native);
	assert.equal(shell.loadWinShell(), native);
	assert.equal(h.nativeLoads(), 1);
	assert.equal(h.warnings.length, 0);
});
