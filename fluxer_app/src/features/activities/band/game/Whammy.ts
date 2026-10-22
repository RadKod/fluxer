// SPDX-License-Identifier: AGPL-3.0-or-later

// Guitar Hero style whammy from a key: pumping it while a sustain is held wobbles the pitch of the player's stem.
// The wobble is a vibrato from a modulated delay line, so the stem keeps its timing; how fast and how hard the key
// is pumped sets the rate and the depth.

import type {BandPart, InstrumentPart} from '@app/features/activities/band/engine/ChartModel';

export const WHAMMY_PARTS: ReadonlyArray<InstrumentPart> = ['guitar', 'rhythm', 'bass'];

export function isWhammyPart(part: BandPart): boolean {
	return (WHAMMY_PARTS as ReadonlyArray<BandPart>).includes(part);
}

export const WHAMMY = {
	// One slow press bends gently; pumping at the fastest interval reaches the full depth.
	gentleDepthCents: 22,
	maxDepthCents: 45,
	slowIntervalMs: 600,
	fastIntervalMs: 180,
	// A single press wobbles at the default rate; pumping sets one cycle per press.
	defaultRateHz: 5,
	minRateHz: 2.5,
	maxRateHz: 8,
	// The stem always runs through the delay line, so it sits this much later than the other stems: far under any
	// timing anyone can hear, and the delay never has to jump when the whammy starts.
	baseDelayS: 0.004,
	attackS: 0.05,
	releaseS: 0.2,
	// While held, the state goes out again this often; a remote wobble with no news for remoteTimeoutMs lets go.
	refreshMs: 400,
	remoteTimeoutMs: 1_000,
} as const;

export interface WhammyModulation {
	readonly depthCents: number;
	readonly rateHz: number;
}

export const WHAMMY_OFF: WhammyModulation = {depthCents: 0, rateHz: WHAMMY.defaultRateHz};

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

// Interval since the press before, null for a first press.
export function whammyModulation(intervalMs: number | null): WhammyModulation {
	if (intervalMs === null || intervalMs > WHAMMY.slowIntervalMs * 2) {
		return {depthCents: WHAMMY.gentleDepthCents, rateHz: WHAMMY.defaultRateHz};
	}
	const pace = clamp((WHAMMY.slowIntervalMs - intervalMs) / (WHAMMY.slowIntervalMs - WHAMMY.fastIntervalMs), 0, 1);
	return {
		depthCents: WHAMMY.gentleDepthCents + (WHAMMY.maxDepthCents - WHAMMY.gentleDepthCents) * pace,
		rateHz: clamp(1000 / intervalMs, WHAMMY.minRateHz, WHAMMY.maxRateHz),
	};
}

// Swing of the delay time, in seconds, for a vibrato peaking at depthCents: a delay moving at speed v shifts the
// pitch by the ratio 1 + v, and a sine of amplitude A at f Hz peaks at v = 2πfA.
export function whammyDelaySwingS({depthCents, rateHz}: WhammyModulation): number {
	if (depthCents <= 0 || rateHz <= 0) return 0;
	const swing = (2 ** (depthCents / 1200) - 1) / (2 * Math.PI * rateHz);
	return Math.min(swing, WHAMMY.baseDelayS * 0.9);
}

// My whammy key: what each press and release does to the wobble.
export class WhammyInput {
	private lastPressMs: number | null = null;
	pressed = false;

	press(ms: number): WhammyModulation {
		const interval = this.lastPressMs === null ? null : ms - this.lastPressMs;
		this.lastPressMs = ms;
		this.pressed = true;
		return whammyModulation(interval);
	}

	release(): WhammyModulation {
		this.pressed = false;
		return WHAMMY_OFF;
	}
}
