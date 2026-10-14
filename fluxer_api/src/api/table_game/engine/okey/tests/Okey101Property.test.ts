// SPDX-License-Identifier: AGPL-3.0-or-later

import {Okey101, type Okey101State} from '@app/api/table_game/engine/okey/Okey101';
import {greedyOkey101Agent} from '@app/api/table_game/engine/okey/tests/Okey101Agents';
import {TableGameRuleError, type TablePosition} from '@app/api/table_game/engine/TableGameEngine';
import {
	assertTileConservation,
	deckTokensOf,
	playRandomGame,
	rackTokensOf,
	tokensIn,
} from '@app/api/table_game/engine/tests/EngineInvariants';
import {SeededRng} from '@app/api/table_game/engine/tests/SeededRng';
import {okeyTileToken} from '@fluxer/constants/src/TableGameConstants';
import {Okey101View, type TableGameAction} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {describe, expect, it} from 'vitest';

const tok = okeyTileToken;
const POSITIONS = [1, 2, 3, 4] as const;

// Scores agree with the result without recomputing rack values: one multiplier m for the whole hand, the
// finisher −101×m, every unopened player 202×m, opened players a positive multiple of m (2m for pair
// openers), penalties whole multiples of 101, and the winners are exactly the lowest totals.
function expectConsistentScores(state: Okey101State): void {
	const result = Okey101.result(state)!;
	if (result.kind !== 'win') {
		expect(state.scores).toBeNull();
		return;
	}
	const scores = state.scores!;
	const best = Math.min(...scores);
	expect(result.reason).toBe('score');
	expect(result.winners).toEqual(POSITIONS.filter((position) => scores[position - 1] === best));
	const finisher = POSITIONS.find((position) => state.racks[position - 1]!.length === 0) ?? null;
	expect(result.finish === undefined).toBe(finisher === null);
	const base = (position: TablePosition) => scores[position - 1]! - state.penalties[position - 1]!;
	const multiplier = finisher === null ? 1 : base(finisher) / -101;
	expect([1, 2, 4]).toContain(multiplier);
	for (const position of POSITIONS) {
		expect(state.penalties[position - 1]! % 101).toBe(0);
		if (position === finisher) continue;
		const opened = state.opened[position - 1]!;
		if (opened === 'none') expect(base(position)).toBe(202 * multiplier);
		else {
			expect(base(position)).toBeGreaterThan(0);
			expect(base(position) % (opened === 'pairs' ? 2 * multiplier : multiplier)).toBe(0);
		}
	}
}

function endingOf(state: Okey101State): string {
	const result = Okey101.result(state)!;
	if (result.kind !== 'win') return `${result.kind}:${result.reason}`;
	return result.finish === undefined ? 'score:pile_empty' : `score:${result.finish}`;
}

// One action that the rules must refuse in this position, picked from a seeded menu.
function illegalAction(state: Okey101State, rng: SeededRng): {actor: TablePosition; action: TableGameAction} {
	const turn = state.turn;
	const other = ((turn % 4) + 1) as TablePosition;
	const rack = state.racks[turn - 1]!;
	const menu: Array<() => {actor: TablePosition; action: TableGameAction}> = [
		() => ({actor: other, action: {type: 'draw', from: 'pile'}}),
		() => ({actor: other, action: {type: 'discard', tile: tok(state.racks[other - 1]![0]!)}}),
		() => ({actor: turn, action: {type: 'discard', tile: tok(state.indicator)}}),
		() => ({actor: turn, action: {type: 'draw', from: 'discard'}}),
		() => ({actor: turn, action: {type: 'resign'}}),
		() => ({actor: turn, action: {type: 'tick'}}),
		() => ({actor: turn, action: {type: 'finish', tile: tok(rack[0]!), sets: [rack.slice(1, 4).map(tok)]}}),
		() => ({actor: turn, action: {type: 'move', from: 'e2', to: 'e4'}}),
		() =>
			state.phase === 'draw'
				? {actor: turn, action: {type: 'meld', open: [rack.slice(0, 3).map(tok)]}}
				: {actor: turn, action: {type: 'draw', from: 'pile'}},
		// a pair and a run-sized meld in one opening: mixed, too short or emptying the rack
		() => ({actor: turn, action: {type: 'meld', open: [rack.slice(0, 2).map(tok), rack.slice(2, 5).map(tok)]}}),
		() => ({actor: turn, action: {type: 'meld', add: [{meld_id: 255, tiles: [tok(rack[0]!)], at: 'end'}]}}),
		() => ({actor: turn, action: {type: 'take_discard'}}),
	];
	if (state.pile.length > 0) {
		menu.push(() => ({actor: turn, action: {type: 'discard', tile: tok(state.pile[0]!)}}));
	}
	return menu[rng.int(menu.length)]!();
}

describe('Okey101 property', () => {
	// the greedy 101 agent plays 1000 seeded hands; after every move each
	// view is parsed by the strict view schema, tokens are matched as whole words against the other
	// racks and the deck of the state after that move, leaks are gathered per step, and the final scores
	// are checked against the result. No wall-clock assertion; the time is logged.
	it('1000 seeded games end, conserve all 106 tiles, score consistently and never leak a rack or the deck', () => {
		const started = performance.now();
		const endings = new Map<string, number>();
		const opened = {sets: 0, pairs: 0};
		const actions = new Map<string, number>();
		const counting = (state: Okey101State, actor: TablePosition) => {
			const action = greedyOkey101Agent(state, actor);
			const key =
				action.type === 'meld' || action.type === 'take_discard'
					? `${action.type}:${action.add ? 'add' : 'open'}`
					: action.type;
			actions.set(key, (actions.get(key) ?? 0) + 1);
			return action;
		};
		let penalized = 0;
		for (let seed = 1; seed <= 1000; seed++) {
			const final = playRandomGame(Okey101, new SeededRng(seed), counting, (state) => {
				assertTileConservation(state);
				const leaks: Array<string> = [];
				for (const viewer of [1, 2, 3, 4, null] as const) {
					const view = Okey101.view(state, viewer);
					Okey101View.parse(view);
					const seen = tokensIn(JSON.stringify(view));
					for (const other of POSITIONS) {
						if (other !== viewer) {
							for (const t of rackTokensOf(state, other))
								if (seen.has(t)) leaks.push(`${viewer} sees rack ${other}: ${t}`);
						}
					}
					for (const t of deckTokensOf(state)) if (seen.has(t)) leaks.push(`${viewer} sees deck: ${t}`);
				}
				expect(leaks).toEqual([]);
			});
			expectConsistentScores(final);
			const ending = endingOf(final);
			endings.set(ending, (endings.get(ending) ?? 0) + 1);
			for (const kind of final.opened) if (kind !== 'none') opened[kind]++;
			if (final.penalties.some((penalty) => penalty > 0)) penalized++;
		}
		const elapsed = Math.round(performance.now() - started);
		console.info(
			`Okey101 property: 1000 games in ${elapsed} ms; endings ${JSON.stringify(Object.fromEntries(endings))}; ` +
				`openings ${JSON.stringify(opened)}; games with a penalty ${penalized}; actions ${JSON.stringify(Object.fromEntries(actions))}`,
		);
		// the agent reaches every ending and both openings, so the checks above ran on all of them
		for (const ending of ['score:pile_empty', 'score:normal', 'forfeit:timeouts']) {
			expect(endings.get(ending) ?? 0).toBeGreaterThan(0);
		}
		expect(opened.sets).toBeGreaterThan(0);
		expect(opened.pairs).toBeGreaterThan(0);
		expect(penalized).toBeGreaterThan(0);
		for (const action of ['take_discard:open', 'take_discard:add', 'meld:open', 'meld:add', 'tick']) {
			expect(actions.get(action) ?? 0).toBeGreaterThan(0);
		}
	}, 120_000);

	it('random illegal actions are rejected without changing state', () => {
		for (let seed = 1; seed <= 200; seed++) {
			const rng = new SeededRng(seed * 7919);
			playRandomGame(Okey101, new SeededRng(seed), greedyOkey101Agent, (state) => {
				if (Okey101.result(state) !== null) return;
				const before = JSON.stringify(state);
				const {actor, action} = illegalAction(state, rng);
				expect(() => Okey101.apply(state, actor, action, rng, {now: 0, turnMs: 45_000})).toThrow(TableGameRuleError);
				expect(JSON.stringify(state)).toBe(before);
			});
		}
	}, 120_000);
});
