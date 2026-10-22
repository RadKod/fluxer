// SPDX-License-Identifier: AGPL-3.0-or-later

// Bir Daha Baştan: the leader-owned room state and the messages around it. The leader is the only writer of
// BandState (session.setState); everyone else sends intents to the leader, which applies them and broadcasts the
// next state. Hits are judged locally and only their outcome travels (BandHitMessage, lossy).

import type {BandDifficulty, BandPart} from '@app/features/activities/band/engine/ChartModel';
import type {JamBackingStyle} from '@app/features/activities/band/jam/JamBacking';
import type {JamKey, JamScale} from '@app/features/activities/band/jam/JamScales';

export const BAND_PHASE_MS = {
	// Counted from the first vote; with no votes the room waits.
	pick: 6_000,
	select: 20_000,
	// Time between "everyone ready" and the first audio frame; covers the slowest client's clock sync and decode.
	countdown: 4_000,
	results: 25_000,
} as const;

// After the select timer runs out, the song still waits this long for seated players whose package has not loaded;
// whoever is still downloading then watches this song instead of dropping into the middle of it.
export const BAND_LOAD_WAIT_MS = 30_000;

// How long the results screen waits for a player's score before it shows them without one.
export const BAND_RESULT_WAIT_MS = 6_000;

export const BAND_DIFFICULTY_MULTIPLIER: Readonly<Record<BandDifficulty, number>> = {
	easy: 1,
	medium: 1.25,
	hard: 1.5,
	expert: 2,
};

// Random library songs offered while the search box is empty.
export const BAND_SUGGESTIONS = 4;
export const BAND_RATING_MIN = 1;
export const BAND_RATING_MAX = 5;

// Genre shelves of the song picker, in the order the picker lists them; the index files each song under one or more.
export const BAND_GENRE_GROUPS = ['turkce', 'rock', 'metal', 'alternatif', 'pop', 'country', 'klasik'] as const;
export type BandGenreGroup = (typeof BAND_GENRE_GROUPS)[number];

// One entry of the song library index (sanalyer.com/sarkilar/<önek>/index.json). The .sng package carries everything else.
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
	// The genre fields below are empty or null for entries of older indexes, which do not carry them.
	readonly groups: ReadonlyArray<BandGenreGroup>;
	// The charter's own genre text, e.g. "Heavy Metal".
	readonly genre: string | null;
	// Release year, read from the leading four digits of the index's year text ("1969 (October 6)").
	readonly year: number | null;
	// Where the song's preview starts, from song.ini preview_start_time.
	readonly previewStartMs: number | null;
}

export interface BandVote {
	readonly userId: string;
	readonly songId: string;
}

export interface BandSeat {
	readonly part: BandPart;
	readonly userId: string;
	readonly difficulty: BandDifficulty;
	readonly ready: boolean;
	// The player's client has the song package open. Missing in states from older leaders, which never wait for it.
	readonly loaded?: boolean;
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
	// Big Rock Ending bonus banked by the final hit, already part of score and rawScore. Missing when none was earned
	// and in results from older clients.
	readonly finaleBonus?: number;
}

// Jam mode's instruments, named after the song parts they match: guitar is the lead (bend, pinch, feedback), rhythm the
// second guitar on power chords or the clean tone.
export const BAND_JAM_INSTRUMENTS = ['guitar', 'rhythm', 'bass', 'keys', 'drums'] as const;
export type BandJamInstrument = (typeof BAND_JAM_INSTRUMENTS)[number];

// Tempo range the leader can set for the backing loop.
export const BAND_JAM_BPM_MIN = 50;
export const BAND_JAM_BPM_MAX = 220;

export interface BandJamSeat {
	readonly userId: string;
	readonly instrument: BandJamInstrument;
}

export interface BandJamBacking {
	readonly style: JamBackingStyle;
	readonly bpm: number;
	readonly on: boolean;
	// Leader clock of the loop's first step. Every client schedules its own copy of the loop from it, so the loops
	// line up; a new style or tempo starts the loop again.
	readonly since: number;
}

export type BandState =
	| {
			// Anyone searches the library and votes; once a vote is in, the most voted song goes on after a countdown.
			readonly phase: 'pick';
			readonly suggestions: ReadonlyArray<string>;
			// One vote per person, in the order they were cast; a changed vote moves to the end.
			readonly votes: ReadonlyArray<BandVote>;
			// Leader clock when the step opened; it names the round.
			readonly openedAt: number;
			// Null while nobody has voted.
			readonly endsAt: number | null;
	  }
	| {
			readonly phase: 'select';
			readonly songId: string;
			readonly groupDifficulty: BandDifficulty;
			// Leader's choice: songs with a Big Rock Ending end in free play. Off plays the notes charted under it.
			// Missing in states from older leaders, which always play it.
			readonly bigRockEnding?: boolean;
			readonly seats: ReadonlyArray<BandSeat>;
			// People who chose to watch (band.claimSeat with part null). The song starts early only once everyone in the
			// room has either a ready seat or is in here; anyone else, late joiners included, is still deciding.
			readonly watching: ReadonlyArray<string>;
			readonly endsAt: number;
			// Set once endsAt has passed with a seat still downloading: the song starts when every seat has loaded, or at
			// this time without the ones that have not. Missing in states from older leaders.
			readonly loadWaitUntil?: number | null;
	  }
	| {
			readonly phase: 'play';
			readonly songId: string;
			readonly seats: ReadonlyArray<BandSeat>;
			// From the select state; missing means on.
			readonly bigRockEnding?: boolean;
			// Leader clock (session.clock.now()) of song position zero.
			readonly startAt: number;
	  }
	| {
			readonly phase: 'results';
			readonly songId: string;
			readonly seats: ReadonlyArray<BandSeat>;
			readonly results: ReadonlyArray<BandPlayerResult>;
			// rater userId -> player userId -> 1..5; public by design.
			readonly ratings: Readonly<Record<string, Readonly<Record<string, number>>>>;
			readonly endsAt: number;
	  }
	| {
			// Jam mode: no song and no score. Everyone who picked an instrument plays in the room's key over an optional
			// backing loop; the others listen. Older clients do not know this phase and show the room as loading.
			readonly phase: 'jam';
			readonly key: JamKey;
			readonly scale: JamScale;
			readonly backing: BandJamBacking;
			// One entry per player with an instrument; anyone may share an instrument with someone else.
			readonly seats: ReadonlyArray<BandJamSeat>;
			readonly openedAt: number;
	  };

export type BandPhase = BandState['phase'];

// Non-leader -> leader. The leader trusts `from` of the envelope, never a user id inside the payload.
export type BandIntent =
	| BandJamIntent
	// My vote for this song; voting for my current song again takes the vote back.
	| {readonly t: 'band.vote'; readonly songId: string}
	// Leader only: skips the countdown and takes this song to part picking.
	| {readonly t: 'band.playNow'; readonly songId: string}
	// Leader only: from seat selection back to picking another song.
	| {readonly t: 'band.pickAnother'}
	| {readonly t: 'band.claimSeat'; readonly part: BandPart | null}
	| {readonly t: 'band.difficulty'; readonly difficulty: BandDifficulty}
	| {readonly t: 'band.groupDifficulty'; readonly difficulty: BandDifficulty}
	// Leader only: turns the Big Rock Ending on or off for this song.
	| {readonly t: 'band.bigRockEnding'; readonly enabled: boolean}
	| {readonly t: 'band.ready'; readonly ready: boolean}
	// My client has the package for this song open. Sent again whenever my seat shows it has not, so it is idempotent.
	| {readonly t: 'band.loaded'; readonly songId: string}
	| {readonly t: 'band.result'; readonly result: Omit<BandPlayerResult, 'userId'>}
	| {readonly t: 'band.rate'; readonly playerId: string; readonly stars: number}
	// Leader only: ends the current phase early. During the song it stops it; every player's client sends what it has
	// scored so far as soon as it sees the results state.
	| {readonly t: 'band.skip'};

// Jam mode. Only the leader opens and ends it and changes the key, scale and backing; anyone picks their instrument.
export interface BandJamSettingsPatch {
	readonly key?: JamKey;
	readonly scale?: JamScale;
	readonly style?: JamBackingStyle;
	readonly bpm?: number;
	readonly backing?: boolean;
}

export type BandJamIntent =
	// From the song picker into jam mode.
	| {readonly t: 'band.jamStart'}
	// Back to the song picker.
	| {readonly t: 'band.jamEnd'}
	| ({readonly t: 'band.jamSettings'} & BandJamSettingsPatch)
	// Null puts my instrument down and I listen.
	| {readonly t: 'band.jamInstrument'; readonly instrument: BandJamInstrument | null};

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

// Broadcast by each player during the Big Rock Ending: lossy presses with the bonus collected so far, so others see
// the lanes light up, then one reliable message saying whether the final hit landed and the bonus counts.
export type BandFinaleMessage =
	| {
			readonly t: 'band.finale';
			readonly kind: 'press';
			readonly part: BandPart;
			readonly lane: number;
			readonly bonus: number;
	  }
	| {readonly t: 'band.finale'; readonly kind: 'final'; readonly part: BandPart; readonly hit: boolean};

export type BandCheerKind = 'clap' | 'fire' | 'horns' | 'wow';

export interface BandCheerMessage {
	readonly t: 'band.cheer';
	readonly kind: BandCheerKind;
}

export type BandMessage = BandIntent | BandHitMessage | BandFinaleMessage | BandCheerMessage;
