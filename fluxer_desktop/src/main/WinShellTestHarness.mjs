// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

export function loadMainModule(name, stubs, processStub, globals = {}, cache = new Map()) {
	if (cache.has(name)) return cache.get(name);
	const url = new URL(`./${name}.ts`, import.meta.url);
	const source = readFileSync(url, 'utf8');
	const code = esbuild.transformSync(source, {
		loader: 'ts',
		format: 'cjs',
		target: 'node20',
		supported: {'dynamic-import': false},
		define: {'import.meta.url': JSON.stringify(url.href)},
	}).code;
	const module = {exports: {}};
	const context = {
		module,
		exports: module.exports,
		process: processStub,
		Buffer,
		TextEncoder,
		URL,
		console,
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		...globals,
		require: (specifier) => {
			if (specifier in stubs) return stubs[specifier];
			if (specifier === '@electron/main/WinShell') {
				return loadMainModule('WinShell', stubs, processStub, globals, cache);
			}
			if (!specifier.startsWith('node:')) throw new Error(`Unexpected module: ${specifier}`);
			return require(specifier);
		},
	};
	vm.runInNewContext(code, context, {filename: url.pathname});
	cache.set(name, module.exports);
	return module.exports;
}
