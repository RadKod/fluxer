// SPDX-License-Identifier: AGPL-3.0-or-later

import {startJam} from '@app/features/activities/band/flow/BandJamMachine';
import {backingSettings, laneOfDrum, laneOfNote} from '@app/features/activities/band/jam/JamRuntime';
import {drumNote, laneNotes} from '@app/features/activities/band/jam/JamScales';
import {describe, expect, it} from 'vitest';

describe('jam runtime helpers', () => {
	it('finds a bandmate note’s lane from its place in the scale, in any octave and as a power chord root', () => {
		const lanes = laneNotes('guitar', {key: 9, scale: 'minorPentatonic', octave: 0}, {low: 0, high: 127});
		expect(lanes.map((note) => laneOfNote(note, 9, 'minorPentatonic'))).toEqual([0, 1, 2, 3, 4]);
		expect(laneOfNote(lanes[3] + 12, 9, 'minorPentatonic')).toBe(3);
		expect(laneOfNote(lanes[1] - 12, 9, 'minorPentatonic')).toBe(1);
		// B is not in A minor pentatonic; the blues scale's flat seventh, its sixth note, has no lane.
		expect(laneOfNote(59, 9, 'minorPentatonic')).toBeNull();
		expect(laneOfNote(9 + 10 + 12 * 4, 9, 'blues')).toBeNull();
	});

	it('finds a drum hit’s lane, alternates included', () => {
		expect(laneOfDrum(drumNote(2, true))).toBe(2);
		expect(laneOfDrum(drumNote(4, false))).toBe(4);
		expect(laneOfDrum(99)).toBeNull();
	});

	it('leaves out of the loop what a person plays', () => {
		const state = startJam(0);
		expect(backingSettings(state)).toMatchObject({drums: true, bass: true, style: 'rock', key: 9});
		const drummer = {...state, seats: [{userId: 'u1', instrument: 'drums' as const}]};
		expect(backingSettings(drummer)).toMatchObject({drums: false, bass: true});
	});
});
