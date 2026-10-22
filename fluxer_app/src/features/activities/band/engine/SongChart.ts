// SPDX-License-Identifier: AGPL-3.0-or-later

import {type BigRockEnding, codaSpan} from '@app/features/activities/band/engine/BigRockEnding';
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

// Chart tracks that can feed each part, in order of preference; a track feeds only the first part that claims it.
// PART RHYTHM is the bass in charts without PART BASS (the Guitar Hero co-op convention), rhythm guitar otherwise.
const PART_TRACKS: ReadonlyArray<readonly [InstrumentPart, ReadonlyArray<Instrument>]> = [
	['guitar', ['guitar']],
	['bass', ['bass', 'rhythm']],
	['rhythm', ['rhythm']],
	['drums', ['drums']],
	['keys', ['keys']],
];

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

// The song's ending across parts. Fills are instrument-wide in .mid but per difficulty in .chart; the hardest charted
// difficulty of each part is the reference.
function songBigRockEnding(
	tracks: ReadonlyMap<InstrumentPart, ReadonlyMap<BandDifficulty, ParsedTrack>>,
): BigRockEnding | null {
	let ending: BigRockEnding | null = null;
	for (const byDifficulty of tracks.values()) {
		const track = BAND_DIFFICULTIES.map((difficulty) => byDifficulty.get(difficulty))
			.filter((candidate) => candidate !== undefined)
			.at(-1);
		const span = track ? codaSpan(track.drumFreestyleSections) : null;
		if (!span) continue;
		const endMs = span.msTime + span.msLength;
		ending = ending
			? {startMs: Math.min(ending.startMs, span.msTime), endMs: Math.max(ending.endMs, endMs)}
			: {startMs: span.msTime, endMs};
	}
	return ending;
}

export class SongChart {
	private readonly chartCache = new Map<string, PartChart>();

	private constructor(
		readonly tempoMap: TempoMap,
		readonly sections: ReadonlyArray<ChartSection>,
		readonly vocals: VocalsChart | null,
		// From the earliest part's lanes to the latest one's end; null when no part has a coda fill. Each part's own
		// lanes are on its PartChart.
		readonly bigRockEnding: BigRockEnding | null,
		private readonly tracks: ReadonlyMap<InstrumentPart, ReadonlyMap<BandDifficulty, ParsedTrack>>,
	) {}

	static parse(data: Uint8Array, format: ChartFormat, modifiers: Partial<IniChartModifiers> = {}): SongChart {
		const parsed = parseChartFile(data, format, modifiers);
		const tempoMap = new TempoMap(parsed.resolution, parsed.tempos, parsed.timeSignatures);

		const byInstrument = new Map<Instrument, Map<BandDifficulty, ParsedTrack>>();
		for (const track of parsed.trackData) {
			if (track.noteEventGroups.length === 0) continue;
			let byDifficulty = byInstrument.get(track.instrument);
			if (!byDifficulty) {
				byDifficulty = new Map();
				byInstrument.set(track.instrument, byDifficulty);
			}
			byDifficulty.set(track.difficulty, track);
		}
		const tracks = new Map<InstrumentPart, ReadonlyMap<BandDifficulty, ParsedTrack>>();
		const claimed = new Set<Instrument>();
		for (const [part, instruments] of PART_TRACKS) {
			for (const instrument of instruments) {
				const byDifficulty = byInstrument.get(instrument);
				if (!byDifficulty || claimed.has(instrument)) continue;
				claimed.add(instrument);
				tracks.set(part, byDifficulty);
				break;
			}
		}

		const sections = parsed.sections.map(({name, msTime}) => ({name, msTime}));
		const vocals = format === 'mid' ? parseVocalsFromMidi(data, tempoMap) : null;
		return new SongChart(tempoMap, sections, vocals, songBigRockEnding(tracks), tracks);
	}

	get durationMs(): number {
		let end = this.vocals?.durationMs ?? 0;
		for (const availability of this.availableParts()) {
			const chart = this.partChart(availability.part, availability.charted.at(-1) ?? 'expert');
			end = Math.max(end, chart?.durationMs ?? 0);
		}
		return end;
	}

	hasPart(part: InstrumentPart): boolean {
		return this.tracks.has(part);
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
