// SPDX-License-Identifier: AGPL-3.0-or-later

import {noteGroup, partChart} from '@app/features/activities/band/engine/BandTestFixtures';
import {
	CHORD_SLOP_MS,
	DIFFICULTY_SCORE_MULTIPLIER,
	HIT_WINDOWS_MS,
	Judge,
	type JudgeEvent,
	MISS_SETTLE_MS,
	multiplierForStreak,
	NOTE_POINTS,
	ratingForOffset,
	SUSTAIN_POINTS_PER_SECOND,
} from '@app/features/activities/band/engine/Judge';
import {describe, expect, it} from 'vitest';

const beats = (count: number, lane = 0) => Array.from({length: count}, (_, i) => noteGroup(1000 + i * 500, [lane]));

// Presses `lanes` at `timeMs`, lets the chord slop pass and returns everything that produced.
function strike(judge: Judge, lanes: ReadonlyArray<number>, timeMs: number): Array<JudgeEvent> {
	return [...lanes.flatMap((lane) => judge.press(lane, timeMs)), ...judge.advance(timeMs + CHORD_SLOP_MS + 1)];
}

// Presses and releases `lanes` at `timeMs`, like a quick tap.
function tap(judge: Judge, lanes: ReadonlyArray<number>, timeMs: number): Array<JudgeEvent> {
	const events = lanes.flatMap((lane) => judge.press(lane, timeMs));
	events.push(...lanes.flatMap((lane) => judge.release(lane, timeMs + 5)));
	events.push(...judge.advance(timeMs + CHORD_SLOP_MS + 1));
	return events;
}

const kinds = (events: ReadonlyArray<JudgeEvent>) => events.map((event) => event.kind);

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
		const events = [...tap(judge, [0], 1000), ...tap(judge, [0], 1550), ...tap(judge, [0], 1910)];
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
		const hits = beats(12).flatMap((group) => tap(judge, [0], group.msTime));
		expect(hits.map((event) => (event.kind === 'hit' ? event.multiplier : 0))).toEqual([
			1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2,
		]);
		expect(judge.snapshot.score).toBe(10 * NOTE_POINTS + 2 * 2 * NOTE_POINTS);
	});

	it('marks unplayed notes as missed only after the window and settle time pass', () => {
		const judge = new Judge(partChart(beats(2)));
		tap(judge, [0], 1000);
		expect(judge.advance(1500 + HIT_WINDOWS_MS.ok + MISS_SETTLE_MS)).toEqual([]);
		expect(judge.advance(1500 + HIT_WINDOWS_MS.ok + MISS_SETTLE_MS + 1)).toEqual([
			{kind: 'miss', groupIndex: 1, timeMs: 1500},
		]);
		expect(judge.snapshot).toMatchObject({combo: 0, maxCombo: 1, misses: 1, judgedGroups: 2});
	});

	it('still accepts a press that arrives after the frame advanced past its window edge', () => {
		const judge = new Judge(partChart(beats(1)));
		judge.advance(1000 + HIT_WINDOWS_MS.ok + 20);
		expect(strike(judge, [0], 1000 + HIT_WINDOWS_MS.ok)).toMatchObject([{kind: 'hit', rating: 'ok'}]);
	});

	it('does not miss a note that is waiting out its slop at the edge of its window', () => {
		const judge = new Judge(partChart(beats(1)));
		const pressMs = 1000 + HIT_WINDOWS_MS.ok;
		judge.press(0, pressMs);
		expect(judge.release(0, pressMs + CHORD_SLOP_MS)).toEqual([]);
		expect(judge.advance(pressMs + CHORD_SLOP_MS + 1)).toMatchObject([{kind: 'hit', rating: 'ok'}]);
	});

	it('misses earlier notes before judging a later press, so the combo order is right', () => {
		const judge = new Judge(partChart(beats(2)));
		expect(kinds(strike(judge, [0], 1500))).toEqual(['miss', 'hit']);
		expect(judge.snapshot.combo).toBe(1);
	});

	it('needs every lane of a chord inside the window and rates by the worst lane', () => {
		const judge = new Judge(partChart([noteGroup(1000, [0, 2]), noteGroup(2000, [1, 3])]));
		expect(judge.press(0, 990)).toEqual([]);
		expect(strike(judge, [2], 1060)).toMatchObject([{kind: 'hit', rating: 'good', offsetMs: 60, points: 160}]);
		judge.release(0, 1100);
		judge.release(2, 1100);
		judge.press(1, 2000);
		expect(judge.finish()).toEqual([{kind: 'miss', groupIndex: 1, timeMs: 2000}]);
	});

	it('hits the earliest open note on a lane when windows overlap', () => {
		const judge = new Judge(partChart([noteGroup(1000, [0]), noteGroup(1080, [0])]));
		expect(tap(judge, [0], 1060)).toMatchObject([{kind: 'hit', groupIndex: 0}]);
		expect(tap(judge, [0], 1075)).toMatchObject([{kind: 'hit', groupIndex: 1}]);
	});

	it('only counts a hit once the slop has passed', () => {
		const judge = new Judge(partChart(beats(1)));
		expect(judge.press(0, 1000)).toEqual([]);
		expect(judge.advance(1000 + CHORD_SLOP_MS)).toEqual([]);
		expect(judge.advance(1000 + CHORD_SLOP_MS + 1)).toMatchObject([{kind: 'hit', timeMs: 1000, offsetMs: 0}]);
	});

	describe('chords need exactly their own keys', () => {
		const chord = () => new Judge(partChart([noteGroup(900, [3]), noteGroup(1000, [0, 1])]));
		const afterIntro = (judge: Judge) => tap(judge, [3], 900);

		it('rejects a two-note chord played with all four keys, keeps the note open and breaks the combo', () => {
			const judge = chord();
			afterIntro(judge);
			const events = strike(judge, [0, 1, 2, 3], 1000);
			expect(events).toEqual([{kind: 'overhit', lane: 2, timeMs: 1000, comboBroken: true}]);
			expect(judge.snapshot).toMatchObject({combo: 0, misses: 0, judgedGroups: 1, overhits: 1});
		});

		it('rejects the chord in any key order', () => {
			for (const order of [
				[0, 1, 2],
				[2, 0, 1],
				[0, 2, 1],
			]) {
				const judge = chord();
				afterIntro(judge);
				expect(kinds(strike(judge, order, 1000))).not.toContain('hit');
			}
		});

		it('rejects a stray key pressed within the slop after the chord', () => {
			const judge = chord();
			afterIntro(judge);
			judge.press(0, 1000);
			judge.press(1, 1000);
			expect(judge.press(2, 1000 + CHORD_SLOP_MS)).toEqual([]);
			expect(judge.advance(1000 + CHORD_SLOP_MS + 1)).toEqual([
				{kind: 'overhit', lane: 2, timeMs: 1000, comboBroken: true},
			]);
		});

		it('lets the rejected chord be played again with the right keys inside its window', () => {
			const judge = chord();
			afterIntro(judge);
			strike(judge, [0, 1, 2], 1000);
			for (const lane of [0, 1, 2]) judge.release(lane, 1030);
			expect(strike(judge, [0, 1], 1040)).toMatchObject([{kind: 'hit', groupIndex: 1, combo: 1}]);
		});

		it('misses a rejected chord nobody fixed once its window passes', () => {
			const judge = chord();
			afterIntro(judge);
			strike(judge, [0, 1, 2], 1000);
			expect(judge.finish()).toEqual([{kind: 'miss', groupIndex: 1, timeMs: 1000}]);
		});

		it('counts the chord when a stray key is let go within one frame of it', () => {
			const judge = chord();
			afterIntro(judge);
			judge.press(2, 995);
			judge.press(0, 1000);
			judge.press(1, 1000);
			judge.release(2, 1000 + CHORD_SLOP_MS);
			expect(judge.advance(1000 + CHORD_SLOP_MS + 1)).toMatchObject([{kind: 'hit', groupIndex: 1}]);
		});

		it('rejects a stray key let go later than that', () => {
			const judge = chord();
			afterIntro(judge);
			judge.press(2, 995);
			judge.press(0, 1000);
			judge.press(1, 1000);
			expect(judge.release(2, 1000 + CHORD_SLOP_MS + 1)).toMatchObject([{kind: 'overhit', lane: 2}]);
		});

		it('rejects a single note played with a stray key down', () => {
			const judge = new Judge(partChart(beats(2)));
			tap(judge, [0], 1000);
			judge.press(4, 1400);
			expect(kinds(strike(judge, [0], 1500))).toEqual(['overhit']);
			expect(judge.snapshot).toMatchObject({combo: 0, overhits: 2});
		});

		it('allows a key still down from the note before, which was spent on that note', () => {
			const judge = new Judge(partChart([noteGroup(1000, [0]), noteGroup(1100, [1]), noteGroup(1200, [0, 1])]));
			expect(strike(judge, [0], 1000)).toMatchObject([{kind: 'hit'}]);
			expect(strike(judge, [1], 1100)).toMatchObject([{kind: 'hit', combo: 2}]);
			judge.release(0, 1150);
			judge.release(1, 1150);
			expect(strike(judge, [0, 1], 1200)).toMatchObject([{kind: 'hit', combo: 3}]);
		});

		it('allows the key of a sustain still ringing under the next note', () => {
			const judge = new Judge(partChart([noteGroup(1000, [0], {msLength: 1000}), noteGroup(1500, [2])]));
			strike(judge, [0], 1000);
			expect(strike(judge, [2], 1500)).toMatchObject([{kind: 'hit', groupIndex: 1}]);
		});

		it('does not let held stray keys play the next chord', () => {
			const judge = chord();
			afterIntro(judge);
			// Every key held down, then only the chord's keys pressed again.
			strike(judge, [0, 1, 2, 3], 960);
			judge.release(0, 990);
			judge.release(1, 990);
			expect(kinds(strike(judge, [0, 1], 1000))).toEqual(['overhit']);
		});
	});

	describe('overhits', () => {
		it('treats stray fret presses as overstrums that break the combo and use up no note', () => {
			const judge = new Judge(partChart(beats(2)));
			tap(judge, [0], 1000);
			expect(judge.press(1, 1200)).toEqual([{kind: 'overhit', lane: 1, timeMs: 1200, comboBroken: true}]);
			judge.release(1, 1210);
			expect(judge.press(0, 1300)).toEqual([{kind: 'overhit', lane: 0, timeMs: 1300, comboBroken: false}]);
			judge.release(0, 1310);
			expect(tap(judge, [0], 1500)).toMatchObject([{kind: 'hit', groupIndex: 1}]);
			expect(judge.snapshot).toMatchObject({combo: 1, overhits: 2, misses: 0});
		});

		it('breaks the drum combo on a pad hit with no note', () => {
			const judge = new Judge(partChart(beats(2), 'drums'));
			expect(judge.press(0, 1000)).toMatchObject([{kind: 'hit', combo: 1}]);
			expect(judge.press(3, 1200)).toEqual([{kind: 'overhit', lane: 3, timeMs: 1200, comboBroken: true}]);
			expect(judge.snapshot).toMatchObject({combo: 0, overhits: 1});
		});

		it('scores drums at once and does not care which other pads are down', () => {
			const judge = new Judge(partChart([noteGroup(1000, [0, 1]), noteGroup(1200, [2])], 'drums'));
			judge.press(0, 1000);
			expect(judge.press(1, 1000)).toMatchObject([{kind: 'hit', groupIndex: 0}]);
			expect(judge.press(2, 1200)).toMatchObject([{kind: 'hit', groupIndex: 1, combo: 2}]);
		});

		it('breaks the drum combo when an extra pad joins a pad chord', () => {
			const judge = new Judge(partChart([noteGroup(1000, [0, 1])], 'drums'));
			const events = [...judge.press(0, 1000), ...judge.press(1, 1000), ...judge.press(3, 1002)];
			expect(kinds(events)).toEqual(['hit', 'overhit']);
			expect(judge.snapshot.combo).toBe(0);
		});
	});

	describe('sustains', () => {
		const sustained = partChart([noteGroup(1000, [0, 1], {msLength: 1000})], 'guitar', 'medium');
		const fullSustainPoints = Math.round(SUSTAIN_POINTS_PER_SECOND * 2 * 1 * DIFFICULTY_SCORE_MULTIPLIER.medium);

		it('pays for the whole sustain when held to the end', () => {
			const judge = new Judge(sustained);
			judge.press(0, 1000);
			judge.press(1, 1000);
			expect(judge.advance(2000 + MISS_SETTLE_MS)).toEqual([
				expect.objectContaining({kind: 'hit'}),
				{kind: 'sustain', groupIndex: 0, timeMs: 2000, heldMs: 1000, points: fullSustainPoints, complete: true},
			]);
		});

		it('pays for the held part when released early', () => {
			const judge = new Judge(sustained);
			strike(judge, [0, 1], 1000);
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
			strike(judge, [0, 1], 1000);
			expect(judge.release(0, 1950)).toMatchObject([{kind: 'sustain', heldMs: 1000, complete: true}]);
		});

		it('starts counting from a late press, and not at all if a lane was let go before the chord counted', () => {
			const late = new Judge(sustained);
			late.press(0, 1080);
			late.press(1, 1080);
			expect(late.finish()).toMatchObject([{kind: 'hit'}, {kind: 'sustain', heldMs: 920}]);

			const dropped = new Judge(sustained);
			dropped.press(0, 1000);
			dropped.release(0, 1010);
			expect(strike(dropped, [1], 1020)).toMatchObject([{kind: 'hit'}]);
			expect(dropped.finish()).toEqual([]);
		});
	});

	it('is deterministic for the same input sequence', () => {
		const run = () => {
			const judge = new Judge(partChart(beats(20), 'guitar', 'expert'));
			const events = beats(20).flatMap((group, i) =>
				tap(judge, [i % 3 === 0 ? 1 : 0], group.msTime + ((i * 37) % 120) - 60),
			);
			return {events: [...events, ...judge.finish()], snapshot: judge.snapshot};
		};
		expect(run()).toEqual(run());
	});
});
