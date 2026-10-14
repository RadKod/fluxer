// SPDX-License-Identifier: AGPL-3.0-or-later

import {Dama, type DamaState} from '@app/api/table_game/engine/dama/Dama';
import {legalPaths, searchNodes} from '@app/api/table_game/engine/dama/DamaCore';
import {DamaNormal} from '@app/api/table_game/engine/dama/DamaNormal';
import {DAMA_NORMAL_RULES, DAMA_RULES} from '@app/api/table_game/engine/dama/DamaRules';
import {type TableGameEngine, TableGameRuleError, type TablePosition} from '@app/api/table_game/engine/TableGameEngine';
import {actorToMove} from '@app/api/table_game/engine/tests/EngineInvariants';
import {SeededRng} from '@app/api/table_game/engine/tests/SeededRng';
import {
	DAMA_LEGAL_PATHS_MAX,
	DAMA_PATH_MAX,
	DAMA_SEARCH_NODE_BUDGET,
	damaSquareIndex,
	TABLE_GAME_TURN_MS,
} from '@fluxer/constants/src/TableGameConstants';
import {
	DamaNormalView,
	DamaView,
	type TableGameAction,
	type TableGameResult,
} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {describe, expect, it} from 'vitest';

type DamaEngine = TableGameEngine<DamaState>;

const SEEDS = 2000;
const CLOCK_MS = TABLE_GAME_TURN_MS.dama.slow;
const FILES = 'abcdefgh';
// Between two advances (a capture or a man moving forward) at most 2 × 25 quiet plies; advances are bounded
// (each capture removes a piece, each man steps forward at most 7 times), so every game ends by the rules
// alone. Time never moves in these games except on the seeds that let a flag fall.
const QUIET_PLIES = 2 * DAMA_RULES.quietMoveLimit;

const move = (path: ReadonlyArray<string>): TableGameAction => ({type: 'dama_move', path: [...path]});
const randomSquare = (rng: SeededRng) => `${FILES[rng.int(8)]}${rng.int(8) + 1}`;

function rejection(fn: () => unknown): string | null {
	try {
		fn();
	} catch (error) {
		if (error instanceof TableGameRuleError) return error.reason;
		throw error;
	}
	return null;
}

const ending = (result: TableGameResult) => `${result.kind}:${result.reason}`;

describe.each([
	['dama', Dama, DamaView, 32, ['draw:lone_kings', 'win:no_pieces', 'win:timeout']],
	['dama_normal', DamaNormal, DamaNormalView, 24, ['win:blocked', 'win:no_pieces', 'win:timeout']],
] as const)('%s property', (_kind, engine, schema, pieces, expectedEndings) => {
	it(`${SEEDS} seeded random games end by the rules, keep every piece accounted for and reject illegal moves`, () => {
		const started = performance.now();
		const endings = new Set<string>();
		let plies = 0;
		let longest = 0;
		for (let seed = 1; seed <= SEEDS; seed++) {
			const rng = new SeededRng(seed);
			let now = 1_000_000;
			let state: DamaState = (engine as TableGameEngine<DamaState>).start([1, 3], rng, {now, turnMs: CLOCK_MS});
			const flagAtPly = rng.int(20) === 0 ? rng.int(120) : -1;
			let captured = 0;
			for (let ply = 0; engine.result(state) === null; ply++) {
				const mover = actorToMove(engine.view(state, null));
				const waiting: TablePosition = mover === 1 ? 3 : 1;
				const view = schema.parse(engine.view(state, mover));
				expect(schema.parse(engine.view(state, waiting)).legal_moves).toBeNull();
				expect(engine.view(state, null)).toEqual({...view, legal_moves: null});
				expect([...view.board].filter((cell) => cell !== '.').length + captured).toBe(pieces);
				expect(state.quietMoves).toBeLessThan(QUIET_PLIES);
				expect(state.repetition.length).toBeLessThanOrEqual(QUIET_PLIES + 1);
				const legal = view.legal_moves ?? [];
				expect(legal.length).toBeGreaterThan(0);

				const clock = {now, turnMs: CLOCK_MS};
				if (ply === flagAtPly) {
					now = engine.deadline(state) ?? now;
					state = engine.onDeadline(state, rng, {now, turnMs: CLOCK_MS});
					expect(engine.result(state)).toEqual({kind: 'win', winners: [waiting], reason: 'timeout'});
					break;
				}

				const before = JSON.stringify(state);
				const pick = legal[rng.int(legal.length)]!.split('-');
				// A two-square path that is not listed is never legal: plain moves are all listed and a single
				// capture's result is fixed by its start and landing square.
				const probe = [randomSquare(rng), randomSquare(rng)];
				if (!legal.includes(probe.join('-'))) {
					expect(rejection(() => engine.apply(state, mover, move(probe), rng, clock))).toBe('illegal_move');
				}
				expect(rejection(() => engine.apply(state, mover, move([...pick, randomSquare(rng)]), rng, clock))).toBe(
					'illegal_move',
				);
				if (pick.length > 2) {
					expect(rejection(() => engine.apply(state, mover, move(pick.slice(0, -1)), rng, clock))).toBe('illegal_move');
				}
				expect(rejection(() => engine.apply(state, waiting, move(pick), rng, clock))).toBe('not_your_turn');
				expect(JSON.stringify(state)).toBe(before);

				const next = engine.apply(state, mover, move(pick), rng, clock);
				const after = schema.parse(engine.view(next, null));
				for (const square of after.last_captured) {
					expect(state.board[damaSquareIndex(square)]!.toLowerCase()).toBe(mover === state.white ? 'b' : 'w');
				}
				if (after.last_captured.length > 0) expect(after.last_captured).toHaveLength(pick.length - 1);
				expect(after.last_move).toEqual(pick);
				captured += after.last_captured.length;
				state = next;
				plies++;
				longest = Math.max(longest, ply + 1);
			}
			const result = engine.result(state);
			if (result === null) throw new Error('game did not end');
			if (result.kind === 'win' && result.reason !== 'timeout') {
				expect(result.winners).toEqual([lastMover(state)]);
			}
			expect(engine.view(state, 1)).toMatchObject({turn: null, legal_moves: null});
			endings.add(ending(result));
		}
		console.log(
			`${engine.kind}: ${SEEDS} games, ${plies} plies, longest ${longest}, endings ${[...endings].sort().join(' ')}, ${Math.round(performance.now() - started)} ms`,
		);
		// Random play takes a lot: the quiet endings (move_limit, threefold) have their own tests below.
		expect([...endings].sort()).toEqual(expectedEndings);
	}, 600_000);
});

// The side that made the last move: its piece stands on the last square of last_move.
function lastMover(state: DamaState): TablePosition {
	const piece = state.board[damaSquareIndex(state.lastMove!.at(-1)!)]!;
	return (piece.toLowerCase() === 'w') === (state.white === 1) ? 1 : 3;
}

function placed(engine: DamaEngine, pieces: Record<string, string>): DamaState {
	const cells = Array<string>(64).fill('.');
	for (const [square, piece] of Object.entries(pieces)) cells[damaSquareIndex(square)] = piece;
	return {...engine.start([1, 3], {int: () => 0}, {now: 0, turnMs: CLOCK_MS}), board: cells.join(''), repetition: []};
}

// Plays the agent's picks (from the listed moves) until the game ends; time never moves.
function playOut(engine: DamaEngine, state: DamaState, pick: (legal: ReadonlyArray<string>, board: string) => string) {
	let longestHistory = state.repetition.length;
	let plies = 0;
	while (engine.result(state) === null) {
		if (plies > 10_000) throw new Error('game did not end');
		const mover = actorToMove(engine.view(state, null));
		const legal = (engine.view(state, mover) as DamaView | DamaNormalView).legal_moves ?? [];
		state = engine.apply(
			state,
			mover,
			move(pick(legal, state.board).split('-')),
			{int: () => 0},
			{now: 0, turnMs: CLOCK_MS},
		);
		longestHistory = Math.max(longestHistory, state.repetition.length);
		plies++;
	}
	return {state, plies, longestHistory};
}

const rankOf = (path: string, index: number) => path.split('-')[index]![1];

describe('dama termination (TD6 / CD4 as amended in Rev 2: only captures and forward man moves reset)', () => {
	it('sideways shuffles end in move_limit or threefold', () => {
		const endings = new Set<string>();
		for (let seed = 1; seed <= 200; seed++) {
			const rng = new SeededRng(seed);
			const {state, plies} = playOut(Dama, placed(Dama, {a2: 'w', c2: 'w', f7: 'b', h7: 'b'}), (legal) => {
				const sideways = legal.filter((path) => rankOf(path, 0) === rankOf(path, 1));
				expect(sideways.length).toBeGreaterThan(0);
				return sideways[rng.int(sideways.length)]!;
			});
			expect(plies).toBeLessThanOrEqual(QUIET_PLIES);
			const result = Dama.result(state)!;
			expect(['draw:threefold', 'draw:move_limit']).toContain(ending(result));
			endings.add(ending(result));
		}
		expect([...endings].sort()).toEqual(['draw:move_limit', 'draw:threefold']);
	});

	it('repetition never exceeds 51 entries', () => {
		// A forward man move first, then sideways shuffles: the history starts after that advance, so a game
		// the move limit ends holds exactly 1 + 50 positions; one the threefold rule ends holds fewer.
		let longest = 0;
		for (let seed = 1; seed <= 200; seed++) {
			const rng = new SeededRng(seed);
			let first = true;
			const {state, longestHistory} = playOut(Dama, placed(Dama, {a2: 'w', c2: 'w', f7: 'b', h7: 'b'}), (legal) => {
				if (first) {
					first = false;
					return 'a2-a3';
				}
				const sideways = legal.filter((path) => rankOf(path, 0) === rankOf(path, 1));
				return sideways[rng.int(sideways.length)]!;
			});
			expect(longestHistory).toBeLessThanOrEqual(QUIET_PLIES + 1);
			if (ending(Dama.result(state)!) === 'draw:move_limit') expect(longestHistory).toBe(QUIET_PLIES + 1);
			longest = Math.max(longest, longestHistory);
		}
		expect(longest).toBe(QUIET_PLIES + 1);
	});
});

// Heaviest positions a hill climb found (maximising distinct results or search states) over lattice-like
// arrangements: kings facing pieces spaced one square apart, so a king can take them in many orders.
// Unreachable material does not matter here: a reachable position is only easier.
const LATTICES = [
	{rules: DAMA_RULES, board: 'WWWW.WWW.b..B......bb...b.b...BB.b...b..b...b.....Bb..b.WW..B..W', results: 451},
	{rules: DAMA_RULES, board: 'WWWW.WWW.b..B.......b..BB.B...b..B.b.B..b...B....B.b..b.WWW.B..W', results: 547},
	{rules: DAMA_RULES, board: '.....B.W...b..B..b..B..b..b..b...B....b.B..BB..b..B..B..W..WW..W', results: 294},
	{rules: DAMA_RULES, board: 'W.W...B.BWb..b.B.b..b......b....b.B...B..B..B..b.....B.....B....', results: 176},
	{rules: DAMA_NORMAL_RULES, board: '........B.B.B.B.........B.B.B.B.........B.B.B.B.........W.......', results: 1},
	{rules: DAMA_NORMAL_RULES, board: '.W.....WW...B.b..b..........b.B..b.B...W......b..b.b...WW.....W.', results: 13},
] as const;

describe('dama worst case', () => {
	it('lattice worst case stays under budget and cap', () => {
		for (const {rules, board, results} of LATTICES) {
			const started = performance.now();
			const paths = legalPaths(board, 'white', rules);
			const elapsed = performance.now() - started;
			const nodes = searchNodes(board, 'white', rules);
			const longest = Math.max(...paths.map((path) => path.length));
			console.log(
				`${board}: ${paths.length} results, ${nodes} search states, longest ${longest}, ${elapsed.toFixed(1)} ms`,
			);
			expect(paths).toHaveLength(results);
			expect(paths.length).toBeLessThan(DAMA_LEGAL_PATHS_MAX);
			expect(nodes).toBeLessThan(DAMA_SEARCH_NODE_BUDGET);
			expect(longest).toBeLessThanOrEqual(DAMA_PATH_MAX);
		}
	});
});
