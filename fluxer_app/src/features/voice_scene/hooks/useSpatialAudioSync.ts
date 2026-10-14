// SPDX-License-Identifier: AGPL-3.0-or-later

import {buildVoiceParticipantIdentity} from '@app/features/voice/utils/VoiceParticipantIdentity';
import {createRoomSpatialAudio, type SpatialSpeaker} from '@app/features/voice_scene/audio/RoomSpatialAudio';
import type {SpatialAudioInput} from '@app/features/voice_scene/audio/SpatialAudioMath';
import type {VoiceSceneHandle} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import type {SeatAssignment, SeatParticipant} from '@app/features/voice_scene/utils/SeatAssignment';
import type {Room} from 'livekit-client';
import {useEffect, useRef, useState} from 'react';

// ~0.3°: a zoom or a resize redraws the scene without turning the listener.
const AZIMUTH_EPSILON_RAD = 0.005;

interface SpatialParticipant extends SeatParticipant {
	isLocal: boolean;
	hasScreenShare: boolean;
}

function buildInput(
	handle: VoiceSceneHandle,
	assignment: SeatAssignment<SeatParticipant>,
	participants: ReadonlyArray<SpatialParticipant>,
	myUserId: string | null,
	azimuth: number,
): SpatialAudioInput {
	const {layout} = handle;
	const seatRank = new Map(layout.seats.map((seat, index) => [seat.name, index]));
	const rank = (userId: string): number => {
		const seat = assignment.placements.get(userId)?.seat;
		return seat ? (seatRank.get(seat) ?? layout.seats.length) : layout.seats.length;
	};
	// Seat order, then standing in list order (stable sort): which four get HRTF stays put as people talk.
	const remote = participants.filter((participant) => !participant.isLocal);
	const ordered = remote.map((participant, index) => ({participant, index}));
	ordered.sort((a, b) => rank(a.participant.userId) - rank(b.participant.userId) || a.index - b.index);
	const speakers: Array<SpatialSpeaker> = [];
	for (const {participant} of ordered) {
		const placement = assignment.placements.get(participant.userId);
		if (!placement) continue;
		speakers.push({
			identity: buildVoiceParticipantIdentity(participant.userId, participant.connectionId),
			kind: 'mic',
			position: placement.position,
		});
	}
	if (layout.screen) {
		for (const participant of remote) {
			if (!participant.hasScreenShare) continue;
			speakers.push({
				identity: buildVoiceParticipantIdentity(participant.userId, participant.connectionId),
				kind: 'screen',
				position: layout.screen.center,
			});
		}
	}
	const own = myUserId ? assignment.placements.get(myUserId) : undefined;
	return {
		// home: azimuth 0 is the cam_home view; without it the sound is turned 20–34° from the picture.
		listener: {
			position: own?.position ?? layout.camTarget,
			azimuth,
			home: {camHome: layout.camHome, camTarget: layout.camTarget},
		},
		speakers,
	};
}

// Binds the room view to 3D audio: seats and the camera steer each speaker's panner; the view closing removes the chains.
export function useSpatialAudioSync({
	handle,
	room,
	assignment,
	participants,
	myUserId,
	enabled,
}: {
	handle: VoiceSceneHandle;
	room: Room | null;
	assignment: SeatAssignment<SeatParticipant>;
	participants: ReadonlyArray<SpatialParticipant>;
	myUserId: string | null;
	enabled: boolean;
}): void {
	const [controller] = useState(() => createRoomSpatialAudio());
	const lastAzimuth = useRef(0);
	const build = useRef((azimuth: number) => buildInput(handle, assignment, participants, myUserId, azimuth));
	build.current = (azimuth) => buildInput(handle, assignment, participants, myUserId, azimuth);

	useEffect(() => () => controller.detach(), [controller]);
	useEffect(() => {
		if (room) controller.attach(room);
		else controller.detach();
	}, [controller, room]);
	useEffect(() => {
		controller.setMode(enabled ? 'spatial' : 'flat');
	}, [controller, enabled]);
	useEffect(() => {
		lastAzimuth.current = handle.getCameraAzimuth();
		controller.update(build.current(lastAzimuth.current));
	}, [controller, handle, assignment, participants, myUserId]);
	useEffect(
		() =>
			handle.onViewChange(() => {
				const azimuth = handle.getCameraAzimuth();
				if (Math.abs(azimuth - lastAzimuth.current) < AZIMUTH_EPSILON_RAD) return;
				lastAzimuth.current = azimuth;
				controller.update(build.current(azimuth));
			}),
		[controller, handle],
	);
}
