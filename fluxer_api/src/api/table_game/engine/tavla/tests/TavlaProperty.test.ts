// SPDX-License-Identifier: AGPL-3.0-or-later

import {type Rng, TableGameRuleError, type TablePosition} from '@app/api/table_game/engine/TableGameEngine';
import {Tavla, type TavlaState} from '@app/api/table_game/engine/tavla/Tavla';
import {legalSequences, sequenceKey, type TavlaBoard, type TavlaMove} from '@app/api/table_game/engine/tavla/TavlaCore';
import {playRandomGame} from '@app/api/table_game/engine/tests/EngineInvariants';
import {SeededRng} from '@app/api/table_game/engine/tests/SeededRng';
import {TAVLA_CHECKERS, TAVLA_LEGAL_SEQUENCES_MAX} from '@fluxer/constants/src/TableGameConstants';
import {type TableGameAction, TavlaView} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {describe, expect, it} from 'vitest';

const GAMES = 2000;
const MAX_TURNS = 600;
const neverRolls: Rng = {
	int: () => {
		throw new Error('a refused action must not roll');
	},
};

const toMoves = (key: string): Array<TavlaMove> =>
	key.split(' ').map((step) => {
		const [from, to] = step.split('/') as [string, string];
		return {from: from === 'bar' ? 'bar' : Number(from), to: to === 'off' ? 'off' : Number(to)};
	});

function checkers(board: TavlaBoard, side: 'white' | 'black'): number {
	const sign = side === 'white' ? 1 : -1;
	return board.points.reduce((sum, count) => sum + Math.max(0, count * sign), 0) + board.bar[side] + board.off[side];
}

function rejection(fn: () => unknown): string | null {
	try {
		fn();
	} catch (error) {
		if (error instanceof TableGameRuleError) return error.reason;
		throw error;
	}
	return null;
}

// One action the rules must refuse, from a seeded menu; null when the pick happens to be legal.
function illegalAction(
	state: TavlaState,
	legal: ReadonlyArray<string>,
	rng: SeededRng,
): {actor: TablePosition; action: TableGameAction; reason: string} | null {
	const turn = state.turn;
	const waiting = turn === 1 ? 3 : 1;
	const any = legal[rng.int(legal.length)]!;
	const point = () => 1 + rng.int(24);
	switch (rng.int(5)) {
		case 0:
			return {actor: waiting, action: {type: 'tavla_move', moves: toMoves(any)}, reason: 'not_your_turn'};
		case 1: {
			const moves: Array<TavlaMove> = Array.from({length: 1 + rng.int(4)}, () => ({
				from: rng.int(25) === 0 ? 'bar' : point(),
				to: rng.int(25) === 0 ? 'off' : point(),
			}));
			const side = turn === state.white ? 'white' : 'black';
			if (legalSequences(state, side, state.dice).accepted.has(sequenceKey(side, moves))) return null;
			return {actor: turn, action: {type: 'tavla_move', moves}, reason: 'illegal_move'};
		}
		case 2: {
			const steps = toMoves(any);
			if (steps.length < 2) return null;
			return {actor: turn, action: {type: 'tavla_move', moves: steps.slice(0, -1)}, reason: 'illegal_move'};
		}
		case 3:
			return {actor: turn, action: {type: 'draw', from: 'pile'}, reason: 'unsupported_action'};
		default:
			return {actor: turn, action: {type: 'dama_move', path: ['c3', 'd4']}, reason: 'unsupported_action'};
	}
}

// Absolute points; black counts given positive.
function board(white: ReadonlyArray<number>, black: Readonly<Record<number, number>>, blackOff: number): TavlaBoard {
	const points = new Array<number>(24).fill(0);
	for (const point of white) points[point - 1] = 1;
	for (const [point, count] of Object.entries(black)) points[Number(point) - 1] = -count;
	return {points, bar: {white: 0, black: 0}, off: {white: 15 - white.length, black: blackOff}};
}

const mirror = (b: TavlaBoard): TavlaBoard => ({
	points: [...b.points].reverse().map((count) => -count || 0),
	bar: {white: b.bar.black, black: b.bar.white},
	off: {white: b.off.black, black: b.off.white},
});

describe('Tavla property', () => {
	// seeded random games with a random refused action at every step; no wall-clock assertion.
	it('2000 seeded games end, keep 15 + 15 checkers, refuse illegal actions and parse strictly', () => {
		const started = performance.now();
		const endings = new Map<string, number>();
		let longest = 0;
		let shuffled = 0;
		for (let seed = 1; seed <= GAMES; seed++) {
			const pick = new SeededRng(seed + 1_000_000);
			// onStep sees every state before the agent does; it keeps the mover's list so the agent needs no view.
			const legalOf = new WeakMap<TavlaState, ReadonlyArray<string>>();
			const agent = (state: TavlaState, _actor: TablePosition): TableGameAction => {
				const sequences = legalOf.get(state)!;
				if (sequences.length === 0 || pick.int(40) === 0) return {type: 'tick'};
				const moves = toMoves(sequences[pick.int(sequences.length)]!);
				if (moves.length > 1 && pick.int(4) === 0) {
					moves.reverse(); // any order of a legal play is accepted
					shuffled++;
				}
				return {type: 'tavla_move', moves};
			};
			const final = playRandomGame(Tavla, new SeededRng(seed), agent, (state) => {
				expect(checkers(state, 'white')).toBe(TAVLA_CHECKERS);
				expect(checkers(state, 'black')).toBe(TAVLA_CHECKERS);
				expect(state.turns).toBeLessThan(MAX_TURNS);
				const views = ([1, 3, null] as const).map((viewer) => TavlaView.parse(Tavla.view(state, viewer)));
				if (Tavla.result(state) !== null) {
					for (const view of views) expect(view.legal_moves).toBeNull();
					return;
				}
				const mover = views[state.turn === 1 ? 0 : 1]!;
				expect(views[state.turn === 1 ? 1 : 0]!.legal_moves).toBeNull();
				expect(views[2]!.legal_moves).toBeNull();
				expect(mover.dice).toEqual(state.dice);
				const legal = mover.legal_moves!;
				legalOf.set(state, legal);
				if (legal.length === 0) return;
				const refused = illegalAction(state, legal, pick);
				if (refused === null) return;
				const before = JSON.stringify(state);
				const clock = {now: state.deadlineAt - 1, turnMs: 40_000};
				expect(rejection(() => Tavla.apply(state, refused.actor, refused.action, neverRolls, clock))).toBe(
					refused.reason,
				);
				expect(JSON.stringify(state)).toBe(before);
			});
			const result = Tavla.result(final)!;
			const ending =
				result.kind === 'win'
					? `${result.reason}${result.finish ? `:${result.finish}` : ''}`
					: `${result.kind}:${result.reason}`;
			endings.set(ending, (endings.get(ending) ?? 0) + 1);
			longest = Math.max(longest, final.turns);
		}
		const elapsed = Math.round(performance.now() - started);
		console.info(
			`Tavla property: ${GAMES} games in ${elapsed} ms; endings ${JSON.stringify(Object.fromEntries(endings))}; ` +
				`longest ${longest} turns; reordered plays ${shuffled}`,
		);
		for (const ending of ['bear_off', 'bear_off:mars', 'forfeit:timeouts']) {
			expect(endings.get(ending) ?? 0).toBeGreaterThan(0);
		}
	}, 600_000);

	// a double is four die moves spread over at most 15 checkers, so at most C(18, 4) = 3060
	// distinct plays (stacks and blocks only lower it); a non-double has at most 2 × 15 × 15 = 450. The cap is that
	// bound; the positions below are the heaviest a hill-climbing search found (2210 for 1-1, 1966 for 2-2).
	it('worst-case sequence count stays under TAVLA_LEGAL_SEQUENCES_MAX', () => {
		expect(TAVLA_LEGAL_SEQUENCES_MAX).toBe(3060);
		const started = performance.now();
		const heavyOnes = board([2, 4, 6, 8, 10, 11, 12, 14, 15, 16, 18, 20, 22, 23, 24], {13: 1}, 14);
		const heavyTwos = board([4, 5, 6, 8, 9, 10, 12, 14, 15, 16, 19, 20, 21, 22, 24], {2: 1, 18: 1}, 13);
		expect(legalSequences(heavyOnes, 'white', [1, 1]).sequences).toHaveLength(2210);
		expect(legalSequences(heavyTwos, 'white', [2, 2]).sequences).toHaveLength(1966);
		let most = 0;
		for (const [heavy, side] of [
			[heavyOnes, 'white'],
			[heavyTwos, 'white'],
			[mirror(heavyOnes), 'black'],
			[mirror(heavyTwos), 'black'],
		] as const) {
			for (let a = 1; a <= 6; a++) {
				for (let b = 1; b <= a; b++) {
					const plays = legalSequences(heavy, side, [a, b]);
					expect(plays.sequences.length).toBeLessThanOrEqual(TAVLA_LEGAL_SEQUENCES_MAX);
					expect(plays.accepted.size).toBeLessThanOrEqual(TAVLA_LEGAL_SEQUENCES_MAX);
					if (a !== b) expect(plays.accepted.size).toBeLessThanOrEqual(450);
					most = Math.max(most, plays.sequences.length);
				}
			}
		}
		expect(legalSequences(mirror(heavyOnes), 'black', [1, 1]).sequences).toHaveLength(2210);
		console.info(`Tavla worst case: ${most} sequences, 84 rolls in ${Math.round(performance.now() - started)} ms`);
	});
});
