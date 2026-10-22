// SPDX-License-Identifier: AGPL-3.0-or-later

// One line about the band room for the call tile of someone who has not joined. It reads the leader's broadcast state
// (everyone in the call receives it) and takes song titles from the catalog when this client has one; it never loads
// the game.

import BandCatalog from '@app/features/activities/band/BandCatalog';
import {PART_DESCRIPTORS} from '@app/features/activities/band/BandPartNames';
import type {BandVote} from '@app/features/activities/band/BandProtocol';
import {tallyVotes} from '@app/features/activities/band/BandVotes';
import type {BandPart} from '@app/features/activities/band/engine/ChartModel';
import type {ActivitySession} from '@app/features/activities/session/ActivitySessionTypes';
import type {I18n} from '@lingui/core';
import {msg} from '@lingui/core/macro';

const PICKING_DESCRIPTOR = msg({
	message: 'Picking a song',
	comment: 'Voice activities: status line on the band game tile in a call while nobody has voted for a song yet.',
});
const VOTING_DESCRIPTOR = msg({
	message: 'Voting on a song',
	comment: 'Voice activities: status line on the band game tile in a call while the players vote for the next song.',
});
const VOTING_AHEAD_DESCRIPTOR = msg({
	message: 'Voting on a song · {song} is ahead',
	comment:
		'Voice activities: status line on the band game tile in a call while the players vote. {song} is the title of the song with the most votes.',
});
const CHOOSING_PARTS_DESCRIPTOR = msg({
	message: 'Choosing parts',
	comment:
		'Voice activities: status line on the band game tile in a call while the players pick their instruments for the chosen song.',
});
const CHOOSING_PARTS_FOR_DESCRIPTOR = msg({
	message: 'Choosing parts · {song}',
	comment:
		'Voice activities: status line on the band game tile in a call while the players pick their instruments. {song} is the song title.',
});
const PLAYING_DESCRIPTOR = msg({
	message: 'Playing a song',
	comment: 'Voice activities: status line on the band game tile in a call while a song is being played.',
});
const PLAYING_SONG_DESCRIPTOR = msg({
	message: 'Playing {song}',
	comment: 'Voice activities: status line on the band game tile in a call while a song is played. {song} is its title.',
});
const MY_PART_AT_DESCRIPTOR = msg({
	message: '{part} · {time}',
	comment:
		'Voice activities: in the header of the mini window while I play the band game. {part} is my instrument (Guitar, Drums...), {time} how far the song is, like 2:14.',
});
const CHOOSING_PARTS_READY_DESCRIPTOR = msg({
	message: 'Choosing parts · {ready}/{seated} ready',
	comment:
		'Voice activities: status line on the band game tile while the players pick their instruments. {ready} of the {seated} players who took a part are ready.',
});
const RESULTS_DESCRIPTOR = msg({
	message: 'Rating the last song',
	comment:
		'Voice activities: status line on the band game tile in a call after a song, while the players see their scores and rate each other.',
});

function readVotes(value: unknown): ReadonlyArray<BandVote> {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(vote): vote is BandVote =>
			typeof vote === 'object' &&
			vote !== null &&
			typeof (vote as BandVote).userId === 'string' &&
			typeof (vote as BandVote).songId === 'string',
	);
}

function songTitle(value: unknown): string | null {
	return typeof value === 'string' ? BandCatalog.title(value) : null;
}

// A song is on the highways; between songs the room shows lists and forms that need the whole stage.
export function bandSongPlaying(session: ActivitySession): boolean {
	const state = session.state;
	return typeof state === 'object' && state !== null && (state as {phase?: unknown}).phase === 'play';
}

// Observable reads only (the session state and the catalog), so the tile follows the room.
export function describeBandState(session: ActivitySession, i18n: I18n): string | null {
	const state = session.state;
	if (typeof state !== 'object' || state === null) return null;
	const {phase, songId, votes, seats} = state as Record<string, unknown>;
	switch (phase) {
		case 'pick': {
			const standing = readVotes(votes);
			if (standing.length === 0) return i18n._(PICKING_DESCRIPTOR);
			const [leading] = tallyVotes(standing);
			const song = songTitle(leading?.songId);
			return song ? i18n._(VOTING_AHEAD_DESCRIPTOR, {song}) : i18n._(VOTING_DESCRIPTOR);
		}
		case 'select': {
			const seated = Array.isArray(seats) ? seats : [];
			if (seated.length > 0) {
				const ready = seated.filter((seat) => (seat as {ready?: unknown} | null)?.ready === true).length;
				return i18n._(CHOOSING_PARTS_READY_DESCRIPTOR, {ready, seated: seated.length});
			}
			const song = songTitle(songId);
			return song ? i18n._(CHOOSING_PARTS_FOR_DESCRIPTOR, {song}) : i18n._(CHOOSING_PARTS_DESCRIPTOR);
		}
		case 'play': {
			const song = songTitle(songId);
			return song ? i18n._(PLAYING_SONG_DESCRIPTOR, {song}) : i18n._(PLAYING_DESCRIPTOR);
		}
		case 'results':
			return i18n._(RESULTS_DESCRIPTOR);
		default:
			return null;
	}
}

function isBandPart(value: unknown): value is BandPart {
	return typeof value === 'string' && value in PART_DESCRIPTORS;
}

function formatSongTime(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const seconds = totalSeconds % 60;
	return `${Math.floor(totalSeconds / 60)}:${seconds < 10 ? '0' : ''}${seconds}`;
}

// My part and how far the song is, while I play one. The time comes from the session clock, which is not observable:
// the caller refreshes it.
export function describeMyBandPart(session: ActivitySession, i18n: I18n): string | null {
	const state = session.state;
	if (typeof state !== 'object' || state === null) return null;
	const {phase, seats, startAt} = state as Record<string, unknown>;
	if (phase !== 'play' || !Array.isArray(seats) || typeof startAt !== 'number') return null;
	const mine = seats.find(
		(seat): seat is {part: unknown} =>
			typeof seat === 'object' && seat !== null && (seat as {userId?: unknown}).userId === session.me.userId,
	);
	if (!mine || !isBandPart(mine.part)) return null;
	return i18n._(MY_PART_AT_DESCRIPTOR, {
		part: i18n._(PART_DESCRIPTORS[mine.part]),
		time: formatSongTime(session.clock.now() - startAt),
	});
}
