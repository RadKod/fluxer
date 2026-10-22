// SPDX-License-Identifier: AGPL-3.0-or-later

// The bots against the real leader: BandLeaderController and BandRoomMachine on the fake session, through a whole
// round from picking a song to the next pick.

import type {BandSongSummary, BandState} from '@app/features/activities/band/BandProtocol';
import {BandBots} from '@app/features/activities/band/dev/BandBots';
import {FakeActivitySession} from '@app/features/activities/band/dev/FakeActivitySession';
import {BandLeaderController} from '@app/features/activities/band/flow/BandLeaderController';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		debug = vi.fn();
		info = vi.fn();
		warn = vi.fn();
		error = vi.fn();
	},
}));

const SONG: BandSongSummary = {
	id: 'duman-bir-daha',
	name: 'Bir Daha',
	artist: 'Duman',
	lengthMs: 8_000,
	parts: {guitar: ['easy', 'expert'], bass: ['expert'], drums: ['expert']},
	stems: true,
	coverUrl: null,
	packageUrl: 'http://127.0.0.1/duman-bir-daha.sng',
	packageBytes: 1,
	addedBy: null,
	groups: [],
	genre: null,
	year: null,
	previewStartMs: null,
	key: null,
};
const NOTES = [500, 1_000, 1_500, 2_000, 2_500, 3_000];

describe('BandBots with the real leader', () => {
	beforeEach(() => {
		vi.useFakeTimers({now: 1_700_000_000_000});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('plays a full round: pick, seats, song, results, ratings, next pick', async () => {
		const session = new FakeActivitySession({
			activityId: 'band',
			myUserId: '100',
			localNow: () => Date.now(),
			latencyMs: 20,
		});
		const bots = new BandBots({
			session,
			songs: () => [SONG],
			chart: async () => ({notes: NOTES, finale: null}),
			random: Math.random,
		});
		const guitarist = bots.add({preferredParts: ['guitar'], accuracy: 1, reactionMs: 1_000});
		const drummer = bots.add({preferredParts: ['drums'], accuracy: 0.5, reactionMs: 1_000});
		bots.add({role: 'spectator', cheerEveryMs: 1_000, reactionMs: 1_000});
		const controller = new BandLeaderController(session, () => ({
			leaderId: session.leader?.userId ?? null,
			presentUserIds: new Set(session.participants.map((participant) => participant.userId)),
			songs: new Map([[SONG.id, SONG]]),
		}));
		const phases: Array<string> = [];
		session.onStateChanged((state) => {
			const phase = (state as BandState).phase;
			if (phases.at(-1) !== phase) phases.push(phase);
		});
		const cheers = vi.fn();
		session.onMessage(({payload}) => {
			if ((payload as {t: string}).t === 'band.cheer') cheers();
		});

		controller.start();
		const state = () => session.state as BandState;
		const advanceUntil = async (phase: BandState['phase'], maxMs: number) => {
			for (let waited = 0; state().phase !== phase && waited < maxMs; waited += 100) {
				await vi.advanceTimersByTimeAsync(100);
			}
			expect(state().phase).toBe(phase);
		};
		expect(state().phase).toBe('pick');

		// Both players claim early, then wait for each other until five seconds are left.
		await advanceUntil('select', 20_000);
		await vi.advanceTimersByTimeAsync(3_000);
		expect(state().phase).toBe('select');
		await advanceUntil('play', 20_000);
		const play = state() as Extract<BandState, {phase: 'play'}>;
		expect(play.seats.map(({part, userId}) => ({part, userId}))).toEqual([
			{part: 'guitar', userId: guitarist.userId},
			{part: 'drums', userId: drummer.userId},
		]);
		// The group default clamps to the nearest charted difficulty: guitar has easy, drums only expert.
		expect(play.seats.map((seat) => seat.difficulty)).toEqual(['easy', 'expert']);

		await advanceUntil('results', 4_000 + 3_000 + 4_000);
		const results = state() as Extract<BandState, {phase: 'results'}>;
		expect(cheers).toHaveBeenCalled();
		const guitar = results.results.find((result) => result.userId === guitarist.userId);
		expect(guitar).toMatchObject({notesHit: NOTES.length, notesMissed: 0, accuracy: 1, score: guitar!.rawScore});
		expect(results.results.find((result) => result.userId === drummer.userId)?.notesHit).toBeLessThanOrEqual(
			NOTES.length,
		);

		await vi.advanceTimersByTimeAsync(2_000);
		const rated = state() as Extract<BandState, {phase: 'results'}>;
		expect(rated.ratings[guitarist.userId]?.[drummer.userId]).toBeGreaterThanOrEqual(1);
		expect(rated.ratings[drummer.userId]?.[guitarist.userId]).toBeGreaterThanOrEqual(1);

		await advanceUntil('pick', 25_000);
		expect(phases).toEqual(['pick', 'select', 'play', 'results', 'pick']);

		controller.stop();
		bots.clear();
		session.dispose();
	});
});
