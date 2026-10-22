// SPDX-License-Identifier: AGPL-3.0-or-later

import {makePersistent} from '@app/features/platform/utils/MobXPersistence';
import {makeAutoObservable} from 'mobx';

export const INPUT_LATENCY_LIMIT_MS = 300;

// How far a missed note drops that part's stem.
export type DuckDepth = 'light' | 'strong';

// What a player sees during a song: their own highway large with the band's beside it, or every highway alike.
// Spectators always get the band view.
export type BandHighwayView = 'focus' | 'group';

// Per-device: the latency offset belongs to this keyboard, output device and machine, so it is never synced.
class BandSettingsState {
	// Positive when presses register late; null until the rhythm test has run on this device.
	inputLatencyMs: number | null = null;
	volume = 0.8;
	// A pick scrape, muted chug or stick click on my own misses, heard only here.
	missSound = true;
	duckDepth: DuckDepth = 'strong';
	highwayView: BandHighwayView = 'focus';

	constructor() {
		makeAutoObservable(this, {}, {autoBind: true});
		void makePersistent(this, 'BandSettings', ['inputLatencyMs', 'volume', 'missSound', 'duckDepth', 'highwayView']);
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

	setHighwayView(view: BandHighwayView): void {
		this.highwayView = view;
	}
}

export default new BandSettingsState();
