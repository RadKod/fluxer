// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	testDamaGameView,
	testTavlaGameView,
	testUnknownGameView,
	testView,
} from '@app/features/table_game/state/TableGameTestViews';
import {tableDeadlineAt} from '@app/features/table_game/utils/TableGameDeadline';
import {describe, expect, it} from 'vitest';

const NOW = Date.parse('2026-10-03T10:00:00.000Z');

describe('tableDeadlineAt', () => {
	it("dama clocks run like chess: the mover is the view's turn, never derived", () => {
		for (const game of ['dama', 'dama_normal'] as const) {
			const at = (turn: 1 | 3 | null, white: 1 | 3) =>
				tableDeadlineAt(
					testView({
						game,
						gameView: testDamaGameView({
							game,
							white,
							turn,
							clocks_ms: {white: 50_000, black: 7000},
							turn_started_at: new Date(NOW).toISOString(),
						}),
					}),
				);
			expect(at(1, 1)).toBe(NOW + 50_000);
			expect(at(3, 1)).toBe(NOW + 7000);
			expect(at(1, 3)).toBe(NOW + 7000);
			expect(at(null, 1)).toBeNull();
		}
	});

	it('a dama game whose clock has not started has no deadline', () => {
		expect(tableDeadlineAt(testView({game: 'dama', gameView: testDamaGameView({turn_started_at: null})}))).toBeNull();
	});

	it("tavla's deadline is the turn's deadline_at", () => {
		const deadline = new Date(NOW + 40_000).toISOString();
		expect(tableDeadlineAt(testView({game: 'tavla', gameView: testTavlaGameView({deadline_at: deadline})}))).toBe(
			NOW + 40_000,
		);
		expect(tableDeadlineAt(testView({game: 'tavla', gameView: testTavlaGameView({deadline_at: null})}))).toBeNull();
	});

	it('an unknown game kind has no deadline and never throws', () => {
		expect(tableDeadlineAt(testUnknownGameView())).toBeNull();
	});
});
