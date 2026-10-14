// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Channel} from '@app/features/channel/models/Channel';
import * as TableGameCommands from '@app/features/table_game/commands/TableGameCommands';
import {ChessBoard} from '@app/features/table_game/components/ChessBoard';
import {DamaBoard} from '@app/features/table_game/components/DamaBoard';
import {OkeyBoard} from '@app/features/table_game/components/okey/OkeyBoard';
import styles from '@app/features/table_game/components/TableGamePanel.module.css';
import {TableLobby} from '@app/features/table_game/components/TableLobby';
import {TavlaBoard} from '@app/features/table_game/components/TavlaBoard';
import {setTableSoundFocus} from '@app/features/table_game/sound/TableGameSounds';
import TableGames from '@app/features/table_game/state/TableGames';
import {
	TABLE_GAME_NAME_DESCRIPTORS,
	TABLE_SLOT_DESCRIPTOR,
	UPDATE_APP_DESCRIPTOR,
} from '@app/features/table_game/utils/TableGameMessages';
import {isKnownTableGameKind, TABLE_GAME_POSITIONS} from '@fluxer/constants/src/TableGameConstants';
import type {TableGameSummary} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {ArrowLeftIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import {useEffect, useState} from 'react';

const ALL_TABLES_DESCRIPTOR = msg({
	message: 'All tables',
	comment: 'Table games: back to the list of tables in the room.',
});
const EMPTY_TABLE_DESCRIPTOR = msg({
	message: 'Free',
	context: 'table-game-free-table',
	comment: 'Table games: a table with no game; anyone can set one up.',
});
const PLAYING_DESCRIPTOR = msg({message: 'Playing', comment: 'Table games: a game is in progress at this table.'});
const SEATS_DESCRIPTOR = msg({
	message: '{taken}/{total} seated',
	comment: 'Table games: players waiting at a table. {taken} and {total} are numbers.',
});

export function tableSlotNumber(slot: string): number {
	return Number.parseInt(slot.slice(1), 10);
}

function seatsTotal(summary: TableGameSummary): number {
	return TABLE_GAME_POSITIONS[summary.game].length;
}

const SlotRow = observer(function SlotRow({
	channel,
	slot,
	onOpen,
}: {
	channel: Channel;
	slot: string;
	onOpen: (slot: string) => void;
}) {
	const {i18n} = useLingui();
	const summary = TableGames.getSummary(channel.id, slot);
	const active = summary && summary.status !== 'ended' ? summary : null;
	let state: string;
	const known = active !== null && isKnownTableGameKind(active.game);
	if (!active) state = i18n._(EMPTY_TABLE_DESCRIPTOR);
	else if (!known) state = i18n._(UPDATE_APP_DESCRIPTOR);
	else if (active.status === 'playing') state = i18n._(PLAYING_DESCRIPTOR);
	else state = i18n._(SEATS_DESCRIPTOR, {taken: active.players.length, total: seatsTotal(active)});
	return (
		<li data-flx="table-game.table-game-panel.slot-row.item">
			<button
				type="button"
				className={styles.slotRow}
				data-slot={slot}
				data-status={active?.status ?? 'free'}
				onClick={() => onOpen(slot)}
				data-flx="table-game.table-game-panel.slot-row.button"
			>
				<span className={styles.slotName} data-flx="table-game.table-game-panel.slot-row.name">
					{i18n._(TABLE_SLOT_DESCRIPTOR, {number: tableSlotNumber(slot)})}
				</span>
				{active && known && (
					<span className={styles.slotGame} data-flx="table-game.table-game-panel.slot-row.game">
						{i18n._(TABLE_GAME_NAME_DESCRIPTORS[active.game])}
					</span>
				)}
				<span className={styles.slotState} data-flx="table-game.table-game-panel.slot-row.state">
					{state}
				</span>
			</button>
		</li>
	);
});

// One table: its board when a game is on, and the lobby controls around it.
const TableView = observer(function TableView({channel, slot}: {channel: Channel; slot: string}) {
	// The open table plays its sounds; the seat view holds its own focus.
	useEffect(() => {
		setTableSoundFocus(channel.id, slot, true);
		return () => setTableSoundFocus(channel.id, slot, false);
	}, [channel.id, slot]);
	const view = TableGames.getView(channel.id, slot);
	const game = view?.game_view && view.summary.status !== 'lobby' ? view.game_view.game : null;
	return (
		<div className={styles.table} data-flx="table-game.table-game-panel.table-view.table">
			{game === 'chess' && (
				<ChessBoard channel={channel} slot={slot} data-flx="table-game.table-game-panel.table-view.chess-board" />
			)}
			{(game === 'okey' || game === 'okey101') && (
				<OkeyBoard channel={channel} slot={slot} data-flx="table-game.table-game-panel.table-view.okey-board" />
			)}
			{(game === 'dama' || game === 'dama_normal') && (
				<DamaBoard channel={channel} slot={slot} data-flx="table-game.table-game-panel.table-view.dama-board" />
			)}
			{game === 'tavla' && (
				<TavlaBoard channel={channel} slot={slot} data-flx="table-game.table-game-panel.table-view.tavla-board" />
			)}
			<TableLobby channel={channel} slot={slot} data-flx="table-game.table-game-panel.table-view.table-lobby" />
		</div>
	);
});

// The panel keeps its own table choice: popouts render it outside the tree that opened it.
export const TableGamePanel = observer(function TableGamePanel({
	channel,
	slots,
	initialSlot = null,
}: {
	channel: Channel;
	slots: ReadonlyArray<string>;
	initialSlot?: string | null;
}) {
	const {i18n} = useLingui();
	const [slot, setSlot] = useState<string | null>(initialSlot);
	useEffect(() => {
		void TableGameCommands.loadTableList(channel.id);
	}, [channel.id]);
	const current = slot ?? (slots.length === 1 ? slots[0]! : null);
	if (!current) {
		return (
			<ul className={styles.slotList} data-flx="table-game.table-game-panel.slot-list">
				{slots.map((candidate) => (
					<SlotRow
						key={candidate}
						channel={channel}
						slot={candidate}
						onOpen={setSlot}
						data-flx="table-game.table-game-panel.slot-row"
					/>
				))}
			</ul>
		);
	}
	const summary = TableGames.getSummary(channel.id, current);
	return (
		<div className={styles.panel} data-flx="table-game.table-game-panel.panel">
			<div className={styles.header} data-flx="table-game.table-game-panel.header">
				{slots.length > 1 && (
					<button
						type="button"
						className={styles.back}
						aria-label={i18n._(ALL_TABLES_DESCRIPTOR)}
						onClick={() => setSlot(null)}
						data-flx="table-game.table-game-panel.button.back"
					>
						<ArrowLeftIcon weight="bold" data-flx="table-game.table-game-panel.arrow-left-icon" />
					</button>
				)}
				<h3 className={styles.title} data-flx="table-game.table-game-panel.title">
					{i18n._(TABLE_SLOT_DESCRIPTOR, {number: tableSlotNumber(current)})}
				</h3>
				{summary && summary.status !== 'ended' && isKnownTableGameKind(summary.game) && (
					<span className={styles.slotGame} data-flx="table-game.table-game-panel.game">
						{i18n._(TABLE_GAME_NAME_DESCRIPTORS[summary.game])}
					</span>
				)}
			</div>
			<TableView channel={channel} slot={current} data-flx="table-game.table-game-panel.table-view" />
		</div>
	);
});
