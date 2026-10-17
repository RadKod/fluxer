// SPDX-License-Identifier: AGPL-3.0-or-later

import {makePersistent} from '@app/features/platform/utils/MobXPersistence';
import {makeAutoObservable} from 'mobx';

export const INPUT_LATENCY_LIMIT_MS = 300;

// Per-device: the latency offset belongs to this keyboard, output device and machine, so it is never synced.
class BandSettingsState {
	// Positive when presses register late; null until the rhythm test has run on this device.
	inputLatencyMs: number | null = null;
	volume = 0.8;

	constructor() {
		makeAutoObservable(this, {}, {autoBind: true});
		void makePersistent(this, 'BandSettings', ['inputLatencyMs', 'volume']);
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
}

export default new BandSettingsState();
