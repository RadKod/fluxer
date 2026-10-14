// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Channel} from '@app/features/channel/models/Channel';
import {SoundType} from '@app/features/notification/utils/SoundUtils';
import * as TableGameCommands from '@app/features/table_game/commands/TableGameCommands';
import {Okey101Melds, Okey101Scores, Okey101SeatBadges} from '@app/features/table_game/components/okey/Okey101Melds';
import styles from '@app/features/table_game/components/okey/OkeyBoard.module.css';
import {OkeyRack} from '@app/features/table_game/components/okey/OkeyRack';
import {
	layoutRack,
	moveRackTile,
	type OkeyFace,
	okeyFaceOf,
	RACK_CELLS,
	rackGroups,
	trimRack,
} from '@app/features/table_game/components/okey/OkeyRackModel';
import {OkeyTile} from '@app/features/table_game/components/okey/OkeyTile';
import {playTableUiSound} from '@app/features/table_game/sound/TableGameSounds';
import TableGames, {type RackSlot} from '@app/features/table_game/state/TableGames';
import {tableDraftKey} from '@app/features/table_game/utils/TableDraftKey';
import {tableGameOutcomeDescriptor} from '@app/features/table_game/utils/TableGameMessages';
import {Button} from '@app/features/ui/button/Button';
import Users from '@app/features/user/state/Users';
import * as NicknameUtils from '@app/features/user/utils/NicknameUtils';
import {TABLE_GAME_TURN_MS} from '@fluxer/constants/src/TableGameConstants';
import type {
	Okey101View,
	OkeyView,
	TableGameAction,
	TableGameSummary,
} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import type {MessageDescriptor} from '@lingui/core';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {useEffect, useState} from 'react';

type OkeyGameView = OkeyView | Okey101View;

const TILES_DESCRIPTOR = msg({
	message: '{count} tiles',
	comment: 'Table games: Okey, how many tiles a player holds; the tiles themselves stay hidden. {count} is a number.',
});
const PILE_DESCRIPTOR = msg({
	message: '{count} in the pile',
	comment: 'Table games: Okey, tiles left to draw. {count} is a number.',
});
const INDICATOR_DESCRIPTOR = msg({
	message: 'Indicator',
	comment: 'Table games: Okey, the face-up tile that decides the okey (one higher, same color).',
});
const DEADLINE_DESCRIPTOR = msg({
	message: '{seconds} seconds left',
	comment: "Table games: Okey, time left in the current player's turn. {seconds} is a number.",
});
const DRAW_PILE_DESCRIPTOR = msg({
	message: 'Draw from pile',
	comment: 'Table games: Okey, take the top tile of the face-down pile.',
});
const TAKE_SIDE_DESCRIPTOR = msg({
	message: 'Take from side',
	comment: 'Table games: Okey, take the tile the previous player just discarded.',
});
const PUT_BACK_DESCRIPTOR = msg({
	message: 'Put back',
	comment: 'Table games: 101 Okey, give back the tile taken from the side before using it.',
});
const DISCARD_DESCRIPTOR = msg({
	message: 'Discard',
	comment: 'Table games: Okey, throw the selected tile to end the turn.',
});
const FINISH_DESCRIPTOR = msg({
	message: 'Finish',
	comment: 'Table games: classic Okey, end the hand: throw the selected tile and show the rest as sets.',
});
const OPEN_DESCRIPTOR = msg({
	message: 'Open',
	comment: 'Table games: 101 Okey, lay the selected sets on the table.',
});
const RACK_HINT_DESCRIPTOR = msg({
	message: 'Leave a gap between sets. Runs go from low to high.',
	comment: 'Table games: Okey, how the rack is read when opening or finishing.',
});

// Classic Okey finishes from 15 tiles: 14 in sets and the one thrown.
const CLASSIC_FINISH_RACK_SIZE = 15;
const DEADLINE_LOW_MS = 5000;
const INVALID_MELD_DESCRIPTOR = tableGameOutcomeDescriptor({ok: false, error: 'rule', reason: 'invalid_meld'});

interface Taking {
	key: string;
	tile: string;
	cell: number;
}

// Re-renders every second while a turn clock runs; nothing ticks on a finished hand.
function useNow(running: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!running) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [running]);
	return now;
}

// Sets in the shape the server accepts (2 to 13 tiles each); anything else is refused here without a request.
function validSets(sets: ReadonlyArray<ReadonlyArray<string>>, maxSets: number): boolean {
	return sets.length > 0 && sets.length <= maxSets && sets.every((set) => set.length >= 2 && set.length <= 13);
}

function placeTaken(cells: ReadonlyArray<RackSlot>, taking: Taking): Array<RackSlot> {
	const next = [...cells];
	next[next[taking.cell] === null ? taking.cell : next.indexOf(null)] = taking.tile;
	return next;
}

function DeadlineRing({deadlineAt, turnMs, now}: {deadlineAt: number; turnMs: number; now: number}) {
	const {i18n} = useLingui();
	const remaining = Math.max(0, deadlineAt - now);
	const seconds = Math.ceil(remaining / 1000);
	return (
		<span
			className={styles.deadline}
			role="timer"
			aria-label={i18n._(DEADLINE_DESCRIPTOR, {seconds})}
			data-deadline="true"
			data-low={remaining < DEADLINE_LOW_MS ? 'true' : undefined}
			data-flx="table-game.okey.okey-board.deadline-ring.deadline"
		>
			<svg
				className={styles.ring}
				viewBox="0 0 36 36"
				aria-hidden
				data-flx="table-game.okey.okey-board.deadline-ring.ring"
			>
				<circle
					className={styles.ringTrack}
					cx="18"
					cy="18"
					r="16"
					data-flx="table-game.okey.okey-board.deadline-ring.ring-track"
				/>
				<circle
					className={styles.ringFill}
					cx="18"
					cy="18"
					r="16"
					pathLength={1}
					style={{strokeDashoffset: 1 - Math.min(1, remaining / turnMs)}}
					data-flx="table-game.okey.okey-board.deadline-ring.ring-fill"
				/>
			</svg>
			<span className={styles.seconds} data-flx="table-game.okey.okey-board.deadline-ring.seconds">
				{seconds}
			</span>
		</span>
	);
}

// One player around the table: name, turn clock, how many tiles (never which), last discard, 101 badges.
function Seat({
	summary,
	view,
	position,
	name,
	okey,
	now,
}: {
	summary: TableGameSummary;
	view: OkeyGameView;
	position: number;
	name: string;
	okey: OkeyFace | null;
	now: number;
}) {
	const {i18n} = useLingui();
	const onTurn = summary.status === 'playing' && view.turn === position;
	const deadlineAt = onTurn && view.deadline_at ? Date.parse(view.deadline_at) : null;
	const lastDiscard = view.discards[position - 1]?.at(-1) ?? null;
	const count = view.rack_counts[position - 1] ?? 0;
	const connected = summary.players.find((player) => player.position === position)?.connected ?? true;
	return (
		<div
			className={styles.seat}
			data-seat-position={position}
			data-turn={onTurn ? 'true' : undefined}
			data-connected={connected ? undefined : 'false'}
			data-flx="table-game.okey.okey-board.seat.seat"
		>
			<div className={styles.seatHead} data-flx="table-game.okey.okey-board.seat.head">
				<span className={styles.seatName} data-flx="table-game.okey.okey-board.seat.name">
					{name}
				</span>
				{deadlineAt !== null && (
					<DeadlineRing
						deadlineAt={deadlineAt}
						turnMs={TABLE_GAME_TURN_MS[view.game][summary.speed]}
						now={now}
						data-flx="table-game.okey.okey-board.seat.deadline-ring"
					/>
				)}
			</div>
			<div className={styles.seatBody} data-flx="table-game.okey.okey-board.seat.body">
				<span className={styles.count} data-rack-count={count} data-flx="table-game.okey.okey-board.seat.count">
					{i18n._(TILES_DESCRIPTOR, {count})}
				</span>
				{lastDiscard && (
					<OkeyTile token={lastDiscard} okey={okey} size="small" data-flx="table-game.okey.okey-board.seat.okey-tile" />
				)}
			</div>
			{view.game === 'okey101' && (
				<Okey101SeatBadges
					view={view}
					position={position}
					data-flx="table-game.okey.okey-board.seat.okey101-seat-badges"
				/>
			)}
		</div>
	);
}

// Classic Okey and 101 Okey for one table. Only the viewer's own rack is ever known here (the server sends no
// other); the rest of the board is the public view every player and spectator gets.
export const OkeyBoard = observer(function OkeyBoard({channel, slot}: {channel: Channel; slot: string}) {
	const {i18n} = useLingui();
	const view = TableGames.getView(channel.id, slot);
	const order = TableGames.getRack(channel.id, slot);
	const [picked, setPicked] = useState<ReadonlyArray<string>>([]);
	const [taking, setTaking] = useState<Taking | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<MessageDescriptor | null>(null);
	const gameView = view?.game_view?.game === 'okey' || view?.game_view?.game === 'okey101' ? view.game_view : null;
	const now = useNow(view?.summary.status === 'playing' && Boolean(gameView?.deadline_at));
	if (!view || !gameView) return null;

	const summary = view.summary;
	// Drafts live until a move, not a version bump.
	const key = tableDraftKey(view);
	const classic = gameView.game === 'okey';
	const me = view.viewer_position;
	const bottom = me ?? 1;
	const rack = me === null ? null : gameView.rack;
	const myTurn = rack !== null && summary.status === 'playing' && gameView.turn === me;
	const previous = ((bottom + 2) % 4) + 1;
	const offered = gameView.discards[previous - 1]?.at(-1) ?? null;
	const okey = okeyFaceOf(gameView.indicator);
	const names = [1, 2, 3, 4].map((position) => {
		const userId = summary.players.find((player) => player.position === position)?.user_id;
		const user = userId ? Users.getUser(userId) : undefined;
		return user ? NicknameUtils.getNickname(user, channel.guildId) : '';
	});
	const nameOf = (position: number) => names[position - 1] ?? '';

	// 101: the side tile sits in the rack (not yet the player's) until it is laid down in the same action.
	const live = taking && taking.key === key && myTurn && gameView.phase === 'draw' ? taking : null;
	const base = layoutRack(order);
	const cells = live ? placeTaken(base, live) : base;
	const selected = new Set(picked.filter((tile) => cells.includes(tile)));
	const selectedInOrder = cells.filter((tile): tile is string => tile !== null && selected.has(tile));

	const send = (action: TableGameAction) => {
		setBusy(true);
		setError(null);
		void TableGameCommands.act(channel.id, slot, action).then((outcome) => {
			setBusy(false);
			setError(tableGameOutcomeDescriptor(outcome));
			if (outcome.ok) setPicked([]);
		});
	};

	const move = (from: number, to: number) => {
		const next = moveRackTile(cells, from, to);
		if (live) {
			setTaking({...live, cell: next.indexOf(live.tile)});
			TableGames.setRackOrder(channel.id, slot, trimRack(next.map((tile) => (tile === live.tile ? null : tile))));
			return;
		}
		TableGames.setRackOrder(channel.id, slot, trimRack(next));
	};

	const onCellClick = (index: number) => {
		setError(null);
		const tile = cells[index] ?? null;
		if (tile === null) {
			if (selectedInOrder.length === 1) {
				playTableUiSound(SoundType.TableGameTilePlace);
				move(cells.indexOf(selectedInOrder[0]!), index);
				setPicked([]);
			}
			return;
		}
		if (selected.has(tile)) setPicked(selectedInOrder.filter((other) => other !== tile));
		else setPicked(classic ? [tile] : [...selectedInOrder, tile]);
	};

	const takeFromSide = () => {
		if (!offered) return;
		const last = base.reduce((found, tile, index) => (tile === null ? found : index), -1);
		const cell = last + 1 < RACK_CELLS ? last + 1 : base.indexOf(null);
		setTaking({key, tile: offered, cell});
		setPicked([offered]);
		setError(null);
	};

	const openSets = () => {
		const sets = rackGroups(cells)
			.map((group) => group.filter((tile) => selected.has(tile)))
			.filter((group) => group.length > 0);
		if (!validSets(sets, 12)) {
			setError(INVALID_MELD_DESCRIPTOR);
			return;
		}
		send(live ? {type: 'take_discard', open: sets} : {type: 'meld', open: sets});
	};

	const addTo = (meldId: number, at: 'start' | 'end') => {
		const add = [{meld_id: meldId, tiles: selectedInOrder, at}];
		send(live ? {type: 'take_discard', add} : {type: 'meld', add});
	};

	const finish = () => {
		const tile = selectedInOrder[0]!;
		const sets = rackGroups(cells, tile);
		if (!validSets(sets, 7)) {
			setError(INVALID_MELD_DESCRIPTOR);
			return;
		}
		send({type: 'finish', tile, sets});
	};

	const drawPhase = myTurn && gameView.phase === 'draw' && !live && !busy;
	const canDrawPile = drawPhase && gameView.pile_count > 0;
	const canTakeSide = drawPhase && offered !== null;
	const throwPhase = myTurn && gameView.phase === (classic ? 'discard' : 'play') && !live && !busy;
	const canDiscard = throwPhase && selected.size === 1;
	const canFinish = canDiscard && rack?.length === CLASSIC_FINISH_RACK_SIZE;
	const laying = !busy && (live !== null || (myTurn && gameView.phase === 'play'));
	const canOpen = laying && selected.size > 0;
	const opened = gameView.game === 'okey101' && me !== null && gameView.opened[me - 1] !== 'none';
	const canAdd = laying && opened && selected.size >= 1 && selected.size <= 12;
	const sideTile = offered && (
		<OkeyTile token={offered} okey={okey} size="small" data-flx="table-game.okey.okey-board.okey-tile" />
	);

	return (
		<div className={styles.board} data-game={gameView.game} data-flx="table-game.okey.okey-board.board">
			<div className={styles.opponents} data-flx="table-game.okey.okey-board.opponents">
				{[3, 2, 1].map((offset) => {
					const position = ((bottom - 1 + offset) % 4) + 1;
					return (
						<Seat
							key={position}
							summary={summary}
							view={gameView}
							position={position}
							name={nameOf(position)}
							okey={okey}
							now={now}
							data-flx="table-game.okey.okey-board.seat"
						/>
					);
				})}
			</div>
			<div className={styles.center} data-flx="table-game.okey.okey-board.center">
				<div className={styles.indicator} data-indicator="true" data-flx="table-game.okey.okey-board.indicator">
					<span className={styles.centerLabel} data-flx="table-game.okey.okey-board.indicator-label">
						{i18n._(INDICATOR_DESCRIPTOR)}
					</span>
					<OkeyTile
						token={gameView.indicator}
						okey={okey}
						size="small"
						data-flx="table-game.okey.okey-board.okey-tile--2"
					/>
				</div>
				<span className={styles.pile} data-pile-count={gameView.pile_count} data-flx="table-game.okey.okey-board.pile">
					{i18n._(PILE_DESCRIPTOR, {count: gameView.pile_count})}
				</span>
			</div>
			{gameView.game === 'okey101' && (
				<Okey101Melds
					view={gameView}
					okey={okey}
					nameOf={nameOf}
					canAdd={canAdd}
					onAdd={rack !== null && summary.status === 'playing' ? addTo : null}
					data-flx="table-game.okey.okey-board.okey101-melds"
				/>
			)}
			<Seat
				summary={summary}
				view={gameView}
				position={bottom}
				name={nameOf(bottom)}
				okey={okey}
				now={now}
				data-flx="table-game.okey.okey-board.seat--2"
			/>
			{rack !== null && (
				<OkeyRack
					cells={cells}
					okey={okey}
					selected={selected}
					pending={live?.tile ?? null}
					onCellClick={onCellClick}
					onMove={move}
					data-flx="table-game.okey.okey-board.okey-rack"
				/>
			)}
			{rack !== null && summary.status === 'playing' && (
				<>
					<div className={styles.actions} data-flx="table-game.okey.okey-board.actions">
						<Button
							small
							variant="secondary"
							disabled={!canDrawPile}
							onClick={() => send({type: 'draw', from: 'pile'})}
							data-action="draw-pile"
							data-flx="table-game.okey.okey-board.button.draw-pile"
						>
							{i18n._(DRAW_PILE_DESCRIPTOR)}
						</Button>
						{classic ? (
							<Button
								small
								variant="secondary"
								disabled={!canTakeSide}
								onClick={() => send({type: 'draw', from: 'discard'})}
								data-action="draw-discard"
								data-flx="table-game.okey.okey-board.button.draw-discard"
							>
								<span className={styles.withTile} data-flx="table-game.okey.okey-board.draw-discard-label">
									{i18n._(TAKE_SIDE_DESCRIPTOR)}
									{sideTile}
								</span>
							</Button>
						) : live ? (
							<Button
								small
								variant="secondary"
								onClick={() => {
									setTaking(null);
									setPicked([]);
								}}
								data-action="take-cancel"
								data-flx="table-game.okey.okey-board.button.take-cancel"
							>
								{i18n._(PUT_BACK_DESCRIPTOR)}
							</Button>
						) : (
							<Button
								small
								variant="secondary"
								disabled={!canTakeSide}
								onClick={takeFromSide}
								data-action="take-discard"
								data-flx="table-game.okey.okey-board.button.take-discard"
							>
								<span className={styles.withTile} data-flx="table-game.okey.okey-board.take-discard-label">
									{i18n._(TAKE_SIDE_DESCRIPTOR)}
									{sideTile}
								</span>
							</Button>
						)}
						{!classic && (
							<Button
								small
								disabled={!canOpen}
								onClick={openSets}
								data-action="open"
								data-flx="table-game.okey.okey-board.button.open"
							>
								{i18n._(OPEN_DESCRIPTOR)}
							</Button>
						)}
						<Button
							small
							disabled={!canDiscard}
							onClick={() => send({type: 'discard', tile: selectedInOrder[0]!})}
							data-action="discard"
							data-flx="table-game.okey.okey-board.button.discard"
						>
							{i18n._(DISCARD_DESCRIPTOR)}
						</Button>
						{classic && (
							<Button
								small
								disabled={!canFinish}
								onClick={finish}
								data-action="finish"
								data-flx="table-game.okey.okey-board.button.finish"
							>
								{i18n._(FINISH_DESCRIPTOR)}
							</Button>
						)}
					</div>
					<p className={styles.hint} data-flx="table-game.okey.okey-board.hint">
						{i18n._(RACK_HINT_DESCRIPTOR)}
					</p>
				</>
			)}
			{error && (
				<p className={styles.error} role="alert" data-flx="table-game.okey.okey-board.error">
					{i18n._(error)}
				</p>
			)}
			{gameView.game === 'okey101' && (
				<Okey101Scores
					view={gameView}
					summary={summary}
					nameOf={nameOf}
					data-flx="table-game.okey.okey-board.okey101-scores"
				/>
			)}
		</div>
	);
});
