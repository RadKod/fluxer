// SPDX-License-Identifier: AGPL-3.0-or-later

// sanalyer: voice channel activities (one per channel at a time). The API writes the running session into the
// LiveKit room metadata under VOICE_ACTIVITY_METADATA_KEY; clients read it from room.metadata and
// RoomEvent.RoomMetadataChanged. Clients cannot write it themselves (voice tokens never grant canUpdateOwnMetadata).
export const VOICE_ACTIVITY_IDS = ['band'] as const;

export type VoiceActivityId = (typeof VOICE_ACTIVITY_IDS)[number];

export function isKnownVoiceActivityId(id: string): id is VoiceActivityId {
	return (VOICE_ACTIVITY_IDS as ReadonlyArray<string>).includes(id);
}

export const VOICE_ACTIVITY_METADATA_KEY = 'sanalyer.activity';

// Value stored under VOICE_ACTIVITY_METADATA_KEY in the room metadata JSON object.
export interface VoiceActivitySessionMetadata {
	readonly activity_id: VoiceActivityId;
	readonly session_id: string;
	readonly started_by: string;
	readonly started_at: number;
}

// Data channel topic for one session; every message of an activity uses it.
export function voiceActivityTopic(sessionId: string): string {
	return `activity:${sessionId}`;
}

// A session nobody ended (crash, API restart) expires after this long.
export const VOICE_ACTIVITY_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
