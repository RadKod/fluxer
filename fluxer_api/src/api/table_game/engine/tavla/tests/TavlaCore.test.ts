// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	legalSequences,
	playSequence,
	sequenceKey,
	startingBoard,
	type TavlaBoard,
	type TavlaSide,
} from '@app/api/table_game/engine/tavla/TavlaCore';
import {describe, expect, it} from 'vitest';

type Counts = Readonly<Record<number, number>>;

// Absolute points; black counts are given positive.
function board(spec: {
	white?: Counts;
	black?: Counts;
	bar?: Partial<Record<TavlaSide, number>>;
	off?: Partial<Record<TavlaSide, number>>;
}): TavlaBoard {
	const points = new Array<number>(24).fill(0);
	for (const [point, count] of Object.entries(spec.white ?? {})) points[Number(point) - 1] = count;
	for (const [point, count] of Object.entries(spec.black ?? {})) points[Number(point) - 1] = -count;
	return {
		points,
		bar: {white: spec.bar?.white ?? 0, black: spec.bar?.black ?? 0},
		off: {white: spec.off?.white ?? 0, black: spec.off?.black ?? 0},
	};
}

function checkers(b: TavlaBoard, side: TavlaSide): number {
	const sign = side === 'white' ? 1 : -1;
	return b.points.reduce((sum, count) => sum + Math.max(0, count * sign), 0) + b.bar[side] + b.off[side];
}

const resultOf = (b: TavlaBoard, side: TavlaSide, key: string) => JSON.stringify(playSequence(b, side, key).board);

// Rel = the mover's own numbering (bar 25, off 0), in which every canonical sequence is non-increasing.
function relFroms(side: TavlaSide, key: string): Array<number> {
	return key.split(' ').map((step) => {
		const from = step.split('/')[0]!;
		if (from === 'bar') return 25;
		return side === 'white' ? Number(from) : 25 - Number(from);
	});
}

describe('TavlaCore', () => {
	it('standard setup 2/5/3/5 mirrored', () => {
		const start = startingBoard();
		expect(start).toEqual(board({white: {24: 2, 13: 5, 8: 3, 6: 5}, black: {1: 2, 12: 5, 17: 3, 19: 5}}));
		expect(checkers(start, 'white')).toBe(15);
		expect(checkers(start, 'black')).toBe(15);
	});

	it('doubles give four moves', () => {
		const plays = legalSequences(startingBoard(), 'white', [3, 3]);
		expect(plays.sequences.length).toBeGreaterThan(0);
		for (const key of plays.sequences) expect(key.split(' ')).toHaveLength(4);
		expect(plays.accepted.has('8/5 8/5 6/3 6/3')).toBe(true);
		expect(plays.accepted.has('8/5 6/3')).toBe(false);
	});

	it('must use both dice when possible; else the larger', () => {
		const start = legalSequences(startingBoard(), 'white', [6, 5]);
		for (const key of start.sequences) expect(key.split(' ')).toHaveLength(2);
		expect(start.accepted.has('24/18')).toBe(false);

		// One runner on 13, the rest stuck on 1; black holds 2 so neither die can follow the other.
		const either = board({white: {13: 1, 1: 14}, black: {2: 2, 20: 13}});
		const larger = legalSequences(either, 'white', [5, 6]);
		expect(larger.sequences).toEqual(['13/7']);
		expect(larger.accepted.has('13/8')).toBe(false);

		// Black also holds 7: the 6 cannot be played at all, so the smaller die is.
		const onlySmaller = board({white: {13: 1, 1: 14}, black: {2: 2, 7: 2, 20: 11}});
		expect(legalSequences(onlySmaller, 'white', [6, 5]).sequences).toEqual(['13/8']);
	});

	it('bar first; entering on the opponent home board; blocked entry passes the turn', () => {
		const hit = board({white: {24: 1, 13: 5, 8: 3, 6: 5}, black: {1: 2, 12: 5, 17: 3, 19: 5}, bar: {white: 1}});
		const plays = legalSequences(hit, 'white', [6, 3]);
		// 6 enters on 19, black's five-stack: only the 3 enters (on 22), then the 6 moves anything.
		expect(plays.sequences.length).toBeGreaterThan(0);
		for (const key of plays.sequences) {
			expect(key.startsWith('bar/22 ')).toBe(true);
			expect(key).not.toContain('bar/19');
		}

		const blackHit = board({white: {6: 5, 8: 3, 13: 5, 24: 2}, black: {1: 1, 12: 5, 17: 3, 19: 5}, bar: {black: 1}});
		// Black enters with die d on point d (white's home); 6 is white's five-stack.
		for (const key of legalSequences(blackHit, 'black', [6, 2]).sequences) expect(key.startsWith('bar/2 ')).toBe(true);

		const closed = board({
			white: {6: 5, 8: 3, 13: 6},
			black: {19: 3, 20: 2, 21: 2, 22: 2, 23: 2, 24: 2, 1: 2},
			bar: {white: 1},
		});
		for (const dice of [
			[6, 6],
			[1, 2],
			[5, 3],
		] as const) {
			const blocked = legalSequences(closed, 'white', dice);
			expect(blocked.sequences).toEqual([]);
			expect(blocked.accepted.size).toBe(0);
		}
	});

	it('hit sends a blot to the bar', () => {
		const b = board({white: {13: 2, 6: 13}, black: {10: 1, 1: 14}});
		const played = playSequence(b, 'white', '13/10');
		expect(played.moves).toEqual([{from: 13, to: 10, hit: true}]);
		expect(played.board.points[9]).toBe(1);
		expect(played.board.bar).toEqual({white: 0, black: 1});
		expect(checkers(played.board, 'black')).toBe(15);

		const backward = board({white: {15: 1, 6: 14}, black: {12: 2, 1: 13}});
		const blackHits = playSequence(backward, 'black', '12/15');
		expect(blackHits.moves).toEqual([{from: 12, to: 15, hit: true}]);
		expect(blackHits.board.points[14]).toBe(-1);
		expect(blackHits.board.bar).toEqual({white: 1, black: 0});

		expect(playSequence(b, 'white', '13/7').moves).toEqual([{from: 13, to: 7, hit: false}]);
	});

	it('bear off only with all checkers home; higher die removes the farthest', () => {
		// 7 is outside home: 2/off needs the 1 to bring it in first and the 2 to bear off exactly.
		const almost = legalSequences(board({white: {7: 1, 2: 1}, black: {24: 15}, off: {white: 13}}), 'white', [2, 1]);
		expect(almost.accepted.has('7/6 2/off')).toBe(true);
		expect(almost.accepted.has('7/5 2/off')).toBe(false);

		const high = legalSequences(board({white: {4: 1, 2: 1}, black: {24: 15}, off: {white: 13}}), 'white', [6, 5]);
		expect(high.sequences).toEqual(['4/off 2/off']);

		// A higher die bears off only the farthest checker: with 5 occupied the 4 cannot take the 3 off.
		const notFarthest = legalSequences(
			board({white: {5: 1, 3: 1}, black: {24: 15}, off: {white: 13}}),
			'white',
			[4, 1],
		);
		expect(notFarthest.accepted.has('5/4 3/off')).toBe(false);
		expect(notFarthest.sequences).toEqual(['5/4 4/off', '5/1 3/2']);

		// Same with doubles: the 5 has to move first.
		const farthest = legalSequences(board({white: {5: 1, 3: 1}, black: {24: 15}, off: {white: 13}}), 'white', [4, 4]);
		expect(farthest.sequences).toEqual(['5/1 3/off 1/off']);

		// Black bears off from 19–24; the farther checker (21) goes first.
		const blackHome = board({black: {21: 1, 23: 1}, white: {1: 15}, off: {black: 13}});
		expect(legalSequences(blackHome, 'black', [6, 5]).sequences).toEqual(['21/off 23/off']);

		const homeless = legalSequences(board({white: {8: 1, 3: 14}, black: {24: 15}}), 'white', [3, 3]);
		expect(homeless.sequences.length).toBeGreaterThan(0);
		for (const key of homeless.sequences) expect(key.split(' ')[0]).toBe('8/5');
	});

	it('bearing off with the exact die is optional; playing inside home is legal too (D5)', () => {
		const home = legalSequences(board({white: {6: 1, 4: 1}, black: {24: 15}, off: {white: 13}}), 'white', [4, 1]);
		// The 4 may take the 4 off or carry the 6 to 2; 6/2 2/1 lands where 6/5 5/1 does.
		expect(home.sequences).toEqual(['6/5 5/1', '6/5 4/off', '6/2 4/3']);
		expect(home.accepted.has('6/2 2/1')).toBe(true);
		expect(home.accepted.has('6/2 4/3')).toBe(true);
	});

	it('legal sequences are canonical (from descending) and deduplicated by result', () => {
		expect(
			sequenceKey('white', [
				{from: 13, to: 7},
				{from: 24, to: 18},
			]),
		).toBe('24/18 13/7');
		expect(
			sequenceKey('black', [
				{from: 12, to: 18},
				{from: 'bar', to: 3},
			]),
		).toBe('bar/3 12/18');

		for (const side of ['white', 'black'] as const) {
			for (const dice of [
				[6, 5],
				[2, 2],
				[4, 1],
			] as const) {
				const start = startingBoard();
				const plays = legalSequences(start, side, dice);
				const results = plays.sequences.map((key) => resultOf(start, side, key));
				expect(new Set(results).size).toBe(results.length);
				for (const key of plays.sequences) {
					expect(plays.accepted.has(key)).toBe(true);
					const froms = relFroms(side, key);
					expect(froms).toEqual([...froms].sort((a, b) => b - a));
				}
				const reachable = new Set([...plays.accepted].map((key) => resultOf(start, side, key)));
				expect(reachable).toEqual(new Set(results));
			}
		}

		const sixFive = legalSequences(startingBoard(), 'white', [6, 5]);
		expect(sixFive.accepted.has('24/18 18/13')).toBe(true);
		expect(sixFive.accepted.has('24/19 19/13')).toBe(false); // 19 is black's five-stack
		// 13/8 8/2 and 13/7 7/2 reach the same board: both are accepted, one is listed.
		expect(sixFive.accepted.has('13/8 8/2')).toBe(true);
		expect(sixFive.accepted.has('13/7 7/2')).toBe(true);
		expect(sixFive.sequences).toContain('13/8 8/2');
		expect(sixFive.sequences).not.toContain('13/7 7/2');
		// Farthest first: the timeout play is the first sequence.
		expect(sixFive.sequences[0]).toBe('24/18 18/13');
	});
});
