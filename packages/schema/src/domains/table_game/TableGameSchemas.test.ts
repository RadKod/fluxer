// SPDX-License-Identifier: AGPL-3.0-or-later

import {DAMA_LEGAL_PATHS_MAX} from '@fluxer/constants/src/TableGameConstants';
import {
	ChessView,
	CreateTableGameRequest,
	DamaNormalView,
	DamaView,
	OkeyView,
	TableGameActionRequest,
	TableGameListResponse,
	TableGameResult,
	TableGameRuleReason,
	TableGameSpectateResponse,
	TableGameUpdateEvent,
	TableGameView,
	TavlaView,
	TileToken,
} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {describe, expect, test} from 'vitest';
import type {z} from 'zod';

const okeyView = {
	game: 'okey',
	indicator: 't5',
	pile_count: 48,
	discards: [['t1'], [], ['t2', 't3'], []],
	rack_counts: [14, 14, 14, 15],
	turn: 4,
	phase: 'discard',
	deadline_at: '2026-10-03T03:00:00.000Z',
	rack: ['t10', 't104'],
};

const okey101View = {
	...okeyView,
	game: 'okey101',
	melds: [{id: 0, owner: 1, kind: 'run', tiles: ['t1', 't2', 't3']}],
	opened: ['sets', 'none', 'none', 'pairs'],
	penalties: [0, 101, 0, 0],
	scores: null,
};

const chessView = {
	game: 'chess',
	fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
	white: 1,
	clocks_ms: {white: 600_000, black: 600_000},
	turn_started_at: null,
	last_move: 'e2e4',
	legal_moves: ['e7e5'],
	in_check: false,
};

const START_DAMA = `${'.'.repeat(8)}${'b'.repeat(16)}${'.'.repeat(16)}${'w'.repeat(16)}${'.'.repeat(8)}`;

const damaView = {
	game: 'dama',
	board: START_DAMA,
	white: 3,
	turn: 3,
	clocks_ms: {white: 600_000, black: 600_000},
	turn_started_at: '2026-10-03T03:00:00.000Z',
	last_move: ['c3', 'c5', 'e5'],
	last_captured: ['c4', 'd5'],
	legal_moves: ['a3-a4', 'c3-c5-e5'],
};

const tavlaView = {
	game: 'tavla',
	white: 1,
	points: [-2, 0, 0, 0, 0, 5, 0, 3, 0, 0, 0, -5, 5, 0, 0, 0, -3, 0, -5, 0, 0, 0, 0, 2],
	bar: {white: 0, black: 0},
	off: {white: 0, black: 0},
	turn: 1,
	dice: [6, 1],
	opening: [6, 1],
	deadline_at: '2026-10-03T03:00:40.000Z',
	last_moves: [
		{from: 'bar', to: 20, hit: true},
		{from: 6, to: 'off', hit: false},
	],
	legal_moves: ['24/18 13/12', '13/7 8/7'],
};

function tableView(gameView: object | null, result: object | null = null, game = 'okey101') {
	return {
		summary: {
			slot: 'T01',
			game,
			speed: 'normal',
			status: result ? 'ended' : 'playing',
			players: [{position: 1, user_id: '1000000000000000001', connected: true, timeouts: 0}],
			spectator_count: 0,
			version: 3,
			result,
		},
		game_view: gameView,
		viewer_position: 1,
		spectating: false,
	};
}

// Every plain object inside the sample, as the path that reaches it.
function objectPaths(value: unknown, path: Array<string | number> = []): Array<Array<string | number>> {
	if (Array.isArray(value)) return value.flatMap((item, index) => objectPaths(item, [...path, index]));
	if (value === null || typeof value !== 'object') return [];
	return [path, ...Object.entries(value).flatMap(([key, child]) => objectPaths(child, [...path, key]))];
}

function withExtraField(value: unknown, path: Array<string | number>): unknown {
	const copy = structuredClone(value) as Record<string | number, unknown>;
	let target: Record<string | number, unknown> = copy;
	for (const key of path) target = target[key] as Record<string | number, unknown>;
	target.leaked = 't7';
	return copy;
}

function expectStrictEverywhere(schema: z.ZodType, sample: unknown) {
	expect(schema.safeParse(sample).success).toBe(true);
	const paths = objectPaths(sample);
	expect(paths.length).toBeGreaterThan(1);
	for (const path of paths) {
		expect(schema.safeParse(withExtraField(sample, path)).success, `extra field at ${path.join('.')}`).toBe(false);
	}
}

describe('table game schemas', () => {
	test('rejects unknown action type', () => {
		expect(TableGameActionRequest.safeParse({version: 0, action: {type: 'peek'}}).success).toBe(false);
		expect(TableGameActionRequest.safeParse({version: 0, action: {type: 'tick'}}).success).toBe(true);
		expect(TableGameActionRequest.safeParse({version: -1, action: {type: 'tick'}}).success).toBe(false);
		expect(TableGameActionRequest.safeParse({version: 2, action: {type: 'move', from: 'e2', to: 'e9'}}).success).toBe(
			false,
		);
	});

	test('TileToken bounds', () => {
		for (const token of ['t0', 't9', 't10', 't99', 't100', 't105'])
			expect(TileToken.safeParse(token).success).toBe(true);
		for (const token of ['t106', 't01', 't', 'T1', 't-1', 't1000', '5']) {
			expect(TileToken.safeParse(token).success).toBe(false);
		}
	});

	test('view rack is nullable and absent racks are null', () => {
		expect(OkeyView.safeParse({...okeyView, rack: null}).success).toBe(true);
		expect(OkeyView.safeParse(okeyView).success).toBe(true);
		const {rack: _rack, ...withoutRack} = okeyView;
		expect(OkeyView.safeParse(withoutRack).success).toBe(false);
		expect(TableGameView.safeParse(tableView(null)).success).toBe(true);
	});

	test('rule violation reason enum is closed', () => {
		expect(TableGameRuleReason.options).toEqual([
			'not_your_turn',
			'wrong_phase',
			'tile_not_in_rack',
			'invalid_meld',
			'open_too_low',
			'pairs_too_few',
			'take_unused',
			'not_opened',
			'cannot_add',
			'illegal_move',
			'game_over',
			'unsupported_action',
			'must_finish_with_discard',
		]);
		expect(TableGameRuleReason.safeParse('tile t5 is not yours').success).toBe(false);
	});

	test('view schema rejects an unknown field at every depth', () => {
		const ended = {kind: 'win', winners: [1], reason: 'finish', finish: 'normal'};
		expectStrictEverywhere(TableGameView, tableView(okeyView));
		expectStrictEverywhere(TableGameView, tableView(okey101View, ended));
		expectStrictEverywhere(TableGameView, tableView(chessView, {kind: 'draw', reason: 'stalemate'}));
		expectStrictEverywhere(TableGameUpdateEvent, {
			channel_id: '1000000000000000002',
			guild_id: '1000000000000000003',
			slot: 'T01',
			view: tableView(okey101View),
		});
		expectStrictEverywhere(TableGameSpectateResponse, {subscribed: true, view: tableView(chessView)});
		expectStrictEverywhere(TableGameListResponse, {
			tables: [tableView(null, {kind: 'forfeit', loser: 2, reason: 'leave'}).summary],
		});
	});

	test('dama_move path 2..17 squares', () => {
		const path = (n: number) => Array.from({length: n}, (_, i) => `${'abcdefgh'[i % 8]}${(i % 8) + 1}`);
		const act = (action: object) => TableGameActionRequest.safeParse({version: 1, action}).success;
		expect(act({type: 'dama_move', path: path(2)})).toBe(true);
		expect(act({type: 'dama_move', path: path(17)})).toBe(true);
		expect(act({type: 'dama_move', path: path(1)})).toBe(false);
		expect(act({type: 'dama_move', path: path(18)})).toBe(false);
		expect(act({type: 'dama_move', path: ['c3', 'c9']})).toBe(false);
		expect(act({type: 'dama_move'})).toBe(false);
	});

	test('tavla_move 1..4 steps, bar only as from, off only as to', () => {
		const act = (moves: unknown) =>
			TableGameActionRequest.safeParse({version: 1, action: {type: 'tavla_move', moves}}).success;
		expect(act([{from: 24, to: 18}])).toBe(true);
		expect(
			act([
				{from: 'bar', to: 20},
				{from: 6, to: 'off'},
				{from: 1, to: 2},
				{from: 12, to: 24},
			]),
		).toBe(true);
		expect(act([])).toBe(false);
		expect(act(Array.from({length: 5}, () => ({from: 24, to: 18})))).toBe(false);
		for (const step of [
			{from: 'off', to: 18},
			{from: 24, to: 'bar'},
			{from: 0, to: 18},
			{from: 25, to: 18},
			{from: 24, to: 0},
			{from: 1.5, to: 3},
			{from: 24},
		]) {
			expect(act([step]), JSON.stringify(step)).toBe(false);
		}
	});

	test('dama/tavla views are deep strict (unknown nested field rejected)', () => {
		expectStrictEverywhere(TableGameView, tableView(damaView, null, 'dama'));
		expectStrictEverywhere(TableGameView, tableView({...damaView, game: 'dama_normal'}, null, 'dama_normal'));
		expectStrictEverywhere(
			TableGameView,
			tableView(tavlaView, {kind: 'win', winners: [1], reason: 'bear_off', finish: 'mars'}, 'tavla'),
		);
		expect(DamaNormalView.safeParse({...damaView, game: 'dama_normal'}).success).toBe(true);
		expect(DamaView.safeParse({...damaView, board: `${START_DAMA.slice(1)}x`}).success).toBe(false);
		expect(DamaView.safeParse({...damaView, board: START_DAMA.slice(1)}).success).toBe(false);
		expect(TavlaView.safeParse({...tavlaView, points: tavlaView.points.slice(1)}).success).toBe(false);
		expect(TavlaView.safeParse({...tavlaView, points: [16, ...tavlaView.points.slice(1)]}).success).toBe(false);
	});

	test('dama view requires turn (1|3|null)', () => {
		expect(DamaView.safeParse({...damaView, turn: 1}).success).toBe(true);
		expect(DamaView.safeParse({...damaView, turn: null}).success).toBe(true);
		for (const turn of [2, 4, 0, '1']) expect(DamaView.safeParse({...damaView, turn}).success).toBe(false);
		const {turn: _turn, ...withoutTurn} = damaView;
		expect(DamaView.safeParse(withoutTurn).success).toBe(false);
	});

	test('dama view legal_moves capped at DAMA_LEGAL_PATHS_MAX', () => {
		const paths = (n: number) => Array.from({length: n}, () => 'c3-c5-e5');
		expect(DamaView.safeParse({...damaView, legal_moves: paths(DAMA_LEGAL_PATHS_MAX)}).success).toBe(true);
		expect(DamaView.safeParse({...damaView, legal_moves: paths(DAMA_LEGAL_PATHS_MAX + 1)}).success).toBe(false);
	});

	test('tavla view dice null or two dice 1..6', () => {
		for (const dice of [null, [1, 1], [6, 5]]) {
			expect(TavlaView.safeParse({...tavlaView, dice, opening: dice}).success).toBe(true);
		}
		for (const dice of [[0, 1], [7, 1], [3], [1, 2, 3], [1.5, 2]]) {
			expect(TavlaView.safeParse({...tavlaView, dice}).success).toBe(false);
			expect(TavlaView.safeParse({...tavlaView, opening: dice}).success).toBe(false);
		}
		const {dice: _dice, ...withoutDice} = tavlaView;
		expect(TavlaView.safeParse(withoutDice).success).toBe(false);
	});

	test('chess view requires in_check', () => {
		expect(ChessView.safeParse({...chessView, in_check: true}).success).toBe(true);
		const {in_check: _inCheck, ...withoutCheck} = chessView;
		expect(ChessView.safeParse(withoutCheck).success).toBe(false);
		expect(ChessView.safeParse({...chessView, in_check: 'no'}).success).toBe(false);
	});

	test('rule violation reasons unchanged', () => {
		expect(TableGameRuleReason.options).toHaveLength(13);
		for (const reason of ['illegal_move', 'wrong_phase', 'not_your_turn', 'game_over', 'unsupported_action']) {
			expect(TableGameRuleReason.safeParse(reason).success).toBe(true);
		}
	});

	test('new kinds and result reasons parse', () => {
		for (const game of ['dama', 'dama_normal', 'tavla']) {
			expect(CreateTableGameRequest.safeParse({game, speed: 'fast', connection_id: 'c'}).success).toBe(true);
		}
		for (const result of [
			{kind: 'win', winners: [1], reason: 'bear_off'},
			{kind: 'win', winners: [3], reason: 'bear_off', finish: 'mars'},
			{kind: 'win', winners: [1], reason: 'no_pieces'},
			{kind: 'win', winners: [3], reason: 'blocked'},
			{kind: 'draw', reason: 'move_limit'},
			{kind: 'draw', reason: 'lone_kings'},
		]) {
			expect(TableGameResult.safeParse(result).success, JSON.stringify(result)).toBe(true);
		}
	});
});
