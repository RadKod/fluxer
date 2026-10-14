// SPDX-License-Identifier: AGPL-3.0-or-later

import {ClassicOkey, type ClassicOkeyState} from '@app/api/table_game/engine/okey/ClassicOkey';
import {TableGameRuleError, type TablePosition} from '@app/api/table_game/engine/TableGameEngine';
import {
	assertTileConservation,
	deckTokensOf,
	playRandomGame,
	rackTokensOf,
	tokensIn,
} from '@app/api/table_game/engine/tests/EngineInvariants';
import {randomOkeyAgent} from '@app/api/table_game/engine/tests/OkeyAgents';
import {SeededRng} from '@app/api/table_game/engine/tests/SeededRng';
import {okeyTileToken} from '@fluxer/constants/src/TableGameConstants';
import {OkeyView, type TableGameAction} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {describe, expect, it} from 'vitest';

const tok = okeyTileToken;

// One action that the rules must refuse in this position, picked from a seeded menu.
function illegalAction(state: ClassicOkeyState, rng: SeededRng): {actor: TablePosition; action: TableGameAction} {
	const turn = state.turn;
	const other = ((turn % 4) + 1) as TablePosition;
	const rack = state.racks[turn - 1]!;
	const menu: Array<() => {actor: TablePosition; action: TableGameAction}> = [
		() => ({actor: other, action: {type: 'draw', from: 'pile'}}),
		() => ({actor: other, action: {type: 'discard', tile: tok(state.racks[other - 1]![0]!)}}),
		() => ({actor: turn, action: {type: 'discard', tile: tok(state.indicator)}}),
		() => ({actor: turn, action: {type: 'resign'}}),
		() => ({actor: turn, action: {type: 'meld', open: [rack.slice(0, 3).map(tok)]}}),
		() => ({actor: turn, action: {type: 'move', from: 'e2', to: 'e4'}}),
		() =>
			state.phase === 'draw'
				? {actor: turn, action: {type: 'discard', tile: tok(rack[0]!)}}
				: {actor: turn, action: {type: 'draw', from: 'pile'}},
		() => ({actor: turn, action: {type: 'finish', tile: tok(rack[0]!), sets: [rack.slice(1, 4).map(tok)]}}),
	];
	if (state.pile.length > 0) {
		menu.push(() => ({actor: turn, action: {type: 'discard', tile: tok(state.pile[0]!)}}));
	}
	return menu[rng.int(menu.length)]!();
}

describe('ClassicOkey property', () => {
	// every view is parsed by the view schema (strictObject, so no field beyond the
	// contract can carry a tile, as a token, a face object or an id), tokens are matched as whole words
	// against the state after each move, and leaks are gathered per step (one expect per token was
	// ~90 M assertions, 300 s measured). The time bound is loose so loaded CI does not flake.
	it('2000 seeded games end, conserve all 106 tiles and never leak a rack or the deck', () => {
		const started = performance.now();
		for (let seed = 1; seed <= 2000; seed++) {
			playRandomGame(ClassicOkey, new SeededRng(seed), randomOkeyAgent, (state) => {
				assertTileConservation(state);
				const leaks: Array<string> = [];
				for (const viewer of [1, 2, 3, 4, null] as const) {
					const view = ClassicOkey.view(state, viewer);
					OkeyView.parse(view);
					const seen = tokensIn(JSON.stringify(view));
					for (const other of [1, 2, 3, 4] as const) {
						if (other !== viewer) {
							for (const t of rackTokensOf(state, other))
								if (seen.has(t)) leaks.push(`${viewer} sees rack ${other}: ${t}`);
						}
					}
					for (const t of deckTokensOf(state)) if (seen.has(t)) leaks.push(`${viewer} sees deck: ${t}`);
				}
				expect(leaks).toEqual([]);
			});
		}
		const elapsed = performance.now() - started;
		console.info(`ClassicOkey leak property: 2000 games in ${Math.round(elapsed)} ms`);
		expect(elapsed).toBeLessThan(60_000);
	}, 120_000);

	it('every game ends within 60 turns', () => {
		const endings = new Map<string, number>();
		for (let seed = 1; seed <= 2000; seed++) {
			const final = playRandomGame(ClassicOkey, new SeededRng(seed), randomOkeyAgent, () => {});
			expect(final.turns).toBeLessThanOrEqual(60);
			const result = ClassicOkey.result(final)!;
			const key = result.kind === 'win' ? `win:${result.finish}` : `${result.kind}:${result.reason}`;
			endings.set(key, (endings.get(key) ?? 0) + 1);
		}
		// the seeded agent reaches every ending a hand can have, so the leak test above covers them all
		expect(endings.get('draw:pile_empty')).toBeGreaterThan(0);
		expect(endings.get('forfeit:timeouts')).toBeGreaterThan(0);
		expect(endings.get('win:normal')).toBeGreaterThan(0);
	}, 60_000);

	it('random illegal actions are rejected without changing state', () => {
		for (let seed = 1; seed <= 300; seed++) {
			const rng = new SeededRng(seed * 7919);
			playRandomGame(ClassicOkey, new SeededRng(seed), randomOkeyAgent, (state) => {
				if (ClassicOkey.result(state) !== null) return;
				const before = JSON.stringify(state);
				const {actor, action} = illegalAction(state, rng);
				expect(() => ClassicOkey.apply(state, actor, action, rng, {now: 0, turnMs: 30_000})).toThrow(
					TableGameRuleError,
				);
				expect(JSON.stringify(state)).toBe(before);
			});
		}
	}, 60_000);
});
