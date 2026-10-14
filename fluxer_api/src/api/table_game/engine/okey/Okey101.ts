// SPDX-License-Identifier: AGPL-3.0-or-later

import {OKEY101_RULES as RULES} from '@app/api/table_game/engine/okey/Okey101Rules';
import {
	isOkey,
	newDeck,
	type OkeyFace,
	okeyFaceOf,
	pickIndicator,
	tileFace,
} from '@app/api/table_game/engine/okey/OkeyDeck';
import {canExtend, type OkeyMeldKind, validatePairs, validateSet} from '@app/api/table_game/engine/okey/OkeyMelds';
import {
	type EngineClock,
	type TableGameEngine,
	TableGameRuleError,
	type TablePosition,
} from '@app/api/table_game/engine/TableGameEngine';
import {
	okeyTileToken,
	parseOkeyTileToken,
	TABLE_GAME_MAX_CONSECUTIVE_TIMEOUTS,
} from '@fluxer/constants/src/TableGameConstants';
import type {
	TableGameAction,
	TableGameResult,
	TableGameRuleReason,
} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';

type Opened = 'none' | 'sets' | 'pairs';
type LayDown = Pick<Extract<TableGameAction, {type: 'meld'}>, 'open' | 'add'>;

export interface Okey101TableMeld {
	readonly owner: TablePosition;
	readonly kind: OkeyMeldKind;
	readonly tiles: ReadonlyArray<number>;
}

// 101 Okey, one hand. Plain JSON so it can live in the table's KV envelope. Arrays are
// indexed by position - 1; a meld's id is its index. this state never leaves the API, clients only get
// view(), and no rack is shown to anyone but its owner, not even at the end.
export interface Okey101State {
	readonly indicator: number;
	readonly pile: ReadonlyArray<number>; // the next draw is the last element
	readonly racks: ReadonlyArray<ReadonlyArray<number>>;
	readonly discards: ReadonlyArray<ReadonlyArray<number>>; // tiles each position threw, oldest first
	readonly melds: ReadonlyArray<Okey101TableMeld>;
	readonly turn: TablePosition;
	readonly phase: 'draw' | 'play';
	readonly drawn: number | null; // the tile drawn from the pile this turn (a timeout throws it)
	readonly opened: ReadonlyArray<Opened>;
	readonly openedAt: ReadonlyArray<number | null>; // value of `turns` on the turn each position opened
	readonly penalties: ReadonlyArray<number>;
	readonly deadlineAt: number;
	readonly timeouts: ReadonlyArray<number>; // consecutive timeouts per position
	readonly turns: number; // completed turns
	readonly scores: ReadonlyArray<number> | null; // once the hand is scored
	readonly result: TableGameResult | null;
}

interface Finish {
	readonly finisher: TablePosition;
	readonly multiplier: number;
	readonly finish: 'normal' | 'okey' | 'hand';
}

const POSITIONS: ReadonlyArray<TablePosition> = [1, 2, 3, 4];

const nextPosition = (position: TablePosition) => ((position % 4) + 1) as TablePosition;
const previousPosition = (position: TablePosition) => (((position + 2) % 4) + 1) as TablePosition;

function fail(reason: TableGameRuleReason): never {
	throw new TableGameRuleError(reason);
}

function replaceAt<T>(items: ReadonlyArray<T>, index: number, value: T): Array<T> {
	return items.map((item, at) => (at === index ? value : item));
}

function expectTurn(state: Okey101State, actor: TablePosition, phase: Okey101State['phase']): void {
	if (actor !== state.turn) fail('not_your_turn');
	if (state.phase !== phase) fail('wrong_phase');
}

function rackTile(rack: ReadonlyArray<number>, token: string): number {
	const tile = parseOkeyTileToken(token);
	if (tile === null || !rack.includes(tile)) fail('tile_not_in_rack');
	return tile;
}

// Opening points of a run or group: its numbers, an okey counting the number it stands for, the 1
// that closes 12-13-1 counting ACE_AFTER_KING_POINTS. Null when the tiles are neither.
export function setPoints(tiles: ReadonlyArray<number>, okey: OkeyFace): number | null {
	const set = validateSet(tiles, okey);
	if (set === null) return null;
	return set.kind === 'run' && endsWithAceAfterKing(tiles, okey)
		? set.value - 1 + RULES.ACE_AFTER_KING_POINTS
		: set.value;
}

// For a valid run, read the way OkeyMelds reads it: a 1 can only open a run or close it after 13.
function endsWithAceAfterKing(run: ReadonlyArray<number>, okey: OkeyFace): boolean {
	const anchor = run.findIndex((tile) => !isOkey(tile, okey));
	const number = tileFace(run[anchor]!, okey).number;
	const start = number === 1 && anchor > 0 ? 14 - anchor : number - anchor;
	return start + run.length - 1 === 14;
}

function rackPoints(rack: ReadonlyArray<number>, okey: OkeyFace): number {
	return rack.reduce(
		(sum, tile) => sum + (isOkey(tile, okey) ? RULES.OKEY_IN_HAND_VALUE : tileFace(tile, okey).number),
		0,
	);
}

// One opening is all pairs or all runs/groups (MIX_SETS_AND_PAIRS_ON_OPEN false).
function openingKind(opening: ReadonlyArray<ReadonlyArray<number>>, okey: OkeyFace): 'sets' | 'pairs' {
	if (opening.every((set) => set.length === 2)) {
		if (!validatePairs(opening, okey)) fail('invalid_meld');
		return 'pairs';
	}
	if (!opening.every((set) => validateSet(set, okey) !== null)) fail('invalid_meld');
	return 'sets';
}

// new melds and additions from the rack (plus `taken`, the discard taken in this action).
// The first opening must reach its minimum within one action; later melds have no minimum but keep the
// opening's kind. Additions start on the turn after the opening. A tile must stay to be discarded.
function layDown(state: Okey101State, actor: TablePosition, action: LayDown, taken: number | null): Okey101State {
	const okey = okeyFaceOf(state.indicator);
	const rack = taken === null ? state.racks[actor - 1]! : [...state.racks[actor - 1]!, taken];
	const opening = (action.open ?? []).map((set) => set.map((token) => rackTile(rack, token)));
	const additions = (action.add ?? []).map((addition) => ({
		meldId: addition.meld_id,
		at: addition.at,
		tiles: addition.tiles.map((token) => rackTile(rack, token)),
	}));
	const used = [...opening.flat(), ...additions.flatMap((addition) => addition.tiles)];
	if (taken !== null && RULES.TAKE_DISCARD_REQUIRES_USE && !used.includes(taken)) fail('take_unused');
	if ((used.length === 0 && taken === null) || new Set(used).size !== used.length) fail('invalid_meld');
	if (used.length >= rack.length) fail('must_finish_with_discard');

	let opened = state.opened[actor - 1]!;
	let openedAt = state.openedAt[actor - 1]!;
	const melds = [...state.melds];
	if (opening.length > 0) {
		const kind = openingKind(opening, okey);
		if (opened === 'none') {
			if (kind === 'pairs' && opening.length < RULES.OPEN_MIN_PAIRS) fail('pairs_too_few');
			const points = opening.reduce((sum, set) => sum + (setPoints(set, okey) ?? 0), 0);
			if (kind === 'sets' && points < RULES.OPEN_MIN_POINTS) fail('open_too_low');
			opened = kind;
			openedAt = state.turns;
		} else if (kind !== opened) {
			fail('invalid_meld');
		}
		for (const tiles of opening) {
			melds.push({owner: actor, kind: kind === 'pairs' ? 'pair' : validateSet(tiles, okey)!.kind, tiles});
		}
	}
	if (additions.length > 0) {
		if (opened === 'none') fail('not_opened');
		if (!RULES.ADD_ON_OPEN_TURN && openedAt === state.turns) fail('cannot_add');
		if (opened === 'pairs' && !RULES.PAIR_OPENER_MAY_ADD) fail('cannot_add');
		for (const {meldId, at, tiles} of additions) {
			const meld = melds[meldId];
			if (meld === undefined || !canExtend(meld, tiles, at, okey)) fail('cannot_add');
			melds[meldId] = {...meld, tiles: at === 'start' ? [...tiles, ...meld.tiles] : [...meld.tiles, ...tiles]};
		}
	}
	return {
		...state,
		racks: replaceAt(
			state.racks,
			actor - 1,
			rack.filter((tile) => !used.includes(tile)),
		),
		melds,
		opened: replaceAt(state.opened, actor - 1, opened),
		openedAt: replaceAt(state.openedAt, actor - 1, openedAt),
	};
}

function drawFromPile(state: Okey101State, actor: TablePosition): Okey101State {
	const tile = state.pile.at(-1)!;
	return {
		...state,
		pile: state.pile.slice(0, -1),
		racks: replaceAt(state.racks, actor - 1, [...state.racks[actor - 1]!, tile]),
		phase: 'play',
		drawn: tile,
	};
}

// only the previous player's last discard, and it has to be laid down in the same action.
function takeDiscard(state: Okey101State, actor: TablePosition, action: LayDown): Okey101State {
	const from = previousPosition(actor) - 1;
	const offered = state.discards[from]!;
	if (offered.length === 0) fail('illegal_move');
	const took = {...state, discards: replaceAt(state.discards, from, offered.slice(0, -1))};
	return {...layDown(took, actor, action, offered.at(-1)!), phase: 'play', drawn: null};
}

// throwing the okey, or a tile some meld on the table could take.
function discardPenalty(state: Okey101State, tile: number, okey: OkeyFace): number {
	if (isOkey(tile, okey)) return RULES.DISCARD_OKEY_PENALTY;
	const playable = state.melds.some(
		(meld) => canExtend(meld, [tile], 'start', okey) || canExtend(meld, [tile], 'end', okey),
	);
	return playable ? RULES.DISCARD_PLAYABLE_PENALTY : 0;
}

// the last tile finishes the hand and carries no penalty.
function discard(state: Okey101State, actor: TablePosition, tile: number, clock: EngineClock): Okey101State {
	const okey = okeyFaceOf(state.indicator);
	const rack = state.racks[actor - 1]!;
	const finishing = rack.length === 1;
	const penalty = finishing ? 0 : discardPenalty(state, tile, okey);
	const thrown: Okey101State = {
		...state,
		racks: replaceAt(
			state.racks,
			actor - 1,
			rack.filter((id) => id !== tile),
		),
		discards: replaceAt(state.discards, actor - 1, [...state.discards[actor - 1]!, tile]),
		penalties: replaceAt(state.penalties, actor - 1, state.penalties[actor - 1]! + penalty),
	};
	if (!finishing) return passTurn(thrown, clock);
	const okeyFinish = isOkey(tile, okey);
	const handFinish = state.openedAt[actor - 1] === state.turns;
	return scoreHand(thrown, {
		finisher: actor,
		multiplier: (okeyFinish ? RULES.OKEY_FINISH_MULTIPLIER : 1) * (handFinish ? RULES.HAND_FINISH_MULTIPLIER : 1),
		finish: okeyFinish ? 'okey' : handFinish ? 'hand' : 'normal',
	});
}

// The next player's draw phase; with the pile gone the hand ends without a finisher.
function passTurn(state: Okey101State, clock: EngineClock): Okey101State {
	const passed: Okey101State = {
		...state,
		turn: nextPosition(state.turn),
		phase: 'draw',
		drawn: null,
		deadlineAt: clock.now + clock.turnMs,
		turns: state.turns + 1,
	};
	return state.pile.length === 0 ? scoreHand(passed, null) : passed;
}

// finisher −101, unopened +202, opened their rack (okey 101, doubled for pair openers), all times the
// finish multiplier, plus penalties. The lowest total wins; ties share.
function scoreHand(state: Okey101State, finish: Finish | null): Okey101State {
	const okey = okeyFaceOf(state.indicator);
	const multiplier = finish?.multiplier ?? 1;
	const scores = POSITIONS.map((position) => {
		const opened = state.opened[position - 1]!;
		const base =
			position === finish?.finisher
				? RULES.WINNER_SCORE
				: opened === 'none'
					? RULES.UNOPENED_SCORE
					: rackPoints(state.racks[position - 1]!, okey) * (opened === 'pairs' ? RULES.PAIR_OPENER_MULTIPLIER : 1);
		return base * multiplier + state.penalties[position - 1]!;
	});
	const best = Math.min(...scores);
	return {
		...state,
		scores,
		result: {
			kind: 'win',
			winners: POSITIONS.filter((position) => scores[position - 1] === best),
			reason: 'score',
			...(finish === null ? {} : {finish: finish.finish}),
		},
	};
}

// the drawn tile, unless it is the okey or a meld could take it; then the first tile that is neither.
function timeoutTile(state: Okey101State, actor: TablePosition): number {
	const okey = okeyFaceOf(state.indicator);
	const rack = state.racks[actor - 1]!;
	const candidates = state.drawn !== null && rack.includes(state.drawn) ? [state.drawn, ...rack] : rack;
	return (
		candidates.find((tile) => discardPenalty(state, tile, okey) === 0) ??
		candidates.find((tile) => !isOkey(tile, okey)) ??
		candidates[0]!
	);
}

function resetTimeouts(state: Okey101State, actor: TablePosition): Okey101State {
	return {...state, timeouts: replaceAt(state.timeouts, actor - 1, 0)};
}

export const Okey101: TableGameEngine<Okey101State> = {
	kind: 'okey101',
	positions: POSITIONS,

	start(positions, rng, clock) {
		if (positions.length !== POSITIONS.length || POSITIONS.some((position) => !positions.includes(position))) {
			throw new Error('101 okey needs all four positions');
		}
		const {indicator, rest} = pickIndicator(newDeck(rng), rng);
		const starter = POSITIONS[rng.int(POSITIONS.length)]!;
		const racks: Array<Array<number>> = [];
		let dealt = 0;
		for (let offset = 0; offset < POSITIONS.length; offset++) {
			const size = offset === 0 ? RULES.DEAL_SIZE + 1 : RULES.DEAL_SIZE;
			racks[(starter - 1 + offset) % POSITIONS.length] = rest.slice(dealt, dealt + size);
			dealt += size;
		}
		return {
			indicator,
			pile: rest.slice(dealt),
			racks,
			discards: POSITIONS.map(() => []),
			melds: [],
			turn: starter,
			phase: 'play', // the starter plays without drawing (Ek B 2)
			drawn: null,
			opened: POSITIONS.map(() => 'none'),
			openedAt: POSITIONS.map(() => null),
			penalties: POSITIONS.map(() => 0),
			deadlineAt: clock.now + clock.turnMs,
			timeouts: POSITIONS.map(() => 0),
			turns: 0,
			scores: null,
			result: null,
		};
	},

	apply(state, actor, action: TableGameAction, _rng, clock) {
		if (state.result !== null) fail('game_over');
		switch (action.type) {
			case 'draw':
				if (action.from !== 'pile') fail('unsupported_action'); // 101 takes a discard with take_discard
				expectTurn(state, actor, 'draw');
				return resetTimeouts(drawFromPile(state, actor), actor);
			case 'take_discard':
				expectTurn(state, actor, 'draw');
				return resetTimeouts(takeDiscard(state, actor, action), actor);
			case 'meld':
				expectTurn(state, actor, 'play');
				return resetTimeouts(layDown(state, actor, action, null), actor);
			case 'discard':
				expectTurn(state, actor, 'play');
				return resetTimeouts(discard(state, actor, rackTile(state.racks[actor - 1]!, action.tile), clock), actor);
			default:
				return fail('unsupported_action');
		}
	},

	onDeadline(state, _rng, clock) {
		if (state.result !== null) return state;
		const actor = state.turn;
		const count = state.timeouts[actor - 1]! + 1;
		const counted = {...state, timeouts: replaceAt(state.timeouts, actor - 1, count)};
		if (count >= TABLE_GAME_MAX_CONSECUTIVE_TIMEOUTS) {
			return {...counted, result: {kind: 'forfeit', loser: actor, reason: 'timeouts'}};
		}
		const holding = state.phase === 'draw' ? drawFromPile(counted, actor) : counted;
		return discard(holding, actor, timeoutTile(holding, actor), clock);
	},

	forfeit(state, loser, reason) {
		return state.result !== null ? state : {...state, result: {kind: 'forfeit', loser, reason}};
	},

	cancel(state, reason) {
		return state.result !== null ? state : {...state, result: {kind: 'canceled', reason}};
	},

	deadline(state) {
		return state.result !== null ? null : state.deadlineAt;
	},

	result(state) {
		return state.result;
	},

	view(state, viewer) {
		const ended = state.result !== null;
		return {
			game: 'okey101',
			indicator: okeyTileToken(state.indicator),
			pile_count: state.pile.length,
			discards: state.discards.map((pile) => pile.map(okeyTileToken)),
			rack_counts: state.racks.map((rack) => rack.length),
			turn: ended ? null : state.turn,
			phase: state.phase,
			deadline_at: ended ? null : new Date(state.deadlineAt).toISOString(),
			rack: viewer === null ? null : state.racks[viewer - 1]!.map(okeyTileToken),
			melds: state.melds.map((meld, id) => ({
				id,
				owner: meld.owner,
				kind: meld.kind,
				tiles: meld.tiles.map(okeyTileToken),
			})),
			opened: [...state.opened],
			penalties: [...state.penalties],
			scores: state.scores === null ? null : [...state.scores],
		};
	},
};
