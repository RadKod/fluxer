// SPDX-License-Identifier: AGPL-3.0-or-later

// Runs against real Clone Hero songs kept outside the repo (they are copyrighted):
//   BAND_SNG_DIR=/path/to/sng-folder npx vitest run src/features/activities/band/engine

import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {FretLane, type PartChart} from '@app/features/activities/band/engine/ChartModel';
import {FRET_DERIVATION_RULES} from '@app/features/activities/band/engine/DifficultyDerivation';
import {SongPackage} from '@app/features/activities/band/engine/SongPackage';
import {describe, expect, it} from 'vitest';

const SNG_DIR = process.env.BAND_SNG_DIR;
const DERIVED = ['hard', 'medium', 'easy'] as const;
// A lane counts as part of a real chart's vocabulary when it carries at least this share of its notes.
const DOMINANT_LANE_SHARE = 0.1;
const NOTE_COUNT_RATIO_RANGE = [0.5, 1.75] as const;

function laneShares(chart: PartChart): Map<number, number> {
	const counts = new Map<number, number>();
	let total = 0;
	for (const group of chart.groups) {
		for (const lane of group.lanes) {
			counts.set(lane, (counts.get(lane) ?? 0) + 1);
			total++;
		}
	}
	return new Map([...counts].map(([lane, count]) => [lane, count / total]));
}

describe.skipIf(!SNG_DIR)('band engine on real songs', () => {
	const files = SNG_DIR ? readdirSync(SNG_DIR).filter((name) => name.endsWith('.sng')) : [];

	it('finds songs to check', () => {
		expect(files.length).toBeGreaterThan(0);
	});

	it.each(files)('%s loads, parses, has vocals and derives difficulties close to the real ones', (fileName) => {
		const song = SongPackage.fromSng(new Uint8Array(readFileSync(join(SNG_DIR!, fileName))));
		const chart = song.chart();
		expect(song.metadata.name).toBeTruthy();
		expect(song.stems.length).toBeGreaterThan(0);
		expect(chart.vocals?.notes.length ?? 0).toBeGreaterThan(0);
		expect(chart.vocals?.phrases.length ?? 0).toBeGreaterThan(0);

		const rows: Array<string> = [];
		for (const {part, charted} of chart.availableParts()) {
			const expert = chart.partChart(part, 'expert')!;
			expect(expert.groups.length).toBeGreaterThan(0);
			for (const difficulty of DERIVED) {
				if (!charted.includes(difficulty)) continue;
				const real = chart.partChart(part, difficulty)!;
				const derived = chart.derivedPartChart(part, difficulty)!;
				const ratio = derived.groups.length / real.groups.length;
				const derivedLanes = laneShares(derived);
				const dominantRealLanes = [...laneShares(real)].filter(([, share]) => share >= DOMINANT_LANE_SHARE);
				rows.push(
					`${part.padEnd(6)} ${difficulty.padEnd(6)} real ${String(real.groups.length).padStart(4)}  derived ${String(
						derived.groups.length,
					).padStart(4)}  ratio ${ratio.toFixed(2)}  lanes ${[...derivedLanes.keys()].sort().join('')} vs ${[
						...laneShares(real).keys(),
					]
						.sort()
						.join('')}`,
				);

				expect(ratio, `${part} ${difficulty} note count`).toBeGreaterThanOrEqual(NOTE_COUNT_RATIO_RANGE[0]);
				expect(ratio, `${part} ${difficulty} note count`).toBeLessThanOrEqual(NOTE_COUNT_RATIO_RANGE[1]);
				for (const [lane] of dominantRealLanes) {
					expect(derivedLanes.has(lane), `${part} ${difficulty} uses lane ${lane}`).toBe(true);
				}
				if (part !== 'drums') {
					const rule = FRET_DERIVATION_RULES[difficulty];
					const highestLane = rule.keepsOpenNotes ? FretLane.Open : rule.laneCount - 1;
					expect(Math.max(...derivedLanes.keys())).toBeLessThanOrEqual(highestLane);
					expect(derived.groups.every((group) => group.lanes.length <= rule.maxChordSize)).toBe(true);
				}
			}
		}
		console.info(`${fileName}: ${chart.vocals?.notes.length} vocal notes\n${rows.join('\n')}`);
	});
});
