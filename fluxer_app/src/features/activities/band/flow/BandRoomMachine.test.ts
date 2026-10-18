// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	BAND_PHASE_MS,
	BAND_RESULT_WAIT_MS,
	type BandIntent,
	type BandPlayerResult,
	type BandSongSummary,
	type BandState,
} from '@app/features/activities/band/BandProtocol';
import {
	BAND_PLAY_GRACE_MS,
	BAND_QUEUE_MAX,
	type BandPlayState,
	type BandRoomContext,
	clampDifficulty,
	createBandRoomState,
	isBandState,
	parseBandIntent,
	pickCandidates,
	rankCandidates,
	reduceBandIntent,
	resultsWaitEndsAt,
	tickBandRoom,
} from '@app/features/activities/band/flow/BandRoomMachine';
import {describe, expect, it} from 'vitest';

const ALL = ['easy', 'medium', 'hard', 'expert'] as const;

function song(id: string, overrides: Partial<BandSongSummary> = {}): BandSongSummary {
	return {
		id,
		name: id,
		artist: 'Artist',
		lengthMs: 180_000,
		parts: {guitar: ALL, bass: ALL, drums: ALL, vocals: ['easy', 'medium']},
		stems: true,
		coverUrl: null,
		packageUrl: `https://dl.example/${id}.sng`,
		packageBytes: 1000,
		addedBy: null,
		...overrides,
	};
}

const SONGS = [song('a'), song('b'), song('c', {parts: {guitar: ['hard', 'expert']}}), song('d'), song('e')];

function context(overrides: Partial<BandRoomContext> = {}): BandRoomContext {
	return {
		leaderId: 'lead',
		presentUserIds: new Set(['lead', 'u1', 'u2', 'u3']),
		songs: new Map(SONGS.map((entry) => [entry.id, entry])),
		...overrides,
	};
}

const CTX = context();
const TWO_GUITARS = song('two-guitars', {parts: {guitar: ALL, rhythm: ['hard', 'expert'], bass: ALL, drums: ALL}});
const TWO_GUITARS_CTX = context({songs: new Map([...SONGS, TWO_GUITARS].map((entry) => [entry.id, entry]))});
const T0 = 1_000_000;

// The default vote fixture already has a vote in, so its countdown runs.
const VOTE_ENDS_AT = T0 + BAND_PHASE_MS.vote;

type Vote = Extract<BandState, {phase: 'vote'}>;
type Select = Extract<BandState, {phase: 'select'}>;
type Results = Extract<BandState, {phase: 'results'}>;

function vote(overrides: Partial<Vote> = {}): Vote {
	return {
		phase: 'vote',
		queue: [],
		candidates: ['a', 'b', 'c'],
		votes: {},
		openedAt: T0 - 5000,
		endsAt: VOTE_ENDS_AT,
		...overrides,
	};
}

function select(overrides: Partial<Select> = {}): Select {
	return {
		phase: 'select',
		queue: [],
		songId: 'a',
		groupDifficulty: 'medium',
		seats: [],
		watching: [],
		endsAt: T0 + 20_000,
		...overrides,
	};
}

function play(overrides: Partial<BandPlayState> = {}): BandPlayState {
	return {
		phase: 'play',
		queue: [],
		songId: 'a',
		seats: [
			{part: 'guitar', userId: 'u1', difficulty: 'hard', ready: true},
			{part: 'drums', userId: 'u2', difficulty: 'expert', ready: true},
		],
		startAt: T0,
		...overrides,
	};
}

function results(overrides: Partial<Results> = {}): Results {
	return {
		phase: 'results',
		queue: [],
		songId: 'a',
		seats: [
			{part: 'guitar', userId: 'u1', difficulty: 'hard', ready: true},
			{part: 'drums', userId: 'u2', difficulty: 'expert', ready: true},
		],
		results: [],
		ratings: {},
		endsAt: T0 + 25_000,
		...overrides,
	};
}

const RESULT: Omit<BandPlayerResult, 'userId'> = {
	part: 'keys',
	difficulty: 'easy',
	score: 999_999,
	rawScore: 1000,
	accuracy: 0.9,
	bestStreak: 40,
	notesHit: 90,
	notesMissed: 10,
	starPowerUses: 2,
};

function apply(state: BandState, intent: BandIntent, from: string, ctx = CTX, now = T0): BandState {
	return reduceBandIntent(state, intent, from, now, ctx);
}

function applyAll(state: BandState, steps: ReadonlyArray<[BandIntent, string]>, ctx = CTX): BandState {
	return steps.reduce((current, [intent, from]) => apply(current, intent, from, ctx), state);
}

describe('clampDifficulty', () => {
	it('keeps a charted difficulty', () => {
		expect(clampDifficulty('hard', ALL)).toBe('hard');
	});

	it('takes the nearest charted one, the easier on a tie', () => {
		expect(clampDifficulty('easy', ['hard', 'expert'])).toBe('hard');
		expect(clampDifficulty('expert', ['easy', 'medium'])).toBe('medium');
		expect(clampDifficulty('medium', ['easy', 'hard'])).toBe('easy');
	});

	it('is null for a part without a chart', () => {
		expect(clampDifficulty('medium', [])).toBeNull();
	});
});

describe('pickCandidates', () => {
	const songs = CTX.songs;

	it('takes queued songs first, in queue order', () => {
		const queue = [
			{songId: 'd', addedBy: 'u1'},
			{songId: 'b', addedBy: 'u2'},
		];
		expect(pickCandidates(queue, songs, null, 1).slice(0, 2)).toEqual(['d', 'b']);
	});

	it('fills from the library without repeats or the excluded song', () => {
		const candidates = pickCandidates([{songId: 'a', addedBy: 'u1'}], songs, 'b', 7);
		expect(candidates).toHaveLength(3);
		expect(candidates[0]).toBe('a');
		expect(new Set(candidates).size).toBe(3);
		expect(candidates).not.toContain('b');
	});

	it('is reproducible for a seed and varies across seeds', () => {
		expect(pickCandidates([], songs, null, 42)).toEqual(pickCandidates([], songs, null, 42));
		const rounds = new Set(Array.from({length: 20}, (_, seed) => pickCandidates([], songs, null, seed).join()));
		expect(rounds.size).toBeGreaterThan(1);
	});

	it('skips queued songs that left the library and caps at three', () => {
		const queue = ['x', 'a', 'b', 'c', 'd'].map((songId) => ({songId, addedBy: 'u1'}));
		expect(pickCandidates(queue, songs, null, 0)).toEqual(['a', 'b', 'c']);
	});

	it('returns what there is in a small library', () => {
		expect(pickCandidates([], new Map([['a', song('a')]]), null, 0)).toEqual(['a']);
		expect(pickCandidates([], new Map(), null, 0)).toEqual([]);
	});
});

describe('createBandRoomState', () => {
	it('opens a vote with an empty queue', () => {
		const state = createBandRoomState(T0, CTX);
		expect(state).toMatchObject({phase: 'vote', queue: [], votes: {}, openedAt: T0, endsAt: null});
		expect(state.phase === 'vote' && state.candidates).toHaveLength(3);
	});

	it('opens an empty vote while the library is loading', () => {
		const state = createBandRoomState(T0, context({songs: new Map()}));
		expect(state.phase === 'vote' && state.candidates).toEqual([]);
	});
});

describe('queue', () => {
	it('adds a library song with the sender as adder', () => {
		const state = apply(vote(), {t: 'band.queueAdd', songId: 'd'}, 'u1');
		expect(state.queue).toEqual([{songId: 'd', addedBy: 'u1'}]);
	});

	it('ignores duplicates and unknown songs', () => {
		const once = apply(vote(), {t: 'band.queueAdd', songId: 'd'}, 'u1');
		expect(apply(once, {t: 'band.queueAdd', songId: 'd'}, 'u2')).toBe(once);
		expect(apply(once, {t: 'band.queueAdd', songId: 'nope'}, 'u2')).toBe(once);
	});

	it('accepts adds in every phase', () => {
		for (const state of [select(), play(), results()]) {
			expect(apply(state, {t: 'band.queueAdd', songId: 'e'}, 'u3').queue).toEqual([{songId: 'e', addedBy: 'u3'}]);
		}
	});

	it('stops at the queue limit', () => {
		const ids = Array.from({length: BAND_QUEUE_MAX + 1}, (_, i) => `s${i}`);
		const ctx = context({songs: new Map(ids.map((id) => [id, song(id)]))});
		const full = ids.reduce<BandState>(
			(state, songId) => apply(state, {t: 'band.queueAdd', songId}, 'u1', ctx),
			vote({candidates: []}),
		);
		expect(full.queue).toHaveLength(BAND_QUEUE_MAX);
	});

	it('removes the winning song from the queue', () => {
		const state = vote({
			queue: [
				{songId: 'b', addedBy: 'u1'},
				{songId: 'd', addedBy: 'u2'},
			],
			candidates: ['b', 'd', 'a'],
			votes: {u1: 'b'},
		});
		const next = tickBandRoom(state, VOTE_ENDS_AT, CTX);
		expect(next).toMatchObject({phase: 'select', songId: 'b', queue: [{songId: 'd', addedBy: 'u2'}]});
	});
});

describe('vote', () => {
	it('records and changes my vote', () => {
		const first = apply(vote(), {t: 'band.vote', songId: 'a'}, 'u1');
		const changed = apply(first, {t: 'band.vote', songId: 'b'}, 'u1');
		expect(changed.phase === 'vote' && changed.votes).toEqual({u1: 'b'});
		expect(apply(changed, {t: 'band.vote', songId: 'b'}, 'u1')).toBe(changed);
	});

	it('ignores votes for non-candidates and outside the vote', () => {
		const state = vote();
		expect(apply(state, {t: 'band.vote', songId: 'e'}, 'u1')).toBe(state);
		const selecting = select();
		expect(apply(selecting, {t: 'band.vote', songId: 'a'}, 'u1')).toBe(selecting);
	});

	it('picks the most voted song when time runs out', () => {
		const state = vote({votes: {u1: 'c', u2: 'c', u3: 'a'}});
		expect(tickBandRoom(state, VOTE_ENDS_AT - 1, CTX)).toBe(state);
		expect(tickBandRoom(state, VOTE_ENDS_AT, CTX)).toMatchObject({
			phase: 'select',
			songId: 'c',
			seats: [],
			groupDifficulty: 'medium',
			endsAt: VOTE_ENDS_AT + BAND_PHASE_MS.select,
		});
	});

	it('breaks a tie by the earliest queued song', () => {
		const state = vote({
			queue: [
				{songId: 'c', addedBy: 'u1'},
				{songId: 'b', addedBy: 'u1'},
			],
			candidates: ['c', 'b', 'a'],
			votes: {u1: 'a', u2: 'b'},
		});
		expect(rankCandidates(state)[0]).toBe('b');
	});

	it('puts a queued song ahead of an unqueued one on a tie', () => {
		const state = vote({queue: [{songId: 'c', addedBy: 'u1'}], candidates: ['a', 'c', 'b'], votes: {u1: 'a', u2: 'c'}});
		expect(rankCandidates(state)[0]).toBe('c');
	});

	it('waits without a countdown until the first vote', () => {
		const open = vote({endsAt: null});
		expect(tickBandRoom(open, T0 + 10 * 60_000, CTX)).toBe(open);
		const voted = apply(open, {t: 'band.vote', songId: 'b'}, 'u1', CTX, T0 + 60_000);
		expect(voted).toMatchObject({votes: {u1: 'b'}, endsAt: T0 + 60_000 + BAND_PHASE_MS.vote});
		const second = apply(voted, {t: 'band.vote', songId: 'c'}, 'u2', CTX, T0 + 65_000);
		expect(second.phase === 'vote' && second.endsAt).toBe(T0 + 60_000 + BAND_PHASE_MS.vote);
		expect(tickBandRoom(second, T0 + 60_000 + BAND_PHASE_MS.vote, CTX).phase).toBe('select');
	});

	it('stops the countdown when the only voter leaves', () => {
		const state = vote({votes: {gone: 'c'}});
		const next = tickBandRoom(state, T0, CTX);
		expect(next).toMatchObject({phase: 'vote', votes: {}, endsAt: null});
		expect(tickBandRoom(next, T0 + BAND_PHASE_MS.vote, CTX)).toBe(next);
	});

	it('puts a song queued during the vote in place of a library pick nobody voted for', () => {
		const state = vote({votes: {u1: 'b'}});
		const queued = apply(state, {t: 'band.queueAdd', songId: 'e'}, 'u2');
		expect(queued).toMatchObject({candidates: ['a', 'b', 'e'], votes: {u1: 'b'}, queue: [{songId: 'e'}]});
		const again = apply(queued, {t: 'band.queueAdd', songId: 'd'}, 'u3');
		expect(again.phase === 'vote' && again.candidates).toEqual(['d', 'b', 'e']);
		const full = apply(again, {t: 'band.queueAdd', songId: 'two-guitars'}, 'u3', TWO_GUITARS_CTX);
		expect(full.phase === 'vote' && full.candidates).toEqual(['d', 'b', 'e']);
		expect(full.queue.map((entry) => entry.songId)).toEqual(['e', 'd', 'two-guitars']);
	});

	it('lets the leader play a song now, skipping the vote', () => {
		const state = vote({queue: [{songId: 'e', addedBy: 'u1'}], votes: {u1: 'a'}});
		expect(apply(state, {t: 'band.playNow', songId: 'e'}, 'u1')).toBe(state);
		expect(apply(state, {t: 'band.playNow', songId: 'nope'}, 'lead')).toBe(state);
		expect(apply(select(), {t: 'band.playNow', songId: 'e'}, 'lead').phase).toBe('select');
		expect(apply(state, {t: 'band.playNow', songId: 'e'}, 'lead')).toMatchObject({
			phase: 'select',
			songId: 'e',
			queue: [],
			endsAt: T0 + BAND_PHASE_MS.select,
		});
	});

	it('drops the votes of people who left', () => {
		const state = vote({votes: {u1: 'b', gone: 'c'}});
		const next = tickBandRoom(state, T0, CTX);
		expect(next.phase === 'vote' && next.votes).toEqual({u1: 'b'});
		expect(tickBandRoom(next, T0, CTX)).toBe(next);
	});

	it('refills an empty round once the library arrives', () => {
		const empty = createBandRoomState(T0, context({songs: new Map()}));
		expect(tickBandRoom(empty, T0 + 100, context({songs: new Map()}))).toBe(empty);
		const filled = tickBandRoom(empty, T0 + 5000, CTX);
		expect(filled.phase === 'vote' && filled.candidates).toHaveLength(3);
		expect(filled).toMatchObject({openedAt: T0 + 5000, endsAt: null});
	});

	it('keeps waiting on an empty library instead of resolving', () => {
		const ctx = context({songs: new Map()});
		const empty = createBandRoomState(T0, ctx);
		expect(tickBandRoom(empty, T0 + 10 * 60_000, ctx)).toBe(empty);
	});
});

describe('seats', () => {
	it('gives a free part to the first claimer at the group difficulty', () => {
		const state = apply(select({groupDifficulty: 'hard'}), {t: 'band.claimSeat', part: 'guitar'}, 'u1');
		expect(state.phase === 'select' && state.seats).toEqual([
			{part: 'guitar', userId: 'u1', difficulty: 'hard', ready: false},
		]);
	});

	it('keeps a taken part for whoever claimed it first', () => {
		const taken = apply(select(), {t: 'band.claimSeat', part: 'guitar'}, 'u1');
		expect(apply(taken, {t: 'band.claimSeat', part: 'guitar'}, 'u2')).toBe(taken);
	});

	it('moves me when I claim another part, unready', () => {
		const state = applyAll(select(), [
			[{t: 'band.claimSeat', part: 'guitar'}, 'u1'],
			[{t: 'band.claimSeat', part: 'drums'}, 'u2'],
			[{t: 'band.claimSeat', part: 'bass'}, 'u1'],
		]);
		expect(state.phase === 'select' && state.seats.map((seat) => [seat.part, seat.userId, seat.ready])).toEqual([
			['bass', 'u1', false],
			['drums', 'u2', false],
		]);
	});

	it('frees my seat when I choose to watch, and takes me off the watch list when I sit back down', () => {
		const seated = apply(select(), {t: 'band.claimSeat', part: 'guitar'}, 'u1');
		const watching = apply(seated, {t: 'band.claimSeat', part: null}, 'u1');
		expect(watching).toMatchObject({seats: [], watching: ['u1']});
		expect(apply(watching, {t: 'band.claimSeat', part: null}, 'u1')).toBe(watching);
		expect(apply(watching, {t: 'band.claimSeat', part: 'bass'}, 'u1')).toMatchObject({
			seats: [{userId: 'u1', part: 'bass'}],
			watching: [],
		});
	});

	it('drops people who left from the watch list', () => {
		const state = select({watching: ['u2', 'gone']});
		expect(tickBandRoom(state, T0, CTX)).toMatchObject({watching: ['u2']});
	});

	it('only offers parts the song has', () => {
		const state = select({songId: 'c'});
		expect(apply(state, {t: 'band.claimSeat', part: 'drums'}, 'u1')).toBe(state);
		expect(apply(state, {t: 'band.claimSeat', part: 'keys'}, 'u1')).toBe(state);
	});

	it('seats lead and rhythm guitar as separate parts, in band order', () => {
		const state = applyAll(
			select({songId: TWO_GUITARS.id}),
			[
				[{t: 'band.claimSeat', part: 'bass'}, 'u3'],
				[{t: 'band.claimSeat', part: 'rhythm'}, 'u1'],
				[{t: 'band.claimSeat', part: 'guitar'}, 'u2'],
			],
			TWO_GUITARS_CTX,
		);
		expect(state.phase === 'select' && state.seats.map((seat) => [seat.part, seat.userId, seat.difficulty])).toEqual([
			['guitar', 'u2', 'medium'],
			['rhythm', 'u1', 'hard'],
			['bass', 'u3', 'medium'],
		]);
	});

	it('has no rhythm guitar seat in a song without one', () => {
		const state = select();
		expect(apply(state, {t: 'band.claimSeat', part: 'rhythm'}, 'u1')).toBe(state);
	});

	it('clamps the group difficulty to what the part offers', () => {
		const state = apply(select({songId: 'c', groupDifficulty: 'easy'}), {t: 'band.claimSeat', part: 'guitar'}, 'u1');
		expect(state.phase === 'select' && state.seats[0].difficulty).toBe('hard');
	});

	it('lets vocals stay empty and start without them', () => {
		const state = applyAll(select(), [
			[{t: 'band.claimSeat', part: null}, 'lead'],
			[{t: 'band.claimSeat', part: null}, 'u2'],
			[{t: 'band.claimSeat', part: null}, 'u3'],
			[{t: 'band.claimSeat', part: 'guitar'}, 'u1'],
			[{t: 'band.ready', ready: true}, 'u1'],
		]);
		expect(state.phase).toBe('play');
	});

	it('ignores seat intents outside the selection', () => {
		for (const state of [vote(), play(), results()]) {
			expect(apply(state, {t: 'band.claimSeat', part: 'keys'}, 'u3')).toBe(state);
			expect(apply(state, {t: 'band.ready', ready: true}, 'u1')).toBe(state);
			expect(apply(state, {t: 'band.difficulty', difficulty: 'easy'}, 'u1')).toBe(state);
		}
	});
});

describe('difficulty', () => {
	const seated = applyAll(select({songId: 'c'}), [[{t: 'band.claimSeat', part: 'guitar'}, 'u1']]) as Select;

	it('changes my seat, clamped to the chart', () => {
		const expert = apply(seated, {t: 'band.difficulty', difficulty: 'expert'}, 'u1');
		expect(expert.phase === 'select' && expert.seats[0].difficulty).toBe('expert');
		const easy = apply(expert, {t: 'band.difficulty', difficulty: 'easy'}, 'u1');
		expect(easy.phase === 'select' && easy.seats[0].difficulty).toBe('hard');
	});

	it('needs a seat', () => {
		expect(apply(seated, {t: 'band.difficulty', difficulty: 'expert'}, 'u2')).toBe(seated);
	});

	it('takes the group difficulty only from the leader', () => {
		const state = select();
		expect(apply(state, {t: 'band.groupDifficulty', difficulty: 'hard'}, 'u1')).toBe(state);
		expect(apply(state, {t: 'band.groupDifficulty', difficulty: 'hard'}, 'lead')).toMatchObject({
			groupDifficulty: 'hard',
		});
		expect(apply(state, {t: 'band.groupDifficulty', difficulty: 'hard'}, 'lead', context({leaderId: null}))).toBe(
			state,
		);
	});

	it('moves the seats that never picked their own and leaves the rest', () => {
		const state = applyAll(select(), [
			[{t: 'band.claimSeat', part: 'guitar'}, 'u1'],
			[{t: 'band.claimSeat', part: 'drums'}, 'u2'],
			[{t: 'band.claimSeat', part: 'vocals'}, 'u3'],
			[{t: 'band.difficulty', difficulty: 'easy'}, 'u2'],
			[{t: 'band.groupDifficulty', difficulty: 'expert'}, 'lead'],
		]);
		expect(state.phase === 'select' && state.seats.map((seat) => [seat.part, seat.difficulty])).toEqual([
			['guitar', 'expert'],
			['drums', 'easy'],
			// Vocals only chart Easy and Medium; Medium was the group's, so it follows to the nearest, Medium.
			['vocals', 'medium'],
		]);
	});

	it('follows the group from a clamped difficulty', () => {
		const state = applyAll(select({songId: 'c', groupDifficulty: 'easy'}), [
			[{t: 'band.claimSeat', part: 'guitar'}, 'u1'],
			[{t: 'band.groupDifficulty', difficulty: 'expert'}, 'lead'],
		]);
		expect(state.phase === 'select' && state.seats[0].difficulty).toBe('expert');
	});
});

describe('select to play', () => {
	it('starts early once everyone is ready or watching', () => {
		const half = applyAll(select(), [
			[{t: 'band.claimSeat', part: null}, 'lead'],
			[{t: 'band.claimSeat', part: null}, 'u3'],
			[{t: 'band.claimSeat', part: 'guitar'}, 'u1'],
			[{t: 'band.claimSeat', part: 'drums'}, 'u2'],
			[{t: 'band.ready', ready: true}, 'u1'],
		]);
		expect(half.phase).toBe('select');
		const started = apply(half, {t: 'band.ready', ready: true}, 'u2', CTX, T0 + 500);
		expect(started).toMatchObject({phase: 'play', songId: 'a', startAt: T0 + 500 + BAND_PHASE_MS.countdown});
		expect(started.phase === 'play' && started.seats.map((seat) => seat.userId)).toEqual(['u1', 'u2']);
	});

	it('waits for people who have not decided, however ready the seats are', () => {
		const state = applyAll(select(), [
			[{t: 'band.claimSeat', part: null}, 'lead'],
			[{t: 'band.claimSeat', part: 'guitar'}, 'u1'],
			[{t: 'band.ready', ready: true}, 'u1'],
			[{t: 'band.claimSeat', part: 'drums'}, 'u2'],
			[{t: 'band.ready', ready: true}, 'u2'],
		]);
		expect(state.phase).toBe('select');
		expect(tickBandRoom(state, T0 + 10, CTX)).toBe(state);
	});

	it('counts a late joiner as undecided', () => {
		const state = applyAll(select(), [
			[{t: 'band.claimSeat', part: null}, 'lead'],
			[{t: 'band.claimSeat', part: null}, 'u2'],
			[{t: 'band.claimSeat', part: 'guitar'}, 'u1'],
		]);
		const joined = context({presentUserIds: new Set(['lead', 'u1', 'u2', 'u3'])});
		const ready = apply(state, {t: 'band.ready', ready: true}, 'u1', joined);
		expect(ready.phase).toBe('select');
		expect(apply(ready, {t: 'band.claimSeat', part: null}, 'u3', joined).phase).toBe('play');
	});

	it('starts once the last undecided person leaves', () => {
		const state = applyAll(select(), [
			[{t: 'band.claimSeat', part: null}, 'lead'],
			[{t: 'band.claimSeat', part: 'guitar'}, 'u1'],
			[{t: 'band.ready', ready: true}, 'u1'],
		]);
		expect(tickBandRoom(state, T0 + 10, context({presentUserIds: new Set(['lead', 'u1'])})).phase).toBe('play');
	});

	it('goes back to the vote early when everyone chose to watch', () => {
		const state = applyAll(
			select(),
			['lead', 'u1', 'u2', 'u3'].map((userId) => [{t: 'band.claimSeat', part: null}, userId] as [BandIntent, string]),
		);
		expect(state.phase).toBe('vote');
	});

	it('takes back a ready', () => {
		const ready = applyAll(select(), [
			[{t: 'band.claimSeat', part: 'guitar'}, 'u1'],
			[{t: 'band.claimSeat', part: 'drums'}, 'u2'],
			[{t: 'band.ready', ready: true}, 'u1'],
			[{t: 'band.ready', ready: false}, 'u1'],
			[{t: 'band.ready', ready: true}, 'u2'],
		]);
		expect(ready.phase).toBe('select');
	});

	it('starts with whoever is seated when time runs out', () => {
		const state = applyAll(select(), [[{t: 'band.claimSeat', part: 'bass'}, 'u1']]) as Select;
		const next = tickBandRoom(state, state.endsAt, CTX);
		expect(next).toMatchObject({phase: 'play', startAt: state.endsAt + BAND_PHASE_MS.countdown});
	});

	it('goes back to the vote when nobody sat down, without the song', () => {
		const state = select({queue: [{songId: 'b', addedBy: 'u1'}]});
		const next = tickBandRoom(state, state.endsAt, CTX);
		expect(next).toMatchObject({phase: 'vote', queue: [{songId: 'b', addedBy: 'u1'}], votes: {}});
		expect(next.phase === 'vote' && next.candidates).not.toContain('a');
	});

	it('frees the seats of people who left, and starts if the rest are ready', () => {
		const state = applyAll(select(), [
			[{t: 'band.claimSeat', part: null}, 'lead'],
			[{t: 'band.claimSeat', part: 'guitar'}, 'u1'],
			[{t: 'band.claimSeat', part: 'drums'}, 'u2'],
			[{t: 'band.ready', ready: true}, 'u1'],
		]);
		const ctx = context({presentUserIds: new Set(['lead', 'u1'])});
		const next = tickBandRoom(state, T0 + 10, ctx);
		expect(next).toMatchObject({phase: 'play', seats: [{userId: 'u1', part: 'guitar'}]});
	});

	it('leaves the selection alone when nothing changed', () => {
		const state = select();
		expect(tickBandRoom(state, T0, CTX)).toBe(state);
	});
});

describe('play', () => {
	it('collects results from seated players, with seat part and recomputed score', () => {
		const state = apply(play(), {t: 'band.result', result: RESULT}, 'u1') as BandPlayState;
		expect(state.phase).toBe('play');
		expect(state.results).toEqual([
			{
				userId: 'u1',
				part: 'guitar',
				difficulty: 'hard',
				score: 1500,
				rawScore: 1000,
				accuracy: 0.9,
				bestStreak: 40,
				notesHit: 90,
				notesMissed: 10,
				starPowerUses: 2,
			},
		]);
	});

	it('orders results by part with rhythm guitar after the lead', () => {
		const seats = [
			{part: 'guitar', userId: 'u1', difficulty: 'hard', ready: true},
			{part: 'rhythm', userId: 'u2', difficulty: 'expert', ready: true},
		] as const;
		const state = applyAll(
			play({songId: TWO_GUITARS.id, seats}),
			[
				[{t: 'band.result', result: RESULT}, 'u2'],
				[{t: 'band.result', result: RESULT}, 'u1'],
			],
			TWO_GUITARS_CTX,
		);
		expect(
			state.phase === 'results' && state.results.map((result) => [result.part, result.userId, result.score]),
		).toEqual([
			['guitar', 'u1', 1500],
			['rhythm', 'u2', 2000],
		]);
	});

	it('ignores results from spectators and second reports', () => {
		const state = play();
		expect(apply(state, {t: 'band.result', result: RESULT}, 'u3')).toBe(state);
		const once = apply(state, {t: 'band.result', result: RESULT}, 'u1');
		expect(apply(once, {t: 'band.result', result: {...RESULT, rawScore: 5}}, 'u1')).toBe(once);
	});

	it('sanitizes the numbers', () => {
		const state = apply(
			play(),
			{
				t: 'band.result',
				result: {...RESULT, rawScore: -5, accuracy: 3, bestStreak: 2.6, notesHit: Number.NaN},
			},
			'u1',
		) as BandPlayState;
		expect(state.results?.[0]).toMatchObject({rawScore: 0, score: 0, accuracy: 1, bestStreak: 3, notesHit: 0});
	});

	it('ends when every seated player reported', () => {
		const state = applyAll(play(), [
			[{t: 'band.result', result: RESULT}, 'u1'],
			[{t: 'band.result', result: RESULT}, 'u2'],
		]);
		expect(state).toMatchObject({phase: 'results', ratings: {}, endsAt: T0 + BAND_PHASE_MS.results});
		expect(state.phase === 'results' && state.results.map((result) => result.userId)).toEqual(['u1', 'u2']);
	});

	it('does not wait for players who left', () => {
		const ctx = context({presentUserIds: new Set(['lead', 'u1'])});
		const state = apply(play(), {t: 'band.result', result: RESULT}, 'u1', ctx);
		expect(state.phase).toBe('results');
		expect(tickBandRoom(play(), T0, context({presentUserIds: new Set(['lead'])})).phase).toBe('results');
	});

	it('ends at the song length plus grace', () => {
		const state = play();
		const end = state.startAt + 180_000 + BAND_PLAY_GRACE_MS;
		expect(tickBandRoom(state, end - 1, CTX)).toBe(state);
		expect(tickBandRoom(state, end, CTX)).toMatchObject({phase: 'results', results: [], endsAt: end + 25_000});
	});

	it('keeps playing when the song length is unknown', () => {
		const state = play();
		expect(tickBandRoom(state, T0 + 10_000_000, context({songs: new Map()}))).toBe(state);
	});

	// The playtest bug: the chart ran past the index length, so every client reported after the leader had already
	// closed the song on length + 2 s, and their play screens were gone by then.
	it('waits for a result that comes in well after the index length', () => {
		const late = play().startAt + 180_000 + 4_500;
		const waiting = tickBandRoom(play(), late, CTX);
		expect(waiting.phase).toBe('play');
		const state = applyAll(waiting, [
			[{t: 'band.result', result: RESULT}, 'u1'],
			[{t: 'band.result', result: RESULT}, 'u2'],
		]);
		expect(state.phase === 'results' && state.results.map((result) => result.userId)).toEqual(['u1', 'u2']);
	});

	it('stops on the leader’s word with whatever arrived', () => {
		const once = apply(play(), {t: 'band.result', result: RESULT}, 'u1');
		expect(apply(once, {t: 'band.skip'}, 'u2')).toBe(once);
		const stopped = apply(once, {t: 'band.skip'}, 'lead');
		expect(stopped.phase === 'results' && stopped.results.map((result) => result.userId)).toEqual(['u1']);
		const late = apply(stopped, {t: 'band.result', result: RESULT}, 'u2');
		expect(late.phase === 'results' && late.results.map((result) => result.userId)).toEqual(['u1', 'u2']);
	});
});

describe('results', () => {
	it('takes late results from players', () => {
		const state = apply(results(), {t: 'band.result', result: RESULT}, 'u2');
		expect(state.phase === 'results' && state.results[0]).toMatchObject({userId: 'u2', score: 2000});
	});

	it('waits a few seconds for a missing score before giving up on it', () => {
		expect(resultsWaitEndsAt(results())).toBe(T0 + BAND_RESULT_WAIT_MS);
	});

	it('records public ratings from anyone but the player rated', () => {
		const state = applyAll(results(), [
			[{t: 'band.rate', playerId: 'u1', stars: 5}, 'u3'],
			[{t: 'band.rate', playerId: 'u1', stars: 3}, 'u2'],
			[{t: 'band.rate', playerId: 'u2', stars: 4}, 'u3'],
		]);
		expect(state.phase === 'results' && state.ratings).toEqual({u3: {u1: 5, u2: 4}, u2: {u1: 3}});
	});

	it('changes a rating', () => {
		const once = apply(results(), {t: 'band.rate', playerId: 'u1', stars: 2}, 'u3');
		const twice = apply(once, {t: 'band.rate', playerId: 'u1', stars: 4}, 'u3');
		expect(twice.phase === 'results' && twice.ratings).toEqual({u3: {u1: 4}});
		expect(apply(twice, {t: 'band.rate', playerId: 'u1', stars: 4}, 'u3')).toBe(twice);
	});

	it('rejects self ratings, non-players and stars outside 1..5', () => {
		const state = results();
		for (const [intent, from] of [
			[{t: 'band.rate', playerId: 'u1', stars: 5}, 'u1'],
			[{t: 'band.rate', playerId: 'u3', stars: 5}, 'u1'],
			[{t: 'band.rate', playerId: 'u1', stars: 0}, 'u3'],
			[{t: 'band.rate', playerId: 'u1', stars: 6}, 'u3'],
			[{t: 'band.rate', playerId: 'u1', stars: 2.5}, 'u3'],
		] as const) {
			expect(apply(state, intent, from)).toBe(state);
		}
		expect(apply(play(), {t: 'band.rate', playerId: 'u1', stars: 5}, 'u3').phase).toBe('play');
	});

	it('opens the next vote without the song just played', () => {
		const state = results({queue: [{songId: 'a', addedBy: 'u1'}]});
		expect(tickBandRoom(state, state.endsAt - 1, CTX)).toBe(state);
		const next = tickBandRoom(state, state.endsAt, CTX);
		expect(next).toMatchObject({phase: 'vote', votes: {}, openedAt: state.endsAt, endsAt: null});
		// A queued copy of the same song still counts: someone asked for it again.
		expect(next.phase === 'vote' && next.candidates[0]).toBe('a');
		const fresh = tickBandRoom(results(), T0 + 25_000, CTX);
		expect(fresh.phase === 'vote' && fresh.candidates).not.toContain('a');
	});
});

describe('skip', () => {
	it('is the leader’s only', () => {
		const state = vote();
		expect(apply(state, {t: 'band.skip'}, 'u1')).toBe(state);
	});

	it('goes back from the selection to a new vote on the leader’s word', () => {
		const state = select({queue: [{songId: 'b', addedBy: 'u1'}]});
		expect(apply(state, {t: 'band.backToVote'}, 'u1')).toBe(state);
		expect(apply(vote(), {t: 'band.backToVote'}, 'lead').phase).toBe('vote');
		const back = apply(state, {t: 'band.backToVote'}, 'lead');
		expect(back).toMatchObject({phase: 'vote', votes: {}, endsAt: null, queue: [{songId: 'b'}]});
		expect(back.phase === 'vote' && back.candidates[0]).toBe('b');
		expect(back.phase === 'vote' && back.candidates).not.toContain('a');
	});

	it('ends each phase early', () => {
		expect(apply(vote({votes: {u1: 'b'}}), {t: 'band.skip'}, 'lead')).toMatchObject({phase: 'select', songId: 'b'});
		const seated = apply(select(), {t: 'band.claimSeat', part: 'guitar'}, 'u1');
		expect(apply(seated, {t: 'band.skip'}, 'lead').phase).toBe('play');
		expect(apply(select(), {t: 'band.skip'}, 'lead').phase).toBe('vote');
		expect(apply(play(), {t: 'band.skip'}, 'lead').phase).toBe('results');
		expect(apply(results(), {t: 'band.skip'}, 'lead').phase).toBe('vote');
	});

	it('keeps an empty vote as it is', () => {
		const state = vote({candidates: []});
		expect(apply(state, {t: 'band.skip'}, 'lead')).toBe(state);
	});
});

describe('leader handoff', () => {
	it('continues from the shared state on a new leader', () => {
		const shared = applyAll(select(), [[{t: 'band.claimSeat', part: 'guitar'}, 'u1']]);
		const handedOver = JSON.parse(JSON.stringify(shared)) as BandState;
		const newLeader = context({leaderId: 'u1', presentUserIds: new Set(['u1', 'u2'])});
		expect(apply(handedOver, {t: 'band.skip'}, 'lead', newLeader)).toBe(handedOver);
		expect(apply(handedOver, {t: 'band.skip'}, 'u1', newLeader, T0 + 1)).toMatchObject({
			phase: 'play',
			songId: 'a',
			seats: [{userId: 'u1', part: 'guitar'}],
		});
	});

	it('keeps results collected in play across the handoff', () => {
		const shared = apply(play(), {t: 'band.result', result: RESULT}, 'u1');
		const handedOver = JSON.parse(JSON.stringify(shared)) as BandState;
		const next = apply(handedOver, {t: 'band.result', result: RESULT}, 'u2', context({leaderId: 'u1'}));
		expect(next.phase === 'results' && next.results).toHaveLength(2);
	});

	it('picks up an expired timer on the first tick', () => {
		const handedOver = vote({endsAt: T0 - 5000, votes: {u2: 'c'}});
		expect(tickBandRoom(handedOver, T0, context({leaderId: 'u1'}))).toMatchObject({phase: 'select', songId: 'c'});
	});
});

describe('isBandState', () => {
	it('accepts the four phases and rejects the rest', () => {
		for (const state of [vote(), select(), play(), results()]) expect(isBandState(state)).toBe(true);
		for (const value of [null, 3, {}, {phase: 'lobby', queue: []}, {phase: 'vote'}]) {
			expect(isBandState(value)).toBe(false);
		}
	});
});

describe('parseBandIntent', () => {
	it('passes well-formed intents through', () => {
		const intents: Array<BandIntent> = [
			{t: 'band.queueAdd', songId: 'a'},
			{t: 'band.vote', songId: 'a'},
			{t: 'band.playNow', songId: 'a'},
			{t: 'band.backToVote'},
			{t: 'band.claimSeat', part: 'drums'},
			{t: 'band.claimSeat', part: 'rhythm'},
			{t: 'band.claimSeat', part: null},
			{t: 'band.difficulty', difficulty: 'expert'},
			{t: 'band.groupDifficulty', difficulty: 'easy'},
			{t: 'band.ready', ready: false},
			{t: 'band.result', result: RESULT},
			{t: 'band.rate', playerId: 'u1', stars: 4},
			{t: 'band.skip'},
		];
		for (const intent of intents) expect(parseBandIntent(JSON.parse(JSON.stringify(intent)))).toEqual(intent);
	});

	it('drops unknown fields such as a user id in the payload', () => {
		expect(parseBandIntent({t: 'band.vote', songId: 'a', userId: 'someone-else'})).toEqual({
			t: 'band.vote',
			songId: 'a',
		});
	});

	it('rejects malformed payloads', () => {
		for (const payload of [
			null,
			'band.skip',
			{t: 'band.hit'},
			{t: 'band.cheer', kind: 'clap'},
			{t: 'band.vote'},
			{t: 'band.vote', songId: ''},
			{t: 'band.claimSeat', part: 'triangle'},
			{t: 'band.claimSeat'},
			{t: 'band.difficulty', difficulty: 'insane'},
			{t: 'band.ready', ready: 'yes'},
			{t: 'band.result', result: {...RESULT, score: 'lots'}},
			{t: 'band.result', result: {...RESULT, part: 'kazoo'}},
			{t: 'band.rate', playerId: 'u1', stars: Number.POSITIVE_INFINITY},
		]) {
			expect(parseBandIntent(payload)).toBeNull();
		}
	});
});
