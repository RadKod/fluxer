// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Channel} from '@app/features/channel/models/Channel';
import * as TableGameCommands from '@app/features/table_game/commands/TableGameCommands';
import styles from '@app/features/table_game/components/ChessBoard.module.css';
import {type ChessPromotion, ChessPromotionPicker} from '@app/features/table_game/components/ChessPromotionPicker';
import TableGames from '@app/features/table_game/state/TableGames';
import {chessGlyph, isWhitePiece, parseFenBoard, squareName} from '@app/features/table_game/utils/ChessFen';
import {tableDraftKey} from '@app/features/table_game/utils/TableDraftKey';
import {chessSideToMove} from '@app/features/table_game/utils/TableGameDeadline';
import {tableGameOutcomeDescriptor} from '@app/features/table_game/utils/TableGameMessages';
import Users from '@app/features/user/state/Users';
import * as NicknameUtils from '@app/features/user/utils/NicknameUtils';
import type {ChessView, TableGameSummary} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import type {MessageDescriptor} from '@lingui/core';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import {useEffect, useState} from 'react';

type Side = 'white' | 'black';

const BOARD_LABEL_DESCRIPTOR = msg({
	message: 'Chess board',
	comment: 'Table games: accessible name of the chess board.',
});

export function formatClock(ms: number): string {
	const seconds = Math.ceil(Math.max(0, ms) / 1000);
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// Re-renders every 250 ms while a clock runs; nothing ticks on a paused or finished game.
export function useNow(running: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!running) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 250);
		return () => clearInterval(timer);
	}, [running]);
	return now;
}

// One player's name and running clock; dama boards use it as well (the mover comes from the view, never derived).
export const PlayerClock = observer(function PlayerClock({
	channel,
	summary,
	view,
	toMove,
	side,
	now,
}: {
	channel: Channel;
	summary: TableGameSummary;
	view: Pick<ChessView, 'white' | 'clocks_ms' | 'turn_started_at'>;
	toMove: Side | null;
	side: Side;
	now: number;
}) {
	const position = side === 'white' ? view.white : view.white === 1 ? 3 : 1;
	const userId = summary.players.find((player) => player.position === position)?.user_id;
	const user = userId ? Users.getUser(userId) : undefined;
	const running = summary.status === 'playing' && view.turn_started_at !== null && toMove === side;
	const elapsed = running ? now - Date.parse(view.turn_started_at!) : 0;
	const remaining = view.clocks_ms[side] - elapsed;
	return (
		<div className={styles.player} data-flx="table-game.chess-board.player-clock.player">
			<span className={styles.playerName} data-flx="table-game.chess-board.player-clock.name">
				{user ? NicknameUtils.getNickname(user, channel.guildId) : ''}
			</span>
			<span
				className={styles.clock}
				data-clock={side}
				data-running={running ? 'true' : undefined}
				data-low={running && remaining < 20_000 ? 'true' : undefined}
				data-flx="table-game.chess-board.player-clock.clock"
			>
				{formatClock(remaining)}
			</span>
		</div>
	);
});

export const ChessBoard = observer(function ChessBoard({channel, slot}: {channel: Channel; slot: string}) {
	const {i18n} = useLingui();
	const view = TableGames.getView(channel.id, slot);
	const [selection, setSelection] = useState<{key: string; square: string} | null>(null);
	const [promotion, setPromotion] = useState<{key: string; from: string; to: string} | null>(null);
	const [error, setError] = useState<MessageDescriptor | null>(null);
	const gameView = view?.game_view?.game === 'chess' ? view.game_view : null;
	const running = view?.summary.status === 'playing' && Boolean(gameView?.turn_started_at);
	const now = useNow(running);
	if (!view || !gameView) return null;
	// Drafts live until a move, not a version bump.
	const key = tableDraftKey(view);
	const selected = selection?.key === key ? selection.square : null;
	const pendingPromotion = promotion?.key === key ? promotion : null;
	const legal = gameView.legal_moves ?? [];
	const targets = new Set(
		selected ? legal.filter((move) => move.startsWith(selected)).map((move) => move.slice(2, 4)) : [],
	);
	const mySide: Side | null =
		view.viewer_position === null ? null : view.viewer_position === gameView.white ? 'white' : 'black';
	const flipped = mySide === 'black';
	const rows = parseFenBoard(gameView.fen);
	const lastFrom = gameView.last_move?.slice(0, 2);
	const lastTo = gameView.last_move?.slice(2, 4);

	const send = (from: string, to: string, piece?: ChessPromotion) => {
		setSelection(null);
		setPromotion(null);
		setError(null);
		void TableGameCommands.act(channel.id, slot, {type: 'move', from, to, ...(piece ? {promotion: piece} : {})}).then(
			(outcome) => setError(tableGameOutcomeDescriptor(outcome)),
		);
	};

	const pick = (square: string) => {
		if (legal.length === 0) return;
		if (selected && targets.has(square)) {
			if (legal.some((move) => move.startsWith(`${selected}${square}`) && move.length === 5)) {
				setPromotion({key, from: selected, to: square});
				return;
			}
			send(selected, square);
			return;
		}
		setPromotion(null);
		setSelection(legal.some((move) => move.startsWith(square)) ? {key, square} : null);
	};

	const order = [0, 1, 2, 3, 4, 5, 6, 7];
	const rowOrder = flipped ? [...order].reverse() : order;
	const fileOrder = flipped ? [...order].reverse() : order;
	const topSide: Side = flipped ? 'white' : 'black';

	return (
		<div className={styles.root} data-flx="table-game.chess-board.root">
			<PlayerClock
				channel={channel}
				summary={view.summary}
				view={gameView}
				toMove={chessSideToMove(gameView.fen)}
				side={topSide}
				now={now}
				data-flx="table-game.chess-board.player-clock"
			/>
			<div
				className={styles.board}
				role="group"
				aria-label={i18n._(BOARD_LABEL_DESCRIPTOR)}
				data-interactive={legal.length > 0 ? 'true' : undefined}
				data-flx="table-game.chess-board.board"
			>
				{rowOrder.flatMap((row) =>
					fileOrder.map((file) => {
						const name = squareName(file, row);
						const piece = rows[row]?.[file] ?? null;
						return (
							<button
								key={name}
								type="button"
								className={clsx(styles.square, (row + file) % 2 === 0 ? styles.light : styles.dark)}
								data-square={name}
								data-piece={piece ?? undefined}
								data-selected={selected === name ? 'true' : undefined}
								data-target={targets.has(name) ? 'true' : undefined}
								data-last={name === lastFrom || name === lastTo ? 'true' : undefined}
								aria-label={name}
								onClick={() => pick(name)}
								data-flx="table-game.chess-board.square"
							>
								{piece && (
									<span
										className={clsx(styles.piece, isWhitePiece(piece) ? styles.whitePiece : styles.blackPiece)}
										aria-hidden
										data-flx="table-game.chess-board.piece"
									>
										{chessGlyph(piece)}
									</span>
								)}
							</button>
						);
					}),
				)}
			</div>
			<PlayerClock
				channel={channel}
				summary={view.summary}
				view={gameView}
				toMove={chessSideToMove(gameView.fen)}
				side={topSide === 'white' ? 'black' : 'white'}
				now={now}
				data-flx="table-game.chess-board.player-clock--2"
			/>
			{pendingPromotion && (
				<ChessPromotionPicker
					side={mySide ?? 'white'}
					onPick={(piece) => send(pendingPromotion.from, pendingPromotion.to, piece)}
					data-flx="table-game.chess-board.chess-promotion-picker"
				/>
			)}
			{error && (
				<p className={styles.error} role="alert" data-flx="table-game.chess-board.error">
					{i18n._(error)}
				</p>
			)}
		</div>
	);
});
