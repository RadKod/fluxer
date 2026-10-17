// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandPart} from '@app/features/activities/band/engine/ChartModel';
import {parseSng, type SongFile} from '@app/features/activities/band/engine/SngFile';
import {type ChartFormat, SongChart} from '@app/features/activities/band/engine/SongChart';
import {
	parseSongIni,
	type SongIniValues,
	type SongMetadata,
	songMetadataFromIni,
} from '@app/features/activities/band/engine/SongMetadata';

// "backing" is song.*, the mix of everything without its own stem; it is never ducked.
export type StemRole = BandPart | 'backing' | 'crowd' | 'preview';
export type AudioFormat = 'opus' | 'ogg';

export interface AudioStem {
	readonly role: StemRole;
	readonly fileName: string;
	readonly format: AudioFormat;
	readonly data: Uint8Array;
}

export interface ChartFile {
	readonly fileName: string;
	readonly format: ChartFormat;
	readonly data: Uint8Array;
}

export class SongPackageError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'SongPackageError';
	}
}

// Preferred first when a folder carries the same stem in both formats.
const AUDIO_FORMATS: ReadonlyArray<AudioFormat> = ['opus', 'ogg'];
const CHART_FILES: ReadonlyArray<readonly [string, ChartFormat]> = [
	['notes.mid', 'mid'],
	['notes.chart', 'chart'],
];
const ALBUM_ART_FILES = ['album.png', 'album.jpg', 'album.jpeg'];

const FIXED_STEM_ROLES: Readonly<Record<string, StemRole>> = {
	guitar: 'guitar',
	bass: 'bass',
	drums: 'drums',
	drums_1: 'drums',
	drums_2: 'drums',
	drums_3: 'drums',
	drums_4: 'drums',
	vocals: 'vocals',
	vocals_1: 'vocals',
	vocals_2: 'vocals',
	keys: 'keys',
	song: 'backing',
	crowd: 'crowd',
	preview: 'preview',
};

function baseName(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1).toLowerCase();
}

function splitExtension(fileName: string): [stem: string, extension: string] {
	const dot = fileName.lastIndexOf('.');
	return dot <= 0 ? [fileName, ''] : [fileName.slice(0, dot), fileName.slice(dot + 1)];
}

// rhythm.* is the bass stem when there is no bass.*; otherwise it is rhythm guitar and plays as backing.
export function mapAudioStems(files: ReadonlyArray<SongFile>): Array<AudioStem> {
	const byStem = new Map<string, {file: SongFile; format: AudioFormat}>();
	for (const file of files) {
		const [stem, extension] = splitExtension(baseName(file.fileName));
		const format = AUDIO_FORMATS.find((candidate) => candidate === extension);
		if (!format) continue;
		const existing = byStem.get(stem);
		if (existing && AUDIO_FORMATS.indexOf(existing.format) <= AUDIO_FORMATS.indexOf(format)) continue;
		byStem.set(stem, {file, format});
	}

	const stems: Array<AudioStem> = [];
	for (const [stem, {file, format}] of [...byStem].sort(([a], [b]) => a.localeCompare(b))) {
		const role = stem === 'rhythm' ? (byStem.has('bass') ? 'backing' : 'bass') : FIXED_STEM_ROLES[stem];
		if (role) stems.push({role, fileName: file.fileName, format, data: file.data});
	}
	return stems;
}

export class SongPackage {
	private parsedChart: SongChart | null = null;

	private constructor(
		readonly ini: SongIniValues,
		readonly metadata: SongMetadata,
		readonly chartFile: ChartFile,
		readonly stems: ReadonlyArray<AudioStem>,
		readonly albumArt: SongFile | null,
	) {}

	static fromSng(bytes: Uint8Array): SongPackage {
		const sng = parseSng(bytes);
		const ini: Record<string, string> = {};
		for (const [key, value] of Object.entries(sng.metadata)) ini[key.toLowerCase()] = value;
		return SongPackage.create(ini, sng.files);
	}

	static fromFolder(files: ReadonlyArray<SongFile>): SongPackage {
		const iniFile = files.find((file) => baseName(file.fileName) === 'song.ini');
		return SongPackage.create(iniFile ? parseSongIni(iniFile.data) : {}, files);
	}

	private static create(ini: SongIniValues, files: ReadonlyArray<SongFile>): SongPackage {
		const findFile = (name: string) => files.find((file) => baseName(file.fileName) === name);
		let chartFile: ChartFile | null = null;
		for (const [name, format] of CHART_FILES) {
			const file = findFile(name);
			if (file) {
				chartFile = {fileName: file.fileName, format, data: file.data};
				break;
			}
		}
		if (!chartFile) throw new SongPackageError('Song has no notes.mid or notes.chart');

		const albumArt = ALBUM_ART_FILES.map(findFile).find((file) => file !== undefined) ?? null;
		return new SongPackage(ini, songMetadataFromIni(ini), chartFile, mapAudioStems(files), albumArt);
	}

	stemsFor(role: StemRole): Array<AudioStem> {
		return this.stems.filter((stem) => stem.role === role);
	}

	// Parsed on first use. scan-chart throws plain strings, so failures are rewrapped as SongPackageError.
	chart(): SongChart {
		if (!this.parsedChart) {
			try {
				this.parsedChart = SongChart.parse(this.chartFile.data, this.chartFile.format, this.metadata.chartModifiers);
			} catch (error) {
				throw new SongPackageError(`${this.chartFile.fileName} could not be parsed: ${String(error)}`, {cause: error});
			}
		}
		return this.parsedChart;
	}
}
