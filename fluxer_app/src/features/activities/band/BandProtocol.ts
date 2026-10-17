// SPDX-License-Identifier: AGPL-3.0-or-later

// Bir Daha Baştan: the leader-owned room state and the messages around it. The leader is the only writer of
// BandState (session.setState); everyone else sends intents to the leader, which applies them and broadcasts the
// next state. Hits are judged locally and only their outcome travels (BandHitMessage, lossy).

import type {BandDifficulty, BandPart} from '@app/features/activities/band/engine/ChartModel';

export const BAND_PHASE_MS = {
	vote: 20_000,
	select: 20_000,
	// Time between "everyone ready" and the first audio frame; covers the slowest client's clock sync and decode.
	countdown: 4_000,
	results: 25_000,
} as const;

export const BAND_DIFFICULTY_MULTIPLIER: Readonly<Record<BandDifficulty, number>> = {
	easy: 1,
	medium: 1.25,
	hard: 1.5,
	expert: 2,
};

export const BAND_VOTE_CANDIDATES = 3;
export const BAND_RATING_MIN = 1;
export const BAND_RATING_MAX = 5;

// One entry of the song library index (dl.sanalyer.com/sarkilar/index.json). The .sng package carries everything else.
export interface BandSongSummary {
	readonly id: string;
	readonly name: string;
	readonly artist: string;
	readonly lengthMs: number;
	// Charted difficulties per part; a part missing here is not in the song.
	readonly parts: Partial<Record<BandPart, ReadonlyArray<BandDifficulty>>>;
	// Separate audio per part, so a miss can duck it. False for single-mix songs like Misirlou.
	readonly stems: boolean;
	readonly coverUrl: string | null;
	readonly packageUrl: string;
	readonly packageBytes: number;
	readonly addedBy: string | null;
}

export interface BandQueueEntry {
	readonly songId: string;
	readonly addedBy: string;
}

export interface BandSeat {
	readonly part: BandPart;
	readonly userId: string;
	readonly difficulty: BandDifficulty;
	readonly ready: boolean;
}

export interface BandPlayerResult {
	readonly userId: string;
	readonly part: BandPart;
	readonly difficulty: BandDifficulty;
	readonly score: number;
	// Score before the difficulty multiplier, shown next to it.
	readonly rawScore: number;
	readonly accuracy: number;
	readonly bestStreak: number;
	readonly notesHit: number;
	readonly notesMissed: number;
	readonly starPowerUses: number;
}

export type BandState =
	| {
			readonly phase: 'vote';
			readonly queue: ReadonlyArray<BandQueueEntry>;
			readonly candidates: ReadonlyArray<string>;
			// voter userId -> songId
			readonly votes: Readonly<Record<string, string>>;
			readonly endsAt: number;
	  }
	| {
			readonly phase: 'select';
			readonly queue: ReadonlyArray<BandQueueEntry>;
			readonly songId: string;
			readonly groupDifficulty: BandDifficulty;
			readonly seats: ReadonlyArray<BandSeat>;
			// People who chose to watch (band.claimSeat with part null). The song starts early only once everyone in the
			// room has either a ready seat or is in here; anyone else, late joiners included, is still deciding.
			readonly watching: ReadonlyArray<string>;
			readonly endsAt: number;
	  }
	| {
			readonly phase: 'play';
			readonly queue: ReadonlyArray<BandQueueEntry>;
			readonly songId: string;
			readonly seats: ReadonlyArray<BandSeat>;
			// Leader clock (session.clock.now()) of song position zero.
			readonly startAt: number;
	  }
	| {
			readonly phase: 'results';
			readonly queue: ReadonlyArray<BandQueueEntry>;
			readonly songId: string;
			readonly seats: ReadonlyArray<BandSeat>;
			readonly results: ReadonlyArray<BandPlayerResult>;
			// rater userId -> player userId -> 1..5; public by design.
			readonly ratings: Readonly<Record<string, Readonly<Record<string, number>>>>;
			readonly endsAt: number;
	  };

export type BandPhase = BandState['phase'];

// Non-leader -> leader. The leader trusts `from` of the envelope, never a user id inside the payload.
export type BandIntent =
	| {readonly t: 'band.queueAdd'; readonly songId: string}
	| {readonly t: 'band.vote'; readonly songId: string}
	| {readonly t: 'band.claimSeat'; readonly part: BandPart | null}
	| {readonly t: 'band.difficulty'; readonly difficulty: BandDifficulty}
	| {readonly t: 'band.groupDifficulty'; readonly difficulty: BandDifficulty}
	| {readonly t: 'band.ready'; readonly ready: boolean}
	| {readonly t: 'band.result'; readonly result: Omit<BandPlayerResult, 'userId'>}
	| {readonly t: 'band.rate'; readonly playerId: string; readonly stars: number}
	| {readonly t: 'band.skip'};

// Broadcast by each player during the song, lossy. Remote clients duck that part's stem on a miss and show the combo.
export interface BandHitMessage {
	readonly t: 'band.hit';
	readonly part: BandPart;
	readonly noteIndex: number;
	readonly hit: boolean;
	readonly combo: number;
	readonly multiplier: number;
	readonly starPower: boolean;
	readonly score: number;
}

export type BandCheerKind = 'clap' | 'fire' | 'horns' | 'wow';

export interface BandCheerMessage {
	readonly t: 'band.cheer';
	readonly kind: BandCheerKind;
}

export type BandMessage = BandIntent | BandHitMessage | BandCheerMessage;
