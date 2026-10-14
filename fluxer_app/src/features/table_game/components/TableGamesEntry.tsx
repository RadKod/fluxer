// SPDX-License-Identifier: AGPL-3.0-or-later

import Authentication from '@app/features/auth/state/Authentication';
import {ChannelHeaderIcon} from '@app/features/channel/components/channel_header_components/ChannelHeaderIcon';
import type {Channel} from '@app/features/channel/models/Channel';
import ExperimentAssignments from '@app/features/experiment/state/ExperimentAssignments';
import * as TableGameCommands from '@app/features/table_game/commands/TableGameCommands';
import {TableGamePanel, tableSlotNumber} from '@app/features/table_game/components/TableGamePanel';
import styles from '@app/features/table_game/components/TableGamesEntry.module.css';
import {useTableDeadlineTick} from '@app/features/table_game/hooks/useTableDeadlineTick';
import TableGames from '@app/features/table_game/state/TableGames';
import {TABLE_GAME_NAME_DESCRIPTORS, TABLE_SLOT_DESCRIPTOR} from '@app/features/table_game/utils/TableGameMessages';
import {BottomSheet} from '@app/features/ui/bottom_sheet/BottomSheet';
import {usePopout} from '@app/features/ui/hooks/usePopout';
import {openPopout, Popout as PopoverPopout} from '@app/features/ui/popover/PopoverPopout';
import MobileLayout from '@app/features/ui/state/MobileLayout';
import MediaEngine from '@app/features/voice/engine/MediaEngineFacade';
import {effectiveRoomTheme} from '@app/features/voice_scene/utils/EffectiveRoomTheme';
import {isKnownTableGameKind} from '@fluxer/constants/src/TableGameConstants';
import {themeTableSlots} from '@fluxer/constants/src/VoiceRoomThemes';
import {readVoiceRoomAssignment} from '@fluxer/schema/src/domains/experiment/ExperimentSchemas';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {CheckerboardIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import {useCallback, useEffect, useRef, useState} from 'react';

const TABLE_GAMES_DESCRIPTOR = msg({
	message: 'Table games',
	comment: 'Table games: voice call header button that opens the tables of the 3D room.',
});
const FREE_TABLE_DESCRIPTOR = msg({
	message: 'Free',
	context: 'table-game-free-table',
	comment: 'Table games: a table with no game; anyone can set one up.',
});

function tableSlotsOf(channel: Channel): ReadonlyArray<string> {
	const theme = effectiveRoomTheme(
		channel.roomTheme,
		readVoiceRoomAssignment(ExperimentAssignments.response).default_room_theme,
		channel.type,
	);
	return theme ? themeTableSlots(theme) : [];
}

// Mounted for every table this user sits at, panel open or not: nudges the server once a turn deadline passes and,
// after a reload (the list names me, no view yet), reads the table once for my own view.
function DeadlineTicker({channelId, slot}: {channelId: string; slot: string}): null {
	useTableDeadlineTick(channelId, slot);
	useEffect(() => {
		if (!TableGames.getView(channelId, slot)) void TableGameCommands.fetchTable(channelId, slot);
	}, [channelId, slot]);
	return null;
}

const MyTableTickers = observer(function MyTableTickers({channelId}: {channelId: string}) {
	const me = Authentication.currentUserId;
	if (!me) return null;
	return TableGames.getMyActiveSlots(channelId, me).map((slot) => (
		<DeadlineTicker
			key={slot}
			channelId={channelId}
			slot={slot}
			data-flx="table-game.table-games-entry.my-table-tickers.deadline-ticker"
		/>
	));
});

const HeaderEntry = observer(function HeaderEntry({channel, slots}: {channel: Channel; slots: ReadonlyArray<string>}) {
	const {i18n} = useLingui();
	const label = i18n._(TABLE_GAMES_DESCRIPTOR);
	const {isOpen, openProps} = usePopout(`table-games-${channel.id}`);
	const [sheetOpen, setSheetOpen] = useState(false);
	// The call view opening is the room opening: read the tables once (later reads are throttled).
	useEffect(() => {
		void TableGameCommands.loadTableList(channel.id);
	}, [channel.id]);
	const tickers = (
		<MyTableTickers channelId={channel.id} data-flx="table-game.table-games-entry.header-entry.my-table-tickers" />
	);
	if (MobileLayout.isMobileLayout()) {
		return (
			<>
				{tickers}
				<ChannelHeaderIcon
					icon={CheckerboardIcon}
					label={label}
					isSelected={sheetOpen}
					onClick={() => setSheetOpen(true)}
					aria-haspopup="dialog"
					aria-expanded={sheetOpen}
					data-flx="table-game.table-games-entry.header-entry.channel-header-icon.mobile"
				/>
				<BottomSheet
					isOpen={sheetOpen}
					onClose={() => setSheetOpen(false)}
					title={label}
					showCloseButton
					data-flx="table-game.table-games-entry.header-entry.bottom-sheet"
				>
					<div className={styles.sheetBody} data-flx="table-game.table-games-entry.header-entry.sheet-body">
						<TableGamePanel
							channel={channel}
							slots={slots}
							data-flx="table-game.table-games-entry.header-entry.table-game-panel"
						/>
					</div>
				</BottomSheet>
			</>
		);
	}
	return (
		<>
			{tickers}
			<PopoverPopout
				{...openProps}
				position="bottom-end"
				offsetMainAxis={8}
				render={() => (
					<div className={styles.popout} data-flx="table-game.table-games-entry.header-entry.popout">
						<TableGamePanel
							channel={channel}
							slots={slots}
							data-flx="table-game.table-games-entry.header-entry.table-game-panel--2"
						/>
					</div>
				)}
				data-flx="table-game.table-games-entry.header-entry.popover-popout"
			>
				<ChannelHeaderIcon
					icon={CheckerboardIcon}
					label={label}
					isSelected={isOpen}
					aria-haspopup="dialog"
					data-flx="table-game.table-games-entry.header-entry.channel-header-icon.desktop"
				/>
			</PopoverPopout>
		</>
	);
});

// A label on the table in the 3D room; it opens the panel for this table, also when the room asks for it. With a
// panelAnchor (the seat view's HUD) the room's request opens a compact panel above that anchor, clear of the table.
const SceneEntry = observer(function SceneEntry({
	channel,
	slots,
	slot,
	panelAnchor,
}: {
	channel: Channel;
	slots: ReadonlyArray<string>;
	slot: string;
	panelAnchor: HTMLElement | null;
}) {
	const {i18n} = useLingui();
	const chipRef = useRef<HTMLButtonElement | null>(null);
	const uniqueId = `table-game-${channel.id}-${slot}`;
	const summary = TableGames.getSummary(channel.id, slot);
	const active = summary && summary.status !== 'ended' ? summary : null;
	const beside = panelAnchor !== null;
	const render = useCallback(
		() => (
			<div
				className={styles.popout}
				data-beside={beside ? '' : undefined}
				data-flx="table-game.table-games-entry.scene-entry.popout"
			>
				<TableGamePanel
					channel={channel}
					slots={slots}
					initialSlot={slot}
					data-flx="table-game.table-games-entry.scene-entry.table-game-panel"
				/>
			</div>
		),
		[channel, slots, slot, beside],
	);
	const request = TableGames.panelRequest;
	const requested = request && request.channelId === channel.id && request.slot === slot ? request.id : null;
	// Each request opens once, with the panel as it is now; one made before this label mounted is not reopened.
	const handled = useRef(requested);
	useEffect(() => {
		if (requested === null || requested === handled.current || !chipRef.current) return;
		handled.current = requested;
		openPopout(
			panelAnchor ?? chipRef.current,
			{position: panelAnchor ? 'top-end' : 'top', offsetMainAxis: 8, render},
			uniqueId,
		);
	}, [requested, render, uniqueId, panelAnchor]);
	return (
		<PopoverPopout
			uniqueId={uniqueId}
			position="top"
			offsetMainAxis={8}
			render={render}
			data-flx="table-game.table-games-entry.scene-entry.popover-popout"
		>
			<button
				ref={chipRef}
				type="button"
				className={styles.chip}
				data-table-chip={slot}
				data-status={active?.status ?? 'free'}
				data-flx="table-game.table-games-entry.scene-entry.chip"
			>
				<span className={styles.chipName} data-flx="table-game.table-games-entry.scene-entry.chip-name">
					{i18n._(TABLE_SLOT_DESCRIPTOR, {number: tableSlotNumber(slot)})}
				</span>
				<span className={styles.chipGame} data-flx="table-game.table-games-entry.scene-entry.chip-game">
					{active
						? isKnownTableGameKind(active.game) && i18n._(TABLE_GAME_NAME_DESCRIPTORS[active.game])
						: i18n._(FREE_TABLE_DESCRIPTOR)}
				</span>
			</button>
		</PopoverPopout>
	);
});

// Only people in this voice call, with table games on and a room theme that has tables, see the entry.
export const TableGamesEntry = observer(function TableGamesEntry({
	channel,
	placement,
	slot,
	panelAnchor = null,
}: {
	channel: Channel;
	placement: 'header' | 'scene';
	slot?: string;
	panelAnchor?: HTMLElement | null;
}): React.JSX.Element | null {
	const slots = tableSlotsOf(channel);
	if (!readVoiceRoomAssignment(ExperimentAssignments.response).games) return null;
	if (slots.length === 0 || MediaEngine.channelId !== channel.id) return null;
	if (placement === 'header')
		return <HeaderEntry channel={channel} slots={slots} data-flx="table-game.table-games-entry.header-entry" />;
	if (!slot || !slots.includes(slot)) return null;
	return (
		<SceneEntry
			channel={channel}
			slots={slots}
			slot={slot}
			panelAnchor={panelAnchor}
			data-flx="table-game.table-games-entry.scene-entry"
		/>
	);
});
