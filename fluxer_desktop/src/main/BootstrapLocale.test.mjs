// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {REPOSITORY_ROOT} from './LocalAppTestSupport.test.mjs';

function runBootstrap(mode) {
	const appData = mkdtempSync(path.join(tmpdir(), 'bootstrap-locale-'));
	const script = `
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {installElectronStub, installTestModuleStub} from './fluxer_desktop/src/main/LocalAppTestSupport.test.mjs';
const appData = process.argv[1];
const mode = process.argv[2];
const savedUserData = path.join(appData, 'sanalyer_desktop');
mkdirSync(savedUserData);
writeFileSync(path.join(savedUserData, 'native-strings.json'), JSON.stringify({locale: 'en-GB', strings: {
  'desktop.shellUpdate.openMicrosoftStore': 'Open Microsoft Store',
  'desktop.shellUpdate.storeSecurityRequired': 'Install the required security update from Microsoft Store before {appName} starts.'
}}));
globalThis.nativeStringReads = 0;
installTestModuleStub('node:fs', "import fs from 'fs'; export * from 'fs'; export default new Proxy(fs, {get(target, key) { if (key === 'readFileSync') return (...args) => { if (String(args[0]).endsWith('native-strings.json')) globalThis.nativeStringReads++; return target.readFileSync(...args); }; return Reflect.get(target, key); }});");
let userData = path.join(appData, 'not-yet-configured');
installElectronStub({app: {
  isPackaged: true, isReady: () => false,
  getPath: (name) => name === 'appData' ? appData : userData,
  setPath: (name, value) => { if (name === 'userData') userData = value; },
  requestSingleInstanceLock: () => true, whenReady: async () => {}, getVersion: () => '1.0.0',
  setToastActivatorCLSID() {}, once() {}, quit() {}, exit() {}
}});
Object.defineProperty(process, 'platform', {value: 'win32'});
Object.defineProperty(process, 'windowsStore', {value: true});
process.env.FLUXER_MODULES = '1';
delete process.env.FLUXER_MODULE_SYSTEM;
delete process.env.FLUXER_PORTABLE;
globalThis.__FLUXER_MAIN_APP_OUTPUT_FILE__ = 'main-entry-must-not-load.js';
installTestModuleStub('@electron/common/BuildChannel', "export const BUILD_CHANNEL = 'stable';");
const noops = (module, names) => installTestModuleStub(module, names.map(name => 'export const ' + name + ' = () => {};').join(';'));
noops('@electron/main/ModuleBootHandoff', ['armOpenUrlForwarding', 'observeRendererLaunchConfirmed', 'armSecondInstanceForwarding', 'onMainWindowCreated', 'onMainWindowReady', 'setCommittedModuleFiles', 'setOnDemandModuleInstaller', 'setSecondInstanceSink']);
noops('@electron/main/ModuleRendererReload', ['watchModuleRendererReload']);
noops('@electron/main/ModuleUpdateGate', ['offerPendingModuleUpdate']);
noops('@electron/main/WindowsShortcuts', ['repairWindowsShortcuts']);
noops('@electron/main/ChromiumRuntime', ['appendWindowsGpuDriverWorkaroundSwitches']);
noops('@electron/main/PreReadyChromium', ['applyPreReadyChromiumConfiguration']);
noops('@electron/main/NativeProbeCache', ['armNativeProbeCache']);
noops('@electron/main/LinuxLaunchPath', ['relaunchStableLaunchPath']);
noops('@electron/main/ModuleOnDemand', ['createOnDemandModuleInstaller']);
noops('@electron/main/ModuleNetworkFetch', ['moduleNetworkFetch']);
installTestModuleStub('@electron/main/AutostartLaunch', 'export const isStartMinimizedLaunch = () => false;');
installTestModuleStub('@electron/main/InstanceModulePreference', 'export const instanceTurnedModulesOff = () => false;');
installTestModuleStub('@electron/main/LocalAppProtocol', 'export const getDesktopLocalAppProtocol = () => ({registerSchemes() {}});');
installTestModuleStub('@electron/main/ModuleStore', 'export const getModuleStoreRoot = root => root; export const ModuleStore = {open: async () => ({storeRoot: "unused", buildModuleIndex: async () => ({})})};');
globalThis.bootstrapMode = mode;
installTestModuleStub('@electron/main/ModuleUpdater', "export const ModuleUpdaterStatus = {CHECKING: 'checking', RETRY_WAIT: 'retry-wait', BLOCKED_UPDATE_REQUIRED: 'blocked-update-required'}; export class ModuleUpdater { async run() { return globalThis.bootstrapMode === 'normal' ? {status: 'launching', rolledBack: false, belowFloor: [], launchAttempt: {committed: {}}} : {status: 'blocked-shell-update', latestVersion: '2.0.0', minimumVersion: '2.0.0', requiredSecurityUpdate: true}; } }");
const blocked = new Promise(resolve => { globalThis.reportBlocked = resolve; });
if (mode === 'normal') {
  installTestModuleStub(new URL('./fluxer_desktop/src/main/main-entry-must-not-load.js', import.meta.url).href, "import {initializeMainI18n, t} from '@electron/main/MainI18n'; initializeMainI18n(); globalThis.reportBlocked({action: {label: t('desktop.shellUpdate.openMicrosoftStore')}, message: t('desktop.shellUpdate.storeSecurityRequired')});");
}
installTestModuleStub('@electron/main/SplashWindow', \`
export const SplashLayout = {SPLASH: 'splash', MANUAL_UPDATE: 'manual-update'};
export const SplashStatus = {BLOCKED_SECURITY_UPDATE_MANAGED: 'blocked-security-update-managed', BLOCKED_SHELL_UPDATE_MANAGED: 'blocked-shell-update-managed'};
export const SplashActionKind = {DOWNLOAD: 'download', QUIT: 'quit'};
export const SplashAction = {QUIT: {kind: 'quit', label: 'Quit'}};
export const setSplashState = state => { if (state.status === 'blocked-security-update-managed') globalThis.reportBlocked(state); };
export const onSplashOpenDownload = () => () => {};
export const openSplashWindow = () => {};
export const closeSplashWindow = () => {};
export const focusSplashWindow = () => {};
export const markSplashLaunching = () => {};
export const onSplashNetworkOnline = () => {};
export const onSplashQuit = () => {};
export const onSplashRetry = () => {};
export const releaseSplashAffordance = () => {};
\`);
await import('./fluxer_desktop/src/main/Bootstrap.ts');
const timeout = setTimeout(() => { throw new Error('Bootstrap never reached the Store update block'); }, 2000);
const state = await blocked;
clearTimeout(timeout);
process.stdout.write(JSON.stringify({state, userData, savedUserData, nativeStringReads: globalThis.nativeStringReads}));
`;
	try {
		return JSON.parse(
			execFileSync(process.execPath, ['--input-type=module', '-e', script, appData, mode], {
				cwd: REPOSITORY_ROOT,
				encoding: 'utf8',
				timeout: 5000,
			}),
		);
	} finally {
		rmSync(appData, {recursive: true, force: true});
	}
}

test('the blocked bootstrap loads persisted native strings before importing the main app or renderer', () => {
	const result = runBootstrap('blocked');
	assert.equal(result.userData, result.savedUserData);
	assert.equal(result.state.action.label, 'Open Microsoft Store');
	assert.equal(result.state.message, 'Install the required security update from Microsoft Store before sanalyer starts.');
	assert.equal(result.nativeStringReads, 1);
});

test('the normal bootstrap leaves the single persisted native-string read to the main app', () => {
	const result = runBootstrap('normal');
	assert.equal(result.state.action.label, 'Open Microsoft Store');
	assert.equal(result.nativeStringReads, 1);
});
