// SPDX-License-Identifier: AGPL-3.0-or-later

import {SoundType} from '@app/features/notification/utils/SoundUtils';
import * as TableGameCommands from '@app/features/table_game/commands/TableGameCommands';
import {type OkeyStage, stagedTiles, stageToAction} from '@app/features/table_game/components/okey/Okey101Staging';
import {playTableUiSound, setTableSoundFocus} from '@app/features/table_game/sound/TableGameSounds';
import TableGames from '@app/features/table_game/state/TableGames';
import {tableDraftKey} from '@app/features/table_game/utils/TableDraftKey';
import {legalTargets, resolveTableDrop, type TableDropOutcome} from '@app/features/table_game/utils/TableDrop';
import {chessSideToMove} from '@app/features/table_game/utils/TableGameDeadline';
import {tableGameOutcomeDescriptor} from '@app/features/table_game/utils/TableGameMessages';
import {completes, expandTavlaPlays, type TavlaStep} from '@app/features/table_game/utils/TavlaSteps';
import * as ToastCommands from '@app/features/ui/commands/ToastCommands';
import type {
	RoomLayout,
	SeatViewTarget,
	TableDragSource,
	TableDropTarget,
	TableGame3D,
	VoiceSceneHandle,
} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {isKnownTableGameKind, TABLE_GAME_POSITIONS} from '@fluxer/constants/src/TableGameConstants';
import type {TableGameAction, TableGameKind} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {useLingui} from '@lingui/react/macro';
import {useEffect, useRef, useState} from 'react';

type Position = 1 | 2 | 3 | 4;
export type ChessPromotionPiece = NonNullable<Extract<TableGameAction, {type: 'move'}>['promotion']>;

// Local moves waiting for a button or the rest of a turn; stamped with the game's move identity they were made on
// (tableDraftKey), so a move (mine went through, the turn timed out, a 409 re-read) drops them by itself while a
// write that changes no game state (the minute presence check) keeps them.
interface Pending {
	key: string;
	stage: OkeyStage | null;
	steps: ReadonlyArray<TavlaStep>;
	paths: ReadonlyArray<ReadonlyArray<string>> | null;
	promotion: {from: string; to: string} | null;
	selection: TableDragSource | null;
	targets: ReadonlyArray<TableDropTarget>;
	// The dama path hovered or focused in the HUD: drawn on the board, never a selection.
	preview: ReadonlyArray<string> | null;
}

const NOTHING_PENDING: Omit<Pending, 'key'> = {
	stage: null,
	steps: [],
	paths: null,
	promotion: null,
	selection: null,
	targets: [],
	preview: null,
};

export interface TableSceneHud {
	game: TableGameKind | null;
	role: SeatViewTarget['role'];
	interactive: boolean;
	stage: OkeyStage | null;
	stagedCount: number;
	tavlaSteps: ReadonlyArray<TavlaStep>;
	tavlaComplete: boolean;
	pathChoice: ReadonlyArray<ReadonlyArray<string>> | null;
	promotion: {from: string; to: string; side: 'white' | 'black'} | null;
	openStage(): void;
	cancelStage(): void;
	undoTavla(): void;
	confirmTavla(): void;
	choosePath(path: ReadonlyArray<string>): void;
	pickPromotion(piece: ChessPromotionPiece): void;
	dismissChoice(): void;
	previewPath(path: ReadonlyArray<string> | null): void;
}

const isSource = (item: TableDragSource | TableDropTarget): item is TableDragSource =>
	item.kind === 'rack_tile' ||
	item.kind === 'pile' ||
	item.kind === 'discard_top' ||
	item.kind === 'square' ||
	item.kind === 'tavla_point';

// A clicked thing as a drop target, when it can be one (a square and a point are both).
function asTarget(item: TableDragSource | TableDropTarget): TableDropTarget | null {
	if (item.kind === 'tavla_point') return item.point === 'bar' ? null : {kind: 'tavla_point', point: item.point};
	if (item.kind === 'rack_tile' || item.kind === 'pile' || item.kind === 'discard_top') return null;
	return item;
}

// A watcher looks from the player edge nearest their seat among the game's edges, so a 2-player board stays the
// right way round between its players. A kind this build does not know  counts all four edges.
function perspectiveOf(layout: RoomLayout, target: SeatViewTarget): Position {
	if (target.seat.table) return target.seat.table.position;
	const edges: ReadonlyArray<number> =
		target.game && isKnownTableGameKind(target.game) ? TABLE_GAME_POSITIONS[target.game] : [1, 2, 3, 4];
	let best: Position = 1;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const seat of layout.seats) {
		if (seat.table?.slot !== target.slot || !edges.includes(seat.table.position)) continue;
		const distance = Math.hypot(seat.position.x - target.seat.position.x, seat.position.z - target.seat.position.z);
		if (distance < bestDistance) {
			bestDistance = distance;
			best = seat.table.position;
		}
	}
	return best;
}

// The 3D table of the seat view: mounts it on my table while the seat view shows (only that table), feeds it
// my own view (my rack + public state) with the local rack order, 101 staging and tavla steps, and turns a drop
// into at most one request  through the shared drop resolver. Returns what the seat HUD shows, or
// null. Call from an observer: the table store is read while rendering.
export function useTableGameScene({
	handle,
	channelId,
	target,
}: {
	handle: VoiceSceneHandle;
	channelId: string;
	target: SeatViewTarget | null;
}): TableSceneHud | null {
	const {i18n} = useLingui();
	const slot = target?.slot ?? null;
	const view = slot ? TableGames.getView(channelId, slot) : null;
	const rack = slot ? TableGames.getRack(channelId, slot) : [];
	const draftKey = view ? tableDraftKey(view) : '';
	const [stored, setStored] = useState<Pending>({key: '', ...NOTHING_PENDING});
	const pending = stored.key === draftKey ? stored : {key: draftKey, ...NOTHING_PENDING};
	const [table, setTable] = useState<TableGame3D | null>(null);

	const me = view?.viewer_position && target?.role === 'player' ? (view.viewer_position as Position) : null;
	const interactive = me !== null && view?.summary.status === 'playing';
	const perspective = target ? perspectiveOf(handle.layout, target) : 1;

	const latest = useRef({view, rack, pending, me, interactive, slot, i18n});
	latest.current = {view, rack, pending, me, interactive, slot, i18n};

	const hasView = view !== null;
	useEffect(() => {
		if (!slot || !hasView) return;
		const game = TableGames.getView(channelId, slot)?.summary.game;
		// No scene for a kind this build does not know: the seat stays the plain room.
		const mounted = game && isKnownTableGameKind(game) ? handle.mountTableGame(slot, game) : null;
		setTable(mounted);
		return () => {
			mounted?.dispose();
			setTable(null);
		};
	}, [handle, channelId, slot, hasView]);

	useEffect(() => {
		if (!slot) return;
		setTableSoundFocus(channelId, slot, true);
		return () => setTableSoundFocus(channelId, slot, false);
	}, [channelId, slot]);

	useEffect(() => {
		if (!table || !view) return;
		// A previewed path shows through the board's own marks: its start selected, its landings as targets.
		const preview = pending.preview;
		table.update({
			view,
			perspective,
			rack,
			stage: pending.stage,
			pendingTavla: pending.steps,
			selection: preview ? {kind: 'square', square: preview[0]!} : pending.selection,
			targets: preview ? preview.slice(1).map((square) => ({kind: 'square', square})) : pending.targets,
			interactive,
		});
	}, [
		table,
		view,
		perspective,
		rack,
		pending.stage,
		pending.steps,
		pending.selection,
		pending.targets,
		pending.preview,
		interactive,
	]);

	const update = (change: Partial<Omit<Pending, 'key'>>): void => {
		setStored({...latest.current.pending, ...change});
	};

	const send = (action: TableGameAction): void => {
		const at = latest.current.slot;
		if (!at) return;
		void TableGameCommands.act(channelId, at, action).then((outcome) => {
			if (outcome.ok) return;
			// The pieces go back to where the table has them (on a 409 act has already re-read it).
			setStored((current) => ({...current, ...NOTHING_PENDING}));
			const descriptor = tableGameOutcomeDescriptor(outcome);
			if (descriptor) ToastCommands.createToast({type: 'error', children: latest.current.i18n._(descriptor)});
		});
	};

	const apply = (outcome: TableDropOutcome): void => {
		const cleared = {selection: null, targets: [], preview: null};
		switch (outcome.kind) {
			case 'action':
				update(cleared);
				send(outcome.action);
				return;
			case 'rack': {
				update(cleared);
				const at = latest.current.slot;
				if (at) TableGames.setRackOrder(channelId, at, outcome.order);
				playTableUiSound(SoundType.TableGameTilePlace);
				return;
			}
			case 'stage':
				update({...cleared, stage: outcome.stage});
				return;
			case 'tavla_step':
				update({...cleared, steps: outcome.steps});
				return;
			case 'choose_path':
				update({...cleared, paths: outcome.paths});
				return;
			case 'promotion':
				update({...cleared, promotion: {from: outcome.from, to: outcome.to}});
				return;
			case 'none':
				update(cleared);
				return;
		}
	};

	const dropInput = (source: TableDragSource) => {
		const {view: current, me: mine, rack: order, pending: local} = latest.current;
		return current ? {view: current, me: mine, rack: order, stage: local.stage, tavlaSteps: local.steps, source} : null;
	};
	const canDrag = (source: TableDragSource): boolean => {
		const input = dropInput(source);
		if (!input || !latest.current.interactive) return false;
		return source.kind === 'rack_tile' || legalTargets(input).length > 0;
	};
	const select = (source: TableDragSource | null): void => {
		const input = source ? dropInput(source) : null;
		update({selection: source, targets: input ? legalTargets(input) : []});
	};

	// The handler reads the latest state through `latest`: set once per mounted table.
	useEffect(() => {
		if (!table) return;
		table.setDragHandler({
			canDrag,
			onDragStart(source) {
				const input = dropInput(source);
				update({selection: null, targets: input ? legalTargets(input) : []});
				if (source.kind === 'rack_tile' || source.kind === 'pile' || source.kind === 'discard_top')
					playTableUiSound(SoundType.TableGameTileDrag);
			},
			onDrop(source, dropTarget) {
				const input = dropTarget && latest.current.interactive ? dropInput(source) : null;
				if (input && dropTarget) apply(resolveTableDrop({...input, target: dropTarget}));
				else update({targets: []});
			},
			// Click-click: a piece, then where it goes; another piece instead picks that one.
			onSelect(item) {
				const {selection} = latest.current.pending;
				const asDrop = asTarget(item);
				const input = selection && asDrop && latest.current.interactive ? dropInput(selection) : null;
				const outcome = input && asDrop ? resolveTableDrop({...input, target: asDrop}) : null;
				if (outcome && outcome.kind !== 'none') apply(outcome);
				else select(isSource(item) && canDrag(item) ? item : null);
			},
		});
		return () => table.setDragHandler(null);
	}, [table]);

	if (!target || !view) return null;
	const gameView = view.game_view;
	const steps = pending.steps;
	const tavlaComplete = gameView?.game === 'tavla' && completes(expandTavlaPlays(gameView), steps);
	return {
		game: gameView?.game ?? null,
		role: target.role,
		interactive,
		stage: pending.stage,
		stagedCount: stagedTiles(pending.stage).length,
		tavlaSteps: steps,
		tavlaComplete,
		pathChoice: pending.paths,
		promotion:
			pending.promotion && gameView?.game === 'chess'
				? {...pending.promotion, side: chessSideToMove(gameView.fen)}
				: null,
		openStage() {
			if (pending.stage) send(stageToAction(pending.stage));
		},
		cancelStage: () => update({stage: null}),
		undoTavla: () => update({steps: steps.slice(0, -1)}),
		confirmTavla() {
			if (tavlaComplete) send({type: 'tavla_move', moves: [...steps]});
		},
		choosePath(path) {
			update({paths: null, preview: null});
			send({type: 'dama_move', path: [...path]});
		},
		pickPromotion(piece) {
			const promotion = pending.promotion;
			if (!promotion) return;
			update({promotion: null});
			send({type: 'move', from: promotion.from, to: promotion.to, promotion: piece});
		},
		dismissChoice: () => update({paths: null, promotion: null, preview: null}),
		previewPath: (path) => update({preview: path}),
	};
}
