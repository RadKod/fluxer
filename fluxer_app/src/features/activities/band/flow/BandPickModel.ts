// SPDX-License-Identifier: AGPL-3.0-or-later

// What the song picker shows, apart from React: the vote panel, the cover grid's column count and how the arrow keys
// move through it.

import {BAND_PHASE_MS, type BandState, type BandVote} from '@app/features/activities/band/BandProtocol';
import {tallyVotes} from '@app/features/activities/band/BandVotes';

type PickState = Extract<BandState, {phase: 'pick'}>;

export interface BandVoteRow {
	readonly songId: string;
	readonly voterIds: ReadonlyArray<string>;
	// The song that would open if the countdown ended now.
	readonly leading: boolean;
	readonly mine: boolean;
}

export type BandVotePanel =
	| {readonly kind: 'waiting'}
	| {
			readonly kind: 'counting';
			readonly secondsLeft: number;
			// 1 when the countdown starts, 0 when it ends.
			readonly remaining: number;
			readonly rows: ReadonlyArray<BandVoteRow>;
			// Leader only: open the leading song without waiting.
			readonly canPlayNow: boolean;
	  };

export function myVoteSongId(votes: ReadonlyArray<BandVote>, myUserId: string): string | null {
	return votes.find((vote) => vote.userId === myUserId)?.songId ?? null;
}

// Voting again for the song I voted for takes the vote back (band.vote toggles).
export function voteAction(songId: string, votes: ReadonlyArray<BandVote>, myUserId: string): 'vote' | 'unvote' {
	return myVoteSongId(votes, myUserId) === songId ? 'unvote' : 'vote';
}

export function votePanel(state: PickState, myUserId: string, isLeader: boolean, now: number): BandVotePanel {
	const tally = tallyVotes(state.votes);
	if (tally.length === 0 || state.endsAt === null) return {kind: 'waiting'};
	const leftMs = Math.max(0, state.endsAt - now);
	return {
		kind: 'counting',
		secondsLeft: Math.ceil(leftMs / 1000),
		remaining: Math.min(1, leftMs / BAND_PHASE_MS.pick),
		rows: tally.map((entry, index) => ({
			songId: entry.songId,
			voterIds: entry.voterIds,
			leading: index === 0,
			mine: entry.voterIds.includes(myUserId),
		})),
		canPlayNow: isLeader,
	};
}

// Cards keep at least this width; four fit beside the rail and the panel on a 1440 px stage.
const MIN_CARD_PX = 168;
const GRID_GAP_PX = 16;
const MIN_COLUMNS = 2;
const MAX_COLUMNS = 6;

export function pickGridColumns(widthPx: number): number {
	const fit = Math.floor((widthPx + GRID_GAP_PX) / (MIN_CARD_PX + GRID_GAP_PX));
	return Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, fit));
}

export type GridKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';

export function isGridKey(key: string): key is GridKey {
	return ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key);
}

// The card index after a key press; rows move by the column count and stop at the edges rather than wrapping.
export function moveInGrid(index: number, key: GridKey, columns: number, count: number): number {
	if (count === 0) return 0;
	const last = count - 1;
	const from = Math.min(Math.max(index, 0), last);
	switch (key) {
		case 'ArrowLeft':
			return Math.max(0, from - 1);
		case 'ArrowRight':
			return Math.min(last, from + 1);
		case 'ArrowUp':
			return from - columns >= 0 ? from - columns : from;
		case 'ArrowDown':
			return from + columns <= last ? from + columns : from;
		case 'Home':
			return 0;
		case 'End':
			return last;
	}
}
