// SPDX-License-Identifier: AGPL-3.0-or-later

import {Logger} from '@app/api/Logger';
import {type Rng, TableGameRuleError, type TablePosition} from '@app/api/table_game/engine/TableGameEngine';
import {Tavla, type TavlaState, tavlaGenerations} from '@app/api/table_game/engine/tavla/Tavla';
import {SeededRng} from '@app/api/table_game/engine/tests/SeededRng';
import type {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {TABLE_GAME_TURN_MS} from '@fluxer/constants/src/TableGameConstants';
import {type TableGameAction, TavlaView} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {describe, expect, it, vi} from 'vitest';

const NOW = 1_000_000;
const TURN_MS = TABLE_GAME_TURN_MS.tavla.normal;
const clockAt = (now: number) => ({now, turnMs: TURN_MS});

// Hands out the given values in order and records every call's bound.
function scripted(values: ReadonlyArray<number>): Rng & {calls: Array<number>; left: () => number} {
	const queue = [...values];
	const calls: Array<number> = [];
	return {
		calls,
		left: () => queue.length,
		int(maxExclusive) {
			calls.push(maxExclusive);
			const value = queue.shift();
			if (value === undefined || value >= maxExclusive)
				throw new Error(`script ran out or ${value} >= ${maxExclusive}`);
			return value;
		},
	};
}

function spy(seed: number): Rng & {calls: Array<number>} {
	const inner = new SeededRng(seed);
	const calls: Array<number> = [];
	return {
		calls,
		int(maxExclusive) {
			calls.push(maxExclusive);
			return inner.int(maxExclusive);
		},
	};
}

const noRng: Rng = {
	int: () => {
		throw new Error('no randomness expected here');
	},
};

// White sits at 1; opening 5 against 2, so white starts and rolls 6-5.
const started = (): TavlaState => Tavla.start([1, 3], scripted([0, 4, 1, 5, 4]), clockAt(NOW));

type Counts = Readonly<Record<number, number>>;
function withBoard(
	state: TavlaState,
	spec: {
		white?: Counts;
		black?: Counts;
		bar?: {white?: number; black?: number};
		off?: {white?: number; black?: number};
	},
): TavlaState {
	const points = new Array<number>(24).fill(0);
	for (const [point, count] of Object.entries(spec.white ?? {})) points[Number(point) - 1] = count;
	for (const [point, count] of Object.entries(spec.black ?? {})) points[Number(point) - 1] = -count;
	return {
		...state,
		points,
		bar: {white: spec.bar?.white ?? 0, black: spec.bar?.black ?? 0},
		off: {white: spec.off?.white ?? 0, black: spec.off?.black ?? 0},
	};
}

function tavlaView(state: TavlaState, viewer: TablePosition | null): TavlaView {
	return TavlaView.parse(Tavla.view(state, viewer));
}

const move = (key: string): TableGameAction => ({
	type: 'tavla_move',
	moves: key.split(' ').map((step) => {
		const [from, to] = step.split('/') as [string, string];
		return {from: from === 'bar' ? 'bar' : Number(from), to: to === 'off' ? 'off' : Number(to)};
	}),
});

function rejection(fn: () => unknown): string | null {
	try {
		fn();
	} catch (error) {
		if (error instanceof TableGameRuleError) return error.reason;
		throw error;
	}
	return null;
}

describe('Tavla', () => {
	it('start rolls one die per side, the higher starts and rerolls (T1a); ties reroll', () => {
		// White at 1; 3-3 ties and rerolls; 5 beats 2 so white starts and rolls 6-1.
		const rng = scripted([0, 2, 2, 4, 1, 5, 0]);
		const state = Tavla.start([1, 3], rng, clockAt(NOW));
		expect(rng.left()).toBe(0);
		expect(rng.calls).toEqual([2, 6, 6, 6, 6, 6, 6]);
		expect(state).toMatchObject({white: 1, turn: 1, opening: [5, 2], dice: [6, 1], result: null});
		expect(Tavla.deadline(state)).toBe(NOW + TURN_MS);

		// White at 3, black (at 1) wins the opening 6 against 1.
		const blackStarts = Tavla.start([1, 3], scripted([1, 0, 5, 2, 3]), clockAt(NOW));
		expect(blackStarts).toMatchObject({white: 3, turn: 1, opening: [1, 6], dice: [3, 4]});
		expect(tavlaView(blackStarts, null).opening).toEqual([1, 6]);

		// The opening dice are shown for the first turn only.
		const second = Tavla.apply(started(), 1, move('24/18 18/13'), scripted([0, 1]), clockAt(NOW + 1));
		expect(tavlaView(second, null).opening).toBeNull();
	});

	it('dice come only from rng.int(6) at turn start', () => {
		const rng = spy(7);
		let state = Tavla.start([1, 3], rng, clockAt(NOW));
		expect(rng.calls[0]).toBe(2);
		expect(rng.calls.slice(1).every((bound) => bound === 6)).toBe(true);
		const drawsAtStart = rng.calls.length;
		expect(drawsAtStart % 2).toBe(1);
		for (let turn = 0; turn < 40 && Tavla.result(state) === null; turn++) {
			const mover = state.turn;
			const legal = tavlaView(state, mover).legal_moves!;
			expect(rng.calls.length).toBe(drawsAtStart + 2 * state.turns);
			const before = rng.calls.length;
			expect(rejection(() => Tavla.apply(state, mover === 1 ? 3 : 1, move(legal[0]!), rng, clockAt(NOW)))).toBe(
				'not_your_turn',
			);
			Tavla.view(state, null);
			expect(rng.calls.length).toBe(before);
			state = Tavla.apply(state, mover, move(legal[legal.length - 1]!), rng, clockAt(NOW + turn));
			const drawn = rng.calls.length - before;
			if (Tavla.result(state) === null) {
				expect(drawn).toBeGreaterThanOrEqual(2);
				expect(drawn % 2).toBe(0);
			}
			expect(rng.calls.slice(before).every((bound) => bound === 6)).toBe(true);
		}
	});

	it('state never holds a future roll', () => {
		const state = started();
		expect(Object.keys(state).sort()).toEqual(
			[
				'bar',
				'deadlineAt',
				'dice',
				'lastMoves',
				'off',
				'opening',
				'points',
				'result',
				'timeouts',
				'turn',
				'turns',
				'white',
			].sort(),
		);
		// The same state and move give whatever the rng rolls when the next turn starts.
		const a = Tavla.apply(state, 1, move('24/18 18/13'), scripted([2, 3]), clockAt(NOW + 1));
		const b = Tavla.apply(state, 1, move('24/18 18/13'), scripted([5, 0]), clockAt(NOW + 1));
		expect(a.dice).toEqual([3, 4]);
		expect(b.dice).toEqual([6, 1]);
		expect({...a, dice: null}).toEqual({...b, dice: null});
	});

	it('tavla_move with a full legal sequence applies; a partial or illegal one → illegal_move, state unchanged', () => {
		const state = started();
		const snapshot = JSON.stringify(state);
		expect(rejection(() => Tavla.apply(state, 1, move('24/18'), noRng, clockAt(NOW)))).toBe('illegal_move');
		expect(rejection(() => Tavla.apply(state, 1, move('24/19 19/13'), noRng, clockAt(NOW)))).toBe('illegal_move');
		expect(rejection(() => Tavla.apply(state, 1, move('13/7 13/7'), noRng, clockAt(NOW)))).toBe('illegal_move');
		expect(rejection(() => Tavla.apply(state, 3, move('1/7 1/6'), noRng, clockAt(NOW)))).toBe('not_your_turn');
		expect(rejection(() => Tavla.apply(state, 1, {type: 'draw', from: 'pile'}, noRng, clockAt(NOW)))).toBe(
			'unsupported_action',
		);
		expect(JSON.stringify(state)).toBe(snapshot);

		// Steps in any order: the play is checked as a multiset.
		const next = Tavla.apply(state, 1, move('18/13 24/18'), scripted([0, 1]), clockAt(NOW + 5));
		expect(next.points[23]).toBe(1);
		expect(next.points[12]).toBe(6);
		expect(next.lastMoves).toEqual([
			{from: 24, to: 18, hit: false},
			{from: 18, to: 13, hit: false},
		]);
		expect(next).toMatchObject({turn: 3, dice: [1, 2], deadlineAt: NOW + 5 + TURN_MS, turns: 1});
		expect(JSON.stringify(state)).toBe(snapshot);
	});

	it('any order and decomposition of a legal turn is accepted (6-5 as 24/18 18/13 and 24/19 19/13)', () => {
		// From the real start 19 is black's five-stack, so black's stack sits on 20 here to leave both paths open.
		const open = withBoard(started(), {white: {24: 2, 13: 5, 8: 3, 6: 5}, black: {1: 2, 12: 5, 17: 3, 20: 5}});
		const boards = ['24/18 18/13', '24/19 19/13', '18/13 24/18', '19/13 24/19'].map((key) => {
			const next = Tavla.apply(open, 1, move(key), scripted([0, 1]), clockAt(NOW));
			return JSON.stringify({points: next.points, bar: next.bar, off: next.off});
		});
		expect(new Set(boards).size).toBe(1);
		expect(tavlaView(open, 1).legal_moves!.filter((key) => key.startsWith('24/1') && key.endsWith('/13'))).toHaveLength(
			1,
		);
	});

	it('no legal move → turn passes inside the same apply and the next player is rolled', () => {
		// White's home board is closed and black is on the bar: after 13/12 13/11 black cannot enter.
		const closed = withBoard(
			{...started(), dice: [1, 2]},
			{white: {1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 2, 13: 3}, black: {24: 14}, bar: {black: 1}},
		);
		const rng = scripted([0, 1, 3, 4]);
		const next = Tavla.apply(closed, 1, move('13/12 13/11'), rng, clockAt(NOW));
		expect(rng.left()).toBe(0);
		expect(next).toMatchObject({turn: 1, dice: [4, 5], turns: closed.turns + 2, timeouts: [0, 0, 0, 0]});
		expect(next.lastMoves).toEqual([
			{from: 13, to: 12, hit: false},
			{from: 13, to: 11, hit: false},
		]);

		// A player left with no play (only after a long pass chain) passes on the deadline without a timeout.
		const stuck = withBoard(
			{...started(), turn: 3, dice: [3, 3]},
			{white: {1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 2, 13: 3}, black: {24: 14}, bar: {black: 1}},
		);
		expect(tavlaView(stuck, 3).legal_moves).toEqual([]);
		const passed = Tavla.onDeadline(stuck, scripted([5, 4]), clockAt(NOW + TURN_MS));
		expect(passed).toMatchObject({turn: 1, dice: [6, 5], timeouts: [0, 0, 0, 0]});
	});

	it('a pass chain stops after 16 passes; the stuck player then passes on the deadline (D4)', () => {
		// Both on the bar against closed boards (built, not reachable): every roll passes.
		const locked = withBoard(
			{...started(), dice: [3, 3]},
			{
				white: {1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 2, 13: 2},
				black: {19: 2, 20: 2, 21: 2, 22: 2, 23: 2, 24: 2, 12: 2},
				bar: {white: 1, black: 1},
			},
		);
		const rng = spy(3);
		const chained = Tavla.onDeadline(locked, rng, clockAt(NOW + TURN_MS));
		expect(rng.calls).toHaveLength(2 * 17);
		expect(chained).toMatchObject({turn: 3, turns: locked.turns + 17, timeouts: [0, 0, 0, 0], result: null});
		expect(tavlaView(chained, 3).legal_moves).toEqual([]);
		expect(Tavla.deadline(chained)).toBe(NOW + 2 * TURN_MS);
		const again = Tavla.onDeadline(chained, rng, clockAt(NOW + 2 * TURN_MS));
		expect(again).toMatchObject({turn: 1, turns: locked.turns + 34, timeouts: [0, 0, 0, 0]});
	});

	it('bear-off of all 15 → win bear_off; loser with none off → finish mars (T2)', () => {
		const last = withBoard({...started(), dice: [1, 2]}, {white: {1: 1}, black: {24: 15}, off: {white: 14}});
		const mars = Tavla.apply(last, 1, move('1/off'), noRng, clockAt(NOW));
		expect(Tavla.result(mars)).toEqual({kind: 'win', winners: [1], reason: 'bear_off', finish: 'mars'});
		expect(Tavla.deadline(mars)).toBeNull();
		const view = tavlaView(mars, 1);
		expect(view).toMatchObject({turn: null, dice: null, deadline_at: null, legal_moves: null});
		expect(view.off).toEqual({white: 15, black: 0});

		const plain = withBoard(last, {white: {1: 1}, black: {24: 12}, off: {white: 14, black: 3}});
		expect(Tavla.result(Tavla.apply(plain, 1, move('1/off'), noRng, clockAt(NOW)))).toEqual({
			kind: 'win',
			winners: [1],
			reason: 'bear_off',
		});

		// T9: resigning never counts as mars.
		expect(Tavla.result(Tavla.apply(started(), 3, {type: 'resign'}, noRng, clockAt(NOW)))).toEqual({
			kind: 'win',
			winners: [1],
			reason: 'resign',
		});
		expect(rejection(() => Tavla.apply(mars, 3, {type: 'resign'}, noRng, clockAt(NOW)))).toBe('game_over');
	});

	it('timeout plays the first canonical sequence and counts; second consecutive → forfeit timeouts; own move resets', () => {
		const state = started();
		const first = tavlaView(state, 1).legal_moves![0]!;
		expect(first).toBe('24/18 18/13');
		const timedOut = Tavla.onDeadline(state, scripted([0, 1]), clockAt(NOW + TURN_MS));
		expect(timedOut).toMatchObject({turn: 3, timeouts: [1, 0, 0, 0], dice: [1, 2]});
		expect(timedOut.lastMoves.map(({from, to}) => `${from}/${to}`).join(' ')).toBe(first);

		const blackMoves = (s: TavlaState, rng: Rng) =>
			Tavla.apply(s, 3, move(tavlaView(s, 3).legal_moves![0]!), rng, clockAt(NOW + TURN_MS + 1));
		const backToWhite = blackMoves(timedOut, scripted([3, 2]));
		expect(backToWhite).toMatchObject({turn: 1, timeouts: [1, 0, 0, 0]});

		const forfeited = Tavla.onDeadline(backToWhite, noRng, clockAt(NOW + 3 * TURN_MS));
		expect(Tavla.result(forfeited)).toEqual({kind: 'forfeit', loser: 1, reason: 'timeouts'});
		expect(forfeited.timeouts).toEqual([2, 0, 0, 0]);

		const reset = Tavla.apply(
			backToWhite,
			1,
			move(tavlaView(backToWhite, 1).legal_moves![0]!),
			scripted([0, 1]),
			clockAt(NOW + 2 * TURN_MS),
		);
		expect(reset.timeouts).toEqual([0, 0, 0, 0]);
	});

	it('view: legal_moves only for the mover; parses strictly', () => {
		const state = started();
		const mover = tavlaView(state, 1);
		expect(mover.legal_moves!.length).toBeGreaterThan(0);
		expect(mover).toMatchObject({
			game: 'tavla',
			white: 1,
			turn: 1,
			dice: [6, 5],
			opening: [5, 2],
			last_moves: [],
			deadline_at: new Date(NOW + TURN_MS).toISOString(),
		});
		expect(tavlaView(state, 3).legal_moves).toBeNull();
		expect(tavlaView(state, null).legal_moves).toBeNull();
		expect({...tavlaView(state, 3), legal_moves: mover.legal_moves}).toEqual(mover);

		const forfeited = Tavla.forfeit(state, 3, 'leave');
		expect(Tavla.result(forfeited)).toEqual({kind: 'forfeit', loser: 3, reason: 'leave'});
		expect(Tavla.forfeit(forfeited, 1, 'disconnect')).toBe(forfeited);
		expect(Tavla.result(Tavla.cancel(state, 'disabled'))).toEqual({kind: 'canceled', reason: 'disabled'});
		expect(tavlaView(forfeited, 1)).toMatchObject({turn: null, dice: null, legal_moves: null, deadline_at: null});
	});

	// The heaviest 1-1 position a search found (TavlaProperty): 2210 distinct plays, about 52 KB of legal_moves.
	const heavyOnes = (): TavlaState => ({
		...withBoard(started(), {
			white: {2: 1, 4: 1, 6: 1, 8: 1, 10: 1, 11: 1, 12: 1, 14: 1, 15: 1, 16: 1, 18: 1, 20: 1, 22: 1, 23: 1, 24: 1},
			black: {13: 1},
			off: {black: 14},
		}),
		dice: [1, 1],
	});

	it('a huge doubles position is computed but not cached; a small one stays cached', () => {
		const before = tavlaGenerations();
		expect(tavlaView(heavyOnes(), 1).legal_moves).toHaveLength(2210);
		expect(tavlaView(heavyOnes(), 1).legal_moves).toHaveLength(2210);
		expect(tavlaGenerations()).toBe(before + 2);
		tavlaView(started(), 1);
		const held = tavlaGenerations();
		tavlaView(started(), 1);
		expect(tavlaGenerations()).toBe(held);
	});

	it('a generation past 16 KB of legal_moves logs one warning carrying counts only', () => {
		const warn = vi.spyOn(Logger.child({}) as NoopLogger, 'warn');
		try {
			// All home, 3-3: a fresh small generation, no warning.
			const small: TavlaState = {...withBoard(started(), {white: {4: 5, 5: 5, 6: 5}, black: {19: 15}}), dice: [3, 3]};
			const generated = tavlaGenerations();
			tavlaView(small, 1);
			expect(tavlaGenerations()).toBe(generated + 1);
			expect(warn).not.toHaveBeenCalled();
			const huge = tavlaView(heavyOnes(), 1);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn).toHaveBeenCalledWith(
				{sequences: 2210, bytes: JSON.stringify(huge.legal_moves).length, generations: tavlaGenerations()},
				'Tavla legal moves over 16 KB',
			);
		} finally {
			warn.mockRestore();
		}
	});
});
