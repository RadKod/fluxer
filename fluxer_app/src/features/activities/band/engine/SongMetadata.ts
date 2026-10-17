// SPDX-License-Identifier: AGPL-3.0-or-later

import {getEncoding} from '@app/features/activities/band/engine/vendor/scan-chart/interfaces';
import type {IniChartModifiers} from '@app/features/activities/band/engine/vendor/scan-chart/note-parsing-interfaces';

export type SongIniValues = Readonly<Record<string, string>>;

export interface SongMetadata {
	readonly name: string | null;
	readonly artist: string | null;
	readonly album: string | null;
	readonly genre: string | null;
	readonly year: string | null;
	readonly charter: string | null;
	readonly songLengthMs: number | null;
	readonly previewStartMs: number | null;
	readonly delayMs: number;
	// Charter difficulty ratings (usually 0..6); -1 or absent in song.ini means the part is not rated.
	readonly ratings: Readonly<
		Partial<Record<'band' | 'guitar' | 'bass' | 'rhythm' | 'drums' | 'keys' | 'vocals', number>>
	>;
	readonly chartModifiers: Readonly<Partial<IniChartModifiers>>;
}

const RATING_KEYS = {
	band: 'diff_band',
	guitar: 'diff_guitar',
	bass: 'diff_bass',
	rhythm: 'diff_rhythm',
	drums: 'diff_drums',
	keys: 'diff_keys',
	vocals: 'diff_vocals',
} as const;

// Lowercased keys from the [song] section; later duplicates win, matching Clone Hero.
export function parseSongIni(data: Uint8Array): Record<string, string> {
	const text = new TextDecoder(getEncoding(data)).decode(data).replace(/^﻿/, '');
	const values: Record<string, string> = {};
	let inSongSection = false;
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith(';') || line.startsWith('#')) continue;
		const section = /^\[(.+)]$/.exec(line);
		if (section) {
			inSongSection = section[1].trim().toLowerCase() === 'song';
			continue;
		}
		const separator = line.indexOf('=');
		if (!inSongSection || separator <= 0) continue;
		values[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
	}
	return values;
}

function text(values: SongIniValues, key: string): string | null {
	const value = values[key];
	return value === undefined || value === '' ? null : value;
}

function number(values: SongIniValues, key: string): number | null {
	const value = values[key];
	if (value === undefined || value.trim() === '') return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function bool(values: SongIniValues, key: string): boolean | null {
	const value = values[key]?.toLowerCase();
	if (value === 'true' || value === '1') return true;
	if (value === 'false' || value === '0') return false;
	return null;
}

export function songMetadataFromIni(values: SongIniValues): SongMetadata {
	const ratings: Partial<Record<keyof typeof RATING_KEYS, number>> = {};
	for (const [part, key] of Object.entries(RATING_KEYS) as Array<[keyof typeof RATING_KEYS, string]>) {
		const rating = number(values, key);
		if (rating !== null && rating >= 0) ratings[part] = rating;
	}

	const chartModifiers: Partial<IniChartModifiers> = {};
	const numericModifiers = [
		'song_length',
		'hopo_frequency',
		'multiplier_note',
		'sustain_cutoff_threshold',
		'chord_snap_threshold',
	] as const;
	for (const key of numericModifiers) {
		const value = number(values, key);
		if (value !== null) chartModifiers[key] = value;
	}
	for (const key of ['eighthnote_hopo', 'five_lane_drums', 'pro_drums'] as const) {
		const value = bool(values, key);
		if (value !== null) chartModifiers[key] = value;
	}

	const previewStartMs = number(values, 'preview_start_time');
	const songLengthMs = number(values, 'song_length');
	return {
		name: text(values, 'name'),
		artist: text(values, 'artist'),
		album: text(values, 'album'),
		genre: text(values, 'genre'),
		year: text(values, 'year'),
		charter: text(values, 'charter') ?? text(values, 'frets'),
		songLengthMs: songLengthMs !== null && songLengthMs > 0 ? songLengthMs : null,
		previewStartMs: previewStartMs !== null && previewStartMs >= 0 ? previewStartMs : null,
		delayMs: number(values, 'delay') ?? 0,
		ratings,
		chartModifiers,
	};
}
