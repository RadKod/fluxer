// SPDX-License-Identifier: AGPL-3.0-or-later

import {makePersistent} from '@app/features/platform/utils/MobXPersistence';
import {makeAutoObservable} from 'mobx';

export const INPUT_LATENCY_LIMIT_MS = 300;

// How far a missed note drops that part's stem.
export type DuckDepth = 'light' | 'strong';

// Per-device: the latency offset belongs to this keyboard, output device and machine, so it is never synced.
class BandSettingsState {
	// Positive when presses register late; null until the rhythm test has run on this device.
	inputLatencyMs: number | null = null;
	volume = 0.8;
	// A short muted-string or dull-drum sound on my own misses.
	missSound = true;
	duckDepth: DuckDepth = 'strong';

	constructor() {
		makeAutoObservable(this, {}, {autoBind: true});
		void makePersistent(this, 'BandSettings', ['inputLatencyMs', 'volume', 'missSound', 'duckDepth']);
	}

	get effectiveInputLatencyMs(): number {
		return this.inputLatencyMs ?? 0;
	}

	setInputLatencyMs(latencyMs: number): void {
		this.inputLatencyMs = Math.round(Math.min(INPUT_LATENCY_LIMIT_MS, Math.max(-INPUT_LATENCY_LIMIT_MS, latencyMs)));
	}

	setVolume(volume: number): void {
		this.volume = Math.min(1, Math.max(0, volume));
	}

	setMissSound(enabled: boolean): void {
		this.missSound = enabled;
	}

	setDuckDepth(depth: DuckDepth): void {
		this.duckDepth = depth;
	}
}

export default new BandSettingsState();
