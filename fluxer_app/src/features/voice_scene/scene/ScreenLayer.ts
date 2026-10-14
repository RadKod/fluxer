// SPDX-License-Identifier: AGPL-3.0-or-later

import type {RoomLayout} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {screenInView} from '@app/features/voice_scene/utils/CameraLimits';
import {wheelStaysInside} from '@app/features/voice_scene/utils/SceneWheel';
import {type PerspectiveCamera, Vector3} from 'three';

// TV: a DOM layer above the canvas (Fluxer's stream UI, not a video texture). The element is laid out at a fixed CSS
// size and mapped onto the four projected corners of the screen quad with one matrix3d homography. Unlike CSS3DRenderer
// there is no CSS perspective / preserve-3d chain, so it stays on the quad at any distance and any browser zoom.
const SCREEN_ELEMENT_WIDTH_PX = 640;

export interface ScreenLayer {
	attach(el: HTMLElement | null): void;
	// After every drawn frame, in CSS px of the canvas box; seated: the seat's TV cone.
	update(camera: PerspectiveCamera, size: {width: number; height: number}, seated?: boolean): void;
	// false in the seat view, so a press over the TV's quad reaches the 3D table instead of focusing the TV.
	setInteractive(interactive: boolean): void;
	dispose(): void;
}

// Element px (0,0) (w,0) (w,h) (0,h) → the four points (Heckbert's square-to-quad), as a column-major CSS matrix3d.
function homography(w: number, h: number, p: ReadonlyArray<number>): string {
	const [x0, y0, x1, y1, x2, y2, x3, y3] = p as [number, number, number, number, number, number, number, number];
	const dx1 = x1 - x2;
	const dx2 = x3 - x2;
	const dx3 = x0 - x1 + x2 - x3;
	const dy1 = y1 - y2;
	const dy2 = y3 - y2;
	const dy3 = y0 - y1 + y2 - y3;
	const det = dx1 * dy2 - dx2 * dy1;
	const g = (dx3 * dy2 - dx2 * dy3) / det;
	const k = (dx1 * dy3 - dx3 * dy1) / det;
	const a = x1 - x0 + g * x1;
	const b = x3 - x0 + k * x3;
	const d = y1 - y0 + g * y1;
	const e = y3 - y0 + k * y3;
	return `matrix3d(${a / w},${d / w},0,${g / w},${b / h},${e / h},0,${k / h},0,0,1,0,${x0},${y0},0,1)`;
}

// wheelTarget: the canvas. A wheel over the TV goes on to the camera there (zoom towards it, into the TV focus; out
// of the focus), as the TV sits above the canvas and would otherwise swallow it.
export function createScreenLayer({
	container,
	layout,
	wheelTarget,
}: {
	container: HTMLElement;
	layout: RoomLayout;
	wheelTarget: HTMLElement;
}): ScreenLayer {
	const layer = document.createElement('div');
	Object.assign(layer.style, {position: 'absolute', inset: '0', overflow: 'hidden', pointerEvents: 'none'});
	container.appendChild(layer);

	const screen = layout.screen;
	const elementHeight = screen ? (SCREEN_ELEMENT_WIDTH_PX * screen.height) / screen.width : 0;
	// World corners matching the element's TL, TR, BR, BL. A TV hangs upright: up is world up flattened onto the quad.
	const corners: Array<Vector3> = [];
	if (screen) {
		const normal = new Vector3(screen.normal.x, screen.normal.y, screen.normal.z);
		const up = new Vector3(0, 1, 0).addScaledVector(normal, -normal.y).normalize();
		const right = new Vector3().crossVectors(up, normal);
		for (const [sx, sy] of [
			[-1, 1],
			[1, 1],
			[1, -1],
			[-1, -1],
		] as const) {
			corners.push(
				new Vector3(screen.center.x, screen.center.y, screen.center.z)
					.addScaledVector(right, (sx * screen.width) / 2)
					.addScaledVector(up, (sy * screen.height) / 2),
			);
		}
	}
	const point = new Vector3();
	const projected: Array<number> = [];
	let holder: HTMLDivElement | null = null;
	let pointerEvents = 'auto';
	// TV content that can still scroll that way keeps its wheel; any other goes only to the canvas.
	const forwardWheel = (event: WheelEvent): void => {
		if (holder && wheelStaysInside(event, holder)) return;
		event.preventDefault();
		event.stopPropagation();
		wheelTarget.dispatchEvent(new WheelEvent('wheel', event));
	};

	return {
		attach(element) {
			holder?.remove();
			holder = null;
			if (!element || !screen) return;
			holder = document.createElement('div');
			Object.assign(holder.style, {
				position: 'absolute',
				left: '0',
				top: '0',
				width: `${SCREEN_ELEMENT_WIDTH_PX}px`,
				height: `${elementHeight}px`,
				transformOrigin: '0 0',
				pointerEvents,
				display: 'none',
			});
			holder.addEventListener('wheel', forwardWheel, {passive: false});
			holder.appendChild(element);
			layer.appendChild(holder);
		},
		update(camera, size, seated = false) {
			if (!holder || !screen) return;
			camera.updateMatrixWorld();
			// DOM cannot be occluded by WebGL geometry, so the TV shows (and takes clicks) only from inside
			// its cone. A corner behind the camera has no valid projection; the quad is then hidden rather than drawn folded.
			let visible = size.width > 0 && size.height > 0 && screenInView(screen, camera.position, seated);
			projected.length = 0;
			for (const corner of corners) {
				if (!visible) break;
				point.copy(corner).applyMatrix4(camera.matrixWorldInverse);
				if (point.z >= -camera.near) visible = false;
				point.applyMatrix4(camera.projectionMatrix);
				projected.push(((point.x + 1) / 2) * size.width, ((1 - point.y) / 2) * size.height);
			}
			if (!visible) {
				holder.style.display = 'none';
				return;
			}
			holder.style.display = '';
			holder.style.transform = homography(SCREEN_ELEMENT_WIDTH_PX, elementHeight, projected);
		},
		setInteractive(interactive) {
			pointerEvents = interactive ? 'auto' : 'none';
			if (holder) holder.style.pointerEvents = pointerEvents;
		},
		dispose() {
			holder?.remove();
			holder = null;
			layer.remove();
		},
	};
}
