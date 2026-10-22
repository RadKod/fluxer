// SPDX-License-Identifier: AGPL-3.0-or-later

// Which key and scale a freestyle solo section plays in, from the key the index measured for the song.

import type {BandKeyArea, BandKeyScale, BandSongKey} from '@app/features/activities/band/BandProtocol';
import {
	JAM_DEFAULT_KEY,
	JAM_DEFAULT_SCALE,
	type JamKey,
	type JamScale,
} from '@app/features/activities/band/jam/JamScales';

const PITCH_CLASSES: Readonly<Record<string, JamKey>> = {
	C: 0,
	'C#': 1,
	Db: 1,
	D: 2,
	'D#': 3,
	Eb: 3,
	E: 4,
	F: 5,
	'F#': 6,
	Gb: 6,
	G: 7,
	'G#': 8,
	Ab: 8,
	A: 9,
	'A#': 10,
	Bb: 10,
	B: 11,
};

const JAM_SCALE_OF: Readonly<Record<BandKeyScale, JamScale>> = {
	'minor-pentatonic': 'minorPentatonic',
	'major-pentatonic': 'majorPentatonic',
	blues: 'blues',
};

export function pitchClass(tonic: string): JamKey | null {
	return PITCH_CLASSES[tonic] ?? null;
}

export type SoloKeySource = 'solo' | 'song' | 'default';

export interface SoloKeyChoice {
	readonly key: JamKey;
	// The key's name as the analysis wrote it, for showing: "A", "F#", "Bb".
	readonly tonic: string;
	readonly scale: JamScale;
	// Freestyle notes are shifted by this to sit in tune with the recording.
	readonly tuningCents: number;
	// The measured solo section's key, the song's key, or A minor pentatonic when the index has none.
	readonly source: SoloKeySource;
}

// The pentatonic of the key's own mode. When the analysis is unsure, the blues scale's flat fifth is the note most
// likely to clash, while the five pentatonic notes are shared with the relative key (A minor and C major pentatonic
// are the same notes), so a major/minor mix-up still sounds right.
function safeScale(area: BandKeyArea): JamScale {
	return area.mode === 'minor' ? 'minorPentatonic' : 'majorPentatonic';
}

function overlapMs(startMs: number, endMs: number, other: {startMs: number; endMs: number}): number {
	return Math.min(endMs, other.endMs) - Math.max(startMs, other.startMs);
}

const DEFAULT_CHOICE: SoloKeyChoice = {
	key: JAM_DEFAULT_KEY,
	tonic: 'A',
	scale: JAM_DEFAULT_SCALE,
	tuningCents: 0,
	source: 'default',
};

// The solo key measured over most of the section, else the song's key.
export function soloKeyFor(songKey: BandSongKey | null, startMs: number, endMs: number): SoloKeyChoice {
	if (!songKey) return DEFAULT_CHOICE;
	let best: BandKeyArea | null = null;
	let bestOverlap = 0;
	for (const solo of songKey.solos) {
		const overlap = overlapMs(startMs, endMs, solo);
		if (overlap > bestOverlap && pitchClass(solo.tonic) !== null) {
			best = solo;
			bestOverlap = overlap;
		}
	}
	const area = best ?? songKey;
	const key = pitchClass(area.tonic);
	if (key === null) return DEFAULT_CHOICE;
	return {
		key,
		tonic: area.tonic,
		scale: songKey.lowConfidence ? safeScale(area) : JAM_SCALE_OF[area.scale],
		tuningCents: songKey.tuningCents,
		source: best ? 'solo' : 'song',
	};
}
