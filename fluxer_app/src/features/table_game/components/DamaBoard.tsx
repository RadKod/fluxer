// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Channel} from '@app/features/channel/models/Channel';
import * as TableGameCommands from '@app/features/table_game/commands/TableGameCommands';
import {PlayerClock, useNow} from '@app/features/table_game/components/ChessBoard';
import styles from '@app/features/table_game/components/DamaBoard.module.css';
import TableGames from '@app/features/table_game/state/TableGames';
import {squareName} from '@app/features/table_game/utils/ChessFen';
import {parsePaths} from '@app/features/table_game/utils/DamaPaths';
import {tableDraftKey} from '@app/features/table_game/utils/TableDraftKey';
import {resolveTableDrop} from '@app/features/table_game/utils/TableDrop';
import {damaSideToMove} from '@app/features/table_game/utils/TableGameDeadline';
import {tableGameOutcomeDescriptor} from '@app/features/table_game/utils/TableGameMessages';
import {damaSquareIndex} from '@fluxer/constants/src/TableGameConstants';
import type {TableGameAction} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import type {MessageDescriptor} from '@lingui/core';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useCallback, useRef, useState} from 'react';
import {useDrag, useDrop} from 'react-dnd';

type Side = 'white' | 'black';
type Paths = ReadonlyArray<ReadonlyArray<string>>;

const BOARD_LABEL_DESCRIPTOR = msg({
	message: 'Draughts board. Arrow keys move between squares, Enter picks a piece and plays it.',
	comment: 'Table games: accessible name and keyboard help of the Turkish or diagonal draughts board.',
});
const SQUARE_PIECE_DESCRIPTOR = msg({
	message: '{square}, {piece}',
	comment: 'Table games: draughts, a square and the piece on it, like "c3, White man". {square} is a square name.',
});
const PIECE_DESCRIPTORS: Record<string, MessageDescriptor> = {
	w: msg({message: 'White man', comment: 'Table games: draughts, a plain white piece.'}),
	b: msg({message: 'Black man', comment: 'Table games: draughts, a plain black piece.'}),
	W: msg({message: 'White king', comment: 'Table games: draughts, a crowned white piece.'}),
	B: msg({message: 'Black king', comment: 'Table games: draughts, a crowned black piece.'}),
};
const PATH_LABEL_DESCRIPTOR = msg({
	message: 'Choose the capture path',
	comment: 'Table games: draughts, more than one capture path leads to the same square; the player picks one.',
});

const DAMA_PIECE_DND_TYPE = 'dama-piece';
const ARROW_STEPS: Partial<Record<string, [number, number]>> = {
	ArrowUp: [-1, 0],
	ArrowDown: [1, 0],
	ArrowLeft: [0, -1],
	ArrowRight: [0, 1],
};
const ORDER = [0, 1, 2, 3, 4, 5, 6, 7];

interface SquareProps {
	name: string;
	piece: string | null;
	light: boolean;
	movable: boolean;
	selected: boolean;
	target: boolean;
	last: boolean;
	captured: boolean;
	focusable: boolean;
	register: (name: string, node: HTMLButtonElement | null) => void;
	onPick: (name: string) => void;
	onFocus: (name: string) => void;
	onDragStart: (name: string) => void;
	onDrop: (from: string, to: string) => void;
}

function DamaSquare({
	name,
	piece,
	light,
	movable,
	selected,
	target,
	last,
	captured,
	focusable,
	register,
	onPick,
	onFocus,
	onDragStart,
	onDrop,
}: SquareProps) {
	const {i18n} = useLingui();
	const [, drag] = useDrag(
		() => ({
			type: DAMA_PIECE_DND_TYPE,
			item: () => {
				onDragStart(name);
				return {from: name};
			},
			canDrag: movable,
		}),
		[name, movable, onDragStart],
	);
	const [, drop] = useDrop(
		() => ({accept: DAMA_PIECE_DND_TYPE, drop: (item: {from: string}) => onDrop(item.from, name)}),
		[name, onDrop],
	);
	const ref = useCallback(
		(node: HTMLButtonElement | null) => {
			drag(drop(node));
			register(name, node);
		},
		[drag, drop, register, name],
	);
	const pieceLabel = piece ? PIECE_DESCRIPTORS[piece] : undefined;
	return (
		<button
			ref={ref}
			type="button"
			className={clsx(styles.square, light ? styles.light : styles.dark)}
			tabIndex={focusable ? 0 : -1}
			data-square={name}
			data-piece={piece ?? undefined}
			data-movable={movable ? 'true' : undefined}
			data-selected={selected ? 'true' : undefined}
			data-target={target ? 'true' : undefined}
			data-last={last ? 'true' : undefined}
			data-captured={captured ? 'true' : undefined}
			aria-label={pieceLabel ? i18n._(SQUARE_PIECE_DESCRIPTOR, {square: name, piece: i18n._(pieceLabel)}) : name}
			aria-pressed={selected}
			onClick={() => onPick(name)}
			onFocus={() => onFocus(name)}
			data-flx="table-game.dama-board.dama-square.square"
		>
			{piece && (
				<span
					className={styles.piece}
					data-side={piece === 'w' || piece === 'W' ? 'white' : 'black'}
					data-king={piece === 'W' || piece === 'B' ? 'true' : undefined}
					aria-hidden
					data-flx="table-game.dama-board.dama-square.piece"
				/>
			)}
		</button>
	);
}

// Türk daması and Normal dama share this board; a legal move is a whole path, sent as one request.
export const DamaBoard = observer(function DamaBoard({channel, slot}: {channel: Channel; slot: string}) {
	const {i18n} = useLingui();
	const view = TableGames.getView(channel.id, slot);
	const [selection, setSelection] = useState<{key: string; square: string} | null>(null);
	const [choice, setChoice] = useState<{key: string; paths: Paths} | null>(null);
	const [cursor, setCursor] = useState<string | null>(null);
	const [error, setError] = useState<MessageDescriptor | null>(null);
	const nodes = useRef(new Map<string, HTMLButtonElement>());
	const register = useCallback((name: string, node: HTMLButtonElement | null) => {
		if (node) nodes.current.set(name, node);
		else nodes.current.delete(name);
	}, []);
	const game = view?.game_view;
	const gameView = game?.game === 'dama' || game?.game === 'dama_normal' ? game : null;
	const toMove = gameView ? damaSideToMove(gameView) : null;
	const now = useNow(view?.summary.status === 'playing' && Boolean(gameView?.turn_started_at) && toMove !== null);
	if (!view || !gameView) return null;

	// Drafts live until a move, not a version bump.
	const key = tableDraftKey(view);
	const me = view.viewer_position as 1 | 2 | 3 | 4 | null;
	// legal_moves only ever reach the player to move; the turn check also covers a late view after the end.
	const myTurn = me !== null && view.summary.status === 'playing' && gameView.turn === me;
	const paths = myTurn ? parsePaths(gameView.legal_moves) : [];
	const selected = selection?.key === key ? selection.square : null;
	const pendingPaths = choice?.key === key ? choice.paths : null;
	const sources = new Set(paths.map((path) => path[0]));
	const targetsOf = (from: string | null) =>
		new Set(from ? paths.filter((path) => path[0] === from).map((path) => path.at(-1)) : []);
	const targets = targetsOf(selected);
	const lastMove = new Set(gameView.last_move ?? []);
	const captured = new Set(gameView.last_captured);
	const mySide: Side | null = me === null ? null : me === gameView.white ? 'white' : 'black';
	const order = mySide === 'black' ? [...ORDER].reverse() : ORDER;
	const visual = order.flatMap((row) => order.map((file) => squareName(file, row)));
	const focusSquare = cursor ?? visual[56]!;
	const topSide: Side = mySide === 'black' ? 'white' : 'black';

	const send = (action: TableGameAction) => {
		setSelection(null);
		setChoice(null);
		setError(null);
		void TableGameCommands.act(channel.id, slot, action).then((outcome) =>
			setError(tableGameOutcomeDescriptor(outcome)),
		);
	};

	// The same resolver as the seated 3D table, so both answer a move alike.
	const play = (from: string, to: string) => {
		const outcome = resolveTableDrop({
			view,
			me,
			rack: [],
			stage: null,
			tavlaSteps: [],
			source: {kind: 'square', square: from},
			target: {kind: 'square', square: to},
		});
		if (outcome.kind === 'action') send(outcome.action);
		else if (outcome.kind === 'choose_path') {
			setSelection(null);
			setChoice({key, paths: outcome.paths});
		}
	};

	const pick = (square: string) => {
		setCursor(square);
		if (selected && targets.has(square)) {
			play(selected, square);
			return;
		}
		setChoice(null);
		setSelection(sources.has(square) ? {key, square} : null);
	};

	const onDragStart = (square: string) => {
		setChoice(null);
		setSelection({key, square});
	};

	const onDrop = (from: string, to: string) => {
		if (targetsOf(from).has(to)) play(from, to);
	};

	const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			pick(focusSquare);
			return;
		}
		const step = ARROW_STEPS[event.key];
		if (!step) return;
		event.preventDefault();
		const index = visual.indexOf(focusSquare);
		const row = Math.floor(index / 8) + step[0];
		const file = (index % 8) + step[1];
		if (row < 0 || row > 7 || file < 0 || file > 7) return;
		const next = visual[row * 8 + file]!;
		setCursor(next);
		nodes.current.get(next)?.focus();
	};

	return (
		<div className={styles.root} data-flx="table-game.dama-board.root">
			<PlayerClock
				channel={channel}
				summary={view.summary}
				view={gameView}
				toMove={toMove}
				side={topSide}
				now={now}
				data-flx="table-game.dama-board.player-clock"
			/>
			<div
				className={styles.board}
				role="group"
				aria-label={i18n._(BOARD_LABEL_DESCRIPTOR)}
				data-interactive={paths.length > 0 ? 'true' : undefined}
				onKeyDown={onKeyDown}
				data-flx="table-game.dama-board.board"
			>
				{visual.map((name) => {
					const index = damaSquareIndex(name);
					const cell = gameView.board[index] ?? '.';
					return (
						<DamaSquare
							key={name}
							name={name}
							piece={cell === '.' ? null : cell}
							light={(Math.floor(index / 8) + (index % 8)) % 2 === 0}
							movable={sources.has(name)}
							selected={selected === name}
							target={targets.has(name)}
							last={lastMove.has(name)}
							captured={captured.has(name)}
							focusable={name === focusSquare}
							register={register}
							onPick={pick}
							onFocus={setCursor}
							onDragStart={onDragStart}
							onDrop={onDrop}
							data-flx="table-game.dama-board.dama-square"
						/>
					);
				})}
			</div>
			<PlayerClock
				channel={channel}
				summary={view.summary}
				view={gameView}
				toMove={toMove}
				side={topSide === 'white' ? 'black' : 'white'}
				now={now}
				data-flx="table-game.dama-board.player-clock--2"
			/>
			{pendingPaths && (
				<fieldset className={styles.paths} data-flx="table-game.dama-board.paths">
					<legend className={styles.pathsLabel} data-flx="table-game.dama-board.paths-label">
						{i18n._(PATH_LABEL_DESCRIPTOR)}
					</legend>
					{pendingPaths.map((path) => (
						<button
							key={path.join('-')}
							type="button"
							className={styles.path}
							data-path={path.join('-')}
							onClick={() => send({type: 'dama_move', path: [...path]})}
							data-flx="table-game.dama-board.button.path"
						>
							{path.join(' → ')}
						</button>
					))}
				</fieldset>
			)}
			{error && (
				<p className={styles.error} role="alert" data-flx="table-game.dama-board.error">
					{i18n._(error)}
				</p>
			)}
		</div>
	);
});
