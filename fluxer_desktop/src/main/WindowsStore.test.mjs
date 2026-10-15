// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, describe, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {loadMainModule} from './WinShellTestHarness.mjs';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const EXEC_PATH = 'C:\\Program Files\\WindowsApps\\sanalyer_1.0.1.0_x64__abc\\app\\sanalyer.exe';
const STORE_PACKAGES_KEY =
	'HKEY_CURRENT_USER\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages';
const STORE_IDENTITY_NAME = 'sanalyer.sanalyer';

function load(relativePath, stubs, processOverrides) {
	stubs = {'@electron/common/BuildChannel': {BUILD_CHANNEL: 'stable'}, ...stubs};
	const url = new URL(relativePath, import.meta.url);
	const sourcePath = fileURLToPath(url);
	const code = esbuild.transformSync(readFileSync(sourcePath, 'utf8'), {
		loader: 'ts',
		format: 'cjs',
		platform: 'node',
		target: 'node20',
		define: {'import.meta.url': JSON.stringify(url.href)},
	}).code;
	const module = {exports: {}};
	const context = vm.createContext({
		module,
		exports: module.exports,
		console,
		URL,
		Promise,
		setTimeout,
		clearTimeout,
		process: {...process, platform: 'win32', argv: [EXEC_PATH], execPath: EXEC_PATH, env: {}, ...processOverrides},
		require: (specifier) => {
			if (specifier in stubs) return stubs[specifier];
			if (specifier === '@electron/main/WinShell') {
				return loadMainModule('WinShell', stubs, context.process);
			}
			if (specifier.startsWith('@electron/')) {
				return load(`../${specifier.slice('@electron/'.length)}.ts`, stubs, processOverrides);
			}
			if (specifier.startsWith('@fluxer/desktop_ipc/') || specifier.startsWith('@fluxer/instance_bootstrap/')) {
				return load(`../../../packages/${specifier.slice('@fluxer/'.length)}.ts`, stubs, processOverrides);
			}
			return require(specifier);
		},
	});
	vm.runInContext(code, context, {filename: sourcePath});
	return module.exports;
}

function electronStub() {
	const handlers = new Map();
	const calls = {
		setLoginItemSettings: [],
		setAsDefaultProtocolClient: [],
		removeAsDefaultProtocolClient: [],
		openExternal: [],
	};
	return {
		handlers,
		calls,
		module: {
			app: {
				isPackaged: true,
				getVersion: () => '1.0.1',
				getPath: () => 'C:\\Users\\sanalyer\\AppData\\Roaming\\sanalyer',
				on() {},
				getLoginItemSettings: () => ({openAtLogin: false, executableWillLaunchAtLogin: false, launchItems: []}),
				setLoginItemSettings: (settings) => calls.setLoginItemSettings.push(settings),
				setAsDefaultProtocolClient: (...args) => {
					calls.setAsDefaultProtocolClient.push(args);
					return true;
				},
				removeAsDefaultProtocolClient: (...args) => {
					calls.removeAsDefaultProtocolClient.push(args);
					return true;
				},
			},
			autoUpdater: {on() {}},
			ipcMain: {handle: (channel, handler) => handlers.set(channel, handler)},
			shell: {openExternal: async (url) => calls.openExternal.push(url)},
		},
	};
}

const logStub = {info() {}, warn() {}, error() {}, debug() {}, transports: {file: {}, console: {}}};
const identityStub = {
	DESKTOP_APP_NAME: 'sanalyer',
	LINUX_DESKTOP_ENTRY_ID: 'sanalyer',
	LEGACY_LINUX_DESKTOP_ENTRY_ID: 'sanalyer',
	LINUX_ICON_NAME: 'sanalyer',
	WINDOWS_APP_USER_MODEL_ID: 'com.sanalyer.desktop',
	WINDOWS_LEGACY_APP_USER_MODEL_IDS: [],
	WINDOWS_STORE_IDENTITY_NAME: STORE_IDENTITY_NAME,
};

function loadUpdater(windowsStore) {
	const electron = electronStub();
	const events = [];
	const velopack = {constructed: 0};
	const exports = load(
		'./Updater.ts',
		{
			'node:module': {
				...require('node:module'),
				createRequire: () => (name) => {
					assert.equal(name, 'velopack');
					return {
						UpdateManager: class {
							constructor() {
								velopack.constructed += 1;
							}
							getCurrentVersion() {
								return '1.0.1';
							}
							getUpdatePendingRestart() {
								return null;
							}
							async checkForUpdatesAsync() {
								return null;
							}
						},
					};
				},
			},
			'@electron/common/UserDataPath': {isPortableMode: () => false},
			'@electron/main/AppImageUpdate': {isRunningFromAppImage: () => false},
			'@electron/main/DesktopTray': {destroyDesktopTray() {}},
			'@electron/main/LinuxSandbox': {isFlatpakRuntime: () => false},
			'@electron/main/Troubleshooting': {relaunchAndExit() {}},
			'@electron/main/UpdaterApplyState': {
				readVelopackApplyAttempt: () => null,
				recordVelopackApplyAttempt() {},
				clearVelopackApplyAttempt() {},
			},
			'@electron/main/UpdaterDownloads': {
				DOWNLOAD_PAGE_URL: 'https://sanalyer.com/indir',
				UPDATE_BASE_URL: 'https://dl.sanalyer.com/desktop/stable/win32/x64',
				MANUAL_DESKTOP_FORMATS: [],
			},
			'@electron/main/Window': {setQuitting() {}},
			electron: electron.module,
			'electron-log': logStub,
		},
		{windowsStore},
	);
	exports.registerUpdater(() => ({webContents: {send: (_channel, event) => events.push(event)}}));
	return {electron, events, velopack};
}

function loadDeepLinks(windowsStore, installedPackages = '') {
	const electron = electronStub();
	const exports = load(
		'./DeepLinks.ts',
		{
			'node:child_process': {
				execFile: (file, args, _options, callback) => {
					assert.equal(file, 'reg.exe');
					assert.deepEqual([...args], ['query', STORE_PACKAGES_KEY]);
					callback(null, installedPackages);
				},
			},
			'@electron/common/Constants': {APP_PROTOCOL: 'sanalyer'},
			'@electron/common/DesktopIdentity': identityStub,
			'@electron/main/JumpList': {parseJumpListTaskFromArgv: () => null},
			'@electron/main/LinuxDesktopEntry': {ensureLinuxProtocolDesktopEntry() {}},
			'@electron/main/RecentDocuments': {recordRecentDeepLink() {}},
			'@electron/main/Window': {getMainWindow: () => null, showWindow() {}},
			electron: electron.module,
		},
		{windowsStore},
	);
	exports.initializeDeepLinks();
	return electron;
}

const userDataDirs = [];
after(() => {
	for (const dir of userDataDirs) rmSync(dir, {recursive: true, force: true});
});

function loadAutostart(
	windowsStore,
	{
		taskState = 'disabled',
		requestResult = 'enabled',
		startupTaskApi = true,
		initialized = false,
		prompted = false,
		platform = 'win32',
	} = {},
) {
	const electron = electronStub();
	const userData = mkdtempSync(path.join(tmpdir(), 'sanalyer-autostart-'));
	userDataDirs.push(userData);
	if (initialized) writeFileSync(path.join(userData, 'autostart-initialized-v2'), '1');
	if (prompted) writeFileSync(path.join(userData, 'store-autostart-prompt-v1'), '1');
	electron.module.app.getPath = () => userData;
	const runValues = [];
	const startupTaskCalls = [];
	const exports = load(
		'./Autostart.ts',
		{
			'node:module': {
				...require('node:module'),
				createRequire: () => (name) => {
					assert.equal(name, '@fluxer/win-shell');
					return {
						setCurrentUserRunValue: async (value) => runValues.push(value),
						deleteCurrentUserRunValue: async () => {},
						getCurrentUserRunValue: async () => null,
						getStartupTaskState: startupTaskApi
							? async (taskId) => {
									startupTaskCalls.push(['get', taskId]);
									if (taskState instanceof Error) throw taskState;
									return taskState;
								}
							: null,
						setStartupTaskEnabled: startupTaskApi
							? async (taskId, enabled) => {
									startupTaskCalls.push(['set', taskId, enabled]);
									if (requestResult instanceof Error) throw requestResult;
									taskState = enabled ? requestResult : 'disabled';
									return taskState;
								}
							: null,
						loadError: null,
					};
				},
			},
			'@electron/common/DesktopIdentity': identityStub,
			'@electron/common/UserDataPath': {isPortableMode: () => false},
			'@electron/main/LinuxLaunchPath': {getStableLinuxLaunchPath: () => EXEC_PATH},
			'@electron/main/LinuxSandbox': {isFlatpakRuntime: () => false},
			'@electron/main/MainI18n': {t: (key) => key},
			electron: electron.module,
			'electron-log': logStub,
		},
		{windowsStore, platform, env: {XDG_CONFIG_HOME: userData}},
	);
	exports.registerAutostartHandlers();
	const invoke = (channel) => electron.handlers.get(channel)({});
	const setTaskState = (state) => {
		taskState = state;
	};
	return {
		electron,
		invoke,
		runValues,
		startupTaskCalls,
		userData,
		setTaskState,
		register: exports.registerAutostartHandlers,
	};
}

function nextTick() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('Microsoft Store (MSIX) package', () => {
	for (const platform of ['darwin', 'linux']) {
		test(`keeps Store startup paths closed on ${platform}`, async () => {
			const {electron, invoke, startupTaskCalls, runValues} = loadAutostart(true, {platform});

			assert.equal(await invoke('autostart-is-initialized'), false);
			assert.equal(await invoke('autostart-claim-store-prompt'), false);
			await invoke('autostart-enable');
			await invoke('autostart-disable');

			assert.deepEqual(startupTaskCalls, []);
			assert.deepEqual(runValues, []);
			assert.deepEqual(electron.calls.openExternal, []);
			assert.deepEqual(
				structuredClone(electron.calls.setLoginItemSettings),
				platform === 'darwin' ? [{openAtLogin: true}, {openAtLogin: false}] : [],
			);
		});
	}

	test('leaves updates to the Store: no Velopack manager, updater reports a managed package', async () => {
		const {electron, events, velopack} = loadUpdater(true);

		await electron.handlers.get('updater-check')({}, 'user');
		await electron.handlers.get('updater-download')({}, 'user');

		assert.equal(velopack.constructed, 0);
		assert.deepEqual(structuredClone(events), [
			{type: 'unsupported', context: 'user', reason: 'managed-package'},
			{type: 'unsupported', context: 'user', reason: 'managed-package'},
		]);
	});

	test('keeps Velopack for the direct download install', async () => {
		const {electron, events, velopack} = loadUpdater(undefined);

		await electron.handlers.get('updater-check')({}, 'user');

		assert.equal(velopack.constructed, 1);
		assert.deepEqual(
			events.map((event) => event.type),
			['checking', 'not-available'],
		);
	});

	test('does not register sanalyer:// itself inside the Store package', async () => {
		const electron = loadDeepLinks(true);
		await nextTick();

		assert.deepEqual(electron.calls.setAsDefaultProtocolClient, []);
	});

	test('registers sanalyer:// for the direct download install', async () => {
		const electron = loadDeepLinks(undefined, `${STORE_PACKAGES_KEY}\\Some.Other.App_1.0.0.0_x64__xyz\r\n`);
		await nextTick();

		assert.deepEqual(electron.calls.setAsDefaultProtocolClient, [['sanalyer']]);
	});

	test('leaves sanalyer:// to the Store copy when it is installed next to the direct download', async () => {
		const electron = loadDeepLinks(
			undefined,
			`${STORE_PACKAGES_KEY}\\${STORE_IDENTITY_NAME}_1.0.1.0_x64__8wekyb3d8bbwe\r\n`,
		);
		await nextTick();

		assert.deepEqual(electron.calls.setAsDefaultProtocolClient, []);
		assert.deepEqual(electron.calls.removeAsDefaultProtocolClient, [['sanalyer']]);
	});

	test('switches the MSIX startup task instead of login items', async () => {
		const {electron, invoke, runValues, startupTaskCalls} = loadAutostart(true, {initialized: true});

		assert.equal(await invoke('autostart-is-enabled'), false);
		await invoke('autostart-enable');
		assert.equal(await invoke('autostart-is-enabled'), true);
		await invoke('autostart-disable');
		assert.equal(await invoke('autostart-is-enabled'), false);

		assert.deepEqual(electron.calls.setLoginItemSettings, []);
		assert.deepEqual(runValues, []);
		assert.deepEqual(electron.calls.openExternal, []);
		assert.deepEqual(
			startupTaskCalls.filter(([kind]) => kind === 'set'),
			[
				['set', 'SanalyerStartup', true],
				['set', 'SanalyerStartup', false],
			],
		);
		// Keeps a web build that silently turns autostart on at first launch from doing so in the Store copy.
		assert.equal(await invoke('autostart-is-initialized'), true);
	});

	test('sends the user to startup apps settings when Windows keeps the task off', async () => {
		const {electron, invoke} = loadAutostart(true, {requestResult: 'disabled-by-user'});

		await invoke('autostart-enable');

		assert.deepEqual(electron.calls.openExternal, ['ms-settings:startupapps']);
		assert.equal(await invoke('autostart-is-enabled'), false);
	});

	test('falls back to startup apps settings without the startup task API', async () => {
		const {electron, invoke} = loadAutostart(true, {startupTaskApi: false});

		await invoke('autostart-enable');
		await invoke('autostart-disable');

		assert.deepEqual(electron.calls.openExternal, ['ms-settings:startupapps', 'ms-settings:startupapps']);
		assert.equal(await invoke('autostart-is-enabled'), false);
		assert.equal(await invoke('autostart-claim-store-prompt'), false);
	});

	test('enables Store startup once at first launch and never asks the web question', async () => {
		const {invoke, startupTaskCalls, userData, setTaskState, register} = loadAutostart(true);
		await nextTick();
		assert.deepEqual(startupTaskCalls, [
			['get', 'SanalyerStartup'],
			['set', 'SanalyerStartup', true],
		]);
		assert.equal(readFileSync(path.join(userData, 'autostart-initialized-v2'), 'utf8'), '1');
		setTaskState('disabled');
		register();
		await nextTick();
		assert.equal(await invoke('autostart-claim-store-prompt'), false);
		assert.equal(startupTaskCalls.length, 2);
	});

	test('does not retry a marked install even when Windows reports Disabled', async () => {
		const {startupTaskCalls, invoke} = loadAutostart(true, {initialized: true});
		await nextTick();
		assert.equal(await invoke('autostart-claim-store-prompt'), false);
		assert.deepEqual(startupTaskCalls, []);
	});

	test('preserves a 1.0.6 Store prompt refusal when the startup task is disabled', async () => {
		const {startupTaskCalls, userData, invoke, register} = loadAutostart(true, {prompted: true});
		await nextTick();
		assert.deepEqual(startupTaskCalls, [['get', 'SanalyerStartup']]);
		assert.equal(readFileSync(path.join(userData, 'autostart-initialized-v2'), 'utf8'), '1');
		assert.equal(readFileSync(path.join(userData, 'store-autostart-prompt-v1'), 'utf8'), '1');
		register();
		await nextTick();
		assert.deepEqual(startupTaskCalls, [['get', 'SanalyerStartup']]);
		assert.equal(await invoke('autostart-claim-store-prompt'), false);
	});

	test('preserves user and policy choices and already-enabled startup tasks', async () => {
		for (const taskState of ['enabled', 'enabled-by-policy', 'disabled-by-user', 'disabled-by-policy']) {
			const {invoke, startupTaskCalls, userData} = loadAutostart(true, {taskState});
			await nextTick();
			assert.equal(await invoke('autostart-claim-store-prompt'), false, taskState);
			assert.deepEqual(startupTaskCalls, [['get', 'SanalyerStartup']]);
			assert.deepEqual(readdirSync(userData), ['autostart-initialized-v2']);
		}
	});

	for (const failure of [null, new Error('StartupTask::GetAsync failed'), 'unknown']) {
		test(`retries at a later launch without marking startup state ${failure}`, async () => {
			const {invoke, userData, startupTaskCalls, setTaskState, register} = loadAutostart(true, {taskState: failure});
			await nextTick();
			assert.equal(await invoke('autostart-claim-store-prompt'), false);
			assert.deepEqual(readdirSync(userData), []);
			assert.deepEqual(startupTaskCalls, [['get', 'SanalyerStartup']]);
			setTaskState('disabled');
			register();
			await nextTick();
			assert.deepEqual(startupTaskCalls, [
				['get', 'SanalyerStartup'],
				['get', 'SanalyerStartup'],
				['set', 'SanalyerStartup', true],
			]);
			assert.deepEqual(readdirSync(userData), ['autostart-initialized-v2']);
		});
	}

	test('does not open Windows Settings or retry a failed automatic enable', async () => {
		for (const requestResult of ['disabled', new Error('RequestEnableAsync failed')]) {
			const {electron, userData, startupTaskCalls, register} = loadAutostart(true, {requestResult});
			await nextTick();
			register();
			await nextTick();
			assert.deepEqual(startupTaskCalls, [
				['get', 'SanalyerStartup'],
				['set', 'SanalyerStartup', true],
			]);
			assert.deepEqual(electron.calls.openExternal, []);
			assert.deepEqual(readdirSync(userData), ['autostart-initialized-v2']);
		}
	});

	test('keeps login item autostart and never asks in the direct download install', async () => {
		const {electron, invoke, runValues, startupTaskCalls, userData} = loadAutostart(undefined);

		await invoke('autostart-enable');

		assert.equal(electron.calls.setLoginItemSettings[0].openAtLogin, true);
		assert.equal(runValues.length, 1);
		assert.deepEqual(electron.calls.openExternal, []);
		assert.equal(await invoke('autostart-claim-store-prompt'), false);
		assert.deepEqual(startupTaskCalls, []);
		assert.deepEqual(readdirSync(userData), []);
	});

	test('leaves the app user model id to the package identity inside the Store package', () => {
		const main = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');

		assert.equal((main.match(/app\.setAppUserModelId\(/g) ?? []).length, 1);
		assert.match(main, /if \(!process\.windowsStore\) \{\s*app\.setAppUserModelId\(WINDOWS_APP_USER_MODEL_ID\);\s*\}/);
	});

	test('manifest declares sanalyer://, a disabled startup task and the toast activator main registers', () => {
		const previousArch = process.env.ELECTRON_ARCH;
		process.env.ELECTRON_ARCH = 'x64';
		let config;
		try {
			config = require('../../electron-builder.config.cjs');
		} finally {
			if (previousArch === undefined) delete process.env.ELECTRON_ARCH;
			else process.env.ELECTRON_ARCH = previousArch;
		}
		const identity = load('../common/DesktopIdentity.ts', {
			'@electron/common/BuildChannel': {BUILD_CHANNEL: 'stable'},
		});
		const clsid = identity.WINDOWS_TOAST_ACTIVATOR_CLSID.replace(/[{}]/g, '');
		const extensions = readFileSync(
			path.resolve(fileURLToPath(new URL('../../', import.meta.url)), config.msix.customExtensionsPath),
			'utf8',
		);

		assert.equal(config.msix.identityName, identity.WINDOWS_STORE_IDENTITY_NAME);
		// Partner Center > sanalyer (9P1SNJ2H2W9H) > Product identity; Application Id as in the published 0.4.4.0 package.
		assert.deepEqual(
			{
				identityName: config.msix.identityName,
				publisher: config.msix.publisher,
				publisherDisplayName: config.msix.publisherDisplayName,
				applicationId: config.msix.applicationId,
			},
			{
				identityName: 'sanalyer.sanalyer',
				publisher: 'CN=6B905D36-79B1-4EA5-8E9B-F18A23784188',
				publisherDisplayName: 'sanalyer',
				applicationId: 'sanalyer',
			},
		);
		assert.deepEqual(config.msix.languages, ['tr-TR', 'en-US']);
		assert.equal(config.msix.setBuildNumber, false);
		assert.deepEqual(
			config.protocols.flatMap((protocol) => protocol.schemes),
			['sanalyer'],
		);
		assert.match(extensions, /<desktop:StartupTask TaskId="SanalyerStartup" Enabled="false"/);
		assert.match(extensions, new RegExp(`<com:Class Id="${clsid}"`));
		assert.match(extensions, new RegExp(`ToastActivatorCLSID="${clsid}"`));
		assert.equal((extensions.match(/Executable="app\\sanalyer\.exe"/g) ?? []).length, 2);
	});
});
