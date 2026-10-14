// SPDX-License-Identifier: AGPL-3.0-or-later
import {createRequire} from 'node:module';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(directory, '../..');
const require = createRequire(resolve(repository, 'fluxer_app/package.json'));
const dependencies = ['react', 'react-dom/client', '@lingui/core', '@lingui/core/macro', '@lingui/react/macro'];

export default {
	root: resolve(repository, 'fluxer_app'),
	resolve: {
		alias: [
			...dependencies.map((name) => ({
				find: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
				replacement: require.resolve(name),
			})),
			{find: /^vitest$/, replacement: resolve(dirname(require.resolve('vitest/package.json')), 'dist/index.js')},
			{find: '@app/api', replacement: resolve(repository, 'fluxer_api/src/api')},
			{find: '@app', replacement: resolve(repository, 'fluxer_app/src')},
			{find: '@electron/common', replacement: resolve(repository, 'fluxer_desktop/src/common')},
			{find: '@fluxer', replacement: resolve(repository, 'packages')},
		],
		tsconfigPaths: true,
	},
	oxc: {jsx: {runtime: 'automatic', importSource: 'react'}},
	test: {
		include: [resolve(directory, 'flow.test.tsx').replaceAll('\\', '/')],
		environment: 'happy-dom',
		maxWorkers: 1,
		fileParallelism: false,
		testTimeout: 30000,
	},
};
