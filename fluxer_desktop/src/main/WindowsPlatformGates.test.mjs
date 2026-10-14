// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {describe, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const logger = {info() {}, warn() {}, error() {}, debug() {}};

function load(name, platform, stubs = {}) {
	const url = new URL(`./${name}.ts`, import.meta.url);
	const sourcePath = fileURLToPath(url);
	const code = esbuild.transformSync(readFileSync(sourcePath, 'utf8'), {
		loader: 'ts',
		format: 'cjs',
		platform: 'node',
		target: 'node20',
		define: {'import.meta.url': JSON.stringify(url.href)},
	}).code;
	const module = {exports: {}};
	vm.runInNewContext(
		code,
		{
			module,
			exports: module.exports,
			process: {platform, argv: [], env: {}, execPath: '/app/Micup', resourcesPath: '/app/resources'},
			require: (name) => {
				if (name in stubs) return stubs[name];
				if (name.startsWith('node:')) return require(name);
				throw new Error(`Unexpected import: ${name}`);
			},
		},
		{filename: sourcePath},
	);
	return module.exports;
}

describe('Windows taskbar platform gates', () => {
	for (const platform of ['darwin', 'linux', 'win32']) {
		test(`initializes JumpList tasks only on Windows (${platform})`, () => {
			const tasks = [];
			const localeListeners = [];
			const module = load('JumpList', platform, {
				'@electron/common/Logger': {createChildLogger: () => logger},
				'@electron/main/MainI18n': {t: (key) => key, onLocaleChange: (listener) => localeListeners.push(listener)},
				electron: {
					app: {
						setUserTasks: (value) => {
							tasks.push(value);
							return true;
						},
					},
				},
			});
			module.initializeJumpList();
			module.initializeJumpList();
			assert.equal(tasks.length, platform === 'win32' ? 1 : 0);
			assert.equal(localeListeners.length, platform === 'win32' ? 1 : 0);
			if (platform === 'win32') {
				assert.equal(tasks[0].length, 2);
				localeListeners[0]();
				assert.equal(tasks.length, 2);
			}
		});

		test(`sets taskbar badge icons only on Windows (${platform})`, () => {
			const loadedIcons = [];
			const overlays = [];
			const module = load('WindowsBadge', platform, {
				'node:fs': {existsSync: () => true},
				'@electron/main/MainI18n': {t: (key) => key, getNativeLocale: () => 'en-US'},
				electron: {
					nativeImage: {
						createFromPath: (path) => {
							loadedIcons.push(path);
							return {isEmpty: () => false};
						},
					},
				},
			});
			const window = {isDestroyed: () => false, setOverlayIcon: (...args) => overlays.push(args)};
			module.setWindowsBadgeOverlay(window, 2);
			module.refreshWindowsBadgeOverlay(window);
			assert.equal(loadedIcons.length, platform === 'win32' ? 11 : 0);
			assert.equal(overlays.length, platform === 'win32' ? 2 : 0);
		});
	}
});
