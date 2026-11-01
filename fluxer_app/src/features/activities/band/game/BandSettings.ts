// SPDX-License-Identifier: AGPL-3.0-or-later

import {makePersistent} from '@app/features/platform/utils/MobXPersistence';
import {makeAutoObservable} from 'mobx';

export const INPUT_LATENCY_LIMIT_MS = 300;

// How far a missed note drops that part's stem.
export type DuckDepth = 'light' | 'strong';

// What a player sees during a song: their own highway large with the band's beside it, or every highway alike.
// Spectators always get the band view.
export type BandHighwayView = 'focus' | 'group';

function clampLatency(latencyMs: number): number {
	return Math.round(Math.min(INPUT_LATENCY_LIMIT_MS, Math.max(-INPUT_LATENCY_LIMIT_MS, latencyMs)));
}

// Per-device: the latency offset belongs to this keyboard, output device and machine, so it is never synced.
class BandSettingsState {
	// Positive when presses register late; null until the rhythm test has run on this device.
	inputLatencyMs: number | null = null;
	// How late taps land after the flashing line crosses the ring in the visual test; null until it has run. Taps
	// carry the input latency too, so the screen's own delay is this minus inputLatencyMs.
	visualLatencyMs: number | null = null;
	// The hint about slow audio output (Bluetooth) was closed on this device.
	latencyHintDismissed = false;
	volume = 0.8;
	// A pick scrape, muted chug or stick click on my own misses, heard only here.
	missSound = true;
	duckDepth: DuckDepth = 'strong';
	highwayView: BandHighwayView = 'focus';
	// The freestyle solo info box beside my highway, open or folded to its title.
	freestyleInfoOpen = true;

	constructor() {
		makeAutoObservable(this, {}, {autoBind: true});
		void makePersistent(this, 'BandSettings', [
			'inputLatencyMs',
			'visualLatencyMs',
			'latencyHintDismissed',
			'volume',
			'missSound',
			'duckDepth',
			'highwayView',
			'freestyleInfoOpen',
		]);
	}

	get effectiveInputLatencyMs(): number {
		return this.inputLatencyMs ?? 0;
	}

	// How far ahead the highway is drawn so a note reaches the strikeline when the screen shows it there, not when the
	// frame was drawn. Zero until the visual test has run.
	get visualOffsetMs(): number {
		return this.visualLatencyMs === null ? 0 : this.visualLatencyMs - this.effectiveInputLatencyMs;
	}

	setInputLatencyMs(latencyMs: number): void {
		this.inputLatencyMs = clampLatency(latencyMs);
	}

	setVisualLatencyMs(latencyMs: number): void {
		this.visualLatencyMs = clampLatency(latencyMs);
	}

	dismissLatencyHint(): void {
		this.latencyHintDismissed = true;
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

	setFreestyleInfoOpen(open: boolean): void {
		this.freestyleInfoOpen = open;
	}
}

export default new BandSettingsState();
