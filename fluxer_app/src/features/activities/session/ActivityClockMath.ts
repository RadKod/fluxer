// SPDX-License-Identifier: AGPL-3.0-or-later

export const ACTIVITY_CLOCK_ROUNDS = 6;
export const ACTIVITY_CLOCK_RESYNC_MS = 30_000;
export const ACTIVITY_CLOCK_PING_TIMEOUT_MS = 1_500;

export interface ActivityClockSample {
	readonly offsetMs: number;
	readonly rttMs: number;
}

// One ping/pong: I sent at sentAt, the leader stamped leaderAt, the pong came back at receivedAt (my clock). The
// leader's stamp is taken to sit halfway through the round trip, so the error is at most half the round trip.
export function activityClockSample(sentAt: number, leaderAt: number, receivedAt: number): ActivityClockSample | null {
	const rttMs = receivedAt - sentAt;
	if (!Number.isFinite(rttMs) || !Number.isFinite(leaderAt) || rttMs < 0) return null;
	return {offsetMs: leaderAt + rttMs / 2 - receivedAt, rttMs};
}

// The shortest round trip has the least room for asymmetric delay, so its offset is the one kept.
export function bestActivityClockSample(samples: ReadonlyArray<ActivityClockSample>): ActivityClockSample | null {
	let best: ActivityClockSample | null = null;
	for (const sample of samples) {
		if (!best || sample.rttMs < best.rttMs) best = sample;
	}
	return best;
}
