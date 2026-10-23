// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	BAND_LOAD_WAIT_MS,
	BAND_PHASE_MS,
	BAND_RESULT_WAIT_MS,
	BAND_SUGGESTIONS,
	type BandIntent,
	type BandPlayerResult,
	type BandSongSummary,
	type BandState,
} from '@app/features/activities/band/BandProtocol';
import {tallyVotes} from '@app/features/activities/band/BandVotes';
import type {BandPart} from '@app/features/activities/band/engine/ChartModel';
import {
	BAND_PLAY_GRACE_MS,
	type BandPlayState,
	type BandRoomContext,
	clampDifficulty,
	createBandRoomState,
	isBandState,
	parseBandIntent,
	pickSuggestions,
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
		groups: [],
		genre: null,
		year: null,
		previewStartMs: null,
		key: null,
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

type Pick = Extract<BandState, {phase: 'pick'}>;
type Select = Extract<BandState, {phase: 'select'}>;
type Results = Extract<BandState, {phase: 'results'}>;

function pick(overrides: Partial<Pick> = {}): Pick {
	return {phase: 'pick', suggestions: ['a', 'b', 'c', 'd'], votes: [], openedAt: T0 - 5000, endsAt: null, ...overrides};
}

function select(overrides: Partial<Select> = {}): Select {
	return {
		phase: 'select',
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

// Takes the part and reports the package of song 'a' as loaded, like a client that already has it.
function sit(part: BandPart, userId: string, songId = 'a'): Array<[BandIntent, string]> {
	return [
		[{t: 'band.claimSeat', part}, userId],
		[{t: 'band.loaded', songId}, userId],
	];
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

describe('pickSuggestions', () => {
	const songs = CTX.songs;

	it('offers library songs without repeats or the excluded song', () => {
		const suggestions = pickSuggestions(songs, 'b', 7);
		expect(suggestions).toHaveLength(BAND_SUGGESTIONS);
		expect(new Set(suggestions).size).toBe(BAND_SUGGESTIONS);
		expect(suggestions).not.toContain('b');
	});

	it('is reproducible for a seed and varies across seeds', () => {
		expect(pickSuggestions(songs, null, 42)).toEqual(pickSuggestions(songs, null, 42));
		const rounds = new Set(Array.from({length: 20}, (_, seed) => pickSuggestions(songs, null, seed).join()));
		expect(rounds.size).toBeGreaterThan(1);
	});

	it('returns what there is in a small library', () => {
		expect(pickSuggestions(new Map([['a', song('a')]]), null, 0)).toEqual(['a']);
		expect(pickSuggestions(new Map(), null, 0)).toEqual([]);
	});
});

describe('createBandRoomState', () => {
	it('opens song picking with suggestions', () => {
		const state = createBandRoomState(T0, CTX);
		expect(state).toMatchObject({phase: 'pick', openedAt: T0});
		expect(state.phase === 'pick' && state.suggestions).toHaveLength(BAND_SUGGESTIONS);
	});

	it('opens without suggestions while the library is loading', () => {
		const state = createBandRoomState(T0, context({songs: new Map()}));
		expect(state.phase === 'pick' && state.suggestions).toEqual([]);
	});
});

describe('pick', () => {
	const PICK_ENDS_AT = T0 + BAND_PHASE_MS.pick;

	it('records, changes and takes back my vote', () => {
		const first = apply(pick(), {t: 'band.vote', songId: 'e'}, 'u1');
		expect(first).toMatchObject({votes: [{userId: 'u1', songId: 'e'}], endsAt: PICK_ENDS_AT});
		const changed = apply(first, {t: 'band.vote', songId: 'b'}, 'u1', CTX, T0 + 1000);
		expect(changed).toMatchObject({votes: [{userId: 'u1', songId: 'b'}], endsAt: PICK_ENDS_AT});
		expect(apply(changed, {t: 'band.vote', songId: 'b'}, 'u1')).toMatchObject({votes: [], endsAt: null});
	});

	it('ignores songs outside the library and votes outside song picking', () => {
		const state = pick();
		expect(apply(state, {t: 'band.vote', songId: 'nope'}, 'u1')).toBe(state);
		for (const other of [select(), play(), results()])
			expect(apply(other, {t: 'band.vote', songId: 'a'}, 'u1')).toBe(other);
	});

	it('waits without a countdown until somebody votes', () => {
		const state = pick();
		expect(tickBandRoom(state, T0 + 60 * 60_000, CTX)).toBe(state);
	});

	it('takes the most voted song when the countdown ends, the earlier one on a tie', () => {
		const state = applyAll(pick(), [
			[{t: 'band.vote', songId: 'c'}, 'u1'],
			[{t: 'band.vote', songId: 'a'}, 'u2'],
			[{t: 'band.vote', songId: 'a'}, 'u3'],
			[{t: 'band.vote', songId: 'c'}, 'lead'],
		]);
		expect(tallyVotes(state.phase === 'pick' ? state.votes : []).map((entry) => entry.songId)).toEqual(['c', 'a']);
		expect(tickBandRoom(state, PICK_ENDS_AT - 1, CTX)).toBe(state);
		expect(tickBandRoom(state, PICK_ENDS_AT, CTX)).toEqual({
			phase: 'select',
			songId: 'c',
			groupDifficulty: 'medium',
			bigRockEnding: true,
			seats: [],
			watching: [],
			endsAt: PICK_ENDS_AT + BAND_PHASE_MS.select,
			loadWaitUntil: null,
		});
	});

	it('moves a changed vote to the back for the tie-break', () => {
		const state = applyAll(pick(), [
			[{t: 'band.vote', songId: 'c'}, 'u1'],
			[{t: 'band.vote', songId: 'a'}, 'u2'],
			[{t: 'band.vote', songId: 'b'}, 'u1'],
			[{t: 'band.vote', songId: 'c'}, 'u1'],
		]);
		expect(tallyVotes(state.phase === 'pick' ? state.votes : []).map((entry) => entry.songId)).toEqual(['a', 'c']);
	});

	it('drops the votes of people who left and stops the countdown with the last one', () => {
		const state = pick({votes: [{userId: 'gone', songId: 'c'}], endsAt: PICK_ENDS_AT});
		const next = tickBandRoom(state, T0, CTX);
		expect(next).toMatchObject({phase: 'pick', votes: [], endsAt: null});
		expect(tickBandRoom(next, PICK_ENDS_AT, CTX)).toBe(next);
	});

	it('lets the leader play a song now, skipping the countdown', () => {
		const state = pick({votes: [{userId: 'u1', songId: 'a'}], endsAt: PICK_ENDS_AT});
		expect(apply(state, {t: 'band.playNow', songId: 'e'}, 'u1')).toBe(state);
		expect(apply(state, {t: 'band.playNow', songId: 'nope'}, 'lead')).toBe(state);
		expect(apply(state, {t: 'band.playNow', songId: 'e'}, 'lead')).toMatchObject({phase: 'select', songId: 'e'});
	});

	it('goes on with the leading song on the leader’s skip, and stays without votes', () => {
		expect(apply(pick({votes: [{userId: 'u1', songId: 'b'}]}), {t: 'band.skip'}, 'lead')).toMatchObject({
			phase: 'select',
			songId: 'b',
		});
		const empty = pick();
		expect(apply(empty, {t: 'band.skip'}, 'lead')).toBe(empty);
	});

	it('fills in suggestions once the library arrives', () => {
		const empty = createBandRoomState(T0, context({songs: new Map()}));
		expect(tickBandRoom(empty, T0 + 100, context({songs: new Map()}))).toBe(empty);
		const filled = tickBandRoom(empty, T0 + 5000, CTX);
		expect(filled.phase === 'pick' && filled.suggestions).toHaveLength(BAND_SUGGESTIONS);
	});
});

describe('seats', () => {
	it('gives a free part to the first claimer at the group difficulty', () => {
		const state = apply(select({groupDifficulty: 'hard'}), {t: 'band.claimSeat', part: 'guitar'}, 'u1');
		expect(state.phase === 'select' && state.seats).toEqual([
			{part: 'guitar', userId: 'u1', difficulty: 'hard', ready: false, loaded: false},
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
			...sit('guitar', 'u1'),
			[{t: 'band.ready', ready: true}, 'u1'],
		]);
		expect(state.phase).toBe('play');
	});

	it('ignores seat intents outside the selection', () => {
		for (const state of [pick(), play(), results()]) {
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

describe('freestyle solo choice', () => {
	it('is the seated player own switch, for guitars and keys only, and goes into the song with the seat', () => {
		const ctx = context({songs: new Map([['a', song('a', {parts: {guitar: ALL, keys: ALL, bass: ALL}})]])});
		const seated = applyAll(select(), [...sit('guitar', 'u1'), ...sit('bass', 'u2')], ctx);
		const on = apply(seated, {t: 'band.freestyleSolo', enabled: true}, 'u1', ctx) as Select;
		expect(on.seats.find((seat) => seat.userId === 'u1')).toMatchObject({part: 'guitar', freestyleSolo: true});
		expect(apply(on, {t: 'band.freestyleSolo', enabled: true}, 'u1', ctx)).toBe(on);
		expect(apply(on, {t: 'band.freestyleSolo', enabled: true}, 'u2', ctx)).toBe(on);
		expect(apply(on, {t: 'band.freestyleSolo', enabled: true}, 'u3', ctx)).toBe(on);
		const moved = apply(on, {t: 'band.claimSeat', part: 'keys'}, 'u1', ctx) as Select;
		expect(moved.seats.find((seat) => seat.userId === 'u1')).toMatchObject({part: 'keys', freestyleSolo: true});
		const off = apply(moved, {t: 'band.freestyleSolo', enabled: false}, 'u1', ctx) as Select;
		expect(off.seats.find((seat) => seat.userId === 'u1')).not.toHaveProperty('freestyleSolo');
		expect(apply(on, {t: 'band.skip'}, 'lead', ctx)).toMatchObject({
			phase: 'play',
			seats: expect.arrayContaining([expect.objectContaining({userId: 'u1', freestyleSolo: true})]),
		});
		expect(apply(play(), {t: 'band.freestyleSolo', enabled: true}, 'u1')).toMatchObject({phase: 'play'});
	});

	it('is dropped when the player moves to a part without freestyle', () => {
		const on = applyAll(select(), [...sit('guitar', 'u1'), [{t: 'band.freestyleSolo', enabled: true}, 'u1']]);
		const bass = apply(on, {t: 'band.claimSeat', part: 'bass'}, 'u1') as Select;
		expect(bass.seats[0]).not.toHaveProperty('freestyleSolo');
	});

	it('parses the switch and keeps the freestyle points of a result within its score', () => {
		expect(parseBandIntent({t: 'band.freestyleSolo', enabled: true})).toEqual({t: 'band.freestyleSolo', enabled: true});
		expect(parseBandIntent({t: 'band.freestyleSolo', enabled: 'yes'})).toBeNull();
		const scored = apply(
			play(),
			{t: 'band.result', result: {...RESULT, freestylePoints: 310.6}},
			'u1',
		) as BandPlayState;
		expect(scored.results?.[0]).toMatchObject({score: 1500, freestylePoints: 311});
		const inflated = apply(
			play(),
			{t: 'band.result', result: {...RESULT, freestylePoints: 1e9}},
			'u1',
		) as BandPlayState;
		expect(inflated.results?.[0]).toMatchObject({freestylePoints: 1500});
		const parsed = parseBandIntent({t: 'band.result', result: {...RESULT, freestylePoints: 'many'}});
		expect(parsed).toBeNull();
	});
});

describe('Big Rock Ending setting', () => {
	it('is on for every new song', () => {
		expect(apply(pick(), {t: 'band.playNow', songId: 'e'}, 'lead')).toMatchObject({bigRockEnding: true});
	});

	it('takes the switch only from the leader, during seat selection', () => {
		const state = select({bigRockEnding: true});
		expect(apply(state, {t: 'band.bigRockEnding', enabled: false}, 'u1')).toBe(state);
		expect(apply(state, {t: 'band.bigRockEnding', enabled: true}, 'lead')).toBe(state);
		const off = apply(state, {t: 'band.bigRockEnding', enabled: false}, 'lead');
		expect(off).toMatchObject({phase: 'select', bigRockEnding: false});
		expect(apply(off, {t: 'band.bigRockEnding', enabled: true}, 'lead')).toMatchObject({bigRockEnding: true});
		expect(apply(play(), {t: 'band.bigRockEnding', enabled: false}, 'lead')).toMatchObject({phase: 'play'});
	});

	it('reads a state from an older leader without the field as on', () => {
		const old = select();
		expect(apply(old, {t: 'band.bigRockEnding', enabled: true}, 'lead')).toBe(old);
		expect(apply(old, {t: 'band.skip'}, 'lead', CTX)).toMatchObject({phase: 'pick'});
		const seated = applyAll(old, [...sit('guitar', 'u1')]);
		expect(apply(seated, {t: 'band.skip'}, 'lead')).toMatchObject({phase: 'play', bigRockEnding: true});
	});

	it('goes into the song with the seats', () => {
		const seated = applyAll(select(), [...sit('guitar', 'u1'), [{t: 'band.bigRockEnding', enabled: false}, 'lead']]);
		expect(apply(seated, {t: 'band.skip'}, 'lead')).toMatchObject({phase: 'play', bigRockEnding: false});
	});
});

describe('select to play', () => {
	it('starts early once everyone is ready or watching', () => {
		const half = applyAll(select(), [
			[{t: 'band.claimSeat', part: null}, 'lead'],
			[{t: 'band.claimSeat', part: null}, 'u3'],
			...sit('guitar', 'u1'),
			...sit('drums', 'u2'),
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
			...sit('guitar', 'u1'),
		]);
		const joined = context({presentUserIds: new Set(['lead', 'u1', 'u2', 'u3'])});
		const ready = apply(state, {t: 'band.ready', ready: true}, 'u1', joined);
		expect(ready.phase).toBe('select');
		expect(apply(ready, {t: 'band.claimSeat', part: null}, 'u3', joined).phase).toBe('play');
	});

	it('starts once the last undecided person leaves', () => {
		const state = applyAll(select(), [
			[{t: 'band.claimSeat', part: null}, 'lead'],
			...sit('guitar', 'u1'),
			[{t: 'band.ready', ready: true}, 'u1'],
		]);
		expect(tickBandRoom(state, T0 + 10, context({presentUserIds: new Set(['lead', 'u1'])})).phase).toBe('play');
	});

	it('goes back to song picking early when everyone chose to watch', () => {
		const state = applyAll(
			select(),
			['lead', 'u1', 'u2', 'u3'].map((userId) => [{t: 'band.claimSeat', part: null}, userId] as [BandIntent, string]),
		);
		expect(state.phase).toBe('pick');
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
		const state = applyAll(select(), sit('bass', 'u1')) as Select;
		const next = tickBandRoom(state, state.endsAt, CTX);
		expect(next).toMatchObject({phase: 'play', startAt: state.endsAt + BAND_PHASE_MS.countdown});
	});

	it('goes back to song picking when nobody sat down, without suggesting the song again', () => {
		const state = select();
		const next = tickBandRoom(state, state.endsAt, CTX);
		expect(next).toMatchObject({phase: 'pick', openedAt: state.endsAt});
		expect(next.phase === 'pick' && next.suggestions).not.toContain('a');
	});

	it('frees the seats of people who left, and starts if the rest are ready', () => {
		const state = applyAll(select(), [
			[{t: 'band.claimSeat', part: null}, 'lead'],
			...sit('guitar', 'u1'),
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

describe('song package loading', () => {
	const ROOM = context({presentUserIds: new Set(['lead', 'u1', 'u2'])});
	const ENDS_AT = T0 + BAND_PHASE_MS.select;
	const CAP = ENDS_AT + BAND_LOAD_WAIT_MS;

	// The leader watches, u1 has the song and is ready, u2 has taken drums and is still downloading.
	function downloading(): Select {
		return applyAll(
			select(),
			[
				[{t: 'band.claimSeat', part: null}, 'lead'],
				...sit('guitar', 'u1'),
				[{t: 'band.ready', ready: true}, 'u1'],
				[{t: 'band.claimSeat', part: 'drums'}, 'u2'],
			],
			ROOM,
		) as Select;
	}

	it('takes ready from a client that never reports loading (an older version) as loaded', () => {
		const state = downloading();
		const ready = apply(state, {t: 'band.ready', ready: true}, 'u2', ROOM);
		expect(ready.phase).toBe('play');
	});

	it('marks the seat loaded on its report, then starts on ready', () => {
		const state = downloading();
		const loaded = apply(state, {t: 'band.loaded', songId: 'a'}, 'u2', ROOM);
		expect(loaded.phase === 'select' && loaded.seats.find((seat) => seat.userId === 'u2')).toMatchObject({
			loaded: true,
			ready: false,
		});
		expect(apply(loaded, {t: 'band.ready', ready: true}, 'u2', ROOM).phase).toBe('play');
	});

	it('does not start early while a ready seat is still downloading', () => {
		// A seat that is ready in the shared state (from an older leader) without the package still holds the start.
		const state = select({
			seats: [
				{part: 'guitar', userId: 'u1', difficulty: 'medium', ready: true, loaded: true},
				{part: 'drums', userId: 'u2', difficulty: 'medium', ready: true, loaded: false},
			],
			watching: ['lead'],
		});
		expect(tickBandRoom(state, T0 + 10, ROOM)).toBe(state);
		expect(apply(state, {t: 'band.loaded', songId: 'a'}, 'u2', ROOM, T0 + 20).phase).toBe('play');
	});

	it('ignores a loaded report for another song or from someone without a seat', () => {
		const state = downloading();
		expect(apply(state, {t: 'band.loaded', songId: 'b'}, 'u2', ROOM)).toBe(state);
		expect(apply(state, {t: 'band.loaded', songId: 'a'}, 'lead', ROOM)).toBe(state);
		for (const other of [pick(), play(), results()]) {
			expect(apply(other, {t: 'band.loaded', songId: 'a'}, 'u1')).toBe(other);
		}
	});

	it('keeps the package across a part change but not after watching', () => {
		const moved = applyAll(select(), [...sit('guitar', 'u1'), [{t: 'band.claimSeat', part: 'bass'}, 'u1']]);
		expect(moved.phase === 'select' && moved.seats[0]).toMatchObject({part: 'bass', loaded: true});
		const back = applyAll(moved, [
			[{t: 'band.claimSeat', part: null}, 'u1'],
			[{t: 'band.claimSeat', part: 'drums'}, 'u1'],
		]);
		expect(back.phase === 'select' && back.seats[0]).toMatchObject({part: 'drums', loaded: false});
	});

	it('waits past the timer for a seat still downloading, and says until when', () => {
		const state = downloading();
		const waiting = tickBandRoom(state, ENDS_AT, ROOM);
		expect(waiting).toMatchObject({phase: 'select', endsAt: ENDS_AT, loadWaitUntil: CAP});
		expect(tickBandRoom(waiting, ENDS_AT + 1000, ROOM)).toBe(waiting);
		const started = apply(waiting, {t: 'band.loaded', songId: 'a'}, 'u2', ROOM, ENDS_AT + 2000);
		expect(started).toMatchObject({phase: 'play', startAt: ENDS_AT + 2000 + BAND_PHASE_MS.countdown});
		expect(started.phase === 'play' && started.seats.map((seat) => seat.userId)).toEqual(['u1', 'u2']);
	});

	it('starts without the seats still downloading once the wait runs out', () => {
		const waiting = tickBandRoom(downloading(), ENDS_AT, ROOM);
		expect(tickBandRoom(waiting, CAP - 1, ROOM)).toBe(waiting);
		const started = tickBandRoom(waiting, CAP, ROOM);
		expect(started).toMatchObject({phase: 'play', seats: [{userId: 'u1', part: 'guitar'}]});
		expect(started.phase === 'play' && started.seats).toHaveLength(1);
	});

	it('goes back to song picking when nobody has the song by then', () => {
		const state = applyAll(select(), [[{t: 'band.claimSeat', part: 'guitar'}, 'u1']], ROOM) as Select;
		const waiting = tickBandRoom(state, ENDS_AT, ROOM);
		expect(waiting.phase).toBe('select');
		expect(tickBandRoom(waiting, CAP, ROOM)).toMatchObject({phase: 'pick', openedAt: CAP});
	});

	it('starts the leader’s skip without the seats still downloading', () => {
		expect(apply(downloading(), {t: 'band.skip'}, 'lead', ROOM)).toMatchObject({
			phase: 'play',
			seats: [{userId: 'u1'}],
		});
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

	it('ignores results from spectators and second reports that judged no more of the song', () => {
		const state = play();
		expect(apply(state, {t: 'band.result', result: RESULT}, 'u3')).toBe(state);
		const once = apply(state, {t: 'band.result', result: RESULT}, 'u1');
		expect(apply(once, {t: 'band.result', result: {...RESULT, rawScore: 5}}, 'u1')).toBe(once);
		const shorter = {...RESULT, rawScore: 5000, notesHit: 10, notesMissed: 0};
		expect(apply(once, {t: 'band.result', result: shorter}, 'u1')).toBe(once);
	});

	it('replaces an early partial result with a fuller one while the song plays, and only then', () => {
		const partial = {...RESULT, rawScore: 100, notesHit: 9, notesMissed: 1};
		const early = apply(play(), {t: 'band.result', result: partial}, 'u1') as BandPlayState;
		const full = apply(early, {t: 'band.result', result: RESULT}, 'u1') as BandPlayState;
		expect(full.phase).toBe('play');
		expect(full.results).toEqual([expect.objectContaining({userId: 'u1', rawScore: 1000, notesHit: 90})]);

		const reported = results({results: early.results});
		expect(apply(reported, {t: 'band.result', result: RESULT}, 'u1')).toBe(reported);
	});

	it('keeps the banked finale bonus, never above the score', () => {
		const banked = apply(play(), {t: 'band.result', result: {...RESULT, finaleBonus: 420.4}}, 'u1') as BandPlayState;
		expect(banked.results?.[0]).toMatchObject({score: 1500, finaleBonus: 420});
		const inflated = apply(play(), {t: 'band.result', result: {...RESULT, finaleBonus: 1e9}}, 'u1') as BandPlayState;
		expect(inflated.results?.[0]).toMatchObject({score: 1500, finaleBonus: 1500});
		const none = apply(play(), {t: 'band.result', result: {...RESULT, finaleBonus: -3}}, 'u1') as BandPlayState;
		expect(none.results?.[0]).not.toHaveProperty('finaleBonus');
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

	it('opens song picking without suggesting the song just played', () => {
		const state = results();
		expect(tickBandRoom(state, state.endsAt - 1, CTX)).toBe(state);
		const next = tickBandRoom(state, state.endsAt, CTX);
		expect(next).toMatchObject({phase: 'pick', openedAt: state.endsAt});
		expect(next.phase === 'pick' && next.suggestions).not.toContain('a');
	});
});

describe('skip', () => {
	it('is the leader’s only', () => {
		const state = select();
		expect(apply(state, {t: 'band.skip'}, 'u1')).toBe(state);
	});

	it('goes from part picking back to song picking on the leader’s word', () => {
		const state = select();
		expect(apply(state, {t: 'band.pickAnother'}, 'u1')).toBe(state);
		const picking = pick();
		expect(apply(picking, {t: 'band.pickAnother'}, 'lead')).toBe(picking);
		const back = apply(state, {t: 'band.pickAnother'}, 'lead');
		expect(back).toMatchObject({phase: 'pick', openedAt: T0});
		expect(back.phase === 'pick' && back.suggestions).not.toContain('a');
	});

	it('ends each phase early', () => {
		const seated = applyAll(select(), sit('guitar', 'u1'));
		expect(apply(seated, {t: 'band.skip'}, 'lead').phase).toBe('play');
		expect(apply(select(), {t: 'band.skip'}, 'lead').phase).toBe('pick');
		expect(apply(play(), {t: 'band.skip'}, 'lead').phase).toBe('results');
		expect(apply(results(), {t: 'band.skip'}, 'lead').phase).toBe('pick');
	});
});

describe('leader handoff', () => {
	it('continues from the shared state on a new leader', () => {
		const shared = applyAll(select(), sit('guitar', 'u1'));
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
		const handedOver = select({
			endsAt: T0 - 5000,
			seats: [{part: 'guitar', userId: 'u2', difficulty: 'easy', ready: false, loaded: true}],
		});
		expect(tickBandRoom(handedOver, T0, context({leaderId: 'u1'}))).toMatchObject({phase: 'play', songId: 'a'});
	});

	it('waits for a seat from an older leader’s state until its client reports the package', () => {
		const handedOver = select({
			endsAt: T0 - 5000,
			seats: [{part: 'guitar', userId: 'u2', difficulty: 'easy', ready: false}],
		});
		const waiting = tickBandRoom(handedOver, T0, context({leaderId: 'u1'}));
		expect(waiting).toMatchObject({phase: 'select', loadWaitUntil: T0 - 5000 + BAND_LOAD_WAIT_MS});
		expect(apply(waiting, {t: 'band.loaded', songId: 'a'}, 'u2', context({leaderId: 'u1'}))).toMatchObject({
			phase: 'play',
			seats: [{userId: 'u2', loaded: true}],
		});
	});

	it('starts afresh from a state an older client wrote', () => {
		expect(isBandState({phase: 'vote', queue: [], candidates: ['a'], votes: {}})).toBe(false);
	});
});

describe('isBandState', () => {
	it('accepts the four phases and rejects the rest', () => {
		for (const state of [pick(), select(), play(), results()]) expect(isBandState(state)).toBe(true);
		for (const value of [null, 3, {}, {phase: 'lobby'}, {phase: 'vote'}]) {
			expect(isBandState(value)).toBe(false);
		}
	});
});

describe('parseBandIntent', () => {
	it('passes well-formed intents through', () => {
		const intents: Array<BandIntent> = [
			{t: 'band.vote', songId: 'a'},
			{t: 'band.playNow', songId: 'a'},
			{t: 'band.pickAnother'},
			{t: 'band.claimSeat', part: 'drums'},
			{t: 'band.claimSeat', part: 'rhythm'},
			{t: 'band.claimSeat', part: null},
			{t: 'band.difficulty', difficulty: 'expert'},
			{t: 'band.groupDifficulty', difficulty: 'easy'},
			{t: 'band.bigRockEnding', enabled: false},
			{t: 'band.ready', ready: false},
			{t: 'band.loaded', songId: 'a'},
			{t: 'band.result', result: RESULT},
			{t: 'band.result', result: {...RESULT, finaleBonus: 1200}},
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
			{t: 'band.queueAdd', songId: 'a'},
			{t: 'band.claimSeat', part: 'triangle'},
			{t: 'band.claimSeat'},
			{t: 'band.difficulty', difficulty: 'insane'},
			{t: 'band.ready', ready: 'yes'},
			{t: 'band.bigRockEnding'},
			{t: 'band.bigRockEnding', enabled: 'no'},
			{t: 'band.result', result: {...RESULT, finaleBonus: 'big'}},
			{t: 'band.loaded'},
			{t: 'band.loaded', songId: 42},
			{t: 'band.result', result: {...RESULT, score: 'lots'}},
			{t: 'band.result', result: {...RESULT, part: 'kazoo'}},
			{t: 'band.rate', playerId: 'u1', stars: Number.POSITIVE_INFINITY},
		]) {
			expect(parseBandIntent(payload)).toBeNull();
		}
	});
});
