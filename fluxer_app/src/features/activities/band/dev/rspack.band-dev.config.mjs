// SPDX-License-Identifier: AGPL-3.0-or-later

// Local harness for Bir Daha Baştan: the real band View on a FakeActivitySession with simulated bandmates, built
// from the app's own resolve and module rules (aliases, lingui macros, CSS modules) but with its own entry and page.
// Nothing in the app imports band/dev and the production config never names this file, so it cannot ship.
//
//   pnpm exec rspack serve -c src/features/activities/band/dev/rspack.band-dev.config.mjs --mode development
//
// Opens on http://127.0.0.1:3100/ (BAND_DEV_PORT to change). Songs come from scripts/sarkilar/yerel-sunucu.mjs in
// the sanalyer.com repo; the page takes ?songs=<url> and defaults to http://127.0.0.1:8787/.

import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DefinePlugin, HtmlRspackPlugin} from '@rspack/core';
import createAppConfig from '../../../../../rspack.config.mjs';

const DEV_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(DEV_DIR, '../../../../..');
const BROWSER_ASSERT_STRICT_MODULE = path.join(APP_DIR, 'src/features/platform/utils/BrowserAssertStrict.ts');
const DEFAULT_PORT = 3100;

// Same rewrite as the app config: an alias does not catch the node: scheme.
function nodeAssertStrictSchemePlugin() {
	return {
		apply(compiler) {
			compiler.hooks.normalModuleFactory.tap('BandDevNodeAssertStrict', (factory) => {
				factory.hooks.beforeResolve.tap('BandDevNodeAssertStrict', (resolveData) => {
					if (resolveData.request === 'node:assert/strict') resolveData.request = BROWSER_ASSERT_STRICT_MODULE;
				});
			});
		},
	};
}

export default () => {
	const app = createAppConfig();
	if (app.mode === 'production') {
		throw new Error('The band harness is development only; run it with --mode development.');
	}
	return {
		mode: app.mode,
		entry: {bandDev: path.join(DEV_DIR, 'BandDevEntry.tsx')},
		output: {
			...app.output,
			path: path.join(APP_DIR, 'node_modules/.cache/band-dev'),
			publicPath: '/',
		},
		devtool: 'eval-cheap-module-source-map',
		target: app.target,
		performance: false,
		ignoreWarnings: app.ignoreWarnings,
		resolve: app.resolve,
		module: app.module,
		plugins: [
			nodeAssertStrictSchemePlugin(),
			...app.plugins.filter((plugin) => plugin instanceof DefinePlugin),
			new HtmlRspackPlugin({
				template: path.join(DEV_DIR, 'band-dev.html'),
				filename: 'index.html',
				inject: 'body',
				scriptLoading: 'module',
			}),
		],
		optimization: {splitChunks: false, runtimeChunk: false, minimize: false},
		devServer: {
			host: '127.0.0.1',
			port: Number(process.env.BAND_DEV_PORT) || DEFAULT_PORT,
			// A reload in the middle of a song throws the round away; refresh by hand after a rebuild.
			hot: false,
			liveReload: false,
			client: false,
			webSocketServer: false,
			historyApiFallback: true,
			static: false,
		},
	};
};
