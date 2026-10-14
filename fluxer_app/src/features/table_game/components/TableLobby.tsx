// SPDX-License-Identifier: AGPL-3.0-or-later

import Authentication from '@app/features/auth/state/Authentication';
import type {Channel} from '@app/features/channel/models/Channel';
import type {TableGameOutcome} from '@app/features/table_game/commands/TableGameCommands';
import * as TableGameCommands from '@app/features/table_game/commands/TableGameCommands';
import {TableGameResult} from '@app/features/table_game/components/TableGameResult';
import styles from '@app/features/table_game/components/TableLobby.module.css';
import TableGames from '@app/features/table_game/state/TableGames';
import {
	MINUTES_PER_PLAYER_DESCRIPTOR,
	NOT_IN_VOICE_DESCRIPTOR,
	SECONDS_PER_TURN_DESCRIPTOR,
	TABLE_GAME_NAME_DESCRIPTORS,
	TABLE_GAME_SPEED_DESCRIPTORS,
	tableGameOutcomeDescriptor,
	UPDATE_APP_DESCRIPTOR,
} from '@app/features/table_game/utils/TableGameMessages';
import {Button} from '@app/features/ui/button/Button';
import {SegmentedTabs} from '@app/features/ui/segmented_tabs/SegmentedTabs';
import {WarningAlert} from '@app/features/ui/warning_alert/WarningAlert';
import Users from '@app/features/user/state/Users';
import * as NicknameUtils from '@app/features/user/utils/NicknameUtils';
import MediaEngine from '@app/features/voice/engine/MediaEngineFacade';
import {
	isKnownTableGameKind,
	TABLE_GAME_CLOCK_KINDS,
	TABLE_GAME_KINDS,
	TABLE_GAME_POSITIONS,
	TABLE_GAME_SPEEDS,
	TABLE_GAME_TURN_MS,
} from '@fluxer/constants/src/TableGameConstants';
import type {
	TableGameKind,
	TableGameSpeed,
	TableGameSummary,
} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import type {MessageDescriptor} from '@lingui/core';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {useState} from 'react';

const GAME_LABEL_DESCRIPTOR = msg({
	message: 'Game',
	comment: 'Table games: label of the game choice when setting up a table.',
});
const SPEED_LABEL_DESCRIPTOR = msg({message: 'Move time', comment: 'Table games: label of the move time choice.'});
const SET_UP_DESCRIPTOR = msg({
	message: 'Set up table',
	comment: 'Table games: button that opens a table for others to join.',
});
const TAKE_SEAT_DESCRIPTOR = msg({
	message: 'Take seat',
	comment: 'Table games: button to sit at a free place at the table.',
});
const OPEN_SEAT_DESCRIPTOR = msg({message: 'Open seat', comment: 'Table games: a free place at the table.'});
const WAITING_DESCRIPTOR = msg({
	message: 'The game starts when every seat is taken.',
	comment: 'Table games: shown while the table waits for players.',
});
const LEAVE_DESCRIPTOR = msg({message: 'Leave table', comment: 'Table games: button to stand up from the table.'});
const LEAVE_WARNING_DESCRIPTOR = msg({
	message: 'If you leave the table, you lose the game.',
	comment: 'Table games: warning before leaving a game in progress.',
});
const LEAVE_CONFIRM_DESCRIPTOR = msg({
	message: 'Leave and lose',
	comment: 'Table games: confirms leaving a game in progress, which loses it.',
});
const STAY_DESCRIPTOR = msg({message: 'Stay', comment: 'Table games: cancels leaving the table.'});
const WATCH_DESCRIPTOR = msg({message: 'Watch', comment: 'Table games: button to follow a game as a spectator.'});
const STOP_WATCHING_DESCRIPTOR = msg({
	message: 'Stop watching',
	comment: 'Table games: button to stop following a game.',
});
const OVERFLOW_DESCRIPTOR = msg({
	message: 'Live spectator spots are full. The table refreshes every few seconds.',
	comment: 'Table games: shown to a spectator past the live spectator limit (50).',
});

function turnTimeText(i18n: ReturnType<typeof useLingui>['i18n'], game: TableGameKind, speed: TableGameSpeed): string {
	const ms = TABLE_GAME_TURN_MS[game][speed];
	return (TABLE_GAME_CLOCK_KINDS as ReadonlyArray<TableGameKind>).includes(game)
		? i18n._(MINUTES_PER_PLAYER_DESCRIPTOR, {minutes: ms / 60_000})
		: i18n._(SECONDS_PER_TURN_DESCRIPTOR, {seconds: ms / 1000});
}

function useRun(): [boolean, MessageDescriptor | null, (command: () => Promise<TableGameOutcome>) => void] {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<MessageDescriptor | null>(null);
	const run = (command: () => Promise<TableGameOutcome>) => {
		setBusy(true);
		setError(null);
		void command().then((outcome) => {
			setBusy(false);
			setError(tableGameOutcomeDescriptor(outcome));
		});
	};
	return [busy, error, run];
}

const CreateTableForm = observer(function CreateTableForm({channelId, slot}: {channelId: string; slot: string}) {
	const {i18n} = useLingui();
	const [game, setGame] = useState<TableGameKind>('okey');
	const [speed, setSpeed] = useState<TableGameSpeed>('normal');
	const [busy, error, run] = useRun();
	const inVoice = MediaEngine.channelId === channelId;
	return (
		<div className={styles.form} data-flx="table-game.table-lobby.create-table-form.form">
			<div className={styles.field} data-flx="table-game.table-lobby.create-table-form.field">
				<span className={styles.fieldLabel} data-flx="table-game.table-lobby.create-table-form.field-label">
					{i18n._(GAME_LABEL_DESCRIPTOR)}
				</span>
				{/* Six games do not fit one segmented row at 390 px: a wrapping grid of toggle buttons. */}
				<div
					className={styles.gamePicker}
					role="group"
					aria-label={i18n._(GAME_LABEL_DESCRIPTOR)}
					data-flx="table-game.table-lobby.create-table-form.game-picker"
				>
					{TABLE_GAME_KINDS.map((id) => (
						<button
							key={id}
							type="button"
							className={styles.gameChoice}
							aria-pressed={id === game}
							data-game-choice={id}
							onClick={() => setGame(id)}
							data-flx="table-game.table-lobby.create-table-form.button.game-choice"
						>
							{i18n._(TABLE_GAME_NAME_DESCRIPTORS[id])}
						</button>
					))}
				</div>
			</div>
			<div className={styles.field} data-flx="table-game.table-lobby.create-table-form.field--2">
				<span className={styles.fieldLabel} data-flx="table-game.table-lobby.create-table-form.field-label--2">
					{i18n._(SPEED_LABEL_DESCRIPTOR)}
				</span>
				<SegmentedTabs
					tabs={TABLE_GAME_SPEEDS.map((id) => ({id, label: i18n._(TABLE_GAME_SPEED_DESCRIPTORS[id])}))}
					selectedTab={speed}
					onTabChange={setSpeed}
					ariaLabel={i18n._(SPEED_LABEL_DESCRIPTOR)}
					data-flx="table-game.table-lobby.create-table-form.segmented-tabs--2"
				/>
				<span className={styles.hint} data-flx="table-game.table-lobby.create-table-form.hint">
					{turnTimeText(i18n, game, speed)}
				</span>
			</div>
			{inVoice ? (
				<Button
					fitContainer
					submitting={busy}
					onClick={() => run(() => TableGameCommands.createTable(channelId, slot, game, speed))}
					data-flx="table-game.table-lobby.create-table-form.button.create"
				>
					{i18n._(SET_UP_DESCRIPTOR)}
				</Button>
			) : (
				<p className={styles.hint} data-flx="table-game.table-lobby.create-table-form.not-in-voice">
					{i18n._(NOT_IN_VOICE_DESCRIPTOR)}
				</p>
			)}
			{error && (
				<p className={styles.error} role="alert" data-flx="table-game.table-lobby.create-table-form.error">
					{i18n._(error)}
				</p>
			)}
		</div>
	);
});

// The seats around a square table, placed like the table's seats in the room: 1 near, 2 right, 3 far, 4 left.
const SeatMap = observer(function SeatMap({
	channel,
	summary,
	canSit,
	onSit,
}: {
	channel: Channel;
	summary: TableGameSummary;
	canSit: boolean;
	onSit: (position: number) => void;
}) {
	const {i18n} = useLingui();
	return (
		<div className={styles.seatMap} data-game={summary.game} data-flx="table-game.table-lobby.seat-map.seat-map">
			<div className={styles.tableTop} aria-hidden data-flx="table-game.table-lobby.seat-map.table-top">
				{i18n._(TABLE_GAME_NAME_DESCRIPTORS[summary.game])}
			</div>
			{TABLE_GAME_POSITIONS[summary.game].map((position) => {
				const player = summary.players.find((candidate) => candidate.position === position);
				const user = player ? Users.getUser(player.user_id) : undefined;
				return (
					<div
						key={position}
						className={styles.seat}
						data-table-position={position}
						data-taken={player ? 'true' : undefined}
						data-flx="table-game.table-lobby.seat-map.seat"
					>
						{player ? (
							<span className={styles.seatName} data-flx="table-game.table-lobby.seat-map.seat-name">
								{user ? NicknameUtils.getNickname(user, channel.guildId) : ''}
							</span>
						) : canSit ? (
							<Button small onClick={() => onSit(position)} data-flx="table-game.table-lobby.seat-map.button.sit">
								{i18n._(TAKE_SEAT_DESCRIPTOR)}
							</Button>
						) : (
							<span className={styles.seatOpen} data-flx="table-game.table-lobby.seat-map.seat-open">
								{i18n._(OPEN_SEAT_DESCRIPTOR)}
							</span>
						)}
					</div>
				);
			})}
		</div>
	);
});

// Everything around the board: setting a table up, seats, leaving, watching. The board itself is separate.
export const TableLobby = observer(function TableLobby({channel, slot}: {channel: Channel; slot: string}) {
	const {i18n} = useLingui();
	const channelId = channel.id;
	const summary = TableGames.getSummary(channelId, slot);
	const watchMode = TableGames.getWatchMode(channelId, slot);
	const [busy, error, run] = useRun();
	const [confirmingLeave, setConfirmingLeave] = useState(false);
	const inVoice = MediaEngine.channelId === channelId;
	if (!summary || summary.status === 'ended') {
		return (
			<div className={styles.lobby} data-flx="table-game.table-lobby.lobby">
				{summary && (
					<TableGameResult channel={channel} summary={summary} data-flx="table-game.table-lobby.table-game-result" />
				)}
				<CreateTableForm channelId={channelId} slot={slot} data-flx="table-game.table-lobby.create-table-form" />
			</div>
		);
	}
	if (!isKnownTableGameKind(summary.game)) {
		return <WarningAlert data-flx="table-game.table-lobby.update-notice">{i18n._(UPDATE_APP_DESCRIPTOR)}</WarningAlert>;
	}
	const me = Authentication.currentUserId;
	const seated = summary.players.some((player) => player.user_id === me);
	const leave = () => {
		setConfirmingLeave(false);
		run(() => TableGameCommands.leaveTable(channelId, slot));
	};
	return (
		<div className={styles.lobby} data-flx="table-game.table-lobby.lobby--2">
			{summary.status === 'lobby' && (
				<>
					<SeatMap
						channel={channel}
						summary={summary}
						canSit={!seated && inVoice && !busy}
						onSit={(position) => run(() => TableGameCommands.joinTable(channelId, slot, position))}
						data-flx="table-game.table-lobby.seat-map"
					/>
					<p className={styles.hint} data-flx="table-game.table-lobby.waiting">
						{i18n._(seated || inVoice ? WAITING_DESCRIPTOR : NOT_IN_VOICE_DESCRIPTOR)}
					</p>
				</>
			)}
			{seated &&
				(confirmingLeave ? (
					<div className={styles.confirm} role="alertdialog" data-flx="table-game.table-lobby.confirm-leave">
						<p className={styles.confirmText} data-flx="table-game.table-lobby.confirm-text">
							{i18n._(LEAVE_WARNING_DESCRIPTOR)}
						</p>
						<div className={styles.actions} data-flx="table-game.table-lobby.confirm-actions">
							<Button
								small
								variant="secondary"
								onClick={() => setConfirmingLeave(false)}
								data-flx="table-game.table-lobby.button.stay"
							>
								{i18n._(STAY_DESCRIPTOR)}
							</Button>
							<Button small variant="danger" onClick={leave} data-flx="table-game.table-lobby.button.leave-confirm">
								{i18n._(LEAVE_CONFIRM_DESCRIPTOR)}
							</Button>
						</div>
					</div>
				) : (
					<Button
						small
						variant="secondary"
						submitting={busy}
						onClick={() => (summary.status === 'playing' ? setConfirmingLeave(true) : leave())}
						data-flx="table-game.table-lobby.button.leave"
					>
						{i18n._(LEAVE_DESCRIPTOR)}
					</Button>
				))}
			{!seated && summary.status === 'playing' && (watchMode || inVoice) && (
				<div className={styles.actions} data-flx="table-game.table-lobby.watch-actions">
					{watchMode ? (
						<Button
							small
							variant="secondary"
							onClick={() => run(() => TableGameCommands.unspectate(channelId, slot))}
							data-flx="table-game.table-lobby.button.unspectate"
						>
							{i18n._(STOP_WATCHING_DESCRIPTOR)}
						</Button>
					) : (
						<Button
							small
							submitting={busy}
							onClick={() => run(() => TableGameCommands.spectate(channelId, slot))}
							data-flx="table-game.table-lobby.button.spectate"
						>
							{i18n._(WATCH_DESCRIPTOR)}
						</Button>
					)}
				</div>
			)}
			{watchMode === 'polling' && (
				<p className={styles.hint} data-flx="table-game.table-lobby.overflow">
					{i18n._(OVERFLOW_DESCRIPTOR)}
				</p>
			)}
			{error && (
				<p className={styles.error} role="alert" data-flx="table-game.table-lobby.error">
					{i18n._(error)}
				</p>
			)}
		</div>
	);
});
