// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {VoiceSceneAnchor, VoiceSceneAnchors} from '@app/features/voice_scene/components/VoiceSceneAnchor';
import type {RoomLayout, Vec3, VoiceSceneHandle} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {seatedPose} from '@app/features/voice_scene/utils/SeatedView';
import {act, createElement, StrictMode} from 'react';
import {createPortal} from 'react-dom';
import {createRoot, type Root} from 'react-dom/client';
import {PerspectiveCamera, Vector3} from 'three';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const BEHIND: Vec3 = {x: 1, y: 1, z: 1};
const OPEN: Vec3 = {x: 2, y: 1, z: 1};
const OFF_SCREEN: Vec3 = {x: 3, y: 1, z: 1};

let root: Root;
let host: HTMLElement;
const blocked = new Set<Vec3>();
const listeners = new Set<() => void>();
// Each ray costs `rayMs` on the page clock (performance.now, stubbed).
let clock = 0;
let rayMs = 0;
const occluded = vi.fn((point: Vec3) => {
	clock += rayMs;
	return blocked.has(point);
});
const occluder = vi.fn(() => occluded);
const wheel = vi.fn();
const handle = {
	wheel,
	project: (point: Vec3) => ({x: 10, y: 10, visible: point !== OFF_SCREEN, scale: 1}),
	onViewChange: (cb: () => void) => {
		listeners.add(cb);
		return () => listeners.delete(cb);
	},
	occluder,
} as unknown as VoiceSceneHandle;
const moveCamera = () => {
	for (const listener of listeners) listener();
};
const anchor = (text: string) =>
	[...host.querySelectorAll('[data-scene-anchor]')].find((el) => el.textContent === text) as HTMLElement;
const flushPlacement = () => act(() => vi.advanceTimersToNextFrame());

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(performance, 'now').mockImplementation(() => clock);
	clock = 0;
	rayMs = 0;
	blocked.clear();
	occluded.mockClear();
	occluder.mockClear();
	wheel.mockClear();
	host = document.createElement('div');
	document.body.appendChild(host);
	root = createRoot(host);
	act(() =>
		root.render(
			createElement(VoiceSceneAnchors, {
				handle,
				children: [
					createElement(VoiceSceneAnchor, {key: 'behind', point: BEHIND, children: 'behind'}),
					createElement(VoiceSceneAnchor, {key: 'open', point: OPEN, children: 'open'}),
					createElement(VoiceSceneAnchor, {key: 'off', point: OFF_SCREEN, children: 'off'}),
				],
			}),
		),
	);
	flushPlacement();
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('VoiceSceneAnchors: shared layout batching', () => {
	const table = {slot: 'T01', center: OPEN, topSize: 1.4};
	const renderCards = (sceneHandle = handle, avoid?: HTMLElement) =>
		act(() =>
			root.render(
				createElement(VoiceSceneAnchors, {
					handle: sceneHandle,
					children: Array.from({length: 4}, (_, index) =>
						createElement(VoiceSceneAnchor, {
							key: index,
							point: OPEN,
							avoid,
							cameraCard: {mode: 'seat', lane: index - 1, table},
							children: `card${index}`,
						}),
					),
				}),
			),
		);

	it('registers a whole layer before one shared measurement and placement, then stays idle', () => {
		const width = vi.spyOn(host, 'clientWidth', 'get').mockReturnValue(1440);
		const height = vi.spyOn(host, 'clientHeight', 'get').mockReturnValue(852);
		const project = vi.fn(handle.project);
		renderCards({...handle, project});
		expect(project).not.toHaveBeenCalled();
		expect(width).not.toHaveBeenCalled();
		flushPlacement();
		expect(width).toHaveBeenCalledTimes(1);
		expect(height).toHaveBeenCalledTimes(1);
		expect(project).toHaveBeenCalledTimes(20);
		act(() => vi.advanceTimersByTime(1000));
		project.mockClear();
		act(() => vi.advanceTimersByTime(1000));
		expect(project).not.toHaveBeenCalled();
		expect(width).toHaveBeenCalledTimes(1);
		width.mockRestore();
		height.mockRestore();
	});

	it('sets one rest timer for each registration batch without postponing its last registration deadline', () => {
		const timeout = vi.spyOn(globalThis, 'setTimeout');
		const cancel = vi.spyOn(globalThis, 'clearTimeout');
		try {
			renderCards();
			flushPlacement();
			expect(timeout.mock.calls.filter(([, delay]) => delay === 150)).toHaveLength(1);
			expect(cancel).toHaveBeenCalledTimes(1);
			timeout.mockClear();
			cancel.mockClear();
			clock = 100;
			renderCards();
			clock = 116;
			flushPlacement();
			expect(timeout.mock.calls.filter(([, delay]) => delay === 134)).toHaveLength(1);
			expect(cancel).toHaveBeenCalledTimes(1);
			occluder.mockClear();
			occluded.mockClear();
			act(() => vi.advanceTimersByTime(133));
			expect(occluder).not.toHaveBeenCalled();
			act(() => vi.advanceTimersByTime(1));
			expect(occluder).toHaveBeenCalledTimes(1);
			expect(occluded).toHaveBeenCalledTimes(4);
		} finally {
			timeout.mockRestore();
			cancel.mockRestore();
		}
	});

	it('cancels the old rest check on registration even when it expires before the pending frame', () => {
		renderCards();
		flushPlacement();
		occluder.mockClear();
		occluded.mockClear();
		act(() => vi.advanceTimersByTime(149));
		renderCards();
		act(() => vi.advanceTimersByTime(1));
		expect(occluder).not.toHaveBeenCalled();
		flushPlacement();
		act(() => vi.advanceTimersByTime(150));
		expect(occluder).toHaveBeenCalledTimes(1);
		expect(occluded).toHaveBeenCalledTimes(4);
	});

	it('shares one ResizeObserver, reads before writing, and uses cached sizes on view frames', () => {
		const observers: Array<{
			callback: ResizeObserverCallback;
			observe: ReturnType<typeof vi.fn>;
			disconnect: ReturnType<typeof vi.fn>;
		}> = [];
		vi.stubGlobal(
			'ResizeObserver',
			class {
				observe = vi.fn();
				unobserve = vi.fn();
				disconnect = vi.fn();
				constructor(callback: ResizeObserverCallback) {
					observers.push({callback, observe: this.observe, disconnect: this.disconnect});
				}
			},
		);
		let size = 1440;
		const hud = document.createElement('div');
		host.appendChild(hud);
		const hudRect = vi
			.spyOn(hud, 'getBoundingClientRect')
			.mockImplementation(() => new DOMRect(size - 300, 0, 288, 852));
		const events: Array<string> = [];
		const width = vi.spyOn(host, 'clientWidth', 'get').mockImplementation(() => {
			events.push('read');
			return size;
		});
		const project = vi.fn((point: Vec3) => {
			events.push('place');
			return point === OPEN ? {x: size - 110, y: 150, visible: true, scale: 1} : handle.project(point);
		});
		renderCards({...handle, project}, hud);
		flushPlacement();
		expect(observers).toHaveLength(1);
		expect(observers[0].observe).toHaveBeenCalledTimes(2);
		events.length = 0;
		project.mockClear();
		width.mockClear();
		size = 1280;
		const resize = () =>
			observers[0].callback(
				[
					{
						target: host,
						contentRect: new DOMRect(0, 0, size, 720),
						borderBoxSize: [],
						contentBoxSize: [],
						devicePixelContentBoxSize: [],
					},
				],
				{} as ResizeObserver,
			);
		const timeout = vi.spyOn(globalThis, 'setTimeout');
		act(() => {
			resize();
			resize();
		});
		expect(project).not.toHaveBeenCalled();
		flushPlacement();
		expect(timeout).not.toHaveBeenCalled(); // Resize only places cards; it does not restart room occlusion.
		timeout.mockRestore();
		expect(events.lastIndexOf('read')).toBeLessThan(events.indexOf('place'));
		expect(width).toHaveBeenCalledTimes(1);
		expect(project).toHaveBeenCalledTimes(20);
		expect(Number.parseFloat(anchor('card0').style.width)).toBeCloseTo((1280 * 205) / 1440);
		expect(hudRect).toHaveBeenCalledTimes(2); // Parent resize moves the HUD even when its own size stays the same.
		const [, x] = /translate3d\(([\d.]+)px/.exec(anchor('card0').style.transform)!;
		expect(Number(x) + Number.parseFloat(anchor('card0').style.width) / 2).toBeLessThanOrEqual(size - 308);
		width.mockClear();
		for (let frame = 0; frame < 60; frame++) act(() => moveCamera());
		expect(width).not.toHaveBeenCalled();
		act(() => root.render(null));
		expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
		project.mockClear();
		act(() => resize());
		expect(vi.getTimerCount()).toBe(0);
		flushPlacement();
		expect(project).not.toHaveBeenCalled();
		expect(width).not.toHaveBeenCalled();
		width.mockRestore();
		hudRect.mockRestore();
	});

	it('consumes a pending placement in the renderer view frame and cancels work when replaced or unmounted', () => {
		const oldProject = vi.fn(handle.project);
		renderCards({...handle, project: oldProject});
		act(() => moveCamera());
		expect(oldProject).toHaveBeenCalledTimes(20);
		flushPlacement();
		expect(oldProject).toHaveBeenCalledTimes(20);
		const nextProject = vi.fn(() => ({x: 300, y: 100, visible: true, scale: 1}));
		renderCards({...handle, project: nextProject});
		flushPlacement();
		expect(oldProject).toHaveBeenCalledTimes(20);
		expect(nextProject).toHaveBeenCalledTimes(20);
		renderCards({...handle, project: nextProject});
		act(() => root.render(null));
		expect(vi.getTimerCount()).toBe(0);
		act(() => vi.advanceTimersByTime(1000));
		expect(nextProject).toHaveBeenCalledTimes(20);
		expect(listeners.size).toBe(0);
	});

	it('measures each parent and shared HUD once before any placement, including StrictMode replay', () => {
		const other = document.createElement('div');
		const hud = document.createElement('div');
		host.append(hud, other);
		const events: Array<string> = [];
		const widths = [host, other].map((element) =>
			vi.spyOn(element, 'clientWidth', 'get').mockImplementation(() => {
				events.push('read');
				return 1440;
			}),
		);
		const rects = [host, other, hud].map((element) =>
			vi.spyOn(element, 'getBoundingClientRect').mockImplementation(() => {
				events.push('read');
				return {left: 0, right: 100, top: 600, bottom: 700, width: 100, height: 100} as DOMRect;
			}),
		);
		const project = vi.fn((point: Vec3) => {
			events.push('place');
			return handle.project(point);
		});
		const card = (key: number) =>
			createElement(VoiceSceneAnchor, {
				key,
				point: OPEN,
				avoid: hud,
				cameraCard: {mode: 'seat', table},
				children: String(key),
			});
		act(() =>
			root.render(
				createElement(
					StrictMode,
					{},
					createElement(VoiceSceneAnchors, {
						handle: {...handle, project},
						children: [card(0), card(1), createPortal([card(2), card(3)], other)],
					}),
				),
			),
		);
		flushPlacement();
		for (const width of widths) expect(width).toHaveBeenCalledTimes(1);
		for (const rect of rects) expect(rect).toHaveBeenCalledTimes(1);
		expect(events.lastIndexOf('read')).toBeLessThan(events.indexOf('place'));
		expect(project).toHaveBeenCalledTimes(20);
		expect(listeners.size).toBe(1);
		for (const spy of [...widths, ...rects]) spy.mockRestore();
	});
});

describe('VoiceSceneAnchors: cross-table placement', () => {
	it('keeps room cards at two different tables separate', () => {
		const a = {x: 1, y: 1, z: 1},
			b = {x: 2, y: 1, z: 1};
		const cardHandle = {
			...handle,
			project: (point: Vec3) =>
				point === a
					? {x: 640, y: 150, visible: true, scale: 0.6}
					: point === b
						? {x: 680, y: 150, visible: true, scale: 0.6}
						: {x: 660 + point.x * 10, y: 300 + point.z * 10, visible: true, scale: 0.6},
		};
		Object.defineProperties(host, {clientWidth: {value: 1440}, clientHeight: {value: 852}});
		act(() =>
			root.render(
				createElement(VoiceSceneAnchors, {
					handle: cardHandle,
					children: [a, b].map((point, index) =>
						createElement(VoiceSceneAnchor, {
							key: index,
							point,
							cameraCard: {
								mode: 'room',
								table: {slot: `T0${index + 1}`, center: {x: index ? 2 : -2, y: 0, z: 0}, topSize: 1.4},
							},
							children: index ? 'b' : 'a',
						}),
					),
				}),
			),
		);
		flushPlacement();
		const rect = (name: string) => {
			const element = anchor(name);
			const [, x, y] = /translate3d\(([\d.]+)px, ([\d.]+)px/.exec(element.style.transform)!;
			return {
				x: Number(x),
				y: Number(y),
				width: Number.parseFloat(element.style.width),
				height: Number.parseFloat(element.style.height),
			};
		};
		const first = rect('a'),
			second = rect('b');
		expect(
			Math.abs(first.x - second.x) < (first.width + second.width) / 2 &&
				Math.abs(first.y - second.y) < (first.height + second.height) / 2,
			JSON.stringify({first, second}),
		).toBe(false);
	});
});

describe('VoiceSceneAnchors: room geometry hides the DOM behind it (F-cam 8, V7)', () => {
	it('fixedScale keeps screen size on camera changes while distance still orders every layer', () => {
		let scale = 0.6;
		const scaledHandle = {...handle, project: () => ({x: 10, y: 10, visible: true, scale})};
		act(() =>
			root.render(
				createElement(VoiceSceneAnchors, {
					handle: scaledHandle,
					children: [
						createElement(VoiceSceneAnchor, {key: 'normal', point: OPEN, children: 'normal'}),
						createElement(VoiceSceneAnchor, {key: 'fixed', point: OPEN, fixedScale: true, children: 'fixed'}),
						createElement(VoiceSceneAnchor, {
							key: 'label',
							point: OPEN,
							fixedScale: true,
							onTop: true,
							children: 'label',
						}),
						createElement(VoiceSceneAnchor, {key: 'controls', point: OPEN, controls: true, children: 'controls'}),
					],
				}),
			),
		);
		flushPlacement();
		for (const distanceScale of [0.6, 1.8, 0.6]) {
			scale = distanceScale;
			act(() => moveCamera());
			expect(anchor('fixed').style.transform).toContain('scale(1)');
			expect(anchor('label').style.transform).toContain('scale(1)');
			expect(anchor('normal').style.transform).toContain(`scale(${scale})`);
			expect(anchor('controls').style.transform).toContain(`scale(${scale})`);
			expect(anchor('normal').style.zIndex).toBe(String(Math.round(scale * 100)));
			expect(anchor('fixed').style.zIndex).toBe(anchor('normal').style.zIndex);
			expect(anchor('label').style.zIndex).toBe(String(1000 + Math.round(scale * 100)));
			expect(anchor('controls').style.zIndex).toBe(String(2000 + Math.round(scale * 100)));
		}
	});

	it.each([false, true])(
		'room cards clear cached label bounds extending beyond the tabletop (fixedScale=%s)',
		(fixedScale) => {
			const labelPoint = {x: 0, y: 0, z: 0};
			const labelWidth = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
				this: HTMLElement,
			) {
				return this.textContent === 'label' ? 180 : 0;
			});
			const labelHeight = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
				this: HTMLElement,
			) {
				return this.textContent === 'label' ? 100 : 0;
			});
			const cardPoint = {x: 1, y: 1, z: 1};
			const cardHandle = {
				...handle,
				project: (point: Vec3) =>
					point === cardPoint
						? {x: 720, y: 250, visible: true, scale: 1}
						: {x: 720 + point.x * 10, y: 300 + point.z * 10, visible: true, scale: 1.8},
			};
			Object.defineProperties(host, {clientWidth: {value: 1440}, clientHeight: {value: 852}});
			act(() =>
				root.render(
					createElement(VoiceSceneAnchors, {
						handle: cardHandle,
						children: [
							createElement(VoiceSceneAnchor, {
								key: 'card',
								point: cardPoint,
								cameraCard: {mode: 'room', table: {slot: 'T01', center: labelPoint, topSize: 1}},
								children: 'card',
							}),
							createElement(VoiceSceneAnchor, {
								key: 'label',
								point: labelPoint,
								onTop: true,
								fixedScale,
								children: 'label',
							}),
						],
					}),
				),
			);
			flushPlacement();
			const assertSeparate = () => {
				const [, x, y] = /translate3d\(([\d.]+)px, ([\d.]+)px/.exec(anchor('card').style.transform)!;
				const scale = fixedScale ? 1 : 1.8;
				expect(
					Math.abs(Number(x) - 720) >= (66 + 180 * scale) / 2 || Math.abs(Number(y) - 300) >= (49.5 + 100 * scale) / 2,
				).toBe(true);
			};
			act(() => moveCamera());
			assertSeparate();
			labelWidth.mockClear();
			labelHeight.mockClear();
			for (let frame = 0; frame < 60; frame++) act(() => moveCamera());
			expect(labelWidth).not.toHaveBeenCalled();
			expect(labelHeight).not.toHaveBeenCalled();
			assertSeparate();
			labelWidth.mockRestore();
			labelHeight.mockRestore();
		},
	);
	it('keeps three peer cards separate through real seated poses, side looks and zoom without a React render', () => {
		const table = {slot: 'T01', center: {x: 1.23, y: 0.8, z: -2.68}, topSize: 1.4};
		const positions = [
			{x: 1.23, y: 1.125, z: -1.54},
			{x: 2.37, y: 1.125, z: -2.68},
			{x: 1.23, y: 1.125, z: -3.82},
			{x: 0.09, y: 1.125, z: -2.68},
		];
		const seats = positions.map((position, index) => ({
			name: `seat_T01_${index + 1}`,
			group: 'T01',
			position,
			table: {slot: 'T01', position: (index + 1) as 1 | 2 | 3 | 4},
			watch: null,
		}));
		const layout: RoomLayout = {
			seats,
			tables: [table],
			stands: [],
			camTarget: table.center,
			camHome: {x: 13.741, y: 10.474, z: 20.71},
			screen: null,
			camPan: {x: 0, z: 0},
		};
		const pose = seatedPose({layout, seat: seats[0], slot: 'T01', game: 'okey', aspect: 1440 / 852});
		const direction = new Vector3(pose.target.x - pose.eye.x, pose.target.y - pose.eye.y, pose.target.z - pose.eye.z);
		const basePitch = Math.asin(direction.y / direction.length());
		const camera = new PerspectiveCamera(pose.fovDeg, 1440 / 852, 0.01, 100);
		camera.position.set(pose.eye.x, pose.eye.y, pose.eye.z);
		const cardHandle = {
			...handle,
			project: (point: Vec3) => {
				const v = new Vector3(point.x, point.y, point.z).applyMatrix4(camera.matrixWorldInverse);
				const front = v.z < -0.01;
				v.applyMatrix4(camera.projectionMatrix);
				return {
					x: (v.x + 1) * 720,
					y: (1 - v.y) * 426,
					visible: front && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1,
					scale: 1,
				};
			},
		};
		Object.defineProperties(host, {clientWidth: {value: 1440}, clientHeight: {value: 852}});
		let renders = 0;
		const child = ({id}: {id: number}) => {
			renders++;
			return String(id);
		};
		act(() =>
			root.render(
				createElement(VoiceSceneAnchors, {
					handle: cardHandle,
					children: seats.slice(1).map((seat, index) =>
						createElement(VoiceSceneAnchor, {
							key: seat.name,
							point: seat.position,
							cameraCard: {mode: 'seat', lane: index - 1, table},
							children: createElement(child, {id: index}),
						}),
					),
				}),
			),
		);
		flushPlacement();
		for (const zoom of [1, 0.7, 0.4])
			for (const yaw of [...Array.from({length: 21}, (_, i) => -100 + i * 10), -85, 85])
				for (const pitch of Array.from({length: 12}, (_, i) => -25 + i * 5)) {
					const r = (yaw * Math.PI) / 180,
						p = basePitch + (pitch * Math.PI) / 180;
					camera.fov = pose.fovDeg * zoom;
					camera.lookAt(
						camera.position
							.clone()
							.add(new Vector3(Math.sin(r) * Math.cos(p), Math.sin(p), -Math.cos(r) * Math.cos(p))),
					);
					camera.updateProjectionMatrix();
					camera.updateMatrixWorld();
					act(() => moveCamera());
					const cards = [0, 1, 2].map((id) => {
						const element = anchor(String(id));
						const [, x, y] = /translate3d\(([\d.]+)px, ([\d.]+)px/.exec(element.style.transform)!;
						return {
							x: Number(x),
							y: Number(y),
							width: Number.parseFloat(element.style.width),
							height: Number.parseFloat(element.style.height),
						};
					});
					for (let a = 0; a < 3; a++)
						for (let b = a + 1; b < 3; b++) {
							expect(
								Math.abs(cards[a].x - cards[b].x) >= (cards[a].width + cards[b].width) / 2 ||
									Math.abs(cards[a].y - cards[b].y) >= (cards[a].height + cards[b].height) / 2,
								`yaw=${yaw}, pitch=${pitch}, zoom=${zoom}, cards=${a}/${b}`,
							).toBe(true);
						}
				}
		expect(renders).toBe(3);
	});
	it('supports fixedScale anchors while keeping their distance stacking order', () => {
		const cardHandle = {...handle, project: () => ({x: 100, y: 200, visible: true, scale: 1.8})};
		act(() =>
			root.render(
				createElement(VoiceSceneAnchors, {
					handle: cardHandle,
					children: createElement(VoiceSceneAnchor, {point: OPEN, fixedScale: true, children: 'fixed'}),
				}),
			),
		);
		flushPlacement();
		expect(anchor('fixed').style.transform).toContain('scale(1)');
		expect(anchor('fixed').style.zIndex).toBe('180');
	});
	it('a seated card preserves the projected face-to-face position when clear of the table and HUD', () => {
		const cardHandle = {
			...handle,
			project: (p: Vec3) =>
				p === OPEN
					? {x: 160, y: 291, visible: true, scale: 1.8}
					: {x: 720 + p.x * 100, y: 480 + p.z * 100, visible: true, scale: 1},
		};
		Object.defineProperties(host, {clientWidth: {value: 1440}, clientHeight: {value: 852}});
		act(() =>
			root.render(
				createElement(VoiceSceneAnchors, {
					handle: cardHandle,
					children: createElement(VoiceSceneAnchor, {
						point: OPEN,
						cameraCard: {mode: 'seat', lane: -1, table: {slot: 'T01', center: {x: 0, y: 0, z: 0}, topSize: 1.4}},
						children: 'card',
					}),
				}),
			),
		);
		flushPlacement();
		expect(anchor('card').style.transform).toContain('translate3d(160px, 291px, 0)');
	});
	it('a seated card moves out of the measured HUD rectangle', () => {
		const hud = document.createElement('div');
		host.appendChild(hud);
		vi.spyOn(hud, 'getBoundingClientRect').mockReturnValue({
			left: 1190,
			right: 1428,
			top: 240,
			bottom: 430,
			width: 238,
			height: 190,
		} as DOMRect);
		const cardHandle = {
			...handle,
			project: (p: Vec3) =>
				p === OPEN
					? {x: 1329.5, y: 291, visible: true, scale: 1.8}
					: {x: 720 + p.x * 100, y: 550 + p.z * 100, visible: true, scale: 1},
		};
		Object.defineProperties(host, {clientWidth: {value: 1440}, clientHeight: {value: 852}});
		act(() =>
			root.render(
				createElement(VoiceSceneAnchors, {
					handle: cardHandle,
					children: createElement(VoiceSceneAnchor, {
						point: OPEN,
						avoid: hud,
						cameraCard: {mode: 'seat', lane: 1, table: {slot: 'T01', center: {x: 0, y: 0, z: 0}, topSize: 1.4}},
						children: 'card',
					}),
				}),
			),
		);
		flushPlacement();
		const [, x, y] = /translate3d\(([\d.]+)px, ([\d.]+)px/.exec(anchor('card').style.transform)!;
		expect(Number(x) + 205 / 2 <= 1182 || Number(y) + (205 * 9) / 32 <= 232).toBe(true);
	});
	it.each([1280, 1440])(
		'table camera cards stay in the %i px viewport without measuring or rendering each frame',
		(width) => {
			let renders = 0;
			const child = () => {
				renders++;
				return createElement('button', {type: 'button'}, 'card');
			};
			const cardHandle = {...handle, project: () => ({x: -300, y: 900, visible: false, scale: 1.8})};
			Object.defineProperties(host, {clientWidth: {value: width}, clientHeight: {value: 720}});
			act(() =>
				root.render(
					createElement(VoiceSceneAnchors, {
						handle: cardHandle,
						children: createElement(VoiceSceneAnchor, {
							point: OPEN,
							cameraCard: {mode: 'seat', lane: 0, table: {slot: 'T01', center: OPEN, topSize: 1.4}},
							children: createElement(child),
						}),
					}),
				),
			);
			flushPlacement();
			const card = anchor('card');
			expect(card.hidden).toBe(false);
			expect(Number.parseFloat(card.style.width)).toBeCloseTo((width * 205) / 1440);
			expect(Number.parseFloat(card.style.height)).toBeCloseTo((((width * 205) / 1440) * 9) / 16);
			expect(card.style.transform).toContain('scale(1)');
			const measure = vi.spyOn(card, 'getBoundingClientRect');
			for (let i = 0; i < 60; i++) act(() => moveCamera());
			expect(renders).toBe(1);
			expect(measure).not.toHaveBeenCalled();
			const [, x, y] = /translate3d\(([\d.]+)px, ([\d.]+)px/.exec(card.style.transform)!;
			const w = Number.parseFloat(card.style.width);
			const h = Number.parseFloat(card.style.height);
			expect(Number(x) - w / 2).toBeGreaterThanOrEqual(0);
			expect(Number(x) + w / 2).toBeLessThanOrEqual(width);
			expect(Number(y) - h / 2).toBeGreaterThanOrEqual(0);
			expect(Number(y) + h / 2).toBeLessThan(200); // clear of the game, rack and the right-hand HUD
		},
	);

	it('room camera cards draw 4:3 clear of the projected table extent and label', () => {
		const cardHandle = {
			...handle,
			project: (p: Vec3) => ({x: 720 + p.x * 100, y: 350 + p.z * 100, visible: true, scale: 1.8}),
		};
		Object.defineProperties(host, {clientWidth: {value: 1440}, clientHeight: {value: 720}});
		const table = {slot: 'T01', center: {x: 0, y: 0, z: 0}, topSize: 1.4};
		act(() =>
			root.render(
				createElement(VoiceSceneAnchors, {
					handle: cardHandle,
					children: createElement(VoiceSceneAnchor, {
						point: {x: 0, y: 1, z: -0.3},
						cameraCard: {mode: 'room', table},
						children: 'card',
					}),
				}),
			),
		);
		flushPlacement();
		const card = anchor('card');
		expect(Number.parseFloat(card.style.width)).toBeCloseTo(66);
		expect(Number.parseFloat(card.style.height)).toBeCloseTo(49.5);
		const [, , y] = /translate3d\(([\d.]+)px, ([\d.]+)px/.exec(card.style.transform)!;
		expect(Number(y) + 49.5 / 2).toBeLessThan(280); // north edge of the 1.4 m table
	});

	it('an anchor with room geometry in front of it hides once the camera rests; the rest stay', () => {
		blocked.add(BEHIND);
		expect(anchor('behind').hidden).toBe(false);
		act(() => vi.advanceTimersByTime(150));
		expect(anchor('behind').hidden).toBe(true);
		expect(anchor('open').hidden).toBe(false);
		// Off screen it is hidden anyway and never ray-tested.
		expect(anchor('off').hidden).toBe(true);
		expect(occluded.mock.calls.map(([point]) => point)).toEqual([BEHIND, OPEN]);
	});

	it('while the camera moves the last answer stays and no ray is cast; at rest it is asked again', () => {
		blocked.add(BEHIND);
		act(() => vi.advanceTimersByTime(150));
		expect(anchor('behind').hidden).toBe(true);
		occluded.mockClear();
		blocked.clear();
		for (let frame = 0; frame < 5; frame++) {
			act(() => {
				moveCamera();
				vi.advanceTimersByTime(100);
			});
			expect(anchor('behind').hidden).toBe(true);
		}
		expect(occluded).not.toHaveBeenCalled();
		act(() => vi.advanceTimersByTime(150));
		expect(anchor('behind').hidden).toBe(false);
		expect(occluded).toHaveBeenCalledTimes(2);
	});

	it('the rest check runs in slices of about 6 ms with one mesh list, and a camera move drops the rest (item 1)', () => {
		// Eight more anchors, every ray 4 ms: two rays a slice (the second crosses 6 ms), a slice per timer turn.
		const extra = Array.from({length: 8}, (_, i) => ({x: 10 + i, y: 1, z: 1}));
		act(() =>
			root.render(
				createElement(VoiceSceneAnchors, {
					handle,
					children: extra.map((point, i) => createElement(VoiceSceneAnchor, {key: i, point, children: `a${i}`})),
				}),
			),
		);
		flushPlacement();
		act(() => vi.advanceTimersByTime(1000));
		occluded.mockClear();
		occluder.mockClear();
		rayMs = 4;
		for (const point of extra) blocked.add(point);
		act(() => moveCamera());
		act(() => vi.advanceTimersByTime(150));
		expect(occluder).toHaveBeenCalledTimes(1);
		expect(occluded).toHaveBeenCalledTimes(2);
		expect(anchor('a0').hidden).toBe(true);
		expect(anchor('a2').hidden).toBe(false);
		act(() => vi.advanceTimersByTime(1));
		expect(occluded).toHaveBeenCalledTimes(4);
		expect(anchor('a2').hidden).toBe(true);
		// The camera moves on: the rest of this check is dropped, the decided ones keep their answer.
		act(() => moveCamera());
		act(() => vi.advanceTimersByTime(100));
		expect(occluded).toHaveBeenCalledTimes(4);
		expect(anchor('a4').hidden).toBe(false);
		expect(anchor('a0').hidden).toBe(true);
		// At rest again a fresh check (one mesh list) goes through them all, slice by slice.
		act(() => vi.advanceTimersByTime(150 + 10));
		expect(occluder).toHaveBeenCalledTimes(2);
		expect(occluded).toHaveBeenCalledTimes(12);
		for (let i = 0; i < 8; i++) expect(anchor(`a${i}`).hidden).toBe(true);
	});

	it('a wheel over an anchor (an avatar, the TV poster) reaches the camera; over its own scrolling content it scrolls (D3)', () => {
		const above = vi.fn();
		host.addEventListener('wheel', above);
		const over = new WheelEvent('wheel', {deltaY: -100, bubbles: true, cancelable: true});
		anchor('open').firstChild!.parentElement!.dispatchEvent(over);
		expect(wheel).toHaveBeenCalledExactlyOnceWith(over);
		expect(over.defaultPrevented).toBe(true);
		expect(above).not.toHaveBeenCalled();
		const list = document.createElement('div');
		list.style.overflowY = 'auto';
		Object.defineProperties(list, {scrollHeight: {value: 300}, clientHeight: {value: 100}, scrollTop: {value: 50}});
		anchor('open').appendChild(list);
		const inside = new WheelEvent('wheel', {deltaY: 100, bubbles: true, cancelable: true});
		list.dispatchEvent(inside);
		expect(wheel).toHaveBeenCalledTimes(1);
		expect(inside.defaultPrevented).toBe(false);
	});
});
