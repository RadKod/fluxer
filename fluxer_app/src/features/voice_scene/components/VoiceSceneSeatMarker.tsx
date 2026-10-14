// SPDX-License-Identifier: AGPL-3.0-or-later

import {tableSlotNumber} from '@app/features/table_game/components/TableGamePanel';
import {TABLE_SLOT_DESCRIPTOR} from '@app/features/table_game/utils/TableGameMessages';
import {Tooltip} from '@app/features/ui/tooltip/Tooltip';
import styles from '@app/features/voice_scene/components/VoiceSceneOverlay.module.css';
import type {RoomSeat} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {clsx} from 'clsx';

const SIT_HERE_DESCRIPTOR = msg({
	message: 'Sit here',
	comment: '3D voice room: tooltip and label on an empty seat; clicking it moves you to that seat.',
});
const WATCH_HERE_DESCRIPTOR = msg({
	message: 'Sit here and watch',
	comment:
		'3D voice room: tooltip and label on an empty seat beside a game table; sitting there shows the game up close (only what every player shows, never a rack).',
});

// An empty seat. A lounge or watch seat asks the server for it; a table seat opens that table's panel.
export function VoiceSceneSeatMarker({
	seat,
	disabled,
	onSelect,
}: {
	seat: RoomSeat;
	disabled: boolean;
	onSelect: (seat: RoomSeat) => void;
}) {
	const {i18n} = useLingui();
	const label = seat.table
		? i18n._(TABLE_SLOT_DESCRIPTOR, {number: tableSlotNumber(seat.table.slot)})
		: i18n._(seat.watch ? WATCH_HERE_DESCRIPTOR : SIT_HERE_DESCRIPTOR);
	return (
		<Tooltip text={label} data-flx="voice-scene.voice-scene-seat-marker.tooltip">
			<button
				type="button"
				className={clsx(styles.marker, seat.table && styles.markerTable, seat.watch && styles.markerWatch)}
				disabled={disabled}
				aria-label={label}
				data-seat={seat.name}
				onClick={() => onSelect(seat)}
				data-flx="voice-scene.voice-scene-seat-marker.marker"
			/>
		</Tooltip>
	);
}
