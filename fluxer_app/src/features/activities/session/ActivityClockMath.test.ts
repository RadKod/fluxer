// SPDX-License-Identifier: AGPL-3.0-or-later

import {activityClockSample, bestActivityClockSample} from '@app/features/activities/session/ActivityClockMath';
import {describe, expect, it} from 'vitest';

describe('activity clock math', () => {
	it('puts the leader stamp halfway through the round trip', () => {
		// My clock is 5 s behind the leader; 20 ms each way.
		expect(activityClockSample(1_000, 6_020, 1_040)).toEqual({offsetMs: 5_000, rttMs: 40});
	});

	it('is off by half the asymmetry when the two ways differ', () => {
		// 10 ms out, 50 ms back: the true offset is 5000, the estimate 20 ms lower.
		expect(activityClockSample(1_000, 6_010, 1_060)?.offsetMs).toBe(4_980);
	});

	it('rejects a sample that went back in time', () => {
		expect(activityClockSample(1_000, 2_000, 999)).toBeNull();
	});

	it('keeps the sample with the shortest round trip', () => {
		const samples = [
			{offsetMs: 30, rttMs: 120},
			{offsetMs: 4, rttMs: 18},
			{offsetMs: -12, rttMs: 60},
		];
		expect(bestActivityClockSample(samples)).toEqual({offsetMs: 4, rttMs: 18});
		expect(bestActivityClockSample([])).toBeNull();
	});
});
