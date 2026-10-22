// SPDX-License-Identifier: AGPL-3.0-or-later

// The parts' names, apart from the game's other messages so the call's mini window can name my part without loading
// the game.

import type {BandPart} from '@app/features/activities/band/engine/ChartModel';
import type {MessageDescriptor} from '@lingui/core';
import {msg} from '@lingui/core/macro';

export const PART_DESCRIPTORS: Readonly<Record<BandPart, MessageDescriptor>> = {
	guitar: msg({message: 'Guitar', comment: 'Band game: the guitar part of a song.'}),
	rhythm: msg({
		message: 'Rhythm guitar',
		comment: 'Band game: the second guitar part of a song, the one playing chords and riffs under the lead.',
	}),
	bass: msg({message: 'Bass', comment: 'Band game: the bass guitar part of a song.'}),
	drums: msg({message: 'Drums', comment: 'Band game: the drums part of a song.'}),
	keys: msg({message: 'Keys', comment: 'Band game: the keyboard (piano, synth) part of a song.'}),
	vocals: msg({message: 'Vocals', comment: 'Band game: the singing part of a song, scored from the microphone.'}),
};
