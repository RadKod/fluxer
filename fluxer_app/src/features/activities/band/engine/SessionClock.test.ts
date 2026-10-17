// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	type AudioClockAnchor,
	contextToSessionTime,
	performanceToContextTime,
	scheduleSongStart,
	sessionToContextTime,
	songTimeMs,
} from '@app/features/activities/band/engine/SessionClock';
import {describe, expect, it} from 'vitest';

// At local epoch 1_700_000_010_000 ms the AudioContext clock read 4 s.
const ANCHOR: AudioClockAnchor = {contextTime: 4, performanceTime: 10_000, timeOrigin: 1_700_000_000_000};
// The synced session clock runs 250 ms ahead of this machine.
const OFFSET = 250;

describe('SessionClock', () => {
	it('maps session time to AudioContext time and back', () => {
		const sessionMs = 1_700_000_012_250;
		expect(sessionToContextTime(sessionMs, OFFSET, ANCHOR)).toBe(6);
		expect(contextToSessionTime(6, OFFSET, ANCHOR)).toBe(sessionMs);
		expect(contextToSessionTime(sessionToContextTime(1_700_000_099_999, OFFSET, ANCHOR), OFFSET, ANCHOR)).toBeCloseTo(
			1_700_000_099_999,
			6,
		);
	});

	it('maps input event timestamps onto the audio clock', () => {
		expect(performanceToContextTime(10_500, ANCHOR)).toBe(4.5);
		expect(performanceToContextTime(9_000, ANCHOR)).toBe(3);
	});

	it('turns audio time into song time minus input latency', () => {
		expect(songTimeMs(7.5, 6, 0)).toBe(1500);
		expect(songTimeMs(7.5, 6, 40)).toBe(1460);
	});

	it('starts on the shared start time when it is far enough ahead', () => {
		const start = scheduleSongStart(1_700_000_013_250, OFFSET, ANCHOR, 0.5);
		expect(start).toEqual({contextTime: 7, offsetSeconds: 0, songZeroContextTime: 7});
	});

	it('starts a late client as soon as allowed and seeks to where everyone else is', () => {
		const start = scheduleSongStart(1_700_000_008_250, OFFSET, ANCHOR, 0.5);
		expect(start.songZeroContextTime).toBe(2);
		expect(start.contextTime).toBe(4.5);
		expect(start.offsetSeconds).toBe(2.5);
		expect(songTimeMs(start.contextTime, start.songZeroContextTime, 0)).toBe(start.offsetSeconds * 1000);
	});
});
