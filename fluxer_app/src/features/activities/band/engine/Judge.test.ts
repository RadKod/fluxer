// SPDX-License-Identifier: AGPL-3.0-or-later

import {noteGroup, partChart} from '@app/features/activities/band/engine/BandTestFixtures';
import {
	DIFFICULTY_SCORE_MULTIPLIER,
	HIT_WINDOWS_MS,
	Judge,
	MISS_SETTLE_MS,
	multiplierForStreak,
	NOTE_POINTS,
	ratingForOffset,
	SUSTAIN_POINTS_PER_SECOND,
} from '@app/features/activities/band/engine/Judge';
import {describe, expect, it} from 'vitest';

const beats = (count: number, lane = 0) => Array.from({length: count}, (_, i) => noteGroup(1000 + i * 500, [lane]));

describe('ratingForOffset', () => {
	it.each([
		[0, 'perfect'],
		[-35, 'perfect'],
		[36, 'good'],
		[-70, 'good'],
		[100, 'ok'],
		[-101, null],
	] as const)('rates %d ms as %s', (offset, rating) => {
		expect(ratingForOffset(offset)).toBe(rating);
	});
});

describe('multiplierForStreak', () => {
	it('steps up every ten hits and stops at four', () => {
		expect([0, 9, 10, 19, 20, 30, 1000].map(multiplierForStreak)).toEqual([1, 1, 2, 2, 3, 4, 4]);
	});
});

describe('Judge', () => {
	it('scores hits by rating and difficulty multiplier', () => {
		const judge = new Judge(partChart(beats(3), 'guitar', 'hard'));
		const events = [
			...judge.press(0, 1000),
			...judge.release(0, 1010),
			...judge.press(0, 1550),
			...judge.press(0, 1910),
		];
		expect(events.filter((event) => event.kind === 'hit')).toMatchObject([
			{groupIndex: 0, rating: 'perfect', offsetMs: 0, points: 75, combo: 1, multiplier: 1},
			{groupIndex: 1, rating: 'good', offsetMs: 50, points: 60, combo: 2},
			{groupIndex: 2, rating: 'ok', offsetMs: -90, points: 38, combo: 3},
		]);
		expect(DIFFICULTY_SCORE_MULTIPLIER.hard * NOTE_POINTS).toBe(75);
		expect(judge.snapshot).toMatchObject({
			score: 173,
			combo: 3,
			maxCombo: 3,
			ratings: {perfect: 1, good: 1, ok: 1},
			judgedGroups: 3,
			totalGroups: 3,
		});
	});

	it('raises the multiplier after every ten consecutive hits', () => {
		const judge = new Judge(partChart(beats(12), 'guitar', 'easy'));
		const hits = beats(12).flatMap((group) => judge.press(0, group.msTime));
		expect(hits.map((event) => (event.kind === 'hit' ? event.multiplier : 0))).toEqual([
			1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2,
		]);
		expect(judge.snapshot.score).toBe(10 * NOTE_POINTS + 2 * 2 * NOTE_POINTS);
	});

	it('marks unplayed notes as missed only after the window and settle time pass', () => {
		const judge = new Judge(partChart(beats(2)));
		judge.press(0, 1000);
		expect(judge.advance(1500 + HIT_WINDOWS_MS.ok + MISS_SETTLE_MS)).toEqual([]);
		expect(judge.advance(1500 + HIT_WINDOWS_MS.ok + MISS_SETTLE_MS + 1)).toEqual([
			{kind: 'miss', groupIndex: 1, timeMs: 1500},
		]);
		expect(judge.snapshot).toMatchObject({combo: 0, maxCombo: 1, misses: 1, judgedGroups: 2});
	});

	it('still accepts a press that arrives after the frame advanced past its window edge', () => {
		const judge = new Judge(partChart(beats(1)));
		judge.advance(1000 + HIT_WINDOWS_MS.ok + 20);
		expect(judge.press(0, 1000 + HIT_WINDOWS_MS.ok)).toMatchObject([{kind: 'hit', rating: 'ok'}]);
	});

	it('misses earlier notes before judging a later press, so the combo order is right', () => {
		const judge = new Judge(partChart(beats(2)));
		const events = judge.press(0, 1500);
		expect(events.map((event) => event.kind)).toEqual(['miss', 'hit']);
		expect(judge.snapshot.combo).toBe(1);
	});

	it('needs every lane of a chord inside the window and rates by the worst lane', () => {
		const judge = new Judge(partChart([noteGroup(1000, [0, 2]), noteGroup(2000, [1, 3])]));
		expect(judge.press(0, 990)).toEqual([]);
		expect(judge.press(2, 1060)).toMatchObject([{kind: 'hit', rating: 'good', offsetMs: 60, points: 160}]);
		judge.press(1, 2000);
		expect(judge.finish()).toEqual([{kind: 'miss', groupIndex: 1, timeMs: 2000}]);
	});

	it('hits the earliest open note on a lane when windows overlap', () => {
		const judge = new Judge(partChart([noteGroup(1000, [0]), noteGroup(1080, [0])]));
		expect(judge.press(0, 1060)).toMatchObject([{kind: 'hit', groupIndex: 0}]);
		expect(judge.press(0, 1075)).toMatchObject([{kind: 'hit', groupIndex: 1}]);
	});

	it('treats stray fret presses as overstrums that break the combo', () => {
		const judge = new Judge(partChart(beats(2)));
		judge.press(0, 1000);
		expect(judge.press(1, 1200)).toEqual([{kind: 'overhit', lane: 1, timeMs: 1200, comboBroken: true}]);
		expect(judge.press(0, 1300)).toEqual([{kind: 'overhit', lane: 0, timeMs: 1300, comboBroken: false}]);
		expect(judge.snapshot).toMatchObject({combo: 0, overhits: 2});
	});

	it('lets drummers flail without losing the combo', () => {
		const judge = new Judge(partChart(beats(2), 'drums'));
		judge.press(0, 1000);
		expect(judge.press(3, 1200)).toEqual([{kind: 'overhit', lane: 3, timeMs: 1200, comboBroken: false}]);
		expect(judge.snapshot.combo).toBe(1);
		expect(new Judge(partChart(beats(1), 'drums'), {overhitBreaksCombo: true}).press(1, 0)).toMatchObject([
			{kind: 'overhit'},
		]);
	});

	describe('sustains', () => {
		const sustained = partChart([noteGroup(1000, [0, 1], {msLength: 1000})], 'guitar', 'medium');
		const fullSustainPoints = Math.round(SUSTAIN_POINTS_PER_SECOND * 2 * 1 * DIFFICULTY_SCORE_MULTIPLIER.medium);

		it('pays for the whole sustain when held to the end', () => {
			const judge = new Judge(sustained);
			judge.press(0, 1000);
			judge.press(1, 1000);
			expect(judge.advance(2000 + MISS_SETTLE_MS)).toEqual([
				{kind: 'sustain', groupIndex: 0, timeMs: 2000, heldMs: 1000, points: fullSustainPoints, complete: true},
			]);
		});

		it('pays for the held part when released early', () => {
			const judge = new Judge(sustained);
			judge.press(0, 1000);
			judge.press(1, 1000);
			expect(judge.release(1, 1500)).toEqual([
				{
					kind: 'sustain',
					groupIndex: 0,
					timeMs: 1500,
					heldMs: 500,
					points: Math.round(fullSustainPoints / 2),
					complete: false,
				},
			]);
			expect(judge.finish()).toEqual([]);
		});

		it('forgives letting go just before the end', () => {
			const judge = new Judge(sustained);
			judge.press(0, 1000);
			judge.press(1, 1000);
			expect(judge.release(0, 1950)).toMatchObject([{kind: 'sustain', heldMs: 1000, complete: true}]);
		});

		it('starts counting from a late press, and not at all if a lane was let go before the chord completed', () => {
			const late = new Judge(sustained);
			late.press(0, 1080);
			late.press(1, 1080);
			expect(late.finish()).toMatchObject([{kind: 'sustain', heldMs: 920}]);

			const dropped = new Judge(sustained);
			dropped.press(0, 1000);
			dropped.release(0, 1010);
			expect(dropped.press(1, 1020)).toMatchObject([{kind: 'hit'}]);
			expect(dropped.finish()).toEqual([]);
		});
	});

	it('is deterministic for the same input sequence', () => {
		const run = () => {
			const judge = new Judge(partChart(beats(20), 'guitar', 'expert'));
			const events = beats(20).flatMap((group, i) => judge.press(0, group.msTime + ((i * 37) % 120) - 60));
			return {events: [...events, ...judge.finish()], snapshot: judge.snapshot};
		};
		expect(run()).toEqual(run());
	});
});
