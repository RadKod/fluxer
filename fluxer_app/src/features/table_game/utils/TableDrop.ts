// SPDX-License-Identifier: AGPL-3.0-or-later

import {type OkeyStage, stagedTiles} from '@app/features/table_game/components/okey/Okey101Staging';
import {
	layoutRack,
	moveRackTile,
	RACK_CELLS,
	rackGroups,
	trimRack,
} from '@app/features/table_game/components/okey/OkeyRackModel';
import type {RackSlot} from '@app/features/table_game/state/TableGames';
import {parsePaths, pathsFor} from '@app/features/table_game/utils/DamaPaths';
import {chessSideToMove} from '@app/features/table_game/utils/TableGameDeadline';
import {completes, expandTavlaPlays, nextLegalSteps, type TavlaStep} from '@app/features/table_game/utils/TavlaSteps';
import type {TableDragSource, TableDropTarget} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import type {
	ChessView,
	DamaNormalView,
	DamaView,
	Okey101View,
	OkeyView,
	TableGameAction,
	TableGameView,
	TavlaView,
} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';

export type TableDropOutcome =
	| {kind: 'action'; action: TableGameAction}
	// Local, no request.
	| {kind: 'rack'; order: ReadonlyArray<RackSlot>}
	// 101 pending.
	| {kind: 'stage'; stage: OkeyStage}
	// Local step.
	| {kind: 'tavla_step'; steps: ReadonlyArray<TavlaStep>}
	// Dama: several paths with the same start and end.
	| {kind: 'choose_path'; paths: ReadonlyArray<ReadonlyArray<string>>}
	// Chess promotion picker.
	| {kind: 'promotion'; from: string; to: string}
	| {kind: 'none'; reason: 'illegal' | 'not_your_turn' | 'wrong_phase' | 'read_only'};

export interface TableDropInput {
	view: TableGameView;
	me: 1 | 2 | 3 | 4 | null;
	rack: ReadonlyArray<RackSlot>;
	stage: OkeyStage | null;
	tavlaSteps: ReadonlyArray<TavlaStep>;
	source: TableDragSource;
	target: TableDropTarget;
}

type Position = 1 | 2 | 3 | 4;
type None = Extract<TableDropOutcome, {kind: 'none'}>;

const READ_ONLY: None = {kind: 'none', reason: 'read_only'};
const ILLEGAL: None = {kind: 'none', reason: 'illegal'};
const NOT_YOUR_TURN: None = {kind: 'none', reason: 'not_your_turn'};
const WRONG_PHASE: None = {kind: 'none', reason: 'wrong_phase'};
const EMPTY_STAGE: OkeyStage = {take: null, open: [], add: []};
// Classic Okey finishes from 15 tiles: 14 in sets and the one thrown.
const CLASSIC_FINISH_RACK_SIZE = 15;

const action = (value: TableGameAction): TableDropOutcome => ({kind: 'action', action: value});

// The shape the server accepts (2 to 13 tiles a set); anything else is refused here without a request.
const validSets = (sets: ReadonlyArray<ReadonlyArray<string>>, maxSets: number) =>
	sets.length > 0 && sets.length <= maxSets && sets.every((set) => set.length >= 2 && set.length <= 13);

// The set a tile stands in on the rack (touching tiles, as rackGroups reads them), less what is already staged.
function setOf(cells: ReadonlyArray<RackSlot>, tile: string, stage: OkeyStage | null): Array<string> {
	const staged = stagedTiles(stage);
	const group = rackGroups(cells).find((set) => set.includes(tile)) ?? [];
	return group.filter((other) => other === tile || !staged.includes(other));
}

// 101: the previous player's last discard, laid down in the same take_discard as the staged sets (Ek B 3).
function takeFromDiscard(
	game: Okey101View,
	me: Position,
	cells: ReadonlyArray<RackSlot>,
	stage: OkeyStage | null,
	top: string,
	target: TableDropTarget,
): TableDropOutcome {
	if (stage?.take) return ILLEGAL;
	const base = stage ?? EMPTY_STAGE;
	switch (target.kind) {
		case 'rack_cell': {
			// Dropped into a gap: it completes the set it lands next to.
			if (cells[target.cell] !== null) return ILLEGAL;
			const placed = [...cells];
			placed[target.cell] = top;
			const group = setOf(placed, top, stage);
			return {kind: 'stage', stage: {...base, take: top, open: group.length >= 2 ? [...base.open, group] : base.open}};
		}
		case 'meld_zone':
			return {kind: 'stage', stage: {...base, take: top}};
		case 'meld_end':
			if (game.opened[me - 1] === 'none') return WRONG_PHASE;
			if (!game.melds.some((meld) => meld.id === target.meldId)) return ILLEGAL;
			return {
				kind: 'stage',
				stage: {...base, take: top, add: [...base.add, {meld_id: target.meldId, tiles: [top], at: target.at}]},
			};
		default:
			return ILLEGAL;
	}
}

function resolveOkey(p: TableDropInput, game: OkeyView | Okey101View, me: Position): TableDropOutcome {
	const {source, target, stage} = p;
	const cells = layoutRack(p.rack);
	// Arranging the rack is local and needs no turn.
	if (source.kind === 'rack_tile' && target.kind === 'rack_cell') {
		const from = cells.indexOf(source.tile);
		if (from < 0 || from === target.cell || target.cell < 0 || target.cell >= RACK_CELLS) return ILLEGAL;
		return {kind: 'rack', order: trimRack(moveRackTile(cells, from, target.cell))};
	}
	if (game.turn !== me) return NOT_YOUR_TURN;
	const classic = game.game === 'okey';

	if (source.kind === 'pile') {
		if (target.kind !== 'rack_cell') return ILLEGAL;
		if (game.phase !== 'draw') return WRONG_PHASE;
		return game.pile_count > 0 ? action({type: 'draw', from: 'pile'}) : ILLEGAL;
	}

	if (source.kind === 'discard_top') {
		const previous = ((me + 2) % 4) + 1;
		const top = game.discards[previous - 1]?.at(-1);
		if (source.position !== previous || top === undefined) return ILLEGAL;
		if (game.phase !== 'draw') return WRONG_PHASE;
		if (game.game === 'okey') return target.kind === 'rack_cell' ? action({type: 'draw', from: 'discard'}) : ILLEGAL;
		return takeFromDiscard(game, me, cells, stage, top, target);
	}

	if (source.kind !== 'rack_tile') return ILLEGAL;
	const tile = source.tile;
	if (!cells.includes(tile) || stagedTiles(stage).includes(tile)) return ILLEGAL;

	switch (target.kind) {
		case 'discard_zone':
			if (game.phase !== (classic ? 'discard' : 'play')) return WRONG_PHASE;
			return action({type: 'discard', tile});
		case 'finish_zone': {
			if (!classic) return ILLEGAL;
			if (game.phase !== 'discard') return WRONG_PHASE;
			const sets = rackGroups(cells, tile);
			if (game.rack?.length !== CLASSIC_FINISH_RACK_SIZE || !validSets(sets, 7)) return ILLEGAL;
			return action({type: 'finish', tile, sets});
		}
		case 'meld_zone':
		case 'meld_end': {
			if (game.game === 'okey') return ILLEGAL;
			// A tile taken from the side is still pending: everything joins that one take_discard.
			const pending = stage?.take != null && game.phase === 'draw';
			if (!pending && game.phase !== 'play') return WRONG_PHASE;
			const opened = game.opened[me - 1] !== 'none';
			const base = stage ?? EMPTY_STAGE;
			if (target.kind === 'meld_zone') {
				const group = setOf(cells, tile, stage);
				if (group.length < 2 || group.length > 13) return ILLEGAL;
				if (pending || !opened) return {kind: 'stage', stage: {...base, open: [...base.open, group]}};
				return action({type: 'meld', open: [group]});
			}
			if (!opened) return WRONG_PHASE;
			if (!game.melds.some((meld) => meld.id === target.meldId)) return ILLEGAL;
			const addition = {meld_id: target.meldId, tiles: [tile], at: target.at};
			if (pending) return {kind: 'stage', stage: {...base, add: [...base.add, addition]}};
			return action({type: 'meld', add: [addition]});
		}
		default:
			return ILLEGAL;
	}
}

function resolveChess(p: TableDropInput, game: ChessView, me: Position): TableDropOutcome {
	const whiteToMove = chessSideToMove(game.fen) === 'white';
	if ((whiteToMove ? game.white : 4 - game.white) !== me) return NOT_YOUR_TURN;
	const {source, target} = p;
	if (source.kind !== 'square' || target.kind !== 'square') return ILLEGAL;
	const uci = `${source.square}${target.square}`;
	const moves = (game.legal_moves ?? []).filter((move) => move.startsWith(uci));
	if (moves.length === 0) return ILLEGAL;
	if (moves.some((move) => move.length === 5)) return {kind: 'promotion', from: source.square, to: target.square};
	return action({type: 'move', from: source.square, to: target.square});
}

function resolveDama(p: TableDropInput, game: DamaView | DamaNormalView, me: Position): TableDropOutcome {
	if (game.turn !== me) return NOT_YOUR_TURN;
	const {source, target} = p;
	if (source.kind !== 'square' || target.kind !== 'square') return ILLEGAL;
	const paths = pathsFor(parsePaths(game.legal_moves), source.square, target.square);
	if (paths.length === 0) return ILLEGAL;
	if (paths.length > 1) return {kind: 'choose_path', paths};
	return action({type: 'dama_move', path: [...paths[0]!]});
}

// My checkers on a point (or the bar) once my local steps are played.
function tavlaCheckers(game: TavlaView, steps: ReadonlyArray<TavlaStep>, point: number | 'bar'): number {
	const white = game.turn === game.white;
	let count =
		point === 'bar'
			? game.bar[white ? 'white' : 'black']
			: Math.max(0, (white ? 1 : -1) * (game.points[point - 1] ?? 0));
	for (const step of steps) {
		if (step.from === point) count--;
		if (step.to === point) count++;
	}
	return count;
}

// The steps that may follow from the dragged point, or why there are none.
function tavlaChoices(
	p: Omit<TableDropInput, 'target'>,
	game: TavlaView,
	me: Position,
): ReadonlyArray<TavlaStep> | None {
	if (game.turn !== me) return NOT_YOUR_TURN;
	const {source, tavlaSteps} = p;
	if (source.kind !== 'tavla_point' || tavlaCheckers(game, tavlaSteps, source.point) <= 0) return ILLEGAL;
	return nextLegalSteps(expandTavlaPlays(game), tavlaSteps).filter((step) => step.from === source.point);
}

function resolveTavla(p: TableDropInput, game: TavlaView, me: Position): TableDropOutcome {
	const choices = tavlaChoices(p, game, me);
	if ('kind' in choices) return choices;
	const to = p.target.kind === 'tavla_off' ? 'off' : p.target.kind === 'tavla_point' ? p.target.point : null;
	const step = choices.find((choice) => choice.to === to);
	if (!step) return ILLEGAL;
	const steps = [...p.tavlaSteps, step];
	// The turn is whole: it goes out by itself, as one request.
	if (completes(expandTavlaPlays(game), steps)) return action({type: 'tavla_move', moves: steps});
	return {kind: 'tavla_step', steps};
}

// Only called on drop (never while dragging): its one action is the one request the caller sends.
export function resolveTableDrop(p: TableDropInput): TableDropOutcome {
	const {view, me} = p;
	const game = view.game_view;
	if (me === null || game === null || view.summary.status !== 'playing') return READ_ONLY;
	switch (game.game) {
		case 'okey':
		case 'okey101':
			return resolveOkey(p, game, me);
		case 'chess':
			return resolveChess(p, game, me);
		case 'dama':
		case 'dama_normal':
			return resolveDama(p, game, me);
		case 'tavla':
			return resolveTavla(p, game, me);
		default:
			// A kind only a newer build knows.
			return READ_ONLY;
	}
}

const SQUARES = Array.from({length: 64}, (_, index) => `${'abcdefgh'[index % 8]}${8 - Math.floor(index / 8)}`);

function candidateTargets(view: TableGameView): ReadonlyArray<TableDropTarget> {
	const game = view.game_view;
	switch (game?.game) {
		case 'okey':
		case 'okey101':
			return [
				...Array.from({length: RACK_CELLS}, (_, cell): TableDropTarget => ({kind: 'rack_cell', cell})),
				{kind: 'discard_zone'},
				{kind: 'finish_zone'},
				{kind: 'meld_zone'},
				...(game.game === 'okey101'
					? game.melds.flatMap(
							(meld): Array<TableDropTarget> => [
								{kind: 'meld_end', meldId: meld.id, at: 'start'},
								{kind: 'meld_end', meldId: meld.id, at: 'end'},
							],
						)
					: []),
			];
		case 'chess':
		case 'dama':
		case 'dama_normal':
			return SQUARES.map((square): TableDropTarget => ({kind: 'square', square}));
		default:
			return [];
	}
}

// Targets to highlight while a piece is dragged (or selected): exactly where a drop would do something.
export function legalTargets(p: Omit<TableDropInput, 'target'>): ReadonlyArray<TableDropTarget> {
	const game = p.view.game_view;
	if (game?.game === 'tavla' && p.me !== null && p.view.summary.status === 'playing') {
		const choices = tavlaChoices(p, game, p.me);
		if ('kind' in choices) return [];
		return [...choices]
			.sort((a, b) => (a.to === 'off' ? 25 : a.to) - (b.to === 'off' ? 25 : b.to))
			.map(
				(step): TableDropTarget => (step.to === 'off' ? {kind: 'tavla_off'} : {kind: 'tavla_point', point: step.to}),
			);
	}
	return candidateTargets(p.view).filter((target) => resolveTableDrop({...p, target}).kind !== 'none');
}
