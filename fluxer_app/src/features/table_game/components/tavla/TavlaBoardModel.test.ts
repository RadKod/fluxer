// SPDX-License-Identifier: AGPL-3.0-or-later

import {tavlaBoardModel} from '@app/features/table_game/components/tavla/TavlaBoardModel';
import type {TavlaView} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {describe, expect, it} from 'vitest';

export function tavlaView(overrides: Partial<TavlaView> = {}): TavlaView {
	const points = Array<number>(24).fill(0);
	points[23] = 2;
	points[0] = -2;
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
		legal_moves: ['24/19 19/13'],
		...overrides,
	};
}

describe('tavlaBoardModel', () => {
	it('24 points, bar, off from the view; my home bottom-right', () => {
		const view = tavlaView({bar: {white: 2, black: 1}, off: {white: 3, black: 4}});
		const white = tavlaBoardModel(view, 1, []);
		expect(white.points).toEqual(view.points);
		expect(white.bar).toEqual(view.bar);
		expect(white.off).toEqual(view.off);
		expect(white.order).toEqual([
			13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1,
		]);
		expect(tavlaBoardModel(view, 3, []).order.slice(18)).toEqual([19, 20, 21, 22, 23, 24]);
		expect(new Set(white.order).size).toBe(24);
	});
	it('previews entry, hits and bearing off without mutating the view', () => {
		const view = tavlaView({bar: {white: 1, black: 0}});
		view.points[21] = -1;
		const result = tavlaBoardModel(view, 1, [
			{from: 'bar', to: 22},
			{from: 22, to: 'off'},
		]);
		expect(result.bar).toEqual({white: 0, black: 1});
		expect(result.off).toEqual({white: 1, black: 0});
		expect(result.points[21]).toBe(0);
		expect(view.points[21]).toBe(-1);
		expect(view.bar.white).toBe(1);
	});
	it('previews black steps using absolute point numbers', () => {
		const view = tavlaView({turn: 3});
		view.points[5] = 1;
		const result = tavlaBoardModel(view, 3, [{from: 1, to: 6}]);
		expect(result.points[0]).toBe(-1);
		expect(result.points[5]).toBe(-1);
		expect(result.bar.white).toBe(1);
	});
});
