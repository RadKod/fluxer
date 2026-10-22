// SPDX-License-Identifier: AGPL-3.0-or-later

// Note letters as players read them off a chord chart; the same in every language the app speaks.
export const JAM_KEY_NAMES: ReadonlyArray<string> = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

export function jamNoteName(midi: number): {readonly letter: string; readonly octave: number} {
	return {letter: JAM_KEY_NAMES[((midi % 12) + 12) % 12], octave: Math.floor(midi / 12) - 1};
}
