// SPDX-License-Identifier: MIT
// NOTICE: vendored from scan-chart 8.0.1 (src/interfaces.ts, src/utils.ts subset), Copyright (c) Geo. See ./LICENSE.

export type ObjectValues<T> = T[keyof T];

export type Instrument = (typeof instruments)[number];
export const instruments = [
	'guitar',
	'guitarcoop',
	'rhythm',
	'bass',
	'drums',
	'keys',
	'guitarghl',
	'guitarcoopghl',
	'rhythmghl',
	'bassghl',
] as const;

export type InstrumentType = ObjectValues<typeof instrumentTypes>;
export const instrumentTypes = {
	sixFret: 0,
	fiveFret: 1,
	drums: 2,
} as const;

export function getInstrumentType(instrument: Instrument): InstrumentType {
	if (instrument === 'drums') {
		return instrumentTypes.drums;
	}
	if (
		instrument === 'guitarghl' ||
		instrument === 'guitarcoopghl' ||
		instrument === 'rhythmghl' ||
		instrument === 'bassghl'
	) {
		return instrumentTypes.sixFret;
	}
	return instrumentTypes.fiveFret;
}

export type DrumType = ObjectValues<typeof drumTypes>;
export const drumTypes = {
	fourLane: 0,
	fourLanePro: 1,
	fiveLane: 2,
} as const;

export type Difficulty = (typeof difficulties)[number];
export const difficulties = ['expert', 'hard', 'medium', 'easy'] as const;

/** @returns the most likely text encoding for text in `buffer`. */
export function getEncoding(buffer: Uint8Array): string {
	if (buffer.length < 2) {
		return 'utf-8';
	}
	if (buffer[0] === 0xff && buffer[1] === 0xfe) {
		return 'utf-16le';
	}
	if (buffer[0] === 0xfe && buffer[1] === 0xff) {
		return 'utf-16be';
	}
	return 'utf-8';
}
