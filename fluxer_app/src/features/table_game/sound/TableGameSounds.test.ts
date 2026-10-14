// SPDX-License-Identifier: AGPL-3.0-or-later

import {SoundType} from '@app/features/notification/utils/SoundUtils';
import {
	DAMA_START_BOARD,
	testChessGameView,
	testDamaGameView,
	testOkeyGameView,
	testTavlaGameView,
	testView,
} from '@app/features/table_game/state/TableGameTestViews';
import type {
	Okey101View,
	OkeyView,
	TableGameAction,
	TableGameKind,
	TableGameResult,
	TableGameView,
	TavlaView,
} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/ui/commands/SoundCommands', () => ({playSound: vi.fn()}));

const {playSound} = await import('@app/features/ui/commands/SoundCommands');
const {default: TableGames} = await import('@app/features/table_game/state/TableGames');
const {TABLE_GAME_SOUND_TYPES, actionSound, setTableSoundFocus, tableGameSoundFor} = await import(
	'@app/features/table_game/sound/TableGameSounds'
);

type GameView = NonNullable<TableGameView['game_view']>;

function at(version: number, gameView: GameView, viewerPosition: number | null = 1): TableGameView {
	return testView({game: gameView.game, version, viewerPosition, gameView});
}

function okey101(overrides: Partial<Okey101View> = {}): Okey101View {
	return {
		...testOkeyGameView(),
		game: 'okey101',
		melds: [],
		opened: ['none', 'none', 'none', 'none'],
		penalties: [0, 0, 0, 0],
		scores: null,
		...overrides,
	} as Okey101View;
}

function okeyLike(game: 'okey' | 'okey101', overrides: Omit<Partial<OkeyView>, 'game'> = {}): GameView {
	return game === 'okey' ? testOkeyGameView(overrides) : okey101(overrides);
}

function withSquares(board: string, squares: Record<number, string>): string {
	return [...board].map((piece, index) => squares[index] ?? piece).join('');
}

function ended(prev: TableGameView, result: TableGameResult, viewerPosition: number | null): TableGameView {
	return testView({
		game: prev.summary.game,
		version: prev.summary.version + 1,
		viewerPosition,
		status: 'ended',
		gameView: prev.game_view,
		summary: {result},
	});
}

const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
const AFTER_E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';
const AFTER_NF3 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2';
// White's queen took on f7: black lost a pawn and is in check.
const BEFORE_QXF7 = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';
const AFTER_QXF7 = 'r1bqkbnr/pppp1Qpp/2n5/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4';
// The same capture without the check (the black king is elsewhere in this made-up position).
const BEFORE_CAPTURE = '4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1';
const AFTER_CAPTURE = '4k3/8/8/3P4/8/8/8/4K3 b - - 0 1';

describe('tableGameSoundFor — the mapping table, one row each', () => {
	it.each(['okey', 'okey101'] as const)('%s: a draw from the pile plays okey-tas-cek', (game) => {
		const prev = at(5, okeyLike(game, {turn: 2, phase: 'draw', pile_count: 40}));
		const next = at(6, okeyLike(game, {turn: 2, phase: 'discard', pile_count: 39}));
		expect(tableGameSoundFor(prev, next, 1)).toBe(SoundType.TableGameTileDraw);
	});

	it.each(['okey', 'okey101'] as const)('%s: a draw from the side plays okey-tas-al', (game) => {
		const prev = at(5, okeyLike(game, {turn: 2, phase: 'draw', discards: [['t9'], [], [], []]}));
		const next = at(6, okeyLike(game, {turn: 2, phase: 'discard', discards: [[], [], [], []]}));
		expect(tableGameSoundFor(prev, next, 1)).toBe(SoundType.TableGameTilePick);
	});

	it.each(['okey', 'okey101'] as const)('%s: a discard plays okey-tas-at', (game) => {
		const prev = at(5, okeyLike(game, {turn: 2, phase: 'discard', discards: [[], [], [], []]}));
		const next = at(6, okeyLike(game, {turn: 3, phase: 'draw', discards: [[], ['t40'], [], []]}));
		expect(tableGameSoundFor(prev, next, 1)).toBe(SoundType.TableGameTileDiscard);
	});

	it.each(['okey', 'okey101'] as const)('%s: the game start plays okey-karistir', (game) => {
		const prev = testView({game, version: 2, status: 'lobby'});
		const next = at(3, okeyLike(game, {turn: 2}));
		expect(tableGameSoundFor(prev, next, 1)).toBe(SoundType.TableGameShuffle);
	});

	it('101: opening melds plays okey-per-ac', () => {
		const meld = {id: 0, owner: 2, kind: 'run' as const, tiles: ['t0', 't1', 't2']};
		const prev = at(5, okey101({turn: 2, phase: 'play', melds: []}));
		const next = at(6, okey101({turn: 2, phase: 'play', melds: [meld], opened: ['none', 'sets', 'none', 'none']}));
		expect(tableGameSoundFor(prev, next, 1)).toBe(SoundType.TableGameMeldOpen);
	});

	it('101: adding to a meld on the table plays okey-per-ac too', () => {
		const meld = {id: 0, owner: 2, kind: 'run' as const, tiles: ['t0', 't1', 't2']};
		const prev = at(5, okey101({turn: 3, phase: 'play', melds: [meld]}));
		const next = at(6, okey101({turn: 3, phase: 'play', melds: [{...meld, tiles: ['t0', 't1', 't2', 't3']}]}));
		expect(tableGameSoundFor(prev, next, 1)).toBe(SoundType.TableGameMeldOpen);
	});

	it('okey: my finishing action plays okey-bitir', () => {
		expect(actionSound('okey', {type: 'finish', tile: 't3', sets: [['t0', 't1', 't2']]})).toBe(
			SoundType.TableGameOkeyFinish,
		);
	});

	it('chess: a move plays satranc-hamle', () => {
		const prev = at(3, testChessGameView(), 3);
		const next = at(4, testChessGameView({fen: AFTER_E4, last_move: 'e2e4'}), 3);
		expect(tableGameSoundFor(prev, next, 3)).toBe(SoundType.TableGameChessMove);
	});

	it('chess: a capture plays satranc-al', () => {
		const prev = at(3, testChessGameView({fen: BEFORE_CAPTURE}), 3);
		const next = at(4, testChessGameView({fen: AFTER_CAPTURE, last_move: 'e4d5'}), 3);
		expect(tableGameSoundFor(prev, next, 3)).toBe(SoundType.TableGameChessCapture);
	});

	it('chess: a check plays satranc-sah', () => {
		const prev = at(3, testChessGameView(), 3);
		const next = at(4, testChessGameView({fen: AFTER_E4, last_move: 'e2e4', in_check: true}), 3);
		expect(tableGameSoundFor(prev, next, 3)).toBe(SoundType.TableGameChessCheck);
	});

	it.each(['dama', 'dama_normal'] as const)('%s: a move plays dama-hamle', (game) => {
		const prev = at(3, testDamaGameView({game, turn: 3}));
		// A black man from b6 to b5.
		const board = withSquares(DAMA_START_BOARD, {17: '.', 25: 'b'});
		const next = at(4, testDamaGameView({game, turn: 1, board, last_move: ['b6', 'b5'], last_captured: []}));
		expect(tableGameSoundFor(prev, next, 1)).toBe(SoundType.TableGameDamaMove);
	});

	it.each(['dama', 'dama_normal'] as const)('%s: a capture plays dama-al', (game) => {
		const prev = at(3, testDamaGameView({game, turn: 3, board: withSquares(DAMA_START_BOARD, {27: 'w'})}));
		// The black man on d6 jumps the white man on d5 to d4.
		const board = withSquares(DAMA_START_BOARD, {19: '.', 35: 'b'});
		const next = at(4, testDamaGameView({game, turn: 1, board, last_move: ['d6', 'd4'], last_captured: ['d5']}));
		expect(tableGameSoundFor(prev, next, 1)).toBe(SoundType.TableGameDamaCapture);
	});

	it('tavla: a new roll of mine plays tavla-zar', () => {
		const prev = at(7, testTavlaGameView({turn: 3, dice: [6, 1], last_moves: []}));
		const next = at(8, testTavlaGameView({turn: 1, dice: [5, 2], last_moves: [{from: 1, to: 7, hit: false}]}));
		expect(tableGameSoundFor(prev, next, 1)).toBe(SoundType.TableGameTavlaDice);
	});

	it('tavla: a move plays tavla-pul', () => {
		const prev = at(7, testTavlaGameView({turn: 3, dice: [6, 1], last_moves: []}), null);
		const next = at(8, testTavlaGameView({turn: 1, dice: [5, 2], last_moves: [{from: 1, to: 7, hit: false}]}), null);
		expect(tableGameSoundFor(prev, next, null)).toBe(SoundType.TableGameTavlaChecker);
	});

	it('tavla: a hit (the bar grew) plays tavla-kir', () => {
		const prev = at(7, testTavlaGameView({turn: 3, dice: [6, 1]}));
		const next = at(
			8,
			testTavlaGameView({
				turn: 1,
				dice: [5, 2],
				bar: {white: 1, black: 0},
				last_moves: [{from: 1, to: 7, hit: true}],
			}),
		);
		expect(tableGameSoundFor(prev, next, 1)).toBe(SoundType.TableGameTavlaHit);
	});

	it('tavla: bearing off (off grew) plays tavla-topla', () => {
		const prev = at(7, testTavlaGameView({turn: 3, dice: [6, 1]}));
		const next = at(
			8,
			testTavlaGameView({
				turn: 1,
				dice: [5, 2],
				off: {white: 0, black: 1},
				last_moves: [{from: 24, to: 'off', hit: false}],
			}),
		);
		expect(tableGameSoundFor(prev, next, 1)).toBe(SoundType.TableGameTavlaBearOff);
	});

	it('tavla: a new roll equal to the last one still plays (version and turn, not the faces)', () => {
		const moves: TavlaView['last_moves'] = [{from: 1, to: 7, hit: false}];
		const prev = at(7, testTavlaGameView({turn: 3, dice: [3, 4], last_moves: moves}), null);
		const next = at(8, testTavlaGameView({turn: 1, dice: [3, 4], last_moves: moves}), null);
		expect(tableGameSoundFor(prev, next, null)).toBe(SoundType.TableGameTavlaDice);
	});

	it('tavla: the same turn and moves at a newer version is not a new roll', () => {
		const moves: TavlaView['last_moves'] = [{from: 1, to: 7, hit: false}];
		const prev = at(7, testTavlaGameView({turn: 3, dice: [3, 4], last_moves: moves}), null);
		const next = at(8, testTavlaGameView({turn: 3, dice: [3, 4], last_moves: moves}), null);
		expect(tableGameSoundFor(prev, next, null)).toBeNull();
	});

	it('the turn passing to me plays sira-sende', () => {
		const prev = at(5, testOkeyGameView({turn: 4, phase: 'draw'}));
		const next = at(6, testOkeyGameView({turn: 1, phase: 'draw'}));
		expect(tableGameSoundFor(prev, next, 1)).toBe(SoundType.TableGameYourTurn);
	});

	it('the turn passing to me at the start of a chess game plays sira-sende', () => {
		const prev = testView({game: 'chess', version: 1, status: 'lobby'});
		const next = at(2, testChessGameView({white: 1}));
		expect(tableGameSoundFor(prev, next, 1)).toBe(SoundType.TableGameYourTurn);
	});

	it('my win plays oyun-kazandin', () => {
		const prev = at(9, testChessGameView({fen: AFTER_E4}), 1);
		expect(tableGameSoundFor(prev, ended(prev, {kind: 'win', winners: [1], reason: 'checkmate'}, 1), 1)).toBe(
			SoundType.TableGameWon,
		);
	});

	it("a two-player opponent's forfeit is my win", () => {
		const prev = at(9, testChessGameView({fen: AFTER_E4}), 1);
		expect(tableGameSoundFor(prev, ended(prev, {kind: 'forfeit', loser: 3, reason: 'leave'}, 1), 1)).toBe(
			SoundType.TableGameWon,
		);
	});

	it.each<[string, TableGameResult, number | null]>([
		['someone else won', {kind: 'win', winners: [2], reason: 'finish'}, 1],
		['a draw', {kind: 'draw', reason: 'pile_empty'}, 1],
		['a four-player forfeit', {kind: 'forfeit', loser: 2, reason: 'leave'}, 1],
		['a watcher sees a win', {kind: 'win', winners: [1], reason: 'finish'}, null],
		['a cancel', {kind: 'canceled', reason: 'abandoned'}, 1],
	])('any other end plays oyun-bitti: %s', (_name, result, me) => {
		const prev = at(9, testOkeyGameView({turn: 2}), me);
		const me1to4 = me as 1 | 2 | 3 | 4 | null;
		expect(tableGameSoundFor(prev, ended(prev, result, me), me1to4)).toBe(SoundType.TableGameEnded);
	});
});

describe('tableGameSoundFor — rules', () => {
	it("my own action's echo does not play twice", () => {
		const prev = at(5, testOkeyGameView({turn: 1, phase: 'discard'}));
		const next = at(6, testOkeyGameView({turn: 2, phase: 'draw', discards: [['t3'], [], [], []]}));
		expect(tableGameSoundFor(prev, next, 1, true)).toBeNull();
		const chessPrev = at(3, testChessGameView({white: 1}));
		const chessNext = at(4, testChessGameView({white: 1, fen: AFTER_E4, last_move: 'e2e4'}));
		expect(tableGameSoundFor(chessPrev, chessNext, 1, true)).toBeNull();
		// Drawing keeps my turn: its echo is no "your turn" either.
		const drawn = at(6, testOkeyGameView({turn: 1, phase: 'discard', pile_count: 47}));
		expect(tableGameSoundFor(at(5, testOkeyGameView({turn: 1, phase: 'draw'})), drawn, 1, true)).toBeNull();
	});

	it('the echo of my winning action still plays the win', () => {
		const prev = at(9, testOkeyGameView({turn: 1, phase: 'discard'}));
		expect(tableGameSoundFor(prev, ended(prev, {kind: 'win', winners: [1], reason: 'finish'}, 1), 1, true)).toBe(
			SoundType.TableGameWon,
		);
	});

	it('a timeout auto-move on my turn plays', () => {
		const prev = at(5, testOkeyGameView({turn: 1, phase: 'draw', pile_count: 40}));
		const next = at(6, testOkeyGameView({turn: 2, phase: 'draw', pile_count: 39, discards: [['t3'], [], [], []]}));
		expect(tableGameSoundFor(prev, next, 1)).toBe(SoundType.TableGameTileDiscard);
		const tavlaPrev = at(7, testTavlaGameView({turn: 1, dice: [6, 1]}));
		const tavlaNext = at(8, testTavlaGameView({turn: 3, dice: [5, 2], last_moves: [{from: 24, to: 18, hit: false}]}));
		expect(tableGameSoundFor(tavlaPrev, tavlaNext, 1)).toBe(SoundType.TableGameTavlaChecker);
	});

	it('new dice after the opponent passes plays', () => {
		// My turn went out and came straight back: the opponent had no play for their roll.
		const prev = at(7, testTavlaGameView({turn: 1, dice: [6, 5], last_moves: []}));
		const next = at(8, testTavlaGameView({turn: 1, dice: [6, 5], last_moves: [{from: 24, to: 13, hit: false}]}));
		expect(tableGameSoundFor(prev, next, 1, true)).toBe(SoundType.TableGameTavlaDice);
		expect(tableGameSoundFor(prev, next, 1)).toBe(SoundType.TableGameTavlaDice);
	});

	it('one sound per update (highest priority)', () => {
		// Capture and check in one move: the check wins.
		const prev = at(3, testChessGameView({fen: BEFORE_QXF7}), 3);
		const next = at(4, testChessGameView({fen: AFTER_QXF7, last_move: 'h5f7', in_check: true}), 3);
		expect(tableGameSoundFor(prev, next, 3)).toBe(SoundType.TableGameChessCheck);
		// Taking the side tile and opening with it: the meld wins over the pick.
		const meld = {id: 0, owner: 2, kind: 'run' as const, tiles: ['t9', 't10', 't11']};
		const prev101 = at(5, okey101({turn: 2, phase: 'draw', discards: [['t9'], [], [], []]}));
		const next101 = at(6, okey101({turn: 2, phase: 'play', discards: [[], [], [], []], melds: [meld]}));
		expect(tableGameSoundFor(prev101, next101, 1)).toBe(SoundType.TableGameMeldOpen);
		// A hit and a bear-off in one turn: the hit.
		const prevTavla = at(7, testTavlaGameView({turn: 3, dice: [6, 1]}));
		const nextTavla = at(
			8,
			testTavlaGameView({turn: 1, dice: [2, 2], bar: {white: 1, black: 0}, off: {white: 0, black: 1}}),
		);
		expect(tableGameSoundFor(prevTavla, nextTavla, 1)).toBe(SoundType.TableGameTavlaHit);
	});

	it('watchers get move sounds but never sira-sende', () => {
		const prev = at(3, testChessGameView(), null);
		const next = at(4, testChessGameView({fen: AFTER_E4, last_move: 'e2e4'}), null);
		expect(tableGameSoundFor(prev, next, null)).toBe(SoundType.TableGameChessMove);
		const turnOnly = at(6, testOkeyGameView({turn: 1, phase: 'draw'}), null);
		expect(tableGameSoundFor(at(5, testOkeyGameView({turn: 4, phase: 'draw'}), null), turnOnly, null)).toBeNull();
		const lobby = testView({game: 'chess', version: 1, status: 'lobby', viewerPosition: null});
		expect(tableGameSoundFor(lobby, at(2, testChessGameView({white: 1}), null), null)).toBeNull();
	});

	it('nothing without a previous view, at the same or an older version, or across a game change', () => {
		const prev = at(3, testChessGameView(), 3);
		const next = at(4, testChessGameView({fen: AFTER_E4, last_move: 'e2e4'}), 3);
		expect(tableGameSoundFor(null, next, 3)).toBeNull();
		expect(tableGameSoundFor(next, {...next}, 3)).toBeNull();
		expect(tableGameSoundFor(next, prev, 3)).toBeNull();
		expect(tableGameSoundFor(at(3, testOkeyGameView({turn: 2}), 3), next, 3)).toBeNull();
	});
});

describe('actionSound — my own action while it is sent', () => {
	it.each<[string, TableGameKind, TableGameAction, SoundType | null]>([
		['draw from the pile', 'okey', {type: 'draw', from: 'pile'}, SoundType.TableGameTileDraw],
		['draw from the side', 'okey', {type: 'draw', from: 'discard'}, SoundType.TableGameTilePick],
		['discard', 'okey101', {type: 'discard', tile: 't4'}, SoundType.TableGameTileDiscard],
		['meld', 'okey101', {type: 'meld', open: [['t0', 't1', 't2']]}, SoundType.TableGameMeldOpen],
		[
			'take the side tile and open',
			'okey101',
			{type: 'take_discard', open: [['t0', 't1', 't2']]},
			SoundType.TableGameMeldOpen,
		],
		['chess move', 'chess', {type: 'move', from: 'e2', to: 'e4'}, SoundType.TableGameChessMove],
		['dama move', 'dama', {type: 'dama_move', path: ['c3', 'c4']}, SoundType.TableGameDamaMove],
		['tavla turn', 'tavla', {type: 'tavla_move', moves: [{from: 24, to: 18}]}, SoundType.TableGameTavlaChecker],
		['tavla bear-off', 'tavla', {type: 'tavla_move', moves: [{from: 3, to: 'off'}]}, SoundType.TableGameTavlaBearOff],
		['tick', 'okey', {type: 'tick'}, null],
		['resign', 'chess', {type: 'resign'}, null],
	])('%s', (_name, game, action, sound) => {
		expect(actionSound(game, action)).toBe(sound);
	});
});

describe('TABLE_GAME_SOUND_TYPES', () => {
	it('lists the 21 table game sound types once each', () => {
		expect(TABLE_GAME_SOUND_TYPES).toHaveLength(21);
		expect(new Set(TABLE_GAME_SOUND_TYPES).size).toBe(21);
		const known = new Set<string>(Object.values(SoundType));
		for (const type of TABLE_GAME_SOUND_TYPES) {
			expect(type.startsWith('table-game-')).toBe(true);
			expect(known.has(type)).toBe(true);
		}
	});
});

describe('setTableSoundFocus — only the focused table plays', () => {
	const CHANNEL = '500';

	function show(view: TableGameView): void {
		TableGames.handleView(CHANNEL, view, 'event');
	}

	beforeEach(() => {
		TableGames.reset();
		vi.mocked(playSound).mockClear();
	});

	afterEach(() => {
		vi.useRealTimers();
		// A failed test must not leave its table playing into the next one.
		setTableSoundFocus(CHANNEL, 'T01', false);
	});

	it('no sound when the table is not focused', () => {
		show(at(3, testChessGameView(), null));
		show(at(4, testChessGameView({fen: AFTER_E4, last_move: 'e2e4'}), null));
		expect(playSound).not.toHaveBeenCalled();

		setTableSoundFocus(CHANNEL, 'T01', true);
		show(at(5, testChessGameView({fen: AFTER_E5, last_move: 'e7e5'}), null));
		expect(vi.mocked(playSound).mock.calls).toEqual([[SoundType.TableGameChessMove]]);

		setTableSoundFocus(CHANNEL, 'T01', false);
		show(at(6, testChessGameView({fen: AFTER_NF3, last_move: 'g1f3'}), null));
		expect(playSound).toHaveBeenCalledTimes(1);
	});

	it('a table focused by the panel and the seat view stays focused until both let go', () => {
		show(at(3, testChessGameView(), null));
		setTableSoundFocus(CHANNEL, 'T01', true);
		setTableSoundFocus(CHANNEL, 'T01', true);
		setTableSoundFocus(CHANNEL, 'T01', false);
		show(at(4, testChessGameView({fen: AFTER_E4, last_move: 'e2e4'}), null));
		expect(playSound).toHaveBeenCalledTimes(1);
		setTableSoundFocus(CHANNEL, 'T01', false);
		show(at(5, testChessGameView({fen: AFTER_E5, last_move: 'e7e5'}), null));
		expect(playSound).toHaveBeenCalledTimes(1);
	});

	it('a server change on my turn plays; only my own action is held for its answer (CR7)', () => {
		show(at(3, testOkeyGameView({turn: 1, phase: 'draw', pile_count: 40})));
		setTableSoundFocus(CHANNEL, 'T01', true);
		show(at(4, testOkeyGameView({turn: 2, phase: 'draw', pile_count: 39, discards: [['t3'], [], [], []]})));
		expect(vi.mocked(playSound).mock.calls).toEqual([[SoundType.TableGameTileDiscard]]);
		setTableSoundFocus(CHANNEL, 'T01', false);
	});

	it('one sound per update reaches the player, my own perspective reply plays nothing more', () => {
		show(at(3, testOkeyGameView({turn: 2, phase: 'discard'})));
		setTableSoundFocus(CHANNEL, 'T01', true);
		const next = at(4, testOkeyGameView({turn: 3, phase: 'draw', discards: [[], ['t40'], [], []]}));
		show(next);
		TableGames.handleView(CHANNEL, {...next}, 'rest');
		expect(vi.mocked(playSound).mock.calls).toEqual([[SoundType.TableGameTileDiscard]]);
		setTableSoundFocus(CHANNEL, 'T01', false);
	});

	it('kalan ≤ 5 sn → sure-azaldi on my turn, once a turn', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-10-03T12:00:00.000Z'));
		const deadline = '2026-10-03T12:00:20.000Z';
		show(at(3, testOkeyGameView({turn: 1, phase: 'draw', deadline_at: deadline})));
		setTableSoundFocus(CHANNEL, 'T01', true);
		vi.advanceTimersByTime(14_999);
		expect(playSound).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(vi.mocked(playSound).mock.calls).toEqual([[SoundType.TableGameTimeLow]]);
		// Drawing keeps the turn (and its deadline), nor does closing and reopening the panel warn twice.
		show(at(4, testOkeyGameView({turn: 1, phase: 'discard', deadline_at: deadline, pile_count: 47})));
		setTableSoundFocus(CHANNEL, 'T01', false);
		setTableSoundFocus(CHANNEL, 'T01', true);
		vi.advanceTimersByTime(10_000);
		// (The draw here comes as a bare update, not through act(), so it sounds as a server change.)
		expect(vi.mocked(playSound).mock.calls.filter(([type]) => type === SoundType.TableGameTimeLow)).toHaveLength(1);
		// My next turn warns again.
		show(at(5, testOkeyGameView({turn: 1, phase: 'draw', deadline_at: '2026-10-03T12:01:00.000Z'})));
		vi.advanceTimersByTime(60_000);
		expect(vi.mocked(playSound).mock.calls.filter(([type]) => type === SoundType.TableGameTimeLow)).toHaveLength(2);
		setTableSoundFocus(CHANNEL, 'T01', false);
	});

	it('no sure-azaldi when it is not my turn, for watchers, or once the table lost focus', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-10-03T12:00:00.000Z'));
		show(at(3, testOkeyGameView({turn: 2, deadline_at: '2026-10-03T12:00:20.000Z'})));
		setTableSoundFocus(CHANNEL, 'T01', true);
		vi.advanceTimersByTime(30_000);
		show(at(4, testOkeyGameView({turn: 1, deadline_at: '2026-10-03T12:01:00.000Z'}), null));
		vi.advanceTimersByTime(60_000);
		expect(playSound).not.toHaveBeenCalledWith(SoundType.TableGameTimeLow);
		show(at(5, testOkeyGameView({turn: 1, deadline_at: '2026-10-03T12:02:00.000Z'})));
		setTableSoundFocus(CHANNEL, 'T01', false);
		vi.advanceTimersByTime(60_000);
		expect(playSound).not.toHaveBeenCalledWith(SoundType.TableGameTimeLow);
	});
});
