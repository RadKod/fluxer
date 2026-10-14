// SPDX-License-Identifier: AGPL-3.0-or-later

import {buildVoiceParticipantIdentity} from '@app/features/voice/utils/VoiceParticipantIdentity';
import type {RoomLayout, RoomSeat, Vec3} from '@app/features/voice_scene/scene/VoiceSceneTypes';

// Avatars drawn in the standing area; the rest is one "+N". Keeps the DOM bounded in a 1000-person channel.
export const VOICE_SCENE_STANDING_CAP = 24;

export interface SeatParticipant {
	userId: string;
	connectionId: string;
}

export interface SeatPlacement {
	position: Vec3;
	seat: string | null;
}

export interface SeatAssignment<T extends SeatParticipant> {
	// Seat name → the one participant drawn there.
	seated: ReadonlyMap<string, T>;
	// Drawn standing, in input order, at most the cap.
	standing: ReadonlyArray<T>;
	// Standing people beyond the cap.
	overflow: number;
	// User id → where the user sits or stands; every user, overflow included (3D audio needs them all).
	placements: ReadonlyMap<string, SeatPlacement>;
}

// `seatOf` is identity → `micup.seat`, written only by the server. One avatar per user: a seated identity wins.
export function assignSeats<T extends SeatParticipant>(
	participants: ReadonlyArray<T>,
	seatOf: ReadonlyMap<string, string>,
	layout: RoomLayout,
): SeatAssignment<T> {
	const seatsByName = new Map<string, RoomSeat>(layout.seats.map((seat) => [seat.name, seat]));
	const seated = new Map<string, T>();
	const seatedUsers = new Set<string>();
	for (const participant of participants) {
		if (seatedUsers.has(participant.userId)) continue;
		const seat = seatOf.get(buildVoiceParticipantIdentity(participant.userId, participant.connectionId));
		if (!seat || !seatsByName.has(seat) || seated.has(seat)) continue;
		seated.set(seat, participant);
		seatedUsers.add(participant.userId);
	}
	const placements = new Map<string, SeatPlacement>();
	for (const [name, participant] of seated) {
		const seat = seatsByName.get(name)!;
		placements.set(participant.userId, {position: seat.position, seat: name});
	}
	const allStanding: Array<T> = [];
	for (const participant of participants) {
		if (placements.has(participant.userId)) continue;
		const stand = layout.stands[allStanding.length % Math.max(layout.stands.length, 1)] ?? layout.camTarget;
		placements.set(participant.userId, {position: stand, seat: null});
		allStanding.push(participant);
	}
	return {
		seated,
		standing: allStanding.slice(0, VOICE_SCENE_STANDING_CAP),
		overflow: Math.max(0, allStanding.length - VOICE_SCENE_STANDING_CAP),
		placements,
	};
}

// Lounge seats only: table and watch seats are never handed out by the server's auto pick.
export function freeLoungeSeatCount(layout: RoomLayout, seatOf: ReadonlyMap<string, string>): number {
	const held = new Set(seatOf.values());
	return layout.seats.filter((seat) => seat.table === null && seat.watch === null && !held.has(seat.name)).length;
}
