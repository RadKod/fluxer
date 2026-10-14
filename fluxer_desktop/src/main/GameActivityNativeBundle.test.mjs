// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

test('native types resolve when platform optional packages are absent', () => {
	const rootRequire = createRequire(new URL('../../../package.json', import.meta.url));
	const ts = rootRequire('typescript');
	const root = fileURLToPath(new URL('../../', import.meta.url));
	const config = JSON.parse(readFileSync(new URL('../../tsconfig.json', import.meta.url), 'utf8'));
	const {options} = ts.parseJsonConfigFileContent({...config, files: [], include: []}, ts.sys, root);
	const host = {
		...ts.sys,
		fileExists: (path) => !path.includes('node_modules') && ts.sys.fileExists(path),
		directoryExists: (path) => !path.includes('node_modules') && ts.sys.directoryExists(path),
	};
	const {resolvedModule} = ts.resolveModuleName(
		'@fluxer/win-shell',
		fileURLToPath(new URL('./GameActivityDetection.ts', import.meta.url)),
		options,
		host,
	);
	assert.ok(resolvedModule);
	assert.match(resolvedModule.resolvedFileName.replaceAll('\\', '/'), /\/native\/win-shell\/index\.d\.ts$/);
});

test('game detection bundle preserves the native package loader location', async () => {
	const buildScript = readFileSync(new URL('../../scripts/build.mjs', import.meta.url), 'utf8');
	const externals = buildScript.match(/const electronExternals = (\[[\s\S]*?\]);/);
	assert.ok(externals);
	const result = await esbuild.build({
		entryPoints: [fileURLToPath(new URL('./GameActivityDetection.ts', import.meta.url))],
		bundle: true,
		platform: 'node',
		target: 'node20',
		format: 'esm',
		write: false,
		metafile: true,
		external: vm.runInNewContext(externals[1]),
	});
	assert.match(result.outputFiles[0].text, /requireModule\(["']@fluxer\/win-shell["']\)/);
	assert.match(result.outputFiles[0].text, /createRequire\(import\.meta\.url\)/);
	assert.ok(!Object.keys(result.metafile.inputs).some((path) => path.includes('win-shell')));
});
