// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, test} from 'node:test';
import {installElectronStub, installTestModuleStub} from './LocalAppTestSupport.test.mjs';
import {fakeNativeImageModule, loadedImagePaths} from './TrayIconTestSupport.test.mjs';

const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sanalyer-desktop-tray-glyph-test-'));
fs.mkdirSync(path.join(resourcesPath, 'icons'));
for (const name of ['16x16.png', 'tray-glyph.png']) fs.writeFileSync(path.join(resourcesPath, 'icons', name), '');
Object.defineProperty(process, 'resourcesPath', {value: resourcesPath, configurable: true});
Object.defineProperty(process, 'platform', {value: 'win32', configurable: true});

const settings = {showTrayIcon: true, coloredTrayIcon: false};
globalThis.__sanalyerTrayGlyphTestSettings__ = settings;
installTestModuleStub(
	'@electron/common/DesktopConfig',
	'export const getDesktopWindowBehaviorSettings = () => ({...globalThis.__sanalyerTrayGlyphTestSettings__});',
);
installTestModuleStub(
	'@electron/main/DesktopUpdatePrompt',
	'export const checkForUpdatesFromShell = async () => {}; export const startDesktopUpdateFromShell = () => {};',
);
installTestModuleStub('@electron/main/LinuxLaunchPath', 'export const relaunchStableLaunchPath = () => {};');

class FakeTray {
	constructor(image) {
		this.image = image;
	}
	setImage(image) {
		this.image = image;
	}
	setToolTip() {}
	setContextMenu() {}
	on() {}
	removeAllListeners() {}
	isDestroyed() {
		return false;
	}
	destroy() {}
}

installElectronStub({
	nativeImage: fakeNativeImageModule,
	nativeTheme: {shouldUseDarkColorsForSystemIntegratedUI: true, on() {}},
	Tray: FakeTray,
	Menu: {buildFromTemplate: () => ({})},
	clipboard: {},
	app: {getPath: () => resourcesPath},
});

const {applyDesktopWindowBehaviorSettings, initializeDesktopTray} = await import('./DesktopTray.ts');

describe('desktop tray base image', () => {
	test('monochrome trays repaint the bare sanalyer glyph, the colored tray keeps the app icon', () => {
		initializeDesktopTray({
			createWindow: () => null,
			getMainWindow: () => null,
			isMainWindowTakenOver: () => false,
			hideWindow: () => {},
			setQuitting: () => {},
			showWindow: () => {},
		});
		assert.deepEqual(
			loadedImagePaths.map((file) => path.basename(file)),
			['tray-glyph.png'],
		);
		settings.coloredTrayIcon = true;
		applyDesktopWindowBehaviorSettings();
		assert.deepEqual(
			loadedImagePaths.map((file) => path.basename(file)),
			['tray-glyph.png', '16x16.png'],
		);
	});
});
