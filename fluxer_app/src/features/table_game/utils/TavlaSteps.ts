// SPDX-License-Identifier: AGPL-3.0-or-later

import type {TavlaView} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';

// One local tavla step, not sent yet; a whole turn goes out as one tavla_move. Point numbers are absolute and a
// legal_moves entry is its steps joined by spaces ('bar/22 13/7'); the notation is the tavla engine's header comment
// (fluxer_api/src/api/table_game/engine/tavla/TavlaCore.ts).
export interface TavlaStep {
	from: number | 'bar';
	to: number | 'off';
}

const stepKey = (step: TavlaStep) => `${step.from}/${step.to}`;

function parseStep(key: string): TavlaStep {
	const [from, to] = key.split('/') as [string, string];
	return {from: from === 'bar' ? 'bar' : Number(from), to: to === 'off' ? 'off' : Number(to)};
}

// What is left of a legal turn once the played steps are taken out, in whatever order they were played; null when
// they do not fit it (the server checks a turn as a multiset too).
function remainder(sequence: string, played: ReadonlyArray<string>): Array<string> | null {
	const left = sequence.split(' ');
	for (const step of played) {
		const at = left.indexOf(step);
		if (at < 0) return null;
		left.splice(at, 1);
	}
	return left;
}

// legal_moves keeps one sequence per resulting board, so a checker running both dice is listed through one middle
// point only (6-5: '24/19 19/13'). The other middle point gives the same board when nothing of the opponent's stands
// on either; this adds that route so the client accepts what the server accepts.
// TEMPORARY: chains ending in 'off' are not re-routed (bear-off die arithmetic); add if players report it.
export function expandTavlaPlays(view: TavlaView): ReadonlyArray<string> {
	const legal = view.legal_moves ?? [];
	if (view.dice === null || view.dice[0] === view.dice[1] || view.turn === null) return legal;
	const white = view.turn === view.white;
	const opponentOn = (point: number) => (white ? -view.points[point - 1]! : view.points[point - 1]!) > 0;
	const routes: Array<string> = [];
	for (const sequence of legal) {
		const [first, second] = sequence.split(' ');
		if (first === undefined || second === undefined) continue;
		const [x, y] = first.split('/') as [string, string];
		const [middle, z] = second.split('/') as [string, string];
		if (middle !== y || z === 'off') continue;
		const from = x === 'bar' ? (white ? 25 : 0) : Number(x);
		const other = from + Number(z) - Number(y);
		if (opponentOn(Number(y)) || opponentOn(other)) continue;
		routes.push(`${x}/${other} ${other}/${z}`);
	}
	return [...legal, ...routes];
}

// Steps that may come next: the rest of every legal turn the played steps fit into.
export function nextLegalSteps(
	legalMoves: ReadonlyArray<string> | null,
	steps: ReadonlyArray<TavlaStep>,
): ReadonlyArray<TavlaStep> {
	const played = steps.map(stepKey);
	const next = new Set<string>();
	for (const sequence of legalMoves ?? []) {
		for (const step of remainder(sequence, played) ?? []) next.add(step);
	}
	return [...next].map(parseStep);
}

// The played steps are a whole legal turn; every legal turn is as long as the longest, so it cannot be extended.
export function completes(legalMoves: ReadonlyArray<string> | null, steps: ReadonlyArray<TavlaStep>): boolean {
	const played = steps.map(stepKey);
	return played.length > 0 && (legalMoves ?? []).some((sequence) => remainder(sequence, played)?.length === 0);
}
