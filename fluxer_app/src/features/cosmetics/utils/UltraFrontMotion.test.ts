// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	FRONT_AT_REST,
	isFrontMoving,
	requestFront,
	stepFront,
	type UltraFrontMotion,
} from '@app/features/cosmetics/utils/UltraFrontMotion';
import {describe, expect, it} from 'vitest';

const LAST = 23;
const run = (state: UltraFrontMotion, steps: number, lastFrame = LAST) =>
	Array.from({length: steps}).reduce<UltraFrontMotion>((current) => stepFront(current, lastFrame), state);

describe('UltraFrontMotion', () => {
	it('opens frame by frame to the last frame, then loops', () => {
		const opening = requestFront(FRONT_AT_REST, true, LAST);
		expect(run(opening, 23)).toEqual({frame: 23, opening: true, looping: false});
		expect(run(opening, 24)).toEqual({frame: 23, opening: true, looping: true});
	});

	it('closes back from the frame it is on', () => {
		const midway = requestFront(run(requestFront(FRONT_AT_REST, true, LAST), 10), false, LAST);
		expect(midway.frame).toBe(10);
		expect(run(midway, 3).frame).toBe(7);
		expect(run(midway, 10)).toEqual(FRONT_AT_REST);
	});

	it('closing a loop starts from the last opening frame', () => {
		const looping = run(requestFront(FRONT_AT_REST, true, LAST), 24);
		expect(requestFront(looping, false, LAST)).toEqual({frame: LAST, opening: false, looping: false});
	});

	it('opening again while closing turns around on the same frame', () => {
		const closing = run(requestFront(run(requestFront(FRONT_AT_REST, true, LAST), 12), false, LAST), 4);
		expect(requestFront(closing, true, LAST)).toEqual({frame: 8, opening: true, looping: false});
	});

	it('stays put at rest and in a loop; moves otherwise (flapping never stacks state)', () => {
		expect(isFrontMoving(FRONT_AT_REST)).toBe(false);
		expect(isFrontMoving(run(requestFront(FRONT_AT_REST, true, LAST), 24))).toBe(false);
		expect(isFrontMoving(requestFront(FRONT_AT_REST, true, LAST))).toBe(true);
		let state = FRONT_AT_REST;
		for (let i = 0; i < 20; i++) state = stepFront(requestFront(state, i % 2 === 0, LAST), LAST);
		expect(state.frame).toBeLessThanOrEqual(1);
		expect(run(requestFront(state, false, LAST), 2)).toEqual(FRONT_AT_REST);
	});

	it('works with the two-frame minimum', () => {
		expect(run(requestFront(FRONT_AT_REST, true, 1), 2, 1)).toEqual({frame: 1, opening: true, looping: true});
	});
});
