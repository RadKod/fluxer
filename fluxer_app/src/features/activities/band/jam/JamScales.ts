// SPDX-License-Identifier: AGPL-3.0-or-later

// Key and scale to the five lanes of each instrument. A lane plays a scale note; the window of five notes moves by
// octave (and, for the six- and seven-note scales, by position inside the octave). Drums map lanes to kit pieces.

export const JAM_LANE_COUNT = 5;

export type JamScale = 'minorPentatonic' | 'majorPentatonic' | 'blues' | 'naturalMinor';
export type JamInstrument = 'guitar' | 'bass' | 'keys' | 'drums';
export type JamMelodicInstrument = Exclude<JamInstrument, 'drums'>;

export const JAM_SCALES: Readonly<Record<JamScale, ReadonlyArray<number>>> = {
	minorPentatonic: [0, 3, 5, 7, 10],
	majorPentatonic: [0, 2, 4, 7, 9],
	blues: [0, 3, 5, 6, 7, 10],
	naturalMinor: [0, 2, 3, 5, 7, 8, 10],
};

// Pitch class of the key, C = 0.
export type JamKey = number;
export const JAM_DEFAULT_KEY: JamKey = 9;
export const JAM_DEFAULT_SCALE: JamScale = 'minorPentatonic';

// Lowest root of each instrument's home position: the key's root in [low, low + 11]. For A that is A3 for the guitar
// (the prototype solo's box) and the keys, and A1 for the bass, an octave under the guitar's low box.
const HOME_ROOT_LOW: Readonly<Record<JamMelodicInstrument, number>> = {
	guitar: 52,
	keys: 52,
	bass: 24,
};

// Octave shifts offered from home: two octaves of reach for the leads, one for the bass. A shift that would take a
// lane outside the instrument's samples is not offered (see laneNotes).
export const JAM_OCTAVE_RANGE: Readonly<Record<JamMelodicInstrument, {readonly min: number; readonly max: number}>> = {
	guitar: {min: -1, max: 1},
	keys: {min: -1, max: 1},
	bass: {min: -1, max: 1},
};

// Most a sample is pitched up or down to reach a note. Samples are three semitones apart, so inside the range a
// note is at most 1.5 away; this allows the ends.
export const JAM_MAX_DETUNE_SEMITONES = 2;

export interface JamNoteRange {
	readonly low: number;
	readonly high: number;
}

export function playableRange(sampleKeys: ReadonlyArray<number>): JamNoteRange {
	return {
		low: Math.min(...sampleKeys) - JAM_MAX_DETUNE_SEMITONES,
		high: Math.max(...sampleKeys) + JAM_MAX_DETUNE_SEMITONES,
	};
}

export interface JamLaneLayout {
	readonly key: JamKey;
	readonly scale: JamScale;
	readonly octave: number;
	// Scale degrees to move the window up within the octave; 0 starts on the root. Only matters for scales with
	// more than five notes.
	readonly position?: number;
}

export function homeRoot(instrument: JamMelodicInstrument, key: JamKey): number {
	const low = HOME_ROOT_LOW[instrument];
	return low + ((((key - low) % 12) + 12) % 12);
}

// Scale degree `degree` (any integer) above the root, in semitones.
export function scaleDegreeSemitones(scale: JamScale, degree: number): number {
	const steps = JAM_SCALES[scale];
	const octave = Math.floor(degree / steps.length);
	return octave * 12 + steps[degree - octave * steps.length];
}

function clampPosition(scale: JamScale, position: number | undefined): number {
	return Math.min(Math.max(0, Math.round(position ?? 0)), JAM_SCALES[scale].length - 1);
}

// The octave shifts whose five lanes all fit `range`, within the instrument's offer. Empty when none does.
export function availableOctaves(
	instrument: JamMelodicInstrument,
	layout: Omit<JamLaneLayout, 'octave'>,
	range: JamNoteRange,
): ReadonlyArray<number> {
	const home = laneNotesAt(instrument, layout, 0);
	const {min, max} = JAM_OCTAVE_RANGE[instrument];
	const octaves: Array<number> = [];
	for (let octave = min; octave <= max; octave++) {
		if (home[0] + 12 * octave >= range.low && home[home.length - 1] + 12 * octave <= range.high) octaves.push(octave);
	}
	return octaves;
}

function laneNotesAt(
	instrument: JamMelodicInstrument,
	layout: Omit<JamLaneLayout, 'octave'>,
	octave: number,
): ReadonlyArray<number> {
	const position = clampPosition(layout.scale, layout.position);
	const root = homeRoot(instrument, layout.key) + 12 * octave;
	return Array.from({length: JAM_LANE_COUNT}, (_, lane) => root + scaleDegreeSemitones(layout.scale, position + lane));
}

export function foldIntoRange(note: number, range: JamNoteRange): number {
	let folded = note;
	while (folded > range.high && folded - 12 >= range.low) folded -= 12;
	while (folded < range.low && folded + 12 <= range.high) folded += 12;
	return folded;
}

// MIDI notes of the five lanes, low to high. The octave is clamped to the nearest one that fits the samples; when
// no shift fits all five (a high position of a seven-note scale on the bass), single lanes fold by an octave.
export function laneNotes(
	instrument: JamMelodicInstrument,
	layout: JamLaneLayout,
	range: JamNoteRange,
): ReadonlyArray<number> {
	const octaves = availableOctaves(instrument, layout, range);
	const {min, max} = JAM_OCTAVE_RANGE[instrument];
	const wanted = Math.min(max, Math.max(min, Math.round(layout.octave)));
	if (octaves.length > 0) {
		const octave = octaves.reduce((best, o) => (Math.abs(o - wanted) < Math.abs(best - wanted) ? o : best));
		return laneNotesAt(instrument, layout, octave);
	}
	return laneNotesAt(instrument, layout, wanted).map((note) => foldIntoRange(note, range));
}

// Power chords sit an octave under the lead box, where the pre-rendered chords are; high lanes fold down.
export function powerChordRoot(laneNote: number, range: JamNoteRange): number {
	return foldIntoRange(laneNote - 12, range);
}

// The pinch squeal should land in the scale: the third harmonic (a twelfth up) where it does, else the fifth (two
// octaves and a major third, C over A minor), else the fourth (two octaves, always in key).
const PINCH_HARMONIC_PREFERENCE = [3, 5, 4] as const;

export function pinchHarmonicFor(note: number, key: JamKey, scale: JamScale): number {
	const steps = JAM_SCALES[scale];
	for (const harmonic of PINCH_HARMONIC_PREFERENCE) {
		const pitchClass = Math.round(note + 12 * Math.log2(harmonic)) - key;
		if (steps.includes(((pitchClass % 12) + 12) % 12)) return harmonic;
	}
	return 4;
}

export const JAM_DRUM_PIECES = [
	'kick',
	'snare',
	'hh_kapali',
	'hh_acik',
	'tom_ince',
	'tom_kalin',
	'crash',
	'ride',
] as const;
export type JamDrumPiece = (typeof JAM_DRUM_PIECES)[number];

// Per lane: the piece, and the one a modifier picks (open hi-hat, floor tom, ride).
export const JAM_DRUM_LANES: ReadonlyArray<{readonly piece: JamDrumPiece; readonly alternate: JamDrumPiece}> = [
	{piece: 'kick', alternate: 'kick'},
	{piece: 'snare', alternate: 'snare'},
	{piece: 'hh_kapali', alternate: 'hh_acik'},
	{piece: 'tom_ince', alternate: 'tom_kalin'},
	{piece: 'crash', alternate: 'ride'},
];

// Drum notes on the wire are indexes into JAM_DRUM_PIECES.
export function drumNote(lane: number, alternate: boolean): number {
	const entry = JAM_DRUM_LANES[lane];
	if (!entry) throw new RangeError(`No drum lane ${lane}`);
	return JAM_DRUM_PIECES.indexOf(alternate ? entry.alternate : entry.piece);
}

export function drumPiece(note: number): JamDrumPiece | null {
	return JAM_DRUM_PIECES[note] ?? null;
}
