// SPDX-License-Identifier: AGPL-3.0-or-later

// A requestAnimationFrame callback draws a frame that reaches the screen about one refresh after the frame's
// timestamp. Drawing the highway for the moment its callback runs instead leaves the notes a frame behind the audio.
// This tracks the refresh interval from the timestamps themselves, so 60, 120 and 144 Hz screens all line up.
const DEFAULT_INTERVAL_MS = 1000 / 60;
const MIN_INTERVAL_MS = 4;
const MAX_INTERVAL_MS = 34;
// A longer gap is a stall or a hidden tab, not the refresh rate.
const MAX_SAMPLE_MS = 50;
const SMOOTHING = 0.1;

export class FramePacer {
	private intervalMs = DEFAULT_INTERVAL_MS;
	private lastTimestamp: number | null = null;

	get refreshIntervalMs(): number {
		return this.intervalMs;
	}

	// performance.now() time at which the frame drawn for this rAF timestamp is expected on screen.
	presentAt(frameTimestamp: number): number {
		const last = this.lastTimestamp;
		this.lastTimestamp = frameTimestamp;
		if (last !== null) {
			const delta = frameTimestamp - last;
			if (delta > 0 && delta <= MAX_SAMPLE_MS) {
				const sample = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, delta));
				this.intervalMs += (sample - this.intervalMs) * SMOOTHING;
			}
		}
		return frameTimestamp + this.intervalMs;
	}
}
