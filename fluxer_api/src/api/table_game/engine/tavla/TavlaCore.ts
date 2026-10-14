// SPDX-License-Identifier: AGPL-3.0-or-later

// Tavla board arithmetic. Notation every client relies on:
// - Point numbers are absolute everywhere (view.points, tavla_move, last_moves, legal_moves; GLB tp_01..tp_24):
//   white moves 24 → 1 into its home 1–6, black moves 1 → 24 into its home 19–24.
//   Entering from the bar with die d: white lands on 25 − d, black on d. 'bar' is only a from, 'off' only a to.
// - A sequence string is its steps joined by spaces, each `from/to` ('bar/22 13/7', '6/off'), in playable order:
//   farthest from the mover's home first (bar first; white: from descending, black: from ascending).
// - legal_moves holds one sequence per distinct resulting board, farthest first; legal_moves[0] is the timeout play.
//   A request is checked as a multiset: any legal play is accepted, whatever order its steps come in.
// - legal_moves = [] (no play for these dice) only shows up after a long pass chain; the turn then passes on its
//   deadline without counting a timeout.
// Inside this file a side is walked in its own numbering ("rel"): 24 → 1, with 25 its bar and 0 off.

export type TavlaSide = 'white' | 'black';

export interface TavlaMove {
	readonly from: number | 'bar';
	readonly to: number | 'off';
}

export interface TavlaBoard {
	readonly points: ReadonlyArray<number>; // 24 counts, index 0 = point 1; + white, − black
	readonly bar: Readonly<Record<TavlaSide, number>>;
	readonly off: Readonly<Record<TavlaSide, number>>;
}

export interface TavlaSequences {
	readonly sequences: ReadonlyArray<string>; // distinct results, farthest first; [] when the dice cannot be played
	readonly accepted: ReadonlySet<string>; // every legal full play in canonical form
}

const BAR = 25;
const OFF = 0;

type RelMove = readonly [from: number, to: number];

// own[r] / opp[r] for r = 1..24 in the mover's numbering; own[25] and opp[25] bar counts, own[0] and opp[0] off counts.
interface Rel {
	readonly own: ReadonlyArray<number>;
	readonly opp: ReadonlyArray<number>;
}

const otherSide = (side: TavlaSide): TavlaSide => (side === 'white' ? 'black' : 'white');
// The mapping is its own inverse.
const flip = (side: TavlaSide, point: number) => (side === 'white' ? point : 25 - point);

export function startingBoard(): TavlaBoard {
	const points = new Array<number>(24).fill(0);
	for (const [point, count] of [
		[24, 2],
		[13, 5],
		[8, 3],
		[6, 5],
	] as const) {
		points[point - 1] = count;
		points[24 - point] = -count;
	}
	return {points, bar: {white: 0, black: 0}, off: {white: 0, black: 0}};
}

function relOf(board: TavlaBoard, side: TavlaSide): Rel {
	const own = new Array<number>(26).fill(0);
	const opp = new Array<number>(26).fill(0);
	const sign = side === 'white' ? 1 : -1;
	for (let r = 1; r <= 24; r++) {
		const count = board.points[flip(side, r) - 1]! * sign;
		if (count > 0) own[r] = count;
		else opp[r] = -count;
	}
	own[BAR] = board.bar[side];
	own[OFF] = board.off[side];
	opp[BAR] = board.bar[otherSide(side)];
	opp[OFF] = board.off[otherSide(side)];
	return {own, opp};
}

function boardOf(rel: Rel, side: TavlaSide): TavlaBoard {
	const sign = side === 'white' ? 1 : -1;
	const points = new Array<number>(24).fill(0);
	for (let r = 1; r <= 24; r++) points[flip(side, r) - 1] = (rel.own[r]! - rel.opp[r]!) * sign || 0;
	const other = otherSide(side);
	return {
		points,
		bar: {[side]: rel.own[BAR]!, [other]: rel.opp[BAR]!} as Record<TavlaSide, number>,
		off: {[side]: rel.own[OFF]!, [other]: rel.opp[OFF]!} as Record<TavlaSide, number>,
	};
}

// Single steps for one die; `maxFrom` keeps doubles in non-increasing order so each multiset is walked once.
function stepsFor({own, opp}: Rel, die: number, maxFrom: number): Array<RelMove> {
	if (own[BAR]! > 0) {
		const to = BAR - die;
		return maxFrom >= BAR && opp[to]! < 2 ? [[BAR, to]] : [];
	}
	let highest = 24;
	while (highest > 0 && own[highest] === 0) highest--;
	const steps: Array<RelMove> = [];
	for (let from = Math.min(maxFrom, highest); from >= 1; from--) {
		if (own[from] === 0) continue;
		const to = from - die;
		if (to >= 1) {
			if (opp[to]! < 2) steps.push([from, to]);
		} else if (highest <= 6 && (to === 0 || from === highest)) {
			steps.push([from, OFF]); // exact, or a higher die bearing off the farthest checker
		}
	}
	return steps;
}

function stepRel(rel: Rel, [from, to]: RelMove): {rel: Rel; hit: boolean} {
	const own = [...rel.own];
	own[from]!--;
	own[to]!++;
	if (to === OFF || rel.opp[to] !== 1) return {rel: {own, opp: rel.opp}, hit: false};
	const opp = [...rel.opp];
	opp[to] = 0;
	opp[BAR]!++;
	return {rel: {own, opp}, hit: true};
}

// Steps sorted by (from, to) descending in rel numbers: always a playable order (no step ever enables a farther one).
const byFarthest = (a: RelMove, b: RelMove) => b[0] - a[0] || b[1] - a[1];

function compareSequences(a: ReadonlyArray<RelMove>, b: ReadonlyArray<RelMove>): number {
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		const order = byFarthest(a[i]!, b[i]!);
		if (order !== 0) return order;
	}
	return a.length - b.length;
}

function keyOf(side: TavlaSide, sorted: ReadonlyArray<RelMove>): string {
	return sorted
		.map(([from, to]) => `${from === BAR ? 'bar' : flip(side, from)}/${to === OFF ? 'off' : flip(side, to)}`)
		.join(' ');
}

function parseKey(side: TavlaSide, key: string): Array<RelMove> {
	return key.split(' ').map((step) => {
		const [from, to] = step.split('/') as [string, string];
		return [from === 'bar' ? BAR : flip(side, Number(from)), to === 'off' ? OFF : flip(side, Number(to))];
	});
}

export function sequenceKey(side: TavlaSide, moves: ReadonlyArray<TavlaMove>): string {
	const rel = moves.map(
		({from, to}): RelMove => [from === 'bar' ? BAR : flip(side, from), to === 'off' ? OFF : flip(side, to)],
	);
	return keyOf(side, rel.sort(byFarthest));
}

// Both dice if possible, else the larger one if either alone; doubles as many times as possible.
export function legalSequences(board: TavlaBoard, side: TavlaSide, dice: readonly [number, number]): TavlaSequences {
	const doubles = dice[0] === dice[1];
	const plays: Array<{moves: Array<RelMove>; dice: Array<number>; end: Rel}> = [];
	const walk = (rel: Rel, left: ReadonlyArray<number>, moves: Array<RelMove>, used: Array<number>, maxFrom: number) => {
		let moved = false;
		for (const [index, die] of left.entries()) {
			if (left.indexOf(die) !== index) continue;
			const rest = left.filter((_, at) => at !== index);
			for (const move of stepsFor(rel, die, doubles ? maxFrom : BAR)) {
				moved = true;
				walk(stepRel(rel, move).rel, rest, [...moves, move], [...used, die], move[0]);
			}
		}
		if (!moved) plays.push({moves, dice: used, end: rel});
	};
	walk(relOf(board, side), doubles ? [dice[0], dice[0], dice[0], dice[0]] : dice, [], [], BAR);

	const longest = Math.max(...plays.map((play) => play.moves.length));
	let kept = plays.filter((play) => play.moves.length === longest && longest > 0);
	if (!doubles && longest === 1) {
		const larger = Math.max(...dice);
		if (kept.some((play) => play.dice[0] === larger)) kept = kept.filter((play) => play.dice[0] === larger);
	}

	const accepted = new Set<string>();
	const byResult = new Map<string, Array<RelMove>>();
	for (const play of kept) {
		const sorted = [...play.moves].sort(byFarthest);
		accepted.add(keyOf(side, sorted));
		const result = String.fromCharCode(...play.end.own, ...play.end.opp);
		const seen = byResult.get(result);
		if (seen === undefined || compareSequences(sorted, seen) < 0) byResult.set(result, sorted);
	}
	const sequences = [...byResult.values()].sort(compareSequences).map((sorted) => keyOf(side, sorted));
	return {sequences, accepted};
}

// Plays a canonical sequence (from legalSequences or sequenceKey) the caller has already checked.
export function playSequence(
	board: TavlaBoard,
	side: TavlaSide,
	key: string,
): {board: TavlaBoard; moves: Array<TavlaMove & {hit: boolean}>} {
	let rel = relOf(board, side);
	const moves: Array<TavlaMove & {hit: boolean}> = [];
	for (const move of parseKey(side, key)) {
		const stepped = stepRel(rel, move);
		rel = stepped.rel;
		moves.push({
			from: move[0] === BAR ? 'bar' : flip(side, move[0]),
			to: move[1] === OFF ? 'off' : flip(side, move[1]),
			hit: stepped.hit,
		});
	}
	return {board: boardOf(rel, side), moves};
}
