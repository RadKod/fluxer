// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';

// JSON stats need chunkModules, nestedModules, orphanModules, dependentModules and cachedModules enabled.
export function checkVoiceSceneBundle(stats) {
	assert.equal(stats.errorsCount ?? stats.errors?.length, 0, 'Production build must have no errors');
	assert(stats.chunks?.length, 'Stats must include chunks');
	const modules = [];
	function visit(module, chunk) {
		assert(!module.filteredChildren && !module.filteredModules, 'Stats must include unfiltered nested modules');
		const name = module.name ?? module.identifier ?? '';
		if (/ \+ \d+ modules$/.test(name)) {
			assert(
				Array.isArray(module.modules) && module.modules.length > 0,
				'Stats must include concatenated module contents',
			);
		}
		if (/[\\/]node_modules[\\/](three|three-mesh-bvh)[\\/]/.test(name)) {
			modules.push({name, initial: chunk.initial, files: chunk.files, runtime: chunk.runtime});
		}
		for (const nested of module.modules ?? []) visit(nested, chunk);
		for (const nested of module.children ?? []) visit(nested, chunk);
	}
	for (const chunk of stats.chunks) {
		assert.equal(typeof chunk.initial, 'boolean', 'Stats must include chunk.initial');
		assert(!chunk.filteredModules, 'Stats must include all chunk modules');
		assert(Array.isArray(chunk.modules), 'Stats must include chunk module arrays');
		for (const module of chunk.modules) visit(module, chunk);
	}
	for (const pkg of ['three', 'three-mesh-bvh']) {
		assert(
			modules.some(
				(module) => module.name.includes(`/node_modules/${pkg}/`) || module.name.includes(`\\node_modules\\${pkg}\\`),
			),
			`Stats must contain ${pkg} modules`,
		);
	}
	const initialModules = modules.filter((module) => module.initial);
	assert.equal(
		initialModules.length,
		0,
		`Room dependencies found in initial chunks: ${initialModules.map((module) => module.name).join(', ')}`,
	);
	const initialFiles = [
		...new Set(
			stats.chunks
				.filter((chunk) => chunk.initial)
				.flatMap((chunk) => chunk.files)
				.filter((file) => file.endsWith('.js')),
		),
	];
	const initialBytes = initialFiles.reduce((total, file) => {
		const asset = stats.assets?.find((candidate) => candidate.name === file);
		assert(Number.isFinite(asset?.size), `Stats must include asset size for ${file}`);
		return total + asset.size;
	}, 0);
	return {modules, initialFiles, initialBytes};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [statsPath, distPath] = process.argv.slice(2);
	assert(statsPath && distPath, 'Usage: node check-voice-scene-bundle.mjs <stats.json> <dist>');
	const stats = JSON.parse(readFileSync(statsPath, 'utf8'));
	const result = checkVoiceSceneBundle(stats);
	result.initialGzipBytes = result.initialFiles.reduce((total, file) => {
		const bytes = readFileSync(path.join(distPath, file));
		assert.equal(bytes.length, stats.assets.find((asset) => asset.name === file).size);
		return total + gzipSync(bytes).length;
	}, 0);
	console.log(JSON.stringify(result, null, 2));
}
