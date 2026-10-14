// SPDX-License-Identifier: AGPL-3.0-or-later

import type {OkeyStage} from '@app/features/table_game/components/okey/Okey101Staging';
import type {RackSlot} from '@app/features/table_game/state/TableGames';
import type {TableDropInput} from '@app/features/table_game/utils/TableDrop';
import type {TavlaStep} from '@app/features/table_game/utils/TavlaSteps';
import type {TableDragSource, TableDropTarget} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {TABLE_GAME_POSITIONS} from '@fluxer/constants/src/TableGameConstants';
import type {
	ChessView,
	DamaView,
	Okey101View,
	OkeyView,
	TableGameSummary,
	TableGameView,
	TavlaView,
} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {describe, expect, it, vi} from 'vitest';

// The resolver is pure: it never sends. The caller sends the one action it returns, on drop only.
vi.mock('@app/features/table_game/commands/TableGameCommands', () => ({act: vi.fn()}));

const TableGameCommands = await import('@app/features/table_game/commands/TableGameCommands');
const {resolveTableDrop, legalTargets} = await import('@app/features/table_game/utils/TableDrop');

type GameView = NonNullable<TableGameView['game_view']>;

function tableView(gameView: GameView, options: {status?: TableGameSummary['status']; me?: number | null} = {}) {
	const summary: TableGameSummary = {
		slot: 'T01',
		game: gameView.game,
		speed: 'normal',
		status: options.status ?? 'playing',
		players: TABLE_GAME_POSITIONS[gameView.game].map((position) => ({
			position,
			user_id: String(100 + position),
			connected: true,
			timeouts: 0,
		})),
		spectator_count: 0,
		version: 7,
		result: null,
	};
	const me = options.me === undefined ? 1 : options.me;
	return {summary, game_view: gameView, viewer_position: me, spectating: me === null} satisfies TableGameView;
}

// My rack (position 1). Indicator t5 is yellow 6. t0 t1 t2 yellow 1-3; t13 t14 blue 1-2; t30 black 5.
const RACK = ['t0', 't1', 't2', 't13', 't14', 't30'];
const ORDER: ReadonlyArray<RackSlot> = ['t0', 't1', 't2', null, 't13', 't14', null, 't30'];

function okeyView(overrides: Partial<OkeyView> = {}): OkeyView {
	return {
		game: 'okey',
		indicator: 't5',
		pile_count: 48,
		// Position 4 sits on my left: its last discard is the one I may take.
		discards: [[], [], [], ['t40']],
		rack_counts: [6, 14, 14, 14],
		turn: 1,
		phase: 'draw',
		deadline_at: null,
		rack: RACK,
		...overrides,
	};
}

const MELD = {id: 2, owner: 2, kind: 'run' as const, tiles: ['t16', 't17', 't18']};

function okey101View(overrides: Partial<Okey101View> = {}): Okey101View {
	return {
		...okeyView(),
		game: 'okey101',
		melds: [MELD],
		opened: ['none', 'sets', 'none', 'none'],
		penalties: [0, 0, 0, 0],
		scores: null,
		...overrides,
	};
}

function input(
	view: TableGameView,
	source: TableDragSource,
	target: TableDropTarget,
	extra: Partial<TableDropInput> = {},
): TableDropInput {
	return {
		view,
		me: view.viewer_position as 1 | 2 | 3 | 4 | null,
		rack: ORDER,
		stage: null,
		tavlaSteps: [],
		source,
		target,
		...extra,
	};
}

const drop = (...args: Parameters<typeof input>) => resolveTableDrop(input(...args));
const tile = (token: string): TableDragSource => ({kind: 'rack_tile', tile: token, cell: ORDER.indexOf(token)});
const cell = (index: number): TableDropTarget => ({kind: 'rack_cell', cell: index});

describe('resolveTableDrop — okey and 101', () => {
	it.each(['okey', 'okey101'] as const)('%s: rack_tile → rack_cell rearranges locally, even off turn', (game) => {
		const gameView = game === 'okey' ? okeyView({turn: 3}) : okey101View({turn: 3});
		expect(drop(tableView(gameView), tile('t30'), cell(3))).toEqual({
			kind: 'rack',
			order: ['t0', 't1', 't2', 't30', 't13', 't14'],
		});
		// Onto a tile: the two swap.
		expect(drop(tableView(gameView), tile('t0'), cell(2))).toEqual({
			kind: 'rack',
			order: ['t2', 't1', 't0', null, 't13', 't14', null, 't30'],
		});
	});

	it.each(['okey', 'okey101'] as const)('%s: pile → rack on my draw turn draws from the pile', (game) => {
		const gameView = game === 'okey' ? okeyView() : okey101View();
		expect(drop(tableView(gameView), {kind: 'pile'}, cell(9))).toEqual({
			kind: 'action',
			action: {type: 'draw', from: 'pile'},
		});
		expect(drop(tableView(gameView), {kind: 'pile'}, {kind: 'discard_zone'})).toEqual({
			kind: 'none',
			reason: 'illegal',
		});
	});

	it('okey: discard_top of my left → rack draws from the discard; another position is illegal', () => {
		expect(drop(tableView(okeyView()), {kind: 'discard_top', position: 4}, cell(9))).toEqual({
			kind: 'action',
			action: {type: 'draw', from: 'discard'},
		});
		expect(drop(tableView(okeyView()), {kind: 'discard_top', position: 2}, cell(9))).toEqual({
			kind: 'none',
			reason: 'illegal',
		});
	});

	it('101: discard_top of my left → rack stages the take with the set it lands in', () => {
		// Dropped right after t13 t14 (cell 6): the take completes that set.
		const rack: Array<RackSlot> = ['t0', 't1', 't2', null, 't13', 't14', null, null, 't30'];
		const outcome = drop(
			tableView(okey101View({discards: [[], [], [], ['t15']]})),
			{kind: 'discard_top', position: 4},
			cell(6),
			{rack},
		);
		expect(outcome).toEqual({kind: 'stage', stage: {take: 't15', open: [['t13', 't14', 't15']], add: []}});
		// Dropped on a lone cell: only the take is staged.
		expect(drop(tableView(okey101View()), {kind: 'discard_top', position: 4}, cell(20))).toEqual({
			kind: 'stage',
			stage: {take: 't40', open: [], add: []},
		});
	});

	it('101: discard_top → meld_zone stages the take; → meld_end stages it as an addition (opened only)', () => {
		const opened = okey101View({opened: ['sets', 'sets', 'none', 'none'], discards: [[], [], [], ['t19']]});
		expect(drop(tableView(opened), {kind: 'discard_top', position: 4}, {kind: 'meld_zone'})).toEqual({
			kind: 'stage',
			stage: {take: 't19', open: [], add: []},
		});
		expect(
			drop(tableView(opened), {kind: 'discard_top', position: 4}, {kind: 'meld_end', meldId: 2, at: 'end'}),
		).toEqual({kind: 'stage', stage: {take: 't19', open: [], add: [{meld_id: 2, tiles: ['t19'], at: 'end'}]}});
		expect(
			drop(tableView(okey101View()), {kind: 'discard_top', position: 4}, {kind: 'meld_end', meldId: 2, at: 'end'}),
		).toEqual({kind: 'none', reason: 'wrong_phase'});
	});

	it('101: rack tiles join a staged take in the same take_discard', () => {
		const stage: OkeyStage = {take: 't40', open: [], add: []};
		expect(drop(tableView(okey101View()), tile('t1'), {kind: 'meld_zone'}, {stage})).toEqual({
			kind: 'stage',
			stage: {take: 't40', open: [['t0', 't1', 't2']], add: []},
		});
	});

	it.each([
		['okey', 'discard'],
		['okey101', 'play'],
	] as const)('%s: rack_tile → discard_zone in the %s phase discards it', (game, phase) => {
		const gameView = game === 'okey' ? okeyView({phase}) : okey101View({phase});
		expect(drop(tableView(gameView), tile('t30'), {kind: 'discard_zone'})).toEqual({
			kind: 'action',
			action: {type: 'discard', tile: 't30'},
		});
		expect(drop(tableView({...gameView, phase: 'draw'}), tile('t30'), {kind: 'discard_zone'})).toEqual({
			kind: 'none',
			reason: 'wrong_phase',
		});
	});

	it('okey: rack_tile → finish_zone with 15 tiles in the discard phase finishes with the rack sets', () => {
		const rack = ['t0', 't1', 't2', 't13', 't14', 't15', 't26', 't27', 't28', 't39', 't40', 't41', 't6', 't104', 't30'];
		const order: Array<RackSlot> = [
			...['t0', 't1', 't2', null, 't13', 't14', 't15', null, 't26', 't27', 't28', null, 't39', 't40', 't41'],
			...['t6', 't104', null, 't30'],
		];
		const view = tableView(okeyView({phase: 'discard', rack, rack_counts: [15, 14, 14, 14]}));
		expect(
			drop(view, {kind: 'rack_tile', tile: 't30', cell: order.indexOf('t30')}, {kind: 'finish_zone'}, {rack: order}),
		).toEqual({
			kind: 'action',
			action: {
				type: 'finish',
				tile: 't30',
				sets: [
					['t0', 't1', 't2'],
					['t13', 't14', 't15'],
					['t26', 't27', 't28'],
					['t39', 't40', 't41'],
					['t6', 't104'],
				],
			},
		});
		// Fewer than 15 tiles cannot finish.
		expect(drop(tableView(okeyView({phase: 'discard'})), tile('t30'), {kind: 'finish_zone'})).toEqual({
			kind: 'none',
			reason: 'illegal',
		});
	});

	it('101: rack_tile → meld_zone stages its set before opening, sends meld{open} once opened', () => {
		expect(drop(tableView(okey101View({phase: 'play'})), tile('t1'), {kind: 'meld_zone'})).toEqual({
			kind: 'stage',
			stage: {take: null, open: [['t0', 't1', 't2']], add: []},
		});
		// Already staged tiles are not staged twice.
		const stage: OkeyStage = {take: null, open: [['t0', 't1', 't2']], add: []};
		expect(drop(tableView(okey101View({phase: 'play'})), tile('t2'), {kind: 'meld_zone'}, {stage})).toEqual({
			kind: 'none',
			reason: 'illegal',
		});
		expect(
			drop(tableView(okey101View({phase: 'play', opened: ['sets', 'sets', 'none', 'none']})), tile('t13'), {
				kind: 'meld_zone',
			}),
		).toEqual({kind: 'action', action: {type: 'meld', open: [['t13', 't14']]}});
		// A lone tile is no set.
		expect(drop(tableView(okey101View({phase: 'play'})), tile('t30'), {kind: 'meld_zone'})).toEqual({
			kind: 'none',
			reason: 'illegal',
		});
	});

	it('101: rack_tile → meld_end adds once opened; before opening it is the wrong phase', () => {
		const end: TableDropTarget = {kind: 'meld_end', meldId: 2, at: 'start'};
		expect(
			drop(tableView(okey101View({phase: 'play', opened: ['sets', 'sets', 'none', 'none']})), tile('t30'), end),
		).toEqual({kind: 'action', action: {type: 'meld', add: [{meld_id: 2, tiles: ['t30'], at: 'start'}]}});
		expect(drop(tableView(okey101View({phase: 'play'})), tile('t30'), end)).toEqual({
			kind: 'none',
			reason: 'wrong_phase',
		});
	});
});

describe('resolveTableDrop — chess', () => {
	const sq = (square: string): TableDragSource & TableDropTarget => ({kind: 'square', square});

	function chessView(overrides: Partial<ChessView> = {}): ChessView {
		return {
			game: 'chess',
			fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
			white: 1,
			clocks_ms: {white: 600_000, black: 600_000},
			turn_started_at: null,
			last_move: null,
			legal_moves: ['e2e3', 'e2e4', 'g1f3'],
			in_check: false,
			...overrides,
		};
	}

	it('square → square in legal_moves moves; anything else is illegal', () => {
		expect(drop(tableView(chessView()), sq('e2'), sq('e4'))).toEqual({
			kind: 'action',
			action: {type: 'move', from: 'e2', to: 'e4'},
		});
		expect(drop(tableView(chessView()), sq('e2'), sq('e5'))).toEqual({kind: 'none', reason: 'illegal'});
	});

	it('a pawn reaching the last rank opens the promotion picker', () => {
		const view = chessView({
			fen: '4k3/4P3/8/8/8/8/8/4K3 w - - 0 1',
			legal_moves: ['e7e8q', 'e7e8r', 'e7e8b', 'e7e8n', 'e1d1'],
		});
		expect(drop(tableView(view), sq('e7'), sq('e8'))).toEqual({kind: 'promotion', from: 'e7', to: 'e8'});
	});

	it('black to move is not my turn as white', () => {
		const view = chessView({fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', legal_moves: null});
		expect(drop(tableView(view), sq('d2'), sq('d4'))).toEqual({kind: 'none', reason: 'not_your_turn'});
	});
});

describe('resolveTableDrop — dama', () => {
	const sq = (square: string): TableDragSource & TableDropTarget => ({kind: 'square', square});

	function damaView(game: 'dama' | 'dama_normal', overrides: Partial<DamaView> = {}) {
		return {
			game,
			board: '.'.repeat(64),
			white: 1,
			turn: 1,
			clocks_ms: {white: 600_000, black: 600_000},
			turn_started_at: null,
			last_move: null,
			last_captured: [],
			legal_moves: ['c3-c4', 'c3-c5-e5', 'c3-e3-e5'],
			...overrides,
		} as DamaView;
	}

	it.each(['dama', 'dama_normal'] as const)('%s: one path sends dama_move, several ask, none is illegal', (game) => {
		expect(drop(tableView(damaView(game)), sq('c3'), sq('c4'))).toEqual({
			kind: 'action',
			action: {type: 'dama_move', path: ['c3', 'c4']},
		});
		expect(drop(tableView(damaView(game)), sq('c3'), sq('e5'))).toEqual({
			kind: 'choose_path',
			paths: [
				['c3', 'c5', 'e5'],
				['c3', 'e3', 'e5'],
			],
		});
		expect(drop(tableView(damaView(game)), sq('c3'), sq('d4'))).toEqual({kind: 'none', reason: 'illegal'});
	});

	it('the turn comes from the view (R2.a)', () => {
		expect(drop(tableView(damaView('dama', {turn: 3, legal_moves: null})), sq('c3'), sq('c4'))).toEqual({
			kind: 'none',
			reason: 'not_your_turn',
		});
	});
});

describe('resolveTableDrop — tavla', () => {
	const point = (p: number | 'bar'): TableDragSource => ({kind: 'tavla_point', point: p});
	const to = (p: number): TableDropTarget => ({kind: 'tavla_point', point: p});

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
			legal_moves: ['24/19 19/13', '24/18 13/8', '13/7 13/8', '6/1 6/off'],
			...overrides,
		};
	}

	it('a step that starts a legal turn stays local', () => {
		expect(drop(tableView(tavlaView()), point(13), to(8))).toEqual({
			kind: 'tavla_step',
			steps: [{from: 13, to: 8}],
		});
	});

	it('the step that completes a turn sends one tavla_move by itself, in the order played', () => {
		const steps: Array<TavlaStep> = [{from: 13, to: 8}];
		expect(drop(tableView(tavlaView()), point(24), to(18), {tavlaSteps: steps})).toEqual({
			kind: 'action',
			action: {
				type: 'tavla_move',
				moves: [
					{from: 13, to: 8},
					{from: 24, to: 18},
				],
			},
		});
		expect(drop(tableView(tavlaView()), point(6), {kind: 'tavla_off'}, {tavlaSteps: [{from: 6, to: 1}]})).toEqual({
			kind: 'action',
			action: {
				type: 'tavla_move',
				moves: [
					{from: 6, to: 1},
					{from: 6, to: 'off'},
				],
			},
		});
	});

	it('the other decomposition of a listed turn is playable (R2.k)', () => {
		expect(drop(tableView(tavlaView()), point(18), to(13), {tavlaSteps: [{from: 24, to: 18}]})).toEqual({
			kind: 'action',
			action: {
				type: 'tavla_move',
				moves: [
					{from: 24, to: 18},
					{from: 18, to: 13},
				],
			},
		});
	});

	it('a step no legal turn holds, or from a point I have no checker on, is illegal', () => {
		expect(drop(tableView(tavlaView()), point(24), to(20))).toEqual({kind: 'none', reason: 'illegal'});
		// 19/13 belongs to '24/19 19/13', but nothing stands on 19 until 24/19 is played.
		expect(drop(tableView(tavlaView()), point(19), to(13))).toEqual({kind: 'none', reason: 'illegal'});
		expect(drop(tableView(tavlaView()), point(19), to(13), {tavlaSteps: [{from: 24, to: 19}]})).toMatchObject({
			kind: 'action',
		});
	});

	it('not my turn', () => {
		expect(drop(tableView(tavlaView({turn: 3, legal_moves: null})), point(13), to(8))).toEqual({
			kind: 'none',
			reason: 'not_your_turn',
		});
	});
});

describe('resolveTableDrop — every game', () => {
	it('read-only for watchers and ended tables', () => {
		const watcher = tableView(okeyView(), {me: null});
		expect(drop(watcher, tile('t30'), cell(3))).toEqual({kind: 'none', reason: 'read_only'});
		const ended = tableView(okeyView(), {status: 'ended'});
		expect(drop(ended, tile('t30'), cell(3))).toEqual({kind: 'none', reason: 'read_only'});
		const lobby = {...tableView(okeyView(), {status: 'lobby'}), game_view: null};
		expect(drop(lobby, tile('t30'), cell(3))).toEqual({kind: 'none', reason: 'read_only'});
		expect(legalTargets({...input(watcher, tile('t30'), cell(3))})).toEqual([]);
	});

	it('not my turn → none(not_your_turn)', () => {
		const view = tableView(okeyView({turn: 2}));
		expect(drop(view, {kind: 'pile'}, cell(9))).toEqual({kind: 'none', reason: 'not_your_turn'});
		expect(drop(view, tile('t30'), {kind: 'discard_zone'})).toEqual({kind: 'none', reason: 'not_your_turn'});
	});

	it('drag sends exactly one action on drop, none while dragging', () => {
		const view = tableView(okeyView({phase: 'discard'}));
		// Drag start: legal targets only, no request.
		const {target: _, ...dragging} = input(view, tile('t30'), {kind: 'discard_zone'});
		expect(legalTargets(dragging)).toContainEqual({kind: 'discard_zone'});
		// Drop: one outcome carrying one action; sending it is the caller's single act().
		expect(drop(view, tile('t30'), {kind: 'discard_zone'})).toEqual({
			kind: 'action',
			action: {type: 'discard', tile: 't30'},
		});
		expect(TableGameCommands.act).not.toHaveBeenCalled();
	});
});

describe('legalTargets', () => {
	it('chess: the squares the dragged piece may reach', () => {
		const view = tableView({
			game: 'chess',
			fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
			white: 1,
			clocks_ms: {white: 1, black: 1},
			turn_started_at: null,
			last_move: null,
			legal_moves: ['e2e3', 'e2e4', 'g1f3'],
			in_check: false,
		});
		const {target: _, ...p} = input(view, {kind: 'square', square: 'e2'}, {kind: 'square', square: 'e2'});
		expect(legalTargets(p)).toEqual([
			{kind: 'square', square: 'e4'},
			{kind: 'square', square: 'e3'},
		]);
	});

	it('tavla: the next legal steps from the dragged point, off included', () => {
		const points = new Array<number>(24).fill(0);
		points[5] = 5;
		points[0] = -15;
		const view = tableView({
			game: 'tavla',
			white: 1,
			points,
			bar: {white: 0, black: 0},
			off: {white: 10, black: 0},
			turn: 1,
			dice: [6, 5],
			opening: null,
			deadline_at: null,
			last_moves: [],
			legal_moves: ['6/1 6/off', '6/off 6/off'],
		});
		const {target: _, ...p} = input(view, {kind: 'tavla_point', point: 6}, {kind: 'tavla_off'});
		expect(legalTargets(p)).toEqual([{kind: 'tavla_point', point: 1}, {kind: 'tavla_off'}]);
	});

	it('okey: the pile goes onto any rack cell on my draw turn', () => {
		const {target: _, ...p} = input(tableView(okeyView()), {kind: 'pile'}, cell(0));
		const targets = legalTargets(p);
		expect(targets).toHaveLength(30);
		expect(targets.every((target) => target.kind === 'rack_cell')).toBe(true);
	});
});
