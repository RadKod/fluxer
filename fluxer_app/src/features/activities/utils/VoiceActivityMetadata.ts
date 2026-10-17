// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	isKnownVoiceActivityId,
	VOICE_ACTIVITY_METADATA_KEY,
	VOICE_ACTIVITY_SESSION_TTL_MS,
	type VoiceActivitySessionMetadata,
} from '@fluxer/constants/src/VoiceActivityConstants';

// The API's session object, from the room metadata or a REST reply. An activity this build does not know is no
// session here: there is nothing to show for it.
export function parseVoiceActivitySession(value: unknown, now = Date.now()): VoiceActivitySessionMetadata | null {
	if (typeof value !== 'object' || value === null) return null;
	const {activity_id, session_id, started_by, started_at} = value as Record<string, unknown>;
	if (typeof activity_id !== 'string' || !isKnownVoiceActivityId(activity_id)) return null;
	if (typeof session_id !== 'string' || session_id.length === 0) return null;
	if (typeof started_by !== 'string' || started_by.length === 0) return null;
	if (typeof started_at !== 'number' || !Number.isFinite(started_at)) return null;
	// A session nobody ended outlives its TTL only when the API could not clean up; it is not running.
	if (now - started_at > VOICE_ACTIVITY_SESSION_TTL_MS) return null;
	return {activity_id, session_id, started_by, started_at};
}

// room.metadata is a JSON object shared with other server-written keys; anything unreadable is no session.
export function parseRoomActivitySession(
	metadata: string | null | undefined,
	now = Date.now(),
): VoiceActivitySessionMetadata | null {
	if (!metadata) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(metadata);
	} catch {
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null) return null;
	return parseVoiceActivitySession((parsed as Record<string, unknown>)[VOICE_ACTIVITY_METADATA_KEY], now);
}
