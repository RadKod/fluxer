// SPDX-License-Identifier: AGPL-3.0-or-later

import {noteGroup} from '@app/features/activities/band/engine/BandTestFixtures';
import {
	DESIGN_HEIGHT,
	DESIGN_WIDTH,
	type FocusLayout,
	type FocusRect,
	type HighwayKind,
	LOOK_AHEAD_MS,
	laneCenterX,
	layoutFocus,
	layoutStage,
	noteDistance,
	project,
	splitSides,
	strikeDistance,
	surfaceLane,
	toFrame,
	visibleWindow,
} from '@app/features/activities/band/game/HighwayGeometry';
import {fadeAfter, firstVisibleGroup, missShake} from '@app/features/activities/band/game/HighwayRenderer';
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

describe('layoutFocus', () => {
	const STAGE = {width: 1440, height: 880};
	const focus = (others: ReadonlyArray<HighwayKind>, mine: HighwayKind | null = 'frets', lyrics = false) =>
		layoutFocus(STAGE.width, STAGE.height, {mine, others, lyrics});
	const right = (rect: FocusRect) => rect.left + rect.width;
	const sideCounts = (layout: FocusLayout) =>
		Object.fromEntries(layout.sides.map((side) => [side.side, side.others.length]));

	it('splits the others between the sides, the extra one on the right (1 to 5 players)', () => {
		expect(splitSides(0)).toEqual({left: 0, right: 0});
		expect(splitSides(1)).toEqual({left: 0, right: 1});
		expect(splitSides(2)).toEqual({left: 1, right: 1});
		expect(splitSides(3)).toEqual({left: 1, right: 2});
		expect(splitSides(4)).toEqual({left: 2, right: 2});
		expect(focus([]).sides).toEqual([]);
		expect(sideCounts(focus(['drums']))).toEqual({right: 1});
		expect(sideCounts(focus(['drums', 'frets']))).toEqual({left: 1, right: 1});
		expect(sideCounts(focus(['drums', 'frets', 'frets']))).toEqual({left: 1, right: 2});
		expect(sideCounts(focus(['drums', 'frets', 'frets', 'frets']))).toEqual({left: 2, right: 2});
		expect(focus(['drums', 'frets', 'frets', 'frets']).sides.flatMap((side) => side.others)).toEqual([0, 1, 2, 3]);
	});

	it('makes my highway about 42% of a 1440 px stage, centred, the HUD right under it', () => {
		const layout = focus(['drums', 'frets']);
		expect(layout.scale).toBe(1);
		const mine = layout.main?.highways[0];
		expect(mine?.width).toBeCloseTo(1440 * 0.42);
		expect((mine?.left ?? 0) + (mine?.width ?? 0) / 2).toBeCloseTo(720);
		expect(layout.main?.originX).toBeCloseTo(720);
		expect(layout.hud?.left).toBeCloseTo(layout.mainRect.left);
		expect(layout.hud?.top).toBeGreaterThan(layout.mainRect.top + layout.mainRect.height);
		expect(mine?.noteScale).toBeGreaterThan(1);
	});

	it('moves my highway left with one other player, theirs on the right, bigger than in a full band', () => {
		const pair = focus(['frets']);
		const band = focus(['frets', 'drums', 'frets', 'frets']);
		expect(pair.mainRect.left + pair.mainRect.width / 2).toBeLessThan(720);
		expect(pair.sides).toHaveLength(1);
		expect(pair.sides[0]).toMatchObject({side: 'right', pair: true});
		const pairWidth = pair.sides[0].layout.highways[0].width;
		const bandWidth = band.sides[0].layout.highways[0].width;
		expect(pairWidth).toBeGreaterThan(bandWidth);
		expect(band.sides.every((side) => !side.pair)).toBe(true);
	});

	it('keeps every side highway clear of mine and inside the stage', () => {
		for (const others of [
			['frets'],
			['frets', 'drums'],
			['frets', 'drums', 'frets'],
			['frets', 'drums', 'frets', 'frets'],
		] as Array<Array<HighwayKind>>) {
			for (const width of [1100, 1440, 1920]) {
				const layout = layoutFocus(width, 880, {mine: 'frets', others, lyrics: false});
				const mainRight = right(layout.mainRect);
				expect(layout.sides.flatMap((side) => side.others)).toHaveLength(others.length);
				for (const side of layout.sides) {
					expect(side.rect.left).toBeGreaterThanOrEqual(0);
					expect(right(side.rect)).toBeLessThanOrEqual(layout.frameWidth);
					if (side.side === 'left') expect(right(side.rect)).toBeLessThan(layout.mainRect.left);
					else expect(side.rect.left).toBeGreaterThan(mainRight);
					for (const highway of side.layout.highways) {
						expect(highway.left).toBeGreaterThanOrEqual(0);
						expect(highway.left + highway.width).toBeLessThanOrEqual(side.layout.width + 0.001);
					}
				}
			}
		}
	});

	it('makes room for the lyrics when someone else sings, and puts the vocal lane in the middle for the singer', () => {
		const withLyrics = focus(['frets'], 'frets', true);
		expect(withLyrics.lyrics).not.toBeNull();
		expect(withLyrics.mainRect.top).toBeGreaterThan(focus(['frets']).mainRect.top);
		const singer = focus(['frets', 'drums', 'frets'], null, true);
		expect(singer.main).toBeNull();
		expect(singer.lyrics).toBeNull();
		expect(singer.vocalLane).not.toBeNull();
		expect((singer.vocalLane?.left ?? 0) + (singer.vocalLane?.width ?? 0) / 2).toBeCloseTo(720);
		expect(sideCounts(singer)).toEqual({left: 1, right: 2});
	});

	it('shows only my own highway in a tile or the mini window', () => {
		const mini = layoutFocus(400, 225, {mine: 'frets', others: ['drums', 'frets'], lyrics: true});
		expect(mini.compact).toBe(true);
		expect(mini.sides).toEqual([]);
		expect(mini.lyrics).toBeNull();
		expect(mini.hud).toBeNull();
		const mine = mini.main?.highways[0];
		expect(mine?.left).toBeGreaterThanOrEqual(0);
		expect((mine?.left ?? 0) + (mine?.width ?? 0)).toBeLessThanOrEqual(400);
	});

	it('scales a narrow stage down by width so the sides still fit', () => {
		const layout = layoutFocus(900, 880, {mine: 'frets', others: ['frets', 'drums'], lyrics: false});
		expect(layout.scale).toBeCloseTo(900 / 1100);
		expect(layout.sides).toHaveLength(2);
	});
});

describe('missShake', () => {
	it('wobbles a side highway for a moment after a miss, then settles', () => {
		expect(missShake(-1)).toBe(0);
		expect(missShake(0)).toBe(0);
		const wobble = [10, 30, 60, 100, 160].map(missShake);
		expect(wobble.some((offset) => offset > 0)).toBe(true);
		expect(wobble.some((offset) => offset < 0)).toBe(true);
		expect(wobble.every((offset) => Math.abs(offset) <= 7)).toBe(true);
		expect(Math.abs(missShake(300))).toBeLessThan(Math.abs(missShake(12)));
		expect(missShake(320)).toBe(0);
	});
});
