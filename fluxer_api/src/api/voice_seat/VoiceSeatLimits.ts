// SPDX-License-Identifier: AGPL-3.0-or-later

// Seat hash {voice_seats:<channel_id>} lives 7 days past its last write; room_finished deletes it earlier.
export const VOICE_SEAT_HASH_TTL_S = 604_800;
// A leave that finds no j: mark (its join hook has not run yet) leaves a g:<identity> tombstone for this long, so the
// late join hook writes nothing for the gone connection.
export const VOICE_SEAT_GONE_TTL_S = 120;
// The fallback read repairs missing j: marks of every present connection, this many per script call.
export const VOICE_SEAT_MARK_CHUNK = 500;
// One gateway voice-state read per channel per window: stale-holder reconciliation and the membership fallback.
export const VOICE_SEAT_RECONCILE_LOCK_S = 30;
// Channel-wide cap on REST seat changes: every change reaches each participant of the LiveKit room, so the
// room's fan-out stays bounded however many members ask. Only a real change counts (not same, taken, full or a
// refused request), checked and counted inside the take script; webhook joins and table seats never.
// TEMPORARY: fixed window, so up to twice the cap across a window edge; a sliding window only if that ever shows.
export const VOICE_SEAT_CHANNEL_CHANGES_PER_WINDOW = 20;
export const VOICE_SEAT_CHANNEL_WINDOW_S = 1;
// TEMPORARY: hooks run detached in the API process, at most 64 at once (a call holds its slot until its work
// settles), aborted after 5 s; a full pool drops the hook with a warning that carries the hung count. Trigger: 'voice membership hook dropped' > 10 per minute. Path: move the hooks to a worker
// task on their own lane.
export const VOICE_MEMBERSHIP_HOOK_CONCURRENCY = 64;
export const VOICE_MEMBERSHIP_HOOK_TIMEOUT_MS = 5_000;
