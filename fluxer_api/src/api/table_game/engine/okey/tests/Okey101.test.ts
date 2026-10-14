// SPDX-License-Identifier: AGPL-3.0-or-later

import {Okey101, type Okey101State, type Okey101TableMeld, setPoints} from '@app/api/table_game/engine/okey/Okey101';
import {OKEY101_RULES} from '@app/api/table_game/engine/okey/Okey101Rules';
import {okeyFaceOf} from '@app/api/table_game/engine/okey/OkeyDeck';
import {TableGameRuleError, type TablePosition} from '@app/api/table_game/engine/TableGameEngine';
import {
	assertTileConservation,
	deckTokensOf,
	rackTokensOf,
	tokensIn,
} from '@app/api/table_game/engine/tests/EngineInvariants';
import {SeededRng} from '@app/api/table_game/engine/tests/SeededRng';
import {okeyTileToken, TABLE_GAME_TURN_MS} from '@fluxer/constants/src/TableGameConstants';
import {Okey101View, type TableGameAction} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {describe, expect, it} from 'vitest';

// colors: 0 yellow, 1 blue, 2 black, 3 red
const tile = (color: number, number: number, copy = 0) => copy * 52 + color * 13 + number - 1;
const Y = (n: number, copy = 0) => tile(0, n, copy);
const B = (n: number, copy = 0) => tile(1, n, copy);
const K = (n: number, copy = 0) => tile(2, n, copy);
const R = (n: number, copy = 0) => tile(3, n, copy);
const t = okeyTileToken;
const ts = (tiles: ReadonlyArray<number>) => tiles.map(t);

const START = Date.parse('2026-10-03T12:00:00.000Z');
const TURN_MS = TABLE_GAME_TURN_MS.okey101.normal;
const clock = (now = START) => ({now, turnMs: TURN_MS});
const rng = new SeededRng(99);

// Indicator yellow 5: the okey is yellow 6, so Y(6) and Y(6, 1) are wild and the fake okeys play as yellow 6.
const INDICATOR = Y(5);
const OKEY = Y(6);
const OKEY_2 = Y(6, 1);
const FAKE = 104;
const OKEY_FACE = okeyFaceOf(INDICATOR);

const RUN_R10_13 = [R(10), R(11), R(12), R(13)]; // 46
const GROUP_13 = [Y(13), B(13), K(13)]; // 39
const RUN_B4_6 = [B(4), B(5), B(6)]; // 15: with the two above 100
const RUN_B4_7 = [B(4), B(5), B(6), B(7)]; // 22: with the two above 107

interface Arrangement {
	racks?: Partial<Record<TablePosition, Array<number>>>;
	discards?: Array<Array<number>>;
	melds?: Array<Okey101TableMeld>;
	pileTop?: Array<number>; // drawn next: the last element
	state?: Partial<Okey101State>;
}

// Position 1 to act in the play phase, nobody opened. Racks not given get 21 leftover tiles each and the
// rest lies under `pileTop`, so all 106 tiles stay accounted for.
function arranged(spec: Arrangement = {}): Okey101State {
	const placed = new Set([
		INDICATOR,
		...Object.values(spec.racks ?? {}).flat(),
		...(spec.discards ?? []).flat(),
		...(spec.melds ?? []).flatMap((meld) => meld.tiles),
		...(spec.pileTop ?? []),
	]);
	const rest = Array.from({length: 106}, (_, id) => id).filter((id) => !placed.has(id));
	const racks = ([1, 2, 3, 4] as const).map((position) => spec.racks?.[position] ?? rest.splice(0, 21));
	const state: Okey101State = {
		indicator: INDICATOR,
		pile: [...rest, ...(spec.pileTop ?? [])],
		racks,
		discards: spec.discards ?? [[], [], [], []],
		melds: spec.melds ?? [],
		turn: 1,
		phase: 'play',
		drawn: null,
		opened: ['none', 'none', 'none', 'none'],
		openedAt: [null, null, null, null],
		penalties: [0, 0, 0, 0],
		deadlineAt: START + TURN_MS,
		timeouts: [0, 0, 0, 0],
		turns: 0,
		scores: null,
		result: null,
		...spec.state,
	};
	assertTileConservation(state);
	return state;
}

// Every position opened with sets on an earlier turn; it is now turn 4.
const OPENED_EARLIER: Partial<Okey101State> = {
	opened: ['sets', 'sets', 'sets', 'sets'],
	openedAt: [0, 0, 0, 0],
	turns: 4,
};

function act(state: Okey101State, actor: TablePosition, action: TableGameAction, now = START): Okey101State {
	return Okey101.apply(state, actor, action, rng, clock(now));
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

// The rule error of `action`, after checking it left the state untouched.
function rejected(state: Okey101State, actor: TablePosition, action: TableGameAction): string {
	const before = JSON.stringify(state);
	const reason = ruleError(() => act(state, actor, action));
	expect(JSON.stringify(state)).toBe(before);
	return reason;
}

const meldOpen = (...sets: Array<ReadonlyArray<number>>): TableGameAction => ({type: 'meld', open: sets.map(ts)});
const add = (meldId: number, tiles: Array<number>, at: 'start' | 'end') => ({meld_id: meldId, tiles: ts(tiles), at});

// Positions 2..4 draw and throw a tile each, then position 1 draws: back to position 1's play phase.
function roundTrip(state: Okey101State, myDiscard: number): Okey101State {
	let s = act(state, 1, {type: 'discard', tile: t(myDiscard)});
	for (const position of [2, 3, 4] as const) {
		s = act(s, position, {type: 'draw', from: 'pile'});
		s = act(s, position, {type: 'discard', tile: t(s.drawn!)});
	}
	return act(s, 1, {type: 'draw', from: 'pile'});
}

describe('Okey101', () => {
	it('deal 22/21, pile 20', () => {
		const starters = new Set<number>();
		for (let seed = 1; seed <= 40; seed++) {
			const state = Okey101.start([1, 2, 3, 4], new SeededRng(seed), clock());
			starters.add(state.turn);
			expect(state.racks.map((rack) => rack.length)).toEqual(
				([1, 2, 3, 4] as const).map((position) => (position === state.turn ? 22 : 21)),
			);
			expect(state.pile).toHaveLength(20);
			expect(state.indicator).toBeLessThan(104);
			expect(state.phase).toBe('play'); // the starter plays without drawing
			expect(state.opened).toEqual(['none', 'none', 'none', 'none']);
			expect(Okey101.deadline(state)).toBe(START + TURN_MS);
			assertTileConservation(state);
		}
		expect(starters.size).toBe(4);
	});

	it('open with sets ≥101 points', () => {
		const opening = [[R(10), OKEY, R(12), R(13)], GROUP_13, RUN_B4_7]; // the okey counts as red 11: 46 + 39 + 22
		const state = arranged({racks: {1: [...opening.flat(), K(2), Y(9)]}});
		const after = act(state, 1, meldOpen(...opening));
		expect(after.opened).toEqual(['sets', 'none', 'none', 'none']);
		expect(after.openedAt).toEqual([0, null, null, null]);
		expect(after.melds).toEqual([
			{owner: 1, kind: 'run', tiles: opening[0]},
			{owner: 1, kind: 'group', tiles: GROUP_13},
			{owner: 1, kind: 'run', tiles: RUN_B4_7},
		]);
		expect(after.racks[0]).toEqual([K(2), Y(9)]);
		expect(after).toMatchObject({turn: 1, phase: 'play', penalties: [0, 0, 0, 0]});
		assertTileConservation(after);
	});

	it('open below 101 → open_too_low', () => {
		const state = arranged({racks: {1: [...RUN_R10_13, ...GROUP_13, ...RUN_B4_6, K(2)]}});
		expect(rejected(state, 1, meldOpen(RUN_R10_13, GROUP_13, RUN_B4_6))).toBe('open_too_low');
	});

	it('set points: the okey is worth the tile it replaces, a 1 after 13 is worth ACE_AFTER_KING_POINTS', () => {
		expect(setPoints([R(10), OKEY, R(12)], OKEY_FACE)).toBe(33);
		expect(setPoints([Y(13), OKEY, K(13), FAKE], OKEY_FACE)).toBeNull(); // the fake okey plays as yellow 6
		expect(setPoints([K(12), K(13), K(1)], OKEY_FACE)).toBe(25 + OKEY101_RULES.ACE_AFTER_KING_POINTS);
		expect(setPoints([K(12), K(13), OKEY], OKEY_FACE)).toBe(25 + OKEY101_RULES.ACE_AFTER_KING_POINTS);
		expect(setPoints([K(1), K(2), K(3)], OKEY_FACE)).toBe(6);
		expect(setPoints([B(5), B(6)], OKEY_FACE)).toBeNull();
		expect(OKEY101_RULES.ACE_AFTER_KING_POINTS).toBe(1);
	});

	it('open with 5 pairs', () => {
		const pairs = [
			[B(3), B(3, 1)],
			[R(8), R(8, 1)],
			[K(1), K(1, 1)],
			[Y(2), Y(2, 1)],
			[B(11), OKEY],
		];
		const state = arranged({racks: {1: [...pairs.flat(), K(9), R(4)]}});
		const after = act(state, 1, meldOpen(...pairs));
		expect(after.opened[0]).toBe('pairs');
		expect(after.melds.map((meld) => meld.kind)).toEqual(['pair', 'pair', 'pair', 'pair', 'pair']);
		expect(after.racks[0]).toEqual([K(9), R(4)]);
		expect(rejected(state, 1, meldOpen(...pairs.slice(0, 4)))).toBe('pairs_too_few');
		expect(rejected(state, 1, meldOpen(...pairs.slice(0, 4), [K(9), R(4)]))).toBe('invalid_meld');
	});

	it('sets and pairs cannot mix in one opening', () => {
		const state = arranged({racks: {1: [...RUN_R10_13, ...GROUP_13, ...RUN_B4_7, B(3), B(3, 1), K(2)]}});
		expect(rejected(state, 1, meldOpen(RUN_R10_13, GROUP_13, RUN_B4_7, [B(3), B(3, 1)]))).toBe('invalid_meld');
	});

	it('after opening, set openers lay only sets and pair openers only pairs, with no minimum', () => {
		const rack = [K(1), K(2), K(3), B(3), B(3, 1), R(9)];
		const sets = arranged({racks: {1: rack}, state: OPENED_EARLIER});
		expect(act(sets, 1, meldOpen([K(1), K(2), K(3)])).melds).toEqual([
			{owner: 1, kind: 'run', tiles: [K(1), K(2), K(3)]},
		]);
		expect(rejected(sets, 1, meldOpen([B(3), B(3, 1)]))).toBe('invalid_meld');
		const pairs = arranged({racks: {1: rack}, state: {...OPENED_EARLIER, opened: ['pairs', 'sets', 'sets', 'sets']}});
		expect(act(pairs, 1, meldOpen([B(3), B(3, 1)])).melds).toEqual([{owner: 1, kind: 'pair', tiles: [B(3), B(3, 1)]}]);
		expect(rejected(pairs, 1, meldOpen([K(1), K(2), K(3)]))).toBe('invalid_meld');
	});

	it('a meld must leave a tile to discard → must_finish_with_discard', () => {
		const state = arranged({racks: {1: [...RUN_R10_13, ...GROUP_13, ...RUN_B4_7]}});
		expect(rejected(state, 1, meldOpen(RUN_R10_13, GROUP_13, RUN_B4_7))).toBe('must_finish_with_discard');
	});

	it('take_discard must use the taken tile in open/add else take_unused (state unchanged)', () => {
		// position 4 threw R9 last; it is position 1's draw phase
		const spec: Arrangement = {
			racks: {1: [...RUN_R10_13, ...GROUP_13, ...RUN_B4_6, K(2)]},
			discards: [[], [], [], [Y(1), R(9)]],
			state: {phase: 'draw'},
		};
		const state = arranged(spec);
		expect(rejected(state, 1, {type: 'take_discard', open: [ts(RUN_R10_13), ts(GROUP_13), ts(RUN_B4_6)]})).toBe(
			'take_unused',
		);
		expect(rejected(state, 1, {type: 'take_discard'})).toBe('take_unused');
		const withR9 = [R(9), ...RUN_R10_13]; // 55 + 39 + 15 = 109
		const after = act(state, 1, {type: 'take_discard', open: [ts(withR9), ts(GROUP_13), ts(RUN_B4_6)]});
		expect(after.discards[3]).toEqual([Y(1)]);
		expect(after.melds[0]).toEqual({owner: 1, kind: 'run', tiles: withR9});
		expect(after.racks[0]).toEqual([K(2)]);
		expect(after).toMatchObject({phase: 'play', drawn: null, opened: ['sets', 'none', 'none', 'none']});
		assertTileConservation(after);
		// nothing to take
		const empty = arranged({...spec, discards: [[], [], [Y(1), R(9)], []]});
		expect(rejected(empty, 1, {type: 'take_discard', open: [ts(withR9), ts(GROUP_13), ts(RUN_B4_6)]})).toBe(
			'illegal_move',
		);
		// an opened player may take it to add it
		const opened = arranged({
			...spec,
			racks: {1: [R(10), K(2), Y(9)]},
			melds: [{owner: 2, kind: 'run', tiles: RUN_R10_13.slice(1)}],
			state: {...OPENED_EARLIER, phase: 'draw'},
		});
		expect(act(opened, 1, {type: 'take_discard', add: [add(0, [R(9), R(10)], 'start')]}).melds[0]!.tiles).toEqual([
			R(9),
			...RUN_R10_13,
		]);
	});

	it('add only after the opening turn (ADD_ON_OPEN_TURN=false)', () => {
		expect(OKEY101_RULES.ADD_ON_OPEN_TURN).toBe(false);
		const state = arranged({racks: {1: [...RUN_R10_13, ...GROUP_13, ...RUN_B4_7, B(8), K(2), K(5)]}});
		const addB8: TableGameAction = {type: 'meld', add: [add(2, [B(8)], 'end')]};
		const openAndAdd: TableGameAction = {
			type: 'meld',
			open: [ts(RUN_R10_13), ts(GROUP_13), ts(RUN_B4_7)],
			add: [add(2, [B(8)], 'end')],
		};
		expect(rejected(state, 1, openAndAdd)).toBe('cannot_add');
		const opened = act(state, 1, meldOpen(RUN_R10_13, GROUP_13, RUN_B4_7));
		expect(rejected(opened, 1, addB8)).toBe('cannot_add');
		const nextTurn = roundTrip(opened, K(5));
		expect(act(nextTurn, 1, addB8).melds[2]!.tiles).toEqual([...RUN_B4_7, B(8)]);
	});

	it('add extends a run at start/end and a group up to 4', () => {
		const state = arranged({
			racks: {1: [B(3), B(8), R(13), Y(13, 1), B(9), K(2)]},
			melds: [
				{owner: 2, kind: 'run', tiles: RUN_B4_7},
				{owner: 3, kind: 'group', tiles: GROUP_13},
			],
			state: OPENED_EARLIER,
		});
		const after = act(state, 1, {
			type: 'meld',
			add: [add(0, [B(3)], 'start'), add(0, [B(8)], 'end'), add(1, [R(13)], 'end')],
		});
		expect(after.melds).toEqual([
			{owner: 2, kind: 'run', tiles: [B(3), ...RUN_B4_7, B(8)]},
			{owner: 3, kind: 'group', tiles: [...GROUP_13, R(13)]},
		]);
		expect(after.racks[0]).toEqual([Y(13, 1), B(9), K(2)]);
		expect(rejected(after, 1, {type: 'meld', add: [add(1, [Y(13, 1)], 'end')]})).toBe('cannot_add');
		expect(rejected(after, 1, {type: 'meld', add: [add(0, [B(9)], 'start')]})).toBe('cannot_add');
		expect(rejected(after, 1, {type: 'meld', add: [add(7, [B(9)], 'end')]})).toBe('cannot_add');
		expect(act(after, 1, {type: 'meld', add: [add(0, [B(9)], 'end')]}).melds[0]!.tiles).toHaveLength(7);
		assertTileConservation(after);
	});

	it('not opened cannot add → not_opened', () => {
		const state = arranged({
			racks: {1: [B(3), K(2)]},
			melds: [{owner: 2, kind: 'run', tiles: RUN_B4_7}],
			state: {...OPENED_EARLIER, opened: ['none', 'sets', 'sets', 'sets'], openedAt: [null, 0, 0, 0]},
		});
		expect(rejected(state, 1, {type: 'meld', add: [add(0, [B(3)], 'start')]})).toBe('not_opened');
	});

	it('discarding the okey adds 101 penalty', () => {
		const state = arranged({racks: {1: [OKEY, B(8), K(2)]}});
		const after = act(state, 1, {type: 'discard', tile: t(OKEY)});
		expect(after.penalties).toEqual([101, 0, 0, 0]);
		expect(after.discards[0]).toEqual([OKEY]);
		expect(after).toMatchObject({turn: 2, phase: 'draw', drawn: null, deadlineAt: START + TURN_MS, result: null});
		assertTileConservation(after);
	});

	it('discarding an addable tile adds 101 penalty', () => {
		const state = arranged({
			racks: {1: [OKEY, B(8), K(2)]},
			melds: [{owner: 2, kind: 'run', tiles: RUN_B4_7}],
		});
		expect(act(state, 1, {type: 'discard', tile: t(B(8))}).penalties).toEqual([101, 0, 0, 0]);
		expect(act(state, 1, {type: 'discard', tile: t(K(2))}).penalties).toEqual([0, 0, 0, 0]);
	});

	it('finish by discarding the last tile ends the hand', () => {
		// K2 could extend the K3-K5 run, but the finishing tile carries no penalty
		const state = arranged({
			racks: {1: [K(2)]},
			melds: [{owner: 1, kind: 'run', tiles: [K(3), K(4), K(5)]}],
			state: {...OPENED_EARLIER, opened: ['sets', 'none', 'none', 'none'], openedAt: [0, null, null, null]},
		});
		const after = act(state, 1, {type: 'discard', tile: t(K(2))});
		expect(Okey101.result(after)).toEqual({kind: 'win', winners: [1], reason: 'score', finish: 'normal'});
		expect(after.scores).toEqual([-101, 202, 202, 202]);
		expect(after.penalties).toEqual([0, 0, 0, 0]);
		expect(after.racks[0]).toEqual([]);
		expect(Okey101.deadline(after)).toBeNull();
		expect(Okey101.view(after, null)).toMatchObject({turn: null, deadline_at: null, scores: [-101, 202, 202, 202]});
		assertTileConservation(after);
	});

	it('okey finish doubles, hand finish (no earlier opening) doubles', () => {
		const lateOpener: Partial<Okey101State> = {
			...OPENED_EARLIER,
			opened: ['sets', 'none', 'none', 'none'],
			openedAt: [0, null, null, null],
		};
		const okeyFinish = act(arranged({racks: {1: [OKEY]}, state: lateOpener}), 1, {
			type: 'discard',
			tile: t(OKEY),
		});
		expect(Okey101.result(okeyFinish)).toEqual({kind: 'win', winners: [1], reason: 'score', finish: 'okey'});
		expect(okeyFinish.scores).toEqual([-202, 404, 404, 404]);
		expect(okeyFinish.penalties).toEqual([0, 0, 0, 0]);

		// the starter opens all 21 tiles in its first turn and throws the last one
		const hand = [
			[R(1), R(2), R(3), R(4), R(5), R(6), R(7), R(8), R(9), R(10), R(11), R(12), R(13)],
			[K(1), K(2), K(3), K(4), K(5), K(6), K(7), K(8)],
		];
		const handFinish = (last: number) => {
			const opened = act(arranged({racks: {1: [...hand.flat(), last]}}), 1, meldOpen(...hand));
			return act(opened, 1, {type: 'discard', tile: t(last)});
		};
		const plain = handFinish(Y(2));
		expect(Okey101.result(plain)).toEqual({kind: 'win', winners: [1], reason: 'score', finish: 'hand'});
		expect(plain.scores).toEqual([-202, 404, 404, 404]);
		const both = handFinish(OKEY);
		expect(Okey101.result(both)).toMatchObject({winners: [1], finish: 'okey'});
		expect(both.scores).toEqual([-404, 808, 808, 808]);
	});

	it('scores: winner −101×m, unopened +202×m, opened sum of rack (okey 101) ×2 for pair openers ×m, plus penalties; lowest wins (ties share)', () => {
		// okey finish: m = 2
		const state = arranged({
			racks: {1: [OKEY], 2: [K(9), R(1)], 3: [B(2), OKEY_2], 4: [K(3), FAKE]},
			state: {
				opened: ['sets', 'none', 'sets', 'pairs'],
				openedAt: [0, null, 0, 0],
				turns: 4,
				penalties: [0, 101, 0, 0],
			},
		});
		const after = act(state, 1, {type: 'discard', tile: t(OKEY)});
		// 1: −101×2; 2: 202×2 + 101; 3: (2 + 101)×2; 4: (3 + 6, the fake plays yellow 6)×2×2
		expect(after.scores).toEqual([-202, 505, 206, 36]);
		expect(Okey101.result(after)).toMatchObject({kind: 'win', winners: [1], reason: 'score'});

		// a penalized finisher can lose to an opened player with a light rack
		const penalized = arranged({
			racks: {1: [K(2)], 2: [K(9)], 3: [B(2)], 4: [R(1)]},
			state: {...OPENED_EARLIER, penalties: [202, 0, 0, 0]},
		});
		const scored = act(penalized, 1, {type: 'discard', tile: t(K(2))});
		expect(scored.scores).toEqual([101, 9, 2, 1]);
		expect(Okey101.result(scored)).toEqual({kind: 'win', winners: [4], reason: 'score', finish: 'normal'});
	});

	it('pile empty → hand ends without finisher, scores multiplier 1', () => {
		const full = arranged({
			racks: {1: [B(2), K(9)], 2: [R(1)], 3: [R(2)], 4: [Y(1)]},
			state: {opened: ['sets', 'none', 'sets', 'none'], openedAt: [0, null, 0, null], turns: 4},
		});
		const state: Okey101State = {...full, pile: [], discards: [[], [], [...full.pile], []]};
		assertTileConservation(state);
		const after = act(state, 1, {type: 'discard', tile: t(K(9))});
		expect(Okey101.result(after)).toEqual({kind: 'win', winners: [1, 3], reason: 'score'});
		expect(after.scores).toEqual([2, 202, 2, 202]);
		expect(Okey101.deadline(after)).toBeNull();
		assertTileConservation(after);
	});

	it('timeouts: draw phase draws, play phase discards the drawn tile avoiding okey and addable tiles', () => {
		const later = START + TURN_MS + 1_000;
		const table = [{owner: 2, kind: 'run', tiles: RUN_B4_7}] as Array<Okey101TableMeld>;

		const drawPhase = arranged({racks: {1: [K(2), K(7)]}, pileTop: [R(9)], melds: table, state: {phase: 'draw'}});
		const drew = Okey101.onDeadline(drawPhase, rng, clock(later));
		expect(drew.racks[0]).toEqual([K(2), K(7)]);
		expect(drew.discards[0]).toEqual([R(9)]);
		expect(drew).toMatchObject({turn: 2, phase: 'draw', timeouts: [1, 0, 0, 0], penalties: [0, 0, 0, 0]});
		expect(drew.deadlineAt).toBe(later + TURN_MS);
		assertTileConservation(drew);

		const okeyOnTop = arranged({racks: {1: [K(2), K(7)]}, pileTop: [OKEY], melds: table, state: {phase: 'draw'}});
		const keptOkey = Okey101.onDeadline(okeyOnTop, rng, clock(later));
		expect(keptOkey.discards[0]).toEqual([K(2)]);
		expect(keptOkey.racks[0]).toEqual([K(7), OKEY]);
		expect(keptOkey.penalties).toEqual([0, 0, 0, 0]);

		const addableDrawn = arranged({racks: {1: [B(8), K(2), K(7)]}, melds: table, state: {drawn: B(8)}});
		const keptAddable = Okey101.onDeadline(addableDrawn, rng, clock(later));
		expect(keptAddable.discards[0]).toEqual([K(2)]);
		expect(keptAddable.penalties).toEqual([0, 0, 0, 0]);

		const safeDrawn = arranged({racks: {1: [K(2), R(9)]}, melds: table, state: {drawn: R(9)}});
		expect(Okey101.onDeadline(safeDrawn, rng, clock(later)).discards[0]).toEqual([R(9)]);

		// the starter has drawn nothing: the first tile without a penalty goes
		const starter = arranged({racks: {1: [OKEY, B(8), K(7), K(2)]}, melds: table});
		expect(Okey101.onDeadline(starter, rng, clock(later)).discards[0]).toEqual([K(7)]);
	});

	it('second consecutive timeout → forfeit', () => {
		const state = arranged({state: {timeouts: [1, 0, 0, 0]}});
		const after = Okey101.onDeadline(state, rng, clock());
		expect(Okey101.result(after)).toEqual({kind: 'forfeit', loser: 1, reason: 'timeouts'});
		expect(after.scores).toBeNull();
		expect(Okey101.deadline(after)).toBeNull();
		expect(Okey101.onDeadline(after, rng, clock())).toBe(after);
		// an own action resets the counter
		const drawPhase = arranged({state: {phase: 'draw', timeouts: [1, 0, 0, 0]}});
		expect(act(drawPhase, 1, {type: 'draw', from: 'pile'}).timeouts).toEqual([0, 0, 0, 0]);
	});

	it('forfeit and cancel end the hand without scores; later actions → game_over', () => {
		const state = arranged();
		const left = Okey101.forfeit(state, 3, 'leave');
		expect(Okey101.result(left)).toEqual({kind: 'forfeit', loser: 3, reason: 'leave'});
		expect(Okey101.forfeit(left, 2, 'disconnect')).toBe(left);
		expect(Okey101.result(Okey101.cancel(state, 'theme_changed'))).toEqual({kind: 'canceled', reason: 'theme_changed'});
		expect(Okey101.view(left, 1)!).toMatchObject({scores: null, turn: null});
		expect(rejected(left, 1, {type: 'discard', tile: t(left.racks[0]![0]!)})).toBe('game_over');
		expect(Okey101.result(state)).toBeNull();
	});

	it('rejects out-of-turn, wrong-phase, foreign-tile and Classic-only actions', () => {
		const state = arranged({racks: {1: [K(2), K(7)]}});
		expect(rejected(state, 2, {type: 'discard', tile: t(state.racks[1]![0]!)})).toBe('not_your_turn');
		expect(rejected(state, 1, {type: 'draw', from: 'pile'})).toBe('wrong_phase');
		expect(rejected(state, 1, {type: 'discard', tile: t(state.pile[0]!)})).toBe('tile_not_in_rack');
		expect(rejected(state, 1, meldOpen([K(2), K(2)]))).toBe('invalid_meld');
		const drawPhase = arranged({racks: {1: [K(2), K(7)]}, state: {phase: 'draw'}});
		expect(rejected(drawPhase, 1, {type: 'discard', tile: t(K(2))})).toBe('wrong_phase');
		expect(rejected(drawPhase, 1, {type: 'draw', from: 'discard'})).toBe('unsupported_action');
		for (const action of [
			{type: 'tick'},
			{type: 'finish', tile: t(K(2)), sets: [[t(K(7))]]},
			{type: 'move', from: 'e2', to: 'e4'},
			{type: 'resign'},
		] as Array<TableGameAction>) {
			expect(rejected(state, 1, action)).toBe('unsupported_action');
		}
	});

	it('view: melds public, racks of others null', () => {
		const state = arranged({
			racks: {1: [K(2), K(7)]},
			melds: [{owner: 2, kind: 'run', tiles: RUN_B4_7}],
			discards: [[R(3)], [], [], []],
			state: {
				...OPENED_EARLIER,
				opened: ['none', 'sets', 'none', 'none'],
				openedAt: [null, 0, null, null],
				penalties: [0, 101, 0, 0],
			},
		});
		const ended = act(arranged({racks: {1: [K(2)]}, state: OPENED_EARLIER}), 1, {type: 'discard', tile: t(K(2))});
		for (const s of [state, ended]) {
			for (const viewer of [1, 2, 3, 4, null] as const) {
				const view = Okey101.view(s, viewer);
				expect(Okey101View.parse(view)).toEqual(view); // strictObject: no field beyond the contract
				expect(view).toMatchObject({
					game: 'okey101',
					indicator: t(INDICATOR),
					pile_count: s.pile.length,
					rack_counts: s.racks.map((rack) => rack.length),
					rack: viewer === null ? null : ts(s.racks[viewer - 1]!),
					melds: s.melds.map((meld, id) => ({id, owner: meld.owner, kind: meld.kind, tiles: ts(meld.tiles)})),
					opened: s.opened,
					penalties: s.penalties,
					scores: s.scores,
				});
				const seen = tokensIn(JSON.stringify(view));
				for (const other of [1, 2, 3, 4] as const) {
					if (other !== viewer) for (const token of rackTokensOf(s, other)) expect(seen.has(token)).toBe(false);
				}
				for (const token of deckTokensOf(s)) expect(seen.has(token)).toBe(false);
			}
		}
		expect(Okey101.view(state, null)).toMatchObject({turn: 1, phase: 'play', discards: [[t(R(3))], [], [], []]});
	});
});
