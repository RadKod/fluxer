// SPDX-License-Identifier: AGPL-3.0-or-later

import * as TableGameCommands from '@app/features/table_game/commands/TableGameCommands';
import type {RoomLayout} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {assignSeats, type SeatAssignment, type SeatParticipant} from '@app/features/voice_scene/utils/SeatAssignment';
import {parseSeatName, VOICE_SEAT_ATTRIBUTE} from '@fluxer/constants/src/VoiceRoomThemes';
import {type Room, RoomEvent} from 'livekit-client';
import {useEffect, useMemo, useState} from 'react';

const NO_SEATS: ReadonlyMap<string, string> = new Map();

// Identity → seat, from the attribute the server writes on each LiveKit participant. No data packets.
function readSeats(room: Room): ReadonlyMap<string, string> {
	const seats = new Map<string, string>();
	for (const participant of [room.localParticipant, ...room.remoteParticipants.values()]) {
		const seat = participant.attributes[VOICE_SEAT_ATTRIBUTE];
		if (seat) seats.set(participant.identity, seat);
	}
	return seats;
}

const isTableSeat = (seat: string | undefined): boolean => seat !== undefined && parseSeatName(seat)?.kind === 'table';

function tableSeatsChanged(previous: ReadonlyMap<string, string>, next: ReadonlyMap<string, string>): boolean {
	for (const identity of new Set([...previous.keys(), ...next.keys()])) {
		const before = previous.get(identity);
		const after = next.get(identity);
		if (before !== after && (isTableSeat(before) || isTableSeat(after))) return true;
	}
	return false;
}

export function useSeatAssignments<T extends SeatParticipant>({
	channelId,
	room,
	layout,
	participants,
}: {
	channelId: string;
	room: Room | null;
	layout: RoomLayout;
	participants: ReadonlyArray<T>;
}): {assignment: SeatAssignment<T>; seatOf: ReadonlyMap<string, string>} {
	const [seatOf, setSeatOf] = useState<ReadonlyMap<string, string>>(NO_SEATS);
	useEffect(() => {
		if (!room) {
			setSeatOf(NO_SEATS);
			return;
		}
		let current = readSeats(room);
		setSeatOf(current);
		const refresh = () => {
			const next = readSeats(room);
			// others learn about table changes from table seat attributes; The refresh debounces and throttles the read.
			if (tableSeatsChanged(current, next)) TableGameCommands.requestTableListRefresh(channelId);
			current = next;
			setSeatOf(next);
		};
		room.on(RoomEvent.ParticipantAttributesChanged, refresh);
		room.on(RoomEvent.ParticipantConnected, refresh);
		room.on(RoomEvent.ParticipantDisconnected, refresh);
		return () => {
			room.off(RoomEvent.ParticipantAttributesChanged, refresh);
			room.off(RoomEvent.ParticipantConnected, refresh);
			room.off(RoomEvent.ParticipantDisconnected, refresh);
		};
	}, [room, channelId]);
	const assignment = useMemo(() => assignSeats(participants, seatOf, layout), [participants, seatOf, layout]);
	return {assignment, seatOf};
}
