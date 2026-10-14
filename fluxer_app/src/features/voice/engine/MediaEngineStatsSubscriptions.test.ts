// SPDX-License-Identifier: AGPL-3.0-or-later

import {readdirSync, readFileSync} from 'node:fs';
import {join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse} from '@babel/parser';
import {expect, test} from 'vitest';

const sourceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const snapshotOnlyFiles = new Set(['features/voice/utils/StatsForNerdsCopy.ts']);
const statsRead =
	/\bMediaEngine\.(currentLatency|mediaLatency|signalLatency|averageLatency|latencyHistory|voiceStats|perTrackStats|statsTimeSeries|publisherTransport|subscriberTransport|reconnectionCount|localConnectionQuality|displayLatency|estimatedLatency)\b/;

function sourceFiles(directory: string): Array<string> {
	return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return /\.tsx?$/.test(path) && !/\.(test|spec)\.tsx?$/.test(path) ? [path] : [];
	});
}

function missingSubscription(file: string, source: string): boolean {
	if (snapshotOnlyFiles.has(file) || !statsRead.test(source)) return false;
	let subscribed = false;
	function visit(node: unknown): void {
		if (!node || typeof node !== 'object') return;
		const value = node as {type?: string; callee?: {type?: string; name?: string}};
		if (
			value.type === 'CallExpression' &&
			value.callee?.type === 'Identifier' &&
			['useMediaEngineStatsVersion', 'useStatsForNerds'].includes(value.callee.name ?? '')
		)
			subscribed = true;
		for (const child of Object.values(node)) {
			if (Array.isArray(child)) child.forEach(visit);
			else visit(child);
		}
	}
	visit(parse(source, {sourceType: 'module', plugins: ['typescript', 'jsx']}));
	return !subscribed;
}

test('every React statistics consumer subscribes to statistics updates', () => {
	const findings = sourceFiles(sourceRoot).flatMap((path) => {
		const source = readFileSync(path, 'utf8');
		const file = relative(sourceRoot, path).replaceAll('\\', '/');
		const isReact =
			path.endsWith('.tsx') ||
			/from ['"](?:react|mobx-react-lite)['"]/.test(source) ||
			/^use[A-Z]/.test(path.split(/[\\/]/).at(-1) ?? '');
		return isReact && missingSubscription(file, source) ? [file] : [];
	});
	expect(findings).toEqual([]);
});

test('the guard detects a removed subscription and allows only the explicit copy snapshot exception', () => {
	for (const field of [
		'currentLatency',
		'mediaLatency',
		'signalLatency',
		'averageLatency',
		'latencyHistory',
		'voiceStats',
		'perTrackStats',
		'statsTimeSeries',
		'publisherTransport',
		'subscriberTransport',
		'reconnectionCount',
		'localConnectionQuality',
		'displayLatency',
		'estimatedLatency',
	]) {
		const source = `const value = MediaEngine.${field};`;
		expect(missingSubscription('features/voice/components/Stats.tsx', source)).toBe(true);
		expect(missingSubscription('features/voice/components/Stats.tsx', `useMediaEngineStatsVersion(); ${source}`)).toBe(
			false,
		);
		expect(missingSubscription('features/voice/components/Stats.tsx', `useStatsForNerds(); ${source}`)).toBe(false);
		expect(missingSubscription('features/voice/utils/StatsForNerdsCopy.ts', source)).toBe(false);
	}
});

test('the useStatsForNerds declaration does not count as its own subscription', () => {
	const path = join(sourceRoot, 'features/voice/components/useStatsForNerds.ts');
	const source = readFileSync(path, 'utf8').replace(/useMediaEngineStatsVersion\s*\(\s*\)\s*;/g, '');
	expect(missingSubscription('features/voice/components/useStatsForNerds.ts', source)).toBe(true);
});
