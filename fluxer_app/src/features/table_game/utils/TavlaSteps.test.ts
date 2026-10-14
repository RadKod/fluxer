// SPDX-License-Identifier: AGPL-3.0-or-later

import {completes, expandTavlaPlays, nextLegalSteps, type TavlaStep} from '@app/features/table_game/utils/TavlaSteps';
import type {TavlaView} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {describe, expect, it} from 'vitest';

const keys = (steps: ReadonlyArray<TavlaStep>) => steps.map((step) => `${step.from}/${step.to}`).sort();

// White on 24 (2), 13 (5), 8 (3), 6 (5); black's 15 checkers parked on point 1, out of white's way.
function tavlaView(overrides: Partial<TavlaView> = {}): TavlaView {
	const points = new Array<number>(24).fill(0);
	points[23] = 2;
	points[12] = 5;
	points[7] = 3;
	points[5] = 5;
	points[0] = -15;
	return {
		game: 'tavla',
		white: 1,
		points,
		bar: {white: 0, black: 0},
		off: {white: 0, black: 0},
		turn: 1,
		dice: [6, 5],
		opening: null,
		deadline_at: null,
		last_moves: [],
		legal_moves: ['24/19 19/13', '24/18 13/8', '13/7 13/8'],
		...overrides,
	};
}

describe('TavlaSteps', () => {
	const legal = ['24/18 13/8', '13/7 13/8', '24/19 19/13'];

	it('next legal steps are prefixes of legal sequences, in any order', () => {
		expect(keys(nextLegalSteps(legal, []))).toEqual(['13/7', '13/8', '19/13', '24/18', '24/19']);
		// 13/8 is the second step of '24/18 13/8': 24/18 is still offered after it.
		expect(keys(nextLegalSteps(legal, [{from: 13, to: 8}]))).toEqual(['13/7', '24/18']);
		expect(nextLegalSteps(legal, [{from: 6, to: 1}])).toEqual([]);
		expect(nextLegalSteps(null, [])).toEqual([]);
	});

	it('a completed maximal sequence is reported complete, whatever the order', () => {
		expect(
			completes(legal, [
				{from: 13, to: 8},
				{from: 24, to: 18},
			]),
		).toBe(true);
		expect(completes(legal, [{from: 24, to: 18}])).toBe(false);
		expect(completes([], [])).toBe(false);
		expect(completes(null, [{from: 24, to: 18}])).toBe(false);
	});

	it('doubles count each step: a step is offered as many times as the sequence holds it', () => {
		const doubles = ['24/18 24/18 13/7 13/7'];
		const one = [{from: 24, to: 18}];
		expect(keys(nextLegalSteps(doubles, one))).toEqual(['13/7', '24/18']);
		expect(keys(nextLegalSteps(doubles, [...one, ...one]))).toEqual(['13/7']);
		expect(completes(doubles, [{from: 13, to: 7}, ...one, {from: 13, to: 7}, ...one])).toBe(true);
	});

	it('undo pops one step: the earlier choices come back', () => {
		const first: Array<TavlaStep> = [{from: 24, to: 18}];
		const before = keys(nextLegalSteps(legal, first));
		const after = [...first, {from: 13, to: 8}];
		expect(keys(nextLegalSteps(legal, after.slice(0, -1)))).toEqual(before);
	});

	it('6-5 played as 24/18 18/13 is accepted when legal_moves lists 24/19 19/13', () => {
		const plays = expandTavlaPlays(tavlaView());
		expect(keys(nextLegalSteps(plays, [{from: 24, to: 18}]))).toContain('18/13');
		expect(
			completes(plays, [
				{from: 24, to: 18},
				{from: 18, to: 13},
			]),
		).toBe(true);
	});

	it("y' with an opponent blot is not added (that play hits: a different result, listed on its own)", () => {
		const blot = tavlaView();
		blot.points[17] = -1; // black blot on 18
		blot.points[0] = -14;
		expect(expandTavlaPlays({...blot, legal_moves: ['24/19 19/13']})).toEqual(['24/19 19/13']);
	});

	it('a chain that hits on its own middle point is not re-routed around the hit', () => {
		const blot = tavlaView();
		blot.points[17] = -1;
		blot.points[0] = -14;
		expect(expandTavlaPlays({...blot, legal_moves: ['24/18 18/13']})).toEqual(['24/18 18/13']);
	});

	it('a blocked middle point is not added', () => {
		const blocked = tavlaView();
		blocked.points[17] = -2;
		blocked.points[0] = -13;
		expect(expandTavlaPlays({...blocked, legal_moves: ['24/19 19/13']})).toEqual(['24/19 19/13']);
	});

	it('black and the bar: the other entry point is offered', () => {
		const points = new Array<number>(24).fill(0);
		points[23] = 15; // white parked on 24
		points[18] = -14;
		const view = tavlaView({
			white: 3,
			turn: 1,
			points,
			bar: {white: 0, black: 1},
			dice: [3, 5],
			legal_moves: ['bar/3 3/8'],
		});
		// Black enters on d: bar/5 with the 5, then 5/8 with the 3.
		expect(expandTavlaPlays(view)).toEqual(['bar/3 3/8', 'bar/5 5/8']);
	});

	it('doubles, single steps and bear-off chains are left as they are', () => {
		expect(expandTavlaPlays(tavlaView({dice: [6, 6], legal_moves: ['24/18 18/12 13/7 13/7']}))).toEqual([
			'24/18 18/12 13/7 13/7',
		]);
		expect(expandTavlaPlays(tavlaView({legal_moves: ['24/18']}))).toEqual(['24/18']);
		expect(expandTavlaPlays(tavlaView({legal_moves: ['8/2 2/off']}))).toEqual(['8/2 2/off']);
		expect(expandTavlaPlays(tavlaView({legal_moves: null}))).toEqual([]);
	});
});
