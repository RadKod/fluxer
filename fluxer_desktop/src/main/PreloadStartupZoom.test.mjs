// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {describe, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const sourcePath = fileURLToPath(new URL('../preload/index.ts', import.meta.url));
const transformedSource = esbuild.buildSync({
	entryPoints: [sourcePath],
	bundle: true,
	write: false,
	external: ['electron'],
	format: 'cjs',
	platform: 'node',
	target: 'node20',
}).outputFiles[0].text;

function runPreload(storedItems = {}, {systemReducedMotion = false} = {}) {
	const storage = new Map(Object.entries(storedItems));
	const rootStyle = new Map();
	const rootClasses = new Map();
	const noop = () => {};
	const electron = {
		contextBridge: {exposeInMainWorld: noop},
		ipcRenderer: {
			on: noop,
			send: noop,
			sendSync: (channel) =>
				channel === 'desktop-capability-manifest:get'
					? Object.assign(Object.create(null), {appStore: false, gatewaySocket: false})
					: null,
			invoke: async () => undefined,
			removeListener: noop,
		},
		webFrame: {setZoomFactor: noop, setSpellCheckProvider: noop},
	};
	const documentElement = {
		classList: {add: noop, remove: noop, toggle: (name, force) => rootClasses.set(name, force)},
		style: {setProperty: (name, value) => rootStyle.set(name, value)},
	};
	const window = {
		localStorage: {
			getItem: (key) => (storage.has(key) ? storage.get(key) : null),
			setItem: (key, value) => storage.set(key, String(value)),
		},
		location: {pathname: '/channels/@me'},
		matchMedia: () => ({matches: systemReducedMotion}),
		addEventListener: noop,
	};
	const module = {exports: {}};
	vm.runInContext(
		transformedSource,
		vm.createContext({
			module,
			exports: module.exports,
			URL,
			TextEncoder,
			TextDecoder,
			require: (id) => {
				if (id === 'electron') return electron;
				throw new Error(`Unexpected preload import: ${id}`);
			},
			process: {platform: 'win32', argv: [], env: {}},
			window,
			document: {documentElement, body: null, addEventListener: noop},
			HTMLTextAreaElement: class {},
			setTimeout,
			clearTimeout,
		}),
		{filename: sourcePath},
	);
	return {customZoom: rootStyle.get('--custom-zoom'), reducedMotion: rootClasses.get('reduced-motion'), storage};
}

describe('preload startup zoom', () => {
	test('paints a fresh install at the 95% default', () => {
		assert.equal(runPreload().customZoom, '95');
	});

	test('reads the zoom the app saved under Accessibility:zoomLevel', () => {
		assert.equal(runPreload({'Accessibility:zoomLevel': '1.5'}).customZoom, '150');
	});

	test('keeps a saved 100% zoom', () => {
		const {customZoom, storage} = runPreload({'Accessibility:zoomLevel': '1'});

		assert.equal(customZoom, '100');
		assert.equal(storage.get('Accessibility:zoomLevel'), '1');
	});
});

describe('preload startup reduced motion', () => {
	const reduced = (storedItems) => runPreload(storedItems, {systemReducedMotion: true}).reducedMotion;
	const motion = (settings) => JSON.stringify(settings);
	const MIGRATED = {'Accessibility:motionSyncDefaultOffMigratedV1': 'true'};

	test('plays animations on a fresh install even when the system asks for reduced motion', () => {
		assert.notEqual(reduced({}), true);
	});

	test('keeps a saved "no override" over an override left in the legacy store', () => {
		assert.equal(
			reduced({
				...MIGRATED,
				'Accessibility:motion': motion({syncReducedMotionWithSystem: false, reducedMotionOverride: null}),
				Accessibility: motion({reducedMotionOverride: true}),
			}),
			false,
		);
	});

	test('turns an old-default sync off before the app runs its one-time move', () => {
		assert.equal(
			reduced({'Accessibility:motion': motion({syncReducedMotionWithSystem: true, reducedMotionOverride: null})}),
			false,
		);
	});

	test('follows the system for a sync kept after the move', () => {
		assert.equal(
			reduced({
				...MIGRATED,
				'Accessibility:motion': motion({syncReducedMotionWithSystem: true, reducedMotionOverride: null}),
			}),
			true,
		);
	});

	test('leaves a sync with an override to the system, as the move does', () => {
		assert.equal(
			reduced({'Accessibility:motion': motion({syncReducedMotionWithSystem: true, reducedMotionOverride: false})}),
			true,
		);
	});

	test('paints a chosen "Reduce motion"', () => {
		assert.equal(
			reduced({'Accessibility:motion': motion({syncReducedMotionWithSystem: false, reducedMotionOverride: true})}),
			true,
		);
	});

	test('reads the legacy sync when the app has not saved motion settings yet', () => {
		assert.equal(reduced({Accessibility: motion({syncReducedMotionWithSystem: true})}), true);
	});
});
