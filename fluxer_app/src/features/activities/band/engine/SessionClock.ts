// SPDX-License-Identifier: AGPL-3.0-or-later

// Pure conversions between the shared session clock and one client's AudioContext.
//
// Session time is epoch milliseconds on the synced clock: sessionMs = localNow + clockOffsetMs, where localNow is
// performance.timeOrigin + performance.now(), the same timebase as RoomActivitySession's clock.
// An anchor ties AudioContext time to wall time; take it from AudioContext.getOutputTimestamp() plus
// performance.timeOrigin, which also folds the output latency into the mapping.

export interface AudioClockAnchor {
	// AudioContext time in seconds (getOutputTimestamp().contextTime).
	readonly contextTime: number;
	// performance.now() at the same instant (getOutputTimestamp().performanceTime).
	readonly performanceTime: number;
	readonly timeOrigin: number;
}

export interface SongStartSchedule {
	// AudioContext time at which to start every stem.
	readonly contextTime: number;
	// Seconds into the audio to start from; above zero when joining a song already underway.
	readonly offsetSeconds: number;
	// AudioContext time of song position zero; pass to songTimeMs().
	readonly songZeroContextTime: number;
}

function anchorEpochMs(anchor: AudioClockAnchor): number {
	return anchor.timeOrigin + anchor.performanceTime;
}

export function sessionToContextTime(sessionMs: number, clockOffsetMs: number, anchor: AudioClockAnchor): number {
	const localEpochMs = sessionMs - clockOffsetMs;
	return anchor.contextTime + (localEpochMs - anchorEpochMs(anchor)) / 1000;
}

export function contextToSessionTime(contextTime: number, clockOffsetMs: number, anchor: AudioClockAnchor): number {
	return anchorEpochMs(anchor) + (contextTime - anchor.contextTime) * 1000 + clockOffsetMs;
}

// Maps an input event's timeStamp (performance.now() timebase) onto the AudioContext clock.
export function performanceToContextTime(performanceTime: number, anchor: AudioClockAnchor): number {
	return anchor.contextTime + (performanceTime - anchor.performanceTime) / 1000;
}

// Song position in ms for the judge: what the player heard at `contextTime`, shifted by their calibrated input
// latency (positive when their presses register late).
export function songTimeMs(contextTime: number, songZeroContextTime: number, inputLatencyMs: number): number {
	return (contextTime - songZeroContextTime) * 1000 - inputLatencyMs;
}

// Chooses when to start playback for a song that begins at `sessionStartMs`. Audio cannot start in the past or
// sooner than `minLeadSeconds` from the anchor, so a late client starts later and seeks forward to stay in sync.
export function scheduleSongStart(
	sessionStartMs: number,
	clockOffsetMs: number,
	anchor: AudioClockAnchor,
	minLeadSeconds: number,
): SongStartSchedule {
	const sharedStart = sessionToContextTime(sessionStartMs, clockOffsetMs, anchor);
	const earliest = anchor.contextTime + minLeadSeconds;
	if (sharedStart >= earliest) return {contextTime: sharedStart, offsetSeconds: 0, songZeroContextTime: sharedStart};
	return {contextTime: earliest, offsetSeconds: earliest - sharedStart, songZeroContextTime: sharedStart};
}
