// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import {createRoomCameraRig, type RoomCameraRig} from '@app/features/voice_scene/scene/RoomCameraRig';
import {createTableGame3DHost} from '@app/features/voice_scene/scene/TableGame3DHost';
import type {TableParts} from '@app/features/voice_scene/scene/table/TableModelTypes';
import type {RoomLayout, TableScene3DInput} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {CAMERA_TWEEN_MS, CAMERA_ZOOM_SPEED, screenFocusPose} from '@app/features/voice_scene/utils/CameraLimits';
import type {SeatPose} from '@app/features/voice_scene/utils/SeatedView';
import {BoxGeometry, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry, Vector3} from 'three';
import {afterEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {staticCdnEndpoint: 'https://static.example'}}));
vi.mock('@fluxer/constants/src/VoiceRoomPartsManifest', () => ({VOICE_ROOM_PARTS_MANIFEST: null}));

const WIDTH = 1280;
const HEIGHT = 720;
const DEG = Math.PI / 180;
const FRAME_MS = 16;

// Gece Lounge's real camera (glTF axes): cam_home 26.5 m away at a 17.3° pitch, under OrbitControls' 20° cursor-zoom limit.
const layout: RoomLayout = {
	seats: [],
	stands: [],
	tables: [],
	camTarget: {x: -0.2607, y: 2.3444, z: -0.3929},
	camHome: {x: 13.7393, y: 10.2444, z: 20.7071},
	camPan: {x: 2, z: 1.5},
	screen: {center: {x: -4, y: 2.2, z: -6}, width: 2, height: 1.125, normal: {x: 0, y: 0, z: 1}},
};
const homeDistance = new Vector3(13.7393 + 0.2607, 10.2444 - 2.3444, 20.7071 + 0.3929).length();

// Gece Lounge T01 seat 1: the eye 0.10 m over the seat and 0.15 m back, the target 0.12 × top_size towards it.
const seatPose: SeatPose = {
	eye: {x: -3.7, y: 1.64, z: -1.88},
	target: {x: -3.7, y: 1.28, z: -2.974},
	fovDeg: 50,
};

const v = (p: {x: number; y: number; z: number}) => new Vector3(p.x, p.y, p.z);

function mount(roomLayout: RoomLayout = layout, pickedAt?: (x: number, y: number) => boolean) {
	const dom = document.createElement('div');
	dom.getBoundingClientRect = () =>
		({left: 0, top: 0, right: WIDTH, bottom: HEIGHT, width: WIDTH, height: HEIGHT, x: 0, y: 0}) as DOMRect;
	Object.defineProperty(dom, 'clientWidth', {value: WIDTH});
	Object.defineProperty(dom, 'clientHeight', {value: HEIGHT});
	document.body.appendChild(dom);
	const camera = new PerspectiveCamera(28, WIDTH / HEIGHT, 1, 200);
	const rig = createRoomCameraRig({camera, dom, layout: roomLayout, pickedAt});
	rig.setAspect(WIDTH / HEIGHT);
	const changes = vi.fn();
	rig.onChange(changes);
	let now = 10_000;
	// Drives update() at 60 Hz until it stops asking for frames; returns how long it kept asking.
	const settle = (): number => {
		const start = now;
		let busyUntil = 0;
		while (now - start < 5000) {
			const busy = rig.update(now);
			if (busy) busyUntil = now - start;
			now += FRAME_MS;
			if (!busy) break;
		}
		return busyUntil;
	};
	return {dom, camera, rig, changes, settle};
}

// The orbit target is where the view axis meets the cam_target height (the rig never moves it vertically).
function orbitTarget(camera: PerspectiveCamera): Vector3 {
	const forward = camera.getWorldDirection(new Vector3());
	return camera.position.clone().addScaledVector(forward, (layout.camTarget.y - camera.position.y) / forward.y);
}

function cursorPoint(camera: PerspectiveCamera, x: number, y: number): Vector3 {
	camera.updateMatrixWorld();
	const direction = new Vector3((x / WIDTH) * 2 - 1, -(y / HEIGHT) * 2 + 1, 0.5)
		.unproject(camera)
		.sub(camera.position)
		.normalize();
	return camera.position.clone().addScaledVector(direction, (layout.camTarget.y - camera.position.y) / direction.y);
}

function toScreen(camera: PerspectiveCamera, point: Vector3): [number, number] {
	camera.updateMatrixWorld();
	const ndc = point.clone().project(camera);
	return [((ndc.x + 1) / 2) * WIDTH, ((1 - ndc.y) / 2) * HEIGHT];
}

function wheel(dom: HTMLElement, deltaY: number, x = WIDTH / 2, y = HEIGHT / 2): void {
	const event = new WheelEvent('wheel', {deltaY, cancelable: true});
	// happy-dom's WheelEvent is a UIEvent; browsers inherit clientX/clientY from MouseEvent.
	Object.defineProperties(event, {clientX: {value: x}, clientY: {value: y}});
	dom.dispatchEvent(event);
}

function drag(
	dom: HTMLElement,
	dx: number,
	dy: number,
	from: [number, number] = [600, 300],
	pointerType = 'mouse',
): void {
	const at = {pointerId: 1, button: 0, pointerType, clientX: from[0], clientY: from[1], bubbles: true, isPrimary: true};
	dom.dispatchEvent(pointer('pointerdown', at));
	dom.dispatchEvent(pointer('pointermove', {...at, clientX: from[0] + dx, clientY: from[1] + dy}));
	dom.dispatchEvent(pointer('pointerup', {...at, clientX: from[0] + dx, clientY: from[1] + dy}));
}

// OrbitControls reads touches by pageX/pageY, which happy-dom does not derive from clientX/clientY.
function pointer(type: string, init: PointerEventInit & {clientX: number; clientY: number}): PointerEvent {
	const event = new PointerEvent(type, init);
	Object.defineProperties(event, {pageX: {value: init.clientX}, pageY: {value: init.clientY}});
	return event;
}

// A press and release on the spot at time `at` (ms), as a mouse click or a finger tap.
function tap(dom: HTMLElement, x: number, y: number, at: number, pointerType = 'mouse'): void {
	for (const type of ['pointerdown', 'pointerup']) {
		const event = pointer(type, {pointerId: 7, button: 0, pointerType, clientX: x, clientY: y, bubbles: true});
		Object.defineProperty(event, 'timeStamp', {value: at});
		dom.dispatchEvent(event);
	}
}

function expectLooksAt(camera: PerspectiveCamera, point: Vector3): void {
	const forward = camera.getWorldDirection(new Vector3());
	const wanted = point.clone().sub(camera.position).normalize();
	expect(forward.dot(wanted)).toBeCloseTo(1, 6);
}

let mounted: RoomCameraRig | null = null;
afterEach(() => {
	mounted?.dispose();
	mounted = null;
	document.body.replaceChildren();
});

// Spherical angles of the camera around the orbit target, in degrees (azimuth from cam_home, polar from +Y).
function orbitAngles(
	camera: PerspectiveCamera,
	rig: RoomCameraRig,
): {azimuth: number; polar: number; distance: number} {
	const offset = camera.position.clone().sub(orbitTarget(camera));
	return {
		azimuth: rig.azimuthFromHome() / DEG,
		polar: Math.acos(offset.y / offset.length()) / DEG,
		distance: offset.length(),
	};
}
const homePolar = Math.acos((10.2444 - 2.3444) / homeDistance) / DEG;
// 120 px of drag turns the orbit 30° (rotateSpeed 0.5: 2π × px / height × 0.5).
const PX_PER_30_DEG = 120;

describe('RoomCameraRig orbit', () => {
	it('a room with wall groups orbits all the way round', () => {
		const {dom, camera, rig, settle} = mount();
		mounted = rig;
		// Twelve 30° turns to the right come back to cam_home, with no stop on the way.
		for (let step = 1; step <= 12; step++) {
			drag(dom, PX_PER_30_DEG, 0);
			settle();
			const wanted = ((((-30 * step + 180) % 360) + 360) % 360) - 180;
			const azimuth = orbitAngles(camera, rig).azimuth;
			expect(Math.abs(((azimuth - wanted + 540) % 360) - 180)).toBeLessThan(1e-3);
			expect(orbitAngles(camera, rig).polar).toBeCloseTo(homePolar, 4);
		}
		// Looking down: from 85° (polar 5°) to level (polar 90°).
		drag(dom, 0, 4000);
		settle();
		expect(orbitAngles(camera, rig).polar).toBeCloseTo(5, 4);
		drag(dom, 0, -8000);
		settle();
		expect(orbitAngles(camera, rig).polar).toBeCloseTo(90, 4);
	});

	it('the wheel comes from cam_home to 0.08 × home in about 20 notches, or to the room’s zoom_min', () => {
		for (const [roomLayout, closest] of [
			[layout, 0.08],
			[{...layout, camZoomMin: 0.14}, 0.14],
		] as const) {
			const {dom, camera, rig, settle} = mount(roomLayout);
			let notches = 0;
			while (orbitAngles(camera, rig).distance > closest * homeDistance + 1e-6 && notches < 100) {
				wheel(dom, -100);
				settle();
				notches++;
			}
			if (closest === 0.08) {
				expect(notches).toBeGreaterThanOrEqual(19);
				expect(notches).toBeLessThanOrEqual(21);
			}
			for (let i = 0; i < 10; i++) wheel(dom, -100);
			settle();
			expect(orbitAngles(camera, rig).distance).toBeCloseTo(closest * homeDistance, 6);
			// Resting against the closest distance is idle.
			for (let i = 0; i < 5; i++) expect(rig.update(80_000 + i * FRAME_MS)).toBe(false);
			rig.dispose();
			document.body.replaceChildren();
		}
	});

	it('the TV focus works from every horizontal angle and gives the orbit pose back', () => {
		const {dom, camera, rig, settle} = mount();
		mounted = rig;
		const pose = screenFocusPose(layout.screen!, WIDTH / HEIGHT);
		for (let step = 0; step < 12; step++) {
			drag(dom, PX_PER_30_DEG, 0);
			settle();
			const position = camera.position.clone();
			rig.focusScreen();
			expect(settle()).toBeLessThanOrEqual(CAMERA_TWEEN_MS);
			expect(rig.mode()).toBe('focus');
			expect(camera.position.distanceTo(v(pose.position))).toBeLessThan(1e-6);
			expectLooksAt(camera, v(pose.target));
			rig.exitToOrbit();
			settle();
			expect(camera.position.distanceTo(position)).toBeLessThan(1e-6);
		}
	});

	it('two fingers on the orbit dolly by their spread, exponent 1 (the wheel step is separate) (F-cam 7)', () => {
		const {dom, camera, rig, settle} = mount();
		mounted = rig;
		const before = orbitAngles(camera, rig).distance;
		const finger = (type: string, id: number, x: number) =>
			dom.dispatchEvent(
				pointer(type, {pointerId: id, button: 0, pointerType: 'touch', clientX: x, clientY: 400, bubbles: true}),
			);
		finger('pointerdown', 31, 540);
		finger('pointerdown', 32, 740);
		finger('pointermove', 32, 840);
		finger('pointerup', 32, 840);
		finger('pointerup', 31, 540);
		settle();
		// 200 → 300 px apart: the camera comes to 2/3 of its distance.
		expect(orbitAngles(camera, rig).distance).toBeCloseTo(before * (200 / 300), 6);
		// The wheel keeps its 20-notch step.
		const at = orbitAngles(camera, rig).distance;
		wheel(dom, -100);
		settle();
		expect(orbitAngles(camera, rig).distance).toBeCloseTo(at * 0.95 ** CAMERA_ZOOM_SPEED, 6);
	});

	it('a wheel notch on a near TV goes into its focus (D3); far off it only zooms', () => {
		// The TV at the end of a room looking +Z, cam_target in front of it: the orbit can come close.
		const tvLayout: RoomLayout = {
			...layout,
			camTarget: {x: 0, y: 2.2, z: -2},
			camHome: {x: 0, y: 9, z: 24},
			camPan: {x: 1, z: 3},
			screen: {center: {x: 0, y: 2.2, z: -5.4}, width: 2, height: 1.125, normal: {x: 0, y: 0, z: 1}, viewDeg: 55},
		};
		const {dom, camera, rig, settle} = mount(tvLayout);
		mounted = rig;
		const tvAt = () => toScreen(camera, v(tvLayout.screen!.center));
		// From cam_home the TV is far: a notch on it zooms.
		wheel(dom, -100, ...tvAt());
		settle();
		expect(rig.mode()).toBe('orbit');
		// Notch by notch towards the TV until it takes over: the TV focus pose.
		let notches = 0;
		while (rig.mode() === 'orbit' && notches < 40) {
			wheel(dom, -100, ...tvAt());
			settle();
			notches++;
		}
		expect(rig.mode()).toBe('focus');
		settle();
		const pose = screenFocusPose(tvLayout.screen!, WIDTH / HEIGHT);
		expect(camera.position.distanceTo(v(pose.position))).toBeLessThan(1e-6);
		// The whole quad in frame, ≥ 60 % of the width.
		const left = toScreen(camera, new Vector3(-1, 2.2, -5.4));
		const right = toScreen(camera, new Vector3(1, 2.2, -5.4));
		expect((right[0] - left[0]) / WIDTH).toBeGreaterThanOrEqual(0.6);
		expect(left[0]).toBeGreaterThanOrEqual(0);
		expect(right[0]).toBeLessThanOrEqual(WIDTH);
		// Off the TV, a notch only zooms.
		rig.exitToOrbit();
		settle();
		wheel(dom, -100, 40, 700);
		settle();
		expect(rig.mode()).toBe('orbit');
	});
});

// The way the camera looks, in degrees: yaw = atan2(x, z) of the view direction (larger = turned left), pitch up.
function lookOf(camera: PerspectiveCamera): {yaw: number; pitch: number} {
	const d = camera.getWorldDirection(new Vector3());
	return {yaw: Math.atan2(d.x, d.z) / DEG, pitch: Math.asin(d.y) / DEG};
}
const wrapDeg = (deg: number): number => ((((deg + 180) % 360) + 360) % 360) - 180;
const seatLook = (() => {
	const d = v(seatPose.target).sub(v(seatPose.eye)).normalize();
	return {yaw: Math.atan2(d.x, d.z) / DEG, pitch: Math.asin(d.y) / DEG};
})();

describe('RoomCameraRig seat view', () => {
	it('a seated drag turns the view around a fixed eye within ±100° / +30° −25°', () => {
		const {dom, camera, rig, settle} = mount();
		mounted = rig;
		rig.enterSeat(seatPose);
		expect(settle()).toBeLessThanOrEqual(CAMERA_TWEEN_MS);
		expect(camera.position.distanceTo(v(seatPose.eye))).toBeLessThan(1e-9);
		expect(camera.fov).toBeCloseTo(seatPose.fovDeg, 6);
		// The view follows the cursor, 1:1 at the seat's own angle: 100 px of drag turns it fov × 100 / height degrees.
		drag(dom, 100, 0);
		settle();
		expect(wrapDeg(lookOf(camera).yaw - seatLook.yaw)).toBeCloseTo((seatPose.fovDeg * 100) / HEIGHT, 4);
		for (const [dx, dy, yaw, pitch] of [
			[4000, 0, 100, null],
			[-8000, 0, -100, null],
			[0, 4000, null, 30],
			[0, -8000, null, -25],
		] as const) {
			drag(dom, dx, dy);
			settle();
			const look = lookOf(camera);
			if (yaw !== null) expect(wrapDeg(look.yaw - seatLook.yaw)).toBeCloseTo(yaw, 4);
			if (pitch !== null) expect(look.pitch - seatLook.pitch).toBeCloseTo(pitch, 4);
			expect(camera.position.distanceTo(v(seatPose.eye))).toBeLessThan(1e-9);
		}
		// Settled: no frame is asked for.
		for (let i = 0; i < 5; i++) expect(rig.update(50_000 + i * FRAME_MS)).toBe(false);
	});

	it('a seated wheel narrows the view toward the cursor down to 0.4×', () => {
		const {dom, camera, rig, settle} = mount();
		mounted = rig;
		rig.enterSeat(seatPose);
		settle();
		const base = camera.fov;
		const [cx, cy] = [900, 260];
		const ray = new Vector3((cx / WIDTH) * 2 - 1, -(cy / HEIGHT) * 2 + 1, 0.5).unproject(camera).sub(camera.position);
		const point = camera.position.clone().add(ray.normalize().multiplyScalar(2));
		wheel(dom, -100, cx, cy);
		settle();
		expect(camera.fov).toBeCloseTo(base * 0.95 ** CAMERA_ZOOM_SPEED, 6);
		const [x, y] = toScreen(camera, point);
		expect(Math.hypot(x - cx, y - cy)).toBeLessThan(0.5);
		expect(camera.position.distanceTo(v(seatPose.eye))).toBeLessThan(1e-9);
		// DOM drawn over the view grows with it.
		expect(rig.zoomScale()).toBeCloseTo(Math.tan((base * DEG) / 2) / Math.tan((camera.fov * DEG) / 2), 9);
		for (let i = 0; i < 30; i++) {
			wheel(dom, -100);
			settle();
			expect(camera.fov).toBeGreaterThanOrEqual(0.4 * base - 1e-9);
		}
		expect(camera.fov).toBeCloseTo(0.4 * base, 6);
		for (let i = 0; i < 30; i++) {
			wheel(dom, 100);
			settle();
			expect(camera.fov).toBeLessThanOrEqual(base + 1e-9);
		}
		expect(camera.fov).toBeCloseTo(base, 6);
		expect(rig.zoomScale()).toBeCloseTo(1, 9);
		expect(camera.position.distanceTo(v(seatPose.eye))).toBeLessThan(1e-9);
		for (let i = 0; i < 5; i++) expect(rig.update(60_000 + i * FRAME_MS)).toBe(false);
	});

	it('a double click on empty space returns the seated view', () => {
		const picked = vi.fn(() => false);
		const {dom, camera, rig, settle} = mount(layout, picked);
		mounted = rig;
		rig.enterSeat(seatPose);
		settle();
		const turnAway = () => {
			drag(dom, 300, 80);
			wheel(dom, -100, 700, 300);
			wheel(dom, -100, 700, 300);
			settle();
			expect(camera.fov).toBeLessThan(seatPose.fovDeg - 1);
		};
		turnAway();
		const away = lookOf(camera);
		// A single click, two clicks far apart in time or place, or a double click on a piece keep the look.
		tap(dom, 500, 400, 1000);
		tap(dom, 500, 400, 1600);
		tap(dom, 700, 400, 1700);
		picked.mockReturnValue(true);
		tap(dom, 500, 400, 3000);
		tap(dom, 500, 400, 3150);
		settle();
		expect(picked).toHaveBeenCalledWith(500, 400);
		expect(lookOf(camera).yaw).toBeCloseTo(away.yaw, 9);
		expect(lookOf(camera).pitch).toBeCloseTo(away.pitch, 9);
		picked.mockReturnValue(false);
		tap(dom, 500, 400, 5000);
		tap(dom, 503, 401, 5200);
		expect(rig.tweening()).toBe(true);
		expect(settle()).toBeLessThanOrEqual(CAMERA_TWEEN_MS);
		expect(rig.mode()).toBe('seat');
		expectLooksAt(camera, v(seatPose.target));
		expect(camera.fov).toBeCloseTo(seatPose.fovDeg, 6);
		expect(camera.position.distanceTo(v(seatPose.eye))).toBeLessThan(1e-9);
		// Looking and narrowing work again afterwards.
		turnAway();
	});

	it('one finger looks, two fingers narrow the view, a double tap returns (touch, D9)', () => {
		const {dom, camera, rig, settle} = mount();
		mounted = rig;
		rig.enterSeat(seatPose);
		settle();
		drag(dom, 100, 0, [600, 300], 'touch');
		settle();
		expect(wrapDeg(lookOf(camera).yaw - seatLook.yaw)).toBeCloseTo((seatPose.fovDeg * 100) / HEIGHT, 4);
		// Two fingers 200 px apart spread to 300 px: the view narrows to 2/3 of its angle.
		const finger = (type: string, id: number, x: number) =>
			dom.dispatchEvent(
				pointer(type, {pointerId: id, button: 0, pointerType: 'touch', clientX: x, clientY: 400, bubbles: true}),
			);
		finger('pointerdown', 11, 500);
		finger('pointerdown', 12, 700);
		finger('pointermove', 12, 800);
		expect(camera.fov).toBeCloseTo(seatPose.fovDeg * (2 / 3), 6);
		finger('pointerup', 12, 800);
		finger('pointerup', 11, 500);
		settle();
		expect(camera.position.distanceTo(v(seatPose.eye))).toBeLessThan(1e-9);
		// Lifting two fingers is no double tap; a real one returns.
		expect(rig.tweening()).toBe(false);
		tap(dom, 640, 360, 9000, 'touch');
		tap(dom, 640, 360, 9200, 'touch');
		settle();
		expectLooksAt(camera, v(seatPose.target));
		expect(camera.fov).toBeCloseTo(seatPose.fovDeg, 6);
	});

	it('a press on a piece still drags the piece; on a drop target or the felt it turns the look (D9)', async () => {
		const center = {x: 2, y: 0.8, z: -1};
		const tableLayout: RoomLayout = {
			...layout,
			tables: [{slot: 'T01', center, topSize: 1.3}],
			seats: [1, 2, 3, 4].map((position) => {
				const angle = ((position - 1) * Math.PI) / 2;
				return {
					name: `seat_T01_${position}`,
					group: 'T01',
					position: {x: center.x + 1.08 * Math.sin(angle), y: 1.1, z: center.z + 1.08 * Math.cos(angle)},
					table: {slot: 'T01', position: position as 1 | 2 | 3 | 4},
					watch: null,
				};
			}),
		};
		const host = {current: null as ReturnType<typeof createTableGame3DHost> | null};
		const {dom, camera, rig, settle} = mount(tableLayout, (x, y) => host.current?.hits(x, y) ?? false);
		mounted = rig;
		rig.enterSeat({eye: {x: 2, y: 1.2, z: 0.25}, target: {x: 2, y: 0.8, z: -0.9}, fovDeg: 55});
		settle();
		// One piece near my edge and a drop target on the far half (root-local; the anchor sits on the table centre).
		const piece = new Mesh(new BoxGeometry(0.06, 0.06, 0.06), new MeshBasicMaterial());
		piece.position.set(0, 0.03, 0.3);
		piece.userData.source = {kind: 'square', square: 'e2'};
		const zone = new Mesh(new PlaneGeometry(0.2, 0.2), new MeshBasicMaterial({visible: false}));
		zone.rotation.x = -Math.PI / 2;
		zone.position.set(0, 0.001, -0.25);
		zone.userData.target = {kind: 'square', square: 'e7'};
		const root = new Group();
		root.add(piece, zone);
		const model = {
			root,
			update() {},
			pickables: () => [piece],
			dropZones: () => [zone],
			animating: () => false,
			dispose() {},
		};
		host.current = createTableGame3DHost({
			parent: new Group(),
			camera,
			dom,
			layout: tableLayout,
			slot: 'T01',
			game: 'chess',
			factoryFor: () => () => model,
			parts: Promise.resolve({} as TableParts),
			requestRender() {},
		});
		const handler = {canDrag: vi.fn(() => true), onDragStart: vi.fn(), onDrop: vi.fn(), onSelect: vi.fn()};
		host.current.setDragHandler(handler);
		host.current.update({
			view: {summary: {game: 'chess'}, game_view: {game: 'chess'}},
			perspective: 1,
			rack: [],
			stage: null,
			pendingTavla: [],
			selection: null,
			targets: [],
			interactive: true,
		} as unknown as TableScene3DInput);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const onPiece = toScreen(camera, new Vector3(center.x, center.y + 0.03, center.z + 0.3));
		const onZone = toScreen(camera, new Vector3(center.x, center.y + 0.001, center.z - 0.25));
		expect(host.current.hits(...onPiece)).toBe(true);
		expect(host.current.hits(...onZone)).toBe(false);
		const before = lookOf(camera);
		drag(dom, 60, -120, onPiece);
		settle();
		expect(handler.onDragStart).toHaveBeenCalledTimes(1);
		expect(handler.onDrop).toHaveBeenCalledTimes(1);
		expect(lookOf(camera).yaw).toBeCloseTo(before.yaw, 9);
		expect(lookOf(camera).pitch).toBeCloseTo(before.pitch, 9);
		drag(dom, 80, 0, onZone);
		settle();
		expect(handler.onDragStart).toHaveBeenCalledTimes(1);
		expect(wrapDeg(lookOf(camera).yaw - before.yaw)).toBeCloseTo((55 * 80) / HEIGHT, 4);
		drag(dom, -80, 0, [100, 650]);
		settle();
		expect(wrapDeg(lookOf(camera).yaw - before.yaw)).toBeCloseTo(0, 4);
		host.current.dispose();
	});

	it('a pinch never moves the gaze: only the view narrows, about the fingers (F-cam 2)', () => {
		const {dom, camera, rig, settle} = mount();
		mounted = rig;
		rig.enterSeat(seatPose);
		settle();
		const finger = (type: string, id: number, x: number) =>
			dom.dispatchEvent(
				pointer(type, {pointerId: id, button: 0, pointerType: 'touch', clientX: x, clientY: 400, bubbles: true}),
			);
		// One finger stays at 500, the other moves 700 → 800: the point under the fingers' new midpoint (650, 400) stays
		// there and the view narrows to 2/3; the controls' turn would have jumped it by the midpoint's offset.
		const ray = new Vector3((650 / WIDTH) * 2 - 1, -(400 / HEIGHT) * 2 + 1, 0.5).unproject(camera).sub(camera.position);
		const point = camera.position.clone().add(ray.normalize().multiplyScalar(2));
		finger('pointerdown', 21, 500);
		finger('pointerdown', 22, 700);
		finger('pointermove', 22, 800);
		settle();
		expect(camera.fov).toBeCloseTo(seatPose.fovDeg * (200 / 300), 6);
		const [x, y] = toScreen(camera, point);
		expect(Math.hypot(x - 650, y - 400)).toBeLessThan(0.5);
		finger('pointerup', 22, 800);
		finger('pointerup', 21, 500);
		settle();
		expect(camera.position.distanceTo(v(seatPose.eye))).toBeLessThan(1e-9);
		const [x2, y2] = toScreen(camera, point);
		expect(Math.hypot(x2 - 650, y2 - 400)).toBeLessThan(0.5);
	});

	it('the seated wheel is the rig’s own: the page never scrolls or zooms with it, a trackpad pinch counts ×10 (F-cam 3)', () => {
		const {dom, camera, rig, settle} = mount();
		mounted = rig;
		rig.enterSeat(seatPose);
		settle();
		const notch = (deltaY: number, ctrlKey = false) => {
			const event = new WheelEvent('wheel', {deltaY, cancelable: true});
			// happy-dom's WheelEvent takes neither ctrlKey nor the mouse position from its init.
			Object.defineProperties(event, {clientX: {value: 640}, clientY: {value: 360}, ctrlKey: {value: ctrlKey}});
			dom.dispatchEvent(event);
			settle();
			return event.defaultPrevented;
		};
		expect(notch(-100)).toBe(true);
		const afterNotch = camera.fov;
		expect(afterNotch).toBeCloseTo(seatPose.fovDeg * 0.95 ** CAMERA_ZOOM_SPEED, 6);
		// A trackpad pinch arrives as a ctrl wheel of a tenth the travel: the same step.
		expect(notch(-10, true)).toBe(true);
		expect(camera.fov).toBeCloseTo(afterNotch * 0.95 ** CAMERA_ZOOM_SPEED, 6);
	});

	it('a re-pose of the same seat (a resize, the game changing) keeps the look and the zoom (F-cam 6)', () => {
		const {dom, camera, rig, settle} = mount();
		mounted = rig;
		rig.enterSeat(seatPose);
		settle();
		drag(dom, 200, 60);
		wheel(dom, -100, 640, 360);
		wheel(dom, -100, 640, 360);
		settle();
		const look = lookOf(camera);
		const zoomed = camera.fov / seatPose.fovDeg;
		expect(zoomed).toBeLessThan(0.95);
		// Same seat, same framing (a resize re-enters with it): nothing moves, no tween.
		rig.enterSeat(seatPose, true);
		expect(rig.tweening()).toBe(false);
		expect(lookOf(camera).yaw).toBeCloseTo(look.yaw, 9);
		expect(lookOf(camera).pitch).toBeCloseTo(look.pitch, 9);
		expect(camera.fov / seatPose.fovDeg).toBeCloseTo(zoomed, 9);
		// The game changes (okey → a board game): the eye glides 10 cm nearer and the pose's own look tilts further down;
		// the viewer's turn from the old pose's look carries over onto the new one, and the zoom stays.
		const nearer = {
			...seatPose,
			eye: {...seatPose.eye, z: seatPose.eye.z - 0.1},
			target: {...seatPose.target, y: seatPose.target.y - 0.2},
			fovDeg: 54,
		};
		const lookAt = (pose: SeatPose) => {
			const d = v(pose.target).sub(v(pose.eye)).normalize();
			return {yaw: Math.atan2(d.x, d.z) / DEG, pitch: Math.asin(d.y) / DEG};
		};
		const turn = {yaw: wrapDeg(look.yaw - lookAt(seatPose).yaw), pitch: look.pitch - lookAt(seatPose).pitch};
		rig.enterSeat(nearer, true);
		expect(rig.tweening()).toBe(true);
		expect(settle()).toBeLessThanOrEqual(CAMERA_TWEEN_MS);
		expect(camera.position.distanceTo(v(nearer.eye))).toBeLessThan(1e-9);
		expect(wrapDeg(lookOf(camera).yaw - lookAt(nearer).yaw)).toBeCloseTo(turn.yaw, 6);
		expect(lookOf(camera).pitch - lookAt(nearer).pitch).toBeCloseTo(turn.pitch, 6);
		expect(camera.fov / nearer.fovDeg).toBeCloseTo(zoomed, 6);
		// Looking on from there keeps the new pose's window and the eye.
		drag(dom, 50, 0);
		settle();
		expect(camera.position.distanceTo(v(nearer.eye))).toBeLessThan(1e-9);
		// Another seat starts from that seat's own look.
		rig.enterSeat({...seatPose, eye: {x: -2.6, y: 1.68, z: -3.13}, target: {x: -3.6, y: 1.28, z: -3.13}}, false);
		settle();
		expectLooksAt(camera, new Vector3(-3.6, 1.28, -3.13));
		expect(camera.fov).toBeCloseTo(seatPose.fovDeg, 6);
	});

	it('a viewer who never turned arrives at the new pose’s own look when the game changes', () => {
		const {camera, rig, settle} = mount();
		mounted = rig;
		rig.enterSeat(seatPose);
		settle();
		const chess = {
			...seatPose,
			eye: {...seatPose.eye, z: seatPose.eye.z - 0.1},
			target: {x: -3.6, y: 1.1, z: -3.1},
			fovDeg: 52,
		};
		rig.enterSeat(chess, true);
		settle();
		expect(camera.position.distanceTo(v(chess.eye))).toBeLessThan(1e-9);
		expectLooksAt(camera, v(chess.target));
		expect(camera.fov).toBeCloseTo(chess.fovDeg, 6);
	});

	it('one board game to another (chess → tavla → dama) keeps the eye and glides the look and the angle (CAM3 1)', () => {
		const {camera, rig, settle} = mount();
		mounted = rig;
		// Every board game puts the eye at the same spot (SEAT_EYE_BACK_BOARD_M); only its look and angle differ.
		const chess = {...seatPose, eye: {...seatPose.eye, z: seatPose.eye.z - 0.1}, target: {x: -3.7, y: 1.1, z: -3.1}};
		rig.enterSeat(chess);
		settle();
		const tavla = {...chess, target: {x: -3.7, y: 1.2, z: -3.05}};
		rig.enterSeat(tavla, true);
		expect(rig.tweening()).toBe(true);
		expect(settle()).toBeLessThanOrEqual(CAMERA_TWEEN_MS);
		expect(camera.position.distanceTo(v(chess.eye))).toBeLessThan(1e-9);
		expectLooksAt(camera, v(tavla.target));
		const dama = {...tavla, fovDeg: tavla.fovDeg + 4};
		rig.enterSeat(dama, true);
		expect(rig.tweening()).toBe(true);
		settle();
		expectLooksAt(camera, v(dama.target));
		expect(camera.fov).toBeCloseTo(dama.fovDeg, 6);
	});

	it('every wheel on the canvas is the rig’s: in a tween and on the TV the page never scrolls either (item 3)', () => {
		const {dom, rig, settle} = mount();
		mounted = rig;
		const notch = () => {
			const event = new WheelEvent('wheel', {deltaY: -100, cancelable: true});
			Object.defineProperties(event, {clientX: {value: 640}, clientY: {value: 360}});
			dom.dispatchEvent(event);
			return event.defaultPrevented;
		};
		rig.focusScreen();
		expect(rig.tweening()).toBe(true);
		expect(notch()).toBe(true);
		settle();
		expect(rig.mode()).toBe('focus');
		expect(notch()).toBe(true);
		rig.exitToOrbit();
		settle();
		expect(notch()).toBe(true);
	});

	it('every press sets the dolly step: a finger 1, a mouse (its middle button too) the wheel’s (item 4)', () => {
		const {dom, camera, rig, settle} = mount();
		mounted = rig;
		const finger = (type: string, id: number, x: number) =>
			dom.dispatchEvent(
				pointer(type, {pointerId: id, button: 0, pointerType: 'touch', clientX: x, clientY: 400, bubbles: true}),
			);
		finger('pointerdown', 41, 540);
		finger('pointerdown', 42, 740);
		finger('pointermove', 42, 840);
		finger('pointerup', 42, 840);
		finger('pointerup', 41, 540);
		settle();
		// A middle-button drag 100 px down dollies out by OrbitControls' wheel step, not the finger's.
		const before = orbitAngles(camera, rig).distance;
		const at = {pointerId: 43, button: 1, pointerType: 'mouse', clientX: 600, clientY: 300, bubbles: true};
		dom.dispatchEvent(pointer('pointerdown', at));
		dom.dispatchEvent(pointer('pointermove', {...at, clientY: 400}));
		dom.dispatchEvent(pointer('pointerup', {...at, clientY: 400}));
		settle();
		expect(orbitAngles(camera, rig).distance).toBeCloseTo(before / 0.95 ** CAMERA_ZOOM_SPEED, 6);
	});

	it('one view change per wheel notch, and only the main button double-clicks back (CR7, CR8)', () => {
		const {dom, camera, rig, changes, settle} = mount();
		mounted = rig;
		rig.enterSeat(seatPose);
		settle();
		changes.mockClear();
		wheel(dom, -100, 900, 300);
		expect(changes).toHaveBeenCalledTimes(1);
		settle();
		drag(dom, 200, 0);
		settle();
		const away = lookOf(camera);
		// A right-button double click (a context menu attempt) keeps the look.
		for (const at of [1000, 1150]) {
			for (const type of ['pointerdown', 'pointerup']) {
				const event = pointer(type, {
					pointerId: 9,
					button: 2,
					pointerType: 'mouse',
					clientX: 500,
					clientY: 400,
					bubbles: true,
				});
				Object.defineProperty(event, 'timeStamp', {value: at});
				dom.dispatchEvent(event);
			}
		}
		settle();
		expect(rig.tweening()).toBe(false);
		expect(lookOf(camera).yaw).toBeCloseTo(away.yaw, 9);
	});

	it('the listener turns with a seated look (D10)', () => {
		const {dom, camera, rig, settle} = mount();
		mounted = rig;
		drag(dom, 100, 0);
		settle();
		const orbiting = rig.azimuthFromHome();
		rig.enterSeat(seatPose);
		settle();
		// Facing the table: the eye → target line, measured from cam_home like the orbit.
		const offset = v(seatPose.eye).sub(v(seatPose.target));
		const home = Math.atan2(layout.camHome.x - layout.camTarget.x, layout.camHome.z - layout.camTarget.z);
		const facing = wrapDeg((Math.atan2(offset.x, offset.z) - home) / DEG);
		expect(wrapDeg(rig.azimuthFromHome() / DEG)).toBeCloseTo(facing, 6);
		// Turning the look 25° left turns the listener 25° the same way.
		drag(dom, (25 / seatPose.fovDeg) * HEIGHT, 0);
		settle();
		expect(wrapDeg(rig.azimuthFromHome() / DEG - facing)).toBeCloseTo(25, 4);
		expect(camera.position.distanceTo(v(seatPose.eye))).toBeLessThan(1e-9);
		rig.exitToOrbit();
		settle();
		expect(rig.azimuthFromHome()).toBeCloseTo(orbiting, 6);
	});
});

describe('RoomCameraRig', () => {
	it('focusScreen tweens in ≤ 450 ms then stops requesting frames', () => {
		const {camera, rig, changes, settle} = mount();
		mounted = rig;
		rig.focusScreen();
		expect(rig.mode()).toBe('focus');
		expect(changes).toHaveBeenCalled();
		const busy = settle();
		expect(busy).toBeGreaterThan(0);
		expect(busy).toBeLessThanOrEqual(CAMERA_TWEEN_MS);
		const pose = screenFocusPose(layout.screen!, WIDTH / HEIGHT);
		expect(camera.position.distanceTo(v(pose.position))).toBeLessThan(1e-6);
		expectLooksAt(camera, v(pose.target));
		changes.mockClear();
		for (let i = 0; i < 10; i++) expect(rig.update(20_000 + i * FRAME_MS)).toBe(false);
		expect(changes).not.toHaveBeenCalled();
		expect(rig.mode()).toBe('focus');
	});

	it('exitToOrbit restores the previous orbit pose', () => {
		const {dom, camera, rig, settle} = mount();
		mounted = rig;
		drag(dom, 120, 20);
		wheel(dom, -300, 900, 450);
		settle();
		const position = camera.position.clone();
		const target = orbitTarget(camera);
		rig.focusScreen();
		settle();
		rig.exitToOrbit();
		expect(rig.mode()).toBe('orbit');
		const busy = settle();
		expect(busy).toBeLessThanOrEqual(CAMERA_TWEEN_MS + FRAME_MS);
		expect(camera.position.distanceTo(position)).toBeLessThan(1e-6);
		expectLooksAt(camera, target);
		// Orbiting works again afterwards.
		drag(dom, -60, 0);
		settle();
		expect(camera.position.distanceTo(position)).toBeGreaterThan(0.1);
	});

	it('wheel out in focus exits focus', () => {
		const {dom, camera, rig, settle} = mount();
		mounted = rig;
		const home = camera.position.clone();
		rig.focusScreen();
		settle();
		wheel(dom, -100);
		expect(rig.mode()).toBe('focus');
		wheel(dom, 100);
		expect(rig.mode()).toBe('orbit');
		settle();
		expect(camera.position.distanceTo(home)).toBeLessThan(1e-6);
	});

	it('seat view keeps the vertical angle within 35°–64° and the horizontal within 100°', () => {
		const {camera, rig, settle} = mount();
		mounted = rig;
		const horizontal = () => (2 * Math.atan(Math.tan((camera.fov * DEG) / 2) * camera.aspect)) / DEG;
		for (const [asked, held] of [
			[70, 64],
			[30, 35],
			[50, 50],
		] as const) {
			rig.enterSeat({...seatPose, fovDeg: asked});
			settle();
			expect(camera.fov).toBeCloseTo(held, 6);
		}
		// Wide boxes narrow the vertical angle so the horizontal stays ≤ 100°; a resize applies without re-entering.
		rig.setAspect(21 / 9);
		expect(camera.fov).toBeCloseTo(50, 6);
		expect(horizontal()).toBeLessThanOrEqual(100);
		for (const aspect of [32 / 9, 4]) {
			rig.setAspect(aspect);
			expect(horizontal()).toBeCloseTo(100, 6);
		}
		rig.setAspect(WIDTH / HEIGHT);
		expect(camera.fov).toBeCloseTo(50, 6);
		expect(rig.update(70_000)).toBe(false);
	});

	it('no frame requests while idle', () => {
		const {dom, rig, changes, settle} = mount();
		mounted = rig;
		for (let i = 0; i < 10; i++) expect(rig.update(1000 + i * FRAME_MS)).toBe(false);
		expect(changes).not.toHaveBeenCalled();
		drag(dom, 80, 0);
		expect(changes).toHaveBeenCalled();
		// Damping settles, then the rig goes quiet again.
		expect(settle()).toBeGreaterThan(0);
		changes.mockClear();
		for (let i = 0; i < 10; i++) expect(rig.update(90_000 + i * FRAME_MS)).toBe(false);
		expect(changes).not.toHaveBeenCalled();
	});

	it('wheel zoom keeps the cursor point under the cursor, the target in the pan box and the distance ≥ 0.08 × home', () => {
		const {dom, camera, rig, settle} = mount();
		mounted = rig;
		const point = cursorPoint(camera, 900, 450);
		const before = orbitTarget(camera);
		wheel(dom, -100, 900, 450);
		const [x, y] = toScreen(camera, point);
		expect(Math.hypot(x - 900, y - 450)).toBeLessThan(0.5);
		const after = orbitTarget(camera);
		expect(after.y).toBeCloseTo(layout.camTarget.y, 9);
		expect(after.distanceTo(point)).toBeLessThan(before.distanceTo(point));
		expect(camera.position.distanceTo(after)).toBeLessThan(homeDistance);
		// Deep zoom towards every corner and back out: never past 0.08 × home, the target never leaves the box.
		for (const [cx, cy] of [
			[20, 20],
			[1260, 20],
			[1260, 700],
			[20, 700],
			[640, 360],
		] as const) {
			for (let i = 0; i < 40; i++) {
				wheel(dom, i < 30 ? -120 : 120, cx, cy);
				settle();
				const target = orbitTarget(camera);
				const distance = camera.position.distanceTo(target);
				expect(distance).toBeGreaterThanOrEqual(0.08 * homeDistance - 1e-6);
				expect(distance).toBeLessThanOrEqual(homeDistance + 1e-6);
				expect(Math.abs(target.x - layout.camTarget.x)).toBeLessThanOrEqual(layout.camPan.x + 1e-6);
				expect(Math.abs(target.z - layout.camTarget.z)).toBeLessThanOrEqual(layout.camPan.z + 1e-6);
				expect(target.y).toBeCloseTo(layout.camTarget.y, 6);
			}
		}
	});

	it('no pan box: wheel zoom only dollies towards cam_target', () => {
		const {dom, camera, rig, settle} = mount({...layout, camPan: {x: 0, z: 0}});
		mounted = rig;
		for (let i = 0; i < 30; i++) {
			wheel(dom, -120, 1200, 650);
			settle();
			expect(orbitTarget(camera).distanceTo(v(layout.camTarget))).toBeLessThan(1e-6);
		}
		expect(camera.position.distanceTo(v(layout.camTarget))).toBeCloseTo(0.08 * homeDistance, 6);
	});

	it('resting against the closest distance stays idle even where the clamp lands an ulp off (Ş7)', () => {
		// Gece Lounge at 0.25 × home: OrbitControls re-clamps the recomputed radius on every update and calls it a zoom.
		const {dom, rig, changes, settle} = mount({...layout, camZoomMin: 0.25});
		mounted = rig;
		for (let i = 0; i < 40; i++) wheel(dom, -120);
		settle();
		changes.mockClear();
		for (let i = 0; i < 10; i++) expect(rig.update(70_000 + i * FRAME_MS)).toBe(false);
		expect(changes).not.toHaveBeenCalled();
	});

	it('near plane follows the distance: deep zoom and the seat view do not clip', () => {
		const {dom, camera, rig, settle} = mount();
		mounted = rig;
		expect(camera.near).toBe(1);
		expect(camera.far).toBeCloseTo(3 * homeDistance);
		for (let i = 0; i < 40; i++) wheel(dom, -120);
		settle();
		expect(camera.near).toBeCloseTo(0.04 * 0.08 * homeDistance, 6);
		// Resting at the closest distance is idle too.
		for (let i = 0; i < 5; i++) expect(rig.update(60_000 + i * FRAME_MS)).toBe(false);
		rig.enterSeat(seatPose);
		settle();
		expect(camera.near).toBe(0.05);
	});
});
