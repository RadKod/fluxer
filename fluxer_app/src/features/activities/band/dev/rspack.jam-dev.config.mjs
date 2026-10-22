// SPDX-License-Identifier: AGPL-3.0-or-later

// Local harness for jam mode's audio engine: the band harness's build with its own entry and port. Nothing in the
// app imports it and the production config never names it.
//
//   pnpm exec rspack serve -c src/features/activities/band/dev/rspack.jam-dev.config.mjs --mode development
//
// Opens on http://127.0.0.1:3101/ (JAM_DEV_PORT to change). Samples: set JAM_SAMPLES_DIR to the folder
// dogaclama-paketle.py wrote (sanalyer.com repo, scripts/sarkilar/) and it is served at /dogaclama/, which the page
// reads by default; otherwise ?jam=<url>, or ?jam=live for the copy on sanalyer.com.

import path from 'node:path';
import {fileURLToPath} from 'node:url';
import createBandDevConfig from './rspack.band-dev.config.mjs';

const DEV_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 3101;
const SAMPLES_DIR = process.env.JAM_SAMPLES_DIR;

export default () => {
	const band = createBandDevConfig();
	return {
		...band,
		entry: {jamDev: path.join(DEV_DIR, 'JamDevEntry.tsx')},
		output: {...band.output, path: path.join(band.output.path, '..', 'jam-dev')},
		devServer: {
			...band.devServer,
			port: Number(process.env.JAM_DEV_PORT) || DEFAULT_PORT,
			static: SAMPLES_DIR ? {directory: path.resolve(SAMPLES_DIR), publicPath: '/dogaclama/', watch: false} : false,
		},
	};
};
