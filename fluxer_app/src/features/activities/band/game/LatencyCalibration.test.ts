// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	CALIBRATION_INTERVAL_S,
	CALIBRATION_LEAD_IN_CLICKS,
	CALIBRATION_TAPS,
	calibrationOutcome,
	planCalibration,
	tapOffsetsMs,
} from '@app/features/activities/band/game/LatencyCalibration';
import {describe, expect, it} from 'vitest';

const plan = planCalibration(2);
const counted = plan.clickTimes.slice(CALIBRATION_LEAD_IN_CLICKS);

describe('LatencyCalibration', () => {
	it('counts in before the taps that are measured', () => {
		expect(plan.clickTimes[0]).toBe(2);
		expect(plan.clickTimes[1] - plan.clickTimes[0]).toBeCloseTo(CALIBRATION_INTERVAL_S);
		expect(plan.firstTapClick).toBe(CALIBRATION_LEAD_IN_CLICKS);
		expect(plan.endTime).toBeGreaterThan(plan.clickTimes.at(-1)!);
	});

	it('measures the median lateness of the taps', () => {
		const lateness = [0.04, 0.05, 0.045, 0.06, 0.05, 0.03, 0.055, 0.05];
		const taps = lateness.map((late, i) => counted[i] + late);
		expect(calibrationOutcome(plan, taps)).toEqual({kind: 'ok', latencyMs: 50});
	});

	it('handles early tappers and ignores stray presses between clicks', () => {
		const taps = counted.slice(0, CALIBRATION_TAPS).map((click) => click - 0.02);
		taps.push(counted[2] + CALIBRATION_INTERVAL_S / 2);
		expect(tapOffsetsMs(plan, taps)).toHaveLength(CALIBRATION_TAPS);
		expect(calibrationOutcome(plan, taps)).toEqual({kind: 'ok', latencyMs: -20});
	});

	it('refuses too few or scattered taps', () => {
		expect(calibrationOutcome(plan, counted.slice(0, 3))).toEqual({kind: 'tooFewTaps'});
		const scattered = counted.slice(0, CALIBRATION_TAPS).map((click, i) => click + (i % 2 === 0 ? -0.2 : 0.2));
		expect(calibrationOutcome(plan, scattered)).toEqual({kind: 'unsteady'});
	});
});
