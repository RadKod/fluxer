// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	BAR_BLACK,
	BAR_WHITE,
	TAVLA_BOARD_SIZE_M,
	TAVLA_STACK_VISIBLE,
	type TavlaBoardSource,
	tavlaBoardGeometry,
	tavlaBoardYaw,
	tavlaDiceRest,
	tavlaLayout,
	tavlaStacks,
} from '@app/features/voice_scene/scene/table/tavlaLayout';
import type {Vec3} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {SEAT_PIECE_SIZE_M, SEAT_READABILITY_PROBES} from '@app/features/voice_scene/utils/SeatedView';
import type {TavlaView} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {describe, expect, it} from 'vitest';

// masa-parcalari.glb rev 2 (sha 64ffffe2f754), measured from the file: tavla_board 0.60 × 0.44 m, tp_* on the
// playing surface (y 0.012), points 0.04 m apart, checker 35 × 7.5 mm.
function glbPoint(point: number): Vec3 {
	const near = point <= 12;
	const k = near ? point : 25 - point; // 1..12 along one edge, from the +X end
	const x = k <= 6 ? 0.246 - 0.04 * (k - 1) : -0.046 - 0.04 * (k - 7);
	return {x, y: 0.012, z: near ? 0.188 : -0.188};
}
const GLB: TavlaBoardSource = {
	boardMin: {x: -0.3, y: 0, z: -0.22},
	boardMax: {x: 0.3, y: 0.026, z: 0.22},
	points: Array.from({length: 24}, (_, index) => glbPoint(index + 1)),
	bar: {white: {x: 0, y: 0.012, z: 0.07}, black: {x: 0, y: 0.012, z: -0.07}},
	off: {white: {x: 0.28, y: 0.018, z: 0.115}, black: {x: -0.28, y: 0.018, z: -0.115}},
	checker: {diameter: 0.035, height: 0.0075},
};

function startPoints(): Array<number> {
	const points = new Array<number>(24).fill(0);
	for (const [point, count] of [
		[24, 2],
		[13, 5],
		[8, 3],
		[6, 5],
	] as const) {
		points[point - 1] = count;
		points[24 - point] = -count;
	}
	return points;
}

function tavla(overrides: Partial<TavlaView> = {}): TavlaView {
	return {
		game: 'tavla',
		white: 1,
		points: startPoints(),
		bar: {white: 0, black: 0},
		off: {white: 0, black: 0},
		turn: 1,
		dice: [6, 5],
		opening: null,
		deadline_at: null,
		last_moves: [],
		legal_moves: null,
		...overrides,
	};
}

const g = tavlaBoardGeometry(GLB);
// The board's half depth after normalising: a borne-off row stays on its own half.
const TAVLA_HALF_DEPTH = TAVLA_BOARD_SIZE_M.z / 2;
const R = g.checker.diameter / 2;
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const onPoint = (layout: ReturnType<typeof tavlaLayout>, point: number) =>
	layout.checkers.filter(
		(checker) =>
			near(checker.position.x, g.points[point - 1]!.x) &&
			Math.sign(checker.position.z) === Math.sign(g.points[point - 1]!.z),
	);

describe('tavlaLayout', () => {
	it('checkers stack from the point base towards the centre line, 5 visible then a count badge', () => {
		const points = new Array<number>(24).fill(0);
		points[5] = 7; // white on 6, near edge
		points[18] = -5; // black on 19, far edge, the same x as 6
		points[0] = 3; // white on 1
		const layout = tavlaLayout(g, tavlaStacks(tavla({points, bar: {white: 0, black: 0}}), []), true);

		const six = onPoint(layout, 6);
		expect(six).toHaveLength(TAVLA_STACK_VISIBLE);
		const base = g.points[5]!;
		expect(six[0]!.position.z).toBeCloseTo(base.z - R, 9); // the first touches the base
		for (let i = 1; i < six.length; i++) {
			const step = six[i - 1]!.position.z - six[i]!.position.z;
			expect(step).toBeGreaterThan(0); // towards the centre line
			expect(step).toBeLessThanOrEqual(g.checker.diameter + 1e-12);
			expect(six[i]!.position.y).toBeGreaterThan(six[i - 1]!.position.y); // overlaps step up, never z-fight
		}
		// The fifth stays short of the centre line, so the far stack of the same x never touches it.
		const nineteen = onPoint(layout, 19);
		expect(nineteen).toHaveLength(5);
		expect(nineteen[0]!.position.z).toBeCloseTo(g.points[18]!.z + R, 9);
		expect(six.at(-1)!.position.z - R).toBeGreaterThan(0);
		expect(nineteen.at(-1)!.position.z + R).toBeLessThan(0);
		expect(onPoint(layout, 1).every((checker) => checker.white && !checker.ghost)).toBe(true);

		expect(layout.badges).toEqual([{position: expect.objectContaining({x: base.x}), count: 7}]);
		expect(layout.badges[0]!.position.y).toBeGreaterThan(six.at(-1)!.position.y + g.checker.height);
		expect(layout.badges[0]!.position.z).toBeCloseTo(six.at(-1)!.position.z, 9);
	});

	it('bar and off trays', () => {
		const points = new Array<number>(24).fill(0);
		points[5] = 10; // + 2 on the bar + 3 off = 15 white
		points[18] = -11; // + 4 on the bar = 15 black
		const view = tavla({points, bar: {white: 2, black: 4}, off: {white: 3, black: 0}});
		const layout = tavlaLayout(g, tavlaStacks(view, []), true);

		const onBar = (white: boolean) =>
			layout.checkers.filter((checker) => checker.white === white && near(checker.position.x, 0));
		const whiteBar = onBar(true);
		expect(whiteBar.map((checker) => checker.position.z)).toEqual([
			expect.closeTo(g.bar.white.z + R, 9),
			expect.closeTo(g.bar.white.z + R + g.checker.diameter, 9),
		]); // outwards, towards white's own edge
		const blackBar = onBar(false);
		expect(blackBar).toHaveLength(3);
		expect(blackBar.every((checker) => checker.position.z < g.bar.black.z)).toBe(true);
		expect(layout.badges).toContainEqual({position: expect.objectContaining({x: 0}), count: 4});

		const off = layout.checkers.filter((checker) => checker.standing);
		expect(off).toHaveLength(3);
		for (const checker of off) {
			expect(checker.white).toBe(true);
			expect(checker.position.x).toBeCloseTo(g.off.white.x, 9);
			expect(checker.position.z).toBeGreaterThan(0);
			expect(checker.position.z).toBeLessThan(TAVLA_HALF_DEPTH);
		}
		// Only my own bar can be picked up.
		const barSources = layout.pickables.filter(
			(pickable) => pickable.source.kind === 'tavla_point' && pickable.source.point === 'bar',
		);
		expect(barSources.map((pickable) => pickable.spot)).toEqual([BAR_WHITE]);
		const asBlack = tavlaLayout(g, tavlaStacks(view, []), false);
		expect(
			asBlack.pickables
				.filter((pickable) => pickable.source.kind === 'tavla_point' && pickable.source.point === 'bar')
				.map((p) => p.spot),
		).toEqual([BAR_BLACK]);
	});

	it('pending local steps move ghosts, not the server state', () => {
		const view = tavla();
		const before = structuredClone(view);
		const stacks = tavlaStacks(view, [
			{from: 24, to: 18},
			{from: 18, to: 13},
		]);
		const layout = tavlaLayout(g, stacks, true);
		expect(view).toEqual(before);
		expect(stacks.flat().filter((checker) => !checker.ghost)).toHaveLength(29);
		const ghosts = layout.checkers.filter((checker) => checker.ghost);
		expect(ghosts).toHaveLength(1);
		const thirteen = onPoint(layout, 13);
		expect(thirteen.at(-1)).toEqual(ghosts[0]); // on top of 13 (now 6: badge), never hidden under it
		expect(layout.badges).toContainEqual({position: expect.objectContaining({x: g.points[12]!.x}), count: 6});
		expect(onPoint(layout, 24)).toHaveLength(1);
		expect(onPoint(layout, 18)).toHaveLength(0);
		expect(layout.checkers.filter((checker) => !checker.ghost)).toHaveLength(28); // one of 13's six under the badge

		// A pending hit: the black blot shows as a ghost on black's bar.
		const points = startPoints();
		points[17] = -1;
		points[18] = -4;
		const hit = tavlaLayout(g, tavlaStacks(tavla({points}), [{from: 24, to: 18}]), true);
		const hitGhosts = hit.checkers.filter((checker) => checker.ghost);
		expect(hitGhosts).toHaveLength(2);
		expect(hitGhosts.find((checker) => !checker.white)!.position.x).toBeCloseTo(0, 9);
		expect(onPoint(hit, 18)).toEqual([expect.objectContaining({white: true, ghost: true})]);
		// Not my turn → pending steps are ignored.
		expect(
			tavlaLayout(g, tavlaStacks(tavla({turn: null}), [{from: 24, to: 18}]), true).checkers.some((c) => c.ghost),
		).toBe(false);
	});

	it('drop zones: 24 points + off', () => {
		const layout = tavlaLayout(g, tavlaStacks(null, []), true);
		expect(layout.zones).toHaveLength(25);
		const points = layout.zones.flatMap((zone) => (zone.target.kind === 'tavla_point' ? [zone.target.point] : []));
		expect(points.sort((a, b) => a - b)).toEqual(Array.from({length: 24}, (_, index) => index + 1));
		for (const zone of layout.zones) {
			if (zone.target.kind !== 'tavla_point') continue;
			const base = g.points[zone.target.point - 1]!;
			expect(zone.center.x).toBeCloseTo(base.x, 9);
			expect(zone.center.z).toBeCloseTo(base.z / 2, 9); // from the base to the centre line
			expect(zone.depth).toBeCloseTo(Math.abs(base.z), 9);
			expect(zone.width).toBeCloseTo(g.pointWidth, 9);
		}
		const off = layout.zones.find((zone) => zone.target.kind === 'tavla_off')!;
		expect(off.center).toEqual(expect.objectContaining({x: g.off.white.x, z: g.off.white.z}));
		const blackOff = tavlaLayout(g, tavlaStacks(null, []), false).zones.find(
			(zone) => zone.target.kind === 'tavla_off',
		)!;
		expect(blackOff.center).toEqual(expect.objectContaining({x: g.off.black.x, z: g.off.black.z}));
		// Empty board: nothing to pick up, nothing drawn.
		expect(layout.checkers).toEqual([]);
		expect(layout.pickables).toEqual([]);
	});

	it("far checkers and dice stay inside SeatedView's probe boxes (R2.d)", () => {
		// the board fills 0.80 × 0.587 m (was 0.62 × 0.46), ≥ 0.25 m inside a 1.3 m table's edge.
		expect(TAVLA_BOARD_SIZE_M).toEqual({x: 0.8, z: 0.5867});
		expect((1.3 - TAVLA_BOARD_SIZE_M.x) / 2).toBeGreaterThanOrEqual(0.25);
		expect(0.6 * g.scale).toBeLessThanOrEqual(TAVLA_BOARD_SIZE_M.x + 1e-9);
		expect(0.44 * g.scale).toBeLessThanOrEqual(TAVLA_BOARD_SIZE_M.z + 1e-9);
		expect(Math.max(0.6 * g.scale - TAVLA_BOARD_SIZE_M.x, 0.44 * g.scale - TAVLA_BOARD_SIZE_M.z)).toBeCloseTo(0, 9);
		// Checkers grow with the board (SEAT_PIECE_SIZE_M the floor) and still fit their point.
		expect(g.checker.diameter).toBeCloseTo(Math.max(SEAT_PIECE_SIZE_M.tavlaChecker, 0.035 * g.scale), 9);
		expect(g.checker.diameter).toBeGreaterThan(SEAT_PIECE_SIZE_M.tavlaChecker);
		expect(g.checker.diameter).toBeLessThanOrEqual(g.pointWidth);
		expect(g.checker.height).toBeCloseTo(0.0075 * (g.checker.diameter / 0.035), 9);
		const probe = SEAT_READABILITY_PROBES.tavlaFarPoint;
		const inside = (geometry: typeof g) => {
			for (const base of geometry.points) {
				expect(Math.abs(base.x)).toBeLessThanOrEqual(probe.x + 1e-9);
				expect(Math.abs(base.z) - R).toBeLessThanOrEqual(Math.abs(probe.z) + 1e-9);
			}
		};
		inside(g);
		// A wider board file shrinks until its far points fit the probes too.
		inside(tavlaBoardGeometry({...GLB, points: GLB.points.map((p) => ({...p, x: p.x * 1.2, z: p.z * 1.15}))}));

		const die = SEAT_READABILITY_PROBES.tavlaDie;
		for (const white of [true, false]) {
			const rest = tavlaDiceRest(g, white);
			for (const spot of rest) {
				expect(Math.abs(spot.x)).toBeLessThanOrEqual(die.x + 1e-9);
				expect(spot.z).toBe(die.z);
				expect(spot.y).toBeCloseTo(g.points[0]!.y + SEAT_PIECE_SIZE_M.tavlaDie / 2, 9);
			}
			expect(Math.abs(rest[0].x - rest[1].x)).toBeGreaterThan(SEAT_PIECE_SIZE_M.tavlaDie); // dice never overlap
			expect(Math.sign(rest[0].x)).toBe(white ? 1 : -1); // the mover's right half
		}
	});

	it("the board turns so white's edge faces white's seat", () => {
		expect(tavlaBoardYaw(1, 1)).toBe(0);
		expect(tavlaBoardYaw(3, 3)).toBe(0);
		expect(tavlaBoardYaw(1, 3)).toBe(Math.PI);
		expect(tavlaBoardYaw(3, 1)).toBe(Math.PI);
		expect(tavlaBoardYaw(null, 3)).toBe(0); // lobby
		expect(tavlaBoardYaw(1, 2)).toBe(0); // a watcher at the side keeps the long side across
	});
});
