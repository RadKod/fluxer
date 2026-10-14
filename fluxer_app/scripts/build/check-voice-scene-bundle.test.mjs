// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {checkVoiceSceneBundle} from './check-voice-scene-bundle.mjs';

const bvh = {name: '../node_modules/.pnpm/three-mesh-bvh@0.9/node_modules/three-mesh-bvh/src/core/MeshBVH.js'};
const three = {name: '../node_modules/three/src/Three.js'};
function stats() {
	return {
		errorsCount: 0,
		assets: [
			{name: 'main.js', size: 100},
			{name: 'room.js', size: 200},
		],
		chunks: [
			{initial: true, files: ['main.js'], modules: []},
			{
				initial: false,
				files: ['room.js'],
				runtime: ['main'],
				modules: [three, {name: 'room + modules', modules: [bvh]}],
			},
		],
	};
}

test('keeps nested room dependencies async and deduplicates initial assets', () => {
	const input = stats();
	input.chunks.push({initial: true, files: ['main.js'], modules: []});
	input.chunks.push({initial: false, files: ['bvh.worker.js'], runtime: ['bvh.worker'], modules: [bvh]});
	const result = checkVoiceSceneBundle(input);
	assert.equal(result.modules.length, 3);
	assert.equal(result.initialBytes, 100);
	assert.deepEqual(result.initialFiles, ['main.js']);
});

test('rejects a BVH module also present in a nested initial chunk', () => {
	const input = stats();
	input.chunks[0].modules.push({name: 'vendor + modules', modules: [bvh]});
	assert.throws(() => checkVoiceSceneBundle(input), /Room dependencies found in initial chunks/);
});

test('rejects initial three and incomplete stats rather than passing with zero matches', () => {
	const input = stats();
	input.chunks[0].modules.push(three);
	assert.throws(() => checkVoiceSceneBundle(input), /Room dependencies found in initial chunks/);
	input.chunks.forEach((chunk) => {
		chunk.modules = [];
	});
	assert.throws(() => checkVoiceSceneBundle(input), /Stats must contain three modules/);
	input.chunks[1].modules = [three];
	assert.throws(() => checkVoiceSceneBundle(input), /Stats must contain three-mesh-bvh modules/);
});

test('rejects stats that hide concatenated modules', () => {
	const input = stats();
	input.chunks[1].modules.push({type: 'orphan modules', filteredChildren: 42});
	assert.throws(() => checkVoiceSceneBundle(input), /Stats must include unfiltered nested modules/);
});

test('rejects missing module arrays in initial and async chunks', () => {
	for (const index of [0, 1]) {
		const input = stats();
		delete input.chunks[index].modules;
		assert.throws(() => checkVoiceSceneBundle(input), /Stats must include chunk module arrays/);
	}
});

test('rejects concatenated aggregates with no nested modules', () => {
	for (const count of [0, 42]) {
		const input = stats();
		input.chunks[0].modules.push({name: `vendor + ${count} modules`});
		assert.throws(() => checkVoiceSceneBundle(input), /Stats must include concatenated module contents/);
	}
});

test('rejects BVH hidden in initial grouped children even when it is also async', () => {
	const input = stats();
	input.chunks[0].modules.push({type: 'modules by path', children: [{type: 'group', children: [bvh]}]});
	assert.throws(() => checkVoiceSceneBundle(input), /Room dependencies found in initial chunks/);
});

test('accepts room dependencies in fully exposed async grouped children', () => {
	const input = stats();
	input.chunks[1].modules = [{type: 'modules by path', children: [three, {type: 'group', children: [bvh]}]}];
	assert.equal(checkVoiceSceneBundle(input).modules.length, 2);
});
