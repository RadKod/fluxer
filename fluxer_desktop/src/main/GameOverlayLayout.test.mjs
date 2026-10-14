// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {describe, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const sourcePath = fileURLToPath(new URL('./GameOverlayLayout.ts', import.meta.url));
const source = readFileSync(sourcePath, 'utf8');
const transformedSource = esbuild.transformSync(source, {
	loader: 'ts',
	format: 'cjs',
	platform: 'node',
	target: 'node20',
}).code;

function loadGameOverlayLayout() {
	const module = {exports: {}};
	const context = vm.createContext({
		module,
		exports: module.exports,
	});
	vm.runInContext(transformedSource, context, {filename: sourcePath});
	return module.exports;
}

function plain(value) {
	return value === null ? null : {...value};
}

const validLayout = {visible: true, corner: 'top-left', width: 56, height: 200};
const fullHd = {x: 0, y: 0, width: 1920, height: 1080};

describe('normalizeGameOverlayLayout', () => {
	test('returns a valid layout unchanged', () => {
		const {normalizeGameOverlayLayout} = loadGameOverlayLayout();
		assert.deepEqual(plain(normalizeGameOverlayLayout(validLayout)), validLayout);
	});

	test('rejects null, arrays and strings', () => {
		const {normalizeGameOverlayLayout} = loadGameOverlayLayout();
		assert.equal(normalizeGameOverlayLayout(null), null);
		assert.equal(normalizeGameOverlayLayout([true, 'top-left', 56, 200]), null);
		assert.equal(normalizeGameOverlayLayout('top-left'), null);
	});

	test('rejects unknown keys', () => {
		const {normalizeGameOverlayLayout} = loadGameOverlayLayout();
		assert.equal(normalizeGameOverlayLayout({...validLayout, x: 0}), null);
	});

	test('rejects missing keys', () => {
		const {normalizeGameOverlayLayout} = loadGameOverlayLayout();
		const {height: _height, ...missingHeight} = validLayout;
		assert.equal(normalizeGameOverlayLayout(missingHeight), null);
	});

	test('rejects an unknown corner or a non-boolean visible', () => {
		const {normalizeGameOverlayLayout} = loadGameOverlayLayout();
		assert.equal(normalizeGameOverlayLayout({...validLayout, corner: 'center'}), null);
		assert.equal(normalizeGameOverlayLayout({...validLayout, visible: 1}), null);
	});

	test('rejects non-finite or non-number sizes', () => {
		const {normalizeGameOverlayLayout} = loadGameOverlayLayout();
		assert.equal(normalizeGameOverlayLayout({...validLayout, width: Number.NaN}), null);
		assert.equal(normalizeGameOverlayLayout({...validLayout, height: Number.POSITIVE_INFINITY}), null);
		assert.equal(normalizeGameOverlayLayout({...validLayout, width: '56'}), null);
	});

	test('rounds then clamps sizes', () => {
		const {normalizeGameOverlayLayout} = loadGameOverlayLayout();
		assert.deepEqual(plain(normalizeGameOverlayLayout({...validLayout, width: 10, height: 10})), {
			...validLayout,
			width: 32,
			height: 32,
		});
		assert.deepEqual(plain(normalizeGameOverlayLayout({...validLayout, width: 5000, height: 5000})), {
			...validLayout,
			width: 360,
			height: 720,
		});
		assert.deepEqual(plain(normalizeGameOverlayLayout({...validLayout, width: 100.6, height: 100.4})), {
			...validLayout,
			width: 101,
			height: 100,
		});
	});
});

describe('computeGameOverlayBounds', () => {
	test('places the overlay in each corner of a 1920x1080 display with a 16px margin', () => {
		const {computeGameOverlayBounds} = loadGameOverlayLayout();
		const size = {visible: true, width: 56, height: 200};
		assert.deepEqual(plain(computeGameOverlayBounds(fullHd, {...size, corner: 'top-left'})), {
			x: 16,
			y: 16,
			width: 56,
			height: 200,
		});
		assert.deepEqual(plain(computeGameOverlayBounds(fullHd, {...size, corner: 'top-right'})), {
			x: 1848,
			y: 16,
			width: 56,
			height: 200,
		});
		assert.deepEqual(plain(computeGameOverlayBounds(fullHd, {...size, corner: 'bottom-left'})), {
			x: 16,
			y: 864,
			width: 56,
			height: 200,
		});
		assert.deepEqual(plain(computeGameOverlayBounds(fullHd, {...size, corner: 'bottom-right'})), {
			x: 1848,
			y: 864,
			width: 56,
			height: 200,
		});
	});

	test('respects display offsets', () => {
		const {computeGameOverlayBounds} = loadGameOverlayLayout();
		const display = {x: -1920, y: 200, width: 1920, height: 1080};
		assert.deepEqual(
			plain(computeGameOverlayBounds(display, {visible: true, corner: 'top-left', width: 56, height: 200})),
			{x: -1904, y: 216, width: 56, height: 200},
		);
		assert.deepEqual(
			plain(computeGameOverlayBounds(display, {visible: true, corner: 'bottom-right', width: 56, height: 200})),
			{x: -72, y: 1064, width: 56, height: 200},
		);
	});

	test('clamps a layout larger than the display inside it', () => {
		const {computeGameOverlayBounds} = loadGameOverlayLayout();
		const display = {x: 0, y: 0, width: 300, height: 200};
		assert.deepEqual(
			plain(computeGameOverlayBounds(display, {visible: true, corner: 'bottom-right', width: 360, height: 720})),
			{x: 16, y: 16, width: 268, height: 168},
		);
	});
});
