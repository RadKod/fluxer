// SPDX-License-Identifier: AGPL-3.0-or-later

import type {VoiceMediaGraphVideoQuality} from '@app/features/voice/engine/VoiceMediaGraph';

// per viewer at worst 4 × 360p + 5 × 180p ≈ 2.6 Mbit/s (+ 720p on the TV), whatever the room size.
export const ROOM_CAMERA_MAX = 9; // TV included
export const ROOM_CAMERA_MEDIUM_MAX = 4;
export const ROOM_CAMERA_HIGH_MAX = 1; // only the TV
export const ROOM_CAMERA_MIN_DISC_PX = 24; // device pixels; a smaller disc keeps the picture
export const ROOM_CAMERA_MEDIUM_DISC_PX = 96;
export const ROOM_CAMERA_UNSUBSCRIBE_GRACE_MS = 2000; // same as the call grid (VIDEO_UNSUBSCRIBE_GRACE_MS)
export const ROOM_CAMERA_DOWNGRADE_HOLD_MS = 1000;
export const ROOM_CAMERA_REPLAN_THROTTLE_MS = 500;
// TEMPORARY: the caps above are compiled-in constants. Trigger: SFU node egress > 70 % or quality
// complaints. Path: move them to VoiceRoomConfig + /experiments.

export type RoomCameraQuality = VoiceMediaGraphVideoQuality;

export interface CameraCandidate {
	identity: string;
	visible: boolean;
	discPx: number;
	distanceM: number;
	sameTable: boolean;
	speakingRecently: boolean;
	seatOrder: number;
	locallyDisabled: boolean;
	// Held by a call or tile popout window: that window owns the subscription; the room neither touches nor counts it.
	externallyHeld: boolean;
	cameraCard?: 'room' | 'seat';
}

// TV > my table (nearest first) > distance > spoke in the last 10 s > seat order.
function byPriority(a: CameraCandidate, b: CameraCandidate): number {
	return (
		Number(b.sameTable) - Number(a.sameTable) ||
		a.distanceM - b.distanceM ||
		Number(b.speakingRecently) - Number(a.speakingRecently) ||
		a.seatOrder - b.seatOrder
	);
}

// `enabled` = the `cameras` assignment ∧ the user's setting (deafening is about sound only).
// Insertion order is the priority order.
export function planRoomCameras(p: {
	enabled: boolean;
	candidates: ReadonlyArray<CameraCandidate>;
	tv: string | null;
}): ReadonlyMap<string, RoomCameraQuality> {
	const plan = new Map<string, RoomCameraQuality>();
	if (!p.enabled) return plan;
	const tv = p.tv === null ? undefined : p.candidates.find((entry) => entry.identity === p.tv);
	if (tv && !tv.locallyDisabled && !tv.externallyHeld) plan.set(tv.identity, 'high');
	const ranked = p.candidates
		.filter(
			(entry) =>
				entry.identity !== p.tv &&
				entry.visible &&
				!entry.locallyDisabled &&
				!entry.externallyHeld &&
				entry.discPx >= ROOM_CAMERA_MIN_DISC_PX,
		)
		.sort(byPriority);
	let medium = 0;
	for (const entry of ranked) {
		if (plan.size >= ROOM_CAMERA_MAX) break;
		const isMedium =
			medium < ROOM_CAMERA_MEDIUM_MAX &&
			(entry.cameraCard === 'seat' || (!entry.cameraCard && entry.discPx >= ROOM_CAMERA_MEDIUM_DISC_PX));
		if (isMedium) medium++;
		plan.set(entry.identity, isMedium ? 'medium' : 'low');
	}
	return plan;
}
