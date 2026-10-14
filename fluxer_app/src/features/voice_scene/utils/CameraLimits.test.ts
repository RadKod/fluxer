// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	azimuthFromHome,
	CAMERA_TWEEN_MS,
	CAMERA_ZOOM_SPEED,
	cameraLimits,
	clampTargetToPanBox,
	cutawayHidden,
	fovFor,
	nearFarFor,
	rayHitsScreen,
	SCREEN_FOCUS_MARGIN,
	screenFocusPose,
	screenInView,
} from '@app/features/voice_scene/utils/CameraLimits';
import {describe, expect, it} from 'vitest';

const at = (x: number, y: number, z: number) => ({x, y, z});
const DEG = Math.PI / 180;

describe('cameraLimits', () => {
	// cam_home straight south of the target at 45° elevation: azimuth 0, distance 10√2.
	const limits = cameraLimits(at(0, 10, 10), at(0, 0, 0));

	it('turns all the way round, looks down 0°–85° and comes to 0.08 × home, or the room’s zoom_min', () => {
		expect(limits.homeAzimuth).toBeCloseTo(0);
		expect(limits.minAzimuth).toBe(-Infinity);
		expect(limits.maxAzimuth).toBe(Infinity);
		expect(limits.minPolar).toBeCloseTo(5 * DEG);
		expect(limits.maxPolar).toBeCloseTo(90 * DEG);
		expect(limits.minDistance).toBeCloseTo(0.08 * 10 * Math.SQRT2);
		expect(limits.maxDistance).toBeCloseTo(10 * Math.SQRT2);
		expect(cameraLimits(at(0, 10, 10), at(0, 0, 0), 0.1469).minDistance).toBeCloseTo(0.1469 * 10 * Math.SQRT2);
		// A home on the -Z side: azimuth π, the same window.
		expect(cameraLimits(at(0, 5, -10), at(0, 0, 0)).homeAzimuth).toBeCloseTo(Math.PI);
	});

	it('the wheel takes about 20 notches from cam_home to 0.08 × home', () => {
		// OrbitControls scales the distance by 0.95^zoomSpeed per 100 px notch.
		const notches = Math.log(0.08) / (CAMERA_ZOOM_SPEED * Math.log(0.95));
		expect(notches).toBeGreaterThanOrEqual(19);
		expect(notches).toBeLessThanOrEqual(21);
	});

	it('camera azimuth is 0 at cam_home, keeps the OrbitControls sign and wraps across ±π', () => {
		expect(azimuthFromHome(0.3, 0)).toBeCloseTo(0.3);
		expect(azimuthFromHome(-0.3, 0)).toBeCloseTo(-0.3);
		expect(azimuthFromHome(-0.9 * Math.PI, Math.PI)).toBeCloseTo(0.1 * Math.PI);
		expect(azimuthFromHome(0.9 * Math.PI, -Math.PI)).toBeCloseTo(-0.1 * Math.PI);
	});
});

describe('clampTargetToPanBox (cam_target pan_x / pan_z)', () => {
	const camTarget = at(-0.26, 2.34, -0.39);

	it('target stays inside the pan box at every zoom', () => {
		const pan = {x: 1.5, z: 0.8};
		// Whatever a cursor zoom asks for (inside, on the edge, far outside, above or below): x/z land in the box, y never moves.
		for (let i = -12; i <= 12; i++) {
			for (let j = -12; j <= 12; j++) {
				const asked = at(camTarget.x + i * 0.4, camTarget.y + (i - j) * 0.3, camTarget.z + j * 0.25);
				const clamped = clampTargetToPanBox(asked, camTarget, pan);
				expect(Math.abs(clamped.x - camTarget.x)).toBeLessThanOrEqual(pan.x + 1e-9);
				expect(Math.abs(clamped.z - camTarget.z)).toBeLessThanOrEqual(pan.z + 1e-9);
				expect(clamped.y).toBe(camTarget.y);
				if (Math.abs(asked.x - camTarget.x) <= pan.x) expect(clamped.x).toBe(asked.x);
				if (Math.abs(asked.z - camTarget.z) <= pan.z) expect(clamped.z).toBe(asked.z);
			}
		}
	});

	it('no pan box → target fixed (zoom only)', () => {
		for (const asked of [at(3, 1, -2), at(-0.26, 9, -0.39), camTarget]) {
			expect(clampTargetToPanBox(asked, camTarget, {x: 0, z: 0})).toEqual(camTarget);
		}
	});
});

describe('screenFocusPose (TV focus)', () => {
	const screen = {center: at(2, 1.6, -4), width: 1.6, height: 0.9, normal: at(0, 0, 1)};
	const halfTan = (deg: number) => Math.tan((deg * DEG) / 2);

	it('screen focus pose fills the width with 8% margin at 16:9 and 4:3', () => {
		expect(SCREEN_FOCUS_MARGIN).toBe(1.08);
		for (const aspect of [16 / 9, 4 / 3]) {
			const pose = screenFocusPose(screen, aspect);
			expect(pose.target).toEqual(screen.center);
			expect(pose.position.x).toBeCloseTo(screen.center.x);
			expect(pose.position.y).toBeCloseTo(screen.center.y);
			const d = pose.position.z - screen.center.z;
			// The screen's half width seen from d, with the margin, is exactly the horizontal half view at this aspect.
			const horizontalHalfTan = halfTan(fovFor(aspect)) * aspect;
			expect(((screen.width / 2 / d) * SCREEN_FOCUS_MARGIN) / horizontalHalfTan).toBeCloseTo(1, 6);
			expect((screen.height / 2 / d) * SCREEN_FOCUS_MARGIN).toBeLessThanOrEqual(halfTan(fovFor(aspect)) + 1e-9);
		}
		// Contract rev 3: d = (width / 2) / tan(horizontal / 2) × 1.08, horizontal from the vertical 28° at 16:9 (≈ 48.0°).
		const d169 = screenFocusPose(screen, 16 / 9).position.z - screen.center.z;
		expect(d169).toBeCloseTo((0.8 / (halfTan(28) * (16 / 9))) * 1.08, 6);
	});

	it('fits width and height at 21:9 and 1.88:1  (d = max(d width, d height) × 1.08)', () => {
		const d169 = screenFocusPose(screen, 16 / 9).position.z - screen.center.z;
		for (const aspect of [21 / 9, 1.88]) {
			const d = screenFocusPose(screen, aspect).position.z - screen.center.z;
			const verticalHalfTan = halfTan(fovFor(aspect));
			const widthShare = ((screen.width / 2 / d) * SCREEN_FOCUS_MARGIN) / (verticalHalfTan * aspect);
			const heightShare = ((screen.height / 2 / d) * SCREEN_FOCUS_MARGIN) / verticalHalfTan;
			// Both edges inside with the margin; the binding one (height on a box wider than the 16:9 screen) exactly at it.
			expect(widthShare).toBeLessThanOrEqual(1 + 1e-9);
			expect(heightShare).toBeCloseTo(1, 6);
			// A 16:9 screen never needs more room in front of it than the contract's d (dogrula checks d + 0.3 m).
			expect(d).toBeCloseTo(d169, 6);
		}
	});

	it('a turned screen gets the pose in front of it', () => {
		const d169 = screenFocusPose(screen, 16 / 9).position.z - screen.center.z;
		const east = {...screen, normal: at(-1, 0, 0)};
		const pose = screenFocusPose(east, 16 / 9);
		expect(pose.position.x).toBeCloseTo(screen.center.x - d169);
		expect(pose.position.y).toBeCloseTo(screen.center.y);
		expect(pose.position.z).toBeCloseTo(screen.center.z);
		expect(screenInView(east, pose.position)).toBe(true);
	});
});

describe('nearFarFor', () => {
	it('near plane follows distance (0.05..1 m), far 3 × home', () => {
		expect(nearFarFor(0.8, 26.5)).toEqual({near: 0.05, far: 3 * 26.5});
		expect(nearFarFor(10, 26.5).near).toBeCloseTo(0.4);
		expect(nearFarFor(26.5, 26.5).near).toBe(1);
		expect(nearFarFor(0, 26.5).near).toBe(0.05);
		expect(nearFarFor(10, 31.5).far).toBeCloseTo(94.5);
	});
});

describe('fovFor', () => {
	it('keeps 28° at 16:9 and wider, and widens the vertical angle on narrower boxes to keep the 16:9 width', () => {
		expect(fovFor(16 / 9)).toBeCloseTo(28);
		expect(fovFor(21 / 9)).toBeCloseTo(28);
		expect(Math.tan((fovFor(4 / 3) * DEG) / 2) * (4 / 3)).toBeCloseTo(Math.tan(14 * DEG) * (16 / 9));
	});

	it('the camera tween is at most 450 ms (Ş7)', () => {
		expect(CAMERA_TWEEN_MS).toBeLessThanOrEqual(450);
	});
});

describe('screenInView (the TV cone)', () => {
	const screen = {center: at(0, 2, -5), width: 1.6, height: 0.9, normal: at(0, 0, 1), viewDeg: 55};
	// A camera this far out from the screen, this many degrees across its normal and up from its centre.
	const from = (acrossDeg: number, upDeg: number, distance = 4) =>
		at(
			distance * Math.cos(upDeg * DEG) * Math.sin(acrossDeg * DEG),
			2 + distance * Math.sin(upDeg * DEG),
			-5 + distance * Math.cos(upDeg * DEG) * Math.cos(acrossDeg * DEG),
		);

	it('screen element shown inside ±55° across and −10°…+45° up', () => {
		for (const [across, up] of [
			[0, 0],
			[54, 0],
			[-54, 0],
			[0, 44],
			[0, -9],
			[40, 30],
		])
			expect(screenInView(screen, from(across!, up!)), `${across} ${up}`).toBe(true);
	});

	it('screen element hidden outside the cone, from behind and level with its plane', () => {
		for (const [across, up] of [
			[56, 0],
			[-56, 0],
			[0, 46],
			[0, -11],
			[90, 0],
			[180, 0],
			[130, 20],
		])
			expect(screenInView(screen, from(across!, up!)), `${across} ${up}`).toBe(false);
		// Straight above or below the centre: no direction across, never in view.
		expect(screenInView(screen, at(0, 9, -5))).toBe(false);
	});

	it('seated, the cone reaches 40° down (a seat sits low under a wall TV); across it stays ±θ (F-cam 1)', () => {
		expect(screenInView(screen, from(0, -30), true)).toBe(true);
		expect(screenInView(screen, from(0, -30))).toBe(false);
		expect(screenInView(screen, from(0, -39), true)).toBe(true);
		expect(screenInView(screen, from(0, -41), true)).toBe(false);
		expect(screenInView(screen, from(56, -20), true)).toBe(false);
		expect(screenInView(screen, from(0, 44), true)).toBe(true);
	});

	it('a room may narrow the cone with tv_view_deg; without it the cone is 55°', () => {
		expect(screenInView({...screen, viewDeg: 30}, from(31, 0))).toBe(false);
		expect(screenInView({...screen, viewDeg: 30}, from(29, 0))).toBe(true);
		const {viewDeg: _omitted, ...plain} = screen;
		expect(screenInView(plain, from(54, 0))).toBe(true);
		expect(screenInView(plain, from(56, 0))).toBe(false);
	});
});

describe('rayHitsScreen (D3)', () => {
	const screen = {center: at(0, 2, -5), width: 1.6, height: 0.9, normal: at(0, 0, 1)};
	const towards = (from: {x: number; y: number; z: number}, to: {x: number; y: number; z: number}) => {
		const d = at(to.x - from.x, to.y - from.y, to.z - from.z);
		const n = Math.hypot(d.x, d.y, d.z);
		return at(d.x / n, d.y / n, d.z / n);
	};

	it('a ray from in front meets the quad inside its edges only', () => {
		const eye = at(1, 2.5, 0);
		for (const point of [at(0, 2, -5), at(0.79, 2.44, -5), at(-0.79, 1.56, -5)])
			expect(rayHitsScreen(screen, eye, towards(eye, point))).toBe(true);
		for (const point of [at(0.81, 2, -5), at(0, 2.46, -5), at(0, 1.54, -5)])
			expect(rayHitsScreen(screen, eye, towards(eye, point))).toBe(false);
	});

	it('a ray from behind, away from the quad or along it never meets it', () => {
		const behind = at(0, 2, -9);
		expect(rayHitsScreen(screen, behind, towards(behind, at(0, 2, -5)))).toBe(false);
		expect(rayHitsScreen(screen, at(0, 2, 0), at(0, 0, 1))).toBe(false);
		expect(rayHitsScreen(screen, at(0, 2, 0), at(1, 0, 0))).toBe(false);
	});
});

describe('cutawayHidden (rev 4 K2)', () => {
	// A 10 × 8 m room, 3 m high: north wall at z = -4, east at x = 5, south at z = 4, west at x = -5.
	const cutaway = {
		walls: [
			{name: 'wall_N', point: {x: 0, z: -4}, normal: {x: 0, z: -1}},
			{name: 'wall_E', point: {x: 5, z: 0}, normal: {x: 1, z: 0}},
			{name: 'wall_S', point: {x: 0, z: 4}, normal: {x: 0, z: 1}},
			{name: 'wall_W', point: {x: -5, z: 0}, normal: {x: -1, z: 0}},
		],
		ceiling: {name: 'ceiling', y: 3},
	};

	it('a wall group hides only while the camera is beyond its plane or within 0.75 m of it (D4)', () => {
		// Well inside (deep zoom): nothing hides, at any height under the ceiling.
		for (const camera of [at(0, 1.2, 0), at(4.2, 2.9, 3.2), at(-4.2, 0.1, -3.2)])
			expect(cutawayHidden(cutaway, camera).walls).toEqual([false, false, false, false]);
		// The band: 0.74 m from the east wall it already hides, 0.76 m it does not.
		expect(cutawayHidden(cutaway, at(4.26, 1, 0)).walls).toEqual([false, true, false, false]);
		expect(cutawayHidden(cutaway, at(4.24, 1, 0)).walls).toEqual([false, false, false, false]);
		expect(cutawayHidden(cutaway, at(0, 10, 20)).walls).toEqual([false, false, true, false]);
		expect(cutawayHidden(cutaway, at(14, 10, 20)).walls).toEqual([false, true, true, false]);
		expect(cutawayHidden(cutaway, at(-14, 10, -20)).walls).toEqual([true, false, false, true]);
	});

	it('the ceiling hides once the camera comes within 0.75 m under it, as dogrula rev 4.1 does (D4)', () => {
		expect(cutawayHidden(cutaway, at(0, 2.24, 0)).ceiling).toBe(false);
		expect(cutawayHidden(cutaway, at(0, 2.26, 20)).ceiling).toBe(true);
		expect(cutawayHidden(cutaway, at(0, 3.01, 0)).ceiling).toBe(true);
		expect(cutawayHidden(cutaway, at(14, 10, 20)).ceiling).toBe(true);
	});
});
