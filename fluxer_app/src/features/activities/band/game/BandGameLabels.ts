// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandDifficulty, BandPart} from '@app/features/activities/band/engine/ChartModel';
import type {FeedbackKind} from '@app/features/activities/band/game/PlayController';
import type {MessageDescriptor} from '@lingui/core';
import {msg} from '@lingui/core/macro';

export const PART_LABELS: Readonly<Record<BandPart, MessageDescriptor>> = {
	guitar: msg({message: 'Guitar', context: 'band-part', comment: 'Band game: the guitar part a player plays.'}),
	bass: msg({message: 'Bass', context: 'band-part', comment: 'Band game: the bass guitar part a player plays.'}),
	drums: msg({message: 'Drums', context: 'band-part', comment: 'Band game: the drums part a player plays.'}),
	keys: msg({message: 'Keys', context: 'band-part', comment: 'Band game: the keyboard (piano) part a player plays.'}),
	vocals: msg({
		message: 'Vocals',
		context: 'band-part',
		comment: 'Band game: the singing part; the singer sings into voice chat.',
	}),
};

export const DIFFICULTY_LABELS: Readonly<Record<BandDifficulty, MessageDescriptor>> = {
	easy: msg({message: 'Easy', context: 'band-difficulty', comment: 'Band game: the easiest difficulty level.'}),
	medium: msg({message: 'Medium', context: 'band-difficulty', comment: 'Band game: the second difficulty level.'}),
	hard: msg({message: 'Hard', context: 'band-difficulty', comment: 'Band game: the third difficulty level.'}),
	expert: msg({message: 'Expert', context: 'band-difficulty', comment: 'Band game: the hardest difficulty level.'}),
};

export const SEAT_DESCRIPTOR = msg({
	message: '{part}, {difficulty}',
	comment: 'Band game: under a player name, their part and difficulty, e.g. "Guitar, Hard".',
});

export const FEEDBACK_LABELS: Readonly<Record<FeedbackKind, MessageDescriptor>> = {
	perfect: msg({
		message: 'Perfect',
		context: 'band-hit',
		comment: 'Band game: flashes at the strikeline for a note hit right on time. Keep it one short word.',
	}),
	good: msg({
		message: 'Good',
		context: 'band-hit',
		comment: 'Band game: flashes at the strikeline for a note hit slightly off time. Keep it one short word.',
	}),
	ok: msg({
		message: 'OK',
		context: 'band-hit',
		comment: 'Band game: flashes at the strikeline for a note hit late or early but still counted. Very short.',
	}),
	miss: msg({
		message: 'Missed',
		context: 'band-hit',
		comment: 'Band game: flashes at the strikeline when a note was not played. Keep it one short word.',
	}),
};
