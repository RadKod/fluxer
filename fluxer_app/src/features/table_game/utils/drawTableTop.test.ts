// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	DAMA_START_BOARD,
	START_FEN,
	testChessGameView,
	testDamaGameView,
	testOkeyGameView,
	testTavlaGameView,
	testUnknownGameView,
	testView,
} from '@app/features/table_game/state/TableGameTestViews';
import {drawTableTop} from '@app/features/table_game/utils/drawTableTop';
import {describe, expect, it} from 'vitest';

interface Call {
	name: string;
	args: Array<unknown>;
	fillStyle: unknown;
}

function fakeCanvas() {
	const calls: Array<Call> = [];
	const context = new Proxy({fillStyle: '' as unknown} as Record<string, unknown>, {
		get(target, property: string) {
			if (property in target) return target[property];
			return (...args: Array<unknown>) => {
				calls.push({name: property, args, fillStyle: target.fillStyle});
			};
		},
		set(target, property: string, value) {
			target[property] = value;
			return true;
		},
	});
	const canvas = {width: 0, height: 0, getContext: () => context} as unknown as HTMLCanvasElement;
	return {canvas, calls, named: (name: string) => calls.filter((call) => call.name === name)};
}

describe('drawTableTop', () => {
	it('chess draws 64 squares and pieces', () => {
		const {canvas, named} = fakeCanvas();
		drawTableTop(canvas, testView({game: 'chess', gameView: testChessGameView({fen: START_FEN})}));
		expect([canvas.width, canvas.height]).toEqual([512, 512]);
		const squares = named('fillRect').filter((call) => call.args[2] === 64 && call.args[3] === 64);
		expect(squares).toHaveLength(64);
		expect(new Set(squares.map((call) => call.fillStyle)).size).toBe(2);
		const pieces = named('fillText');
		expect(pieces).toHaveLength(32);
		expect(pieces.filter((call) => call.args[0] === '♟')).toHaveLength(16);
		expect(new Set(pieces.map((call) => call.fillStyle)).size).toBe(2);
	});

	it("faces the white player's seat: white king on e1 at the bottom for position 1, at the top for position 3", () => {
		const kingAt = (white: 1 | 3) => {
			const {canvas, named} = fakeCanvas();
			drawTableTop(canvas, testView({game: 'chess', gameView: testChessGameView({fen: START_FEN, white})}));
			// Pieces are drawn from rank 8 down, so the second king drawn is the white one.
			const whiteKing = named('fillText').filter((call) => call.args[0] === '♚')[1]!;
			return whiteKing.args.slice(1, 3);
		};
		expect(kingAt(1)).toEqual([4 * 64 + 32, 7 * 64 + 32]);
		expect(kingAt(3)).toEqual([3 * 64 + 32, 32]);
	});

	it('okey draws indicator and discard tops', () => {
		const {canvas, named} = fakeCanvas();
		// t5 = yellow 6; discard tops t13 (blue 1) and t51 (red 13); position 3 has none.
		drawTableTop(
			canvas,
			testView({gameView: testOkeyGameView({indicator: 't5', discards: [['t0', 't13'], ['t51'], [], ['t104']]})}),
		);
		const texts = named('fillText').map((call) => call.args[0]);
		expect(texts).toContain('6');
		expect(texts).toContain('1');
		expect(texts).toContain('13');
		expect(texts).toContain('★');
		expect(texts).not.toContain('2');
		expect(texts).toContain('48');
	});

	it('null view clears', () => {
		const {canvas, named, calls} = fakeCanvas();
		drawTableTop(canvas, null);
		expect(named('clearRect')).toEqual([{name: 'clearRect', args: [0, 0, 512, 512], fillStyle: ''}]);
		expect(calls.filter((call) => call.name === 'fillText')).toHaveLength(0);
	});

	it('an unknown game kind (a newer build set it up) only clears and never throws', () => {
		const {canvas, calls} = fakeCanvas();
		expect(() => drawTableTop(canvas, testUnknownGameView())).not.toThrow();
		expect(calls.map((call) => call.name)).toEqual(['clearRect']);
	});

	it('dama draws pieces on the board: 64 squares, a disc per piece, kings ringed, white towards its seat', () => {
		const {canvas, named} = fakeCanvas();
		drawTableTop(canvas, testView({game: 'dama', gameView: testDamaGameView({board: DAMA_START_BOARD})}));
		const squares = named('fillRect').filter((call) => call.args[2] === 64 && call.args[3] === 64);
		expect(squares).toHaveLength(64);
		const discs = named('arc');
		expect(discs).toHaveLength(32);
		expect(named('fill').filter((call) => call.fillStyle === '#fbfaf7')).toHaveLength(16);
		expect(named('fill').filter((call) => call.fillStyle === '#17120d')).toHaveLength(16);

		// One white king on a1 and one black man on h8: the king gets a second (ring) arc.
		const board = `${'.'.repeat(7)}b${'.'.repeat(48)}W${'.'.repeat(7)}`;
		const at = (white: 1 | 3) => {
			const drawn = fakeCanvas();
			drawTableTop(
				drawn.canvas,
				testView({game: 'dama_normal', gameView: testDamaGameView({game: 'dama_normal', board, white})}),
			);
			return drawn.named('arc').map((call) => call.args.slice(0, 2));
		};
		expect(at(1)).toEqual([
			[7 * 64 + 32, 32],
			[32, 7 * 64 + 32],
			[32, 7 * 64 + 32],
		]);
		expect(at(3)).toEqual([
			[32, 7 * 64 + 32],
			[7 * 64 + 32, 32],
			[7 * 64 + 32, 32],
		]);
	});

	it('tavla draws checkers and dice', () => {
		const {canvas, named} = fakeCanvas();
		drawTableTop(canvas, testView({game: 'tavla', gameView: testTavlaGameView()}));
		expect(named('arc')).toHaveLength(30);
		expect(named('roundRect')).toHaveLength(0);

		const rolled = fakeCanvas();
		drawTableTop(rolled.canvas, testView({game: 'tavla', gameView: testTavlaGameView({dice: [6, 5]})}));
		// Two dice faces, 6 + 5 pips, on top of the same 30 checkers.
		expect(rolled.named('roundRect')).toHaveLength(2);
		expect(rolled.named('arc')).toHaveLength(30 + 11);
	});

	it("tavla stacks at most five checkers a point with a count, the bar in the middle, white's home towards its seat", () => {
		const points = Array<number>(24).fill(0);
		points[0] = 7;
		points[23] = -1;
		const draw = (white: 1 | 3) => {
			const drawn = fakeCanvas();
			drawTableTop(
				drawn.canvas,
				testView({
					game: 'tavla',
					gameView: testTavlaGameView({points, white, bar: {white: 1, black: 0}, off: {white: 7, black: 14}}),
				}),
			);
			return drawn;
		};
		const {named} = draw(1);
		const discs = named('arc');
		expect(discs).toHaveLength(5 + 1 + 1);
		expect(named('fillText').map((call) => call.args[0])).toContain('7');
		// Point 1 is bottom right for the white seat at the bottom; point 24 top right.
		const [x1, y1] = discs[0]!.args as [number, number];
		expect(x1).toBeGreaterThan(400);
		expect(y1).toBeGreaterThan(400);
		const flipped = draw(3).named('arc');
		const [fx, fy] = flipped[0]!.args as [number, number];
		expect(fx).toBeLessThan(112);
		expect(fy).toBeLessThan(112);
	});
});
