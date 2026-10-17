// SPDX-License-Identifier: AGPL-3.0-or-later

import {noteGroup} from '@app/features/activities/band/engine/BandTestFixtures';
import {
	DESIGN_HEIGHT,
	DESIGN_WIDTH,
	LOOK_AHEAD_MS,
	laneCenterX,
	layoutStage,
	noteDistance,
	project,
	strikeDistance,
	surfaceLane,
	toFrame,
	visibleWindow,
} from '@app/features/activities/band/game/HighwayGeometry';
import {fadeAfter, firstVisibleGroup} from '@app/features/activities/band/game/HighwayRenderer';
import {describe, expect, it} from 'vitest';

describe('HighwayGeometry', () => {
	it('reproduces the approved three-highway layout at design size', () => {
		const layout = layoutStage(DESIGN_WIDTH, DESIGN_HEIGHT, ['frets', 'drums', 'frets']);
		expect(layout.scale).toBe(1);
		// The mock-up rounded the centred block to whole pixels: 110, 347, 614.
		expect(layout.highways.map(({left, width, lanes, noteScale}) => [left, width, lanes, noteScale])).toEqual([
			[110.5, 205, 5, 1],
			[347.5, 235, 4, 1],
			[614.5, 205, 5, 1],
		]);
		expect(layout.regionTop).toBe(196);
	});

	it('projects the near edge unscaled and narrows towards the far end', () => {
		const layout = layoutStage(DESIGN_WIDTH, DESIGN_HEIGHT, ['frets']);
		const near = project(layout, 362, 0);
		expect(near).toEqual({x: 362, y: 196 + 480, scale: 1});
		const far = project(layout, 362, layout.planeLength);
		expect(far.scale).toBeLessThan(1);
		expect(far.y).toBeLessThan(near.y);
		// Points left of the centre move right as they recede, as in a CSS perspective with a centred origin.
		expect(far.x).toBeGreaterThan(near.x);
		expect(project(layout, layout.originX, layout.planeLength).x).toBeCloseTo(layout.originX);
	});

	it('scales uniformly into a smaller panel, anchored to the bottom centre', () => {
		const layout = layoutStage(DESIGN_WIDTH, DESIGN_HEIGHT / 2, ['frets', 'drums', 'frets']);
		expect(layout.scale).toBe(0.5);
		expect(layout.frameLeft).toBe(DESIGN_WIDTH / 4);
		expect(layout.frameTop).toBe(0);
		expect(layout.highways[0].left).toBe(DESIGN_WIDTH / 4 + 110.5 / 2);
		expect(toFrame(layout, layout.highways[0].left, layout.regionTop)).toEqual({x: 110.5, y: 196});
	});

	it('shrinks four highways to fit the design width', () => {
		const layout = layoutStage(DESIGN_WIDTH, DESIGN_HEIGHT, ['frets', 'drums', 'frets', 'frets']);
		const last = layout.highways[3];
		expect(layout.highways[0].left).toBeGreaterThanOrEqual(0);
		expect(last.left + last.width).toBeLessThanOrEqual(DESIGN_WIDTH);
		expect(last.width).toBeLessThan(205);
		expect(layout.highways.every((highway) => highway.noteScale === 1)).toBe(true);
	});

	it('fits five highways centred, with smaller gems in the narrower lanes', () => {
		const layout = layoutStage(DESIGN_WIDTH, DESIGN_HEIGHT, ['frets', 'frets', 'drums', 'frets', 'frets']);
		const first = layout.highways[0];
		const last = layout.highways[4];
		expect(first.left).toBeGreaterThan(0);
		expect(first.left).toBeCloseTo(DESIGN_WIDTH - (last.left + last.width));
		expect(first.width).toBeLessThan(155);
		const fretLane = first.width / first.lanes;
		// A gem is 32 design px across at noteScale 1.
		expect(32 * first.noteScale).toBeLessThan(fretLane);
		expect(first.noteScale).toBeGreaterThan(0.75);
	});

	it('places notes on the strikeline at their time and one look-ahead further up', () => {
		const layout = layoutStage(DESIGN_WIDTH * 2, DESIGN_HEIGHT * 2, ['frets']);
		expect(noteDistance(layout, 0)).toBe(strikeDistance(layout));
		expect(noteDistance(layout, LOOK_AHEAD_MS)).toBeLessThan(layout.planeLength);
		expect(noteDistance(layout, -100)).toBeLessThan(strikeDistance(layout));
		const {fromMs, toMs} = visibleWindow(10_000);
		expect(noteDistance(layout, fromMs - 10_000)).toBeCloseTo(0);
		expect(noteDistance(layout, toMs - 10_000)).toBeCloseTo(layout.planeLength);
	});

	it('maps lanes onto the surface', () => {
		const layout = layoutStage(DESIGN_WIDTH, DESIGN_HEIGHT, ['frets', 'drums']);
		const [frets, drums] = layout.highways;
		expect(laneCenterX(frets, 0)).toBeCloseTo(frets.left + 20.5);
		expect(laneCenterX(drums, 3)).toBeCloseTo(drums.left + 235 * (3.5 / 4));
		expect(surfaceLane('frets', 3)).toBe(3);
		expect(surfaceLane('drums', 0)).toBeNull();
		expect(surfaceLane('drums', 4)).toBe(3);
	});
});

describe('HighwayRenderer helpers', () => {
	const groups = [0, 500, 1_000, 20_000, 20_500].map((ms) => noteGroup(ms, [0]));

	it('finds the first group that can still be on screen, sustain tails included', () => {
		expect(firstVisibleGroup(groups, 20_100)).toBe(3);
		expect(firstVisibleGroup(groups, 0)).toBe(0);
		expect(firstVisibleGroup(groups, 100_000)).toBe(groups.length);
	});

	it('fades effects linearly after their moment', () => {
		expect(fadeAfter(1_000, 1_000, 200)).toBe(1);
		expect(fadeAfter(1_100, 1_000, 200)).toBe(0.5);
		expect(fadeAfter(1_200, 1_000, 200)).toBe(0);
		expect(fadeAfter(900, 1_000, 200)).toBe(0);
	});
});
