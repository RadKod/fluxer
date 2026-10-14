// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import {createScreenLayer} from '@app/features/voice_scene/scene/ScreenLayer';
import type {RoomLayout} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {PerspectiveCamera, Vector3} from 'three';
import {afterEach, describe, expect, it} from 'vitest';

const screen = {center: {x: 1, y: 1.6, z: -4}, width: 1.6, height: 0.9, normal: {x: 0, y: 0, z: 1}};
const layout: RoomLayout = {
	seats: [],
	stands: [],
	tables: [],
	camTarget: {x: 0, y: 1, z: 0},
	camHome: {x: 0, y: 8, z: 20},
	camPan: {x: 0, z: 0},
	screen,
};
const size = {width: 1280, height: 720};

function cameraAt(position: [number, number, number], lookAt: [number, number, number]): PerspectiveCamera {
	const camera = new PerspectiveCamera(28, size.width / size.height, 0.05, 100);
	camera.position.set(...position);
	camera.lookAt(...lookAt);
	camera.updateMatrixWorld();
	return camera;
}

// The quad's corners TL, TR, BR, BL projected to CSS px, computed independently of the layer.
function projectedCorners(camera: PerspectiveCamera): Array<[number, number]> {
	return [
		[-1, 1],
		[1, 1],
		[1, -1],
		[-1, -1],
	].map(([sx, sy]) => {
		const ndc = new Vector3(
			screen.center.x + (sx! * screen.width) / 2,
			screen.center.y + (sy! * screen.height) / 2,
			screen.center.z,
		).project(camera);
		return [((ndc.x + 1) / 2) * size.width, ((1 - ndc.y) / 2) * size.height];
	});
}

// Applies a CSS matrix3d (column-major) to an element-local point (transform-origin 0 0).
function applyMatrix3d(transform: string, x: number, y: number): [number, number] {
	const m = /^matrix3d\((.*)\)$/.exec(transform)![1]!.split(',').map(Number);
	const w = m[3]! * x + m[7]! * y + m[15]!;
	return [(m[0]! * x + m[4]! * y + m[12]!) / w, (m[1]! * x + m[5]! * y + m[13]!) / w];
}

function mount(roomLayout: RoomLayout = layout) {
	const container = document.createElement('div');
	document.body.appendChild(container);
	const canvas = document.createElement('canvas');
	document.body.appendChild(canvas);
	const layer = createScreenLayer({container, layout: roomLayout, wheelTarget: canvas});
	const element = document.createElement('div');
	layer.attach(element);
	const holder = element.parentElement as HTMLElement;
	return {container, canvas, layer, element, holder};
}

afterEach(() => {
	document.body.replaceChildren();
});

describe('ScreenLayer (matrix3d homography instead of CSS3DRenderer)', () => {
	it('matrix3d maps the element corners onto the four projected screen corners (≤ 1 px)', () => {
		const {holder, layer} = mount();
		// Oblique, from the right and above, near enough that perspective foreshortening is strong.
		for (const camera of [cameraAt([3, 2.5, -1.5], [1, 1.6, -4]), cameraAt([-0.5, 1.2, -2.2], [1.2, 1.7, -4])]) {
			layer.update(camera, size);
			expect(holder.style.display).not.toBe('none');
			expect(holder.style.transformOrigin).toBe('0 0');
			const width = Number.parseFloat(holder.style.width);
			const height = Number.parseFloat(holder.style.height);
			expect(height / width).toBeCloseTo(screen.height / screen.width);
			const mapped = [applyMatrix3d(holder.style.transform, 0, 0), applyMatrix3d(holder.style.transform, width, 0)];
			mapped.push(
				applyMatrix3d(holder.style.transform, width, height),
				applyMatrix3d(holder.style.transform, 0, height),
			);
			const expected = projectedCorners(camera);
			for (let i = 0; i < 4; i++) {
				expect(Math.hypot(mapped[i]![0] - expected[i]![0], mapped[i]![1] - expected[i]![1])).toBeLessThanOrEqual(1);
			}
		}
	});

	it('hidden when any corner is behind the camera or the screen faces away', () => {
		const {holder, layer} = mount();
		layer.update(cameraAt([1, 1.6, -9], [1, 1.6, -4]), size);
		expect(holder.style.display).toBe('none');
		// 10 cm in front of the quad, beside its middle, looking along it: the left corners are behind the camera.
		layer.update(cameraAt([1.3, 1.6, -3.9], [5, 1.6, -3.9]), size);
		expect(holder.style.display).toBe('none');
		layer.update(cameraAt([1, 1.8, 1], [1, 1.6, -4]), size);
		expect(holder.style.display).not.toBe('none');
	});

	it('the TV layer hides and ignores clicks from behind (rev 4: the orbit goes all the way round)', () => {
		const {holder, layer} = mount();
		// Twelve orbit positions 20 m out around the room centre, 20° up: shown (and clickable) only inside the cone.
		for (let step = 0; step < 12; step++) {
			const azimuth = (step * Math.PI) / 6;
			const position: [number, number, number] = [20 * Math.sin(azimuth), 8, 20 * Math.cos(azimuth)];
			layer.update(cameraAt(position, [0, 1, 0]), size);
			const across = Math.atan2(Math.abs(position[0] - screen.center.x), position[2] - screen.center.z);
			const inCone = position[2] > screen.center.z && across <= (55 * Math.PI) / 180;
			expect(holder.style.display === 'none', `step ${step}`).toBe(!inCone);
			if (inCone) expect(holder.style.pointerEvents).toBe('auto');
		}
		// Level with the quad's plane counts as behind; display none takes it out of hit testing too.
		layer.update(cameraAt([9, 1.6, screen.center.z], [1, 1.6, -4]), size);
		expect(holder.style.display).toBe('none');
	});

	it('the TV shows only inside its cone: ±55° across (or the room’s tv_view_deg), −10°…+45° up (D1)', () => {
		const {holder, layer} = mount();
		const from = (acrossDeg: number, upDeg: number, distance = 4) => {
			const across = (acrossDeg * Math.PI) / 180;
			const up = (upDeg * Math.PI) / 180;
			const {x, y, z} = screen.center;
			layer.update(
				cameraAt(
					[
						x + distance * Math.cos(up) * Math.sin(across),
						y + distance * Math.sin(up),
						z + distance * Math.cos(up) * Math.cos(across),
					],
					[x, y, z],
				),
				size,
			);
			return holder.style.display !== 'none';
		};
		expect([from(0, 0), from(54, 0), from(-54, 0), from(0, 44), from(0, -9)]).toEqual([true, true, true, true, true]);
		expect([from(56, 0), from(-56, 0), from(0, 46), from(0, -11), from(170, 0)]).toEqual([
			false,
			false,
			false,
			false,
			false,
		]);
		const narrow = mount({...layout, screen: {...screen, viewDeg: 40}});
		narrow.layer.update(
			cameraAt([1 + 4 * Math.sin((45 * Math.PI) / 180), 1.6, -4 + 4 * Math.cos((45 * Math.PI) / 180)], [1, 1.6, -4]),
			size,
		);
		expect(narrow.holder.style.display).toBe('none');
		narrow.layer.update(
			cameraAt([1 + 4 * Math.sin((35 * Math.PI) / 180), 1.6, -4 + 4 * Math.cos((35 * Math.PI) / 180)], [1, 1.6, -4]),
			size,
		);
		expect(narrow.holder.style.display).not.toBe('none');
	});

	it('seated, the TV shows from as low as 40° under it (F-cam 1)', () => {
		const {holder, layer} = mount();
		// 4 m out, 30° under the screen's centre, looking up at it.
		const below = cameraAt(
			[1, 1.6 - 4 * Math.sin((30 * Math.PI) / 180), -4 + 4 * Math.cos((30 * Math.PI) / 180)],
			[1, 1.6, -4],
		);
		layer.update(below, size, false);
		expect(holder.style.display).toBe('none');
		layer.update(below, size, true);
		expect(holder.style.display).not.toBe('none');
	});

	it('a wheel over scrolling TV content scrolls it; elsewhere it reaches only the canvas (CR10)', () => {
		const {canvas, element} = mount();
		const seen: Array<number> = [];
		const above: Array<number> = [];
		canvas.addEventListener('wheel', (event) => seen.push(event.deltaY));
		document.body.addEventListener('wheel', (event) => above.push(event.deltaY));
		const list = document.createElement('div');
		list.style.overflowY = 'auto';
		Object.defineProperties(list, {
			scrollHeight: {value: 300},
			clientHeight: {value: 100},
			scrollTop: {value: 50, writable: true},
		});
		element.appendChild(list);
		const inside = new WheelEvent('wheel', {deltaY: 100, bubbles: true, cancelable: true});
		list.dispatchEvent(inside);
		expect(inside.defaultPrevented).toBe(false);
		expect(seen).toEqual([]);
		// At the list's end it can no longer scroll that way: the canvas gets it, and nothing above sees it twice.
		list.scrollTop = 200;
		const atEnd = new WheelEvent('wheel', {deltaY: 100, bubbles: true, cancelable: true});
		list.dispatchEvent(atEnd);
		expect(atEnd.defaultPrevented).toBe(true);
		expect(seen).toEqual([100]);
		const plain = new WheelEvent('wheel', {deltaY: -100, bubbles: true, cancelable: true});
		element.dispatchEvent(plain);
		expect(seen).toEqual([100, -100]);
		// The page above hears each one once: the inner scroll itself, the others only as the canvas's copies.
		expect(above).toEqual([100, 100, -100]);
	});

	it('a wheel over the TV goes on to the canvas, where the camera listens (D3)', () => {
		const {canvas, element} = mount();
		const seen: Array<number> = [];
		canvas.addEventListener('wheel', (event) => seen.push(event.deltaY));
		const wheel = new WheelEvent('wheel', {deltaY: -100, bubbles: true, cancelable: true});
		element.dispatchEvent(wheel);
		expect(seen).toEqual([-100]);
		expect(wheel.defaultPrevented).toBe(true);
	});

	it('same result at devicePixelRatio 1, 1.25, 1.5 (browser zoom)', () => {
		const {holder, layer} = mount();
		const camera = cameraAt([2.4, 2, -0.5], [1, 1.6, -4]);
		const transforms = [1, 1.25, 1.5].map((ratio) => {
			Object.defineProperty(window, 'devicePixelRatio', {value: ratio, configurable: true});
			layer.update(camera, size);
			return holder.style.transform;
		});
		expect(new Set(transforms).size).toBe(1);
	});

	it('seat view: the TV layer takes no pointer events, also for an element attached meanwhile (A4)', () => {
		const {layer, holder} = mount();
		expect(holder.style.pointerEvents).toBe('auto');
		layer.setInteractive(false);
		expect(holder.style.pointerEvents).toBe('none');
		const next = document.createElement('div');
		layer.attach(next);
		const nextHolder = next.parentElement as HTMLElement;
		expect(nextHolder.style.pointerEvents).toBe('none');
		layer.setInteractive(true);
		expect(nextHolder.style.pointerEvents).toBe('auto');
	});

	it('attach replaces the element, null removes it, dispose removes the layer', () => {
		const {container, layer, element, holder} = mount();
		const next = document.createElement('div');
		layer.attach(next);
		expect(element.isConnected).toBe(false);
		expect(next.isConnected).toBe(true);
		expect(holder.isConnected).toBe(false);
		layer.attach(null);
		expect(next.isConnected).toBe(false);
		layer.dispose();
		expect(container.childElementCount).toBe(0);
	});
});
