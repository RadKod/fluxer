// SPDX-License-Identifier: AGPL-3.0-or-later

// Test-only builders of server payloads; every value here would parse with the strict TableGameSchemas.
import {TABLE_GAME_POSITIONS} from '@fluxer/constants/src/TableGameConstants';
import type {
	ChessView,
	DamaNormalView,
	DamaView,
	OkeyView,
	TableGameKind,
	TableGamePlayer,
	TableGameSummary,
	TableGameView,
	TavlaView,
} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';

export const ME_ID = '100';

export function testPlayer(position: number, userId = String(100 + position - 1)): TableGamePlayer {
	return {position, user_id: userId, connected: true, timeouts: 0};
}

export function testSummary(overrides: Partial<TableGameSummary> = {}): TableGameSummary {
	return {
		slot: 'T01',
		game: 'okey',
		speed: 'normal',
		status: 'playing',
		players: [1, 2, 3, 4].map((position) => testPlayer(position)),
		spectator_count: 0,
		version: 1,
		result: null,
		...overrides,
	};
}

export function testOkeyGameView(overrides: Partial<OkeyView> = {}): OkeyView {
	return {
		game: 'okey',
		indicator: 't5',
		pile_count: 48,
		discards: [[], [], [], []],
		rack_counts: [14, 14, 14, 14],
		turn: 1,
		phase: 'draw',
		deadline_at: null,
		rack: null,
		...overrides,
	};
}

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export function testChessGameView(overrides: Partial<ChessView> = {}): ChessView {
	return {
		game: 'chess',
		fen: START_FEN,
		white: 1,
		clocks_ms: {white: 600_000, black: 600_000},
		turn_started_at: null,
		last_move: null,
		legal_moves: null,
		in_check: false,
		...overrides,
	};
}

// Türk daması start: white men on ranks 2-3, black on 6-7 (rows a8..h8 first).
export const DAMA_START_BOARD = `${'.'.repeat(8)}${'b'.repeat(16)}${'.'.repeat(16)}${'w'.repeat(16)}${'.'.repeat(8)}`;

export function testDamaGameView(
	overrides: Partial<Omit<DamaView, 'game'>> & {game?: 'dama' | 'dama_normal'} = {},
): DamaView | DamaNormalView {
	return {
		game: 'dama',
		board: DAMA_START_BOARD,
		white: 1,
		turn: 1,
		clocks_ms: {white: 600_000, black: 600_000},
		turn_started_at: null,
		last_move: null,
		last_captured: [],
		legal_moves: null,
		...overrides,
	};
}

// Standard tavla start from white's side: index 0 is point 1, positive white, negative black.
export function testTavlaPoints(): Array<number> {
	const points = Array<number>(24).fill(0);
	points[23] = 2;
	points[12] = 5;
	points[7] = 3;
	points[5] = 5;
	points[0] = -2;
	points[11] = -5;
	points[16] = -3;
	points[18] = -5;
	return points;
}

export function testTavlaGameView(overrides: Partial<TavlaView> = {}): TavlaView {
	return {
		game: 'tavla',
		white: 1,
		points: testTavlaPoints(),
		bar: {white: 0, black: 0},
		off: {white: 0, black: 0},
		turn: 1,
		dice: null,
		opening: null,
		deadline_at: null,
		last_moves: [],
		legal_moves: null,
		...overrides,
	};
}

function defaultGameView(game: TableGameKind): NonNullable<TableGameView['game_view']> {
	switch (game) {
		case 'chess':
			return testChessGameView();
		case 'dama':
		case 'dama_normal':
			return testDamaGameView({game});
		case 'tavla':
			return testTavlaGameView();
		default:
			return testOkeyGameView();
	}
}

// The one exception to the rule above: a kind only a newer build knows, as an older tab receives it.
export const UNKNOWN_GAME = 'dama_tr' as TableGameKind;

export function testUnknownGameView(
	status: TableGameSummary['status'] = 'playing',
	summary: Partial<TableGameSummary> = {},
): TableGameView {
	return testView({
		game: UNKNOWN_GAME,
		status,
		gameView:
			status === 'lobby'
				? null
				: ({game: UNKNOWN_GAME, board: 'x', turn: 1, deadline_at: null} as unknown as TableGameView['game_view']),
		summary: {players: [testPlayer(1, '71'), testPlayer(3, '73')], ...summary},
	});
}

export function testView(
	options: {
		game?: TableGameKind;
		version?: number;
		status?: TableGameSummary['status'];
		viewerPosition?: number | null;
		spectating?: boolean;
		gameView?: TableGameView['game_view'];
		summary?: Partial<TableGameSummary>;
	} = {},
): TableGameView {
	const game = options.game ?? 'okey';
	const status = options.status ?? 'playing';
	const players = (TABLE_GAME_POSITIONS[game] ?? [1, 2, 3, 4]).map((p) => testPlayer(p));
	const gameView = status === 'lobby' ? null : defaultGameView(game);
	return {
		summary: testSummary({game, status, players, version: options.version ?? 1, ...options.summary}),
		game_view: options.gameView === undefined ? gameView : options.gameView,
		viewer_position: options.viewerPosition === undefined ? 1 : options.viewerPosition,
		spectating: options.spectating ?? false,
	};
}
