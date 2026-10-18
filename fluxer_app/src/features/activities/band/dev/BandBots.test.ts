// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandSongSummary, BandState} from '@app/features/activities/band/BandProtocol';
import {type BandBotChart, BandBots} from '@app/features/activities/band/dev/BandBots';
import {FakeActivitySession} from '@app/features/activities/band/dev/FakeActivitySession';
import type {ActivityMessage} from '@app/features/activities/session/ActivitySessionTypes';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const LATENCY_MS = 10;
const REACTION_MS = 500;

const SONG: BandSongSummary = {
	id: 'duman-bir-daha',
	name: 'Bir Daha',
	artist: 'Duman',
	lengthMs: 5_000,
	parts: {guitar: ['expert'], bass: ['expert'], drums: ['expert']},
	stems: true,
	coverUrl: null,
	packageUrl: 'http://127.0.0.1/duman-bir-daha.sng',
	packageBytes: 1,
	addedBy: null,
};

function setup(
	noteTimes: ReadonlyArray<number> | null = [1_000, 1_500, 2_000, 2_500],
	finale: BandBotChart['finale'] = null,
) {
	const session = new FakeActivitySession({
		activityId: 'band',
		myUserId: '100',
		localNow: () => Date.now(),
		latencyMs: LATENCY_MS,
	});
	const bots = new BandBots({
		session,
		songs: () => [SONG],
		chart: async () => (noteTimes ? {notes: noteTimes, finale} : null),
		random: () => 0.5,
	});
	const received: Array<ActivityMessage> = [];
	session.onMessage((message) => received.push(message));
	const payloads = () => received.map((message) => message.payload as {t: string});
	return {session, bots, received, payloads};
}

function selectState(seats: Extract<BandState, {phase: 'select'}>['seats']): BandState {
	return {
		phase: 'select',
		queue: [],
		songId: SONG.id,
		groupDifficulty: 'hard',
		seats,
		watching: [],
		endsAt: Date.now() + 20_000,
	};
}

describe('BandBots', () => {
	beforeEach(() => {
		vi.useFakeTimers({now: 1_700_000_000_000});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('votes for one of the candidates', () => {
		const {session, bots, received} = setup();
		const bot = bots.add({reactionMs: REACTION_MS});
		session.setState({phase: 'vote', queue: [], candidates: ['a', 'b'], votes: {}, openedAt: Date.now(), endsAt: null});
		vi.advanceTimersByTime(LATENCY_MS * 2 + REACTION_MS);
		expect(received.map((message) => message.payload)).toEqual([{t: 'band.vote', songId: 'b'}]);
		expect(received[0].from.userId).toBe(bot.userId);
	});

	it('claims its preferred free part, then readies once seated', () => {
		const {session, bots, payloads} = setup();
		const bot = bots.add({reactionMs: REACTION_MS, preferredParts: ['drums'], difficulty: 'expert'});
		session.setState(selectState([]));
		vi.advanceTimersByTime(LATENCY_MS * 2 + REACTION_MS);
		expect(payloads()).toEqual([
			{t: 'band.claimSeat', part: 'drums'},
			{t: 'band.difficulty', difficulty: 'expert'},
		]);

		session.setState(selectState([{part: 'drums', userId: bot.userId, difficulty: 'expert', ready: false}]));
		vi.advanceTimersByTime(LATENCY_MS * 2 + REACTION_MS);
		expect(payloads()).toHaveLength(2);
		// Alone in the seats it leaves room for a person to join, and readies five seconds before the phase ends.
		vi.advanceTimersByTime(15_000 + REACTION_MS);
		expect(payloads().at(-1)).toEqual({t: 'band.ready', ready: true});
	});

	it('readies as soon as the seated people are ready', () => {
		const {session, bots, payloads} = setup();
		const bot = bots.add({reactionMs: REACTION_MS});
		session.setState(
			selectState([
				{part: 'guitar', userId: '100', difficulty: 'hard', ready: false},
				{part: 'bass', userId: bot.userId, difficulty: 'hard', ready: false},
			]),
		);
		vi.advanceTimersByTime(LATENCY_MS * 2 + REACTION_MS);
		expect(payloads()).toEqual([]);
		session.setState(
			selectState([
				{part: 'guitar', userId: '100', difficulty: 'hard', ready: true},
				{part: 'bass', userId: bot.userId, difficulty: 'hard', ready: false},
			]),
		);
		vi.advanceTimersByTime(LATENCY_MS * 2 + REACTION_MS);
		expect(payloads()).toEqual([{t: 'band.ready', ready: true}]);
	});

	it('takes the next free part when its preferred one is taken', () => {
		const {session, bots, payloads} = setup();
		bots.add({reactionMs: REACTION_MS, preferredParts: ['guitar']});
		session.setState(selectState([{part: 'guitar', userId: '100', difficulty: 'hard', ready: false}]));
		vi.advanceTimersByTime(LATENCY_MS * 2 + REACTION_MS);
		expect(payloads()[0]).toEqual({t: 'band.claimSeat', part: 'bass'});
	});

	it('leaves the seats alone as a spectator', () => {
		const {session, bots, received} = setup();
		bots.add({role: 'spectator', reactionMs: REACTION_MS});
		session.setState(selectState([]));
		vi.advanceTimersByTime(LATENCY_MS * 2 + REACTION_MS);
		expect(received).toHaveLength(0);
	});

	it('plays each note at its time and reports the result to the leader', async () => {
		const {session, bots, received, payloads} = setup();
		const bot = bots.add({reactionMs: REACTION_MS, accuracy: 1});
		session.setState({
			phase: 'play',
			queue: [],
			songId: SONG.id,
			seats: [{part: 'bass', userId: bot.userId, difficulty: 'expert', ready: true}],
			startAt: Date.now() + 1_000,
		});
		await vi.advanceTimersByTimeAsync(1_000 + 1_500 + 100);
		const hits = received.filter((message) => (message.payload as {t: string}).t === 'band.hit');
		expect(hits.map((message) => message.payload)).toEqual([
			{t: 'band.hit', part: 'bass', noteIndex: 0, hit: true, combo: 1, multiplier: 1, starPower: false, score: 100},
			{t: 'band.hit', part: 'bass', noteIndex: 1, hit: true, combo: 2, multiplier: 1, starPower: false, score: 200},
		]);

		await vi.advanceTimersByTimeAsync(1_000 + 1_000 + REACTION_MS + LATENCY_MS);
		const result = payloads().find((payload) => payload.t === 'band.result');
		expect(result).toEqual({
			t: 'band.result',
			result: {
				part: 'bass',
				difficulty: 'expert',
				score: 400,
				rawScore: 200,
				accuracy: 1,
				bestStreak: 4,
				notesHit: 4,
				notesMissed: 0,
				starPowerUses: 0,
			},
		});
	});

	it('misses every note at zero accuracy and breaks the combo', async () => {
		const {session, bots, received} = setup([1_000, 1_100]);
		const bot = bots.add({accuracy: 0});
		session.setState({
			phase: 'play',
			queue: [],
			songId: SONG.id,
			seats: [{part: 'guitar', userId: bot.userId, difficulty: 'easy', ready: true}],
			startAt: Date.now(),
		});
		await vi.advanceTimersByTimeAsync(1_500);
		const hits = received.map((message) => message.payload as {t: string; hit?: boolean; combo?: number});
		expect(hits.filter((payload) => payload.t === 'band.hit').map(({hit, combo}) => ({hit, combo}))).toEqual([
			{hit: false, combo: 0},
			{hit: false, combo: 0},
		]);
	});

	it('free-plays the Big Rock Ending and banks it on the final hit', async () => {
		const {session, bots, payloads} = setup([500, 1_000, 1_500, 1_700], {startMs: 1_400, endMs: 2_000});
		const bot = bots.add({accuracy: 1, reactionMs: 0});
		session.setState({
			phase: 'play',
			queue: [],
			songId: SONG.id,
			seats: [{part: 'drums', userId: bot.userId, difficulty: 'expert', ready: true}],
			startAt: Date.now(),
		});
		await vi.advanceTimersByTimeAsync(2_000 + 1_000 + 200);
		const sent = payloads() as Array<{t: string; kind?: string; noteIndex?: number; bonus?: number; hit?: boolean}>;
		expect(sent.filter((payload) => payload.t === 'band.hit').map((payload) => payload.noteIndex)).toEqual([0, 1]);
		const presses = sent.filter((payload) => payload.t === 'band.finale' && payload.kind === 'press');
		expect(presses.length).toBeGreaterThanOrEqual(3);
		expect(presses.at(-1)?.bonus).toBe(presses.length * 50);
		expect(sent.find((payload) => payload.kind === 'final')).toMatchObject({hit: true, part: 'drums'});
		const result = sent.find((payload) => payload.t === 'band.result') as unknown as {result: {rawScore: number}};
		expect(result.result.rawScore).toBe(100 + presses.length * 25);
	});

	it('cheers as a spectator during the song', async () => {
		const {session, bots, payloads} = setup();
		bots.add({role: 'spectator', cheerEveryMs: 1_000});
		session.setState({phase: 'play', queue: [], songId: SONG.id, seats: [], startAt: Date.now()});
		await vi.advanceTimersByTimeAsync(LATENCY_MS * 2 + 3_000);
		expect(payloads().filter((payload) => payload.t === 'band.cheer').length).toBeGreaterThanOrEqual(2);
	});

	it('rates every other player once in the results', () => {
		const {session, bots, payloads} = setup();
		const bot = bots.add({reactionMs: REACTION_MS});
		const results: BandState = {
			phase: 'results',
			queue: [],
			songId: SONG.id,
			seats: [
				{part: 'guitar', userId: '100', difficulty: 'hard', ready: true},
				{part: 'bass', userId: bot.userId, difficulty: 'hard', ready: true},
			],
			results: [],
			ratings: {},
			endsAt: Date.now() + 25_000,
		};
		session.setState(results);
		session.setState({...results, ratings: {[bot.userId]: {'100': 4}}});
		vi.advanceTimersByTime(LATENCY_MS * 2 + REACTION_MS);
		expect(payloads()).toEqual([{t: 'band.rate', playerId: '100', stars: 4}]);
	});

	it('leaves the room when removed', () => {
		const {session, bots} = setup();
		const bot = bots.add();
		expect(session.participants).toHaveLength(2);
		bots.remove(bot);
		expect(session.participants).toHaveLength(1);
		expect(bots.bots).toHaveLength(0);
	});
});
