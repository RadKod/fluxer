// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	BAND_DIFFICULTIES,
	type BandDifficulty,
	buildPartChart,
	type InstrumentPart,
	type PartChart,
} from '@app/features/activities/band/engine/ChartModel';
import {deriveDifficulty} from '@app/features/activities/band/engine/DifficultyDerivation';
import {TempoMap} from '@app/features/activities/band/engine/TempoMap';
import {parseVocalsFromMidi, type VocalsChart} from '@app/features/activities/band/engine/VocalsParser';
import type {Instrument} from '@app/features/activities/band/engine/vendor/scan-chart/interfaces';
import type {IniChartModifiers} from '@app/features/activities/band/engine/vendor/scan-chart/note-parsing-interfaces';
import {type ParsedChart, parseChartFile} from '@app/features/activities/band/engine/vendor/scan-chart/notes-parser';

export type ChartFormat = 'mid' | 'chart';

// Chart tracks that can feed each part, in order of preference.
const PART_TRACKS: Readonly<Record<InstrumentPart, ReadonlyArray<Instrument>>> = {
	guitar: ['guitar'],
	bass: ['bass', 'rhythm'],
	drums: ['drums'],
	keys: ['keys'],
};

export interface PartAvailability {
	readonly part: InstrumentPart;
	// Difficulties authored in the chart file.
	readonly charted: ReadonlyArray<BandDifficulty>;
	// Charted plus those derivable from Expert.
	readonly playable: ReadonlyArray<BandDifficulty>;
}

export interface ChartSection {
	readonly name: string;
	readonly msTime: number;
}

type ParsedTrack = ParsedChart['trackData'][number];

export class SongChart {
	private readonly chartCache = new Map<string, PartChart>();

	private constructor(
		readonly tempoMap: TempoMap,
		readonly sections: ReadonlyArray<ChartSection>,
		readonly vocals: VocalsChart | null,
		private readonly tracks: ReadonlyMap<InstrumentPart, ReadonlyMap<BandDifficulty, ParsedTrack>>,
	) {}

	static parse(data: Uint8Array, format: ChartFormat, modifiers: Partial<IniChartModifiers> = {}): SongChart {
		const parsed = parseChartFile(data, format, modifiers);
		const tempoMap = new TempoMap(parsed.resolution, parsed.tempos, parsed.timeSignatures);

		const tracks = new Map<InstrumentPart, Map<BandDifficulty, ParsedTrack>>();
		for (const [part, instruments] of Object.entries(PART_TRACKS) as Array<[InstrumentPart, Array<Instrument>]>) {
			const instrument = instruments.find((name) => parsed.trackData.some((track) => track.instrument === name));
			if (!instrument) continue;
			const byDifficulty = new Map<BandDifficulty, ParsedTrack>();
			for (const track of parsed.trackData) {
				if (track.instrument === instrument && track.noteEventGroups.length > 0)
					byDifficulty.set(track.difficulty, track);
			}
			if (byDifficulty.size > 0) tracks.set(part, byDifficulty);
		}

		const sections = parsed.sections.map(({name, msTime}) => ({name, msTime}));
		const vocals = format === 'mid' ? parseVocalsFromMidi(data, tempoMap) : null;
		return new SongChart(tempoMap, sections, vocals, tracks);
	}

	get durationMs(): number {
		let end = this.vocals?.durationMs ?? 0;
		for (const availability of this.availableParts()) {
			const chart = this.partChart(availability.part, availability.charted.at(-1) ?? 'expert');
			end = Math.max(end, chart?.durationMs ?? 0);
		}
		return end;
	}

	availableParts(): Array<PartAvailability> {
		return [...this.tracks].map(([part, byDifficulty]) => {
			const charted = BAND_DIFFICULTIES.filter((difficulty) => byDifficulty.has(difficulty));
			const playable = byDifficulty.has('expert') ? [...BAND_DIFFICULTIES] : charted;
			return {part, charted, playable};
		});
	}

	// The charted difficulty when it exists, otherwise one derived from Expert; null when neither is possible.
	partChart(part: InstrumentPart, difficulty: BandDifficulty): PartChart | null {
		const byDifficulty = this.tracks.get(part);
		if (!byDifficulty) return null;
		const cacheKey = `${part}:${difficulty}`;
		const cached = this.chartCache.get(cacheKey);
		if (cached) return cached;

		const track = byDifficulty.get(difficulty);
		let chart: PartChart | null = null;
		if (track) {
			chart = buildPartChart(part, difficulty, track);
		} else if (difficulty !== 'expert') {
			const expert = this.partChart(part, 'expert');
			chart = expert ? deriveDifficulty(expert, difficulty, this.tempoMap) : null;
		}
		if (chart) this.chartCache.set(cacheKey, chart);
		return chart;
	}

	// Always derived from Expert, even when the chart has its own; used to compare derivation against real charts.
	derivedPartChart(part: InstrumentPart, difficulty: Exclude<BandDifficulty, 'expert'>): PartChart | null {
		const expert = this.partChart(part, 'expert');
		return expert ? deriveDifficulty(expert, difficulty, this.tempoMap) : null;
	}
}
