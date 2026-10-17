// SPDX-License-Identifier: AGPL-3.0-or-later

// The rhythm test: a metronome clicks, the player taps along, and the median gap between what they heard and when
// their tap arrived is this device's input latency.
export const CALIBRATION_TAPS = 8;
export const CALIBRATION_LEAD_IN_CLICKS = 4;
export const CALIBRATION_INTERVAL_S = 0.6;
// Clicks keep going a little past the eighth tap for players who start late.
const CALIBRATION_SPARE_CLICKS = 4;
// Taps further than this from every click are stray presses.
const MAX_TAP_DISTANCE_S = CALIBRATION_INTERVAL_S * 0.45;
// When taps scatter more than this around their median, the run says nothing about latency.
const MAX_SPREAD_MS = 60;

export interface CalibrationPlan {
	readonly clickTimes: ReadonlyArray<number>;
	// First click the player taps along to; the ones before are the count-in.
	readonly firstTapClick: number;
	readonly endTime: number;
}

export function planCalibration(startContextTime: number): CalibrationPlan {
	const count = CALIBRATION_LEAD_IN_CLICKS + CALIBRATION_TAPS + CALIBRATION_SPARE_CLICKS;
	const clickTimes = Array.from({length: count}, (_, i) => startContextTime + i * CALIBRATION_INTERVAL_S);
	return {
		clickTimes,
		firstTapClick: CALIBRATION_LEAD_IN_CLICKS,
		endTime: startContextTime + count * CALIBRATION_INTERVAL_S,
	};
}

function median(values: ReadonlyArray<number>): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Offsets in ms of each tap from its nearest counted click; positive is late.
export function tapOffsetsMs(plan: CalibrationPlan, tapContextTimes: ReadonlyArray<number>): Array<number> {
	const counted = plan.clickTimes.slice(plan.firstTapClick);
	const offsets: Array<number> = [];
	for (const tap of tapContextTimes) {
		let nearest = Number.POSITIVE_INFINITY;
		for (const click of counted) if (Math.abs(tap - click) < Math.abs(nearest)) nearest = tap - click;
		if (Math.abs(nearest) <= MAX_TAP_DISTANCE_S) offsets.push(nearest * 1000);
	}
	return offsets;
}

export type CalibrationOutcome =
	| {readonly kind: 'ok'; readonly latencyMs: number}
	| {readonly kind: 'tooFewTaps'}
	| {readonly kind: 'unsteady'};

export function calibrationOutcome(plan: CalibrationPlan, tapContextTimes: ReadonlyArray<number>): CalibrationOutcome {
	const offsets = tapOffsetsMs(plan, tapContextTimes);
	if (offsets.length < CALIBRATION_TAPS - 2) return {kind: 'tooFewTaps'};
	const latencyMs = median(offsets);
	const spread = median(offsets.map((offset) => Math.abs(offset - latencyMs)));
	if (spread > MAX_SPREAD_MS) return {kind: 'unsteady'};
	return {kind: 'ok', latencyMs: Math.round(latencyMs)};
}
