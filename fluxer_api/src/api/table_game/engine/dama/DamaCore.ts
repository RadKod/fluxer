// SPDX-License-Identifier: AGPL-3.0-or-later

import {Logger} from '@app/api/Logger';
import {type SearchCache, searchCache} from '@app/api/table_game/engine/SearchCache';
import {DAMA_LEGAL_PATHS_MAX, DAMA_SEARCH_NODE_BUDGET, damaSquareIndex} from '@fluxer/constants/src/TableGameConstants';

// Board and move rules shared by Türk daması and Normal dama; the rule flags pick the variant.
// Board string: 64 cells a8..h8, a7..h7, …, a1..h1; '.' empty, 'w'/'b' man, 'W'/'B' king.
export interface DamaRuleSet {
	menCaptureBackward: boolean;
	flyingKings: boolean;
	orthogonal: boolean; // Türk: men and kings move along ranks and files; otherwise on diagonals
	majorityCapture: true;
	removeCaptured: 'immediately' | 'after_move';
	promoteMidCapture: 'continue_as_man' | 'promote_and_continue' | 'stop';
	loneKingsDraw: boolean;
	threefoldDraw: boolean;
	quietMoveLimit: number; // full moves without a capture or a man moving forward
	whiteStarts: boolean;
}

export type DamaSide = 'white' | 'black';

export interface DamaMove {
	captured: Array<string>; // squares of the taken pieces, in capture order
	board: string; // after the move, taken pieces removed and promotion applied
	advance: boolean; // a capture or a man moving forward: no earlier position can recur
}

type Direction = readonly [row: number, column: number]; // row 0 = rank 8

const FILES = 'abcdefgh';
const EMPTY = '.';
// Opposite directions sit at indexes 2k and 2k+1, so the reverse of direction i is i ^ 1.
const ORTHOGONAL: ReadonlyArray<Direction> = [
	[-1, 0],
	[1, 0],
	[0, -1],
	[0, 1],
];
const DIAGONAL: ReadonlyArray<Direction> = [
	[-1, -1],
	[1, 1],
	[-1, 1],
	[1, -1],
];
const NO_DIRECTION = 4;

const bitCount = (mask: number) => {
	let count = 0;
	for (let rest = mask; rest !== 0; rest &= rest - 1) count++;
	return count;
};
const squareName = (index: number) => `${FILES[index % 8]}${8 - Math.floor(index / 8)}`;
const onBoard = (row: number, column: number) => row >= 0 && row < 8 && column >= 0 && column < 8;
const forwardOf = (side: DamaSide) => (side === 'white' ? -1 : 1);
const lastRowOf = (side: DamaSide) => (side === 'white' ? 0 : 7);
const isKing = (cell: string) => cell === 'W' || cell === 'B';
const owns = (side: DamaSide, cell: string) =>
	side === 'white' ? cell === 'w' || cell === 'W' : cell === 'b' || cell === 'B';

export function initialBoard(rules: DamaRuleSet): string {
	const cells: Array<string> = [];
	for (let row = 0; row < 8; row++) {
		for (let column = 0; column < 8; column++) {
			const rank = 8 - row;
			// Normal dama plays on the dark squares, a1 dark (CD2); Türk daması fills ranks 2–3 and 6–7.
			const playable = rules.orthogonal ? rank !== 1 && rank !== 8 : (column + rank) % 2 === 1;
			const white = rules.orthogonal ? rank === 2 || rank === 3 : rank <= 3;
			const black = rules.orthogonal ? rank === 6 || rank === 7 : rank >= 6;
			cells.push(!playable ? EMPTY : white ? 'w' : black ? 'b' : EMPTY);
		}
	}
	return cells.join('');
}

function directionIndexes(rules: DamaRuleSet, side: DamaSide, king: boolean, capture: boolean): Array<number> {
	const all = rules.orthogonal ? ORTHOGONAL : DIAGONAL;
	const forward = forwardOf(side);
	return [0, 1, 2, 3].filter((index) => {
		if (king || (capture && rules.menCaptureBackward)) return true;
		const row = all[index]![0];
		return row === forward || (rules.orthogonal && row === 0);
	});
}

// One capture leg out of a search state.
interface Leg {
	direction: number;
	victim: number;
	land: number;
	king: boolean; // what the mover is when it goes on from `land`
	stop: boolean; // promotion ends the capture here (promoteMidCapture 'stop')
}

// Everything one side can do on one board. The capture search state (square, man/king, direction it came
// from, pieces taken) fixes the board, so each state is expanded once: first for the most pieces it can
// still take, then once more to list one route per distinct result. Routes with the same start, end and
// taken pieces are one move (the FMJD rule), so the list stays small; any of them is accepted (applyPath).
class DamaSearch {
	private readonly cells: Array<string>;
	private readonly bitOf = Array<number>(64).fill(-1); // opponent piece square -> bit in a taken mask
	private readonly all: ReadonlyArray<Direction>;
	private readonly memos = new Map<number, Map<number, number>>(); // per mover square
	private readonly victims: number;
	private mover = -1;
	private memo = new Map<number, number>();
	nodes = 0;

	constructor(
		board: string,
		private readonly side: DamaSide,
		private readonly rules: DamaRuleSet,
	) {
		this.cells = board.split('');
		this.all = rules.orthogonal ? ORTHOGONAL : DIAGONAL;
		let bit = 0;
		for (let square = 0; square < 64; square++) {
			if (this.cells[square] !== EMPTY && !owns(side, this.cells[square]!)) this.bitOf[square] = bit++;
		}
		this.victims = bit;
	}

	piece(square: number): string {
		return this.cells[square]!;
	}

	isKingAt(square: number): boolean {
		return isKing(this.cells[square]!);
	}

	ownsAt(square: number): boolean {
		return owns(this.side, this.cells[square]!);
	}

	bit(square: number): number {
		return 1 << this.bitOf[square]!;
	}

	// The mover's start is empty; taken pieces are gone at once or stay as blockers never jumped again.
	private occupant(square: number, mask: number): 'empty' | 'victim' | 'blocker' {
		if (square === this.mover) return 'empty';
		const bit = this.bitOf[square]!;
		if (bit >= 0 && (mask & (1 << bit)) !== 0) {
			return this.rules.removeCaptured === 'immediately' ? 'empty' : 'blocker';
		}
		if (bit >= 0) return 'victim';
		return this.cells[square] === EMPTY ? 'empty' : 'blocker';
	}

	select(mover: number): void {
		this.mover = mover;
		let memo = this.memos.get(mover);
		if (memo === undefined) {
			memo = new Map();
			this.memos.set(mover, memo);
		}
		this.memo = memo;
	}

	legs(at: number, king: boolean, came: number, mask: number): Array<Leg> {
		const legs: Array<Leg> = [];
		const flying = king && this.rules.flyingKings;
		const lastRow = lastRowOf(this.side);
		for (const direction of directionIndexes(this.rules, this.side, king, true)) {
			if (came !== NO_DIRECTION && direction === (came ^ 1)) continue; // never turn 180° inside a capture
			const [dRow, dColumn] = this.all[direction]!;
			let row = Math.floor(at / 8) + dRow;
			let column = (at % 8) + dColumn;
			while (flying && onBoard(row, column) && this.occupant(row * 8 + column, mask) === 'empty') {
				row += dRow;
				column += dColumn;
			}
			if (!onBoard(row, column)) continue;
			const victim = row * 8 + column;
			if (this.occupant(victim, mask) !== 'victim') continue;
			const taken = mask | this.bit(victim);
			row += dRow;
			column += dColumn;
			while (onBoard(row, column) && this.occupant(row * 8 + column, taken) === 'empty') {
				const reachesLastRow = !king && row === lastRow;
				legs.push({
					direction,
					victim,
					land: row * 8 + column,
					king: king || (reachesLastRow && this.rules.promoteMidCapture === 'promote_and_continue'),
					stop: reachesLastRow && this.rules.promoteMidCapture === 'stop',
				});
				if (!flying) break;
				row += dRow;
				column += dColumn;
			}
		}
		return legs;
	}

	// Most further pieces the mover can take from this state.
	// TEMPORARY: the search runs on the API event loop (up to ~100 ms of CPU at DAMA_SEARCH_NODE_BUDGET; past
	// it the search keeps what it found, deterministic, and could miss a longer capture in a position no test has
	// found). The position cache (`searched`) only spares repeats within one API process, and holds no generation over
	// DAMA_SEARCH_CACHE_PATHS_MAX paths: such a rare position is searched again on each use, a few times a turn (the
	// heaviest lattice found, 547 results, takes ~120k nodes / ~37 ms each time). Trigger: the 'Dama move search over
	// 50k nodes' warning (each ≥ ~10 ms of CPU, re-searches included) more than once a second in one API process, i.e.
	// ≥ 1% of its time in long searches. Path: move generation off the event loop (a worker thread, or out of process),
	// or a (table, version) result cache.
	extra(at: number, king: boolean, came: number, mask: number): number {
		const key = ((mask * 64 + at) * 2 + (king ? 1 : 0)) * 5 + came;
		const known = this.memo.get(key);
		if (known !== undefined) return known;
		if (this.nodes >= DAMA_SEARCH_NODE_BUDGET) return 0;
		this.nodes++;
		searchedNodes++;
		let best = 0;
		const left = this.victims - bitCount(mask);
		for (const leg of this.legs(at, king, came, mask)) {
			const total = 1 + (leg.stop ? 0 : this.extra(leg.land, leg.king, leg.direction, mask | this.bit(leg.victim)));
			if (total > best) best = total;
			if (best === left) break; // took everything that is left: nothing can do better
		}
		this.memo.set(key, best);
		return best;
	}

	// Most pieces any of the side's pieces can take (0: no capture this turn).
	most(): number {
		let most = 0;
		for (let from = 0; from < 64; from++) {
			if (!this.ownsAt(from)) continue;
			this.select(from);
			most = Math.max(most, this.extra(from, this.isKingAt(from), NO_DIRECTION, 0));
			if (most === this.victims) break;
		}
		return most;
	}

	// One route per distinct (end, taken pieces, promotion) taking `need` pieces from `from`.
	routes(from: number, need: number, out: Array<Array<number>>): void {
		this.select(from);
		const seen = new Set<string>();
		const expanded = new Set<number>();
		const path = [from];
		const lastRow = lastRowOf(this.side);
		const walk = (at: number, king: boolean, came: number, mask: number, left: number) => {
			const key = ((mask * 64 + at) * 2 + (king ? 1 : 0)) * 5 + came;
			if (expanded.has(key) || this.nodes >= DAMA_SEARCH_NODE_BUDGET) return; // same state, same results
			expanded.add(key);
			this.nodes++;
			searchedNodes++;
			for (const leg of this.legs(at, king, came, mask)) {
				if (out.length >= DAMA_LEGAL_PATHS_MAX) return;
				const taken = mask | this.bit(leg.victim);
				const rest = leg.stop ? 0 : this.extra(leg.land, leg.king, leg.direction, taken);
				if (1 + rest !== left) continue;
				path.push(leg.land);
				if (rest === 0) {
					const id = `${leg.land},${taken},${leg.king || Math.floor(leg.land / 8) === lastRow}`;
					if (!seen.has(id)) {
						seen.add(id);
						out.push(path.slice());
					}
				} else {
					walk(leg.land, leg.king, leg.direction, taken, left - 1);
				}
				path.pop();
			}
		};
		walk(from, this.isKingAt(from), NO_DIRECTION, 0, need);
	}

	// Plain (non-capture) targets: allowed directions over empty squares, one square unless a flying king.
	plainTargets(from: number): Array<number> {
		const king = this.isKingAt(from);
		const targets: Array<number> = [];
		for (const direction of directionIndexes(this.rules, this.side, king, false)) {
			const [dRow, dColumn] = this.all[direction]!;
			let row = Math.floor(from / 8) + dRow;
			let column = (from % 8) + dColumn;
			while (onBoard(row, column) && this.cells[row * 8 + column] === EMPTY) {
				targets.push(row * 8 + column);
				if (!(king && this.rules.flyingKings)) break;
				row += dRow;
				column += dColumn;
			}
		}
		return targets;
	}
}

interface Generation {
	most: number;
	paths: ReadonlyArray<ReadonlyArray<string>>;
	nodes: number;
}

function generate(board: string, side: DamaSide, rules: DamaRuleSet): Generation {
	const search = new DamaSearch(board, side, rules);
	const most = search.most();
	const out: Array<Array<number>> = [];
	if (most === 0) {
		for (let from = 0; from < 64; from++) {
			if (!search.ownsAt(from)) continue;
			for (const to of search.plainTargets(from)) out.push([from, to]);
		}
	}
	for (let from = 0; most > 0 && from < 64 && out.length < DAMA_LEGAL_PATHS_MAX; from++) {
		if (search.ownsAt(from)) search.routes(from, most, out);
	}
	return {most, paths: out.slice(0, DAMA_LEGAL_PATHS_MAX).map((path) => path.map(squareName)), nodes: search.nodes};
}

// One generation per position serves the move check (applyPath), the blocked check of the next position
// (hasLegalMove), the mover's view and every later GET or illegal move on the same board. Each rule set has
// its own cache; 256 positions each, holding only generations of at most DAMA_SEARCH_CACHE_PATHS_MAX paths. A held
// path measured ~585 B at 17 squares and ~117 B as a plain move: ≤ ~150 KB per entry, ≤ ~75 MB for both caches in
// one process even if every entry were 256 longest captures (a real game's entries are a few KB). TEMPORARY: DamaSearch.extra's note.
const DAMA_SEARCH_CACHE_SIZE = 256;
const DAMA_SEARCH_CACHE_PATHS_MAX = 256;
const DAMA_SEARCH_WARN_NODES = 50_000;
const searches = new WeakMap<DamaRuleSet, SearchCache<Generation>>();

function searched(board: string, side: DamaSide, rules: DamaRuleSet): Generation {
	let cache = searches.get(rules);
	if (cache === undefined) {
		cache = searchCache<Generation>(DAMA_SEARCH_CACHE_SIZE, ({paths}) => paths.length <= DAMA_SEARCH_CACHE_PATHS_MAX);
		searches.set(rules, cache);
	}
	return cache(`${side}${board}`, () => {
		const generation = generate(board, side, rules);
		if (generation.nodes > DAMA_SEARCH_WARN_NODES) {
			Logger.warn({nodes: generation.nodes, paths: generation.paths.length}, 'Dama move search over 50k nodes');
		}
		return generation;
	});
}

// Legal moves of the side to move, as square paths: the captures taking the most pieces (one route per
// distinct result), or the plain moves when nothing can be taken. At most DAMA_LEGAL_PATHS_MAX entries.
export function legalPaths(board: string, side: DamaSide, rules: DamaRuleSet): ReadonlyArray<ReadonlyArray<string>> {
	return searched(board, side, rules).paths;
}

// Whether the side has any move at all: a capture, or a plain move (listed whenever nothing can be taken).
export function hasLegalMove(board: string, side: DamaSide, rules: DamaRuleSet): boolean {
	const {most, paths} = searched(board, side, rules);
	return most > 0 || paths.length > 0;
}

// Checks a requested move leg by leg (no list lookup) and plays it: every leg a legal capture (or a single
// legal plain step) and as many pieces taken as the most any capture takes. null when it is not legal.
export function applyPath(
	board: string,
	side: DamaSide,
	rules: DamaRuleSet,
	path: ReadonlyArray<string>,
): DamaMove | null {
	const squares = path.map(damaSquareIndex);
	const search = new DamaSearch(board, side, rules);
	const from = squares[0]!;
	if (!search.ownsAt(from)) return null;
	const piece = search.piece(from);
	const after = board.split('');
	after[from] = EMPTY;
	const {most} = searched(board, side, rules);
	if (most === 0) {
		if (squares.length !== 2 || !search.plainTargets(from).includes(squares[1]!)) return null;
		const to = squares[1]!;
		const forward = Math.floor(to / 8) - Math.floor(from / 8) === forwardOf(side);
		after[to] = !isKing(piece) && Math.floor(to / 8) === lastRowOf(side) ? piece.toUpperCase() : piece;
		return {captured: [], board: after.join(''), advance: !isKing(piece) && forward};
	}
	if (squares.length !== most + 1) return null;
	search.select(from);
	let at = from;
	let king = isKing(piece);
	let came = NO_DIRECTION;
	let mask = 0;
	const captured: Array<number> = [];
	for (let index = 1; index < squares.length; index++) {
		const leg = search.legs(at, king, came, mask).find((candidate) => candidate.land === squares[index]);
		if (leg === undefined || (leg.stop && index < squares.length - 1)) return null;
		captured.push(leg.victim);
		mask |= search.bit(leg.victim);
		at = leg.land;
		king = leg.king || leg.stop;
		came = leg.direction;
	}
	for (const square of captured) after[square] = EMPTY;
	after[at] = king || Math.floor(at / 8) === lastRowOf(side) ? piece.toUpperCase() : piece;
	return {captured: captured.map(squareName), board: after.join(''), advance: true};
}

// Every capture search state expanded in this process so far (the search cache's tests read it).
let searchedNodes = 0;
export const damaSearchedNodes = (): number => searchedNodes;

// Search work for one generation (worst-case tests only).
export function searchNodes(board: string, side: DamaSide, rules: DamaRuleSet): number {
	return generate(board, side, rules).nodes;
}
