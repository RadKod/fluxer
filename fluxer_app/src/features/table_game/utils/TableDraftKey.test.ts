// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	DAMA_START_BOARD,
	testChessGameView,
	testDamaGameView,
	testOkeyGameView,
	testTavlaGameView,
	testTavlaPoints,
	testUnknownGameView,
	testView,
} from '@app/features/table_game/state/TableGameTestViews';
import {tableDraftKey} from '@app/features/table_game/utils/TableDraftKey';
import type {Okey101View, TableGameView} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {describe, expect, it} from 'vitest';

type GameView = NonNullable<TableGameView['game_view']>;

const at = (version: number, gameView: GameView, status: 'playing' | 'ended' = 'playing') =>
	testView({game: gameView.game, version, status, gameView});

const okey101 = (overrides: Partial<Okey101View> = {}): Okey101View => ({
	...testOkeyGameView({phase: 'play', rack: ['t0', 't1', 't2', 't9']}),
	game: 'okey101',
	melds: [],
	opened: ['none', 'none', 'none', 'none'],
	penalties: [0, 0, 0, 0],
	scores: null,
	...overrides,
});

// A white man from a3 (index 40) to a4 (index 32).
const DAMA_MOVED = `${DAMA_START_BOARD.slice(0, 32)}w${DAMA_START_BOARD.slice(33, 40)}.${DAMA_START_BOARD.slice(41)}`;

const moved = testTavlaPoints();
moved[23] = 1;
moved[17] = 1;

describe('tableDraftKey', () => {
	it.each<[string, GameView, GameView]>([
		[
			'okey: a draw',
			testOkeyGameView({rack: ['t0', 't1']}),
			testOkeyGameView({phase: 'discard', pile_count: 47, rack: ['t0', 't1', 't7']}),
		],
		['101: opening sets', okey101(), okey101({rack: ['t9'], opened: ['sets', 'none', 'none', 'none']})],
		['101: the turn passing with the same rack', okey101(), okey101({turn: 2, discards: [['t9'], [], [], []]})],
		[
			'tavla: a played turn',
			testTavlaGameView({dice: [6, 5]}),
			testTavlaGameView({turn: 3, dice: [2, 1], points: moved, last_moves: [{from: 24, to: 18, hit: false}]}),
		],
		[
			'tavla: my turn back with equal dice (the opponent passed)',
			testTavlaGameView({dice: [6, 5]}),
			testTavlaGameView({dice: [6, 5], points: moved, last_moves: [{from: 24, to: 18, hit: false}]}),
		],
		['dama: a move', testDamaGameView(), testDamaGameView({turn: 3, board: DAMA_MOVED})],
		[
			'chess: a move',
			testChessGameView(),
			testChessGameView({fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1'}),
		],
	])(
		'%s changes the key; the same position at a newer version (the presence check) keeps it',
		(_name, before, after) => {
			expect(tableDraftKey(at(8, before))).toBe(tableDraftKey(at(7, before)));
			expect(tableDraftKey(at(8, after))).not.toBe(tableDraftKey(at(7, before)));
		},
	);

	it('the end of the game changes it, even on an unchanged board (a resign)', () => {
		const board = testChessGameView();
		expect(tableDraftKey(at(8, board, 'ended'))).not.toBe(tableDraftKey(at(7, board)));
	});

	it('a new turn on an identical position changes it (its turn clock)', () => {
		const first = testDamaGameView({turn_started_at: '2026-10-03T10:00:00.000Z'});
		const rematch = testDamaGameView({turn_started_at: '2026-10-03T10:20:00.000Z'});
		expect(tableDraftKey(at(9, rematch))).not.toBe(tableDraftKey(at(7, first)));
	});

	it('a kind this build does not know falls back to the version', () => {
		const view = testUnknownGameView();
		const newer = {...view, summary: {...view.summary, version: view.summary.version + 1}};
		expect(tableDraftKey(newer)).not.toBe(tableDraftKey(view));
		expect(tableDraftKey({...view})).toBe(tableDraftKey(view));
	});
});
