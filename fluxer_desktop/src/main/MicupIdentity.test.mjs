// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {describe, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const FLUXER_TOAST_ACTIVATOR_CLSIDS = [
	'{48EEF21B-F3AE-431E-8CF2-386FFB2143F2}',
	'{9CEDB5C0-3552-43B0-A279-2232E0CDF74C}',
];
const GUID_PATTERN = /^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/;

function load(relativePath, {stubs = {}, globals = {}} = {}) {
	const sourcePath = fileURLToPath(new URL(relativePath, import.meta.url));
	const code = esbuild.transformSync(readFileSync(sourcePath, 'utf8'), {
		loader: 'ts',
		format: 'cjs',
		platform: 'node',
		target: 'node20',
	}).code;
	const module = {exports: {}};
	const context = vm.createContext({
		module,
		exports: module.exports,
		URL,
		...globals,
		require: (specifier) => {
			if (specifier in stubs) return stubs[specifier];
			if (specifier.startsWith('node:')) return require(specifier);
			if (specifier.startsWith('@electron/')) {
				return load(`../${specifier.slice('@electron/'.length)}.ts`, {stubs, globals});
			}
			if (specifier.startsWith('@fluxer/desktop_ipc/')) {
				return load(`../../../packages/desktop_ipc/${specifier.slice('@fluxer/desktop_ipc/'.length)}.ts`, {
					stubs,
					globals,
				});
			}
			throw new Error(`Unexpected import: ${specifier}`);
		},
	});
	vm.runInContext(code, context, {filename: sourcePath});
	return module.exports;
}

function channelStub(channel) {
	return {'@electron/common/BuildChannel': {BUILD_CHANNEL: channel}};
}

describe('sanalyer desktop identity', () => {
	test('updates from dl.sanalyer.com and sends manual downloads to the sanalyer download page', () => {
		const downloads = load('./UpdaterDownloads.ts', {
			stubs: channelStub('stable'),
			globals: {process: {platform: 'win32', arch: 'x64'}},
		});

		assert.equal(downloads.UPDATE_BASE_URL, 'https://dl.sanalyer.com/desktop/stable/win32/x64');
		assert.equal(downloads.DOWNLOAD_PAGE_URL, 'https://sanalyer.com/indir');
		assert.equal(
			downloads.buildManualVersionDownloadUrl('1.0.1', 'setup'),
			'https://dl.sanalyer.com/desktop/stable/win32/x64/1.0.1/setup',
		);
	});

	test('names Linux manual download artefacts after sanalyer', () => {
		const downloads = load('./UpdaterDownloads.ts', {
			stubs: channelStub('stable'),
			globals: {process: {platform: 'linux', arch: 'x64'}},
		});
		const [appimage] = downloads.getManualDownloadOptions({version: '1.0.1', pubDate: null, files: {}});

		assert.equal(appimage.url, 'https://dl.sanalyer.com/desktop/stable/linux/x64/1.0.1/appimage');
		assert.equal(appimage.suggestedName, 'sanalyer-1.0.1-linux-x86_64.AppImage');
	});

	test('opens sanalyer:// links and trusts only sanalyer web origins', () => {
		const constants = load('../common/Constants.ts', {stubs: channelStub('stable')});

		assert.equal(constants.APP_PROTOCOL, 'sanalyer');
		assert.equal(constants.STABLE_APP_URL, 'https://sanalyer.com');
		assert.equal(constants.CANARY_APP_URL, 'https://canary.sanalyer.com');
		assert.equal(constants.STATIC_CDN_URL, 'https://sanalyer.com');
	});

	test('keeps the v1 application id and gets its own Velopack id, AUMID and toast activator', () => {
		const stable = load('../common/DesktopIdentity.ts', {stubs: channelStub('stable')});
		const canary = load('../common/DesktopIdentity.ts', {stubs: channelStub('canary')});

		assert.equal(stable.DESKTOP_APP_NAME, 'sanalyer');
		assert.equal(stable.MACOS_BUNDLE_ID, 'com.sanalyer.desktop');
		assert.equal(stable.LINUX_DESKTOP_ENTRY_ID, 'sanalyer');
		assert.equal(stable.WINDOWS_VELOPACK_ID, 'sanalyer_desktop');
		assert.equal(stable.WINDOWS_APP_USER_MODEL_ID, 'com.sanalyer.desktop');
		assert.equal(stable.WINDOWS_SHORTCUT_AUTHOR, 'sanalyer');
		assert.equal(canary.DESKTOP_APP_NAME, 'sanalyer Canary');
		assert.equal(canary.LINUX_DESKTOP_ENTRY_ID, 'sanalyer-canary');
		assert.equal(canary.WINDOWS_VELOPACK_ID, 'sanalyer_desktop_canary');
		for (const clsid of [stable.WINDOWS_TOAST_ACTIVATOR_CLSID, canary.WINDOWS_TOAST_ACTIVATOR_CLSID]) {
			assert.match(clsid, GUID_PATTERN);
			assert.equal(FLUXER_TOAST_ACTIVATOR_CLSIDS.includes(clsid), false);
		}
		assert.notEqual(stable.WINDOWS_TOAST_ACTIVATOR_CLSID, canary.WINDOWS_TOAST_ACTIVATOR_CLSID);
	});

	test('stores user data apart from the sanalyer v1 profile in %APPDATA%\\sanalyer', () => {
		const appData = path.join('C:', 'Users', 'sanalyer', 'AppData', 'Roaming');
		for (const [channel, directoryName] of [
			['stable', 'sanalyer_desktop'],
			['canary', 'sanalyer_desktop_canary'],
		]) {
			const setPaths = new Map();
			const userDataPath = load('../common/UserDataPath.ts', {
				stubs: {
					...channelStub(channel),
					electron: {
						app: {
							getPath: (name) => {
								assert.equal(name, 'appData');
								return appData;
							},
							setPath: (name, value) => setPaths.set(name, value),
						},
					},
				},
				globals: {process: {platform: 'win32', argv: [], env: {}, execPath: path.join(appData, 'sanalyer.exe')}},
			});

			const resolved = userDataPath.configureUserDataPath();

			assert.equal(resolved.directoryName, directoryName);
			assert.equal(setPaths.get('userData'), path.join(appData, directoryName));
			// NTFS matches folder names case-insensitively: "sanalyer" would reopen v1's Chromium profile
			// (cookies, service worker, zoom) and share its single-instance lock.
			assert.notEqual(resolved.directoryName.toLowerCase(), 'sanalyer');
		}
	});

	test('packages as com.sanalyer.desktop with the sanalyer protocol', () => {
		const previousArch = process.env.ELECTRON_ARCH;
		process.env.ELECTRON_ARCH = 'x64';
		let config;
		try {
			config = require('../../electron-builder.config.cjs');
		} finally {
			if (previousArch === undefined) delete process.env.ELECTRON_ARCH;
			else process.env.ELECTRON_ARCH = previousArch;
		}

		assert.equal(config.appId, 'com.sanalyer.desktop');
		assert.equal(config.productName, 'sanalyer');
		assert.match(config.artifactName, /^sanalyer-/);
		assert.deepEqual(
			config.protocols.map((protocol) => protocol.schemes),
			[['sanalyer']],
		);
		// The exe's CompanyName (Task Manager > Startup apps "Publisher") comes from the author.
		assert.equal(config.extraMetadata.author.name, 'sanalyer');
		for (const [key, prompt] of Object.entries(config.mac.extendInfo)) {
			assert.doesNotMatch(prompt, /Fluxer/, key);
		}
		// AGPLv3 §4/§6: the installed app carries a copy of the licence next to LICENSE.electron.txt.
		// macOS goes to Contents/Resources: codesign rejects unsigned files in the bundle's Contents root.
		const licence = [{from: 'LICENSE', to: 'LICENSE.txt'}];
		assert.equal(config.extraFiles, undefined);
		assert.deepEqual(config.win.extraFiles, licence);
		assert.deepEqual(config.linux.extraFiles, licence);
		assert.equal(config.mac.extraFiles, undefined);
		assert.deepEqual(config.mac.extraResources, licence);
		assert.match(
			readFileSync(new URL('../../LICENSE', import.meta.url), 'utf8'),
			/GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3/,
		);
	});

	// sanalyer: upstream removed the app's Linux manual-update options file; the API redirects are what is left to check.
	test('points the API download redirects at dl.sanalyer.com', () => {
		const redirects = load('../../../fluxer_api/src/api/download/DownloadRedirects.ts');

		assert.equal(redirects.PKGS_BASE_URL, 'https://dl.sanalyer.com');
		assert.equal(
			redirects.resolveDownloadRedirect('/dl/desktop/stable/win32/x64/latest').location,
			'https://dl.sanalyer.com/desktop/stable/win32/x64/latest.json',
		);
	});

	test('names the tray, app menu, update and startup errors, Theme Studio and autostart entry after sanalyer', () => {
		for (const file of [
			'./DesktopTray.ts',
			'./Menu.ts',
			'./Updater.ts',
			'./Window.ts',
			'./MainI18n.ts',
			'./NativeModulePreflight.ts',
			'./Autostart.ts',
		]) {
			const source = readFileSync(new URL(file, import.meta.url), 'utf8');
			assert.doesNotMatch(source, /\bFluxer\b/, file);
			assert.match(source, /DESKTOP_APP_NAME|`sanalyer /, file);
		}
		const menu = readFileSync(new URL('./Menu.ts', import.meta.url), 'utf8');
		assert.match(menu, /openExternalDeduped\('mailto:info@sanalyer\.com'\)/);
		// AGPL source offer: Help > Source code opens the sanalyer source page, not upstream GitHub.
		assert.match(
			menu,
			/label: t\('desktop\.appMenu\.sourceCode'\),\s*click: async \(\) => \{\s*await openExternalDeduped\('https:\/\/github\.com\/RadKod\/fluxer'\);/,
		);
		assert.doesNotMatch(menu, /fluxerapp\/fluxer|desktop\.appMenu\.github/);
	});

	// Desktop 1.0.1 showed "Fluxer uygulamasını gizle": the tray passed its own 'Fluxer' as {appName}.
	test('fills every native string with sanalyer, also the ones the renderer sent in Turkish', () => {
		const i18n = load('./MainI18n.ts', {
			stubs: {
				'@electron/common/DesktopIdentity': load('../common/DesktopIdentity.ts', {stubs: channelStub('stable')}),
				'@electron/common/Logger': {createChildLogger: () => ({info() {}, warn() {}})},
				electron: {app: {getPath: () => 'userData'}},
				'node:fs': {
					readFileSync() {
						throw new Error('nothing persisted');
					},
					writeFileSync() {},
				},
			},
		});
		const source = readFileSync(new URL('./MainI18n.ts', import.meta.url), 'utf8');
		const keys = [...source.matchAll(/^\t'(desktop\.[\w.]+)':/gm)].map((match) => match[1]);
		assert.ok(keys.length > 30);
		for (const key of keys) {
			assert.doesNotMatch(i18n.t(key), /fluxer/i, key);
		}
		assert.equal(i18n.t('desktop.tray.show'), 'Show sanalyer');
		assert.equal(i18n.t('desktop.appMenu.sourceCode'), 'Source code');

		i18n.setNativeStrings('tr', {
			'desktop.tray.hide': '{appName} uygulamasını gizle',
			'desktop.tray.restart': '{appName} uygulamasını yeniden başlat',
			'desktop.tray.quit': '{appName} uygulamasından çık',
		});
		assert.equal(i18n.t('desktop.tray.hide'), 'sanalyer uygulamasını gizle');
		assert.equal(i18n.t('desktop.tray.restart'), 'sanalyer uygulamasını yeniden başlat');
		assert.equal(i18n.t('desktop.tray.quit'), 'sanalyer uygulamasından çık');
	});
});
