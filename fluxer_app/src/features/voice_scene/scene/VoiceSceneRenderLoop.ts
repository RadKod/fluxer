// SPDX-License-Identifier: AGPL-3.0-or-later

// the room draws only on demand, at most 30 frames a second, never while the tab is hidden.
export const MAX_FRAMES_PER_SECOND = 30;
const FRAME_INTERVAL_MS = 1000 / MAX_FRAMES_PER_SECOND;
// rAF timestamps jitter around the display period; without slack a 60 Hz screen would land on 20 fps.
const FRAME_SLACK_MS = 4;

export interface RenderLoopOptions {
	// Draws one frame; true while the camera is still settling (damping) and another frame is due.
	draw(): boolean;
	canvas: EventTarget;
	onContextLost(): void;
	doc?: EventTarget & {readonly hidden: boolean};
	requestFrame?: (callback: FrameRequestCallback) => number;
	cancelFrame?: (id: number) => void;
}

export interface RenderLoop {
	requestRender(): void;
	dispose(): void;
}

export function createRenderLoop({
	draw,
	canvas,
	onContextLost,
	doc = document,
	requestFrame = (callback) => requestAnimationFrame(callback),
	cancelFrame = (id) => cancelAnimationFrame(id),
}: RenderLoopOptions): RenderLoop {
	let frameId: number | null = null;
	let wanted = false;
	let stopped = false;
	let lastFrameAt = Number.NEGATIVE_INFINITY;

	const schedule = (): void => {
		if (frameId === null && !stopped && !doc.hidden) frameId = requestFrame(tick);
	};
	const cancel = (): void => {
		if (frameId !== null) cancelFrame(frameId);
		frameId = null;
	};
	function tick(now: number): void {
		frameId = null;
		if (now - lastFrameAt < FRAME_INTERVAL_MS - FRAME_SLACK_MS) {
			schedule();
			return;
		}
		lastFrameAt = now;
		wanted = false;
		// draw() may call requestRender itself (OrbitControls 'change'); that only sets `wanted`.
		if (draw()) wanted = true;
		if (wanted) schedule();
	}

	const onVisibilityChange = (): void => {
		if (doc.hidden) {
			cancel();
			return;
		}
		// Size or scene may have changed while hidden: one fresh frame, then idle again.
		wanted = true;
		schedule();
	};
	const onContextLostEvent = (): void => {
		if (stopped) return;
		stopped = true;
		cancel();
		onContextLost();
	};
	doc.addEventListener('visibilitychange', onVisibilityChange);
	canvas.addEventListener('webglcontextlost', onContextLostEvent);

	return {
		requestRender() {
			if (stopped) return;
			wanted = true;
			schedule();
		},
		dispose() {
			stopped = true;
			cancel();
			doc.removeEventListener('visibilitychange', onVisibilityChange);
			canvas.removeEventListener('webglcontextlost', onContextLostEvent);
		},
	};
}
