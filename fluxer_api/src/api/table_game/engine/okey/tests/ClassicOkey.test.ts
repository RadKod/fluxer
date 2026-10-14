// SPDX-License-Identifier: AGPL-3.0-or-later

import {ClassicOkey, type ClassicOkeyState} from '@app/api/table_game/engine/okey/ClassicOkey';
import {isOkey, okeyFaceOf} from '@app/api/table_game/engine/okey/OkeyDeck';
import {TableGameRuleError, type TablePosition} from '@app/api/table_game/engine/TableGameEngine';
import {
	assertTileConservation,
	deckTokensOf,
	rackTokensOf,
	tokensIn,
} from '@app/api/table_game/engine/tests/EngineInvariants';
import {SeededRng} from '@app/api/table_game/engine/tests/SeededRng';
import {okeyTileToken} from '@fluxer/constants/src/TableGameConstants';
import {OkeyView, type TableGameAction} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {describe, expect, it} from 'vitest';

// colors: 0 yellow, 1 blue, 2 black, 3 red
const tile = (color: number, number: number, copy = 0) => copy * 52 + color * 13 + number - 1;
const Y = (n: number, copy = 0) => tile(0, n, copy);
const B = (n: number, copy = 0) => tile(1, n, copy);
const K = (n: number, copy = 0) => tile(2, n, copy);
const R = (n: number, copy = 0) => tile(3, n, copy);
const t = okeyTileToken;

const START = Date.parse('2026-10-03T12:00:00.000Z');
const TURN_MS = 30_000;
const clock = (now = START) => ({now, turnMs: TURN_MS});
const rng = new SeededRng(99);

function started(seed: number): ClassicOkeyState {
	return ClassicOkey.start([1, 2, 3, 4], new SeededRng(seed), clock());
}

function act(state: ClassicOkeyState, actor: TablePosition, action: TableGameAction, now = START): ClassicOkeyState {
	return ClassicOkey.apply(state, actor, action, rng, clock(now));
}

function ruleError(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		if (error instanceof TableGameRuleError) return error.reason;
		throw error;
	}
	throw new Error('expected a TableGameRuleError');
}

const next = (p: TablePosition) => ((p % 4) + 1) as TablePosition;

// Indicator yellow 5, okey yellow 6. Position 1 starts in the discard phase with `starterRack`;
// the other tiles fill racks 2..4 (14 each) and the pile, so all 106 tiles stay accounted for.
function arranged(starterRack: Array<number>): ClassicOkeyState {
	const indicator = Y(5);
	const rest = Array.from({length: 106}, (_, id) => id).filter((id) => id !== indicator && !starterRack.includes(id));
	return {
		indicator,
		pile: rest.slice(42),
		racks: [starterRack, rest.slice(0, 14), rest.slice(14, 28), rest.slice(28, 42)],
		discards: [[], [], [], []],
		turn: 1,
		phase: 'discard',
		lastReceived: starterRack[starterRack.length - 1]!,
		deadlineAt: START + TURN_MS,
		timeouts: [0, 0, 0, 0],
		turns: 0,
		result: null,
	};
}

const SETS_HAND = [
	[B(1), B(2), B(3), B(4)],
	[R(10), R(11), R(12), R(13)],
	[Y(7), B(7), K(7)],
	[K(9), K(10), K(11)],
];
const OKEY_TILE = Y(6);

function okeyTileOf(state: ClassicOkeyState): number {
	const face = okeyFaceOf(state.indicator);
	return face.color * 13 + face.number - 1;
}

function swapTiles(state: ClassicOkeyState, a: number, b: number): ClassicOkeyState {
	const swap = (id: number) => (id === a ? b : id === b ? a : id);
	return {
		...state,
		pile: state.pile.map(swap),
		racks: state.racks.map((rack) => rack.map(swap)),
		discards: state.discards.map((pile) => pile.map(swap)),
	};
}

describe('ClassicOkey', () => {
	it('deal: starter 15, others 14, indicator out, pile 48', () => {
		for (let seed = 1; seed <= 20; seed++) {
			const state = started(seed);
			const starter = state.turn;
			expect(state.racks.map((rack) => rack.length)).toEqual(
				([1, 2, 3, 4] as const).map((position) => (position === starter ? 15 : 14)),
			);
			expect(state.pile).toHaveLength(48);
			expect(state.indicator).toBeLessThan(104);
			expect(state.pile).not.toContain(state.indicator);
			for (const rack of state.racks) expect(rack).not.toContain(state.indicator);
			expect(state.phase).toBe('discard');
			expect(state.deadlineAt).toBe(START + TURN_MS);
			expect(ClassicOkey.deadline(state)).toBe(START + TURN_MS);
			assertTileConservation(state);
		}
		const starters = new Set(Array.from({length: 40}, (_, k) => started(k + 1).turn));
		expect(starters.size).toBe(4);
	});

	it('starter discards without drawing', () => {
		const state = started(3);
		const starter = state.turn;
		expect(ruleError(() => act(state, starter, {type: 'draw', from: 'pile'}))).toBe('wrong_phase');
		const thrown = state.racks[starter - 1]![0]!;
		const after = act(state, starter, {type: 'discard', tile: t(thrown)}, START + 5_000);
		expect(after.racks[starter - 1]).toHaveLength(14);
		expect(after.discards[starter - 1]).toEqual([thrown]);
		expect(after.turn).toBe(next(starter));
		expect(after.phase).toBe('draw');
		expect(after.deadlineAt).toBe(START + 5_000 + TURN_MS);
		assertTileConservation(after);
	});

	it("draw from discard takes only the previous player's last discard", () => {
		let state = started(4);
		const starter = state.turn;
		const firstThrow = state.racks[starter - 1]![0]!;
		state = act(state, starter, {type: 'discard', tile: t(firstThrow)});
		for (let k = 0; k < 4; k++) {
			const actor = state.turn;
			state = act(state, actor, {type: 'draw', from: 'pile'});
			state = act(state, actor, {type: 'discard', tile: t(state.lastReceived!)});
		}
		const actor = state.turn;
		expect(actor).toBe(next(starter));
		const secondThrow = state.discards[starter - 1]!.at(-1)!;
		expect(state.discards[starter - 1]).toEqual([firstThrow, secondThrow]);
		const before = JSON.stringify(state);
		const after = act(state, actor, {type: 'draw', from: 'discard'});
		expect(JSON.stringify(state)).toBe(before);
		expect(after.racks[actor - 1]).toContain(secondThrow);
		expect(after.racks[actor - 1]).not.toContain(firstThrow);
		expect(after.discards[starter - 1]).toEqual([firstThrow]);
		expect(after.lastReceived).toBe(secondThrow);
		expect(after.pile).toEqual(state.pile);
		assertTileConservation(after);
	});

	it('finish with 14 tiles in sets + discard ends with winner', () => {
		const state = arranged([...SETS_HAND.flat(), R(5)]);
		const after = act(state, 1, {type: 'finish', tile: t(R(5)), sets: SETS_HAND.map((set) => set.map(t))});
		expect(ClassicOkey.result(after)).toEqual({kind: 'win', winners: [1], reason: 'finish', finish: 'normal'});
		expect(ClassicOkey.deadline(after)).toBeNull();
		expect(after.discards[0]).toEqual([R(5)]);
		expect(ClassicOkey.view(after, null)).toMatchObject({turn: null, deadline_at: null});
		assertTileConservation(after);
	});

	it("finish with seven pairs → finish 'pairs'", () => {
		const pairs = [B(1), B(2), K(3), K(4), R(8), R(9), Y(11)].map((id) => [id, id + 52]);
		const state = arranged([...pairs.flat(), R(5)]);
		const after = act(state, 1, {type: 'finish', tile: t(R(5)), sets: pairs.map((pair) => pair.map(t))});
		expect(ClassicOkey.result(after)).toEqual({kind: 'win', winners: [1], reason: 'finish', finish: 'pairs'});
		const withOkey = [...pairs.slice(0, 6), [Y(11), OKEY_TILE]];
		const okeyPairs = arranged([...withOkey.flat(), R(5)]);
		expect(
			ClassicOkey.result(act(okeyPairs, 1, {type: 'finish', tile: t(R(5)), sets: withOkey.map((pair) => pair.map(t))})),
		).toMatchObject({kind: 'win', finish: 'pairs'});
	});

	it("finishing tile okey → finish 'okey'", () => {
		const state = arranged([...SETS_HAND.flat(), OKEY_TILE]);
		const after = act(state, 1, {type: 'finish', tile: t(OKEY_TILE), sets: SETS_HAND.map((set) => set.map(t))});
		expect(ClassicOkey.result(after)).toEqual({kind: 'win', winners: [1], reason: 'finish', finish: 'okey'});
		// an okey inside a set is a plain wildcard and the finish stays normal
		const sets = [[B(1), OKEY_TILE, B(3), B(4)], ...SETS_HAND.slice(1)];
		const wild = arranged([...sets.flat(), B(2)]);
		expect(
			ClassicOkey.result(act(wild, 1, {type: 'finish', tile: t(B(2)), sets: sets.map((set) => set.map(t))})),
		).toMatchObject({finish: 'normal'});
	});

	it('invalid finish → invalid_meld, state unchanged', () => {
		const state = arranged([...SETS_HAND.flat(), R(5)]);
		const before = JSON.stringify(state);
		const finish = (tileId: number, sets: Array<Array<number>>) => () =>
			act(state, 1, {type: 'finish', tile: t(tileId), sets: sets.map((set) => set.map(t))});
		const broken = [
			[B(1), B(2), B(3), B(4)],
			[R(10), R(11), R(12), R(13)],
			[Y(7), B(7), K(9)],
			[K(7), K(10), K(11)],
		];
		expect(ruleError(finish(R(5), broken))).toBe('invalid_meld');
		expect(ruleError(finish(R(5), SETS_HAND.slice(0, 3)))).toBe('invalid_meld');
		expect(ruleError(finish(R(5), [...SETS_HAND.slice(0, 3), [K(9), K(10), K(11), R(5)]]))).toBe('invalid_meld');
		expect(ruleError(finish(R(5), [...SETS_HAND.slice(0, 3), [K(9), K(10), K(11), K(12)]]))).toBe('tile_not_in_rack');
		expect(ruleError(finish(R(6), SETS_HAND))).toBe('tile_not_in_rack');
		const mixed = [[B(1), B(2)], [B(3), B(4)], ...SETS_HAND.slice(1)];
		expect(ruleError(finish(R(5), mixed))).toBe('invalid_meld');
		expect(JSON.stringify(state)).toBe(before);
		expect(ruleError(() => act(state, 2, {type: 'finish', tile: t(R(5)), sets: [[t(R(5))]]}))).toBe('not_your_turn');
	});

	it('pile empty at draw phase → draw pile_empty', () => {
		const lastTile = started(6);
		const starter = lastTile.turn;
		const drained: ClassicOkeyState = {
			...lastTile,
			pile: lastTile.pile.slice(-1),
			discards: lastTile.discards.map((pile, index) => (index === 3 ? lastTile.pile.slice(0, -1) : pile)),
		};
		assertTileConservation(drained);
		let state = act(drained, starter, {type: 'discard', tile: t(drained.racks[starter - 1]![0]!)});
		expect(ClassicOkey.result(state)).toBeNull();
		const actor = state.turn;
		state = act(state, actor, {type: 'draw', from: 'pile'});
		expect(state.pile).toHaveLength(0);
		state = act(state, actor, {type: 'discard', tile: t(state.lastReceived!)});
		expect(ClassicOkey.result(state)).toEqual({kind: 'draw', reason: 'pile_empty'});
		expect(ClassicOkey.deadline(state)).toBeNull();
		assertTileConservation(state);
	});

	it('timeout in draw phase draws from pile and discards the drawn tile (not the okey)', () => {
		const first = started(7);
		const starter = first.turn;
		const state = act(first, starter, {type: 'discard', tile: t(first.racks[starter - 1]![0]!)});
		const actor = state.turn;
		const top = state.pile.at(-1)!;
		const okeyTile = okeyTileOf(state);
		expect(isOkey(top, okeyFaceOf(state.indicator))).toBe(false);
		const later = START + 31_000;
		const after = ClassicOkey.onDeadline(state, rng, clock(later));
		expect(after.racks[actor - 1]).toEqual(state.racks[actor - 1]);
		expect(after.discards[actor - 1]).toEqual([top]);
		expect(after.pile).toHaveLength(state.pile.length - 1);
		expect(after.turn).toBe(next(actor));
		expect(after.phase).toBe('draw');
		expect(after.timeouts[actor - 1]).toBe(1);
		expect(after.deadlineAt).toBe(later + TURN_MS);
		assertTileConservation(after);

		const rigged = swapTiles(state, top, okeyTile);
		expect(rigged.pile.at(-1)).toBe(okeyTile);
		const okeyDraw = ClassicOkey.onDeadline(rigged, rng, clock(later));
		expect(okeyDraw.racks[actor - 1]).toContain(okeyTile);
		expect(okeyDraw.discards[actor - 1]).toEqual([
			rigged.racks[actor - 1]!.find((id) => !isOkey(id, okeyFaceOf(state.indicator))),
		]);
		assertTileConservation(okeyDraw);
	});

	it('timeout in discard phase discards the last received tile', () => {
		const first = started(8);
		const starter = first.turn;
		const okey = okeyFaceOf(first.indicator);
		const dealtLast = first.racks[starter - 1]!.at(-1)!;
		expect(first.lastReceived).toBe(dealtLast);
		expect(isOkey(dealtLast, okey)).toBe(false);
		const starterTimedOut = ClassicOkey.onDeadline(first, rng, clock(START + 31_000));
		expect(starterTimedOut.discards[starter - 1]).toEqual([dealtLast]);

		const actor = starterTimedOut.turn;
		const drawn = act(starterTimedOut, actor, {type: 'draw', from: 'pile'}, START + 32_000);
		const received = drawn.lastReceived!;
		expect(isOkey(received, okey)).toBe(false);
		const after = ClassicOkey.onDeadline(drawn, rng, clock(START + 70_000));
		expect(after.discards[actor - 1]).toEqual([received]);
		expect(after.racks[actor - 1]).toEqual(starterTimedOut.racks[actor - 1]);
		expect(after.turn).toBe(next(actor));
		assertTileConservation(after);
	});

	it('second consecutive timeout → forfeit timeouts', () => {
		let state = started(9);
		const starter = state.turn;
		state = ClassicOkey.onDeadline(state, rng, clock());
		expect(state.timeouts[starter - 1]).toBe(1);
		for (let k = 0; k < 3; k++) {
			const actor = state.turn;
			state = act(state, actor, {type: 'draw', from: 'pile'});
			state = act(state, actor, {type: 'discard', tile: t(state.lastReceived!)});
		}
		expect(state.turn).toBe(starter);
		state = ClassicOkey.onDeadline(state, rng, clock());
		expect(ClassicOkey.result(state)).toEqual({kind: 'forfeit', loser: starter, reason: 'timeouts'});
		expect(ClassicOkey.deadline(state)).toBeNull();
		assertTileConservation(state);
	});

	it('own action resets the timeout counter', () => {
		let state = started(10);
		const starter = state.turn;
		state = ClassicOkey.onDeadline(state, rng, clock());
		for (let k = 0; k < 3; k++) {
			const actor = state.turn;
			state = act(state, actor, {type: 'draw', from: 'pile'});
			state = act(state, actor, {type: 'discard', tile: t(state.lastReceived!)});
		}
		state = act(state, starter, {type: 'draw', from: 'pile'});
		expect(state.timeouts[starter - 1]).toBe(0);
		state = ClassicOkey.onDeadline(state, rng, clock());
		expect(ClassicOkey.result(state)).toBeNull();
		expect(state.timeouts[starter - 1]).toBe(1);
	});

	it('forfeit leave ends with loser', () => {
		const state = started(11);
		const after = ClassicOkey.forfeit(state, 2, 'leave');
		expect(ClassicOkey.result(after)).toEqual({kind: 'forfeit', loser: 2, reason: 'leave'});
		expect(ClassicOkey.deadline(after)).toBeNull();
		expect(ClassicOkey.forfeit(after, 3, 'disconnect')).toBe(after);
		expect(ClassicOkey.result(ClassicOkey.forfeit(state, 4, 'disconnect'))).toEqual({
			kind: 'forfeit',
			loser: 4,
			reason: 'disconnect',
		});
		expect(ClassicOkey.result(ClassicOkey.cancel(state, 'theme_changed'))).toEqual({
			kind: 'canceled',
			reason: 'theme_changed',
		});
		expect(ClassicOkey.result(state)).toBeNull();
	});

	it('actions after end → game_over', () => {
		const state = ClassicOkey.cancel(started(12), 'disabled');
		const actor = state.turn;
		expect(ruleError(() => act(state, actor, {type: 'discard', tile: t(state.racks[actor - 1]![0]!)}))).toBe(
			'game_over',
		);
		expect(ruleError(() => act(state, actor, {type: 'draw', from: 'pile'}))).toBe('game_over');
		expect(ClassicOkey.onDeadline(state, rng, clock())).toBe(state);
		expect(ClassicOkey.cancel(state, 'abandoned')).toBe(state);
	});

	it('rejects out-of-turn, wrong-phase, foreign-tile and unsupported actions', () => {
		const state = started(13);
		const starter = state.turn;
		const other = next(starter);
		const before = JSON.stringify(state);
		expect(ruleError(() => act(state, other, {type: 'discard', tile: t(state.racks[other - 1]![0]!)}))).toBe(
			'not_your_turn',
		);
		expect(ruleError(() => act(state, starter, {type: 'discard', tile: t(state.pile[0]!)}))).toBe('tile_not_in_rack');
		expect(ruleError(() => act(state, starter, {type: 'discard', tile: t(state.indicator)}))).toBe('tile_not_in_rack');
		for (const action of [
			{type: 'tick'},
			{type: 'meld', open: [[t(1), t(2), t(3)]]},
			{type: 'take_discard'},
			{type: 'move', from: 'e2', to: 'e4'},
			{type: 'resign'},
		] as Array<TableGameAction>) {
			expect(ruleError(() => act(state, starter, action))).toBe('unsupported_action');
		}
		const drawPhase = act(state, starter, {type: 'discard', tile: t(state.racks[starter - 1]![0]!)});
		expect(ruleError(() => act(drawPhase, other, {type: 'discard', tile: t(drawPhase.racks[other - 1]![0]!)}))).toBe(
			'wrong_phase',
		);
		expect(JSON.stringify(state)).toBe(before);
	});

	it('view: own rack only; others null; deck order absent', () => {
		let state = started(14);
		const starter = state.turn;
		state = act(state, starter, {type: 'discard', tile: t(state.racks[starter - 1]![0]!)});
		for (const viewer of [1, 2, 3, 4, null] as const) {
			const view = ClassicOkey.view(state, viewer);
			expect(OkeyView.parse(view)).toEqual(view); // strictObject: no field beyond the contract
			expect(Object.keys(view!).sort()).toEqual(
				['deadline_at', 'discards', 'game', 'indicator', 'phase', 'pile_count', 'rack', 'rack_counts', 'turn'].sort(),
			);
			expect(view).toMatchObject({
				game: 'okey',
				indicator: t(state.indicator),
				pile_count: 48,
				rack_counts: state.racks.map((rack) => rack.length),
				turn: state.turn,
				phase: 'draw',
				deadline_at: new Date(state.deadlineAt).toISOString(),
				rack: viewer === null ? null : state.racks[viewer - 1]!.map(t),
			});
			const seen = tokensIn(JSON.stringify(view));
			for (const other of [1, 2, 3, 4] as const) {
				if (other !== viewer) for (const token of rackTokensOf(state, other)) expect(seen.has(token)).toBe(false);
			}
			for (const token of deckTokensOf(state)) expect(seen.has(token)).toBe(false);
		}
	});
});
